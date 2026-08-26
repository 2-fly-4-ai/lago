PRAGMA foreign_keys = ON;

-- Daily usage is a durable revenue-analytics projection. The full JSON payloads preserve Lago's
-- cumulative snapshot and diff contracts, while normalized charge rows make daily/weekly/monthly
-- rollups queryable in D1 without ClickHouse or JSON scans.
CREATE TABLE daily_usage_snapshots (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  customer_id TEXT NOT NULL REFERENCES customers(id) ON DELETE RESTRICT,
  subscription_id TEXT NOT NULL REFERENCES subscriptions(id) ON DELETE RESTRICT,
  external_subscription_id TEXT NOT NULL,
  usage_date TEXT NOT NULL CHECK (usage_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  from_datetime TEXT NOT NULL,
  to_datetime TEXT NOT NULL,
  calculated_through TEXT NOT NULL,
  refreshed_at TEXT NOT NULL,
  currency TEXT NOT NULL CHECK (length(currency) > 0),
  amount_minor INTEGER NOT NULL,
  total_amount_minor INTEGER NOT NULL,
  tax_amount_minor INTEGER NOT NULL DEFAULT 0,
  usage_json TEXT NOT NULL CHECK (json_valid(usage_json)),
  usage_diff_json TEXT NOT NULL CHECK (json_valid(usage_diff_json)),
  source_type TEXT NOT NULL CHECK (source_type IN ('scheduled', 'invoice')),
  source_invoice_id TEXT REFERENCES invoices(id) ON DELETE CASCADE,
  source_invoice_version INTEGER CHECK (source_invoice_version IS NULL OR source_invoice_version > 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (subscription_id, usage_date),
  UNIQUE (source_invoice_id, subscription_id),
  CHECK (
    (source_type = 'scheduled' AND source_invoice_id IS NULL AND source_invoice_version IS NULL) OR
    (source_type = 'invoice' AND source_invoice_id IS NOT NULL AND source_invoice_version IS NOT NULL)
  )
) STRICT;

CREATE INDEX daily_usage_snapshots_org_date_idx
  ON daily_usage_snapshots(organization_id, usage_date, id);
CREATE INDEX daily_usage_snapshots_customer_date_idx
  ON daily_usage_snapshots(customer_id, usage_date, id);
CREATE INDEX daily_usage_snapshots_external_date_idx
  ON daily_usage_snapshots(organization_id, external_subscription_id, usage_date, id);
CREATE INDEX daily_usage_snapshots_source_invoice_idx
  ON daily_usage_snapshots(source_invoice_id)
  WHERE source_invoice_id IS NOT NULL;

CREATE TABLE daily_usage_charge_snapshots (
  id TEXT PRIMARY KEY,
  daily_usage_snapshot_id TEXT NOT NULL REFERENCES daily_usage_snapshots(id) ON DELETE CASCADE,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  customer_id TEXT NOT NULL REFERENCES customers(id) ON DELETE RESTRICT,
  subscription_id TEXT NOT NULL REFERENCES subscriptions(id) ON DELETE RESTRICT,
  charge_id TEXT NOT NULL,
  charge_code TEXT,
  billable_metric_id TEXT NOT NULL,
  billable_metric_code TEXT NOT NULL,
  currency TEXT NOT NULL CHECK (length(currency) > 0),
  cumulative_units_decimal TEXT NOT NULL,
  delta_units_decimal TEXT NOT NULL,
  cumulative_events_count INTEGER NOT NULL,
  delta_events_count INTEGER NOT NULL,
  cumulative_amount_minor INTEGER NOT NULL,
  delta_amount_minor INTEGER NOT NULL,
  cumulative_usage_json TEXT NOT NULL CHECK (json_valid(cumulative_usage_json)),
  delta_usage_json TEXT NOT NULL CHECK (json_valid(delta_usage_json)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (daily_usage_snapshot_id, charge_id)
) STRICT;

CREATE INDEX daily_usage_charge_snapshots_rollup_idx
  ON daily_usage_charge_snapshots(organization_id, billable_metric_code, daily_usage_snapshot_id);
CREATE INDEX daily_usage_charge_snapshots_subscription_idx
  ON daily_usage_charge_snapshots(subscription_id, charge_id, daily_usage_snapshot_id);
