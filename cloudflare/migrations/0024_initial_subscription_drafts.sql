CREATE TABLE subscription_invoice_contexts (
  invoice_id TEXT PRIMARY KEY REFERENCES invoices(id) ON DELETE RESTRICT,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  subscription_id TEXT NOT NULL REFERENCES subscriptions(id) ON DELETE RESTRICT,
  context_type TEXT NOT NULL CHECK (context_type IN ('initial')),
  period_start TEXT NOT NULL,
  period_end TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (subscription_id, context_type)
) STRICT;

CREATE INDEX subscription_invoice_contexts_subscription_idx
  ON subscription_invoice_contexts(subscription_id, created_at);
