import type { AuthContext } from "../auth/api-key";
import { ApiError, json } from "../http";

type Evidence = {
  id: string;
  customer_external_id: string;
  subscription_external_id: string | null;
  subscription_status: string | null;
  plan_interval: string | null;
  paid_through: string | null;
  paid_from: string | null;
  plan_line_count: number;
  ending_at: string | null;
  terminated_at: string | null;
  status: string;
  payment_status: string;
  total_due_minor: number;
  paid_minor: number;
  provider: string | null;
  provider_code: string | null;
  provider_count: number;
  invalid_payment_count: number;
  link_count: number;
  matching_link_count: number;
  closure_held: number;
  refunded_minor: number;
  pending_refund_minor: number;
  unknown_refund_count: number;
};

// One statement gives consumers a consistent local-ledger snapshot. This is not a
// provider reconciliation, nor a lease authorizing a later entitlement mutation.
export async function showInvoiceFulfillment(
  invoiceId: string,
  database: D1Database,
  auth: AuthContext,
  requestId: string,
): Promise<Response> {
  const row = await database
    .prepare(`WITH scoped_invoice AS (
    SELECT * FROM invoices WHERE id = ? AND organization_id = ?
  ), plan_lines AS (
    SELECT line.metadata_json FROM invoice_lines line
    JOIN scoped_invoice i ON i.id = line.invoice_id
    JOIN subscriptions s ON s.id = i.subscription_id
      AND s.organization_id = i.organization_id AND s.customer_id = i.customer_id
    WHERE line.line_type = 'subscription' AND line.source_type = 'plan' AND line.source_id = s.plan_id
  ), payment_evidence AS (
    SELECT p.provider, p.provider_account_code, p.currency,
      COALESCE(p.provider_transaction_id, 'attempt:' || p.id) AS transaction_key, p.amount_minor
    FROM payment_attempts p JOIN scoped_invoice i ON i.id = p.invoice_id
    WHERE p.organization_id = i.organization_id AND p.status = 'succeeded'
    UNION
    SELECT p.provider, p.provider_account_code, p.currency,
      COALESCE(p.provider_transaction_id, 'request:' || p.id), a.amount_minor
    FROM payment_request_payment_allocations a
    JOIN scoped_invoice i ON i.id = a.invoice_id
    JOIN payment_request_payments p ON p.id = a.payment_request_payment_id
    WHERE p.organization_id = i.organization_id AND a.organization_id = i.organization_id
      AND p.status = 'succeeded'
  ), payments AS (
    SELECT provider, provider_account_code, currency, transaction_key,
      MAX(amount_minor) AS amount_minor, COUNT(DISTINCT amount_minor) AS amount_versions
    FROM payment_evidence GROUP BY provider, provider_account_code, currency, transaction_key
  ), refund_evidence AS (
    SELECT COALESCE(r.credit_note_id, 'operation:' || r.id) AS refund_key,
      r.amount_minor, r.currency, r.status
    FROM provider_refund_operations r JOIN scoped_invoice i ON i.id = r.invoice_id
    WHERE r.organization_id = i.organization_id
    UNION ALL
    SELECT n.id, f.refund_amount_minor, n.currency, f.refund_status
    FROM credit_notes n JOIN scoped_invoice i ON i.id = n.invoice_id
    JOIN credit_note_financials f ON f.credit_note_id = n.id
    WHERE n.organization_id = i.organization_id AND f.organization_id = i.organization_id AND f.refund_amount_minor > 0
    UNION ALL
    SELECT r.credit_note_id, r.amount_minor, r.currency, r.status
    FROM credit_note_refunds r JOIN scoped_invoice i ON i.id = r.invoice_id
    WHERE r.organization_id = i.organization_id
  ), normalized_refunds AS (
    SELECT refund_key, amount_minor, currency, CASE
      WHEN status IN ('failed', 'canceled') THEN 'failed'
      WHEN status = 'succeeded' THEN 'succeeded'
      WHEN status IN ('pending', 'requires_action') THEN 'pending'
      ELSE 'unknown' END AS status FROM refund_evidence
  ), refunds AS (
    SELECT refund_key, MAX(amount_minor) AS amount_minor, MIN(currency) AS currency,
      CASE WHEN COUNT(DISTINCT amount_minor) <> 1 OR COUNT(DISTINCT currency) <> 1
        OR COUNT(DISTINCT status) <> 1 THEN 'unknown' ELSE MIN(status) END AS status
    FROM normalized_refunds GROUP BY refund_key
  ) SELECT i.id, c.external_id AS customer_external_id,
    s.external_id AS subscription_external_id, s.status AS subscription_status,
    p.interval AS plan_interval, s.ending_at, s.terminated_at,
    (SELECT json_extract(CASE WHEN json_valid(metadata_json) THEN metadata_json ELSE '{}' END, '$.periodEnd') FROM plan_lines) AS paid_through,
    (SELECT json_extract(CASE WHEN json_valid(metadata_json) THEN metadata_json ELSE '{}' END, '$.periodStart') FROM plan_lines) AS paid_from,
    (SELECT COUNT(*) FROM plan_lines) AS plan_line_count,
    i.status, i.payment_status, i.total_due_minor,
    (SELECT COUNT(*) FROM invoice_subscriptions l WHERE l.invoice_id = i.id) AS link_count,
    (SELECT COUNT(*) FROM invoice_subscriptions l WHERE l.invoice_id = i.id
      AND l.subscription_id = s.id AND l.organization_id = i.organization_id) AS matching_link_count,
    (EXISTS (SELECT 1 FROM customer_closure_holds h WHERE h.customer_id = c.id)
      OR EXISTS (SELECT 1 FROM customer_closure_email_holds h
        WHERE h.organization_id = i.organization_id AND h.email = lower(c.email))) AS closure_held,
    COALESCE((SELECT SUM(amount_minor) FROM payments), 0) AS paid_minor,
    (SELECT MIN(provider) FROM payments) AS provider,
    (SELECT MIN(provider_account_code) FROM payments) AS provider_code,
    (SELECT COUNT(*) FROM (SELECT DISTINCT provider, provider_account_code FROM payments)) AS provider_count,
    (SELECT COUNT(*) FROM payments WHERE currency <> i.currency OR amount_minor <= 0 OR amount_versions <> 1) AS invalid_payment_count,
    COALESCE((SELECT SUM(amount_minor) FROM refunds WHERE status = 'succeeded'), 0) AS refunded_minor,
    COALESCE((SELECT SUM(amount_minor) FROM refunds WHERE status NOT IN ('succeeded', 'failed', 'canceled')), 0) AS pending_refund_minor,
    (SELECT COUNT(*) FROM refunds WHERE status IS NULL OR status IN ('unknown', 'submitted')
      OR status NOT IN ('succeeded', 'failed', 'canceled', 'pending', 'requires_action', 'submitted')
      OR currency <> i.currency) AS unknown_refund_count
    FROM scoped_invoice i JOIN customers c ON c.id = i.customer_id AND c.organization_id = i.organization_id
    LEFT JOIN subscriptions s ON s.id = i.subscription_id AND s.customer_id = i.customer_id AND s.organization_id = i.organization_id
    LEFT JOIN plans p ON p.id = s.plan_id AND p.organization_id = i.organization_id`)
    .bind(invoiceId, auth.organizationId)
    .first<Evidence>();
  if (!row) throw new ApiError(404, "invoice_not_found", "Invoice was not found");

  const now = Date.now();
  const recurring = ["weekly", "monthly", "quarterly", "yearly"].includes(row.plan_interval ?? "");
  const refundState =
    row.unknown_refund_count > 0
      ? "unknown"
      : row.pending_refund_minor > 0
        ? "pending"
        : row.refunded_minor > 0
          ? row.refunded_minor >= row.paid_minor
            ? "full"
            : "partial"
          : row.payment_status === "refunded"
            ? "unknown"
            : "none";
  const eligible =
    row.status === "finalized" &&
    row.payment_status === "succeeded" &&
    row.total_due_minor > 0 &&
    row.paid_minor >= row.total_due_minor &&
    row.provider === "easy_pay_direct" &&
    row.provider_count === 1 &&
    Boolean(row.provider_code) &&
    row.invalid_payment_count === 0 &&
    row.link_count === 1 &&
    row.matching_link_count === 1 &&
    row.plan_line_count === 1 &&
    row.closure_held === 0 &&
    row.subscription_status === "active" &&
    row.terminated_at === null &&
    refundState === "none" &&
    (row.ending_at === null || Date.parse(row.ending_at) > now) &&
    (row.plan_interval === "one_time" ||
      (recurring &&
        Date.parse(row.paid_from ?? "") <= now &&
        Date.parse(row.paid_through ?? "") > now));
  const paidThrough =
    row.plan_interval === "one_time"
      ? null
      : row.ending_at && Date.parse(row.ending_at) < Date.parse(row.paid_through ?? "")
        ? row.ending_at
        : row.paid_through;
  return json(
    {
      fulfillment: {
        version: 1,
        invoiceId: row.id,
        externalCustomerId: row.customer_external_id,
        externalSubscriptionId: row.subscription_external_id,
        provider: row.provider,
        providerCode: row.provider_code,
        eligible,
        subscriptionStatus: row.subscription_status,
        planInterval: row.plan_interval,
        paidThrough,
        endingAt: row.ending_at,
        refundState,
        refundedAmountMinor: row.refunded_minor,
        pendingRefundAmountMinor: row.pending_refund_minor,
      },
    },
    { requestId },
  );
}
