import { deterministicUuid } from "../identifiers";
import { stableJson } from "../json";
import { rateCharge, rateProratedFixedCharge } from "../rating/charge-models";
import { Decimal } from "../rating/decimal";
import {
  aggregateUsageResult,
  applyAggregationRounding,
  type AggregationRoundingFunction,
  type SupportedAggregationType,
} from "../usage/aggregation";
import { parseChargeModel } from "../usage/charge-properties";
import {
  parseStoredBillableMetricFilters,
  parseStoredChargeFilters,
  partitionUsageEvents,
  type ChargeFilter,
} from "../usage/charge-filters";
import { calculateCouponCredits, type CouponCredit } from "./coupon-credits";
import { calculateCreditNoteAllocations, type CreditNoteAllocation } from "./credit-note-credits";
import { fixedChargePeriodUnits, type FixedChargeUnitEvent } from "./fixed-charge-units";
import { calculateManualTaxes, totalManualTaxMinor, type InvoiceTax } from "./manual-taxes";
import { calculateMinimumCommitmentLine } from "./minimum-commitment";
import {
  billingPeriodDurationDays,
  billingPeriodProration,
  followingPeriodEnd,
  initialPlanProration,
  type BillingTime,
} from "./periods";
import { calculateWalletAllocations, type WalletAllocation } from "./wallet-credits";
import type { WalletFeeBucket, WalletFeeType } from "./wallet-limitations";
import { progressiveCreditForLines } from "./progressive-credit";

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
  plan_pay_in_advance: number;
  net_payment_term: number;
  invoice_grace_period: number;
  billing_time: BillingTime;
  billing_timezone: string;
  trial_started_at: string | null;
  trial_end_at: string | null;
  trial_ended_at: string | null;
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
  recurring: number;
  weighted_interval: string | null;
  rounding_function: AggregationRoundingFunction | null;
  rounding_precision: number | null;
  accepts_target_wallet: number;
  filters_json: string;
  metric_filters_json: string;
};

type FixedChargeRow = {
  id: string;
  code: string;
  invoice_display_name: string | null;
  charge_model: string;
  properties_json: string;
  units: string;
  prorated_units: string;
  prorated: number;
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
  persistenceSourceId?: string;
  billableMetricId?: string | null;
  targetWalletCode?: string | null;
  metadataJson: string;
};

export type SubscriptionInvoiceCalculation = {
  lines: SubscriptionInvoiceLine[];
  subtotalMinor: number;
  progressiveBillingCreditMinor: number;
  progressiveBillingCreditInvoiceId: string | null;
  progressiveBillingCreditExcessMinor: number;
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

export type InvoiceAllocationOwner = Pick<
  BillableSubscription,
  "organization_id" | "customer_id" | "currency"
> & { plan_id?: string };

export type InvoiceAllocationCalculation = Omit<
  SubscriptionInvoiceCalculation,
  | "lines"
  | "nextPeriodEnd"
  | "progressiveBillingCreditInvoiceId"
  | "progressiveBillingCreditExcessMinor"
>;

export type SubscriptionInvoiceReason =
  | "subscription_starting"
  | "subscription_periodic"
  | "subscription_terminating"
  | "upgrading";

export function invoiceSubscriptionStatement(
  database: D1Database,
  invoiceId: string,
  subscriptionId: string,
  organizationId: string,
  invoicingReason: SubscriptionInvoiceReason,
  periodStart: string | null,
  periodEnd: string | null,
  createdAt: string,
): D1PreparedStatement {
  return database
    .prepare(
      `INSERT INTO invoice_subscriptions
       (invoice_id, subscription_id, organization_id, invoicing_reason,
        period_start, period_end, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      invoiceId,
      subscriptionId,
      organizationId,
      invoicingReason,
      periodStart,
      periodEnd,
      createdAt,
    );
}

export type TerminationBillingWindow = {
  billableDays: number;
  fullPeriodDays: number;
  usagePeriodEnd: string;
};

type SubscriptionInvoiceOptions =
  | { context: "renewal" }
  | { context: "progressive"; calculatedThrough: string }
  | {
      context: "termination";
      terminatedAt: string;
      window: TerminationBillingWindow;
      additionalCreditNote?: {
        creditNoteId: string;
        amountMinor: number;
      };
    };

export async function findBillableSubscription(
  database: D1Database,
  id: string,
): Promise<BillableSubscription | null> {
  return findSubscriptionForCalculation(database, id, false);
}

export async function findRefreshableSubscription(
  database: D1Database,
  id: string,
): Promise<BillableSubscription | null> {
  return findSubscriptionForCalculation(database, id, true);
}

async function findSubscriptionForCalculation(
  database: D1Database,
  id: string,
  includeTerminated: boolean,
): Promise<BillableSubscription | null> {
  return database
    .prepare(
      `SELECT s.id, s.organization_id, s.customer_id, s.plan_id, s.external_id,
              s.current_period_start, s.current_period_end, p.interval, p.currency,
              p.name AS plan_name, s.name AS subscription_name,
              p.amount_minor AS plan_amount_minor,
              p.pay_in_advance AS plan_pay_in_advance,
              s.billing_time, s.billing_timezone, s.trial_started_at, s.trial_end_at,
              s.trial_ended_at,
              COALESCE(c.net_payment_term, o.net_payment_term) AS net_payment_term,
              COALESCE(c.invoice_grace_period, o.invoice_grace_period) AS invoice_grace_period
       FROM subscriptions s JOIN plans p ON p.id = s.plan_id
       JOIN customers c ON c.id = s.customer_id
       JOIN organizations o ON o.id = s.organization_id
       WHERE s.id = ? AND s.status IN (${includeTerminated ? "'active', 'past_due', 'terminated'" : "'active', 'past_due'"})
       LIMIT 1`,
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
  const trialEndInvoice =
    subscription.trial_end_at !== null && periodStart === subscription.trial_end_at;
  const proration = trialEndInvoice
    ? initialPlanProration(
        new Date(periodStart),
        new Date(periodEnd),
        subscription.billing_time,
        subscription.interval,
        subscription.billing_timezone,
      )
    : { billableDays: 1, fullPeriodDays: 1 };
  const preciseAmount = Decimal.parse(subscription.plan_amount_minor)
    .multiply(Decimal.parse(proration.billableDays))
    .divideByInteger(BigInt(proration.fullPeriodDays));
  const roundedAmount = safeMinorInteger(preciseAmount);
  const line: SubscriptionInvoiceLine = {
    id: await deterministicUuid("initial-invoice-line", invoiceId),
    description: subscription.subscription_name ?? subscription.plan_name,
    units: "1",
    precise: preciseAmount.toString(),
    rounded: roundedAmount,
    sourceId: subscription.plan_id,
    lineType: "subscription",
    sourceType: "plan",
    metadataJson: stableJson({
      contextType: "initial",
      periodStart,
      periodEnd,
      billingTime: subscription.billing_time,
      billingTimezone: subscription.billing_timezone,
      billableDays: proration.billableDays,
      fullPeriodDays: proration.fullPeriodDays,
    }),
  };
  const lines = [line];
  const shouldBillAdvanceFixedCharges = subscription.trial_started_at === null || !trialEndInvoice;
  if (shouldBillAdvanceFixedCharges) {
    lines.push(
      ...(await calculateInitialPayInAdvanceFixedChargeLines(
        database,
        subscription,
        invoiceId,
        periodStart,
        periodEnd,
      )),
    );
  }
  const allocations = await calculateInvoiceAllocations(database, subscription, invoiceId, lines);
  return {
    lines,
    ...allocations,
    progressiveBillingCreditInvoiceId: null,
    progressiveBillingCreditExcessMinor: 0,
    nextPeriodEnd: periodEnd,
  };
}

export async function calculateInitialPayInAdvanceFixedChargeLines(
  database: D1Database,
  subscription: BillableSubscription,
  invoiceId: string,
  periodStart: string,
  periodEnd: string,
): Promise<SubscriptionInvoiceLine[]> {
  const fixedChargeFullPeriodDays = billingPeriodDurationDays(
    new Date(periodStart),
    new Date(periodEnd),
    subscription.billing_time,
    subscription.interval,
    subscription.billing_timezone,
  );
  const lines: SubscriptionInvoiceLine[] = [];
  for (const charge of await loadFixedCharges(
    database,
    subscription,
    periodStart,
    periodEnd,
    fixedChargeFullPeriodDays,
    1,
  )) {
    const model = parseChargeModel(charge.charge_model, parseObject(charge.properties_json));
    const precise = Decimal.parse(
      (charge.prorated === 1
        ? rateProratedFixedCharge(charge.units, charge.prorated_units, model)
        : rateCharge(charge.units, model)
      ).amountCents,
    );
    lines.push({
      id: await deterministicUuid("initial-fixed-charge-line", `${invoiceId}:${charge.id}`),
      description:
        charge.invoice_display_name ?? charge.add_on_invoice_display_name ?? charge.add_on_name,
      units: charge.units,
      precise: precise.toString(),
      rounded: safeMinorInteger(precise),
      sourceId: charge.id,
      lineType: "fixed_charge",
      sourceType: "fixed_charge",
      metadataJson: stableJson({
        contextType: "in_advance_charge",
        billingMode: "in_advance",
        fixedChargeCode: charge.code,
        addOnCode: charge.add_on_code,
        chargeModel: charge.charge_model,
        periodStart,
        periodEnd,
        effectiveAt: periodStart,
        ...(charge.prorated === 1 ? { prorated: true, proratedUnits: charge.prorated_units } : {}),
      }),
    });
  }
  return lines;
}

export async function calculateInvoiceAllocations(
  database: D1Database,
  owner: InvoiceAllocationOwner,
  invoiceId: string,
  lines: SubscriptionInvoiceLine[],
  additionalCreditNote?: { creditNoteId: string; amountMinor: number },
  progressiveBillingCreditMinor = 0,
): Promise<InvoiceAllocationCalculation> {
  const subtotalMinor = lines.reduce((total, line) => safeAdd(total, line.rounded), 0);
  if (
    !Number.isSafeInteger(progressiveBillingCreditMinor) ||
    progressiveBillingCreditMinor < 0 ||
    progressiveBillingCreditMinor > subtotalMinor
  ) {
    throw new Error("invalid_progressive_billing_credit");
  }
  const subtotalAfterProgressiveCredit = subtotalMinor - progressiveBillingCreditMinor;
  const progressiveDiscounts = allocateInvoiceLineDiscounts(lines, progressiveBillingCreditMinor);
  const couponCredits = await calculateCouponCredits(
    database,
    owner.organization_id,
    owner.customer_id,
    invoiceId,
    owner.currency,
    lines.map((line) => ({
      id: line.id,
      amountMinor: line.rounded - (progressiveDiscounts.get(line.id) ?? 0),
      billableMetricId: line.billableMetricId,
    })),
    owner.plan_id,
  );
  const couponsMinor = couponCredits.reduce(
    (total, credit) => safeAdd(total, credit.amountMinor),
    0,
  );
  const couponDiscounts = new Map<string, number>();
  for (const credit of couponCredits) {
    for (const discount of credit.lineDiscounts) {
      couponDiscounts.set(
        discount.lineId,
        safeAdd(couponDiscounts.get(discount.lineId) ?? 0, discount.amountMinor),
      );
    }
  }
  const invoiceTaxes = await calculateManualTaxes(
    database,
    owner.organization_id,
    owner.customer_id,
    invoiceId,
    lines.map((candidate) => ({
      id: candidate.id,
      amountMinor: candidate.rounded,
      sourceType: candidate.sourceType,
      sourceId: candidate.persistenceSourceId ?? candidate.sourceId,
      couponDiscountMinor: safeAdd(
        progressiveDiscounts.get(candidate.id) ?? 0,
        couponDiscounts.get(candidate.id) ?? 0,
      ),
    })),
    0,
  );
  const taxMinor = totalManualTaxMinor(invoiceTaxes);
  const creditNoteAllocations = await calculateCreditNoteAllocations(
    database,
    owner.organization_id,
    owner.customer_id,
    invoiceId,
    owner.currency,
    subtotalAfterProgressiveCredit + taxMinor - couponsMinor,
  );
  let creditNotesMinor = creditNoteAllocations.reduce(
    (total, allocation) => safeAdd(total, allocation.amountMinor),
    0,
  );
  if (additionalCreditNote) {
    const remainingDue =
      subtotalAfterProgressiveCredit + taxMinor - couponsMinor - creditNotesMinor;
    const amountMinor = Math.min(additionalCreditNote.amountMinor, remainingDue);
    if (amountMinor > 0) {
      creditNoteAllocations.push({
        creditNoteId: additionalCreditNote.creditNoteId,
        creditNoteVersion: 1,
        amountMinor,
        applicationId: await deterministicUuid(
          "credit-note-application",
          `${invoiceId}:${additionalCreditNote.creditNoteId}`,
        ),
        consumed: amountMinor === additionalCreditNote.amountMinor,
      });
      creditNotesMinor = safeAdd(creditNotesMinor, amountMinor);
    }
  }
  const walletAllocations = await calculateWalletAllocations(
    database,
    owner.organization_id,
    owner.customer_id,
    invoiceId,
    owner.currency,
    subtotalAfterProgressiveCredit + taxMinor - couponsMinor - creditNotesMinor,
    walletFeeBuckets(lines, invoiceTaxes),
  );
  const prepaidCreditMinor = walletAllocations.reduce(
    (total, allocation) => safeAdd(total, allocation.amountMinor),
    0,
  );
  const creditsMinor = safeAdd(
    progressiveBillingCreditMinor,
    safeAdd(safeAdd(couponsMinor, creditNotesMinor), prepaidCreditMinor),
  );
  return {
    subtotalMinor,
    progressiveBillingCreditMinor,
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
  };
}

export async function calculateSubscriptionInvoice(
  database: D1Database,
  subscription: BillableSubscription,
  invoiceId: string,
  billingCycleId: string,
  periodStart: string,
  periodEnd: string,
  options: SubscriptionInvoiceOptions = { context: "renewal" },
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
  const calculationPeriodEnd =
    options.context === "termination"
      ? options.window.usagePeriodEnd
      : options.context === "progressive"
        ? options.calculatedThrough
        : periodEnd;
  const calculationPeriodEndMs = Date.parse(calculationPeriodEnd);
  if (!Number.isFinite(calculationPeriodEndMs) || calculationPeriodEndMs <= periodStartMs) {
    throw new Error("invalid_calculation_period");
  }
  const cycleKey =
    options.context === "renewal"
      ? `${subscription.id}:${periodStart}:${periodEnd}`
      : `${subscription.id}:${periodStart}:${calculationPeriodEnd}:${options.context}`;
  const nextEnd = followingPeriodEnd(
    new Date(periodEnd),
    subscription.interval,
    subscription.billing_time,
    subscription.billing_timezone,
  ).toISOString();
  const planPeriodStart =
    options.context === "renewal" && subscription.plan_pay_in_advance === 1
      ? periodEnd
      : periodStart;
  const planPeriodEnd =
    options.context === "termination"
      ? calculationPeriodEnd
      : subscription.plan_pay_in_advance === 1
        ? nextEnd
        : periodEnd;
  const lines: SubscriptionInvoiceLine[] = [];
  let includePlanLine =
    options.context !== "progressive" &&
    !(options.context === "termination" && subscription.plan_pay_in_advance === 1);
  let renewalProration: { billableDays: number; fullPeriodDays: number } | null = null;
  if (options.context === "renewal" && subscription.trial_end_at) {
    const trialEndMs = Date.parse(subscription.trial_end_at);
    if (!Number.isFinite(trialEndMs)) throw new Error("invalid_trial_end_at");
    if (subscription.plan_pay_in_advance === 1) {
      if (subscription.trial_ended_at === null && trialEndMs > periodEndMs) includePlanLine = false;
    } else {
      const billableStartMs = Math.max(periodStartMs, trialEndMs);
      if (billableStartMs >= periodEndMs) includePlanLine = false;
      else {
        renewalProration = billingPeriodProration(
          new Date(billableStartMs),
          new Date(periodStartMs),
          new Date(periodEndMs),
          subscription.billing_timezone,
        );
      }
    }
  }
  const precisePlanAmount =
    options.context === "termination" && includePlanLine
      ? Decimal.parse(subscription.plan_amount_minor)
          .multiply(Decimal.parse(options.window.billableDays))
          .divideByInteger(BigInt(options.window.fullPeriodDays))
      : includePlanLine && renewalProration
        ? Decimal.parse(subscription.plan_amount_minor)
            .multiply(Decimal.parse(renewalProration.billableDays))
            .divideByInteger(BigInt(renewalProration.fullPeriodDays))
        : includePlanLine
          ? Decimal.parse(subscription.plan_amount_minor)
          : Decimal.zero();
  const roundedPlanAmount = includePlanLine ? safeMinorInteger(precisePlanAmount) : 0;
  let subtotalMinor = roundedPlanAmount;
  if (includePlanLine) {
    lines.push({
      id: await deterministicUuid("billing-cycle-plan-line", cycleKey),
      description: subscription.plan_name,
      units: "1",
      precise: precisePlanAmount.toString(),
      rounded: roundedPlanAmount,
      sourceId: subscription.plan_id,
      lineType: "subscription",
      sourceType: "plan",
      metadataJson: stableJson({
        billingCycleId: options.context === "renewal" ? billingCycleId : undefined,
        billingMode: subscription.plan_pay_in_advance === 1 ? "in_advance" : "in_arrears",
        periodStart: planPeriodStart,
        periodEnd: planPeriodEnd,
        ...(subscription.billing_time === "calendar"
          ? {
              billingTime: subscription.billing_time,
              billingTimezone: subscription.billing_timezone,
            }
          : {}),
        ...(renewalProration
          ? {
              billableDays: renewalProration.billableDays,
              fullPeriodDays: renewalProration.fullPeriodDays,
              trialEndAt: subscription.trial_end_at,
            }
          : {}),
        ...(options.context === "termination"
          ? {
              contextType: "termination",
              billableDays: options.window.billableDays,
              fullPeriodDays: options.window.fullPeriodDays,
              terminatedAt: options.terminatedAt,
            }
          : {}),
      }),
    });
  }

  for (const charge of await loadCharges(database, subscription)) {
    const events = await loadEvents(
      database,
      subscription.id,
      charge.metric_id,
      periodStartMs,
      calculationPeriodEndMs,
    );
    const aggregationType = supportedAggregation(charge.aggregation_type);
    if (aggregationType === "weighted_sum_agg" && charge.weighted_interval !== "seconds") {
      throw new Error("invalid_weighted_interval");
    }
    const filters = parseStoredChargeFilters(
      charge.filters_json,
      parseStoredBillableMetricFilters(charge.metric_filters_json),
      charge.charge_model,
      charge.id,
    );
    const initialValues =
      aggregationType === "weighted_sum_agg" && charge.recurring === 1
        ? await recurringWeightedBaseline(
            database,
            subscription,
            charge.metric_id,
            charge.field_name,
            periodStartMs,
            filters,
            charge.accepts_target_wallet === 1,
          )
        : zeroWeightedBaselines(filters);
    const filtered = partitionUsageEvents(events, filters);
    const groups =
      filters.length > 0
        ? [
            ...filtered.filters.flatMap(({ filter, events: filterEvents }) =>
              targetWalletEventGroups(
                filterEvents,
                charge.accepts_target_wallet === 1,
                initialValues.filters.get(filter.lagoId)?.keys(),
              ).map((group) => ({
                ...group,
                filter,
                properties: filter.properties,
              })),
            ),
            ...targetWalletEventGroups(
              filtered.base,
              charge.accepts_target_wallet === 1,
              initialValues.base.keys(),
            ).map((group) => ({
              ...group,
              filter: null,
              properties: parseObject(charge.properties_json),
            })),
          ]
        : targetWalletEventGroups(
            events,
            charge.accepts_target_wallet === 1,
            initialValues.base.keys(),
          ).map((group) => ({
            ...group,
            filter: null,
            properties: parseObject(charge.properties_json),
          }));
    const chargeLineStart = lines.length;
    for (const group of groups) {
      const partitionInitialValues = group.filter
        ? (initialValues.filters.get(group.filter.lagoId) ?? new Map())
        : initialValues.base;
      const initialValue = partitionInitialValues.get(group.targetWalletCode) ?? Decimal.zero();
      const aggregation = aggregateUsageResult(aggregationType, charge.field_name, group.events, {
        periodStartMs,
        periodEndMs: calculationPeriodEndMs,
        periodDurationDays:
          aggregationType === "weighted_sum_agg"
            ? billingPeriodDurationDays(
                new Date(periodStartMs),
                new Date(periodEndMs),
                subscription.billing_time,
                subscription.interval,
                subscription.billing_timezone,
              )
            : undefined,
        initialValue,
      });
      const units = applyAggregationRounding(
        aggregation.units,
        charge.rounding_function,
        charge.rounding_precision,
      );
      const precise = Decimal.parse(
        rateCharge(units.toString(), parseChargeModel(charge.charge_model, group.properties), {
          eventsCount: group.events.length,
        }).amountCents,
      );
      const rounded = safeMinorInteger(precise);
      subtotalMinor = safeAdd(subtotalMinor, rounded);
      const groupKey = group.targetWalletCode ?? "untargeted";
      const targeted = charge.accepts_target_wallet === 1;
      const filteredLine = group.filter !== null;
      lines.push({
        id: await deterministicUuid(
          "billing-cycle-line",
          filteredLine
            ? targeted
              ? `${cycleKey}:${charge.id}:filter:${group.filter.lagoId}:wallet:${groupKey}`
              : `${cycleKey}:${charge.id}:filter:${group.filter.lagoId}`
            : targeted
              ? `${cycleKey}:${charge.id}:wallet:${groupKey}`
              : `${cycleKey}:${charge.id}`,
        ),
        description:
          group.filter?.invoiceDisplayName ?? charge.invoice_display_name ?? charge.metric_name,
        units: units.toString(),
        precise: precise.toString(),
        rounded,
        sourceId: charge.id,
        persistenceSourceId: filteredLine
          ? targeted
            ? await deterministicUuid(
                "charge-filter-wallet-group-source",
                `${group.filter.lagoId}:${groupKey}`,
              )
            : group.filter.lagoId
          : targeted
            ? await deterministicUuid("charge-wallet-group-source", `${charge.id}:${groupKey}`)
            : charge.id,
        lineType: "usage",
        sourceType: "charge",
        billableMetricId: charge.metric_id,
        targetWalletCode: group.targetWalletCode,
        metadataJson: stableJson({
          billingCycleId: options.context === "renewal" ? billingCycleId : undefined,
          billableMetricCode: charge.metric_code,
          chargeCode: charge.code,
          chargeModel: charge.charge_model,
          eventCount: group.events.length,
          ...(aggregationType === "weighted_sum_agg"
            ? { totalAggregatedUnits: aggregation.totalAggregatedUnits.toString() }
            : {}),
          periodStart,
          periodEnd: calculationPeriodEnd,
          ...(filteredLine
            ? {
                billableMetricId: charge.metric_id,
                chargeId: charge.id,
                chargeFilterId: group.filter.lagoId,
                chargeFilterValues: group.filter.values,
              }
            : {}),
          ...(targeted
            ? {
                billableMetricId: charge.metric_id,
                chargeId: charge.id,
                targetWalletCode: group.targetWalletCode ?? undefined,
                groupedBy: group.targetWalletCode
                  ? { target_wallet_code: group.targetWalletCode }
                  : {},
              }
            : {}),
          ...(options.context === "termination" ? { contextType: "termination" } : {}),
        }),
      });
    }
    const chargeLines = lines.slice(chargeLineStart);
    const minimum =
      options.context === "progressive"
        ? Decimal.zero()
        : proratedChargeMinimum(charge.min_amount_minor, options);
    const usedRounded = chargeLines.reduce((sum, line) => safeAdd(sum, line.rounded), 0);
    if (options.context !== "progressive" && Decimal.parse(usedRounded).compare(minimum) < 0) {
      const usedPrecise = chargeLines.reduce(
        (sum, line) => sum.add(Decimal.parse(line.precise)),
        Decimal.zero(),
      );
      const precise = minimum.subtract(usedPrecise);
      const rounded = safeMinorInteger(minimum.subtract(Decimal.parse(usedRounded)));
      subtotalMinor = safeAdd(subtotalMinor, rounded);
      lines.push({
        id: await deterministicUuid(
          "billing-cycle-charge-true-up-line",
          `${cycleKey}:${charge.id}`,
        ),
        description: charge.invoice_display_name ?? charge.metric_name,
        units: "1",
        precise: precise.toString(),
        rounded,
        sourceId: charge.id,
        persistenceSourceId: await deterministicUuid("charge-true-up-source", charge.id),
        lineType: "usage",
        sourceType: "charge",
        billableMetricId: charge.metric_id,
        targetWalletCode: null,
        metadataJson: stableJson({
          billingCycleId: options.context === "renewal" ? billingCycleId : undefined,
          billableMetricCode: charge.metric_code,
          billableMetricId: charge.metric_id,
          chargeCode: charge.code,
          chargeId: charge.id,
          chargeModel: charge.charge_model,
          eventCount: 0,
          periodStart,
          periodEnd: calculationPeriodEnd,
          trueUp: true,
          trueUpParentSourceId: charge.id,
          ...(options.context === "termination" ? { contextType: "termination" } : {}),
        }),
      });
    }
  }

  if (options.context === "progressive") {
    return {
      lines,
      subtotalMinor,
      progressiveBillingCreditMinor: 0,
      progressiveBillingCreditInvoiceId: null,
      progressiveBillingCreditExcessMinor: 0,
      couponCredits: [],
      couponsMinor: 0,
      invoiceTaxes: [],
      taxMinor: 0,
      creditNoteAllocations: [],
      creditNotesMinor: 0,
      walletAllocations: [],
      prepaidCreditMinor: 0,
      creditsMinor: 0,
      totalDueMinor: subtotalMinor,
      nextPeriodEnd: calculationPeriodEnd,
    };
  }

  const fixedChargePeriods = [
    {
      payInAdvance: 0 as const,
      start: periodStart,
      end: calculationPeriodEnd,
      fullEnd: periodEnd,
    },
    ...(options.context === "renewal"
      ? [
          {
            payInAdvance: 1 as const,
            start: periodEnd,
            end: nextEnd,
            fullEnd: nextEnd,
          },
        ]
      : []),
  ];
  for (const fixedChargePeriod of fixedChargePeriods) {
    const fullPeriodDays = billingPeriodDurationDays(
      new Date(fixedChargePeriod.start),
      new Date(fixedChargePeriod.fullEnd),
      subscription.billing_time,
      subscription.interval,
      subscription.billing_timezone,
    );
    for (const charge of await loadFixedCharges(
      database,
      subscription,
      fixedChargePeriod.start,
      fixedChargePeriod.end,
      fullPeriodDays,
      fixedChargePeriod.payInAdvance,
    )) {
      const model = parseChargeModel(charge.charge_model, parseObject(charge.properties_json));
      const precise = Decimal.parse(
        (charge.prorated === 1
          ? rateProratedFixedCharge(charge.units, charge.prorated_units, model)
          : rateCharge(charge.units, model)
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
          billingCycleId: options.context === "renewal" ? billingCycleId : undefined,
          fixedChargeCode: charge.code,
          addOnCode: charge.add_on_code,
          chargeModel: charge.charge_model,
          billingMode: fixedChargePeriod.payInAdvance === 1 ? "in_advance" : "in_arrears",
          ...(charge.prorated === 1
            ? { prorated: true, proratedUnits: charge.prorated_units }
            : {}),
          periodStart: fixedChargePeriod.start,
          periodEnd: fixedChargePeriod.end,
          ...(options.context === "termination" ? { contextType: "termination" } : {}),
        }),
      });
    }
  }

  const preciseFees = lines.reduce(
    (total, line) => total.add(Decimal.parse(line.precise)),
    Decimal.zero(),
  );
  const historicalCommitmentFees =
    options.context === "termination" && subscription.plan_pay_in_advance === 1
      ? await loadHistoricalCommitmentFees(
          database,
          subscription,
          invoiceId,
          periodStart,
          periodEnd,
        )
      : { roundedMinor: 0, preciseMinor: Decimal.zero() };
  const commitmentTargetMinor =
    options.context === "termination"
      ? safeMinorInteger(
          Decimal.parse(options.window.billableDays)
            .multiply(Decimal.parse(await minimumCommitmentAmount(database, subscription.plan_id)))
            .divideByInteger(BigInt(options.window.fullPeriodDays)),
        )
      : undefined;
  const commitmentLine =
    options.context === "renewal" || commitmentTargetMinor !== undefined
      ? await calculateMinimumCommitmentLine(
          database,
          subscription.plan_id,
          invoiceId,
          safeAdd(subtotalMinor, historicalCommitmentFees.roundedMinor),
          preciseFees.add(historicalCommitmentFees.preciseMinor),
          commitmentTargetMinor,
        )
      : null;
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
      metadataJson: stableJson({
        billingCycleId: options.context === "renewal" ? billingCycleId : undefined,
        periodStart,
        periodEnd: calculationPeriodEnd,
        ...(options.context === "termination"
          ? {
              contextType: "termination",
              targetAmountMinor: commitmentTargetMinor,
              historicalFeesMinor: historicalCommitmentFees.roundedMinor,
              billableDays: options.window.billableDays,
              fullPeriodDays: options.window.fullPeriodDays,
            }
          : {}),
      }),
    });
  }

  const progressiveCredit = await progressiveCreditForLines(
    database,
    subscription.id,
    periodStart,
    periodEnd,
    lines,
  );
  const allocations = await calculateInvoiceAllocations(
    database,
    subscription,
    invoiceId,
    lines,
    options.context === "termination" ? options.additionalCreditNote : undefined,
    progressiveCredit?.appliedCreditMinor ?? 0,
  );
  return {
    lines,
    ...allocations,
    progressiveBillingCreditInvoiceId: progressiveCredit?.invoiceId ?? null,
    progressiveBillingCreditExcessMinor: progressiveCredit?.excessCreditMinor ?? 0,
    nextPeriodEnd: options.context === "renewal" ? nextEnd : calculationPeriodEnd,
  };
}

export function walletFeeBuckets(
  lines: SubscriptionInvoiceLine[],
  taxes: InvoiceTax[],
): WalletFeeBucket[] {
  const preciseTaxByLine = new Map<string, Decimal>();
  for (const tax of taxes) {
    for (const lineTax of tax.lineTaxes) {
      preciseTaxByLine.set(
        lineTax.lineId,
        (preciseTaxByLine.get(lineTax.lineId) ?? Decimal.zero()).add(
          Decimal.parse(lineTax.preciseAmountMinor),
        ),
      );
    }
  }
  return lines.map((line) => ({
    amountMinor: safeAdd(
      line.rounded,
      preciseTaxByLine.has(line.id) ? safeMinorInteger(preciseTaxByLine.get(line.id)!) : 0,
    ),
    billableMetricId: line.billableMetricId ?? null,
    feeType: walletFeeType(line.lineType),
    targetWalletCode: line.targetWalletCode ?? null,
  }));
}

function walletFeeType(lineType: SubscriptionInvoiceLine["lineType"]): WalletFeeType {
  if (lineType === "usage") return "charge";
  return lineType;
}

export async function calculateTerminationSubscriptionInvoice(
  database: D1Database,
  subscription: BillableSubscription,
  invoiceId: string,
  terminationId: string,
  terminatedAt: string,
  additionalCreditNote?: { creditNoteId: string; amountMinor: number },
  immutablePeriod?: { periodStart: string; periodEnd: string },
): Promise<SubscriptionInvoiceCalculation> {
  const periodStart = immutablePeriod?.periodStart ?? subscription.current_period_start;
  const periodEnd = immutablePeriod?.periodEnd ?? subscription.current_period_end;
  const window = terminationBillingWindowUtc(periodStart, periodEnd, terminatedAt);
  return calculateSubscriptionInvoice(
    database,
    subscription,
    invoiceId,
    terminationId,
    periodStart,
    periodEnd,
    { context: "termination", terminatedAt, window, additionalCreditNote },
  );
}

export function terminationBillingWindowUtc(
  periodStart: string,
  periodEnd: string,
  terminatedAt: string,
): TerminationBillingWindow {
  const periodStartMs = Date.parse(periodStart);
  const periodEndMs = Date.parse(periodEnd);
  const terminatedAtMs = Date.parse(terminatedAt);
  if (
    !Number.isFinite(periodStartMs) ||
    !Number.isFinite(periodEndMs) ||
    !Number.isFinite(terminatedAtMs) ||
    periodEndMs <= periodStartMs ||
    terminatedAtMs < periodStartMs
  ) {
    throw new Error("invalid_termination_period");
  }
  const startDay = utcDayOrdinal(periodStartMs);
  const endDay = utcDayOrdinal(periodEndMs);
  const terminationDay = utcDayOrdinal(Math.min(terminatedAtMs, periodEndMs));
  const fullPeriodDays = endDay - startDay;
  if (!Number.isSafeInteger(fullPeriodDays) || fullPeriodDays <= 0) {
    throw new Error("unsupported_subday_termination_period");
  }
  const billableDays = Math.min(fullPeriodDays, terminationDay - startDay + 1);
  if (!Number.isSafeInteger(billableDays) || billableDays <= 0) {
    throw new Error("invalid_termination_billable_days");
  }
  const nextUtcDayMs = (terminationDay + 1) * 86_400_000;
  const usagePeriodEndMs = Math.min(periodEndMs, nextUtcDayMs);
  if (usagePeriodEndMs <= periodStartMs) throw new Error("invalid_termination_usage_period");
  return {
    billableDays,
    fullPeriodDays,
    usagePeriodEnd: new Date(usagePeriodEndMs).toISOString(),
  };
}

function utcDayOrdinal(timestampMs: number): number {
  const date = new Date(timestampMs);
  return Math.floor(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()) / 86_400_000,
  );
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
        line.persistenceSourceId ?? line.sourceId,
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
              ch.properties_json, ch.filters_json, ch.min_amount_minor, bm.id AS metric_id,
              bm.code AS metric_code, bm.name AS metric_name,
              bm.aggregation_type, bm.field_name, bm.recurring, bm.weighted_interval,
              bm.rounding_function, bm.rounding_precision, ch.accepts_target_wallet,
              bm.filters_json AS metric_filters_json
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
  periodStart: string,
  calculationPeriodEnd: string,
  fullPeriodDays: number,
  payInAdvance: 0 | 1,
): Promise<FixedChargeRow[]> {
  const result = await database
    .prepare(
      `SELECT fc.id, fc.code, fc.invoice_display_name, fc.charge_model,
              fc.properties_json, fc.units, fc.prorated,
              EXISTS (
                SELECT 1 FROM fixed_charge_unit_events any_event
                WHERE any_event.subscription_id = ? AND any_event.fixed_charge_id = fc.id
              ) AS has_unit_events,
              ao.code AS add_on_code, ao.name AS add_on_name,
              ao.invoice_display_name AS add_on_invoice_display_name
       FROM fixed_charges fc JOIN add_ons ao ON ao.id = fc.add_on_id
       WHERE fc.organization_id = ? AND fc.plan_id = ? AND fc.active = 1
         AND fc.pay_in_advance = ?
       ORDER BY fc.created_at, fc.id`,
    )
    .bind(subscription.id, subscription.organization_id, subscription.plan_id, payInAdvance)
    .all<
      Omit<FixedChargeRow, "prorated_units"> & {
        has_unit_events: number;
      }
    >();
  if (result.results.length === 0) return [];

  const eventResult = await database
    .prepare(
      `SELECT event.fixed_charge_id, event.fixed_charge_version, event.units, event.effective_at
       FROM fixed_charge_unit_events event
       JOIN fixed_charges fixed ON fixed.id = event.fixed_charge_id
       WHERE fixed.organization_id = ? AND fixed.plan_id = ? AND fixed.active = 1
         AND event.subscription_id = ? AND event.effective_at < ?
         AND (
           event.effective_at >= ? OR event.id = (
             SELECT prior.id FROM fixed_charge_unit_events prior
             WHERE prior.subscription_id = event.subscription_id
               AND prior.fixed_charge_id = event.fixed_charge_id
               AND prior.effective_at < ?
             ORDER BY prior.fixed_charge_version DESC, prior.effective_at DESC, prior.id DESC
             LIMIT 1
           )
         )
       ORDER BY event.fixed_charge_id, event.fixed_charge_version, event.id
       LIMIT ?`,
    )
    .bind(
      subscription.organization_id,
      subscription.plan_id,
      subscription.id,
      calculationPeriodEnd,
      periodStart,
      periodStart,
      MAX_FIXED_CHARGE_PERIOD_EVENTS + 1,
    )
    .all<{
      fixed_charge_id: string;
      fixed_charge_version: number;
      units: string;
      effective_at: string;
    }>();
  if (eventResult.results.length > MAX_FIXED_CHARGE_PERIOD_EVENTS) {
    throw new Error("fixed_charge_period_event_limit_exceeded");
  }
  const eventsByFixedCharge = new Map<string, FixedChargeUnitEvent[]>();
  for (const event of eventResult.results) {
    const events = eventsByFixedCharge.get(event.fixed_charge_id) ?? [];
    events.push({
      fixedChargeVersion: event.fixed_charge_version,
      units: event.units,
      effectiveAt: event.effective_at,
    });
    eventsByFixedCharge.set(event.fixed_charge_id, events);
  }

  return result.results.map((charge) => {
    const periodUnits = fixedChargePeriodUnits(
      charge.units,
      charge.has_unit_events === 1,
      eventsByFixedCharge.get(charge.id) ?? [],
      periodStart,
      calculationPeriodEnd,
      fullPeriodDays,
      subscription.billing_timezone,
    );
    return {
      ...charge,
      units: periodUnits.fullUnits,
      prorated_units: periodUnits.proratedUnits,
    };
  });
}

const MAX_FIXED_CHARGE_PERIOD_EVENTS = 1_000;

async function minimumCommitmentAmount(database: D1Database, planId: string): Promise<number> {
  const commitment = await database
    .prepare("SELECT amount_minor FROM minimum_commitments WHERE plan_id = ? LIMIT 1")
    .bind(planId)
    .first<{ amount_minor: number }>();
  return commitment?.amount_minor ?? 0;
}

async function loadHistoricalCommitmentFees(
  database: D1Database,
  subscription: BillableSubscription,
  currentInvoiceId: string,
  periodStart: string,
  periodEnd: string,
): Promise<{ roundedMinor: number; preciseMinor: Decimal }> {
  const result = await database
    .prepare(
      `SELECT line.amount_minor,
              COALESCE(line.precise_amount_minor, CAST(line.amount_minor AS TEXT))
                AS precise_amount_minor
       FROM invoice_lines line JOIN invoices invoice ON invoice.id = line.invoice_id
       WHERE invoice.organization_id = ? AND invoice.id <> ?
         AND invoice.status IN ('draft', 'finalized')
         AND EXISTS (
           SELECT 1 FROM invoice_subscriptions owned
           WHERE owned.invoice_id = invoice.id AND owned.subscription_id = ?
             AND owned.period_start IS NOT NULL AND owned.period_end IS NOT NULL
             AND owned.period_start < ? AND owned.period_end > ?
         )
         AND (
           (line.line_type = 'subscription' AND line.source_type = 'plan'
             AND line.source_id = ?)
           OR (line.line_type = 'usage' AND EXISTS (
             SELECT 1 FROM charges charge
             WHERE charge.plan_id = ?
               AND charge.id = COALESCE(json_extract(line.metadata_json, '$.chargeId'),
                                        line.source_id)
           ))
           OR (line.line_type = 'fixed_charge' AND EXISTS (
             SELECT 1 FROM fixed_charges fixed
             WHERE fixed.plan_id = ? AND fixed.id = line.source_id
           ))
         )
       ORDER BY invoice.created_at, invoice.id, line.id LIMIT 10001`,
    )
    .bind(
      subscription.organization_id,
      currentInvoiceId,
      subscription.id,
      periodEnd,
      periodStart,
      subscription.plan_id,
      subscription.plan_id,
      subscription.plan_id,
    )
    .all<{ amount_minor: number; precise_amount_minor: string }>();
  if (result.results.length > 10000) throw new Error("commitment_fee_history_too_large");
  let roundedMinor = 0;
  let preciseMinor = Decimal.zero();
  for (const row of result.results) {
    roundedMinor = safeAdd(roundedMinor, row.amount_minor);
    preciseMinor = preciseMinor.add(Decimal.parse(row.precise_amount_minor));
  }
  return { roundedMinor, preciseMinor };
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
         AND deleted_at IS NULL
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

type WeightedTargetBaselines = Map<string | null, Decimal>;

type WeightedBaselines = {
  base: WeightedTargetBaselines;
  filters: Map<string, WeightedTargetBaselines>;
};

function zeroWeightedBaselines(filters: ChargeFilter[]): WeightedBaselines {
  return {
    base: new Map(),
    filters: new Map(filters.map((filter) => [filter.lagoId, new Map()])),
  };
}

async function recurringWeightedBaseline(
  database: D1Database,
  subscription: BillableSubscription,
  metricId: string,
  fieldName: string | null,
  periodStartMs: number,
  filters: ChargeFilter[],
  acceptsTargetWallet: boolean,
): Promise<WeightedBaselines> {
  if (!fieldName) throw new Error("aggregation_field_name_required");
  const result = await database
    .prepare(
      `SELECT id, timestamp_ms, properties_json FROM usage_events
       WHERE organization_id = ? AND external_subscription_id = ? AND billable_metric_id = ?
         AND deleted_at IS NULL AND timestamp_ms < ?
       ORDER BY timestamp_ms, id LIMIT 10001`,
    )
    .bind(subscription.organization_id, subscription.external_id, metricId, periodStartMs)
    .all<{ id: string; timestamp_ms: number; properties_json: string }>();
  if (result.results.length > 10000) throw new Error("usage_baseline_too_large");
  const events = result.results.map((event) => ({
    id: event.id,
    timestampMs: event.timestamp_ms,
    properties: parseObject(event.properties_json),
  }));
  const partitions = partitionUsageEvents(events, filters);
  const sumGroups = (partitionEvents: typeof events): WeightedTargetBaselines => {
    if (acceptsTargetWallet && partitionEvents.length === 0) return new Map();
    return new Map(
      targetWalletEventGroups(partitionEvents, acceptsTargetWallet).map(
        ({ targetWalletCode, events: groupEvents }) => [
          targetWalletCode,
          groupEvents.reduce((total, event) => {
            const value = event.properties[fieldName];
            if (typeof value !== "string" && typeof value !== "number") {
              throw new Error("aggregation_property_must_be_numeric");
            }
            return total.add(Decimal.parse(value));
          }, Decimal.zero()),
        ],
      ),
    );
  };
  return {
    base: sumGroups(partitions.base),
    filters: new Map(
      partitions.filters.map(({ filter, events: filterEvents }) => [
        filter.lagoId,
        sumGroups(filterEvents),
      ]),
    ),
  };
}

type RatedUsageEvent = Awaited<ReturnType<typeof loadEvents>>[number];

function targetWalletEventGroups(
  events: RatedUsageEvent[],
  acceptsTargetWallet: boolean,
  baselineCodes: Iterable<string | null> = [],
): Array<{ targetWalletCode: string | null; events: RatedUsageEvent[] }> {
  if (!acceptsTargetWallet) return [{ targetWalletCode: null, events }];
  const grouped = new Map<string | null, RatedUsageEvent[]>();
  for (const code of baselineCodes) grouped.set(code, []);
  for (const event of events) {
    const value = event.properties.target_wallet_code;
    const code = typeof value === "string" && value.trim() ? value.trim() : null;
    const values = grouped.get(code) ?? [];
    values.push(event);
    grouped.set(code, values);
  }
  if (grouped.size === 0) grouped.set(null, []);
  return [...grouped.entries()]
    .sort(([left], [right]) => {
      if (left === right) return 0;
      if (left === null) return -1;
      if (right === null) return 1;
      return left.localeCompare(right);
    })
    .map(([targetWalletCode, groupedEvents]) => ({
      targetWalletCode,
      events: groupedEvents,
    }));
}

function proratedChargeMinimum(minimumMinor: number, options: SubscriptionInvoiceOptions): Decimal {
  const minimum = Decimal.parse(minimumMinor);
  if (options.context !== "termination") return minimum;
  return minimum
    .multiply(Decimal.parse(options.window.billableDays))
    .divideByInteger(BigInt(options.window.fullPeriodDays));
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
    value === "weighted_sum_agg" ||
    value === "latest_agg" ||
    value === "custom_agg"
  ) {
    return value;
  }
  throw new Error(`unsupported_aggregation_type:${value}`);
}

function allocateInvoiceLineDiscounts(
  lines: SubscriptionInvoiceLine[],
  discountMinor: number,
): Map<string, number> {
  if (discountMinor === 0) return new Map();
  const baseMinor = lines.reduce((sum, line) => safeAdd(sum, line.rounded), 0);
  if (discountMinor < 0 || discountMinor > baseMinor) {
    throw new Error("invalid_invoice_line_discount");
  }
  const allocations = lines.map((line) => {
    const numerator = BigInt(discountMinor) * BigInt(line.rounded);
    return {
      lineId: line.id,
      amountMinor: Number(numerator / BigInt(baseMinor)),
      remainder: numerator % BigInt(baseMinor),
    };
  });
  let undistributed =
    discountMinor - allocations.reduce((sum, allocation) => sum + allocation.amountMinor, 0);
  allocations.sort((left, right) => {
    if (left.remainder === right.remainder) return left.lineId.localeCompare(right.lineId);
    return left.remainder > right.remainder ? -1 : 1;
  });
  for (const allocation of allocations) {
    if (undistributed <= 0) break;
    allocation.amountMinor += 1;
    undistributed -= 1;
  }
  return new Map(allocations.map((allocation) => [allocation.lineId, allocation.amountMinor]));
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
