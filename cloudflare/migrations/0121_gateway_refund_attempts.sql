-- Gateway refund responses may reuse the original sale ID. The local operation
-- is the unique identity; no amount-matching reconstruction is permitted.
CREATE TABLE gateway_refund_attempts (
  operation_id TEXT PRIMARY KEY REFERENCES provider_refund_operations(id) ON DELETE RESTRICT,
  status TEXT NOT NULL CHECK(status IN ('submitted','succeeded','failed','unknown')),
  response_transaction_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;
CREATE TRIGGER gateway_refund_attempt_identity_immutable
BEFORE UPDATE OF operation_id, created_at ON gateway_refund_attempts
BEGIN SELECT RAISE(ABORT, 'immutable_gateway_refund_attempt_identity'); END;
CREATE TRIGGER gateway_refund_attempt_terminal_immutable
BEFORE UPDATE ON gateway_refund_attempts
WHEN OLD.status IN ('succeeded','failed')
BEGIN SELECT RAISE(ABORT, 'immutable_gateway_refund_terminal_outcome'); END;
