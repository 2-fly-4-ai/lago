ALTER TABLE usage_events ADD COLUMN deleted_at TEXT;

CREATE TABLE billable_metric_cleanup_tasks (
  billable_metric_id TEXT PRIMARY KEY REFERENCES billable_metrics(id) ON DELETE RESTRICT,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  created_at TEXT NOT NULL
) STRICT;

CREATE INDEX billable_metric_cleanup_tasks_created_idx
  ON billable_metric_cleanup_tasks(created_at, billable_metric_id);

CREATE TABLE billable_metric_mutation_guards (
  request_id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  billable_metric_id TEXT NOT NULL REFERENCES billable_metrics(id) ON DELETE RESTRICT,
  source_version INTEGER NOT NULL CHECK (source_version > 0),
  target_version INTEGER NOT NULL CHECK (target_version = source_version + 1),
  target_active INTEGER NOT NULL CHECK (target_active IN (0, 1)),
  created_at TEXT NOT NULL
) STRICT;

DROP INDEX usage_events_billing_lookup_idx;
CREATE INDEX usage_events_billing_lookup_idx
  ON usage_events(subscription_id, billable_metric_id, timestamp_ms, id)
  WHERE deleted_at IS NULL;

DROP INDEX usage_events_org_created_idx;
CREATE INDEX usage_events_org_created_idx
  ON usage_events(organization_id, created_at DESC, id DESC)
  WHERE deleted_at IS NULL;

DROP INDEX usage_events_org_code_timestamp_idx;
CREATE INDEX usage_events_org_code_timestamp_idx
  ON usage_events(organization_id, code, timestamp_ms)
  WHERE deleted_at IS NULL;

CREATE TABLE artifact_cleanup_tasks_next (
  archive_key TEXT PRIMARY KEY,
  resource_type TEXT NOT NULL CHECK (resource_type IN ('webhook_receipt', 'usage_event')),
  resource_id TEXT NOT NULL,
  created_at TEXT NOT NULL
) STRICT;

INSERT INTO artifact_cleanup_tasks_next
  (archive_key, resource_type, resource_id, created_at)
SELECT archive_key, resource_type, resource_id, created_at
FROM artifact_cleanup_tasks;

DROP TABLE artifact_cleanup_tasks;
ALTER TABLE artifact_cleanup_tasks_next RENAME TO artifact_cleanup_tasks;

CREATE INDEX artifact_cleanup_tasks_created_idx
  ON artifact_cleanup_tasks(created_at, archive_key);
