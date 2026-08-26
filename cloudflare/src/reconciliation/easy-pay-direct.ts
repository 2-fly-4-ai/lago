import { reconcilePaymentRequest, type PendingReceipt } from "./authorize-net";
import { sha256Hex } from "../auth/api-key";
import { deterministicUuid } from "../identifiers";
import { stableJson } from "../json";
import { getEasyPayDirectOrder, type CommerceOrder } from "../providers/easy-pay-direct";

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

type EasyPayDirectExecution = {
  id: string;
  organization_id: string;
  payment_request_id: string;
  provider_account_code: string;
  provider_transaction_id: string;
};

export async function reconcileEasyPayDirectExecution(
  env: Env,
  executionId: string,
  fetcher: typeof fetch = fetch,
): Promise<"processed" | "deferred"> {
  const execution = await env.BILLING_DB.prepare(
    `SELECT id, organization_id, payment_request_id, provider_account_code,
            provider_transaction_id
     FROM easy_pay_direct_payment_executions
     WHERE id = ? AND status IN ('processing', 'unknown')
       AND provider_transaction_id IS NOT NULL
     LIMIT 1`,
  )
    .bind(executionId)
    .first<EasyPayDirectExecution>();
  if (!execution) return "processed";
  if (String(env.PROVIDER_READS_ENABLED) !== "1") return "deferred";

  const order = await getEasyPayDirectOrder(env, execution.provider_transaction_id, fetcher);
  if (order.id !== execution.provider_transaction_id) {
    throw new Error("easy_pay_direct_order_identity_mismatch");
  }
  const normalizedStatus = normalizeOrderStatus(order.status);
  if (normalizedStatus === "pending" || normalizedStatus === "unknown") return "deferred";

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
  await env.BILLING_DB.prepare(
    `UPDATE easy_pay_direct_payment_executions
     SET status = ?, failure_code = ?, failure_message = ?, updated_at = ?, completed_at = ?
     WHERE id = ? AND status IN ('processing', 'unknown')`,
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
  let event: EasyPayDirectEvent;
  try {
    event = JSON.parse(raw) as EasyPayDirectEvent;
  } catch {
    throw new Error("easy_pay_direct_webhook_invalid_json");
  }
  const eventType = event.type?.trim() || receipt.event_type;
  if (eventType.includes("chargeback") || eventType.includes("dispute")) {
    await reconcileDispute(env.BILLING_DB, receipt, event, eventType);
    return "processed";
  }
  if (eventType !== "order.succeeded" && eventType !== "order.failed") {
    await markIgnored(env.BILLING_DB, receiptId);
    return "processed";
  }
  const paymentRequestId =
    event.data?.object?.metadata?.lago_payment_request_id?.trim() ||
    (await findPaymentRequestId(
      env.BILLING_DB,
      receipt.provider_account_code,
      receipt.provider_transaction_id,
    ));
  if (!paymentRequestId) throw new Error("payment_request_not_found");
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
  await env.BILLING_DB.prepare(
    `UPDATE easy_pay_direct_payment_executions
     SET status = ?, failure_code = ?, failure_message = ?, updated_at = ?, completed_at = ?
     WHERE provider_account_code = ? AND provider_transaction_id = ?
       AND status IN ('processing', 'unknown')`,
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
): Promise<void> {
  const transactionId = receipt.provider_transaction_id!;
  const paymentRequestId =
    event.data?.object?.metadata?.lago_payment_request_id?.trim() ||
    (await findPaymentRequestId(database, receipt.provider_account_code, transactionId));
  const payment = await database
    .prepare(
      `SELECT attempt.id AS payment_attempt_id, attempt.invoice_id
       FROM payment_attempts attempt
       WHERE attempt.organization_id = ? AND attempt.provider = 'easy_pay_direct'
         AND attempt.provider_account_code = ? AND attempt.provider_transaction_id = ?
       LIMIT 1`,
    )
    .bind(receipt.organization_id, receipt.provider_account_code, transactionId)
    .first<{ payment_attempt_id: string; invoice_id: string }>();
  const linkedInvoice = paymentRequestId
    ? await database
        .prepare(
          `SELECT link.invoice_id FROM invoices_payment_requests link
           WHERE link.organization_id = ? AND link.payment_request_id = ?
           ORDER BY link.created_at, link.id LIMIT 1`,
        )
        .bind(receipt.organization_id, paymentRequestId)
        .first<{ invoice_id: string }>()
    : null;
  const invoiceId = payment?.invoice_id ?? linkedInvoice?.invoice_id ?? null;
  const amountMinor = Number.isSafeInteger(event.data?.object?.total)
    ? Number(event.data?.object?.total)
    : 0;
  const currency = event.data?.object?.currency?.trim().toUpperCase() || "USD";
  const status = normalizeDisputeStatus(eventType, event.data?.object?.status);
  const timestamp = new Date().toISOString();
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
          provider_created_at, last_provider_event_created_at, created_at, updated_at)
         VALUES (?, ?, 'easy_pay_direct', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?)
         ON CONFLICT(provider, provider_account_code, provider_dispute_id) DO UPDATE SET
           payment_attempt_id = COALESCE(payment_disputes.payment_attempt_id,
                                         excluded.payment_attempt_id),
           invoice_id = COALESCE(payment_disputes.invoice_id, excluded.invoice_id),
           amount_minor = CASE WHEN excluded.amount_minor > 0
                               THEN excluded.amount_minor ELSE payment_disputes.amount_minor END,
           currency = excluded.currency, reason = excluded.reason, status = excluded.status,
           last_provider_event_created_at = excluded.last_provider_event_created_at,
           updated_at = excluded.updated_at`,
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
        timestamp,
        timestamp,
        timestamp,
        timestamp,
      ),
    database
      .prepare(
        `UPDATE provider_webhook_events
         SET invoice_id = ?, normalized_status = ?, normalized_at = ? WHERE receipt_id = ?`,
      )
      .bind(invoiceId, status, timestamp, receipt.receipt_id),
    database
      .prepare(
        `UPDATE webhook_receipts
         SET processed_at = ?, processing_error_code = NULL WHERE id = ?`,
      )
      .bind(timestamp, receipt.receipt_id),
  ];
  if (invoiceId && status === "lost") {
    statements.push(
      database
        .prepare(
          `UPDATE invoices SET payment_dispute_lost_at = COALESCE(payment_dispute_lost_at, ?),
             updated_at = ? WHERE id = ? AND organization_id = ?`,
        )
        .bind(timestamp, timestamp, invoiceId, receipt.organization_id),
    );
  }
  await database.batch(statements);
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
