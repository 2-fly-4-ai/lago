// Presentation only. A review never resolves a financial outcome or authorizes replay.
// Invalidate the annotation when a payment/checkpoint/attempt changes after review.
export const reviewedCheckoutSql = `execution.status = 'unknown'
  AND execution.provider_transaction_id IS NULL
  AND NOT EXISTS (
    SELECT 1 FROM payment_request_payments payment
    WHERE payment.organization_id = execution.organization_id
      AND payment.payment_request_id = execution.payment_request_id
  )
  AND EXISTS (
    SELECT 1 FROM invoices_payment_requests link
    JOIN invoice_metadata review ON review.invoice_id = link.invoice_id
      AND review.organization_id = link.organization_id
    WHERE link.organization_id = execution.organization_id
      AND link.payment_request_id = execution.payment_request_id
      AND review.key = 'epd_execution_review'
      AND json_extract(CASE WHEN json_valid(review.value) THEN review.value ELSE '{}' END, '$.execution_id') = execution.id
      AND json_extract(CASE WHEN json_valid(review.value) THEN review.value ELSE '{}' END, '$.outcome') = 'no_matching_gateway_charge_found'
      AND json_extract(CASE WHEN json_valid(review.value) THEN review.value ELSE '{}' END, '$.checkpoint') = execution.last_checkpoint
      AND json_extract(CASE WHEN json_valid(review.value) THEN review.value ELSE '{}' END, '$.resume_count') = execution.resume_count
      AND json_extract(CASE WHEN json_valid(review.value) THEN review.value ELSE '{}' END, '$.failure_code') IS execution.failure_code
  )`;
