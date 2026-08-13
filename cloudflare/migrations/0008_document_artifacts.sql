CREATE TABLE document_artifacts (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  resource_type TEXT NOT NULL CHECK (resource_type IN ('invoice')),
  resource_id TEXT NOT NULL REFERENCES invoices(id) ON DELETE RESTRICT,
  resource_version INTEGER NOT NULL CHECK (resource_version > 0),
  artifact_type TEXT NOT NULL CHECK (artifact_type IN ('pdf')),
  status TEXT NOT NULL CHECK (status IN ('generating', 'ready', 'failed')),
  object_key TEXT,
  content_sha256 TEXT,
  byte_length INTEGER CHECK (byte_length IS NULL OR byte_length >= 0),
  failure_code TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  generated_at TEXT,
  UNIQUE (resource_type, resource_id, resource_version, artifact_type)
) STRICT;

CREATE INDEX document_artifacts_status_idx
  ON document_artifacts(status, updated_at);
