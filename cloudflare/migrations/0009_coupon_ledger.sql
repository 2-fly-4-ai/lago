CREATE TABLE coupons (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  coupon_type TEXT NOT NULL CHECK (coupon_type IN ('fixed_amount', 'percentage')),
  amount_minor INTEGER CHECK (amount_minor IS NULL OR amount_minor > 0),
  currency TEXT,
  percentage_rate TEXT,
  frequency TEXT NOT NULL CHECK (frequency IN ('once', 'recurring', 'forever')),
  frequency_duration INTEGER CHECK (frequency_duration IS NULL OR frequency_duration > 0),
  expiration TEXT NOT NULL CHECK (expiration IN ('no_expiration', 'time_limit')),
  expiration_at TEXT,
  reusable INTEGER NOT NULL CHECK (reusable IN (0, 1)),
  status TEXT NOT NULL CHECK (status IN ('active', 'terminated')),
  request_sha256 TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  terminated_at TEXT,
  UNIQUE (organization_id, code),
  CHECK (
    (coupon_type = 'fixed_amount' AND amount_minor IS NOT NULL AND currency IS NOT NULL AND percentage_rate IS NULL) OR
    (coupon_type = 'percentage' AND amount_minor IS NULL AND currency IS NULL AND percentage_rate IS NOT NULL)
  ),
  CHECK (
    (frequency = 'recurring' AND frequency_duration IS NOT NULL) OR
    (frequency <> 'recurring' AND frequency_duration IS NULL)
  ),
  CHECK (
    (expiration = 'time_limit' AND expiration_at IS NOT NULL) OR
    (expiration = 'no_expiration' AND expiration_at IS NULL)
  )
) STRICT;

CREATE INDEX coupons_status_idx ON coupons(organization_id, status, created_at);

CREATE TABLE applied_coupons (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  customer_id TEXT NOT NULL REFERENCES customers(id) ON DELETE RESTRICT,
  coupon_id TEXT NOT NULL REFERENCES coupons(id) ON DELETE RESTRICT,
  amount_minor INTEGER CHECK (amount_minor IS NULL OR amount_minor > 0),
  currency TEXT,
  percentage_rate TEXT,
  frequency TEXT NOT NULL CHECK (frequency IN ('once', 'recurring', 'forever')),
  frequency_duration INTEGER CHECK (frequency_duration IS NULL OR frequency_duration > 0),
  frequency_duration_remaining INTEGER CHECK (
    frequency_duration_remaining IS NULL OR frequency_duration_remaining >= 0
  ),
  status TEXT NOT NULL CHECK (status IN ('active', 'terminated')),
  termination_reason TEXT CHECK (termination_reason IN ('consumed', 'manual', 'expired')),
  reuse_slot INTEGER CHECK (reuse_slot IS NULL OR reuse_slot = 0),
  idempotency_key TEXT,
  request_sha256 TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  terminated_at TEXT,
  CHECK (
    (frequency = 'recurring' AND frequency_duration IS NOT NULL AND frequency_duration_remaining IS NOT NULL) OR
    (frequency <> 'recurring' AND frequency_duration IS NULL AND frequency_duration_remaining IS NULL)
  )
) STRICT;

CREATE UNIQUE INDEX applied_coupons_idempotency_idx
  ON applied_coupons(organization_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;
CREATE UNIQUE INDEX applied_coupons_non_reusable_idx
  ON applied_coupons(customer_id, coupon_id, reuse_slot)
  WHERE reuse_slot = 0;
CREATE INDEX applied_coupons_customer_status_idx
  ON applied_coupons(customer_id, status, created_at);
CREATE INDEX applied_coupons_coupon_idx ON applied_coupons(coupon_id, created_at);

CREATE TABLE coupon_credits (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  invoice_id TEXT NOT NULL REFERENCES invoices(id) ON DELETE RESTRICT,
  applied_coupon_id TEXT NOT NULL REFERENCES applied_coupons(id) ON DELETE RESTRICT,
  applied_coupon_version INTEGER NOT NULL CHECK (applied_coupon_version > 0),
  amount_minor INTEGER NOT NULL CHECK (amount_minor >= 0),
  currency TEXT NOT NULL,
  before_taxes INTEGER NOT NULL CHECK (before_taxes IN (0, 1)),
  created_at TEXT NOT NULL,
  UNIQUE (invoice_id, applied_coupon_id)
) STRICT;

CREATE INDEX coupon_credits_applied_coupon_idx
  ON coupon_credits(applied_coupon_id, created_at);

CREATE TRIGGER coupon_credits_require_current_application
BEFORE INSERT ON coupon_credits
WHEN NOT EXISTS (
  SELECT 1 FROM applied_coupons
  WHERE id = NEW.applied_coupon_id
    AND organization_id = NEW.organization_id
    AND status = 'active'
    AND version = NEW.applied_coupon_version
)
BEGIN
  SELECT RAISE(ABORT, 'coupon_version_conflict');
END;
