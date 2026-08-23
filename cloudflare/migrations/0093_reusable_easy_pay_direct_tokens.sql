CREATE TABLE easy_pay_direct_payment_executions_rebuilt (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  checkout_intent_id TEXT NOT NULL UNIQUE
    REFERENCES payment_request_checkout_intents(id) ON DELETE RESTRICT,
  payment_request_id TEXT NOT NULL REFERENCES payment_requests(id) ON DELETE RESTRICT,
  provider_account_code TEXT NOT NULL,
  request_sha256 TEXT NOT NULL,
  payment_token_sha256 TEXT NOT NULL,
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

INSERT INTO easy_pay_direct_payment_executions_rebuilt
SELECT * FROM easy_pay_direct_payment_executions;

DROP TABLE easy_pay_direct_payment_executions;
ALTER TABLE easy_pay_direct_payment_executions_rebuilt
  RENAME TO easy_pay_direct_payment_executions;

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
