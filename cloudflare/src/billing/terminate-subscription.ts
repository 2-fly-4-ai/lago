import type { DomainEvent } from "../domain-events";
import { deterministicUuid } from "../identifiers";
import { stableJson } from "../json";
import { couponCreditStatements } from "./coupon-credits";
import { creditNoteAllocationStatements } from "./credit-note-credits";
import { manualTaxStatements } from "./manual-taxes";
import { paymentDueDate } from "./payment-terms";
import {
  calculateTerminationSubscriptionInvoice,
  findBillableSubscription,
  subscriptionInvoiceLineStatements,
} from "./subscription-invoice-calculation";
import { walletAllocationStatements } from "./wallet-credits";

export type TerminateSubscriptionWithInvoiceResult = {
  invoiceId: string;
  terminatedAt: string;
  totalDueMinor: number;
  lineCount: number;
  invoiceEvent: DomainEvent;
  subscriptionEvent: DomainEvent;
};

export async function terminateSubscriptionWithInvoice(
  env: Env,
  subscriptionId: string,
  expectedVersion: number,
  terminatedAt: string,
  correlationId: string,
): Promise<TerminateSubscriptionWithInvoiceResult> {
  const subscription = await findBillableSubscription(env.BILLING_DB, subscriptionId);
  if (!subscription) throw new Error("subscription_not_found");
  if (subscription.invoice_grace_period !== 0) {
    throw new Error("unsupported_termination_invoice_grace_period");
  }
  const terminationId = await deterministicUuid(
    "subscription-termination",
    `${subscription.id}:v${expectedVersion + 1}:${subscription.current_period_start}`,
  );
  const invoiceId = await deterministicUuid("subscription-termination-invoice", terminationId);
  const calculation = await calculateTerminationSubscriptionInvoice(
    env.BILLING_DB,
    subscription,
    invoiceId,
    terminationId,
    terminatedAt,
  );
  const now = terminatedAt;
  const invoiceNumber = invoiceId.replaceAll("-", "").slice(0, 20).toUpperCase();
  const issuingDate = terminatedAt.slice(0, 10);
  const dueDate = paymentDueDate(issuingDate, subscription.net_payment_term);
  const invoiceEvent: DomainEvent = {
    id: `invoice-finalized:${invoiceId}:v1`,
    type: "invoice.finalized",
    version: 1,
    aggregateType: "invoice",
    aggregateId: invoiceId,
    aggregateVersion: 1,
    occurredAt: now,
    causationId: terminationId,
    correlationId,
    payload: {
      organizationId: subscription.organization_id,
      subscriptionId: subscription.id,
      terminationId,
      invoicingReason: "subscription_terminating",
      couponsMinor: calculation.couponsMinor,
      taxMinor: calculation.taxMinor,
      creditNotesMinor: calculation.creditNotesMinor,
      prepaidCreditMinor: calculation.prepaidCreditMinor,
      totalDueMinor: calculation.totalDueMinor,
      currency: subscription.currency,
      periodStart: subscription.current_period_start,
      periodEnd: calculation.nextPeriodEnd,
      issuingDate,
    },
  };
  const subscriptionEvent: DomainEvent = {
    id: `subscription-terminated:${subscription.id}:v${expectedVersion + 1}`,
    type: "subscription.terminated",
    version: 1,
    aggregateType: "subscription",
    aggregateId: subscription.id,
    aggregateVersion: expectedVersion + 1,
    occurredAt: now,
    causationId: correlationId,
    correlationId,
    payload: {
      organizationId: subscription.organization_id,
      subscriptionId: subscription.id,
      externalSubscriptionId: subscription.external_id,
      terminatedAt,
      finalInvoiceGenerated: true,
      finalInvoiceId: invoiceId,
      creditNoteGenerated: false,
    },
  };
  const couponStatements = couponCreditStatements(
    env.BILLING_DB,
    subscription.organization_id,
    invoiceId,
    subscription.currency,
    calculation.couponCredits,
    now,
    correlationId,
  );
  const creditNoteStatements = calculation.creditNoteAllocations.flatMap((allocation) =>
    creditNoteAllocationStatements(
      env.BILLING_DB,
      subscription.organization_id,
      invoiceId,
      allocation,
      now,
      correlationId,
    ),
  );
  const walletStatements = calculation.walletAllocations.flatMap((allocation) =>
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
       SELECT ?, ?, ?, ?, ?, 'finalized', 'pending', ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?,
              0, ?, 0, 0, NULL
       FROM subscriptions
       WHERE id = ? AND organization_id = ? AND version = ?
         AND status IN ('active', 'past_due')`,
    ).bind(
      invoiceId,
      subscription.organization_id,
      subscription.customer_id,
      subscription.id,
      invoiceNumber,
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
      subscription.id,
      subscription.organization_id,
      expectedVersion,
    ),
    ...subscriptionInvoiceLineStatements(env.BILLING_DB, invoiceId, null, calculation.lines, now),
    ...couponStatements,
    ...manualTaxStatements(
      env.BILLING_DB,
      subscription.organization_id,
      invoiceId,
      subscription.currency,
      calculation.invoiceTaxes,
      now,
    ),
    ...creditNoteStatements,
    ...walletStatements,
    env.BILLING_DB.prepare(
      `UPDATE subscriptions
       SET status = 'terminated', terminated_at = ?, current_period_end = ?,
           version = version + 1, updated_at = ?
       WHERE id = ? AND organization_id = ? AND version = ?
         AND status IN ('active', 'past_due')`,
    ).bind(
      terminatedAt,
      terminatedAt,
      now,
      subscription.id,
      subscription.organization_id,
      expectedVersion,
    ),
    outboxStatement(env.BILLING_DB, subscription.organization_id, invoiceEvent),
    outboxStatement(env.BILLING_DB, subscription.organization_id, subscriptionEvent),
  ];
  let results: D1Result<unknown>[];
  try {
    results = await env.BILLING_DB.batch(statements);
  } catch (error) {
    const current = await env.BILLING_DB.prepare(
      "SELECT version, status FROM subscriptions WHERE id = ? AND organization_id = ?",
    )
      .bind(subscription.id, subscription.organization_id)
      .first<{ version: number; status: string }>();
    if (
      !current ||
      current.version !== expectedVersion ||
      (current.status !== "active" && current.status !== "past_due")
    ) {
      throw new Error("subscription_version_conflict");
    }
    throw error;
  }
  const subscriptionUpdate = results[results.length - 3];
  if (!subscriptionUpdate || subscriptionUpdate.meta.changes !== 1) {
    throw new Error("subscription_version_conflict");
  }
  const firstCouponUpdate = 2 + calculation.lines.length;
  for (let offset = 0; offset < calculation.couponCredits.length; offset += 1) {
    const update = results[firstCouponUpdate + offset * 3];
    if (!update || update.meta.changes !== 1) throw new Error("coupon_version_conflict");
  }
  await env.DOMAIN_EVENTS.send(invoiceEvent);
  await env.DOMAIN_EVENTS.send(subscriptionEvent);
  return {
    invoiceId,
    terminatedAt,
    totalDueMinor: calculation.totalDueMinor,
    lineCount: calculation.lines.length,
    invoiceEvent,
    subscriptionEvent,
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
