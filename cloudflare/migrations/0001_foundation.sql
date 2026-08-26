PRAGMA foreign_keys = ON;

CREATE TABLE organizations (
  id TEXT PRIMARY KEY,
  external_id TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;

CREATE TABLE api_keys (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  key_prefix TEXT NOT NULL,
  key_hash TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  revoked_at TEXT
) STRICT;

CREATE INDEX api_keys_organization_id_idx ON api_keys(organization_id);
CREATE INDEX api_keys_active_prefix_idx ON api_keys(key_prefix) WHERE revoked_at IS NULL;

CREATE TABLE customers (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  external_id TEXT NOT NULL,
  email TEXT,
  name TEXT,
  currency TEXT,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (organization_id, external_id)
) STRICT;

CREATE INDEX customers_organization_id_idx ON customers(organization_id);

CREATE TABLE plans (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  interval TEXT NOT NULL CHECK (interval IN ('weekly', 'monthly', 'quarterly', 'yearly', 'one_time')),
  amount_minor INTEGER NOT NULL CHECK (amount_minor >= 0),
  currency TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (organization_id, code, version)
) STRICT;

CREATE INDEX plans_active_code_idx ON plans(organization_id, code, active);

CREATE TABLE subscriptions (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  customer_id TEXT NOT NULL REFERENCES customers(id) ON DELETE RESTRICT,
  plan_id TEXT NOT NULL REFERENCES plans(id) ON DELETE RESTRICT,
  external_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'active', 'past_due', 'canceled', 'terminated')),
  started_at TEXT,
  current_period_start TEXT,
  current_period_end TEXT,
  canceled_at TEXT,
  terminated_at TEXT,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (organization_id, external_id)
) STRICT;

CREATE INDEX subscriptions_customer_status_idx ON subscriptions(customer_id, status);
CREATE INDEX subscriptions_period_end_idx ON subscriptions(status, current_period_end);

CREATE TABLE invoices (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  customer_id TEXT NOT NULL REFERENCES customers(id) ON DELETE RESTRICT,
  subscription_id TEXT REFERENCES subscriptions(id) ON DELETE RESTRICT,
  number TEXT,
  status TEXT NOT NULL CHECK (status IN ('draft', 'finalized', 'voided', 'failed')),
  payment_status TEXT NOT NULL CHECK (payment_status IN ('pending', 'requires_action', 'succeeded', 'failed', 'refunded')),
  currency TEXT NOT NULL,
  subtotal_minor INTEGER NOT NULL DEFAULT 0,
  tax_minor INTEGER NOT NULL DEFAULT 0,
  credits_minor INTEGER NOT NULL DEFAULT 0,
  total_due_minor INTEGER NOT NULL DEFAULT 0,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  finalized_at TEXT,
  voided_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (total_due_minor = subtotal_minor + tax_minor - credits_minor)
) STRICT;

CREATE UNIQUE INDEX invoices_org_number_idx ON invoices(organization_id, number) WHERE number IS NOT NULL;
CREATE INDEX invoices_customer_created_idx ON invoices(customer_id, created_at DESC);
CREATE INDEX invoices_subscription_idx ON invoices(subscription_id);

CREATE TABLE invoice_lines (
  id TEXT PRIMARY KEY,
  invoice_id TEXT NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
  line_type TEXT NOT NULL,
  description TEXT NOT NULL,
  quantity_decimal TEXT NOT NULL,
  unit_amount_decimal TEXT NOT NULL,
  amount_minor INTEGER NOT NULL,
  source_type TEXT NOT NULL,
  source_id TEXT NOT NULL,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  UNIQUE (invoice_id, source_type, source_id)
) STRICT;

CREATE INDEX invoice_lines_invoice_id_idx ON invoice_lines(invoice_id);

CREATE TABLE payment_attempts (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  invoice_id TEXT NOT NULL REFERENCES invoices(id) ON DELETE RESTRICT,
  provider TEXT NOT NULL,
  provider_account_code TEXT NOT NULL,
  provider_transaction_id TEXT,
  idempotency_key TEXT NOT NULL,
  amount_minor INTEGER NOT NULL CHECK (amount_minor >= 0),
  currency TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('intent_recorded', 'submitted', 'requires_action', 'succeeded', 'failed', 'unknown')),
  failure_code TEXT,
  failure_message TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (organization_id, idempotency_key),
  UNIQUE (provider, provider_account_code, provider_transaction_id)
) STRICT;

CREATE INDEX payment_attempts_invoice_status_idx ON payment_attempts(invoice_id, status);

CREATE TABLE webhook_receipts (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  provider_account_code TEXT NOT NULL,
  provider_event_id TEXT NOT NULL,
  signature_valid INTEGER NOT NULL CHECK (signature_valid IN (0, 1)),
  payload_sha256 TEXT NOT NULL,
  received_at TEXT NOT NULL,
  processed_at TEXT,
  processing_error_code TEXT,
  UNIQUE (provider, provider_account_code, provider_event_id)
) STRICT;

CREATE TABLE idempotency_records (
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  idempotency_key TEXT NOT NULL,
  operation TEXT NOT NULL,
  request_sha256 TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('processing', 'completed', 'failed')),
  response_status INTEGER,
  response_json TEXT,
  created_at TEXT NOT NULL,
  completed_at TEXT,
  expires_at TEXT NOT NULL,
  PRIMARY KEY (organization_id, idempotency_key)
) WITHOUT ROWID, STRICT;

CREATE INDEX idempotency_records_expires_at_idx ON idempotency_records(expires_at);

CREATE TABLE outbox_events (
  event_id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  event_type TEXT NOT NULL,
  event_version INTEGER NOT NULL CHECK (event_version > 0),
  aggregate_type TEXT NOT NULL,
  aggregate_id TEXT NOT NULL,
  aggregate_version INTEGER NOT NULL CHECK (aggregate_version > 0),
  causation_id TEXT,
  correlation_id TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  published_at TEXT
) STRICT;

CREATE INDEX outbox_events_unpublished_idx ON outbox_events(occurred_at) WHERE published_at IS NULL;
CREATE INDEX outbox_events_aggregate_idx ON outbox_events(aggregate_type, aggregate_id, aggregate_version);

CREATE TABLE processed_messages (
  event_id TEXT PRIMARY KEY,
  event_type TEXT NOT NULL,
  processed_at TEXT NOT NULL
) STRICT;
