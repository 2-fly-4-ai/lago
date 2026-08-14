ALTER TABLE wallet_transactions ADD COLUMN metadata_json TEXT NOT NULL DEFAULT '[]'
  CHECK (json_valid(metadata_json) AND json_type(metadata_json) = 'array');

CREATE TABLE recurring_transaction_rules (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  wallet_id TEXT NOT NULL REFERENCES wallets(id) ON DELETE CASCADE,
  interval TEXT NOT NULL
    CHECK (interval IN ('weekly', 'monthly', 'quarterly', 'semiannual', 'yearly')),
  method TEXT NOT NULL DEFAULT 'fixed' CHECK (method = 'fixed'),
  trigger TEXT NOT NULL DEFAULT 'interval' CHECK (trigger = 'interval'),
  paid_credits TEXT NOT NULL DEFAULT '0' CHECK (paid_credits = '0'),
  granted_credits TEXT NOT NULL,
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

CREATE UNIQUE INDEX recurring_transaction_rules_active_wallet_idx
  ON recurring_transaction_rules(wallet_id) WHERE status = 'active';

CREATE INDEX recurring_transaction_rules_expiration_idx
  ON recurring_transaction_rules(status, expiration_at)
  WHERE status = 'active' AND expiration_at IS NOT NULL;

CREATE INDEX recurring_transaction_rules_interval_idx
  ON recurring_transaction_rules(status, trigger, interval, wallet_id)
  WHERE status = 'active';

CREATE TRIGGER recurring_transaction_rules_tenant_insert
BEFORE INSERT ON recurring_transaction_rules
WHEN NOT EXISTS (
  SELECT 1 FROM wallets
  WHERE id = NEW.wallet_id AND organization_id = NEW.organization_id AND status = 'active'
)
BEGIN
  SELECT RAISE(ABORT, 'invalid_recurring_transaction_rule_tenant');
END;

CREATE TRIGGER recurring_transaction_rules_identity_immutable
BEFORE UPDATE OF id, wallet_id, organization_id ON recurring_transaction_rules
WHEN OLD.id <> NEW.id OR OLD.wallet_id <> NEW.wallet_id
  OR OLD.organization_id <> NEW.organization_id
BEGIN
  SELECT RAISE(ABORT, 'immutable_recurring_transaction_rule_identity');
END;

ALTER TABLE wallet_transactions ADD COLUMN recurring_transaction_rule_id TEXT
  REFERENCES recurring_transaction_rules(id) ON DELETE RESTRICT;

CREATE INDEX wallet_transactions_recurring_rule_idx
  ON wallet_transactions(recurring_transaction_rule_id, created_at)
  WHERE recurring_transaction_rule_id IS NOT NULL;

CREATE TRIGGER wallet_interval_transaction_requires_active_rule
BEFORE INSERT ON wallet_transactions
WHEN NEW.source = 'interval' AND NOT EXISTS (
  SELECT 1 FROM recurring_transaction_rules rule
  WHERE rule.id = NEW.recurring_transaction_rule_id
    AND rule.wallet_id = NEW.wallet_id
    AND rule.organization_id = NEW.organization_id
    AND rule.status = 'active'
    AND (rule.started_at IS NULL OR rule.started_at <= NEW.created_at)
    AND (rule.expiration_at IS NULL OR rule.expiration_at > NEW.created_at)
)
BEGIN
  SELECT RAISE(ABORT, 'invalid_interval_wallet_transaction_rule');
END;

CREATE TABLE recurring_transaction_rules_invoice_custom_sections (
  recurring_transaction_rule_id TEXT NOT NULL
    REFERENCES recurring_transaction_rules(id) ON DELETE CASCADE,
  invoice_custom_section_id TEXT NOT NULL REFERENCES invoice_custom_sections(id) ON DELETE RESTRICT,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  created_at TEXT NOT NULL,
  PRIMARY KEY (recurring_transaction_rule_id, invoice_custom_section_id)
) STRICT;

CREATE INDEX recurring_transaction_rules_invoice_custom_sections_section_idx
  ON recurring_transaction_rules_invoice_custom_sections(
    invoice_custom_section_id,
    recurring_transaction_rule_id
  );

CREATE TRIGGER recurring_transaction_rules_invoice_custom_sections_tenant_insert
BEFORE INSERT ON recurring_transaction_rules_invoice_custom_sections
WHEN NOT EXISTS (
  SELECT 1 FROM recurring_transaction_rules rule JOIN invoice_custom_sections section
    ON section.id = NEW.invoice_custom_section_id
  WHERE rule.id = NEW.recurring_transaction_rule_id
    AND rule.organization_id = NEW.organization_id
    AND section.organization_id = NEW.organization_id
    AND section.status = 'active'
)
BEGIN
  SELECT RAISE(ABORT, 'invalid_recurring_rule_invoice_custom_section_tenant');
END;

CREATE TRIGGER recurring_transaction_rules_invoice_custom_sections_identity_immutable
BEFORE UPDATE OF recurring_transaction_rule_id, invoice_custom_section_id, organization_id
ON recurring_transaction_rules_invoice_custom_sections
WHEN OLD.recurring_transaction_rule_id <> NEW.recurring_transaction_rule_id
  OR OLD.invoice_custom_section_id <> NEW.invoice_custom_section_id
  OR OLD.organization_id <> NEW.organization_id
BEGIN
  SELECT RAISE(ABORT, 'immutable_recurring_rule_invoice_custom_section_identity');
END;

CREATE TRIGGER recurring_transaction_rules_terminate_with_wallet
AFTER UPDATE OF status ON wallets
WHEN OLD.status = 'active' AND NEW.status = 'terminated'
BEGIN
  UPDATE recurring_transaction_rules
  SET status = 'terminated', terminated_at = COALESCE(terminated_at, NEW.terminated_at),
      updated_at = NEW.updated_at, version = version + 1
  WHERE wallet_id = NEW.id AND status = 'active';
END;
