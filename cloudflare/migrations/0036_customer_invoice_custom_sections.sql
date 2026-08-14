ALTER TABLE customers ADD COLUMN skip_invoice_custom_sections INTEGER NOT NULL DEFAULT 0
  CHECK (skip_invoice_custom_sections IN (0, 1));

ALTER TABLE organizations ADD COLUMN invoice_custom_section_version INTEGER NOT NULL DEFAULT 0
  CHECK (invoice_custom_section_version >= 0);

CREATE TABLE customers_invoice_custom_sections (
  customer_id TEXT NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  invoice_custom_section_id TEXT NOT NULL REFERENCES invoice_custom_sections(id) ON DELETE RESTRICT,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  created_at TEXT NOT NULL,
  PRIMARY KEY (customer_id, invoice_custom_section_id)
) STRICT;

CREATE INDEX customers_invoice_custom_sections_section_idx
  ON customers_invoice_custom_sections(invoice_custom_section_id, customer_id);

CREATE TRIGGER customers_invoice_custom_sections_tenant_insert
BEFORE INSERT ON customers_invoice_custom_sections
WHEN NOT EXISTS (
  SELECT 1 FROM customers c JOIN invoice_custom_sections cs
    ON cs.id = NEW.invoice_custom_section_id
  WHERE c.id = NEW.customer_id AND c.organization_id = NEW.organization_id
    AND cs.organization_id = NEW.organization_id AND cs.status = 'active'
)
BEGIN
  SELECT RAISE(ABORT, 'invalid_customer_invoice_custom_section_tenant');
END;

CREATE TRIGGER customers_invoice_custom_sections_identity_immutable
BEFORE UPDATE OF customer_id, invoice_custom_section_id, organization_id
ON customers_invoice_custom_sections
WHEN OLD.customer_id <> NEW.customer_id
  OR OLD.invoice_custom_section_id <> NEW.invoice_custom_section_id
  OR OLD.organization_id <> NEW.organization_id
BEGIN
  SELECT RAISE(ABORT, 'immutable_customer_invoice_custom_section_identity');
END;

CREATE TABLE organization_invoice_custom_sections (
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  invoice_custom_section_id TEXT NOT NULL REFERENCES invoice_custom_sections(id) ON DELETE RESTRICT,
  created_at TEXT NOT NULL,
  PRIMARY KEY (organization_id, invoice_custom_section_id)
) STRICT;

CREATE INDEX organization_invoice_custom_sections_section_idx
  ON organization_invoice_custom_sections(invoice_custom_section_id, organization_id);

CREATE TRIGGER organization_invoice_custom_sections_tenant_insert
BEFORE INSERT ON organization_invoice_custom_sections
WHEN NOT EXISTS (
  SELECT 1 FROM invoice_custom_sections cs
  WHERE cs.id = NEW.invoice_custom_section_id
    AND cs.organization_id = NEW.organization_id AND cs.status = 'active'
)
BEGIN
  SELECT RAISE(ABORT, 'invalid_organization_invoice_custom_section_tenant');
END;

CREATE TRIGGER organization_invoice_custom_sections_identity_immutable
BEFORE UPDATE OF organization_id, invoice_custom_section_id
ON organization_invoice_custom_sections
WHEN OLD.organization_id <> NEW.organization_id
  OR OLD.invoice_custom_section_id <> NEW.invoice_custom_section_id
BEGIN
  SELECT RAISE(ABORT, 'immutable_organization_invoice_custom_section_identity');
END;

CREATE VIEW invoice_custom_section_owners AS
SELECT i.id AS invoice_id,
       (
         SELECT owned.subscription_id
         FROM invoice_subscriptions owned
         JOIN subscriptions candidate ON candidate.id = owned.subscription_id
         WHERE owned.invoice_id = i.id
         ORDER BY candidate.generation DESC
         LIMIT 1
       ) AS subscription_id
FROM invoices i;

CREATE VIEW effective_invoice_custom_sections AS
SELECT i.id AS invoice_id, cs.id AS invoice_custom_section_id, cs.organization_id,
       cs.code, cs.name, cs.description, cs.details, cs.display_name
FROM invoices i
JOIN customers c ON c.id = i.customer_id
JOIN invoice_custom_section_owners owner ON owner.invoice_id = i.id
JOIN invoice_custom_sections cs ON cs.organization_id = i.organization_id
WHERE cs.status = 'active'
  AND (
    EXISTS (
      SELECT 1 FROM subscriptions_invoice_custom_sections resource_link
      WHERE resource_link.subscription_id = owner.subscription_id
        AND resource_link.invoice_custom_section_id = cs.id
    )
    OR (
      NOT (
        NOT EXISTS (
          SELECT 1 FROM subscriptions_invoice_custom_sections resource_link
          JOIN invoice_custom_sections resource_section
            ON resource_section.id = resource_link.invoice_custom_section_id
          WHERE resource_link.subscription_id = owner.subscription_id
            AND resource_section.status = 'active'
        )
        AND (
          COALESCE((SELECT skip_invoice_custom_sections FROM subscriptions
                    WHERE id = owner.subscription_id), 0) = 1
          OR (
            COALESCE((SELECT skip_invoice_custom_sections FROM subscriptions
                      WHERE id = owner.subscription_id), 0) = 0
            AND c.skip_invoice_custom_sections = 1
          )
        )
      )
      AND EXISTS (
        SELECT 1 FROM customers_invoice_custom_sections system_link
        WHERE system_link.customer_id = c.id
          AND system_link.invoice_custom_section_id = cs.id
          AND cs.section_type = 'system_generated'
      )
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
      AND c.skip_invoice_custom_sections = 0
      AND cs.section_type = 'manual'
      AND (
        (
          EXISTS (
            SELECT 1 FROM customers_invoice_custom_sections selected
            JOIN invoice_custom_sections selected_section
              ON selected_section.id = selected.invoice_custom_section_id
            WHERE selected.customer_id = c.id AND selected_section.status = 'active'
              AND selected_section.section_type = 'manual'
          )
          AND EXISTS (
            SELECT 1 FROM customers_invoice_custom_sections selected
            WHERE selected.customer_id = c.id
              AND selected.invoice_custom_section_id = cs.id
          )
        )
        OR (
          NOT EXISTS (
            SELECT 1 FROM customers_invoice_custom_sections selected
            JOIN invoice_custom_sections selected_section
              ON selected_section.id = selected.invoice_custom_section_id
            WHERE selected.customer_id = c.id AND selected_section.status = 'active'
              AND selected_section.section_type = 'manual'
          )
          AND EXISTS (
            SELECT 1 FROM organization_invoice_custom_sections organization_default
            WHERE organization_default.organization_id = i.organization_id
              AND organization_default.invoice_custom_section_id = cs.id
          )
        )
      )
    )
  );

DROP TRIGGER invoice_custom_sections_snapshot_after_owner_insert;
CREATE TRIGGER invoice_custom_sections_snapshot_after_owner_insert
AFTER INSERT ON invoice_subscriptions
BEGIN
  DELETE FROM applied_invoice_custom_sections WHERE invoice_id = NEW.invoice_id;
  INSERT INTO applied_invoice_custom_sections
    (id, invoice_id, organization_id, invoice_custom_section_id, code, name, description,
     details, display_name, created_at)
  SELECT lower(hex(randomblob(16))), NEW.invoice_id, organization_id, invoice_custom_section_id,
         code, name, description, details, display_name, NEW.created_at
  FROM effective_invoice_custom_sections
  WHERE invoice_id = NEW.invoice_id
  ORDER BY name, code;
END;

CREATE TRIGGER invoice_custom_sections_snapshot_after_invoice_insert
AFTER INSERT ON invoices
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

DROP TRIGGER invoice_custom_sections_snapshot_after_invoice_refresh;
CREATE TRIGGER invoice_custom_sections_snapshot_after_invoice_refresh
AFTER UPDATE OF last_refreshed_at, status ON invoices
WHEN NEW.status = 'draft' OR (OLD.status = 'draft' AND NEW.status = 'finalized')
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

CREATE TRIGGER draft_refresh_after_customer_section_insert
AFTER INSERT ON customers_invoice_custom_sections
BEGIN
  UPDATE invoices SET ready_to_be_refreshed = 1
  WHERE status = 'draft' AND customer_id = NEW.customer_id;
END;

CREATE TRIGGER draft_refresh_after_customer_section_delete
AFTER DELETE ON customers_invoice_custom_sections
BEGIN
  UPDATE invoices SET ready_to_be_refreshed = 1
  WHERE status = 'draft' AND customer_id = OLD.customer_id;
END;

CREATE TRIGGER draft_refresh_after_customer_section_skip
AFTER UPDATE OF skip_invoice_custom_sections ON customers
WHEN OLD.skip_invoice_custom_sections <> NEW.skip_invoice_custom_sections
BEGIN
  UPDATE invoices SET ready_to_be_refreshed = 1
  WHERE status = 'draft' AND customer_id = NEW.id;
END;

CREATE TRIGGER draft_refresh_after_organization_section_insert
AFTER INSERT ON organization_invoice_custom_sections
BEGIN
  UPDATE invoices SET ready_to_be_refreshed = 1
  WHERE status = 'draft' AND organization_id = NEW.organization_id;
END;

CREATE TRIGGER draft_refresh_after_organization_section_delete
AFTER DELETE ON organization_invoice_custom_sections
BEGIN
  UPDATE invoices SET ready_to_be_refreshed = 1
  WHERE status = 'draft' AND organization_id = OLD.organization_id;
END;

DROP TRIGGER draft_refresh_after_invoice_custom_section_update;
CREATE TRIGGER draft_refresh_after_invoice_custom_section_update
AFTER UPDATE OF code, name, description, details, display_name, status ON invoice_custom_sections
WHEN OLD.code IS NOT NEW.code
  OR OLD.name IS NOT NEW.name
  OR OLD.description IS NOT NEW.description
  OR OLD.details IS NOT NEW.details
  OR OLD.display_name IS NOT NEW.display_name
  OR OLD.status IS NOT NEW.status
BEGIN
  UPDATE invoices SET ready_to_be_refreshed = 1
  WHERE status = 'draft' AND organization_id = NEW.organization_id;
END;
