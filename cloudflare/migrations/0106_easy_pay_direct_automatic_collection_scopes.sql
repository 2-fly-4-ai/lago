CREATE TABLE easy_pay_direct_automatic_collection_scopes (
  subscription_id TEXT PRIMARY KEY REFERENCES subscriptions(id) ON DELETE CASCADE,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  status TEXT NOT NULL CHECK (status IN ('enabled', 'disabled')),
  reason TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;

CREATE INDEX easy_pay_direct_automatic_collection_scopes_org_status_idx
  ON easy_pay_direct_automatic_collection_scopes(organization_id, status, subscription_id);

CREATE TRIGGER easy_pay_direct_automatic_collection_scope_guard
BEFORE INSERT ON easy_pay_direct_automatic_collection_scopes
WHEN NOT EXISTS (
  SELECT 1 FROM subscriptions subscription
  WHERE subscription.id = NEW.subscription_id
    AND subscription.organization_id = NEW.organization_id
)
BEGIN
  SELECT RAISE(ABORT, 'invalid_easy_pay_direct_automatic_collection_scope');
END;

CREATE TRIGGER easy_pay_direct_automatic_collection_scope_identity_immutable
BEFORE UPDATE OF subscription_id, organization_id, created_at
ON easy_pay_direct_automatic_collection_scopes
BEGIN
  SELECT RAISE(ABORT, 'immutable_easy_pay_direct_automatic_collection_scope_identity');
END;
