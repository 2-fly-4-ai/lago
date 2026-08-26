ALTER TABLE invoices ADD COLUMN issuing_date TEXT;
ALTER TABLE invoices ADD COLUMN expected_finalization_date TEXT;

UPDATE invoices
SET issuing_date = date(COALESCE(finalized_at, created_at));

CREATE INDEX invoices_expected_finalization_idx
  ON invoices(expected_finalization_date, id)
  WHERE status = 'draft';
