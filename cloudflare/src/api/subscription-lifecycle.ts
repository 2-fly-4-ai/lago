import type { AuthContext } from "../auth/api-key";
import { sha256Hex } from "../auth/api-key";
import type { DomainEvent } from "../domain-events";
import { ApiError, json, objectAt, optionalString, parseJsonObject } from "../http";
import { stableJson } from "../json";

type SubscriptionRow = {
  id: string;
  external_id: string;
  customer_id: string;
  customer_external_id: string;
  plan_code: string;
  plan_amount_minor: number;
  plan_currency: string;
  name: string | null;
  status: string;
  started_at: string | null;
  current_period_start: string | null;
  current_period_end: string | null;
  canceled_at: string | null;
  terminated_at: string | null;
  created_at: string;
  updated_at: string;
  version: number;
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
  if (subscription.status !== "active" && subscription.status !== "past_due")
    throw new ApiError(422, "subscription_not_updatable", "Subscription is not active");
  const input = objectAt(await parseJsonObject(request), "subscription");
  const unsupported = Object.keys(input).find((key) => key !== "name");
  if (unsupported)
    throw new ApiError(
      422,
      "unsupported_subscription_feature",
      `${unsupported} update is not implemented by the Cloudflare subscription lifecycle`,
    );
  const name = input.name === undefined ? subscription.name : optionalString(input, "name");
  const now = new Date().toISOString();
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
    },
  };
  const results = await env.BILLING_DB.batch([
    env.BILLING_DB.prepare(
      `UPDATE subscriptions SET name = ?, version = version + 1, updated_at = ?
       WHERE id = ? AND organization_id = ? AND version = ?
         AND status IN ('active', 'past_due')`,
    ).bind(name, now, subscription.id, auth.organizationId, subscription.version),
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
  if (results[0]?.meta.changes !== 1 || results[1]?.meta.changes !== 1)
    throw new ApiError(409, "subscription_version_conflict", "Subscription changed concurrently");
  await env.DOMAIN_EVENTS.send(event);
  const updated = await findAnySubscription(env.BILLING_DB, auth.organizationId, externalId);
  if (!updated) throw new ApiError(500, "persistence_error", "Subscription disappeared");
  return json({ subscription: serializeSubscription(updated) }, { requestId });
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
  return json(
    {
      subscriptions: result.results.map(serializeSubscription),
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
  return json({ subscription: serializeSubscription(subscription) }, { requestId });
}

async function terminateSubscription(
  externalId: string,
  url: URL,
  env: Env,
  auth: AuthContext,
  requestId: string,
): Promise<Response> {
  const onTerminationInvoice = url.searchParams.get("on_termination_invoice")?.trim() || "generate";
  const onTerminationCreditNote =
    url.searchParams.get("on_termination_credit_note")?.trim() || "credit";
  if (onTerminationInvoice !== "skip") {
    throw new ApiError(
      422,
      "unsupported_termination_invoicing",
      "Termination requires on_termination_invoice=skip until final proration is ported",
    );
  }
  if (onTerminationCreditNote !== "skip") {
    throw new ApiError(
      422,
      "unsupported_termination_credit_note",
      "Termination requires on_termination_credit_note=skip until credit notes are ported",
    );
  }
  let subscription = await findAnySubscription(env.BILLING_DB, auth.organizationId, externalId);
  if (!subscription)
    throw new ApiError(404, "subscription_not_found", "Subscription was not found");
  if (subscription.status === "terminated") {
    return json({ subscription: serializeSubscription(subscription) }, { requestId });
  }
  if (subscription.status !== "active" && subscription.status !== "past_due") {
    throw new ApiError(422, "subscription_not_terminable", "Subscription is not active");
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
    return json({ subscription: serializeSubscription(subscription) }, { requestId });
  }

  const terminatedAt = new Date().toISOString();
  const event: DomainEvent = {
    id: `subscription-terminated:${subscription.id}:v${subscription.version + 1}`,
    type: "subscription.terminated",
    version: 1,
    aggregateType: "subscription",
    aggregateId: subscription.id,
    aggregateVersion: subscription.version + 1,
    occurredAt: terminatedAt,
    causationId: requestId,
    correlationId: requestId,
    payload: {
      organizationId: auth.organizationId,
      subscriptionId: subscription.id,
      externalSubscriptionId: subscription.external_id,
      terminatedAt,
      finalInvoiceGenerated: false,
      creditNoteGenerated: false,
    },
  };
  try {
    const results = await env.BILLING_DB.batch([
      env.BILLING_DB.prepare(
        `UPDATE subscriptions
         SET status = 'terminated', terminated_at = ?, current_period_end = ?,
             version = version + 1, updated_at = ?
         WHERE id = ? AND organization_id = ? AND version = ?
           AND status IN ('active', 'past_due')`,
      ).bind(
        terminatedAt,
        terminatedAt,
        terminatedAt,
        subscription.id,
        auth.organizationId,
        subscription.version,
      ),
      env.BILLING_DB.prepare(
        `INSERT INTO outbox_events
         (event_id, organization_id, event_type, event_version, aggregate_type,
          aggregate_id, aggregate_version, causation_id, correlation_id, payload_json,
          occurred_at, published_at)
         SELECT ?, ?, ?, 1, 'subscription', ?, ?, ?, ?, ?, ?, NULL
         FROM subscriptions
         WHERE id = ? AND organization_id = ? AND version = ?
           AND status = 'terminated' AND terminated_at = ?`,
      ).bind(
        event.id,
        auth.organizationId,
        event.type,
        subscription.id,
        event.aggregateVersion,
        requestId,
        requestId,
        stableJson(event.payload),
        terminatedAt,
        subscription.id,
        auth.organizationId,
        subscription.version + 1,
        terminatedAt,
      ),
    ]);
    if (results[0]?.meta.changes !== 1 || results[1]?.meta.changes !== 1) {
      throw new Error("subscription_version_conflict");
    }
    await env.DOMAIN_EVENTS.send(event);
    await account.completeCommand(reservationKey, { terminatedAt, eventId: event.id });
  } catch (error) {
    await account.releaseCommand(reservationKey, requestHash);
    throw error;
  }
  subscription = await findAnySubscription(env.BILLING_DB, auth.organizationId, externalId);
  if (!subscription) throw new ApiError(500, "persistence_error", "Subscription disappeared");
  return json({ subscription: serializeSubscription(subscription) }, { requestId });
}

function subscriptionSelect(): string {
  return `SELECT s.id, s.external_id, s.customer_id, c.external_id AS customer_external_id,
                 p.code AS plan_code, p.amount_minor AS plan_amount_minor,
                 p.currency AS plan_currency, s.name, s.status, s.started_at,
                 s.current_period_start, s.current_period_end, s.canceled_at,
                 s.terminated_at, s.created_at, s.updated_at, s.version
          FROM subscriptions s
          JOIN customers c ON c.id = s.customer_id
          JOIN plans p ON p.id = s.plan_id`;
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
              ORDER BY s.created_at DESC LIMIT 1`)
    .bind(organizationId, externalId)
    .first<SubscriptionRow>();
}

function serializeSubscription(subscription: SubscriptionRow): Record<string, unknown> {
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
    billing_time: "anniversary",
    subscription_at: subscription.started_at,
    started_at: subscription.started_at,
    terminated_at: subscription.terminated_at,
    canceled_at: subscription.canceled_at,
    created_at: subscription.created_at,
    current_billing_period_started_at: subscription.current_period_start,
    current_billing_period_ending_at: subscription.current_period_end,
    payment_method: { payment_method_id: null, payment_method_type: null },
  };
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
