-- Lago represents a plan change as a new subscription row with the same external identifier.
-- Rebuild the early single-row table so immutable generations can retain their own plan, period,
-- usage, invoice, and transition history.
PRAGMA defer_foreign_keys = ON;

-- SQLite validates every trigger body while the table is swapped. Preserve the cross-table draft
-- invalidation triggers explicitly so there is no interval where a plan mutation can leave a
-- plan-change draft stale.
DROP TRIGGER draft_refresh_after_add_on_update;
DROP TRIGGER draft_refresh_after_charge_insert;
DROP TRIGGER draft_refresh_after_charge_update;
DROP TRIGGER draft_refresh_after_commitment_insert;
DROP TRIGGER draft_refresh_after_commitment_update;
DROP TRIGGER draft_refresh_after_fixed_charge_insert;
DROP TRIGGER draft_refresh_after_fixed_charge_update;
DROP TRIGGER draft_refresh_after_metric_update;
DROP TRIGGER draft_refresh_after_plan_update;

CREATE TABLE subscriptions_v2 (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  customer_id TEXT NOT NULL REFERENCES customers(id) ON DELETE RESTRICT,
  plan_id TEXT NOT NULL REFERENCES plans(id) ON DELETE RESTRICT,
  external_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'active', 'past_due', 'canceled', 'terminated')),
  started_at TEXT,
  current_period_start TEXT,
  current_period_end TEXT,
  canceled_at TEXT,
  terminated_at TEXT,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  name TEXT,
  request_sha256 TEXT,
  subscription_at TEXT,
  ending_at TEXT,
  on_termination_credit_note TEXT
    CHECK (on_termination_credit_note IN ('credit', 'skip', 'refund', 'offset')),
  on_termination_invoice TEXT CHECK (on_termination_invoice IN ('generate', 'skip')),
  billing_time TEXT NOT NULL DEFAULT 'anniversary'
    CHECK (billing_time IN ('calendar', 'anniversary')),
  billing_timezone TEXT NOT NULL DEFAULT 'UTC' CHECK (length(billing_timezone) > 0),
  trial_started_at TEXT,
  trial_end_at TEXT,
  trial_ended_at TEXT,
  previous_subscription_id TEXT REFERENCES subscriptions_v2(id) ON DELETE RESTRICT,
  transition_kind TEXT NOT NULL DEFAULT 'initial'
    CHECK (transition_kind IN ('initial', 'upgrade', 'downgrade')),
  transition_at TEXT,
  generation INTEGER NOT NULL DEFAULT 1 CHECK (generation > 0),
  UNIQUE (organization_id, external_id, generation),
  CHECK (
    (transition_kind = 'initial' AND previous_subscription_id IS NULL AND generation = 1) OR
    (transition_kind IN ('upgrade', 'downgrade') AND previous_subscription_id IS NOT NULL
      AND generation > 1)
  )
) STRICT;

INSERT INTO subscriptions_v2
  (id, organization_id, customer_id, plan_id, external_id, status, started_at,
   current_period_start, current_period_end, canceled_at, terminated_at, version, created_at,
   updated_at, name, request_sha256, subscription_at, ending_at, on_termination_credit_note,
   on_termination_invoice, billing_time, billing_timezone, trial_started_at, trial_end_at,
   trial_ended_at, previous_subscription_id, transition_kind, transition_at, generation)
SELECT id, organization_id, customer_id, plan_id, external_id, status, started_at,
       current_period_start, current_period_end, canceled_at, terminated_at, version, created_at,
       updated_at, name, request_sha256, subscription_at, ending_at, on_termination_credit_note,
       on_termination_invoice, billing_time, billing_timezone, trial_started_at, trial_end_at,
       trial_ended_at, NULL, 'initial', started_at, 1
FROM subscriptions;

DROP TABLE subscriptions;
ALTER TABLE subscriptions_v2 RENAME TO subscriptions;

CREATE INDEX subscriptions_external_history_idx
  ON subscriptions(organization_id, external_id, generation DESC);
CREATE UNIQUE INDEX subscriptions_current_external_idx
  ON subscriptions(organization_id, external_id)
  WHERE status IN ('active', 'past_due');
CREATE UNIQUE INDEX subscriptions_initial_pending_external_idx
  ON subscriptions(organization_id, external_id)
  WHERE status = 'pending' AND previous_subscription_id IS NULL;
CREATE UNIQUE INDEX subscriptions_pending_transition_idx
  ON subscriptions(previous_subscription_id)
  WHERE status = 'pending';
CREATE INDEX subscriptions_previous_status_idx
  ON subscriptions(previous_subscription_id, status, generation DESC);
CREATE INDEX subscriptions_customer_status_idx ON subscriptions(customer_id, status);
CREATE INDEX subscriptions_period_end_idx ON subscriptions(status, current_period_end);
CREATE INDEX subscriptions_request_sha256_idx
  ON subscriptions(organization_id, request_sha256)
  WHERE request_sha256 IS NOT NULL;
CREATE INDEX subscriptions_pending_activation_idx
  ON subscriptions(subscription_at, id)
  WHERE status = 'pending' AND subscription_at IS NOT NULL AND previous_subscription_id IS NULL;
CREATE INDEX subscriptions_scheduled_termination_idx
  ON subscriptions(ending_at, id)
  WHERE status IN ('active', 'past_due') AND ending_at IS NOT NULL;
CREATE INDEX subscriptions_trial_end_idx
  ON subscriptions(status, trial_end_at)
  WHERE trial_end_at IS NOT NULL AND trial_ended_at IS NULL;

CREATE TRIGGER subscriptions_trial_boundaries_insert
BEFORE INSERT ON subscriptions
WHEN (NEW.trial_started_at IS NULL) <> (NEW.trial_end_at IS NULL)
  OR (NEW.trial_started_at IS NOT NULL AND NEW.trial_end_at <= NEW.trial_started_at)
  OR (NEW.trial_ended_at IS NOT NULL AND NEW.trial_end_at IS NULL)
  OR (NEW.trial_ended_at IS NOT NULL AND NEW.trial_ended_at IS NOT NEW.trial_end_at)
BEGIN
  SELECT RAISE(ABORT, 'invalid_subscription_trial_boundaries');
END;

CREATE TRIGGER subscriptions_trial_boundaries_update
BEFORE UPDATE OF trial_started_at, trial_end_at, trial_ended_at ON subscriptions
WHEN NOT (
    OLD.status = 'pending' AND NEW.status = 'pending'
    AND OLD.started_at IS NULL AND NEW.started_at IS NULL
    AND NEW.trial_ended_at IS NULL
    AND (
      (NEW.trial_started_at IS NULL AND NEW.trial_end_at IS NULL) OR
      (NEW.trial_started_at IS NOT NULL AND NEW.trial_end_at > NEW.trial_started_at)
    )
  )
  AND (
    NEW.trial_started_at IS NOT OLD.trial_started_at
    OR NEW.trial_end_at IS NOT OLD.trial_end_at
    OR (
      NEW.trial_ended_at IS NOT OLD.trial_ended_at
      AND (OLD.trial_ended_at IS NOT NULL OR NEW.trial_ended_at IS NOT NEW.trial_end_at)
    )
  )
BEGIN
  SELECT RAISE(ABORT, 'invalid_subscription_trial_transition');
END;

CREATE TRIGGER draft_refresh_after_subscription_update
AFTER UPDATE OF name, plan_id, status, terminated_at ON subscriptions
BEGIN
  UPDATE invoices
  SET ready_to_be_refreshed = 1
  WHERE subscription_id = NEW.id AND status = 'draft';
END;

CREATE TRIGGER draft_refresh_after_plan_update
AFTER UPDATE OF name, invoice_display_name, amount_minor, interval, currency ON plans
BEGIN
  UPDATE invoices
  SET ready_to_be_refreshed = 1
  WHERE status = 'draft'
    AND subscription_id IN (SELECT id FROM subscriptions WHERE plan_id = NEW.id);
END;

CREATE TRIGGER draft_refresh_after_metric_update
AFTER UPDATE OF name, aggregation_type, field_name, recurring, properties_json ON billable_metrics
BEGIN
  UPDATE invoices
  SET ready_to_be_refreshed = 1
  WHERE status = 'draft'
    AND subscription_id IN (
      SELECT subscriptions.id
      FROM subscriptions
      JOIN charges ON charges.plan_id = subscriptions.plan_id
      WHERE charges.billable_metric_id = NEW.id AND charges.active = 1
    );
END;

CREATE TRIGGER draft_refresh_after_charge_insert
AFTER INSERT ON charges
BEGIN
  UPDATE invoices
  SET ready_to_be_refreshed = 1
  WHERE status = 'draft'
    AND subscription_id IN (SELECT id FROM subscriptions WHERE plan_id = NEW.plan_id);
END;

CREATE TRIGGER draft_refresh_after_charge_update
AFTER UPDATE ON charges
BEGIN
  UPDATE invoices
  SET ready_to_be_refreshed = 1
  WHERE status = 'draft'
    AND subscription_id IN (
      SELECT id FROM subscriptions WHERE plan_id IN (OLD.plan_id, NEW.plan_id)
    );
END;

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

CREATE TRIGGER draft_refresh_after_commitment_insert
AFTER INSERT ON minimum_commitments
BEGIN
  UPDATE invoices
  SET ready_to_be_refreshed = 1
  WHERE status = 'draft'
    AND subscription_id IN (SELECT id FROM subscriptions WHERE plan_id = NEW.plan_id);
END;

CREATE TRIGGER draft_refresh_after_commitment_update
AFTER UPDATE ON minimum_commitments
BEGIN
  UPDATE invoices
  SET ready_to_be_refreshed = 1
  WHERE status = 'draft'
    AND subscription_id IN (
      SELECT id FROM subscriptions WHERE plan_id IN (OLD.plan_id, NEW.plan_id)
    );
END;

CREATE TABLE invoice_subscriptions (
  invoice_id TEXT NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
  subscription_id TEXT NOT NULL REFERENCES subscriptions(id) ON DELETE RESTRICT,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  invoicing_reason TEXT NOT NULL
    CHECK (invoicing_reason IN ('subscription_starting', 'subscription_periodic',
      'subscription_terminating', 'upgrading')),
  period_start TEXT,
  period_end TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY (invoice_id, subscription_id)
) STRICT;

INSERT INTO invoice_subscriptions
  (invoice_id, subscription_id, organization_id, invoicing_reason, period_start, period_end,
   created_at)
SELECT i.id, i.subscription_id, i.organization_id,
       CASE
         WHEN sic.context_type = 'initial' THEN 'subscription_starting'
         WHEN sic.context_type = 'termination' THEN 'subscription_terminating'
         ELSE 'subscription_periodic'
       END,
       COALESCE(sic.period_start, bc.period_start),
       COALESCE(sic.period_end, bc.period_end),
       i.created_at
FROM invoices i
LEFT JOIN subscription_invoice_contexts sic ON sic.invoice_id = i.id
LEFT JOIN billing_cycles bc ON bc.invoice_id = i.id
WHERE i.subscription_id IS NOT NULL;

CREATE INDEX invoice_subscriptions_subscription_idx
  ON invoice_subscriptions(subscription_id, created_at DESC);

CREATE TRIGGER draft_refresh_after_generation_subscription_update
AFTER UPDATE OF name, plan_id, status, terminated_at ON subscriptions
BEGIN
  UPDATE invoices SET ready_to_be_refreshed = 1
  WHERE status = 'draft' AND id IN (
    SELECT invoice_id FROM invoice_subscriptions WHERE subscription_id = NEW.id
  );
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

CREATE TRIGGER draft_refresh_after_generation_metric_update
AFTER UPDATE OF name, aggregation_type, field_name, recurring, properties_json ON billable_metrics
BEGIN
  UPDATE invoices SET ready_to_be_refreshed = 1
  WHERE status = 'draft' AND id IN (
    SELECT invoice_subscriptions.invoice_id FROM invoice_subscriptions
    JOIN subscriptions ON subscriptions.id = invoice_subscriptions.subscription_id
    JOIN charges ON charges.plan_id = subscriptions.plan_id
    WHERE charges.billable_metric_id = NEW.id AND charges.active = 1
  );
END;

CREATE TRIGGER draft_refresh_after_generation_charge_insert
AFTER INSERT ON charges
BEGIN
  UPDATE invoices SET ready_to_be_refreshed = 1
  WHERE status = 'draft' AND id IN (
    SELECT invoice_subscriptions.invoice_id FROM invoice_subscriptions
    JOIN subscriptions ON subscriptions.id = invoice_subscriptions.subscription_id
    WHERE subscriptions.plan_id = NEW.plan_id
  );
END;

CREATE TRIGGER draft_refresh_after_generation_charge_update
AFTER UPDATE ON charges
BEGIN
  UPDATE invoices SET ready_to_be_refreshed = 1
  WHERE status = 'draft' AND id IN (
    SELECT invoice_subscriptions.invoice_id FROM invoice_subscriptions
    JOIN subscriptions ON subscriptions.id = invoice_subscriptions.subscription_id
    WHERE subscriptions.plan_id IN (OLD.plan_id, NEW.plan_id)
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

CREATE TRIGGER draft_refresh_after_generation_commitment_insert
AFTER INSERT ON minimum_commitments
BEGIN
  UPDATE invoices SET ready_to_be_refreshed = 1
  WHERE status = 'draft' AND id IN (
    SELECT invoice_subscriptions.invoice_id FROM invoice_subscriptions
    JOIN subscriptions ON subscriptions.id = invoice_subscriptions.subscription_id
    WHERE subscriptions.plan_id = NEW.plan_id
  );
END;

CREATE TRIGGER draft_refresh_after_generation_commitment_update
AFTER UPDATE ON minimum_commitments
BEGIN
  UPDATE invoices SET ready_to_be_refreshed = 1
  WHERE status = 'draft' AND id IN (
    SELECT invoice_subscriptions.invoice_id FROM invoice_subscriptions
    JOIN subscriptions ON subscriptions.id = invoice_subscriptions.subscription_id
    WHERE subscriptions.plan_id IN (OLD.plan_id, NEW.plan_id)
  );
END;

CREATE TABLE plan_change_invoice_contexts (
  invoice_id TEXT PRIMARY KEY REFERENCES invoices(id) ON DELETE RESTRICT,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  previous_subscription_id TEXT NOT NULL REFERENCES subscriptions(id) ON DELETE RESTRICT,
  next_subscription_id TEXT NOT NULL REFERENCES subscriptions(id) ON DELETE RESTRICT,
  transition_kind TEXT NOT NULL CHECK (transition_kind IN ('upgrade', 'downgrade')),
  transitioned_at TEXT NOT NULL,
  previous_period_start TEXT NOT NULL,
  previous_period_end TEXT NOT NULL,
  next_period_start TEXT NOT NULL,
  next_period_end TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (previous_subscription_id, next_subscription_id)
) STRICT;

CREATE INDEX plan_change_context_next_idx
  ON plan_change_invoice_contexts(next_subscription_id, created_at DESC);

CREATE TRIGGER plan_change_context_requires_transition
BEFORE INSERT ON plan_change_invoice_contexts
WHEN NOT EXISTS (
    SELECT 1 FROM subscriptions previous
    JOIN subscriptions next ON next.id = NEW.next_subscription_id
    WHERE previous.id = NEW.previous_subscription_id
      AND previous.organization_id = NEW.organization_id
      AND next.organization_id = NEW.organization_id
      AND previous.status = 'terminated'
      AND next.status IN ('active', 'past_due')
      AND next.previous_subscription_id = previous.id
  )
BEGIN
  SELECT RAISE(ABORT, 'plan_change_transition_incomplete');
END;

ALTER TABLE usage_events ADD COLUMN external_subscription_id TEXT;

UPDATE usage_events
SET external_subscription_id = (
  SELECT subscriptions.external_id FROM subscriptions
  WHERE subscriptions.id = usage_events.subscription_id
);

CREATE UNIQUE INDEX usage_events_external_transaction_idx
  ON usage_events(organization_id, external_subscription_id, transaction_id)
  WHERE external_subscription_id IS NOT NULL;

PRAGMA defer_foreign_keys = OFF;
