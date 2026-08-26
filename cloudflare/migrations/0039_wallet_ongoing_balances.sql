ALTER TABLE customers ADD COLUMN awaiting_wallet_refresh INTEGER NOT NULL DEFAULT 0
  CHECK (awaiting_wallet_refresh IN (0, 1));

ALTER TABLE wallets ADD COLUMN ongoing_balance_minor INTEGER NOT NULL DEFAULT 0;
ALTER TABLE wallets ADD COLUMN ongoing_usage_balance_minor INTEGER NOT NULL DEFAULT 0
  CHECK (ongoing_usage_balance_minor >= 0);
ALTER TABLE wallets ADD COLUMN depleted_ongoing_balance INTEGER NOT NULL DEFAULT 0
  CHECK (depleted_ongoing_balance IN (0, 1));
ALTER TABLE wallets ADD COLUMN last_ongoing_balance_sync_at TEXT;
ALTER TABLE wallets ADD COLUMN ongoing_balance_version INTEGER NOT NULL DEFAULT 0
  CHECK (ongoing_balance_version >= 0);

UPDATE wallets SET ongoing_balance_minor = balance_minor;

ALTER TABLE recurring_transaction_rules ADD COLUMN threshold_credits TEXT NOT NULL DEFAULT '0';

CREATE INDEX customers_wallet_refresh_idx
  ON customers(awaiting_wallet_refresh, updated_at, id)
  WHERE awaiting_wallet_refresh = 1;

CREATE TABLE wallet_threshold_rules (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  wallet_id TEXT NOT NULL REFERENCES wallets(id) ON DELETE CASCADE,
  interval TEXT NOT NULL DEFAULT 'weekly'
    CHECK (interval IN ('weekly', 'monthly', 'quarterly', 'semiannual', 'yearly')),
  method TEXT NOT NULL DEFAULT 'fixed' CHECK (method = 'fixed'),
  trigger TEXT NOT NULL DEFAULT 'threshold' CHECK (trigger = 'threshold'),
  paid_credits TEXT NOT NULL DEFAULT '0' CHECK (paid_credits = '0'),
  granted_credits TEXT NOT NULL,
  threshold_credits TEXT NOT NULL DEFAULT '0',
  started_at TEXT,
  expiration_at TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'terminated')),
  transaction_metadata_json TEXT NOT NULL DEFAULT '[]'
    CHECK (json_valid(transaction_metadata_json) AND json_type(transaction_metadata_json) = 'array'),
  transaction_name TEXT CHECK (transaction_name IS NULL OR length(transaction_name) BETWEEN 1 AND 255),
  invoice_requires_successful_payment INTEGER NOT NULL DEFAULT 0
    CHECK (invoice_requires_successful_payment = 0),
  ignore_paid_top_up_limits INTEGER NOT NULL DEFAULT 0
    CHECK (ignore_paid_top_up_limits = 0),
  skip_invoice_custom_sections INTEGER NOT NULL DEFAULT 0
    CHECK (skip_invoice_custom_sections IN (0, 1)),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  terminated_at TEXT
) STRICT;

CREATE UNIQUE INDEX wallet_threshold_rules_active_wallet_idx
  ON wallet_threshold_rules(wallet_id) WHERE status = 'active';
CREATE INDEX wallet_threshold_rules_expiration_idx
  ON wallet_threshold_rules(status, expiration_at)
  WHERE status = 'active' AND expiration_at IS NOT NULL;

CREATE TRIGGER wallet_threshold_rules_tenant_insert
BEFORE INSERT ON wallet_threshold_rules
WHEN NOT EXISTS (
  SELECT 1 FROM wallets
  WHERE id = NEW.wallet_id AND organization_id = NEW.organization_id AND status = 'active'
)
BEGIN
  SELECT RAISE(ABORT, 'invalid_wallet_threshold_rule_tenant');
END;

CREATE TRIGGER wallet_threshold_rules_single_active_insert
BEFORE INSERT ON wallet_threshold_rules
WHEN NEW.status = 'active' AND EXISTS (
  SELECT 1 FROM recurring_transaction_rules
  WHERE wallet_id = NEW.wallet_id AND status = 'active'
)
BEGIN
  SELECT RAISE(ABORT, 'active_recurring_transaction_rule_exists');
END;

CREATE TRIGGER recurring_transaction_rules_single_active_insert
BEFORE INSERT ON recurring_transaction_rules
WHEN NEW.status = 'active' AND EXISTS (
  SELECT 1 FROM wallet_threshold_rules
  WHERE wallet_id = NEW.wallet_id AND status = 'active'
)
BEGIN
  SELECT RAISE(ABORT, 'active_recurring_transaction_rule_exists');
END;

CREATE TRIGGER wallet_threshold_rules_identity_immutable
BEFORE UPDATE OF id, wallet_id, organization_id ON wallet_threshold_rules
WHEN OLD.id <> NEW.id OR OLD.wallet_id <> NEW.wallet_id
  OR OLD.organization_id <> NEW.organization_id
BEGIN
  SELECT RAISE(ABORT, 'immutable_wallet_threshold_rule_identity');
END;

CREATE TABLE wallet_threshold_rules_invoice_custom_sections (
  wallet_threshold_rule_id TEXT NOT NULL REFERENCES wallet_threshold_rules(id) ON DELETE CASCADE,
  invoice_custom_section_id TEXT NOT NULL REFERENCES invoice_custom_sections(id) ON DELETE RESTRICT,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  created_at TEXT NOT NULL,
  PRIMARY KEY (wallet_threshold_rule_id, invoice_custom_section_id)
) STRICT;

CREATE INDEX wallet_threshold_rules_invoice_custom_sections_section_idx
  ON wallet_threshold_rules_invoice_custom_sections(
    invoice_custom_section_id,
    wallet_threshold_rule_id
  );

CREATE TRIGGER wallet_threshold_rules_invoice_custom_sections_tenant_insert
BEFORE INSERT ON wallet_threshold_rules_invoice_custom_sections
WHEN NOT EXISTS (
  SELECT 1 FROM wallet_threshold_rules rule JOIN invoice_custom_sections section
    ON section.id = NEW.invoice_custom_section_id
  WHERE rule.id = NEW.wallet_threshold_rule_id
    AND rule.organization_id = NEW.organization_id
    AND section.organization_id = NEW.organization_id
    AND section.status = 'active'
)
BEGIN
  SELECT RAISE(ABORT, 'invalid_threshold_rule_invoice_custom_section_tenant');
END;

CREATE TRIGGER wallet_threshold_rules_terminate_with_wallet
AFTER UPDATE OF status ON wallets
WHEN OLD.status = 'active' AND NEW.status = 'terminated'
BEGIN
  UPDATE wallet_threshold_rules
  SET status = 'terminated', terminated_at = COALESCE(terminated_at, NEW.terminated_at),
      updated_at = NEW.updated_at, version = version + 1
  WHERE wallet_id = NEW.id AND status = 'active';
END;

ALTER TABLE wallet_transactions ADD COLUMN wallet_threshold_rule_id TEXT
  REFERENCES wallet_threshold_rules(id) ON DELETE RESTRICT;

CREATE INDEX wallet_transactions_threshold_rule_idx
  ON wallet_transactions(wallet_threshold_rule_id, created_at)
  WHERE wallet_threshold_rule_id IS NOT NULL;

CREATE TRIGGER wallet_threshold_transaction_requires_active_rule
BEFORE INSERT ON wallet_transactions
WHEN NEW.source = 'threshold' AND NOT EXISTS (
  SELECT 1 FROM wallet_threshold_rules rule
  WHERE rule.id = NEW.wallet_threshold_rule_id
    AND rule.wallet_id = NEW.wallet_id
    AND rule.organization_id = NEW.organization_id
    AND rule.status = 'active'
    AND (rule.started_at IS NULL OR rule.started_at <= NEW.created_at)
    AND (rule.expiration_at IS NULL OR rule.expiration_at > NEW.created_at)
)
BEGIN
  SELECT RAISE(ABORT, 'invalid_threshold_wallet_transaction_rule');
END;

CREATE TABLE wallet_projection_guards (
  run_id TEXT NOT NULL,
  wallet_id TEXT NOT NULL,
  expected_wallet_version INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (run_id, wallet_id)
) STRICT;

CREATE TRIGGER wallet_projection_guard_current_version
BEFORE INSERT ON wallet_projection_guards
WHEN NOT EXISTS (
  SELECT 1 FROM wallets
  WHERE id = NEW.wallet_id AND status = 'active' AND version = NEW.expected_wallet_version
)
BEGIN
  SELECT RAISE(ABORT, 'wallet_projection_version_conflict');
END;
