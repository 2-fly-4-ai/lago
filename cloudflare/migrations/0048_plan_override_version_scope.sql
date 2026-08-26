-- Subscription override plans share the public catalog code with their root plan, but their
-- optimistic versions belong to independent resources. Scope code/version uniqueness to roots so
-- a child version cannot block the next root mutation.
PRAGMA defer_foreign_keys = ON;

-- SQLite validates trigger bodies while the referenced table is swapped.
DROP TRIGGER IF EXISTS draft_refresh_after_plan_update;
DROP TRIGGER IF EXISTS draft_refresh_after_generation_plan_update;
DROP TRIGGER IF EXISTS subscriptions_reject_non_subscribable_plan_insert;
DROP TRIGGER IF EXISTS subscriptions_reject_non_subscribable_plan_update;
DROP TRIGGER IF EXISTS plans_reject_catalog_update_while_deleting;
DROP TRIGGER IF EXISTS charges_reject_insert_while_plan_deleting;
DROP TRIGGER IF EXISTS charges_reject_update_while_plan_deleting;
DROP TRIGGER IF EXISTS fixed_charges_reject_insert_while_plan_deleting;
DROP TRIGGER IF EXISTS fixed_charges_reject_update_while_plan_deleting;
DROP TRIGGER IF EXISTS minimum_commitments_reject_insert_while_deleting;
DROP TRIGGER IF EXISTS minimum_commitments_reject_update_while_deleting;
DROP TRIGGER IF EXISTS minimum_commitments_reject_insert_while_plan_deleting;
DROP TRIGGER IF EXISTS minimum_commitments_reject_update_while_plan_deleting;

CREATE TABLE plans_v2 (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  interval TEXT NOT NULL CHECK (interval IN ('weekly', 'monthly', 'quarterly', 'yearly', 'one_time')),
  amount_minor INTEGER NOT NULL CHECK (amount_minor >= 0),
  currency TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  invoice_display_name TEXT,
  description TEXT,
  trial_period REAL,
  pay_in_advance INTEGER NOT NULL DEFAULT 0 CHECK (pay_in_advance IN (0, 1)),
  bill_charges_monthly INTEGER CHECK (bill_charges_monthly IN (0, 1)),
  bill_fixed_charges_monthly INTEGER CHECK (bill_fixed_charges_monthly IN (0, 1)),
  metadata_json TEXT NOT NULL DEFAULT '{}',
  request_sha256 TEXT,
  pending_deletion INTEGER NOT NULL DEFAULT 0 CHECK (pending_deletion IN (0, 1)),
  parent_id TEXT REFERENCES plans_v2(id) ON DELETE RESTRICT
) STRICT;

INSERT INTO plans_v2
  (id, organization_id, code, name, interval, amount_minor, currency, version, active,
   created_at, updated_at, invoice_display_name, description, trial_period, pay_in_advance,
   bill_charges_monthly, bill_fixed_charges_monthly, metadata_json, request_sha256,
   pending_deletion, parent_id)
SELECT id, organization_id, code, name, interval, amount_minor, currency, version, active,
       created_at, updated_at, invoice_display_name, description, trial_period, pay_in_advance,
       bill_charges_monthly, bill_fixed_charges_monthly, metadata_json, request_sha256,
       pending_deletion, parent_id
FROM plans;

DROP TABLE plans;
ALTER TABLE plans_v2 RENAME TO plans;

CREATE UNIQUE INDEX plans_root_code_version_idx
  ON plans(organization_id, code, version)
  WHERE parent_id IS NULL;
CREATE INDEX plans_active_code_idx ON plans(organization_id, code, active);
CREATE INDEX plans_request_sha256_idx
  ON plans(organization_id, request_sha256)
  WHERE request_sha256 IS NOT NULL;
CREATE INDEX plans_parent_idx ON plans(parent_id) WHERE parent_id IS NOT NULL;

CREATE TRIGGER draft_refresh_after_plan_update
AFTER UPDATE OF name, invoice_display_name, amount_minor, interval, currency ON plans
BEGIN
  UPDATE invoices
  SET ready_to_be_refreshed = 1
  WHERE status = 'draft'
    AND subscription_id IN (SELECT id FROM subscriptions WHERE plan_id = NEW.id);
END;

CREATE TRIGGER draft_refresh_after_generation_plan_update
AFTER UPDATE OF name, invoice_display_name, amount_minor, interval, currency ON plans
BEGIN
  UPDATE invoices SET ready_to_be_refreshed = 1
  WHERE status = 'draft' AND id IN (
    SELECT invoice_subscriptions.invoice_id FROM invoice_subscriptions
    JOIN subscriptions ON subscriptions.id = invoice_subscriptions.subscription_id
    WHERE subscriptions.plan_id = NEW.id
  );
END;

CREATE TRIGGER subscriptions_reject_non_subscribable_plan_insert
BEFORE INSERT ON subscriptions
WHEN NOT EXISTS (
  SELECT 1 FROM plans
  WHERE id = NEW.plan_id AND organization_id = NEW.organization_id
    AND active = 1 AND pending_deletion = 0
)
BEGIN
  SELECT RAISE(ABORT, 'plan_not_subscribable');
END;

CREATE TRIGGER subscriptions_reject_non_subscribable_plan_update
BEFORE UPDATE OF plan_id ON subscriptions
WHEN NEW.plan_id IS NOT OLD.plan_id
  AND NOT EXISTS (
    SELECT 1 FROM plans
    WHERE id = NEW.plan_id AND organization_id = NEW.organization_id
      AND active = 1 AND pending_deletion = 0
  )
BEGIN
  SELECT RAISE(ABORT, 'plan_not_subscribable');
END;

CREATE TRIGGER plans_reject_catalog_update_while_deleting
BEFORE UPDATE OF code, name, invoice_display_name, description, interval, amount_minor, currency,
                 trial_period, pay_in_advance, bill_charges_monthly,
                 bill_fixed_charges_monthly, metadata_json
ON plans
WHEN OLD.pending_deletion = 1
BEGIN
  SELECT RAISE(ABORT, 'plan_deletion_in_progress');
END;

CREATE TRIGGER charges_reject_insert_while_plan_deleting
BEFORE INSERT ON charges
WHEN EXISTS (SELECT 1 FROM plans WHERE id = NEW.plan_id AND pending_deletion = 1)
BEGIN
  SELECT RAISE(ABORT, 'plan_deletion_in_progress');
END;

CREATE TRIGGER charges_reject_update_while_plan_deleting
BEFORE UPDATE ON charges
WHEN EXISTS (SELECT 1 FROM plans WHERE id = OLD.plan_id AND pending_deletion = 1)
  AND NOT EXISTS (
    SELECT 1 FROM plan_deletion_tasks
    WHERE plan_id = OLD.plan_id AND status = 'retiring'
  )
BEGIN
  SELECT RAISE(ABORT, 'plan_deletion_in_progress');
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

CREATE TRIGGER minimum_commitments_reject_insert_while_plan_deleting
BEFORE INSERT ON minimum_commitments
WHEN EXISTS (SELECT 1 FROM plans WHERE id = NEW.plan_id AND pending_deletion = 1)
BEGIN
  SELECT RAISE(ABORT, 'plan_deletion_in_progress');
END;

CREATE TRIGGER minimum_commitments_reject_update_while_plan_deleting
BEFORE UPDATE ON minimum_commitments
WHEN EXISTS (SELECT 1 FROM plans WHERE id = OLD.plan_id AND pending_deletion = 1)
BEGIN
  SELECT RAISE(ABORT, 'plan_deletion_in_progress');
END;

PRAGMA defer_foreign_keys = OFF;
