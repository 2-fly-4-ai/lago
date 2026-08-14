import type { DomainEvent } from "../domain-events";
import { deterministicUuid } from "../identifiers";
import { stableJson } from "../json";
import { couponCreditStatements } from "./coupon-credits";
import { creditNoteAllocationStatements } from "./credit-note-credits";
import { manualTaxStatements } from "./manual-taxes";
import { paymentDueDate } from "./payment-terms";
import { firstPeriodEnd, localDateString } from "./periods";
import {
  calculateInitialSubscriptionInvoice,
  type BillableSubscription,
  subscriptionInvoiceLineStatements,
} from "./subscription-invoice-calculation";
import { walletAllocationStatements } from "./wallet-credits";

type PendingSubscription = BillableSubscription & {
  subscription_at: string;
  version: number;
};

export async function activatePendingSubscriptions(
  env: Env,
  activatedAt: string,
  correlationId: string,
): Promise<number> {
  const pending = await env.BILLING_DB.prepare(
    `SELECT s.id, s.organization_id, s.customer_id, s.plan_id, s.external_id,
            s.subscription_at, s.version, p.interval, p.currency, p.name AS plan_name,
            p.pay_in_advance AS plan_pay_in_advance,
            s.billing_time, s.billing_timezone, s.trial_started_at, s.trial_end_at,
            s.trial_ended_at,
            s.name AS subscription_name, p.amount_minor AS plan_amount_minor,
            COALESCE(c.net_payment_term, o.net_payment_term) AS net_payment_term,
            COALESCE(c.invoice_grace_period, o.invoice_grace_period) AS invoice_grace_period,
            '' AS current_period_start, '' AS current_period_end
     FROM subscriptions s
     JOIN plans p ON p.id = s.plan_id
     JOIN customers c ON c.id = s.customer_id
     JOIN organizations o ON o.id = s.organization_id
     WHERE s.status = 'pending' AND s.subscription_at IS NOT NULL AND s.subscription_at <= ?
     ORDER BY s.subscription_at, s.id LIMIT 100`,
  )
    .bind(activatedAt)
    .all<PendingSubscription>();
  let activated = 0;
  for (const subscription of pending.results) {
    if (await activatePendingSubscription(env, subscription, activatedAt, correlationId)) {
      activated += 1;
    }
  }
  return activated;
}

async function activatePendingSubscription(
  env: Env,
  pending: PendingSubscription,
  activatedAt: string,
  correlationId: string,
): Promise<boolean> {
  const effectiveStart = pending.subscription_at;
  const periodEnd = firstPeriodEnd(
    new Date(effectiveStart),
    pending.interval,
    pending.billing_time,
    pending.billing_timezone,
  ).toISOString();
  const subscription: BillableSubscription = {
    ...pending,
    current_period_start: effectiveStart,
    current_period_end: periodEnd,
  };
  const invoiceId = await deterministicUuid(
    "initial-invoice",
    `${pending.organization_id}:${pending.external_id}`,
  );
  if (pending.plan_pay_in_advance !== 1 || pending.trial_end_at !== null) {
    return activateWithoutInitialInvoice(
      env,
      pending,
      effectiveStart,
      activatedAt,
      periodEnd,
      correlationId,
    );
  }
  const calculation = await calculateInitialSubscriptionInvoice(
    env.BILLING_DB,
    subscription,
    invoiceId,
    effectiveStart,
    periodEnd,
  );
  const draft = pending.invoice_grace_period > 0;
  const issuingDate = shiftCalendarDate(
    localDateString(new Date(effectiveStart), pending.billing_timezone),
    pending.invoice_grace_period,
  );
  const paymentDue = paymentDueDate(issuingDate, pending.net_payment_term);
  const invoiceNumber = invoiceId.replaceAll("-", "").slice(0, 20).toUpperCase();
  const subscriptionVersion = pending.version + 1;
  const subscriptionEvent: DomainEvent = {
    id: `subscription-started:${pending.id}:v${subscriptionVersion}`,
    type: "subscription.started",
    version: 1,
    aggregateType: "subscription",
    aggregateId: pending.id,
    aggregateVersion: subscriptionVersion,
    occurredAt: activatedAt,
    causationId: correlationId,
    correlationId,
    payload: {
      organizationId: pending.organization_id,
      subscriptionId: pending.id,
      externalSubscriptionId: pending.external_id,
      subscriptionAt: pending.subscription_at,
      startedAt: effectiveStart,
    },
  };
  const invoiceEvent: DomainEvent = {
    id: `${draft ? "invoice-drafted" : "invoice-finalized"}:${invoiceId}:v1`,
    type: draft ? "invoice.drafted" : "invoice.finalized",
    version: 1,
    aggregateType: "invoice",
    aggregateId: invoiceId,
    aggregateVersion: 1,
    occurredAt: activatedAt,
    causationId: correlationId,
    correlationId,
    payload: {
      organizationId: pending.organization_id,
      subscriptionId: pending.id,
      billingCycleId: null,
      couponsMinor: calculation.couponsMinor,
      taxMinor: calculation.taxMinor,
      creditNotesMinor: calculation.creditNotesMinor,
      prepaidCreditMinor: calculation.prepaidCreditMinor,
      totalDueMinor: calculation.totalDueMinor,
      currency: pending.currency,
      periodStart: effectiveStart,
      periodEnd,
      issuingDate,
      expectedFinalizationDate: issuingDate,
      appliedGracePeriod: pending.invoice_grace_period,
    },
  };
  const statements: D1PreparedStatement[] = [
    env.BILLING_DB.prepare(
      `UPDATE subscriptions
       SET status = 'active', started_at = ?, current_period_start = ?, current_period_end = ?,
           version = version + 1, updated_at = ?
       WHERE id = ? AND organization_id = ? AND status = 'pending' AND version = ?
         AND subscription_at <= ?`,
    ).bind(
      effectiveStart,
      effectiveStart,
      periodEnd,
      activatedAt,
      pending.id,
      pending.organization_id,
      pending.version,
      activatedAt,
    ),
    env.BILLING_DB.prepare(
      `INSERT INTO invoices
       (id, organization_id, customer_id, subscription_id, number, status, payment_status,
        currency, subtotal_minor, tax_minor, credits_minor, total_due_minor, version,
        finalized_at, issuing_date, created_at, updated_at, coupons_minor, prepaid_credit_minor,
        credit_notes_minor, net_payment_term, payment_due_date, payment_overdue,
        expected_finalization_date, applied_grace_period, ready_to_be_refreshed, last_refreshed_at)
       VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0,
               ?, ?, 0, ?)`,
    ).bind(
      invoiceId,
      pending.organization_id,
      pending.customer_id,
      pending.id,
      invoiceNumber,
      draft ? "draft" : "finalized",
      pending.currency,
      calculation.subtotalMinor,
      calculation.taxMinor,
      calculation.creditsMinor,
      calculation.totalDueMinor,
      draft ? null : activatedAt,
      issuingDate,
      activatedAt,
      activatedAt,
      calculation.couponsMinor,
      calculation.prepaidCreditMinor,
      calculation.creditNotesMinor,
      pending.net_payment_term,
      paymentDue,
      issuingDate,
      pending.invoice_grace_period,
      draft ? activatedAt : null,
    ),
    ...subscriptionInvoiceLineStatements(
      env.BILLING_DB,
      invoiceId,
      null,
      calculation.lines,
      activatedAt,
    ),
    env.BILLING_DB.prepare(
      `INSERT INTO subscription_invoice_contexts
       (invoice_id, organization_id, subscription_id, context_type, period_start,
        period_end, created_at) VALUES (?, ?, ?, 'initial', ?, ?, ?)`,
    ).bind(invoiceId, pending.organization_id, pending.id, effectiveStart, periodEnd, activatedAt),
  ];
  if (!draft) {
    statements.push(
      ...couponCreditStatements(
        env.BILLING_DB,
        pending.organization_id,
        invoiceId,
        pending.currency,
        calculation.couponCredits,
        activatedAt,
        correlationId,
      ),
    );
  }
  statements.push(
    ...manualTaxStatements(
      env.BILLING_DB,
      pending.organization_id,
      invoiceId,
      pending.currency,
      calculation.invoiceTaxes,
      activatedAt,
    ),
  );
  if (!draft) {
    for (const allocation of calculation.walletAllocations) {
      statements.push(
        ...walletAllocationStatements(
          env.BILLING_DB,
          pending.organization_id,
          invoiceId,
          allocation,
          activatedAt,
          correlationId,
        ),
      );
    }
    for (const allocation of calculation.creditNoteAllocations) {
      statements.push(
        ...creditNoteAllocationStatements(
          env.BILLING_DB,
          pending.organization_id,
          invoiceId,
          allocation,
          activatedAt,
          correlationId,
        ),
      );
    }
  }
  statements.push(
    outboxStatement(env.BILLING_DB, pending.organization_id, subscriptionEvent),
    outboxStatement(env.BILLING_DB, pending.organization_id, invoiceEvent),
  );
  try {
    const results = await env.BILLING_DB.batch(statements);
    if ((results[0]?.meta.changes ?? 0) < 1) throw new Error("subscription_activation_conflict");
  } catch (error) {
    const current = await env.BILLING_DB.prepare(
      `SELECT status FROM subscriptions WHERE id = ? AND organization_id = ? LIMIT 1`,
    )
      .bind(pending.id, pending.organization_id)
      .first<{ status: string }>();
    const invoice = await env.BILLING_DB.prepare("SELECT id FROM invoices WHERE id = ? LIMIT 1")
      .bind(invoiceId)
      .first();
    if (current?.status === "active" && invoice) return false;
    throw error;
  }
  await Promise.all([
    env.DOMAIN_EVENTS.send(subscriptionEvent),
    env.DOMAIN_EVENTS.send(invoiceEvent),
  ]);
  return true;
}

async function activateWithoutInitialInvoice(
  env: Env,
  pending: PendingSubscription,
  effectiveStart: string,
  activatedAt: string,
  periodEnd: string,
  correlationId: string,
): Promise<boolean> {
  const subscriptionVersion = pending.version + 1;
  const event: DomainEvent = {
    id: `subscription-started:${pending.id}:v${subscriptionVersion}`,
    type: "subscription.started",
    version: 1,
    aggregateType: "subscription",
    aggregateId: pending.id,
    aggregateVersion: subscriptionVersion,
    occurredAt: activatedAt,
    causationId: correlationId,
    correlationId,
    payload: {
      organizationId: pending.organization_id,
      subscriptionId: pending.id,
      externalSubscriptionId: pending.external_id,
      subscriptionAt: pending.subscription_at,
      startedAt: effectiveStart,
      initialInvoiceGenerated: false,
    },
  };
  const results = await env.BILLING_DB.batch([
    env.BILLING_DB.prepare(
      `UPDATE subscriptions
       SET status = 'active', started_at = ?, current_period_start = ?, current_period_end = ?,
           version = version + 1, updated_at = ?
       WHERE id = ? AND organization_id = ? AND status = 'pending' AND version = ?
         AND subscription_at <= ?`,
    ).bind(
      effectiveStart,
      effectiveStart,
      periodEnd,
      activatedAt,
      pending.id,
      pending.organization_id,
      pending.version,
      activatedAt,
    ),
    conditionalActivationOutboxStatement(
      env.BILLING_DB,
      pending.organization_id,
      event,
      effectiveStart,
    ),
  ]);
  if ((results[0]?.meta.changes ?? 0) < 1 || results[1]?.meta.changes !== 1) {
    const current = await env.BILLING_DB.prepare(
      `SELECT status FROM subscriptions WHERE id = ? AND organization_id = ? LIMIT 1`,
    )
      .bind(pending.id, pending.organization_id)
      .first<{ status: string }>();
    if (current?.status === "active") return false;
    throw new Error("subscription_activation_conflict");
  }
  await env.DOMAIN_EVENTS.send(event);
  return true;
}

function conditionalActivationOutboxStatement(
  database: D1Database,
  organizationId: string,
  event: DomainEvent,
  startedAt: string,
): D1PreparedStatement {
  return database
    .prepare(
      `INSERT INTO outbox_events
       (event_id, organization_id, event_type, event_version, aggregate_type,
        aggregate_id, aggregate_version, causation_id, correlation_id, payload_json,
        occurred_at, published_at)
       SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL
       FROM subscriptions
       WHERE id = ? AND organization_id = ? AND status = 'active' AND version = ?
         AND started_at = ?
       ON CONFLICT(event_id) DO NOTHING`,
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
      event.aggregateId,
      organizationId,
      event.aggregateVersion,
      startedAt,
    );
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

function shiftCalendarDate(value: string, days: number): string {
  const date = new Date(`${value.slice(0, 10)}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}
