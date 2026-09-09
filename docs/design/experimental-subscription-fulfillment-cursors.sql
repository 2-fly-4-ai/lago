-- EXPERIMENTAL ONLY. DO NOT put this file in cloudflare/migrations.
-- These triggers increase D1 meta.changes and break existing exact-row-count guards.
-- See experimental-subscription-fulfillment-cursors.md before any further use.
-- No snapshots, publication, Auth calls, or billing policy.
-- A source is (database deployment namespace, organization_id, subscription_id).
-- The external namespace MUST be supplied by trusted deployment configuration before publication;
-- independent staging/production databases may contain identical internal identities.
-- Revisions are monotonic, not contiguous: one ledger batch can bump a source several times.
-- Keep tombstone cursors after subscription deletion. Do not reuse internal subscription IDs.
CREATE TABLE subscription_fulfillment_cursors (
  organization_id TEXT NOT NULL,
  subscription_id TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK (revision > 0),
  retired INTEGER NOT NULL DEFAULT 0 CHECK (retired IN (0, 1)),
  updated_at TEXT NOT NULL,
  PRIMARY KEY (organization_id, subscription_id)
) STRICT;

-- Opaque journal identifiers intentionally have no parent foreign keys: deletion
-- must not be blocked, and historical revisions must not reset when IDs are reused.
-- A future publisher MUST reject retired sources, even if a source ID is reinserted.
CREATE INDEX fulfillment_subscription_plan_idx ON subscriptions(plan_id, organization_id);
CREATE INDEX fulfillment_customer_email_idx ON customers(organization_id, lower(email));

CREATE TRIGGER fulfillment_cursor_retirement_monotonic
BEFORE UPDATE OF retired ON subscription_fulfillment_cursors
WHEN OLD.retired = 1 AND NEW.retired <> 1
BEGIN
  SELECT RAISE(ABORT, 'retired_fulfillment_source');
END;

CREATE TRIGGER fulfillment_cursor_subscription_retired
BEFORE DELETE ON subscriptions
BEGIN
  UPDATE subscription_fulfillment_cursors SET retired = 1, revision = revision + 1,
    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  WHERE organization_id = OLD.organization_id AND subscription_id = OLD.id;
END;

CREATE TRIGGER fulfillment_cursor_subscription_identity_retired
BEFORE UPDATE OF id, organization_id ON subscriptions
WHEN OLD.id IS NOT NEW.id OR OLD.organization_id IS NOT NEW.organization_id
BEGIN
  UPDATE subscription_fulfillment_cursors SET retired = 1, revision = revision + 1,
    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  WHERE organization_id = OLD.organization_id AND subscription_id = OLD.id;
END;

CREATE TRIGGER fulfillment_cursor_organization_retired
BEFORE DELETE ON organizations
BEGIN
  UPDATE subscription_fulfillment_cursors SET retired = 1, revision = revision + 1,
    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  WHERE organization_id = OLD.id;
END;

CREATE TRIGGER fulfillment_cursor_identity_immutable
BEFORE UPDATE OF organization_id, subscription_id ON subscription_fulfillment_cursors
WHEN OLD.organization_id IS NOT NEW.organization_id OR OLD.subscription_id IS NOT NEW.subscription_id
BEGIN
  SELECT RAISE(ABORT, 'immutable_fulfillment_source_identity');
END;

CREATE TRIGGER fulfillment_cursor_revision_monotonic
BEFORE UPDATE OF revision ON subscription_fulfillment_cursors
WHEN NEW.revision <= OLD.revision
BEGIN
  SELECT RAISE(ABORT, 'non_monotonic_fulfillment_revision');
END;

INSERT INTO subscription_fulfillment_cursors
  (organization_id, subscription_id, revision, updated_at)
SELECT organization_id, id, 1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now') FROM subscriptions;

-- BEFORE/AFTER UPDATE mapping covers both sides of identity/link retargets.
-- All cursor changes roll back with the parent statement/batch.

CREATE TRIGGER fulfillment_cursor_subscriptions_insert
AFTER INSERT ON subscriptions
BEGIN
  INSERT INTO subscription_fulfillment_cursors (organization_id, subscription_id, revision, updated_at)
  SELECT source.organization_id, source.subscription_id, 1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  FROM (SELECT NEW.organization_id, NEW.id AS subscription_id) AS source WHERE 1
  ON CONFLICT (organization_id, subscription_id) DO UPDATE SET
    revision = subscription_fulfillment_cursors.revision + 1,
    updated_at = excluded.updated_at;
END;

CREATE TRIGGER fulfillment_cursor_subscriptions_delete
BEFORE DELETE ON subscriptions
BEGIN
  INSERT INTO subscription_fulfillment_cursors (organization_id, subscription_id, revision, updated_at)
  SELECT source.organization_id, source.subscription_id, 1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  FROM (SELECT OLD.organization_id, OLD.id AS subscription_id) AS source WHERE 1
  ON CONFLICT (organization_id, subscription_id) DO UPDATE SET
    revision = subscription_fulfillment_cursors.revision + 1,
    updated_at = excluded.updated_at;
END;

CREATE TRIGGER fulfillment_cursor_subscriptions_update_old
BEFORE UPDATE OF id, organization_id, customer_id, plan_id, external_id, status, started_at, current_period_start, current_period_end, canceled_at, terminated_at, ending_at, subscription_at ON subscriptions
WHEN OLD.id IS NOT NEW.id
  OR OLD.organization_id IS NOT NEW.organization_id
  OR OLD.customer_id IS NOT NEW.customer_id
  OR OLD.plan_id IS NOT NEW.plan_id
  OR OLD.external_id IS NOT NEW.external_id
  OR OLD.status IS NOT NEW.status
  OR OLD.started_at IS NOT NEW.started_at
  OR OLD.current_period_start IS NOT NEW.current_period_start
  OR OLD.current_period_end IS NOT NEW.current_period_end
  OR OLD.canceled_at IS NOT NEW.canceled_at
  OR OLD.terminated_at IS NOT NEW.terminated_at
  OR OLD.ending_at IS NOT NEW.ending_at
  OR OLD.subscription_at IS NOT NEW.subscription_at
BEGIN
  INSERT INTO subscription_fulfillment_cursors (organization_id, subscription_id, revision, updated_at)
  SELECT source.organization_id, source.subscription_id, 1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  FROM (SELECT OLD.organization_id, OLD.id AS subscription_id) AS source WHERE 1
  ON CONFLICT (organization_id, subscription_id) DO UPDATE SET
    revision = subscription_fulfillment_cursors.revision + 1,
    updated_at = excluded.updated_at;
END;

CREATE TRIGGER fulfillment_cursor_subscriptions_update_new
AFTER UPDATE OF id, organization_id, customer_id, plan_id, external_id, status, started_at, current_period_start, current_period_end, canceled_at, terminated_at, ending_at, subscription_at ON subscriptions
WHEN OLD.id IS NOT NEW.id
  OR OLD.organization_id IS NOT NEW.organization_id
  OR OLD.customer_id IS NOT NEW.customer_id
  OR OLD.plan_id IS NOT NEW.plan_id
  OR OLD.external_id IS NOT NEW.external_id
  OR OLD.status IS NOT NEW.status
  OR OLD.started_at IS NOT NEW.started_at
  OR OLD.current_period_start IS NOT NEW.current_period_start
  OR OLD.current_period_end IS NOT NEW.current_period_end
  OR OLD.canceled_at IS NOT NEW.canceled_at
  OR OLD.terminated_at IS NOT NEW.terminated_at
  OR OLD.ending_at IS NOT NEW.ending_at
  OR OLD.subscription_at IS NOT NEW.subscription_at
BEGIN
  INSERT INTO subscription_fulfillment_cursors (organization_id, subscription_id, revision, updated_at)
  SELECT source.organization_id, source.subscription_id, 1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  FROM (SELECT NEW.organization_id, NEW.id AS subscription_id) AS source WHERE 1
  ON CONFLICT (organization_id, subscription_id) DO UPDATE SET
    revision = subscription_fulfillment_cursors.revision + 1,
    updated_at = excluded.updated_at;
END;

CREATE TRIGGER fulfillment_cursor_invoices_insert
AFTER INSERT ON invoices
BEGIN
  INSERT INTO subscription_fulfillment_cursors (organization_id, subscription_id, revision, updated_at)
  SELECT source.organization_id, source.subscription_id, 1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  FROM (SELECT DISTINCT i.organization_id, s.id AS subscription_id
    FROM invoices i JOIN subscriptions s
      ON s.organization_id = i.organization_id AND s.customer_id = i.customer_id
    WHERE (i.id = NEW.id) AND (s.id = i.subscription_id OR EXISTS (
      SELECT 1 FROM invoice_subscriptions link WHERE link.invoice_id = i.id
        AND link.subscription_id = s.id AND link.organization_id = i.organization_id))) AS source WHERE 1
  ON CONFLICT (organization_id, subscription_id) DO UPDATE SET
    revision = subscription_fulfillment_cursors.revision + 1,
    updated_at = excluded.updated_at;
END;

CREATE TRIGGER fulfillment_cursor_invoices_delete
BEFORE DELETE ON invoices
BEGIN
  INSERT INTO subscription_fulfillment_cursors (organization_id, subscription_id, revision, updated_at)
  SELECT source.organization_id, source.subscription_id, 1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  FROM (SELECT DISTINCT i.organization_id, s.id AS subscription_id
    FROM invoices i JOIN subscriptions s
      ON s.organization_id = i.organization_id AND s.customer_id = i.customer_id
    WHERE (i.id = OLD.id) AND (s.id = i.subscription_id OR EXISTS (
      SELECT 1 FROM invoice_subscriptions link WHERE link.invoice_id = i.id
        AND link.subscription_id = s.id AND link.organization_id = i.organization_id))) AS source WHERE 1
  ON CONFLICT (organization_id, subscription_id) DO UPDATE SET
    revision = subscription_fulfillment_cursors.revision + 1,
    updated_at = excluded.updated_at;
END;

CREATE TRIGGER fulfillment_cursor_invoices_update_old
BEFORE UPDATE OF organization_id, customer_id, subscription_id, status, payment_status, currency, total_due_minor ON invoices
WHEN OLD.organization_id IS NOT NEW.organization_id
  OR OLD.customer_id IS NOT NEW.customer_id
  OR OLD.subscription_id IS NOT NEW.subscription_id
  OR OLD.status IS NOT NEW.status
  OR OLD.payment_status IS NOT NEW.payment_status
  OR OLD.currency IS NOT NEW.currency
  OR OLD.total_due_minor IS NOT NEW.total_due_minor
BEGIN
  INSERT INTO subscription_fulfillment_cursors (organization_id, subscription_id, revision, updated_at)
  SELECT source.organization_id, source.subscription_id, 1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  FROM (SELECT DISTINCT i.organization_id, s.id AS subscription_id
    FROM invoices i JOIN subscriptions s
      ON s.organization_id = i.organization_id AND s.customer_id = i.customer_id
    WHERE (i.id = OLD.id) AND (s.id = i.subscription_id OR EXISTS (
      SELECT 1 FROM invoice_subscriptions link WHERE link.invoice_id = i.id
        AND link.subscription_id = s.id AND link.organization_id = i.organization_id))) AS source WHERE 1
  ON CONFLICT (organization_id, subscription_id) DO UPDATE SET
    revision = subscription_fulfillment_cursors.revision + 1,
    updated_at = excluded.updated_at;
END;

CREATE TRIGGER fulfillment_cursor_invoices_update_new
AFTER UPDATE OF organization_id, customer_id, subscription_id, status, payment_status, currency, total_due_minor ON invoices
WHEN OLD.organization_id IS NOT NEW.organization_id
  OR OLD.customer_id IS NOT NEW.customer_id
  OR OLD.subscription_id IS NOT NEW.subscription_id
  OR OLD.status IS NOT NEW.status
  OR OLD.payment_status IS NOT NEW.payment_status
  OR OLD.currency IS NOT NEW.currency
  OR OLD.total_due_minor IS NOT NEW.total_due_minor
BEGIN
  INSERT INTO subscription_fulfillment_cursors (organization_id, subscription_id, revision, updated_at)
  SELECT source.organization_id, source.subscription_id, 1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  FROM (SELECT DISTINCT i.organization_id, s.id AS subscription_id
    FROM invoices i JOIN subscriptions s
      ON s.organization_id = i.organization_id AND s.customer_id = i.customer_id
    WHERE (i.id = NEW.id) AND (s.id = i.subscription_id OR EXISTS (
      SELECT 1 FROM invoice_subscriptions link WHERE link.invoice_id = i.id
        AND link.subscription_id = s.id AND link.organization_id = i.organization_id))) AS source WHERE 1
  ON CONFLICT (organization_id, subscription_id) DO UPDATE SET
    revision = subscription_fulfillment_cursors.revision + 1,
    updated_at = excluded.updated_at;
END;

CREATE TRIGGER fulfillment_cursor_invoice_subscriptions_insert
AFTER INSERT ON invoice_subscriptions
BEGIN
  INSERT INTO subscription_fulfillment_cursors (organization_id, subscription_id, revision, updated_at)
  SELECT source.organization_id, source.subscription_id, 1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  FROM (SELECT DISTINCT i.organization_id, s.id AS subscription_id
    FROM invoices i JOIN subscriptions s
      ON s.organization_id = i.organization_id AND s.customer_id = i.customer_id
    WHERE (i.id = NEW.invoice_id) AND (s.id = i.subscription_id OR EXISTS (
      SELECT 1 FROM invoice_subscriptions link WHERE link.invoice_id = i.id
        AND link.subscription_id = s.id AND link.organization_id = i.organization_id))) AS source WHERE 1
  ON CONFLICT (organization_id, subscription_id) DO UPDATE SET
    revision = subscription_fulfillment_cursors.revision + 1,
    updated_at = excluded.updated_at;
END;

CREATE TRIGGER fulfillment_cursor_invoice_subscriptions_delete
BEFORE DELETE ON invoice_subscriptions
BEGIN
  INSERT INTO subscription_fulfillment_cursors (organization_id, subscription_id, revision, updated_at)
  SELECT source.organization_id, source.subscription_id, 1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  FROM (SELECT DISTINCT i.organization_id, s.id AS subscription_id
    FROM invoices i JOIN subscriptions s
      ON s.organization_id = i.organization_id AND s.customer_id = i.customer_id
    WHERE (i.id = OLD.invoice_id) AND (s.id = i.subscription_id OR EXISTS (
      SELECT 1 FROM invoice_subscriptions link WHERE link.invoice_id = i.id
        AND link.subscription_id = s.id AND link.organization_id = i.organization_id))) AS source WHERE 1
  ON CONFLICT (organization_id, subscription_id) DO UPDATE SET
    revision = subscription_fulfillment_cursors.revision + 1,
    updated_at = excluded.updated_at;
END;

CREATE TRIGGER fulfillment_cursor_invoice_subscriptions_update_old
BEFORE UPDATE OF invoice_id, subscription_id, organization_id, period_start, period_end ON invoice_subscriptions
WHEN OLD.invoice_id IS NOT NEW.invoice_id
  OR OLD.subscription_id IS NOT NEW.subscription_id
  OR OLD.organization_id IS NOT NEW.organization_id
  OR OLD.period_start IS NOT NEW.period_start
  OR OLD.period_end IS NOT NEW.period_end
BEGIN
  INSERT INTO subscription_fulfillment_cursors (organization_id, subscription_id, revision, updated_at)
  SELECT source.organization_id, source.subscription_id, 1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  FROM (SELECT DISTINCT i.organization_id, s.id AS subscription_id
    FROM invoices i JOIN subscriptions s
      ON s.organization_id = i.organization_id AND s.customer_id = i.customer_id
    WHERE (i.id = OLD.invoice_id) AND (s.id = i.subscription_id OR EXISTS (
      SELECT 1 FROM invoice_subscriptions link WHERE link.invoice_id = i.id
        AND link.subscription_id = s.id AND link.organization_id = i.organization_id))) AS source WHERE 1
  ON CONFLICT (organization_id, subscription_id) DO UPDATE SET
    revision = subscription_fulfillment_cursors.revision + 1,
    updated_at = excluded.updated_at;
END;

CREATE TRIGGER fulfillment_cursor_invoice_subscriptions_update_new
AFTER UPDATE OF invoice_id, subscription_id, organization_id, period_start, period_end ON invoice_subscriptions
WHEN OLD.invoice_id IS NOT NEW.invoice_id
  OR OLD.subscription_id IS NOT NEW.subscription_id
  OR OLD.organization_id IS NOT NEW.organization_id
  OR OLD.period_start IS NOT NEW.period_start
  OR OLD.period_end IS NOT NEW.period_end
BEGIN
  INSERT INTO subscription_fulfillment_cursors (organization_id, subscription_id, revision, updated_at)
  SELECT source.organization_id, source.subscription_id, 1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  FROM (SELECT DISTINCT i.organization_id, s.id AS subscription_id
    FROM invoices i JOIN subscriptions s
      ON s.organization_id = i.organization_id AND s.customer_id = i.customer_id
    WHERE (i.id = NEW.invoice_id) AND (s.id = i.subscription_id OR EXISTS (
      SELECT 1 FROM invoice_subscriptions link WHERE link.invoice_id = i.id
        AND link.subscription_id = s.id AND link.organization_id = i.organization_id))) AS source WHERE 1
  ON CONFLICT (organization_id, subscription_id) DO UPDATE SET
    revision = subscription_fulfillment_cursors.revision + 1,
    updated_at = excluded.updated_at;
END;

CREATE TRIGGER fulfillment_cursor_invoice_lines_insert
AFTER INSERT ON invoice_lines
BEGIN
  INSERT INTO subscription_fulfillment_cursors (organization_id, subscription_id, revision, updated_at)
  SELECT source.organization_id, source.subscription_id, 1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  FROM (SELECT DISTINCT i.organization_id, s.id AS subscription_id
    FROM invoices i JOIN subscriptions s
      ON s.organization_id = i.organization_id AND s.customer_id = i.customer_id
    WHERE (i.id = NEW.invoice_id) AND (s.id = i.subscription_id OR EXISTS (
      SELECT 1 FROM invoice_subscriptions link WHERE link.invoice_id = i.id
        AND link.subscription_id = s.id AND link.organization_id = i.organization_id))) AS source WHERE 1
  ON CONFLICT (organization_id, subscription_id) DO UPDATE SET
    revision = subscription_fulfillment_cursors.revision + 1,
    updated_at = excluded.updated_at;
END;

CREATE TRIGGER fulfillment_cursor_invoice_lines_delete
BEFORE DELETE ON invoice_lines
BEGIN
  INSERT INTO subscription_fulfillment_cursors (organization_id, subscription_id, revision, updated_at)
  SELECT source.organization_id, source.subscription_id, 1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  FROM (SELECT DISTINCT i.organization_id, s.id AS subscription_id
    FROM invoices i JOIN subscriptions s
      ON s.organization_id = i.organization_id AND s.customer_id = i.customer_id
    WHERE (i.id = OLD.invoice_id) AND (s.id = i.subscription_id OR EXISTS (
      SELECT 1 FROM invoice_subscriptions link WHERE link.invoice_id = i.id
        AND link.subscription_id = s.id AND link.organization_id = i.organization_id))) AS source WHERE 1
  ON CONFLICT (organization_id, subscription_id) DO UPDATE SET
    revision = subscription_fulfillment_cursors.revision + 1,
    updated_at = excluded.updated_at;
END;

CREATE TRIGGER fulfillment_cursor_invoice_lines_update_old
BEFORE UPDATE OF invoice_id, line_type, source_type, source_id, metadata_json, amount_minor ON invoice_lines
WHEN OLD.invoice_id IS NOT NEW.invoice_id
  OR OLD.line_type IS NOT NEW.line_type
  OR OLD.source_type IS NOT NEW.source_type
  OR OLD.source_id IS NOT NEW.source_id
  OR OLD.metadata_json IS NOT NEW.metadata_json
  OR OLD.amount_minor IS NOT NEW.amount_minor
BEGIN
  INSERT INTO subscription_fulfillment_cursors (organization_id, subscription_id, revision, updated_at)
  SELECT source.organization_id, source.subscription_id, 1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  FROM (SELECT DISTINCT i.organization_id, s.id AS subscription_id
    FROM invoices i JOIN subscriptions s
      ON s.organization_id = i.organization_id AND s.customer_id = i.customer_id
    WHERE (i.id = OLD.invoice_id) AND (s.id = i.subscription_id OR EXISTS (
      SELECT 1 FROM invoice_subscriptions link WHERE link.invoice_id = i.id
        AND link.subscription_id = s.id AND link.organization_id = i.organization_id))) AS source WHERE 1
  ON CONFLICT (organization_id, subscription_id) DO UPDATE SET
    revision = subscription_fulfillment_cursors.revision + 1,
    updated_at = excluded.updated_at;
END;

CREATE TRIGGER fulfillment_cursor_invoice_lines_update_new
AFTER UPDATE OF invoice_id, line_type, source_type, source_id, metadata_json, amount_minor ON invoice_lines
WHEN OLD.invoice_id IS NOT NEW.invoice_id
  OR OLD.line_type IS NOT NEW.line_type
  OR OLD.source_type IS NOT NEW.source_type
  OR OLD.source_id IS NOT NEW.source_id
  OR OLD.metadata_json IS NOT NEW.metadata_json
  OR OLD.amount_minor IS NOT NEW.amount_minor
BEGIN
  INSERT INTO subscription_fulfillment_cursors (organization_id, subscription_id, revision, updated_at)
  SELECT source.organization_id, source.subscription_id, 1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  FROM (SELECT DISTINCT i.organization_id, s.id AS subscription_id
    FROM invoices i JOIN subscriptions s
      ON s.organization_id = i.organization_id AND s.customer_id = i.customer_id
    WHERE (i.id = NEW.invoice_id) AND (s.id = i.subscription_id OR EXISTS (
      SELECT 1 FROM invoice_subscriptions link WHERE link.invoice_id = i.id
        AND link.subscription_id = s.id AND link.organization_id = i.organization_id))) AS source WHERE 1
  ON CONFLICT (organization_id, subscription_id) DO UPDATE SET
    revision = subscription_fulfillment_cursors.revision + 1,
    updated_at = excluded.updated_at;
END;

CREATE TRIGGER fulfillment_cursor_payment_attempts_insert
AFTER INSERT ON payment_attempts
BEGIN
  INSERT INTO subscription_fulfillment_cursors (organization_id, subscription_id, revision, updated_at)
  SELECT source.organization_id, source.subscription_id, 1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  FROM (SELECT DISTINCT i.organization_id, s.id AS subscription_id
    FROM invoices i JOIN subscriptions s
      ON s.organization_id = i.organization_id AND s.customer_id = i.customer_id
    WHERE (i.id = NEW.invoice_id AND i.organization_id = NEW.organization_id) AND (s.id = i.subscription_id OR EXISTS (
      SELECT 1 FROM invoice_subscriptions link WHERE link.invoice_id = i.id
        AND link.subscription_id = s.id AND link.organization_id = i.organization_id))) AS source WHERE 1
  ON CONFLICT (organization_id, subscription_id) DO UPDATE SET
    revision = subscription_fulfillment_cursors.revision + 1,
    updated_at = excluded.updated_at;
END;

CREATE TRIGGER fulfillment_cursor_payment_attempts_delete
BEFORE DELETE ON payment_attempts
BEGIN
  INSERT INTO subscription_fulfillment_cursors (organization_id, subscription_id, revision, updated_at)
  SELECT source.organization_id, source.subscription_id, 1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  FROM (SELECT DISTINCT i.organization_id, s.id AS subscription_id
    FROM invoices i JOIN subscriptions s
      ON s.organization_id = i.organization_id AND s.customer_id = i.customer_id
    WHERE (i.id = OLD.invoice_id AND i.organization_id = OLD.organization_id) AND (s.id = i.subscription_id OR EXISTS (
      SELECT 1 FROM invoice_subscriptions link WHERE link.invoice_id = i.id
        AND link.subscription_id = s.id AND link.organization_id = i.organization_id))) AS source WHERE 1
  ON CONFLICT (organization_id, subscription_id) DO UPDATE SET
    revision = subscription_fulfillment_cursors.revision + 1,
    updated_at = excluded.updated_at;
END;

CREATE TRIGGER fulfillment_cursor_payment_attempts_update_old
BEFORE UPDATE OF organization_id, invoice_id, provider, provider_account_code, provider_transaction_id, amount_minor, currency, status ON payment_attempts
WHEN OLD.organization_id IS NOT NEW.organization_id
  OR OLD.invoice_id IS NOT NEW.invoice_id
  OR OLD.provider IS NOT NEW.provider
  OR OLD.provider_account_code IS NOT NEW.provider_account_code
  OR OLD.provider_transaction_id IS NOT NEW.provider_transaction_id
  OR OLD.amount_minor IS NOT NEW.amount_minor
  OR OLD.currency IS NOT NEW.currency
  OR OLD.status IS NOT NEW.status
BEGIN
  INSERT INTO subscription_fulfillment_cursors (organization_id, subscription_id, revision, updated_at)
  SELECT source.organization_id, source.subscription_id, 1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  FROM (SELECT DISTINCT i.organization_id, s.id AS subscription_id
    FROM invoices i JOIN subscriptions s
      ON s.organization_id = i.organization_id AND s.customer_id = i.customer_id
    WHERE (i.id = OLD.invoice_id AND i.organization_id = OLD.organization_id) AND (s.id = i.subscription_id OR EXISTS (
      SELECT 1 FROM invoice_subscriptions link WHERE link.invoice_id = i.id
        AND link.subscription_id = s.id AND link.organization_id = i.organization_id))) AS source WHERE 1
  ON CONFLICT (organization_id, subscription_id) DO UPDATE SET
    revision = subscription_fulfillment_cursors.revision + 1,
    updated_at = excluded.updated_at;
END;

CREATE TRIGGER fulfillment_cursor_payment_attempts_update_new
AFTER UPDATE OF organization_id, invoice_id, provider, provider_account_code, provider_transaction_id, amount_minor, currency, status ON payment_attempts
WHEN OLD.organization_id IS NOT NEW.organization_id
  OR OLD.invoice_id IS NOT NEW.invoice_id
  OR OLD.provider IS NOT NEW.provider
  OR OLD.provider_account_code IS NOT NEW.provider_account_code
  OR OLD.provider_transaction_id IS NOT NEW.provider_transaction_id
  OR OLD.amount_minor IS NOT NEW.amount_minor
  OR OLD.currency IS NOT NEW.currency
  OR OLD.status IS NOT NEW.status
BEGIN
  INSERT INTO subscription_fulfillment_cursors (organization_id, subscription_id, revision, updated_at)
  SELECT source.organization_id, source.subscription_id, 1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  FROM (SELECT DISTINCT i.organization_id, s.id AS subscription_id
    FROM invoices i JOIN subscriptions s
      ON s.organization_id = i.organization_id AND s.customer_id = i.customer_id
    WHERE (i.id = NEW.invoice_id AND i.organization_id = NEW.organization_id) AND (s.id = i.subscription_id OR EXISTS (
      SELECT 1 FROM invoice_subscriptions link WHERE link.invoice_id = i.id
        AND link.subscription_id = s.id AND link.organization_id = i.organization_id))) AS source WHERE 1
  ON CONFLICT (organization_id, subscription_id) DO UPDATE SET
    revision = subscription_fulfillment_cursors.revision + 1,
    updated_at = excluded.updated_at;
END;

CREATE TRIGGER fulfillment_cursor_payment_request_payments_insert
AFTER INSERT ON payment_request_payments
BEGIN
  INSERT INTO subscription_fulfillment_cursors (organization_id, subscription_id, revision, updated_at)
  SELECT source.organization_id, source.subscription_id, 1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  FROM (SELECT DISTINCT i.organization_id, s.id AS subscription_id
    FROM invoices i JOIN subscriptions s
      ON s.organization_id = i.organization_id AND s.customer_id = i.customer_id
    WHERE (i.organization_id = NEW.organization_id AND i.id IN (
      SELECT link.invoice_id FROM invoices_payment_requests link
      WHERE link.organization_id = NEW.organization_id AND link.payment_request_id = NEW.payment_request_id
      UNION SELECT allocation.invoice_id FROM payment_request_payment_allocations allocation
      WHERE allocation.organization_id = NEW.organization_id
        AND allocation.payment_request_payment_id = NEW.id)) AND (s.id = i.subscription_id OR EXISTS (
      SELECT 1 FROM invoice_subscriptions link WHERE link.invoice_id = i.id
        AND link.subscription_id = s.id AND link.organization_id = i.organization_id))) AS source WHERE 1
  ON CONFLICT (organization_id, subscription_id) DO UPDATE SET
    revision = subscription_fulfillment_cursors.revision + 1,
    updated_at = excluded.updated_at;
END;

CREATE TRIGGER fulfillment_cursor_payment_request_payments_delete
BEFORE DELETE ON payment_request_payments
BEGIN
  INSERT INTO subscription_fulfillment_cursors (organization_id, subscription_id, revision, updated_at)
  SELECT source.organization_id, source.subscription_id, 1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  FROM (SELECT DISTINCT i.organization_id, s.id AS subscription_id
    FROM invoices i JOIN subscriptions s
      ON s.organization_id = i.organization_id AND s.customer_id = i.customer_id
    WHERE (i.organization_id = OLD.organization_id AND i.id IN (
      SELECT link.invoice_id FROM invoices_payment_requests link
      WHERE link.organization_id = OLD.organization_id AND link.payment_request_id = OLD.payment_request_id
      UNION SELECT allocation.invoice_id FROM payment_request_payment_allocations allocation
      WHERE allocation.organization_id = OLD.organization_id
        AND allocation.payment_request_payment_id = OLD.id)) AND (s.id = i.subscription_id OR EXISTS (
      SELECT 1 FROM invoice_subscriptions link WHERE link.invoice_id = i.id
        AND link.subscription_id = s.id AND link.organization_id = i.organization_id))) AS source WHERE 1
  ON CONFLICT (organization_id, subscription_id) DO UPDATE SET
    revision = subscription_fulfillment_cursors.revision + 1,
    updated_at = excluded.updated_at;
END;

CREATE TRIGGER fulfillment_cursor_payment_request_payments_update_old
BEFORE UPDATE OF organization_id, payment_request_id, provider, provider_account_code, provider_transaction_id, amount_minor, currency, status ON payment_request_payments
WHEN OLD.organization_id IS NOT NEW.organization_id
  OR OLD.payment_request_id IS NOT NEW.payment_request_id
  OR OLD.provider IS NOT NEW.provider
  OR OLD.provider_account_code IS NOT NEW.provider_account_code
  OR OLD.provider_transaction_id IS NOT NEW.provider_transaction_id
  OR OLD.amount_minor IS NOT NEW.amount_minor
  OR OLD.currency IS NOT NEW.currency
  OR OLD.status IS NOT NEW.status
BEGIN
  INSERT INTO subscription_fulfillment_cursors (organization_id, subscription_id, revision, updated_at)
  SELECT source.organization_id, source.subscription_id, 1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  FROM (SELECT DISTINCT i.organization_id, s.id AS subscription_id
    FROM invoices i JOIN subscriptions s
      ON s.organization_id = i.organization_id AND s.customer_id = i.customer_id
    WHERE (i.organization_id = OLD.organization_id AND i.id IN (
      SELECT link.invoice_id FROM invoices_payment_requests link
      WHERE link.organization_id = OLD.organization_id AND link.payment_request_id = OLD.payment_request_id
      UNION SELECT allocation.invoice_id FROM payment_request_payment_allocations allocation
      WHERE allocation.organization_id = OLD.organization_id
        AND allocation.payment_request_payment_id = OLD.id)) AND (s.id = i.subscription_id OR EXISTS (
      SELECT 1 FROM invoice_subscriptions link WHERE link.invoice_id = i.id
        AND link.subscription_id = s.id AND link.organization_id = i.organization_id))) AS source WHERE 1
  ON CONFLICT (organization_id, subscription_id) DO UPDATE SET
    revision = subscription_fulfillment_cursors.revision + 1,
    updated_at = excluded.updated_at;
END;

CREATE TRIGGER fulfillment_cursor_payment_request_payments_update_new
AFTER UPDATE OF organization_id, payment_request_id, provider, provider_account_code, provider_transaction_id, amount_minor, currency, status ON payment_request_payments
WHEN OLD.organization_id IS NOT NEW.organization_id
  OR OLD.payment_request_id IS NOT NEW.payment_request_id
  OR OLD.provider IS NOT NEW.provider
  OR OLD.provider_account_code IS NOT NEW.provider_account_code
  OR OLD.provider_transaction_id IS NOT NEW.provider_transaction_id
  OR OLD.amount_minor IS NOT NEW.amount_minor
  OR OLD.currency IS NOT NEW.currency
  OR OLD.status IS NOT NEW.status
BEGIN
  INSERT INTO subscription_fulfillment_cursors (organization_id, subscription_id, revision, updated_at)
  SELECT source.organization_id, source.subscription_id, 1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  FROM (SELECT DISTINCT i.organization_id, s.id AS subscription_id
    FROM invoices i JOIN subscriptions s
      ON s.organization_id = i.organization_id AND s.customer_id = i.customer_id
    WHERE (i.organization_id = NEW.organization_id AND i.id IN (
      SELECT link.invoice_id FROM invoices_payment_requests link
      WHERE link.organization_id = NEW.organization_id AND link.payment_request_id = NEW.payment_request_id
      UNION SELECT allocation.invoice_id FROM payment_request_payment_allocations allocation
      WHERE allocation.organization_id = NEW.organization_id
        AND allocation.payment_request_payment_id = NEW.id)) AND (s.id = i.subscription_id OR EXISTS (
      SELECT 1 FROM invoice_subscriptions link WHERE link.invoice_id = i.id
        AND link.subscription_id = s.id AND link.organization_id = i.organization_id))) AS source WHERE 1
  ON CONFLICT (organization_id, subscription_id) DO UPDATE SET
    revision = subscription_fulfillment_cursors.revision + 1,
    updated_at = excluded.updated_at;
END;

CREATE TRIGGER fulfillment_cursor_payment_request_payment_allocations_insert
AFTER INSERT ON payment_request_payment_allocations
BEGIN
  INSERT INTO subscription_fulfillment_cursors (organization_id, subscription_id, revision, updated_at)
  SELECT source.organization_id, source.subscription_id, 1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  FROM (SELECT DISTINCT i.organization_id, s.id AS subscription_id
    FROM invoices i JOIN subscriptions s
      ON s.organization_id = i.organization_id AND s.customer_id = i.customer_id
    WHERE (i.id = NEW.invoice_id AND i.organization_id = NEW.organization_id) AND (s.id = i.subscription_id OR EXISTS (
      SELECT 1 FROM invoice_subscriptions link WHERE link.invoice_id = i.id
        AND link.subscription_id = s.id AND link.organization_id = i.organization_id))) AS source WHERE 1
  ON CONFLICT (organization_id, subscription_id) DO UPDATE SET
    revision = subscription_fulfillment_cursors.revision + 1,
    updated_at = excluded.updated_at;
END;

CREATE TRIGGER fulfillment_cursor_payment_request_payment_allocations_delete
BEFORE DELETE ON payment_request_payment_allocations
BEGIN
  INSERT INTO subscription_fulfillment_cursors (organization_id, subscription_id, revision, updated_at)
  SELECT source.organization_id, source.subscription_id, 1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  FROM (SELECT DISTINCT i.organization_id, s.id AS subscription_id
    FROM invoices i JOIN subscriptions s
      ON s.organization_id = i.organization_id AND s.customer_id = i.customer_id
    WHERE (i.id = OLD.invoice_id AND i.organization_id = OLD.organization_id) AND (s.id = i.subscription_id OR EXISTS (
      SELECT 1 FROM invoice_subscriptions link WHERE link.invoice_id = i.id
        AND link.subscription_id = s.id AND link.organization_id = i.organization_id))) AS source WHERE 1
  ON CONFLICT (organization_id, subscription_id) DO UPDATE SET
    revision = subscription_fulfillment_cursors.revision + 1,
    updated_at = excluded.updated_at;
END;

CREATE TRIGGER fulfillment_cursor_payment_request_payment_allocations_update_old
BEFORE UPDATE OF organization_id, payment_request_payment_id, payment_request_id, invoice_id, amount_minor, currency ON payment_request_payment_allocations
WHEN OLD.organization_id IS NOT NEW.organization_id
  OR OLD.payment_request_payment_id IS NOT NEW.payment_request_payment_id
  OR OLD.payment_request_id IS NOT NEW.payment_request_id
  OR OLD.invoice_id IS NOT NEW.invoice_id
  OR OLD.amount_minor IS NOT NEW.amount_minor
  OR OLD.currency IS NOT NEW.currency
BEGIN
  INSERT INTO subscription_fulfillment_cursors (organization_id, subscription_id, revision, updated_at)
  SELECT source.organization_id, source.subscription_id, 1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  FROM (SELECT DISTINCT i.organization_id, s.id AS subscription_id
    FROM invoices i JOIN subscriptions s
      ON s.organization_id = i.organization_id AND s.customer_id = i.customer_id
    WHERE (i.id = OLD.invoice_id AND i.organization_id = OLD.organization_id) AND (s.id = i.subscription_id OR EXISTS (
      SELECT 1 FROM invoice_subscriptions link WHERE link.invoice_id = i.id
        AND link.subscription_id = s.id AND link.organization_id = i.organization_id))) AS source WHERE 1
  ON CONFLICT (organization_id, subscription_id) DO UPDATE SET
    revision = subscription_fulfillment_cursors.revision + 1,
    updated_at = excluded.updated_at;
END;

CREATE TRIGGER fulfillment_cursor_payment_request_payment_allocations_update_new
AFTER UPDATE OF organization_id, payment_request_payment_id, payment_request_id, invoice_id, amount_minor, currency ON payment_request_payment_allocations
WHEN OLD.organization_id IS NOT NEW.organization_id
  OR OLD.payment_request_payment_id IS NOT NEW.payment_request_payment_id
  OR OLD.payment_request_id IS NOT NEW.payment_request_id
  OR OLD.invoice_id IS NOT NEW.invoice_id
  OR OLD.amount_minor IS NOT NEW.amount_minor
  OR OLD.currency IS NOT NEW.currency
BEGIN
  INSERT INTO subscription_fulfillment_cursors (organization_id, subscription_id, revision, updated_at)
  SELECT source.organization_id, source.subscription_id, 1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  FROM (SELECT DISTINCT i.organization_id, s.id AS subscription_id
    FROM invoices i JOIN subscriptions s
      ON s.organization_id = i.organization_id AND s.customer_id = i.customer_id
    WHERE (i.id = NEW.invoice_id AND i.organization_id = NEW.organization_id) AND (s.id = i.subscription_id OR EXISTS (
      SELECT 1 FROM invoice_subscriptions link WHERE link.invoice_id = i.id
        AND link.subscription_id = s.id AND link.organization_id = i.organization_id))) AS source WHERE 1
  ON CONFLICT (organization_id, subscription_id) DO UPDATE SET
    revision = subscription_fulfillment_cursors.revision + 1,
    updated_at = excluded.updated_at;
END;

CREATE TRIGGER fulfillment_cursor_provider_refund_operations_insert
AFTER INSERT ON provider_refund_operations
BEGIN
  INSERT INTO subscription_fulfillment_cursors (organization_id, subscription_id, revision, updated_at)
  SELECT source.organization_id, source.subscription_id, 1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  FROM (SELECT DISTINCT i.organization_id, s.id AS subscription_id
    FROM invoices i JOIN subscriptions s
      ON s.organization_id = i.organization_id AND s.customer_id = i.customer_id
    WHERE (i.id = NEW.invoice_id AND i.organization_id = NEW.organization_id) AND (s.id = i.subscription_id OR EXISTS (
      SELECT 1 FROM invoice_subscriptions link WHERE link.invoice_id = i.id
        AND link.subscription_id = s.id AND link.organization_id = i.organization_id))) AS source WHERE 1
  ON CONFLICT (organization_id, subscription_id) DO UPDATE SET
    revision = subscription_fulfillment_cursors.revision + 1,
    updated_at = excluded.updated_at;
END;

CREATE TRIGGER fulfillment_cursor_provider_refund_operations_delete
BEFORE DELETE ON provider_refund_operations
BEGIN
  INSERT INTO subscription_fulfillment_cursors (organization_id, subscription_id, revision, updated_at)
  SELECT source.organization_id, source.subscription_id, 1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  FROM (SELECT DISTINCT i.organization_id, s.id AS subscription_id
    FROM invoices i JOIN subscriptions s
      ON s.organization_id = i.organization_id AND s.customer_id = i.customer_id
    WHERE (i.id = OLD.invoice_id AND i.organization_id = OLD.organization_id) AND (s.id = i.subscription_id OR EXISTS (
      SELECT 1 FROM invoice_subscriptions link WHERE link.invoice_id = i.id
        AND link.subscription_id = s.id AND link.organization_id = i.organization_id))) AS source WHERE 1
  ON CONFLICT (organization_id, subscription_id) DO UPDATE SET
    revision = subscription_fulfillment_cursors.revision + 1,
    updated_at = excluded.updated_at;
END;

CREATE TRIGGER fulfillment_cursor_provider_refund_operations_update_old
BEFORE UPDATE OF organization_id, invoice_id, credit_note_id, amount_minor, currency, status ON provider_refund_operations
WHEN OLD.organization_id IS NOT NEW.organization_id
  OR OLD.invoice_id IS NOT NEW.invoice_id
  OR OLD.credit_note_id IS NOT NEW.credit_note_id
  OR OLD.amount_minor IS NOT NEW.amount_minor
  OR OLD.currency IS NOT NEW.currency
  OR OLD.status IS NOT NEW.status
BEGIN
  INSERT INTO subscription_fulfillment_cursors (organization_id, subscription_id, revision, updated_at)
  SELECT source.organization_id, source.subscription_id, 1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  FROM (SELECT DISTINCT i.organization_id, s.id AS subscription_id
    FROM invoices i JOIN subscriptions s
      ON s.organization_id = i.organization_id AND s.customer_id = i.customer_id
    WHERE (i.id = OLD.invoice_id AND i.organization_id = OLD.organization_id) AND (s.id = i.subscription_id OR EXISTS (
      SELECT 1 FROM invoice_subscriptions link WHERE link.invoice_id = i.id
        AND link.subscription_id = s.id AND link.organization_id = i.organization_id))) AS source WHERE 1
  ON CONFLICT (organization_id, subscription_id) DO UPDATE SET
    revision = subscription_fulfillment_cursors.revision + 1,
    updated_at = excluded.updated_at;
END;

CREATE TRIGGER fulfillment_cursor_provider_refund_operations_update_new
AFTER UPDATE OF organization_id, invoice_id, credit_note_id, amount_minor, currency, status ON provider_refund_operations
WHEN OLD.organization_id IS NOT NEW.organization_id
  OR OLD.invoice_id IS NOT NEW.invoice_id
  OR OLD.credit_note_id IS NOT NEW.credit_note_id
  OR OLD.amount_minor IS NOT NEW.amount_minor
  OR OLD.currency IS NOT NEW.currency
  OR OLD.status IS NOT NEW.status
BEGIN
  INSERT INTO subscription_fulfillment_cursors (organization_id, subscription_id, revision, updated_at)
  SELECT source.organization_id, source.subscription_id, 1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  FROM (SELECT DISTINCT i.organization_id, s.id AS subscription_id
    FROM invoices i JOIN subscriptions s
      ON s.organization_id = i.organization_id AND s.customer_id = i.customer_id
    WHERE (i.id = NEW.invoice_id AND i.organization_id = NEW.organization_id) AND (s.id = i.subscription_id OR EXISTS (
      SELECT 1 FROM invoice_subscriptions link WHERE link.invoice_id = i.id
        AND link.subscription_id = s.id AND link.organization_id = i.organization_id))) AS source WHERE 1
  ON CONFLICT (organization_id, subscription_id) DO UPDATE SET
    revision = subscription_fulfillment_cursors.revision + 1,
    updated_at = excluded.updated_at;
END;

CREATE TRIGGER fulfillment_cursor_credit_notes_insert
AFTER INSERT ON credit_notes
BEGIN
  INSERT INTO subscription_fulfillment_cursors (organization_id, subscription_id, revision, updated_at)
  SELECT source.organization_id, source.subscription_id, 1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  FROM (SELECT DISTINCT i.organization_id, s.id AS subscription_id
    FROM invoices i JOIN subscriptions s
      ON s.organization_id = i.organization_id AND s.customer_id = i.customer_id
    WHERE (i.id = NEW.invoice_id AND i.organization_id = NEW.organization_id) AND (s.id = i.subscription_id OR EXISTS (
      SELECT 1 FROM invoice_subscriptions link WHERE link.invoice_id = i.id
        AND link.subscription_id = s.id AND link.organization_id = i.organization_id))) AS source WHERE 1
  ON CONFLICT (organization_id, subscription_id) DO UPDATE SET
    revision = subscription_fulfillment_cursors.revision + 1,
    updated_at = excluded.updated_at;
END;

CREATE TRIGGER fulfillment_cursor_credit_notes_delete
BEFORE DELETE ON credit_notes
BEGIN
  INSERT INTO subscription_fulfillment_cursors (organization_id, subscription_id, revision, updated_at)
  SELECT source.organization_id, source.subscription_id, 1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  FROM (SELECT DISTINCT i.organization_id, s.id AS subscription_id
    FROM invoices i JOIN subscriptions s
      ON s.organization_id = i.organization_id AND s.customer_id = i.customer_id
    WHERE (i.id = OLD.invoice_id AND i.organization_id = OLD.organization_id) AND (s.id = i.subscription_id OR EXISTS (
      SELECT 1 FROM invoice_subscriptions link WHERE link.invoice_id = i.id
        AND link.subscription_id = s.id AND link.organization_id = i.organization_id))) AS source WHERE 1
  ON CONFLICT (organization_id, subscription_id) DO UPDATE SET
    revision = subscription_fulfillment_cursors.revision + 1,
    updated_at = excluded.updated_at;
END;

CREATE TRIGGER fulfillment_cursor_credit_notes_update_old
BEFORE UPDATE OF organization_id, customer_id, invoice_id, currency ON credit_notes
WHEN OLD.organization_id IS NOT NEW.organization_id
  OR OLD.customer_id IS NOT NEW.customer_id
  OR OLD.invoice_id IS NOT NEW.invoice_id
  OR OLD.currency IS NOT NEW.currency
BEGIN
  INSERT INTO subscription_fulfillment_cursors (organization_id, subscription_id, revision, updated_at)
  SELECT source.organization_id, source.subscription_id, 1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  FROM (SELECT DISTINCT i.organization_id, s.id AS subscription_id
    FROM invoices i JOIN subscriptions s
      ON s.organization_id = i.organization_id AND s.customer_id = i.customer_id
    WHERE (i.id = OLD.invoice_id AND i.organization_id = OLD.organization_id) AND (s.id = i.subscription_id OR EXISTS (
      SELECT 1 FROM invoice_subscriptions link WHERE link.invoice_id = i.id
        AND link.subscription_id = s.id AND link.organization_id = i.organization_id))) AS source WHERE 1
  ON CONFLICT (organization_id, subscription_id) DO UPDATE SET
    revision = subscription_fulfillment_cursors.revision + 1,
    updated_at = excluded.updated_at;
END;

CREATE TRIGGER fulfillment_cursor_credit_notes_update_new
AFTER UPDATE OF organization_id, customer_id, invoice_id, currency ON credit_notes
WHEN OLD.organization_id IS NOT NEW.organization_id
  OR OLD.customer_id IS NOT NEW.customer_id
  OR OLD.invoice_id IS NOT NEW.invoice_id
  OR OLD.currency IS NOT NEW.currency
BEGIN
  INSERT INTO subscription_fulfillment_cursors (organization_id, subscription_id, revision, updated_at)
  SELECT source.organization_id, source.subscription_id, 1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  FROM (SELECT DISTINCT i.organization_id, s.id AS subscription_id
    FROM invoices i JOIN subscriptions s
      ON s.organization_id = i.organization_id AND s.customer_id = i.customer_id
    WHERE (i.id = NEW.invoice_id AND i.organization_id = NEW.organization_id) AND (s.id = i.subscription_id OR EXISTS (
      SELECT 1 FROM invoice_subscriptions link WHERE link.invoice_id = i.id
        AND link.subscription_id = s.id AND link.organization_id = i.organization_id))) AS source WHERE 1
  ON CONFLICT (organization_id, subscription_id) DO UPDATE SET
    revision = subscription_fulfillment_cursors.revision + 1,
    updated_at = excluded.updated_at;
END;

CREATE TRIGGER fulfillment_cursor_credit_note_financials_insert
AFTER INSERT ON credit_note_financials
BEGIN
  INSERT INTO subscription_fulfillment_cursors (organization_id, subscription_id, revision, updated_at)
  SELECT source.organization_id, source.subscription_id, 1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  FROM (SELECT DISTINCT i.organization_id, s.id AS subscription_id
    FROM invoices i JOIN subscriptions s
      ON s.organization_id = i.organization_id AND s.customer_id = i.customer_id
    WHERE (i.organization_id = NEW.organization_id AND i.id = (
      SELECT note.invoice_id FROM credit_notes note WHERE note.id = NEW.credit_note_id
        AND note.organization_id = NEW.organization_id)) AND (s.id = i.subscription_id OR EXISTS (
      SELECT 1 FROM invoice_subscriptions link WHERE link.invoice_id = i.id
        AND link.subscription_id = s.id AND link.organization_id = i.organization_id))) AS source WHERE 1
  ON CONFLICT (organization_id, subscription_id) DO UPDATE SET
    revision = subscription_fulfillment_cursors.revision + 1,
    updated_at = excluded.updated_at;
END;

CREATE TRIGGER fulfillment_cursor_credit_note_financials_delete
BEFORE DELETE ON credit_note_financials
BEGIN
  INSERT INTO subscription_fulfillment_cursors (organization_id, subscription_id, revision, updated_at)
  SELECT source.organization_id, source.subscription_id, 1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  FROM (SELECT DISTINCT i.organization_id, s.id AS subscription_id
    FROM invoices i JOIN subscriptions s
      ON s.organization_id = i.organization_id AND s.customer_id = i.customer_id
    WHERE (i.organization_id = OLD.organization_id AND i.id = (
      SELECT note.invoice_id FROM credit_notes note WHERE note.id = OLD.credit_note_id
        AND note.organization_id = OLD.organization_id)) AND (s.id = i.subscription_id OR EXISTS (
      SELECT 1 FROM invoice_subscriptions link WHERE link.invoice_id = i.id
        AND link.subscription_id = s.id AND link.organization_id = i.organization_id))) AS source WHERE 1
  ON CONFLICT (organization_id, subscription_id) DO UPDATE SET
    revision = subscription_fulfillment_cursors.revision + 1,
    updated_at = excluded.updated_at;
END;

CREATE TRIGGER fulfillment_cursor_credit_note_financials_update_old
BEFORE UPDATE OF credit_note_id, organization_id, refund_amount_minor, refund_status ON credit_note_financials
WHEN OLD.credit_note_id IS NOT NEW.credit_note_id
  OR OLD.organization_id IS NOT NEW.organization_id
  OR OLD.refund_amount_minor IS NOT NEW.refund_amount_minor
  OR OLD.refund_status IS NOT NEW.refund_status
BEGIN
  INSERT INTO subscription_fulfillment_cursors (organization_id, subscription_id, revision, updated_at)
  SELECT source.organization_id, source.subscription_id, 1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  FROM (SELECT DISTINCT i.organization_id, s.id AS subscription_id
    FROM invoices i JOIN subscriptions s
      ON s.organization_id = i.organization_id AND s.customer_id = i.customer_id
    WHERE (i.organization_id = OLD.organization_id AND i.id = (
      SELECT note.invoice_id FROM credit_notes note WHERE note.id = OLD.credit_note_id
        AND note.organization_id = OLD.organization_id)) AND (s.id = i.subscription_id OR EXISTS (
      SELECT 1 FROM invoice_subscriptions link WHERE link.invoice_id = i.id
        AND link.subscription_id = s.id AND link.organization_id = i.organization_id))) AS source WHERE 1
  ON CONFLICT (organization_id, subscription_id) DO UPDATE SET
    revision = subscription_fulfillment_cursors.revision + 1,
    updated_at = excluded.updated_at;
END;

CREATE TRIGGER fulfillment_cursor_credit_note_financials_update_new
AFTER UPDATE OF credit_note_id, organization_id, refund_amount_minor, refund_status ON credit_note_financials
WHEN OLD.credit_note_id IS NOT NEW.credit_note_id
  OR OLD.organization_id IS NOT NEW.organization_id
  OR OLD.refund_amount_minor IS NOT NEW.refund_amount_minor
  OR OLD.refund_status IS NOT NEW.refund_status
BEGIN
  INSERT INTO subscription_fulfillment_cursors (organization_id, subscription_id, revision, updated_at)
  SELECT source.organization_id, source.subscription_id, 1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  FROM (SELECT DISTINCT i.organization_id, s.id AS subscription_id
    FROM invoices i JOIN subscriptions s
      ON s.organization_id = i.organization_id AND s.customer_id = i.customer_id
    WHERE (i.organization_id = NEW.organization_id AND i.id = (
      SELECT note.invoice_id FROM credit_notes note WHERE note.id = NEW.credit_note_id
        AND note.organization_id = NEW.organization_id)) AND (s.id = i.subscription_id OR EXISTS (
      SELECT 1 FROM invoice_subscriptions link WHERE link.invoice_id = i.id
        AND link.subscription_id = s.id AND link.organization_id = i.organization_id))) AS source WHERE 1
  ON CONFLICT (organization_id, subscription_id) DO UPDATE SET
    revision = subscription_fulfillment_cursors.revision + 1,
    updated_at = excluded.updated_at;
END;

CREATE TRIGGER fulfillment_cursor_credit_note_refunds_insert
AFTER INSERT ON credit_note_refunds
BEGIN
  INSERT INTO subscription_fulfillment_cursors (organization_id, subscription_id, revision, updated_at)
  SELECT source.organization_id, source.subscription_id, 1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  FROM (SELECT DISTINCT i.organization_id, s.id AS subscription_id
    FROM invoices i JOIN subscriptions s
      ON s.organization_id = i.organization_id AND s.customer_id = i.customer_id
    WHERE (i.id = NEW.invoice_id AND i.organization_id = NEW.organization_id) AND (s.id = i.subscription_id OR EXISTS (
      SELECT 1 FROM invoice_subscriptions link WHERE link.invoice_id = i.id
        AND link.subscription_id = s.id AND link.organization_id = i.organization_id))) AS source WHERE 1
  ON CONFLICT (organization_id, subscription_id) DO UPDATE SET
    revision = subscription_fulfillment_cursors.revision + 1,
    updated_at = excluded.updated_at;
END;

CREATE TRIGGER fulfillment_cursor_credit_note_refunds_delete
BEFORE DELETE ON credit_note_refunds
BEGIN
  INSERT INTO subscription_fulfillment_cursors (organization_id, subscription_id, revision, updated_at)
  SELECT source.organization_id, source.subscription_id, 1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  FROM (SELECT DISTINCT i.organization_id, s.id AS subscription_id
    FROM invoices i JOIN subscriptions s
      ON s.organization_id = i.organization_id AND s.customer_id = i.customer_id
    WHERE (i.id = OLD.invoice_id AND i.organization_id = OLD.organization_id) AND (s.id = i.subscription_id OR EXISTS (
      SELECT 1 FROM invoice_subscriptions link WHERE link.invoice_id = i.id
        AND link.subscription_id = s.id AND link.organization_id = i.organization_id))) AS source WHERE 1
  ON CONFLICT (organization_id, subscription_id) DO UPDATE SET
    revision = subscription_fulfillment_cursors.revision + 1,
    updated_at = excluded.updated_at;
END;

CREATE TRIGGER fulfillment_cursor_credit_note_refunds_update_old
BEFORE UPDATE OF organization_id, credit_note_id, invoice_id, amount_minor, currency, status ON credit_note_refunds
WHEN OLD.organization_id IS NOT NEW.organization_id
  OR OLD.credit_note_id IS NOT NEW.credit_note_id
  OR OLD.invoice_id IS NOT NEW.invoice_id
  OR OLD.amount_minor IS NOT NEW.amount_minor
  OR OLD.currency IS NOT NEW.currency
  OR OLD.status IS NOT NEW.status
BEGIN
  INSERT INTO subscription_fulfillment_cursors (organization_id, subscription_id, revision, updated_at)
  SELECT source.organization_id, source.subscription_id, 1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  FROM (SELECT DISTINCT i.organization_id, s.id AS subscription_id
    FROM invoices i JOIN subscriptions s
      ON s.organization_id = i.organization_id AND s.customer_id = i.customer_id
    WHERE (i.id = OLD.invoice_id AND i.organization_id = OLD.organization_id) AND (s.id = i.subscription_id OR EXISTS (
      SELECT 1 FROM invoice_subscriptions link WHERE link.invoice_id = i.id
        AND link.subscription_id = s.id AND link.organization_id = i.organization_id))) AS source WHERE 1
  ON CONFLICT (organization_id, subscription_id) DO UPDATE SET
    revision = subscription_fulfillment_cursors.revision + 1,
    updated_at = excluded.updated_at;
END;

CREATE TRIGGER fulfillment_cursor_credit_note_refunds_update_new
AFTER UPDATE OF organization_id, credit_note_id, invoice_id, amount_minor, currency, status ON credit_note_refunds
WHEN OLD.organization_id IS NOT NEW.organization_id
  OR OLD.credit_note_id IS NOT NEW.credit_note_id
  OR OLD.invoice_id IS NOT NEW.invoice_id
  OR OLD.amount_minor IS NOT NEW.amount_minor
  OR OLD.currency IS NOT NEW.currency
  OR OLD.status IS NOT NEW.status
BEGIN
  INSERT INTO subscription_fulfillment_cursors (organization_id, subscription_id, revision, updated_at)
  SELECT source.organization_id, source.subscription_id, 1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  FROM (SELECT DISTINCT i.organization_id, s.id AS subscription_id
    FROM invoices i JOIN subscriptions s
      ON s.organization_id = i.organization_id AND s.customer_id = i.customer_id
    WHERE (i.id = NEW.invoice_id AND i.organization_id = NEW.organization_id) AND (s.id = i.subscription_id OR EXISTS (
      SELECT 1 FROM invoice_subscriptions link WHERE link.invoice_id = i.id
        AND link.subscription_id = s.id AND link.organization_id = i.organization_id))) AS source WHERE 1
  ON CONFLICT (organization_id, subscription_id) DO UPDATE SET
    revision = subscription_fulfillment_cursors.revision + 1,
    updated_at = excluded.updated_at;
END;

CREATE TRIGGER fulfillment_cursor_customer_closure_holds_insert
AFTER INSERT ON customer_closure_holds
BEGIN
  INSERT INTO subscription_fulfillment_cursors (organization_id, subscription_id, revision, updated_at)
  SELECT source.organization_id, source.subscription_id, 1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  FROM (SELECT s.organization_id, s.id AS subscription_id FROM subscriptions s
    WHERE s.customer_id = NEW.customer_id AND s.organization_id = NEW.organization_id) AS source WHERE 1
  ON CONFLICT (organization_id, subscription_id) DO UPDATE SET
    revision = subscription_fulfillment_cursors.revision + 1,
    updated_at = excluded.updated_at;
END;

CREATE TRIGGER fulfillment_cursor_customer_closure_holds_delete
BEFORE DELETE ON customer_closure_holds
BEGIN
  INSERT INTO subscription_fulfillment_cursors (organization_id, subscription_id, revision, updated_at)
  SELECT source.organization_id, source.subscription_id, 1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  FROM (SELECT s.organization_id, s.id AS subscription_id FROM subscriptions s
    WHERE s.customer_id = OLD.customer_id AND s.organization_id = OLD.organization_id) AS source WHERE 1
  ON CONFLICT (organization_id, subscription_id) DO UPDATE SET
    revision = subscription_fulfillment_cursors.revision + 1,
    updated_at = excluded.updated_at;
END;

CREATE TRIGGER fulfillment_cursor_customer_closure_holds_update_old
BEFORE UPDATE OF customer_id, organization_id ON customer_closure_holds
WHEN OLD.customer_id IS NOT NEW.customer_id
  OR OLD.organization_id IS NOT NEW.organization_id
BEGIN
  INSERT INTO subscription_fulfillment_cursors (organization_id, subscription_id, revision, updated_at)
  SELECT source.organization_id, source.subscription_id, 1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  FROM (SELECT s.organization_id, s.id AS subscription_id FROM subscriptions s
    WHERE s.customer_id = OLD.customer_id AND s.organization_id = OLD.organization_id) AS source WHERE 1
  ON CONFLICT (organization_id, subscription_id) DO UPDATE SET
    revision = subscription_fulfillment_cursors.revision + 1,
    updated_at = excluded.updated_at;
END;

CREATE TRIGGER fulfillment_cursor_customer_closure_holds_update_new
AFTER UPDATE OF customer_id, organization_id ON customer_closure_holds
WHEN OLD.customer_id IS NOT NEW.customer_id
  OR OLD.organization_id IS NOT NEW.organization_id
BEGIN
  INSERT INTO subscription_fulfillment_cursors (organization_id, subscription_id, revision, updated_at)
  SELECT source.organization_id, source.subscription_id, 1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  FROM (SELECT s.organization_id, s.id AS subscription_id FROM subscriptions s
    WHERE s.customer_id = NEW.customer_id AND s.organization_id = NEW.organization_id) AS source WHERE 1
  ON CONFLICT (organization_id, subscription_id) DO UPDATE SET
    revision = subscription_fulfillment_cursors.revision + 1,
    updated_at = excluded.updated_at;
END;

CREATE TRIGGER fulfillment_cursor_customer_closure_email_holds_insert
AFTER INSERT ON customer_closure_email_holds
BEGIN
  INSERT INTO subscription_fulfillment_cursors (organization_id, subscription_id, revision, updated_at)
  SELECT source.organization_id, source.subscription_id, 1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  FROM (SELECT s.organization_id, s.id AS subscription_id FROM subscriptions s
    JOIN customers c ON c.id = s.customer_id AND c.organization_id = s.organization_id
    WHERE c.organization_id = NEW.organization_id AND lower(c.email) = NEW.email) AS source WHERE 1
  ON CONFLICT (organization_id, subscription_id) DO UPDATE SET
    revision = subscription_fulfillment_cursors.revision + 1,
    updated_at = excluded.updated_at;
END;

CREATE TRIGGER fulfillment_cursor_customer_closure_email_holds_delete
BEFORE DELETE ON customer_closure_email_holds
BEGIN
  INSERT INTO subscription_fulfillment_cursors (organization_id, subscription_id, revision, updated_at)
  SELECT source.organization_id, source.subscription_id, 1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  FROM (SELECT s.organization_id, s.id AS subscription_id FROM subscriptions s
    JOIN customers c ON c.id = s.customer_id AND c.organization_id = s.organization_id
    WHERE c.organization_id = OLD.organization_id AND lower(c.email) = OLD.email) AS source WHERE 1
  ON CONFLICT (organization_id, subscription_id) DO UPDATE SET
    revision = subscription_fulfillment_cursors.revision + 1,
    updated_at = excluded.updated_at;
END;

CREATE TRIGGER fulfillment_cursor_customer_closure_email_holds_update_old
BEFORE UPDATE OF organization_id, email ON customer_closure_email_holds
WHEN OLD.organization_id IS NOT NEW.organization_id
  OR OLD.email IS NOT NEW.email
BEGIN
  INSERT INTO subscription_fulfillment_cursors (organization_id, subscription_id, revision, updated_at)
  SELECT source.organization_id, source.subscription_id, 1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  FROM (SELECT s.organization_id, s.id AS subscription_id FROM subscriptions s
    JOIN customers c ON c.id = s.customer_id AND c.organization_id = s.organization_id
    WHERE c.organization_id = OLD.organization_id AND lower(c.email) = OLD.email) AS source WHERE 1
  ON CONFLICT (organization_id, subscription_id) DO UPDATE SET
    revision = subscription_fulfillment_cursors.revision + 1,
    updated_at = excluded.updated_at;
END;

CREATE TRIGGER fulfillment_cursor_customer_closure_email_holds_update_new
AFTER UPDATE OF organization_id, email ON customer_closure_email_holds
WHEN OLD.organization_id IS NOT NEW.organization_id
  OR OLD.email IS NOT NEW.email
BEGIN
  INSERT INTO subscription_fulfillment_cursors (organization_id, subscription_id, revision, updated_at)
  SELECT source.organization_id, source.subscription_id, 1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  FROM (SELECT s.organization_id, s.id AS subscription_id FROM subscriptions s
    JOIN customers c ON c.id = s.customer_id AND c.organization_id = s.organization_id
    WHERE c.organization_id = NEW.organization_id AND lower(c.email) = NEW.email) AS source WHERE 1
  ON CONFLICT (organization_id, subscription_id) DO UPDATE SET
    revision = subscription_fulfillment_cursors.revision + 1,
    updated_at = excluded.updated_at;
END;

CREATE TRIGGER fulfillment_cursor_customers_insert
AFTER INSERT ON customers
BEGIN
  INSERT INTO subscription_fulfillment_cursors (organization_id, subscription_id, revision, updated_at)
  SELECT source.organization_id, source.subscription_id, 1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  FROM (SELECT s.organization_id, s.id AS subscription_id FROM subscriptions s
    WHERE s.customer_id = NEW.id AND s.organization_id = NEW.organization_id) AS source WHERE 1
  ON CONFLICT (organization_id, subscription_id) DO UPDATE SET
    revision = subscription_fulfillment_cursors.revision + 1,
    updated_at = excluded.updated_at;
END;

CREATE TRIGGER fulfillment_cursor_customers_delete
BEFORE DELETE ON customers
BEGIN
  INSERT INTO subscription_fulfillment_cursors (organization_id, subscription_id, revision, updated_at)
  SELECT source.organization_id, source.subscription_id, 1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  FROM (SELECT s.organization_id, s.id AS subscription_id FROM subscriptions s
    WHERE s.customer_id = OLD.id AND s.organization_id = OLD.organization_id) AS source WHERE 1
  ON CONFLICT (organization_id, subscription_id) DO UPDATE SET
    revision = subscription_fulfillment_cursors.revision + 1,
    updated_at = excluded.updated_at;
END;

CREATE TRIGGER fulfillment_cursor_customers_update_old
BEFORE UPDATE OF organization_id, external_id, email ON customers
WHEN OLD.organization_id IS NOT NEW.organization_id
  OR OLD.external_id IS NOT NEW.external_id
  OR OLD.email IS NOT NEW.email
BEGIN
  INSERT INTO subscription_fulfillment_cursors (organization_id, subscription_id, revision, updated_at)
  SELECT source.organization_id, source.subscription_id, 1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  FROM (SELECT s.organization_id, s.id AS subscription_id FROM subscriptions s
    WHERE s.customer_id = OLD.id AND s.organization_id = OLD.organization_id) AS source WHERE 1
  ON CONFLICT (organization_id, subscription_id) DO UPDATE SET
    revision = subscription_fulfillment_cursors.revision + 1,
    updated_at = excluded.updated_at;
END;

CREATE TRIGGER fulfillment_cursor_customers_update_new
AFTER UPDATE OF organization_id, external_id, email ON customers
WHEN OLD.organization_id IS NOT NEW.organization_id
  OR OLD.external_id IS NOT NEW.external_id
  OR OLD.email IS NOT NEW.email
BEGIN
  INSERT INTO subscription_fulfillment_cursors (organization_id, subscription_id, revision, updated_at)
  SELECT source.organization_id, source.subscription_id, 1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  FROM (SELECT s.organization_id, s.id AS subscription_id FROM subscriptions s
    WHERE s.customer_id = NEW.id AND s.organization_id = NEW.organization_id) AS source WHERE 1
  ON CONFLICT (organization_id, subscription_id) DO UPDATE SET
    revision = subscription_fulfillment_cursors.revision + 1,
    updated_at = excluded.updated_at;
END;

CREATE TRIGGER fulfillment_cursor_plans_insert
AFTER INSERT ON plans
BEGIN
  INSERT INTO subscription_fulfillment_cursors (organization_id, subscription_id, revision, updated_at)
  SELECT source.organization_id, source.subscription_id, 1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  FROM (SELECT s.organization_id, s.id AS subscription_id FROM subscriptions s
    WHERE s.plan_id = NEW.id AND s.organization_id = NEW.organization_id) AS source WHERE 1
  ON CONFLICT (organization_id, subscription_id) DO UPDATE SET
    revision = subscription_fulfillment_cursors.revision + 1,
    updated_at = excluded.updated_at;
END;

CREATE TRIGGER fulfillment_cursor_plans_delete
BEFORE DELETE ON plans
BEGIN
  INSERT INTO subscription_fulfillment_cursors (organization_id, subscription_id, revision, updated_at)
  SELECT source.organization_id, source.subscription_id, 1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  FROM (SELECT s.organization_id, s.id AS subscription_id FROM subscriptions s
    WHERE s.plan_id = OLD.id AND s.organization_id = OLD.organization_id) AS source WHERE 1
  ON CONFLICT (organization_id, subscription_id) DO UPDATE SET
    revision = subscription_fulfillment_cursors.revision + 1,
    updated_at = excluded.updated_at;
END;

CREATE TRIGGER fulfillment_cursor_plans_update_old
BEFORE UPDATE OF organization_id, interval ON plans
WHEN OLD.organization_id IS NOT NEW.organization_id
  OR OLD.interval IS NOT NEW.interval
BEGIN
  INSERT INTO subscription_fulfillment_cursors (organization_id, subscription_id, revision, updated_at)
  SELECT source.organization_id, source.subscription_id, 1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  FROM (SELECT s.organization_id, s.id AS subscription_id FROM subscriptions s
    WHERE s.plan_id = OLD.id AND s.organization_id = OLD.organization_id) AS source WHERE 1
  ON CONFLICT (organization_id, subscription_id) DO UPDATE SET
    revision = subscription_fulfillment_cursors.revision + 1,
    updated_at = excluded.updated_at;
END;

CREATE TRIGGER fulfillment_cursor_plans_update_new
AFTER UPDATE OF organization_id, interval ON plans
WHEN OLD.organization_id IS NOT NEW.organization_id
  OR OLD.interval IS NOT NEW.interval
BEGIN
  INSERT INTO subscription_fulfillment_cursors (organization_id, subscription_id, revision, updated_at)
  SELECT source.organization_id, source.subscription_id, 1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  FROM (SELECT s.organization_id, s.id AS subscription_id FROM subscriptions s
    WHERE s.plan_id = NEW.id AND s.organization_id = NEW.organization_id) AS source WHERE 1
  ON CONFLICT (organization_id, subscription_id) DO UPDATE SET
    revision = subscription_fulfillment_cursors.revision + 1,
    updated_at = excluded.updated_at;
END;
