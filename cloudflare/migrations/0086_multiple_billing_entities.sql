DROP VIEW billing_entities;

CREATE TABLE billing_entities (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  default_currency TEXT NOT NULL,
  country TEXT,
  address_line1 TEXT,
  address_line2 TEXT,
  city TEXT,
  state TEXT,
  zipcode TEXT,
  einvoicing INTEGER NOT NULL DEFAULT 0 CHECK (einvoicing IN (0, 1)),
  email TEXT,
  legal_name TEXT,
  legal_number TEXT,
  timezone TEXT NOT NULL,
  net_payment_term INTEGER NOT NULL DEFAULT 0 CHECK (net_payment_term >= 0),
  email_settings_json TEXT NOT NULL DEFAULT '[]',
  document_numbering TEXT NOT NULL CHECK (document_numbering IN (
    'per_customer', 'per_billing_entity'
  )),
  document_number_prefix TEXT,
  tax_identification_number TEXT,
  finalize_zero_amount_invoice INTEGER NOT NULL DEFAULT 1
    CHECK (finalize_zero_amount_invoice IN (0, 1)),
  invoice_footer TEXT,
  invoice_grace_period INTEGER NOT NULL DEFAULT 0 CHECK (invoice_grace_period >= 0),
  subscription_invoice_issuing_date_adjustment TEXT NOT NULL CHECK (
    subscription_invoice_issuing_date_adjustment IN (
      'keep_anchor', 'align_with_finalization_date'
    )
  ),
  subscription_invoice_issuing_date_anchor TEXT NOT NULL CHECK (
    subscription_invoice_issuing_date_anchor IN ('current_period_end', 'next_period_start')
  ),
  document_locale TEXT NOT NULL,
  is_default INTEGER NOT NULL DEFAULT 0 CHECK (is_default IN (0, 1)),
  eu_tax_management INTEGER NOT NULL DEFAULT 0 CHECK (eu_tax_management IN (0, 1)),
  logo_url TEXT,
  invoice_custom_section_version INTEGER NOT NULL DEFAULT 0
    CHECK (invoice_custom_section_version >= 0),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  archived_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;

CREATE UNIQUE INDEX billing_entities_active_code_idx
  ON billing_entities(organization_id, code) WHERE archived_at IS NULL;
CREATE UNIQUE INDEX billing_entities_one_default_idx
  ON billing_entities(organization_id) WHERE is_default = 1 AND archived_at IS NULL;
CREATE INDEX billing_entities_org_active_idx
  ON billing_entities(organization_id, archived_at, created_at, id);

INSERT INTO billing_entities
  (id, organization_id, code, name, default_currency, country, address_line1, address_line2,
   city, state, zipcode, einvoicing, email, legal_name, legal_number, timezone,
   net_payment_term, email_settings_json, document_numbering, document_number_prefix,
   tax_identification_number, finalize_zero_amount_invoice, invoice_footer,
   invoice_grace_period, subscription_invoice_issuing_date_adjustment,
   subscription_invoice_issuing_date_anchor, document_locale, is_default, eu_tax_management,
   logo_url, invoice_custom_section_version, version, created_at, updated_at)
SELECT id, id, 'default', name, default_currency, country, address_line1, address_line2,
       city, state, zipcode, 0, email, legal_name, legal_number, timezone,
       net_payment_term, email_settings_json,
       CASE document_numbering WHEN 'per_organization' THEN 'per_billing_entity'
            ELSE document_numbering END,
       document_number_prefix, tax_identification_number, finalize_zero_amount_invoice,
       invoice_footer, invoice_grace_period, 'align_with_finalization_date',
       'next_period_start', document_locale, 1, 0, NULL, invoice_custom_section_version,
       version, created_at, updated_at
FROM organizations;

CREATE TRIGGER billing_entity_tenant_immutable
BEFORE UPDATE OF organization_id, code, is_default, created_at ON billing_entities
BEGIN
  SELECT RAISE(ABORT, 'immutable_billing_entity_identity');
END;

CREATE TRIGGER organization_create_default_billing_entity
AFTER INSERT ON organizations
BEGIN
  INSERT INTO billing_entities
    (id, organization_id, code, name, default_currency, country, address_line1, address_line2,
     city, state, zipcode, einvoicing, email, legal_name, legal_number, timezone,
     net_payment_term, email_settings_json, document_numbering, document_number_prefix,
     tax_identification_number, finalize_zero_amount_invoice, invoice_footer,
     invoice_grace_period, subscription_invoice_issuing_date_adjustment,
     subscription_invoice_issuing_date_anchor, document_locale, is_default, eu_tax_management,
     logo_url, invoice_custom_section_version, version, created_at, updated_at)
  VALUES
    (NEW.id, NEW.id, 'default', NEW.name, NEW.default_currency, NEW.country,
     NEW.address_line1, NEW.address_line2, NEW.city, NEW.state, NEW.zipcode, 0, NEW.email,
     NEW.legal_name, NEW.legal_number, NEW.timezone, NEW.net_payment_term,
     NEW.email_settings_json,
     CASE NEW.document_numbering WHEN 'per_organization' THEN 'per_billing_entity'
          ELSE NEW.document_numbering END,
     NEW.document_number_prefix, NEW.tax_identification_number,
     NEW.finalize_zero_amount_invoice, NEW.invoice_footer, NEW.invoice_grace_period,
     'align_with_finalization_date', 'next_period_start', NEW.document_locale, 1, 0, NULL,
     NEW.invoice_custom_section_version, NEW.version, NEW.created_at, NEW.updated_at);
END;

CREATE TRIGGER organization_sync_default_billing_entity
AFTER UPDATE OF name, default_currency, country, address_line1, address_line2, city, state,
  zipcode, email, legal_name, legal_number, timezone, net_payment_term, email_settings_json,
  document_numbering, document_number_prefix, tax_identification_number,
  finalize_zero_amount_invoice, invoice_footer, invoice_grace_period,
  subscription_invoice_issuing_date_adjustment,
  subscription_invoice_issuing_date_anchor, document_locale,
  invoice_custom_section_version, version, updated_at ON organizations
BEGIN
  UPDATE billing_entities
  SET name = NEW.name,
      default_currency = NEW.default_currency,
      country = NEW.country,
      address_line1 = NEW.address_line1,
      address_line2 = NEW.address_line2,
      city = NEW.city,
      state = NEW.state,
      zipcode = NEW.zipcode,
      email = NEW.email,
      legal_name = NEW.legal_name,
      legal_number = NEW.legal_number,
      timezone = NEW.timezone,
      net_payment_term = NEW.net_payment_term,
      email_settings_json = NEW.email_settings_json,
      document_numbering = CASE NEW.document_numbering
        WHEN 'per_organization' THEN 'per_billing_entity' ELSE NEW.document_numbering END,
      document_number_prefix = NEW.document_number_prefix,
      tax_identification_number = NEW.tax_identification_number,
      finalize_zero_amount_invoice = NEW.finalize_zero_amount_invoice,
      invoice_footer = NEW.invoice_footer,
      invoice_grace_period = NEW.invoice_grace_period,
      subscription_invoice_issuing_date_adjustment =
        NEW.subscription_invoice_issuing_date_adjustment,
      subscription_invoice_issuing_date_anchor = NEW.subscription_invoice_issuing_date_anchor,
      document_locale = NEW.document_locale,
      invoice_custom_section_version = NEW.invoice_custom_section_version,
      version = NEW.version,
      updated_at = NEW.updated_at
  WHERE id = NEW.id AND organization_id = NEW.id AND is_default = 1;
END;

ALTER TABLE customers ADD COLUMN billing_entity_id TEXT
  REFERENCES billing_entities(id) ON DELETE RESTRICT;
UPDATE customers SET billing_entity_id = organization_id WHERE billing_entity_id IS NULL;

CREATE TRIGGER customer_default_billing_entity
AFTER INSERT ON customers
WHEN NEW.billing_entity_id IS NULL
BEGIN
  UPDATE customers SET billing_entity_id = NEW.organization_id WHERE id = NEW.id;
END;

CREATE TRIGGER customer_billing_entity_scope_guard
BEFORE INSERT ON customers
WHEN NEW.billing_entity_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM billing_entities entity
  WHERE entity.id = NEW.billing_entity_id AND entity.organization_id = NEW.organization_id
    AND entity.archived_at IS NULL
)
BEGIN
  SELECT RAISE(ABORT, 'customer_billing_entity_scope_conflict');
END;

CREATE TRIGGER customer_billing_entity_update_scope_guard
BEFORE UPDATE OF billing_entity_id ON customers
WHEN NEW.billing_entity_id IS NULL OR NOT EXISTS (
  SELECT 1 FROM billing_entities entity
  WHERE entity.id = NEW.billing_entity_id AND entity.organization_id = NEW.organization_id
    AND entity.archived_at IS NULL
)
BEGIN
  SELECT RAISE(ABORT, 'customer_billing_entity_scope_conflict');
END;

ALTER TABLE subscriptions ADD COLUMN billing_entity_id TEXT
  REFERENCES billing_entities(id) ON DELETE RESTRICT;
UPDATE subscriptions
SET billing_entity_id = COALESCE(
  (SELECT customer.billing_entity_id FROM customers customer
   WHERE customer.id = subscriptions.customer_id),
  organization_id
)
WHERE billing_entity_id IS NULL;

CREATE TRIGGER subscription_default_billing_entity
AFTER INSERT ON subscriptions
WHEN NEW.billing_entity_id IS NULL
BEGIN
  UPDATE subscriptions
  SET billing_entity_id = COALESCE(
    (SELECT previous.billing_entity_id FROM subscriptions previous
     WHERE previous.id = NEW.previous_subscription_id),
    (SELECT customer.billing_entity_id FROM customers customer
     WHERE customer.id = NEW.customer_id),
    NEW.organization_id
  )
  WHERE id = NEW.id;
END;

CREATE TRIGGER subscription_billing_entity_scope_guard
BEFORE INSERT ON subscriptions
WHEN NEW.billing_entity_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM billing_entities entity
  JOIN customers customer ON customer.id = NEW.customer_id
  WHERE entity.id = NEW.billing_entity_id
    AND entity.organization_id = NEW.organization_id
    AND customer.organization_id = NEW.organization_id
    AND entity.archived_at IS NULL
)
BEGIN
  SELECT RAISE(ABORT, 'subscription_billing_entity_scope_conflict');
END;

CREATE TRIGGER subscription_billing_entity_update_scope_guard
BEFORE UPDATE OF billing_entity_id ON subscriptions
WHEN NEW.billing_entity_id IS NULL OR NOT EXISTS (
  SELECT 1 FROM billing_entities entity
  WHERE entity.id = NEW.billing_entity_id AND entity.organization_id = NEW.organization_id
    AND entity.archived_at IS NULL
)
BEGIN
  SELECT RAISE(ABORT, 'subscription_billing_entity_scope_conflict');
END;

ALTER TABLE invoices ADD COLUMN billing_entity_id TEXT
  REFERENCES billing_entities(id) ON DELETE RESTRICT;
UPDATE invoices
SET billing_entity_id = COALESCE(
  (SELECT subscription.billing_entity_id FROM subscriptions subscription
   WHERE subscription.id = invoices.subscription_id),
  (SELECT customer.billing_entity_id FROM customers customer WHERE customer.id = invoices.customer_id),
  organization_id
)
WHERE billing_entity_id IS NULL;

CREATE TRIGGER invoice_default_billing_entity
AFTER INSERT ON invoices
WHEN NEW.billing_entity_id IS NULL
BEGIN
  UPDATE invoices
  SET billing_entity_id = COALESCE(
    (SELECT subscription.billing_entity_id FROM subscriptions subscription
     WHERE subscription.id = NEW.subscription_id),
    (SELECT customer.billing_entity_id FROM customers customer WHERE customer.id = NEW.customer_id),
    NEW.organization_id
  )
  WHERE id = NEW.id;
END;

CREATE TRIGGER invoice_billing_entity_scope_guard
BEFORE INSERT ON invoices
WHEN NEW.billing_entity_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM billing_entities entity
  JOIN customers customer ON customer.id = NEW.customer_id
  WHERE entity.id = NEW.billing_entity_id
    AND entity.organization_id = NEW.organization_id
    AND customer.organization_id = NEW.organization_id
    AND entity.archived_at IS NULL
)
BEGIN
  SELECT RAISE(ABORT, 'invoice_billing_entity_scope_conflict');
END;

CREATE TRIGGER invoice_billing_entity_update_scope_guard
BEFORE UPDATE OF billing_entity_id ON invoices
WHEN NEW.billing_entity_id IS NULL OR NOT EXISTS (
  SELECT 1 FROM billing_entities entity
  WHERE entity.id = NEW.billing_entity_id AND entity.organization_id = NEW.organization_id
    AND entity.archived_at IS NULL
)
BEGIN
  SELECT RAISE(ABORT, 'invoice_billing_entity_scope_conflict');
END;

CREATE TABLE billing_entity_invoice_custom_sections (
  billing_entity_id TEXT NOT NULL REFERENCES billing_entities(id) ON DELETE CASCADE,
  invoice_custom_section_id TEXT NOT NULL REFERENCES invoice_custom_sections(id) ON DELETE RESTRICT,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  created_at TEXT NOT NULL,
  PRIMARY KEY (billing_entity_id, invoice_custom_section_id)
) STRICT;

CREATE INDEX billing_entity_invoice_custom_sections_section_idx
  ON billing_entity_invoice_custom_sections(invoice_custom_section_id, billing_entity_id);

CREATE TRIGGER billing_entity_invoice_custom_sections_scope_guard
BEFORE INSERT ON billing_entity_invoice_custom_sections
WHEN NOT EXISTS (
  SELECT 1 FROM billing_entities entity
  JOIN invoice_custom_sections section ON section.id = NEW.invoice_custom_section_id
  WHERE entity.id = NEW.billing_entity_id
    AND entity.organization_id = NEW.organization_id
    AND section.organization_id = NEW.organization_id
    AND section.status = 'active'
)
BEGIN
  SELECT RAISE(ABORT, 'billing_entity_invoice_custom_section_scope_conflict');
END;

INSERT INTO billing_entity_invoice_custom_sections
  (billing_entity_id, invoice_custom_section_id, organization_id, created_at)
SELECT legacy.organization_id, legacy.invoice_custom_section_id, legacy.organization_id,
       legacy.created_at
FROM organization_invoice_custom_sections legacy;

CREATE TRIGGER legacy_organization_section_insert_sync
AFTER INSERT ON organization_invoice_custom_sections
BEGIN
  INSERT OR IGNORE INTO billing_entity_invoice_custom_sections
    (billing_entity_id, invoice_custom_section_id, organization_id, created_at)
  VALUES (NEW.organization_id, NEW.invoice_custom_section_id, NEW.organization_id, NEW.created_at);
END;

CREATE TRIGGER legacy_organization_section_delete_sync
AFTER DELETE ON organization_invoice_custom_sections
BEGIN
  DELETE FROM billing_entity_invoice_custom_sections
  WHERE billing_entity_id = OLD.organization_id
    AND invoice_custom_section_id = OLD.invoice_custom_section_id;
END;

DROP TRIGGER billing_entity_outbox_version_guard;
CREATE TRIGGER billing_entity_outbox_version_guard
BEFORE INSERT ON outbox_events
WHEN NEW.event_type = 'billing_entity.updated' AND NOT EXISTS (
  SELECT 1 FROM billing_entities entity
  WHERE entity.id = NEW.aggregate_id
    AND entity.organization_id = NEW.organization_id
    AND entity.version = NEW.aggregate_version
)
BEGIN
  SELECT RAISE(ABORT, 'billing_entity_outbox_version_conflict');
END;

DROP TRIGGER tax_target_requires_owned_resources;
CREATE TRIGGER tax_target_requires_owned_resources
BEFORE INSERT ON tax_targets
WHEN NOT EXISTS (
  SELECT 1 FROM taxes
  WHERE id = NEW.tax_id AND organization_id = NEW.organization_id AND status = 'active'
) OR (
  NEW.target_type = 'billing_entity' AND NOT EXISTS (
    SELECT 1 FROM billing_entities
    WHERE id = NEW.target_id AND organization_id = NEW.organization_id AND archived_at IS NULL
  )
) OR (
  NEW.target_type = 'customer' AND NOT EXISTS (
    SELECT 1 FROM customers WHERE id = NEW.target_id AND organization_id = NEW.organization_id
  )
) OR (
  NEW.target_type = 'plan' AND NOT EXISTS (
    SELECT 1 FROM plans WHERE id = NEW.target_id AND organization_id = NEW.organization_id
  )
) OR (
  NEW.target_type = 'charge' AND NOT EXISTS (
    SELECT 1 FROM charges WHERE id = NEW.target_id AND organization_id = NEW.organization_id
  )
) OR (
  NEW.target_type = 'fixed_charge' AND NOT EXISTS (
    SELECT 1 FROM fixed_charges WHERE id = NEW.target_id AND organization_id = NEW.organization_id
  )
) OR (
  NEW.target_type = 'commitment' AND NOT EXISTS (
    SELECT 1 FROM minimum_commitments
    WHERE id = NEW.target_id AND organization_id = NEW.organization_id
  )
) OR (
  NEW.target_type = 'add_on' AND NOT EXISTS (
    SELECT 1 FROM add_ons WHERE id = NEW.target_id AND organization_id = NEW.organization_id
  )
)
BEGIN
  SELECT RAISE(ABORT, 'tax_target_scope_conflict');
END;

DROP VIEW effective_invoice_custom_sections;
CREATE VIEW effective_invoice_custom_sections AS
SELECT invoice.id AS invoice_id, section.id AS invoice_custom_section_id,
       section.organization_id, section.code, section.name, section.description,
       section.details, section.display_name
FROM invoices invoice
JOIN customers customer ON customer.id = invoice.customer_id
JOIN invoice_custom_section_owners owner ON owner.invoice_id = invoice.id
JOIN invoice_custom_sections section ON section.organization_id = invoice.organization_id
WHERE section.status = 'active'
  AND (
    EXISTS (
      SELECT 1 FROM subscriptions_invoice_custom_sections resource_link
      WHERE resource_link.subscription_id = owner.subscription_id
        AND resource_link.invoice_custom_section_id = section.id
    )
    OR (
      NOT EXISTS (
        SELECT 1 FROM subscriptions_invoice_custom_sections resource_link
        JOIN invoice_custom_sections resource_section
          ON resource_section.id = resource_link.invoice_custom_section_id
        WHERE resource_link.subscription_id = owner.subscription_id
          AND resource_section.status = 'active'
      )
      AND COALESCE((SELECT skip_invoice_custom_sections FROM subscriptions
                    WHERE id = owner.subscription_id), 0) = 0
      AND customer.skip_invoice_custom_sections = 0
      AND section.section_type = 'manual'
      AND (
        EXISTS (
          SELECT 1 FROM customers_invoice_custom_sections selected
          JOIN invoice_custom_sections selected_section
            ON selected_section.id = selected.invoice_custom_section_id
          WHERE selected.customer_id = customer.id
            AND selected.invoice_custom_section_id = section.id
            AND selected_section.status = 'active'
            AND selected_section.section_type = 'manual'
        )
        OR (
          NOT EXISTS (
            SELECT 1 FROM customers_invoice_custom_sections selected
            JOIN invoice_custom_sections selected_section
              ON selected_section.id = selected.invoice_custom_section_id
            WHERE selected.customer_id = customer.id AND selected_section.status = 'active'
              AND selected_section.section_type = 'manual'
          )
          AND EXISTS (
            SELECT 1 FROM billing_entity_invoice_custom_sections entity_default
            WHERE entity_default.billing_entity_id = COALESCE(
              invoice.billing_entity_id, customer.billing_entity_id, invoice.organization_id
            )
              AND entity_default.invoice_custom_section_id = section.id
          )
        )
      )
    )
    OR (
      NOT (
        COALESCE((SELECT skip_invoice_custom_sections FROM subscriptions
                  WHERE id = owner.subscription_id), 0) = 1
        OR customer.skip_invoice_custom_sections = 1
      )
      AND EXISTS (
        SELECT 1 FROM customers_invoice_custom_sections system_link
        WHERE system_link.customer_id = customer.id
          AND system_link.invoice_custom_section_id = section.id
          AND section.section_type = 'system_generated'
      )
    )
  );

DROP TRIGGER invoice_custom_sections_snapshot_after_invoice_insert;
CREATE TRIGGER invoice_custom_sections_snapshot_after_invoice_insert
AFTER INSERT ON invoices
WHEN NEW.billing_entity_id IS NOT NULL
BEGIN
  INSERT INTO applied_invoice_custom_sections
    (id, invoice_id, organization_id, invoice_custom_section_id, code, name, description,
     details, display_name, created_at)
  SELECT lower(hex(randomblob(16))), NEW.id, organization_id, invoice_custom_section_id,
         code, name, description, details, display_name, NEW.created_at
  FROM effective_invoice_custom_sections
  WHERE invoice_id = NEW.id
  ORDER BY name, code;
END;

CREATE TRIGGER invoice_billing_entity_section_snapshot
AFTER UPDATE OF billing_entity_id ON invoices
WHEN OLD.billing_entity_id IS NOT NEW.billing_entity_id
BEGIN
  DELETE FROM applied_invoice_custom_sections WHERE invoice_id = NEW.id;
  INSERT INTO applied_invoice_custom_sections
    (id, invoice_id, organization_id, invoice_custom_section_id, code, name, description,
     details, display_name, created_at)
  SELECT lower(hex(randomblob(16))), NEW.id, organization_id, invoice_custom_section_id,
         code, name, description, details, display_name, NEW.updated_at
  FROM effective_invoice_custom_sections
  WHERE invoice_id = NEW.id
  ORDER BY name, code;
END;
