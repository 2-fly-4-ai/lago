PRAGMA foreign_keys = ON;

CREATE TABLE payment_receipt_document_artifacts (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  payment_receipt_id TEXT NOT NULL REFERENCES payment_receipts(id) ON DELETE RESTRICT,
  receipt_version INTEGER NOT NULL CHECK (receipt_version > 0),
  status TEXT NOT NULL CHECK (status IN ('generating', 'ready', 'failed')),
  object_key TEXT,
  content_sha256 TEXT,
  byte_length INTEGER CHECK (byte_length IS NULL OR byte_length >= 0),
  failure_code TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  generated_at TEXT,
  UNIQUE (payment_receipt_id, receipt_version)
) STRICT;

CREATE INDEX payment_receipt_document_artifacts_status_idx
  ON payment_receipt_document_artifacts(status, updated_at);

CREATE TRIGGER payment_receipt_document_artifact_tenant_guard
BEFORE INSERT ON payment_receipt_document_artifacts
WHEN NOT EXISTS (
  SELECT 1 FROM payment_receipts receipt
  WHERE receipt.id = NEW.payment_receipt_id
    AND receipt.organization_id = NEW.organization_id
    AND receipt.version = NEW.receipt_version
)
BEGIN
  SELECT RAISE(ABORT, 'invalid_payment_receipt_document_tenant_or_version');
END;

CREATE TRIGGER payment_receipt_document_artifact_identity_immutable
BEFORE UPDATE OF organization_id, payment_receipt_id, receipt_version
ON payment_receipt_document_artifacts
WHEN OLD.organization_id <> NEW.organization_id
  OR OLD.payment_receipt_id <> NEW.payment_receipt_id
  OR OLD.receipt_version <> NEW.receipt_version
BEGIN
  SELECT RAISE(ABORT, 'immutable_payment_receipt_document_identity');
END;
