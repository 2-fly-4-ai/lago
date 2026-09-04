CREATE TABLE easy_pay_direct_automatic_tax_quotes (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  invoice_id TEXT NOT NULL UNIQUE REFERENCES invoices(id) ON DELETE RESTRICT,
  source_checkout_tax_quote_id TEXT NOT NULL
    REFERENCES easy_pay_direct_checkout_tax_quotes(id) ON DELETE RESTRICT,
  local_rule_set_id TEXT NOT NULL REFERENCES indirect_tax_rule_sets(id) ON DELETE RESTRICT,
  local_rule_id TEXT NOT NULL REFERENCES indirect_tax_rules(id) ON DELETE RESTRICT,
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
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;

CREATE INDEX easy_pay_direct_automatic_tax_org_created_idx
  ON easy_pay_direct_automatic_tax_quotes(organization_id, created_at DESC, id DESC);

CREATE TRIGGER easy_pay_direct_automatic_tax_scope_guard
BEFORE INSERT ON easy_pay_direct_automatic_tax_quotes
WHEN NOT EXISTS (
  SELECT 1
  FROM invoices invoice
  JOIN customers customer ON customer.id = invoice.customer_id
  JOIN easy_pay_direct_checkout_tax_quotes source
    ON source.id = NEW.source_checkout_tax_quote_id
  JOIN indirect_tax_rule_sets rule_set ON rule_set.id = NEW.local_rule_set_id
  JOIN indirect_tax_rules rule ON rule.id = NEW.local_rule_id
  WHERE invoice.id = NEW.invoice_id
    AND invoice.organization_id = NEW.organization_id
    AND invoice.status = 'finalized'
    AND invoice.payment_status = 'pending'
    AND invoice.ready_for_payment_processing = 1
    AND customer.organization_id = NEW.organization_id
    AND customer.payment_provider = 'easy_pay_direct'
    AND source.organization_id = NEW.organization_id
    AND source.status = 'committed'
    AND source.billing_address_sha256 = NEW.billing_address_sha256
    AND source.billing_country = NEW.billing_country
    AND source.billing_state IS NEW.billing_state
    AND source.billing_postal_code IS NEW.billing_postal_code
    AND rule_set.status = 'active'
    AND rule.rule_set_id = rule_set.id
    AND rule.product_tax_code = NEW.tax_code
)
BEGIN
  SELECT RAISE(ABORT, 'invalid_easy_pay_direct_automatic_tax_quote');
END;

CREATE TRIGGER easy_pay_direct_automatic_tax_identity_immutable
BEFORE UPDATE ON easy_pay_direct_automatic_tax_quotes
BEGIN
  SELECT RAISE(ABORT, 'immutable_easy_pay_direct_automatic_tax_quote');
END;

CREATE TABLE easy_pay_direct_automatic_payment_executions (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  payment_request_id TEXT NOT NULL UNIQUE REFERENCES payment_requests(id) ON DELETE RESTRICT,
  customer_id TEXT NOT NULL REFERENCES customers(id) ON DELETE RESTRICT,
  provider_profile_id TEXT NOT NULL
    REFERENCES provider_customer_profiles(id) ON DELETE RESTRICT,
  provider_account_code TEXT NOT NULL,
  request_sha256 TEXT NOT NULL,
  gateway_customer_vault_id TEXT NOT NULL,
  initial_transaction_id TEXT NOT NULL,
  order_reference TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN (
    'pending', 'processing', 'succeeded', 'failed', 'unknown'
  )),
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
  UNIQUE (provider_account_code, order_reference),
  UNIQUE (provider_account_code, provider_transaction_id)
) STRICT;

CREATE INDEX easy_pay_direct_automatic_execution_status_idx
  ON easy_pay_direct_automatic_payment_executions(status, updated_at, id);
CREATE INDEX easy_pay_direct_automatic_execution_customer_idx
  ON easy_pay_direct_automatic_payment_executions(
    organization_id, customer_id, created_at DESC, id DESC
  );

CREATE TRIGGER easy_pay_direct_automatic_execution_scope_guard
BEFORE INSERT ON easy_pay_direct_automatic_payment_executions
WHEN NOT EXISTS (
  SELECT 1
  FROM payment_requests request
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
BEGIN
  SELECT RAISE(ABORT, 'invalid_easy_pay_direct_automatic_execution');
END;

CREATE TRIGGER easy_pay_direct_automatic_execution_identity_immutable
BEFORE UPDATE OF id, organization_id, payment_request_id, customer_id, provider_profile_id,
  provider_account_code, request_sha256, gateway_customer_vault_id, initial_transaction_id,
  order_reference, created_at
ON easy_pay_direct_automatic_payment_executions
BEGIN
  SELECT RAISE(ABORT, 'immutable_easy_pay_direct_automatic_execution_identity');
END;
