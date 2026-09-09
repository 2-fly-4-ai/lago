-- Existing dispute timestamps may be local processing times rather than the
-- provider's event.created. Do not backfill or pretend those clocks are ordered.
-- Stripe and other existing inserts remain compatible with the nullable field.
ALTER TABLE payment_disputes ADD COLUMN last_provider_event_receipt_id TEXT
  REFERENCES webhook_receipts(id) ON DELETE RESTRICT;

CREATE INDEX payment_disputes_event_receipt_idx
  ON payment_disputes(last_provider_event_receipt_id)
  WHERE last_provider_event_receipt_id IS NOT NULL;
