import type { AuthContext } from "../auth/api-key";
import { sha256Hex } from "../auth/api-key";
import type { DomainEvent } from "../domain-events";
import { ApiError, parseJsonObject } from "../http";
import { deterministicUuid } from "../identifiers";
import { stableJson } from "../json";

type RetryableInvoiceRow = {
  id: string;
  number: string | null;
  currency: string;
  status: string;
  payment_status: string;
  ready_for_payment_processing: number;
  total_due_minor: number;
  total_paid_minor: number;
  version: number;
  payment_provider: string | null;
  payment_provider_code: string | null;
};

type RetryAttemptRow = {
  id: string;
  invoice_id: string;
  provider: string;
  provider_account_code: string;
  amount_minor: number;
  currency: string;
  status: string;
};

export async function handleInvoicePaymentRetryRequest(
  request: Request,
  env: Env,
  auth: AuthContext,
  requestId: string,
): Promise<Response | null> {
  const match = new URL(request.url).pathname.match(
    /^\/api\/v1\/invoices\/([^/]+)\/retry_payment$/,
  );
  if (request.method !== "POST" || !match?.[1]) return null;
  if (String(env.PAYMENT_MUTATIONS_ENABLED) !== "1") {
    throw new ApiError(503, "payment_mutations_disabled", "Payment mutations are disabled");
  }

  const invoiceId = decodeURIComponent(match[1]);
  await validateRetryBody(request);
  const clientIdempotencyKey = requiredIdempotencyKey(request);
  const keyHash = await sha256Hex(`${auth.organizationId}:${clientIdempotencyKey}`);
  const storedIdempotencyKey = `invoice-retry:${keyHash}`;
  const existing = await findRetryAttempt(
    env.BILLING_DB,
    auth.organizationId,
    storedIdempotencyKey,
  );
  if (existing) return replayResponse(existing, invoiceId, requestId);

  const invoice = await findRetryableInvoice(env.BILLING_DB, auth.organizationId, invoiceId);
  if (!invoice) throw new ApiError(404, "invoice_not_found", "Invoice was not found");
  assertRetryable(invoice);
  const outstandingMinor = invoice.total_due_minor - invoice.total_paid_minor;
  if (outstandingMinor <= 0) {
    throw new ApiError(422, "invalid_status", "Invoice has no outstanding balance");
  }

  const providerAccountCode = invoice.payment_provider_code ?? "default";
  const attemptId = await deterministicUuid(
    "invoice-payment-retry",
    `${auth.organizationId}:${keyHash}`,
  );
  const now = new Date().toISOString();
  const event: DomainEvent = {
    id: `invoice-payment-retry-requested:${attemptId}:v1`,
    type: "invoice.payment_retry_requested",
    version: 1,
    aggregateType: "payment",
    aggregateId: attemptId,
    aggregateVersion: 1,
    occurredAt: now,
    causationId: requestId,
    correlationId: requestId,
    payload: {
      organizationId: auth.organizationId,
      invoiceId: invoice.id,
      paymentAttemptId: attemptId,
      provider: "authorize_net",
      status: "intent_recorded",
    },
  };

  let results: D1Result[];
  try {
    results = await env.BILLING_DB.batch([
      env.BILLING_DB.prepare(
        `INSERT INTO payment_attempts
         (id, organization_id, invoice_id, provider, provider_account_code,
          provider_transaction_id, idempotency_key, amount_minor, currency, status,
          failure_code, failure_message, payment_type, reference, version, created_at, updated_at)
         SELECT ?, ?, invoice.id, 'authorize_net', ?, NULL, ?, ?, invoice.currency,
                'intent_recorded', NULL, NULL, 'provider', ?, 1, ?, ?
         FROM invoices invoice
         JOIN customers customer
           ON customer.id = invoice.customer_id
          AND customer.organization_id = invoice.organization_id
         WHERE invoice.id = ? AND invoice.organization_id = ? AND invoice.version = ?
           AND invoice.status = 'finalized'
           AND invoice.payment_status IN ('pending', 'failed')
           AND invoice.ready_for_payment_processing = 1
           AND customer.payment_provider = 'authorize_net'`,
      ).bind(
        attemptId,
        auth.organizationId,
        providerAccountCode,
        storedIdempotencyKey,
        outstandingMinor,
        invoice.number ?? invoice.id,
        now,
        now,
        invoice.id,
        auth.organizationId,
        invoice.version,
      ),
      env.BILLING_DB.prepare(
        `UPDATE invoices
         SET payment_status = 'pending', ready_for_payment_processing = 1,
             version = version + 1, updated_at = ?
         WHERE id = ? AND organization_id = ? AND version = ?
           AND status = 'finalized' AND payment_status IN ('pending', 'failed')
           AND ready_for_payment_processing = 1
           AND EXISTS (
             SELECT 1 FROM payment_attempts
             WHERE id = ? AND organization_id = ? AND invoice_id = ?
           )`,
      ).bind(
        now,
        invoice.id,
        auth.organizationId,
        invoice.version,
        attemptId,
        auth.organizationId,
        invoice.id,
      ),
      env.BILLING_DB.prepare(
        `DELETE FROM payment_links
         WHERE invoice_id = ? AND EXISTS (
           SELECT 1 FROM payment_attempts
           WHERE id = ? AND organization_id = ? AND invoice_id = ?
         )`,
      ).bind(invoice.id, attemptId, auth.organizationId, invoice.id),
      env.BILLING_DB.prepare(
        `INSERT INTO outbox_events
         (event_id, organization_id, event_type, event_version, aggregate_type,
          aggregate_id, aggregate_version, causation_id, correlation_id, payload_json,
          occurred_at, published_at)
         SELECT ?, ?, ?, 1, 'payment', ?, 1, ?, ?, ?, ?, NULL
         FROM payment_attempts
         WHERE id = ? AND organization_id = ? AND invoice_id = ?`,
      ).bind(
        event.id,
        auth.organizationId,
        event.type,
        attemptId,
        requestId,
        requestId,
        stableJson(event.payload),
        now,
        attemptId,
        auth.organizationId,
        invoice.id,
      ),
    ]);
  } catch (error) {
    const concurrent = await findRetryAttempt(
      env.BILLING_DB,
      auth.organizationId,
      storedIdempotencyKey,
    );
    if (concurrent) return replayResponse(concurrent, invoiceId, requestId);
    throw error;
  }

  if (
    results[0]?.meta.changes !== 1 ||
    results[1]?.meta.changes !== 1 ||
    results[3]?.meta.changes !== 1
  ) {
    const concurrent = await findRetryAttempt(
      env.BILLING_DB,
      auth.organizationId,
      storedIdempotencyKey,
    );
    if (concurrent) return replayResponse(concurrent, invoiceId, requestId);
    throw new ApiError(409, "invoice_version_conflict", "Invoice changed concurrently");
  }

  await env.DOMAIN_EVENTS.send(event);
  return acceptedResponse(requestId, false);
}

async function validateRetryBody(request: Request): Promise<void> {
  if (!request.body) return;
  const body = await parseJsonObject(request);
  const unsupported = Object.keys(body).find((key) => key !== "payment_method");
  if (unsupported) {
    throw new ApiError(
      422,
      "unsupported_payment_retry_feature",
      `${unsupported} is not supported by invoice payment retry`,
    );
  }
  if (body.payment_method === undefined || body.payment_method === null) return;
  if (
    typeof body.payment_method !== "object" ||
    Array.isArray(body.payment_method) ||
    Object.keys(body.payment_method).length > 0
  ) {
    throw new ApiError(
      422,
      "unsupported_payment_method_override",
      "Authorize.Net hosted payment retry does not accept a payment method override",
    );
  }
}

function requiredIdempotencyKey(request: Request): string {
  const value = request.headers.get("Idempotency-Key")?.trim();
  if (!value) {
    throw new ApiError(
      422,
      "idempotency_key_required",
      "Idempotency-Key is required for invoice payment retry",
    );
  }
  if (value.length > 255)
    throw new ApiError(422, "validation_error", "Idempotency-Key is too long");
  return value;
}

function assertRetryable(invoice: RetryableInvoiceRow): void {
  if (invoice.status !== "finalized" || !["pending", "failed"].includes(invoice.payment_status)) {
    throw new ApiError(422, "invalid_status", "Invoice payment cannot be retried");
  }
  if (invoice.ready_for_payment_processing !== 1) {
    throw new ApiError(
      422,
      "payment_processor_is_currently_handling_payment",
      "The payment processor is currently handling this invoice",
    );
  }
  if (invoice.payment_provider !== "authorize_net") {
    throw new ApiError(
      422,
      "invalid_payment_provider",
      "Authorize.Net is not configured for this customer",
    );
  }
}

function findRetryableInvoice(
  database: D1Database,
  organizationId: string,
  invoiceId: string,
): Promise<RetryableInvoiceRow | null> {
  return database
    .prepare(
      `SELECT i.id, i.number, i.currency, i.status, i.payment_status,
              i.ready_for_payment_processing, i.total_due_minor, i.version,
              c.payment_provider, c.payment_provider_code,
              COALESCE((
                SELECT SUM(amount_minor) FROM (
                  SELECT payment.amount_minor FROM payment_attempts payment
                  WHERE payment.invoice_id = i.id AND payment.status = 'succeeded'
                  UNION ALL
                  SELECT allocation.amount_minor
                  FROM payment_request_payment_allocations allocation
                  WHERE allocation.invoice_id = i.id
                )
              ), 0) AS total_paid_minor
       FROM invoices i
       JOIN customers c ON c.id = i.customer_id AND c.organization_id = i.organization_id
       WHERE i.organization_id = ? AND i.id = ? LIMIT 1`,
    )
    .bind(organizationId, invoiceId)
    .first<RetryableInvoiceRow>();
}

function findRetryAttempt(
  database: D1Database,
  organizationId: string,
  idempotencyKey: string,
): Promise<RetryAttemptRow | null> {
  return database
    .prepare(
      `SELECT id, invoice_id, provider, provider_account_code, amount_minor, currency, status
       FROM payment_attempts WHERE organization_id = ? AND idempotency_key = ? LIMIT 1`,
    )
    .bind(organizationId, idempotencyKey)
    .first<RetryAttemptRow>();
}

function replayResponse(attempt: RetryAttemptRow, invoiceId: string, requestId: string): Response {
  if (
    attempt.invoice_id !== invoiceId ||
    attempt.provider !== "authorize_net" ||
    attempt.status !== "intent_recorded"
  ) {
    throw new ApiError(
      409,
      "idempotency_conflict",
      "Idempotency-Key was already used for another payment command",
    );
  }
  return acceptedResponse(requestId, true);
}

function acceptedResponse(requestId: string, replayed: boolean): Response {
  return new Response(null, {
    status: 200,
    headers: {
      "Cache-Control": "no-store",
      "X-Idempotent-Replay": replayed ? "true" : "false",
      "X-Request-Id": requestId,
    },
  });
}
