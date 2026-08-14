import type { AuthContext } from "../auth/api-key";
import { sha256Hex } from "../auth/api-key";
import type { DomainEvent } from "../domain-events";
import {
  terminateSubscriptionWithInvoice,
  terminateSubscriptionWithoutInvoice,
  type TerminationActions,
} from "../billing/terminate-subscription";
import { terminatePayInAdvanceWithCredit } from "../billing/pay-in-advance-termination-credit";
import type { BillingTime } from "../billing/periods";
import { ApiError, json, objectAt, optionalString, parseJsonObject } from "../http";
import { stableJson } from "../json";
import { normalizeSubscriptionPaymentMethod } from "./subscription-payment-method";
import {
  guardedCustomSectionLinkStatements,
  normalizeSubscriptionCustomSections,
  resolveCustomSectionIds,
  serializeAppliedCustomSections,
  serializeAppliedCustomSectionsForSubscriptions,
  type SerializedAppliedCustomSection,
} from "../subscriptions/custom-sections";
import {
  assertEndingAtAfterStart,
  assertFutureEndingAt,
  assertFutureSubscriptionAt,
  normalizeEndingAt,
  normalizeSubscriptionAt,
} from "../subscriptions/time";

type SubscriptionRow = {
  id: string;
  external_id: string;
  customer_id: string;
  customer_external_id: string;
  plan_code: string;
  plan_amount_minor: number;
  plan_currency: string;
  plan_pay_in_advance: number;
  plan_interval: string;
  name: string | null;
  status: string;
  subscription_at: string | null;
  started_at: string | null;
  current_period_start: string | null;
  current_period_end: string | null;
  ending_at: string | null;
  on_termination_credit_note: string | null;
  on_termination_invoice: string | null;
  canceled_at: string | null;
  terminated_at: string | null;
  created_at: string;
  updated_at: string;
  version: number;
  invoice_grace_period: number;
  billing_time: BillingTime;
  billing_timezone: string;
  trial_started_at: string | null;
  trial_end_at: string | null;
  trial_ended_at: string | null;
  previous_plan_code: string | null;
  next_plan_code: string | null;
  downgrade_plan_date: string | null;
  payment_method_type: "manual" | "provider" | null;
  payment_method_id: string | null;
  skip_invoice_custom_sections: number;
};

export async function handleSubscriptionLifecycleRequest(
  request: Request,
  env: Env,
  auth: AuthContext,
  requestId: string,
): Promise<Response | null> {
  const url = new URL(request.url);
  if (request.method === "GET" && url.pathname === "/api/v1/subscriptions") {
    return listSubscriptions(url, env.BILLING_DB, auth, requestId);
  }
  const match = url.pathname.match(/^\/api\/v1\/subscriptions\/([^/]+)$/);
  if (!match?.[1]) return null;
  const externalId = decodeURIComponent(match[1]);
  if (request.method === "GET") {
    return showSubscription(externalId, url, env.BILLING_DB, auth, requestId);
  }
  if (request.method === "PUT") {
    return updateSubscription(externalId, request, env, auth, requestId);
  }
  if (request.method === "DELETE") {
    return terminateSubscription(externalId, url, env, auth, requestId);
  }
  return null;
}

async function updateSubscription(
  externalId: string,
  request: Request,
  env: Env,
  auth: AuthContext,
  requestId: string,
): Promise<Response> {
  const subscription = await findAnySubscription(env.BILLING_DB, auth.organizationId, externalId);
  if (!subscription)
    throw new ApiError(404, "subscription_not_found", "Subscription was not found");
  if (!["active", "past_due", "pending"].includes(subscription.status))
    throw new ApiError(422, "subscription_not_updatable", "Subscription is not updatable");
  const input = objectAt(await parseJsonObject(request), "subscription");
  const allowed =
    subscription.status === "pending"
      ? [
          "name",
          "subscription_at",
          "ending_at",
          "on_termination_credit_note",
          "on_termination_invoice",
          "payment_method",
          "invoice_custom_section",
        ]
      : [
          "name",
          "ending_at",
          "on_termination_credit_note",
          "on_termination_invoice",
          "payment_method",
          "invoice_custom_section",
        ];
  const unsupported = Object.keys(input).find((key) => !allowed.includes(key));
  if (unsupported)
    throw new ApiError(
      422,
      "unsupported_subscription_feature",
      `${unsupported} update is not implemented by the Cloudflare subscription lifecycle`,
    );
  const name = input.name === undefined ? subscription.name : optionalString(input, "name");
  const paymentMethod = normalizeSubscriptionPaymentMethod(input.payment_method);
  const paymentMethodType =
    paymentMethod === undefined
      ? subscription.payment_method_type
      : paymentMethod.paymentMethodType;
  const paymentMethodId =
    paymentMethod === undefined ? subscription.payment_method_id : paymentMethod.paymentMethodId;
  const customSections = normalizeSubscriptionCustomSections(input.invoice_custom_section);
  const resolvedCustomSectionIds = await resolveCustomSectionIds(
    env.BILLING_DB,
    auth.organizationId,
    customSections?.codes,
  );
  const customSectionUpdate = subscriptionCustomSectionUpdate(
    subscription,
    customSections?.skip,
    resolvedCustomSectionIds,
  );
  const nowDate = new Date();
  const now = nowDate.toISOString();
  let subscriptionAt = subscription.subscription_at;
  if (input.subscription_at !== undefined) {
    subscriptionAt = normalizeSubscriptionAt(input.subscription_at);
    if (!subscriptionAt) {
      throw new ApiError(422, "validation_error", "subscription_at is required when rescheduling");
    }
    assertFutureSubscriptionAt(subscriptionAt, nowDate);
    if (subscription.ending_at) {
      assertEndingAtAfterStart(subscription.ending_at, subscriptionAt);
    }
  }
  const onTerminationCreditNote = terminationCreditAction(
    input.on_termination_credit_note,
    subscription,
  );
  const onTerminationInvoice = terminationInvoiceAction(
    input.on_termination_invoice,
    subscription.on_termination_invoice,
  );
  let endingAt = subscription.ending_at;
  if (input.ending_at !== undefined) {
    endingAt = normalizeEndingAt(input.ending_at);
    if (endingAt) {
      assertFutureEndingAt(endingAt, nowDate);
      const startsAt = subscriptionAt ?? subscription.started_at;
      if (!startsAt) throw new ApiError(422, "validation_error", "Subscription start is missing");
      assertEndingAtAfterStart(endingAt, startsAt);
    }
  }
  if (endingAt) assertSupportedScheduledTermination(subscription, onTerminationCreditNote);
  const event: DomainEvent = {
    id: `subscription-updated:${subscription.id}:v${subscription.version + 1}`,
    type: "subscription.updated",
    version: 1,
    aggregateType: "subscription",
    aggregateId: subscription.id,
    aggregateVersion: subscription.version + 1,
    occurredAt: now,
    causationId: requestId,
    correlationId: requestId,
    payload: {
      organizationId: auth.organizationId,
      subscriptionId: subscription.id,
      externalSubscriptionId: externalId,
      name,
      subscriptionAt,
      endingAt,
      onTerminationCreditNote,
      onTerminationInvoice,
      paymentMethodId,
      paymentMethodType,
      skipInvoiceCustomSections: customSectionUpdate.skip === 1,
    },
  };
  const sectionStatements = guardedCustomSectionLinkStatements(
    env.BILLING_DB,
    auth.organizationId,
    subscription.id,
    customSectionUpdate.sectionIds,
    now,
    subscription.version + 1,
    subscription.status,
  );
  const results = await env.BILLING_DB.batch([
    env.BILLING_DB.prepare(
      `UPDATE subscriptions
       SET name = ?, subscription_at = ?, ending_at = ?, on_termination_credit_note = ?,
           on_termination_invoice = ?, payment_method_type = ?, payment_method_id = ?,
           skip_invoice_custom_sections = ?,
           version = version + 1, updated_at = ?
       WHERE id = ? AND organization_id = ? AND version = ?
         AND status = ?`,
    ).bind(
      name,
      subscriptionAt,
      endingAt,
      onTerminationCreditNote,
      onTerminationInvoice,
      paymentMethodType,
      paymentMethodId,
      customSectionUpdate.skip,
      now,
      subscription.id,
      auth.organizationId,
      subscription.version,
      subscription.status,
    ),
    ...sectionStatements,
    env.BILLING_DB.prepare(
      `INSERT INTO outbox_events
       (event_id, organization_id, event_type, event_version, aggregate_type,
        aggregate_id, aggregate_version, causation_id, correlation_id, payload_json,
        occurred_at, published_at)
       SELECT ?, ?, ?, 1, 'subscription', ?, ?, ?, ?, ?, ?, NULL
       FROM subscriptions WHERE id = ? AND organization_id = ? AND version = ? AND updated_at = ?`,
    ).bind(
      event.id,
      auth.organizationId,
      event.type,
      subscription.id,
      event.aggregateVersion,
      requestId,
      requestId,
      stableJson(event.payload),
      now,
      subscription.id,
      auth.organizationId,
      subscription.version + 1,
      now,
    ),
  ]);
  if (
    (results[0]?.meta.changes ?? 0) < 1 ||
    results[1 + sectionStatements.length]?.meta.changes !== 1
  )
    throw new ApiError(409, "subscription_version_conflict", "Subscription changed concurrently");
  await env.DOMAIN_EVENTS.send(event);
  const updated = await findAnySubscription(env.BILLING_DB, auth.organizationId, externalId);
  if (!updated) throw new ApiError(500, "persistence_error", "Subscription disappeared");
  return json(
    { subscription: await serializeSubscription(env.BILLING_DB, updated) },
    { requestId },
  );
}

function subscriptionCustomSectionUpdate(
  subscription: SubscriptionRow,
  skip: boolean | undefined,
  sectionIds: string[] | undefined,
): { skip: number; sectionIds: string[] | undefined } {
  if (skip === true) return { skip: 1, sectionIds: [] };
  if (skip === false) return { skip: 0, sectionIds };
  if (subscription.skip_invoice_custom_sections === 1) {
    return { skip: 1, sectionIds: undefined };
  }
  return { skip: 0, sectionIds };
}

async function listSubscriptions(
  url: URL,
  database: D1Database,
  auth: AuthContext,
  requestId: string,
): Promise<Response> {
  const externalCustomerId = url.searchParams.get("external_customer_id")?.trim() || null;
  const page = positiveInteger(url.searchParams.get("page"), 1);
  const perPage = Math.min(positiveInteger(url.searchParams.get("per_page"), 20), 100);
  const offset = (page - 1) * perPage;
  const where = externalCustomerId
    ? "s.organization_id = ? AND c.external_id = ?"
    : "s.organization_id = ?";
  const bindings = externalCustomerId
    ? [auth.organizationId, externalCustomerId]
    : [auth.organizationId];
  const count = await database
    .prepare(
      `SELECT COUNT(*) AS total FROM subscriptions s JOIN customers c ON c.id = s.customer_id WHERE ${where}`,
    )
    .bind(...bindings)
    .first<{ total: number }>();
  const result = await database
    .prepare(`${subscriptionSelect()} WHERE ${where}
              ORDER BY s.created_at DESC, s.id DESC LIMIT ? OFFSET ?`)
    .bind(...bindings, perPage, offset)
    .all<SubscriptionRow>();
  const sectionsBySubscription = await serializeAppliedCustomSectionsForSubscriptions(
    database,
    result.results.map((subscription) => subscription.id),
  );
  return json(
    {
      subscriptions: await Promise.all(
        result.results.map((subscription) =>
          serializeSubscription(
            database,
            subscription,
            sectionsBySubscription.get(subscription.id) ?? [],
          ),
        ),
      ),
      meta: pagination(count?.total ?? 0, page, perPage),
    },
    { requestId },
  );
}

async function showSubscription(
  externalId: string,
  url: URL,
  database: D1Database,
  auth: AuthContext,
  requestId: string,
): Promise<Response> {
  const status = url.searchParams.get("status")?.trim() || "active";
  const subscription = await findSubscription(database, auth.organizationId, externalId, status);
  if (!subscription)
    throw new ApiError(404, "subscription_not_found", "Subscription was not found");
  return json({ subscription: await serializeSubscription(database, subscription) }, { requestId });
}

async function terminateSubscription(
  externalId: string,
  url: URL,
  env: Env,
  auth: AuthContext,
  requestId: string,
): Promise<Response> {
  let subscription = await findAnySubscription(env.BILLING_DB, auth.organizationId, externalId);
  if (!subscription)
    throw new ApiError(404, "subscription_not_found", "Subscription was not found");
  if (subscription.status === "terminated" || subscription.status === "canceled") {
    return json(
      { subscription: await serializeSubscription(env.BILLING_DB, subscription) },
      { requestId },
    );
  }
  if (subscription.status === "pending") {
    return cancelPendingSubscription(subscription, env, auth, requestId);
  }
  const onTerminationInvoice =
    url.searchParams.get("on_termination_invoice")?.trim() ||
    subscription.on_termination_invoice ||
    "generate";
  const onTerminationCreditNote =
    url.searchParams.get("on_termination_credit_note")?.trim() ||
    subscription.on_termination_credit_note ||
    "credit";
  if (onTerminationInvoice !== "generate" && onTerminationInvoice !== "skip") {
    throw new ApiError(422, "validation_error", "on_termination_invoice must be generate or skip");
  }
  if (!new Set(["credit", "skip", "refund", "offset"]).has(onTerminationCreditNote)) {
    throw new ApiError(
      422,
      "validation_error",
      "on_termination_credit_note must be credit, skip, refund, or offset",
    );
  }
  if (
    subscription.plan_pay_in_advance === 1 &&
    onTerminationCreditNote !== "credit" &&
    onTerminationCreditNote !== "skip"
  ) {
    throw new ApiError(
      422,
      "unsupported_termination_credit_note",
      "Pay-in-advance termination currently supports only credit or skip",
    );
  }
  const actions: TerminationActions = {
    creditNote:
      subscription.plan_pay_in_advance === 1
        ? (onTerminationCreditNote as "credit" | "skip")
        : null,
    invoice: onTerminationInvoice as "generate" | "skip",
  };
  if (subscription.status !== "active" && subscription.status !== "past_due") {
    throw new ApiError(422, "subscription_not_terminable", "Subscription is not active");
  }
  if (
    subscription.plan_pay_in_advance === 1 &&
    (await hasMinimumCommitment(env.BILLING_DB, auth.organizationId, subscription.id))
  ) {
    throw new ApiError(
      422,
      "unsupported_termination_minimum_commitment",
      "Pay-in-advance minimum-commitment termination is not implemented",
    );
  }

  const requestHash = await sha256Hex(
    stableJson({ externalId, onTerminationCreditNote, onTerminationInvoice }),
  );
  const reservationKey = `subscription-terminate:${subscription.id}:v${subscription.version}`;
  const account = env.BILLING_ACCOUNTS.getByName(`customer:${subscription.customer_id}`);
  const reservation = await account.reserveCommand({
    idempotencyKey: reservationKey,
    commandType: "subscription.terminate",
    requestHash,
  });
  if (!reservation.ok) {
    throw new ApiError(
      409,
      reservation.error,
      "Subscription termination conflicts with another command",
    );
  }
  if (reservation.replayed && reservation.reservation.status !== "completed") {
    throw new ApiError(409, "termination_in_progress", "Subscription termination is in progress");
  }
  if (reservation.replayed) {
    subscription = await findAnySubscription(env.BILLING_DB, auth.organizationId, externalId);
    if (!subscription) throw new ApiError(500, "persistence_error", "Subscription disappeared");
    return json(
      { subscription: await serializeSubscription(env.BILLING_DB, subscription) },
      { requestId },
    );
  }

  const terminatedAt = new Date().toISOString();
  try {
    if (
      subscription.plan_pay_in_advance === 1 &&
      onTerminationInvoice === "skip" &&
      onTerminationCreditNote === "credit"
    ) {
      const result = await terminatePayInAdvanceWithCredit(
        env,
        subscription.id,
        subscription.version,
        terminatedAt,
        requestId,
        actions,
      );
      await account.completeCommand(reservationKey, {
        terminatedAt,
        eventId: result.subscriptionEvent.id,
        creditNoteId: result.creditNoteId,
      });
      subscription = await findAnySubscription(env.BILLING_DB, auth.organizationId, externalId);
      if (!subscription) throw new ApiError(500, "persistence_error", "Subscription disappeared");
      return json(
        { subscription: await serializeSubscription(env.BILLING_DB, subscription) },
        { requestId },
      );
    }
    if (onTerminationInvoice === "generate") {
      const result = await terminateSubscriptionWithInvoice(
        env,
        subscription.id,
        subscription.version,
        terminatedAt,
        requestId,
        true,
        subscription.plan_pay_in_advance === 1 && onTerminationCreditNote === "credit",
        actions,
      );
      await account.completeCommand(reservationKey, {
        terminatedAt,
        eventId: result.subscriptionEvent.id,
        invoiceId: result.invoiceId,
        creditNoteId: result.creditNoteId,
      });
      subscription = await findAnySubscription(env.BILLING_DB, auth.organizationId, externalId);
      if (!subscription) throw new ApiError(500, "persistence_error", "Subscription disappeared");
      return json(
        { subscription: await serializeSubscription(env.BILLING_DB, subscription) },
        { requestId },
      );
    }
    const event = await terminateSubscriptionWithoutInvoice(
      env,
      subscription.id,
      subscription.version,
      terminatedAt,
      requestId,
      true,
      actions,
    );
    await account.completeCommand(reservationKey, { terminatedAt, eventId: event.id });
  } catch (error) {
    await account.releaseCommand(reservationKey, requestHash);
    if (error instanceof Error) {
      if (error.message === "subscription_version_conflict") {
        throw new ApiError(409, error.message, "Subscription changed concurrently");
      }
      const unsupported: Record<string, string> = {
        unsupported_draft_termination_credit_adjustment:
          "Draft termination credits require an undiscounted, untaxed source invoice without wallet or credit-note allocations",
        unsupported_termination_minimum_commitment:
          "Termination invoicing for plans with a minimum commitment is not implemented",
        unsupported_pay_in_advance_termination_credit:
          "Pay-in-advance termination credits require a finalized, undiscounted, untaxed base invoice without wallet or credit-note allocations",
      };
      const message = unsupported[error.message];
      if (message) throw new ApiError(422, error.message, message);
    }
    throw error;
  }
  subscription = await findAnySubscription(env.BILLING_DB, auth.organizationId, externalId);
  if (!subscription) throw new ApiError(500, "persistence_error", "Subscription disappeared");
  return json(
    { subscription: await serializeSubscription(env.BILLING_DB, subscription) },
    { requestId },
  );
}

async function cancelPendingSubscription(
  subscription: SubscriptionRow,
  env: Env,
  auth: AuthContext,
  requestId: string,
): Promise<Response> {
  const canceledAt = new Date().toISOString();
  const event: DomainEvent = {
    id: `subscription-terminated:${subscription.id}:v${subscription.version + 1}`,
    type: "subscription.terminated",
    version: 1,
    aggregateType: "subscription",
    aggregateId: subscription.id,
    aggregateVersion: subscription.version + 1,
    occurredAt: canceledAt,
    causationId: requestId,
    correlationId: requestId,
    payload: {
      organizationId: auth.organizationId,
      subscriptionId: subscription.id,
      externalSubscriptionId: subscription.external_id,
      canceledAt,
      terminatedAt: null,
      finalInvoiceGenerated: false,
      creditNoteGenerated: false,
    },
  };
  const results = await env.BILLING_DB.batch([
    env.BILLING_DB.prepare(
      `UPDATE subscriptions
       SET status = 'canceled', canceled_at = ?, version = version + 1, updated_at = ?
       WHERE id = ? AND organization_id = ? AND version = ? AND status = 'pending'`,
    ).bind(canceledAt, canceledAt, subscription.id, auth.organizationId, subscription.version),
    env.BILLING_DB.prepare(
      `INSERT INTO outbox_events
       (event_id, organization_id, event_type, event_version, aggregate_type,
        aggregate_id, aggregate_version, causation_id, correlation_id, payload_json,
        occurred_at, published_at)
       SELECT ?, ?, ?, 1, 'subscription', ?, ?, ?, ?, ?, ?, NULL
       FROM subscriptions
       WHERE id = ? AND organization_id = ? AND version = ?
         AND status = 'canceled' AND canceled_at = ?
       ON CONFLICT(event_id) DO NOTHING`,
    ).bind(
      event.id,
      auth.organizationId,
      event.type,
      subscription.id,
      event.aggregateVersion,
      requestId,
      requestId,
      stableJson(event.payload),
      canceledAt,
      subscription.id,
      auth.organizationId,
      subscription.version + 1,
      canceledAt,
    ),
  ]);
  if ((results[0]?.meta.changes ?? 0) < 1 || results[1]?.meta.changes !== 1) {
    const current = await findAnySubscription(
      env.BILLING_DB,
      auth.organizationId,
      subscription.external_id,
    );
    if (current?.status === "canceled") {
      return json(
        { subscription: await serializeSubscription(env.BILLING_DB, current) },
        { requestId },
      );
    }
    throw new ApiError(409, "subscription_version_conflict", "Subscription changed concurrently");
  }
  await env.DOMAIN_EVENTS.send(event);
  const canceled = await findAnySubscription(
    env.BILLING_DB,
    auth.organizationId,
    subscription.external_id,
  );
  if (!canceled) throw new ApiError(500, "persistence_error", "Subscription disappeared");
  return json(
    { subscription: await serializeSubscription(env.BILLING_DB, canceled) },
    { requestId },
  );
}

async function hasMinimumCommitment(
  database: D1Database,
  organizationId: string,
  subscriptionId: string,
): Promise<boolean> {
  const row = await database
    .prepare(
      `SELECT 1 AS present
       FROM subscriptions s JOIN minimum_commitments mc ON mc.plan_id = s.plan_id
       WHERE s.id = ? AND s.organization_id = ? LIMIT 1`,
    )
    .bind(subscriptionId, organizationId)
    .first<{ present: number }>();
  return row?.present === 1;
}

function subscriptionSelect(): string {
  return `SELECT s.id, s.external_id, s.customer_id, c.external_id AS customer_external_id,
                 p.code AS plan_code, p.amount_minor AS plan_amount_minor, p.interval AS plan_interval,
                 p.currency AS plan_currency, p.pay_in_advance AS plan_pay_in_advance,
                 COALESCE(c.invoice_grace_period, o.invoice_grace_period) AS invoice_grace_period,
                 s.name, s.status, s.subscription_at, s.started_at,
                 s.current_period_start, s.current_period_end, s.canceled_at,
                 s.ending_at, s.on_termination_credit_note, s.on_termination_invoice,
                 s.terminated_at, s.created_at, s.updated_at, s.version,
                 s.billing_time, s.billing_timezone, s.trial_started_at, s.trial_end_at,
                 s.trial_ended_at, s.payment_method_type, s.payment_method_id,
                 s.skip_invoice_custom_sections,
                 (SELECT pp.code FROM subscriptions ps JOIN plans pp ON pp.id = ps.plan_id
                  WHERE ps.id = s.previous_subscription_id LIMIT 1) AS previous_plan_code,
                 (SELECT np.code FROM subscriptions ns JOIN plans np ON np.id = ns.plan_id
                  WHERE ns.previous_subscription_id = s.id AND ns.status = 'pending'
                  ORDER BY ns.generation DESC LIMIT 1) AS next_plan_code,
                 (SELECT ns.transition_at FROM subscriptions ns
                  WHERE ns.previous_subscription_id = s.id AND ns.status = 'pending'
                  ORDER BY ns.generation DESC LIMIT 1) AS downgrade_plan_date
          FROM subscriptions s
          JOIN customers c ON c.id = s.customer_id
          JOIN plans p ON p.id = s.plan_id
          JOIN organizations o ON o.id = s.organization_id`;
}

async function findSubscription(
  database: D1Database,
  organizationId: string,
  externalId: string,
  status: string,
): Promise<SubscriptionRow | null> {
  return database
    .prepare(`${subscriptionSelect()} WHERE s.organization_id = ? AND s.external_id = ? AND s.status = ?
              ORDER BY s.created_at DESC LIMIT 1`)
    .bind(organizationId, externalId, status)
    .first<SubscriptionRow>();
}

async function findAnySubscription(
  database: D1Database,
  organizationId: string,
  externalId: string,
): Promise<SubscriptionRow | null> {
  return database
    .prepare(`${subscriptionSelect()} WHERE s.organization_id = ? AND s.external_id = ?
              ORDER BY CASE
                WHEN s.status IN ('active', 'past_due') THEN 0
                WHEN s.status = 'pending' AND s.previous_subscription_id IS NULL THEN 1
                WHEN s.status = 'pending' THEN 2
                ELSE 3
              END, s.created_at DESC LIMIT 1`)
    .bind(organizationId, externalId)
    .first<SubscriptionRow>();
}

async function serializeSubscription(
  database: D1Database,
  subscription: SubscriptionRow,
  appliedSections?: SerializedAppliedCustomSection[],
): Promise<Record<string, unknown>> {
  return {
    lago_id: subscription.id,
    external_id: subscription.external_id,
    lago_customer_id: subscription.customer_id,
    external_customer_id: subscription.customer_external_id,
    name: subscription.name,
    plan_code: subscription.plan_code,
    plan_amount_cents: subscription.plan_amount_minor,
    plan_amount_currency: subscription.plan_currency,
    status: subscription.status,
    billing_time: subscription.billing_time,
    billing_timezone: subscription.billing_timezone,
    subscription_at: subscription.subscription_at,
    started_at: subscription.started_at,
    terminated_at: subscription.terminated_at,
    canceled_at: subscription.canceled_at,
    ending_at: subscription.ending_at,
    on_termination_credit_note: subscription.on_termination_credit_note,
    on_termination_invoice: subscription.on_termination_invoice,
    created_at: subscription.created_at,
    current_billing_period_started_at: subscription.current_period_start,
    current_billing_period_ending_at: subscription.current_period_end,
    trial_started_at: subscription.trial_started_at,
    trial_ended_at: subscription.trial_ended_at,
    previous_plan_code: subscription.previous_plan_code,
    next_plan_code: subscription.next_plan_code,
    downgrade_plan_date: subscription.downgrade_plan_date?.slice(0, 10) ?? null,
    payment_method: {
      payment_method_id: subscription.payment_method_id,
      payment_method_type: subscription.payment_method_type,
    },
    skip_invoice_custom_sections: subscription.skip_invoice_custom_sections === 1,
    applied_invoice_custom_sections:
      appliedSections ?? (await serializeAppliedCustomSections(database, subscription.id)),
  };
}

function assertSupportedScheduledTermination(
  subscription: SubscriptionRow,
  creditAction: string | null,
): void {
  if (
    subscription.plan_interval === "one_time" ||
    (subscription.plan_pay_in_advance === 1 && creditAction !== "skip")
  ) {
    throw new ApiError(
      422,
      "unsupported_scheduled_termination",
      "Pay-in-advance ending_at requires on_termination_credit_note=skip; one-time plans remain unsupported",
    );
  }
}

function terminationCreditAction(value: unknown, subscription: SubscriptionRow): string | null {
  if (value === undefined) return subscription.on_termination_credit_note;
  if (value === null || value === "") return null;
  if (typeof value !== "string" || !new Set(["credit", "skip", "refund", "offset"]).has(value)) {
    throw new ApiError(422, "validation_error", "on_termination_credit_note is invalid");
  }
  if (subscription.plan_pay_in_advance !== 1) return null;
  if (value === "refund" || value === "offset") {
    throw new ApiError(
      422,
      "unsupported_termination_credit_note",
      "Pay-in-advance termination currently supports only credit or skip",
    );
  }
  return value;
}

function terminationInvoiceAction(value: unknown, current: string | null): string | null {
  if (value === undefined) return current;
  if (value === null || value === "") return null;
  if (value !== "generate" && value !== "skip") {
    throw new ApiError(422, "validation_error", "on_termination_invoice is invalid");
  }
  return value;
}

function positiveInteger(value: string | null, fallback: number): number {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function pagination(total: number, page: number, perPage: number): Record<string, number | null> {
  const totalPages = total === 0 ? 0 : Math.ceil(total / perPage);
  return {
    current_page: total === 0 ? 0 : page,
    next_page: page < totalPages ? page + 1 : null,
    prev_page: page > 1 && page <= totalPages ? page - 1 : null,
    total_pages: totalPages,
    total_count: total,
  };
}
