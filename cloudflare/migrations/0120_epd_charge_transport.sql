-- Payment-method provenance does not identify the API which charged it.
-- Historical initial imports may be Commerce or direct Gateway test charges;
-- preserve uncertainty rather than reclassifying from an identifier's shape.
ALTER TABLE easy_pay_direct_payment_executions ADD COLUMN charge_transport TEXT NOT NULL DEFAULT 'legacy_unknown'
  CHECK (charge_transport IN ('commerce', 'gateway', 'legacy_unknown'));
ALTER TABLE easy_pay_direct_automatic_payment_executions ADD COLUMN charge_transport TEXT NOT NULL DEFAULT 'gateway'
  CHECK (charge_transport IN ('commerce', 'gateway'));
UPDATE easy_pay_direct_automatic_payment_executions SET charge_transport = 'commerce'
  WHERE payment_backend = 'commerce_elements';
UPDATE easy_pay_direct_payment_executions SET charge_transport = 'commerce'
  WHERE payment_backend = 'commerce_elements';
CREATE TRIGGER epd_initial_charge_transport_immutable
BEFORE UPDATE OF charge_transport ON easy_pay_direct_payment_executions
BEGIN SELECT RAISE(ABORT, 'immutable_epd_charge_transport'); END;
CREATE TRIGGER epd_automatic_charge_transport_immutable
BEFORE UPDATE OF charge_transport ON easy_pay_direct_automatic_payment_executions
BEGIN SELECT RAISE(ABORT, 'immutable_epd_charge_transport'); END;
CREATE TRIGGER epd_initial_charge_transport_guard
BEFORE INSERT ON easy_pay_direct_payment_executions
WHEN NEW.payment_backend = 'commerce_elements' AND NEW.charge_transport <> 'commerce'
BEGIN SELECT RAISE(ABORT, 'invalid_epd_charge_transport'); END;
CREATE TRIGGER epd_automatic_charge_transport_guard
BEFORE INSERT ON easy_pay_direct_automatic_payment_executions
WHEN (NEW.payment_backend = 'commerce_elements' AND NEW.charge_transport <> 'commerce')
  OR (NEW.payment_backend = 'gateway_vault' AND NEW.charge_transport <> 'gateway')
BEGIN SELECT RAISE(ABORT, 'invalid_epd_charge_transport'); END;
