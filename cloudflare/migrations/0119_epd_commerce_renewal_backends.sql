-- Backend identity is durable: existing profiles/executions remain Gateway-only.
-- Do not infer a Gateway vault from a Commerce payment-method UUID.
ALTER TABLE provider_customer_profiles ADD COLUMN payment_backend TEXT NOT NULL DEFAULT 'gateway_vault'
  CHECK (payment_backend IN ('gateway_vault', 'commerce_elements'));
ALTER TABLE easy_pay_direct_payment_executions ADD COLUMN payment_backend TEXT NOT NULL DEFAULT 'gateway_vault'
  CHECK (payment_backend IN ('gateway_vault', 'commerce_elements'));
ALTER TABLE easy_pay_direct_payment_executions ADD COLUMN contact_name_sha256 TEXT;
CREATE TRIGGER provider_customer_profiles_backend_immutable
BEFORE UPDATE OF payment_backend ON provider_customer_profiles
BEGIN SELECT RAISE(ABORT, 'immutable_provider_payment_backend'); END;
CREATE TRIGGER easy_pay_direct_payment_backend_immutable
BEFORE UPDATE OF payment_backend, contact_name_sha256 ON easy_pay_direct_payment_executions
BEGIN SELECT RAISE(ABORT, 'immutable_easy_pay_direct_payment_backend'); END;
CREATE TRIGGER provider_customer_profiles_commerce_identity_guard
BEFORE INSERT ON provider_customer_profiles
WHEN NEW.payment_backend = 'commerce_elements' AND (
  NEW.provider <> 'easy_pay_direct' OR NEW.checkout_intent_id IS NULL
  OR length(NEW.provider_customer_id) <> 36 OR length(NEW.provider_payment_method_id) IS NOT 36
  OR NEW.gateway_customer_vault_id IS NOT NULL OR NEW.gateway_billing_id IS NOT NULL
)
BEGIN SELECT RAISE(ABORT, 'invalid_commerce_payment_profile'); END;

-- Rebuild only the execution journal; no tables reference its primary key.
-- Keeping one journal preserves shared-invoice payment exclusion across backends.
DROP TRIGGER easy_pay_direct_automatic_execution_scope_guard;
DROP TRIGGER easy_pay_direct_automatic_execution_identity_immutable;
CREATE TABLE easy_pay_direct_automatic_payment_executions_next (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  payment_request_id TEXT NOT NULL UNIQUE REFERENCES payment_requests(id) ON DELETE RESTRICT,
  customer_id TEXT NOT NULL REFERENCES customers(id) ON DELETE RESTRICT,
  provider_profile_id TEXT NOT NULL REFERENCES provider_customer_profiles(id) ON DELETE RESTRICT,
  provider_account_code TEXT NOT NULL,
  request_sha256 TEXT NOT NULL,
  gateway_customer_vault_id TEXT,
  initial_transaction_id TEXT,
  order_reference TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'processing', 'succeeded', 'failed', 'unknown')),
  provider_transaction_id TEXT,
  provider_response_code TEXT,
  failure_code TEXT,
  failure_message TEXT,
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  lease_expires_at TEXT,
  last_provider_read_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT,
  payment_backend TEXT NOT NULL DEFAULT 'gateway_vault' CHECK (payment_backend IN ('gateway_vault', 'commerce_elements')),
  commerce_customer_id TEXT,
  commerce_payment_method_id TEXT,
  product_idempotency_key TEXT,
  order_idempotency_key TEXT,
  commerce_product_id TEXT,
  commerce_order_id TEXT,
  order_submit_started_at TEXT,
  CHECK ((payment_backend = 'gateway_vault' AND gateway_customer_vault_id IS NOT NULL AND initial_transaction_id IS NOT NULL
          AND commerce_customer_id IS NULL AND commerce_payment_method_id IS NULL)
    OR (payment_backend = 'commerce_elements' AND gateway_customer_vault_id IS NULL
        AND commerce_customer_id IS NOT NULL AND commerce_payment_method_id IS NOT NULL
        AND product_idempotency_key IS NOT NULL AND order_idempotency_key IS NOT NULL
        AND length(commerce_customer_id) = 36 AND length(commerce_payment_method_id) = 36
        AND length(product_idempotency_key) = 36 AND substr(product_idempotency_key,15,1) = '4'
        AND length(order_idempotency_key) = 36 AND substr(order_idempotency_key,15,1) = '4')),
  UNIQUE (provider_account_code, order_reference),
  UNIQUE (provider_account_code, provider_transaction_id)
) STRICT;
INSERT INTO easy_pay_direct_automatic_payment_executions_next
 (id, organization_id, payment_request_id, customer_id, provider_profile_id, provider_account_code,
  request_sha256, gateway_customer_vault_id, initial_transaction_id, order_reference, status,
  provider_transaction_id, provider_response_code, failure_code, failure_message, attempt_count,
  lease_expires_at, last_provider_read_at, created_at, updated_at, completed_at)
SELECT id, organization_id, payment_request_id, customer_id, provider_profile_id, provider_account_code,
  request_sha256, gateway_customer_vault_id, initial_transaction_id, order_reference, status,
  provider_transaction_id, provider_response_code, failure_code, failure_message, attempt_count,
  lease_expires_at, last_provider_read_at, created_at, updated_at, completed_at
FROM easy_pay_direct_automatic_payment_executions;
DROP TABLE easy_pay_direct_automatic_payment_executions;
ALTER TABLE easy_pay_direct_automatic_payment_executions_next RENAME TO easy_pay_direct_automatic_payment_executions;
CREATE INDEX easy_pay_direct_automatic_execution_status_idx
  ON easy_pay_direct_automatic_payment_executions(status, updated_at, id);
CREATE INDEX easy_pay_direct_automatic_execution_customer_idx
  ON easy_pay_direct_automatic_payment_executions(organization_id, customer_id, created_at DESC, id);
CREATE TRIGGER easy_pay_direct_automatic_execution_scope_guard
BEFORE INSERT ON easy_pay_direct_automatic_payment_executions
WHEN NOT EXISTS (
 SELECT 1 FROM payment_requests request JOIN customers customer ON customer.id = request.customer_id
 JOIN provider_customer_profiles profile ON profile.id = NEW.provider_profile_id
 WHERE request.id = NEW.payment_request_id AND request.organization_id = NEW.organization_id
  AND request.customer_id = NEW.customer_id AND request.payment_status = 'pending' AND request.ready_for_payment_processing = 1
  AND customer.organization_id = NEW.organization_id AND customer.payment_provider = 'easy_pay_direct'
  AND COALESCE(customer.payment_provider_code, 'default') = NEW.provider_account_code
  AND profile.organization_id = NEW.organization_id AND profile.customer_id = NEW.customer_id
  AND profile.provider = 'easy_pay_direct' AND profile.provider_account_code = NEW.provider_account_code
  AND profile.status = 'active' AND profile.payment_backend = NEW.payment_backend
  AND ((NEW.payment_backend = 'gateway_vault' AND profile.gateway_customer_vault_id = NEW.gateway_customer_vault_id
        AND profile.initial_transaction_id = NEW.initial_transaction_id)
    OR (NEW.payment_backend = 'commerce_elements' AND profile.provider_customer_id = NEW.commerce_customer_id
        AND profile.provider_payment_method_id = NEW.commerce_payment_method_id))
)
BEGIN SELECT RAISE(ABORT, 'invalid_easy_pay_direct_automatic_execution'); END;
CREATE TRIGGER easy_pay_direct_automatic_execution_identity_immutable
BEFORE UPDATE OF id, organization_id, payment_request_id, customer_id, provider_profile_id,
  provider_account_code, request_sha256, gateway_customer_vault_id, initial_transaction_id,
  order_reference, created_at, payment_backend, commerce_customer_id, commerce_payment_method_id,
  product_idempotency_key, order_idempotency_key
ON easy_pay_direct_automatic_payment_executions
BEGIN SELECT RAISE(ABORT, 'immutable_easy_pay_direct_automatic_execution_identity'); END;
CREATE TRIGGER easy_pay_direct_automatic_commerce_checkpoint_immutable
BEFORE UPDATE OF commerce_product_id, commerce_order_id, order_submit_started_at
ON easy_pay_direct_automatic_payment_executions
WHEN (OLD.commerce_product_id IS NOT NULL AND NEW.commerce_product_id IS NOT OLD.commerce_product_id)
 OR (OLD.commerce_order_id IS NOT NULL AND NEW.commerce_order_id IS NOT OLD.commerce_order_id)
 OR (OLD.order_submit_started_at IS NOT NULL AND NEW.order_submit_started_at IS NOT OLD.order_submit_started_at)
BEGIN SELECT RAISE(ABORT, 'immutable_automatic_commerce_checkpoint'); END;
