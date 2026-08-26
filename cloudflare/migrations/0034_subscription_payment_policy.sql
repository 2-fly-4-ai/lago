ALTER TABLE subscriptions ADD COLUMN payment_method_type TEXT
  CHECK (payment_method_type IN ('manual', 'provider'));
ALTER TABLE subscriptions ADD COLUMN payment_method_id TEXT;

CREATE TRIGGER subscriptions_payment_method_insert
BEFORE INSERT ON subscriptions
WHEN (NEW.payment_method_type IS NULL AND NEW.payment_method_id IS NOT NULL)
  OR (NEW.payment_method_type = 'manual' AND NEW.payment_method_id IS NOT NULL)
BEGIN
  SELECT RAISE(ABORT, 'invalid_subscription_payment_method');
END;

CREATE TRIGGER subscriptions_payment_method_update
BEFORE UPDATE OF payment_method_type, payment_method_id ON subscriptions
WHEN (NEW.payment_method_type IS NULL AND NEW.payment_method_id IS NOT NULL)
  OR (NEW.payment_method_type = 'manual' AND NEW.payment_method_id IS NOT NULL)
BEGIN
  SELECT RAISE(ABORT, 'invalid_subscription_payment_method');
END;
