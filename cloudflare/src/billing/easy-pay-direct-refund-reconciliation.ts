import { ApiError } from "../http";
import { readEasyPayDirectRefundByOrigin } from "./easy-pay-direct-refund-backend";
import type {
  ProviderFinancialServiceBinding,
  EasyPayDirectRefundRpcResult,
} from "../provider-financial-service";
import type { DomainEvent } from "../domain-events";
import { stableJson } from "../json";

export type RefundCheckpointIdentity = {
  operationId: string;
  organizationId: string;
  providerAccountCode: string;
  orderId: string;
  amountMinor: number;
  currency: string;
  idempotencyKey: string;
};

type RecoveryEnv = {
  APP_ENV?: string;
  BILLING_DB: D1Database;
  DOMAIN_EVENTS: Queue;
  CREDIT_NOTE_REFUND_MODE?: string;
  PROVIDER_READS_ENABLED?: string;
  EASY_PAY_DIRECT_ACCOUNT_CODE?: string;
  EASY_PAY_DIRECT_ORGANIZATION_ID?: string;
  EASY_PAY_DIRECT_NETWORK_MODE?: string;
  EASY_PAY_DIRECT_LIVEMODE_ALLOWED?: string;
  PROVIDER_FINANCIALS?: ProviderFinancialServiceBinding;
};

function easyPayDirectRefundMode(mode: string | undefined): boolean {
  return mode === "easy_pay_direct_test" || mode === "easy_pay_direct_live";
}

export async function checkpointEasyPayDirectRefund(
  database: D1Database,
  input: RefundCheckpointIdentity,
  transactionId: string,
): Promise<void> {
  if (!transactionId.trim()) throw new Error("empty_refund_transaction_checkpoint");
  const recorded = await database
    .prepare(`UPDATE provider_refund_operations
    SET provider_refund_transaction_id = ?, updated_at = ?
    WHERE id = ? AND organization_id = ? AND provider = 'easy_pay_direct'
      AND provider_account_code = ? AND provider_payment_id = ?
      AND amount_minor = ? AND currency = ? AND provider_idempotency_key = ?
      AND status = 'submitted'
      AND (provider_refund_transaction_id IS NULL OR provider_refund_transaction_id = ?)
    RETURNING id`)
    .bind(
      transactionId,
      new Date().toISOString(),
      input.operationId,
      input.organizationId,
      input.providerAccountCode,
      input.orderId,
      input.amountMinor,
      input.currency,
      input.idempotencyKey,
      transactionId,
    )
    .first();
  if (!recorded)
    throw new ApiError(
      409,
      "refund_checkpoint_conflict",
      "Refund checkpoint does not match the submitted operation",
    );
}

export async function reconcileEasyPayDirectRefundOperation(
  env: RecoveryEnv,
  operationId: string,
  fetcher: typeof fetch = fetch,
): Promise<"processed" | "deferred"> {
  if (!easyPayDirectRefundMode(env.CREDIT_NOTE_REFUND_MODE)) return "deferred";
  const operation = await env.BILLING_DB.prepare(`SELECT op.id, op.organization_id,
    op.credit_note_id, op.provider_account_code, op.provider_payment_id,
    op.provider_refund_transaction_id, op.provider_idempotency_key, op.amount_minor,
    op.currency, op.status, note.invoice_id, note.total_amount_minor,
    note.version AS credit_note_version
    FROM provider_refund_operations op
    JOIN credit_notes note ON note.id = op.credit_note_id
      AND note.organization_id = op.organization_id
    WHERE op.id = ? AND op.provider = 'easy_pay_direct'`)
    .bind(operationId)
    .first<{
      id: string;
      organization_id: string;
      credit_note_id: string | null;
      provider_account_code: string;
      provider_payment_id: string;
      provider_refund_transaction_id: string | null;
      provider_idempotency_key: string | null;
      amount_minor: number;
      currency: string;
      status: string;
      invoice_id: string;
      total_amount_minor: number;
      credit_note_version: number;
    }>();
  if (!operation || !operation.credit_note_id) return "deferred";
  if (operation.status === "succeeded" || operation.status === "failed") return "processed";
  // The API cannot look up a mutation by idempotency key. Never substitute a
  // same-amount refund or an order's cumulative status for this exact identity.
  if (
    operation.status !== "submitted" ||
    !operation.provider_refund_transaction_id ||
    !operation.provider_idempotency_key
  )
    return "deferred";
  if (
    !env.PROVIDER_FINANCIALS &&
    (env.PROVIDER_READS_ENABLED !== "1" ||
      operation.organization_id !== env.EASY_PAY_DIRECT_ORGANIZATION_ID?.trim() ||
      operation.provider_account_code !== env.EASY_PAY_DIRECT_ACCOUNT_CODE?.trim())
  )
    return "deferred";
  let result: EasyPayDirectRefundRpcResult;
  try {
    const input = {
      operationId: operation.id,
      organizationId: operation.organization_id,
      providerAccountCode: operation.provider_account_code,
      orderId: operation.provider_payment_id,
      amountMinor: operation.amount_minor,
      currency: operation.currency,
      idempotencyKey: operation.provider_idempotency_key,
      transactionId: operation.provider_refund_transaction_id,
    };
    result = env.PROVIDER_FINANCIALS
      ? await env.PROVIDER_FINANCIALS.readEasyPayDirectRefund(input)
      : await readEasyPayDirectRefundByOrigin(env as Env, input, fetcher);
  } catch (error) {
    if (!(error instanceof ApiError) && !(error instanceof TypeError)) throw error;
    await env.BILLING_DB.prepare(`UPDATE provider_refund_operations
      SET updated_at = ?, failure_code = 'easy_pay_direct_refund_read_unavailable'
      WHERE id = ? AND status = 'submitted'`)
      .bind(new Date().toISOString(), operation.id)
      .run();
    return "deferred";
  }
  const now = new Date().toISOString();
  if (result.status === "unknown" || !result.id) {
    await env.BILLING_DB.prepare(`UPDATE provider_refund_operations
      SET updated_at = ?, failure_code = 'easy_pay_direct_refund_evidence_unresolved'
      WHERE id = ? AND status = 'submitted'`)
      .bind(now, operation.id)
      .run();
    return "deferred";
  }
  const failure = result.status === "failed" ? "Easy Pay Direct confirmed the refund failed" : null;
  const resolvedEvent: DomainEvent | null =
    result.status === "succeeded"
      ? {
          id: `credit-note-refund-succeeded:${operation.credit_note_id}:${result.id}`,
          type: "credit_note.created",
          version: 1,
          aggregateType: "credit_note",
          aggregateId: operation.credit_note_id,
          aggregateVersion: operation.credit_note_version,
          occurredAt: now,
          causationId: operation.id,
          correlationId: operation.id,
          payload: {
            organizationId: operation.organization_id,
            invoiceId: operation.invoice_id,
            totalAmountMinor: operation.total_amount_minor,
          },
        }
      : null;
  const statements = [
    env.BILLING_DB.prepare(`UPDATE provider_refund_operations
      SET status = ?, provider_refund_id = ?, failure_code = ?, failure_message = ?, updated_at = ?
      WHERE id = ? AND (status = 'submitted' OR (? = 'succeeded' AND status = 'failed'))
        AND provider_refund_transaction_id = ?`).bind(
      result.status,
      result.id,
      result.status === "failed" ? "easy_pay_direct_refund_failed" : null,
      failure,
      now,
      operation.id,
      result.status,
      operation.provider_refund_transaction_id,
    ),
    env.BILLING_DB.prepare(`UPDATE credit_note_refunds SET status = ?, provider_refund_id = ?,
      failure_message = ?, updated_at = ? WHERE organization_id = ? AND credit_note_id = ?
      AND status <> 'succeeded' AND EXISTS (SELECT 1 FROM provider_refund_operations op
        WHERE op.id = ? AND op.status = ? AND op.provider_refund_id = ?)`).bind(
      result.status,
      result.id,
      failure,
      now,
      operation.organization_id,
      operation.credit_note_id,
      operation.id,
      result.status,
      result.id,
    ),
    env.BILLING_DB.prepare(`UPDATE credit_note_financials SET refund_status = ?
      WHERE organization_id = ? AND credit_note_id = ? AND refund_status <> 'succeeded'
      AND EXISTS (SELECT 1 FROM provider_refund_operations op WHERE op.id = ? AND op.status = ?)`).bind(
      result.status,
      operation.organization_id,
      operation.credit_note_id,
      operation.id,
      result.status,
    ),
    ...(resolvedEvent
      ? [
          env.BILLING_DB.prepare(`INSERT INTO outbox_events
            (event_id, organization_id, event_type, event_version, aggregate_type,
             aggregate_id, aggregate_version, causation_id, correlation_id,
             payload_json, occurred_at, published_at)
            SELECT ?,?,?,?,?,?,?,?,?,?,?,NULL
            WHERE EXISTS (SELECT 1 FROM provider_refund_operations
              WHERE id = ? AND status = 'succeeded' AND provider_refund_id = ?)
            ON CONFLICT(event_id) DO NOTHING`).bind(
            resolvedEvent.id,
            operation.organization_id,
            resolvedEvent.type,
            resolvedEvent.version,
            resolvedEvent.aggregateType,
            resolvedEvent.aggregateId,
            resolvedEvent.aggregateVersion,
            resolvedEvent.causationId,
            resolvedEvent.correlationId,
            stableJson(resolvedEvent.payload),
            resolvedEvent.occurredAt,
            operation.id,
            result.id,
          ),
        ]
      : []),
  ];
  const writes = await env.BILLING_DB.batch(statements);
  if (resolvedEvent && writes[0]?.meta.changes === 1) await env.DOMAIN_EVENTS.send(resolvedEvent);
  return "processed";
}

export async function pendingEasyPayDirectRefundOperations(env: Env): Promise<string[]> {
  if (
    !easyPayDirectRefundMode(env.CREDIT_NOTE_REFUND_MODE) ||
    env.PROVIDER_READS_ENABLED !== "1" ||
    !env.EASY_PAY_DIRECT_ORGANIZATION_ID?.trim() ||
    !env.EASY_PAY_DIRECT_ACCOUNT_CODE?.trim()
  )
    return [];
  const rows = await env.BILLING_DB.prepare(`SELECT id FROM provider_refund_operations
    WHERE provider = 'easy_pay_direct' AND status = 'submitted'
      AND organization_id = ? AND provider_account_code = ?
      AND provider_refund_transaction_id IS NOT NULL AND provider_idempotency_key IS NOT NULL
    ORDER BY updated_at, id LIMIT 25`)
    .bind(env.EASY_PAY_DIRECT_ORGANIZATION_ID, env.EASY_PAY_DIRECT_ACCOUNT_CODE)
    .all<{ id: string }>();
  return rows.results.map((row) => row.id);
}
