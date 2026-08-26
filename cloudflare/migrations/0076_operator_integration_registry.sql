CREATE TABLE operator_integration_connections (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  provider_code TEXT NOT NULL,
  integration_group TEXT NOT NULL CHECK (integration_group IN ('payments', 'tax', 'accounting', 'crm')),
  display_name TEXT,
  status TEXT NOT NULL CHECK (status IN ('disabled', 'configuration_required')),
  settings_json TEXT NOT NULL DEFAULT '{}',
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT,
  UNIQUE (organization_id, provider_code)
) STRICT;
CREATE INDEX operator_integration_connections_org_idx
  ON operator_integration_connections(organization_id, integration_group, provider_code)
  WHERE deleted_at IS NULL;
CREATE TRIGGER operator_integration_connections_tenant_immutable
BEFORE UPDATE OF organization_id, provider_code, created_at ON operator_integration_connections
WHEN OLD.organization_id <> NEW.organization_id OR OLD.provider_code <> NEW.provider_code
  OR OLD.created_at <> NEW.created_at
BEGIN
  SELECT RAISE(ABORT, 'immutable_operator_integration_identity');
END;
