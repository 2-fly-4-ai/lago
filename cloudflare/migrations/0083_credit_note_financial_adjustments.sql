-- Credit notes originally shipped as credit-only records. Keep the immutable legacy row as the
-- aggregate root and add the complete financial split and source-invoice snapshots alongside it.
CREATE TABLE credit_note_financials (
  credit_note_id TEXT PRIMARY KEY REFERENCES credit_notes(id) ON DELETE RESTRICT,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  items_amount_minor INTEGER NOT NULL CHECK (items_amount_minor > 0),
  taxes_amount_minor INTEGER NOT NULL CHECK (taxes_amount_minor >= 0),
  coupons_adjustment_minor INTEGER NOT NULL CHECK (coupons_adjustment_minor >= 0),
  total_amount_minor INTEGER NOT NULL CHECK (total_amount_minor > 0),
  credit_amount_minor INTEGER NOT NULL CHECK (credit_amount_minor >= 0),
  refund_amount_minor INTEGER NOT NULL CHECK (refund_amount_minor >= 0),
  offset_amount_minor INTEGER NOT NULL CHECK (offset_amount_minor >= 0),
  precise_taxes_amount_minor TEXT NOT NULL,
  refund_status TEXT CHECK (refund_status IN ('pending', 'succeeded', 'failed')),
  created_at TEXT NOT NULL,
  CHECK (total_amount_minor = items_amount_minor + taxes_amount_minor - coupons_adjustment_minor),
  CHECK (total_amount_minor = credit_amount_minor + refund_amount_minor + offset_amount_minor),
  CHECK ((refund_amount_minor = 0 AND refund_status IS NULL) OR
         (refund_amount_minor > 0 AND refund_status IS NOT NULL))
) STRICT;

CREATE TRIGGER credit_note_financials_tenant_guard
BEFORE INSERT ON credit_note_financials
WHEN NOT EXISTS (
  SELECT 1 FROM credit_notes note
  WHERE note.id = NEW.credit_note_id AND note.organization_id = NEW.organization_id
)
BEGIN
  SELECT RAISE(ABORT, 'credit_note_financial_scope_conflict');
END;

CREATE TRIGGER credit_note_financials_immutable
BEFORE UPDATE ON credit_note_financials
BEGIN
  SELECT RAISE(ABORT, 'immutable_credit_note_financials');
END;

CREATE TABLE credit_note_item_adjustments (
  credit_note_item_id TEXT PRIMARY KEY REFERENCES credit_note_items(id) ON DELETE RESTRICT,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  coupon_adjustment_minor INTEGER NOT NULL CHECK (coupon_adjustment_minor >= 0),
  taxable_base_minor INTEGER NOT NULL CHECK (taxable_base_minor >= 0),
  created_at TEXT NOT NULL
) STRICT;

CREATE TRIGGER credit_note_item_adjustment_scope_guard
BEFORE INSERT ON credit_note_item_adjustments
WHEN NOT EXISTS (
  SELECT 1 FROM credit_note_items item
  JOIN credit_notes note ON note.id = item.credit_note_id
  WHERE item.id = NEW.credit_note_item_id
    AND item.organization_id = NEW.organization_id
    AND note.organization_id = NEW.organization_id
)
BEGIN
  SELECT RAISE(ABORT, 'credit_note_item_adjustment_scope_conflict');
END;

CREATE TABLE credit_note_taxes (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  credit_note_id TEXT NOT NULL REFERENCES credit_notes(id) ON DELETE RESTRICT,
  credit_note_item_id TEXT NOT NULL REFERENCES credit_note_items(id) ON DELETE RESTRICT,
  invoice_line_tax_id TEXT NOT NULL REFERENCES invoice_line_taxes(id) ON DELETE RESTRICT,
  tax_id TEXT NOT NULL REFERENCES taxes(id) ON DELETE RESTRICT,
  tax_code TEXT NOT NULL,
  tax_name TEXT NOT NULL,
  tax_description TEXT,
  tax_rate TEXT NOT NULL,
  taxable_base_minor INTEGER NOT NULL CHECK (taxable_base_minor >= 0),
  amount_minor INTEGER NOT NULL CHECK (amount_minor >= 0),
  precise_amount_minor TEXT NOT NULL,
  currency TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (credit_note_item_id, invoice_line_tax_id)
) STRICT;

CREATE INDEX credit_note_taxes_note_idx ON credit_note_taxes(credit_note_id, tax_id, created_at);

CREATE TRIGGER credit_note_tax_scope_guard
BEFORE INSERT ON credit_note_taxes
WHEN NOT EXISTS (
  SELECT 1 FROM credit_notes note
  JOIN credit_note_items item ON item.credit_note_id = note.id
  JOIN invoice_line_taxes source_tax ON source_tax.id = NEW.invoice_line_tax_id
  WHERE note.id = NEW.credit_note_id
    AND item.id = NEW.credit_note_item_id
    AND item.invoice_line_id = source_tax.invoice_line_id
    AND note.organization_id = NEW.organization_id
    AND item.organization_id = NEW.organization_id
    AND source_tax.organization_id = NEW.organization_id
    AND source_tax.tax_id = NEW.tax_id
)
BEGIN
  SELECT RAISE(ABORT, 'credit_note_tax_scope_conflict');
END;

CREATE TABLE credit_note_offsets (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  credit_note_id TEXT NOT NULL UNIQUE REFERENCES credit_notes(id) ON DELETE RESTRICT,
  invoice_id TEXT NOT NULL REFERENCES invoices(id) ON DELETE RESTRICT,
  amount_minor INTEGER NOT NULL CHECK (amount_minor > 0),
  status TEXT NOT NULL CHECK (status IN ('succeeded')),
  created_at TEXT NOT NULL
) STRICT;

CREATE TRIGGER credit_note_offset_scope_guard
BEFORE INSERT ON credit_note_offsets
WHEN NOT EXISTS (
  SELECT 1 FROM credit_notes note JOIN invoices invoice ON invoice.id = note.invoice_id
  WHERE note.id = NEW.credit_note_id
    AND note.invoice_id = NEW.invoice_id
    AND note.organization_id = NEW.organization_id
    AND invoice.organization_id = NEW.organization_id
    AND invoice.status = 'finalized'
    AND NEW.amount_minor <= invoice.total_due_minor - COALESCE((
      SELECT SUM(payment.amount_minor) FROM payment_attempts payment
      WHERE payment.invoice_id = invoice.id AND payment.status = 'succeeded'
    ), 0)
)
BEGIN
  SELECT RAISE(ABORT, 'credit_note_offset_scope_conflict');
END;

CREATE TABLE credit_note_refunds (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  credit_note_id TEXT NOT NULL UNIQUE REFERENCES credit_notes(id) ON DELETE RESTRICT,
  invoice_id TEXT NOT NULL REFERENCES invoices(id) ON DELETE RESTRICT,
  provider_mode TEXT NOT NULL CHECK (provider_mode IN ('sandbox')),
  provider_refund_id TEXT NOT NULL,
  amount_minor INTEGER NOT NULL CHECK (amount_minor > 0),
  currency TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('succeeded')),
  created_at TEXT NOT NULL,
  UNIQUE (provider_mode, provider_refund_id)
) STRICT;

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
