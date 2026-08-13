CREATE TABLE webhook_endpoints (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  webhook_url TEXT NOT NULL,
  signature_algo TEXT NOT NULL CHECK (signature_algo IN ('hmac')),
  name TEXT,
  event_types_json TEXT,
  status TEXT NOT NULL CHECK (status IN ('active', 'deleted')),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT
) STRICT;

CREATE UNIQUE INDEX webhook_endpoints_active_url_idx
  ON webhook_endpoints(organization_id, webhook_url) WHERE status = 'active';
CREATE INDEX webhook_endpoints_active_idx
  ON webhook_endpoints(organization_id, status, created_at);

CREATE TRIGGER webhook_endpoint_limit
BEFORE INSERT ON webhook_endpoints
WHEN (SELECT COUNT(*) FROM webhook_endpoints
      WHERE organization_id = NEW.organization_id AND status = 'active') >= 10
BEGIN
  SELECT RAISE(ABORT, 'webhook_endpoint_limit');
END;

CREATE TABLE outbound_webhook_deliveries (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  webhook_endpoint_id TEXT NOT NULL REFERENCES webhook_endpoints(id) ON DELETE RESTRICT,
  event_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'succeeded', 'retrying', 'failed')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  http_status INTEGER,
  response_excerpt TEXT,
  last_error TEXT,
  last_attempted_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (webhook_endpoint_id, event_id)
) STRICT;

CREATE INDEX outbound_webhook_deliveries_status_idx
  ON outbound_webhook_deliveries(status, updated_at);
CREATE INDEX outbound_webhook_deliveries_event_idx
  ON outbound_webhook_deliveries(event_id, webhook_endpoint_id);
