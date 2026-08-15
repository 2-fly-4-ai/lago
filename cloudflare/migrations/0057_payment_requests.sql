CREATE TABLE payment_requests (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  customer_id TEXT NOT NULL REFERENCES customers(id) ON DELETE RESTRICT,
  amount_minor INTEGER NOT NULL CHECK (amount_minor > 0),
  currency TEXT NOT NULL CHECK (length(currency) = 3 AND currency = upper(currency)),
  email TEXT,
  payment_attempts INTEGER NOT NULL DEFAULT 0 CHECK (payment_attempts >= 0),
  payment_status TEXT NOT NULL DEFAULT 'pending'
    CHECK (payment_status IN ('pending', 'succeeded', 'failed')),
  ready_for_payment_processing INTEGER NOT NULL DEFAULT 1
    CHECK (ready_for_payment_processing IN (0, 1)),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;

CREATE INDEX payment_requests_org_created_idx
  ON payment_requests(organization_id, created_at DESC, id DESC);
CREATE INDEX payment_requests_customer_created_idx
  ON payment_requests(customer_id, created_at DESC, id DESC);
CREATE INDEX payment_requests_org_status_idx
  ON payment_requests(organization_id, payment_status, created_at DESC);

CREATE TABLE invoices_payment_requests (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  payment_request_id TEXT NOT NULL REFERENCES payment_requests(id) ON DELETE CASCADE,
  invoice_id TEXT NOT NULL REFERENCES invoices(id) ON DELETE RESTRICT,
  invoice_version INTEGER NOT NULL CHECK (invoice_version > 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (invoice_id, payment_request_id)
) STRICT;

CREATE INDEX invoices_payment_requests_request_idx
  ON invoices_payment_requests(payment_request_id, invoice_id);
CREATE INDEX invoices_payment_requests_invoice_idx
  ON invoices_payment_requests(invoice_id, payment_request_id);
CREATE INDEX invoices_payment_requests_org_idx
  ON invoices_payment_requests(organization_id, payment_request_id);

CREATE TRIGGER invoices_payment_requests_insert_guard
BEFORE INSERT ON invoices_payment_requests
WHEN NOT EXISTS (
  SELECT 1
  FROM payment_requests request
  JOIN invoices invoice ON invoice.id = NEW.invoice_id
  WHERE request.id = NEW.payment_request_id
    AND request.organization_id = NEW.organization_id
    AND invoice.organization_id = NEW.organization_id
    AND invoice.customer_id = request.customer_id
    AND invoice.version = NEW.invoice_version
    AND invoice.status = 'finalized'
    AND invoice.payment_status <> 'succeeded'
    AND invoice.payment_overdue = 1
)
BEGIN
  SELECT RAISE(ABORT, 'invalid_payment_request_invoice');
END;

CREATE TRIGGER payment_requests_tenant_guard
BEFORE INSERT ON payment_requests
WHEN NOT EXISTS (
  SELECT 1 FROM customers customer
  WHERE customer.id = NEW.customer_id
    AND customer.organization_id = NEW.organization_id
)
BEGIN
  SELECT RAISE(ABORT, 'invalid_payment_request_customer');
END;
