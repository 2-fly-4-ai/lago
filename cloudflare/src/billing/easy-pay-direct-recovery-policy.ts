// Correlated against easy_pay_direct_payment_executions in SELECT/UPDATE.
// Keep claims, batch selection, and the last pre-order check on the same rules.
// EPD retains Commerce idempotency keys for 24 hours. Stop mutating retries
// after 23 hours from immutable execution creation, leaving clock/network
// headroom. Updating a retry timestamp must never extend this safety window.
export const EASY_PAY_DIRECT_REPLAY_WINDOW_SQL = `
  julianday(easy_pay_direct_payment_executions.created_at) > julianday('now', '-23 hours')`;

// Direct successful attempts and allocations from aggregate payment requests
// both reduce the outstanding sum. The single-invoice compatibility attempt
// mirrors its allocation and must not be counted a second time.
// A stale request must not charge after another request paid/credited its invoice.
export function easyPayDirectOutstandingInvoiceBalanceSql(requestAlias: "r" | "request"): string {
  return `
    EXISTS (SELECT 1 FROM invoices_payment_requests balance_link
      WHERE balance_link.payment_request_id = ${requestAlias}.id
        AND balance_link.organization_id = ${requestAlias}.organization_id)
    AND NOT EXISTS (
      SELECT 1 FROM invoices_payment_requests balance_link
      JOIN invoices balance_invoice ON balance_invoice.id = balance_link.invoice_id
        AND balance_invoice.organization_id = balance_link.organization_id
      WHERE balance_link.payment_request_id = ${requestAlias}.id
        AND balance_link.organization_id = ${requestAlias}.organization_id
        AND (balance_invoice.status <> 'finalized'
          OR balance_invoice.payment_status = 'succeeded'
          OR balance_invoice.ready_for_payment_processing <> 1
          OR balance_invoice.currency <> ${requestAlias}.currency)
    )
    AND ${requestAlias}.amount_minor = (
      SELECT SUM(MAX(balance_invoice.total_due_minor -
        COALESCE((SELECT SUM(paid_attempt.amount_minor) FROM payment_attempts paid_attempt
          WHERE paid_attempt.invoice_id = balance_invoice.id
            AND paid_attempt.organization_id = balance_invoice.organization_id
            AND paid_attempt.status = 'succeeded'
            AND NOT EXISTS (
              SELECT 1 FROM payment_request_payment_allocations mirrored_allocation
              JOIN payment_request_payments mirrored_payment
                ON mirrored_payment.id = mirrored_allocation.payment_request_payment_id
               AND mirrored_payment.organization_id = mirrored_allocation.organization_id
              WHERE mirrored_allocation.invoice_id = paid_attempt.invoice_id
                AND mirrored_allocation.organization_id = paid_attempt.organization_id
                AND mirrored_payment.provider = paid_attempt.provider
                AND mirrored_payment.provider_account_code = paid_attempt.provider_account_code
                AND mirrored_payment.provider_transaction_id = paid_attempt.provider_transaction_id
            )), 0) -
        COALESCE((SELECT SUM(paid_allocation.amount_minor) FROM payment_request_payment_allocations paid_allocation
          WHERE paid_allocation.invoice_id = balance_invoice.id
            AND paid_allocation.organization_id = balance_invoice.organization_id), 0), 0))
      FROM invoices_payment_requests balance_link
      JOIN invoices balance_invoice ON balance_invoice.id = balance_link.invoice_id
        AND balance_invoice.organization_id = balance_link.organization_id
      WHERE balance_link.payment_request_id = ${requestAlias}.id
        AND balance_link.organization_id = ${requestAlias}.organization_id
    )`;
}

// A customer has one billing currency once any financial evidence exists. Keep
// every automatic-charge selector and final claim on the same invariant as the
// customer and checkout APIs. The aliases/expressions are internal constants.
export function easyPayDirectCustomerCurrencyEligibilitySql(
  customerAlias: string,
  currencyExpression: string,
): string {
  return `${customerAlias}.currency = ${currencyExpression}
    AND NOT EXISTS (SELECT 1 FROM invoices currency_invoice
      WHERE currency_invoice.customer_id = ${customerAlias}.id
        AND currency_invoice.organization_id = ${customerAlias}.organization_id
        AND currency_invoice.currency <> ${currencyExpression})
    AND NOT EXISTS (SELECT 1 FROM payment_requests currency_request
      WHERE currency_request.customer_id = ${customerAlias}.id
        AND currency_request.organization_id = ${customerAlias}.organization_id
        AND currency_request.currency <> ${currencyExpression})
    AND NOT EXISTS (SELECT 1 FROM subscriptions currency_subscription
      JOIN plans currency_plan ON currency_plan.id = currency_subscription.plan_id
        AND currency_plan.organization_id = currency_subscription.organization_id
      WHERE currency_subscription.customer_id = ${customerAlias}.id
        AND currency_subscription.organization_id = ${customerAlias}.organization_id
        AND currency_plan.currency <> ${currencyExpression})
    AND NOT EXISTS (SELECT 1 FROM wallets currency_wallet
      WHERE currency_wallet.customer_id = ${customerAlias}.id
        AND currency_wallet.organization_id = ${customerAlias}.organization_id
        AND currency_wallet.currency <> ${currencyExpression})`;
}

export const EASY_PAY_DIRECT_PAYABLE_EXECUTION_SQL = `
  EXISTS (
    SELECT 1 FROM payment_request_checkout_intents i
    JOIN payment_requests r ON r.id = i.payment_request_id AND r.organization_id = i.organization_id
    WHERE i.id = easy_pay_direct_payment_executions.checkout_intent_id
      AND i.organization_id = easy_pay_direct_payment_executions.organization_id
      AND i.payment_request_id = easy_pay_direct_payment_executions.payment_request_id
      AND i.provider = 'easy_pay_direct' AND i.status = 'succeeded'
      AND r.payment_status <> 'succeeded' AND r.ready_for_payment_processing = 1
      AND EXISTS (
        SELECT 1 FROM customers currency_customer
        WHERE currency_customer.id = i.customer_id
          AND currency_customer.organization_id = i.organization_id
          AND currency_customer.currency = i.currency
      )
      AND ${easyPayDirectOutstandingInvoiceBalanceSql("r")}
      AND NOT EXISTS (
        SELECT 1 FROM invoices_payment_requests own_link
        JOIN invoices_payment_requests shared_link
          ON shared_link.invoice_id = own_link.invoice_id
         AND shared_link.organization_id = own_link.organization_id
        JOIN easy_pay_direct_payment_executions other_execution
          ON other_execution.payment_request_id = shared_link.payment_request_id
         AND other_execution.organization_id = shared_link.organization_id
        WHERE own_link.payment_request_id = r.id AND own_link.organization_id = r.organization_id
          AND other_execution.id <> easy_pay_direct_payment_executions.id
          AND other_execution.status IN ('processing', 'unknown')
      )
      AND NOT EXISTS (
        SELECT 1 FROM invoices_payment_requests own_link
        JOIN invoices_payment_requests shared_link
          ON shared_link.invoice_id = own_link.invoice_id
         AND shared_link.organization_id = own_link.organization_id
        JOIN easy_pay_direct_automatic_payment_executions automatic_execution
          ON automatic_execution.payment_request_id = shared_link.payment_request_id
         AND automatic_execution.organization_id = shared_link.organization_id
        WHERE own_link.payment_request_id = r.id AND own_link.organization_id = r.organization_id
          AND automatic_execution.status IN ('processing', 'unknown')
      )
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
