import type { DomainEvent } from "../domain-events";
import { deterministicUuid } from "../identifiers";
import { stableJson } from "../json";
import {
  applicableUsageThresholds,
  passedUsageThresholds,
  type UsageThresholdRow,
} from "../usage/thresholds";
import { refreshLifetimeUsage } from "../usage/lifetime-usage";
import { couponCreditStatements } from "./coupon-credits";
import { creditNoteAllocationStatements } from "./credit-note-credits";
import { manualTaxStatements } from "./manual-taxes";
import { paymentDueDate } from "./payment-terms";
import { localDateString } from "./periods";
import { prepareProgressiveCreditNote, progressiveCreditForLines } from "./progressive-credit";
import {
  calculateInvoiceAllocations,
  calculateSubscriptionInvoice,
  findBillableSubscription,
  invoiceSubscriptionStatement,
  subscriptionInvoiceLineStatements,
} from "./subscription-invoice-calculation";
import { walletAllocationStatements } from "./wallet-credits";

export type ProgressiveBillingCandidate = {
  subscriptionId: string;
  organizationId: string;
  externalSubscriptionId: string;
};

export type ProgressiveBillingResult = {
  invoiceId: string;
  replayed: boolean;
  grossUsageMinor: number;
  progressiveCreditMinor: number;
  totalDueMinor: number;
  thresholdIds: string[];
};

export async function progressiveBillingCandidates(
  database: D1Database,
  limit = 100,
): Promise<ProgressiveBillingCandidate[]> {
  const result = await database
    .prepare(
      `SELECT subscription.id AS subscription_id,
              subscription.organization_id,
              subscription.external_id
       FROM subscriptions subscription
       JOIN lifetime_usages lifetime ON lifetime.subscription_id = subscription.id
       WHERE subscription.status = 'active'
         AND EXISTS (
           SELECT 1 FROM usage_thresholds threshold
           WHERE threshold.organization_id = subscription.organization_id
             AND threshold.deleted_at IS NULL
             AND (threshold.subscription_id = subscription.id OR threshold.plan_id = subscription.plan_id)
         )
       ORDER BY lifetime.updated_at, subscription.id LIMIT ?`,
    )
    .bind(limit)
    .all<{
      subscription_id: string;
      organization_id: string;
      external_id: string;
    }>();
  return result.results.map((row) => ({
    subscriptionId: row.subscription_id,
    organizationId: row.organization_id,
    externalSubscriptionId: row.external_id,
  }));
}

export async function createProgressiveBillingInvoice(
  env: Env,
  candidate: ProgressiveBillingCandidate,
  checkedAt = new Date().toISOString(),
  correlationId = `progressive:${candidate.subscriptionId}:${checkedAt}`,
): Promise<ProgressiveBillingResult | null> {
  const subscription = await findBillableSubscription(env.BILLING_DB, candidate.subscriptionId);
  if (!subscription) return null;
  const lifetime = await refreshLifetimeUsage(
    env.BILLING_DB,
    candidate.organizationId,
    candidate.externalSubscriptionId,
    checkedAt,
  );
  if (!lifetime) return null;
  const thresholds = await applicableUsageThresholds(
    env.BILLING_DB,
    candidate.organizationId,
    subscription.id,
    subscription.plan_id,
  );
  if (thresholds.length === 0) return null;
  const latest = await latestProgressiveInvoice(
    env.BILLING_DB,
    subscription.id,
    subscription.current_period_start,
    subscription.current_period_end,
  );
  const passed = passedUsageThresholds(thresholds, {
    historicalUsageMinor: lifetime.historical_usage_amount_minor,
    invoicedUsageMinor: lifetime.invoiced_usage_amount_minor,
    currentUsageMinor: lifetime.current_usage_amount_minor,
    progressiveBilledUsageMinor: latest?.gross_usage_amount_minor ?? 0,
  });
  if (passed.length === 0) return null;

  const calculatedThrough = clampCalculationTimestamp(
    checkedAt,
    subscription.current_period_start,
    subscription.current_period_end,
  );
  const crossingKey = thresholdCrossingKey(lifetime, passed, latest?.invoice_id ?? null);
  const invoiceId = await deterministicUuid(
    "progressive-billing-invoice",
    `${subscription.id}:${subscription.current_period_start}:${crossingKey}`,
  );
  const replay = await findProgressiveResult(env.BILLING_DB, invoiceId);
  if (replay) return { ...replay, replayed: true };

  const usageCalculation = await calculateSubscriptionInvoice(
    env.BILLING_DB,
    subscription,
    invoiceId,
    invoiceId,
    subscription.current_period_start,
    subscription.current_period_end,
    { context: "progressive", calculatedThrough },
  );
  const lines = usageCalculation.lines;
  const grossUsageMinor = usageCalculation.subtotalMinor;
  const priorCredit = await progressiveCreditForLines(
    env.BILLING_DB,
    subscription.id,
    subscription.current_period_start,
    subscription.current_period_end,
    lines,
  );
  const progressiveCreditMinor = priorCredit?.appliedCreditMinor ?? 0;
  const allocation = await calculateInvoiceAllocations(
    env.BILLING_DB,
    subscription,
    invoiceId,
    lines,
    undefined,
    progressiveCreditMinor,
  );
  const now = checkedAt;
  const correctionCreditNote =
    priorCredit && priorCredit.excessCreditMinor > 0
      ? await prepareProgressiveCreditNote(env.BILLING_DB, {
          organizationId: subscription.organization_id,
          sourceInvoiceId: priorCredit.invoiceId,
          amountMinor: priorCredit.excessCreditMinor,
          correctionInvoiceId: invoiceId,
          createdAt: now,
          correlationId,
        })
      : null;
  const issuingDate = localDateString(new Date(checkedAt), subscription.billing_timezone);
  const dueDate = paymentDueDate(issuingDate, subscription.net_payment_term);
  const invoiceNumber = invoiceId.replaceAll("-", "").slice(0, 20).toUpperCase();
  const lifetimeUsageMinor = safeAdd(
    lifetime.historical_usage_amount_minor,
    safeAdd(lifetime.invoiced_usage_amount_minor, lifetime.current_usage_amount_minor),
  );
  const invoiceEvent = invoiceDomainEvent(
    invoiceId,
    subscription.organization_id,
    subscription.id,
    allocation.totalDueMinor,
    subscription.currency,
    correlationId,
    now,
  );
  const thresholdEvents = passed.map((threshold) =>
    thresholdDomainEvent(
      threshold,
      subscription.organization_id,
      subscription.id,
      candidate.externalSubscriptionId,
      invoiceId,
      lifetimeUsageMinor,
      correlationId,
      now,
    ),
  );
  const appliedThresholds = await Promise.all(
    passed.map(async (threshold) => ({
      id: await deterministicUuid("applied-usage-threshold", `${invoiceId}:${threshold.id}`),
      threshold,
    })),
  );
  const couponStatements = couponCreditStatements(
    env.BILLING_DB,
    subscription.organization_id,
    invoiceId,
    subscription.currency,
    allocation.couponCredits,
    now,
    correlationId,
  );
  const correctionPrefixCount =
    (correctionCreditNote?.statements.length ?? 0) + (correctionCreditNote ? 1 : 0);
  const statements: D1PreparedStatement[] = [
    ...(correctionCreditNote?.statements ?? []),
    ...(correctionCreditNote
      ? [outboxStatement(env.BILLING_DB, subscription.organization_id, correctionCreditNote.event)]
      : []),
    env.BILLING_DB.prepare(
      `INSERT INTO invoices
       (id, organization_id, customer_id, subscription_id, number, status, payment_status,
        currency, subtotal_minor, tax_minor, credits_minor, total_due_minor, version,
        finalized_at, issuing_date, created_at, updated_at, coupons_minor, prepaid_credit_minor,
        credit_notes_minor, net_payment_term, payment_due_date, payment_overdue,
        expected_finalization_date, applied_grace_period, ready_to_be_refreshed,
        last_refreshed_at, invoice_type, progressive_billing_credit_minor)
       VALUES (?, ?, ?, ?, ?, 'finalized', ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0,
               ?, 0, 0, NULL, 'subscription', ?)`,
    ).bind(
      invoiceId,
      subscription.organization_id,
      subscription.customer_id,
      subscription.id,
      invoiceNumber,
      allocation.totalDueMinor > 0 ? "pending" : "succeeded",
      subscription.currency,
      allocation.subtotalMinor,
      allocation.taxMinor,
      allocation.creditsMinor,
      allocation.totalDueMinor,
      now,
      issuingDate,
      now,
      now,
      allocation.couponsMinor,
      allocation.prepaidCreditMinor,
      allocation.creditNotesMinor,
      subscription.net_payment_term,
      dueDate,
      issuingDate,
      progressiveCreditMinor,
    ),
    ...subscriptionInvoiceLineStatements(env.BILLING_DB, invoiceId, null, lines, now),
    ...couponStatements,
    ...manualTaxStatements(
      env.BILLING_DB,
      subscription.organization_id,
      invoiceId,
      subscription.currency,
      allocation.invoiceTaxes,
      now,
    ),
    ...allocation.creditNoteAllocations.flatMap((credit) =>
      creditNoteAllocationStatements(
        env.BILLING_DB,
        subscription.organization_id,
        invoiceId,
        credit,
        now,
        correlationId,
      ),
    ),
    ...allocation.walletAllocations.flatMap((wallet) =>
      walletAllocationStatements(
        env.BILLING_DB,
        subscription.organization_id,
        invoiceId,
        wallet,
        now,
        correlationId,
      ),
    ),
    invoiceSubscriptionStatement(
      env.BILLING_DB,
      invoiceId,
      subscription.id,
      subscription.organization_id,
      "subscription_periodic",
      subscription.current_period_start,
      subscription.current_period_end,
      now,
    ),
    env.BILLING_DB.prepare(
      `INSERT INTO progressive_billing_invoices
       (invoice_id, organization_id, subscription_id, period_start, period_end,
        lifetime_usage_amount_minor, gross_usage_amount_minor, prior_progressive_credit_minor,
        threshold_crossing_key, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      invoiceId,
      subscription.organization_id,
      subscription.id,
      subscription.current_period_start,
      subscription.current_period_end,
      lifetimeUsageMinor,
      grossUsageMinor,
      progressiveCreditMinor,
      crossingKey,
      now,
    ),
    ...appliedThresholds.map(({ id, threshold }) =>
      env.BILLING_DB.prepare(
        `INSERT INTO applied_usage_thresholds
         (id, organization_id, usage_threshold_id, invoice_id,
          lifetime_usage_amount_minor, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).bind(
        id,
        subscription.organization_id,
        threshold.id,
        invoiceId,
        lifetimeUsageMinor,
        now,
        now,
      ),
    ),
    ...(priorCredit && progressiveCreditMinor > 0
      ? [
          env.BILLING_DB.prepare(
            `INSERT INTO progressive_billing_credits
             (invoice_id, progressive_invoice_id, organization_id, subscription_id,
              amount_minor, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
          ).bind(
            invoiceId,
            priorCredit.invoiceId,
            subscription.organization_id,
            subscription.id,
            progressiveCreditMinor,
            now,
          ),
        ]
      : []),
    outboxStatement(env.BILLING_DB, subscription.organization_id, invoiceEvent),
    ...thresholdEvents.map((event) =>
      outboxStatement(env.BILLING_DB, subscription.organization_id, event),
    ),
  ];

  try {
    const results = await env.BILLING_DB.batch(statements);
    const firstCouponUpdate = correctionPrefixCount + 1 + lines.length;
    for (let offset = 0; offset < allocation.couponCredits.length; offset += 1) {
      const update = results[firstCouponUpdate + offset * 3];
      if (!update || update.meta.changes < 1) throw new Error("coupon_version_conflict");
    }
  } catch (error) {
    const concurrent = await findProgressiveResult(env.BILLING_DB, invoiceId);
    if (concurrent) return { ...concurrent, replayed: true };
    throw error;
  }
  await Promise.all([
    ...(correctionCreditNote ? [env.DOMAIN_EVENTS.send(correctionCreditNote.event)] : []),
    env.DOMAIN_EVENTS.send(invoiceEvent),
    ...thresholdEvents.map((event) => env.DOMAIN_EVENTS.send(event)),
  ]);
  return {
    invoiceId,
    replayed: false,
    grossUsageMinor,
    progressiveCreditMinor,
    totalDueMinor: allocation.totalDueMinor,
    thresholdIds: passed.map((threshold) => threshold.id),
  };
}

async function latestProgressiveInvoice(
  database: D1Database,
  subscriptionId: string,
  periodStart: string,
  periodEnd: string,
) {
  return database
    .prepare(
      `SELECT marker.invoice_id, marker.gross_usage_amount_minor
       FROM progressive_billing_invoices marker
       JOIN invoices invoice ON invoice.id = marker.invoice_id
       WHERE marker.subscription_id = ? AND marker.period_start = ? AND marker.period_end = ?
         AND invoice.status IN ('finalized', 'failed')
       ORDER BY marker.created_at DESC, marker.invoice_id DESC LIMIT 1`,
    )
    .bind(subscriptionId, periodStart, periodEnd)
    .first<{ invoice_id: string; gross_usage_amount_minor: number }>();
}

async function findProgressiveResult(
  database: D1Database,
  invoiceId: string,
): Promise<Omit<ProgressiveBillingResult, "replayed"> | null> {
  const row = await database
    .prepare(
      `SELECT marker.invoice_id, marker.gross_usage_amount_minor,
              marker.prior_progressive_credit_minor, invoice.total_due_minor
       FROM progressive_billing_invoices marker
       JOIN invoices invoice ON invoice.id = marker.invoice_id
       WHERE marker.invoice_id = ? LIMIT 1`,
    )
    .bind(invoiceId)
    .first<{
      invoice_id: string;
      gross_usage_amount_minor: number;
      prior_progressive_credit_minor: number;
      total_due_minor: number;
    }>();
  if (!row) return null;
  const thresholds = await database
    .prepare(
      `SELECT usage_threshold_id FROM applied_usage_thresholds
       WHERE invoice_id = ? ORDER BY usage_threshold_id`,
    )
    .bind(invoiceId)
    .all<{ usage_threshold_id: string }>();
  return {
    invoiceId: row.invoice_id,
    grossUsageMinor: row.gross_usage_amount_minor,
    progressiveCreditMinor: row.prior_progressive_credit_minor,
    totalDueMinor: row.total_due_minor,
    thresholdIds: thresholds.results.map((threshold) => threshold.usage_threshold_id),
  };
}

function thresholdCrossingKey(
  lifetime: {
    historical_usage_amount_minor: number;
    invoiced_usage_amount_minor: number;
  },
  thresholds: UsageThresholdRow[],
  previousInvoiceId: string | null,
): string {
  const thresholdIds = thresholds.map((threshold) => threshold.id).join(",");
  return stableJson({
    historicalUsageMinor: lifetime.historical_usage_amount_minor,
    invoicedUsageMinor: lifetime.invoiced_usage_amount_minor,
    previousInvoiceId,
    thresholdIds,
  });
}

function clampCalculationTimestamp(value: string, periodStart: string, periodEnd: string): string {
  const valueMs = Date.parse(value);
  const startMs = Date.parse(periodStart);
  const endMs = Date.parse(periodEnd);
  if (![valueMs, startMs, endMs].every(Number.isFinite) || endMs <= startMs) {
    throw new Error("invalid_progressive_billing_period");
  }
  return new Date(Math.min(endMs, Math.max(startMs, valueMs))).toISOString();
}

function invoiceDomainEvent(
  invoiceId: string,
  organizationId: string,
  subscriptionId: string,
  totalDueMinor: number,
  currency: string,
  correlationId: string,
  occurredAt: string,
): DomainEvent {
  return {
    id: `invoice-finalized:${invoiceId}:v1`,
    type: "invoice.finalized",
    version: 1,
    aggregateType: "invoice",
    aggregateId: invoiceId,
    aggregateVersion: 1,
    occurredAt,
    causationId: correlationId,
    correlationId,
    payload: {
      organizationId,
      subscriptionId,
      invoiceType: "progressive_billing",
      totalDueMinor,
      currency,
    },
  };
}

function thresholdDomainEvent(
  threshold: UsageThresholdRow,
  organizationId: string,
  subscriptionId: string,
  externalSubscriptionId: string,
  invoiceId: string,
  lifetimeUsageMinor: number,
  correlationId: string,
  occurredAt: string,
): DomainEvent {
  return {
    id: `subscription-usage-threshold-reached:${invoiceId}:${threshold.id}`,
    type: "subscription.usage_threshold_reached",
    version: 1,
    aggregateType: "subscription",
    aggregateId: subscriptionId,
    aggregateVersion: threshold.version,
    occurredAt,
    causationId: invoiceId,
    correlationId,
    payload: {
      organizationId,
      subscriptionId,
      externalSubscriptionId,
      invoiceId,
      lifetimeUsageAmountCents: lifetimeUsageMinor,
      usageThreshold: {
        lago_id: threshold.id,
        amount_cents: threshold.amount_minor,
        recurring: threshold.recurring === 1,
        threshold_display_name: threshold.threshold_display_name,
      },
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
       (event_id, organization_id, event_type, event_version, aggregate_type,
        aggregate_id, aggregate_version, causation_id, correlation_id, payload_json,
        occurred_at, published_at)
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
  const total = left + right;
  if (!Number.isSafeInteger(total) || total < 0) throw new Error("invalid_progressive_amount");
  return total;
}
