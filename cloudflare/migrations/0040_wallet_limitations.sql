ALTER TABLE wallets ADD COLUMN allowed_fee_types_json TEXT NOT NULL DEFAULT '[]'
  CHECK (json_valid(allowed_fee_types_json) AND json_type(allowed_fee_types_json) = 'array');

CREATE TABLE wallet_targets (
  wallet_id TEXT NOT NULL REFERENCES wallets(id) ON DELETE CASCADE,
  billable_metric_id TEXT NOT NULL REFERENCES billable_metrics(id) ON DELETE RESTRICT,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  created_at TEXT NOT NULL,
  PRIMARY KEY (wallet_id, billable_metric_id)
) STRICT;

CREATE INDEX wallet_targets_metric_idx
  ON wallet_targets(organization_id, billable_metric_id, wallet_id);

CREATE TRIGGER wallet_target_requires_same_organization
BEFORE INSERT ON wallet_targets
WHEN NOT EXISTS (
  SELECT 1
  FROM wallets wallet
  JOIN billable_metrics metric ON metric.id = NEW.billable_metric_id
  WHERE wallet.id = NEW.wallet_id
    AND wallet.organization_id = NEW.organization_id
    AND metric.organization_id = NEW.organization_id
)
BEGIN
  SELECT RAISE(ABORT, 'wallet_target_tenant_mismatch');
END;
