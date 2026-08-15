CREATE TABLE payment_request_checkout_intents (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  payment_request_id TEXT NOT NULL REFERENCES payment_requests(id) ON DELETE RESTRICT,
  customer_id TEXT NOT NULL REFERENCES customers(id) ON DELETE RESTRICT,
  provider TEXT NOT NULL,
  provider_account_code TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  request_sha256 TEXT NOT NULL,
  amount_minor INTEGER NOT NULL CHECK (amount_minor > 0),
  currency TEXT NOT NULL CHECK (length(currency) = 3 AND currency = upper(currency)),
  payment_request_version INTEGER NOT NULL CHECK (payment_request_version > 0),
  status TEXT NOT NULL CHECK (status IN ('pending', 'processing', 'succeeded', 'failed')),
  payment_url TEXT,
  provider_token_sha256 TEXT,
  expires_at TEXT,
  failure_code TEXT,
  failure_message TEXT,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT,
  UNIQUE (organization_id, idempotency_key),
  UNIQUE (payment_request_id, payment_request_version, provider),
  CHECK (
    (status = 'succeeded' AND payment_url IS NOT NULL AND provider_token_sha256 IS NOT NULL) OR
    (status <> 'succeeded' AND payment_url IS NULL AND provider_token_sha256 IS NULL)
  )
) STRICT;

CREATE INDEX payment_request_checkout_intents_status_idx
  ON payment_request_checkout_intents(status, updated_at, id);
CREATE INDEX payment_request_checkout_intents_request_idx
  ON payment_request_checkout_intents(payment_request_id, payment_request_version, status);

CREATE TRIGGER payment_request_checkout_intents_tenant_guard
BEFORE INSERT ON payment_request_checkout_intents
WHEN NOT EXISTS (
  SELECT 1
  FROM payment_requests request
  JOIN customers customer ON customer.id = request.customer_id
  WHERE request.id = NEW.payment_request_id
    AND request.organization_id = NEW.organization_id
    AND request.customer_id = NEW.customer_id
    AND request.amount_minor = NEW.amount_minor
    AND request.currency = NEW.currency
    AND request.version = NEW.payment_request_version
    AND request.payment_status <> 'succeeded'
    AND request.ready_for_payment_processing = 1
    AND customer.organization_id = NEW.organization_id
    AND customer.payment_provider = NEW.provider
    AND COALESCE(customer.payment_provider_code, 'default') = NEW.provider_account_code
)
BEGIN
  SELECT RAISE(ABORT, 'invalid_payment_request_checkout_intent');
END;

CREATE TRIGGER payment_request_checkout_intents_immutable_guard
BEFORE UPDATE OF organization_id, payment_request_id, customer_id, provider,
                 provider_account_code, idempotency_key, request_sha256, amount_minor,
                 currency, payment_request_version
ON payment_request_checkout_intents
BEGIN
  SELECT RAISE(ABORT, 'immutable_payment_request_checkout_intent');
END;
