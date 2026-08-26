import type { DomainEvent } from "../domain-events";
import { deterministicUuid } from "../identifiers";
import { stableJson } from "../json";
import { couponCreditStatements } from "./coupon-credits";
import { closeBillingPeriod } from "./close-period";
import { creditNoteAllocationStatements } from "./credit-note-credits";
import { manualTaxStatements } from "./manual-taxes";
import { paymentDueDate } from "./payment-terms";
import { followingPeriodEnd, localDateString } from "./periods";
import {
  calculateInitialSubscriptionInvoice,
  invoiceSubscriptionStatement,
  type BillableSubscription,
  subscriptionInvoiceLineStatements,
} from "./subscription-invoice-calculation";
import { walletAllocationStatements } from "./wallet-credits";

type TrialSubscription = BillableSubscription & { version: number };

export async function billEndedTrialSubscriptions(
  env: Env,
  billedAt: string,
  correlationId: string,
): Promise<number> {
  if (!Number.isFinite(Date.parse(billedAt))) throw new Error("invalid_trial_billing_timestamp");
  const due = await env.BILLING_DB.prepare(
    `SELECT s.id, s.organization_id, s.customer_id, s.plan_id, s.external_id,
            s.current_period_start, s.current_period_end, s.version,
            s.billing_time, s.billing_timezone, s.trial_started_at, s.trial_end_at,
            s.trial_ended_at, p.interval, p.currency, p.name AS plan_name,
            s.name AS subscription_name, p.amount_minor AS plan_amount_minor,
            p.pay_in_advance AS plan_pay_in_advance,
            COALESCE(c.net_payment_term, o.net_payment_term) AS net_payment_term,
            COALESCE(c.invoice_grace_period, o.invoice_grace_period) AS invoice_grace_period
     FROM subscriptions s
     JOIN plans p ON p.id = s.plan_id
     JOIN customers c ON c.id = s.customer_id
     JOIN organizations o ON o.id = s.organization_id
     WHERE s.status IN ('active', 'past_due') AND s.trial_end_at IS NOT NULL
       AND s.trial_ended_at IS NULL AND s.trial_end_at <= ?
       AND s.current_period_start IS NOT NULL AND s.current_period_end IS NOT NULL
     ORDER BY s.trial_end_at, s.id LIMIT 100`,
  )
    .bind(billedAt)
    .all<TrialSubscription>();
  let ended = 0;
  for (const subscription of due.results) {
    if (await billEndedTrialSubscription(env, subscription, billedAt, correlationId)) ended += 1;
  }
  return ended;
}

async function billEndedTrialSubscription(
  env: Env,
  dueSubscription: TrialSubscription,
  billedAt: string,
  correlationId: string,
): Promise<boolean> {
  const subscription = await closePeriodsEndingDuringTrial(env, dueSubscription, correlationId);
  const trialEndAt = subscription.trial_end_at;
  if (!trialEndAt) return false;
  const nextVersion = subscription.version + 1;
  const trialEvent = trialEndedEvent(
    subscription,
    nextVersion,
    trialEndAt,
    billedAt,
    correlationId,
  );

  if (
    subscription.plan_pay_in_advance !== 1 ||
    (await alreadyBilledAtTrialEnd(env.BILLING_DB, subscription, trialEndAt))
  ) {
    return endTrialWithoutInvoice(env, subscription, trialEvent, billedAt);
  }

  const invoiceId = await deterministicUuid(
    "trial-end-invoice",
    `${subscription.id}:${trialEndAt}`,
  );
  const calculationPeriodEnd =
    Date.parse(subscription.current_period_end) > Date.parse(trialEndAt)
      ? subscription.current_period_end
      : followingPeriodEnd(
          new Date(subscription.current_period_end),
          subscription.interval,
          subscription.billing_time,
          subscription.billing_timezone,
        ).toISOString();
  const calculation = await calculateInitialSubscriptionInvoice(
    env.BILLING_DB,
    subscription,
    invoiceId,
    trialEndAt,
    calculationPeriodEnd,
  );
  const draft = subscription.invoice_grace_period > 0;
  const issuingDate = shiftCalendarDate(
    localDateString(new Date(trialEndAt), subscription.billing_timezone),
    subscription.invoice_grace_period,
  );
  const paymentDue = paymentDueDate(issuingDate, subscription.net_payment_term);
  const invoiceNumber = invoiceId.replaceAll("-", "").slice(0, 20).toUpperCase();
  const invoiceEvent: DomainEvent = {
    id: `${draft ? "invoice-drafted" : "invoice-finalized"}:${invoiceId}:v1`,
    type: draft ? "invoice.drafted" : "invoice.finalized",
    version: 1,
    aggregateType: "invoice",
    aggregateId: invoiceId,
    aggregateVersion: 1,
    occurredAt: billedAt,
    causationId: correlationId,
    correlationId,
    payload: {
      organizationId: subscription.organization_id,
      subscriptionId: subscription.id,
      billingCycleId: null,
      contextType: "trial_end",
      trialEndAt,
      couponsMinor: calculation.couponsMinor,
      taxMinor: calculation.taxMinor,
      creditNotesMinor: calculation.creditNotesMinor,
      prepaidCreditMinor: calculation.prepaidCreditMinor,
      totalDueMinor: calculation.totalDueMinor,
      currency: subscription.currency,
      periodStart: trialEndAt,
      periodEnd: calculationPeriodEnd,
      issuingDate,
      expectedFinalizationDate: issuingDate,
      appliedGracePeriod: subscription.invoice_grace_period,
    },
  };
  const statements: D1PreparedStatement[] = [
    trialEndUpdate(env.BILLING_DB, subscription, billedAt),
    env.BILLING_DB.prepare(
      `INSERT INTO invoices
       (id, organization_id, customer_id, subscription_id, number, status, payment_status,
        currency, subtotal_minor, tax_minor, credits_minor, total_due_minor, version,
        finalized_at, issuing_date, created_at, updated_at, coupons_minor, prepaid_credit_minor,
        credit_notes_minor, net_payment_term, payment_due_date, payment_overdue,
        expected_finalization_date, applied_grace_period, ready_to_be_refreshed, last_refreshed_at)
       SELECT ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0,
              ?, ?, 0, ?
       FROM subscriptions WHERE id = ? AND organization_id = ? AND version = ?
         AND trial_ended_at = ?`,
    ).bind(
      invoiceId,
      subscription.organization_id,
      subscription.customer_id,
      subscription.id,
      invoiceNumber,
      draft ? "draft" : "finalized",
      subscription.currency,
      calculation.subtotalMinor,
      calculation.taxMinor,
      calculation.creditsMinor,
      calculation.totalDueMinor,
      draft ? null : billedAt,
      issuingDate,
      billedAt,
      billedAt,
      calculation.couponsMinor,
      calculation.prepaidCreditMinor,
      calculation.creditNotesMinor,
      subscription.net_payment_term,
      paymentDue,
      issuingDate,
      subscription.invoice_grace_period,
      draft ? billedAt : null,
      subscription.id,
      subscription.organization_id,
      nextVersion,
      trialEndAt,
    ),
    ...subscriptionInvoiceLineStatements(
      env.BILLING_DB,
      invoiceId,
      null,
      calculation.lines,
      billedAt,
    ),
    env.BILLING_DB.prepare(
      `INSERT INTO subscription_invoice_contexts
       (invoice_id, organization_id, subscription_id, context_type, period_start,
        period_end, created_at) VALUES (?, ?, ?, 'initial', ?, ?, ?)`,
    ).bind(
      invoiceId,
      subscription.organization_id,
      subscription.id,
      trialEndAt,
      calculationPeriodEnd,
      billedAt,
    ),
    invoiceSubscriptionStatement(
      env.BILLING_DB,
      invoiceId,
      subscription.id,
      subscription.organization_id,
      "subscription_starting",
      trialEndAt,
      calculationPeriodEnd,
      billedAt,
    ),
  ];
  if (!draft) {
    statements.push(
      ...couponCreditStatements(
        env.BILLING_DB,
        subscription.organization_id,
        invoiceId,
        subscription.currency,
        calculation.couponCredits,
        billedAt,
        correlationId,
      ),
    );
  }
  statements.push(
    ...manualTaxStatements(
      env.BILLING_DB,
      subscription.organization_id,
      invoiceId,
      subscription.currency,
      calculation.invoiceTaxes,
      billedAt,
    ),
  );
  if (!draft) {
    for (const allocation of calculation.walletAllocations) {
      statements.push(
        ...walletAllocationStatements(
          env.BILLING_DB,
          subscription.organization_id,
          invoiceId,
          allocation,
          billedAt,
          correlationId,
        ),
      );
    }
    for (const allocation of calculation.creditNoteAllocations) {
      statements.push(
        ...creditNoteAllocationStatements(
          env.BILLING_DB,
          subscription.organization_id,
          invoiceId,
          allocation,
          billedAt,
          correlationId,
        ),
      );
    }
  }
  statements.push(
    conditionalOutbox(env.BILLING_DB, subscription, trialEvent, nextVersion, trialEndAt),
    conditionalOutbox(env.BILLING_DB, subscription, invoiceEvent, nextVersion, trialEndAt),
  );
  try {
    const results = await env.BILLING_DB.batch(statements);
    if (results[0]?.meta.changes !== 1 || (results[1]?.meta.changes ?? 0) < 1)
      throw new Error("trial_billing_conflict");
  } catch (error) {
    const current = await currentTrialState(env.BILLING_DB, subscription.id);
    const invoice = await env.BILLING_DB.prepare("SELECT id FROM invoices WHERE id = ? LIMIT 1")
      .bind(invoiceId)
      .first();
    if (current?.trial_ended_at === trialEndAt && invoice) return false;
    throw error;
  }
  await Promise.all([env.DOMAIN_EVENTS.send(trialEvent), env.DOMAIN_EVENTS.send(invoiceEvent)]);
  return true;
}

async function closePeriodsEndingDuringTrial(
  env: Env,
  dueSubscription: TrialSubscription,
  correlationId: string,
): Promise<TrialSubscription> {
  let subscription = dueSubscription;
  for (let period = 0; period < 120; period += 1) {
    const trialEndAt = subscription.trial_end_at;
    if (!trialEndAt || Date.parse(subscription.current_period_end) > Date.parse(trialEndAt)) {
      return subscription;
    }
    await closeBillingPeriod(
      env,
      subscription.id,
      subscription.current_period_end,
      `${correlationId}:trial-period:${period}`,
    );
    const refreshed = await findTrialSubscription(env.BILLING_DB, subscription.id);
    if (!refreshed) throw new Error("trial_subscription_disappeared");
    subscription = refreshed;
  }
  throw new Error("trial_period_reconciliation_limit");
}

function findTrialSubscription(database: D1Database, subscriptionId: string) {
  return database
    .prepare(
      `SELECT s.id, s.organization_id, s.customer_id, s.plan_id, s.external_id,
              s.current_period_start, s.current_period_end, s.version,
              s.billing_time, s.billing_timezone, s.trial_started_at, s.trial_end_at,
              s.trial_ended_at, p.interval, p.currency, p.name AS plan_name,
              s.name AS subscription_name, p.amount_minor AS plan_amount_minor,
              p.pay_in_advance AS plan_pay_in_advance,
              COALESCE(c.net_payment_term, o.net_payment_term) AS net_payment_term,
              COALESCE(c.invoice_grace_period, o.invoice_grace_period) AS invoice_grace_period
       FROM subscriptions s
       JOIN plans p ON p.id = s.plan_id
       JOIN customers c ON c.id = s.customer_id
       JOIN organizations o ON o.id = s.organization_id
       WHERE s.id = ? AND s.status IN ('active', 'past_due') LIMIT 1`,
    )
    .bind(subscriptionId)
    .first<TrialSubscription>();
}

async function alreadyBilledAtTrialEnd(
  database: D1Database,
  subscription: TrialSubscription,
  trialEndAt: string,
): Promise<boolean> {
  const row = await database
    .prepare(
      `SELECT il.id FROM invoice_lines il
       JOIN invoices i ON i.id = il.invoice_id
       WHERE i.organization_id = ? AND i.subscription_id = ? AND i.status != 'voided'
         AND il.source_type = 'plan' AND il.source_id = ?
         AND (
           json_extract(il.metadata_json, '$.periodStart') = ?
           OR EXISTS (
             SELECT 1 FROM subscription_invoice_contexts sic
             WHERE sic.invoice_id = i.id AND sic.period_start <= ? AND sic.period_end > ?
           )
         )
       LIMIT 1`,
    )
    .bind(
      subscription.organization_id,
      subscription.id,
      subscription.plan_id,
      trialEndAt,
      trialEndAt,
      trialEndAt,
    )
    .first();
  return row !== null;
}

async function endTrialWithoutInvoice(
  env: Env,
  subscription: TrialSubscription,
  event: DomainEvent,
  billedAt: string,
): Promise<boolean> {
  const nextVersion = subscription.version + 1;
  const trialEndAt = subscription.trial_end_at;
  if (!trialEndAt) return false;
  const results = await env.BILLING_DB.batch([
    trialEndUpdate(env.BILLING_DB, subscription, billedAt),
    conditionalOutbox(env.BILLING_DB, subscription, event, nextVersion, trialEndAt),
  ]);
  if (results[0]?.meta.changes !== 1 || results[1]?.meta.changes !== 1) {
    const current = await currentTrialState(env.BILLING_DB, subscription.id);
    if (current?.trial_ended_at === trialEndAt) return false;
    throw new Error("trial_end_conflict");
  }
  await env.DOMAIN_EVENTS.send(event);
  return true;
}

function trialEndUpdate(
  database: D1Database,
  subscription: TrialSubscription,
  billedAt: string,
): D1PreparedStatement {
  return database
    .prepare(
      `UPDATE subscriptions SET trial_ended_at = trial_end_at, version = version + 1, updated_at = ?
       WHERE id = ? AND organization_id = ? AND version = ? AND trial_ended_at IS NULL
         AND trial_end_at IS NOT NULL AND trial_end_at <= ?`,
    )
    .bind(billedAt, subscription.id, subscription.organization_id, subscription.version, billedAt);
}

function conditionalOutbox(
  database: D1Database,
  subscription: TrialSubscription,
  event: DomainEvent,
  nextVersion: number,
  trialEndAt: string,
): D1PreparedStatement {
  return database
    .prepare(
      `INSERT INTO outbox_events
       (event_id, organization_id, event_type, event_version, aggregate_type,
        aggregate_id, aggregate_version, causation_id, correlation_id, payload_json,
        occurred_at, published_at)
       SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL FROM subscriptions
       WHERE id = ? AND organization_id = ? AND version = ? AND trial_ended_at = ?
       ON CONFLICT(event_id) DO NOTHING`,
    )
    .bind(
      event.id,
      subscription.organization_id,
      event.type,
      event.version,
      event.aggregateType,
      event.aggregateId,
      event.aggregateVersion,
      event.causationId,
      event.correlationId,
      stableJson(event.payload),
      event.occurredAt,
      subscription.id,
      subscription.organization_id,
      nextVersion,
      trialEndAt,
    );
}

function trialEndedEvent(
  subscription: TrialSubscription,
  nextVersion: number,
  trialEndAt: string,
  billedAt: string,
  correlationId: string,
): DomainEvent {
  return {
    id: `subscription-trial-ended:${subscription.id}:v${nextVersion}`,
    type: "subscription.trial_ended",
    version: 1,
    aggregateType: "subscription",
    aggregateId: subscription.id,
    aggregateVersion: nextVersion,
    occurredAt: billedAt,
    causationId: correlationId,
    correlationId,
    payload: {
      organizationId: subscription.organization_id,
      subscriptionId: subscription.id,
      externalSubscriptionId: subscription.external_id,
      trialStartedAt: subscription.trial_started_at,
      trialEndAt,
    },
  };
}

function currentTrialState(database: D1Database, subscriptionId: string) {
  return database
    .prepare("SELECT trial_ended_at FROM subscriptions WHERE id = ? LIMIT 1")
    .bind(subscriptionId)
    .first<{ trial_ended_at: string | null }>();
}

function shiftCalendarDate(value: string, days: number): string {
  const date = new Date(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(date.getTime())) throw new Error("invalid_trial_billing_date");
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}
