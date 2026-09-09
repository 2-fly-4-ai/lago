import type { DomainEvent } from "../domain-events";
import { deterministicUuid } from "../identifiers";
import { stableJson } from "../json";
import { NO_IN_FLIGHT_EPD_PAYMENT_FOR_INVOICE_SQL } from "../billing/easy-pay-direct-in-flight";
import { easyPayDirectCustomerCurrencyEligibilitySql } from "../billing/easy-pay-direct-recovery-policy";
import {
  automaticCollectionScopeMode,
  configuredAutomaticCollectionScope,
  recurringSubscriptionEligibilitySql,
  savedProfileEligibilitySql,
} from "../billing/easy-pay-direct-renewal-eligibility";

type DunningEnv = Pick<Env, "BILLING_DB"> &
  Partial<
    Pick<
      Env,
      | "EASY_PAY_DIRECT_AUTOMATIC_COLLECTION_ENABLED"
      | "EASY_PAY_DIRECT_AUTOMATIC_COLLECTION_SCOPE_MODE"
      | "EASY_PAY_DIRECT_ORGANIZATION_ID"
      | "EASY_PAY_DIRECT_ACCOUNT_CODE"
    >
  >;

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
  payment_provider: string | null;
  provider_account_code: string;
  threshold_minor: number;
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
  env: DunningEnv,
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
      const outcome = await createDunningPaymentRequest(env, candidate, triggeredAt, correlationId);
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
              campaign.max_attempts, customer.payment_provider, threshold.amount_minor AS threshold_minor,
              COALESCE(customer.payment_provider_code, 'default') AS provider_account_code
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
         AND (COALESCE(customer.payment_provider, '') <> 'easy_pay_direct'
           OR (${easyPayDirectCustomerCurrencyEligibilitySql("customer", "customer.currency")}))
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
             AND ${NO_IN_FLIGHT_EPD_PAYMENT_FOR_INVOICE_SQL}
         ), 0)
       ORDER BY customer.id LIMIT 100`,
    )
    .bind(cursor, triggeredAt)
    .all<DunningCandidate>();
  return rows.results;
}

async function createDunningPaymentRequest(
  env: DunningEnv,
  candidate: DunningCandidate,
  triggeredAt: string,
  correlationId: string,
): Promise<{ created: boolean; finished: boolean }> {
  const database = env.BILLING_DB;
  const invoices = await database
    .prepare(
      `SELECT invoice.id, invoice.version,
${outstandingInvoiceMinorSql()} AS outstanding_minor
       FROM invoices invoice
       WHERE invoice.customer_id = ? AND invoice.organization_id = ? AND invoice.currency = ?
         AND invoice.status = 'finalized' AND invoice.payment_status <> 'succeeded'
         AND invoice.payment_overdue = 1
         AND invoice.ready_for_payment_processing = 1
         AND ${NO_IN_FLIGHT_EPD_PAYMENT_FOR_INVOICE_SQL}
       ORDER BY invoice.created_at, invoice.id`,
    )
    .bind(candidate.customer_id, candidate.organization_id, candidate.currency)
    .all<DueInvoice>();
  let dueInvoices = invoices.results.filter((invoice) => invoice.outstanding_minor > 0);
  let selectedProfileId: string | null = null;
  if (candidate.payment_provider === "easy_pay_direct") {
    const configuredScope = configuredAutomaticCollectionScope(env);
    if (
      !configuredScope ||
      candidate.organization_id !== configuredScope.organizationId ||
      candidate.provider_account_code !== configuredScope.accountCode
    )
      return { created: false, finished: false };
    if (String(env.EASY_PAY_DIRECT_AUTOMATIC_COLLECTION_ENABLED) !== "1")
      return { created: false, finished: false };
    const mode = automaticCollectionScopeMode(env);
    const eligible = await database
      .prepare(
        `SELECT invoice.id, profile.id AS profile_id
${eligibleEpdDunningInvoicesSql(mode)}`,
      )
      .bind(candidate.organization_id, candidate.customer_id, mode)
      .all<{ id: string; profile_id: string }>();
    const profiles = new Map(eligible.results.map((row) => [row.id, row.profile_id]));
    dueInvoices = dueInvoices.filter((invoice) => profiles.has(invoice.id));
    if (dueInvoices.length === 0) return { created: false, finished: false };
    if (new Set(dueInvoices.map((invoice) => profiles.get(invoice.id))).size > 1) {
      await database
        .prepare(
          `INSERT INTO epd_dunning_review_holds
         (organization_id, customer_id, dunning_campaign_id, reason, status, created_at, updated_at, resolved_at)
         VALUES (?, ?, ?, 'multiple_eligible_provider_profiles', 'held', ?, ?, NULL)
         ON CONFLICT(organization_id, customer_id, dunning_campaign_id) DO UPDATE
         SET status = 'held', updated_at = excluded.updated_at, resolved_at = NULL`,
        )
        .bind(
          candidate.organization_id,
          candidate.customer_id,
          candidate.campaign_id,
          triggeredAt,
          triggeredAt,
        )
        .run();
      return { created: false, finished: false };
    }
    selectedProfileId = profiles.get(dueInvoices[0]!.id)!;
  }
  if (dueInvoices.length === 0) return { created: false, finished: false };
  const amountMinor = dueInvoices.reduce(
    (sum, invoice) => safeAdd(sum, invoice.outstanding_minor),
    0,
  );
  if (candidate.payment_provider === "easy_pay_direct" && amountMinor < candidate.threshold_minor)
    return { created: false, finished: false };
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
  if (selectedProfileId) {
    const mode = automaticCollectionScopeMode(env);
    const expectedInvoices = stableJson(dueInvoices);
    // No ledger triggers: this named CHECK aborts the whole D1 batch when any
    // pre-read invoice, balance, profile, scope or closure evidence has changed.
    statements.unshift(
      database
        .prepare(
          `INSERT INTO epd_dunning_attempt_fences (guard_id, eligible)
       SELECT ?, CASE WHEN (
         SELECT COUNT(*) ${eligibleEpdDunningInvoicesSql(mode)}
         AND profile.id = ? AND invoice.currency = ?
         AND invoice.status = 'finalized' AND invoice.payment_status <> 'succeeded'
         AND invoice.payment_overdue = 1 AND invoice.ready_for_payment_processing = 1
         AND ${NO_IN_FLIGHT_EPD_PAYMENT_FOR_INVOICE_SQL}
         AND EXISTS (SELECT 1 FROM json_each(?) selected
           WHERE json_extract(selected.value, '$.id') = invoice.id
             AND json_extract(selected.value, '$.version') = invoice.version
             AND json_extract(selected.value, '$.outstanding_minor') = (${outstandingInvoiceMinorSql()}))
       ) = json_array_length(?)
       AND ? >= (SELECT amount_minor FROM dunning_campaign_thresholds WHERE id = ?
         AND organization_id = ? AND deleted_at IS NULL)
       THEN 1 ELSE 0 END`,
        )
        .bind(
          guardId,
          candidate.organization_id,
          candidate.customer_id,
          mode,
          selectedProfileId,
          candidate.currency,
          expectedInvoices,
          expectedInvoices,
          amountMinor,
          candidate.threshold_id,
          candidate.organization_id,
        ),
    );
    statements.push(
      database
        .prepare(`UPDATE epd_dunning_review_holds
        SET status = 'resolved', resolved_at = ?, updated_at = ?
        WHERE organization_id = ? AND customer_id = ? AND dunning_campaign_id = ? AND status = 'held'`)
        .bind(
          triggeredAt,
          triggeredAt,
          candidate.organization_id,
          candidate.customer_id,
          candidate.campaign_id,
        ),
      database.prepare("DELETE FROM epd_dunning_attempt_fences WHERE guard_id = ?").bind(guardId),
    );
  }
  try {
    const results = await database.batch(statements);
    const customerUpdateIndex = 2 + dueInvoices.length + (selectedProfileId ? 1 : 0);
    if (results[customerUpdateIndex]?.meta.changes !== 1) {
      throw new Error("dunning_attempt_conflict");
    }
  } catch (error) {
    if (error instanceof Error && error.message.includes("epd_dunning_eligibility_current"))
      return { created: false, finished: false };
    const replay = await database
      .prepare("SELECT id FROM payment_requests WHERE id = ? LIMIT 1")
      .bind(paymentRequestId)
      .first();
    if (replay) return { created: false, finished };
    throw error;
  }
  return { created: true, finished };
}

function outstandingInvoiceMinorSql(): string {
  return `invoice.total_due_minor - COALESCE((
                SELECT SUM(amount_minor) FROM (
                  SELECT payment.amount_minor FROM payment_attempts payment
                  WHERE payment.invoice_id = invoice.id AND payment.status = 'succeeded'
                    AND payment.organization_id = invoice.organization_id
                    AND NOT EXISTS (
                      SELECT 1 FROM payment_request_payment_allocations mirror
                      JOIN payment_request_payments source ON source.id = mirror.payment_request_payment_id
                        AND source.organization_id = mirror.organization_id
                      WHERE mirror.invoice_id = invoice.id
                        AND mirror.organization_id = invoice.organization_id
                        AND source.provider = payment.provider
                        AND source.provider_account_code = payment.provider_account_code
                        AND source.provider_transaction_id = payment.provider_transaction_id
                    )
                  UNION ALL
                  SELECT allocation.amount_minor FROM payment_request_payment_allocations allocation
                  WHERE allocation.invoice_id = invoice.id
                    AND allocation.organization_id = invoice.organization_id
                )
              ), 0)`;
}

function eligibleEpdDunningInvoicesSql(
  mode: ReturnType<typeof automaticCollectionScopeMode>,
): string {
  return `       FROM invoices invoice
       JOIN customers customer ON customer.id = invoice.customer_id
         AND customer.organization_id = invoice.organization_id
       JOIN subscriptions subscription ON subscription.id = invoice.subscription_id
         AND subscription.organization_id = invoice.organization_id
         AND subscription.customer_id = invoice.customer_id
       JOIN plans plan ON plan.id = subscription.plan_id AND plan.organization_id = invoice.organization_id
       JOIN provider_customer_profiles profile ON profile.id = subscription.payment_method_id
         AND profile.organization_id = invoice.organization_id AND profile.customer_id = customer.id
         AND profile.provider = 'easy_pay_direct' AND profile.status = 'active'
         AND profile.provider_account_code = COALESCE(customer.payment_provider_code, 'default')
       WHERE invoice.organization_id = ? AND invoice.customer_id = ?
         AND customer.payment_provider = 'easy_pay_direct'
         AND plan.currency = invoice.currency
         AND ${easyPayDirectCustomerCurrencyEligibilitySql("customer", "invoice.currency")}
         AND ${savedProfileEligibilitySql()}
         AND NOT EXISTS (SELECT 1 FROM customer_closure_holds h WHERE h.customer_id = customer.id)
         AND NOT EXISTS (SELECT 1 FROM customer_closure_email_holds h
           WHERE h.organization_id = customer.organization_id AND h.email = lower(customer.email))
         AND ${recurringSubscriptionEligibilitySql(mode)}`;
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
