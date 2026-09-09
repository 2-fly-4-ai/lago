import { ApiError } from "../http";

export async function hasSuccessfulEasyPayDirectPayment(
  database: D1Database,
  organizationId: string,
  paymentRequestId: string,
  providerAccountCode: string,
  transactionId: string,
): Promise<boolean> {
  return Boolean(
    await database
      .prepare(
        `SELECT 1 FROM payment_request_payments payment
     JOIN payment_requests request ON request.id = payment.payment_request_id
      AND request.organization_id = payment.organization_id
     WHERE payment.organization_id = ? AND payment.payment_request_id = ?
       AND payment.provider = 'easy_pay_direct' AND payment.provider_account_code = ?
       AND payment.provider_transaction_id = ? AND payment.status = 'succeeded'
       AND payment.amount_minor = request.amount_minor AND payment.currency = request.currency LIMIT 1`,
      )
      .bind(organizationId, paymentRequestId, providerAccountCode, transactionId)
      .first(),
  );
}

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
