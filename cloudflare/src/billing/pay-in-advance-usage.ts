import type { DomainEvent } from "../domain-events";
import { deterministicUuid } from "../identifiers";
import { stableJson } from "../json";
import { rateCharge } from "../rating/charge-models";
import { Decimal } from "../rating/decimal";
import {
  aggregateUsageResult,
  type SupportedAggregationType,
  type UsageAggregationEvent,
} from "../usage/aggregation";
import { parseChargeModel } from "../usage/charge-properties";
import {
  parseStoredBillableMetricFilters,
  parseStoredChargeFilters,
  partitionUsageEvents,
  type ChargeFilter,
} from "../usage/charge-filters";
import { couponCreditStatements } from "./coupon-credits";
import { creditNoteAllocationStatements } from "./credit-note-credits";
import { manualTaxStatements } from "./manual-taxes";
import { paymentDueDate } from "./payment-terms";
import { localDateString, type BillingTime } from "./periods";
import {
  calculateInvoiceAllocations,
  invoiceSubscriptionStatement,
  subscriptionInvoiceLineStatements,
  type SubscriptionInvoiceLine,
} from "./subscription-invoice-calculation";
import { walletAllocationStatements } from "./wallet-credits";

type AdvanceUsageEventRow = {
  id: string;
  organization_id: string;
  subscription_id: string;
  customer_id: string;
  billable_metric_id: string;
  transaction_id: string;
  timestamp: string;
  timestamp_ms: number;
  created_at: string;
  properties_json: string;
  plan_id: string;
  current_period_start: string;
  current_period_end: string;
  interval: string;
  currency: string;
  billing_time: BillingTime;
  billing_timezone: string;
  net_payment_term: number;
};

type AdvanceUsageChargeRow = {
  id: string;
  code: string;
  invoice_display_name: string | null;
  charge_model: string;
  properties_json: string;
  filters_json: string;
  accepts_target_wallet: number;
  metric_code: string;
  metric_name: string;
  aggregation_type: string;
  field_name: string | null;
  metric_filters_json: string;
};

type BillingPeriod = { start: string; end: string; startMs: number; endMs: number };

type ExistingBilling = { invoice_id: string };

export type PayInAdvanceUsageProcessingResult = {
  invoiceCount: number;
  replayedCount: number;
};

export async function processPayInAdvanceUsageEvent(
  env: Env,
  usageEventId: string,
  correlationId: string,
): Promise<PayInAdvanceUsageProcessingResult> {
  const event = await loadAdvanceUsageEvent(env.BILLING_DB, usageEventId);
  if (!event) return { invoiceCount: 0, replayedCount: 0 };
  const charges = await loadAdvanceUsageCharges(env.BILLING_DB, event);
  let invoiceCount = 0;
  let replayedCount = 0;
  for (const charge of charges) {
    const existing = await findBilling(env.BILLING_DB, event.id, charge.id);
    if (existing) {
      replayedCount += 1;
      continue;
    }
    const result = await createAdvanceUsageInvoice(env, event, charge, correlationId);
    if (result.replayed) replayedCount += 1;
    else invoiceCount += 1;
  }
  return { invoiceCount, replayedCount };
}

export async function repairPendingPayInAdvanceUsageInvoices(
  env: Env,
  dueAt: string,
  correlationId: string,
): Promise<number> {
  const result = await env.BILLING_DB.prepare(
    `SELECT DISTINCT event.id
     FROM usage_events event
     JOIN subscriptions subscription ON subscription.id = event.subscription_id
     JOIN charges charge ON charge.plan_id = subscription.plan_id
       AND charge.billable_metric_id = event.billable_metric_id
     WHERE event.deleted_at IS NULL AND event.timestamp <= ?
       AND charge.active = 1 AND charge.invoiceable = 1
       AND charge.pay_in_advance = 1 AND charge.prorated = 0
       AND NOT EXISTS (
         SELECT 1 FROM pay_in_advance_usage_billings billing
         WHERE billing.usage_event_id = event.id AND billing.charge_id = charge.id
       )
     ORDER BY event.created_at, event.id LIMIT 100`,
  )
    .bind(dueAt)
    .all<{ id: string }>();
  let invoices = 0;
  for (const event of result.results) {
    invoices += (await processPayInAdvanceUsageEvent(env, event.id, correlationId)).invoiceCount;
  }
  return invoices;
}

async function createAdvanceUsageInvoice(
  env: Env,
  event: AdvanceUsageEventRow,
  charge: AdvanceUsageChargeRow,
  correlationId: string,
): Promise<{ invoiceId: string; replayed: boolean }> {
  const invoiceId = await deterministicUuid(
    "pay-in-advance-usage-invoice",
    `${event.id}:${charge.id}`,
  );
  const existing = await findBilling(env.BILLING_DB, event.id, charge.id);
  if (existing) return { invoiceId: existing.invoice_id, replayed: true };

  const period = await resolveBillingPeriod(env.BILLING_DB, event);
  const events = await loadUsagePrefix(env.BILLING_DB, event, period);
  const filters = parseStoredChargeFilters(
    charge.filters_json,
    parseStoredBillableMetricFilters(charge.metric_filters_json),
    charge.charge_model,
    charge.id,
  );
  const ratedPartition = partitionForEvent(events, event.id, filters, charge.properties_json);
  const targetWalletCode =
    charge.accepts_target_wallet === 1
      ? eventTargetWalletCode(ratedPartition.events.find((candidate) => candidate.id === event.id))
      : null;
  const groupedEvents = ratedPartition.events.filter(
    (candidate) =>
      charge.accepts_target_wallet !== 1 || eventTargetWalletCode(candidate) === targetWalletCode,
  );
  const beforeEvents = groupedEvents.filter((candidate) => candidate.id !== event.id);
  const aggregationType = supportedAdvanceAggregation(charge.aggregation_type);
  const beforeAggregation = aggregateUsageResult(
    aggregationType,
    charge.field_name,
    beforeEvents,
  ).units;
  const afterAggregation = aggregateUsageResult(
    aggregationType,
    charge.field_name,
    groupedEvents,
  ).units;
  // Lago intentionally skips metric aggregation rounding for an event-triggered advance invoice.
  const roundedBefore = nonNegative(beforeAggregation);
  const roundedAfter = nonNegative(afterAggregation);
  const model = parseChargeModel(charge.charge_model, ratedPartition.properties);
  const amountBefore = Decimal.parse(
    rateCharge(roundedBefore.toString(), model, { eventsCount: beforeEvents.length }).amountCents,
  );
  const amountAfter = Decimal.parse(
    rateCharge(roundedAfter.toString(), model, { eventsCount: groupedEvents.length }).amountCents,
  );
  const preciseAmount = nonNegative(amountAfter.subtract(amountBefore));
  const billedUnits = nonNegative(afterAggregation.subtract(beforeAggregation));
  const amountMinor = safeMinorInteger(preciseAmount);
  const lineId = await deterministicUuid("pay-in-advance-usage-line", invoiceId);
  const line: SubscriptionInvoiceLine = {
    id: lineId,
    description:
      ratedPartition.filter?.invoiceDisplayName ??
      charge.invoice_display_name ??
      charge.metric_name,
    units: billedUnits.toString(),
    precise: preciseAmount.toString(),
    rounded: amountMinor,
    sourceId: charge.id,
    lineType: "usage",
    sourceType: "charge",
    billableMetricId: event.billable_metric_id,
    targetWalletCode,
    metadataJson: stableJson({
      contextType: "in_advance_charge",
      billingMode: "in_advance",
      usageEventId: event.id,
      transactionId: event.transaction_id,
      billableMetricCode: charge.metric_code,
      chargeCode: charge.code,
      chargeModel: charge.charge_model,
      chargeFilterId: ratedPartition.filter?.lagoId ?? null,
      targetWalletCode,
      aggregationBefore: beforeAggregation.toString(),
      aggregationAfter: afterAggregation.toString(),
      ratedAggregationBefore: roundedBefore.toString(),
      ratedAggregationAfter: roundedAfter.toString(),
      periodStart: period.start,
      periodEnd: period.end,
    }),
  };
  const calculation = await calculateInvoiceAllocations(env.BILLING_DB, event, invoiceId, [line]);
  const now = new Date().toISOString();
  const issuingDate = localDateString(new Date(event.timestamp), event.billing_timezone);
  const dueDate = paymentDueDate(issuingDate, event.net_payment_term);
  const invoiceEvent: DomainEvent = {
    id: `invoice-finalized:${invoiceId}:v1`,
    type: "invoice.finalized",
    version: 1,
    aggregateType: "invoice",
    aggregateId: invoiceId,
    aggregateVersion: 1,
    occurredAt: now,
    causationId: correlationId,
    correlationId,
    payload: {
      organizationId: event.organization_id,
      subscriptionId: event.subscription_id,
      usageEventId: event.id,
      chargeId: charge.id,
      inAdvanceCharge: true,
      totalDueMinor: calculation.totalDueMinor,
      currency: event.currency,
      periodStart: period.start,
      periodEnd: period.end,
      issuingDate,
    },
  };
  const statements: D1PreparedStatement[] = [
    env.BILLING_DB.prepare(
      `INSERT INTO invoices
       (id, organization_id, customer_id, subscription_id, number, status, payment_status,
        currency, subtotal_minor, tax_minor, credits_minor, total_due_minor, version,
        finalized_at, issuing_date, created_at, updated_at, coupons_minor, prepaid_credit_minor,
        credit_notes_minor, net_payment_term, payment_due_date, payment_overdue,
        expected_finalization_date, applied_grace_period, ready_to_be_refreshed,
        last_refreshed_at)
       VALUES (?, ?, ?, ?, ?, 'finalized', ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0,
               ?, 0, 0, NULL)`,
    ).bind(
      invoiceId,
      event.organization_id,
      event.customer_id,
      event.subscription_id,
      invoiceId.replaceAll("-", "").slice(0, 20).toUpperCase(),
      calculation.totalDueMinor > 0 ? "pending" : "succeeded",
      event.currency,
      calculation.subtotalMinor,
      calculation.taxMinor,
      calculation.creditsMinor,
      calculation.totalDueMinor,
      now,
      issuingDate,
      now,
      now,
      calculation.couponsMinor,
      calculation.prepaidCreditMinor,
      calculation.creditNotesMinor,
      event.net_payment_term,
      dueDate,
      issuingDate,
    ),
    ...subscriptionInvoiceLineStatements(env.BILLING_DB, invoiceId, null, [line], now),
    ...couponCreditStatements(
      env.BILLING_DB,
      event.organization_id,
      invoiceId,
      event.currency,
      calculation.couponCredits,
      now,
      correlationId,
    ),
    ...manualTaxStatements(
      env.BILLING_DB,
      event.organization_id,
      invoiceId,
      event.currency,
      calculation.invoiceTaxes,
      now,
    ),
    ...calculation.creditNoteAllocations.flatMap((allocation) =>
      creditNoteAllocationStatements(
        env.BILLING_DB,
        event.organization_id,
        invoiceId,
        allocation,
        now,
        correlationId,
      ),
    ),
    ...calculation.walletAllocations.flatMap((allocation) =>
      walletAllocationStatements(
        env.BILLING_DB,
        event.organization_id,
        invoiceId,
        allocation,
        now,
        correlationId,
      ),
    ),
    invoiceSubscriptionStatement(
      env.BILLING_DB,
      invoiceId,
      event.subscription_id,
      event.organization_id,
      "subscription_periodic",
      period.start,
      period.end,
      now,
    ),
    env.BILLING_DB.prepare(
      `INSERT INTO pay_in_advance_usage_billings
       (usage_event_id, charge_id, organization_id, subscription_id, invoice_id,
        charge_filter_id, target_wallet_code, period_start, period_end, aggregation_before,
        aggregation_after, billed_units, precise_amount_minor, amount_minor, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      event.id,
      charge.id,
      event.organization_id,
      event.subscription_id,
      invoiceId,
      ratedPartition.filter?.lagoId ?? null,
      targetWalletCode,
      period.start,
      period.end,
      beforeAggregation.toString(),
      afterAggregation.toString(),
      billedUnits.toString(),
      preciseAmount.toString(),
      amountMinor,
      now,
    ),
    env.BILLING_DB.prepare(
      `INSERT INTO outbox_events
       (event_id, organization_id, event_type, event_version, aggregate_type,
        aggregate_id, aggregate_version, causation_id, correlation_id, payload_json,
        occurred_at, published_at)
       VALUES (?, ?, ?, 1, 'invoice', ?, 1, ?, ?, ?, ?, NULL)`,
    ).bind(
      invoiceEvent.id,
      event.organization_id,
      invoiceEvent.type,
      invoiceId,
      correlationId,
      correlationId,
      stableJson(invoiceEvent.payload),
      now,
    ),
  ];

  try {
    await env.BILLING_DB.batch(statements);
  } catch (error) {
    const concurrent = await findBilling(env.BILLING_DB, event.id, charge.id);
    if (!concurrent) throw error;
    return { invoiceId: concurrent.invoice_id, replayed: true };
  }
  await env.DOMAIN_EVENTS.send(invoiceEvent);
  return { invoiceId, replayed: false };
}

async function loadAdvanceUsageEvent(
  database: D1Database,
  usageEventId: string,
): Promise<AdvanceUsageEventRow | null> {
  return database
    .prepare(
      `SELECT event.id, event.organization_id, event.subscription_id, event.customer_id,
              event.billable_metric_id, event.transaction_id, event.timestamp,
              event.timestamp_ms, event.created_at, event.properties_json, subscription.plan_id,
              subscription.current_period_start, subscription.current_period_end,
              plan.interval, plan.currency, subscription.billing_time,
              subscription.billing_timezone,
              COALESCE(customer.net_payment_term, organization.net_payment_term) AS net_payment_term
       FROM usage_events event
       JOIN subscriptions subscription ON subscription.id = event.subscription_id
       JOIN plans plan ON plan.id = subscription.plan_id
       JOIN customers customer ON customer.id = event.customer_id
       JOIN organizations organization ON organization.id = event.organization_id
       WHERE event.id = ? AND event.deleted_at IS NULL LIMIT 1`,
    )
    .bind(usageEventId)
    .first<AdvanceUsageEventRow>();
}

async function loadAdvanceUsageCharges(
  database: D1Database,
  event: AdvanceUsageEventRow,
): Promise<AdvanceUsageChargeRow[]> {
  const result = await database
    .prepare(
      `SELECT charge.id, charge.code, charge.invoice_display_name, charge.charge_model,
              charge.properties_json, charge.filters_json, charge.accepts_target_wallet,
              metric.code AS metric_code, metric.name AS metric_name,
              metric.aggregation_type, metric.field_name,
              metric.filters_json AS metric_filters_json
       FROM charges charge JOIN billable_metrics metric ON metric.id = charge.billable_metric_id
       WHERE charge.organization_id = ? AND charge.plan_id = ?
         AND charge.billable_metric_id = ? AND charge.active = 1
         AND charge.invoiceable = 1 AND charge.pay_in_advance = 1 AND charge.prorated = 0
       ORDER BY charge.created_at, charge.id`,
    )
    .bind(event.organization_id, event.plan_id, event.billable_metric_id)
    .all<AdvanceUsageChargeRow>();
  return [...result.results];
}

async function findBilling(
  database: D1Database,
  usageEventId: string,
  chargeId: string,
): Promise<ExistingBilling | null> {
  return database
    .prepare(
      `SELECT invoice_id FROM pay_in_advance_usage_billings
       WHERE usage_event_id = ? AND charge_id = ? LIMIT 1`,
    )
    .bind(usageEventId, chargeId)
    .first<ExistingBilling>();
}

async function resolveBillingPeriod(
  database: D1Database,
  event: AdvanceUsageEventRow,
): Promise<BillingPeriod> {
  const currentStartMs = Date.parse(event.current_period_start);
  const currentEndMs = Date.parse(event.current_period_end);
  if (event.timestamp_ms >= currentStartMs && event.timestamp_ms < currentEndMs) {
    return {
      start: event.current_period_start,
      end: event.current_period_end,
      startMs: currentStartMs,
      endMs: currentEndMs,
    };
  }
  const cycle = await database
    .prepare(
      `SELECT period_start AS start, period_end AS end,
              period_start_ms AS startMs, period_end_ms AS endMs
       FROM billing_cycles WHERE subscription_id = ?
         AND period_start_ms <= ? AND period_end_ms > ?
       ORDER BY period_start_ms DESC LIMIT 1`,
    )
    .bind(event.subscription_id, event.timestamp_ms, event.timestamp_ms)
    .first<BillingPeriod>();
  if (!cycle) throw new Error("pay_in_advance_usage_period_not_found");
  return cycle;
}

async function loadUsagePrefix(
  database: D1Database,
  event: AdvanceUsageEventRow,
  period: BillingPeriod,
): Promise<UsageAggregationEvent[]> {
  const result = await database
    .prepare(
      `SELECT id, timestamp_ms, properties_json FROM usage_events
       WHERE subscription_id = ? AND billable_metric_id = ? AND deleted_at IS NULL
         AND timestamp_ms >= ? AND timestamp_ms < ?
         AND (timestamp_ms < ? OR (
           timestamp_ms = ? AND (created_at < ? OR (created_at = ? AND id <= ?))
         ))
       ORDER BY timestamp_ms, created_at, id LIMIT 10001`,
    )
    .bind(
      event.subscription_id,
      event.billable_metric_id,
      period.startMs,
      period.endMs,
      event.timestamp_ms,
      event.timestamp_ms,
      event.created_at,
      event.created_at,
      event.id,
    )
    .all<{ id: string; timestamp_ms: number; properties_json: string }>();
  if (result.results.length > 10_000) {
    throw new Error("pay_in_advance_usage_window_too_large");
  }
  const events = result.results.map((candidate) => ({
    id: candidate.id,
    timestampMs: candidate.timestamp_ms,
    properties: parseObject(candidate.properties_json),
  }));
  if (!events.some((candidate) => candidate.id === event.id)) {
    throw new Error("pay_in_advance_usage_event_missing_from_period");
  }
  return events;
}

function partitionForEvent(
  events: UsageAggregationEvent[],
  eventId: string,
  filters: ChargeFilter[],
  chargePropertiesJson: string,
): {
  events: UsageAggregationEvent[];
  filter: ChargeFilter | null;
  properties: Record<string, unknown>;
} {
  const partitions = partitionUsageEvents(events, filters);
  for (const partition of partitions.filters) {
    if (partition.events.some((candidate) => candidate.id === eventId)) {
      return {
        events: partition.events,
        filter: partition.filter,
        properties: partition.filter.properties,
      };
    }
  }
  if (!partitions.base.some((candidate) => candidate.id === eventId)) {
    throw new Error("pay_in_advance_usage_filter_partition_missing");
  }
  return { events: partitions.base, filter: null, properties: parseObject(chargePropertiesJson) };
}

function supportedAdvanceAggregation(value: string): SupportedAggregationType {
  if (value === "count_agg" || value === "sum_agg" || value === "unique_count_agg") return value;
  throw new Error("unsupported_pay_in_advance_usage_aggregation");
}

function eventTargetWalletCode(event: UsageAggregationEvent | undefined): string | null {
  const value = event?.properties.target_wallet_code;
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function nonNegative(value: Decimal): Decimal {
  return value.isNegative() ? Decimal.zero() : value;
}

function safeMinorInteger(value: Decimal): number {
  const number = Number(value.round());
  if (!Number.isSafeInteger(number) || number < 0) throw new Error("invoice_amount_out_of_range");
  return number;
}

function parseObject(value: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}
