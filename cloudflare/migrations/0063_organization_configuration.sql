PRAGMA foreign_keys = ON;

ALTER TABLE organizations ADD COLUMN slug TEXT;
ALTER TABLE organizations
  ADD COLUMN default_currency TEXT NOT NULL DEFAULT 'USD'
  CHECK (length(default_currency) = 3 AND default_currency = upper(default_currency));
ALTER TABLE organizations
  ADD COLUMN country TEXT CHECK (country IS NULL OR (length(country) = 2 AND country = upper(country)));
ALTER TABLE organizations ADD COLUMN address_line1 TEXT;
ALTER TABLE organizations ADD COLUMN address_line2 TEXT;
ALTER TABLE organizations ADD COLUMN state TEXT;
ALTER TABLE organizations ADD COLUMN zipcode TEXT;
ALTER TABLE organizations ADD COLUMN email TEXT;
ALTER TABLE organizations ADD COLUMN city TEXT;
ALTER TABLE organizations ADD COLUMN legal_name TEXT;
ALTER TABLE organizations ADD COLUMN legal_number TEXT;
ALTER TABLE organizations ADD COLUMN tax_identification_number TEXT;
ALTER TABLE organizations
  ADD COLUMN document_numbering TEXT NOT NULL DEFAULT 'per_organization'
  CHECK (document_numbering IN ('per_customer', 'per_organization'));
ALTER TABLE organizations ADD COLUMN document_number_prefix TEXT;
ALTER TABLE organizations
  ADD COLUMN finalize_zero_amount_invoice INTEGER NOT NULL DEFAULT 0
  CHECK (finalize_zero_amount_invoice IN (0, 1));
ALTER TABLE organizations
  ADD COLUMN email_settings_json TEXT NOT NULL DEFAULT '[]'
  CHECK (json_valid(email_settings_json) AND json_type(email_settings_json) = 'array');
ALTER TABLE organizations ADD COLUMN invoice_footer TEXT;
ALTER TABLE organizations ADD COLUMN document_locale TEXT NOT NULL DEFAULT 'en';
ALTER TABLE organizations ADD COLUMN version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0);

UPDATE organizations SET slug = lower(external_id) WHERE slug IS NULL;

CREATE UNIQUE INDEX organizations_slug_idx ON organizations(slug) WHERE slug IS NOT NULL;

CREATE TRIGGER organization_configuration_validation_insert
BEFORE INSERT ON organizations
WHEN (NEW.slug IS NOT NULL AND (length(NEW.slug) < 3 OR length(NEW.slug) > 40))
  OR (NEW.invoice_footer IS NOT NULL AND length(NEW.invoice_footer) > 600)
  OR (NEW.document_number_prefix IS NOT NULL
      AND (length(NEW.document_number_prefix) < 1 OR length(NEW.document_number_prefix) > 10))
BEGIN
  SELECT RAISE(ABORT, 'organization_configuration_invalid');
END;

CREATE TRIGGER organization_configuration_validation_update
BEFORE UPDATE OF slug, invoice_footer, document_number_prefix ON organizations
WHEN (NEW.slug IS NOT NULL AND (length(NEW.slug) < 3 OR length(NEW.slug) > 40))
  OR (NEW.invoice_footer IS NOT NULL AND length(NEW.invoice_footer) > 600)
  OR (NEW.document_number_prefix IS NOT NULL
      AND (length(NEW.document_number_prefix) < 1 OR length(NEW.document_number_prefix) > 10))
BEGIN
  SELECT RAISE(ABORT, 'organization_configuration_invalid');
END;

CREATE TRIGGER organization_outbox_version_guard
BEFORE INSERT ON outbox_events
WHEN NEW.aggregate_type = 'organization' AND NOT EXISTS (
  SELECT 1 FROM organizations
  WHERE id = NEW.aggregate_id
    AND id = NEW.organization_id
    AND version = NEW.aggregate_version
)
BEGIN
  SELECT RAISE(ABORT, 'organization_outbox_version_conflict');
END;
