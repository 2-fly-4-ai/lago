import { sha256Hex } from "../auth/api-key";
import type { DomainEvent } from "../domain-events";
import { deterministicUuid } from "../identifiers";
import { stableJson } from "../json";
import { rateCharge } from "../rating/charge-models";
import { Decimal } from "../rating/decimal";
import { aggregateUsage, type SupportedAggregationType } from "../usage/aggregation";
import { parseChargeModel } from "../usage/charge-properties";
import { nextPeriodEnd } from "./periods";
import { calculateCouponCredits } from "./coupon-credits";
import { calculateWalletAllocations, walletAllocationStatements } from "./wallet-credits";
import {
  calculateCreditNoteAllocations,
  creditNoteAllocationStatements,
} from "./credit-note-credits";
import { calculateManualTaxes, manualTaxStatements, totalManualTaxMinor } from "./manual-taxes";
import { calculateMinimumCommitmentLine } from "./minimum-commitment";

type SubscriptionRow = {
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
  plan_amount_minor: number;
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

export type CloseBillingPeriodResult = {
  billingCycleId: string;
  invoiceId: string;
  replayed: boolean;
  totalDueMinor: number;
  lineCount: number;
  nextPeriodEnd: string;
};

export async function closeBillingPeriod(
  env: Env,
  subscriptionId: string,
  expectedPeriodEnd: string,
  correlationId: string,
): Promise<CloseBillingPeriodResult> {
  const subscription = await findSubscription(env.BILLING_DB, subscriptionId);
  if (!subscription) throw new Error("subscription_not_found");
  if (subscription.current_period_end !== expectedPeriodEnd) {
    const replay = await findClosedCycle(
      env.BILLING_DB,
      subscriptionId,
      subscription.current_period_start,
      expectedPeriodEnd,
    );
    if (replay) return replay;
    throw new Error("billing_period_changed");
  }

  const periodStart = subscription.current_period_start;
  const periodEnd = subscription.current_period_end;
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
  const cycleId = await deterministicUuid("billing-cycle", cycleKey);
  const requestHash = await sha256Hex(cycleKey);
  const invoiceId = await deterministicUuid("billing-cycle-invoice", cycleKey);
  const existing = await findCycle(env.BILLING_DB, subscription.id, periodStart, periodEnd);
  if (existing?.status === "closed" && existing.invoice_id) {
    return cycleResult(env.BILLING_DB, existing.id, existing.invoice_id, true, periodEnd);
  }

  const reservationKey = `billing-cycle:${subscription.id}:${periodStart}:${periodEnd}`;
  const billingAccount = env.BILLING_ACCOUNTS.getByName(`customer:${subscription.customer_id}`);
  let reservation = await billingAccount.reserveCommand({
    idempotencyKey: reservationKey,
    commandType: "subscription.period.close",
    requestHash,
  });
  if (!reservation.ok) throw new Error(reservation.error);
  if (reservation.replayed && reservation.reservation.status === "completed") {
    const completed = parseCompletedReservation(reservation.reservation.responseJson);
    if (completed) return { ...completed, replayed: true };
  }
  const now = new Date().toISOString();
  const leaseExpiresAt = new Date(Date.now() + 3 * 60 * 1000).toISOString();
  if (reservation.replayed && !existing) {
    const staleBefore = Date.now() - 3 * 60 * 1000;
    if (Date.parse(reservation.reservation.createdAt) > staleBefore) {
      throw new Error("billing_period_close_in_progress");
    }
    await billingAccount.releaseCommand(reservationKey, requestHash);
    reservation = await billingAccount.reserveCommand({
      idempotencyKey: reservationKey,
      commandType: "subscription.period.close",
      requestHash,
    });
    if (!reservation.ok || reservation.replayed)
      throw new Error("billing_period_close_in_progress");
  }
  if (!existing) {
    await env.BILLING_DB.prepare(
      `INSERT INTO billing_cycles
       (id, organization_id, subscription_id, period_start, period_end, period_start_ms,
        period_end_ms, status, request_sha256, invoice_id, lease_expires_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'closing', ?, NULL, ?, ?, ?)`,
    )
      .bind(
        cycleId,
        subscription.organization_id,
        subscription.id,
        periodStart,
        periodEnd,
        periodStartMs,
        periodEndMs,
        requestHash,
        leaseExpiresAt,
        now,
        now,
      )
      .run();
  } else if (existing.request_sha256 !== requestHash) {
    throw new Error("billing_cycle_idempotency_conflict");
  } else {
    const claim = await env.BILLING_DB.prepare(
      `UPDATE billing_cycles
       SET status = 'closing', failure_code = NULL, lease_expires_at = ?, updated_at = ?
       WHERE id = ? AND (
         status = 'failed' OR
         (status = 'closing' AND (lease_expires_at IS NULL OR lease_expires_at <= ?))
       )`,
    )
      .bind(leaseExpiresAt, now, existing.id, now)
      .run();
    if (claim.meta.changes !== 1) throw new Error("billing_period_close_in_progress");
  }

  try {
    const charges = await loadCharges(env.BILLING_DB, subscription);
    const lines: Array<{
      id: string;
      description: string;
      units: string;
      precise: string;
      rounded: number;
      sourceId: string;
      metadataJson: string;
    }> = [];
    let subtotal = subscription.plan_amount_minor;
    lines.push({
      id: await deterministicUuid("billing-cycle-plan-line", cycleKey),
      description: subscription.plan_name,
      units: "1",
      precise: String(subscription.plan_amount_minor),
      rounded: subscription.plan_amount_minor,
      sourceId: subscription.plan_id,
      metadataJson: stableJson({ billingCycleId: cycleId, periodStart, periodEnd }),
    });
    for (const charge of charges) {
      const events = await loadEvents(
        env.BILLING_DB,
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
          {
            eventsCount: events.length,
          },
        ).amountCents,
      );
      const minimum = Decimal.parse(charge.min_amount_minor);
      if (precise.compare(minimum) < 0) precise = minimum;
      const rounded = safeMinorInteger(precise);
      subtotal = safeAdd(subtotal, rounded);
      lines.push({
        id: await deterministicUuid("billing-cycle-line", `${cycleKey}:${charge.id}`),
        description: charge.invoice_display_name ?? charge.metric_name,
        units: units.toString(),
        precise: precise.toString(),
        rounded,
        sourceId: charge.id,
        metadataJson: stableJson({
          billingCycleId: cycleId,
          billableMetricCode: charge.metric_code,
          chargeCode: charge.code,
          chargeModel: charge.charge_model,
          eventCount: events.length,
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
      env.BILLING_DB,
      subscription.plan_id,
      invoiceId,
      subtotal,
      preciseFees,
    );
    if (commitmentLine) {
      subtotal = safeAdd(subtotal, commitmentLine.amountMinor);
      lines.push({
        id: commitmentLine.id,
        description: commitmentLine.description,
        units: "1",
        precise: commitmentLine.preciseAmountMinor,
        rounded: commitmentLine.amountMinor,
        sourceId: commitmentLine.commitmentId,
        metadataJson: stableJson({ billingCycleId: cycleId, periodStart, periodEnd }),
      });
    }

    const couponCredits = await calculateCouponCredits(
      env.BILLING_DB,
      subscription.organization_id,
      subscription.customer_id,
      invoiceId,
      subscription.currency,
      subtotal,
    );
    const couponsMinor = couponCredits.reduce(
      (total, credit) => safeAdd(total, credit.amountMinor),
      0,
    );
    const invoiceTaxes = await calculateManualTaxes(
      env.BILLING_DB,
      subscription.organization_id,
      invoiceId,
      lines.map((line) => ({ id: line.id, amountMinor: line.rounded })),
      couponsMinor,
    );
    const taxMinor = totalManualTaxMinor(invoiceTaxes);
    const creditNoteAllocations = await calculateCreditNoteAllocations(
      env.BILLING_DB,
      subscription.organization_id,
      subscription.customer_id,
      invoiceId,
      subscription.currency,
      subtotal + taxMinor - couponsMinor,
    );
    const creditNotesMinor = creditNoteAllocations.reduce(
      (total, allocation) => safeAdd(total, allocation.amountMinor),
      0,
    );
    const walletAllocations = await calculateWalletAllocations(
      env.BILLING_DB,
      subscription.organization_id,
      subscription.customer_id,
      invoiceId,
      subscription.currency,
      subtotal + taxMinor - couponsMinor - creditNotesMinor,
    );
    const prepaidCreditMinor = walletAllocations.reduce(
      (total, allocation) => safeAdd(total, allocation.amountMinor),
      0,
    );
    const creditsMinor = safeAdd(safeAdd(couponsMinor, creditNotesMinor), prepaidCreditMinor);
    const totalDue = subtotal + taxMinor - creditsMinor;
    const nextEnd = nextPeriodEnd(new Date(periodEnd), subscription.interval).toISOString();
    const invoiceNumber = invoiceId.replaceAll("-", "").slice(0, 20).toUpperCase();
    const domainEvent: DomainEvent = {
      id: `invoice-finalized:${invoiceId}:v1`,
      type: "invoice.finalized",
      version: 1,
      aggregateType: "invoice",
      aggregateId: invoiceId,
      aggregateVersion: 1,
      occurredAt: now,
      causationId: cycleId,
      correlationId,
      payload: {
        organizationId: subscription.organization_id,
        subscriptionId: subscription.id,
        billingCycleId: cycleId,
        couponsMinor,
        taxMinor,
        creditNotesMinor,
        prepaidCreditMinor,
        totalDueMinor: totalDue,
        currency: subscription.currency,
        periodStart,
        periodEnd,
      },
    };
    const statements: D1PreparedStatement[] = [
      env.BILLING_DB.prepare(
        `INSERT INTO invoices
         (id, organization_id, customer_id, subscription_id, number, status, payment_status,
          currency, subtotal_minor, tax_minor, credits_minor, total_due_minor, version,
          finalized_at, created_at, updated_at, coupons_minor, prepaid_credit_minor,
          credit_notes_minor)
         VALUES (?, ?, ?, ?, ?, 'finalized', 'pending', ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?)`,
      ).bind(
        invoiceId,
        subscription.organization_id,
        subscription.customer_id,
        subscription.id,
        invoiceNumber,
        subscription.currency,
        subtotal,
        taxMinor,
        creditsMinor,
        totalDue,
        now,
        now,
        now,
        couponsMinor,
        prepaidCreditMinor,
        creditNotesMinor,
      ),
      ...lines.map((line) =>
        env.BILLING_DB.prepare(
          `INSERT INTO invoice_lines
           (id, invoice_id, line_type, description, quantity_decimal, unit_amount_decimal,
            amount_minor, source_type, source_id, metadata_json, created_at,
            precise_amount_minor, billing_cycle_id)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).bind(
          line.id,
          invoiceId,
          line.sourceId === subscription.plan_id
            ? "subscription"
            : line.sourceId === commitmentLine?.commitmentId
              ? "commitment"
              : "usage",
          line.description,
          line.units,
          line.units === "0"
            ? "0"
            : Decimal.parse(line.precise).divide(Decimal.parse(line.units)).toString(),
          line.rounded,
          line.sourceId === subscription.plan_id
            ? "plan"
            : line.sourceId === commitmentLine?.commitmentId
              ? "commitment"
              : "charge",
          line.sourceId,
          line.metadataJson,
          now,
          line.precise,
          cycleId,
        ),
      ),
      ...couponCredits.flatMap((credit) => [
        env.BILLING_DB.prepare(
          `INSERT INTO coupon_credits
           (id, organization_id, invoice_id, applied_coupon_id, applied_coupon_version,
            amount_minor, currency, before_taxes, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?)`,
        ).bind(
          credit.id,
          subscription.organization_id,
          invoiceId,
          credit.appliedCouponId,
          credit.expectedVersion,
          credit.amountMinor,
          subscription.currency,
          now,
        ),
        env.BILLING_DB.prepare(
          `UPDATE applied_coupons
           SET frequency_duration_remaining = ?,
               status = CASE WHEN ? = 1 THEN 'terminated' ELSE status END,
               termination_reason = CASE WHEN ? = 1 THEN 'consumed' ELSE termination_reason END,
               terminated_at = CASE WHEN ? = 1 THEN ? ELSE terminated_at END,
               version = version + 1, updated_at = ?
           WHERE id = ? AND organization_id = ? AND status = 'active' AND version = ?`,
        ).bind(
          credit.nextRemaining,
          credit.terminates ? 1 : 0,
          credit.terminates ? 1 : 0,
          credit.terminates ? 1 : 0,
          now,
          now,
          credit.appliedCouponId,
          subscription.organization_id,
          credit.expectedVersion,
        ),
      ]),
      ...manualTaxStatements(
        env.BILLING_DB,
        subscription.organization_id,
        invoiceId,
        subscription.currency,
        invoiceTaxes,
        now,
      ),
      ...creditNoteAllocations.flatMap((allocation) =>
        creditNoteAllocationStatements(
          env.BILLING_DB,
          subscription.organization_id,
          invoiceId,
          allocation,
          now,
          correlationId,
        ),
      ),
      ...walletAllocations.flatMap((allocation) =>
        walletAllocationStatements(
          env.BILLING_DB,
          subscription.organization_id,
          invoiceId,
          allocation,
          now,
          correlationId,
        ),
      ),
      env.BILLING_DB.prepare(
        `UPDATE subscriptions
         SET current_period_start = ?, current_period_end = ?, version = version + 1, updated_at = ?
         WHERE id = ? AND current_period_start = ? AND current_period_end = ?`,
      ).bind(periodEnd, nextEnd, now, subscription.id, periodStart, periodEnd),
      env.BILLING_DB.prepare(
        `UPDATE billing_cycles
         SET status = 'closed', invoice_id = ?, lease_expires_at = NULL, closed_at = ?, updated_at = ?
         WHERE id = ? AND status = 'closing'`,
      ).bind(invoiceId, now, now, cycleId),
      env.BILLING_DB.prepare(
        `INSERT INTO outbox_events
         (event_id, organization_id, event_type, event_version, aggregate_type,
          aggregate_id, aggregate_version, causation_id, correlation_id, payload_json,
          occurred_at, published_at)
         VALUES (?, ?, ?, 1, 'invoice', ?, 1, ?, ?, ?, ?, NULL)`,
      ).bind(
        domainEvent.id,
        subscription.organization_id,
        domainEvent.type,
        invoiceId,
        cycleId,
        correlationId,
        stableJson(domainEvent.payload),
        now,
      ),
    ];
    const results = await env.BILLING_DB.batch(statements);
    const firstCouponUpdate = 2 + lines.length;
    for (let offset = 0; offset < couponCredits.length; offset += 1) {
      const update = results[firstCouponUpdate + offset * 2];
      if (!update || update.meta.changes !== 1) throw new Error("coupon_version_conflict");
    }
    const subscriptionUpdate = results[results.length - 3];
    if (!subscriptionUpdate || subscriptionUpdate.meta.changes !== 1) {
      throw new Error("billing_period_changed");
    }
    await env.DOMAIN_EVENTS.send(domainEvent);
    const result: CloseBillingPeriodResult = {
      billingCycleId: cycleId,
      invoiceId,
      replayed: false,
      totalDueMinor: totalDue,
      lineCount: lines.length,
      nextPeriodEnd: nextEnd,
    };
    await billingAccount.completeCommand(reservationKey, result);
    return result;
  } catch (error) {
    const failureCode = error instanceof Error ? error.message.slice(0, 100) : "unknown_error";
    await env.BILLING_DB.prepare(
      `UPDATE billing_cycles
       SET status = 'failed', failure_code = ?, lease_expires_at = NULL, updated_at = ?
       WHERE id = ? AND status = 'closing'`,
    )
      .bind(failureCode, new Date().toISOString(), cycleId)
      .run();
    await billingAccount.releaseCommand(reservationKey, requestHash);
    throw error;
  }
}

async function findSubscription(database: D1Database, id: string): Promise<SubscriptionRow | null> {
  return database
    .prepare(
      `SELECT s.id, s.organization_id, s.customer_id, s.plan_id, s.external_id,
              s.current_period_start, s.current_period_end, p.interval, p.currency,
              p.name AS plan_name, p.amount_minor AS plan_amount_minor
       FROM subscriptions s JOIN plans p ON p.id = s.plan_id
       WHERE s.id = ? AND s.status IN ('active', 'past_due') LIMIT 1`,
    )
    .bind(id)
    .first<SubscriptionRow>();
}

async function loadCharges(
  database: D1Database,
  subscription: SubscriptionRow,
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

async function findCycle(
  database: D1Database,
  subscriptionId: string,
  periodStart: string,
  periodEnd: string,
) {
  return database
    .prepare(
      `SELECT id, status, request_sha256, invoice_id, lease_expires_at FROM billing_cycles
       WHERE subscription_id = ? AND period_start = ? AND period_end = ? LIMIT 1`,
    )
    .bind(subscriptionId, periodStart, periodEnd)
    .first<{
      id: string;
      status: string;
      request_sha256: string;
      invoice_id: string | null;
      lease_expires_at: string | null;
    }>();
}

async function findClosedCycle(
  database: D1Database,
  subscriptionId: string,
  currentPeriodStart: string,
  periodEnd: string,
): Promise<CloseBillingPeriodResult | null> {
  const cycle = await database
    .prepare(
      `SELECT id, invoice_id FROM billing_cycles
       WHERE subscription_id = ? AND period_end = ? AND status = 'closed'
         AND period_start < ?
       ORDER BY closed_at DESC LIMIT 1`,
    )
    .bind(subscriptionId, periodEnd, currentPeriodStart)
    .first<{ id: string; invoice_id: string }>();
  return cycle ? cycleResult(database, cycle.id, cycle.invoice_id, true, periodEnd) : null;
}

async function cycleResult(
  database: D1Database,
  billingCycleId: string,
  invoiceId: string,
  replayed: boolean,
  periodEnd: string,
): Promise<CloseBillingPeriodResult> {
  const invoice = await database
    .prepare("SELECT total_due_minor FROM invoices WHERE id = ? LIMIT 1")
    .bind(invoiceId)
    .first<{ total_due_minor: number }>();
  const count = await database
    .prepare("SELECT COUNT(*) AS total FROM invoice_lines WHERE billing_cycle_id = ?")
    .bind(billingCycleId)
    .first<{ total: number }>();
  const subscription = await database
    .prepare(
      `SELECT subscriptions.current_period_end FROM billing_cycles
       JOIN subscriptions ON subscriptions.id = billing_cycles.subscription_id
       WHERE billing_cycles.id = ?`,
    )
    .bind(billingCycleId)
    .first<{ current_period_end: string }>();
  if (!invoice || !subscription) throw new Error("billing_cycle_corrupt");
  return {
    billingCycleId,
    invoiceId,
    replayed,
    totalDueMinor: invoice.total_due_minor,
    lineCount: count?.total ?? 0,
    nextPeriodEnd: subscription.current_period_end || periodEnd,
  };
}

function parseCompletedReservation(value: string | null): CloseBillingPeriodResult | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as Partial<CloseBillingPeriodResult>;
    return typeof parsed.billingCycleId === "string" &&
      typeof parsed.invoiceId === "string" &&
      typeof parsed.totalDueMinor === "number" &&
      typeof parsed.lineCount === "number" &&
      typeof parsed.nextPeriodEnd === "string"
      ? ({ ...parsed, replayed: true } as CloseBillingPeriodResult)
      : null;
  } catch {
    return null;
  }
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
