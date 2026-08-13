import type { AuthContext } from "../auth/api-key";
import { sha256Hex } from "../auth/api-key";
import type { DomainEvent } from "../domain-events";
import { ApiError, json, objectAt, optionalString, parseJsonObject, requiredString } from "../http";
import { deterministicUuid } from "../identifiers";
import { stableJson } from "../json";
import { rateCharge } from "../rating/charge-models";
import { Decimal } from "../rating/decimal";
import { aggregateUsage, type SupportedAggregationType } from "../usage/aggregation";
import { parseChargeModel } from "../usage/charge-properties";

type MetricRow = {
  id: string;
  code: string;
  name: string;
  description: string | null;
  aggregation_type: string;
  field_name: string | null;
  recurring: number;
  rounding_function: string | null;
  rounding_precision: number | null;
  weighted_interval: string | null;
  expression: string | null;
  created_at: string;
};

type EventRow = {
  id: string;
  transaction_id: string;
  customer_id: string;
  subscription_id: string;
  external_subscription_id: string;
  code: string;
  timestamp: string;
  timestamp_ms: number;
  precise_total_amount_minor: string | null;
  properties_json: string;
  request_sha256: string;
  created_at: string;
};

type SubscriptionUsageRow = {
  id: string;
  customer_id: string;
  plan_id: string;
  external_id: string;
  current_period_start: string;
  current_period_end: string;
  currency: string;
};

type ChargeUsageRow = {
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

type EventInput = {
  transactionId: string;
  code: string;
  externalSubscriptionId: string;
  timestamp: string;
  timestampMs: number;
  preciseTotalAmountMinor: string | null;
  properties: Record<string, unknown>;
};

const SUPPORTED_AGGREGATIONS = new Set<SupportedAggregationType>([
  "count_agg",
  "sum_agg",
  "max_agg",
  "unique_count_agg",
  "latest_agg",
]);
const SUPPORTED_CHARGE_MODELS = new Set([
  "standard",
  "graduated",
  "package",
  "percentage",
  "volume",
  "graduated_percentage",
]);

export async function handleMeteredUsageRequest(
  request: Request,
  env: Env,
  auth: AuthContext,
  requestId: string,
): Promise<Response | null> {
  const url = new URL(request.url);

  if (request.method === "POST" && url.pathname === "/api/v1/billable_metrics") {
    return createBillableMetric(request, env.BILLING_DB, auth, requestId);
  }
  if (request.method === "GET" && url.pathname === "/api/v1/billable_metrics") {
    return listBillableMetrics(url, env.BILLING_DB, auth, requestId);
  }
  const metricMatch = url.pathname.match(/^\/api\/v1\/billable_metrics\/([^/]+)$/);
  if (request.method === "GET" && metricMatch?.[1]) {
    return showBillableMetric(decodeURIComponent(metricMatch[1]), env.BILLING_DB, auth, requestId);
  }

  const chargesMatch = url.pathname.match(/^\/api\/v1\/plans\/([^/]+)\/charges$/);
  if (request.method === "POST" && chargesMatch?.[1]) {
    return createCharge(
      request,
      decodeURIComponent(chargesMatch[1]),
      env.BILLING_DB,
      auth,
      requestId,
    );
  }

  if (request.method === "POST" && url.pathname === "/api/v1/events") {
    return createUsageEvent(request, env, auth, requestId);
  }
  if (request.method === "GET" && url.pathname === "/api/v1/events") {
    return listUsageEvents(url, env.BILLING_DB, auth, requestId);
  }
  const eventMatch = url.pathname.match(/^\/api\/v1\/events\/([^/]+)$/);
  if (request.method === "GET" && eventMatch?.[1]) {
    return showUsageEvent(decodeURIComponent(eventMatch[1]), env.BILLING_DB, auth, requestId);
  }

  const usageMatch = url.pathname.match(/^\/api\/v1\/customers\/([^/]+)\/current_usage$/);
  if (request.method === "GET" && usageMatch?.[1]) {
    return currentUsage(decodeURIComponent(usageMatch[1]), url, env.BILLING_DB, auth, requestId);
  }

  return null;
}

async function createBillableMetric(
  request: Request,
  database: D1Database,
  auth: AuthContext,
  requestId: string,
): Promise<Response> {
  const body = await parseJsonObject(request);
  const input = objectAt(body, "billable_metric");
  const code = requiredString(input, "code");
  const name = requiredString(input, "name");
  const aggregationType = requiredString(input, "aggregation_type");
  if (!SUPPORTED_AGGREGATIONS.has(aggregationType as SupportedAggregationType)) {
    throw new ApiError(
      422,
      "unsupported_aggregation_type",
      `Unsupported aggregation type: ${aggregationType}`,
    );
  }
  const fieldName = optionalString(input, "field_name");
  if (aggregationType !== "count_agg" && !fieldName) {
    throw new ApiError(422, "validation_error", "field_name is required");
  }
  const existing = await findMetric(database, auth.organizationId, code);
  if (existing) {
    throw new ApiError(422, "value_already_exist", "Billable metric code already exists");
  }

  const now = new Date().toISOString();
  const id = await deterministicUuid("billable-metric", `${auth.organizationId}:${code}`);
  await database
    .prepare(
      `INSERT INTO billable_metrics
       (id, organization_id, code, name, description, aggregation_type, field_name,
        recurring, rounding_function, rounding_precision, weighted_interval, expression,
        properties_json, version, active, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '{}', 1, 1, ?, ?)`,
    )
    .bind(
      id,
      auth.organizationId,
      code,
      name,
      optionalString(input, "description"),
      aggregationType,
      fieldName,
      booleanInteger(input.recurring, false),
      optionalString(input, "rounding_function"),
      optionalInteger(input.rounding_precision),
      optionalString(input, "weighted_interval"),
      optionalString(input, "expression"),
      now,
      now,
    )
    .run();
  const metric = await findMetric(database, auth.organizationId, code);
  if (!metric) throw new ApiError(500, "persistence_error", "Billable metric was not persisted");
  return json({ billable_metric: serializeMetric(metric) }, { requestId });
}

async function listBillableMetrics(
  url: URL,
  database: D1Database,
  auth: AuthContext,
  requestId: string,
): Promise<Response> {
  const page = positiveInteger(url.searchParams.get("page"), 1);
  const perPage = Math.min(positiveInteger(url.searchParams.get("per_page"), 20), 100);
  const offset = (page - 1) * perPage;
  const count = await database
    .prepare(
      "SELECT COUNT(*) AS total FROM billable_metrics WHERE organization_id = ? AND active = 1",
    )
    .bind(auth.organizationId)
    .first<{ total: number }>();
  const result = await database
    .prepare(
      `SELECT id, code, name, description, aggregation_type, field_name, recurring,
              rounding_function, rounding_precision, weighted_interval, expression, created_at
       FROM billable_metrics WHERE organization_id = ? AND active = 1
       ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`,
    )
    .bind(auth.organizationId, perPage, offset)
    .all<MetricRow>();
  return json(
    {
      billable_metrics: result.results.map(serializeMetric),
      meta: pagination(count?.total ?? 0, page, perPage),
    },
    { requestId },
  );
}

async function showBillableMetric(
  code: string,
  database: D1Database,
  auth: AuthContext,
  requestId: string,
): Promise<Response> {
  const metric = await findMetric(database, auth.organizationId, code);
  if (!metric)
    throw new ApiError(404, "billable_metric_not_found", "Billable metric was not found");
  return json({ billable_metric: serializeMetric(metric) }, { requestId });
}

async function createCharge(
  request: Request,
  planCode: string,
  database: D1Database,
  auth: AuthContext,
  requestId: string,
): Promise<Response> {
  const body = await parseJsonObject(request);
  const input = objectAt(body, "charge");
  const code = requiredString(input, "code");
  const metricId = requiredString(input, "billable_metric_id");
  const chargeModel = requiredString(input, "charge_model");
  if (!SUPPORTED_CHARGE_MODELS.has(chargeModel)) {
    throw new ApiError(422, "unsupported_charge_model", `Unsupported charge model: ${chargeModel}`);
  }
  const properties = optionalObject(input.properties, "properties");
  parseChargeModel(chargeModel, properties);

  const plan = await database
    .prepare(
      `SELECT id FROM plans
       WHERE organization_id = ? AND code = ? AND active = 1
       ORDER BY version DESC LIMIT 1`,
    )
    .bind(auth.organizationId, planCode)
    .first<{ id: string }>();
  if (!plan) throw new ApiError(404, "plan_not_found", "Plan was not found");
  const metric = await database
    .prepare(
      `SELECT id FROM billable_metrics
       WHERE organization_id = ? AND id = ? AND active = 1 LIMIT 1`,
    )
    .bind(auth.organizationId, metricId)
    .first<{ id: string }>();
  if (!metric)
    throw new ApiError(404, "billable_metric_not_found", "Billable metric was not found");
  const existing = await database
    .prepare("SELECT id FROM charges WHERE plan_id = ? AND code = ? AND active = 1")
    .bind(plan.id, code)
    .first();
  if (existing) throw new ApiError(422, "value_already_exist", "Charge code already exists");

  const now = new Date().toISOString();
  const id = await deterministicUuid("charge", `${plan.id}:${code}`);
  await database
    .prepare(
      `INSERT INTO charges
       (id, organization_id, plan_id, billable_metric_id, code, invoice_display_name,
        charge_model, properties_json, invoiceable, pay_in_advance, prorated,
        min_amount_minor, version, active, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 1, ?, ?)`,
    )
    .bind(
      id,
      auth.organizationId,
      plan.id,
      metric.id,
      code,
      optionalString(input, "invoice_display_name"),
      chargeModel,
      stableJson(properties),
      booleanInteger(input.invoiceable, true),
      booleanInteger(input.pay_in_advance, false),
      booleanInteger(input.prorated, false),
      optionalNonNegativeInteger(input.min_amount_cents, 0),
      now,
      now,
    )
    .run();
  return json(
    {
      charge: {
        lago_id: id,
        lago_billable_metric_id: metric.id,
        code,
        invoice_display_name: optionalString(input, "invoice_display_name"),
        billable_metric_code: (await metricCode(database, metric.id)) ?? null,
        created_at: now,
        charge_model: chargeModel,
        invoiceable: booleanInteger(input.invoiceable, true) === 1,
        pay_in_advance: booleanInteger(input.pay_in_advance, false) === 1,
        prorated: booleanInteger(input.prorated, false) === 1,
        min_amount_cents: optionalNonNegativeInteger(input.min_amount_cents, 0),
        properties,
        filters: [],
        taxes: [],
        applied_pricing_unit: null,
        lago_parent_id: null,
      },
    },
    { requestId },
  );
}

async function createUsageEvent(
  request: Request,
  env: Env,
  auth: AuthContext,
  requestId: string,
): Promise<Response> {
  const body = await parseJsonObject(request);
  const input = normalizeEventInput(objectAt(body, "event"));
  const context = await env.BILLING_DB.prepare(
    `SELECT s.id AS subscription_id, s.customer_id, bm.id AS metric_id,
            bm.aggregation_type, bm.field_name
     FROM subscriptions s
     JOIN billable_metrics bm
       ON bm.organization_id = s.organization_id AND bm.code = ? AND bm.active = 1
     WHERE s.organization_id = ? AND s.external_id = ?
       AND s.status IN ('active', 'past_due')
       AND (s.started_at IS NULL OR s.started_at <= ?)
       AND (s.terminated_at IS NULL OR s.terminated_at >= ?)
     LIMIT 1`,
  )
    .bind(
      input.code,
      auth.organizationId,
      input.externalSubscriptionId,
      input.timestamp,
      input.timestamp,
    )
    .first<{
      subscription_id: string;
      customer_id: string;
      metric_id: string;
      aggregation_type: string;
      field_name: string | null;
    }>();
  if (!context) {
    const metric = await findMetric(env.BILLING_DB, auth.organizationId, input.code);
    throw metric
      ? new ApiError(404, "subscription_not_found", "Subscription was not found")
      : new ApiError(404, "billable_metric_not_found", "Billable metric was not found");
  }
  validateAggregationProperties(context.aggregation_type, context.field_name, input.properties);

  const normalized = {
    transactionId: input.transactionId,
    code: input.code,
    externalSubscriptionId: input.externalSubscriptionId,
    timestamp: input.timestamp,
    preciseTotalAmountMinor: input.preciseTotalAmountMinor,
    properties: input.properties,
  };
  const requestHash = await sha256Hex(stableJson(normalized));
  const existing = await findEvent(
    env.BILLING_DB,
    auth.organizationId,
    context.subscription_id,
    input.transactionId,
  );
  if (existing) {
    assertEventReplay(existing, requestHash);
    await env.DOMAIN_EVENTS.send(eventDomainMessage(existing, auth.organizationId, requestId));
    return json({ event: serializeEvent(existing) }, { requestId });
  }

  const id = await deterministicUuid(
    "usage-event",
    `${auth.organizationId}:${context.subscription_id}:${input.transactionId}`,
  );
  const archiveKey = `usage-events/${auth.organizationId}/${input.timestamp.slice(0, 10)}/${id}/${requestHash}.json`;
  await env.BILLING_ARTIFACTS.put(archiveKey, stableJson({ event: normalized }), {
    httpMetadata: { contentType: "application/json" },
    customMetadata: { sha256: requestHash, schema: "lago-event-v1" },
  });
  const createdAt = new Date().toISOString();
  const row: EventRow = {
    id,
    transaction_id: input.transactionId,
    customer_id: context.customer_id,
    subscription_id: context.subscription_id,
    external_subscription_id: input.externalSubscriptionId,
    code: input.code,
    timestamp: input.timestamp,
    timestamp_ms: input.timestampMs,
    precise_total_amount_minor: input.preciseTotalAmountMinor,
    properties_json: stableJson(input.properties),
    request_sha256: requestHash,
    created_at: createdAt,
  };
  const domainEvent = eventDomainMessage(row, auth.organizationId, requestId);
  try {
    await env.BILLING_DB.batch([
      env.BILLING_DB.prepare(
        `INSERT INTO usage_events
         (id, organization_id, subscription_id, customer_id, billable_metric_id,
          transaction_id, code, timestamp, timestamp_ms, precise_total_amount_minor,
          properties_json, request_sha256, archive_key, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(
        id,
        auth.organizationId,
        context.subscription_id,
        context.customer_id,
        context.metric_id,
        input.transactionId,
        input.code,
        input.timestamp,
        input.timestampMs,
        input.preciseTotalAmountMinor,
        row.properties_json,
        requestHash,
        archiveKey,
        createdAt,
      ),
      env.BILLING_DB.prepare(
        `INSERT INTO outbox_events
         (event_id, organization_id, event_type, event_version, aggregate_type,
          aggregate_id, aggregate_version, causation_id, correlation_id, payload_json,
          occurred_at, published_at)
         VALUES (?, ?, ?, 1, 'usage_event', ?, 1, ?, ?, ?, ?, NULL)`,
      ).bind(
        domainEvent.id,
        auth.organizationId,
        domainEvent.type,
        id,
        requestId,
        requestId,
        stableJson(domainEvent.payload),
        createdAt,
      ),
    ]);
  } catch (error) {
    const concurrent = await findEvent(
      env.BILLING_DB,
      auth.organizationId,
      context.subscription_id,
      input.transactionId,
    );
    if (!concurrent) throw error;
    assertEventReplay(concurrent, requestHash);
    await env.DOMAIN_EVENTS.send(eventDomainMessage(concurrent, auth.organizationId, requestId));
    return json({ event: serializeEvent(concurrent) }, { requestId });
  }
  await env.DOMAIN_EVENTS.send(domainEvent);
  return json({ event: serializeEvent(row) }, { requestId });
}

async function showUsageEvent(
  transactionId: string,
  database: D1Database,
  auth: AuthContext,
  requestId: string,
): Promise<Response> {
  const event = await database
    .prepare(
      `SELECT ue.id, ue.transaction_id, ue.customer_id, ue.subscription_id,
              s.external_id AS external_subscription_id, ue.code, ue.timestamp,
              ue.timestamp_ms, ue.precise_total_amount_minor, ue.properties_json,
              ue.request_sha256, ue.created_at
       FROM usage_events ue JOIN subscriptions s ON s.id = ue.subscription_id
       WHERE ue.organization_id = ? AND ue.transaction_id = ?
       ORDER BY ue.created_at DESC LIMIT 1`,
    )
    .bind(auth.organizationId, transactionId)
    .first<EventRow>();
  if (!event) throw new ApiError(404, "event_not_found", "Event was not found");
  return json({ event: serializeEvent(event) }, { requestId });
}

async function listUsageEvents(
  url: URL,
  database: D1Database,
  auth: AuthContext,
  requestId: string,
): Promise<Response> {
  const code = url.searchParams.get("code")?.trim() || null;
  const subscription = url.searchParams.get("external_subscription_id")?.trim() || null;
  const page = positiveInteger(url.searchParams.get("page"), 1);
  const perPage = Math.min(positiveInteger(url.searchParams.get("per_page"), 20), 100);
  const offset = (page - 1) * perPage;
  const filters = ["ue.organization_id = ?"];
  const bindings: Array<string | number> = [auth.organizationId];
  if (code) {
    filters.push("ue.code = ?");
    bindings.push(code);
  }
  if (subscription) {
    filters.push("s.external_id = ?");
    bindings.push(subscription);
  }
  const where = filters.join(" AND ");
  const count = await database
    .prepare(
      `SELECT COUNT(*) AS total FROM usage_events ue
       JOIN subscriptions s ON s.id = ue.subscription_id WHERE ${where}`,
    )
    .bind(...bindings)
    .first<{ total: number }>();
  const result = await database
    .prepare(
      `SELECT ue.id, ue.transaction_id, ue.customer_id, ue.subscription_id,
              s.external_id AS external_subscription_id, ue.code, ue.timestamp,
              ue.timestamp_ms, ue.precise_total_amount_minor, ue.properties_json,
              ue.request_sha256, ue.created_at
       FROM usage_events ue JOIN subscriptions s ON s.id = ue.subscription_id
       WHERE ${where} ORDER BY ue.created_at DESC, ue.id DESC LIMIT ? OFFSET ?`,
    )
    .bind(...bindings, perPage, offset)
    .all<EventRow>();
  return json(
    {
      events: result.results.map(serializeEvent),
      meta: pagination(count?.total ?? 0, page, perPage),
    },
    { requestId },
  );
}

async function currentUsage(
  externalCustomerId: string,
  url: URL,
  database: D1Database,
  auth: AuthContext,
  requestId: string,
): Promise<Response> {
  const externalSubscriptionId = url.searchParams.get("external_subscription_id")?.trim();
  if (!externalSubscriptionId) {
    throw new ApiError(422, "validation_error", "external_subscription_id is required");
  }
  const subscription = await database
    .prepare(
      `SELECT s.id, s.customer_id, s.plan_id, s.external_id, s.current_period_start,
              s.current_period_end, p.currency
       FROM subscriptions s
       JOIN customers c ON c.id = s.customer_id
       JOIN plans p ON p.id = s.plan_id
       WHERE s.organization_id = ? AND c.external_id = ? AND s.external_id = ?
         AND s.status IN ('active', 'past_due') LIMIT 1`,
    )
    .bind(auth.organizationId, externalCustomerId, externalSubscriptionId)
    .first<SubscriptionUsageRow>();
  if (!subscription)
    throw new ApiError(404, "subscription_not_found", "Subscription was not found");

  const charges = await database
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
    .bind(auth.organizationId, subscription.plan_id)
    .all<ChargeUsageRow>();

  let total = Decimal.zero();
  const chargeUsage: Array<Record<string, unknown>> = [];
  for (const charge of charges.results) {
    const events = await usageEventsForPeriod(database, subscription, charge.metric_id);
    const units = aggregateUsage(
      supportedAggregation(charge.aggregation_type),
      charge.field_name,
      events,
    );
    const properties = parseStoredObject(charge.properties_json);
    const rated = rateCharge(units.toString(), parseChargeModel(charge.charge_model, properties), {
      eventsCount: events.length,
    });
    let amount = Decimal.parse(rated.amountCents);
    const minimum = Decimal.parse(charge.min_amount_minor);
    if (amount.compare(minimum) < 0) amount = minimum;
    total = total.add(amount);
    chargeUsage.push({
      units: units.toString(),
      total_aggregated_units: units.toString(),
      events_count: events.length,
      amount_cents: jsonDecimal(amount),
      amount_currency: subscription.currency,
      charge: {
        lago_id: charge.id,
        charge_model: charge.charge_model,
        invoice_display_name: charge.invoice_display_name,
      },
      billable_metric: {
        lago_id: charge.metric_id,
        name: charge.metric_name,
        code: charge.metric_code,
        aggregation_type: charge.aggregation_type,
      },
      filters: [],
      grouped_usage: [],
      pricing_unit_details: null,
      presentation_breakdowns: [],
    });
  }

  return json(
    {
      customer_usage: {
        from_datetime: subscription.current_period_start,
        to_datetime: subscription.current_period_end,
        issuing_date: subscription.current_period_end.slice(0, 10),
        currency: subscription.currency,
        amount_cents: jsonDecimal(total),
        total_amount_cents: jsonDecimal(total),
        taxes_amount_cents: 0,
        lago_invoice_id: null,
        charges_usage: chargeUsage,
      },
    },
    { requestId },
  );
}

async function usageEventsForPeriod(
  database: D1Database,
  subscription: SubscriptionUsageRow,
  metricId: string,
): Promise<Array<{ id: string; timestampMs: number; properties: Record<string, unknown> }>> {
  const result = await database
    .prepare(
      `SELECT id, timestamp_ms, properties_json FROM usage_events
       WHERE subscription_id = ? AND billable_metric_id = ?
         AND timestamp_ms >= ? AND timestamp_ms < ?
       ORDER BY timestamp_ms, id LIMIT 10001`,
    )
    .bind(
      subscription.id,
      metricId,
      Date.parse(subscription.current_period_start),
      Date.parse(subscription.current_period_end),
    )
    .all<{ id: string; timestamp_ms: number; properties_json: string }>();
  if (result.results.length > 10000) {
    throw new ApiError(503, "usage_window_too_large", "Usage requires asynchronous aggregation");
  }
  return result.results.map((event) => ({
    id: event.id,
    timestampMs: event.timestamp_ms,
    properties: parseStoredObject(event.properties_json),
  }));
}

function normalizeEventInput(input: Record<string, unknown>): EventInput {
  const timestampValue = input.timestamp;
  let timestampMs: number;
  if (timestampValue === undefined || timestampValue === null || timestampValue === "") {
    timestampMs = Date.now();
  } else if (typeof timestampValue === "string" || typeof timestampValue === "number") {
    const seconds = Number(timestampValue);
    timestampMs = seconds * 1000;
  } else {
    timestampMs = Number.NaN;
  }
  if (!Number.isFinite(timestampMs) || !Number.isSafeInteger(Math.trunc(timestampMs))) {
    throw new ApiError(422, "invalid_format", "timestamp must be epoch seconds");
  }
  timestampMs = Math.trunc(timestampMs);
  const timestamp = new Date(timestampMs);
  if (Number.isNaN(timestamp.getTime())) {
    throw new ApiError(422, "invalid_format", "timestamp must be epoch seconds");
  }
  const precise = input.precise_total_amount_cents;
  const preciseTotalAmountMinor =
    precise === undefined || precise === null
      ? null
      : validateDecimalValue(precise, "precise_total_amount_cents");
  return {
    transactionId: requiredString(input, "transaction_id"),
    code: requiredString(input, "code"),
    externalSubscriptionId: requiredString(input, "external_subscription_id"),
    timestamp: timestamp.toISOString(),
    timestampMs,
    preciseTotalAmountMinor,
    properties: optionalObject(input.properties, "properties"),
  };
}

async function findMetric(
  database: D1Database,
  organizationId: string,
  code: string,
): Promise<MetricRow | null> {
  return database
    .prepare(
      `SELECT id, code, name, description, aggregation_type, field_name, recurring,
              rounding_function, rounding_precision, weighted_interval, expression, created_at
       FROM billable_metrics
       WHERE organization_id = ? AND code = ? AND active = 1 LIMIT 1`,
    )
    .bind(organizationId, code)
    .first<MetricRow>();
}

async function findEvent(
  database: D1Database,
  organizationId: string,
  subscriptionId: string,
  transactionId: string,
): Promise<EventRow | null> {
  return database
    .prepare(
      `SELECT ue.id, ue.transaction_id, ue.customer_id, ue.subscription_id,
              s.external_id AS external_subscription_id, ue.code, ue.timestamp,
              ue.timestamp_ms, ue.precise_total_amount_minor, ue.properties_json,
              ue.request_sha256, ue.created_at
       FROM usage_events ue JOIN subscriptions s ON s.id = ue.subscription_id
       WHERE ue.organization_id = ? AND ue.subscription_id = ? AND ue.transaction_id = ? LIMIT 1`,
    )
    .bind(organizationId, subscriptionId, transactionId)
    .first<EventRow>();
}

function serializeMetric(metric: MetricRow): Record<string, unknown> {
  return {
    lago_id: metric.id,
    name: metric.name,
    code: metric.code,
    description: metric.description,
    aggregation_type: metric.aggregation_type,
    weighted_interval: metric.weighted_interval,
    recurring: metric.recurring === 1,
    rounding_function: metric.rounding_function,
    rounding_precision: metric.rounding_precision,
    created_at: metric.created_at,
    field_name: metric.field_name,
    expression: metric.expression,
    active_subscriptions_count: 0,
    draft_invoices_count: 0,
    plans_count: 0,
    filters: [],
  };
}

function serializeEvent(event: EventRow): Record<string, unknown> {
  return {
    lago_id: event.id,
    transaction_id: event.transaction_id,
    lago_customer_id: event.customer_id,
    code: event.code,
    timestamp: formatIsoMilliseconds(event.timestamp),
    precise_total_amount_cents: event.precise_total_amount_minor,
    properties: parseStoredObject(event.properties_json),
    lago_subscription_id: event.subscription_id,
    external_subscription_id: event.external_subscription_id,
    created_at: event.created_at,
  };
}

function eventDomainMessage(
  event: EventRow,
  organizationId: string,
  correlationId: string,
): DomainEvent {
  return {
    id: `usage-event-ingested:${event.id}`,
    type: "usage_event.ingested",
    version: 1,
    aggregateType: "usage_event",
    aggregateId: event.id,
    aggregateVersion: 1,
    occurredAt: event.created_at,
    causationId: correlationId,
    correlationId,
    payload: {
      organizationId,
      subscriptionId: event.subscription_id,
      billableMetricCode: event.code,
      transactionId: event.transaction_id,
      timestamp: event.timestamp,
    },
  };
}

function assertEventReplay(event: EventRow, requestHash: string): void {
  if (event.request_sha256 !== requestHash) {
    throw new ApiError(
      409,
      "event_idempotency_conflict",
      "Event transaction_id was reused with different attributes",
    );
  }
}

function supportedAggregation(value: string): SupportedAggregationType {
  if (SUPPORTED_AGGREGATIONS.has(value as SupportedAggregationType)) {
    return value as SupportedAggregationType;
  }
  throw new ApiError(422, "unsupported_aggregation_type", `Unsupported aggregation type: ${value}`);
}

function validateAggregationProperties(
  aggregationType: string,
  fieldName: string | null,
  properties: Record<string, unknown>,
): void {
  if (aggregationType === "count_agg") return;
  if (!fieldName) throw new ApiError(500, "invalid_metric", "Metric field_name is missing");
  const value = properties[fieldName];
  if (aggregationType === "unique_count_agg") {
    if (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean") {
      throw new ApiError(422, "validation_error", `${fieldName} is required`);
    }
    const operation = properties.operation_type;
    if (operation !== undefined && operation !== "add" && operation !== "remove") {
      throw new ApiError(422, "validation_error", "operation_type must be add or remove");
    }
    return;
  }
  validateDecimalValue(value, fieldName);
}

function parseStoredObject(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // Stored JSON is an internal invariant; surface a stable error without leaking its contents.
  }
  throw new ApiError(500, "invalid_stored_json", "Stored JSON could not be decoded");
}

function optionalObject(value: unknown, field: string): Record<string, unknown> {
  if (value === undefined || value === null) return {};
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ApiError(422, "validation_error", `${field} must be an object`);
  }
  return value as Record<string, unknown>;
}

function validateDecimalValue(value: unknown, field: string): string {
  if (typeof value !== "string" && typeof value !== "number") {
    throw new ApiError(422, "validation_error", `${field} must be a decimal`);
  }
  const normalized = String(value);
  try {
    Decimal.parse(normalized);
  } catch {
    throw new ApiError(422, "validation_error", `${field} must be a decimal`);
  }
  return normalized;
}

function booleanInteger(value: unknown, fallback: boolean): 0 | 1 {
  if (value === undefined || value === null) return fallback ? 1 : 0;
  if (typeof value !== "boolean") throw new ApiError(422, "validation_error", "must be boolean");
  return value ? 1 : 0;
}

function optionalInteger(value: unknown): number | null {
  if (value === undefined || value === null) return null;
  if (!Number.isSafeInteger(value))
    throw new ApiError(422, "validation_error", "must be an integer");
  return value as number;
}

function optionalNonNegativeInteger(value: unknown, fallback: number): number {
  if (value === undefined || value === null) return fallback;
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    throw new ApiError(422, "validation_error", "must be a non-negative integer");
  }
  return Number(value);
}

function jsonDecimal(value: Decimal): number | string {
  const source = value.toString();
  const number = Number(source);
  return Number.isFinite(number) && Math.abs(number) <= Number.MAX_SAFE_INTEGER ? number : source;
}

function formatIsoMilliseconds(value: string): string {
  return new Date(value).toISOString();
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

async function metricCode(database: D1Database, id: string): Promise<string | null> {
  const metric = await database
    .prepare("SELECT code FROM billable_metrics WHERE id = ? LIMIT 1")
    .bind(id)
    .first<{ code: string }>();
  return metric?.code ?? null;
}
