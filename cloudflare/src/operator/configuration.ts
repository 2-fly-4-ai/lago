import { ApiError, json, objectAt, parseJsonObject } from "../http";

type PricingUnitRow = {
  id: string;
  code: string;
  name: string;
  short_name: string;
  description: string | null;
  version: number;
  created_at: string;
  updated_at: string;
};

type AlertRow = {
  id: string;
  resource_type: "subscription" | "wallet";
  resource_id: string;
  alert_type: string;
  billable_metric_id: string | null;
  code: string;
  name: string | null;
  thresholds_json: string;
  version: number;
  created_at: string;
  updated_at: string;
};

type Threshold = { code: string | null; recurring: boolean; value: string };

const ALERT_TYPES = new Set([
  "billable_metric_current_usage_amount",
  "billable_metric_current_usage_units",
  "billable_metric_lifetime_usage_units",
  "current_usage_amount",
  "lifetime_usage_amount",
  "wallet_balance_amount",
  "wallet_credits_balance",
  "wallet_credits_ongoing_balance",
  "wallet_ongoing_balance_amount",
]);

export async function handleOperatorConfigurationRequest(
  request: Request,
  database: D1Database,
  organizationId: string,
  requestId: string,
): Promise<Response | null> {
  const url = new URL(request.url);
  if (/^\/api\/operator\/v1\/pricing-units(?:\/|$)/.test(url.pathname)) {
    return handlePricingUnits(request, database, organizationId, requestId);
  }
  if (/^\/api\/operator\/v1\/alerts(?:\/|$)/.test(url.pathname)) {
    return handleAlerts(request, database, organizationId, requestId);
  }
  return null;
}

async function handlePricingUnits(
  request: Request,
  database: D1Database,
  organizationId: string,
  requestId: string,
) {
  const url = new URL(request.url);
  const match = url.pathname.match(/^\/api\/operator\/v1\/pricing-units(?:\/([^/]+))?$/);
  if (!match) return null;
  const pricingUnitId = match[1] ? decodeURIComponent(match[1]) : null;
  if (request.method === "GET" && !pricingUnitId) {
    const result = await database
      .prepare(`SELECT id, code, name, short_name, description, version, created_at, updated_at
        FROM pricing_units WHERE organization_id = ? AND deleted_at IS NULL
        ORDER BY created_at DESC, id DESC LIMIT 100`)
      .bind(organizationId)
      .all<PricingUnitRow>();
    return json({ pricing_units: result.results.map(serializePricingUnit) }, { requestId });
  }
  if (request.method === "GET" && pricingUnitId) {
    return pricingUnitResponse(database, organizationId, pricingUnitId, requestId);
  }
  if (request.method === "POST" && !pricingUnitId) {
    const input = normalizePricingUnit(objectAt(await parseJsonObject(request), "pricing_unit"));
    if (await findPricingUnitByCode(database, organizationId, input.code)) {
      throw new ApiError(422, "value_already_exist", "Pricing unit code already exists");
    }
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    await database
      .prepare(`INSERT INTO pricing_units
        (id, organization_id, code, name, short_name, description, version, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)`)
      .bind(
        id,
        organizationId,
        input.code,
        input.name,
        input.shortName,
        input.description,
        now,
        now,
      )
      .run();
    return pricingUnitResponse(database, organizationId, id, requestId, 201);
  }
  if (request.method === "PUT" && pricingUnitId) {
    const current = await findPricingUnit(database, organizationId, pricingUnitId);
    if (!current) throw new ApiError(404, "pricing_unit_not_found", "Pricing unit was not found");
    const input = normalizePricingUnit(objectAt(await parseJsonObject(request), "pricing_unit"), {
      code: current.code,
      name: current.name,
      shortName: current.short_name,
      description: current.description,
    });
    if (input.code !== current.code) {
      throw new ApiError(422, "immutable_pricing_unit_code", "Pricing unit code cannot be changed");
    }
    await database
      .prepare(`UPDATE pricing_units SET name = ?, short_name = ?, description = ?,
        version = version + 1, updated_at = ?
        WHERE id = ? AND organization_id = ? AND deleted_at IS NULL AND version = ?`)
      .bind(
        input.name,
        input.shortName,
        input.description,
        new Date().toISOString(),
        current.id,
        organizationId,
        current.version,
      )
      .run();
    return pricingUnitResponse(database, organizationId, current.id, requestId);
  }
  return null;
}

async function handleAlerts(
  request: Request,
  database: D1Database,
  organizationId: string,
  requestId: string,
) {
  const url = new URL(request.url);
  const match = url.pathname.match(/^\/api\/operator\/v1\/alerts(?:\/([^/]+))?$/);
  if (!match) return null;
  const alertId = match[1] ? decodeURIComponent(match[1]) : null;
  if (request.method === "GET" && !alertId) {
    const resourceType = normalizeResourceType(url.searchParams.get("resource_type"));
    const resourceId = requiredQuery(url, "resource_id");
    const canonicalId = await canonicalResourceId(
      database,
      organizationId,
      resourceType,
      resourceId,
    );
    const result = await database
      .prepare(`SELECT id, resource_type, resource_id, alert_type, billable_metric_id, code,
        name, thresholds_json, version, created_at, updated_at FROM operator_alerts
        WHERE organization_id = ? AND resource_type = ? AND resource_id = ? AND deleted_at IS NULL
        ORDER BY created_at DESC, id DESC LIMIT 100`)
      .bind(organizationId, resourceType, canonicalId)
      .all<AlertRow>();
    return json({ alerts: result.results.map(serializeAlert) }, { requestId });
  }
  if (request.method === "GET" && alertId) {
    return alertResponse(database, organizationId, alertId, requestId);
  }
  if (request.method === "POST" && !alertId) {
    const body = await parseJsonObject(request);
    const input = normalizeAlert(objectAt(body, "alert"));
    const canonicalId = await canonicalResourceId(
      database,
      organizationId,
      input.resourceType,
      input.resourceId,
    );
    await assertMetric(database, organizationId, input.alertType, input.billableMetricId);
    const duplicate = await database
      .prepare(`SELECT id FROM operator_alerts WHERE organization_id = ? AND resource_type = ?
        AND resource_id = ? AND code = ? AND deleted_at IS NULL`)
      .bind(organizationId, input.resourceType, canonicalId, input.code)
      .first();
    if (duplicate) throw new ApiError(422, "value_already_exist", "Alert code already exists");
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    await database
      .prepare(`INSERT INTO operator_alerts
        (id, organization_id, resource_type, resource_id, alert_type, billable_metric_id,
         code, name, thresholds_json, version, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`)
      .bind(
        id,
        organizationId,
        input.resourceType,
        canonicalId,
        input.alertType,
        input.billableMetricId,
        input.code,
        input.name,
        JSON.stringify(input.thresholds),
        now,
        now,
      )
      .run();
    return alertResponse(database, organizationId, id, requestId, 201);
  }
  if (request.method === "PUT" && alertId) {
    const current = await findAlert(database, organizationId, alertId);
    if (!current) throw new ApiError(404, "alert_not_found", "Alert was not found");
    const input = normalizeAlert(objectAt(await parseJsonObject(request), "alert"), current);
    if (
      input.resourceType !== current.resource_type ||
      input.resourceId !== current.resource_id ||
      input.alertType !== current.alert_type
    ) {
      throw new ApiError(
        422,
        "immutable_alert_contract",
        "Alert resource and type cannot be changed",
      );
    }
    await assertMetric(database, organizationId, input.alertType, input.billableMetricId);
    await database
      .prepare(`UPDATE operator_alerts SET billable_metric_id = ?, code = ?, name = ?,
        thresholds_json = ?, version = version + 1, updated_at = ?
        WHERE id = ? AND organization_id = ? AND deleted_at IS NULL AND version = ?`)
      .bind(
        input.billableMetricId,
        input.code,
        input.name,
        JSON.stringify(input.thresholds),
        new Date().toISOString(),
        current.id,
        organizationId,
        current.version,
      )
      .run();
    return alertResponse(database, organizationId, current.id, requestId);
  }
  if (request.method === "DELETE" && alertId) {
    const current = await findAlert(database, organizationId, alertId);
    if (!current) throw new ApiError(404, "alert_not_found", "Alert was not found");
    await database
      .prepare(`UPDATE operator_alerts SET deleted_at = ?, updated_at = ?, version = version + 1
        WHERE id = ? AND organization_id = ? AND deleted_at IS NULL`)
      .bind(new Date().toISOString(), new Date().toISOString(), current.id, organizationId)
      .run();
    return new Response(null, { status: 204 });
  }
  return null;
}

function normalizePricingUnit(
  input: Record<string, unknown>,
  current?: { code: string; name: string; shortName: string; description: string | null },
) {
  const code = current?.code ?? requiredBoundedString(input, "code", "pricing_unit.code", 100);
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(code)) {
    throw new ApiError(422, "validation_error", "pricing_unit.code is invalid");
  }
  const name =
    input.name === undefined && current
      ? current.name
      : requiredBoundedString(input, "name", "pricing_unit.name", 255);
  const shortName =
    input.short_name === undefined && current
      ? current.shortName
      : requiredBoundedString(input, "short_name", "pricing_unit.short_name", 3);
  const description =
    input.description === undefined && current
      ? current.description
      : typeof input.description === "string"
        ? input.description.trim().slice(0, 1_000) || null
        : null;
  return { code, name, shortName, description };
}

function normalizeAlert(input: Record<string, unknown>, current?: AlertRow) {
  const resourceType =
    input.resource_type === undefined && current
      ? current.resource_type
      : normalizeResourceType(input.resource_type);
  const resourceId =
    input.resource_id === undefined && current
      ? current.resource_id
      : requiredBoundedString(input, "resource_id", "alert.resource_id", 255);
  const alertType =
    input.alert_type === undefined && current
      ? current.alert_type
      : requiredBoundedString(input, "alert_type", "alert.alert_type", 100);
  if (
    !ALERT_TYPES.has(alertType) ||
    (resourceType === "wallet") !== alertType.startsWith("wallet_")
  ) {
    throw new ApiError(422, "validation_error", "alert.alert_type is invalid for this resource");
  }
  const code =
    input.code === undefined && current
      ? current.code
      : requiredBoundedString(input, "code", "alert.code", 100);
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(code)) {
    throw new ApiError(422, "validation_error", "alert.code is invalid");
  }
  const name =
    input.name === undefined && current
      ? current.name
      : typeof input.name === "string"
        ? input.name.trim().slice(0, 255) || null
        : null;
  const billableMetricId =
    input.billable_metric_id === undefined && current
      ? current.billable_metric_id
      : typeof input.billable_metric_id === "string"
        ? input.billable_metric_id.trim() || null
        : null;
  const rawThresholds =
    input.thresholds === undefined && current
      ? safeThresholds(current.thresholds_json)
      : input.thresholds;
  if (!Array.isArray(rawThresholds) || rawThresholds.length < 1 || rawThresholds.length > 20) {
    throw new ApiError(422, "validation_error", "alert.thresholds must contain 1 to 20 items");
  }
  const thresholds = rawThresholds.map((threshold, index) => normalizeThreshold(threshold, index));
  return { resourceType, resourceId, alertType, billableMetricId, code, name, thresholds };
}

function normalizeThreshold(value: unknown, index: number): Threshold {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ApiError(422, "validation_error", `alert.thresholds[${index}] is invalid`);
  }
  const threshold = value as Record<string, unknown>;
  const amount = requiredBoundedString(threshold, "value", `alert.thresholds[${index}].value`, 64);
  if (!/^\d+(?:\.\d+)?$/.test(amount)) {
    throw new ApiError(422, "validation_error", `alert.thresholds[${index}].value is invalid`);
  }
  return {
    code: typeof threshold.code === "string" ? threshold.code.trim().slice(0, 100) || null : null,
    recurring: threshold.recurring === true,
    value: amount,
  };
}

function normalizeResourceType(value: unknown): "subscription" | "wallet" {
  if (value !== "subscription" && value !== "wallet") {
    throw new ApiError(422, "validation_error", "resource_type must be subscription or wallet");
  }
  return value;
}

async function canonicalResourceId(
  database: D1Database,
  organizationId: string,
  resourceType: "subscription" | "wallet",
  resourceId: string,
) {
  const row =
    resourceType === "subscription"
      ? await database
          .prepare(`SELECT id FROM subscriptions WHERE organization_id = ?
            AND (id = ? OR external_id = ?) LIMIT 1`)
          .bind(organizationId, resourceId, resourceId)
          .first<{ id: string }>()
      : await database
          .prepare("SELECT id FROM wallets WHERE organization_id = ? AND id = ? LIMIT 1")
          .bind(organizationId, resourceId)
          .first<{ id: string }>();
  if (!row) throw new ApiError(404, `${resourceType}_not_found`, `${resourceType} was not found`);
  return row.id;
}

async function assertMetric(
  database: D1Database,
  organizationId: string,
  alertType: string,
  metricId: string | null,
) {
  const requiresMetric = alertType.startsWith("billable_metric_");
  if (requiresMetric !== Boolean(metricId)) {
    throw new ApiError(
      422,
      "validation_error",
      requiresMetric
        ? "alert.billable_metric_id is required"
        : "alert.billable_metric_id is not allowed",
    );
  }
  if (!metricId) return;
  const metric = await database
    .prepare(`SELECT id FROM billable_metrics
      WHERE organization_id = ? AND id = ? AND active = 1`)
    .bind(organizationId, metricId)
    .first();
  if (!metric) throw new ApiError(422, "invalid_billable_metric", "Billable metric was not found");
}

async function pricingUnitResponse(
  database: D1Database,
  organizationId: string,
  id: string,
  requestId: string,
  status = 200,
) {
  const row = await findPricingUnit(database, organizationId, id);
  if (!row) throw new ApiError(404, "pricing_unit_not_found", "Pricing unit was not found");
  return json({ pricing_unit: serializePricingUnit(row) }, { requestId, status });
}

async function alertResponse(
  database: D1Database,
  organizationId: string,
  id: string,
  requestId: string,
  status = 200,
) {
  const row = await findAlert(database, organizationId, id);
  if (!row) throw new ApiError(404, "alert_not_found", "Alert was not found");
  return json({ alert: serializeAlert(row) }, { requestId, status });
}

function findPricingUnit(database: D1Database, organizationId: string, id: string) {
  return database
    .prepare(`SELECT id, code, name, short_name, description, version, created_at, updated_at
      FROM pricing_units WHERE organization_id = ? AND id = ? AND deleted_at IS NULL`)
    .bind(organizationId, id)
    .first<PricingUnitRow>();
}

function findPricingUnitByCode(database: D1Database, organizationId: string, code: string) {
  return database
    .prepare(`SELECT id, code, name, short_name, description, version, created_at, updated_at
      FROM pricing_units WHERE organization_id = ? AND code = ? AND deleted_at IS NULL`)
    .bind(organizationId, code)
    .first<PricingUnitRow>();
}

function findAlert(database: D1Database, organizationId: string, id: string) {
  return database
    .prepare(`SELECT id, resource_type, resource_id, alert_type, billable_metric_id, code,
      name, thresholds_json, version, created_at, updated_at FROM operator_alerts
      WHERE organization_id = ? AND id = ? AND deleted_at IS NULL`)
    .bind(organizationId, id)
    .first<AlertRow>();
}

function serializePricingUnit(row: PricingUnitRow) {
  return {
    lago_id: row.id,
    code: row.code,
    name: row.name,
    short_name: row.short_name,
    description: row.description,
    version: row.version,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function serializeAlert(row: AlertRow) {
  return {
    lago_id: row.id,
    resource_type: row.resource_type,
    resource_id: row.resource_id,
    alert_type: row.alert_type,
    billable_metric_id: row.billable_metric_id,
    code: row.code,
    name: row.name,
    thresholds: safeThresholds(row.thresholds_json),
    version: row.version,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function safeThresholds(raw: string): Threshold[] {
  try {
    const value = JSON.parse(raw) as unknown;
    return Array.isArray(value) ? (value as Threshold[]) : [];
  } catch {
    return [];
  }
}

function requiredQuery(url: URL, name: string) {
  const value = url.searchParams.get(name)?.trim();
  if (!value) throw new ApiError(422, "validation_error", `${name} is required`);
  return value.slice(0, 255);
}

function requiredBoundedString(
  value: Record<string, unknown>,
  key: string,
  label: string,
  maxLength: number,
) {
  const candidate = value[key];
  if (typeof candidate !== "string" || !candidate.trim()) {
    throw new ApiError(422, "validation_error", `${label} is required`);
  }
  const normalized = candidate.trim();
  if (normalized.length > maxLength) {
    throw new ApiError(422, "validation_error", `${label} is too long`);
  }
  return normalized;
}
