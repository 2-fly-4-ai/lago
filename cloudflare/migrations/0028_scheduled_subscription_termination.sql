ALTER TABLE subscriptions ADD COLUMN ending_at TEXT;

CREATE INDEX subscriptions_scheduled_termination_idx
  ON subscriptions(ending_at, id)
  WHERE status IN ('active', 'past_due') AND ending_at IS NOT NULL;
