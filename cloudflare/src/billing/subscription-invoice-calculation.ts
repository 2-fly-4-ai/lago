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
import {
  billingPeriodProration,
  followingPeriodEnd,
  initialPlanProration,
  type BillingTime,
} from "./periods";
import { calculateWalletAllocations, type WalletAllocation } from "./wallet-credits";
import type { WalletFeeBucket, WalletFeeType } from "./wallet-limitations";

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
  accepts_target_wallet: number;
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
  persistenceSourceId?: string;
  billableMetricId?: string | null;
  targetWalletCode?: string | null;
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

export type InvoiceAllocationOwner = Pick<
  BillableSubscription,
  "organization_id" | "customer_id" | "currency"
>;

export type InvoiceAllocationCalculation = Omit<
  SubscriptionInvoiceCalculation,
  "lines" | "nextPeriodEnd"
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
  const allocations = await calculateInvoiceAllocations(database, subscription, invoiceId, lines);
  return { lines, ...allocations, nextPeriodEnd: periodEnd };
}

export async function calculateInvoiceAllocations(
  database: D1Database,
  owner: InvoiceAllocationOwner,
  invoiceId: string,
  lines: SubscriptionInvoiceLine[],
  additionalCreditNote?: { creditNoteId: string; amountMinor: number },
): Promise<InvoiceAllocationCalculation> {
  const subtotalMinor = lines.reduce((total, line) => safeAdd(total, line.rounded), 0);
  const couponCredits = await calculateCouponCredits(
    database,
    owner.organization_id,
    owner.customer_id,
    invoiceId,
    owner.currency,
    subtotalMinor,
  );
  const couponsMinor = couponCredits.reduce(
    (total, credit) => safeAdd(total, credit.amountMinor),
    0,
  );
  const invoiceTaxes = await calculateManualTaxes(
    database,
    owner.organization_id,
    invoiceId,
    lines.map((candidate) => ({ id: candidate.id, amountMinor: candidate.rounded })),
    couponsMinor,
  );
  const taxMinor = totalManualTaxMinor(invoiceTaxes);
  const creditNoteAllocations = await calculateCreditNoteAllocations(
    database,
    owner.organization_id,
    owner.customer_id,
    invoiceId,
    owner.currency,
    subtotalMinor + taxMinor - couponsMinor,
  );
  let creditNotesMinor = creditNoteAllocations.reduce(
    (total, allocation) => safeAdd(total, allocation.amountMinor),
    0,
  );
  if (additionalCreditNote) {
    const remainingDue = subtotalMinor + taxMinor - couponsMinor - creditNotesMinor;
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
    subtotalMinor + taxMinor - couponsMinor - creditNotesMinor,
    walletFeeBuckets(lines, invoiceTaxes),
  );
  const prepaidCreditMinor = walletAllocations.reduce(
    (total, allocation) => safeAdd(total, allocation.amountMinor),
    0,
  );
  const creditsMinor = safeAdd(safeAdd(couponsMinor, creditNotesMinor), prepaidCreditMinor);
  return {
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
    options.context === "termination" ? options.window.usagePeriodEnd : periodEnd;
  const calculationPeriodEndMs = Date.parse(calculationPeriodEnd);
  if (!Number.isFinite(calculationPeriodEndMs) || calculationPeriodEndMs <= periodStartMs) {
    throw new Error("invalid_calculation_period");
  }
  const cycleKey =
    options.context === "renewal"
      ? `${subscription.id}:${periodStart}:${periodEnd}`
      : `${subscription.id}:${periodStart}:${calculationPeriodEnd}:termination`;
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
  let includePlanLine = !(
    options.context === "termination" && subscription.plan_pay_in_advance === 1
  );
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
    for (const group of targetWalletEventGroups(events, charge.accepts_target_wallet === 1)) {
      const units = aggregateUsage(
        supportedAggregation(charge.aggregation_type),
        charge.field_name,
        group.events,
      );
      let precise = Decimal.parse(
        rateCharge(
          units.toString(),
          parseChargeModel(charge.charge_model, parseObject(charge.properties_json)),
          { eventsCount: group.events.length },
        ).amountCents,
      );
      const minimum = Decimal.parse(charge.min_amount_minor);
      if (precise.compare(minimum) < 0) precise = minimum;
      const rounded = safeMinorInteger(precise);
      subtotalMinor = safeAdd(subtotalMinor, rounded);
      const groupKey = group.targetWalletCode ?? "untargeted";
      const targeted = charge.accepts_target_wallet === 1;
      lines.push({
        id: await deterministicUuid(
          "billing-cycle-line",
          targeted ? `${cycleKey}:${charge.id}:wallet:${groupKey}` : `${cycleKey}:${charge.id}`,
        ),
        description: charge.invoice_display_name ?? charge.metric_name,
        units: units.toString(),
        precise: precise.toString(),
        rounded,
        sourceId: charge.id,
        persistenceSourceId: targeted
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
          periodStart,
          periodEnd: calculationPeriodEnd,
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
        billingCycleId: options.context === "renewal" ? billingCycleId : undefined,
        fixedChargeCode: charge.code,
        addOnCode: charge.add_on_code,
        chargeModel: charge.charge_model,
        periodStart,
        periodEnd: calculationPeriodEnd,
        ...(options.context === "termination" ? { contextType: "termination" } : {}),
      }),
    });
  }

  const preciseFees = lines.reduce(
    (total, line) => total.add(Decimal.parse(line.precise)),
    Decimal.zero(),
  );
  const commitmentTargetMinor =
    options.context === "termination" && subscription.plan_pay_in_advance === 0
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
          subtotalMinor,
          preciseFees,
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
              billableDays: options.window.billableDays,
              fullPeriodDays: options.window.fullPeriodDays,
            }
          : {}),
      }),
    });
  }

  const allocations = await calculateInvoiceAllocations(
    database,
    subscription,
    invoiceId,
    lines,
    options.context === "termination" ? options.additionalCreditNote : undefined,
  );
  return {
    lines,
    ...allocations,
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
  const unsupported = await database
    .prepare(
      `SELECT EXISTS(SELECT 1 FROM minimum_commitments
                WHERE organization_id = ? AND plan_id = ?) AS minimum_commitment`,
    )
    .bind(subscription.organization_id, subscription.plan_id)
    .first<{ minimum_commitment: number }>();
  if (unsupported?.minimum_commitment === 1 && subscription.plan_pay_in_advance === 1) {
    throw new Error("unsupported_termination_minimum_commitment");
  }
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
              ch.properties_json, ch.min_amount_minor, bm.id AS metric_id,
              bm.code AS metric_code, bm.name AS metric_name,
              bm.aggregation_type, bm.field_name, ch.accepts_target_wallet
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

async function minimumCommitmentAmount(database: D1Database, planId: string): Promise<number> {
  const commitment = await database
    .prepare("SELECT amount_minor FROM minimum_commitments WHERE plan_id = ? LIMIT 1")
    .bind(planId)
    .first<{ amount_minor: number }>();
  return commitment?.amount_minor ?? 0;
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

type RatedUsageEvent = Awaited<ReturnType<typeof loadEvents>>[number];

function targetWalletEventGroups(
  events: RatedUsageEvent[],
  acceptsTargetWallet: boolean,
): Array<{ targetWalletCode: string | null; events: RatedUsageEvent[] }> {
  if (!acceptsTargetWallet) return [{ targetWalletCode: null, events }];
  const grouped = new Map<string | null, RatedUsageEvent[]>();
  if (events.length === 0) grouped.set(null, []);
  for (const event of events) {
    const value = event.properties.target_wallet_code;
    const code = typeof value === "string" && value.trim() ? value.trim() : null;
    const values = grouped.get(code) ?? [];
    values.push(event);
    grouped.set(code, values);
  }
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
