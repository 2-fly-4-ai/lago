-- Invoiceable pay-in-advance usage charges are billed once per usage-event/charge pair.
-- The marker is committed atomically with the invoice so Queue retries and scheduled repair are
-- deterministic and never rely on best-effort in-memory state.
CREATE TABLE pay_in_advance_usage_billings (
  usage_event_id TEXT NOT NULL REFERENCES usage_events(id) ON DELETE RESTRICT,
  charge_id TEXT NOT NULL REFERENCES charges(id) ON DELETE RESTRICT,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  subscription_id TEXT NOT NULL REFERENCES subscriptions(id) ON DELETE RESTRICT,
  invoice_id TEXT NOT NULL REFERENCES invoices(id) ON DELETE RESTRICT,
  charge_filter_id TEXT,
  target_wallet_code TEXT,
  period_start TEXT NOT NULL,
  period_end TEXT NOT NULL,
  aggregation_before TEXT NOT NULL,
  aggregation_after TEXT NOT NULL,
  billed_units TEXT NOT NULL,
  precise_amount_minor TEXT NOT NULL,
  amount_minor INTEGER NOT NULL CHECK (amount_minor >= 0),
  created_at TEXT NOT NULL,
  PRIMARY KEY (usage_event_id, charge_id),
  UNIQUE (invoice_id)
) STRICT;

CREATE INDEX pay_in_advance_usage_billings_subscription_idx
  ON pay_in_advance_usage_billings(subscription_id, period_start, period_end, created_at);

CREATE INDEX pay_in_advance_usage_billings_charge_idx
  ON pay_in_advance_usage_billings(charge_id, created_at);
