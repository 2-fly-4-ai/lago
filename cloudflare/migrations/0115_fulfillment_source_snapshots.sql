-- Additive local source-snapshot storage only. No billing-table triggers, publishing,
-- remote calls or grant behavior. Deployment namespace is an external trusted binding.
CREATE TABLE fulfillment_source_snapshot_heads (
  organization_id TEXT NOT NULL,
  subscription_id TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK (revision > 0),
  payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
  captured_at TEXT NOT NULL,
  evaluated_at TEXT NOT NULL,
  next_boundary_at TEXT,
  PRIMARY KEY (organization_id, subscription_id)
) STRICT;

CREATE INDEX fulfillment_source_snapshot_refresh_idx
  ON fulfillment_source_snapshot_heads(organization_id, evaluated_at, subscription_id);
CREATE INDEX fulfillment_source_snapshot_boundary_idx
  ON fulfillment_source_snapshot_heads(organization_id, next_boundary_at)
  WHERE next_boundary_at IS NOT NULL;

CREATE TABLE fulfillment_source_snapshot_history (
  organization_id TEXT NOT NULL,
  subscription_id TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK (revision > 0),
  payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
  captured_at TEXT NOT NULL,
  PRIMARY KEY (organization_id, subscription_id, revision)
) STRICT;

CREATE TRIGGER fulfillment_source_snapshot_history_immutable
BEFORE UPDATE ON fulfillment_source_snapshot_history
BEGIN
  SELECT RAISE(ABORT, 'immutable_fulfillment_source_snapshot');
END;

CREATE TRIGGER fulfillment_source_snapshot_history_no_delete
BEFORE DELETE ON fulfillment_source_snapshot_history
BEGIN
  SELECT RAISE(ABORT, 'immutable_fulfillment_source_snapshot');
END;
