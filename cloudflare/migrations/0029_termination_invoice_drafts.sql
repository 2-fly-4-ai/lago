CREATE TABLE subscription_invoice_contexts_v2 (
  invoice_id TEXT PRIMARY KEY REFERENCES invoices(id) ON DELETE RESTRICT,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  subscription_id TEXT NOT NULL REFERENCES subscriptions(id) ON DELETE RESTRICT,
  context_type TEXT NOT NULL CHECK (context_type IN ('initial', 'termination')),
  period_start TEXT NOT NULL,
  period_end TEXT NOT NULL,
  terminated_at TEXT,
  created_at TEXT NOT NULL,
  CHECK (
    (context_type = 'initial' AND terminated_at IS NULL) OR
    (context_type = 'termination' AND terminated_at IS NOT NULL)
  ),
  UNIQUE (subscription_id, context_type)
) STRICT;

INSERT INTO subscription_invoice_contexts_v2
  (invoice_id, organization_id, subscription_id, context_type, period_start, period_end,
   terminated_at, created_at)
SELECT invoice_id, organization_id, subscription_id, context_type, period_start, period_end,
       NULL, created_at
FROM subscription_invoice_contexts;

DROP TABLE subscription_invoice_contexts;
ALTER TABLE subscription_invoice_contexts_v2 RENAME TO subscription_invoice_contexts;

CREATE INDEX subscription_invoice_contexts_subscription_idx
  ON subscription_invoice_contexts(subscription_id, created_at);
