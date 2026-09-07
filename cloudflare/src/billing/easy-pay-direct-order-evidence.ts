import { ApiError } from "../http";

// Both provider reads and webhooks must prove the same money identity as the
// inline checkout. A missing amount is not permission to assume the invoice total.
export async function requireEasyPayDirectOrderEvidence(
  database: D1Database,
  organizationId: string,
  paymentRequestId: string,
  order: { id?: unknown; total?: unknown; currency?: unknown },
  expectedOrderId: string,
): Promise<void> {
  const request = await database
    .prepare(
      "SELECT amount_minor, currency FROM payment_requests WHERE id = ? AND organization_id = ?",
    )
    .bind(paymentRequestId, organizationId)
    .first<{ amount_minor: number; currency: string }>();
  if (
    !request ||
    typeof order.id !== "string" ||
    !order.id.trim() ||
    order.id !== expectedOrderId ||
    !Number.isSafeInteger(order.total) ||
    order.total !== request.amount_minor ||
    typeof order.currency !== "string" ||
    order.currency.toUpperCase() !== request.currency
  ) {
    throw new ApiError(
      409,
      "easy_pay_direct_order_evidence_mismatch",
      "Payment confirmation needs review. Please do not submit another payment.",
    );
  }
}
