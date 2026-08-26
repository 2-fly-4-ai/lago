CREATE TABLE operator_invitations (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  access_issuer TEXT NOT NULL,
  email_sha256 TEXT NOT NULL CHECK (length(email_sha256) = 64),
  role TEXT NOT NULL CHECK (role IN ('viewer', 'admin')),
  status TEXT NOT NULL CHECK (status IN ('pending', 'accepted', 'revoked', 'expired')),
  invited_by_membership_id TEXT REFERENCES operator_memberships(id) ON DELETE SET NULL,
  accepted_by_membership_id TEXT REFERENCES operator_memberships(id) ON DELETE SET NULL,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  accepted_at TEXT,
  revoked_at TEXT
) STRICT;

CREATE UNIQUE INDEX operator_invitations_pending_identity_idx
  ON operator_invitations(access_issuer, email_sha256, organization_id)
  WHERE status = 'pending';

CREATE INDEX operator_invitations_org_status_idx
  ON operator_invitations(organization_id, status, created_at DESC);

CREATE TRIGGER operator_invitations_identity_immutable
BEFORE UPDATE OF organization_id, access_issuer, email_sha256, created_at
ON operator_invitations
WHEN OLD.organization_id <> NEW.organization_id
  OR OLD.access_issuer <> NEW.access_issuer
  OR OLD.email_sha256 <> NEW.email_sha256
  OR OLD.created_at <> NEW.created_at
BEGIN
  SELECT RAISE(ABORT, 'immutable_operator_invitation_identity');
END;
