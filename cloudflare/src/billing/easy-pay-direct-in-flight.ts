// Used inside invoice eligibility and, critically, the atomic pending -> processing
// payment claim. Pending attempts do not block each other; the first claim wins.
// Include attempts on the SAME request as well as different requests so a browser
// checkout cannot race a stored-method collection of that request.
export const NO_IN_FLIGHT_EPD_PAYMENT_FOR_INVOICE_SQL = `NOT EXISTS (
  SELECT 1 FROM invoices_payment_requests competing_link
  WHERE competing_link.invoice_id = invoice.id
    AND competing_link.organization_id = invoice.organization_id
    AND (
      EXISTS (SELECT 1 FROM easy_pay_direct_automatic_payment_executions competing
        WHERE competing.payment_request_id = competing_link.payment_request_id
          AND competing.organization_id = invoice.organization_id
          AND competing.status IN ('processing', 'unknown'))
      OR EXISTS (SELECT 1 FROM easy_pay_direct_payment_executions competing
        WHERE competing.payment_request_id = competing_link.payment_request_id
          AND competing.organization_id = invoice.organization_id
          AND competing.status IN ('processing', 'unknown'))
    )
)`;
