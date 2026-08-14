import { sha256Hex } from "../auth/api-key";
import type { DomainEvent } from "../domain-events";
import { deterministicUuid } from "../identifiers";
import { stableJson } from "../json";
import { couponCreditStatements } from "./coupon-credits";
import { walletAllocationStatements } from "./wallet-credits";
import { creditNoteAllocationStatements } from "./credit-note-credits";
import { manualTaxStatements } from "./manual-taxes";
import { paymentDueDate } from "./payment-terms";
import {
  calculateSubscriptionInvoice,
  findBillableSubscription,
  subscriptionInvoiceLineStatements,
} from "./subscription-invoice-calculation";

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
  const subscription = await findBillableSubscription(env.BILLING_DB, subscriptionId);
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
    const calculation = await calculateSubscriptionInvoice(
      env.BILLING_DB,
      subscription,
      invoiceId,
      cycleId,
      periodStart,
      periodEnd,
    );
    const {
      lines,
      subtotalMinor: subtotal,
      couponCredits,
      couponsMinor,
      invoiceTaxes,
      taxMinor,
      creditNoteAllocations,
      creditNotesMinor,
      walletAllocations,
      prepaidCreditMinor,
      creditsMinor,
      totalDueMinor: totalDue,
      nextPeriodEnd: nextEnd,
    } = calculation;
    const draft = subscription.invoice_grace_period > 0;
    const invoiceNumber = invoiceId.replaceAll("-", "").slice(0, 20).toUpperCase();
    const billingDate = periodEnd.slice(0, 10);
    const issuingDate = shiftCalendarDate(billingDate, -1);
    const expectedFinalizationDate = shiftCalendarDate(
      billingDate,
      subscription.invoice_grace_period,
    );
    const dueDate = paymentDueDate(issuingDate, subscription.net_payment_term);
    const eventType = draft ? "invoice.drafted" : "invoice.finalized";
    const domainEvent: DomainEvent = {
      id: `${draft ? "invoice-drafted" : "invoice-finalized"}:${invoiceId}:v1`,
      type: eventType,
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
        issuingDate,
        expectedFinalizationDate,
        appliedGracePeriod: subscription.invoice_grace_period,
      },
    };
    const couponStatements = draft
      ? []
      : couponCreditStatements(
          env.BILLING_DB,
          subscription.organization_id,
          invoiceId,
          subscription.currency,
          couponCredits,
          now,
          correlationId,
        );
    const creditNoteStatements = draft
      ? []
      : creditNoteAllocations.flatMap((allocation) =>
          creditNoteAllocationStatements(
            env.BILLING_DB,
            subscription.organization_id,
            invoiceId,
            allocation,
            now,
            correlationId,
          ),
        );
    const walletStatements = draft
      ? []
      : walletAllocations.flatMap((allocation) =>
          walletAllocationStatements(
            env.BILLING_DB,
            subscription.organization_id,
            invoiceId,
            allocation,
            now,
            correlationId,
          ),
        );
    const statements: D1PreparedStatement[] = [
      env.BILLING_DB.prepare(
        `INSERT INTO invoices
         (id, organization_id, customer_id, subscription_id, number, status, payment_status,
          currency, subtotal_minor, tax_minor, credits_minor, total_due_minor, version,
          finalized_at, issuing_date, created_at, updated_at, coupons_minor, prepaid_credit_minor,
          credit_notes_minor, net_payment_term, payment_due_date, payment_overdue,
          expected_finalization_date, applied_grace_period, ready_to_be_refreshed,
          last_refreshed_at)
         VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0,
                 ?, ?, 0, ?)`,
      ).bind(
        invoiceId,
        subscription.organization_id,
        subscription.customer_id,
        subscription.id,
        invoiceNumber,
        draft ? "draft" : "finalized",
        subscription.currency,
        subtotal,
        taxMinor,
        creditsMinor,
        totalDue,
        draft ? null : now,
        issuingDate,
        now,
        now,
        couponsMinor,
        prepaidCreditMinor,
        creditNotesMinor,
        subscription.net_payment_term,
        dueDate,
        expectedFinalizationDate,
        subscription.invoice_grace_period,
        draft ? now : null,
      ),
      ...subscriptionInvoiceLineStatements(env.BILLING_DB, invoiceId, cycleId, lines, now),
      ...couponStatements,
      ...manualTaxStatements(
        env.BILLING_DB,
        subscription.organization_id,
        invoiceId,
        subscription.currency,
        invoiceTaxes,
        now,
      ),
      ...creditNoteStatements,
      ...walletStatements,
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
    if (!draft) {
      const firstCouponUpdate = 2 + lines.length;
      for (let offset = 0; offset < couponCredits.length; offset += 1) {
        const update = results[firstCouponUpdate + offset * 3];
        if (!update || update.meta.changes < 1) throw new Error("coupon_version_conflict");
      }
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

function shiftCalendarDate(value: string, days: number): string {
  const date = new Date(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(date.getTime())) throw new Error("invalid_billing_date");
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
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
