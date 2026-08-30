CREATE TABLE easy_pay_direct_checkout_tax_quotes (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  payment_request_id TEXT NOT NULL REFERENCES payment_requests(id) ON DELETE RESTRICT,
  invoice_id TEXT NOT NULL REFERENCES invoices(id) ON DELETE RESTRICT,
  source_checkout_intent_id TEXT NOT NULL
    REFERENCES payment_request_checkout_intents(id) ON DELETE RESTRICT,
  active_checkout_intent_id TEXT
    REFERENCES payment_request_checkout_intents(id) ON DELETE RESTRICT,
  provider_code TEXT NOT NULL,
  provider_calculation_id TEXT NOT NULL,
  request_sha256 TEXT NOT NULL,
  billing_address_sha256 TEXT NOT NULL,
  billing_country TEXT NOT NULL CHECK (
    length(billing_country) = 2 AND billing_country = upper(billing_country)
  ),
  billing_state TEXT,
  billing_postal_code TEXT,
  currency TEXT NOT NULL CHECK (length(currency) = 3 AND currency = upper(currency)),
  subtotal_minor INTEGER NOT NULL CHECK (subtotal_minor > 0),
  tax_minor INTEGER NOT NULL CHECK (tax_minor >= 0),
  total_minor INTEGER NOT NULL CHECK (total_minor = subtotal_minor + tax_minor),
  tax_code TEXT NOT NULL,
  status TEXT NOT NULL CHECK (
    status IN ('quoted', 'applied', 'committed', 'commit_failed', 'superseded', 'failed')
  ),
  failure_code TEXT,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  committed_at TEXT,
  UNIQUE (provider_code, provider_calculation_id),
  UNIQUE (active_checkout_intent_id)
) STRICT;

CREATE INDEX easy_pay_direct_checkout_tax_quotes_request_idx
  ON easy_pay_direct_checkout_tax_quotes(payment_request_id, created_at DESC);
CREATE INDEX easy_pay_direct_checkout_tax_quotes_status_idx
  ON easy_pay_direct_checkout_tax_quotes(status, expires_at, id);

CREATE TRIGGER easy_pay_direct_checkout_tax_quote_scope_guard
BEFORE INSERT ON easy_pay_direct_checkout_tax_quotes
WHEN NOT EXISTS (
  SELECT 1
  FROM payment_request_checkout_intents intent
  JOIN payment_requests request ON request.id = intent.payment_request_id
  JOIN invoices_payment_requests link ON link.payment_request_id = request.id
  JOIN invoices invoice ON invoice.id = link.invoice_id
  WHERE intent.id = NEW.source_checkout_intent_id
    AND intent.organization_id = NEW.organization_id
    AND intent.payment_request_id = NEW.payment_request_id
    AND intent.provider = 'easy_pay_direct'
    AND intent.status = 'succeeded'
    AND request.organization_id = NEW.organization_id
    AND request.collection_mode = 'checkout'
    AND request.payment_status = 'pending'
    AND request.ready_for_payment_processing = 1
    AND invoice.id = NEW.invoice_id
    AND invoice.organization_id = NEW.organization_id
    AND invoice.status = 'finalized'
    AND invoice.payment_status = 'pending'
    AND invoice.ready_for_payment_processing = 1
)
BEGIN
  SELECT RAISE(ABORT, 'invalid_easy_pay_direct_checkout_tax_quote');
END;

CREATE TRIGGER easy_pay_direct_checkout_tax_quote_identity_immutable
BEFORE UPDATE OF organization_id, payment_request_id, invoice_id, source_checkout_intent_id,
  provider_code, provider_calculation_id, request_sha256, billing_address_sha256,
  billing_country, billing_state, billing_postal_code, currency, subtotal_minor, tax_minor,
  total_minor, tax_code, created_at
ON easy_pay_direct_checkout_tax_quotes
BEGIN
  SELECT RAISE(ABORT, 'immutable_easy_pay_direct_checkout_tax_quote_identity');
END;

CREATE TABLE easy_pay_direct_checkout_tax_repricing_guards (
  quote_id TEXT PRIMARY KEY
    REFERENCES easy_pay_direct_checkout_tax_quotes(id) ON DELETE RESTRICT,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  payment_request_id TEXT NOT NULL REFERENCES payment_requests(id) ON DELETE RESTRICT,
  invoice_id TEXT NOT NULL REFERENCES invoices(id) ON DELETE RESTRICT,
  source_checkout_intent_id TEXT NOT NULL
    REFERENCES payment_request_checkout_intents(id) ON DELETE RESTRICT,
  expected_payment_request_version INTEGER NOT NULL CHECK (expected_payment_request_version > 0),
  expected_invoice_version INTEGER NOT NULL CHECK (expected_invoice_version > 0),
  expected_amount_minor INTEGER NOT NULL CHECK (expected_amount_minor > 0),
  created_at TEXT NOT NULL
) STRICT;

CREATE TRIGGER easy_pay_direct_checkout_tax_repricing_guard
BEFORE INSERT ON easy_pay_direct_checkout_tax_repricing_guards
WHEN NOT EXISTS (
  SELECT 1
  FROM easy_pay_direct_checkout_tax_quotes quote
  JOIN payment_request_checkout_intents intent ON intent.id = NEW.source_checkout_intent_id
  JOIN payment_requests request ON request.id = NEW.payment_request_id
  JOIN invoices_payment_requests link
    ON link.payment_request_id = request.id AND link.invoice_id = NEW.invoice_id
  JOIN invoices invoice ON invoice.id = link.invoice_id
  WHERE quote.id = NEW.quote_id
    AND quote.organization_id = NEW.organization_id
    AND quote.payment_request_id = NEW.payment_request_id
    AND quote.invoice_id = NEW.invoice_id
    AND quote.source_checkout_intent_id = NEW.source_checkout_intent_id
    AND quote.status = 'quoted'
    AND intent.organization_id = NEW.organization_id
    AND intent.payment_request_id = NEW.payment_request_id
    AND intent.provider = 'easy_pay_direct'
    AND intent.status = 'succeeded'
    AND intent.amount_minor = NEW.expected_amount_minor
    AND intent.payment_request_version = NEW.expected_payment_request_version
    AND request.organization_id = NEW.organization_id
    AND request.version = NEW.expected_payment_request_version
    AND request.amount_minor = NEW.expected_amount_minor
    AND request.collection_mode = 'checkout'
    AND request.payment_status = 'pending'
    AND request.ready_for_payment_processing = 1
    AND link.invoice_version = NEW.expected_invoice_version
    AND invoice.organization_id = NEW.organization_id
    AND invoice.version = NEW.expected_invoice_version
    AND invoice.total_due_minor = NEW.expected_amount_minor
    AND invoice.status = 'finalized'
    AND invoice.payment_status = 'pending'
    AND invoice.ready_for_payment_processing = 1
    AND (SELECT COUNT(*) FROM invoices_payment_requests counted
         WHERE counted.payment_request_id = request.id) = 1
)
BEGIN
  SELECT RAISE(ABORT, 'easy_pay_direct_checkout_tax_repricing_conflict');
END;

CREATE TRIGGER easy_pay_direct_checkout_tax_repricing_guard_immutable
BEFORE UPDATE ON easy_pay_direct_checkout_tax_repricing_guards
BEGIN
  SELECT RAISE(ABORT, 'immutable_easy_pay_direct_checkout_tax_repricing_guard');
END;

ALTER TABLE easy_pay_direct_payment_executions ADD COLUMN tax_quote_id TEXT
  REFERENCES easy_pay_direct_checkout_tax_quotes(id) ON DELETE RESTRICT;
ALTER TABLE easy_pay_direct_payment_executions ADD COLUMN billing_address_sha256 TEXT;

CREATE TRIGGER easy_pay_direct_execution_tax_identity_immutable
BEFORE UPDATE OF tax_quote_id, billing_address_sha256
ON easy_pay_direct_payment_executions
BEGIN
  SELECT RAISE(ABORT, 'immutable_easy_pay_direct_execution_tax_identity');
END;
