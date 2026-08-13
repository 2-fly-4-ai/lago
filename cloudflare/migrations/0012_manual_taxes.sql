CREATE TABLE taxes (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  rate TEXT NOT NULL,
  applied_to_organization INTEGER NOT NULL CHECK (applied_to_organization IN (0, 1)),
  status TEXT NOT NULL CHECK (status IN ('active', 'terminated')),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  request_sha256 TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  terminated_at TEXT
) STRICT;

CREATE UNIQUE INDEX taxes_active_code_idx
  ON taxes(organization_id, code) WHERE status = 'active';
CREATE INDEX taxes_active_default_idx
  ON taxes(organization_id, applied_to_organization, status, created_at);

CREATE TABLE invoice_line_taxes (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  invoice_id TEXT NOT NULL REFERENCES invoices(id) ON DELETE RESTRICT,
  invoice_line_id TEXT NOT NULL REFERENCES invoice_lines(id) ON DELETE RESTRICT,
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
  UNIQUE (invoice_line_id, tax_id)
) STRICT;

CREATE INDEX invoice_line_taxes_invoice_idx ON invoice_line_taxes(invoice_id, created_at);

CREATE TABLE invoice_taxes (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  invoice_id TEXT NOT NULL REFERENCES invoices(id) ON DELETE RESTRICT,
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
  UNIQUE (invoice_id, tax_id)
) STRICT;

CREATE INDEX invoice_taxes_tax_idx ON invoice_taxes(tax_id, created_at);

CREATE TRIGGER invoice_line_tax_requires_owned_line
BEFORE INSERT ON invoice_line_taxes
WHEN NOT EXISTS (
  SELECT 1 FROM invoice_lines il
  JOIN invoices i ON i.id = il.invoice_id
  JOIN taxes t ON t.id = NEW.tax_id
  WHERE il.id = NEW.invoice_line_id
    AND il.invoice_id = NEW.invoice_id
    AND i.organization_id = NEW.organization_id
    AND t.organization_id = NEW.organization_id
)
BEGIN
  SELECT RAISE(ABORT, 'invoice_line_tax_scope_conflict');
END;

CREATE TRIGGER invoice_tax_requires_owned_invoice
BEFORE INSERT ON invoice_taxes
WHEN NOT EXISTS (
  SELECT 1 FROM invoices i JOIN taxes t ON t.id = NEW.tax_id
  WHERE i.id = NEW.invoice_id
    AND i.organization_id = NEW.organization_id
    AND t.organization_id = NEW.organization_id
)
BEGIN
  SELECT RAISE(ABORT, 'invoice_tax_scope_conflict');
END;
