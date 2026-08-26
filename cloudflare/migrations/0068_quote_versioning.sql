PRAGMA foreign_keys = ON;

ALTER TABLE organizations ADD COLUMN quote_counter INTEGER NOT NULL DEFAULT 0
  CHECK (quote_counter >= 0);

CREATE TABLE organization_memberships (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  user_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'revoked')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (organization_id, user_id)
) STRICT;

CREATE INDEX organization_memberships_active_idx
  ON organization_memberships(organization_id, user_id) WHERE status = 'active';

CREATE TABLE quotes (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  customer_id TEXT NOT NULL REFERENCES customers(id) ON DELETE RESTRICT,
  subscription_id TEXT REFERENCES subscriptions(id) ON DELETE RESTRICT,
  number TEXT NOT NULL,
  sequential_id INTEGER NOT NULL CHECK (sequential_id > 0),
  order_type TEXT NOT NULL
    CHECK (order_type IN ('subscription_creation', 'subscription_amendment', 'one_off')),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  idempotency_key TEXT NOT NULL,
  request_sha256 TEXT NOT NULL CHECK (length(request_sha256) = 64),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (organization_id, sequential_id),
  UNIQUE (organization_id, number),
  UNIQUE (organization_id, idempotency_key)
) STRICT;

CREATE INDEX quotes_customer_created_idx
  ON quotes(customer_id, created_at DESC, id DESC);
CREATE INDEX quotes_subscription_idx ON quotes(subscription_id, created_at DESC);
CREATE INDEX quotes_org_order_type_idx
  ON quotes(organization_id, order_type, created_at DESC, id DESC);

CREATE TABLE quote_versions (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  quote_id TEXT NOT NULL REFERENCES quotes(id) ON DELETE RESTRICT,
  sequential_id INTEGER NOT NULL CHECK (sequential_id > 0),
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'approved', 'voided')),
  approved_at TEXT,
  voided_at TEXT,
  void_reason TEXT CHECK (void_reason IS NULL OR void_reason IN (
    'manual', 'superseded', 'cascade_of_expired', 'cascade_of_voided'
  )),
  billing_items_json TEXT,
  content TEXT,
  share_token TEXT,
  lock_version INTEGER NOT NULL DEFAULT 1 CHECK (lock_version > 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK ((status = 'voided') = (void_reason IS NOT NULL AND voided_at IS NOT NULL)),
  CHECK ((status = 'approved') = (approved_at IS NOT NULL)),
  CHECK (status = 'voided' OR share_token IS NOT NULL),
  CHECK (billing_items_json IS NULL OR json_valid(billing_items_json)),
  UNIQUE (quote_id, sequential_id),
  UNIQUE (share_token)
) STRICT;

CREATE UNIQUE INDEX quote_versions_one_active_idx
  ON quote_versions(quote_id) WHERE status IN ('draft', 'approved');
CREATE INDEX quote_versions_org_status_idx
  ON quote_versions(organization_id, status, created_at DESC, id DESC);
CREATE INDEX quote_versions_quote_current_idx
  ON quote_versions(quote_id, sequential_id DESC);

CREATE TABLE quote_owners (
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  quote_id TEXT NOT NULL REFERENCES quotes(id) ON DELETE RESTRICT,
  user_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (quote_id, user_id)
) WITHOUT ROWID, STRICT;

CREATE INDEX quote_owners_org_user_idx ON quote_owners(organization_id, user_id, quote_id);

CREATE TRIGGER quotes_tenant_scope_guard
BEFORE INSERT ON quotes
WHEN (NOT EXISTS (
  SELECT 1 FROM customers customer
  WHERE customer.id = NEW.customer_id AND customer.organization_id = NEW.organization_id
)
OR (NEW.order_type = 'subscription_amendment' AND NEW.subscription_id IS NULL)
OR (NEW.subscription_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM subscriptions subscription
  WHERE subscription.id = NEW.subscription_id
    AND subscription.organization_id = NEW.organization_id
    AND subscription.customer_id = NEW.customer_id
)))
BEGIN
  SELECT RAISE(ABORT, 'invalid_quote_scope');
END;

CREATE TRIGGER quotes_identity_immutable
BEFORE UPDATE OF organization_id, customer_id, subscription_id, number, sequential_id,
  order_type, idempotency_key, request_sha256
ON quotes
WHEN OLD.organization_id <> NEW.organization_id
  OR OLD.customer_id <> NEW.customer_id
  OR OLD.subscription_id IS NOT NEW.subscription_id
  OR OLD.number <> NEW.number
  OR OLD.sequential_id <> NEW.sequential_id
  OR OLD.order_type <> NEW.order_type
  OR OLD.idempotency_key <> NEW.idempotency_key
  OR OLD.request_sha256 <> NEW.request_sha256
BEGIN
  SELECT RAISE(ABORT, 'immutable_quote_identity');
END;

CREATE TRIGGER quote_versions_tenant_guard
BEFORE INSERT ON quote_versions
WHEN NOT EXISTS (
  SELECT 1 FROM quotes quote
  WHERE quote.id = NEW.quote_id AND quote.organization_id = NEW.organization_id
)
BEGIN
  SELECT RAISE(ABORT, 'invalid_quote_version_scope');
END;

CREATE TRIGGER quote_versions_identity_immutable
BEFORE UPDATE OF organization_id, quote_id, sequential_id, created_at
ON quote_versions
WHEN OLD.organization_id <> NEW.organization_id
  OR OLD.quote_id <> NEW.quote_id
  OR OLD.sequential_id <> NEW.sequential_id
  OR OLD.created_at <> NEW.created_at
BEGIN
  SELECT RAISE(ABORT, 'immutable_quote_version_identity');
END;

CREATE TRIGGER quote_owners_tenant_guard
BEFORE INSERT ON quote_owners
WHEN NOT EXISTS (
  SELECT 1 FROM quotes quote
  JOIN organization_memberships membership
    ON membership.organization_id = quote.organization_id
   AND membership.user_id = NEW.user_id
   AND membership.status = 'active'
  WHERE quote.id = NEW.quote_id AND quote.organization_id = NEW.organization_id
)
BEGIN
  SELECT RAISE(ABORT, 'invalid_quote_owner');
END;

CREATE TRIGGER quote_outbox_version_guard
BEFORE INSERT ON outbox_events
WHEN NEW.aggregate_type = 'quote' AND NOT EXISTS (
  SELECT 1 FROM quotes quote
  WHERE quote.id = NEW.aggregate_id
    AND quote.organization_id = NEW.organization_id
    AND quote.version = NEW.aggregate_version
)
BEGIN
  SELECT RAISE(ABORT, 'quote_outbox_version_conflict');
END;

CREATE TRIGGER quote_version_outbox_version_guard
BEFORE INSERT ON outbox_events
WHEN NEW.aggregate_type = 'quote_version' AND NOT EXISTS (
  SELECT 1 FROM quote_versions version
  WHERE version.id = NEW.aggregate_id
    AND version.organization_id = NEW.organization_id
    AND version.lock_version = NEW.aggregate_version
)
BEGIN
  SELECT RAISE(ABORT, 'quote_version_outbox_version_conflict');
END;
