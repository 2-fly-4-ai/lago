import type { DomainEvent } from "../domain-events";
import { deterministicUuid } from "../identifiers";
import { stableJson } from "../json";
import { rateCharge, rateProratedFixedCharge } from "../rating/charge-models";
import { Decimal } from "../rating/decimal";
import { parseChargeModel } from "../usage/charge-properties";
import { couponCreditStatements } from "./coupon-credits";
import { creditNoteAllocationStatements } from "./credit-note-credits";
import { manualTaxStatements } from "./manual-taxes";
import { paymentDueDate } from "./payment-terms";
import { billingPeriodProration, initialPlanProration, localDateString } from "./periods";
import {
  calculateInvoiceAllocations,
  findBillableSubscription,
  invoiceSubscriptionStatement,
  subscriptionInvoiceLineStatements,
  type BillableSubscription,
  type SubscriptionInvoiceReason,
  type SubscriptionInvoiceLine,
} from "./subscription-invoice-calculation";
import { walletAllocationStatements } from "./wallet-credits";

type AdvanceFixedChargeRow = {
  id: string;
  code: string;
  invoice_display_name: string | null;
  charge_model: string;
  properties_json: string;
  units: string;
  prorated: number;
  add_on_code: string;
  add_on_name: string;
  add_on_invoice_display_name: string | null;
};

export type PayInAdvanceFixedChargeInvoiceResult = {
  invoiceId: string;
  lineCount: number;
  totalDueMinor: number;
  replayed: boolean;
};

export async function createInitialPayInAdvanceFixedChargeInvoice(
  env: Env,
  subscriptionId: string,
  effectiveAt: string,
  correlationId: string,
): Promise<PayInAdvanceFixedChargeInvoiceResult | null> {
  const subscription = await findBillableSubscription(env.BILLING_DB, subscriptionId);
  if (!subscription) throw new Error("subscription_not_found");
  const charges = await loadAdvanceFixedCharges(
    env.BILLING_DB,
    subscription.organization_id,
    subscription.plan_id,
  );
  if (charges.length === 0) return null;

  const commandKey = `${subscription.id}:${effectiveAt}:initial`;
  const invoiceId = await deterministicUuid("pay-in-advance-fixed-charge-invoice", commandKey);
  const existing = await env.BILLING_DB.prepare(
    "SELECT total_due_minor FROM invoices WHERE id = ? LIMIT 1",
  )
    .bind(invoiceId)
    .first<{ total_due_minor: number }>();
  if (existing) {
    return {
      invoiceId,
      lineCount: charges.length,
      totalDueMinor: existing.total_due_minor,
      replayed: true,
    };
  }

  const proration = initialPlanProration(
    new Date(effectiveAt),
    new Date(subscription.current_period_end),
    subscription.billing_time,
    subscription.interval,
    subscription.billing_timezone,
  );
  const lines: SubscriptionInvoiceLine[] = [];
  for (const charge of charges) {
    const model = parseChargeModel(charge.charge_model, parseObject(charge.properties_json));
    const proratedUnits = Decimal.parse(charge.units)
      .multiply(Decimal.parse(proration.billableDays))
      .divideByInteger(BigInt(proration.fullPeriodDays));
    const precise = Decimal.parse(
      (charge.prorated === 1
        ? rateProratedFixedCharge(charge.units, proratedUnits.toString(), model)
        : rateCharge(charge.units, model)
      ).amountCents,
    );
    lines.push({
      id: await deterministicUuid("pay-in-advance-fixed-charge-line", `${invoiceId}:${charge.id}`),
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
        periodStart: subscription.current_period_start,
        periodEnd: subscription.current_period_end,
        effectiveAt,
        ...(charge.prorated === 1
          ? {
              prorated: true,
              proratedUnits: proratedUnits.toString(),
              billableDays: proration.billableDays,
              fullPeriodDays: proration.fullPeriodDays,
            }
          : {}),
      }),
    });
  }

  const invoice = await persistPayInAdvanceFixedChargeInvoice(
    env,
    subscription,
    invoiceId,
    effectiveAt,
    lines,
    correlationId,
    "subscription_starting",
  );
  return invoice;
}

export async function createPayInAdvanceFixedChargeDeltaInvoice(
  env: Env,
  subscriptionId: string,
  effectiveAt: string,
  correlationId: string,
): Promise<PayInAdvanceFixedChargeInvoiceResult | null> {
  const subscription = await findBillableSubscription(env.BILLING_DB, subscriptionId);
  if (!subscription) throw new Error("subscription_not_found");
  const eventResult = await env.BILLING_DB.prepare(
    `SELECT fixed_charge_id, fixed_charge_version, units
     FROM fixed_charge_unit_events
     WHERE organization_id = ? AND subscription_id = ? AND effective_at = ?
     ORDER BY fixed_charge_id, fixed_charge_version DESC, id DESC LIMIT ?`,
  )
    .bind(
      subscription.organization_id,
      subscription.id,
      effectiveAt,
      MAX_ADVANCE_FIXED_CHARGE_EVENTS + 1,
    )
    .all<{ fixed_charge_id: string; fixed_charge_version: number; units: string }>();
  if (eventResult.results.length > MAX_ADVANCE_FIXED_CHARGE_EVENTS) {
    throw new Error("pay_in_advance_fixed_charge_event_limit_exceeded");
  }
  const eventUnits = new Map<string, { units: string; version: number }>();
  for (const event of eventResult.results) {
    if (!eventUnits.has(event.fixed_charge_id)) {
      eventUnits.set(event.fixed_charge_id, {
        units: event.units,
        version: event.fixed_charge_version,
      });
    }
  }
  if (eventUnits.size === 0) return null;
  const charges = (
    await loadAdvanceFixedCharges(
      env.BILLING_DB,
      subscription.organization_id,
      subscription.plan_id,
    )
  ).filter((charge) => eventUnits.has(charge.id));
  if (charges.length === 0) return null;

  const paidResult = await env.BILLING_DB.prepare(
    `SELECT line.source_id, line.quantity_decimal
     FROM invoice_lines line JOIN invoices invoice ON invoice.id = line.invoice_id
     WHERE invoice.organization_id = ? AND invoice.subscription_id = ?
       AND line.line_type = 'fixed_charge'
       AND json_extract(line.metadata_json, '$.billingMode') = 'in_advance'
       AND json_extract(line.metadata_json, '$.periodStart') = ?
       AND json_extract(line.metadata_json, '$.periodEnd') = ?
       AND line.source_id IN (
         SELECT fixed_charge_id FROM fixed_charge_unit_events
         WHERE organization_id = ? AND subscription_id = ? AND effective_at = ?
       )
     ORDER BY line.created_at, line.id LIMIT ?`,
  )
    .bind(
      subscription.organization_id,
      subscription.id,
      subscription.current_period_start,
      subscription.current_period_end,
      subscription.organization_id,
      subscription.id,
      effectiveAt,
      MAX_ADVANCE_FIXED_CHARGE_LINES + 1,
    )
    .all<{ source_id: string; quantity_decimal: string }>();
  if (paidResult.results.length > MAX_ADVANCE_FIXED_CHARGE_LINES) {
    throw new Error("pay_in_advance_fixed_charge_line_limit_exceeded");
  }
  const paidUnits = new Map<string, Decimal>();
  for (const paid of paidResult.results) {
    paidUnits.set(
      paid.source_id,
      (paidUnits.get(paid.source_id) ?? Decimal.zero()).add(Decimal.parse(paid.quantity_decimal)),
    );
  }

  const proration =
    subscription.billing_time === "calendar"
      ? initialPlanProration(
          new Date(effectiveAt),
          new Date(subscription.current_period_end),
          subscription.billing_time,
          subscription.interval,
          subscription.billing_timezone,
        )
      : billingPeriodProration(
          new Date(effectiveAt),
          new Date(subscription.current_period_start),
          new Date(subscription.current_period_end),
          subscription.billing_timezone,
        );
  const invoiceId = await deterministicUuid(
    "pay-in-advance-fixed-charge-invoice",
    `${subscription.id}:${effectiveAt}:delta:${charges
      .map((charge) => `${charge.id}:v${eventUnits.get(charge.id)!.version}`)
      .sort()
      .join(",")}`,
  );
  const lines: SubscriptionInvoiceLine[] = [];
  for (const charge of charges) {
    const requestedUnits = Decimal.parse(eventUnits.get(charge.id)!.units);
    const previouslyPaidUnits = paidUnits.get(charge.id) ?? Decimal.zero();
    const delta = requestedUnits.subtract(previouslyPaidUnits);
    const billedUnits = delta.isNegative() || delta.isZero() ? Decimal.zero() : delta;
    const proratedUnits = billedUnits
      .multiply(Decimal.parse(proration.billableDays))
      .divideByInteger(BigInt(proration.fullPeriodDays));
    const model = parseChargeModel(charge.charge_model, parseObject(charge.properties_json));
    const precise = Decimal.parse(
      (charge.prorated === 1
        ? rateProratedFixedCharge(billedUnits.toString(), proratedUnits.toString(), model)
        : rateCharge(billedUnits.toString(), model)
      ).amountCents,
    );
    lines.push({
      id: await deterministicUuid("pay-in-advance-fixed-charge-line", `${invoiceId}:${charge.id}`),
      description:
        charge.invoice_display_name ?? charge.add_on_invoice_display_name ?? charge.add_on_name,
      units: billedUnits.toString(),
      precise: precise.toString(),
      rounded: safeMinorInteger(precise),
      sourceId: charge.id,
      lineType: "fixed_charge",
      sourceType: "fixed_charge",
      metadataJson: stableJson({
        contextType: "in_advance_charge_delta",
        billingMode: "in_advance",
        fixedChargeCode: charge.code,
        addOnCode: charge.add_on_code,
        chargeModel: charge.charge_model,
        periodStart: subscription.current_period_start,
        periodEnd: subscription.current_period_end,
        effectiveAt,
        requestedUnits: requestedUnits.toString(),
        previouslyPaidUnits: previouslyPaidUnits.toString(),
        ...(charge.prorated === 1
          ? {
              prorated: true,
              proratedUnits: proratedUnits.toString(),
              billableDays: proration.billableDays,
              fullPeriodDays: proration.fullPeriodDays,
            }
          : {}),
      }),
    });
  }
  const invoice = await persistPayInAdvanceFixedChargeInvoice(
    env,
    subscription,
    invoiceId,
    effectiveAt,
    lines,
    correlationId,
    "subscription_periodic",
  );
  const billedAt = new Date().toISOString();
  await env.BILLING_DB.prepare(
    `UPDATE fixed_charge_unit_events
     SET advance_billed_at = COALESCE(advance_billed_at, ?),
         advance_invoice_id = COALESCE(advance_invoice_id, ?)
     WHERE organization_id = ? AND subscription_id = ? AND effective_at = ?
       AND bill_immediately = 1 AND fixed_charge_id IN (
         SELECT id FROM fixed_charges WHERE organization_id = ? AND plan_id = ?
           AND active = 1 AND pay_in_advance = 1
       )`,
  )
    .bind(
      billedAt,
      invoice.invoiceId,
      subscription.organization_id,
      subscription.id,
      effectiveAt,
      subscription.organization_id,
      subscription.plan_id,
    )
    .run();
  return invoice;
}

const MAX_ADVANCE_FIXED_CHARGE_EVENTS = 200;
const MAX_ADVANCE_FIXED_CHARGE_LINES = 1_000;

export async function repairPendingPayInAdvanceFixedChargeInvoices(
  env: Env,
  dueAt: string,
  correlationId: string,
): Promise<number> {
  const result = await env.BILLING_DB.prepare(
    `SELECT DISTINCT event.subscription_id, event.effective_at
     FROM fixed_charge_unit_events event
     JOIN subscriptions subscription ON subscription.id = event.subscription_id
     JOIN fixed_charges fixed ON fixed.id = event.fixed_charge_id
     WHERE event.bill_immediately = 1 AND event.advance_billed_at IS NULL
       AND event.effective_at <= ? AND subscription.status IN ('active', 'past_due')
       AND subscription.plan_id = fixed.plan_id AND fixed.active = 1 AND fixed.pay_in_advance = 1
     ORDER BY event.effective_at, event.subscription_id LIMIT 100`,
  )
    .bind(dueAt)
    .all<{ subscription_id: string; effective_at: string }>();
  let repaired = 0;
  for (const pending of result.results) {
    const invoice = await createPayInAdvanceFixedChargeDeltaInvoice(
      env,
      pending.subscription_id,
      pending.effective_at,
      correlationId,
    );
    if (invoice) repaired += 1;
  }
  const missingInitial = await env.BILLING_DB.prepare(
    `SELECT subscription.id, subscription.started_at
     FROM subscriptions subscription
     WHERE subscription.status IN ('active', 'past_due')
       AND subscription.previous_subscription_id IS NULL
       AND subscription.started_at IS NOT NULL
       AND subscription.started_at = subscription.current_period_start
       AND subscription.started_at <= ?
       AND EXISTS (
         SELECT 1 FROM fixed_charges fixed
         WHERE fixed.plan_id = subscription.plan_id AND fixed.active = 1
           AND fixed.pay_in_advance = 1
       )
       AND NOT EXISTS (
         SELECT 1 FROM invoices invoice JOIN invoice_lines line ON line.invoice_id = invoice.id
         WHERE invoice.subscription_id = subscription.id AND line.line_type = 'fixed_charge'
           AND json_extract(line.metadata_json, '$.billingMode') = 'in_advance'
           AND json_extract(line.metadata_json, '$.periodStart') = subscription.current_period_start
           AND json_extract(line.metadata_json, '$.periodEnd') = subscription.current_period_end
       )
     ORDER BY subscription.started_at, subscription.id LIMIT 100`,
  )
    .bind(dueAt)
    .all<{ id: string; started_at: string }>();
  for (const subscription of missingInitial.results) {
    const invoice = await createInitialPayInAdvanceFixedChargeInvoice(
      env,
      subscription.id,
      subscription.started_at,
      correlationId,
    );
    if (invoice) repaired += 1;
  }
  return repaired;
}

async function persistPayInAdvanceFixedChargeInvoice(
  env: Env,
  subscription: BillableSubscription,
  invoiceId: string,
  effectiveAt: string,
  lines: SubscriptionInvoiceLine[],
  correlationId: string,
  invoicingReason: SubscriptionInvoiceReason,
): Promise<PayInAdvanceFixedChargeInvoiceResult> {
  const calculation = await calculateInvoiceAllocations(
    env.BILLING_DB,
    subscription,
    invoiceId,
    lines,
  );
  const now = new Date().toISOString();
  const issuingDate = localDateString(new Date(effectiveAt), subscription.billing_timezone);
  const dueDate = paymentDueDate(issuingDate, subscription.net_payment_term);
  const event: DomainEvent = {
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
      organizationId: subscription.organization_id,
      subscriptionId: subscription.id,
      inAdvanceCharge: true,
      totalDueMinor: calculation.totalDueMinor,
      currency: subscription.currency,
      periodStart: subscription.current_period_start,
      periodEnd: subscription.current_period_end,
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
      subscription.organization_id,
      subscription.customer_id,
      subscription.id,
      invoiceId.replaceAll("-", "").slice(0, 20).toUpperCase(),
      calculation.totalDueMinor > 0 ? "pending" : "succeeded",
      subscription.currency,
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
      subscription.net_payment_term,
      dueDate,
      issuingDate,
    ),
    ...subscriptionInvoiceLineStatements(env.BILLING_DB, invoiceId, null, lines, now),
    ...couponCreditStatements(
      env.BILLING_DB,
      subscription.organization_id,
      invoiceId,
      subscription.currency,
      calculation.couponCredits,
      now,
      correlationId,
    ),
    ...manualTaxStatements(
      env.BILLING_DB,
      subscription.organization_id,
      invoiceId,
      subscription.currency,
      calculation.invoiceTaxes,
      now,
    ),
    ...calculation.creditNoteAllocations.flatMap((allocation) =>
      creditNoteAllocationStatements(
        env.BILLING_DB,
        subscription.organization_id,
        invoiceId,
        allocation,
        now,
        correlationId,
      ),
    ),
    ...calculation.walletAllocations.flatMap((allocation) =>
      walletAllocationStatements(
        env.BILLING_DB,
        subscription.organization_id,
        invoiceId,
        allocation,
        now,
        correlationId,
      ),
    ),
    invoiceSubscriptionStatement(
      env.BILLING_DB,
      invoiceId,
      subscription.id,
      subscription.organization_id,
      invoicingReason,
      subscription.current_period_start,
      subscription.current_period_end,
      now,
    ),
    env.BILLING_DB.prepare(
      `INSERT INTO outbox_events
       (event_id, organization_id, event_type, event_version, aggregate_type,
        aggregate_id, aggregate_version, causation_id, correlation_id, payload_json,
        occurred_at, published_at)
       VALUES (?, ?, ?, 1, 'invoice', ?, 1, ?, ?, ?, ?, NULL)`,
    ).bind(
      event.id,
      subscription.organization_id,
      event.type,
      invoiceId,
      correlationId,
      correlationId,
      stableJson(event.payload),
      now,
    ),
  ];

  try {
    await env.BILLING_DB.batch(statements);
  } catch (error) {
    const concurrent = await env.BILLING_DB.prepare(
      "SELECT total_due_minor FROM invoices WHERE id = ? LIMIT 1",
    )
      .bind(invoiceId)
      .first<{ total_due_minor: number }>();
    if (!concurrent) throw error;
    return {
      invoiceId,
      lineCount: lines.length,
      totalDueMinor: concurrent.total_due_minor,
      replayed: true,
    };
  }
  await env.DOMAIN_EVENTS.send(event);
  return {
    invoiceId,
    lineCount: lines.length,
    totalDueMinor: calculation.totalDueMinor,
    replayed: false,
  };
}

async function loadAdvanceFixedCharges(
  database: D1Database,
  organizationId: string,
  planId: string,
): Promise<AdvanceFixedChargeRow[]> {
  const result = await database
    .prepare(
      `SELECT fc.id, fc.code, fc.invoice_display_name, fc.charge_model,
              fc.properties_json, fc.units, fc.prorated, ao.code AS add_on_code,
              ao.name AS add_on_name, ao.invoice_display_name AS add_on_invoice_display_name
       FROM fixed_charges fc JOIN add_ons ao ON ao.id = fc.add_on_id
       WHERE fc.organization_id = ? AND fc.plan_id = ? AND fc.active = 1
         AND fc.pay_in_advance = 1
       ORDER BY fc.created_at, fc.id`,
    )
    .bind(organizationId, planId)
    .all<AdvanceFixedChargeRow>();
  return [...result.results];
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
