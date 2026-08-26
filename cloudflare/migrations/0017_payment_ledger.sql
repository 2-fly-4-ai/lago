ALTER TABLE payment_attempts
  ADD COLUMN payment_type TEXT NOT NULL DEFAULT 'provider'
  CHECK (payment_type IN ('provider', 'manual'));
ALTER TABLE payment_attempts ADD COLUMN reference TEXT;
ALTER TABLE payment_attempts ADD COLUMN version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0);

CREATE INDEX payment_attempts_org_created_idx
  ON payment_attempts(organization_id, created_at DESC, id DESC);
