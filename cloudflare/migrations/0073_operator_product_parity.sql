PRAGMA foreign_keys = ON;

-- Lago-owned feature catalog. This deliberately remains in the billing domain; a future
-- serp-auth adapter may consume the projection, but it is not the source of truth for it.
CREATE TABLE entitlement_features (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  code TEXT NOT NULL CHECK (length(code) BETWEEN 1 AND 255),
  name TEXT CHECK (name IS NULL OR length(name) <= 255),
  description TEXT CHECK (description IS NULL OR length(description) <= 600),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT
) STRICT;

CREATE UNIQUE INDEX entitlement_features_active_code_idx
  ON entitlement_features(organization_id, code)
  WHERE deleted_at IS NULL;
CREATE INDEX entitlement_features_org_created_idx
  ON entitlement_features(organization_id, created_at DESC, id DESC)
  WHERE deleted_at IS NULL;

CREATE TABLE entitlement_privileges (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  entitlement_feature_id TEXT NOT NULL REFERENCES entitlement_features(id) ON DELETE CASCADE,
  code TEXT NOT NULL CHECK (length(code) BETWEEN 1 AND 255),
  name TEXT CHECK (name IS NULL OR length(name) <= 255),
  value_type TEXT NOT NULL CHECK (value_type IN ('boolean', 'integer', 'string', 'select')),
  config_json TEXT NOT NULL DEFAULT '{}'
    CHECK (
      json_valid(config_json)
      AND json_type(config_json) = 'object'
      AND (
        value_type <> 'select'
        OR (
          json_type(config_json, '$.select_options') = 'array'
          AND json_array_length(config_json, '$.select_options') > 0
        )
      )
    ),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT
) STRICT;

CREATE UNIQUE INDEX entitlement_privileges_active_code_idx
  ON entitlement_privileges(entitlement_feature_id, code)
  WHERE deleted_at IS NULL;
CREATE INDEX entitlement_privileges_org_feature_idx
  ON entitlement_privileges(organization_id, entitlement_feature_id, created_at, id)
  WHERE deleted_at IS NULL;

CREATE TABLE plan_entitlements (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  plan_id TEXT NOT NULL REFERENCES plans(id) ON DELETE CASCADE,
  entitlement_feature_id TEXT NOT NULL REFERENCES entitlement_features(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT
) STRICT;

CREATE UNIQUE INDEX plan_entitlements_active_feature_idx
  ON plan_entitlements(plan_id, entitlement_feature_id)
  WHERE deleted_at IS NULL;
CREATE INDEX plan_entitlements_org_feature_idx
  ON plan_entitlements(organization_id, entitlement_feature_id, plan_id)
  WHERE deleted_at IS NULL;

CREATE TABLE entitlement_values (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  plan_entitlement_id TEXT NOT NULL REFERENCES plan_entitlements(id) ON DELETE CASCADE,
  entitlement_privilege_id TEXT NOT NULL REFERENCES entitlement_privileges(id) ON DELETE CASCADE,
  value_json TEXT NOT NULL CHECK (json_valid(value_json)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (plan_entitlement_id, entitlement_privilege_id)
) STRICT;

CREATE INDEX entitlement_values_org_entitlement_idx
  ON entitlement_values(organization_id, plan_entitlement_id, entitlement_privilege_id);

CREATE TRIGGER entitlement_privileges_tenant_guard
BEFORE INSERT ON entitlement_privileges
WHEN NOT EXISTS (
  SELECT 1 FROM entitlement_features
  WHERE id = NEW.entitlement_feature_id
    AND organization_id = NEW.organization_id
    AND deleted_at IS NULL
)
BEGIN
  SELECT RAISE(ABORT, 'invalid_entitlement_feature_tenant');
END;

CREATE TRIGGER entitlement_features_identity_immutable
BEFORE UPDATE OF organization_id, code, created_at ON entitlement_features
WHEN OLD.organization_id <> NEW.organization_id
  OR OLD.code <> NEW.code
  OR OLD.created_at <> NEW.created_at
BEGIN
  SELECT RAISE(ABORT, 'immutable_entitlement_feature_identity');
END;

CREATE TRIGGER entitlement_privileges_identity_immutable
BEFORE UPDATE OF organization_id, entitlement_feature_id, code, value_type, created_at
ON entitlement_privileges
WHEN OLD.organization_id <> NEW.organization_id
  OR OLD.entitlement_feature_id <> NEW.entitlement_feature_id
  OR OLD.code <> NEW.code
  OR OLD.value_type <> NEW.value_type
  OR OLD.created_at <> NEW.created_at
BEGIN
  SELECT RAISE(ABORT, 'immutable_entitlement_privilege_identity');
END;

CREATE TRIGGER plan_entitlements_tenant_guard
BEFORE INSERT ON plan_entitlements
WHEN NOT EXISTS (
  SELECT 1 FROM plans
  WHERE id = NEW.plan_id AND organization_id = NEW.organization_id
)
OR NOT EXISTS (
  SELECT 1 FROM entitlement_features
  WHERE id = NEW.entitlement_feature_id
    AND organization_id = NEW.organization_id
    AND deleted_at IS NULL
)
BEGIN
  SELECT RAISE(ABORT, 'invalid_plan_entitlement_tenant');
END;

CREATE TRIGGER plan_entitlements_identity_immutable
BEFORE UPDATE OF organization_id, plan_id, entitlement_feature_id, created_at ON plan_entitlements
WHEN OLD.organization_id <> NEW.organization_id
  OR OLD.plan_id <> NEW.plan_id
  OR OLD.entitlement_feature_id <> NEW.entitlement_feature_id
  OR OLD.created_at <> NEW.created_at
BEGIN
  SELECT RAISE(ABORT, 'immutable_plan_entitlement_identity');
END;

CREATE TRIGGER entitlement_values_tenant_guard
BEFORE INSERT ON entitlement_values
WHEN NOT EXISTS (
  SELECT 1 FROM plan_entitlements
  WHERE id = NEW.plan_entitlement_id
    AND organization_id = NEW.organization_id
    AND deleted_at IS NULL
)
OR NOT EXISTS (
  SELECT 1 FROM entitlement_privileges
  WHERE id = NEW.entitlement_privilege_id
    AND organization_id = NEW.organization_id
    AND deleted_at IS NULL
)
BEGIN
  SELECT RAISE(ABORT, 'invalid_entitlement_value_tenant');
END;

CREATE TRIGGER entitlement_values_identity_immutable
BEFORE UPDATE OF organization_id, plan_entitlement_id, entitlement_privilege_id, created_at
ON entitlement_values
WHEN OLD.organization_id <> NEW.organization_id
  OR OLD.plan_entitlement_id <> NEW.plan_entitlement_id
  OR OLD.entitlement_privilege_id <> NEW.entitlement_privilege_id
  OR OLD.created_at <> NEW.created_at
BEGIN
  SELECT RAISE(ABORT, 'immutable_entitlement_value_identity');
END;

-- AI history is scoped to both the Access membership and organization. The assistant has no
-- mutation tools; these tables persist only the conversations explicitly created by an operator.
CREATE TABLE ai_conversations (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  operator_membership_id TEXT NOT NULL REFERENCES operator_memberships(id) ON DELETE CASCADE,
  title TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 160),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;

CREATE INDEX ai_conversations_member_updated_idx
  ON ai_conversations(organization_id, operator_membership_id, status, updated_at DESC, id DESC);

CREATE TABLE ai_messages (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  conversation_id TEXT NOT NULL REFERENCES ai_conversations(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
  content TEXT NOT NULL CHECK (length(content) BETWEEN 1 AND 32000),
  created_at TEXT NOT NULL
) STRICT;

CREATE INDEX ai_messages_conversation_created_idx
  ON ai_messages(organization_id, conversation_id, created_at, id);

CREATE TRIGGER ai_conversations_membership_tenant_guard
BEFORE INSERT ON ai_conversations
WHEN NOT EXISTS (
  SELECT 1 FROM operator_memberships
  WHERE id = NEW.operator_membership_id
    AND organization_id = NEW.organization_id
    AND active = 1
    AND revoked_at IS NULL
)
BEGIN
  SELECT RAISE(ABORT, 'invalid_ai_conversation_membership');
END;

CREATE TRIGGER ai_conversations_identity_immutable
BEFORE UPDATE OF organization_id, operator_membership_id, created_at ON ai_conversations
WHEN OLD.organization_id <> NEW.organization_id
  OR OLD.operator_membership_id <> NEW.operator_membership_id
  OR OLD.created_at <> NEW.created_at
BEGIN
  SELECT RAISE(ABORT, 'immutable_ai_conversation_identity');
END;

CREATE TRIGGER ai_messages_conversation_tenant_guard
BEFORE INSERT ON ai_messages
WHEN NOT EXISTS (
  SELECT 1 FROM ai_conversations
  WHERE id = NEW.conversation_id
    AND organization_id = NEW.organization_id
)
BEGIN
  SELECT RAISE(ABORT, 'invalid_ai_conversation_tenant');
END;

CREATE TRIGGER ai_messages_immutable
BEFORE UPDATE ON ai_messages
BEGIN
  SELECT RAISE(ABORT, 'immutable_ai_message');
END;
