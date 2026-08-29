ALTER TABLE easy_pay_direct_payment_executions
  ADD COLUMN phone_ciphertext TEXT;

ALTER TABLE easy_pay_direct_payment_executions
  ADD COLUMN phone_iv TEXT;

ALTER TABLE easy_pay_direct_payment_executions
  ADD COLUMN last_checkpoint TEXT NOT NULL DEFAULT 'created'
    CHECK (last_checkpoint IN (
      'created', 'gateway_vaulted', 'provider_customer', 'provider_payment_method',
      'provider_product', 'provider_order'
    ));

ALTER TABLE easy_pay_direct_payment_executions
  ADD COLUMN resume_count INTEGER NOT NULL DEFAULT 0 CHECK (resume_count >= 0);

ALTER TABLE easy_pay_direct_payment_executions
  ADD COLUMN last_error_at TEXT;

CREATE INDEX easy_pay_direct_executions_recovery_idx
  ON easy_pay_direct_payment_executions(status, last_checkpoint, updated_at, id);
