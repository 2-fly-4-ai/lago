ALTER TABLE subscriptions ADD COLUMN subscription_at TEXT;

UPDATE subscriptions SET subscription_at = started_at WHERE subscription_at IS NULL;

CREATE INDEX subscriptions_pending_activation_idx
  ON subscriptions(subscription_at, id)
  WHERE status = 'pending' AND subscription_at IS NOT NULL;
