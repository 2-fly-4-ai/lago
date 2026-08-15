import type { DomainEvent } from "../domain-events";
import { deterministicUuid } from "../identifiers";
import { stableJson } from "../json";
import { Decimal } from "../rating/decimal";
import { couponCreditStatements } from "./coupon-credits";
import { creditNoteAllocationStatements } from "./credit-note-credits";
import { manualTaxStatements } from "./manual-taxes";
import {
  preparePayInAdvanceTerminationCredit,
  type PreparedPayInAdvanceTerminationCredit,
} from "./pay-in-advance-termination-credit";
import { paymentDueDate } from "./payment-terms";
import { prepareProgressiveCreditNote } from "./progressive-credit";
import {
  addTrialDays,
  firstPeriodEnd,
  localDate,
  localDateString,
  type BillingTime,
} from "./periods";
import {
  calculateInitialSubscriptionInvoice,
  calculateInitialPayInAdvanceFixedChargeLines,
  calculateInvoiceAllocations,
  calculateTerminationSubscriptionInvoice,
  findBillableSubscription,
  subscriptionInvoiceLineStatements,
  type BillableSubscription,
  type SubscriptionInvoiceLine,
} from "./subscription-invoice-calculation";
import { walletAllocationStatements } from "./wallet-credits";
import {
  customSectionLinkStatements,
  guardedCustomSectionLinkStatements,
} from "../subscriptions/custom-sections";
import {
  prepareUsageThresholds,
  type NormalizedUsageThresholdInput,
  type PreparedUsageThreshold,
} from "../usage/thresholds";

type CurrentGeneration = {
  id: string;
  organization_id: string;
  customer_id: string;
  plan_id: string;
  external_id: string;
  status: "pending" | "active" | "past_due";
  subscription_at: string;
  started_at: string | null;
  current_period_start: string | null;
  current_period_end: string | null;
  ending_at: string | null;
  billing_time: BillingTime;
  billing_timezone: string;
  generation: number;
  version: number;
  plan_amount_minor: number;
  plan_currency: string;
  plan_interval: string;
  plan_pay_in_advance: number;
  trial_started_at: string | null;
  trial_end_at: string | null;
  trial_ended_at: string | null;
  invoice_grace_period: number;
  net_payment_term: number;
  payment_method_type: "manual" | "provider" | null;
  payment_method_id: string | null;
  skip_invoice_custom_sections: number;
};

type TargetPlan = {
  id: string;
  code: string;
  name: string;
  interval: string;
  amount_minor: number;
  currency: string;
  pay_in_advance: number;
  trial_period: number | null;
};

export type ChangeSubscriptionPlanInput = {
  organizationId: string;
  externalSubscriptionId: string;
  externalCustomerId: string;
  planCode: string;
  name: string | null;
  endingAt: string | null;
  requestHash: string;
  requestId: string;
  paymentMethodType?: "manual" | "provider" | null;
  paymentMethodId?: string | null;
  customSectionIds?: string[];
  skipInvoiceCustomSections?: boolean;
  usageThresholds?: NormalizedUsageThresholdInput[];
};

export type ChangeSubscriptionPlanResult = {
  responseSubscriptionId: string;
  changed: boolean;
  transition: "pending_update" | "upgrade" | "downgrade";
};

export async function changeSubscriptionPlan(
  env: Env,
  input: ChangeSubscriptionPlanInput,
): Promise<ChangeSubscriptionPlanResult> {
  const current = await findCurrentGeneration(
    env.BILLING_DB,
    input.organizationId,
    input.externalSubscriptionId,
  );
  if (!current) throw new Error("subscription_not_found");
  const target = await findTargetPlan(env.BILLING_DB, input.organizationId, input.planCode);
  if (!target) throw new Error("plan_not_found");
  if (current.plan_currency !== target.currency) throw new Error("plan_currency_mismatch");
  try {
    if (current.status === "pending") return updateInitialPending(env, current, target, input);

    const comparison = compareAnnualized(target, current);
    if (comparison >= 0) return upgradeActiveGeneration(env, current, target, input);
    return scheduleDowngrade(env, current, target, input);
  } catch (error) {
    const concurrent = await resolveConcurrentChange(env.BILLING_DB, current, target, input);
    if (concurrent) return concurrent;
    if (isD1ConcurrencyError(error)) throw new Error("subscription_version_conflict");
    throw error;
  }
}

function isD1ConcurrencyError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const message = error.message.toLowerCase();
  return (
    message.includes("unique constraint") ||
    message.includes("constraint failed") ||
    message.includes("database is locked") ||
    message.includes("d1_error")
  );
}

async function resolveConcurrentChange(
  database: D1Database,
  previous: CurrentGeneration,
  target: TargetPlan,
  input: ChangeSubscriptionPlanInput,
): Promise<ChangeSubscriptionPlanResult | null> {
  const result = await database
    .prepare(
      `SELECT current.id AS current_id, current.plan_id AS current_plan_id,
              current.request_sha256 AS current_request_sha256,
              pending.id AS pending_id, pending.plan_id AS pending_plan_id,
              pending.request_sha256 AS pending_request_sha256
       FROM subscriptions current
       LEFT JOIN subscriptions pending ON pending.previous_subscription_id = current.id
         AND pending.status = 'pending'
       WHERE current.organization_id = ? AND current.external_id = ?
         AND (current.status IN ('active', 'past_due') OR
              (current.status = 'pending' AND current.previous_subscription_id IS NULL))
       ORDER BY CASE WHEN current.status IN ('active', 'past_due') THEN 0 ELSE 1 END,
                current.generation DESC LIMIT 1`,
    )
    .bind(previous.organization_id, previous.external_id)
    .first<{
      current_id: string;
      current_plan_id: string;
      current_request_sha256: string | null;
      pending_id: string | null;
      pending_plan_id: string | null;
      pending_request_sha256: string | null;
    }>();
  if (
    result?.current_plan_id === target.id &&
    result.current_request_sha256 === input.requestHash
  ) {
    return {
      responseSubscriptionId: result.current_id,
      changed: false,
      transition: previous.status === "pending" ? "pending_update" : "upgrade",
    };
  }
  if (
    result?.pending_plan_id === target.id &&
    result.pending_request_sha256 === input.requestHash
  ) {
    return { responseSubscriptionId: result.current_id, changed: false, transition: "downgrade" };
  }
  return null;
}

async function updateInitialPending(
  env: Env,
  current: CurrentGeneration,
  target: TargetPlan,
  input: ChangeSubscriptionPlanInput,
): Promise<ChangeSubscriptionPlanResult> {
  const changedAt = new Date().toISOString();
  const initialStartedAt = current.subscription_at;
  const trialEndAt = trialEnd(target, initialStartedAt, current.billing_timezone);
  const paymentMethodType =
    input.paymentMethodType === undefined ? current.payment_method_type : input.paymentMethodType;
  const paymentMethodId =
    input.paymentMethodType === undefined
      ? current.payment_method_id
      : (input.paymentMethodId ?? null);
  const sectionUpdate = pendingCustomSectionUpdate(current, input);
  const event = subscriptionEvent(
    "subscription.updated",
    current.id,
    current.version + 1,
    changedAt,
    input.requestId,
    {
      organizationId: current.organization_id,
      subscriptionId: current.id,
      externalSubscriptionId: current.external_id,
      planCode: target.code,
      status: "pending",
      skipInvoiceCustomSections: sectionUpdate.skip === 1,
    },
  );
  const sectionStatements = guardedCustomSectionLinkStatements(
    env.BILLING_DB,
    current.organization_id,
    current.id,
    sectionUpdate.sectionIds,
    changedAt,
    current.version + 1,
    "pending",
  );
  const replacementUsageThresholds =
    input.usageThresholds === undefined
      ? null
      : await prepareUsageThresholds(
          "subscription",
          current.organization_id,
          current.id,
          current.version + 1,
          input.usageThresholds,
        );
  const thresholdStatements = guardedPendingUsageThresholdStatements(
    env.BILLING_DB,
    current,
    replacementUsageThresholds,
    changedAt,
  );
  const statements = [
    env.BILLING_DB.prepare(
      `UPDATE subscriptions
       SET plan_id = ?, name = ?, ending_at = ?, request_sha256 = ?,
           payment_method_type = ?, payment_method_id = ?,
           trial_started_at = ?, trial_end_at = ?, trial_ended_at = NULL,
           skip_invoice_custom_sections = ?,
           version = version + 1, updated_at = ?
       WHERE id = ? AND organization_id = ? AND version = ? AND status = 'pending'
         AND previous_subscription_id IS NULL`,
    ).bind(
      target.id,
      input.name,
      input.endingAt ?? current.ending_at,
      input.requestHash,
      paymentMethodType,
      paymentMethodId,
      trialEndAt ? initialStartedAt : null,
      trialEndAt,
      sectionUpdate.skip,
      changedAt,
      current.id,
      current.organization_id,
      current.version,
    ),
    ...sectionStatements,
    ...thresholdStatements,
    guardedOutboxStatement(
      env.BILLING_DB,
      current.organization_id,
      event,
      current.id,
      current.version + 1,
      "pending",
      changedAt,
    ),
  ];
  const results = await env.BILLING_DB.batch(statements);
  const outboxIndex = statements.length - 1;
  if (
    (results[0]?.meta.changes ?? 0) < 1 ||
    results[outboxIndex]?.meta.changes !== 1 ||
    (replacementUsageThresholds !== null &&
      results
        .slice(
          2 + sectionStatements.length,
          2 + sectionStatements.length + replacementUsageThresholds.length,
        )
        .some((result) => result.meta.changes !== 1))
  ) {
    throw new Error("subscription_version_conflict");
  }
  await env.DOMAIN_EVENTS.send(event);
  return { responseSubscriptionId: current.id, changed: true, transition: "pending_update" };
}

function pendingCustomSectionUpdate(
  current: CurrentGeneration,
  input: ChangeSubscriptionPlanInput,
): { skip: number; sectionIds: string[] | undefined } {
  if (input.skipInvoiceCustomSections === true) return { skip: 1, sectionIds: [] };
  if (input.skipInvoiceCustomSections === false) {
    return { skip: 0, sectionIds: input.customSectionIds };
  }
  if (current.skip_invoice_custom_sections === 1) return { skip: 1, sectionIds: undefined };
  return { skip: 0, sectionIds: input.customSectionIds };
}

function guardedPendingUsageThresholdStatements(
  database: D1Database,
  current: CurrentGeneration,
  thresholds: PreparedUsageThreshold[] | null,
  changedAt: string,
): D1PreparedStatement[] {
  if (thresholds === null) return [];
  const guard = `EXISTS (
    SELECT 1 FROM subscriptions
    WHERE id = ? AND organization_id = ? AND version = ? AND status = 'pending'
      AND previous_subscription_id IS NULL AND updated_at = ?
  )`;
  return [
    database
      .prepare(
        `UPDATE usage_thresholds
         SET deleted_at = ?, version = version + 1, updated_at = ?
         WHERE organization_id = ? AND subscription_id = ? AND deleted_at IS NULL
           AND ${guard}`,
      )
      .bind(
        changedAt,
        changedAt,
        current.organization_id,
        current.id,
        current.id,
        current.organization_id,
        current.version + 1,
        changedAt,
      ),
    ...thresholds.map((threshold) =>
      database
        .prepare(
          `INSERT INTO usage_thresholds
           (id, organization_id, plan_id, subscription_id, amount_minor, recurring,
            threshold_display_name, version, deleted_at, created_at, updated_at)
           SELECT ?, ?, NULL, ?, ?, ?, ?, 1, NULL, ?, ?
           WHERE ${guard}`,
        )
        .bind(
          threshold.id,
          current.organization_id,
          current.id,
          threshold.amountMinor,
          threshold.recurring,
          threshold.displayName,
          changedAt,
          changedAt,
          current.id,
          current.organization_id,
          current.version + 1,
          changedAt,
        ),
    ),
  ];
}

async function prepareNextGenerationUsageThresholds(
  current: CurrentGeneration,
  nextId: string,
  inputs: NormalizedUsageThresholdInput[] | undefined,
): Promise<PreparedUsageThreshold[]> {
  if (inputs === undefined) return [];
  return prepareUsageThresholds("subscription", current.organization_id, nextId, 1, inputs);
}

function newGenerationUsageThresholdStatements(
  database: D1Database,
  organizationId: string,
  nextId: string,
  previousId: string,
  previousVersion: number,
  thresholds: PreparedUsageThreshold[],
  changedAt: string,
): D1PreparedStatement[] {
  return thresholds.map((threshold) =>
    database
      .prepare(
        `INSERT INTO usage_thresholds
         (id, organization_id, plan_id, subscription_id, amount_minor, recurring,
          threshold_display_name, version, deleted_at, created_at, updated_at)
         SELECT ?, ?, NULL, ?, ?, ?, ?, 1, NULL, ?, ?
         WHERE EXISTS (
           SELECT 1 FROM subscriptions next
           JOIN subscriptions previous ON previous.id = next.previous_subscription_id
           WHERE next.id = ? AND next.organization_id = ? AND next.previous_subscription_id = ?
             AND previous.organization_id = ? AND previous.version IN (?, ?)
         )`,
      )
      .bind(
        threshold.id,
        organizationId,
        nextId,
        threshold.amountMinor,
        threshold.recurring,
        threshold.displayName,
        changedAt,
        changedAt,
        nextId,
        organizationId,
        previousId,
        organizationId,
        previousVersion,
        previousVersion + 1,
      ),
  );
}

async function scheduleDowngrade(
  env: Env,
  current: CurrentGeneration,
  target: TargetPlan,
  input: ChangeSubscriptionPlanInput,
): Promise<ChangeSubscriptionPlanResult> {
  if (!current.current_period_end) throw new Error("subscription_period_missing");
  const existing = await env.BILLING_DB.prepare(
    `SELECT id, plan_id, request_sha256 FROM subscriptions
     WHERE previous_subscription_id = ? AND status = 'pending'
     ORDER BY generation DESC LIMIT 1`,
  )
    .bind(current.id)
    .first<{ id: string; plan_id: string; request_sha256: string | null }>();
  if (existing?.plan_id === target.id && existing.request_sha256 === input.requestHash) {
    return { responseSubscriptionId: current.id, changed: false, transition: "downgrade" };
  }
  const changedAt = new Date().toISOString();
  const nextGeneration = await nextGenerationNumber(env.BILLING_DB, current);
  const nextId = await deterministicUuid(
    "subscription-generation",
    `${current.organization_id}:${current.external_id}:g${nextGeneration}`,
  );
  const initialStartedAt = await initialStartedAtFor(env.BILLING_DB, current);
  const trialEndAt = trialEnd(target, initialStartedAt, current.billing_timezone);
  const nextSkipInvoiceCustomSections = input.skipInvoiceCustomSections === true ? 1 : 0;
  const nextUsageThresholds = await prepareNextGenerationUsageThresholds(
    current,
    nextId,
    input.usageThresholds,
  );
  const event = subscriptionEvent(
    "subscription.updated",
    current.id,
    current.version + 1,
    changedAt,
    input.requestId,
    {
      organizationId: current.organization_id,
      subscriptionId: current.id,
      externalSubscriptionId: current.external_id,
      nextSubscriptionId: nextId,
      nextPlanCode: target.code,
      downgradePlanDate: current.current_period_end,
    },
  );
  const statements: D1PreparedStatement[] = [];
  if (existing) {
    statements.push(
      env.BILLING_DB.prepare(
        `UPDATE subscriptions
         SET status = 'canceled', canceled_at = ?, version = version + 1, updated_at = ?
         WHERE id = ? AND status = 'pending' AND previous_subscription_id = ?
           AND EXISTS (
             SELECT 1 FROM subscriptions previous
             WHERE previous.id = ? AND previous.organization_id = ? AND previous.version = ?
               AND previous.status IN ('active', 'past_due')
           )`,
      ).bind(
        changedAt,
        changedAt,
        existing.id,
        current.id,
        current.id,
        current.organization_id,
        current.version,
      ),
    );
  }
  statements.push(
    env.BILLING_DB.prepare(
      `INSERT INTO subscriptions
       (id, organization_id, customer_id, plan_id, external_id, status, started_at,
        current_period_start, current_period_end, canceled_at, terminated_at, version,
        created_at, updated_at, name, request_sha256, subscription_at, ending_at,
        on_termination_credit_note, on_termination_invoice, billing_time, billing_timezone,
        trial_started_at, trial_end_at, trial_ended_at, previous_subscription_id,
        transition_kind, transition_at, generation, payment_method_type, payment_method_id,
        skip_invoice_custom_sections)
       SELECT ?, ?, ?, ?, ?, 'pending', NULL, NULL, NULL, NULL, NULL, 1, ?, ?, ?, ?, ?, ?,
              NULL, NULL, ?, ?, ?, ?, ?, ?, 'downgrade', ?, ?, ?, ?, ?
       FROM subscriptions previous
       WHERE previous.id = ? AND previous.organization_id = ? AND previous.version = ?
         AND previous.status IN ('active', 'past_due')`,
    ).bind(
      nextId,
      current.organization_id,
      current.customer_id,
      target.id,
      current.external_id,
      changedAt,
      changedAt,
      input.name,
      input.requestHash,
      current.subscription_at,
      input.endingAt ?? current.ending_at,
      current.billing_time,
      current.billing_timezone,
      trialEndAt ? initialStartedAt : null,
      trialEndAt,
      trialEndAt && Date.parse(trialEndAt) <= Date.parse(current.current_period_end)
        ? trialEndAt
        : null,
      current.id,
      current.current_period_end,
      nextGeneration,
      input.paymentMethodType === undefined ? current.payment_method_type : input.paymentMethodType,
      input.paymentMethodType === undefined
        ? current.payment_method_id
        : (input.paymentMethodId ?? null),
      nextSkipInvoiceCustomSections,
      current.id,
      current.organization_id,
      current.version,
    ),
    ...customSectionLinkStatements(
      env.BILLING_DB,
      current.organization_id,
      nextId,
      input.customSectionIds,
      changedAt,
      false,
    ),
    ...newGenerationUsageThresholdStatements(
      env.BILLING_DB,
      current.organization_id,
      nextId,
      current.id,
      current.version,
      nextUsageThresholds,
      changedAt,
    ),
    env.BILLING_DB.prepare(
      `UPDATE subscriptions SET version = version + 1, updated_at = ?
       WHERE id = ? AND organization_id = ? AND version = ?
         AND status IN ('active', 'past_due')`,
    ).bind(changedAt, current.id, current.organization_id, current.version),
    guardedOutboxStatement(
      env.BILLING_DB,
      current.organization_id,
      event,
      current.id,
      current.version + 1,
      current.status,
      changedAt,
    ),
  );
  let results: D1Result<unknown>[];
  try {
    results = await env.BILLING_DB.batch(statements);
  } catch {
    throw new Error("subscription_version_conflict");
  }
  const insertIndex = existing ? 1 : 0;
  const linkCount = input.customSectionIds?.length ?? 0;
  const updateIndex = insertIndex + 1 + linkCount + nextUsageThresholds.length;
  if (
    results[insertIndex]?.meta.changes !== 1 ||
    (results[updateIndex]?.meta.changes ?? 0) < 1 ||
    results[updateIndex + 1]?.meta.changes !== 1
  ) {
    throw new Error("subscription_version_conflict");
  }
  await env.DOMAIN_EVENTS.send(event);
  return { responseSubscriptionId: current.id, changed: true, transition: "downgrade" };
}

async function upgradeActiveGeneration(
  env: Env,
  current: CurrentGeneration,
  target: TargetPlan,
  input: ChangeSubscriptionPlanInput,
): Promise<ChangeSubscriptionPlanResult> {
  const previous = await findBillableSubscription(env.BILLING_DB, current.id);
  if (!previous || !current.current_period_start || !current.current_period_end) {
    throw new Error("subscription_period_missing");
  }
  const changedAt = new Date().toISOString();
  const nextGeneration = await nextGenerationNumber(env.BILLING_DB, current);
  const nextId = await deterministicUuid(
    "subscription-generation",
    `${current.organization_id}:${current.external_id}:g${nextGeneration}`,
  );
  const invoiceId = await deterministicUuid(
    "subscription-plan-change-invoice",
    `${current.id}:${nextId}:${changedAt}`,
  );
  const nextPeriodEnd = firstPeriodEnd(
    new Date(changedAt),
    target.interval,
    current.billing_time,
    current.billing_timezone,
  ).toISOString();
  const initialStartedAt = await initialStartedAtFor(env.BILLING_DB, current);
  const targetTrialEndAt = trialEnd(target, initialStartedAt, current.billing_timezone);
  const targetTrialActive =
    targetTrialEndAt !== null && Date.parse(targetTrialEndAt) > Date.parse(changedAt);
  const nextSkipInvoiceCustomSections = input.skipInvoiceCustomSections === true ? 1 : 0;
  const nextUsageThresholds = await prepareNextGenerationUsageThresholds(
    current,
    nextId,
    input.usageThresholds,
  );
  const nextSubscription: BillableSubscription = {
    id: nextId,
    organization_id: current.organization_id,
    customer_id: current.customer_id,
    plan_id: target.id,
    external_id: current.external_id,
    current_period_start: changedAt,
    current_period_end: nextPeriodEnd,
    interval: target.interval,
    currency: target.currency,
    plan_name: target.name,
    subscription_name: input.name,
    plan_amount_minor: target.amount_minor,
    plan_pay_in_advance: target.pay_in_advance,
    net_payment_term: current.net_payment_term,
    invoice_grace_period: current.invoice_grace_period,
    billing_time: current.billing_time,
    billing_timezone: current.billing_timezone,
    trial_started_at: targetTrialEndAt ? initialStartedAt : null,
    trial_end_at: targetTrialEndAt,
    trial_ended_at: targetTrialEndAt && !targetTrialActive ? targetTrialEndAt : null,
  };

  const previousCalculation = await calculateTerminationSubscriptionInvoice(
    env.BILLING_DB,
    previous,
    invoiceId,
    `plan-change:${current.id}:${nextId}`,
    changedAt,
  );
  const previousLines = adjustUpgradeTerminationDay(
    previousCalculation.lines,
    previous.plan_amount_minor,
    previous.trial_end_at,
  );
  const unadjustedNextLines =
    target.pay_in_advance === 1 && !targetTrialActive
      ? (
          await calculateInitialSubscriptionInvoice(
            env.BILLING_DB,
            { ...nextSubscription, trial_end_at: changedAt, trial_ended_at: changedAt },
            invoiceId,
            changedAt,
            nextPeriodEnd,
          )
        ).lines
      : await calculateInitialPayInAdvanceFixedChargeLines(
          env.BILLING_DB,
          nextSubscription,
          invoiceId,
          changedAt,
          nextPeriodEnd,
        );
  const nextLines = await applyPreviousAdvanceFixedChargeOffsets(
    env.BILLING_DB,
    current.id,
    current.billing_timezone,
    changedAt,
    unadjustedNextLines,
  );
  const lines = [...previousLines, ...nextLines];
  const unusedCredit = await maybePrepareUnusedCredit(
    env.BILLING_DB,
    previous,
    current,
    changedAt,
    input.requestId,
  );
  const draft = current.invoice_grace_period > 0;
  const allocations = await calculateInvoiceAllocations(
    env.BILLING_DB,
    nextSubscription,
    invoiceId,
    lines,
    unusedCredit?.creditNoteId && unusedCredit.allocationState === "finalized"
      ? { creditNoteId: unusedCredit.creditNoteId, amountMinor: unusedCredit.creditAmountMinor }
      : undefined,
    previousCalculation.progressiveBillingCreditMinor,
  );
  const correctionCreditNote =
    !draft &&
    previousCalculation.progressiveBillingCreditInvoiceId &&
    previousCalculation.progressiveBillingCreditExcessMinor > 0
      ? await prepareProgressiveCreditNote(env.BILLING_DB, {
          organizationId: current.organization_id,
          sourceInvoiceId: previousCalculation.progressiveBillingCreditInvoiceId,
          amountMinor: previousCalculation.progressiveBillingCreditExcessMinor,
          correctionInvoiceId: invoiceId,
          createdAt: changedAt,
          correlationId: input.requestId,
        })
      : null;
  const issuingDate = shiftCalendarDate(
    localDateString(new Date(changedAt), current.billing_timezone),
    current.invoice_grace_period,
  );
  const invoiceEvent = subscriptionEvent(
    draft ? "invoice.drafted" : "invoice.finalized",
    invoiceId,
    1,
    changedAt,
    input.requestId,
    {
      organizationId: current.organization_id,
      subscriptionId: nextId,
      previousSubscriptionId: current.id,
      invoicingReason: "upgrading",
      totalDueMinor: allocations.totalDueMinor,
      currency: target.currency,
    },
    "invoice",
  );
  const terminatedEvent = subscriptionEvent(
    "subscription.terminated",
    current.id,
    current.version + 1,
    changedAt,
    input.requestId,
    {
      organizationId: current.organization_id,
      subscriptionId: current.id,
      externalSubscriptionId: current.external_id,
      terminatedAt: changedAt,
      upgrade: true,
      nextSubscriptionId: nextId,
    },
  );
  const startedEvent = subscriptionEvent(
    "subscription.started",
    nextId,
    1,
    changedAt,
    input.requestId,
    {
      organizationId: current.organization_id,
      subscriptionId: nextId,
      externalSubscriptionId: current.external_id,
      previousSubscriptionId: current.id,
      planCode: target.code,
      startedAt: changedAt,
      upgrade: true,
    },
  );

  const statements: D1PreparedStatement[] = [
    ...(unusedCredit?.creationStatements ?? []),
    ...(unusedCredit?.creditNoteEvent
      ? [outboxStatement(env.BILLING_DB, current.organization_id, unusedCredit.creditNoteEvent)]
      : []),
    ...(correctionCreditNote?.statements ?? []),
    ...(correctionCreditNote
      ? [outboxStatement(env.BILLING_DB, current.organization_id, correctionCreditNote.event)]
      : []),
    env.BILLING_DB.prepare(
      `INSERT INTO invoices
       (id, organization_id, customer_id, subscription_id, number, status, payment_status,
        currency, subtotal_minor, tax_minor, credits_minor, total_due_minor, version,
        finalized_at, issuing_date, created_at, updated_at, coupons_minor, prepaid_credit_minor,
        credit_notes_minor, net_payment_term, payment_due_date, payment_overdue,
        expected_finalization_date, applied_grace_period, ready_to_be_refreshed,
        last_refreshed_at, progressive_billing_credit_minor)
       SELECT ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0,
              ?, ?, 0, ?, ?
       FROM subscriptions WHERE id = ? AND version = ? AND status IN ('active', 'past_due')`,
    ).bind(
      invoiceId,
      current.organization_id,
      current.customer_id,
      current.id,
      invoiceId.replaceAll("-", "").slice(0, 20).toUpperCase(),
      draft ? "draft" : "finalized",
      target.currency,
      allocations.subtotalMinor,
      allocations.taxMinor,
      allocations.creditsMinor,
      allocations.totalDueMinor,
      draft ? null : changedAt,
      issuingDate,
      changedAt,
      changedAt,
      allocations.couponsMinor,
      allocations.prepaidCreditMinor,
      allocations.creditNotesMinor,
      current.net_payment_term,
      paymentDueDate(issuingDate, current.net_payment_term),
      issuingDate,
      current.invoice_grace_period,
      draft ? changedAt : null,
      previousCalculation.progressiveBillingCreditMinor,
      current.id,
      current.version,
    ),
    ...subscriptionInvoiceLineStatements(env.BILLING_DB, invoiceId, null, lines, changedAt),
    ...(draft
      ? []
      : couponCreditStatements(
          env.BILLING_DB,
          current.organization_id,
          invoiceId,
          target.currency,
          allocations.couponCredits,
          changedAt,
          input.requestId,
        )),
    ...manualTaxStatements(
      env.BILLING_DB,
      current.organization_id,
      invoiceId,
      target.currency,
      allocations.invoiceTaxes,
      changedAt,
    ),
    ...(draft
      ? []
      : allocations.creditNoteAllocations.flatMap((allocation) =>
          creditNoteAllocationStatements(
            env.BILLING_DB,
            current.organization_id,
            invoiceId,
            allocation,
            changedAt,
            input.requestId,
          ),
        )),
    ...(draft
      ? []
      : allocations.walletAllocations.flatMap((allocation) =>
          walletAllocationStatements(
            env.BILLING_DB,
            current.organization_id,
            invoiceId,
            allocation,
            changedAt,
            input.requestId,
          ),
        )),
    env.BILLING_DB.prepare(
      `UPDATE subscriptions
       SET status = 'terminated', terminated_at = ?, current_period_end = ?,
           version = version + 1, updated_at = ?
       WHERE id = ? AND organization_id = ? AND version = ?
         AND status IN ('active', 'past_due')`,
    ).bind(changedAt, changedAt, changedAt, current.id, current.organization_id, current.version),
    env.BILLING_DB.prepare(
      `INSERT INTO subscriptions
       (id, organization_id, customer_id, plan_id, external_id, status, started_at,
        current_period_start, current_period_end, canceled_at, terminated_at, version,
        created_at, updated_at, name, request_sha256, subscription_at, ending_at,
        on_termination_credit_note, on_termination_invoice, billing_time, billing_timezone,
        trial_started_at, trial_end_at, trial_ended_at, previous_subscription_id,
        transition_kind, transition_at, generation, payment_method_type, payment_method_id,
        skip_invoice_custom_sections)
       VALUES (?, ?, ?, ?, ?, 'active', ?, ?, ?, NULL, NULL, 1, ?, ?, ?, ?, ?, ?, NULL, NULL,
               ?, ?, ?, ?, ?, ?, 'upgrade', ?, ?, ?, ?, ?)`,
    ).bind(
      nextId,
      current.organization_id,
      current.customer_id,
      target.id,
      current.external_id,
      changedAt,
      changedAt,
      nextPeriodEnd,
      changedAt,
      changedAt,
      input.name,
      input.requestHash,
      current.subscription_at,
      input.endingAt ?? current.ending_at,
      current.billing_time,
      current.billing_timezone,
      nextSubscription.trial_started_at,
      nextSubscription.trial_end_at,
      nextSubscription.trial_ended_at,
      current.id,
      changedAt,
      nextGeneration,
      input.paymentMethodType === undefined ? current.payment_method_type : input.paymentMethodType,
      input.paymentMethodType === undefined
        ? current.payment_method_id
        : (input.paymentMethodId ?? null),
      nextSkipInvoiceCustomSections,
    ),
    ...customSectionLinkStatements(
      env.BILLING_DB,
      current.organization_id,
      nextId,
      input.customSectionIds,
      changedAt,
      false,
    ),
    ...newGenerationUsageThresholdStatements(
      env.BILLING_DB,
      current.organization_id,
      nextId,
      current.id,
      current.version,
      nextUsageThresholds,
      changedAt,
    ),
    env.BILLING_DB.prepare(
      `INSERT INTO invoice_subscriptions
       (invoice_id, subscription_id, organization_id, invoicing_reason, period_start,
        period_end, created_at)
       VALUES (?, ?, ?, 'upgrading', ?, ?, ?), (?, ?, ?, 'upgrading', ?, ?, ?)`,
    ).bind(
      invoiceId,
      current.id,
      current.organization_id,
      current.current_period_start,
      changedAt,
      changedAt,
      invoiceId,
      nextId,
      current.organization_id,
      changedAt,
      nextPeriodEnd,
      changedAt,
    ),
    env.BILLING_DB.prepare(
      `INSERT INTO plan_change_invoice_contexts
       (invoice_id, organization_id, previous_subscription_id, next_subscription_id,
        transition_kind, transitioned_at, previous_period_start, previous_period_end,
        next_period_start, next_period_end, created_at)
       VALUES (?, ?, ?, ?, 'upgrade', ?, ?, ?, ?, ?, ?)`,
    ).bind(
      invoiceId,
      current.organization_id,
      current.id,
      nextId,
      changedAt,
      current.current_period_start,
      current.current_period_end,
      changedAt,
      nextPeriodEnd,
      changedAt,
    ),
    ...(previousCalculation.progressiveBillingCreditInvoiceId &&
    previousCalculation.progressiveBillingCreditMinor > 0
      ? [
          env.BILLING_DB.prepare(
            `INSERT INTO progressive_billing_credits
             (invoice_id, progressive_invoice_id, organization_id, subscription_id,
              amount_minor, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
          ).bind(
            invoiceId,
            previousCalculation.progressiveBillingCreditInvoiceId,
            current.organization_id,
            current.id,
            previousCalculation.progressiveBillingCreditMinor,
            changedAt,
          ),
        ]
      : []),
    outboxStatement(env.BILLING_DB, current.organization_id, terminatedEvent),
    outboxStatement(env.BILLING_DB, current.organization_id, startedEvent),
    outboxStatement(env.BILLING_DB, current.organization_id, invoiceEvent),
  ];

  let results: D1Result<unknown>[];
  try {
    results = await env.BILLING_DB.batch(statements);
  } catch {
    throw new Error("subscription_version_conflict");
  }
  const oldGeneration = await env.BILLING_DB.prepare(
    "SELECT status FROM subscriptions WHERE id = ? AND version = ?",
  )
    .bind(current.id, current.version + 1)
    .first<{ status: string }>();
  const newGeneration = await env.BILLING_DB.prepare(
    "SELECT status FROM subscriptions WHERE id = ? AND previous_subscription_id = ?",
  )
    .bind(nextId, current.id)
    .first<{ status: string }>();
  if (
    !results.length ||
    oldGeneration?.status !== "terminated" ||
    newGeneration?.status !== "active"
  ) {
    throw new Error("subscription_version_conflict");
  }
  await Promise.all([
    ...(unusedCredit?.creditNoteEvent
      ? [env.DOMAIN_EVENTS.send(unusedCredit.creditNoteEvent)]
      : []),
    ...(correctionCreditNote ? [env.DOMAIN_EVENTS.send(correctionCreditNote.event)] : []),
    env.DOMAIN_EVENTS.send(terminatedEvent),
    env.DOMAIN_EVENTS.send(startedEvent),
    env.DOMAIN_EVENTS.send(invoiceEvent),
  ]);
  return { responseSubscriptionId: nextId, changed: true, transition: "upgrade" };
}

async function maybePrepareUnusedCredit(
  database: D1Database,
  previous: BillableSubscription,
  current: CurrentGeneration,
  changedAt: string,
  correlationId: string,
): Promise<PreparedPayInAdvanceTerminationCredit | null> {
  if (previous.plan_pay_in_advance !== 1) return null;
  if (
    current.trial_end_at &&
    current.trial_ended_at === null &&
    Date.parse(current.trial_end_at) > Date.parse(changedAt)
  ) {
    return null;
  }
  return preparePayInAdvanceTerminationCredit(
    database,
    current.id,
    current.version,
    changedAt,
    correlationId,
  );
}

export function adjustUpgradeTerminationDay(
  lines: SubscriptionInvoiceLine[],
  planAmountMinor: number,
  trialEndAt: string | null = null,
): SubscriptionInvoiceLine[] {
  return lines.flatMap((line) => {
    if (line.lineType !== "subscription") return [line];
    const metadata = JSON.parse(line.metadataJson) as Record<string, unknown>;
    const billableDays = Number(metadata.billableDays);
    const fullPeriodDays = Number(metadata.fullPeriodDays);
    if (!Number.isSafeInteger(billableDays) || !Number.isSafeInteger(fullPeriodDays)) return [line];
    const periodStart = typeof metadata.periodStart === "string" ? metadata.periodStart : null;
    const trialDays =
      trialEndAt && periodStart
        ? Math.max(0, utcDayOrdinal(trialEndAt) - utcDayOrdinal(periodStart))
        : 0;
    const upgradeDays = Math.max(0, billableDays - 1 - trialDays);
    if (upgradeDays === 0) return [];
    const precise = Decimal.parse(planAmountMinor)
      .multiply(Decimal.parse(upgradeDays))
      .divideByInteger(BigInt(fullPeriodDays));
    return [
      {
        ...line,
        precise: precise.toString(),
        rounded: Number(precise.round()),
        metadataJson: stableJson({ ...metadata, billableDays: upgradeDays, upgrade: true }),
      },
    ];
  });
}

type PreviousAdvanceFixedChargeLine = {
  next_fixed_charge_id: string;
  precise_amount_minor: string | number;
  metadata_json: string;
};

async function applyPreviousAdvanceFixedChargeOffsets(
  database: D1Database,
  previousSubscriptionId: string,
  timezone: string,
  changedAt: string,
  lines: SubscriptionInvoiceLine[],
): Promise<SubscriptionInvoiceLine[]> {
  const candidates = lines.filter((line) => {
    if (line.lineType !== "fixed_charge") return false;
    const metadata = parseLineMetadata(line.metadataJson);
    return metadata.billingMode === "in_advance" && metadata.prorated === true;
  });
  if (candidates.length === 0) return lines;
  const ids = candidates.map((line) => line.sourceId);
  const prior = await database
    .prepare(
      `SELECT next.id AS next_fixed_charge_id,
              COALESCE(line.precise_amount_minor, line.amount_minor) AS precise_amount_minor,
              line.metadata_json
       FROM fixed_charges next
       JOIN fixed_charges previous ON previous.add_on_id = next.add_on_id
       JOIN invoice_lines line ON line.source_id = previous.id AND line.line_type = 'fixed_charge'
       JOIN invoices invoice ON invoice.id = line.invoice_id
       JOIN invoice_subscriptions owner ON owner.invoice_id = invoice.id
       WHERE next.id IN (SELECT value FROM json_each(?)) AND owner.subscription_id = ?
         AND invoice.status <> 'voided'
         AND json_extract(line.metadata_json, '$.billingMode') = 'in_advance'
         AND json_extract(line.metadata_json, '$.periodEnd') > ?
       ORDER BY line.created_at, line.id LIMIT ?`,
    )
    .bind(
      stableJson(ids),
      previousSubscriptionId,
      changedAt,
      MAX_PREVIOUS_ADVANCE_FIXED_CHARGE_LINES + 1,
    )
    .all<PreviousAdvanceFixedChargeLine>();
  if (prior.results.length > MAX_PREVIOUS_ADVANCE_FIXED_CHARGE_LINES) {
    throw new Error("previous_advance_fixed_charge_line_limit_exceeded");
  }
  const priorByNext = new Map<string, PreviousAdvanceFixedChargeLine[]>();
  for (const row of prior.results) {
    const values = priorByNext.get(row.next_fixed_charge_id) ?? [];
    values.push(row);
    priorByNext.set(row.next_fixed_charge_id, values);
  }
  return lines.map((line) => {
    const previousLines = priorByNext.get(line.sourceId);
    if (!previousLines?.length) return line;
    const metadata = parseLineMetadata(line.metadataJson);
    const currentStart = stringMetadata(metadata.periodStart) ?? changedAt;
    const currentEnd = stringMetadata(metadata.periodEnd);
    if (!currentEnd) return line;
    let offset = Decimal.zero();
    for (const previous of previousLines) {
      const previousMetadata = parseLineMetadata(previous.metadata_json);
      const paidStart =
        stringMetadata(previousMetadata.effectiveAt) ??
        stringMetadata(previousMetadata.periodStart);
      const paidEnd = stringMetadata(previousMetadata.periodEnd);
      if (!paidStart || !paidEnd) continue;
      const paidDays = localDaySpan(paidStart, paidEnd, timezone);
      const overlapStart = new Date(
        Math.max(Date.parse(changedAt), Date.parse(currentStart), Date.parse(paidStart)),
      ).toISOString();
      const overlapEnd = new Date(
        Math.min(Date.parse(currentEnd), Date.parse(paidEnd)),
      ).toISOString();
      const overlapDays = localDaySpan(overlapStart, overlapEnd, timezone);
      if (paidDays <= 0 || overlapDays <= 0) continue;
      offset = offset.add(
        Decimal.parse(previous.precise_amount_minor)
          .multiply(Decimal.parse(overlapDays))
          .divideByInteger(BigInt(paidDays)),
      );
    }
    if (offset.isZero()) return line;
    const adjusted = Decimal.parse(line.precise).subtract(offset);
    const clamped = adjusted.isNegative() ? Decimal.zero() : adjusted;
    const rounded = Number(clamped.round());
    if (!Number.isSafeInteger(rounded) || rounded < 0) {
      throw new Error("invoice_amount_out_of_range");
    }
    return {
      ...line,
      precise: clamped.toString(),
      rounded,
      metadataJson: stableJson({
        ...metadata,
        previousPrepaidOffsetMinor: offset.toString(),
        upgrade: true,
      }),
    };
  });
}

const MAX_PREVIOUS_ADVANCE_FIXED_CHARGE_LINES = 1_000;

function parseLineMetadata(value: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function stringMetadata(value: unknown): string | null {
  return typeof value === "string" && Number.isFinite(Date.parse(value)) ? value : null;
}

function localDaySpan(start: string, end: string, timezone: string): number {
  const startDate = localDate(new Date(start), timezone);
  const endDate = localDate(new Date(end), timezone);
  return Math.max(
    0,
    Math.floor(Date.UTC(endDate.year, endDate.month - 1, endDate.day) / 86_400_000) -
      Math.floor(Date.UTC(startDate.year, startDate.month - 1, startDate.day) / 86_400_000),
  );
}

function utcDayOrdinal(value: string): number {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) throw new Error("invalid_upgrade_trial_boundary");
  const date = new Date(timestamp);
  return Math.floor(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()) / 86_400_000,
  );
}

async function findCurrentGeneration(
  database: D1Database,
  organizationId: string,
  externalId: string,
): Promise<CurrentGeneration | null> {
  return database
    .prepare(
      `SELECT s.id, s.organization_id, s.customer_id, s.plan_id, s.external_id, s.status,
              s.subscription_at, s.started_at, s.current_period_start, s.current_period_end,
              s.ending_at, s.billing_time, s.billing_timezone, s.generation, s.version,
              s.payment_method_type, s.payment_method_id, s.skip_invoice_custom_sections,
              s.trial_started_at, s.trial_end_at, s.trial_ended_at,
              p.amount_minor AS plan_amount_minor, p.currency AS plan_currency,
              p.interval AS plan_interval, p.pay_in_advance AS plan_pay_in_advance,
              COALESCE(c.invoice_grace_period, o.invoice_grace_period) AS invoice_grace_period,
              COALESCE(c.net_payment_term, o.net_payment_term) AS net_payment_term
       FROM subscriptions s JOIN plans p ON p.id = s.plan_id
       JOIN customers c ON c.id = s.customer_id
       JOIN organizations o ON o.id = s.organization_id
       WHERE s.organization_id = ? AND s.external_id = ?
         AND (s.status IN ('active', 'past_due') OR
              (s.status = 'pending' AND s.previous_subscription_id IS NULL))
       ORDER BY CASE WHEN s.status IN ('active', 'past_due') THEN 0 ELSE 1 END,
                s.generation DESC LIMIT 1`,
    )
    .bind(organizationId, externalId)
    .first<CurrentGeneration>();
}

async function findTargetPlan(
  database: D1Database,
  organizationId: string,
  planCode: string,
): Promise<TargetPlan | null> {
  return database
    .prepare(
      `SELECT id, code, name, interval, amount_minor, currency, pay_in_advance, trial_period
       FROM plans
       WHERE organization_id = ? AND code = ? AND active = 1 AND pending_deletion = 0
         AND parent_id IS NULL
       ORDER BY version DESC LIMIT 1`,
    )
    .bind(organizationId, planCode)
    .first<TargetPlan>();
}

async function initialStartedAtFor(
  database: D1Database,
  current: CurrentGeneration,
): Promise<string> {
  const row = await database
    .prepare(
      `SELECT COALESCE(MIN(started_at), MIN(subscription_at)) AS initial_started_at
       FROM subscriptions WHERE organization_id = ? AND external_id = ?`,
    )
    .bind(current.organization_id, current.external_id)
    .first<{ initial_started_at: string | null }>();
  return row?.initial_started_at ?? current.subscription_at;
}

async function nextGenerationNumber(
  database: D1Database,
  current: CurrentGeneration,
): Promise<number> {
  const row = await database
    .prepare(
      `SELECT COALESCE(MAX(generation), 0) + 1 AS next_generation
       FROM subscriptions WHERE organization_id = ? AND external_id = ?`,
    )
    .bind(current.organization_id, current.external_id)
    .first<{ next_generation: number }>();
  const generation = row?.next_generation ?? current.generation + 1;
  if (!Number.isSafeInteger(generation) || generation <= current.generation) {
    throw new Error("subscription_generation_corrupt");
  }
  return generation;
}

function compareAnnualized(target: TargetPlan, current: CurrentGeneration): number {
  const next = BigInt(target.amount_minor) * intervalMultiplier(target.interval);
  const previous = BigInt(current.plan_amount_minor) * intervalMultiplier(current.plan_interval);
  return next === previous ? 0 : next > previous ? 1 : -1;
}

function intervalMultiplier(interval: string): bigint {
  if (interval === "weekly") return 52n;
  if (interval === "monthly") return 12n;
  if (interval === "quarterly") return 4n;
  if (interval === "yearly") return 1n;
  throw new Error("unsupported_subscription_plan_interval");
}

function trialEnd(plan: TargetPlan, initialStartedAt: string, timezone: string): string | null {
  return plan.trial_period && plan.trial_period > 0
    ? addTrialDays(new Date(initialStartedAt), plan.trial_period, timezone).toISOString()
    : null;
}

function shiftCalendarDate(value: string, days: number): string {
  const date = new Date(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(date.getTime())) throw new Error("invalid_plan_change_date");
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function subscriptionEvent(
  type: string,
  aggregateId: string,
  aggregateVersion: number,
  occurredAt: string,
  correlationId: string,
  payload: Record<string, unknown>,
  aggregateType = "subscription",
): DomainEvent {
  return {
    id: `${type.replaceAll(".", "-")}:${aggregateId}:v${aggregateVersion}`,
    type,
    version: 1,
    aggregateType,
    aggregateId,
    aggregateVersion,
    occurredAt,
    causationId: correlationId,
    correlationId,
    payload,
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

function guardedOutboxStatement(
  database: D1Database,
  organizationId: string,
  event: DomainEvent,
  subscriptionId: string,
  subscriptionVersion: number,
  subscriptionStatus: string,
  updatedAt: string,
): D1PreparedStatement {
  return database
    .prepare(
      `INSERT INTO outbox_events
       (event_id, organization_id, event_type, event_version, aggregate_type,
        aggregate_id, aggregate_version, causation_id, correlation_id, payload_json,
        occurred_at, published_at)
       SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL
       FROM subscriptions
       WHERE id = ? AND organization_id = ? AND version = ? AND status = ? AND updated_at = ?`,
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
      subscriptionId,
      organizationId,
      subscriptionVersion,
      subscriptionStatus,
      updatedAt,
    );
}
