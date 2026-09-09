-- Distinguish production EPD refunds from sandbox EPD refunds. The runtime
-- remains fail-closed unless CREDIT_NOTE_REFUND_MODE is explicitly enabled.
DROP TRIGGER credit_note_refund_scope_guard;
DROP TRIGGER credit_note_refund_identity_immutable;

ALTER TABLE credit_note_refunds RENAME TO credit_note_refunds_before_epd_live;

CREATE TABLE credit_note_refunds (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  credit_note_id TEXT NOT NULL UNIQUE REFERENCES credit_notes(id) ON DELETE RESTRICT,
  invoice_id TEXT NOT NULL REFERENCES invoices(id) ON DELETE RESTRICT,
  provider_mode TEXT NOT NULL CHECK (
    provider_mode IN ('sandbox', 'stripe_test', 'easy_pay_direct_test', 'easy_pay_direct_live')
  ),
  provider_refund_id TEXT,
  amount_minor INTEGER NOT NULL CHECK (amount_minor > 0),
  currency TEXT NOT NULL,
  status TEXT NOT NULL CHECK (
    status IN ('pending', 'requires_action', 'succeeded', 'failed', 'canceled')
  ),
  failure_message TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (provider_mode, provider_refund_id)
) STRICT;

INSERT INTO credit_note_refunds
  (id, organization_id, credit_note_id, invoice_id, provider_mode, provider_refund_id,
   amount_minor, currency, status, failure_message, created_at, updated_at)
SELECT id, organization_id, credit_note_id, invoice_id, provider_mode, provider_refund_id,
       amount_minor, currency, status, failure_message, created_at, updated_at
FROM credit_note_refunds_before_epd_live;

DROP TABLE credit_note_refunds_before_epd_live;

CREATE TRIGGER credit_note_refund_scope_guard
BEFORE INSERT ON credit_note_refunds
WHEN NOT EXISTS (
  SELECT 1 FROM credit_notes note JOIN invoices invoice ON invoice.id = note.invoice_id
  WHERE note.id = NEW.credit_note_id
    AND note.invoice_id = NEW.invoice_id
    AND note.organization_id = NEW.organization_id
    AND invoice.organization_id = NEW.organization_id
)
BEGIN
  SELECT RAISE(ABORT, 'credit_note_refund_scope_conflict');
END;

CREATE TRIGGER credit_note_refund_identity_immutable
BEFORE UPDATE OF id, organization_id, credit_note_id, invoice_id, provider_mode, amount_minor,
  currency, created_at ON credit_note_refunds
BEGIN
  SELECT RAISE(ABORT, 'immutable_credit_note_refund_identity');
END;
