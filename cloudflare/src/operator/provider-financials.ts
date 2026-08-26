import { ApiError, json } from "../http";
import { stableJson } from "../json";

type DisputeRow = {
  id: string;
  provider: string;
  provider_account_code: string;
  provider_dispute_id: string;
  payment_attempt_id: string | null;
  invoice_id: string | null;
  invoice_number: string | null;
  provider_payment_intent_id: string | null;
  provider_charge_id: string | null;
  amount_minor: number;
  currency: string;
  reason: string | null;
  status: string;
  evidence_due_by: string | null;
  livemode: number;
  provider_created_at: string;
  updated_at: string;
};

type RefundRow = {
  id: string;
  credit_note_id: string | null;
  credit_note_number: string | null;
  invoice_id: string;
  invoice_number: string | null;
  payment_attempt_id: string;
  provider: string;
  provider_account_code: string;
  provider_payment_id: string;
  provider_refund_id: string | null;
  amount_minor: number;
  currency: string;
  status: string;
  failure_code: string | null;
  failure_message: string | null;
  created_at: string;
  updated_at: string;
};

export async function handleOperatorProviderFinancialsRequest(
  request: Request,
  database: D1Database,
  organizationId: string,
  requestId: string,
): Promise<Response | null> {
  const pathname = new URL(request.url).pathname;
  const loseDisputeMatch = pathname.match(/^\/api\/operator\/v1\/payment-disputes\/([^/]+)\/lose$/);
  const disputeMatch = pathname.match(/^\/api\/operator\/v1\/payment-disputes(?:\/([^/]+))?$/);
  const refundMatch = pathname.match(/^\/api\/operator\/v1\/provider-refunds(?:\/([^/]+))?$/);
  if (!loseDisputeMatch && !disputeMatch && !refundMatch) return null;
  if (loseDisputeMatch?.[1] && request.method === "POST") {
    return loseDispute(
      database,
      organizationId,
      decodeURIComponent(loseDisputeMatch[1]),
      requestId,
    );
  }
  if (request.method !== "GET") {
    throw new ApiError(
      405,
      "operator_provider_financials_read_only",
      "Provider disputes and refunds are read-only until the production provider gate is approved",
    );
  }
  if (disputeMatch) {
    return disputes(
      database,
      organizationId,
      disputeMatch[1] ? decodeURIComponent(disputeMatch[1]) : null,
      requestId,
    );
  }
  return refunds(
    database,
    organizationId,
    refundMatch?.[1] ? decodeURIComponent(refundMatch[1]) : null,
    requestId,
  );
}

async function loseDispute(
  database: D1Database,
  organizationId: string,
  id: string,
  requestId: string,
): Promise<Response> {
  const current = await database
    .prepare(
      `SELECT id, invoice_id, status FROM payment_disputes
       WHERE id = ? AND organization_id = ? LIMIT 1`,
    )
    .bind(id, organizationId)
    .first<{ id: string; invoice_id: string | null; status: string }>();
  if (!current)
    throw new ApiError(404, "payment_dispute_not_found", "Payment dispute was not found");
  if (!current.invoice_id)
    throw new ApiError(422, "payment_dispute_unmatched", "Payment dispute has no matched invoice");
  if (current.status !== "lost") {
    const now = new Date().toISOString();
    const eventId = `payment-dispute-lost:${id}`;
    const results = await database.batch([
      database
        .prepare(
          `UPDATE payment_disputes SET status = 'lost', updated_at = ?
           WHERE id = ? AND organization_id = ? AND status != 'lost'`,
        )
        .bind(now, id, organizationId),
      database
        .prepare(
          `UPDATE invoices
           SET payment_dispute_lost_at = COALESCE(payment_dispute_lost_at, ?),
               version = version + CASE WHEN payment_dispute_lost_at IS NULL THEN 1 ELSE 0 END,
               updated_at = CASE WHEN payment_dispute_lost_at IS NULL THEN ? ELSE updated_at END
           WHERE id = ? AND organization_id = ?`,
        )
        .bind(now, now, current.invoice_id, organizationId),
      database
        .prepare(
          `INSERT INTO outbox_events
           (event_id, organization_id, event_type, event_version, aggregate_type, aggregate_id,
            aggregate_version, causation_id, correlation_id, payload_json, occurred_at, published_at)
           SELECT ?, ?, 'payment_dispute.lost', 1, 'payment_dispute', ?, 1, ?, ?, ?, ?, NULL
           WHERE EXISTS (SELECT 1 FROM payment_disputes WHERE id = ? AND organization_id = ?
                         AND status = 'lost')
           ON CONFLICT(event_id) DO NOTHING`,
        )
        .bind(
          eventId,
          organizationId,
          id,
          requestId,
          requestId,
          stableJson({ disputeId: id, invoiceId: current.invoice_id, source: "operator" }),
          now,
          id,
          organizationId,
        ),
    ]);
    if ((results[0]?.meta.changes ?? 0) < 1 || (results[1]?.meta.changes ?? 0) < 1)
      throw new ApiError(409, "payment_dispute_conflict", "Payment dispute changed concurrently");
  }
  return disputes(database, organizationId, id, requestId);
}

async function disputes(
  database: D1Database,
  organizationId: string,
  id: string | null,
  requestId: string,
): Promise<Response> {
  const rows = await database
    .prepare(
      `SELECT dispute.id, dispute.provider, dispute.provider_account_code,
              dispute.provider_dispute_id, dispute.payment_attempt_id, dispute.invoice_id,
              invoice.number AS invoice_number, dispute.provider_payment_intent_id,
              dispute.provider_charge_id, dispute.amount_minor, dispute.currency, dispute.reason,
              dispute.status, dispute.evidence_due_by, dispute.livemode,
              dispute.provider_created_at, dispute.updated_at
       FROM payment_disputes dispute
       LEFT JOIN invoices invoice ON invoice.id = dispute.invoice_id
       WHERE dispute.organization_id = ?${id ? " AND dispute.id = ?" : ""}
       ORDER BY dispute.updated_at DESC, dispute.id DESC LIMIT 100`,
    )
    .bind(...(id ? [organizationId, id] : [organizationId]))
    .all<DisputeRow>();
  if (id && rows.results.length === 0) {
    throw new ApiError(404, "payment_dispute_not_found", "Payment dispute was not found");
  }
  const serialized = rows.results.map((row) => ({
    lago_id: row.id,
    provider: row.provider,
    provider_account_code: row.provider_account_code,
    provider_dispute_id: row.provider_dispute_id,
    payment_id: row.payment_attempt_id,
    invoice_id: row.invoice_id,
    invoice_number: row.invoice_number,
    provider_payment_intent_id: row.provider_payment_intent_id,
    provider_charge_id: row.provider_charge_id,
    amount_cents: row.amount_minor,
    currency: row.currency,
    reason: row.reason,
    status: row.status,
    evidence_due_by: row.evidence_due_by,
    livemode: row.livemode === 1,
    provider_created_at: row.provider_created_at,
    updated_at: row.updated_at,
  }));
  return json(
    id
      ? { payment_dispute: serialized[0] }
      : { payment_disputes: serialized, meta: { current_page: 1, total_pages: 1 } },
    { requestId },
  );
}

async function refunds(
  database: D1Database,
  organizationId: string,
  id: string | null,
  requestId: string,
): Promise<Response> {
  const rows = await database
    .prepare(
      `SELECT refund.id, refund.credit_note_id, note.number AS credit_note_number,
              refund.invoice_id, invoice.number AS invoice_number, refund.payment_attempt_id,
              refund.provider, refund.provider_account_code, refund.provider_payment_id,
              refund.provider_refund_id, refund.amount_minor, refund.currency, refund.status,
              refund.failure_code, refund.failure_message, refund.created_at, refund.updated_at
       FROM provider_refund_operations refund
       JOIN invoices invoice ON invoice.id = refund.invoice_id
       LEFT JOIN credit_notes note ON note.id = refund.credit_note_id
       WHERE refund.organization_id = ?${id ? " AND refund.id = ?" : ""}
       ORDER BY refund.updated_at DESC, refund.id DESC LIMIT 100`,
    )
    .bind(...(id ? [organizationId, id] : [organizationId]))
    .all<RefundRow>();
  if (id && rows.results.length === 0) {
    throw new ApiError(404, "provider_refund_not_found", "Provider refund was not found");
  }
  const serialized = rows.results.map((row) => ({
    lago_id: row.id,
    credit_note_id: row.credit_note_id,
    credit_note_number: row.credit_note_number,
    invoice_id: row.invoice_id,
    invoice_number: row.invoice_number,
    payment_id: row.payment_attempt_id,
    provider: row.provider,
    provider_account_code: row.provider_account_code,
    provider_payment_id: row.provider_payment_id,
    provider_refund_id: row.provider_refund_id,
    amount_cents: row.amount_minor,
    currency: row.currency,
    status: row.status,
    failure_code: row.failure_code,
    failure_message: row.failure_message,
    created_at: row.created_at,
    updated_at: row.updated_at,
  }));
  return json(
    id
      ? { provider_refund: serialized[0] }
      : { provider_refunds: serialized, meta: { current_page: 1, total_pages: 1 } },
    { requestId },
  );
}
