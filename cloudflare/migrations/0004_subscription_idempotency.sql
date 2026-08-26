ALTER TABLE subscriptions ADD COLUMN name TEXT;
ALTER TABLE subscriptions ADD COLUMN request_sha256 TEXT;

CREATE INDEX subscriptions_request_sha256_idx
  ON subscriptions(organization_id, request_sha256)
  WHERE request_sha256 IS NOT NULL;
