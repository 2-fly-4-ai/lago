ALTER TABLE organizations ADD COLUMN timezone TEXT NOT NULL DEFAULT 'UTC'
  CHECK (length(timezone) > 0);

ALTER TABLE customers ADD COLUMN timezone TEXT CHECK (timezone IS NULL OR length(timezone) > 0);

-- Existing D1 subscriptions were created by the anniversary-only implementation. Preserve their
-- boundaries during migration; the API writes the legacy Lago default (`calendar`) explicitly.
ALTER TABLE subscriptions ADD COLUMN billing_time TEXT NOT NULL DEFAULT 'anniversary'
  CHECK (billing_time IN ('calendar', 'anniversary'));
ALTER TABLE subscriptions ADD COLUMN billing_timezone TEXT NOT NULL DEFAULT 'UTC'
  CHECK (length(billing_timezone) > 0);
ALTER TABLE subscriptions ADD COLUMN trial_started_at TEXT;
ALTER TABLE subscriptions ADD COLUMN trial_end_at TEXT;
ALTER TABLE subscriptions ADD COLUMN trial_ended_at TEXT;

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
WHEN NEW.trial_started_at IS NOT OLD.trial_started_at
  OR NEW.trial_end_at IS NOT OLD.trial_end_at
  OR (
    NEW.trial_ended_at IS NOT OLD.trial_ended_at
    AND (OLD.trial_ended_at IS NOT NULL OR NEW.trial_ended_at IS NOT NEW.trial_end_at)
  )
BEGIN
  SELECT RAISE(ABORT, 'invalid_subscription_trial_transition');
END;

CREATE TRIGGER draft_refresh_after_customer_timezone_update
AFTER UPDATE OF timezone ON customers
BEGIN
  UPDATE invoices
  SET ready_to_be_refreshed = 1
  WHERE customer_id = NEW.id AND status = 'draft';
END;
