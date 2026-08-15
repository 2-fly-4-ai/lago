import type { DomainEvent } from "../domain-events";
import { deterministicUuid } from "../identifiers";
import { stableJson } from "../json";

type DunningCandidate = {
  customer_id: string;
  organization_id: string;
  customer_email: string | null;
  currency: string;
  customer_version: number;
  campaign_id: string;
  campaign_code: string;
  threshold_id: string;
  last_attempt: number;
  last_attempt_at: string | null;
  max_attempts: number;
};

type DueInvoice = {
  id: string;
  version: number;
  outstanding_minor: number;
};

export type DunningRun = {
  candidates: number;
  requestsCreated: number;
  campaignsFinished: number;
};

export async function processDunningCampaigns(
  env: Pick<Env, "BILLING_DB">,
  triggeredAt: string,
  correlationId: string,
): Promise<DunningRun> {
  if (!Number.isFinite(Date.parse(triggeredAt))) throw new Error("invalid_dunning_time");
  const result: DunningRun = { candidates: 0, requestsCreated: 0, campaignsFinished: 0 };
  let cursor = "";
  for (;;) {
    const candidates = await dueDunningCandidates(env.BILLING_DB, triggeredAt, cursor);
    if (candidates.length === 0) break;
    for (const candidate of candidates) {
      result.candidates += 1;
      const outcome = await createDunningPaymentRequest(
        env.BILLING_DB,
        candidate,
        triggeredAt,
        correlationId,
      );
      if (outcome.created) result.requestsCreated += 1;
      if (outcome.finished) result.campaignsFinished += 1;
    }
    cursor = candidates.at(-1)!.customer_id;
  }
  return result;
}

async function dueDunningCandidates(
  database: D1Database,
  triggeredAt: string,
  cursor: string,
): Promise<DunningCandidate[]> {
  const rows = await database
    .prepare(
      `SELECT customer.id AS customer_id, customer.organization_id,
              customer.email AS customer_email, customer.currency,
              customer.version AS customer_version,
              campaign.id AS campaign_id, campaign.code AS campaign_code,
              threshold.id AS threshold_id,
              customer.last_dunning_campaign_attempt AS last_attempt,
              customer.last_dunning_campaign_attempt_at AS last_attempt_at,
              campaign.max_attempts
       FROM customers customer
       JOIN organizations organization ON organization.id = customer.organization_id
       JOIN dunning_campaigns campaign
         ON campaign.id = COALESCE(customer.applied_dunning_campaign_id,
                                   organization.applied_dunning_campaign_id)
       JOIN dunning_campaign_thresholds threshold
         ON threshold.dunning_campaign_id = campaign.id
        AND threshold.currency = customer.currency
        AND threshold.deleted_at IS NULL
       WHERE customer.id > ? AND customer.exclude_from_dunning_campaign = 0
         AND campaign.active = 1
         AND customer.last_dunning_campaign_attempt < campaign.max_attempts
         AND (
           customer.last_dunning_campaign_attempt_at IS NULL OR
           datetime(customer.last_dunning_campaign_attempt_at,
                    printf('+%d days', campaign.days_between_attempts)) <= datetime(?)
         )
         AND threshold.amount_minor <= COALESCE((
           SELECT SUM(invoice.total_due_minor)
           FROM invoices invoice
           WHERE invoice.customer_id = customer.id
             AND invoice.organization_id = customer.organization_id
             AND invoice.currency = customer.currency
             AND invoice.status = 'finalized'
             AND invoice.payment_status <> 'succeeded'
             AND invoice.payment_overdue = 1
             AND invoice.ready_for_payment_processing = 1
         ), 0)
       ORDER BY customer.id LIMIT 100`,
    )
    .bind(cursor, triggeredAt)
    .all<DunningCandidate>();
  return rows.results;
}

async function createDunningPaymentRequest(
  database: D1Database,
  candidate: DunningCandidate,
  triggeredAt: string,
  correlationId: string,
): Promise<{ created: boolean; finished: boolean }> {
  const invoices = await database
    .prepare(
      `SELECT invoice.id, invoice.version,
              invoice.total_due_minor - COALESCE((
                SELECT SUM(amount_minor) FROM (
                  SELECT payment.amount_minor FROM payment_attempts payment
                  WHERE payment.invoice_id = invoice.id AND payment.status = 'succeeded'
                  UNION ALL
                  SELECT allocation.amount_minor FROM payment_request_payment_allocations allocation
                  WHERE allocation.invoice_id = invoice.id
                )
              ), 0) AS outstanding_minor
       FROM invoices invoice
       WHERE invoice.customer_id = ? AND invoice.organization_id = ? AND invoice.currency = ?
         AND invoice.status = 'finalized' AND invoice.payment_status <> 'succeeded'
         AND invoice.payment_overdue = 1
         AND invoice.ready_for_payment_processing = 1
       ORDER BY invoice.created_at, invoice.id`,
    )
    .bind(candidate.customer_id, candidate.organization_id, candidate.currency)
    .all<DueInvoice>();
  const dueInvoices = invoices.results.filter((invoice) => invoice.outstanding_minor > 0);
  if (dueInvoices.length === 0) return { created: false, finished: false };
  const amountMinor = dueInvoices.reduce(
    (sum, invoice) => safeAdd(sum, invoice.outstanding_minor),
    0,
  );
  const attempt = candidate.last_attempt + 1;
  const paymentRequestId = await deterministicUuid(
    "dunning-payment-request",
    `${candidate.organization_id}:${candidate.customer_id}:${candidate.campaign_id}:${attempt}`,
  );
  const existing = await database
    .prepare("SELECT id FROM payment_requests WHERE id = ? LIMIT 1")
    .bind(paymentRequestId)
    .first();
  if (existing) return { created: false, finished: false };
  const guardId = `${correlationId}:${candidate.customer_id}:attempt:${attempt}`;
  const event = paymentRequestEvent(
    paymentRequestId,
    candidate,
    dueInvoices.map((invoice) => invoice.id),
    amountMinor,
    attempt,
    triggeredAt,
    correlationId,
  );
  const finished = attempt >= candidate.max_attempts;
  const finishedEvent = finished
    ? campaignFinishedEvent(candidate, attempt, triggeredAt, correlationId)
    : null;
  const statements: D1PreparedStatement[] = [
    database
      .prepare(
        `INSERT INTO dunning_attempt_guards
         (run_id, organization_id, customer_id, dunning_campaign_id,
          dunning_campaign_threshold_id, expected_customer_version, expected_attempt,
          expected_last_attempt_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        guardId,
        candidate.organization_id,
        candidate.customer_id,
        candidate.campaign_id,
        candidate.threshold_id,
        candidate.customer_version,
        candidate.last_attempt,
        candidate.last_attempt_at,
        triggeredAt,
      ),
    database
      .prepare(
        `INSERT INTO payment_requests
         (id, organization_id, customer_id, amount_minor, currency, email, payment_attempts,
          payment_status, ready_for_payment_processing, version, created_at, updated_at,
          source, dunning_campaign_id, dunning_campaign_threshold_id, dunning_attempt)
         VALUES (?, ?, ?, ?, ?, ?, 0, 'pending', 1, 1, ?, ?, 'dunning', ?, ?, ?)`,
      )
      .bind(
        paymentRequestId,
        candidate.organization_id,
        candidate.customer_id,
        amountMinor,
        candidate.currency,
        candidate.customer_email,
        triggeredAt,
        triggeredAt,
        candidate.campaign_id,
        candidate.threshold_id,
        attempt,
      ),
  ];
  for (const invoice of dueInvoices) {
    statements.push(
      database
        .prepare(
          `INSERT INTO invoices_payment_requests
           (id, organization_id, payment_request_id, invoice_id, invoice_version,
            created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          await deterministicUuid(
            "invoice-payment-request",
            `${candidate.organization_id}:${paymentRequestId}:${invoice.id}`,
          ),
          candidate.organization_id,
          paymentRequestId,
          invoice.id,
          invoice.version,
          triggeredAt,
          triggeredAt,
        ),
    );
  }
  statements.push(
    database
      .prepare(
        `UPDATE customers
         SET last_dunning_campaign_attempt = ?, last_dunning_campaign_attempt_at = ?,
             version = version + 1, updated_at = ?
         WHERE id = ? AND organization_id = ? AND version = ?
           AND last_dunning_campaign_attempt = ?
           AND EXISTS (SELECT 1 FROM dunning_attempt_guards WHERE run_id = ?)`,
      )
      .bind(
        attempt,
        triggeredAt,
        triggeredAt,
        candidate.customer_id,
        candidate.organization_id,
        candidate.customer_version,
        candidate.last_attempt,
        guardId,
      ),
    outboxStatement(database, candidate.organization_id, event),
  );
  if (finishedEvent) {
    statements.push(outboxStatement(database, candidate.organization_id, finishedEvent));
  }
  statements.push(
    database.prepare("DELETE FROM dunning_attempt_guards WHERE run_id = ?").bind(guardId),
  );
  try {
    const results = await database.batch(statements);
    const customerUpdateIndex = 2 + dueInvoices.length;
    if (results[customerUpdateIndex]?.meta.changes !== 1) {
      throw new Error("dunning_attempt_conflict");
    }
  } catch (error) {
    const replay = await database
      .prepare("SELECT id FROM payment_requests WHERE id = ? LIMIT 1")
      .bind(paymentRequestId)
      .first();
    if (replay) return { created: false, finished };
    throw error;
  }
  return { created: true, finished };
}

function paymentRequestEvent(
  paymentRequestId: string,
  candidate: DunningCandidate,
  invoiceIds: string[],
  amountMinor: number,
  attempt: number,
  occurredAt: string,
  correlationId: string,
): DomainEvent {
  return {
    id: `payment-request-created:${paymentRequestId}:v1`,
    type: "payment_request.created",
    version: 1,
    aggregateType: "payment_request",
    aggregateId: paymentRequestId,
    aggregateVersion: 1,
    occurredAt,
    causationId: correlationId,
    correlationId,
    payload: {
      organizationId: candidate.organization_id,
      customerId: candidate.customer_id,
      paymentRequestId,
      dunningCampaignId: candidate.campaign_id,
      dunningAttempt: attempt,
      invoiceIds,
      amountMinor,
      currency: candidate.currency,
    },
  };
}

function campaignFinishedEvent(
  candidate: DunningCandidate,
  attempt: number,
  occurredAt: string,
  correlationId: string,
): DomainEvent {
  return {
    id: `dunning-campaign-finished:${candidate.customer_id}:${candidate.campaign_id}:a${attempt}`,
    type: "dunning_campaign.finished",
    version: 1,
    aggregateType: "customer",
    aggregateId: candidate.customer_id,
    aggregateVersion: candidate.customer_version + 1,
    occurredAt,
    causationId: correlationId,
    correlationId,
    payload: {
      organizationId: candidate.organization_id,
      customerId: candidate.customer_id,
      dunningCampaignId: candidate.campaign_id,
      dunningCampaignCode: candidate.campaign_code,
      attempt,
    },
  };
}

function outboxStatement(
  database: D1Database,
  organizationId: string,
  event: DomainEvent,
): D1PreparedStatement {
  return database
    .prepare(
      `INSERT INTO outbox_events
       (event_id, organization_id, event_type, event_version, aggregate_type, aggregate_id,
        aggregate_version, causation_id, correlation_id, payload_json, occurred_at, published_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
    )
    .bind(
      event.id,
      organizationId,
      event.type,
      event.version,
      event.aggregateType,
      event.aggregateId,
      event.aggregateVersion,
      event.causationId,
      event.correlationId,
      stableJson(event.payload),
      event.occurredAt,
    );
}

function safeAdd(left: number, right: number): number {
  const value = left + right;
  if (!Number.isSafeInteger(value)) throw new Error("dunning_amount_overflow");
  return value;
}
