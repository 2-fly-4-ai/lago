import { ApiError } from "../http";

export type FulfillmentSourceSnapshot = {
  version: 1;
  sourceId: string;
  organizationId: string;
  revision: number;
  provider: "easy_pay_direct";
  providerCode: string;
  mode: "test" | "live";
  customerId: string;
  customerEmail: string | null;
  currency: string;
  externalCustomerId: string;
  externalSubscriptionId: string;
  subscriptionStatus: string;
  planInterval: string;
  eligible: boolean;
  held: boolean;
  holdReason: string | null;
  inactiveReason: string | null;
  validFrom: string | null;
  paidThrough: string | null;
  endingAt: string | null;
  nextBoundaryAt: string | null;
  evidenceInvoiceIds: string[];
  paidAmountMinor: number;
  refundedAmountMinor: number;
  pendingRefundAmountMinor: number;
};

export type FulfillmentSourceScope = {
  providerCode: string;
  mode: "test" | "live";
  pin?: { invoiceId: string; externalCustomerId: string; externalSubscriptionId: string };
};

// All ledger reads and the revision UPSERT occur in ONE SQL statement. There is
// no application-side read/compute/write gap to fence with payment-table triggers.
// D1 batch then records immutable history and returns the head in the same transaction.
const MATERIALIZE = `WITH RECURSIVE requested AS (
  SELECT ? AS subscription_id, ? AS organization_id,
    COALESCE(?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) AS evaluated_at,
    ? AS provider_code, ? AS mode, ? AS origin_invoice_id
), args AS (
  SELECT r.subscription_id, r.organization_id, CASE
    WHEN julianday(h.evaluated_at) > julianday(r.evaluated_at) THEN h.evaluated_at
    ELSE r.evaluated_at END AS evaluated_at, r.provider_code, r.mode, r.origin_invoice_id FROM requested r
  LEFT JOIN fulfillment_source_snapshot_heads h ON h.organization_id = r.organization_id AND h.subscription_id = r.subscription_id
), live_source AS (
  SELECT s.id, s.organization_id, s.customer_id, s.plan_id,
    COALESCE(json_extract(h.payload_json, '$.externalSubscriptionId'), s.external_id) AS external_id,
    CASE WHEN json_extract(h.payload_json, '$.subscriptionStatus') = 'deleted' THEN 'deleted'
      WHEN h.payload_json IS NOT NULL AND (json_extract(h.payload_json, '$.externalCustomerId') <> c.external_id
        OR json_extract(h.payload_json, '$.customerId') <> s.customer_id
        OR json_extract(h.payload_json, '$.customerEmail') IS NOT lower(trim(c.email))
        OR json_extract(h.payload_json, '$.currency') <> p.currency
        OR json_extract(h.payload_json, '$.planId') <> s.plan_id
        OR json_extract(h.payload_json, '$.planInterval') <> p.interval
        OR json_extract(h.payload_json, '$.externalSubscriptionId') <> s.external_id
        OR json_extract(h.payload_json, '$.providerCode') <> a.provider_code
        OR json_extract(h.payload_json, '$.mode') <> a.mode) THEN 'identity_conflict'
      ELSE s.status END AS status,
    s.ending_at, s.terminated_at,
    COALESCE(json_extract(h.payload_json, '$.externalCustomerId'), c.external_id) AS customer_external_id,
    COALESCE(json_extract(h.payload_json, '$.planInterval'), p.interval) AS plan_interval,
    COALESCE(json_extract(h.payload_json, '$.currency'), p.currency) AS currency,
    CASE WHEN h.payload_json IS NOT NULL THEN json_extract(h.payload_json, '$.customerEmail')
      ELSE lower(trim(c.email)) END AS customer_email,
    (EXISTS (SELECT 1 FROM customer_closure_holds h WHERE h.customer_id = s.customer_id)
      OR EXISTS (SELECT 1 FROM customer_closure_email_holds h
        WHERE h.organization_id = s.organization_id AND h.email = lower(c.email))) AS closure_held
  FROM subscriptions s JOIN args a ON s.id = a.subscription_id AND s.organization_id = a.organization_id
  JOIN customers c ON c.id = s.customer_id AND c.organization_id = s.organization_id
  JOIN plans p ON p.id = s.plan_id AND p.organization_id = s.organization_id
  LEFT JOIN fulfillment_source_snapshot_heads h ON h.organization_id = s.organization_id AND h.subscription_id = s.id
), source AS (
  SELECT * FROM live_source
  UNION ALL
  SELECT h.subscription_id, h.organization_id, NULL, NULL,
    json_extract(h.payload_json, '$.externalSubscriptionId'), 'deleted', NULL, h.captured_at,
    json_extract(h.payload_json, '$.externalCustomerId'), json_extract(h.payload_json, '$.planInterval'),
    json_extract(h.payload_json, '$.currency'), json_extract(h.payload_json, '$.customerEmail'), 0
  FROM fulfillment_source_snapshot_heads h JOIN args a
    ON h.organization_id = a.organization_id AND h.subscription_id = a.subscription_id
  WHERE NOT EXISTS (SELECT 1 FROM live_source)
), source_invoices AS (
  SELECT i.* FROM invoices i JOIN source s
    ON s.organization_id = i.organization_id AND s.customer_id = i.customer_id
  WHERE i.subscription_id = s.id OR EXISTS (SELECT 1 FROM invoice_subscriptions link
    WHERE link.invoice_id = i.id AND link.subscription_id = s.id AND link.organization_id = s.organization_id)
), plan_lines AS (
  SELECT l.invoice_id, COUNT(*) AS line_count,
    MIN(json_extract(CASE WHEN json_valid(l.metadata_json) THEN l.metadata_json ELSE '{}' END, '$.periodStart')) AS period_start,
    MIN(json_extract(CASE WHEN json_valid(l.metadata_json) THEN l.metadata_json ELSE '{}' END, '$.periodEnd')) AS period_end
  FROM invoice_lines l JOIN source_invoices i ON i.id = l.invoice_id JOIN source s
  WHERE l.line_type = 'subscription' AND l.source_type = 'plan' AND l.source_id = s.plan_id
  GROUP BY l.invoice_id
), payment_evidence AS (
  SELECT p.invoice_id, p.provider, p.provider_account_code, p.currency,
    COALESCE(p.provider_transaction_id, 'attempt:' || p.id) AS transaction_key, p.amount_minor
  FROM payment_attempts p JOIN source_invoices i ON i.id = p.invoice_id
  WHERE p.organization_id = i.organization_id AND p.status = 'succeeded'
  UNION ALL
  SELECT a.invoice_id, p.provider, p.provider_account_code, p.currency,
    COALESCE(p.provider_transaction_id, 'request:' || p.id), a.amount_minor
  FROM payment_request_payment_allocations a JOIN source_invoices i ON i.id = a.invoice_id
  JOIN payment_request_payments p ON p.id = a.payment_request_payment_id
  WHERE p.organization_id = i.organization_id AND a.organization_id = i.organization_id AND p.status = 'succeeded'
), payments AS (
  SELECT invoice_id, provider, provider_account_code, currency, transaction_key,
    MAX(amount_minor) AS amount_minor, COUNT(DISTINCT amount_minor) AS amount_versions
  FROM payment_evidence GROUP BY invoice_id, provider, provider_account_code, currency, transaction_key
), refund_evidence AS (
  SELECT r.invoice_id, COALESCE(r.credit_note_id, 'operation:' || r.id) AS refund_key,
    r.amount_minor, r.currency, r.status
  FROM provider_refund_operations r JOIN source_invoices i ON i.id = r.invoice_id
  WHERE r.organization_id = i.organization_id
  UNION ALL
  SELECT n.invoice_id, n.id, f.refund_amount_minor, n.currency, f.refund_status
  FROM credit_notes n JOIN source_invoices i ON i.id = n.invoice_id
  JOIN credit_note_financials f ON f.credit_note_id = n.id
  WHERE n.organization_id = i.organization_id AND f.organization_id = i.organization_id AND f.refund_amount_minor > 0
  UNION ALL
  SELECT r.invoice_id, r.credit_note_id, r.amount_minor, r.currency, r.status
  FROM credit_note_refunds r JOIN source_invoices i ON i.id = r.invoice_id
  WHERE r.organization_id = i.organization_id
), normalized_refunds AS (
  SELECT invoice_id, refund_key, amount_minor, currency, CASE
    WHEN status IN ('failed', 'canceled') THEN 'failed'
    WHEN status = 'succeeded' THEN 'succeeded'
    WHEN status IN ('pending', 'requires_action') THEN 'pending'
    ELSE 'unknown' END AS status FROM refund_evidence
), refunds AS (
  SELECT invoice_id, refund_key, MAX(amount_minor) AS amount_minor, MIN(currency) AS currency,
    CASE WHEN COUNT(DISTINCT amount_minor) <> 1 OR COUNT(DISTINCT currency) <> 1
      OR COUNT(DISTINCT status) <> 1 THEN 'unknown' ELSE MIN(status) END AS status
  FROM normalized_refunds GROUP BY invoice_id, refund_key
), invoice_evidence AS (
  SELECT i.*, l.period_start, l.period_end, COALESCE(l.line_count, 0) AS plan_line_count,
    (SELECT COUNT(*) FROM invoice_subscriptions link WHERE link.invoice_id = i.id) AS link_count,
    (SELECT COUNT(*) FROM invoice_subscriptions link JOIN source s
      WHERE link.invoice_id = i.id AND link.subscription_id = s.id AND link.organization_id = s.organization_id) AS matching_link_count,
    COALESCE((SELECT SUM(amount_minor) FROM payments p WHERE p.invoice_id = i.id), 0) AS paid_minor,
    (SELECT COUNT(*) FROM payments p WHERE p.invoice_id = i.id AND (
      p.currency <> i.currency OR p.amount_minor <= 0 OR p.amount_versions <> 1
      OR p.provider <> 'easy_pay_direct' OR p.provider_account_code <> (SELECT provider_code FROM args))) AS invalid_payments,
    (SELECT COUNT(DISTINCT provider_account_code) FROM payments p WHERE p.invoice_id = i.id) AS account_count,
    COALESCE((SELECT SUM(amount_minor) FROM refunds r WHERE r.invoice_id = i.id AND r.status = 'succeeded'), 0) AS refunded_minor,
    COALESCE((SELECT SUM(amount_minor) FROM refunds r WHERE r.invoice_id = i.id AND r.status IN ('pending', 'unknown')), 0) AS pending_refund_minor,
    (SELECT COUNT(*) FROM refunds r WHERE r.invoice_id = i.id AND (r.status = 'unknown' OR r.currency <> i.currency)) AS unknown_refunds
  FROM source_invoices i LEFT JOIN plan_lines l ON l.invoice_id = i.id
), qualified AS (
  SELECT e.* FROM invoice_evidence e JOIN source s
  WHERE e.status = 'finalized' AND e.payment_status = 'succeeded'
    AND e.total_due_minor > 0 AND e.paid_minor = e.total_due_minor AND e.currency = s.currency
    AND e.invalid_payments = 0 AND e.account_count = 1
    AND e.plan_line_count = 1 AND e.link_count = 1 AND e.matching_link_count = 1
    AND e.unknown_refunds = 0 AND e.pending_refund_minor = 0 AND e.refunded_minor < e.paid_minor
    AND ((s.plan_interval = 'one_time' AND typeof(e.period_start) = 'text' AND julianday(e.period_start) IS NOT NULL)
      OR (s.plan_interval IN ('weekly', 'monthly', 'quarterly', 'yearly')
      AND typeof(e.period_start) = 'text' AND typeof(e.period_end) = 'text'
      AND julianday(e.period_end) > julianday(e.period_start)))
), coverage_chain (id, period_start, period_end) AS (
  SELECT q.id, q.period_start, q.period_end FROM qualified q JOIN args a JOIN source s
    WHERE s.plan_interval <> 'one_time' AND julianday(q.period_start) <= julianday(a.evaluated_at)
      AND julianday(q.period_end) > julianday(a.evaluated_at)
  UNION
  SELECT q.id, q.period_start, q.period_end FROM qualified q JOIN coverage_chain c
    ON julianday(q.period_start) <= julianday(c.period_end) AND julianday(q.period_end) > julianday(c.period_end)
), coverage_ids AS (
  SELECT id FROM coverage_chain
  UNION SELECT q.id FROM qualified q JOIN source s JOIN args a WHERE s.plan_interval = 'one_time'
    AND julianday(q.period_start) <= julianday(a.evaluated_at)
), coverage AS (
  SELECT s.*,
    (SELECT COUNT(*) FROM coverage_ids) AS covered,
    (SELECT q.period_start FROM qualified q JOIN coverage_ids ids ON ids.id = q.id
      ORDER BY julianday(q.period_start), q.id LIMIT 1) AS valid_from,
    (SELECT period_end FROM coverage_chain ORDER BY julianday(period_end) DESC, id LIMIT 1) AS paid_through,
    (SELECT COUNT(*) FROM invoice_evidence e WHERE e.pending_refund_minor > 0 OR e.unknown_refunds > 0) AS refund_review,
    (SELECT COUNT(*) FROM invoice_evidence e WHERE e.invalid_payments > 0
      OR (e.payment_status = 'refunded' AND e.refunded_minor < e.paid_minor)
      OR e.refunded_minor > e.paid_minor
      OR (e.payment_status = 'succeeded' AND (e.paid_minor <> e.total_due_minor OR e.account_count <> 1))) AS ambiguous_evidence
  FROM source s
), decision AS (
  SELECT c.*, CASE
    WHEN c.status = 'identity_conflict' THEN 'source_identity_changed'
    WHEN c.closure_held = 1 THEN 'closure'
    WHEN c.ending_at IS NOT NULL AND julianday(c.ending_at) IS NULL THEN 'ambiguous_evidence'
    WHEN c.covered = 0 AND c.ambiguous_evidence > 0 THEN 'ambiguous_evidence'
    WHEN c.covered = 0 AND c.refund_review > 0 THEN 'refund_review'
    ELSE NULL END AS hold_reason,
    CASE WHEN c.status = 'active' AND c.terminated_at IS NULL AND c.closure_held = 0
      AND c.covered > 0 AND (c.ending_at IS NULL OR julianday(c.ending_at) > julianday(a.evaluated_at))
      THEN 1 ELSE 0 END AS eligible,
    CASE WHEN c.plan_interval = 'one_time' THEN c.ending_at
      WHEN c.ending_at IS NOT NULL AND julianday(c.ending_at) < julianday(c.paid_through)
        THEN c.ending_at ELSE c.paid_through END AS effective_paid_through
  FROM coverage c JOIN args a
), boundaries AS (
  SELECT period_start AS boundary FROM qualified WHERE period_start IS NOT NULL
  UNION SELECT period_end FROM qualified WHERE period_end IS NOT NULL
  UNION SELECT ending_at FROM source WHERE ending_at IS NOT NULL
), payload AS (
  SELECT d.organization_id, d.id AS subscription_id, a.evaluated_at,
    (SELECT boundary FROM boundaries WHERE julianday(boundary) > julianday(a.evaluated_at)
      ORDER BY julianday(boundary) LIMIT 1) AS next_boundary_at,
    json_object(
      'version', 1, 'sourceId', d.id, 'organizationId', d.organization_id,
      'provider', 'easy_pay_direct',
      'originInvoiceId', COALESCE((SELECT json_extract(h.payload_json, '$.originInvoiceId') FROM fulfillment_source_snapshot_heads h WHERE h.organization_id = d.organization_id AND h.subscription_id = d.id), a.origin_invoice_id),
      'providerCode', COALESCE((SELECT json_extract(h.payload_json, '$.providerCode') FROM fulfillment_source_snapshot_heads h WHERE h.organization_id = d.organization_id AND h.subscription_id = d.id), a.provider_code),
      'mode', COALESCE((SELECT json_extract(h.payload_json, '$.mode') FROM fulfillment_source_snapshot_heads h WHERE h.organization_id = d.organization_id AND h.subscription_id = d.id), a.mode),
      'customerId', COALESCE((SELECT json_extract(h.payload_json, '$.customerId') FROM fulfillment_source_snapshot_heads h
        WHERE h.organization_id = d.organization_id AND h.subscription_id = d.id), d.customer_id),
      'customerEmail', d.customer_email, 'currency', d.currency,
      'planId', COALESCE((SELECT json_extract(h.payload_json, '$.planId') FROM fulfillment_source_snapshot_heads h
        WHERE h.organization_id = d.organization_id AND h.subscription_id = d.id), d.plan_id),
      'externalCustomerId', d.customer_external_id, 'externalSubscriptionId', d.external_id,
      'subscriptionStatus', d.status, 'planInterval', d.plan_interval,
      'eligible', json(CASE WHEN d.eligible = 1 THEN 'true' ELSE 'false' END),
      'held', json(CASE WHEN d.hold_reason IS NOT NULL THEN 'true' ELSE 'false' END),
      'holdReason', d.hold_reason,
      'inactiveReason', CASE WHEN d.eligible = 1 OR d.hold_reason IS NOT NULL THEN NULL
        WHEN d.status <> 'active' OR d.terminated_at IS NOT NULL THEN 'subscription_inactive'
        WHEN d.ending_at IS NOT NULL AND julianday(d.ending_at) <= julianday(a.evaluated_at) THEN 'ended'
        ELSE 'no_current_paid_coverage' END,
      'validFrom', d.valid_from, 'paidThrough', d.effective_paid_through, 'endingAt', d.ending_at,
      'evidenceInvoiceIds', json(COALESCE((SELECT json_group_array(id) FROM (SELECT id FROM coverage_ids ORDER BY id)), '[]')),
      'paidAmountMinor', COALESCE((SELECT SUM(paid_minor) FROM invoice_evidence WHERE currency = d.currency), 0),
      'refundedAmountMinor', COALESCE((SELECT SUM(refunded_minor) FROM invoice_evidence WHERE currency = d.currency), 0),
      'pendingRefundAmountMinor', COALESCE((SELECT SUM(pending_refund_minor) FROM invoice_evidence WHERE currency = d.currency), 0),
      'nextBoundaryAt', (SELECT boundary FROM boundaries WHERE julianday(boundary) > julianday(a.evaluated_at)
        ORDER BY julianday(boundary) LIMIT 1)
    ) AS payload_json FROM decision d JOIN args a
)
INSERT INTO fulfillment_source_snapshot_heads
  (organization_id, subscription_id, revision, payload_json, captured_at, evaluated_at, next_boundary_at)
SELECT organization_id, subscription_id, 1, payload_json, evaluated_at, evaluated_at, next_boundary_at
FROM payload WHERE 1
ON CONFLICT (organization_id, subscription_id) DO UPDATE SET
  revision = fulfillment_source_snapshot_heads.revision + CASE
    WHEN fulfillment_source_snapshot_heads.payload_json <> excluded.payload_json THEN 1 ELSE 0 END,
  captured_at = CASE WHEN fulfillment_source_snapshot_heads.payload_json <> excluded.payload_json
    THEN excluded.captured_at ELSE fulfillment_source_snapshot_heads.captured_at END,
  payload_json = excluded.payload_json, evaluated_at = excluded.evaluated_at,
  next_boundary_at = excluded.next_boundary_at`;

export async function materializeFulfillmentSourceSnapshot(
  database: D1Database,
  organizationId: string,
  subscriptionId: string,
  scope: FulfillmentSourceScope,
  now?: Date,
): Promise<FulfillmentSourceSnapshot> {
  if (!scope.providerCode.trim() || !["test", "live"].includes(scope.mode))
    throw new ApiError(503, "fulfillment_scope_unavailable", "Fulfillment scope is unavailable");
  const evaluatedAt = now?.toISOString() ?? null;
  // The pin is checked in the same D1 transaction as materialization. A durable
  // original invoice anchor survives refunds/deletion and cannot be retargeted.
  const pinGuard = scope.pin
    ? `EXISTS (
    SELECT 1 FROM fulfillment_source_snapshot_heads h WHERE h.organization_id = ? AND h.subscription_id = ?
      AND json_extract(h.payload_json, '$.originInvoiceId') = ?
      AND json_extract(h.payload_json, '$.externalCustomerId') = ?
      AND json_extract(h.payload_json, '$.externalSubscriptionId') = ?
    UNION ALL SELECT 1 FROM invoices i JOIN subscriptions s ON s.id = i.subscription_id
      AND s.organization_id = i.organization_id AND s.customer_id = i.customer_id
    JOIN customers c ON c.id = s.customer_id AND c.organization_id = s.organization_id
    WHERE i.organization_id = ? AND i.id = ? AND s.id = ? AND c.external_id = ? AND s.external_id = ?
      AND NOT EXISTS (SELECT 1 FROM fulfillment_source_snapshot_heads h WHERE h.organization_id = s.organization_id
        AND h.subscription_id = s.id AND json_extract(h.payload_json, '$.originInvoiceId') IS NOT NULL
        AND json_extract(h.payload_json, '$.originInvoiceId') <> i.id)
    )`
    : "1";
  const pinBindings = scope.pin
    ? [
        organizationId,
        subscriptionId,
        scope.pin.invoiceId,
        scope.pin.externalCustomerId,
        scope.pin.externalSubscriptionId,
        organizationId,
        scope.pin.invoiceId,
        subscriptionId,
        scope.pin.externalCustomerId,
        scope.pin.externalSubscriptionId,
      ]
    : [];
  const results = await database.batch([
    database
      .prepare(
        MATERIALIZE.replace("? AS origin_invoice_id", `? AS origin_invoice_id WHERE ${pinGuard}`),
      )
      .bind(
        subscriptionId,
        organizationId,
        evaluatedAt,
        scope.providerCode,
        scope.mode,
        scope.pin?.invoiceId ?? null,
        ...pinBindings,
      ),
    database
      .prepare(`INSERT INTO fulfillment_source_snapshot_history
      (organization_id, subscription_id, revision, payload_json, captured_at)
      SELECT organization_id, subscription_id, revision, payload_json, captured_at
      FROM fulfillment_source_snapshot_heads WHERE organization_id = ? AND subscription_id = ?
      ON CONFLICT (organization_id, subscription_id, revision) DO NOTHING`)
      .bind(organizationId, subscriptionId),
    database
      .prepare(`SELECT revision, payload_json FROM fulfillment_source_snapshot_heads
      WHERE organization_id = ? AND subscription_id = ? AND ${pinGuard}`)
      .bind(organizationId, subscriptionId, ...pinBindings),
  ]);
  const row = results.at(-1)?.results[0] as { revision: number; payload_json: string } | undefined;
  if (!row) throw new ApiError(404, "subscription_not_found", "Subscription was not found");
  return { ...JSON.parse(row.payload_json), revision: row.revision } as FulfillmentSourceSnapshot;
}

// Polling foundation only: no scheduler, external delivery or provider calls are enabled.
export async function listFulfillmentSourcesForRefresh(
  database: D1Database,
  organizationId: string,
  evaluatedBefore: string,
  now = new Date(),
): Promise<string[]> {
  const result = await database
    .prepare(`SELECT subscription_id FROM fulfillment_source_snapshot_heads
    WHERE organization_id = ? AND (julianday(evaluated_at) <= julianday(?) OR julianday(next_boundary_at) <= julianday(?))
    ORDER BY evaluated_at, subscription_id LIMIT 100`)
    .bind(organizationId, evaluatedBefore, now.toISOString())
    .all<{ subscription_id: string }>();
  return result.results.map((row) => row.subscription_id);
}
