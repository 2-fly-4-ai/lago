import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import { sha256Hex } from "../auth/api-key";
import { ApiError } from "../http";
import { deterministicUuid } from "../identifiers";
import { stableJson } from "../json";
import { createAuthorizeNetPaymentRequestUrl } from "../providers/authorize-net";
import { createEasyPayDirectCheckoutUrl } from "../providers/easy-pay-direct";

export type CheckoutWorkflowParams = {
  organizationId: string;
  paymentRequestId: string;
  paymentRequestVersion: number;
  idempotencyKey: string;
  correlationId: string;
};

type PreparedCheckout = {
  checkoutIntentId: string;
  organizationId: string;
  paymentRequestId: string;
  paymentRequestVersion: number;
  customerId: string;
  externalCustomerId: string;
  customerEmail: string | null;
  providerAccountCode: string;
  provider: "authorize_net" | "easy_pay_direct";
  amountMinor: number;
  currency: string;
  correlationId: string;
  completed: boolean;
};

type PaymentRequestCheckoutRow = {
  id: string;
  organization_id: string;
  customer_id: string;
  amount_minor: number;
  currency: string;
  payment_status: string;
  ready_for_payment_processing: number;
  version: number;
  external_customer_id: string;
  customer_email: string | null;
  payment_provider: string | null;
  payment_provider_code: string | null;
};

type CheckoutIntentRow = {
  id: string;
  request_sha256: string;
  status: "pending" | "processing" | "succeeded" | "failed";
};

type CheckoutDispatcherEnv = Pick<Env, "BILLING_DB" | "CHECKOUT_WORKFLOW"> & {
  PAYMENT_MUTATIONS_ENABLED?: string;
};

export class CheckoutWorkflow extends WorkflowEntrypoint<Env, CheckoutWorkflowParams> {
  override async run(event: WorkflowEvent<CheckoutWorkflowParams>, step: WorkflowStep) {
    return runCheckoutWorkflow(this.env, event.payload, step);
  }
}

export async function runCheckoutWorkflow(
  env: Env,
  payload: Readonly<CheckoutWorkflowParams>,
  step: WorkflowStep,
  fetcher: typeof fetch = fetch,
): Promise<Record<string, unknown>> {
  const prepared = await step.do("prepare payment request checkout", async () =>
    preparePaymentRequestCheckout(env, payload),
  );
  if (prepared.completed) {
    return {
      accepted: true,
      replayed: true,
      checkoutIntentId: prepared.checkoutIntentId,
      paymentRequestId: prepared.paymentRequestId,
    };
  }

  await step.do("mark payment request checkout processing", async () => {
    await env.BILLING_DB.prepare(
      `UPDATE payment_request_checkout_intents
       SET status = 'processing', version = version + 1, updated_at = ?
       WHERE id = ? AND organization_id = ? AND status = 'pending'`,
    )
      .bind(new Date().toISOString(), prepared.checkoutIntentId, prepared.organizationId)
      .run();
    return { checkoutIntentId: prepared.checkoutIntentId };
  });

  try {
    const generated = await step.do(
      `create ${prepared.provider} payment request URL`,
      {
        retries: { limit: 2, delay: "5 seconds", backoff: "exponential" },
        timeout: "1 minute",
        sensitive: "output",
      },
      async () =>
        prepared.provider === "easy_pay_direct"
          ? createEasyPayDirectCheckoutUrl(env, {
              checkoutIntentId: prepared.checkoutIntentId,
            })
          : createAuthorizeNetPaymentRequestUrl(
              env,
              {
                paymentRequestId: prepared.paymentRequestId,
                customerId: prepared.customerId,
                externalCustomerId: prepared.externalCustomerId,
                organizationId: prepared.organizationId,
                amountMinor: prepared.amountMinor,
                currency: prepared.currency,
                customerEmail: prepared.customerEmail,
              },
              fetcher,
            ),
    );
    await step.do("record payment request checkout success", async () => {
      await completePaymentRequestCheckout(env.BILLING_DB, prepared, generated);
      return {
        checkoutIntentId: prepared.checkoutIntentId,
        paymentRequestId: prepared.paymentRequestId,
        expiresAt: generated.expiresAt,
      };
    });
    return {
      accepted: true,
      replayed: false,
      checkoutIntentId: prepared.checkoutIntentId,
      paymentRequestId: prepared.paymentRequestId,
      expiresAt: generated.expiresAt,
    };
  } catch (error) {
    const failureCode = error instanceof ApiError ? error.code : "checkout_workflow_failed";
    await step.do("record payment request checkout failure", async () => {
      await failPaymentRequestCheckout(
        env.BILLING_DB,
        prepared,
        failureCode,
        "Payment request checkout could not be created",
      );
      return { checkoutIntentId: prepared.checkoutIntentId, failureCode };
    });
    throw error;
  }
}

export async function dispatchPendingPaymentRequestCheckouts(
  env: CheckoutDispatcherEnv,
): Promise<{ candidates: number; dispatched: number }> {
  if (String(env.PAYMENT_MUTATIONS_ENABLED) !== "1") {
    return { candidates: 0, dispatched: 0 };
  }
  const candidates = await env.BILLING_DB.prepare(
    `SELECT request.id, request.organization_id, request.version
     FROM payment_requests request
     JOIN customers customer ON customer.id = request.customer_id
     WHERE request.payment_status <> 'succeeded'
       AND request.ready_for_payment_processing = 1
       AND customer.payment_provider IN ('authorize_net', 'easy_pay_direct')
       AND NOT EXISTS (
         SELECT 1 FROM payment_request_checkout_intents intent
         WHERE intent.payment_request_id = request.id
           AND intent.payment_request_version = request.version
           AND intent.provider = customer.payment_provider
       )
     ORDER BY request.created_at, request.id LIMIT 100`,
  ).all<{ id: string; organization_id: string; version: number }>();
  let dispatched = 0;
  for (const candidate of candidates.results) {
    const instanceId = `payment-request-checkout-${candidate.id}-v${candidate.version}`;
    try {
      await env.CHECKOUT_WORKFLOW.create({
        id: instanceId,
        params: {
          organizationId: candidate.organization_id,
          paymentRequestId: candidate.id,
          paymentRequestVersion: candidate.version,
          idempotencyKey: instanceId,
          correlationId: instanceId,
        },
      });
      dispatched += 1;
    } catch (error) {
      const message = error instanceof Error ? error.message.toLowerCase() : "";
      if (!message.includes("already exists")) throw error;
    }
  }
  return { candidates: candidates.results.length, dispatched };
}

async function preparePaymentRequestCheckout(
  env: Env,
  payload: Readonly<CheckoutWorkflowParams>,
): Promise<PreparedCheckout> {
  validateCheckoutPayload(payload);
  if (String(env.PAYMENT_MUTATIONS_ENABLED) !== "1") {
    throw new ApiError(
      503,
      "payment_mutations_disabled",
      "Payment provider mutations are disabled",
    );
  }
  const paymentRequest = await env.BILLING_DB.prepare(
    `SELECT request.id, request.organization_id, request.customer_id, request.amount_minor,
            request.currency, request.payment_status, request.ready_for_payment_processing,
            request.version, customer.external_id AS external_customer_id,
            customer.email AS customer_email, customer.payment_provider,
            customer.payment_provider_code
     FROM payment_requests request
     JOIN customers customer ON customer.id = request.customer_id
     WHERE request.id = ? AND request.organization_id = ? LIMIT 1`,
  )
    .bind(payload.paymentRequestId, payload.organizationId)
    .first<PaymentRequestCheckoutRow>();
  if (!paymentRequest) throw new Error("payment_request_not_found");
  if (
    paymentRequest.version !== payload.paymentRequestVersion ||
    paymentRequest.payment_status === "succeeded" ||
    paymentRequest.ready_for_payment_processing !== 1
  ) {
    throw new Error("payment_request_checkout_state_changed");
  }
  if (
    paymentRequest.payment_provider !== "authorize_net" &&
    paymentRequest.payment_provider !== "easy_pay_direct"
  ) {
    throw new Error("unsupported_payment_request_provider");
  }
  const balance = await env.BILLING_DB.prepare(
    `SELECT COUNT(*) AS invoice_count,
            COALESCE(SUM(invoice.total_due_minor - COALESCE((
              SELECT SUM(amount_minor) FROM (
                SELECT payment.amount_minor FROM payment_attempts payment
                WHERE payment.invoice_id = invoice.id AND payment.status = 'succeeded'
                UNION ALL
                SELECT allocation.amount_minor
                FROM payment_request_payment_allocations allocation
                WHERE allocation.invoice_id = invoice.id
              )
            ), 0)), 0) AS outstanding_minor
     FROM invoices_payment_requests link
     JOIN invoices invoice ON invoice.id = link.invoice_id
     WHERE link.payment_request_id = ? AND link.organization_id = ?`,
  )
    .bind(paymentRequest.id, paymentRequest.organization_id)
    .first<{ invoice_count: number; outstanding_minor: number }>();
  if (
    !balance ||
    balance.invoice_count <= 0 ||
    balance.outstanding_minor !== paymentRequest.amount_minor
  ) {
    throw new Error("payment_request_balance_changed");
  }

  const providerAccountCode = paymentRequest.payment_provider_code ?? "default";
  const requestSha256 = await sha256Hex(
    stableJson({
      amountMinor: paymentRequest.amount_minor,
      currency: paymentRequest.currency,
      organizationId: paymentRequest.organization_id,
      paymentRequestId: paymentRequest.id,
      paymentRequestVersion: paymentRequest.version,
      provider: paymentRequest.payment_provider,
      providerAccountCode,
    }),
  );
  const checkoutIntentId = await deterministicUuid(
    "payment-request-checkout-intent",
    `${paymentRequest.organization_id}:${payload.idempotencyKey}`,
  );
  const now = new Date().toISOString();
  await env.BILLING_DB.prepare(
    `INSERT INTO payment_request_checkout_intents
     (id, organization_id, payment_request_id, customer_id, provider,
      provider_account_code, idempotency_key, request_sha256, amount_minor, currency,
      payment_request_version, status, version, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', 1, ?, ?)
     ON CONFLICT(organization_id, idempotency_key) DO NOTHING`,
  )
    .bind(
      checkoutIntentId,
      paymentRequest.organization_id,
      paymentRequest.id,
      paymentRequest.customer_id,
      paymentRequest.payment_provider,
      providerAccountCode,
      payload.idempotencyKey,
      requestSha256,
      paymentRequest.amount_minor,
      paymentRequest.currency,
      paymentRequest.version,
      now,
      now,
    )
    .run();
  const intent = await env.BILLING_DB.prepare(
    `SELECT id, request_sha256, status FROM payment_request_checkout_intents
     WHERE organization_id = ? AND idempotency_key = ? LIMIT 1`,
  )
    .bind(paymentRequest.organization_id, payload.idempotencyKey)
    .first<CheckoutIntentRow>();
  if (!intent || intent.id !== checkoutIntentId || intent.request_sha256 !== requestSha256) {
    throw new Error("checkout_idempotency_key_conflict");
  }
  if (intent.status === "failed") throw new Error("checkout_intent_failed");
  return {
    checkoutIntentId,
    organizationId: paymentRequest.organization_id,
    paymentRequestId: paymentRequest.id,
    paymentRequestVersion: paymentRequest.version,
    customerId: paymentRequest.customer_id,
    externalCustomerId: paymentRequest.external_customer_id,
    customerEmail: paymentRequest.customer_email,
    providerAccountCode,
    provider: paymentRequest.payment_provider,
    amountMinor: paymentRequest.amount_minor,
    currency: paymentRequest.currency,
    correlationId: payload.correlationId,
    completed: intent.status === "succeeded",
  };
}

async function completePaymentRequestCheckout(
  database: D1Database,
  prepared: PreparedCheckout,
  generated: { paymentUrl: string; token: string; expiresAt: string | null },
): Promise<void> {
  const now = new Date().toISOString();
  const tokenSha256 = await sha256Hex(generated.token);
  const eventId = `payment-request-checkout-succeeded:${prepared.checkoutIntentId}`;
  const payload = stableJson({
    organizationId: prepared.organizationId,
    paymentRequestId: prepared.paymentRequestId,
    checkoutIntentId: prepared.checkoutIntentId,
    provider: prepared.provider,
    expiresAt: generated.expiresAt,
  });
  await database.batch([
    database
      .prepare(
        `UPDATE payment_request_checkout_intents
         SET status = 'succeeded', payment_url = ?, provider_token_sha256 = ?, expires_at = ?,
             failure_code = NULL, failure_message = NULL, version = version + 1,
             updated_at = ?, completed_at = ?
         WHERE id = ? AND organization_id = ? AND status IN ('pending', 'processing')
           AND EXISTS (
             SELECT 1 FROM payment_requests request
             WHERE request.id = payment_request_checkout_intents.payment_request_id
               AND request.organization_id = payment_request_checkout_intents.organization_id
               AND request.version = payment_request_checkout_intents.payment_request_version
               AND request.payment_status <> 'succeeded'
               AND request.ready_for_payment_processing = 1
           )`,
      )
      .bind(
        generated.paymentUrl,
        tokenSha256,
        generated.expiresAt,
        now,
        now,
        prepared.checkoutIntentId,
        prepared.organizationId,
      ),
    database
      .prepare(
        `INSERT INTO outbox_events
         (event_id, organization_id, event_type, event_version, aggregate_type,
          aggregate_id, aggregate_version, causation_id, correlation_id, payload_json,
          occurred_at, published_at)
         SELECT ?, organization_id, 'payment_request.checkout_url_created', 1,
                'payment_request_checkout', id, version, ?, ?, ?, ?, NULL
         FROM payment_request_checkout_intents
         WHERE id = ? AND organization_id = ? AND status = 'succeeded'
         ON CONFLICT(event_id) DO NOTHING`,
      )
      .bind(
        eventId,
        prepared.correlationId,
        prepared.correlationId,
        payload,
        now,
        prepared.checkoutIntentId,
        prepared.organizationId,
      ),
  ]);
  const succeeded = await database
    .prepare(
      `SELECT id FROM payment_request_checkout_intents
       WHERE id = ? AND organization_id = ? AND status = 'succeeded' LIMIT 1`,
    )
    .bind(prepared.checkoutIntentId, prepared.organizationId)
    .first();
  if (!succeeded) throw new Error("payment_request_checkout_state_changed");
}

async function failPaymentRequestCheckout(
  database: D1Database,
  prepared: PreparedCheckout,
  failureCode: string,
  failureMessage: string,
): Promise<void> {
  const now = new Date().toISOString();
  const eventId = `payment-request-checkout-failed:${prepared.checkoutIntentId}`;
  await database.batch([
    database
      .prepare(
        `UPDATE payment_request_checkout_intents
         SET status = 'failed', payment_url = NULL, provider_token_sha256 = NULL,
             expires_at = NULL, failure_code = ?, failure_message = ?,
             version = version + 1, updated_at = ?, completed_at = ?
         WHERE id = ? AND organization_id = ? AND status <> 'succeeded'`,
      )
      .bind(
        failureCode,
        failureMessage,
        now,
        now,
        prepared.checkoutIntentId,
        prepared.organizationId,
      ),
    database
      .prepare(
        `INSERT INTO outbox_events
         (event_id, organization_id, event_type, event_version, aggregate_type,
          aggregate_id, aggregate_version, causation_id, correlation_id, payload_json,
          occurred_at, published_at)
         SELECT ?, organization_id, 'payment_request.payment_failure', 1,
                'payment_request_checkout', id, version, ?, ?, ?, ?, NULL
         FROM payment_request_checkout_intents
         WHERE id = ? AND organization_id = ? AND status = 'failed'
         ON CONFLICT(event_id) DO NOTHING`,
      )
      .bind(
        eventId,
        prepared.correlationId,
        prepared.correlationId,
        stableJson({
          organizationId: prepared.organizationId,
          paymentRequestId: prepared.paymentRequestId,
          checkoutIntentId: prepared.checkoutIntentId,
          provider: prepared.provider,
          failureCode,
        }),
        now,
        prepared.checkoutIntentId,
        prepared.organizationId,
      ),
  ]);
}

function validateCheckoutPayload(payload: Readonly<CheckoutWorkflowParams>): void {
  if (
    !payload.organizationId?.trim() ||
    !payload.paymentRequestId?.trim() ||
    !Number.isSafeInteger(payload.paymentRequestVersion) ||
    payload.paymentRequestVersion <= 0 ||
    !payload.idempotencyKey?.trim() ||
    !payload.correlationId?.trim()
  ) {
    throw new Error("invalid_checkout_workflow_payload");
  }
}
