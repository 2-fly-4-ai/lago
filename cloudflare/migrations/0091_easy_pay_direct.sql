CREATE TABLE easy_pay_direct_payment_executions (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  checkout_intent_id TEXT NOT NULL UNIQUE
    REFERENCES payment_request_checkout_intents(id) ON DELETE RESTRICT,
  payment_request_id TEXT NOT NULL REFERENCES payment_requests(id) ON DELETE RESTRICT,
  provider_account_code TEXT NOT NULL,
  request_sha256 TEXT NOT NULL,
  payment_token_sha256 TEXT NOT NULL UNIQUE,
  phone_sha256 TEXT NOT NULL,
  customer_idempotency_key TEXT NOT NULL,
  payment_method_idempotency_key TEXT NOT NULL,
  product_idempotency_key TEXT NOT NULL,
  order_idempotency_key TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN (
    'pending', 'processing', 'succeeded', 'failed', 'unknown'
  )),
  provider_transaction_id TEXT,
  provider_response_code TEXT,
  failure_code TEXT,
  failure_message TEXT,
  customer_vault_id TEXT,
  gateway_billing_id TEXT,
  provider_customer_id TEXT,
  provider_payment_method_id TEXT,
  provider_product_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT,
  UNIQUE (provider_account_code, provider_transaction_id)
) STRICT;

CREATE INDEX easy_pay_direct_executions_request_idx
  ON easy_pay_direct_payment_executions(payment_request_id, status, created_at DESC);

CREATE TRIGGER easy_pay_direct_executions_scope_guard
BEFORE INSERT ON easy_pay_direct_payment_executions
WHEN NOT EXISTS (
  SELECT 1
  FROM payment_request_checkout_intents intent
  JOIN payment_requests request ON request.id = intent.payment_request_id
  WHERE intent.id = NEW.checkout_intent_id
    AND intent.organization_id = NEW.organization_id
    AND intent.payment_request_id = NEW.payment_request_id
    AND intent.provider = 'easy_pay_direct'
    AND intent.provider_account_code = NEW.provider_account_code
    AND intent.request_sha256 = NEW.request_sha256
    AND intent.status = 'succeeded'
    AND request.organization_id = NEW.organization_id
    AND request.payment_status <> 'succeeded'
)
BEGIN
  SELECT RAISE(ABORT, 'invalid_easy_pay_direct_execution');
END;

CREATE TRIGGER easy_pay_direct_executions_identity_immutable
BEFORE UPDATE OF organization_id, checkout_intent_id, payment_request_id,
  provider_account_code, request_sha256, payment_token_sha256, phone_sha256,
  customer_idempotency_key, payment_method_idempotency_key,
  product_idempotency_key, order_idempotency_key, created_at
ON easy_pay_direct_payment_executions
BEGIN
  SELECT RAISE(ABORT, 'immutable_easy_pay_direct_execution_identity');
END;

CREATE TABLE provider_customer_profiles (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  customer_id TEXT NOT NULL REFERENCES customers(id) ON DELETE RESTRICT,
  provider TEXT NOT NULL,
  provider_account_code TEXT NOT NULL,
  provider_customer_id TEXT NOT NULL,
  provider_payment_method_id TEXT,
  gateway_customer_vault_id TEXT,
  gateway_billing_id TEXT,
  initial_transaction_id TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (customer_id, provider, provider_account_code),
  UNIQUE (provider, provider_account_code, provider_customer_id)
) STRICT;

CREATE INDEX provider_customer_profiles_org_provider_idx
  ON provider_customer_profiles(organization_id, provider, status, updated_at DESC);

CREATE TRIGGER provider_customer_profiles_scope_guard
BEFORE INSERT ON provider_customer_profiles
WHEN NOT EXISTS (
  SELECT 1 FROM customers customer
  WHERE customer.id = NEW.customer_id
    AND customer.organization_id = NEW.organization_id
    AND customer.payment_provider = NEW.provider
    AND COALESCE(customer.payment_provider_code, 'default') = NEW.provider_account_code
)
BEGIN
  SELECT RAISE(ABORT, 'invalid_provider_customer_profile');
END;

CREATE TRIGGER provider_customer_profiles_identity_immutable
BEFORE UPDATE OF organization_id, customer_id, provider, provider_account_code,
  provider_customer_id, created_at
ON provider_customer_profiles
BEGIN
  SELECT RAISE(ABORT, 'immutable_provider_customer_profile_identity');
END;

ALTER TABLE provider_refund_operations ADD COLUMN provider_idempotency_key TEXT;

CREATE UNIQUE INDEX provider_refund_operations_provider_idempotency_idx
  ON provider_refund_operations(provider, provider_account_code, provider_idempotency_key)
  WHERE provider_idempotency_key IS NOT NULL;

CREATE TRIGGER provider_refund_operations_provider_idempotency_immutable
BEFORE UPDATE OF provider_idempotency_key ON provider_refund_operations
WHEN OLD.provider_idempotency_key IS NOT NULL
  AND NEW.provider_idempotency_key IS NOT OLD.provider_idempotency_key
BEGIN
  SELECT RAISE(ABORT, 'immutable_provider_refund_idempotency');
END;

-- Credit-note refunds existed before Easy Pay Direct. Expand the fail-closed provider-mode
-- projection while preserving every existing Stripe/sandbox refund row and its immutable guard.
DROP TRIGGER credit_note_refund_scope_guard;
DROP TRIGGER credit_note_refund_identity_immutable;

ALTER TABLE credit_note_refunds RENAME TO credit_note_refunds_before_easy_pay_direct;

CREATE TABLE credit_note_refunds (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  credit_note_id TEXT NOT NULL UNIQUE REFERENCES credit_notes(id) ON DELETE RESTRICT,
  invoice_id TEXT NOT NULL REFERENCES invoices(id) ON DELETE RESTRICT,
  provider_mode TEXT NOT NULL CHECK (
    provider_mode IN ('sandbox', 'stripe_test', 'easy_pay_direct_test')
  ),
  provider_refund_id TEXT,
  amount_minor INTEGER NOT NULL CHECK (amount_minor > 0),
  currency TEXT NOT NULL,
  status TEXT NOT NULL CHECK (
    status IN ('pending', 'requires_action', 'succeeded', 'failed', 'canceled')
  ),
  failure_message TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (provider_mode, provider_refund_id)
) STRICT;

INSERT INTO credit_note_refunds
  (id, organization_id, credit_note_id, invoice_id, provider_mode, provider_refund_id,
   amount_minor, currency, status, failure_message, created_at, updated_at)
SELECT id, organization_id, credit_note_id, invoice_id, provider_mode, provider_refund_id,
       amount_minor, currency, status, failure_message, created_at, updated_at
FROM credit_note_refunds_before_easy_pay_direct;

DROP TABLE credit_note_refunds_before_easy_pay_direct;

CREATE TRIGGER credit_note_refund_scope_guard
BEFORE INSERT ON credit_note_refunds
WHEN NOT EXISTS (
  SELECT 1 FROM credit_notes note JOIN invoices invoice ON invoice.id = note.invoice_id
  WHERE note.id = NEW.credit_note_id
    AND note.invoice_id = NEW.invoice_id
    AND note.organization_id = NEW.organization_id
    AND invoice.organization_id = NEW.organization_id
)
BEGIN
  SELECT RAISE(ABORT, 'credit_note_refund_scope_conflict');
END;

CREATE TRIGGER credit_note_refund_identity_immutable
BEFORE UPDATE OF id, organization_id, credit_note_id, invoice_id, provider_mode, amount_minor,
  currency, created_at ON credit_note_refunds
BEGIN
  SELECT RAISE(ABORT, 'immutable_credit_note_refund_identity');
END;
