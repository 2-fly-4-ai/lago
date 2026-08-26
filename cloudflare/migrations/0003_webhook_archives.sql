ALTER TABLE webhook_receipts ADD COLUMN archive_key TEXT;

CREATE INDEX webhook_receipts_unprocessed_idx
  ON webhook_receipts(received_at)
  WHERE processed_at IS NULL;
