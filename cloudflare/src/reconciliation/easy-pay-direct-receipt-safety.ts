import { ApiError } from "../http";
import { reconcileEasyPayDirectReceipt } from "./easy-pay-direct";

const REVIEW_PREFIX = "epd_receipt_review:";
const REVIEWABLE_ERRORS = new Set([
  "easy_pay_direct_webhook_archive_missing",
  "easy_pay_direct_webhook_invalid_json",
  "easy_pay_direct_webhook_execution_mismatch",
  "payment_request_not_found",
  "payment_request_invoices_not_found",
  "payment_request_currency_mismatch",
  "payment_request_amount_mismatch",
  "payment_request_balance_changed",
]);

// Only known receipt/evidence failures are isolated. A D1/R2 outage, unexpected
// exception, or programming error still fails the step so infrastructure faults
// cannot silently become a successful maintenance run.
export async function reconcileEasyPayDirectReceiptSafely(
  env: Env,
  receiptId: string,
  reconcile: typeof reconcileEasyPayDirectReceipt = reconcileEasyPayDirectReceipt,
): Promise<"processed" | "deferred" | "quarantined"> {
  const receipt = await env.BILLING_DB.prepare(
    "SELECT processing_error_code FROM webhook_receipts WHERE id = ? AND provider = 'easy_pay_direct'",
  )
    .bind(receiptId)
    .first<{ processing_error_code: string | null }>();
  if (receipt?.processing_error_code?.startsWith(REVIEW_PREFIX)) return "quarantined";
  try {
    return await reconcile(env, receiptId);
  } catch (error) {
    const code =
      error instanceof ApiError && error.code === "easy_pay_direct_order_evidence_mismatch"
        ? error.code
        : error instanceof Error && REVIEWABLE_ERRORS.has(error.message)
          ? error.message
          : null;
    if (!code) throw error;
    await env.BILLING_DB.prepare(
      `UPDATE webhook_receipts SET processing_error_code = ?
       WHERE id = ? AND provider = 'easy_pay_direct' AND processed_at IS NULL`,
    )
      .bind(`${REVIEW_PREFIX}${code}`, receiptId)
      .run();
    return "quarantined";
  }
}

export async function pendingProviderReceipts(database: D1Database) {
  const result = await database
    .prepare(
      `WITH ranked_receipts AS (
       SELECT id, provider, received_at,
         ROW_NUMBER() OVER (PARTITION BY provider ORDER BY received_at ASC, id ASC) AS provider_rank
       FROM webhook_receipts
       WHERE provider IN ('authorize_net', 'easy_pay_direct') AND processed_at IS NULL
         AND COALESCE(processing_error_code, '') NOT GLOB 'epd_receipt_review:*'
     )
     SELECT id, provider FROM ranked_receipts
     WHERE provider_rank <= 50
     ORDER BY received_at ASC, id ASC LIMIT 100`,
    )
    .all<{ id: string; provider: "authorize_net" | "easy_pay_direct" }>();
  return result.results;
}

export async function quarantinedEasyPayDirectReceiptCount(database: D1Database): Promise<number> {
  const row = await database
    .prepare(
      `SELECT COUNT(*) AS count FROM webhook_receipts
     WHERE provider = 'easy_pay_direct' AND processed_at IS NULL
       AND processing_error_code GLOB 'epd_receipt_review:*'`,
    )
    .first<{ count: number }>();
  return row?.count ?? 0;
}
