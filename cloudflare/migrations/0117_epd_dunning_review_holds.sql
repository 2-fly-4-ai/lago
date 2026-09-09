-- Review evidence only: no triggers and no authorization to submit payments.
CREATE TABLE epd_dunning_review_holds (
  organization_id TEXT NOT NULL,
  customer_id TEXT NOT NULL,
  dunning_campaign_id TEXT NOT NULL,
  reason TEXT NOT NULL CHECK (reason = 'multiple_eligible_provider_profiles'),
  status TEXT NOT NULL CHECK (status IN ('held', 'resolved')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  resolved_at TEXT,
  PRIMARY KEY (organization_id, customer_id, dunning_campaign_id)
);
CREATE INDEX epd_dunning_review_holds_status_idx
  ON epd_dunning_review_holds(organization_id, status, updated_at);

-- Transaction-local assertion; inserted/deleted within the dunning request batch.
-- A failed assertion aborts the complete batch before any attempt is consumed.
CREATE TABLE epd_dunning_attempt_fences (
  guard_id TEXT PRIMARY KEY,
  eligible INTEGER NOT NULL CONSTRAINT epd_dunning_eligibility_current CHECK (eligible = 1)
);
