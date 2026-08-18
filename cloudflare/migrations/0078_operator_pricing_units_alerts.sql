CREATE TABLE pricing_units (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  short_name TEXT NOT NULL CHECK (length(short_name) BETWEEN 1 AND 3),
  description TEXT,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT,
  UNIQUE (organization_id, code)
) STRICT;

CREATE INDEX pricing_units_org_active_idx
  ON pricing_units(organization_id, created_at DESC, id)
  WHERE deleted_at IS NULL;

CREATE TRIGGER pricing_units_identity_immutable
BEFORE UPDATE OF organization_id, code, created_at ON pricing_units
WHEN OLD.organization_id <> NEW.organization_id OR OLD.code <> NEW.code
  OR OLD.created_at <> NEW.created_at
BEGIN
  SELECT RAISE(ABORT, 'immutable_pricing_unit_identity');
END;

CREATE TABLE operator_alerts (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  resource_type TEXT NOT NULL CHECK (resource_type IN ('subscription', 'wallet')),
  resource_id TEXT NOT NULL,
  alert_type TEXT NOT NULL CHECK (alert_type IN (
    'billable_metric_current_usage_amount',
    'billable_metric_current_usage_units',
    'billable_metric_lifetime_usage_units',
    'current_usage_amount',
    'lifetime_usage_amount',
    'wallet_balance_amount',
    'wallet_credits_balance',
    'wallet_credits_ongoing_balance',
    'wallet_ongoing_balance_amount'
  )),
  billable_metric_id TEXT REFERENCES billable_metrics(id) ON DELETE RESTRICT,
  code TEXT NOT NULL,
  name TEXT,
  thresholds_json TEXT NOT NULL CHECK (
    json_valid(thresholds_json) AND json_type(thresholds_json) = 'array'
  ),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT
) STRICT;

CREATE UNIQUE INDEX operator_alerts_resource_code_active_idx
  ON operator_alerts(organization_id, resource_type, resource_id, code)
  WHERE deleted_at IS NULL;

CREATE INDEX operator_alerts_resource_active_idx
  ON operator_alerts(organization_id, resource_type, resource_id, created_at DESC, id)
  WHERE deleted_at IS NULL;

CREATE TRIGGER operator_subscription_alert_tenant_guard
BEFORE INSERT ON operator_alerts
WHEN NEW.resource_type = 'subscription' AND NOT EXISTS (
  SELECT 1 FROM subscriptions
  WHERE organization_id = NEW.organization_id
    AND (id = NEW.resource_id OR external_id = NEW.resource_id)
)
BEGIN
  SELECT RAISE(ABORT, 'invalid_subscription_alert_tenant');
END;

CREATE TRIGGER operator_wallet_alert_tenant_guard
BEFORE INSERT ON operator_alerts
WHEN NEW.resource_type = 'wallet' AND NOT EXISTS (
  SELECT 1 FROM wallets WHERE organization_id = NEW.organization_id AND id = NEW.resource_id
)
BEGIN
  SELECT RAISE(ABORT, 'invalid_wallet_alert_tenant');
END;

CREATE TRIGGER operator_alert_metric_tenant_guard
BEFORE INSERT ON operator_alerts
WHEN NEW.billable_metric_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM billable_metrics
  WHERE organization_id = NEW.organization_id AND id = NEW.billable_metric_id AND active = 1
)
BEGIN
  SELECT RAISE(ABORT, 'invalid_alert_metric_tenant');
END;

CREATE TRIGGER operator_alert_metric_update_tenant_guard
BEFORE UPDATE OF billable_metric_id ON operator_alerts
WHEN NEW.billable_metric_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM billable_metrics
  WHERE organization_id = NEW.organization_id AND id = NEW.billable_metric_id AND active = 1
)
BEGIN
  SELECT RAISE(ABORT, 'invalid_alert_metric_tenant');
END;

CREATE TRIGGER operator_alert_identity_immutable
BEFORE UPDATE OF organization_id, resource_type, resource_id, alert_type, created_at ON operator_alerts
WHEN OLD.organization_id <> NEW.organization_id OR OLD.resource_type <> NEW.resource_type
  OR OLD.resource_id <> NEW.resource_id OR OLD.alert_type <> NEW.alert_type
  OR OLD.created_at <> NEW.created_at
BEGIN
  SELECT RAISE(ABORT, 'immutable_operator_alert_identity');
END;
