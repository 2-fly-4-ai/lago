ALTER TABLE credit_notes
  ADD COLUMN allocation_state TEXT NOT NULL DEFAULT 'finalized'
  CHECK (allocation_state IN ('draft', 'finalized'));

CREATE TABLE termination_credit_note_contexts (
  credit_note_id TEXT PRIMARY KEY REFERENCES credit_notes(id) ON DELETE RESTRICT,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  subscription_id TEXT NOT NULL REFERENCES subscriptions(id) ON DELETE RESTRICT,
  source_invoice_id TEXT NOT NULL REFERENCES invoices(id) ON DELETE RESTRICT,
  unused_days INTEGER NOT NULL CHECK (unused_days > 0),
  full_period_days INTEGER NOT NULL CHECK (full_period_days >= unused_days),
  correlation_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (subscription_id)
) STRICT;

CREATE INDEX termination_credit_note_contexts_source_idx
  ON termination_credit_note_contexts(source_invoice_id, credit_note_id);

DROP TRIGGER credit_note_application_requires_balance;

CREATE TRIGGER credit_note_application_requires_balance
BEFORE INSERT ON credit_note_applications
WHEN NOT EXISTS (
  SELECT 1 FROM credit_notes
  WHERE id = NEW.credit_note_id
    AND organization_id = NEW.organization_id
    AND allocation_state = 'finalized'
    AND credit_status = 'available'
    AND version = NEW.credit_note_version
    AND balance_amount_minor >= NEW.amount_minor
)
BEGIN
  SELECT RAISE(ABORT, 'credit_note_version_conflict');
END;
