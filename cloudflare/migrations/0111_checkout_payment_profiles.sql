-- Preserve existing profile IDs and foreign keys while allowing each checkout
-- to retain its own card. Existing subscriptions keep their legacy profile.
PRAGMA defer_foreign_keys = ON;
DROP TRIGGER easy_pay_direct_automatic_execution_scope_guard;
CREATE TABLE provider_customer_profiles_next (
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
  checkout_intent_id TEXT UNIQUE REFERENCES payment_request_checkout_intents(id) ON DELETE RESTRICT
) STRICT;
INSERT INTO provider_customer_profiles_next
 SELECT id, organization_id, customer_id, provider, provider_account_code,
        provider_customer_id, provider_payment_method_id, gateway_customer_vault_id,
        gateway_billing_id, initial_transaction_id, status, created_at, updated_at, NULL
 FROM provider_customer_profiles;
DROP TABLE provider_customer_profiles;
ALTER TABLE provider_customer_profiles_next RENAME TO provider_customer_profiles;
CREATE INDEX provider_customer_profiles_org_provider_idx
 ON provider_customer_profiles(organization_id, provider, status, updated_at DESC);
CREATE UNIQUE INDEX provider_customer_profiles_legacy_customer_idx
 ON provider_customer_profiles(customer_id, provider, provider_account_code)
 WHERE checkout_intent_id IS NULL;
CREATE TRIGGER provider_customer_profiles_scope_guard
BEFORE INSERT ON provider_customer_profiles
WHEN NOT EXISTS (
 SELECT 1 FROM customers customer
 WHERE customer.id = NEW.customer_id AND customer.organization_id = NEW.organization_id
 AND customer.payment_provider = NEW.provider
 AND COALESCE(customer.payment_provider_code, 'default') = NEW.provider_account_code
) OR (NEW.checkout_intent_id IS NOT NULL AND NOT EXISTS (
 SELECT 1 FROM payment_request_checkout_intents intent
 WHERE intent.id = NEW.checkout_intent_id AND intent.organization_id = NEW.organization_id
 AND intent.customer_id = NEW.customer_id AND intent.provider = NEW.provider
 AND intent.provider_account_code = NEW.provider_account_code
))
BEGIN SELECT RAISE(ABORT, 'invalid_provider_customer_profile'); END;
CREATE TRIGGER provider_customer_profiles_identity_immutable
BEFORE UPDATE OF organization_id, customer_id, provider, provider_account_code,
 provider_customer_id, created_at, checkout_intent_id ON provider_customer_profiles
BEGIN SELECT RAISE(ABORT, 'immutable_provider_customer_profile_identity'); END;
CREATE TRIGGER provider_customer_profiles_card_immutable
BEFORE UPDATE OF provider_payment_method_id, gateway_customer_vault_id, gateway_billing_id
ON provider_customer_profiles WHEN OLD.checkout_intent_id IS NOT NULL
BEGIN SELECT RAISE(ABORT, 'immutable_checkout_payment_method'); END;
CREATE TRIGGER easy_pay_direct_automatic_execution_scope_guard
BEFORE INSERT ON easy_pay_direct_automatic_payment_executions
WHEN NOT EXISTS (
  SELECT 1 FROM payment_requests request
  JOIN customers customer ON customer.id = request.customer_id
  JOIN provider_customer_profiles profile ON profile.id = NEW.provider_profile_id
  WHERE request.id = NEW.payment_request_id
    AND request.organization_id = NEW.organization_id
    AND request.customer_id = NEW.customer_id
    AND request.payment_status = 'pending'
    AND request.ready_for_payment_processing = 1
    AND customer.organization_id = NEW.organization_id
    AND customer.payment_provider = 'easy_pay_direct'
    AND COALESCE(customer.payment_provider_code, 'default') = NEW.provider_account_code
    AND profile.organization_id = NEW.organization_id
    AND profile.customer_id = NEW.customer_id
    AND profile.provider = 'easy_pay_direct'
    AND profile.provider_account_code = NEW.provider_account_code
    AND profile.gateway_customer_vault_id = NEW.gateway_customer_vault_id
    AND profile.initial_transaction_id = NEW.initial_transaction_id
    AND profile.status = 'active'
)
BEGIN SELECT RAISE(ABORT, 'invalid_easy_pay_direct_automatic_execution'); END;
-- Assert the rebuilt table still satisfies every reference before restoring
-- immediate enforcement (including executions created before this migration).
CREATE TABLE checkout_profile_migration_fk_guard (violations INTEGER CHECK (violations = 0));
INSERT INTO checkout_profile_migration_fk_guard SELECT COUNT(*) FROM pragma_foreign_key_check;
DROP TABLE checkout_profile_migration_fk_guard;
PRAGMA defer_foreign_keys = OFF;
