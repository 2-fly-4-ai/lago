ALTER TABLE wallets ADD COLUMN skip_invoice_custom_sections INTEGER NOT NULL DEFAULT 0
  CHECK (skip_invoice_custom_sections IN (0, 1));

ALTER TABLE wallet_transactions ADD COLUMN skip_invoice_custom_sections INTEGER NOT NULL DEFAULT 0
  CHECK (skip_invoice_custom_sections IN (0, 1));

CREATE TABLE wallets_invoice_custom_sections (
  wallet_id TEXT NOT NULL REFERENCES wallets(id) ON DELETE CASCADE,
  invoice_custom_section_id TEXT NOT NULL REFERENCES invoice_custom_sections(id) ON DELETE RESTRICT,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  created_at TEXT NOT NULL,
  PRIMARY KEY (wallet_id, invoice_custom_section_id)
) STRICT;

CREATE INDEX wallets_invoice_custom_sections_section_idx
  ON wallets_invoice_custom_sections(invoice_custom_section_id, wallet_id);

CREATE TRIGGER wallets_invoice_custom_sections_tenant_insert
BEFORE INSERT ON wallets_invoice_custom_sections
WHEN NOT EXISTS (
  SELECT 1 FROM wallets w JOIN invoice_custom_sections cs
    ON cs.id = NEW.invoice_custom_section_id
  WHERE w.id = NEW.wallet_id AND w.organization_id = NEW.organization_id
    AND cs.organization_id = NEW.organization_id AND cs.status = 'active'
)
BEGIN
  SELECT RAISE(ABORT, 'invalid_wallet_invoice_custom_section_tenant');
END;

CREATE TRIGGER wallets_invoice_custom_sections_identity_immutable
BEFORE UPDATE OF wallet_id, invoice_custom_section_id, organization_id
ON wallets_invoice_custom_sections
WHEN OLD.wallet_id <> NEW.wallet_id
  OR OLD.invoice_custom_section_id <> NEW.invoice_custom_section_id
  OR OLD.organization_id <> NEW.organization_id
BEGIN
  SELECT RAISE(ABORT, 'immutable_wallet_invoice_custom_section_identity');
END;

CREATE TABLE wallet_transactions_invoice_custom_sections (
  wallet_transaction_id TEXT NOT NULL REFERENCES wallet_transactions(id) ON DELETE CASCADE,
  invoice_custom_section_id TEXT NOT NULL REFERENCES invoice_custom_sections(id) ON DELETE RESTRICT,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  created_at TEXT NOT NULL,
  PRIMARY KEY (wallet_transaction_id, invoice_custom_section_id)
) STRICT;

CREATE INDEX wallet_transactions_invoice_custom_sections_section_idx
  ON wallet_transactions_invoice_custom_sections(invoice_custom_section_id, wallet_transaction_id);

CREATE TRIGGER wallet_transactions_invoice_custom_sections_tenant_insert
BEFORE INSERT ON wallet_transactions_invoice_custom_sections
WHEN NOT EXISTS (
  SELECT 1 FROM wallet_transactions wt JOIN invoice_custom_sections cs
    ON cs.id = NEW.invoice_custom_section_id
  WHERE wt.id = NEW.wallet_transaction_id AND wt.organization_id = NEW.organization_id
    AND cs.organization_id = NEW.organization_id AND cs.status = 'active'
)
BEGIN
  SELECT RAISE(ABORT, 'invalid_wallet_transaction_invoice_custom_section_tenant');
END;

CREATE TRIGGER wallet_transactions_invoice_custom_sections_identity_immutable
BEFORE UPDATE OF wallet_transaction_id, invoice_custom_section_id, organization_id
ON wallet_transactions_invoice_custom_sections
WHEN OLD.wallet_transaction_id <> NEW.wallet_transaction_id
  OR OLD.invoice_custom_section_id <> NEW.invoice_custom_section_id
  OR OLD.organization_id <> NEW.organization_id
BEGIN
  SELECT RAISE(ABORT, 'immutable_wallet_transaction_invoice_custom_section_identity');
END;
