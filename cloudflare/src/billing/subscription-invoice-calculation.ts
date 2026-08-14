import { deterministicUuid } from "../identifiers";
import { stableJson } from "../json";
import { rateCharge } from "../rating/charge-models";
import { Decimal } from "../rating/decimal";
import { aggregateUsage, type SupportedAggregationType } from "../usage/aggregation";
import { parseChargeModel } from "../usage/charge-properties";
import { calculateCouponCredits, type CouponCredit } from "./coupon-credits";
import { calculateCreditNoteAllocations, type CreditNoteAllocation } from "./credit-note-credits";
import { calculateManualTaxes, totalManualTaxMinor, type InvoiceTax } from "./manual-taxes";
import { calculateMinimumCommitmentLine } from "./minimum-commitment";
import { nextPeriodEnd } from "./periods";
import { calculateWalletAllocations, type WalletAllocation } from "./wallet-credits";

export type BillableSubscription = {
  id: string;
  organization_id: string;
  customer_id: string;
  plan_id: string;
  external_id: string;
  current_period_start: string;
  current_period_end: string;
  interval: string;
  currency: string;
  plan_name: string;
  subscription_name: string | null;
  plan_amount_minor: number;
  net_payment_term: number;
  invoice_grace_period: number;
};

type ChargeRow = {
  id: string;
  code: string;
  invoice_display_name: string | null;
  charge_model: string;
  properties_json: string;
  min_amount_minor: number;
  metric_id: string;
  metric_code: string;
  metric_name: string;
  aggregation_type: string;
  field_name: string | null;
};

type FixedChargeRow = {
  id: string;
  code: string;
  invoice_display_name: string | null;
  charge_model: string;
  properties_json: string;
  units: string;
  add_on_code: string;
  add_on_name: string;
  add_on_invoice_display_name: string | null;
};

export type SubscriptionInvoiceLine = {
  id: string;
  description: string;
  units: string;
  precise: string;
  rounded: number;
  sourceId: string;
  lineType: "subscription" | "usage" | "fixed_charge" | "commitment";
  sourceType: "plan" | "charge" | "fixed_charge" | "commitment";
  metadataJson: string;
};

export type SubscriptionInvoiceCalculation = {
  lines: SubscriptionInvoiceLine[];
  subtotalMinor: number;
  couponCredits: CouponCredit[];
  couponsMinor: number;
  invoiceTaxes: InvoiceTax[];
  taxMinor: number;
  creditNoteAllocations: CreditNoteAllocation[];
  creditNotesMinor: number;
  walletAllocations: WalletAllocation[];
  prepaidCreditMinor: number;
  creditsMinor: number;
  totalDueMinor: number;
  nextPeriodEnd: string;
};

export async function findBillableSubscription(
  database: D1Database,
  id: string,
): Promise<BillableSubscription | null> {
  return database
    .prepare(
      `SELECT s.id, s.organization_id, s.customer_id, s.plan_id, s.external_id,
              s.current_period_start, s.current_period_end, p.interval, p.currency,
              p.name AS plan_name, s.name AS subscription_name,
              p.amount_minor AS plan_amount_minor,
              COALESCE(c.net_payment_term, o.net_payment_term) AS net_payment_term,
              COALESCE(c.invoice_grace_period, o.invoice_grace_period) AS invoice_grace_period
       FROM subscriptions s JOIN plans p ON p.id = s.plan_id
       JOIN customers c ON c.id = s.customer_id
       JOIN organizations o ON o.id = s.organization_id
       WHERE s.id = ? AND s.status IN ('active', 'past_due') LIMIT 1`,
    )
    .bind(id)
    .first<BillableSubscription>();
}

export async function calculateInitialSubscriptionInvoice(
  database: D1Database,
  subscription: BillableSubscription,
  invoiceId: string,
  periodStart: string,
  periodEnd: string,
): Promise<SubscriptionInvoiceCalculation> {
  if (!Number.isFinite(Date.parse(periodStart)) || !Number.isFinite(Date.parse(periodEnd))) {
    throw new Error("invalid_billing_period");
  }
  const line: SubscriptionInvoiceLine = {
    id: await deterministicUuid("initial-invoice-line", invoiceId),
    description: subscription.subscription_name ?? subscription.plan_name,
    units: "1",
    precise: String(subscription.plan_amount_minor),
    rounded: subscription.plan_amount_minor,
    sourceId: subscription.plan_id,
    lineType: "subscription",
    sourceType: "plan",
    metadataJson: stableJson({ contextType: "initial", periodStart, periodEnd }),
  };
  const lines = [line];
  const subtotalMinor = subscription.plan_amount_minor;
  const couponCredits = await calculateCouponCredits(
    database,
    subscription.organization_id,
    subscription.customer_id,
    invoiceId,
    subscription.currency,
    subtotalMinor,
  );
  const couponsMinor = couponCredits.reduce(
    (total, credit) => safeAdd(total, credit.amountMinor),
    0,
  );
  const invoiceTaxes = await calculateManualTaxes(
    database,
    subscription.organization_id,
    invoiceId,
    [{ id: line.id, amountMinor: line.rounded }],
    couponsMinor,
  );
  const taxMinor = totalManualTaxMinor(invoiceTaxes);
  const creditNoteAllocations = await calculateCreditNoteAllocations(
    database,
    subscription.organization_id,
    subscription.customer_id,
    invoiceId,
    subscription.currency,
    subtotalMinor + taxMinor - couponsMinor,
  );
  const creditNotesMinor = creditNoteAllocations.reduce(
    (total, allocation) => safeAdd(total, allocation.amountMinor),
    0,
  );
  const walletAllocations = await calculateWalletAllocations(
    database,
    subscription.organization_id,
    subscription.customer_id,
    invoiceId,
    subscription.currency,
    subtotalMinor + taxMinor - couponsMinor - creditNotesMinor,
  );
  const prepaidCreditMinor = walletAllocations.reduce(
    (total, allocation) => safeAdd(total, allocation.amountMinor),
    0,
  );
  const creditsMinor = safeAdd(safeAdd(couponsMinor, creditNotesMinor), prepaidCreditMinor);
  return {
    lines,
    subtotalMinor,
    couponCredits,
    couponsMinor,
    invoiceTaxes,
    taxMinor,
    creditNoteAllocations,
    creditNotesMinor,
    walletAllocations,
    prepaidCreditMinor,
    creditsMinor,
    totalDueMinor: subtotalMinor + taxMinor - creditsMinor,
    nextPeriodEnd: periodEnd,
  };
}

export async function calculateSubscriptionInvoice(
  database: D1Database,
  subscription: BillableSubscription,
  invoiceId: string,
  billingCycleId: string,
  periodStart: string,
  periodEnd: string,
): Promise<SubscriptionInvoiceCalculation> {
  const periodStartMs = Date.parse(periodStart);
  const periodEndMs = Date.parse(periodEnd);
  if (
    !Number.isFinite(periodStartMs) ||
    !Number.isFinite(periodEndMs) ||
    periodEndMs <= periodStartMs
  ) {
    throw new Error("invalid_billing_period");
  }
  const cycleKey = `${subscription.id}:${periodStart}:${periodEnd}`;
  const lines: SubscriptionInvoiceLine[] = [];
  let subtotalMinor = subscription.plan_amount_minor;
  lines.push({
    id: await deterministicUuid("billing-cycle-plan-line", cycleKey),
    description: subscription.plan_name,
    units: "1",
    precise: String(subscription.plan_amount_minor),
    rounded: subscription.plan_amount_minor,
    sourceId: subscription.plan_id,
    lineType: "subscription",
    sourceType: "plan",
    metadataJson: stableJson({ billingCycleId, periodStart, periodEnd }),
  });

  for (const charge of await loadCharges(database, subscription)) {
    const events = await loadEvents(
      database,
      subscription.id,
      charge.metric_id,
      periodStartMs,
      periodEndMs,
    );
    const units = aggregateUsage(
      supportedAggregation(charge.aggregation_type),
      charge.field_name,
      events,
    );
    let precise = Decimal.parse(
      rateCharge(
        units.toString(),
        parseChargeModel(charge.charge_model, parseObject(charge.properties_json)),
        { eventsCount: events.length },
      ).amountCents,
    );
    const minimum = Decimal.parse(charge.min_amount_minor);
    if (precise.compare(minimum) < 0) precise = minimum;
    const rounded = safeMinorInteger(precise);
    subtotalMinor = safeAdd(subtotalMinor, rounded);
    lines.push({
      id: await deterministicUuid("billing-cycle-line", `${cycleKey}:${charge.id}`),
      description: charge.invoice_display_name ?? charge.metric_name,
      units: units.toString(),
      precise: precise.toString(),
      rounded,
      sourceId: charge.id,
      lineType: "usage",
      sourceType: "charge",
      metadataJson: stableJson({
        billingCycleId,
        billableMetricCode: charge.metric_code,
        chargeCode: charge.code,
        chargeModel: charge.charge_model,
        eventCount: events.length,
        periodStart,
        periodEnd,
      }),
    });
  }

  for (const charge of await loadFixedCharges(database, subscription)) {
    const precise = Decimal.parse(
      rateCharge(
        charge.units,
        parseChargeModel(charge.charge_model, parseObject(charge.properties_json)),
      ).amountCents,
    );
    const rounded = safeMinorInteger(precise);
    subtotalMinor = safeAdd(subtotalMinor, rounded);
    lines.push({
      id: await deterministicUuid("billing-cycle-fixed-charge-line", `${cycleKey}:${charge.id}`),
      description:
        charge.invoice_display_name ?? charge.add_on_invoice_display_name ?? charge.add_on_name,
      units: charge.units,
      precise: precise.toString(),
      rounded,
      sourceId: charge.id,
      lineType: "fixed_charge",
      sourceType: "fixed_charge",
      metadataJson: stableJson({
        billingCycleId,
        fixedChargeCode: charge.code,
        addOnCode: charge.add_on_code,
        chargeModel: charge.charge_model,
        periodStart,
        periodEnd,
      }),
    });
  }

  const preciseFees = lines.reduce(
    (total, line) => total.add(Decimal.parse(line.precise)),
    Decimal.zero(),
  );
  const commitmentLine = await calculateMinimumCommitmentLine(
    database,
    subscription.plan_id,
    invoiceId,
    subtotalMinor,
    preciseFees,
  );
  if (commitmentLine) {
    subtotalMinor = safeAdd(subtotalMinor, commitmentLine.amountMinor);
    lines.push({
      id: commitmentLine.id,
      description: commitmentLine.description,
      units: "1",
      precise: commitmentLine.preciseAmountMinor,
      rounded: commitmentLine.amountMinor,
      sourceId: commitmentLine.commitmentId,
      lineType: "commitment",
      sourceType: "commitment",
      metadataJson: stableJson({ billingCycleId, periodStart, periodEnd }),
    });
  }

  const couponCredits = await calculateCouponCredits(
    database,
    subscription.organization_id,
    subscription.customer_id,
    invoiceId,
    subscription.currency,
    subtotalMinor,
  );
  const couponsMinor = couponCredits.reduce(
    (total, credit) => safeAdd(total, credit.amountMinor),
    0,
  );
  const invoiceTaxes = await calculateManualTaxes(
    database,
    subscription.organization_id,
    invoiceId,
    lines.map((line) => ({ id: line.id, amountMinor: line.rounded })),
    couponsMinor,
  );
  const taxMinor = totalManualTaxMinor(invoiceTaxes);
  const creditNoteAllocations = await calculateCreditNoteAllocations(
    database,
    subscription.organization_id,
    subscription.customer_id,
    invoiceId,
    subscription.currency,
    subtotalMinor + taxMinor - couponsMinor,
  );
  const creditNotesMinor = creditNoteAllocations.reduce(
    (total, allocation) => safeAdd(total, allocation.amountMinor),
    0,
  );
  const walletAllocations = await calculateWalletAllocations(
    database,
    subscription.organization_id,
    subscription.customer_id,
    invoiceId,
    subscription.currency,
    subtotalMinor + taxMinor - couponsMinor - creditNotesMinor,
  );
  const prepaidCreditMinor = walletAllocations.reduce(
    (total, allocation) => safeAdd(total, allocation.amountMinor),
    0,
  );
  const creditsMinor = safeAdd(safeAdd(couponsMinor, creditNotesMinor), prepaidCreditMinor);
  return {
    lines,
    subtotalMinor,
    couponCredits,
    couponsMinor,
    invoiceTaxes,
    taxMinor,
    creditNoteAllocations,
    creditNotesMinor,
    walletAllocations,
    prepaidCreditMinor,
    creditsMinor,
    totalDueMinor: subtotalMinor + taxMinor - creditsMinor,
    nextPeriodEnd: nextPeriodEnd(new Date(periodEnd), subscription.interval).toISOString(),
  };
}

export function subscriptionInvoiceLineStatements(
  database: D1Database,
  invoiceId: string,
  billingCycleId: string | null,
  lines: SubscriptionInvoiceLine[],
  now: string,
): D1PreparedStatement[] {
  return lines.map((line) =>
    database
      .prepare(
        `INSERT INTO invoice_lines
         (id, invoice_id, line_type, description, quantity_decimal, unit_amount_decimal,
          amount_minor, source_type, source_id, metadata_json, created_at,
          precise_amount_minor, billing_cycle_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        line.id,
        invoiceId,
        line.lineType,
        line.description,
        line.units,
        line.units === "0"
          ? "0"
          : Decimal.parse(line.precise).divide(Decimal.parse(line.units)).toString(),
        line.rounded,
        line.sourceType,
        line.sourceId,
        line.metadataJson,
        now,
        line.precise,
        billingCycleId,
      ),
  );
}

async function loadCharges(
  database: D1Database,
  subscription: BillableSubscription,
): Promise<ChargeRow[]> {
  const result = await database
    .prepare(
      `SELECT ch.id, ch.code, ch.invoice_display_name, ch.charge_model,
              ch.properties_json, ch.min_amount_minor, bm.id AS metric_id,
              bm.code AS metric_code, bm.name AS metric_name,
              bm.aggregation_type, bm.field_name
       FROM charges ch JOIN billable_metrics bm ON bm.id = ch.billable_metric_id
       WHERE ch.organization_id = ? AND ch.plan_id = ? AND ch.active = 1
         AND ch.invoiceable = 1 AND ch.pay_in_advance = 0
       ORDER BY ch.created_at, ch.id`,
    )
    .bind(subscription.organization_id, subscription.plan_id)
    .all<ChargeRow>();
  return [...result.results];
}

async function loadFixedCharges(
  database: D1Database,
  subscription: BillableSubscription,
): Promise<FixedChargeRow[]> {
  const result = await database
    .prepare(
      `SELECT fc.id, fc.code, fc.invoice_display_name, fc.charge_model,
              fc.properties_json, fc.units, ao.code AS add_on_code, ao.name AS add_on_name,
              ao.invoice_display_name AS add_on_invoice_display_name
       FROM fixed_charges fc JOIN add_ons ao ON ao.id = fc.add_on_id
       WHERE fc.organization_id = ? AND fc.plan_id = ? AND fc.pay_in_advance = 0
         AND fc.prorated = 0
       ORDER BY fc.created_at, fc.id`,
    )
    .bind(subscription.organization_id, subscription.plan_id)
    .all<FixedChargeRow>();
  return [...result.results];
}

async function loadEvents(
  database: D1Database,
  subscriptionId: string,
  metricId: string,
  periodStartMs: number,
  periodEndMs: number,
): Promise<Array<{ id: string; timestampMs: number; properties: Record<string, unknown> }>> {
  const result = await database
    .prepare(
      `SELECT id, timestamp_ms, properties_json FROM usage_events
       WHERE subscription_id = ? AND billable_metric_id = ?
         AND timestamp_ms >= ? AND timestamp_ms < ?
       ORDER BY timestamp_ms, id LIMIT 10001`,
    )
    .bind(subscriptionId, metricId, periodStartMs, periodEndMs)
    .all<{ id: string; timestamp_ms: number; properties_json: string }>();
  if (result.results.length > 10000) throw new Error("usage_window_too_large");
  return result.results.map((row) => ({
    id: row.id,
    timestampMs: row.timestamp_ms,
    properties: parseObject(row.properties_json),
  }));
}

function parseObject(value: string): Record<string, unknown> {
  const parsed = JSON.parse(value) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("invalid_stored_json");
  }
  return parsed as Record<string, unknown>;
}

function supportedAggregation(value: string): SupportedAggregationType {
  if (
    value === "count_agg" ||
    value === "sum_agg" ||
    value === "max_agg" ||
    value === "unique_count_agg" ||
    value === "latest_agg"
  ) {
    return value;
  }
  throw new Error(`unsupported_aggregation_type:${value}`);
}

function safeMinorInteger(value: Decimal): number {
  const rounded = value.round();
  const number = Number(rounded);
  if (!Number.isSafeInteger(number) || number < 0) throw new Error("invalid_minor_amount");
  return number;
}

function safeAdd(left: number, right: number): number {
  const total = left + right;
  if (!Number.isSafeInteger(total)) throw new Error("invoice_total_overflow");
  return total;
}
