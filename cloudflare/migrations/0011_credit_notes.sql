CREATE TABLE credit_notes (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  customer_id TEXT NOT NULL REFERENCES customers(id) ON DELETE RESTRICT,
  invoice_id TEXT NOT NULL REFERENCES invoices(id) ON DELETE RESTRICT,
  sequential_id INTEGER NOT NULL CHECK (sequential_id > 0),
  number TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('finalized')),
  credit_status TEXT NOT NULL CHECK (credit_status IN ('available', 'consumed', 'voided')),
  reason TEXT NOT NULL CHECK (reason IN (
    'duplicated_charge', 'product_unsatisfactory', 'order_change',
    'order_cancellation', 'fraudulent_charge', 'other'
  )),
  description TEXT,
  currency TEXT NOT NULL,
  total_amount_minor INTEGER NOT NULL CHECK (total_amount_minor > 0),
  credit_amount_minor INTEGER NOT NULL CHECK (credit_amount_minor > 0),
  balance_amount_minor INTEGER NOT NULL CHECK (balance_amount_minor >= 0),
  refund_amount_minor INTEGER NOT NULL DEFAULT 0 CHECK (refund_amount_minor = 0),
  offset_amount_minor INTEGER NOT NULL DEFAULT 0 CHECK (offset_amount_minor = 0),
  taxes_amount_minor INTEGER NOT NULL DEFAULT 0 CHECK (taxes_amount_minor = 0),
  coupons_adjustment_minor INTEGER NOT NULL DEFAULT 0 CHECK (coupons_adjustment_minor = 0),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  idempotency_key TEXT NOT NULL,
  request_sha256 TEXT NOT NULL,
  issuing_date TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  voided_at TEXT,
  UNIQUE (invoice_id, sequential_id),
  UNIQUE (organization_id, number),
  UNIQUE (organization_id, idempotency_key),
  CHECK (total_amount_minor = credit_amount_minor)
) STRICT;

CREATE INDEX credit_notes_customer_balance_idx
  ON credit_notes(customer_id, currency, credit_status, created_at);
CREATE INDEX credit_notes_invoice_idx ON credit_notes(invoice_id, created_at);

CREATE TABLE credit_note_items (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  credit_note_id TEXT NOT NULL REFERENCES credit_notes(id) ON DELETE RESTRICT,
  invoice_line_id TEXT NOT NULL REFERENCES invoice_lines(id) ON DELETE RESTRICT,
  amount_minor INTEGER NOT NULL CHECK (amount_minor > 0),
  precise_amount_minor TEXT NOT NULL,
  currency TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (credit_note_id, invoice_line_id)
) STRICT;

CREATE INDEX credit_note_items_line_idx ON credit_note_items(invoice_line_id, created_at);

CREATE TRIGGER credit_note_item_requires_remaining_amount
BEFORE INSERT ON credit_note_items
WHEN NOT EXISTS (
  SELECT 1
  FROM invoice_lines il
  JOIN invoices invoice ON invoice.id = il.invoice_id
  JOIN credit_notes new_cn ON new_cn.id = NEW.credit_note_id
  WHERE il.id = NEW.invoice_line_id
    AND il.invoice_id = new_cn.invoice_id
    AND invoice.organization_id = NEW.organization_id
    AND new_cn.organization_id = NEW.organization_id
    AND NEW.amount_minor <= il.amount_minor - COALESCE((
      SELECT SUM(existing_item.amount_minor)
      FROM credit_note_items existing_item
      JOIN credit_notes existing_cn ON existing_cn.id = existing_item.credit_note_id
      WHERE existing_item.invoice_line_id = NEW.invoice_line_id
        AND existing_cn.credit_status <> 'voided'
    ), 0)
)
BEGIN
  SELECT RAISE(ABORT, 'credit_note_item_conflict');
END;

CREATE TABLE credit_note_applications (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  credit_note_id TEXT NOT NULL REFERENCES credit_notes(id) ON DELETE RESTRICT,
  invoice_id TEXT NOT NULL REFERENCES invoices(id) ON DELETE RESTRICT,
  credit_note_version INTEGER NOT NULL CHECK (credit_note_version > 0),
  amount_minor INTEGER NOT NULL CHECK (amount_minor > 0),
  created_at TEXT NOT NULL,
  UNIQUE (credit_note_id, invoice_id)
) STRICT;

CREATE INDEX credit_note_applications_invoice_idx
  ON credit_note_applications(invoice_id, created_at);

CREATE TRIGGER credit_note_application_requires_balance
BEFORE INSERT ON credit_note_applications
WHEN NOT EXISTS (
  SELECT 1 FROM credit_notes
  WHERE id = NEW.credit_note_id
    AND organization_id = NEW.organization_id
    AND credit_status = 'available'
    AND version = NEW.credit_note_version
    AND balance_amount_minor >= NEW.amount_minor
)
BEGIN
  SELECT RAISE(ABORT, 'credit_note_version_conflict');
END;

CREATE TABLE credit_note_recredits (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  application_id TEXT NOT NULL REFERENCES credit_note_applications(id) ON DELETE RESTRICT,
  credit_note_id TEXT NOT NULL REFERENCES credit_notes(id) ON DELETE RESTRICT,
  voided_invoice_id TEXT NOT NULL REFERENCES invoices(id) ON DELETE RESTRICT,
  credit_note_version INTEGER NOT NULL CHECK (credit_note_version > 0),
  amount_minor INTEGER NOT NULL CHECK (amount_minor > 0),
  created_at TEXT NOT NULL,
  UNIQUE (application_id)
) STRICT;

CREATE TRIGGER credit_note_recredit_requires_current_application
BEFORE INSERT ON credit_note_recredits
WHEN NOT EXISTS (
  SELECT 1
  FROM credit_note_applications cna
  JOIN credit_notes cn ON cn.id = cna.credit_note_id
  JOIN invoices i ON i.id = cna.invoice_id
  WHERE cna.id = NEW.application_id
    AND cna.organization_id = NEW.organization_id
    AND cna.credit_note_id = NEW.credit_note_id
    AND cna.invoice_id = NEW.voided_invoice_id
    AND cna.amount_minor = NEW.amount_minor
    AND cn.version = NEW.credit_note_version
    AND cn.credit_status <> 'voided'
    AND i.status = 'voided'
)
BEGIN
  SELECT RAISE(ABORT, 'credit_note_recredit_conflict');
END;

ALTER TABLE invoices ADD COLUMN credit_notes_minor INTEGER NOT NULL DEFAULT 0 CHECK (credit_notes_minor >= 0);
