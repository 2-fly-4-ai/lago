CREATE TABLE artifact_cleanup_tasks (
  archive_key TEXT PRIMARY KEY,
  resource_type TEXT NOT NULL CHECK (resource_type IN ('webhook_receipt')),
  resource_id TEXT NOT NULL,
  created_at TEXT NOT NULL
) STRICT;

CREATE INDEX artifact_cleanup_tasks_created_idx
  ON artifact_cleanup_tasks(created_at, archive_key);

CREATE INDEX webhook_receipts_retention_idx
  ON webhook_receipts(received_at, id);

CREATE INDEX outbound_webhook_deliveries_retention_idx
  ON outbound_webhook_deliveries(updated_at, id);
