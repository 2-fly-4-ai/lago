CREATE TABLE payment_request_payments (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  payment_request_id TEXT NOT NULL REFERENCES payment_requests(id) ON DELETE RESTRICT,
  provider TEXT NOT NULL,
  provider_account_code TEXT NOT NULL,
  provider_transaction_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  amount_minor INTEGER NOT NULL CHECK (amount_minor > 0),
  currency TEXT NOT NULL CHECK (length(currency) = 3 AND currency = upper(currency)),
  status TEXT NOT NULL
    CHECK (status IN ('pending', 'succeeded', 'failed', 'unknown')),
  failure_code TEXT,
  failure_message TEXT,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (organization_id, idempotency_key),
  UNIQUE (provider, provider_account_code, provider_transaction_id)
) STRICT;

CREATE INDEX payment_request_payments_request_status_idx
  ON payment_request_payments(payment_request_id, status, created_at DESC, id DESC);
CREATE INDEX payment_request_payments_org_created_idx
  ON payment_request_payments(organization_id, created_at DESC, id DESC);

CREATE TABLE payment_request_payment_allocations (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  payment_request_payment_id TEXT NOT NULL
    REFERENCES payment_request_payments(id) ON DELETE CASCADE,
  payment_request_id TEXT NOT NULL REFERENCES payment_requests(id) ON DELETE RESTRICT,
  invoice_id TEXT NOT NULL REFERENCES invoices(id) ON DELETE RESTRICT,
  amount_minor INTEGER NOT NULL CHECK (amount_minor > 0),
  currency TEXT NOT NULL CHECK (length(currency) = 3 AND currency = upper(currency)),
  created_at TEXT NOT NULL,
  UNIQUE (payment_request_payment_id, invoice_id)
) STRICT;

CREATE INDEX payment_request_payment_allocations_invoice_idx
  ON payment_request_payment_allocations(invoice_id, payment_request_payment_id);
CREATE INDEX payment_request_payment_allocations_request_idx
  ON payment_request_payment_allocations(payment_request_id, invoice_id);

ALTER TABLE provider_webhook_events ADD COLUMN payment_request_id TEXT;

CREATE INDEX provider_webhook_events_payment_request_idx
  ON provider_webhook_events(payment_request_id)
  WHERE payment_request_id IS NOT NULL;

CREATE TABLE payment_request_reconciliation_guards (
  receipt_id TEXT PRIMARY KEY REFERENCES webhook_receipts(id) ON DELETE CASCADE,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  payment_request_id TEXT NOT NULL REFERENCES payment_requests(id) ON DELETE RESTRICT,
  expected_payment_request_version INTEGER NOT NULL CHECK (expected_payment_request_version > 0),
  created_at TEXT NOT NULL
) STRICT;

CREATE TABLE payment_request_reconciliation_invoice_guards (
  receipt_id TEXT NOT NULL
    REFERENCES payment_request_reconciliation_guards(receipt_id) ON DELETE CASCADE,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  payment_request_id TEXT NOT NULL REFERENCES payment_requests(id) ON DELETE RESTRICT,
  invoice_id TEXT NOT NULL REFERENCES invoices(id) ON DELETE RESTRICT,
  expected_invoice_version INTEGER NOT NULL CHECK (expected_invoice_version > 0),
  created_at TEXT NOT NULL,
  PRIMARY KEY (receipt_id, invoice_id)
) WITHOUT ROWID, STRICT;

CREATE TRIGGER payment_request_reconciliation_guard_current_state
BEFORE INSERT ON payment_request_reconciliation_guards
WHEN NOT EXISTS (
  SELECT 1 FROM payment_requests request
  WHERE request.id = NEW.payment_request_id
    AND request.organization_id = NEW.organization_id
    AND request.version = NEW.expected_payment_request_version
    AND request.payment_status <> 'succeeded'
)
BEGIN
  SELECT RAISE(ABORT, 'payment_request_reconciliation_conflict');
END;

CREATE TRIGGER payment_request_reconciliation_invoice_guard_current_state
BEFORE INSERT ON payment_request_reconciliation_invoice_guards
WHEN NOT EXISTS (
  SELECT 1
  FROM payment_request_reconciliation_guards guard
  JOIN invoices_payment_requests link
    ON link.payment_request_id = guard.payment_request_id
   AND link.invoice_id = NEW.invoice_id
  JOIN invoices invoice ON invoice.id = link.invoice_id
  WHERE guard.receipt_id = NEW.receipt_id
    AND guard.payment_request_id = NEW.payment_request_id
    AND guard.organization_id = NEW.organization_id
    AND link.organization_id = NEW.organization_id
    AND invoice.organization_id = NEW.organization_id
    AND invoice.version = NEW.expected_invoice_version
    AND invoice.payment_status <> 'succeeded'
)
BEGIN
  SELECT RAISE(ABORT, 'payment_request_invoice_reconciliation_conflict');
END;

CREATE TRIGGER provider_webhook_events_payment_request_guard
BEFORE UPDATE OF organization_id, invoice_id, payment_request_id ON provider_webhook_events
WHEN (NEW.invoice_id IS NOT NULL AND NEW.payment_request_id IS NOT NULL)
  OR (NEW.payment_request_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM payment_requests request
    WHERE request.id = NEW.payment_request_id
      AND request.organization_id = NEW.organization_id
  ))
BEGIN
  SELECT RAISE(ABORT, 'invalid_provider_webhook_payable');
END;

CREATE TRIGGER payment_request_payments_tenant_guard
BEFORE INSERT ON payment_request_payments
WHEN NOT EXISTS (
  SELECT 1 FROM payment_requests request
  WHERE request.id = NEW.payment_request_id
    AND request.organization_id = NEW.organization_id
    AND request.currency = NEW.currency
    AND request.amount_minor = NEW.amount_minor
)
BEGIN
  SELECT RAISE(ABORT, 'invalid_payment_request_payment');
END;

CREATE TRIGGER payment_request_payments_update_guard
BEFORE UPDATE OF organization_id, payment_request_id, amount_minor, currency
ON payment_request_payments
WHEN NOT EXISTS (
  SELECT 1 FROM payment_requests request
  WHERE request.id = NEW.payment_request_id
    AND request.organization_id = NEW.organization_id
    AND request.currency = NEW.currency
    AND request.amount_minor = NEW.amount_minor
)
BEGIN
  SELECT RAISE(ABORT, 'invalid_payment_request_payment');
END;

CREATE TRIGGER payment_request_payment_allocations_guard
BEFORE INSERT ON payment_request_payment_allocations
WHEN NOT EXISTS (
  SELECT 1
  FROM payment_request_payments payment
  JOIN payment_requests request ON request.id = NEW.payment_request_id
  JOIN invoices_payment_requests link
    ON link.payment_request_id = request.id AND link.invoice_id = NEW.invoice_id
  JOIN invoices invoice ON invoice.id = NEW.invoice_id
  WHERE payment.id = NEW.payment_request_payment_id
    AND payment.payment_request_id = request.id
    AND payment.organization_id = NEW.organization_id
    AND request.organization_id = NEW.organization_id
    AND link.organization_id = NEW.organization_id
    AND invoice.organization_id = NEW.organization_id
    AND payment.status = 'succeeded'
    AND payment.currency = NEW.currency
    AND request.currency = NEW.currency
    AND invoice.currency = NEW.currency
)
BEGIN
  SELECT RAISE(ABORT, 'invalid_payment_request_payment_allocation');
END;
