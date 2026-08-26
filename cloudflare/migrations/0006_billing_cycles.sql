CREATE TABLE billing_cycles (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  subscription_id TEXT NOT NULL REFERENCES subscriptions(id) ON DELETE RESTRICT,
  period_start TEXT NOT NULL,
  period_end TEXT NOT NULL,
  period_start_ms INTEGER NOT NULL,
  period_end_ms INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('open', 'closing', 'closed', 'failed')),
  request_sha256 TEXT NOT NULL,
  invoice_id TEXT REFERENCES invoices(id) ON DELETE RESTRICT,
  failure_code TEXT,
  lease_expires_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  closed_at TEXT,
  UNIQUE (subscription_id, period_start, period_end)
) STRICT;

CREATE INDEX billing_cycles_pending_idx
  ON billing_cycles(status, period_end_ms);
CREATE INDEX billing_cycles_expired_lease_idx
  ON billing_cycles(lease_expires_at)
  WHERE status = 'closing';

ALTER TABLE invoice_lines ADD COLUMN precise_amount_minor TEXT;
ALTER TABLE invoice_lines ADD COLUMN billing_cycle_id TEXT REFERENCES billing_cycles(id) ON DELETE RESTRICT;

CREATE INDEX invoice_lines_billing_cycle_idx
  ON invoice_lines(billing_cycle_id);
