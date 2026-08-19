CREATE TABLE external_tax_estimates (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  provider_code TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  request_sha256 TEXT NOT NULL,
  currency TEXT NOT NULL,
  subtotal_minor INTEGER NOT NULL CHECK (subtotal_minor >= 0),
  tax_minor INTEGER CHECK (tax_minor IS NULL OR tax_minor >= 0),
  status TEXT NOT NULL CHECK (status IN ('pending', 'succeeded', 'failed')),
  response_sha256 TEXT,
  failure_code TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (organization_id, idempotency_key)
) STRICT;

CREATE INDEX external_tax_estimates_org_created_idx
  ON external_tax_estimates(organization_id, created_at DESC);

CREATE TRIGGER external_tax_estimate_identity_immutable
BEFORE UPDATE OF organization_id, provider_code, idempotency_key, request_sha256,
  currency, subtotal_minor, created_at ON external_tax_estimates
BEGIN
  SELECT RAISE(ABORT, 'immutable_external_tax_estimate_identity');
END;
