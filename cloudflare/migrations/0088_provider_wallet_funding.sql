CREATE TABLE provider_wallet_funding_operations (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  wallet_id TEXT NOT NULL REFERENCES wallets(id) ON DELETE RESTRICT,
  wallet_transaction_id TEXT NOT NULL UNIQUE REFERENCES wallet_transactions(id) ON DELETE RESTRICT,
  provider TEXT NOT NULL,
  provider_account_code TEXT NOT NULL,
  provider_payment_intent_id TEXT,
  payment_method_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  request_sha256 TEXT NOT NULL,
  amount_minor INTEGER NOT NULL CHECK (amount_minor > 0),
  credit_amount TEXT NOT NULL,
  currency TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN (
    'pending', 'requires_action', 'processing', 'succeeded', 'failed', 'canceled'
  )),
  client_secret TEXT,
  failure_code TEXT,
  failure_message TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (organization_id, idempotency_key),
  UNIQUE (provider, provider_account_code, provider_payment_intent_id)
) STRICT;

CREATE INDEX provider_wallet_funding_org_status_idx
  ON provider_wallet_funding_operations(organization_id, status, updated_at DESC);

CREATE TRIGGER provider_wallet_funding_scope_guard
BEFORE INSERT ON provider_wallet_funding_operations
WHEN NOT EXISTS (
  SELECT 1 FROM wallets wallet
  JOIN wallet_transactions transaction_row
    ON transaction_row.id = NEW.wallet_transaction_id
  WHERE wallet.id = NEW.wallet_id
    AND wallet.organization_id = NEW.organization_id
    AND transaction_row.wallet_id = wallet.id
    AND transaction_row.organization_id = NEW.organization_id
    AND transaction_row.transaction_type = 'inbound'
    AND transaction_row.transaction_status = 'purchased'
)
BEGIN
  SELECT RAISE(ABORT, 'provider_wallet_funding_scope_conflict');
END;

CREATE TRIGGER provider_wallet_funding_identity_immutable
BEFORE UPDATE OF organization_id, wallet_id, wallet_transaction_id, provider,
  provider_account_code, payment_method_id, idempotency_key, request_sha256,
  amount_minor, credit_amount, currency, created_at ON provider_wallet_funding_operations
BEGIN
  SELECT RAISE(ABORT, 'immutable_provider_wallet_funding_identity');
END;
