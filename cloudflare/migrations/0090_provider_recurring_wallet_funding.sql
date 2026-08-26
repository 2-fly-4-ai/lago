CREATE TABLE provider_recurring_wallet_rule_funding (
  rule_id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  wallet_id TEXT NOT NULL REFERENCES wallets(id) ON DELETE CASCADE,
  storage_kind TEXT NOT NULL CHECK (storage_kind IN ('interval', 'threshold')),
  paid_credits TEXT NOT NULL,
  payment_method_id TEXT NOT NULL CHECK (length(payment_method_id) BETWEEN 1 AND 255),
  invoice_requires_successful_payment INTEGER NOT NULL DEFAULT 0
    CHECK (invoice_requires_successful_payment IN (0, 1)),
  ignore_paid_top_up_limits INTEGER NOT NULL DEFAULT 0
    CHECK (ignore_paid_top_up_limits IN (0, 1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;

CREATE INDEX provider_recurring_wallet_rule_funding_wallet_idx
  ON provider_recurring_wallet_rule_funding(organization_id, wallet_id, storage_kind);

CREATE TRIGGER provider_recurring_wallet_rule_funding_scope_guard
BEFORE INSERT ON provider_recurring_wallet_rule_funding
WHEN NOT EXISTS (
  SELECT 1 FROM recurring_transaction_rules rule
  WHERE NEW.storage_kind = 'interval'
    AND rule.id = NEW.rule_id
    AND rule.organization_id = NEW.organization_id
    AND rule.wallet_id = NEW.wallet_id
    AND rule.status = 'active'
) AND NOT EXISTS (
  SELECT 1 FROM wallet_threshold_rules rule
  WHERE NEW.storage_kind = 'threshold'
    AND rule.id = NEW.rule_id
    AND rule.organization_id = NEW.organization_id
    AND rule.wallet_id = NEW.wallet_id
    AND rule.status = 'active'
)
BEGIN
  SELECT RAISE(ABORT, 'provider_recurring_wallet_rule_scope_conflict');
END;

CREATE TRIGGER provider_recurring_wallet_rule_funding_identity_immutable
BEFORE UPDATE OF rule_id, organization_id, wallet_id, storage_kind, created_at
ON provider_recurring_wallet_rule_funding
WHEN OLD.rule_id <> NEW.rule_id
  OR OLD.organization_id <> NEW.organization_id
  OR OLD.wallet_id <> NEW.wallet_id
  OR OLD.storage_kind <> NEW.storage_kind
  OR OLD.created_at <> NEW.created_at
BEGIN
  SELECT RAISE(ABORT, 'immutable_provider_recurring_wallet_rule_identity');
END;

ALTER TABLE provider_wallet_funding_operations ADD COLUMN recurring_rule_id TEXT;
ALTER TABLE provider_wallet_funding_operations ADD COLUMN recurring_trigger TEXT
  CHECK (recurring_trigger IS NULL OR recurring_trigger IN ('interval', 'threshold'));
ALTER TABLE provider_wallet_funding_operations ADD COLUMN provider_charge_minor INTEGER
  CHECK (provider_charge_minor IS NULL OR provider_charge_minor > 0);

CREATE INDEX provider_wallet_funding_recurring_rule_idx
  ON provider_wallet_funding_operations(recurring_rule_id, created_at)
  WHERE recurring_rule_id IS NOT NULL;

CREATE TRIGGER provider_wallet_funding_recurring_scope_guard
BEFORE INSERT ON provider_wallet_funding_operations
WHEN NEW.recurring_rule_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM provider_recurring_wallet_rule_funding funding
  WHERE funding.rule_id = NEW.recurring_rule_id
    AND funding.organization_id = NEW.organization_id
    AND funding.wallet_id = NEW.wallet_id
    AND funding.storage_kind = NEW.recurring_trigger
)
BEGIN
  SELECT RAISE(ABORT, 'provider_wallet_funding_recurring_scope_conflict');
END;
