PRAGMA foreign_keys = ON;

ALTER TABLE customers ADD COLUMN document_locale TEXT;
ALTER TABLE customers ADD COLUMN subscription_invoice_issuing_date_adjustment TEXT
  CHECK (subscription_invoice_issuing_date_adjustment IS NULL OR
         subscription_invoice_issuing_date_adjustment IN ('keep_anchor', 'align_with_finalization_date'));
ALTER TABLE customers ADD COLUMN subscription_invoice_issuing_date_anchor TEXT
  CHECK (subscription_invoice_issuing_date_anchor IS NULL OR
         subscription_invoice_issuing_date_anchor IN ('current_period_end', 'next_period_start'));

CREATE TABLE customer_applied_taxes (
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  customer_id TEXT NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  tax_id TEXT NOT NULL REFERENCES taxes(id) ON DELETE RESTRICT,
  created_at TEXT NOT NULL,
  PRIMARY KEY (customer_id, tax_id)
) STRICT;

CREATE TRIGGER customer_applied_taxes_tenant_guard
BEFORE INSERT ON customer_applied_taxes
WHEN NOT EXISTS (
  SELECT 1 FROM customers customer JOIN taxes tax ON tax.id = NEW.tax_id
  WHERE customer.id = NEW.customer_id
    AND customer.organization_id = NEW.organization_id
    AND tax.organization_id = NEW.organization_id
    AND tax.status = 'active'
)
BEGIN
  SELECT RAISE(ABORT, 'customer_applied_tax_scope_conflict');
END;

CREATE TABLE billing_entity_assets (
  organization_id TEXT PRIMARY KEY REFERENCES organizations(id) ON DELETE CASCADE,
  object_key TEXT NOT NULL,
  mime_type TEXT NOT NULL CHECK (mime_type IN ('image/png', 'image/jpeg', 'image/webp')),
  filename TEXT NOT NULL,
  byte_size INTEGER NOT NULL CHECK (byte_size > 0 AND byte_size <= 1048576),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;

CREATE TABLE invoice_metadata (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  invoice_id TEXT NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
  key TEXT NOT NULL CHECK (length(key) BETWEEN 1 AND 64),
  value TEXT NOT NULL CHECK (length(value) <= 512),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (invoice_id, key)
) STRICT;

CREATE TRIGGER invoice_metadata_tenant_guard
BEFORE INSERT ON invoice_metadata
WHEN NOT EXISTS (
  SELECT 1 FROM invoices invoice
  WHERE invoice.id = NEW.invoice_id AND invoice.organization_id = NEW.organization_id
)
BEGIN
  SELECT RAISE(ABORT, 'invoice_metadata_scope_conflict');
END;

CREATE TABLE adjusted_fees (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  invoice_id TEXT NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
  invoice_line_id TEXT REFERENCES invoice_lines(id) ON DELETE CASCADE,
  description TEXT NOT NULL,
  quantity_decimal TEXT NOT NULL,
  unit_amount_decimal TEXT NOT NULL,
  amount_minor INTEGER NOT NULL CHECK (amount_minor >= 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (invoice_id, invoice_line_id)
) STRICT;

CREATE TRIGGER adjusted_fees_tenant_guard
BEFORE INSERT ON adjusted_fees
WHEN NOT EXISTS (
  SELECT 1 FROM invoices invoice
  LEFT JOIN invoice_lines line ON line.id = NEW.invoice_line_id
  WHERE invoice.id = NEW.invoice_id
    AND invoice.organization_id = NEW.organization_id
    AND (NEW.invoice_line_id IS NULL OR line.invoice_id = invoice.id)
)
BEGIN
  SELECT RAISE(ABORT, 'adjusted_fee_scope_conflict');
END;

CREATE INDEX invoice_metadata_invoice_idx ON invoice_metadata(invoice_id, created_at, id);
CREATE INDEX adjusted_fees_invoice_idx ON adjusted_fees(invoice_id, created_at, id);

CREATE TABLE invoice_regenerations (
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  source_invoice_id TEXT PRIMARY KEY REFERENCES invoices(id) ON DELETE RESTRICT,
  regenerated_invoice_id TEXT NOT NULL UNIQUE REFERENCES invoices(id) ON DELETE RESTRICT,
  created_at TEXT NOT NULL
) STRICT;

CREATE TRIGGER invoice_regenerations_tenant_guard
BEFORE INSERT ON invoice_regenerations
WHEN NOT EXISTS (
  SELECT 1 FROM invoices source JOIN invoices regenerated ON regenerated.id = NEW.regenerated_invoice_id
  WHERE source.id = NEW.source_invoice_id
    AND source.organization_id = NEW.organization_id
    AND regenerated.organization_id = NEW.organization_id
)
BEGIN
  SELECT RAISE(ABORT, 'invoice_regeneration_scope_conflict');
END;
