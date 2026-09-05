-- Address-resolved rates remain part of the signed rule-set identity while allowing the
-- authority lookup result to be audited independently. No rule set or registration is activated.
ALTER TABLE indirect_tax_rules ADD COLUMN calculation_method TEXT NOT NULL DEFAULT 'static'
  CHECK (calculation_method IN ('static', 'wa_dor_address'));

ALTER TABLE easy_pay_direct_checkout_tax_quotes ADD COLUMN local_calculation_method TEXT
  CHECK (local_calculation_method IS NULL OR local_calculation_method IN ('static', 'wa_dor_address'));
ALTER TABLE easy_pay_direct_checkout_tax_quotes ADD COLUMN billing_address_ciphertext TEXT;
ALTER TABLE easy_pay_direct_checkout_tax_quotes ADD COLUMN billing_address_iv TEXT;
ALTER TABLE easy_pay_direct_checkout_tax_quotes ADD COLUMN billing_address_key_id TEXT
  CHECK (billing_address_key_id IS NULL OR length(billing_address_key_id) BETWEEN 1 AND 50);
ALTER TABLE easy_pay_direct_checkout_tax_quotes ADD COLUMN rate_location_code TEXT;
ALTER TABLE easy_pay_direct_checkout_tax_quotes ADD COLUMN rate_jurisdiction TEXT;
ALTER TABLE easy_pay_direct_checkout_tax_quotes ADD COLUMN rate_period TEXT;
ALTER TABLE easy_pay_direct_checkout_tax_quotes ADD COLUMN rate_valid_through TEXT;
ALTER TABLE easy_pay_direct_checkout_tax_quotes ADD COLUMN state_rate_ppm INTEGER
  CHECK (state_rate_ppm IS NULL OR state_rate_ppm BETWEEN 0 AND 1000000);
ALTER TABLE easy_pay_direct_checkout_tax_quotes ADD COLUMN local_rate_ppm INTEGER
  CHECK (local_rate_ppm IS NULL OR local_rate_ppm BETWEEN 0 AND 1000000);

ALTER TABLE easy_pay_direct_automatic_tax_quotes ADD COLUMN local_calculation_method TEXT NOT NULL
  DEFAULT 'static' CHECK (local_calculation_method IN ('static', 'wa_dor_address'));
ALTER TABLE easy_pay_direct_automatic_tax_quotes ADD COLUMN rate_location_code TEXT;
ALTER TABLE easy_pay_direct_automatic_tax_quotes ADD COLUMN rate_jurisdiction TEXT;
ALTER TABLE easy_pay_direct_automatic_tax_quotes ADD COLUMN rate_period TEXT;
ALTER TABLE easy_pay_direct_automatic_tax_quotes ADD COLUMN rate_valid_through TEXT;
ALTER TABLE easy_pay_direct_automatic_tax_quotes ADD COLUMN state_rate_ppm INTEGER
  CHECK (state_rate_ppm IS NULL OR state_rate_ppm BETWEEN 0 AND 1000000);
ALTER TABLE easy_pay_direct_automatic_tax_quotes ADD COLUMN local_rate_ppm INTEGER
  CHECK (local_rate_ppm IS NULL OR local_rate_ppm BETWEEN 0 AND 1000000);

CREATE TRIGGER indirect_tax_rule_calculation_method_immutable
BEFORE UPDATE OF calculation_method ON indirect_tax_rules
BEGIN SELECT RAISE(ABORT, 'immutable_tax_calculation_method'); END;

CREATE TRIGGER easy_pay_direct_checkout_address_rate_identity_immutable
BEFORE UPDATE OF local_calculation_method, billing_address_ciphertext, billing_address_iv,
  billing_address_key_id,
  rate_location_code, rate_jurisdiction, rate_period, rate_valid_through,
  state_rate_ppm, local_rate_ppm
ON easy_pay_direct_checkout_tax_quotes
BEGIN SELECT RAISE(ABORT, 'immutable_checkout_address_rate_identity'); END;

CREATE TRIGGER easy_pay_direct_checkout_address_rate_guard
BEFORE INSERT ON easy_pay_direct_checkout_tax_quotes
WHEN
  (NEW.local_calculation_method = 'wa_dor_address' AND (
    NEW.billing_country <> 'US' OR NEW.billing_state <> 'WA' OR
    NEW.billing_address_ciphertext IS NULL OR NEW.billing_address_iv IS NULL OR
    NEW.billing_address_key_id IS NULL OR
    NEW.rate_location_code IS NULL OR NEW.rate_jurisdiction IS NULL OR
    NEW.rate_period IS NULL OR NEW.rate_valid_through IS NULL OR
    NEW.state_rate_ppm IS NULL OR NEW.local_rate_ppm IS NULL
  )) OR
  (COALESCE(NEW.local_calculation_method, 'static') <> 'wa_dor_address' AND (
    NEW.billing_address_ciphertext IS NOT NULL OR NEW.billing_address_iv IS NOT NULL OR
    NEW.billing_address_key_id IS NOT NULL OR
    NEW.rate_location_code IS NOT NULL OR NEW.rate_jurisdiction IS NOT NULL OR
    NEW.rate_period IS NOT NULL OR NEW.rate_valid_through IS NOT NULL OR
    NEW.state_rate_ppm IS NOT NULL OR NEW.local_rate_ppm IS NOT NULL
  ))
BEGIN SELECT RAISE(ABORT, 'invalid_checkout_address_rate_identity'); END;

CREATE TRIGGER easy_pay_direct_automatic_address_rate_guard
BEFORE INSERT ON easy_pay_direct_automatic_tax_quotes
WHEN
  (NEW.local_calculation_method = 'wa_dor_address' AND (
    NEW.billing_country <> 'US' OR NEW.billing_state <> 'WA' OR
    NEW.rate_location_code IS NULL OR NEW.rate_jurisdiction IS NULL OR
    NEW.rate_period IS NULL OR NEW.rate_valid_through IS NULL OR
    NEW.state_rate_ppm IS NULL OR NEW.local_rate_ppm IS NULL
  )) OR
  (NEW.local_calculation_method <> 'wa_dor_address' AND (
    NEW.rate_location_code IS NOT NULL OR NEW.rate_jurisdiction IS NOT NULL OR
    NEW.rate_period IS NOT NULL OR NEW.rate_valid_through IS NOT NULL OR
    NEW.state_rate_ppm IS NOT NULL OR NEW.local_rate_ppm IS NOT NULL
  ))
BEGIN SELECT RAISE(ABORT, 'invalid_automatic_address_rate_identity'); END;
