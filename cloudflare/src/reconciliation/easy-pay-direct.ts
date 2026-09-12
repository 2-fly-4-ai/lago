import { reconcilePaymentRequest, type PendingReceipt } from "./authorize-net";
import { sha256Hex } from "../auth/api-key";
import { deterministicUuid } from "../identifiers";
import { stableJson } from "../json";
import { getEasyPayDirectOrder, type CommerceOrder } from "../providers/easy-pay-direct";
import {
  resumeEasyPayDirectExecution,
  finalizeEasyPayDirectPaidExecution,
  reconcileEasyPayDirectGatewayExecution,
  EASY_PAY_DIRECT_SETUP_REVIEW_CODES,
} from "../api/easy-pay-direct-checkout";
import {
  requireEasyPayDirectOrderEvidence,
  hasSuccessfulEasyPayDirectPayment,
} from "../billing/easy-pay-direct-order-evidence";
import {
  EASY_PAY_DIRECT_PAYABLE_EXECUTION_SQL,
  EASY_PAY_DIRECT_TAX_COMMIT_PENDING_SQL,
  EASY_PAY_DIRECT_REPLAY_WINDOW_SQL,
} from "../billing/easy-pay-direct-recovery-policy";
import { commitAppliedCheckoutTaxQuote } from "../api/easy-pay-direct-tax";
import { ApiError } from "../http";

type EasyPayDirectEvent = {
  id?: string;
  type?: string;
  created?: number;
  livemode?: boolean;
  data?: {
    object?: {
      id?: string;
      object?: string;
      status?: string;
      total?: number;
      currency?: string;
      failure_reason?: string | null;
      metadata?: Record<string, string>;
    };
  };
};

type EasyPayDirectGatewayEvent = {
  event_id?: string;
  event_type?: string;
  event_body?: {
    features?: { is_test_mode?: boolean };
    transaction_id?: string;
    order_id?: string;
    requested_amount?: string;
    currency?: string;
    action?: {
      success?: string;
      response_code?: string;
      response_text?: string;
      processor_response_text?: string;
    };
  };
};

type NormalizedArchivedEasyPayDirectEvent = {
  event: EasyPayDirectEvent;
  gateway: boolean;
};

function gatewayAmountMinor(value: string | undefined): number | null {
  const match = value?.trim().match(/^(\d{1,12})(?:\.(\d{1,2}))?$/);
  if (!match?.[1]) return null;
  const cents = `${match[2] ?? ""}00`.slice(0, 2);
  const amount = Number(match[1]) * 100 + Number(cents);
  return Number.isSafeInteger(amount) ? amount : null;
}

export function normalizeArchivedEasyPayDirectEvent(
  raw: string,
): NormalizedArchivedEasyPayDirectEvent {
  let parsed: EasyPayDirectEvent | EasyPayDirectGatewayEvent;
  try {
    parsed = JSON.parse(raw) as EasyPayDirectEvent | EasyPayDirectGatewayEvent;
  } catch {
    throw new Error("easy_pay_direct_webhook_invalid_json");
  }
  if (!("event_id" in parsed) && !("event_type" in parsed) && !("event_body" in parsed)) {
    return { event: parsed as EasyPayDirectEvent, gateway: false };
  }
  const gateway = parsed as EasyPayDirectGatewayEvent;
  const eventType = gateway.event_type?.trim();
  const body = gateway.event_body;
  const translatedType =
    eventType === "transaction.sale.success"
      ? "order.succeeded"
      : eventType === "transaction.sale.failure"
        ? "order.failed"
        : eventType;
  const translatedStatus =
    translatedType === "order.succeeded"
      ? "succeeded"
      : translatedType === "order.failed"
        ? "failed"
        : undefined;
  if (
    (translatedStatus === "succeeded" && body?.action?.success !== "1") ||
    (translatedStatus === "failed" && body?.action?.success !== "0")
  ) {
    throw new ApiError(
      409,
      "easy_pay_direct_order_evidence_mismatch",
      "Gateway webhook event and action outcomes do not match.",
    );
  }
  return {
    gateway: true,
    event: {
      id: gateway.event_id?.trim(),
      type: translatedType,
      livemode:
        typeof body?.features?.is_test_mode === "boolean" ? !body.features.is_test_mode : undefined,
      data: {
        object: {
          id: body?.transaction_id?.trim(),
          object: "gateway_transaction",
          status: translatedStatus,
          total: gatewayAmountMinor(body?.requested_amount) ?? undefined,
          currency: body?.currency?.trim().toLowerCase(),
          failure_reason:
            translatedStatus === "failed"
              ? body?.action?.response_text?.trim() ||
                body?.action?.processor_response_text?.trim() ||
                null
              : null,
          metadata: body?.order_id?.trim() ? { lago_payment_request_id: body.order_id.trim() } : {},
        },
      },
    },
  };
}

type EasyPayDirectExecution = {
  id: string;
  charge_transport: string;
  payment_backend: string;
  status: string;
  organization_id: string;
  payment_request_id: string;
  provider_account_code: string;
  provider_transaction_id: string | null;
};

async function readElementsExecutionOrder(
  env: Env,
  execution: EasyPayDirectExecution,
  fetcher: typeof fetch,
): Promise<CommerceOrder> {
  const expected =
    await env.BILLING_DB.prepare(`SELECT e.provider_customer_id, e.provider_payment_method_id,
    r.amount_minor, r.currency FROM easy_pay_direct_payment_executions e
    JOIN payment_requests r ON r.id = e.payment_request_id AND r.organization_id = e.organization_id
    WHERE e.id = ? AND e.payment_backend = 'commerce_elements' AND e.provider_transaction_id = ?`)
      .bind(execution.id, execution.provider_transaction_id)
      .first<{
        provider_customer_id: string;
        provider_payment_method_id: string;
        amount_minor: number;
        currency: string;
      }>();
  if (!expected || !execution.provider_transaction_id)
    throw new ApiError(
      409,
      "easy_pay_direct_order_evidence_mismatch",
      "Payment confirmation needs review.",
    );
  const epd = await import("../providers/easy-pay-direct-elements");
  const result = await epd.getEasyPayDirectElementsOrder(
    env,
    execution.provider_transaction_id,
    fetcher,
  );
  return epd.validateEasyPayDirectElementsOrder(result.evidence, {
    orderId: execution.provider_transaction_id,
    customerId: expected.provider_customer_id,
    paymentMethodId: expected.provider_payment_method_id,
    amountMinor: expected.amount_minor,
    currency: expected.currency,
  });
}

// A later verified success can supersede a failed event. Select this from the
// durable ledger, not a second webhook write: interruption after settlement must
// not strand recurring setup. The exact known order can only be read, not charged.
const PAID_FAILED_EXECUTION_SQL = `status = 'failed' AND provider_transaction_id IS NOT NULL
 AND EXISTS (SELECT 1 FROM payment_request_payments paid
   JOIN payment_requests request ON request.id = paid.payment_request_id
     AND request.organization_id = paid.organization_id
   WHERE paid.organization_id = easy_pay_direct_payment_executions.organization_id
     AND paid.payment_request_id = easy_pay_direct_payment_executions.payment_request_id
     AND paid.provider = 'easy_pay_direct'
     AND paid.provider_account_code = easy_pay_direct_payment_executions.provider_account_code
     AND paid.provider_transaction_id = easy_pay_direct_payment_executions.provider_transaction_id
     AND paid.status = 'succeeded' AND paid.amount_minor = request.amount_minor
     AND paid.currency = request.currency)`;

export async function pendingEasyPayDirectExecutions(
  database: D1Database,
  networkMode: string | undefined,
): Promise<string[]> {
  // Review-held, pre-order executions must not occupy the oldest 100 slots
  // forever. An existing order still needs read-only outcome reconciliation,
  // even if an older failure code remains on that execution.
  const result = await database
    .prepare(
      `SELECT id FROM easy_pay_direct_payment_executions
     WHERE (charge_transport IN ('gateway', 'commerce') AND status IN ('processing', 'unknown')
       AND (provider_transaction_id IS NOT NULL
            OR (charge_transport = 'gateway' AND payment_backend = 'gateway_vault'
                AND ? IN ('gateway_test', 'production')
                AND (status = 'unknown' OR julianday(updated_at) <= julianday('now', '-2 minutes')))
            OR (customer_vault_id IS NOT NULL AND gateway_billing_id IS NOT NULL
                AND length(phone_ciphertext) > 0 AND length(phone_iv) > 0
                AND COALESCE(failure_code, '') <> 'easy_pay_direct_recovery_checkpoint_missing'
                AND (? <> 'production' OR (length(gateway_billing_id) BETWEEN 1 AND 32
                     AND gateway_billing_id NOT GLOB '*[^0-9]*'))
                AND ${EASY_PAY_DIRECT_PAYABLE_EXECUTION_SQL}
                AND ${EASY_PAY_DIRECT_REPLAY_WINDOW_SQL}
                AND COALESCE(failure_code, '') NOT IN (${EASY_PAY_DIRECT_SETUP_REVIEW_CODES.map(() => "?").join(", ")}))))
       OR (status = 'succeeded' AND ${EASY_PAY_DIRECT_TAX_COMMIT_PENDING_SQL})
       OR (charge_transport IN ('gateway', 'commerce') AND (${PAID_FAILED_EXECUTION_SQL}))
     ORDER BY updated_at ASC, id ASC LIMIT 100`,
    )
    .bind(
      networkMode ?? "production",
      networkMode ?? "production",
      ...EASY_PAY_DIRECT_SETUP_REVIEW_CODES,
    )
    .all<{ id: string }>();
  return result.results.map((row) => row.id);
}

export async function reconcileEasyPayDirectExecution(
  env: Env,
  executionId: string,
  fetcher: typeof fetch = fetch,
): Promise<"processed" | "deferred"> {
  try {
    return await reconcileExecution(env, executionId, fetcher);
  } catch (error) {
    if (!(error instanceof ApiError)) throw error;
    // An unavailable or inconsistent provider read is not a new payment and
    // must not stop unrelated orders from being reconciled.
    await env.BILLING_DB.prepare(
      `UPDATE easy_pay_direct_payment_executions
       SET status = 'unknown', failure_code = ?, failure_message = ?, updated_at = ?
       WHERE id = ? AND provider_transaction_id IS NOT NULL
         AND status IN ('processing', 'unknown')`,
    )
      .bind(
        error.code === "easy_pay_direct_order_evidence_mismatch"
          ? error.code
          : "easy_pay_direct_order_read_pending",
        "Payment outcome needs a verified provider read; do not submit another payment",
        new Date().toISOString(),
        executionId,
      )
      .run();
    return "deferred";
  }
}

async function reconcileExecution(
  env: Env,
  executionId: string,
  fetcher: typeof fetch,
): Promise<"processed" | "deferred"> {
  await env.BILLING_DB.prepare(`UPDATE easy_pay_direct_payment_executions
    SET status = 'unknown', completed_at = NULL, failure_code = 'easy_pay_direct_paid_followup_pending',
        failure_message = 'Payment confirmed; saved-card setup needs a verified provider read'
    WHERE id = ? AND (${PAID_FAILED_EXECUTION_SQL})`)
    .bind(executionId)
    .run();
  let execution = await env.BILLING_DB.prepare(
    `SELECT id, charge_transport, payment_backend, status, organization_id, payment_request_id, provider_account_code,
            provider_transaction_id
     FROM easy_pay_direct_payment_executions
     WHERE id = ? AND (status IN ('processing', 'unknown')
       OR (status = 'succeeded' AND ${EASY_PAY_DIRECT_TAX_COMMIT_PENDING_SQL}))
     LIMIT 1`,
  )
    .bind(executionId)
    .first<EasyPayDirectExecution>();
  if (!execution) return "processed";
  if (String(env.PROVIDER_READS_ENABLED) !== "1") return "deferred";
  if (execution.status === "succeeded" && execution.provider_transaction_id) {
    await env.BILLING_DB.prepare(
      "UPDATE easy_pay_direct_payment_executions SET updated_at = ? WHERE id = ?",
    )
      .bind(new Date().toISOString(), executionId)
      .run();
    return (await commitAppliedCheckoutTaxQuote(
      env,
      executionId,
      execution.provider_transaction_id,
      fetcher,
    )) === "retry"
      ? "deferred"
      : "processed";
  }
  if (execution.charge_transport === "gateway") {
    // A lost Gateway sale response has no Commerce vault/order checkpoint.
    // Recover only through its stable request order ID, never resume a charge.
    return reconcileEasyPayDirectGatewayExecution(env, execution.id, fetcher);
  }
  if (execution.charge_transport !== "commerce") return "deferred";
  if (execution.provider_transaction_id) {
    // Fair oldest-attempt ordering, without extending a pre-order claim lease.
    await env.BILLING_DB.prepare(
      "UPDATE easy_pay_direct_payment_executions SET updated_at = ? WHERE id = ? AND provider_transaction_id IS NOT NULL AND status IN ('processing', 'unknown')",
    )
      .bind(new Date().toISOString(), executionId)
      .run();
  }

  if (!execution.provider_transaction_id) {
    const resumed = await resumeEasyPayDirectExecution(env, executionId, fetcher);
    if (resumed === "deferred") return "deferred";
    execution = await env.BILLING_DB.prepare(
      `SELECT id, charge_transport, payment_backend, status, organization_id, payment_request_id, provider_account_code,
              provider_transaction_id
       FROM easy_pay_direct_payment_executions
       WHERE id = ? AND status IN ('processing', 'unknown') LIMIT 1`,
    )
      .bind(executionId)
      .first<EasyPayDirectExecution>();
    if (!execution?.provider_transaction_id) return "deferred";
  }

  const order =
    execution.payment_backend === "commerce_elements"
      ? await readElementsExecutionOrder(env, execution, fetcher)
      : await getEasyPayDirectOrder(env, execution.provider_transaction_id, fetcher);
  if (!order || order.id !== execution.provider_transaction_id) {
    throw new ApiError(
      409,
      "easy_pay_direct_order_evidence_mismatch",
      "Payment confirmation needs review",
    );
  }
  const normalizedStatus = normalizeOrderStatus(order.status);
  if (normalizedStatus === "pending" || normalizedStatus === "unknown") return "deferred";
  await requireEasyPayDirectOrderEvidence(
    env.BILLING_DB,
    execution.organization_id,
    execution.payment_request_id,
    order,
    execution.provider_transaction_id,
  );

  const payload = stableJson(order);
  const payloadHash = await sha256Hex(payload);
  const receiptId = await deterministicUuid(
    "easy-pay-direct-provider-read",
    `${execution.provider_account_code}:${order.id}:${order.status}`,
  );
  const providerEventId = `reconciliation:${order.id}:${order.status}`;
  const timestamp = new Date().toISOString();
  await env.BILLING_DB.batch([
    env.BILLING_DB.prepare(
      `INSERT INTO webhook_receipts
       (id, provider, provider_account_code, provider_event_id, signature_valid,
        payload_sha256, received_at, processed_at, processing_error_code)
       VALUES (?, 'easy_pay_direct_reconciliation', ?, ?, 0, ?, ?, NULL, NULL)
       ON CONFLICT(provider, provider_account_code, provider_event_id) DO NOTHING`,
    ).bind(receiptId, execution.provider_account_code, providerEventId, payloadHash, timestamp),
    env.BILLING_DB.prepare(
      `INSERT INTO provider_webhook_events
       (receipt_id, organization_id, event_type, provider_transaction_id, invoice_id,
        normalized_status, normalized_at, payment_request_id)
       VALUES (?, ?, 'order.reconciled', ?, NULL, NULL, NULL, NULL)
       ON CONFLICT(receipt_id) DO NOTHING`,
    ).bind(receiptId, execution.organization_id, order.id),
  ]);

  const receipt: PendingReceipt = {
    receipt_id: receiptId,
    organization_id: execution.organization_id,
    provider_account_code: execution.provider_account_code,
    event_type: "order.reconciled",
    provider_transaction_id: order.id,
    archive_key: null,
    processed_at: null,
  };
  await reconcilePaymentRequest(
    env.BILLING_DB,
    receipt,
    execution.payment_request_id,
    {
      id: order.id,
      amountMinor: Number.isSafeInteger(order.total) ? order.total : null,
      failureCode: normalizedStatus === "failed" ? "easy_pay_direct_order_failed" : null,
      failureMessage: normalizedStatus === "failed" ? order.failure_reason?.trim() || null : null,
    },
    normalizedStatus,
    "easy_pay_direct",
  );
  if (normalizedStatus === "succeeded") {
    return (await finalizeEasyPayDirectPaidExecution(env, execution.id, order, fetcher))
      ? "processed"
      : "deferred";
  }
  // The ledger never regresses a verified success. A stale failure must not
  // discard the execution's still-unfinished tax/card recovery either.
  if (
    await hasSuccessfulEasyPayDirectPayment(
      env.BILLING_DB,
      execution.organization_id,
      execution.payment_request_id,
      execution.provider_account_code,
      order.id,
    )
  )
    return "deferred";
  await env.BILLING_DB.prepare(
    `UPDATE easy_pay_direct_payment_executions
     SET status = ?, failure_code = ?, failure_message = ?, updated_at = ?, completed_at = ?,
         phone_ciphertext = NULL, phone_iv = NULL
     WHERE id = ? AND status IN ('processing', 'unknown')
       AND NOT EXISTS (SELECT 1 FROM payment_request_payments paid
         WHERE paid.organization_id = easy_pay_direct_payment_executions.organization_id
           AND paid.payment_request_id = easy_pay_direct_payment_executions.payment_request_id
           AND paid.provider = 'easy_pay_direct'
           AND paid.provider_account_code = easy_pay_direct_payment_executions.provider_account_code
           AND paid.provider_transaction_id = easy_pay_direct_payment_executions.provider_transaction_id
           AND paid.status = 'succeeded')`,
  )
    .bind(
      normalizedStatus,
      normalizedStatus === "failed" ? "easy_pay_direct_order_failed" : null,
      normalizedStatus === "failed" ? order.failure_reason?.trim().slice(0, 500) || null : null,
      timestamp,
      timestamp,
      execution.id,
    )
    .run();
  return "processed";
}

function normalizeOrderStatus(
  status: CommerceOrder["status"],
): "pending" | "succeeded" | "failed" | "unknown" {
  if (status === "pending") return "pending";
  if (status === "succeeded" || status === "partially_refunded" || status === "refunded") {
    return "succeeded";
  }
  if (status === "failed" || status === "voided" || status === "refund_failed") return "failed";
  return "unknown";
}

export async function reconcileEasyPayDirectReceipt(
  env: Env,
  receiptId: string,
): Promise<"processed" | "deferred"> {
  const receipt = await env.BILLING_DB.prepare(
    `SELECT e.receipt_id, e.organization_id, r.provider_account_code, e.event_type,
            e.provider_transaction_id, r.archive_key, r.processed_at
     FROM provider_webhook_events e
     JOIN webhook_receipts r ON r.id = e.receipt_id
     WHERE e.receipt_id = ? AND r.provider = 'easy_pay_direct' LIMIT 1`,
  )
    .bind(receiptId)
    .first<PendingReceipt>();
  if (!receipt || receipt.processed_at) return "processed";
  if (!receipt.archive_key || !receipt.provider_transaction_id) {
    await markIgnored(env.BILLING_DB, receiptId);
    return "processed";
  }
  const archived = await env.BILLING_ARTIFACTS.get(receipt.archive_key);
  if (!archived) throw new Error("easy_pay_direct_webhook_archive_missing");
  const raw = await archived.text();
  const normalizedEvent = normalizeArchivedEasyPayDirectEvent(raw);
  const event = normalizedEvent.event;
  const eventType = event.type?.trim() || receipt.event_type;
  if (eventType.includes("chargeback") || eventType.includes("dispute")) {
    return reconcileDispute(env.BILLING_DB, receipt, event, eventType);
  }
  if (eventType !== "order.succeeded" && eventType !== "order.failed") {
    await markIgnored(env.BILLING_DB, receiptId);
    return "processed";
  }
  if (event.data?.object?.status !== (eventType === "order.succeeded" ? "succeeded" : "failed")) {
    throw new ApiError(
      409,
      "easy_pay_direct_order_evidence_mismatch",
      "Payment event status needs a verified provider read.",
    );
  }
  const paymentRequestId =
    event.data?.object?.metadata?.lago_payment_request_id?.trim() ||
    (await findPaymentRequestId(
      env.BILLING_DB,
      receipt.provider_account_code,
      receipt.provider_transaction_id,
    ));
  if (!paymentRequestId) throw new Error("payment_request_not_found");
  const automaticExecutionId = event.data?.object?.metadata?.lago_automatic_execution_id;
  if (automaticExecutionId) {
    const { reconcileElementsAutomaticWebhook } =
      await import("../billing/easy-pay-direct-commerce-renewal");
    const checkpointed = await reconcileElementsAutomaticWebhook(env.BILLING_DB, {
      organizationId: receipt.organization_id,
      accountCode: receipt.provider_account_code,
      paymentRequestId,
      executionId: automaticExecutionId,
      order: event.data?.object,
    });
    if (!checkpointed) throw new Error("easy_pay_direct_webhook_execution_mismatch");
    // The automatic collection reader verifies and settles this saved order.
    // This receipt supplies a recovery identity, not authorization to charge.
    await env.BILLING_DB.prepare(
      "UPDATE webhook_receipts SET processed_at = ?, processing_error_code = NULL WHERE id = ?",
    )
      .bind(new Date().toISOString(), receiptId)
      .run();
    return "processed";
  }
  await requireEasyPayDirectOrderEvidence(
    env.BILLING_DB,
    receipt.organization_id,
    paymentRequestId,
    event.data?.object ?? {},
    receipt.provider_transaction_id,
  );
  // A signed success can arrive before the POST response/checkpoint. Attach it
  // only to the exact local intent, never to a request ID alone. Otherwise the
  // paid-request guard would correctly stop replay but also strand finalization.
  const execution = await env.BILLING_DB.prepare(
    `SELECT id, payment_backend, provider_customer_id, provider_payment_method_id FROM easy_pay_direct_payment_executions
     WHERE organization_id = ? AND provider_account_code = ? AND payment_request_id = ?
      AND (provider_transaction_id = ? OR
         (provider_transaction_id IS NULL AND status IN ('processing', 'unknown')
          AND (? = 1 OR checkout_intent_id = ?)))
     LIMIT 1`,
  )
    .bind(
      receipt.organization_id,
      receipt.provider_account_code,
      paymentRequestId,
      receipt.provider_transaction_id,
      normalizedEvent.gateway ? 1 : 0,
      event.data?.object?.metadata?.lago_checkout_intent_id ?? null,
    )
    .first<{
      id: string;
      payment_backend: string;
      provider_customer_id: string;
      provider_payment_method_id: string;
    }>();
  if (!execution) throw new Error("easy_pay_direct_webhook_execution_mismatch");
  if (normalizedEvent.gateway && execution.payment_backend !== "gateway_vault") {
    throw new Error("easy_pay_direct_webhook_execution_mismatch");
  }
  if (execution.payment_backend === "commerce_elements") {
    const expected = await env.BILLING_DB.prepare(
      "SELECT amount_minor, currency FROM payment_requests WHERE id = ? AND organization_id = ?",
    )
      .bind(paymentRequestId, receipt.organization_id)
      .first<{ amount_minor: number; currency: string }>();
    if (!expected) throw new Error("easy_pay_direct_webhook_execution_mismatch");
    const { validateEasyPayDirectElementsOrder } =
      await import("../providers/easy-pay-direct-elements");
    validateEasyPayDirectElementsOrder(event.data?.object, {
      orderId: receipt.provider_transaction_id,
      customerId: execution.provider_customer_id,
      paymentMethodId: execution.provider_payment_method_id,
      amountMinor: expected.amount_minor,
      currency: expected.currency,
    });
  }
  await env.BILLING_DB.prepare(
    `UPDATE easy_pay_direct_payment_executions
     SET provider_transaction_id = ?, last_checkpoint = 'provider_order', updated_at = ?
     WHERE id = ? AND provider_transaction_id IS NULL AND status IN ('processing', 'unknown')`,
  )
    .bind(receipt.provider_transaction_id, new Date().toISOString(), execution.id)
    .run();
  const status = eventType === "order.succeeded" ? "succeeded" : "failed";
  const amountMinor = Number.isSafeInteger(event.data?.object?.total)
    ? Number(event.data?.object?.total)
    : null;
  await reconcilePaymentRequest(
    env.BILLING_DB,
    receipt,
    paymentRequestId,
    {
      id: receipt.provider_transaction_id,
      amountMinor,
      failureCode: status === "failed" ? "easy_pay_direct_order_failed" : null,
      failureMessage:
        status === "failed" ? event.data?.object?.failure_reason?.trim() || null : null,
    },
    status,
    "easy_pay_direct",
  );
  const timestamp = new Date().toISOString();
  // A success webhook finalizes the invoice, but the execution remains readable
  // until provider reconciliation captures the processor transaction/card binding.
  // Never issue another charge while waiting for that provider read.
  if (status === "succeeded") return "processed";
  if (
    await hasSuccessfulEasyPayDirectPayment(
      env.BILLING_DB,
      receipt.organization_id,
      paymentRequestId,
      receipt.provider_account_code,
      receipt.provider_transaction_id,
    )
  )
    return "processed";
  await env.BILLING_DB.prepare(
    `UPDATE easy_pay_direct_payment_executions
     SET status = ?, failure_code = ?, failure_message = ?, updated_at = ?, completed_at = ?,
         phone_ciphertext = NULL, phone_iv = NULL
     WHERE provider_account_code = ? AND provider_transaction_id = ?
       AND status IN ('processing', 'unknown')
       AND NOT EXISTS (SELECT 1 FROM payment_request_payments paid
         WHERE paid.organization_id = easy_pay_direct_payment_executions.organization_id
           AND paid.payment_request_id = easy_pay_direct_payment_executions.payment_request_id
           AND paid.provider = 'easy_pay_direct'
           AND paid.provider_account_code = easy_pay_direct_payment_executions.provider_account_code
           AND paid.provider_transaction_id = easy_pay_direct_payment_executions.provider_transaction_id
           AND paid.status = 'succeeded')`,
  )
    .bind(
      status,
      status === "failed" ? "easy_pay_direct_order_failed" : null,
      status === "failed"
        ? event.data?.object?.failure_reason?.trim()?.slice(0, 500) || null
        : null,
      timestamp,
      timestamp,
      receipt.provider_account_code,
      receipt.provider_transaction_id,
    )
    .run();
  return "processed";
}

async function reconcileDispute(
  database: D1Database,
  receipt: PendingReceipt,
  event: EasyPayDirectEvent,
  eventType: string,
): Promise<"processed" | "deferred"> {
  // EPD's event envelope uses Unix seconds. Delivery/signature time and our
  // processing clock cannot establish provider event order, especially on replay.
  // https://docs.api.epd.com/api-reference/webhooks
  const timestamp = new Date().toISOString();
  const created = event.created;
  if (
    typeof created !== "number" ||
    !Number.isSafeInteger(created) ||
    created <= 0 ||
    created > Math.floor(Date.now() / 1000) + 300
  ) {
    await database.batch([
      database
        .prepare(`UPDATE provider_webhook_events SET normalized_status = 'dispute_review',
        normalized_at = ? WHERE receipt_id = ?`)
        .bind(timestamp, receipt.receipt_id),
      database
        .prepare(`UPDATE webhook_receipts SET processing_error_code =
        'epd_receipt_review:dispute_clock_unverified' WHERE id = ? AND processed_at IS NULL`)
        .bind(receipt.receipt_id),
    ]);
    return "deferred";
  }
  const eventCreatedAt = new Date(created * 1000).toISOString();
  const transactionId = receipt.provider_transaction_id!;
  // A request ID in provider metadata is not proof that this transaction paid
  // that invoice. Combined requests can cover several invoices; never LIMIT 1.
  const payment = await database
    .prepare(
      `WITH scope AS (SELECT ? AS organization_id, ? AS account_code, ? AS transaction_id),
       paid_invoices AS (
         SELECT attempt.id AS payment_attempt_id, attempt.invoice_id,
           attempt.amount_minor AS order_total, attempt.currency,
           CASE WHEN attempt.currency <> invoice.currency THEN 1 ELSE 0 END AS invalid_money
         FROM payment_attempts attempt JOIN scope s
         JOIN invoices invoice ON invoice.id = attempt.invoice_id AND invoice.organization_id = s.organization_id
         WHERE attempt.organization_id = s.organization_id AND attempt.provider = 'easy_pay_direct'
           AND attempt.provider_account_code = s.account_code AND attempt.provider_transaction_id = s.transaction_id
           AND attempt.status = 'succeeded'
         UNION ALL
         SELECT NULL, allocation.invoice_id, paid.amount_minor, paid.currency,
           CASE WHEN paid.currency <> allocation.currency OR paid.currency <> invoice.currency
             OR paid.currency <> request.currency OR paid.amount_minor <> request.amount_minor
             OR allocation.amount_minor <> paid.amount_minor THEN 1 ELSE 0 END
         FROM payment_request_payments paid
         JOIN payment_request_payment_allocations allocation ON allocation.payment_request_payment_id = paid.id
           AND allocation.organization_id = paid.organization_id
         JOIN payment_requests request ON request.id = paid.payment_request_id AND request.organization_id = paid.organization_id
         JOIN invoices invoice ON invoice.id = allocation.invoice_id AND invoice.organization_id = paid.organization_id
         JOIN scope s WHERE paid.organization_id = s.organization_id AND paid.provider = 'easy_pay_direct'
           AND paid.provider_account_code = s.account_code AND paid.provider_transaction_id = s.transaction_id
           AND paid.status = 'succeeded'
       ) SELECT COUNT(DISTINCT invoice_id) AS invoice_count,
         COUNT(DISTINCT order_total) AS amount_versions, MIN(order_total) AS order_total,
         COUNT(DISTINCT currency) AS currency_versions, MIN(currency) AS currency,
         SUM(invalid_money) AS invalid_money,
         MIN(payment_attempt_id) AS payment_attempt_id, MIN(invoice_id) AS invoice_id FROM paid_invoices`,
    )
    .bind(receipt.organization_id, receipt.provider_account_code, transactionId)
    .first<{
      invoice_count: number;
      payment_attempt_id: string | null;
      invoice_id: string | null;
      amount_versions: number;
      order_total: number | null;
      currency_versions: number;
      currency: string | null;
      invalid_money: number | null;
    }>();
  if (payment?.invoice_count !== 1 || !payment.invoice_id) {
    const ambiguous = Number(payment?.invoice_count ?? 0) > 1;
    await database.batch([
      database
        .prepare(`UPDATE provider_webhook_events SET normalized_status = ?, normalized_at = ?
        WHERE receipt_id = ?`)
        .bind(
          ambiguous ? "dispute_review" : "dispute_waiting_payment",
          timestamp,
          receipt.receipt_id,
        ),
      database
        .prepare(
          `UPDATE webhook_receipts SET processing_error_code = ? WHERE id = ? AND processed_at IS NULL`,
        )
        .bind(
          ambiguous
            ? "epd_receipt_review:dispute_invoice_link_ambiguous"
            : "epd_dispute_payment_link_pending",
          receipt.receipt_id,
        ),
    ]);
    return "deferred";
  }
  const invoiceId = payment.invoice_id;
  // This adapter understands an order snapshot, whose `total` is the settled
  // order total in minor units. It must not interpret an arbitrary dispute's
  // partial `amount` as that total. Unknown payload shapes remain review-held.
  // https://docs.api.epd.com/api-reference/orders
  const object = event.data?.object;
  const amountMinor = object?.total;
  const currency = typeof object?.currency === "string" ? object.currency.toUpperCase() : "";
  if (
    object?.object !== "order" ||
    object.id !== transactionId ||
    typeof amountMinor !== "number" ||
    !Number.isSafeInteger(amountMinor) ||
    amountMinor <= 0 ||
    !/^[A-Z]{3}$/.test(currency) ||
    payment.amount_versions !== 1 ||
    payment.currency_versions !== 1 ||
    payment.invalid_money !== 0 ||
    amountMinor !== payment.order_total ||
    currency !== payment.currency
  ) {
    await database.batch([
      database
        .prepare(`UPDATE provider_webhook_events SET normalized_status='dispute_review', normalized_at=?
        WHERE receipt_id=?`)
        .bind(timestamp, receipt.receipt_id),
      database
        .prepare(`UPDATE webhook_receipts SET processing_error_code='epd_receipt_review:dispute_money_unverified'
        WHERE id=? AND processed_at IS NULL`)
        .bind(receipt.receipt_id),
    ]);
    return "deferred";
  }
  const status = normalizeDisputeStatus(eventType, event.data?.object?.status);
  const providerDisputeId = transactionId;
  const disputeId = await deterministicUuid(
    "easy-pay-direct-dispute",
    `${receipt.provider_account_code}:${providerDisputeId}`,
  );
  const reason =
    event.data?.object?.failure_reason?.trim() || event.data?.object?.status?.trim() || eventType;
  const livemode = event.livemode === true ? 1 : 0;
  const statements: D1PreparedStatement[] = [
    database
      .prepare(
        `INSERT INTO payment_disputes
         (id, organization_id, provider, provider_account_code, provider_dispute_id,
          payment_attempt_id, invoice_id, provider_payment_intent_id, provider_charge_id,
          amount_minor, currency, reason, status, evidence_due_by, livemode,
          provider_created_at, last_provider_event_created_at, created_at, updated_at,
          last_provider_event_receipt_id)
         VALUES (?, ?, 'easy_pay_direct', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(provider, provider_account_code, provider_dispute_id) DO UPDATE SET
           payment_attempt_id = COALESCE(payment_disputes.payment_attempt_id,
                                         excluded.payment_attempt_id),
           invoice_id = COALESCE(payment_disputes.invoice_id, excluded.invoice_id),
           amount_minor = CASE WHEN excluded.amount_minor > 0
                               THEN excluded.amount_minor ELSE payment_disputes.amount_minor END,
           currency = excluded.currency, reason = excluded.reason, status = excluded.status,
           last_provider_event_created_at = excluded.last_provider_event_created_at,
           last_provider_event_receipt_id = excluded.last_provider_event_receipt_id,
           updated_at = excluded.updated_at
         WHERE payment_disputes.organization_id = excluded.organization_id
           AND payment_disputes.last_provider_event_receipt_id IS NOT NULL
           AND payment_disputes.livemode = excluded.livemode
           AND (payment_disputes.invoice_id IS NULL OR excluded.invoice_id IS NULL
                OR payment_disputes.invoice_id = excluded.invoice_id)
           AND excluded.last_provider_event_created_at > payment_disputes.last_provider_event_created_at`,
      )
      .bind(
        disputeId,
        receipt.organization_id,
        receipt.provider_account_code,
        providerDisputeId,
        payment?.payment_attempt_id ?? null,
        invoiceId,
        transactionId,
        transactionId,
        amountMinor,
        currency,
        reason.slice(0, 500),
        status,
        livemode,
        eventCreatedAt,
        eventCreatedAt,
        timestamp,
        timestamp,
        receipt.receipt_id,
      ),
    database
      .prepare(
        `UPDATE provider_webhook_events SET invoice_id = ?, normalized_at = ?,
         normalized_status = COALESCE((SELECT CASE
           WHEN last_provider_event_receipt_id IS NULL OR organization_id <> ? OR livemode <> ?
             OR (invoice_id IS NOT NULL AND invoice_id IS NOT ?)
             THEN 'dispute_review'
           WHEN last_provider_event_created_at > ? THEN 'ignored_stale'
           WHEN last_provider_event_created_at = ? AND status = ? AND amount_minor = ?
             AND currency = ? AND reason = ? THEN status
           ELSE 'dispute_review' END FROM payment_disputes
           WHERE provider = 'easy_pay_direct' AND provider_account_code = ? AND provider_dispute_id = ?), 'dispute_review')
         WHERE receipt_id = ? RETURNING normalized_status`,
      )
      .bind(
        invoiceId,
        timestamp,
        receipt.organization_id,
        livemode,
        invoiceId,
        eventCreatedAt,
        eventCreatedAt,
        status,
        amountMinor,
        currency,
        reason.slice(0, 500),
        receipt.provider_account_code,
        providerDisputeId,
        receipt.receipt_id,
      ),
    database
      .prepare(
        `UPDATE webhook_receipts
         SET processed_at = CASE WHEN (SELECT normalized_status FROM provider_webhook_events
             WHERE receipt_id = ?) = 'dispute_review' THEN NULL ELSE ? END,
           processing_error_code = CASE WHEN (SELECT normalized_status FROM provider_webhook_events
             WHERE receipt_id = ?) = 'dispute_review'
             THEN 'epd_receipt_review:dispute_ordering_conflict' ELSE NULL END WHERE id = ?`,
      )
      .bind(receipt.receipt_id, timestamp, receipt.receipt_id, receipt.receipt_id),
  ];
  if (invoiceId && status === "lost") {
    statements.push(
      database
        .prepare(
          `UPDATE invoices SET payment_dispute_lost_at = COALESCE(payment_dispute_lost_at, ?),
             updated_at = ? WHERE id = ? AND organization_id = ?
               AND EXISTS (SELECT 1 FROM provider_webhook_events
                 WHERE receipt_id = ? AND normalized_status = 'lost')`,
        )
        .bind(eventCreatedAt, timestamp, invoiceId, receipt.organization_id, receipt.receipt_id),
    );
  }
  const results = await database.batch<{ normalized_status: string }>(statements);
  return results[1]?.results[0]?.normalized_status === "dispute_review" ? "deferred" : "processed";
}

function normalizeDisputeStatus(eventType: string, condition: string | undefined) {
  const normalized = `${eventType} ${condition ?? ""}`.toLowerCase();
  if (normalized.includes("prevent")) return "prevented" as const;
  if (normalized.includes("won") || normalized.includes("win")) return "won" as const;
  if (normalized.includes("lost") || normalized.includes("lose")) return "lost" as const;
  if (normalized.includes("review")) return "under_review" as const;
  if (normalized.includes("closed")) return "warning_closed" as const;
  return "needs_response" as const;
}

async function findPaymentRequestId(
  database: D1Database,
  providerAccountCode: string,
  transactionId: string,
): Promise<string | null> {
  const row = await database
    .prepare(
      `SELECT payment_request_id FROM easy_pay_direct_payment_executions
       WHERE provider_account_code = ? AND provider_transaction_id = ? LIMIT 1`,
    )
    .bind(providerAccountCode, transactionId)
    .first<{ payment_request_id: string }>();
  return row?.payment_request_id ?? null;
}

async function markIgnored(database: D1Database, receiptId: string): Promise<void> {
  const timestamp = new Date().toISOString();
  await database.batch([
    database
      .prepare(
        `UPDATE provider_webhook_events
         SET normalized_status = 'ignored', normalized_at = ? WHERE receipt_id = ?`,
      )
      .bind(timestamp, receiptId),
    database
      .prepare(
        `UPDATE webhook_receipts SET processed_at = ?, processing_error_code = NULL WHERE id = ?`,
      )
      .bind(timestamp, receiptId),
  ]);
}
