CREATE TABLE dunning_campaigns (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  bcc_emails_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(bcc_emails_json)),
  days_between_attempts INTEGER NOT NULL CHECK (days_between_attempts > 0),
  max_attempts INTEGER NOT NULL CHECK (max_attempts > 0),
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  request_sha256 TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT
) STRICT;

CREATE UNIQUE INDEX dunning_campaigns_active_code_idx
  ON dunning_campaigns(organization_id, code) WHERE active = 1;
CREATE INDEX dunning_campaigns_org_created_idx
  ON dunning_campaigns(organization_id, created_at DESC, id DESC);

CREATE TABLE dunning_campaign_thresholds (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  dunning_campaign_id TEXT NOT NULL REFERENCES dunning_campaigns(id) ON DELETE RESTRICT,
  amount_minor INTEGER NOT NULL CHECK (amount_minor >= 0),
  currency TEXT NOT NULL CHECK (length(currency) = 3 AND currency = upper(currency)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT
) STRICT;

CREATE UNIQUE INDEX dunning_campaign_thresholds_active_currency_idx
  ON dunning_campaign_thresholds(dunning_campaign_id, currency) WHERE deleted_at IS NULL;
CREATE INDEX dunning_campaign_thresholds_org_currency_idx
  ON dunning_campaign_thresholds(organization_id, currency, amount_minor)
  WHERE deleted_at IS NULL;

ALTER TABLE organizations ADD COLUMN applied_dunning_campaign_id TEXT;

ALTER TABLE customers ADD COLUMN applied_dunning_campaign_id TEXT;
ALTER TABLE customers ADD COLUMN exclude_from_dunning_campaign INTEGER NOT NULL DEFAULT 0
  CHECK (exclude_from_dunning_campaign IN (0, 1));
ALTER TABLE customers ADD COLUMN last_dunning_campaign_attempt INTEGER NOT NULL DEFAULT 0
  CHECK (last_dunning_campaign_attempt >= 0);
ALTER TABLE customers ADD COLUMN last_dunning_campaign_attempt_at TEXT;

CREATE INDEX customers_dunning_candidate_idx
  ON customers(organization_id, exclude_from_dunning_campaign, currency,
               last_dunning_campaign_attempt_at, id);
CREATE INDEX customers_applied_dunning_campaign_idx
  ON customers(applied_dunning_campaign_id, id)
  WHERE applied_dunning_campaign_id IS NOT NULL;

ALTER TABLE payment_requests ADD COLUMN source TEXT NOT NULL DEFAULT 'manual'
  CHECK (source IN ('manual', 'dunning'));
ALTER TABLE payment_requests ADD COLUMN dunning_campaign_id TEXT;
ALTER TABLE payment_requests ADD COLUMN dunning_campaign_threshold_id TEXT;
ALTER TABLE payment_requests ADD COLUMN dunning_attempt INTEGER
  CHECK (dunning_attempt IS NULL OR dunning_attempt > 0);

CREATE UNIQUE INDEX payment_requests_dunning_attempt_idx
  ON payment_requests(customer_id, dunning_campaign_id, dunning_attempt)
  WHERE source = 'dunning';

CREATE TABLE dunning_attempt_guards (
  run_id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  customer_id TEXT NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  dunning_campaign_id TEXT NOT NULL REFERENCES dunning_campaigns(id) ON DELETE CASCADE,
  dunning_campaign_threshold_id TEXT NOT NULL
    REFERENCES dunning_campaign_thresholds(id) ON DELETE CASCADE,
  expected_customer_version INTEGER NOT NULL CHECK (expected_customer_version > 0),
  expected_attempt INTEGER NOT NULL CHECK (expected_attempt >= 0),
  expected_last_attempt_at TEXT,
  created_at TEXT NOT NULL
) STRICT;

CREATE TRIGGER dunning_campaign_thresholds_tenant_guard
BEFORE INSERT ON dunning_campaign_thresholds
WHEN NOT EXISTS (
  SELECT 1 FROM dunning_campaigns campaign
  WHERE campaign.id = NEW.dunning_campaign_id
    AND campaign.organization_id = NEW.organization_id
    AND campaign.active = 1
)
BEGIN
  SELECT RAISE(ABORT, 'invalid_dunning_campaign_threshold');
END;

CREATE TRIGGER dunning_campaign_thresholds_update_tenant_guard
BEFORE UPDATE OF organization_id, dunning_campaign_id ON dunning_campaign_thresholds
WHEN NOT EXISTS (
  SELECT 1 FROM dunning_campaigns campaign
  WHERE campaign.id = NEW.dunning_campaign_id
    AND campaign.organization_id = NEW.organization_id
    AND campaign.active = 1
)
BEGIN
  SELECT RAISE(ABORT, 'invalid_dunning_campaign_threshold');
END;

CREATE TRIGGER organizations_dunning_campaign_guard
BEFORE UPDATE OF applied_dunning_campaign_id ON organizations
WHEN NEW.applied_dunning_campaign_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM dunning_campaigns campaign
  WHERE campaign.id = NEW.applied_dunning_campaign_id
    AND campaign.organization_id = NEW.id
    AND campaign.active = 1
)
BEGIN
  SELECT RAISE(ABORT, 'invalid_organization_dunning_campaign');
END;

CREATE TRIGGER customers_dunning_campaign_insert_guard
BEFORE INSERT ON customers
WHEN NEW.applied_dunning_campaign_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM dunning_campaigns campaign
  WHERE campaign.id = NEW.applied_dunning_campaign_id
    AND campaign.organization_id = NEW.organization_id
    AND campaign.active = 1
)
BEGIN
  SELECT RAISE(ABORT, 'invalid_customer_dunning_campaign');
END;

CREATE TRIGGER customers_dunning_campaign_update_guard
BEFORE UPDATE OF applied_dunning_campaign_id ON customers
WHEN NEW.applied_dunning_campaign_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM dunning_campaigns campaign
  WHERE campaign.id = NEW.applied_dunning_campaign_id
    AND campaign.organization_id = NEW.organization_id
    AND campaign.active = 1
)
BEGIN
  SELECT RAISE(ABORT, 'invalid_customer_dunning_campaign');
END;

CREATE TRIGGER payment_requests_dunning_guard
BEFORE INSERT ON payment_requests
WHEN (
  NEW.source = 'manual' AND (
    NEW.dunning_campaign_id IS NOT NULL OR
    NEW.dunning_campaign_threshold_id IS NOT NULL OR
    NEW.dunning_attempt IS NOT NULL
  )
) OR (
  NEW.source = 'dunning' AND NOT EXISTS (
    SELECT 1
    FROM dunning_campaigns campaign
    JOIN dunning_campaign_thresholds threshold
      ON threshold.dunning_campaign_id = campaign.id
    WHERE campaign.id = NEW.dunning_campaign_id
      AND threshold.id = NEW.dunning_campaign_threshold_id
      AND campaign.organization_id = NEW.organization_id
      AND threshold.organization_id = NEW.organization_id
      AND campaign.active = 1
      AND threshold.deleted_at IS NULL
      AND NEW.dunning_attempt IS NOT NULL
  )
)
BEGIN
  SELECT RAISE(ABORT, 'invalid_dunning_payment_request');
END;

CREATE TRIGGER dunning_attempt_guard_current_state
BEFORE INSERT ON dunning_attempt_guards
WHEN NOT EXISTS (
  SELECT 1
  FROM customers customer
  JOIN organizations organization ON organization.id = customer.organization_id
  JOIN dunning_campaigns campaign ON campaign.id = NEW.dunning_campaign_id
  JOIN dunning_campaign_thresholds threshold
    ON threshold.id = NEW.dunning_campaign_threshold_id
   AND threshold.dunning_campaign_id = campaign.id
  WHERE customer.id = NEW.customer_id
    AND customer.organization_id = NEW.organization_id
    AND campaign.organization_id = NEW.organization_id
    AND threshold.organization_id = NEW.organization_id
    AND campaign.active = 1
    AND threshold.deleted_at IS NULL
    AND customer.exclude_from_dunning_campaign = 0
    AND customer.currency = threshold.currency
    AND COALESCE(customer.applied_dunning_campaign_id,
                 organization.applied_dunning_campaign_id) = campaign.id
    AND customer.version = NEW.expected_customer_version
    AND customer.last_dunning_campaign_attempt = NEW.expected_attempt
    AND (
      customer.last_dunning_campaign_attempt_at = NEW.expected_last_attempt_at OR
      (customer.last_dunning_campaign_attempt_at IS NULL AND
       NEW.expected_last_attempt_at IS NULL)
    )
    AND NEW.expected_attempt < campaign.max_attempts
    AND (
      customer.last_dunning_campaign_attempt_at IS NULL OR
      datetime(customer.last_dunning_campaign_attempt_at,
               printf('+%d days', campaign.days_between_attempts)) <= datetime(NEW.created_at)
    )
    AND threshold.amount_minor <= COALESCE((
      SELECT SUM(invoice.total_due_minor - COALESCE((
        SELECT SUM(payment.amount_minor)
        FROM payment_attempts payment
        WHERE payment.invoice_id = invoice.id AND payment.status = 'succeeded'
      ), 0))
      FROM invoices invoice
      WHERE invoice.customer_id = customer.id
        AND invoice.organization_id = NEW.organization_id
        AND invoice.currency = threshold.currency
        AND invoice.status = 'finalized'
        AND invoice.payment_status <> 'succeeded'
        AND invoice.payment_overdue = 1
    ), 0)
)
BEGIN
  SELECT RAISE(ABORT, 'dunning_attempt_conflict');
END;
