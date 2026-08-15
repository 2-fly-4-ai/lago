PRAGMA foreign_keys = ON;

CREATE TABLE operator_memberships (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  access_issuer TEXT NOT NULL CHECK (
    access_issuer LIKE 'https://%.cloudflareaccess.com'
    AND instr(substr(access_issuer, 9), '/') = 0
  ),
  access_subject_sha256 TEXT NOT NULL CHECK (length(access_subject_sha256) = 64),
  role TEXT NOT NULL CHECK (role IN ('viewer', 'admin')),
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  revoked_at TEXT,
  UNIQUE (access_issuer, access_subject_sha256),
  CHECK ((active = 1 AND revoked_at IS NULL) OR (active = 0 AND revoked_at IS NOT NULL))
) STRICT;

CREATE INDEX operator_memberships_org_active_idx
  ON operator_memberships(organization_id, active, role);

CREATE TRIGGER operator_membership_identity_immutable
BEFORE UPDATE OF organization_id, access_issuer, access_subject_sha256, created_at
ON operator_memberships
WHEN OLD.organization_id <> NEW.organization_id
  OR OLD.access_issuer <> NEW.access_issuer
  OR OLD.access_subject_sha256 <> NEW.access_subject_sha256
  OR OLD.created_at <> NEW.created_at
BEGIN
  SELECT RAISE(ABORT, 'immutable_operator_membership_identity');
END;
