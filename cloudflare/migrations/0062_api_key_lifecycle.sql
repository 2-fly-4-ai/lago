PRAGMA foreign_keys = ON;

ALTER TABLE api_keys ADD COLUMN name TEXT;
ALTER TABLE api_keys
  ADD COLUMN permissions_json TEXT NOT NULL DEFAULT '{}'
  CHECK (json_valid(permissions_json));
ALTER TABLE api_keys ADD COLUMN value_ending TEXT;
ALTER TABLE api_keys ADD COLUMN expires_at TEXT;
ALTER TABLE api_keys ADD COLUMN version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0);
ALTER TABLE api_keys ADD COLUMN updated_at TEXT;

CREATE INDEX api_keys_organization_active_expiry_idx
  ON api_keys(organization_id, expires_at, created_at DESC)
  WHERE revoked_at IS NULL;

CREATE TRIGGER api_keys_expiry_order_guard_insert
BEFORE INSERT ON api_keys
WHEN NEW.expires_at IS NOT NULL AND NEW.expires_at < NEW.created_at
BEGIN
  SELECT RAISE(ABORT, 'api_key_expiry_before_creation');
END;

CREATE TRIGGER api_keys_expiry_order_guard_update
BEFORE UPDATE OF expires_at ON api_keys
WHEN NEW.expires_at IS NOT NULL AND NEW.expires_at < NEW.created_at
BEGIN
  SELECT RAISE(ABORT, 'api_key_expiry_before_creation');
END;

CREATE TRIGGER api_key_outbox_version_guard
BEFORE INSERT ON outbox_events
WHEN NEW.aggregate_type = 'api_key' AND NOT EXISTS (
  SELECT 1 FROM api_keys
  WHERE id = NEW.aggregate_id
    AND organization_id = NEW.organization_id
    AND version = NEW.aggregate_version
)
BEGIN
  SELECT RAISE(ABORT, 'api_key_outbox_version_conflict');
END;

CREATE TRIGGER api_key_rotation_replaced_version_guard
BEFORE INSERT ON outbox_events
WHEN NEW.event_type = 'api_key.rotated' AND NOT EXISTS (
  SELECT 1 FROM api_keys
  WHERE id = json_extract(NEW.payload_json, '$.replaced_api_key_id')
    AND organization_id = NEW.organization_id
    AND version = json_extract(NEW.payload_json, '$.previous_version')
)
BEGIN
  SELECT RAISE(ABORT, 'api_key_rotation_version_conflict');
END;
