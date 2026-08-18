ALTER TABLE invoices ADD COLUMN payment_dispute_lost_at TEXT;

CREATE TABLE payment_disputes (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  provider TEXT NOT NULL,
  provider_account_code TEXT NOT NULL,
  provider_dispute_id TEXT NOT NULL,
  payment_attempt_id TEXT REFERENCES payment_attempts(id) ON DELETE RESTRICT,
  invoice_id TEXT REFERENCES invoices(id) ON DELETE RESTRICT,
  provider_payment_intent_id TEXT,
  provider_charge_id TEXT,
  amount_minor INTEGER NOT NULL CHECK (amount_minor >= 0),
  currency TEXT NOT NULL,
  reason TEXT,
  status TEXT NOT NULL CHECK (status IN (
    'warning_needs_response', 'warning_under_review', 'warning_closed',
    'needs_response', 'under_review', 'won', 'lost', 'prevented'
  )),
  evidence_due_by TEXT,
  livemode INTEGER NOT NULL CHECK (livemode IN (0, 1)),
  provider_created_at TEXT NOT NULL,
  last_provider_event_created_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (provider, provider_account_code, provider_dispute_id)
) STRICT;

CREATE INDEX payment_disputes_org_status_idx
  ON payment_disputes(organization_id, status, updated_at DESC, id DESC);

CREATE INDEX payment_disputes_invoice_idx
  ON payment_disputes(invoice_id, updated_at DESC)
  WHERE invoice_id IS NOT NULL;

CREATE TRIGGER payment_disputes_scope_guard
BEFORE INSERT ON payment_disputes
WHEN (NEW.payment_attempt_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM payment_attempts payment
  WHERE payment.id = NEW.payment_attempt_id
    AND payment.organization_id = NEW.organization_id
)) OR (NEW.invoice_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM invoices invoice
  WHERE invoice.id = NEW.invoice_id
    AND invoice.organization_id = NEW.organization_id
))
BEGIN
  SELECT RAISE(ABORT, 'payment_dispute_scope_conflict');
END;

CREATE TABLE provider_refund_operations (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  credit_note_id TEXT REFERENCES credit_notes(id) ON DELETE RESTRICT,
  invoice_id TEXT NOT NULL REFERENCES invoices(id) ON DELETE RESTRICT,
  payment_attempt_id TEXT NOT NULL REFERENCES payment_attempts(id) ON DELETE RESTRICT,
  provider TEXT NOT NULL,
  provider_account_code TEXT NOT NULL,
  provider_payment_id TEXT NOT NULL,
  provider_refund_id TEXT,
  idempotency_key TEXT NOT NULL,
  request_sha256 TEXT NOT NULL,
  amount_minor INTEGER NOT NULL CHECK (amount_minor > 0),
  currency TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN (
    'pending', 'requires_action', 'submitted', 'succeeded', 'failed', 'canceled'
  )),
  failure_code TEXT,
  failure_message TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (organization_id, idempotency_key),
  UNIQUE (provider, provider_account_code, provider_refund_id)
) STRICT;

CREATE INDEX provider_refund_operations_invoice_idx
  ON provider_refund_operations(invoice_id, status, updated_at DESC);

CREATE TRIGGER provider_refund_operations_scope_guard
BEFORE INSERT ON provider_refund_operations
WHEN NOT EXISTS (
  SELECT 1 FROM invoices invoice
  JOIN payment_attempts payment ON payment.id = NEW.payment_attempt_id
  WHERE invoice.id = NEW.invoice_id
    AND invoice.organization_id = NEW.organization_id
    AND payment.invoice_id = invoice.id
    AND payment.organization_id = NEW.organization_id
    AND payment.provider = NEW.provider
    AND payment.provider_account_code = NEW.provider_account_code
) OR (NEW.credit_note_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM credit_notes note
  WHERE note.id = NEW.credit_note_id
    AND note.invoice_id = NEW.invoice_id
    AND note.organization_id = NEW.organization_id
))
BEGIN
  SELECT RAISE(ABORT, 'provider_refund_scope_conflict');
END;

CREATE TRIGGER provider_refund_operations_identity_immutable
BEFORE UPDATE OF organization_id, credit_note_id, invoice_id, payment_attempt_id, provider,
  provider_account_code, provider_payment_id, idempotency_key, request_sha256, amount_minor,
  currency, created_at ON provider_refund_operations
BEGIN
  SELECT RAISE(ABORT, 'immutable_provider_refund_identity');
END;
