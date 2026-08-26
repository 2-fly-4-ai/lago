CREATE TABLE operator_api_logs (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  membership_id TEXT NOT NULL REFERENCES operator_memberships(id) ON DELETE CASCADE,
  request_id TEXT NOT NULL,
  method TEXT NOT NULL CHECK (method IN ('GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE')),
  route_template TEXT NOT NULL,
  response_status INTEGER NOT NULL CHECK (response_status BETWEEN 100 AND 599),
  duration_ms INTEGER NOT NULL CHECK (duration_ms >= 0),
  occurred_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
) STRICT;

CREATE INDEX operator_api_logs_org_occurred_idx
  ON operator_api_logs(organization_id, occurred_at DESC, id DESC);

CREATE INDEX operator_api_logs_expiry_idx
  ON operator_api_logs(expires_at, id);

CREATE TRIGGER operator_api_logs_immutable
BEFORE UPDATE ON operator_api_logs
BEGIN
  SELECT RAISE(ABORT, 'operator_api_log_immutable');
END;
