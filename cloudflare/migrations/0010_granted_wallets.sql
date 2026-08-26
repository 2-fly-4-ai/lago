CREATE TABLE wallets (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  customer_id TEXT NOT NULL REFERENCES customers(id) ON DELETE RESTRICT,
  code TEXT NOT NULL,
  name TEXT,
  currency TEXT NOT NULL,
  currency_exponent INTEGER NOT NULL CHECK (currency_exponent BETWEEN 0 AND 3),
  rate_amount TEXT NOT NULL,
  priority INTEGER NOT NULL CHECK (priority BETWEEN 1 AND 50),
  balance_minor INTEGER NOT NULL DEFAULT 0 CHECK (balance_minor >= 0),
  consumed_minor INTEGER NOT NULL DEFAULT 0 CHECK (consumed_minor >= 0),
  status TEXT NOT NULL CHECK (status IN ('active', 'terminated')),
  expiration_at TEXT,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  request_sha256 TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  terminated_at TEXT
) STRICT;

CREATE UNIQUE INDEX wallets_active_code_idx
  ON wallets(customer_id, code) WHERE status = 'active';
CREATE INDEX wallets_customer_status_idx
  ON wallets(customer_id, status, priority, created_at);

CREATE TABLE wallet_transactions (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  wallet_id TEXT NOT NULL REFERENCES wallets(id) ON DELETE RESTRICT,
  invoice_id TEXT REFERENCES invoices(id) ON DELETE RESTRICT,
  voided_invoice_id TEXT REFERENCES invoices(id) ON DELETE RESTRICT,
  transaction_type TEXT NOT NULL CHECK (transaction_type IN ('inbound', 'outbound')),
  transaction_status TEXT NOT NULL CHECK (transaction_status IN ('granted', 'purchased', 'voided', 'invoiced')),
  status TEXT NOT NULL CHECK (status IN ('pending', 'settled', 'failed')),
  source TEXT NOT NULL CHECK (source IN ('manual', 'interval', 'threshold')),
  amount_minor INTEGER NOT NULL CHECK (amount_minor >= 0),
  credit_amount TEXT NOT NULL,
  remaining_minor INTEGER CHECK (remaining_minor IS NULL OR remaining_minor >= 0),
  priority INTEGER NOT NULL CHECK (priority BETWEEN 1 AND 50),
  wallet_version INTEGER NOT NULL CHECK (wallet_version > 0),
  idempotency_key TEXT,
  request_sha256 TEXT NOT NULL,
  name TEXT,
  settled_at TEXT,
  failed_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (
    (transaction_type = 'inbound' AND remaining_minor IS NOT NULL) OR
    (transaction_type = 'outbound' AND remaining_minor IS NULL)
  )
) STRICT;

CREATE UNIQUE INDEX wallet_transactions_idempotency_idx
  ON wallet_transactions(organization_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;
CREATE UNIQUE INDEX wallet_transactions_invoice_wallet_idx
  ON wallet_transactions(invoice_id, wallet_id)
  WHERE transaction_type = 'outbound' AND transaction_status = 'invoiced';
CREATE UNIQUE INDEX wallet_transactions_void_recredit_idx
  ON wallet_transactions(voided_invoice_id, wallet_id)
  WHERE transaction_type = 'inbound' AND transaction_status = 'voided';
CREATE INDEX wallet_transactions_available_idx
  ON wallet_transactions(wallet_id, priority, created_at)
  WHERE transaction_type = 'inbound' AND status = 'settled' AND remaining_minor > 0;

CREATE TABLE wallet_transaction_consumptions (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  inbound_transaction_id TEXT NOT NULL REFERENCES wallet_transactions(id) ON DELETE RESTRICT,
  outbound_transaction_id TEXT NOT NULL REFERENCES wallet_transactions(id) ON DELETE RESTRICT,
  amount_minor INTEGER NOT NULL CHECK (amount_minor > 0),
  created_at TEXT NOT NULL,
  UNIQUE (inbound_transaction_id, outbound_transaction_id)
) STRICT;

CREATE INDEX wallet_consumptions_outbound_idx
  ON wallet_transaction_consumptions(outbound_transaction_id, created_at);

CREATE TRIGGER wallet_outbound_requires_current_balance
BEFORE INSERT ON wallet_transactions
WHEN NEW.transaction_type = 'outbound' AND NOT EXISTS (
  SELECT 1 FROM wallets
  WHERE id = NEW.wallet_id
    AND organization_id = NEW.organization_id
    AND status = 'active'
    AND version = NEW.wallet_version
    AND balance_minor >= NEW.amount_minor
    AND (expiration_at IS NULL OR expiration_at > NEW.created_at)
)
BEGIN
  SELECT RAISE(ABORT, 'wallet_version_conflict');
END;

CREATE TRIGGER wallet_inbound_requires_current_version
BEFORE INSERT ON wallet_transactions
WHEN NEW.transaction_type = 'inbound' AND NOT EXISTS (
  SELECT 1 FROM wallets
  WHERE id = NEW.wallet_id
    AND organization_id = NEW.organization_id
    AND (status = 'active' OR NEW.transaction_status = 'voided')
    AND version = NEW.wallet_version
)
BEGIN
  SELECT RAISE(ABORT, 'wallet_version_conflict');
END;

CREATE TRIGGER wallet_consumption_requires_available_lot
BEFORE INSERT ON wallet_transaction_consumptions
WHEN NOT EXISTS (
  SELECT 1 FROM wallet_transactions inbound
  JOIN wallet_transactions outbound ON outbound.id = NEW.outbound_transaction_id
  WHERE inbound.id = NEW.inbound_transaction_id
    AND inbound.wallet_id = outbound.wallet_id
    AND inbound.transaction_type = 'inbound'
    AND inbound.status = 'settled'
    AND inbound.remaining_minor >= NEW.amount_minor
    AND outbound.transaction_type = 'outbound'
    AND outbound.status = 'settled'
)
BEGIN
  SELECT RAISE(ABORT, 'wallet_lot_conflict');
END;

ALTER TABLE invoices ADD COLUMN coupons_minor INTEGER NOT NULL DEFAULT 0 CHECK (coupons_minor >= 0);
ALTER TABLE invoices ADD COLUMN prepaid_credit_minor INTEGER NOT NULL DEFAULT 0 CHECK (prepaid_credit_minor >= 0);

UPDATE invoices
SET coupons_minor = COALESCE((SELECT SUM(amount_minor) FROM coupon_credits WHERE invoice_id = invoices.id), 0);
