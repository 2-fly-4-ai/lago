CREATE TRIGGER provider_refund_rejects_lost_dispute
BEFORE INSERT ON provider_refund_operations
WHEN EXISTS (
  SELECT 1 FROM invoices invoice
  WHERE invoice.id = NEW.invoice_id
    AND invoice.organization_id = NEW.organization_id
    AND invoice.payment_dispute_lost_at IS NOT NULL
)
BEGIN
  SELECT RAISE(ABORT, 'refund_unavailable_after_lost_dispute');
END;

CREATE TRIGGER provider_refund_update_rejects_lost_dispute
BEFORE UPDATE OF status ON provider_refund_operations
WHEN NEW.status IN ('requires_action', 'submitted', 'succeeded') AND EXISTS (
  SELECT 1 FROM invoices invoice
  WHERE invoice.id = NEW.invoice_id
    AND invoice.organization_id = NEW.organization_id
    AND invoice.payment_dispute_lost_at IS NOT NULL
)
BEGIN
  SELECT RAISE(ABORT, 'refund_unavailable_after_lost_dispute');
END;
