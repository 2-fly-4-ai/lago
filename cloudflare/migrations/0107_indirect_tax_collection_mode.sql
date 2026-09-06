-- Separate an explicit collection-off decision from an inactive registration.
-- Defaults preserve existing behavior; no scopes or rates are activated here.
ALTER TABLE indirect_tax_registration_scopes ADD COLUMN collection_mode TEXT NOT NULL
  DEFAULT 'collect' CHECK (collection_mode IN ('collect', 'off'));

ALTER TABLE easy_pay_direct_checkout_tax_quotes ADD COLUMN local_collection_mode TEXT
  CHECK (local_collection_mode IS NULL OR local_collection_mode IN ('collect', 'off'));

ALTER TABLE easy_pay_direct_automatic_tax_quotes ADD COLUMN local_collection_mode TEXT NOT NULL
  DEFAULT 'collect' CHECK (local_collection_mode IN ('collect', 'off'));

CREATE TRIGGER easy_pay_direct_checkout_tax_collection_mode_immutable
BEFORE UPDATE OF local_collection_mode ON easy_pay_direct_checkout_tax_quotes
BEGIN
  SELECT RAISE(ABORT, 'immutable_checkout_tax_collection_mode');
END;
