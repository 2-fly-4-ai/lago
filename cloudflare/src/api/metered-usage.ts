import type { AuthContext } from "../auth/api-key";
import { sha256Hex } from "../auth/api-key";
import type { DomainEvent } from "../domain-events";
import { ApiError, json, objectAt, optionalString, parseJsonObject, requiredString } from "../http";
import { deterministicUuid } from "../identifiers";
import { stableJson } from "../json";
import { rateCharge } from "../rating/charge-models";
import { Decimal } from "../rating/decimal";
import {
  aggregateUsageResult,
  applyAggregationRounding,
  type AggregationRoundingFunction,
  type SupportedAggregationType,
} from "../usage/aggregation";
import { parseChargeModel } from "../usage/charge-properties";
import {
  normalizeBillableMetricFilters,
  normalizeChargeFilters,
  parseStoredBillableMetricFilters,
  parseStoredChargeFilters,
  partitionUsageEvents,
  serializeChargeFilter,
  type BillableMetricFilter,
  type ChargeFilter,
} from "../usage/charge-filters";
import {
  evaluateUsageExpression,
  UsageExpressionError,
  validateUsageExpression,
} from "../usage/expression";
import { billingPeriodDurationDays, type BillingTime } from "../billing/periods";

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
  filters_json: string;
  version: number;
  created_at: string;
  updated_at: string;
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
  organization_id: string;
  customer_id: string;
  plan_id: string;
  external_id: string;
  current_period_start: string;
  current_period_end: string;
  currency: string;
  interval: string;
  billing_time: BillingTime;
  billing_timezone: string;
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
  recurring: number;
  weighted_interval: string | null;
  rounding_function: AggregationRoundingFunction | null;
  rounding_precision: number | null;
  accepts_target_wallet: number;
  filters_json: string;
  metric_filters_json: string;
};

type CatalogChargeRow = ChargeUsageRow & {
  created_at: string;
  updated_at: string;
  version: number;
  invoiceable: number;
  pay_in_advance: number;
  prorated: number;
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

type EventContext = {
  subscription_id: string;
  customer_id: string;
  metric_id: string;
  aggregation_type: string;
  field_name: string | null;
  expression: string | null;
  accepts_target_wallet: number;
};

type PreparedBatchEvent = {
  input: EventInput;
  context: EventContext;
  normalized: Record<string, unknown>;
  requestHash: string;
  archiveKey: string;
  row: EventRow;
  domainEvent: DomainEvent;
  targetWalletError: DomainEvent | null;
};

const SUPPORTED_AGGREGATIONS = new Set<SupportedAggregationType>([
  "count_agg",
  "sum_agg",
  "max_agg",
  "unique_count_agg",
  "weighted_sum_agg",
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
    return createBillableMetric(request, env, auth, requestId);
  }
  if (request.method === "GET" && url.pathname === "/api/v1/billable_metrics") {
    return listBillableMetrics(url, env.BILLING_DB, auth, requestId);
  }
  if (
    request.method === "POST" &&
    url.pathname === "/api/v1/billable_metrics/evaluate_expression"
  ) {
    return evaluateBillableMetricExpression(request, requestId);
  }
  const metricMatch = url.pathname.match(/^\/api\/v1\/billable_metrics\/([^/]+)$/);
  if (request.method === "GET" && metricMatch?.[1]) {
    return showBillableMetric(decodeURIComponent(metricMatch[1]), env.BILLING_DB, auth, requestId);
  }
  if (request.method === "PUT" && metricMatch?.[1]) {
    return updateBillableMetric(decodeURIComponent(metricMatch[1]), request, env, auth, requestId);
  }
  if (request.method === "DELETE" && metricMatch?.[1]) {
    return deleteBillableMetric(decodeURIComponent(metricMatch[1]), env, auth, requestId);
  }

  const chargesMatch = url.pathname.match(/^\/api\/v1\/plans\/([^/]+)\/charges$/);
  if (request.method === "GET" && chargesMatch?.[1]) {
    return listCharges(decodeURIComponent(chargesMatch[1]), url, env.BILLING_DB, auth, requestId);
  }
  if (request.method === "POST" && chargesMatch?.[1]) {
    return createCharge(request, decodeURIComponent(chargesMatch[1]), env, auth, requestId);
  }
  const chargeMatch = url.pathname.match(/^\/api\/v1\/plans\/([^/]+)\/charges\/([^/]+)$/);
  if (request.method === "GET" && chargeMatch?.[1] && chargeMatch[2]) {
    return showCharge(
      decodeURIComponent(chargeMatch[1]),
      decodeURIComponent(chargeMatch[2]),
      env.BILLING_DB,
      auth,
      requestId,
    );
  }
  if (request.method === "PUT" && chargeMatch?.[1] && chargeMatch[2]) {
    return updateCharge(
      request,
      decodeURIComponent(chargeMatch[1]),
      decodeURIComponent(chargeMatch[2]),
      env,
      auth,
      requestId,
    );
  }
  if (request.method === "DELETE" && chargeMatch?.[1] && chargeMatch[2]) {
    return deleteCharge(
      request,
      decodeURIComponent(chargeMatch[1]),
      decodeURIComponent(chargeMatch[2]),
      env,
      auth,
      requestId,
    );
  }
  const chargeFiltersMatch = url.pathname.match(
    /^\/api\/v1\/plans\/([^/]+)\/charges\/([^/]+)\/filters$/,
  );
  if (request.method === "GET" && chargeFiltersMatch?.[1] && chargeFiltersMatch[2]) {
    return listChargeFilters(
      decodeURIComponent(chargeFiltersMatch[1]),
      decodeURIComponent(chargeFiltersMatch[2]),
      url,
      env.BILLING_DB,
      auth,
      requestId,
    );
  }
  if (request.method === "POST" && chargeFiltersMatch?.[1] && chargeFiltersMatch[2]) {
    return createChargeFilter(
      decodeURIComponent(chargeFiltersMatch[1]),
      decodeURIComponent(chargeFiltersMatch[2]),
      request,
      env,
      auth,
      requestId,
    );
  }
  const chargeFilterMatch = url.pathname.match(
    /^\/api\/v1\/plans\/([^/]+)\/charges\/([^/]+)\/filters\/([^/]+)$/,
  );
  if (
    request.method === "GET" &&
    chargeFilterMatch?.[1] &&
    chargeFilterMatch[2] &&
    chargeFilterMatch[3]
  ) {
    return showChargeFilter(
      decodeURIComponent(chargeFilterMatch[1]),
      decodeURIComponent(chargeFilterMatch[2]),
      decodeURIComponent(chargeFilterMatch[3]),
      env.BILLING_DB,
      auth,
      requestId,
    );
  }
  if (
    request.method === "PUT" &&
    chargeFilterMatch?.[1] &&
    chargeFilterMatch[2] &&
    chargeFilterMatch[3]
  ) {
    return updateChargeFilter(
      decodeURIComponent(chargeFilterMatch[1]),
      decodeURIComponent(chargeFilterMatch[2]),
      decodeURIComponent(chargeFilterMatch[3]),
      request,
      env,
      auth,
      requestId,
    );
  }
  if (
    request.method === "DELETE" &&
    chargeFilterMatch?.[1] &&
    chargeFilterMatch[2] &&
    chargeFilterMatch[3]
  ) {
    return deleteChargeFilter(
      decodeURIComponent(chargeFilterMatch[1]),
      decodeURIComponent(chargeFilterMatch[2]),
      decodeURIComponent(chargeFilterMatch[3]),
      env,
      auth,
      requestId,
    );
  }

  if (request.method === "POST" && url.pathname === "/api/v1/events/batch") {
    return createUsageEventBatch(request, env, auth, requestId);
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

async function evaluateBillableMetricExpression(
  request: Request,
  requestId: string,
): Promise<Response> {
  const body = await parseJsonObject(request);
  const expression = requiredString(body, "expression");
  const rawEvent = body.event;
  if (
    rawEvent !== undefined &&
    (!rawEvent || typeof rawEvent !== "object" || Array.isArray(rawEvent))
  ) {
    throw new ApiError(422, "validation_error", "event must be an object");
  }
  const event = (rawEvent ?? {}) as Record<string, unknown>;
  const rawProperties = event.properties;
  if (
    rawProperties !== undefined &&
    (!rawProperties || typeof rawProperties !== "object" || Array.isArray(rawProperties))
  ) {
    throw new ApiError(422, "validation_error", "event.properties must be an object");
  }
  const timestamp = event.timestamp ?? Date.now() / 1000;
  if (typeof timestamp !== "string" && typeof timestamp !== "number") {
    throw new ApiError(422, "invalid_event", "event.timestamp must be numeric");
  }
  const timestampSeconds = Number(timestamp);
  if (!Number.isFinite(timestampSeconds)) {
    throw new ApiError(422, "invalid_event", "event.timestamp must be numeric");
  }
  try {
    const value = evaluateUsageExpression(expression, {
      code: event.code === undefined ? "" : String(event.code),
      timestamp: Math.trunc(timestampSeconds),
      properties: (rawProperties ?? {}) as Record<string, unknown>,
    });
    return json({ expression_result: { value } }, { requestId });
  } catch (error) {
    throw expressionApiError(error);
  }
}

async function createBillableMetric(
  request: Request,
  env: Env,
  auth: AuthContext,
  requestId: string,
): Promise<Response> {
  const database = env.BILLING_DB;
  const body = await parseJsonObject(request);
  const input = objectAt(body, "billable_metric");
  const normalized = normalizeMetricInput(input);
  const existing = await findMetric(database, auth.organizationId, normalized.code);
  if (existing) {
    if (sameMetric(existing, normalized))
      return json({ billable_metric: serializeMetric(existing) }, { requestId });
    throw new ApiError(422, "value_already_exist", "Billable metric code already exists");
  }

  const now = new Date().toISOString();
  const identity = await nextMetricIdentity(database, auth.organizationId, normalized.code);
  const event = catalogEvent(
    "billable_metric.created",
    "billable_metric",
    identity.id,
    identity.version,
    auth.organizationId,
    requestId,
    now,
    { code: normalized.code },
  );
  try {
    await database.batch([
      database
        .prepare(
          `INSERT INTO billable_metrics
       (id, organization_id, code, name, description, aggregation_type, field_name,
        recurring, rounding_function, rounding_precision, weighted_interval, expression,
        properties_json, filters_json, version, active, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '{}', ?, ?, 1, ?, ?)`,
        )
        .bind(
          identity.id,
          auth.organizationId,
          normalized.code,
          normalized.name,
          normalized.description,
          normalized.aggregationType,
          normalized.fieldName,
          normalized.recurring,
          normalized.roundingFunction,
          normalized.roundingPrecision,
          normalized.weightedInterval,
          normalized.expression,
          stableJson(normalized.filters),
          identity.version,
          now,
          now,
        ),
      outboxStatement(database, auth.organizationId, event),
    ]);
  } catch (error) {
    const concurrent = await findMetric(database, auth.organizationId, normalized.code);
    if (concurrent && sameMetric(concurrent, normalized))
      return json({ billable_metric: serializeMetric(concurrent) }, { requestId });
    if (concurrent)
      throw new ApiError(422, "value_already_exist", "Billable metric code already exists");
    throw error;
  }
  await env.DOMAIN_EVENTS.send(event);
  const metric = await findMetric(database, auth.organizationId, normalized.code);
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
              rounding_function, rounding_precision, weighted_interval, expression, filters_json, version,
              created_at, updated_at
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

async function updateBillableMetric(
  code: string,
  request: Request,
  env: Env,
  auth: AuthContext,
  requestId: string,
): Promise<Response> {
  const metric = await findMetric(env.BILLING_DB, auth.organizationId, code);
  if (!metric)
    throw new ApiError(404, "billable_metric_not_found", "Billable metric was not found");
  const input = objectAt(await parseJsonObject(request), "billable_metric");
  const attached = await env.BILLING_DB.prepare(
    "SELECT id FROM charges WHERE billable_metric_id = ? AND active = 1 LIMIT 1",
  )
    .bind(metric.id)
    .first();
  const nextCode = input.code === undefined ? metric.code : requiredString(input, "code");
  const nextAggregation =
    input.aggregation_type === undefined
      ? supportedMetricAggregation(metric.aggregation_type)
      : supportedMetricAggregation(input.aggregation_type);
  const nextFieldName =
    input.field_name === undefined ? metric.field_name : optionalString(input, "field_name");
  const nextExpression =
    input.expression === undefined ? metric.expression : optionalString(input, "expression");
  const nextRecurring =
    input.recurring === undefined
      ? metric.recurring === 1
        ? 1
        : 0
      : booleanInteger(input.recurring, metric.recurring === 1);
  const nextWeightedInterval =
    input.weighted_interval === undefined
      ? normalizeStoredWeightedInterval(metric.weighted_interval)
      : normalizeWeightedInterval(input.weighted_interval);
  const nextRoundingFunction =
    input.rounding_function === undefined
      ? normalizeStoredRoundingFunction(metric.rounding_function)
      : normalizeRoundingFunction(input.rounding_function);
  const nextRoundingPrecision =
    input.rounding_precision === undefined
      ? metric.rounding_precision
      : normalizeRoundingPrecision(input.rounding_precision);
  const nextFilters =
    input.filters === undefined
      ? parseStoredBillableMetricFilters(metric.filters_json)
      : normalizeBillableMetricFilters(input.filters);
  validateMetricConfiguration(
    nextAggregation,
    nextFieldName,
    nextExpression,
    nextRecurring,
    nextWeightedInterval,
  );
  if (
    attached &&
    (nextCode !== metric.code ||
      nextAggregation !== metric.aggregation_type ||
      nextFieldName !== metric.field_name ||
      input.recurring !== undefined ||
      input.rounding_function !== undefined ||
      input.rounding_precision !== undefined ||
      input.weighted_interval !== undefined ||
      input.expression !== undefined ||
      stableJson(nextFilters) !== stableJson(parseStoredBillableMetricFilters(metric.filters_json)))
  )
    throw new ApiError(
      422,
      "billable_metric_in_use",
      "Only name and description can change on a billable metric attached to a plan",
    );
  if (nextCode !== metric.code) {
    const duplicate = await findMetric(env.BILLING_DB, auth.organizationId, nextCode);
    if (duplicate)
      throw new ApiError(422, "value_already_exist", "Billable metric code already exists");
  }
  const next = {
    code: nextCode,
    name: input.name === undefined ? metric.name : requiredString(input, "name"),
    description:
      input.description === undefined ? metric.description : optionalString(input, "description"),
    aggregationType: nextAggregation,
    fieldName: nextFieldName,
    filters: nextFilters,
  };
  const now = new Date().toISOString();
  const event = catalogEvent(
    "billable_metric.updated",
    "billable_metric",
    metric.id,
    metric.version + 1,
    auth.organizationId,
    requestId,
    now,
    { code: next.code },
  );
  try {
    const results = await env.BILLING_DB.batch([
      metricMutationGuardStatement(env.BILLING_DB, requestId, auth.organizationId, metric, 1, now),
      env.BILLING_DB.prepare(
        `UPDATE billable_metrics SET code = ?, name = ?, description = ?,
         aggregation_type = ?, field_name = ?, recurring = ?, rounding_function = ?,
         rounding_precision = ?, weighted_interval = ?, expression = ?, filters_json = ?,
         version = version + 1, updated_at = ?
         WHERE id = ? AND organization_id = ? AND active = 1 AND version = ?
           AND EXISTS (SELECT 1 FROM billable_metric_mutation_guards
                       WHERE request_id = ? AND billable_metric_id = ?)`,
      ).bind(
        next.code,
        next.name,
        next.description,
        next.aggregationType,
        next.fieldName,
        nextRecurring,
        nextRoundingFunction,
        nextRoundingPrecision,
        nextWeightedInterval,
        nextExpression,
        stableJson(next.filters),
        now,
        metric.id,
        auth.organizationId,
        metric.version,
        requestId,
        metric.id,
      ),
      guardedMetricOutboxStatement(
        env.BILLING_DB,
        auth.organizationId,
        event,
        metric.id,
        metric.version + 1,
        now,
        1,
        requestId,
      ),
      clearMetricMutationGuardStatement(env.BILLING_DB, requestId, metric.id),
    ]);
    if (
      results[0]?.meta.changes !== 1 ||
      (results[1]?.meta.changes ?? 0) < 1 ||
      results[2]?.meta.changes !== 1 ||
      results[3]?.meta.changes !== 1
    )
      throw new ApiError(
        409,
        "billable_metric_version_conflict",
        "Billable metric changed concurrently",
      );
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError(422, "value_already_exist", "Billable metric code already exists");
  }
  await env.DOMAIN_EVENTS.send(event);
  const updated = await findMetric(env.BILLING_DB, auth.organizationId, next.code);
  if (!updated) throw new ApiError(500, "persistence_error", "Billable metric disappeared");
  return json({ billable_metric: serializeMetric(updated) }, { requestId });
}

async function deleteBillableMetric(
  code: string,
  env: Env,
  auth: AuthContext,
  requestId: string,
): Promise<Response> {
  const database = env.BILLING_DB;
  const metric = await findMetric(database, auth.organizationId, code);
  if (!metric)
    throw new ApiError(404, "billable_metric_not_found", "Billable metric was not found");

  const now = new Date().toISOString();
  const event = catalogEvent(
    "billable_metric.deleted",
    "billable_metric",
    metric.id,
    metric.version + 1,
    auth.organizationId,
    requestId,
    now,
    { code: metric.code },
  );
  const currentMetric = `EXISTS (
    SELECT 1 FROM billable_metric_mutation_guards
    WHERE request_id = ? AND billable_metric_id = ?
  )`;
  const results = await database.batch([
    metricMutationGuardStatement(database, requestId, auth.organizationId, metric, 0, now),
    database
      .prepare(
        `UPDATE charges SET active = 0, version = version + 1, updated_at = ?
         WHERE organization_id = ? AND billable_metric_id = ? AND active = 1
           AND ${currentMetric}`,
      )
      .bind(now, auth.organizationId, metric.id, requestId, metric.id),
    database
      .prepare(
        `INSERT OR IGNORE INTO billable_metric_cleanup_tasks
         (billable_metric_id, organization_id, created_at)
         SELECT id, organization_id, ? FROM billable_metrics
         WHERE id = ? AND organization_id = ? AND active = 1 AND version = ?
           AND ${currentMetric}`,
      )
      .bind(now, metric.id, auth.organizationId, metric.version, requestId, metric.id),
    database
      .prepare(
        `UPDATE billable_metrics SET active = 0, version = version + 1, updated_at = ?
         WHERE id = ? AND organization_id = ? AND active = 1 AND version = ?
           AND ${currentMetric}`,
      )
      .bind(now, metric.id, auth.organizationId, metric.version, requestId, metric.id),
    guardedMetricOutboxStatement(
      database,
      auth.organizationId,
      event,
      metric.id,
      metric.version + 1,
      now,
      0,
      requestId,
    ),
    clearMetricMutationGuardStatement(database, requestId, metric.id),
  ]);
  if (
    results[0]?.meta.changes !== 1 ||
    results[2]?.meta.changes !== 1 ||
    results[3]?.meta.changes !== 1 ||
    results[4]?.meta.changes !== 1 ||
    results[5]?.meta.changes !== 1
  )
    throw new ApiError(
      409,
      "billable_metric_version_conflict",
      "Billable metric changed concurrently",
    );
  await env.DOMAIN_EVENTS.send(event);
  return json({ billable_metric: serializeMetric(metric) }, { requestId });
}

async function createCharge(
  request: Request,
  planCode: string,
  env: Env,
  auth: AuthContext,
  requestId: string,
): Promise<Response> {
  const database = env.BILLING_DB;
  const body = await parseJsonObject(request);
  const input = objectAt(body, "charge");
  rejectUnsupportedChargeInput(input);
  const code = requiredString(input, "code");
  const metricId = requiredString(input, "billable_metric_id");
  const chargeModel = requiredString(input, "charge_model");
  if (!SUPPORTED_CHARGE_MODELS.has(chargeModel)) {
    throw new ApiError(422, "unsupported_charge_model", `Unsupported charge model: ${chargeModel}`);
  }
  const properties = optionalObject(input.properties, "properties");
  parseChargeModel(chargeModel, properties);
  if (booleanInteger(input.pay_in_advance, false) === 1)
    throw new ApiError(
      422,
      "unsupported_charge_feature",
      "Pay-in-advance usage charges are not implemented",
    );
  if (booleanInteger(input.prorated, false) === 1)
    throw new ApiError(
      422,
      "unsupported_charge_feature",
      "Prorated usage charges are not implemented",
    );

  const plan = await database
    .prepare(
      `SELECT id FROM plans
       WHERE organization_id = ? AND code = ? AND active = 1 AND pending_deletion = 0
         AND parent_id IS NULL
       ORDER BY version DESC LIMIT 1`,
    )
    .bind(auth.organizationId, planCode)
    .first<{ id: string }>();
  if (!plan) throw new ApiError(404, "plan_not_found", "Plan was not found");
  const metric = await database
    .prepare(
      `SELECT id, aggregation_type, filters_json FROM billable_metrics
       WHERE organization_id = ? AND id = ? AND active = 1 LIMIT 1`,
    )
    .bind(auth.organizationId, metricId)
    .first<{ id: string; aggregation_type: string; filters_json: string }>();
  if (!metric)
    throw new ApiError(404, "billable_metric_not_found", "Billable metric was not found");
  const normalized = {
    invoiceDisplayName: optionalString(input, "invoice_display_name"),
    invoiceable: booleanInteger(input.invoiceable, true),
    minAmountMinor: optionalNonNegativeInteger(input.min_amount_cents, 0),
    acceptsTargetWallet: booleanInteger(input.accepts_target_wallet, false),
  };
  const existing = await findCatalogCharge(database, plan.id, code);
  if (existing) {
    const filters = await normalizeChargeFilters(
      input.filters,
      parseStoredBillableMetricFilters(metric.filters_json),
      chargeModel,
      existing.id,
    );
    if (sameCatalogCharge(existing, metric.id, chargeModel, properties, filters, normalized))
      return json({ charge: serializeCatalogCharge(existing) }, { requestId });
    throw new ApiError(422, "value_already_exist", "Charge code already exists");
  }

  const now = new Date().toISOString();
  const id = await nextCatalogChargeId(database, plan.id, code);
  const filters = await normalizeChargeFilters(
    input.filters,
    parseStoredBillableMetricFilters(metric.filters_json),
    chargeModel,
    id,
  );
  const event = catalogEvent(
    "charge.created",
    "charge",
    id,
    1,
    auth.organizationId,
    requestId,
    now,
    { code, planCode },
  );
  try {
    await database.batch([
      database
        .prepare(
          `INSERT INTO charges
       (id, organization_id, plan_id, billable_metric_id, code, invoice_display_name,
        charge_model, properties_json, filters_json, invoiceable, pay_in_advance, prorated,
        min_amount_minor, accepts_target_wallet, version, active, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 1, ?, ?)`,
        )
        .bind(
          id,
          auth.organizationId,
          plan.id,
          metric.id,
          code,
          normalized.invoiceDisplayName,
          chargeModel,
          stableJson(properties),
          stableJson(filters),
          normalized.invoiceable,
          0,
          0,
          normalized.minAmountMinor,
          normalized.acceptsTargetWallet,
          now,
          now,
        ),
      outboxStatement(database, auth.organizationId, event),
    ]);
  } catch (error) {
    const concurrent = await findCatalogCharge(database, plan.id, code);
    if (
      concurrent &&
      sameCatalogCharge(concurrent, metric.id, chargeModel, properties, filters, normalized)
    )
      return json({ charge: serializeCatalogCharge(concurrent) }, { requestId });
    if (concurrent) throw new ApiError(422, "value_already_exist", "Charge code already exists");
    throw error;
  }
  await env.DOMAIN_EVENTS.send(event);
  const created = await findCatalogCharge(database, plan.id, code);
  if (!created) throw new ApiError(500, "persistence_error", "Charge was not persisted");
  return json({ charge: serializeCatalogCharge(created) }, { requestId });
}

async function updateCharge(
  request: Request,
  planCode: string,
  chargeCode: string,
  env: Env,
  auth: AuthContext,
  requestId: string,
): Promise<Response> {
  const database = env.BILLING_DB;
  const plan = await findPlanId(database, auth.organizationId, planCode);
  if (!plan) throw new ApiError(404, "plan_not_found", "Plan was not found");
  assertCatalogPlanMutationAvailable(plan);
  const charge = await findCatalogCharge(database, plan.id, chargeCode);
  if (!charge) throw new ApiError(404, "charge_not_found", "Charge was not found");

  const input = objectAt(await parseJsonObject(request), "charge");
  rejectUnsupportedChargeInput(input);
  if (booleanInteger(input.pay_in_advance, charge.pay_in_advance === 1) === 1)
    throw new ApiError(
      422,
      "unsupported_charge_feature",
      "Pay-in-advance usage charges are not implemented",
    );
  if (booleanInteger(input.prorated, charge.prorated === 1) === 1)
    throw new ApiError(
      422,
      "unsupported_charge_feature",
      "Prorated usage charges are not implemented",
    );

  const attached = await database
    .prepare("SELECT id FROM subscriptions WHERE plan_id = ? LIMIT 1")
    .bind(plan.id)
    .first();
  const nextCode =
    attached || input.code === undefined ? charge.code : requiredString(input, "code");
  const nextMetricId =
    attached || input.billable_metric_id === undefined
      ? charge.metric_id
      : requiredString(input, "billable_metric_id");
  const nextChargeModel =
    attached || input.charge_model === undefined
      ? charge.charge_model
      : requiredString(input, "charge_model");
  if (!SUPPORTED_CHARGE_MODELS.has(nextChargeModel))
    throw new ApiError(
      422,
      "unsupported_charge_model",
      `Unsupported charge model: ${nextChargeModel}`,
    );
  const nextProperties =
    input.properties === undefined
      ? parseStoredObject(charge.properties_json)
      : optionalObject(input.properties, "properties");
  parseChargeModel(nextChargeModel, nextProperties);
  const next = {
    code: nextCode,
    metricId: nextMetricId,
    invoiceDisplayName:
      input.invoice_display_name === undefined
        ? charge.invoice_display_name
        : optionalString(input, "invoice_display_name"),
    chargeModel: nextChargeModel,
    properties: nextProperties,
    invoiceable:
      attached || input.invoiceable === undefined
        ? charge.invoiceable
        : booleanInteger(input.invoiceable, charge.invoiceable === 1),
    minAmountMinor:
      attached || input.min_amount_cents === undefined
        ? charge.min_amount_minor
        : optionalNonNegativeInteger(input.min_amount_cents, charge.min_amount_minor),
    acceptsTargetWallet:
      input.accepts_target_wallet === undefined
        ? charge.accepts_target_wallet
        : booleanInteger(input.accepts_target_wallet, charge.accepts_target_wallet === 1),
  };
  const metric = await database
    .prepare(
      `SELECT id, aggregation_type, filters_json FROM billable_metrics
       WHERE organization_id = ? AND id = ? AND active = 1 LIMIT 1`,
    )
    .bind(auth.organizationId, next.metricId)
    .first<{ id: string; aggregation_type: string; filters_json: string }>();
  if (!metric)
    throw new ApiError(404, "billable_metric_not_found", "Billable metric was not found");
  const nextFilters =
    input.filters === undefined
      ? parseStoredChargeFilters(
          charge.filters_json,
          parseStoredBillableMetricFilters(metric.filters_json),
          nextChargeModel,
          charge.id,
        )
      : await normalizeChargeFilters(
          input.filters,
          parseStoredBillableMetricFilters(metric.filters_json),
          nextChargeModel,
          charge.id,
        );
  if (next.code !== charge.code) {
    const duplicate = await findCatalogCharge(database, plan.id, next.code);
    if (duplicate) throw new ApiError(422, "value_already_exist", "Charge code already exists");
  }
  if (
    sameCatalogCharge(charge, next.metricId, next.chargeModel, next.properties, nextFilters, next)
  )
    return json({ charge: serializeCatalogCharge(charge) }, { requestId });

  const now = new Date().toISOString();
  const event = catalogEvent(
    "charge.updated",
    "charge",
    charge.id,
    charge.version + 1,
    auth.organizationId,
    requestId,
    now,
    { code: next.code, planCode },
  );
  try {
    const results = await database.batch([
      database
        .prepare(
          `UPDATE charges SET billable_metric_id = ?, code = ?, invoice_display_name = ?,
           charge_model = ?, properties_json = ?, filters_json = ?, invoiceable = ?, min_amount_minor = ?,
           accepts_target_wallet = ?, version = version + 1, updated_at = ?
           WHERE id = ? AND organization_id = ? AND plan_id = ? AND active = 1 AND version = ?`,
        )
        .bind(
          next.metricId,
          next.code,
          next.invoiceDisplayName,
          next.chargeModel,
          stableJson(next.properties),
          stableJson(nextFilters),
          next.invoiceable,
          next.minAmountMinor,
          next.acceptsTargetWallet,
          now,
          charge.id,
          auth.organizationId,
          plan.id,
          charge.version,
        ),
      conditionalChargeOutboxStatement(
        database,
        auth.organizationId,
        event,
        charge.id,
        charge.version + 1,
        now,
        1,
      ),
    ]);
    if ((results[0]?.meta.changes ?? 0) < 1 || results[1]?.meta.changes !== 1)
      throw new ApiError(409, "charge_version_conflict", "Charge changed concurrently");
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError(422, "value_already_exist", "Charge code already exists");
  }
  await env.DOMAIN_EVENTS.send(event);
  const updated = await findCatalogCharge(database, plan.id, next.code);
  if (!updated) throw new ApiError(500, "persistence_error", "Charge disappeared");
  return json({ charge: serializeCatalogCharge(updated) }, { requestId });
}

async function deleteCharge(
  request: Request,
  planCode: string,
  chargeCode: string,
  env: Env,
  auth: AuthContext,
  requestId: string,
): Promise<Response> {
  const database = env.BILLING_DB;
  const plan = await findPlanId(database, auth.organizationId, planCode);
  if (!plan) throw new ApiError(404, "plan_not_found", "Plan was not found");
  assertCatalogPlanMutationAvailable(plan);
  const charge = await findCatalogCharge(database, plan.id, chargeCode);
  if (!charge) throw new ApiError(404, "charge_not_found", "Charge was not found");
  if (request.body !== null) {
    const body = await parseJsonObject(request);
    const input = objectAt(body, "charge");
    rejectUnsupportedChargeInput(input);
  }

  const now = new Date().toISOString();
  const event = catalogEvent(
    "charge.deleted",
    "charge",
    charge.id,
    charge.version + 1,
    auth.organizationId,
    requestId,
    now,
    { code: charge.code, planCode },
  );
  const results = await database.batch([
    database
      .prepare(
        `UPDATE charges SET active = 0, version = version + 1, updated_at = ?
         WHERE id = ? AND organization_id = ? AND plan_id = ? AND active = 1 AND version = ?`,
      )
      .bind(now, charge.id, auth.organizationId, plan.id, charge.version),
    conditionalChargeOutboxStatement(
      database,
      auth.organizationId,
      event,
      charge.id,
      charge.version + 1,
      now,
      0,
    ),
  ]);
  if ((results[0]?.meta.changes ?? 0) < 1 || results[1]?.meta.changes !== 1)
    throw new ApiError(409, "charge_version_conflict", "Charge changed concurrently");
  await env.DOMAIN_EVENTS.send(event);
  return json({ charge: serializeCatalogCharge(charge) }, { requestId });
}

async function listCharges(
  planCode: string,
  url: URL,
  database: D1Database,
  auth: AuthContext,
  requestId: string,
): Promise<Response> {
  const plan = await findPlanId(database, auth.organizationId, planCode);
  if (!plan) throw new ApiError(404, "plan_not_found", "Plan was not found");
  const page = positiveInteger(url.searchParams.get("page"), 1);
  const perPage = Math.min(positiveInteger(url.searchParams.get("per_page"), 20), 100);
  const offset = (page - 1) * perPage;
  const count = await database
    .prepare("SELECT COUNT(*) AS total FROM charges WHERE plan_id = ? AND active = 1")
    .bind(plan.id)
    .first<{ total: number }>();
  const result = await database
    .prepare(`${chargeSelect()} WHERE ch.plan_id = ? AND ch.active = 1
              ORDER BY ch.created_at DESC, ch.id DESC LIMIT ? OFFSET ?`)
    .bind(plan.id, perPage, offset)
    .all<CatalogChargeRow>();
  return json(
    {
      charges: result.results.map(serializeCatalogCharge),
      meta: pagination(count?.total ?? 0, page, perPage),
    },
    { requestId },
  );
}

async function showCharge(
  planCode: string,
  chargeCode: string,
  database: D1Database,
  auth: AuthContext,
  requestId: string,
): Promise<Response> {
  const plan = await findPlanId(database, auth.organizationId, planCode);
  if (!plan) throw new ApiError(404, "plan_not_found", "Plan was not found");
  const charge = await database
    .prepare(`${chargeSelect()} WHERE ch.plan_id = ? AND ch.code = ? AND ch.active = 1 LIMIT 1`)
    .bind(plan.id, chargeCode)
    .first<CatalogChargeRow>();
  if (!charge) throw new ApiError(404, "charge_not_found", "Charge was not found");
  return json({ charge: serializeCatalogCharge(charge) }, { requestId });
}

async function listChargeFilters(
  planCode: string,
  chargeCode: string,
  url: URL,
  database: D1Database,
  auth: AuthContext,
  requestId: string,
): Promise<Response> {
  const charge = await requireCatalogCharge(database, auth.organizationId, planCode, chargeCode);
  const filters = catalogChargeFilters(charge);
  const page = positiveInteger(url.searchParams.get("page"), 1);
  const perPage = Math.min(positiveInteger(url.searchParams.get("per_page"), 20), 100);
  const offset = (page - 1) * perPage;
  return json(
    {
      filters: filters
        .slice(offset, offset + perPage)
        .map((filter) => serializeChargeFilter(filter, charge.code)),
      meta: pagination(filters.length, page, perPage),
    },
    { requestId },
  );
}

async function showChargeFilter(
  planCode: string,
  chargeCode: string,
  filterId: string,
  database: D1Database,
  auth: AuthContext,
  requestId: string,
): Promise<Response> {
  const charge = await requireCatalogCharge(database, auth.organizationId, planCode, chargeCode);
  const filter = requireChargeFilter(charge, filterId);
  return json({ filter: serializeChargeFilter(filter, charge.code) }, { requestId });
}

async function createChargeFilter(
  planCode: string,
  chargeCode: string,
  request: Request,
  env: Env,
  auth: AuthContext,
  requestId: string,
): Promise<Response> {
  const charge = await requireMutableCatalogCharge(
    env.BILLING_DB,
    auth.organizationId,
    planCode,
    chargeCode,
  );
  const input = objectAt(await parseJsonObject(request), "filter");
  rejectChargeFilterCascade(input);
  const filters = catalogChargeFilters(charge);
  const created = (
    await normalizeChargeFilters(
      [input],
      parseStoredBillableMetricFilters(charge.metric_filters_json),
      charge.charge_model,
      charge.id,
      `${charge.id}:v${charge.version + 1}`,
    )
  )[0]!;
  if (filters.some((filter) => stableJson(filter.values) === stableJson(created.values))) {
    throw new ApiError(422, "value_already_exist", "Charge filter values already exist");
  }
  await persistChargeFilters(charge, [...filters, created], planCode, env, auth, requestId);
  return json({ filter: serializeChargeFilter(created, charge.code) }, { requestId });
}

async function updateChargeFilter(
  planCode: string,
  chargeCode: string,
  filterId: string,
  request: Request,
  env: Env,
  auth: AuthContext,
  requestId: string,
): Promise<Response> {
  const charge = await requireMutableCatalogCharge(
    env.BILLING_DB,
    auth.organizationId,
    planCode,
    chargeCode,
  );
  const filters = catalogChargeFilters(charge);
  const current = requireChargeFilter(charge, filterId);
  const input = objectAt(await parseJsonObject(request), "filter");
  rejectChargeFilterCascade(input);
  const normalized = (
    await normalizeChargeFilters(
      [
        {
          invoice_display_name:
            input.invoice_display_name === undefined
              ? current.invoiceDisplayName
              : input.invoice_display_name,
          properties: input.properties === undefined ? current.properties : input.properties,
          values: current.values,
        },
      ],
      parseStoredBillableMetricFilters(charge.metric_filters_json),
      charge.charge_model,
      charge.id,
    )
  )[0]!;
  const updated = { ...normalized, lagoId: current.lagoId };
  const next = filters.map((filter) => (filter.lagoId === filterId ? updated : filter));
  if (stableJson(filters) !== stableJson(next)) {
    await persistChargeFilters(charge, next, planCode, env, auth, requestId);
  }
  return json({ filter: serializeChargeFilter(updated, charge.code) }, { requestId });
}

async function deleteChargeFilter(
  planCode: string,
  chargeCode: string,
  filterId: string,
  env: Env,
  auth: AuthContext,
  requestId: string,
): Promise<Response> {
  const charge = await requireMutableCatalogCharge(
    env.BILLING_DB,
    auth.organizationId,
    planCode,
    chargeCode,
  );
  const filters = catalogChargeFilters(charge);
  const deleted = requireChargeFilter(charge, filterId);
  await persistChargeFilters(
    charge,
    filters.filter((filter) => filter.lagoId !== filterId),
    planCode,
    env,
    auth,
    requestId,
  );
  return json({ filter: serializeChargeFilter(deleted, charge.code) }, { requestId });
}

async function requireCatalogCharge(
  database: D1Database,
  organizationId: string,
  planCode: string,
  chargeCode: string,
): Promise<CatalogChargeRow> {
  const plan = await findPlanId(database, organizationId, planCode);
  if (!plan) throw new ApiError(404, "plan_not_found", "Plan was not found");
  const charge = await findCatalogCharge(database, plan.id, chargeCode);
  if (!charge) throw new ApiError(404, "charge_not_found", "Charge was not found");
  return charge;
}

async function requireMutableCatalogCharge(
  database: D1Database,
  organizationId: string,
  planCode: string,
  chargeCode: string,
): Promise<CatalogChargeRow> {
  const plan = await findPlanId(database, organizationId, planCode);
  if (!plan) throw new ApiError(404, "plan_not_found", "Plan was not found");
  assertCatalogPlanMutationAvailable(plan);
  const charge = await findCatalogCharge(database, plan.id, chargeCode);
  if (!charge) throw new ApiError(404, "charge_not_found", "Charge was not found");
  return charge;
}

function catalogChargeFilters(charge: CatalogChargeRow): ChargeFilter[] {
  return parseStoredChargeFilters(
    charge.filters_json,
    parseStoredBillableMetricFilters(charge.metric_filters_json),
    charge.charge_model,
    charge.id,
  );
}

function requireChargeFilter(charge: CatalogChargeRow, filterId: string): ChargeFilter {
  const filter = catalogChargeFilters(charge).find((candidate) => candidate.lagoId === filterId);
  if (!filter) throw new ApiError(404, "charge_filter_not_found", "Charge filter was not found");
  return filter;
}

async function persistChargeFilters(
  charge: CatalogChargeRow,
  filters: ChargeFilter[],
  planCode: string,
  env: Env,
  auth: AuthContext,
  requestId: string,
): Promise<void> {
  const now = new Date().toISOString();
  const event = catalogEvent(
    "charge.updated",
    "charge",
    charge.id,
    charge.version + 1,
    auth.organizationId,
    requestId,
    now,
    { code: charge.code, planCode },
  );
  const results = await env.BILLING_DB.batch([
    env.BILLING_DB.prepare(
      `UPDATE charges SET filters_json = ?, version = version + 1, updated_at = ?
       WHERE id = ? AND organization_id = ? AND active = 1 AND version = ?`,
    ).bind(stableJson(filters), now, charge.id, auth.organizationId, charge.version),
    conditionalChargeOutboxStatement(
      env.BILLING_DB,
      auth.organizationId,
      event,
      charge.id,
      charge.version + 1,
      now,
      1,
    ),
  ]);
  if ((results[0]?.meta.changes ?? 0) < 1 || results[1]?.meta.changes !== 1) {
    throw new ApiError(409, "charge_version_conflict", "Charge changed concurrently");
  }
  await env.DOMAIN_EVENTS.send(event);
}

function rejectChargeFilterCascade(input: Record<string, unknown>): void {
  if (input.cascade_updates === true) {
    throw new ApiError(
      422,
      "unsupported_charge_feature",
      "Charge filter cascade updates are not implemented",
    );
  }
}

function findPlanId(database: D1Database, organizationId: string, code: string) {
  return database
    .prepare(
      `SELECT id, pending_deletion FROM plans
       WHERE organization_id = ? AND code = ? AND active = 1 AND parent_id IS NULL
       ORDER BY version DESC LIMIT 1`,
    )
    .bind(organizationId, code)
    .first<{ id: string; pending_deletion: number }>();
}

function assertCatalogPlanMutationAvailable(plan: { pending_deletion: number }): void {
  if (plan.pending_deletion === 1) {
    throw new ApiError(
      409,
      "plan_deletion_in_progress",
      "Plan cannot change while asynchronous deletion is in progress",
    );
  }
}

function chargeSelect(): string {
  return `SELECT ch.id, ch.code, ch.invoice_display_name, ch.charge_model,
                 ch.properties_json, ch.filters_json, ch.min_amount_minor, ch.invoiceable,
                 ch.pay_in_advance, ch.prorated, ch.version, ch.created_at, ch.updated_at,
                 ch.accepts_target_wallet,
                 bm.id AS metric_id, bm.code AS metric_code, bm.name AS metric_name,
                 bm.aggregation_type, bm.field_name, bm.filters_json AS metric_filters_json
          FROM charges ch JOIN billable_metrics bm ON bm.id = ch.billable_metric_id`;
}

function findCatalogCharge(database: D1Database, planId: string, code: string) {
  return database
    .prepare(`${chargeSelect()} WHERE ch.plan_id = ? AND ch.code = ? AND ch.active = 1 LIMIT 1`)
    .bind(planId, code)
    .first<CatalogChargeRow>();
}

async function nextCatalogChargeId(
  database: D1Database,
  planId: string,
  code: string,
): Promise<string> {
  for (let generation = 1; generation <= 100; generation += 1) {
    const seed = generation === 1 ? `${planId}:${code}` : `${planId}:${code}:${generation}`;
    const id = await deterministicUuid("charge", seed);
    const existing = await database
      .prepare("SELECT id FROM charges WHERE id = ? LIMIT 1")
      .bind(id)
      .first<{ id: string }>();
    if (!existing) return id;
  }
  throw new ApiError(409, "charge_generation_conflict", "Charge code has too many generations");
}

function sameCatalogCharge(
  charge: CatalogChargeRow,
  metricId: string,
  chargeModel: string,
  properties: Record<string, unknown>,
  filters: ChargeFilter[],
  normalized: {
    invoiceDisplayName: string | null;
    invoiceable: number;
    minAmountMinor: number;
    acceptsTargetWallet: number;
  },
): boolean {
  return (
    charge.metric_id === metricId &&
    charge.invoice_display_name === normalized.invoiceDisplayName &&
    charge.charge_model === chargeModel &&
    stableJson(parseStoredObject(charge.properties_json)) === stableJson(properties) &&
    stableJson(
      parseStoredChargeFilters(
        charge.filters_json,
        parseStoredBillableMetricFilters(charge.metric_filters_json),
        charge.charge_model,
        charge.id,
      ),
    ) === stableJson(filters) &&
    charge.invoiceable === normalized.invoiceable &&
    charge.pay_in_advance === 0 &&
    charge.prorated === 0 &&
    charge.min_amount_minor === normalized.minAmountMinor &&
    charge.accepts_target_wallet === normalized.acceptsTargetWallet
  );
}

function serializeCatalogCharge(charge: CatalogChargeRow): Record<string, unknown> {
  return {
    lago_id: charge.id,
    lago_billable_metric_id: charge.metric_id,
    code: charge.code,
    invoice_display_name: charge.invoice_display_name,
    billable_metric_code: charge.metric_code,
    created_at: charge.created_at,
    charge_model: charge.charge_model,
    invoiceable: charge.invoiceable === 1,
    pay_in_advance: charge.pay_in_advance === 1,
    prorated: charge.prorated === 1,
    min_amount_cents: charge.min_amount_minor,
    accepts_target_wallet: charge.accepts_target_wallet === 1,
    properties: parseStoredObject(charge.properties_json),
    filters: parseStoredChargeFilters(
      charge.filters_json,
      parseStoredBillableMetricFilters(charge.metric_filters_json),
      charge.charge_model,
      charge.id,
    ).map((filter) => serializeChargeFilter(filter, charge.code)),
    taxes: [],
    applied_pricing_unit: null,
    lago_parent_id: null,
  };
}

async function createUsageEventBatch(
  request: Request,
  env: Env,
  auth: AuthContext,
  requestId: string,
): Promise<Response> {
  const body = await parseJsonObject(request);
  const rawEvents = body.events;
  if (!Array.isArray(rawEvents) || rawEvents.length === 0) {
    throw new ApiError(422, "no_events", "events must contain at least one event", {
      events: ["no_events"],
    });
  }
  if (rawEvents.length > 100) {
    throw new ApiError(422, "too_many_events", "events cannot contain more than 100 events", {
      events: ["too_many_events"],
    });
  }

  const errors: Record<string, unknown> = {};
  const inputs: EventInput[] = [];
  const seen = new Set<string>();
  for (const [index, value] of rawEvents.entries()) {
    try {
      if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw new ApiError(422, "validation_error", "event must be an object");
      }
      const input = normalizeEventInput(value as Record<string, unknown>);
      const duplicateKey = `${input.externalSubscriptionId}\u0000${input.transactionId}`;
      if (seen.has(duplicateKey)) {
        throw new ApiError(
          422,
          "value_already_exist",
          "transaction_id is duplicated in this batch",
        );
      }
      seen.add(duplicateKey);
      inputs.push(input);
    } catch (error) {
      errors[String(index)] = batchErrorDetail(error);
    }
  }
  if (Object.keys(errors).length > 0) {
    throw new ApiError(422, "batch_validation_error", "One or more events are invalid", errors);
  }

  const createdAt = new Date().toISOString();
  const prepared: PreparedBatchEvent[] = [];
  for (const [index, input] of inputs.entries()) {
    try {
      prepared.push(await prepareBatchEvent(env, auth, requestId, input, createdAt));
    } catch (error) {
      errors[String(index)] = batchErrorDetail(error);
    }
  }
  if (Object.keys(errors).length > 0) {
    throw new ApiError(422, "batch_validation_error", "One or more events are invalid", errors);
  }

  const archiveResults = await Promise.allSettled(
    prepared.map((event) =>
      env.BILLING_ARTIFACTS.put(event.archiveKey, stableJson({ event: event.normalized }), {
        httpMetadata: { contentType: "application/json" },
        customMetadata: { sha256: event.requestHash, schema: "lago-event-v1" },
      }),
    ),
  );
  if (archiveResults.some((result) => result.status === "rejected")) {
    await cleanupUncommittedBatchArchives(env, prepared);
    throw new ApiError(
      503,
      "event_archive_failed",
      "One or more event archives could not be stored",
    );
  }

  try {
    await env.BILLING_DB.batch(
      prepared.flatMap((event) => batchEventStatements(env.BILLING_DB, auth, requestId, event)),
    );
  } catch (error) {
    await cleanupUncommittedBatchArchives(env, prepared);
    const conflicts = await Promise.all(
      prepared.map((event) =>
        findEvent(
          env.BILLING_DB,
          auth.organizationId,
          event.input.externalSubscriptionId,
          event.input.transactionId,
        ),
      ),
    );
    if (conflicts.some(Boolean)) {
      throw new ApiError(
        409,
        "batch_event_conflict",
        "An event transaction_id was created concurrently; retry with a new batch",
      );
    }
    throw error;
  }

  await Promise.all(
    prepared
      .flatMap((event) =>
        [event.domainEvent, event.targetWalletError].filter(
          (candidate): candidate is DomainEvent => candidate !== null,
        ),
      )
      .map((event) => env.DOMAIN_EVENTS.send(event)),
  );
  return json({ events: prepared.map((event) => serializeEvent(event.row)) }, { requestId });
}

async function prepareBatchEvent(
  env: Env,
  auth: AuthContext,
  requestId: string,
  input: EventInput,
  createdAt: string,
): Promise<PreparedBatchEvent> {
  const context = await findEventContext(env.BILLING_DB, auth.organizationId, input);
  if (!context) {
    const metric = await findMetric(env.BILLING_DB, auth.organizationId, input.code);
    throw metric
      ? new ApiError(404, "subscription_not_found", "Subscription was not found")
      : new ApiError(404, "billable_metric_not_found", "Billable metric was not found");
  }
  input = applyMetricExpression(input, context);
  validateAggregationProperties(context.aggregation_type, context.field_name, input.properties);
  const normalized = normalizedEvent(input);
  const requestHash = await sha256Hex(stableJson(normalized));
  const existing = await findEvent(
    env.BILLING_DB,
    auth.organizationId,
    input.externalSubscriptionId,
    input.transactionId,
  );
  if (existing) {
    throw new ApiError(
      422,
      "value_already_exist",
      "transaction_id already exists for this subscription",
    );
  }
  const id = await deterministicUuid(
    "usage-event",
    `${auth.organizationId}:${context.subscription_id}:${input.transactionId}`,
  );
  const archiveKey = `usage-events/${auth.organizationId}/${input.timestamp.slice(0, 10)}/${id}/${requestHash}.json`;
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
  const targetWalletError = await targetWalletErrorEvent(
    env.BILLING_DB,
    auth.organizationId,
    context,
    row,
    input,
    requestId,
  );
  return {
    input,
    context,
    normalized,
    requestHash,
    archiveKey,
    row,
    domainEvent: eventDomainMessage(row, auth.organizationId, requestId),
    targetWalletError,
  };
}

function batchEventStatements(
  database: D1Database,
  auth: AuthContext,
  requestId: string,
  event: PreparedBatchEvent,
): D1PreparedStatement[] {
  const statements = [
    database
      .prepare(
        `INSERT INTO usage_events
         (id, organization_id, subscription_id, customer_id, billable_metric_id,
          transaction_id, code, timestamp, timestamp_ms, precise_total_amount_minor,
          properties_json, request_sha256, archive_key, created_at, external_subscription_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        event.row.id,
        auth.organizationId,
        event.context.subscription_id,
        event.context.customer_id,
        event.context.metric_id,
        event.input.transactionId,
        event.input.code,
        event.input.timestamp,
        event.input.timestampMs,
        event.input.preciseTotalAmountMinor,
        event.row.properties_json,
        event.requestHash,
        event.archiveKey,
        event.row.created_at,
        event.input.externalSubscriptionId,
      ),
    database
      .prepare(
        `INSERT INTO outbox_events
         (event_id, organization_id, event_type, event_version, aggregate_type,
          aggregate_id, aggregate_version, causation_id, correlation_id, payload_json,
          occurred_at, published_at)
         VALUES (?, ?, ?, 1, 'usage_event', ?, 1, ?, ?, ?, ?, NULL)`,
      )
      .bind(
        event.domainEvent.id,
        auth.organizationId,
        event.domainEvent.type,
        event.row.id,
        requestId,
        requestId,
        stableJson(event.domainEvent.payload),
        event.row.created_at,
      ),
  ];
  if (event.targetWalletError)
    statements.push(eventOutboxStatement(database, auth.organizationId, event.targetWalletError));
  return statements;
}

async function cleanupUncommittedBatchArchives(
  env: Env,
  events: PreparedBatchEvent[],
): Promise<void> {
  await Promise.allSettled(
    events.map(async (event) => {
      const committed = await env.BILLING_DB.prepare(
        "SELECT archive_key FROM usage_events WHERE id = ? LIMIT 1",
      )
        .bind(event.row.id)
        .first<{ archive_key: string }>();
      if (committed?.archive_key === event.archiveKey) return;
      await env.BILLING_ARTIFACTS.delete(event.archiveKey);
    }),
  );
}

function batchErrorDetail(error: unknown): Record<string, string> {
  if (error instanceof ApiError) return { code: error.code, message: error.message };
  return { code: "validation_error", message: "Event is invalid" };
}

async function createUsageEvent(
  request: Request,
  env: Env,
  auth: AuthContext,
  requestId: string,
): Promise<Response> {
  const body = await parseJsonObject(request);
  let input = normalizeEventInput(objectAt(body, "event"));
  const context = await findEventContext(env.BILLING_DB, auth.organizationId, input);
  if (!context) {
    const metric = await findMetric(env.BILLING_DB, auth.organizationId, input.code);
    throw metric
      ? new ApiError(404, "subscription_not_found", "Subscription was not found")
      : new ApiError(404, "billable_metric_not_found", "Billable metric was not found");
  }
  input = applyMetricExpression(input, context);
  validateAggregationProperties(context.aggregation_type, context.field_name, input.properties);

  const normalized = normalizedEvent(input);
  const requestHash = await sha256Hex(stableJson(normalized));
  const existing = await findEvent(
    env.BILLING_DB,
    auth.organizationId,
    input.externalSubscriptionId,
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
  const targetWalletError = await targetWalletErrorEvent(
    env.BILLING_DB,
    auth.organizationId,
    context,
    row,
    input,
    requestId,
  );
  try {
    await env.BILLING_DB.batch([
      env.BILLING_DB.prepare(
        `INSERT INTO usage_events
         (id, organization_id, subscription_id, customer_id, billable_metric_id,
          transaction_id, code, timestamp, timestamp_ms, precise_total_amount_minor,
          properties_json, request_sha256, archive_key, created_at, external_subscription_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
        input.externalSubscriptionId,
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
      ...(targetWalletError
        ? [eventOutboxStatement(env.BILLING_DB, auth.organizationId, targetWalletError)]
        : []),
      env.BILLING_DB.prepare(
        `UPDATE invoices SET ready_to_be_refreshed = 1, updated_at = ?
         WHERE status = 'draft' AND organization_id = ? AND subscription_id = ?
           AND id IN (
             SELECT invoice_id FROM billing_cycles
             WHERE subscription_id = ? AND invoice_id IS NOT NULL
               AND period_start_ms <= ? AND period_end_ms > ?
           )`,
      ).bind(
        createdAt,
        auth.organizationId,
        context.subscription_id,
        context.subscription_id,
        input.timestampMs,
        input.timestampMs,
      ),
    ]);
  } catch (error) {
    const concurrent = await findEvent(
      env.BILLING_DB,
      auth.organizationId,
      input.externalSubscriptionId,
      input.transactionId,
    );
    if (!concurrent) throw error;
    assertEventReplay(concurrent, requestHash);
    await env.DOMAIN_EVENTS.send(eventDomainMessage(concurrent, auth.organizationId, requestId));
    return json({ event: serializeEvent(concurrent) }, { requestId });
  }
  await env.DOMAIN_EVENTS.send(domainEvent);
  if (targetWalletError) await env.DOMAIN_EVENTS.send(targetWalletError);
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
       WHERE ue.organization_id = ? AND ue.transaction_id = ? AND ue.deleted_at IS NULL
         AND EXISTS (SELECT 1 FROM billable_metrics metric
                     WHERE metric.id = ue.billable_metric_id AND metric.active = 1)
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
  const filters = [
    "ue.organization_id = ?",
    "ue.deleted_at IS NULL",
    `EXISTS (SELECT 1 FROM billable_metrics metric
             WHERE metric.id = ue.billable_metric_id AND metric.active = 1)`,
  ];
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
              s.current_period_end, s.organization_id, s.billing_time, s.billing_timezone,
              p.currency, p.interval
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
              ch.properties_json, ch.filters_json, ch.min_amount_minor, ch.accepts_target_wallet,
              bm.id AS metric_id,
              bm.code AS metric_code, bm.name AS metric_name,
              bm.aggregation_type, bm.field_name, bm.recurring, bm.weighted_interval,
              bm.rounding_function, bm.rounding_precision,
              bm.filters_json AS metric_filters_json
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
    const aggregationType = supportedAggregation(charge.aggregation_type);
    assertStoredWeightedConfiguration(aggregationType, charge.weighted_interval);
    const filters = parseStoredChargeFilters(
      charge.filters_json,
      parseStoredBillableMetricFilters(charge.metric_filters_json),
      charge.charge_model,
      charge.id,
    );
    const periodStartMs = Date.parse(subscription.current_period_start);
    const periodEndMs = Date.parse(subscription.current_period_end);
    const initialValues =
      aggregationType === "weighted_sum_agg" && charge.recurring === 1
        ? await recurringWeightedBaseline(
            database,
            subscription.organization_id,
            subscription.external_id,
            charge.metric_id,
            charge.field_name,
            periodStartMs,
            filters,
            charge.accepts_target_wallet === 1,
          )
        : zeroWeightedBaselines(filters);
    const partitions = partitionUsageEvents(events, filters);
    const ratePartition = (
      partitionEvents: typeof events,
      properties: Record<string, unknown>,
      initialValue: Decimal,
    ) => {
      const aggregation = aggregateUsageResult(
        aggregationType,
        charge.field_name,
        partitionEvents,
        {
          periodStartMs,
          periodEndMs,
          periodDurationDays:
            aggregationType === "weighted_sum_agg"
              ? billingPeriodDurationDays(
                  new Date(periodStartMs),
                  new Date(periodEndMs),
                  subscription.billing_time,
                  subscription.interval,
                  subscription.billing_timezone,
                )
              : undefined,
          initialValue,
        },
      );
      const units = applyAggregationRounding(
        aggregation.units,
        charge.rounding_function,
        charge.rounding_precision,
      );
      const amount = Decimal.parse(
        rateCharge(units.toString(), parseChargeModel(charge.charge_model, properties), {
          eventsCount: partitionEvents.length,
        }).amountCents,
      );
      return { aggregation, amount, events: partitionEvents, units };
    };
    const rateTargetGroups = (
      partitionEvents: typeof events,
      properties: Record<string, unknown>,
      initialValues: WeightedTargetBaselines,
    ) => {
      const rated = targetWalletUsageEventGroups(
        partitionEvents,
        charge.accepts_target_wallet === 1,
        initialValues.keys(),
      ).map(({ targetWalletCode, events: groupEvents }) =>
        ratePartition(
          groupEvents,
          properties,
          initialValues.get(targetWalletCode) ?? Decimal.zero(),
        ),
      );
      return {
        amount: rated.reduce((sum, group) => sum.add(group.amount), Decimal.zero()),
        events: partitionEvents,
        totalAggregatedUnits: rated.reduce(
          (sum, group) => sum.add(group.aggregation.totalAggregatedUnits),
          Decimal.zero(),
        ),
        units: rated.reduce((sum, group) => sum.add(group.units), Decimal.zero()),
      };
    };
    const base = rateTargetGroups(
      partitions.base,
      parseStoredObject(charge.properties_json),
      initialValues.base,
    );
    const ratedFilters = partitions.filters.map(({ filter, events: filterEvents }) => ({
      filter,
      ...rateTargetGroups(
        filterEvents,
        filter.properties,
        initialValues.filters.get(filter.lagoId) ?? new Map(),
      ),
    }));
    const units = ratedFilters.reduce((sum, filter) => sum.add(filter.units), base.units);
    const totalAggregatedUnits = ratedFilters.reduce(
      (sum, filter) => sum.add(filter.totalAggregatedUnits),
      base.totalAggregatedUnits,
    );
    const amount = ratedFilters.reduce((sum, filter) => sum.add(filter.amount), base.amount);
    total = total.add(amount);
    chargeUsage.push({
      units: units.toString(),
      total_aggregated_units: totalAggregatedUnits.toString(),
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
      filters: ratedFilters.map((filter) => ({
        units: filter.units.toString(),
        total_aggregated_units: filter.totalAggregatedUnits.toString(),
        events_count: filter.events.length,
        amount_cents: jsonDecimal(filter.amount),
        pricing_unit_details: null,
        invoice_display_name: filter.filter.invoiceDisplayName,
        values: filter.filter.values,
      })),
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
         AND deleted_at IS NULL
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

function targetWalletUsageEventGroups<T extends { properties: Record<string, unknown> }>(
  events: T[],
  acceptsTargetWallet: boolean,
  baselineCodes: Iterable<string | null> = [],
): Array<{ targetWalletCode: string | null; events: T[] }> {
  if (!acceptsTargetWallet) return [{ targetWalletCode: null, events }];
  const groups = new Map<string | null, T[]>();
  for (const code of baselineCodes) groups.set(code, []);
  for (const event of events) {
    const value = event.properties.target_wallet_code;
    const code = typeof value === "string" && value.trim() ? value.trim() : null;
    const grouped = groups.get(code) ?? [];
    grouped.push(event);
    groups.set(code, grouped);
  }
  if (groups.size === 0) groups.set(null, []);
  return [...groups.entries()]
    .sort(([left], [right]) => {
      if (left === right) return 0;
      if (left === null) return -1;
      if (right === null) return 1;
      return left.localeCompare(right);
    })
    .map(([targetWalletCode, grouped]) => ({ targetWalletCode, events: grouped }));
}

type WeightedTargetBaselines = Map<string | null, Decimal>;

type WeightedBaselines = {
  base: WeightedTargetBaselines;
  filters: Map<string, WeightedTargetBaselines>;
};

function zeroWeightedBaselines(filters: ChargeFilter[]): WeightedBaselines {
  return {
    base: new Map(),
    filters: new Map(filters.map((filter) => [filter.lagoId, new Map()])),
  };
}

async function recurringWeightedBaseline(
  database: D1Database,
  organizationId: string,
  externalSubscriptionId: string,
  metricId: string,
  fieldName: string | null,
  periodStartMs: number,
  filters: ChargeFilter[],
  acceptsTargetWallet: boolean,
): Promise<WeightedBaselines> {
  if (!fieldName) throw new ApiError(500, "invalid_metric", "Metric field_name is missing");
  const result = await database
    .prepare(
      `SELECT id, timestamp_ms, properties_json FROM usage_events
       WHERE organization_id = ? AND external_subscription_id = ? AND billable_metric_id = ?
         AND deleted_at IS NULL AND timestamp_ms < ?
       ORDER BY timestamp_ms, id LIMIT 10001`,
    )
    .bind(organizationId, externalSubscriptionId, metricId, periodStartMs)
    .all<{ id: string; timestamp_ms: number; properties_json: string }>();
  if (result.results.length > 10000) {
    throw new ApiError(
      503,
      "usage_baseline_too_large",
      "Recurring usage requires asynchronous aggregation",
    );
  }
  const events = result.results.map((event) => ({
    id: event.id,
    timestampMs: event.timestamp_ms,
    properties: parseStoredObject(event.properties_json),
  }));
  const partitions = partitionUsageEvents(events, filters);
  const sumGroups = (partitionEvents: typeof events): WeightedTargetBaselines => {
    if (acceptsTargetWallet && partitionEvents.length === 0) return new Map();
    return new Map(
      targetWalletUsageEventGroups(partitionEvents, acceptsTargetWallet).map(
        ({ targetWalletCode, events: groupEvents }) => [
          targetWalletCode,
          groupEvents.reduce(
            (total, event) =>
              total.add(
                Decimal.parse(validateDecimalValue(event.properties[fieldName], fieldName)),
              ),
            Decimal.zero(),
          ),
        ],
      ),
    );
  };
  return {
    base: sumGroups(partitions.base),
    filters: new Map(
      partitions.filters.map(({ filter, events: filterEvents }) => [
        filter.lagoId,
        sumGroups(filterEvents),
      ]),
    ),
  };
}

async function findEventContext(
  database: D1Database,
  organizationId: string,
  input: EventInput,
): Promise<EventContext | null> {
  return database
    .prepare(
      `SELECT s.id AS subscription_id, s.customer_id, bm.id AS metric_id,
              bm.aggregation_type, bm.field_name, bm.expression,
              EXISTS(SELECT 1 FROM charges charge
                     WHERE charge.plan_id = s.plan_id
                       AND charge.billable_metric_id = bm.id AND charge.active = 1
                       AND charge.accepts_target_wallet = 1) AS accepts_target_wallet
       FROM subscriptions s
       JOIN billable_metrics bm
         ON bm.organization_id = s.organization_id AND bm.code = ? AND bm.active = 1
       WHERE s.organization_id = ? AND s.external_id = ?
         AND s.status IN ('active', 'past_due', 'terminated')
         AND (s.started_at IS NULL OR s.started_at <= ?)
         AND (s.terminated_at IS NULL OR s.terminated_at > ?)
       ORDER BY s.generation DESC LIMIT 1`,
    )
    .bind(
      input.code,
      organizationId,
      input.externalSubscriptionId,
      input.timestamp,
      input.timestamp,
    )
    .first<EventContext>();
}

function normalizedEvent(input: EventInput): Record<string, unknown> {
  return {
    transactionId: input.transactionId,
    code: input.code,
    externalSubscriptionId: input.externalSubscriptionId,
    timestamp: input.timestamp,
    preciseTotalAmountMinor: input.preciseTotalAmountMinor,
    properties: input.properties,
  };
}

function applyMetricExpression(input: EventInput, context: EventContext): EventInput {
  if (!context.expression) return input;
  if (!context.field_name) {
    throw new ApiError(500, "invalid_metric", "Expression metric field_name is missing");
  }
  try {
    const value = evaluateUsageExpression(context.expression, {
      code: input.code,
      timestamp: Math.trunc(input.timestampMs / 1000),
      properties: input.properties,
    });
    return {
      ...input,
      properties: { ...input.properties, [context.field_name]: value },
    };
  } catch (error) {
    throw expressionApiError(error);
  }
}

function expressionApiError(error: unknown): ApiError {
  if (error instanceof UsageExpressionError) {
    return new ApiError(422, error.code, error.message);
  }
  return new ApiError(422, "expression_evaluation_failed", "Expression could not be evaluated");
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
  const properties = optionalObject(input.properties, "properties");
  if (properties.target_wallet_code !== undefined) {
    if (typeof properties.target_wallet_code !== "string" || !properties.target_wallet_code.trim())
      throw new ApiError(422, "validation_error", "target_wallet_code must be a non-empty string");
    properties.target_wallet_code = properties.target_wallet_code.trim();
  }
  return {
    transactionId: requiredString(input, "transaction_id"),
    code: requiredString(input, "code"),
    externalSubscriptionId: requiredString(input, "external_subscription_id"),
    timestamp: timestamp.toISOString(),
    timestampMs,
    preciseTotalAmountMinor,
    properties,
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
              rounding_function, rounding_precision, weighted_interval, expression, filters_json, version,
              created_at, updated_at
       FROM billable_metrics
       WHERE organization_id = ? AND code = ? AND active = 1 LIMIT 1`,
    )
    .bind(organizationId, code)
    .first<MetricRow>();
}

async function nextMetricIdentity(
  database: D1Database,
  organizationId: string,
  code: string,
): Promise<{ id: string; version: number }> {
  const prior = await database
    .prepare(
      `SELECT COALESCE(MAX(version), 0) AS version
       FROM billable_metrics WHERE organization_id = ? AND code = ?`,
    )
    .bind(organizationId, code)
    .first<{ version: number }>();
  const version = (prior?.version ?? 0) + 1;
  for (let generation = 1; generation <= 100; generation += 1) {
    const seed =
      generation === 1 ? `${organizationId}:${code}` : `${organizationId}:${code}:${generation}`;
    const id = await deterministicUuid("billable-metric", seed);
    const existing = await database
      .prepare("SELECT id FROM billable_metrics WHERE id = ? LIMIT 1")
      .bind(id)
      .first<{ id: string }>();
    if (!existing) return { id, version };
  }
  throw new ApiError(
    409,
    "billable_metric_generation_conflict",
    "Billable metric code has too many generations",
  );
}

async function findEvent(
  database: D1Database,
  organizationId: string,
  externalSubscriptionId: string,
  transactionId: string,
): Promise<EventRow | null> {
  return database
    .prepare(
      `SELECT ue.id, ue.transaction_id, ue.customer_id, ue.subscription_id,
              COALESCE(ue.external_subscription_id, s.external_id) AS external_subscription_id,
              ue.code, ue.timestamp,
              ue.timestamp_ms, ue.precise_total_amount_minor, ue.properties_json,
              ue.request_sha256, ue.created_at
       FROM usage_events ue JOIN subscriptions s ON s.id = ue.subscription_id
       WHERE ue.organization_id = ?
         AND COALESCE(ue.external_subscription_id, s.external_id) = ?
         AND ue.transaction_id = ? LIMIT 1`,
    )
    .bind(organizationId, externalSubscriptionId, transactionId)
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
    filters: parseStoredBillableMetricFilters(metric.filters_json),
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

async function targetWalletErrorEvent(
  database: D1Database,
  organizationId: string,
  context: EventContext,
  event: EventRow,
  input: EventInput,
  correlationId: string,
): Promise<DomainEvent | null> {
  const targetWalletCode = input.properties.target_wallet_code;
  if (context.accepts_target_wallet !== 1 || typeof targetWalletCode !== "string") return null;
  const wallet = await database
    .prepare(
      `SELECT id FROM wallets
       WHERE organization_id = ? AND customer_id = ? AND code = ? AND status = 'active'
       LIMIT 1`,
    )
    .bind(organizationId, context.customer_id, targetWalletCode)
    .first<{ id: string }>();
  if (wallet) return null;
  return {
    id: `usage-event-target-wallet-error:${event.id}`,
    type: "event.error",
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
      transactionId: event.transaction_id,
      targetWalletCode,
      error: { target_wallet_code: ["target_wallet_code_not_found"] },
    },
  };
}

function eventOutboxStatement(
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

type NormalizedMetric = {
  code: string;
  name: string;
  description: string | null;
  aggregationType: SupportedAggregationType;
  fieldName: string | null;
  recurring: 0 | 1;
  weightedInterval: "seconds" | null;
  expression: string | null;
  roundingFunction: AggregationRoundingFunction | null;
  roundingPrecision: number | null;
  filters: BillableMetricFilter[];
};

function normalizeMetricInput(input: Record<string, unknown>): NormalizedMetric {
  const aggregationType = supportedMetricAggregation(input.aggregation_type);
  const fieldName = optionalString(input, "field_name");
  const recurring = booleanInteger(input.recurring, false);
  const weightedInterval = normalizeWeightedInterval(input.weighted_interval);
  const expression = optionalString(input, "expression");
  const roundingFunction = normalizeRoundingFunction(input.rounding_function);
  const roundingPrecision = normalizeRoundingPrecision(input.rounding_precision);
  const filters = normalizeBillableMetricFilters(input.filters);
  validateMetricConfiguration(aggregationType, fieldName, expression, recurring, weightedInterval);
  return {
    code: requiredString(input, "code"),
    name: requiredString(input, "name"),
    description: optionalString(input, "description"),
    aggregationType,
    fieldName,
    recurring,
    weightedInterval,
    expression,
    roundingFunction,
    roundingPrecision,
    filters,
  };
}

function supportedMetricAggregation(value: unknown): SupportedAggregationType {
  if (typeof value !== "string" || !SUPPORTED_AGGREGATIONS.has(value as SupportedAggregationType))
    throw new ApiError(
      422,
      "unsupported_aggregation_type",
      `Unsupported aggregation type: ${String(value)}`,
    );
  return value as SupportedAggregationType;
}

function normalizeRoundingFunction(value: unknown): AggregationRoundingFunction | null {
  if (value === undefined || value === null || value === "") return null;
  if (value === "round" || value === "ceil" || value === "floor") return value;
  throw new ApiError(422, "validation_error", "rounding_function must be round, ceil, or floor");
}

function normalizeStoredRoundingFunction(value: string | null): AggregationRoundingFunction | null {
  if (value === null || value === "round" || value === "ceil" || value === "floor") return value;
  throw new ApiError(500, "invalid_metric", "Stored rounding_function is invalid");
}

function normalizeRoundingPrecision(value: unknown): number | null {
  if (value === undefined || value === null) return null;
  if (!Number.isSafeInteger(value) || (value as number) < -100 || (value as number) > 100) {
    throw new ApiError(
      422,
      "validation_error",
      "rounding_precision must be an integer between -100 and 100",
    );
  }
  return value as number;
}

function normalizeWeightedInterval(value: unknown): "seconds" | null {
  if (value === undefined || value === null || value === "") return null;
  if (value === "seconds") return value;
  throw new ApiError(422, "validation_error", "weighted_interval must be seconds");
}

function normalizeStoredWeightedInterval(value: string | null): "seconds" | null {
  if (value === null || value === "seconds") return value;
  throw new ApiError(500, "invalid_metric", "Stored weighted_interval is invalid");
}

function validateMetricConfiguration(
  aggregationType: SupportedAggregationType,
  fieldName: string | null,
  expression: string | null,
  recurring: 0 | 1,
  weightedInterval: "seconds" | null,
): void {
  if (aggregationType !== "count_agg" && !fieldName)
    throw new ApiError(422, "validation_error", "field_name is required");
  if (expression && !fieldName)
    throw new ApiError(422, "validation_error", "field_name is required for expression");
  if (expression) {
    try {
      validateUsageExpression(expression);
    } catch {
      throw new ApiError(422, "invalid_expression", "expression is invalid");
    }
  }
  if (aggregationType === "weighted_sum_agg") {
    if (weightedInterval !== "seconds")
      throw new ApiError(422, "validation_error", "weighted_interval is required");
    return;
  }
  if (weightedInterval !== null)
    throw new ApiError(
      422,
      "validation_error",
      "weighted_interval is only valid for weighted_sum_agg",
    );
  if (recurring === 1)
    throw new ApiError(
      422,
      "unsupported_billable_metric_feature",
      "recurring is currently supported only for weighted_sum_agg",
    );
}

function rejectUnsupportedChargeInput(input: Record<string, unknown>): void {
  for (const field of ["applied_pricing_unit", "regroup_paid_fees", "cascade_updates"]) {
    const value = input[field];
    if (value === undefined || value === null || value === false) continue;
    if (Array.isArray(value) && value.length === 0) continue;
    throw new ApiError(
      422,
      "unsupported_charge_feature",
      `${field} is not implemented by the Cloudflare charge catalog`,
    );
  }
  if (Array.isArray(input.tax_codes) && input.tax_codes.length > 0)
    throw new ApiError(
      422,
      "unsupported_tax_target",
      "Charge-specific tax targeting is not implemented",
    );
}

function assertStoredWeightedConfiguration(
  aggregationType: SupportedAggregationType,
  weightedInterval: string | null,
): void {
  if (aggregationType === "weighted_sum_agg" && weightedInterval !== "seconds") {
    throw new ApiError(500, "invalid_metric", "Weighted metric interval is invalid");
  }
}

function sameMetric(metric: MetricRow, normalized: NormalizedMetric): boolean {
  return (
    metric.code === normalized.code &&
    metric.name === normalized.name &&
    metric.description === normalized.description &&
    metric.aggregation_type === normalized.aggregationType &&
    metric.field_name === normalized.fieldName &&
    metric.recurring === normalized.recurring &&
    metric.rounding_function === normalized.roundingFunction &&
    metric.rounding_precision === normalized.roundingPrecision &&
    metric.weighted_interval === normalized.weightedInterval &&
    metric.expression === normalized.expression &&
    stableJson(parseStoredBillableMetricFilters(metric.filters_json)) ===
      stableJson(normalized.filters)
  );
}

function catalogEvent(
  type: string,
  aggregateType: string,
  id: string,
  version: number,
  organizationId: string,
  correlationId: string,
  occurredAt: string,
  payload: Record<string, unknown>,
): DomainEvent {
  return {
    id: `${type.replaceAll(".", "-")}:${id}:v${version}`,
    type,
    version: 1,
    aggregateType,
    aggregateId: id,
    aggregateVersion: version,
    occurredAt,
    causationId: correlationId,
    correlationId,
    payload: { organizationId, ...payload },
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
       (event_id, organization_id, event_type, event_version, aggregate_type, aggregate_id,
        aggregate_version, causation_id, correlation_id, payload_json, occurred_at, published_at)
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

function metricMutationGuardStatement(
  database: D1Database,
  requestId: string,
  organizationId: string,
  metric: MetricRow,
  targetActive: 0 | 1,
  now: string,
): D1PreparedStatement {
  return database
    .prepare(
      `INSERT INTO billable_metric_mutation_guards
       (request_id, organization_id, billable_metric_id, source_version, target_version,
        target_active, created_at)
       SELECT ?, organization_id, id, version, version + 1, ?, ? FROM billable_metrics
       WHERE id = ? AND organization_id = ? AND active = 1 AND version = ?`,
    )
    .bind(requestId, targetActive, now, metric.id, organizationId, metric.version);
}

function guardedMetricOutboxStatement(
  database: D1Database,
  organizationId: string,
  event: DomainEvent,
  metricId: string,
  expectedVersion: number,
  expectedUpdatedAt: string,
  expectedActive: 0 | 1,
  requestId: string,
): D1PreparedStatement {
  return database
    .prepare(
      `INSERT INTO outbox_events
       (event_id, organization_id, event_type, event_version, aggregate_type, aggregate_id,
        aggregate_version, causation_id, correlation_id, payload_json, occurred_at, published_at)
       SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL
       FROM billable_metrics metric
       JOIN billable_metric_mutation_guards guard
         ON guard.billable_metric_id = metric.id AND guard.organization_id = metric.organization_id
       WHERE guard.request_id = ? AND guard.target_active = ? AND guard.target_version = ?
         AND metric.id = ? AND metric.organization_id = ? AND metric.active = ?
         AND metric.version = ? AND metric.updated_at = ?`,
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
      requestId,
      expectedActive,
      expectedVersion,
      metricId,
      organizationId,
      expectedActive,
      expectedVersion,
      expectedUpdatedAt,
    );
}

function clearMetricMutationGuardStatement(
  database: D1Database,
  requestId: string,
  metricId: string,
): D1PreparedStatement {
  return database
    .prepare(
      `DELETE FROM billable_metric_mutation_guards
       WHERE request_id = ? AND billable_metric_id = ?`,
    )
    .bind(requestId, metricId);
}

function conditionalChargeOutboxStatement(
  database: D1Database,
  organizationId: string,
  event: DomainEvent,
  chargeId: string,
  expectedVersion: number,
  expectedUpdatedAt: string,
  expectedActive: 0 | 1,
): D1PreparedStatement {
  return database
    .prepare(
      `INSERT INTO outbox_events
       (event_id, organization_id, event_type, event_version, aggregate_type, aggregate_id,
        aggregate_version, causation_id, correlation_id, payload_json, occurred_at, published_at)
       SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL FROM charges
       WHERE id = ? AND organization_id = ? AND active = ? AND version = ? AND updated_at = ?`,
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
      chargeId,
      organizationId,
      expectedActive,
      expectedVersion,
      expectedUpdatedAt,
    );
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
