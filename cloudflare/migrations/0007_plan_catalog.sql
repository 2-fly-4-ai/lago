ALTER TABLE plans ADD COLUMN invoice_display_name TEXT;
ALTER TABLE plans ADD COLUMN description TEXT;
ALTER TABLE plans ADD COLUMN trial_period REAL;
ALTER TABLE plans ADD COLUMN pay_in_advance INTEGER NOT NULL DEFAULT 0 CHECK (pay_in_advance IN (0, 1));
ALTER TABLE plans ADD COLUMN bill_charges_monthly INTEGER CHECK (bill_charges_monthly IN (0, 1));
ALTER TABLE plans ADD COLUMN bill_fixed_charges_monthly INTEGER CHECK (bill_fixed_charges_monthly IN (0, 1));
ALTER TABLE plans ADD COLUMN metadata_json TEXT NOT NULL DEFAULT '{}';
ALTER TABLE plans ADD COLUMN request_sha256 TEXT;
ALTER TABLE plans ADD COLUMN pending_deletion INTEGER NOT NULL DEFAULT 0 CHECK (pending_deletion IN (0, 1));

CREATE INDEX plans_request_sha256_idx
  ON plans(organization_id, request_sha256)
  WHERE request_sha256 IS NOT NULL;
