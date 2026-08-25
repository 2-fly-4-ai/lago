ALTER TABLE easy_pay_direct_payment_executions
  ADD COLUMN terms_accepted_at TEXT;

ALTER TABLE easy_pay_direct_payment_executions
  ADD COLUMN terms_version TEXT;

DROP TRIGGER easy_pay_direct_executions_identity_immutable;

CREATE TRIGGER easy_pay_direct_executions_identity_immutable
BEFORE UPDATE OF organization_id, checkout_intent_id, payment_request_id,
  provider_account_code, request_sha256, payment_token_sha256, phone_sha256,
  customer_idempotency_key, payment_method_idempotency_key,
  product_idempotency_key, order_idempotency_key, terms_accepted_at,
  terms_version, created_at
ON easy_pay_direct_payment_executions
BEGIN
  SELECT RAISE(ABORT, 'immutable_easy_pay_direct_execution_identity');
END;
