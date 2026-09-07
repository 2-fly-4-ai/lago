// Correlated against easy_pay_direct_payment_executions in SELECT/UPDATE.
// Keep claims, batch selection, and the last pre-order check on the same rules.
export const EASY_PAY_DIRECT_PAYABLE_EXECUTION_SQL = `
  EXISTS (
    SELECT 1 FROM payment_request_checkout_intents i
    JOIN payment_requests r ON r.id = i.payment_request_id AND r.organization_id = i.organization_id
    WHERE i.id = easy_pay_direct_payment_executions.checkout_intent_id
      AND i.organization_id = easy_pay_direct_payment_executions.organization_id
      AND i.payment_request_id = easy_pay_direct_payment_executions.payment_request_id
      AND i.provider = 'easy_pay_direct' AND i.status = 'succeeded'
      AND r.payment_status <> 'succeeded' AND r.ready_for_payment_processing = 1
      AND NOT EXISTS (SELECT 1 FROM customer_closure_holds h
                      WHERE h.customer_id = i.customer_id)
      AND NOT EXISTS (SELECT 1 FROM customer_closure_email_holds h
                      JOIN customers c ON c.organization_id = h.organization_id AND lower(c.email) = h.email
                      WHERE c.id = i.customer_id)
  )`;

// Also recover tax follow-ups from older/Gateway checkouts that already marked
// execution success. A matching settled ledger entry is required; never charge.
export const EASY_PAY_DIRECT_TAX_COMMIT_PENDING_SQL = `
  EXISTS (
    SELECT 1 FROM easy_pay_direct_checkout_tax_quotes q
    JOIN payment_request_payments p ON p.payment_request_id = easy_pay_direct_payment_executions.payment_request_id
    JOIN payment_requests r ON r.id = p.payment_request_id AND r.organization_id = p.organization_id
    WHERE q.id = easy_pay_direct_payment_executions.tax_quote_id
      AND q.status IN ('applied', 'commit_failed')
      AND p.organization_id = easy_pay_direct_payment_executions.organization_id
      AND p.provider = 'easy_pay_direct'
      AND p.provider_account_code = easy_pay_direct_payment_executions.provider_account_code
      AND p.provider_transaction_id = easy_pay_direct_payment_executions.provider_transaction_id
      AND p.status = 'succeeded' AND p.amount_minor = r.amount_minor AND p.currency = r.currency
  )`;
