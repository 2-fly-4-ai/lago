PRAGMA foreign_keys = OFF;

CREATE TABLE data_exports_next (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  requested_by_api_key_id TEXT REFERENCES api_keys(id) ON DELETE RESTRICT,
  requested_by_operator_membership_id TEXT REFERENCES operator_memberships(id) ON DELETE RESTRICT,
  format TEXT NOT NULL DEFAULT 'csv' CHECK (format = 'csv'),
  resource_type TEXT NOT NULL CHECK (resource_type IN (
    'invoices', 'invoice_fees', 'credit_notes', 'credit_note_items'
  )),
  resource_query_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(resource_query_json)),
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'processing', 'completed', 'failed')),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  idempotency_key TEXT NOT NULL,
  request_sha256 TEXT NOT NULL CHECK (length(request_sha256) = 64),
  object_key TEXT,
  filename TEXT,
  etag TEXT,
  byte_size INTEGER CHECK (byte_size IS NULL OR byte_size >= 0),
  row_count INTEGER CHECK (row_count IS NULL OR row_count >= 0),
  error_code TEXT,
  started_at TEXT,
  completed_at TEXT,
  expires_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (organization_id, idempotency_key),
  CHECK ((requested_by_api_key_id IS NULL) <> (requested_by_operator_membership_id IS NULL)),
  CHECK (status NOT IN ('processing', 'completed') OR started_at IS NOT NULL),
  CHECK ((status = 'completed') = (
    object_key IS NOT NULL AND filename IS NOT NULL AND etag IS NOT NULL
    AND byte_size IS NOT NULL AND row_count IS NOT NULL
    AND completed_at IS NOT NULL AND expires_at IS NOT NULL
  )),
  CHECK ((status = 'failed') = (error_code IS NOT NULL))
) STRICT;

INSERT INTO data_exports_next (
  id, organization_id, requested_by_api_key_id, requested_by_operator_membership_id,
  format, resource_type, resource_query_json, status, version, idempotency_key,
  request_sha256, object_key, filename, etag, byte_size, row_count, error_code,
  started_at, completed_at, expires_at, created_at, updated_at
)
SELECT id, organization_id, requested_by_api_key_id, NULL,
  format, resource_type, resource_query_json, status, version, idempotency_key,
  request_sha256, object_key, filename, etag, byte_size, row_count, error_code,
  started_at, completed_at, expires_at, created_at, updated_at
FROM data_exports;

DROP TRIGGER data_export_outbox_version_guard;
DROP TRIGGER data_exports_artifact_immutable;
DROP TRIGGER data_exports_identity_immutable;
DROP TRIGGER data_exports_requester_tenant_guard;
DROP TABLE data_exports;
ALTER TABLE data_exports_next RENAME TO data_exports;

CREATE INDEX data_exports_org_created_idx
  ON data_exports(organization_id, created_at DESC, id DESC);
CREATE INDEX data_exports_pending_idx
  ON data_exports(status, created_at) WHERE status IN ('pending', 'processing');
CREATE INDEX data_exports_expiry_idx
  ON data_exports(expires_at) WHERE status = 'completed';

CREATE TRIGGER data_exports_requester_tenant_guard
BEFORE INSERT ON data_exports
WHEN NOT (
  (NEW.requested_by_api_key_id IS NOT NULL AND EXISTS (
    SELECT 1 FROM api_keys
    WHERE id = NEW.requested_by_api_key_id
      AND organization_id = NEW.organization_id
      AND revoked_at IS NULL
  ))
  OR
  (NEW.requested_by_operator_membership_id IS NOT NULL AND EXISTS (
    SELECT 1 FROM operator_memberships
    WHERE id = NEW.requested_by_operator_membership_id
      AND organization_id = NEW.organization_id
      AND active = 1
      AND revoked_at IS NULL
  ))
)
BEGIN
  SELECT RAISE(ABORT, 'invalid_data_export_requester');
END;

CREATE TRIGGER data_exports_identity_immutable
BEFORE UPDATE OF organization_id, requested_by_api_key_id,
  requested_by_operator_membership_id, format, resource_type,
  resource_query_json, idempotency_key, request_sha256, created_at
ON data_exports
WHEN OLD.organization_id <> NEW.organization_id
  OR OLD.requested_by_api_key_id IS NOT NEW.requested_by_api_key_id
  OR OLD.requested_by_operator_membership_id IS NOT NEW.requested_by_operator_membership_id
  OR OLD.format <> NEW.format
  OR OLD.resource_type <> NEW.resource_type
  OR OLD.resource_query_json <> NEW.resource_query_json
  OR OLD.idempotency_key <> NEW.idempotency_key
  OR OLD.request_sha256 <> NEW.request_sha256
  OR OLD.created_at <> NEW.created_at
BEGIN
  SELECT RAISE(ABORT, 'immutable_data_export_identity');
END;

CREATE TRIGGER data_exports_artifact_immutable
BEFORE UPDATE OF object_key, filename, etag, byte_size, row_count, completed_at, expires_at
ON data_exports
WHEN OLD.status = 'completed' AND (
  OLD.object_key IS NOT NEW.object_key
  OR OLD.filename IS NOT NEW.filename
  OR OLD.etag IS NOT NEW.etag
  OR OLD.byte_size IS NOT NEW.byte_size
  OR OLD.row_count IS NOT NEW.row_count
  OR OLD.completed_at IS NOT NEW.completed_at
  OR OLD.expires_at IS NOT NEW.expires_at
)
BEGIN
  SELECT RAISE(ABORT, 'immutable_data_export_artifact');
END;

CREATE TRIGGER data_export_outbox_version_guard
BEFORE INSERT ON outbox_events
WHEN NEW.aggregate_type = 'data_export' AND NOT EXISTS (
  SELECT 1 FROM data_exports export
  WHERE export.id = NEW.aggregate_id
    AND export.organization_id = NEW.organization_id
    AND export.version = NEW.aggregate_version
)
BEGIN
  SELECT RAISE(ABORT, 'data_export_outbox_version_conflict');
END;

PRAGMA foreign_keys = ON;
