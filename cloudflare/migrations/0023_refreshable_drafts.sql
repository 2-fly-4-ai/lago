ALTER TABLE organizations ADD COLUMN invoice_grace_period INTEGER NOT NULL DEFAULT 0
  CHECK (invoice_grace_period >= 0);
ALTER TABLE customers ADD COLUMN invoice_grace_period INTEGER
  CHECK (invoice_grace_period >= 0);

ALTER TABLE invoices ADD COLUMN applied_grace_period INTEGER NOT NULL DEFAULT 0
  CHECK (applied_grace_period >= 0);
ALTER TABLE invoices ADD COLUMN ready_to_be_refreshed INTEGER NOT NULL DEFAULT 0
  CHECK (ready_to_be_refreshed IN (0, 1));
ALTER TABLE invoices ADD COLUMN last_refreshed_at TEXT;

CREATE TABLE invoice_mutation_guards (
  command_id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  invoice_id TEXT NOT NULL REFERENCES invoices(id) ON DELETE RESTRICT,
  operation TEXT NOT NULL CHECK (operation IN ('refresh', 'finalize')),
  expected_version INTEGER NOT NULL CHECK (expected_version > 0),
  resulting_version INTEGER NOT NULL CHECK (resulting_version = expected_version + 1),
  created_at TEXT NOT NULL,
  UNIQUE (invoice_id, expected_version)
) STRICT;

CREATE TRIGGER invoice_mutation_guard_requires_current_draft
BEFORE INSERT ON invoice_mutation_guards
WHEN NOT EXISTS (
  SELECT 1 FROM invoices
  WHERE id = NEW.invoice_id
    AND organization_id = NEW.organization_id
    AND status = 'draft'
    AND version = NEW.expected_version
)
BEGIN
  SELECT RAISE(ABORT, 'invoice_version_conflict');
END;

CREATE INDEX invoices_ready_to_refresh_idx
  ON invoices(updated_at, id)
  WHERE status = 'draft' AND ready_to_be_refreshed = 1;

UPDATE invoices
SET expected_finalization_date = COALESCE(expected_finalization_date, issuing_date)
WHERE status = 'draft';
