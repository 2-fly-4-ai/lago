ALTER TABLE invoices
  ADD COLUMN invoice_type TEXT NOT NULL DEFAULT 'subscription'
  CHECK (invoice_type IN ('subscription', 'one_off'));
ALTER TABLE invoices ADD COLUMN request_sha256 TEXT;
ALTER TABLE invoice_lines
  ADD COLUMN display_order INTEGER NOT NULL DEFAULT 0 CHECK (display_order >= 0);

CREATE UNIQUE INDEX invoices_one_off_request_idx
  ON invoices(organization_id, request_sha256)
  WHERE invoice_type = 'one_off' AND request_sha256 IS NOT NULL;
