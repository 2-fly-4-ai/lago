-- Commerce transaction identity is distinct from the gateway processor refund ID.
-- Persist it before post-refund verification so recovery can remain GET-only.
ALTER TABLE provider_refund_operations ADD COLUMN provider_refund_transaction_id TEXT;

CREATE UNIQUE INDEX provider_refund_operations_commerce_transaction_idx
  ON provider_refund_operations(provider, provider_account_code, provider_refund_transaction_id)
  WHERE provider_refund_transaction_id IS NOT NULL;

CREATE TRIGGER provider_refund_operations_transaction_immutable
BEFORE UPDATE OF provider_refund_transaction_id ON provider_refund_operations
WHEN OLD.provider_refund_transaction_id IS NOT NULL
  AND NEW.provider_refund_transaction_id IS NOT OLD.provider_refund_transaction_id
BEGIN
  SELECT RAISE(ABORT, 'immutable_provider_refund_transaction');
END;
