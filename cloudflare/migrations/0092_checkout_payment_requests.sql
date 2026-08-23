ALTER TABLE payment_requests ADD COLUMN collection_mode TEXT NOT NULL DEFAULT 'overdue'
  CHECK (collection_mode IN ('overdue', 'checkout'));

DROP TRIGGER invoices_payment_requests_insert_guard;

CREATE TRIGGER invoices_payment_requests_insert_guard
BEFORE INSERT ON invoices_payment_requests
WHEN NOT EXISTS (
  SELECT 1
  FROM payment_requests request
  JOIN invoices invoice ON invoice.id = NEW.invoice_id
  WHERE request.id = NEW.payment_request_id
    AND request.organization_id = NEW.organization_id
    AND invoice.organization_id = NEW.organization_id
    AND invoice.customer_id = request.customer_id
    AND invoice.version = NEW.invoice_version
    AND invoice.status = 'finalized'
    AND invoice.payment_status <> 'succeeded'
    AND (
      invoice.payment_overdue = 1 OR
      (
        request.collection_mode = 'checkout'
        AND invoice.net_payment_term = 0
        AND (
          invoice.payment_due_date IS NULL OR
          date(invoice.payment_due_date) <= date(NEW.created_at)
        )
      )
    )
    AND invoice.ready_for_payment_processing = 1
)
BEGIN
  SELECT RAISE(ABORT, 'invalid_payment_request_invoice');
END;
