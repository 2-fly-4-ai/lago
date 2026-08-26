import type { DomainEvent } from "../domain-events";

type SubscriptionTerminationEnv = Pick<Env, "BILLING_DB" | "DOMAIN_EVENTS">;
import { deterministicUuid } from "../identifiers";
import { stableJson } from "../json";
import { couponCreditStatements } from "./coupon-credits";
import { creditNoteAllocationStatements } from "./credit-note-credits";
import { manualTaxStatements } from "./manual-taxes";
import { paymentDueDate } from "./payment-terms";
import { prepareProgressiveCreditNote } from "./progressive-credit";
import {
  preparePayInAdvanceTerminationCredit,
  terminatePayInAdvanceWithCredit,
} from "./pay-in-advance-termination-credit";
import {
  calculateTerminationSubscriptionInvoice,
  findBillableSubscription,
  invoiceSubscriptionStatement,
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
  creditNoteId: string | null;
  creditAmountMinor: number;
};

export type TerminationActions = {
  creditNote: "credit" | "skip" | null;
  invoice: "generate" | "skip";
};

export async function terminateSubscriptionWithInvoice(
  env: SubscriptionTerminationEnv,
  subscriptionId: string,
  expectedVersion: number,
  terminatedAt: string,
  correlationId: string,
  publishImmediately = true,
  includeUnusedCredit = false,
  actions?: TerminationActions,
): Promise<TerminateSubscriptionWithInvoiceResult> {
  const subscription = await findBillableSubscription(env.BILLING_DB, subscriptionId);
  if (!subscription) throw new Error("subscription_not_found");
  const draft = subscription.invoice_grace_period > 0;
  const effectiveActions: TerminationActions = actions ?? {
    creditNote: includeUnusedCredit ? "credit" : null,
    invoice: "generate",
  };
  const terminationId = await deterministicUuid(
    "subscription-termination",
    `${subscription.id}:v${expectedVersion + 1}:${subscription.current_period_start}`,
  );
  const invoiceId = await deterministicUuid("subscription-termination-invoice", terminationId);
  const unusedCredit = includeUnusedCredit
    ? await preparePayInAdvanceTerminationCredit(
        env.BILLING_DB,
        subscriptionId,
        expectedVersion,
        terminatedAt,
        correlationId,
      )
    : null;
  const calculation = await calculateTerminationSubscriptionInvoice(
    env.BILLING_DB,
    subscription,
    invoiceId,
    terminationId,
    terminatedAt,
    unusedCredit?.creditNoteId && unusedCredit.allocationState === "finalized"
      ? {
          creditNoteId: unusedCredit.creditNoteId,
          amountMinor: unusedCredit.creditAmountMinor,
        }
      : undefined,
  );
  const now = terminatedAt;
  const correctionCreditNote =
    !draft &&
    calculation.progressiveBillingCreditInvoiceId &&
    calculation.progressiveBillingCreditExcessMinor > 0
      ? await prepareProgressiveCreditNote(env.BILLING_DB, {
          organizationId: subscription.organization_id,
          sourceInvoiceId: calculation.progressiveBillingCreditInvoiceId,
          amountMinor: calculation.progressiveBillingCreditExcessMinor,
          correctionInvoiceId: invoiceId,
          createdAt: now,
          correlationId,
        })
      : null;
  const invoiceNumber = invoiceId.replaceAll("-", "").slice(0, 20).toUpperCase();
  const terminationDate = terminatedAt.slice(0, 10);
  const issuingDate = shiftCalendarDate(terminationDate, subscription.invoice_grace_period);
  const dueDate = paymentDueDate(issuingDate, subscription.net_payment_term);
  const eventType = draft ? "invoice.drafted" : "invoice.finalized";
  const invoiceEvent: DomainEvent = {
    id: `${draft ? "invoice-drafted" : "invoice-finalized"}:${invoiceId}:v1`,
    type: eventType,
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
      expectedFinalizationDate: issuingDate,
      appliedGracePeriod: subscription.invoice_grace_period,
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
      creditNoteGenerated: Boolean(unusedCredit?.creditNoteId),
      creditNoteId: unusedCredit?.creditNoteId,
      creditAmountMinor: unusedCredit?.creditAmountMinor,
      onTerminationCreditNote: effectiveActions.creditNote,
      onTerminationInvoice: effectiveActions.invoice,
    },
  };
  const couponStatements = draft
    ? []
    : couponCreditStatements(
        env.BILLING_DB,
        subscription.organization_id,
        invoiceId,
        subscription.currency,
        calculation.couponCredits,
        now,
        correlationId,
      );
  const creditNoteStatements = draft
    ? []
    : calculation.creditNoteAllocations.flatMap((allocation) =>
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
    : calculation.walletAllocations.flatMap((allocation) =>
        walletAllocationStatements(
          env.BILLING_DB,
          subscription.organization_id,
          invoiceId,
          allocation,
          now,
          correlationId,
        ),
      );
  const creditCreationStatements: D1PreparedStatement[] = [
    ...(unusedCredit?.creationStatements ?? []),
    ...(unusedCredit?.creditNoteEvent
      ? [
          outboxStatement(
            env.BILLING_DB,
            subscription.organization_id,
            unusedCredit.creditNoteEvent,
          ),
        ]
      : []),
    ...(correctionCreditNote?.statements ?? []),
    ...(correctionCreditNote
      ? [outboxStatement(env.BILLING_DB, subscription.organization_id, correctionCreditNote.event)]
      : []),
  ];
  const statements: D1PreparedStatement[] = [
    ...creditCreationStatements,
    env.BILLING_DB.prepare(
      `INSERT INTO invoices
       (id, organization_id, customer_id, subscription_id, number, status, payment_status,
        currency, subtotal_minor, tax_minor, credits_minor, total_due_minor, version,
        finalized_at, issuing_date, created_at, updated_at, coupons_minor, prepaid_credit_minor,
       credit_notes_minor, net_payment_term, payment_due_date, payment_overdue,
        expected_finalization_date, applied_grace_period, ready_to_be_refreshed,
        last_refreshed_at, progressive_billing_credit_minor)
       SELECT ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?,
              0, ?, ?, 0, ?, ?
       FROM subscriptions
       WHERE id = ? AND organization_id = ? AND version = ?
         AND status IN ('active', 'past_due')`,
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
      draft ? null : now,
      issuingDate,
      now,
      now,
      calculation.couponsMinor,
      calculation.prepaidCreditMinor,
      calculation.creditNotesMinor,
      subscription.net_payment_term,
      dueDate,
      issuingDate,
      subscription.invoice_grace_period,
      draft ? now : null,
      calculation.progressiveBillingCreditMinor,
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
    ...(draft
      ? [
          env.BILLING_DB.prepare(
            `INSERT INTO subscription_invoice_contexts
             (invoice_id, organization_id, subscription_id, context_type, period_start,
              period_end, terminated_at, created_at)
             VALUES (?, ?, ?, 'termination', ?, ?, ?, ?)`,
          ).bind(
            invoiceId,
            subscription.organization_id,
            subscription.id,
            subscription.current_period_start,
            subscription.current_period_end,
            terminatedAt,
            now,
          ),
        ]
      : []),
    invoiceSubscriptionStatement(
      env.BILLING_DB,
      invoiceId,
      subscription.id,
      subscription.organization_id,
      "subscription_terminating",
      subscription.current_period_start,
      terminatedAt,
      now,
    ),
    ...(calculation.progressiveBillingCreditInvoiceId &&
    calculation.progressiveBillingCreditMinor > 0
      ? [
          env.BILLING_DB.prepare(
            `INSERT INTO progressive_billing_credits
             (invoice_id, progressive_invoice_id, organization_id, subscription_id,
              amount_minor, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
          ).bind(
            invoiceId,
            calculation.progressiveBillingCreditInvoiceId,
            subscription.organization_id,
            subscription.id,
            calculation.progressiveBillingCreditMinor,
            now,
          ),
        ]
      : []),
    env.BILLING_DB.prepare(
      `UPDATE subscriptions
       SET status = 'canceled', canceled_at = ?, version = version + 1, updated_at = ?
       WHERE previous_subscription_id = ? AND status = 'pending'
         AND EXISTS (
           SELECT 1 FROM subscriptions current
           WHERE current.id = ? AND current.organization_id = ? AND current.version = ?
             AND current.status IN ('active', 'past_due')
         )`,
    ).bind(
      now,
      now,
      subscription.id,
      subscription.id,
      subscription.organization_id,
      expectedVersion,
    ),
    env.BILLING_DB.prepare(
      `UPDATE subscriptions
       SET status = 'terminated', terminated_at = ?, current_period_end = ?,
           on_termination_credit_note = ?, on_termination_invoice = ?,
           version = version + 1, updated_at = ?
       WHERE id = ? AND organization_id = ? AND version = ?
         AND status IN ('active', 'past_due')`,
    ).bind(
      terminatedAt,
      terminatedAt,
      effectiveActions.creditNote,
      effectiveActions.invoice,
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
  // D1 reports changes performed by the draft-invalidation trigger as part of this statement.
  // The subscription predicate targets one primary key, so any positive count proves the transition.
  if (!subscriptionUpdate || subscriptionUpdate.meta.changes < 1) {
    throw new Error("subscription_version_conflict");
  }
  const firstCouponUpdate = creditCreationStatements.length + 2 + calculation.lines.length;
  if (!draft) {
    for (let offset = 0; offset < calculation.couponCredits.length; offset += 1) {
      const update = results[firstCouponUpdate + offset * 3];
      if (!update || update.meta.changes !== 1) throw new Error("coupon_version_conflict");
    }
  }
  if (publishImmediately) {
    if (unusedCredit?.creditNoteEvent) await env.DOMAIN_EVENTS.send(unusedCredit.creditNoteEvent);
    if (correctionCreditNote) await env.DOMAIN_EVENTS.send(correctionCreditNote.event);
    await env.DOMAIN_EVENTS.send(invoiceEvent);
    await env.DOMAIN_EVENTS.send(subscriptionEvent);
  }
  return {
    invoiceId,
    terminatedAt,
    totalDueMinor: calculation.totalDueMinor,
    lineCount: calculation.lines.length,
    invoiceEvent,
    subscriptionEvent,
    creditNoteId: unusedCredit?.creditNoteId ?? null,
    creditAmountMinor: unusedCredit?.creditAmountMinor ?? 0,
  };
}

export async function terminateSubscriptionWithoutInvoice(
  env: SubscriptionTerminationEnv,
  subscriptionId: string,
  expectedVersion: number,
  terminatedAt: string,
  correlationId: string,
  publishImmediately = true,
  actions: TerminationActions = { creditNote: null, invoice: "skip" },
): Promise<DomainEvent> {
  const subscription = await findBillableSubscription(env.BILLING_DB, subscriptionId);
  if (!subscription) throw new Error("subscription_not_found");
  const event: DomainEvent = {
    id: `subscription-terminated:${subscription.id}:v${expectedVersion + 1}`,
    type: "subscription.terminated",
    version: 1,
    aggregateType: "subscription",
    aggregateId: subscription.id,
    aggregateVersion: expectedVersion + 1,
    occurredAt: terminatedAt,
    causationId: correlationId,
    correlationId,
    payload: {
      organizationId: subscription.organization_id,
      subscriptionId: subscription.id,
      externalSubscriptionId: subscription.external_id,
      terminatedAt,
      finalInvoiceGenerated: false,
      creditNoteGenerated: false,
      onTerminationCreditNote: actions.creditNote,
      onTerminationInvoice: actions.invoice,
    },
  };
  const results = await env.BILLING_DB.batch([
    env.BILLING_DB.prepare(
      `UPDATE subscriptions
       SET status = 'canceled', canceled_at = ?, version = version + 1, updated_at = ?
       WHERE previous_subscription_id = ? AND status = 'pending'
         AND EXISTS (
           SELECT 1 FROM subscriptions current
           WHERE current.id = ? AND current.organization_id = ? AND current.version = ?
             AND current.status IN ('active', 'past_due')
         )`,
    ).bind(
      terminatedAt,
      terminatedAt,
      subscription.id,
      subscription.id,
      subscription.organization_id,
      expectedVersion,
    ),
    env.BILLING_DB.prepare(
      `UPDATE subscriptions
       SET status = 'terminated', terminated_at = ?, current_period_end = ?,
           on_termination_credit_note = ?, on_termination_invoice = ?,
           version = version + 1, updated_at = ?
       WHERE id = ? AND organization_id = ? AND version = ?
         AND status IN ('active', 'past_due')`,
    ).bind(
      terminatedAt,
      terminatedAt,
      actions.creditNote,
      actions.invoice,
      terminatedAt,
      subscription.id,
      subscription.organization_id,
      expectedVersion,
    ),
    terminationOutboxStatement(
      env.BILLING_DB,
      subscription.organization_id,
      event,
      expectedVersion + 1,
      terminatedAt,
    ),
  ]);
  if ((results[1]?.meta.changes ?? 0) < 1 || results[2]?.meta.changes !== 1) {
    throw new Error("subscription_version_conflict");
  }
  if (publishImmediately) await env.DOMAIN_EVENTS.send(event);
  return event;
}

function shiftCalendarDate(value: string, days: number): string {
  const date = new Date(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(date.getTime())) throw new Error("invalid_termination_date");
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

export async function terminateEndedSubscriptions(
  env: SubscriptionTerminationEnv,
  cutoff: string,
  correlationId: string,
): Promise<number> {
  if (!Number.isFinite(Date.parse(cutoff))) throw new Error("invalid_termination_cutoff");
  const due = await env.BILLING_DB.prepare(
    `SELECT s.id, s.version, s.ending_at, p.pay_in_advance AS plan_pay_in_advance,
            s.on_termination_credit_note, s.on_termination_invoice
     FROM subscriptions s JOIN plans p ON p.id = s.plan_id
     WHERE s.status IN ('active', 'past_due') AND s.ending_at IS NOT NULL AND s.ending_at <= ?
     ORDER BY s.ending_at, s.id LIMIT 100`,
  )
    .bind(cutoff)
    .all<{
      id: string;
      version: number;
      ending_at: string;
      plan_pay_in_advance: number;
      on_termination_credit_note: "credit" | "skip" | null;
      on_termination_invoice: "generate" | "skip" | null;
    }>();
  let terminated = 0;
  for (const subscription of due.results) {
    try {
      const actions: TerminationActions = {
        creditNote:
          subscription.plan_pay_in_advance === 1
            ? (subscription.on_termination_credit_note ?? "credit")
            : null,
        invoice: subscription.on_termination_invoice ?? "generate",
      };
      const commandCorrelationId = `${correlationId}:${subscription.id}`;
      if (actions.invoice === "generate") {
        await terminateSubscriptionWithInvoice(
          env,
          subscription.id,
          subscription.version,
          subscription.ending_at,
          commandCorrelationId,
          false,
          subscription.plan_pay_in_advance === 1 && actions.creditNote === "credit",
          actions,
        );
      } else if (subscription.plan_pay_in_advance === 1 && actions.creditNote === "credit") {
        await terminatePayInAdvanceWithCredit(
          env,
          subscription.id,
          subscription.version,
          subscription.ending_at,
          commandCorrelationId,
          actions,
          false,
        );
      } else {
        await terminateSubscriptionWithoutInvoice(
          env,
          subscription.id,
          subscription.version,
          subscription.ending_at,
          commandCorrelationId,
          false,
          actions,
        );
      }
      terminated += 1;
    } catch (error) {
      if (!(error instanceof Error) || error.message !== "subscription_version_conflict") {
        throw error;
      }
      const current = await env.BILLING_DB.prepare(
        "SELECT status FROM subscriptions WHERE id = ? LIMIT 1",
      )
        .bind(subscription.id)
        .first<{ status: string }>();
      if (current?.status !== "terminated") throw error;
    }
  }
  return terminated;
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

function terminationOutboxStatement(
  database: D1Database,
  organizationId: string,
  event: DomainEvent,
  expectedVersion: number,
  terminatedAt: string,
): D1PreparedStatement {
  return database
    .prepare(
      `INSERT INTO outbox_events
       (event_id, organization_id, event_type, event_version, aggregate_type,
        aggregate_id, aggregate_version, causation_id, correlation_id, payload_json,
        occurred_at, published_at)
       SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL
       FROM subscriptions
       WHERE id = ? AND organization_id = ? AND version = ?
         AND status = 'terminated' AND terminated_at = ?`,
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
      expectedVersion,
      terminatedAt,
    );
}
