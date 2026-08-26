CREATE TABLE customer_portal_tokens (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  customer_id TEXT NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  token_sha256 TEXT NOT NULL UNIQUE CHECK (length(token_sha256) = 64),
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  created_by_membership_id TEXT REFERENCES operator_memberships(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  expires_at TEXT,
  last_used_at TEXT,
  revoked_at TEXT,
  CHECK ((active = 1 AND revoked_at IS NULL) OR (active = 0 AND revoked_at IS NOT NULL))
) STRICT;

CREATE INDEX customer_portal_tokens_customer_active_idx
  ON customer_portal_tokens(organization_id, customer_id, active, created_at DESC);

CREATE TRIGGER customer_portal_token_tenant_guard
BEFORE INSERT ON customer_portal_tokens
WHEN NOT EXISTS (
  SELECT 1 FROM customers WHERE id = NEW.customer_id AND organization_id = NEW.organization_id
)
BEGIN
  SELECT RAISE(ABORT, 'invalid_customer_portal_tenant');
END;

CREATE TRIGGER customer_portal_token_identity_immutable
BEFORE UPDATE OF organization_id, customer_id, token_sha256, created_at
ON customer_portal_tokens
WHEN OLD.organization_id <> NEW.organization_id OR OLD.customer_id <> NEW.customer_id
  OR OLD.token_sha256 <> NEW.token_sha256 OR OLD.created_at <> NEW.created_at
BEGIN
  SELECT RAISE(ABORT, 'immutable_customer_portal_token_identity');
END;
