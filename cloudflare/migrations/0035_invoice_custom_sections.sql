CREATE TABLE invoice_custom_sections (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  details TEXT,
  display_name TEXT,
  section_type TEXT NOT NULL DEFAULT 'manual'
    CHECK (section_type IN ('manual', 'system_generated')),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'terminated')),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  request_sha256 TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  terminated_at TEXT
) STRICT;

CREATE UNIQUE INDEX invoice_custom_sections_active_code_idx
  ON invoice_custom_sections(organization_id, code) WHERE status = 'active';
CREATE INDEX invoice_custom_sections_org_status_idx
  ON invoice_custom_sections(organization_id, status, created_at DESC);

CREATE TRIGGER invoice_custom_sections_tenant_immutable
BEFORE UPDATE OF organization_id ON invoice_custom_sections
WHEN OLD.organization_id <> NEW.organization_id
BEGIN
  SELECT RAISE(ABORT, 'immutable_invoice_custom_section_tenant');
END;

ALTER TABLE subscriptions ADD COLUMN skip_invoice_custom_sections INTEGER NOT NULL DEFAULT 0
  CHECK (skip_invoice_custom_sections IN (0, 1));

CREATE TABLE subscriptions_invoice_custom_sections (
  subscription_id TEXT NOT NULL REFERENCES subscriptions(id) ON DELETE CASCADE,
  invoice_custom_section_id TEXT NOT NULL REFERENCES invoice_custom_sections(id) ON DELETE RESTRICT,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  created_at TEXT NOT NULL,
  PRIMARY KEY (subscription_id, invoice_custom_section_id)
) STRICT;

CREATE INDEX subscriptions_invoice_custom_sections_section_idx
  ON subscriptions_invoice_custom_sections(invoice_custom_section_id, subscription_id);

CREATE TRIGGER subscriptions_invoice_custom_sections_tenant_insert
BEFORE INSERT ON subscriptions_invoice_custom_sections
WHEN NOT EXISTS (
  SELECT 1 FROM subscriptions s JOIN invoice_custom_sections cs
    ON cs.id = NEW.invoice_custom_section_id
  WHERE s.id = NEW.subscription_id AND s.organization_id = NEW.organization_id
    AND cs.organization_id = NEW.organization_id AND cs.status = 'active'
)
BEGIN
  SELECT RAISE(ABORT, 'invalid_subscription_invoice_custom_section_tenant');
END;

CREATE TRIGGER subscriptions_invoice_custom_sections_identity_immutable
BEFORE UPDATE OF subscription_id, invoice_custom_section_id, organization_id
ON subscriptions_invoice_custom_sections
WHEN OLD.subscription_id <> NEW.subscription_id
  OR OLD.invoice_custom_section_id <> NEW.invoice_custom_section_id
  OR OLD.organization_id <> NEW.organization_id
BEGIN
  SELECT RAISE(ABORT, 'immutable_subscription_invoice_custom_section_identity');
END;

CREATE TABLE applied_invoice_custom_sections (
  id TEXT PRIMARY KEY,
  invoice_id TEXT NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  invoice_custom_section_id TEXT REFERENCES invoice_custom_sections(id) ON DELETE SET NULL,
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  details TEXT,
  display_name TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (invoice_id, code)
) STRICT;

CREATE INDEX applied_invoice_custom_sections_invoice_idx
  ON applied_invoice_custom_sections(invoice_id, name, code, id);

CREATE TRIGGER applied_invoice_custom_sections_tenant_insert
BEFORE INSERT ON applied_invoice_custom_sections
WHEN NOT EXISTS (
  SELECT 1 FROM invoices i
  WHERE i.id = NEW.invoice_id AND i.organization_id = NEW.organization_id
)
OR (
  NEW.invoice_custom_section_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM invoice_custom_sections cs
    WHERE cs.id = NEW.invoice_custom_section_id AND cs.organization_id = NEW.organization_id
  )
)
BEGIN
  SELECT RAISE(ABORT, 'invalid_applied_invoice_custom_section_tenant');
END;

CREATE TRIGGER applied_invoice_custom_sections_immutable
BEFORE UPDATE ON applied_invoice_custom_sections
BEGIN
  SELECT RAISE(ABORT, 'immutable_applied_invoice_custom_section');
END;

CREATE TRIGGER invoice_custom_sections_snapshot_after_owner_insert
AFTER INSERT ON invoice_subscriptions
BEGIN
  DELETE FROM applied_invoice_custom_sections WHERE invoice_id = NEW.invoice_id;
  INSERT INTO applied_invoice_custom_sections
    (id, invoice_id, organization_id, invoice_custom_section_id, code, name, description,
     details, display_name, created_at)
  SELECT lower(hex(randomblob(16))), NEW.invoice_id, cs.organization_id, cs.id, cs.code, cs.name,
         cs.description, cs.details, cs.display_name, NEW.created_at
  FROM subscriptions_invoice_custom_sections link
  JOIN invoice_custom_sections cs ON cs.id = link.invoice_custom_section_id
  JOIN subscriptions s ON s.id = link.subscription_id
  WHERE link.subscription_id = (
    SELECT owned.subscription_id FROM invoice_subscriptions owned
    JOIN subscriptions candidate ON candidate.id = owned.subscription_id
    WHERE owned.invoice_id = NEW.invoice_id
    ORDER BY candidate.generation DESC LIMIT 1
  )
    AND s.skip_invoice_custom_sections = 0 AND cs.status = 'active'
  ORDER BY cs.name, cs.code;
END;

CREATE TRIGGER invoice_custom_sections_snapshot_after_invoice_refresh
AFTER UPDATE OF last_refreshed_at, status ON invoices
WHEN NEW.status = 'draft' OR (OLD.status = 'draft' AND NEW.status = 'finalized')
BEGIN
  DELETE FROM applied_invoice_custom_sections WHERE invoice_id = NEW.id;
  INSERT INTO applied_invoice_custom_sections
    (id, invoice_id, organization_id, invoice_custom_section_id, code, name, description,
     details, display_name, created_at)
  SELECT lower(hex(randomblob(16))), NEW.id, cs.organization_id, cs.id, cs.code, cs.name,
         cs.description, cs.details, cs.display_name, NEW.updated_at
  FROM subscriptions_invoice_custom_sections link
  JOIN invoice_custom_sections cs ON cs.id = link.invoice_custom_section_id
  JOIN subscriptions s ON s.id = link.subscription_id
  WHERE link.subscription_id = (
    SELECT owned.subscription_id FROM invoice_subscriptions owned
    JOIN subscriptions candidate ON candidate.id = owned.subscription_id
    WHERE owned.invoice_id = NEW.id
    ORDER BY candidate.generation DESC LIMIT 1
  )
    AND s.skip_invoice_custom_sections = 0 AND cs.status = 'active'
  ORDER BY cs.name, cs.code;
END;

CREATE TRIGGER draft_refresh_after_subscription_section_insert
AFTER INSERT ON subscriptions_invoice_custom_sections
BEGIN
  UPDATE invoices SET ready_to_be_refreshed = 1
  WHERE status = 'draft' AND id IN (
    SELECT invoice_id FROM invoice_subscriptions WHERE subscription_id = NEW.subscription_id
  );
END;

CREATE TRIGGER draft_refresh_after_subscription_section_delete
AFTER DELETE ON subscriptions_invoice_custom_sections
BEGIN
  UPDATE invoices SET ready_to_be_refreshed = 1
  WHERE status = 'draft' AND id IN (
    SELECT invoice_id FROM invoice_subscriptions WHERE subscription_id = OLD.subscription_id
  );
END;

CREATE TRIGGER draft_refresh_after_subscription_section_skip
AFTER UPDATE OF skip_invoice_custom_sections ON subscriptions
WHEN OLD.skip_invoice_custom_sections <> NEW.skip_invoice_custom_sections
BEGIN
  UPDATE invoices SET ready_to_be_refreshed = 1
  WHERE status = 'draft' AND id IN (
    SELECT invoice_id FROM invoice_subscriptions WHERE subscription_id = NEW.id
  );
END;

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
  WHERE status = 'draft' AND id IN (
    SELECT owned.invoice_id FROM invoice_subscriptions owned
    JOIN subscriptions_invoice_custom_sections link
      ON link.subscription_id = owned.subscription_id
    WHERE link.invoice_custom_section_id = NEW.id
  );
END;
