-- Pay-in-advance fixed charges are now owned by the Worker invoice-at-activation, renewal,
-- and effective-unit rebilling paths.
PRAGMA defer_foreign_keys = ON;

-- SQLite validates trigger bodies while the referenced table is swapped.
DROP TRIGGER IF EXISTS draft_refresh_after_fixed_charge_insert;
DROP TRIGGER IF EXISTS draft_refresh_after_fixed_charge_update;
DROP TRIGGER IF EXISTS draft_refresh_after_generation_fixed_charge_insert;
DROP TRIGGER IF EXISTS draft_refresh_after_generation_fixed_charge_update;
DROP TRIGGER IF EXISTS draft_refresh_after_add_on_update;
DROP TRIGGER IF EXISTS draft_refresh_after_generation_add_on_update;
DROP TRIGGER IF EXISTS fixed_charges_reject_insert_while_plan_deleting;
DROP TRIGGER IF EXISTS fixed_charges_reject_update_while_plan_deleting;

CREATE TABLE fixed_charges_v2 (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  plan_id TEXT NOT NULL REFERENCES plans(id) ON DELETE RESTRICT,
  add_on_id TEXT NOT NULL REFERENCES add_ons(id) ON DELETE RESTRICT,
  code TEXT NOT NULL,
  invoice_display_name TEXT,
  charge_model TEXT NOT NULL CHECK (charge_model IN ('standard', 'graduated', 'volume')),
  properties_json TEXT NOT NULL,
  units TEXT NOT NULL,
  pay_in_advance INTEGER NOT NULL DEFAULT 0 CHECK (pay_in_advance IN (0, 1)),
  prorated INTEGER NOT NULL DEFAULT 0 CHECK (prorated IN (0, 1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  parent_id TEXT REFERENCES fixed_charges_v2(id) ON DELETE RESTRICT,
  UNIQUE (plan_id, code)
) STRICT;

INSERT INTO fixed_charges_v2
  (id, organization_id, plan_id, add_on_id, code, invoice_display_name, charge_model,
   properties_json, units, pay_in_advance, prorated, created_at, updated_at, version, active,
   parent_id)
SELECT id, organization_id, plan_id, add_on_id, code, invoice_display_name, charge_model,
       properties_json, units, pay_in_advance, prorated, created_at, updated_at, version, active,
       parent_id
FROM fixed_charges;

DROP TABLE fixed_charges;
ALTER TABLE fixed_charges_v2 RENAME TO fixed_charges;

CREATE INDEX fixed_charges_plan_idx ON fixed_charges(plan_id, created_at);
CREATE INDEX fixed_charges_active_plan_idx
  ON fixed_charges(plan_id, created_at)
  WHERE active = 1;
CREATE INDEX fixed_charges_parent_idx
  ON fixed_charges(parent_id)
  WHERE parent_id IS NOT NULL;

CREATE TRIGGER draft_refresh_after_fixed_charge_insert
AFTER INSERT ON fixed_charges
BEGIN
  UPDATE invoices
  SET ready_to_be_refreshed = 1
  WHERE status = 'draft'
    AND subscription_id IN (SELECT id FROM subscriptions WHERE plan_id = NEW.plan_id);
END;

CREATE TRIGGER draft_refresh_after_fixed_charge_update
AFTER UPDATE ON fixed_charges
BEGIN
  UPDATE invoices
  SET ready_to_be_refreshed = 1
  WHERE status = 'draft'
    AND subscription_id IN (
      SELECT id FROM subscriptions WHERE plan_id IN (OLD.plan_id, NEW.plan_id)
    );
END;

CREATE TRIGGER draft_refresh_after_generation_fixed_charge_insert
AFTER INSERT ON fixed_charges
BEGIN
  UPDATE invoices SET ready_to_be_refreshed = 1
  WHERE status = 'draft' AND id IN (
    SELECT invoice_subscriptions.invoice_id FROM invoice_subscriptions
    JOIN subscriptions ON subscriptions.id = invoice_subscriptions.subscription_id
    WHERE subscriptions.plan_id = NEW.plan_id
  );
END;

CREATE TRIGGER draft_refresh_after_generation_fixed_charge_update
AFTER UPDATE ON fixed_charges
BEGIN
  UPDATE invoices SET ready_to_be_refreshed = 1
  WHERE status = 'draft' AND id IN (
    SELECT invoice_subscriptions.invoice_id FROM invoice_subscriptions
    JOIN subscriptions ON subscriptions.id = invoice_subscriptions.subscription_id
    WHERE subscriptions.plan_id IN (OLD.plan_id, NEW.plan_id)
  );
END;

CREATE TRIGGER draft_refresh_after_add_on_update
AFTER UPDATE OF name, invoice_display_name, amount_minor, currency, status ON add_ons
BEGIN
  UPDATE invoices
  SET ready_to_be_refreshed = 1
  WHERE status = 'draft'
    AND subscription_id IN (
      SELECT subscriptions.id
      FROM subscriptions
      JOIN fixed_charges ON fixed_charges.plan_id = subscriptions.plan_id
      WHERE fixed_charges.add_on_id = NEW.id
    );
END;

CREATE TRIGGER draft_refresh_after_generation_add_on_update
AFTER UPDATE OF name, invoice_display_name, amount_minor, currency, status ON add_ons
BEGIN
  UPDATE invoices SET ready_to_be_refreshed = 1
  WHERE status = 'draft' AND id IN (
    SELECT invoice_subscriptions.invoice_id FROM invoice_subscriptions
    JOIN subscriptions ON subscriptions.id = invoice_subscriptions.subscription_id
    JOIN fixed_charges ON fixed_charges.plan_id = subscriptions.plan_id
    WHERE fixed_charges.add_on_id = NEW.id
  );
END;

CREATE TRIGGER fixed_charges_reject_insert_while_plan_deleting
BEFORE INSERT ON fixed_charges
WHEN EXISTS (SELECT 1 FROM plans WHERE id = NEW.plan_id AND pending_deletion = 1)
BEGIN
  SELECT RAISE(ABORT, 'plan_deletion_in_progress');
END;

CREATE TRIGGER fixed_charges_reject_update_while_plan_deleting
BEFORE UPDATE ON fixed_charges
WHEN EXISTS (SELECT 1 FROM plans WHERE id = OLD.plan_id AND pending_deletion = 1)
  AND NOT EXISTS (
    SELECT 1 FROM plan_deletion_tasks
    WHERE plan_id = OLD.plan_id AND status = 'retiring'
  )
BEGIN
  SELECT RAISE(ABORT, 'plan_deletion_in_progress');
END;

ALTER TABLE fixed_charge_unit_events
  ADD COLUMN bill_immediately INTEGER NOT NULL DEFAULT 0 CHECK (bill_immediately IN (0, 1));
ALTER TABLE fixed_charge_unit_events ADD COLUMN advance_billed_at TEXT;
ALTER TABLE fixed_charge_unit_events ADD COLUMN advance_invoice_id TEXT;

CREATE INDEX fixed_charge_unit_events_advance_pending_idx
  ON fixed_charge_unit_events(effective_at, subscription_id, fixed_charge_id)
  WHERE bill_immediately = 1 AND advance_billed_at IS NULL;

PRAGMA defer_foreign_keys = OFF;
