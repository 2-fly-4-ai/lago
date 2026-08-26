CREATE TABLE billable_metrics (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  aggregation_type TEXT NOT NULL CHECK (
    aggregation_type IN (
      'count_agg',
      'sum_agg',
      'max_agg',
      'unique_count_agg',
      'weighted_sum_agg',
      'latest_agg',
      'custom_agg'
    )
  ),
  field_name TEXT,
  recurring INTEGER NOT NULL DEFAULT 0 CHECK (recurring IN (0, 1)),
  rounding_function TEXT CHECK (rounding_function IN ('round', 'ceil', 'floor')),
  rounding_precision INTEGER,
  weighted_interval TEXT CHECK (weighted_interval IN ('seconds')),
  expression TEXT,
  properties_json TEXT NOT NULL DEFAULT '{}',
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (organization_id, code, version)
) STRICT;

CREATE UNIQUE INDEX billable_metrics_active_code_idx
  ON billable_metrics(organization_id, code)
  WHERE active = 1;

CREATE TABLE charges (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  plan_id TEXT NOT NULL REFERENCES plans(id) ON DELETE RESTRICT,
  billable_metric_id TEXT NOT NULL REFERENCES billable_metrics(id) ON DELETE RESTRICT,
  code TEXT NOT NULL,
  invoice_display_name TEXT,
  charge_model TEXT NOT NULL CHECK (
    charge_model IN (
      'standard',
      'graduated',
      'package',
      'percentage',
      'volume',
      'graduated_percentage'
    )
  ),
  properties_json TEXT NOT NULL,
  invoiceable INTEGER NOT NULL DEFAULT 1 CHECK (invoiceable IN (0, 1)),
  pay_in_advance INTEGER NOT NULL DEFAULT 0 CHECK (pay_in_advance IN (0, 1)),
  prorated INTEGER NOT NULL DEFAULT 0 CHECK (prorated IN (0, 1)),
  min_amount_minor INTEGER NOT NULL DEFAULT 0 CHECK (min_amount_minor >= 0),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (plan_id, code, version)
) STRICT;

CREATE UNIQUE INDEX charges_active_code_idx
  ON charges(plan_id, code)
  WHERE active = 1;
CREATE INDEX charges_plan_metric_idx
  ON charges(plan_id, billable_metric_id)
  WHERE active = 1;

CREATE TABLE usage_events (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  subscription_id TEXT NOT NULL REFERENCES subscriptions(id) ON DELETE RESTRICT,
  customer_id TEXT NOT NULL REFERENCES customers(id) ON DELETE RESTRICT,
  billable_metric_id TEXT NOT NULL REFERENCES billable_metrics(id) ON DELETE RESTRICT,
  transaction_id TEXT NOT NULL,
  code TEXT NOT NULL,
  timestamp TEXT NOT NULL,
  timestamp_ms INTEGER NOT NULL,
  precise_total_amount_minor TEXT,
  properties_json TEXT NOT NULL DEFAULT '{}',
  request_sha256 TEXT NOT NULL,
  archive_key TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (organization_id, subscription_id, transaction_id)
) STRICT;

CREATE INDEX usage_events_billing_lookup_idx
  ON usage_events(subscription_id, billable_metric_id, timestamp_ms, id);
CREATE INDEX usage_events_org_created_idx
  ON usage_events(organization_id, created_at DESC, id DESC);
CREATE INDEX usage_events_org_code_timestamp_idx
  ON usage_events(organization_id, code, timestamp_ms);
