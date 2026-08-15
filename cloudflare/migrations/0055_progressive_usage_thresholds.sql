PRAGMA foreign_keys = ON;

CREATE TABLE usage_thresholds (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  plan_id TEXT REFERENCES plans(id) ON DELETE RESTRICT,
  subscription_id TEXT REFERENCES subscriptions(id) ON DELETE RESTRICT,
  amount_minor INTEGER NOT NULL CHECK (amount_minor > 0),
  recurring INTEGER NOT NULL DEFAULT 0 CHECK (recurring IN (0, 1)),
  threshold_display_name TEXT,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  deleted_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK ((plan_id IS NOT NULL) <> (subscription_id IS NOT NULL))
) STRICT;

CREATE INDEX usage_thresholds_organization_idx ON usage_thresholds(organization_id, id);
CREATE UNIQUE INDEX usage_thresholds_plan_amount_active_idx
  ON usage_thresholds(plan_id, amount_minor, recurring)
  WHERE deleted_at IS NULL AND plan_id IS NOT NULL;
CREATE UNIQUE INDEX usage_thresholds_subscription_amount_active_idx
  ON usage_thresholds(subscription_id, amount_minor, recurring)
  WHERE deleted_at IS NULL AND subscription_id IS NOT NULL;
CREATE UNIQUE INDEX usage_thresholds_plan_recurring_active_idx
  ON usage_thresholds(plan_id)
  WHERE deleted_at IS NULL AND plan_id IS NOT NULL AND recurring = 1;
CREATE UNIQUE INDEX usage_thresholds_subscription_recurring_active_idx
  ON usage_thresholds(subscription_id)
  WHERE deleted_at IS NULL AND subscription_id IS NOT NULL AND recurring = 1;

-- The core invoices.invoice_type check predates progressive billing. This marker preserves the
-- distinct invoice kind without rebuilding the central invoice table or weakening its FKs.
CREATE TABLE progressive_billing_invoices (
  invoice_id TEXT PRIMARY KEY REFERENCES invoices(id) ON DELETE CASCADE,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  subscription_id TEXT NOT NULL REFERENCES subscriptions(id) ON DELETE RESTRICT,
  period_start TEXT NOT NULL,
  period_end TEXT NOT NULL,
  lifetime_usage_amount_minor INTEGER NOT NULL CHECK (lifetime_usage_amount_minor >= 0),
  gross_usage_amount_minor INTEGER NOT NULL CHECK (gross_usage_amount_minor >= 0),
  prior_progressive_credit_minor INTEGER NOT NULL DEFAULT 0
    CHECK (prior_progressive_credit_minor >= 0),
  threshold_crossing_key TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (subscription_id, threshold_crossing_key)
) STRICT;

CREATE INDEX progressive_billing_invoices_period_idx
  ON progressive_billing_invoices(subscription_id, period_start, period_end, created_at DESC);
CREATE INDEX progressive_billing_invoices_organization_idx
  ON progressive_billing_invoices(organization_id, created_at DESC, invoice_id);

CREATE TABLE applied_usage_thresholds (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  usage_threshold_id TEXT NOT NULL REFERENCES usage_thresholds(id) ON DELETE RESTRICT,
  invoice_id TEXT NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
  lifetime_usage_amount_minor INTEGER NOT NULL DEFAULT 0
    CHECK (lifetime_usage_amount_minor >= 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (usage_threshold_id, invoice_id)
) STRICT;

CREATE INDEX applied_usage_thresholds_invoice_idx
  ON applied_usage_thresholds(invoice_id, id);
CREATE INDEX applied_usage_thresholds_organization_idx
  ON applied_usage_thresholds(organization_id, created_at DESC, id);

CREATE TABLE progressive_billing_credits (
  invoice_id TEXT NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
  progressive_invoice_id TEXT NOT NULL REFERENCES progressive_billing_invoices(invoice_id)
    ON DELETE RESTRICT,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  subscription_id TEXT NOT NULL REFERENCES subscriptions(id) ON DELETE RESTRICT,
  amount_minor INTEGER NOT NULL CHECK (amount_minor > 0),
  created_at TEXT NOT NULL,
  PRIMARY KEY (invoice_id, progressive_invoice_id)
) STRICT;

CREATE INDEX progressive_billing_credits_subscription_idx
  ON progressive_billing_credits(subscription_id, created_at DESC, invoice_id);

ALTER TABLE invoices ADD COLUMN progressive_billing_credit_minor INTEGER NOT NULL DEFAULT 0
  CHECK (progressive_billing_credit_minor >= 0);
