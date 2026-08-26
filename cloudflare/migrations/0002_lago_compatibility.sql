ALTER TABLE customers ADD COLUMN payment_provider TEXT;
ALTER TABLE customers ADD COLUMN payment_provider_code TEXT;

CREATE TABLE payment_links (
  invoice_id TEXT PRIMARY KEY REFERENCES invoices(id) ON DELETE CASCADE,
  provider TEXT NOT NULL,
  provider_account_code TEXT NOT NULL,
  payment_url TEXT NOT NULL,
  provider_token_sha256 TEXT NOT NULL,
  expires_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;

CREATE TABLE provider_webhook_events (
  receipt_id TEXT PRIMARY KEY REFERENCES webhook_receipts(id) ON DELETE CASCADE,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  event_type TEXT NOT NULL,
  provider_transaction_id TEXT,
  invoice_id TEXT REFERENCES invoices(id) ON DELETE RESTRICT,
  normalized_status TEXT,
  normalized_at TEXT
) STRICT;

CREATE INDEX provider_webhook_events_transaction_idx
  ON provider_webhook_events(provider_transaction_id);
