-- Container-free replacement for Lago's subscription-activity Sidekiq fanout and
-- lifetime-usage refresh jobs. Activities are coalesced by external subscription so a burst of
-- events only needs one projection refresh; the guarded version prevents a refresh from deleting
-- activity that arrived while it was calculating usage.
ALTER TABLE subscriptions ADD COLUMN last_received_event_on TEXT;

CREATE TABLE usage_subscription_activities (
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  external_subscription_id TEXT NOT NULL,
  subscription_id TEXT NOT NULL REFERENCES subscriptions(id) ON DELETE CASCADE,
  latest_event_at TEXT NOT NULL,
  latest_event_on TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  last_error_code TEXT,
  inserted_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (organization_id, external_subscription_id)
) WITHOUT ROWID, STRICT;

CREATE INDEX usage_subscription_activities_oldest_idx
  ON usage_subscription_activities(updated_at, organization_id, external_subscription_id);

CREATE TABLE lifetime_usages (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  subscription_id TEXT NOT NULL REFERENCES subscriptions(id) ON DELETE RESTRICT,
  external_subscription_id TEXT NOT NULL,
  historical_usage_amount_minor INTEGER NOT NULL DEFAULT 0
    CHECK (historical_usage_amount_minor >= 0),
  invoiced_usage_amount_minor INTEGER NOT NULL DEFAULT 0
    CHECK (invoiced_usage_amount_minor >= 0),
  current_usage_amount_minor INTEGER NOT NULL DEFAULT 0
    CHECK (current_usage_amount_minor >= 0),
  current_usage_amount_refreshed_at TEXT,
  invoiced_usage_amount_refreshed_at TEXT,
  recalculate_current_usage INTEGER NOT NULL DEFAULT 0
    CHECK (recalculate_current_usage IN (0, 1)),
  recalculate_invoiced_usage INTEGER NOT NULL DEFAULT 1
    CHECK (recalculate_invoiced_usage IN (0, 1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (organization_id, external_subscription_id),
  UNIQUE (subscription_id)
) STRICT;

CREATE INDEX lifetime_usages_refresh_idx
  ON lifetime_usages(
    recalculate_invoiced_usage DESC,
    current_usage_amount_refreshed_at,
    organization_id,
    external_subscription_id
  );
