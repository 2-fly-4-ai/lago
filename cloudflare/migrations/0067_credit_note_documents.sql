PRAGMA foreign_keys = ON;

CREATE TABLE credit_note_document_artifacts (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  credit_note_id TEXT NOT NULL REFERENCES credit_notes(id) ON DELETE RESTRICT,
  credit_note_version INTEGER NOT NULL CHECK (credit_note_version > 0),
  status TEXT NOT NULL CHECK (status IN ('generating', 'ready', 'failed')),
  object_key TEXT,
  content_sha256 TEXT,
  byte_length INTEGER CHECK (byte_length IS NULL OR byte_length >= 0),
  failure_code TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  generated_at TEXT,
  UNIQUE (credit_note_id, credit_note_version)
) STRICT;

CREATE INDEX credit_note_document_artifacts_status_idx
  ON credit_note_document_artifacts(status, updated_at);

CREATE TRIGGER credit_note_document_artifact_tenant_guard
BEFORE INSERT ON credit_note_document_artifacts
WHEN NOT EXISTS (
  SELECT 1 FROM credit_notes note
  WHERE note.id = NEW.credit_note_id
    AND note.organization_id = NEW.organization_id
    AND note.version = NEW.credit_note_version
    AND note.allocation_state = 'finalized'
)
BEGIN
  SELECT RAISE(ABORT, 'invalid_credit_note_document_tenant_or_version');
END;

CREATE TRIGGER credit_note_document_artifact_identity_immutable
BEFORE UPDATE OF organization_id, credit_note_id, credit_note_version
ON credit_note_document_artifacts
WHEN OLD.organization_id <> NEW.organization_id
  OR OLD.credit_note_id <> NEW.credit_note_id
  OR OLD.credit_note_version <> NEW.credit_note_version
BEGIN
  SELECT RAISE(ABORT, 'immutable_credit_note_document_identity');
END;

CREATE TRIGGER credit_note_generated_outbox_version_guard
BEFORE INSERT ON outbox_events
WHEN NEW.event_type = 'credit_note.generated' AND NOT EXISTS (
  SELECT 1 FROM credit_notes note
  WHERE note.id = NEW.aggregate_id
    AND note.organization_id = NEW.organization_id
    AND note.version = NEW.aggregate_version
    AND note.allocation_state = 'finalized'
)
BEGIN
  SELECT RAISE(ABORT, 'credit_note_generated_outbox_version_conflict');
END;
