CREATE TABLE plan_deletion_tasks (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  plan_id TEXT NOT NULL UNIQUE REFERENCES plans(id) ON DELETE RESTRICT,
  source_plan_version INTEGER NOT NULL CHECK (source_plan_version > 0),
  correlation_id TEXT NOT NULL,
  effective_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'running', 'retiring', 'completed', 'failed')),
  workflow_sequence INTEGER NOT NULL DEFAULT 1 CHECK (workflow_sequence > 0),
  workflow_instance_id TEXT NOT NULL,
  error_code TEXT,
  last_dispatched_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT
) STRICT;

CREATE INDEX plan_deletion_tasks_dispatch_idx
  ON plan_deletion_tasks(status, updated_at, id);

CREATE TABLE plan_deletion_subscription_tasks (
  plan_deletion_task_id TEXT NOT NULL REFERENCES plan_deletion_tasks(id) ON DELETE RESTRICT,
  subscription_id TEXT NOT NULL REFERENCES subscriptions(id) ON DELETE RESTRICT,
  action TEXT NOT NULL CHECK (action IN ('cancel', 'terminate')),
  source_status TEXT NOT NULL CHECK (source_status IN ('pending', 'active', 'past_due')),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'completed')),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  last_error_code TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT,
  PRIMARY KEY (plan_deletion_task_id, subscription_id)
) STRICT;

CREATE INDEX plan_deletion_subscription_tasks_pending_idx
  ON plan_deletion_subscription_tasks(plan_deletion_task_id, status, created_at, subscription_id);

-- Once deletion preparation commits, the subscription snapshot is closed. These database-level
-- guards make races converge even when another Worker already resolved the same plan generation.
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

-- Catalog inputs used by termination invoices stay immutable while the asynchronous deletion is
-- running. The final retirement touches only lifecycle columns, so it does not trip this guard.
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
