import { ApiError, json, parseJsonObject } from "../http";

type ActivityRow = {
  event_id: string;
  event_type: string;
  aggregate_version: number;
  payload_json: string;
  occurred_at: string;
};

type EntitlementRow = {
  entitlement_id: string;
  feature_id: string;
  feature_code: string;
  feature_name: string | null;
  privilege_id: string | null;
  privilege_code: string | null;
  privilege_name: string | null;
  value_type: "boolean" | "integer" | "string" | "select" | null;
  config_json: string | null;
  value_json: string | null;
};

type NormalizedValue = {
  privilegeId: string;
  value: boolean | number | string;
};

type NormalizedEntitlement = {
  featureId: string;
  featureCode: string;
  values: NormalizedValue[];
};

export async function handleOperatorProductParityRequest(
  request: Request,
  database: D1Database,
  organizationId: string,
  requestId: string,
): Promise<Response | null> {
  const url = new URL(request.url);
  const featureActivity = url.pathname.match(/^\/api\/operator\/v1\/features\/([^/]+)\/activity$/);
  if (request.method === "GET" && featureActivity?.[1]) {
    const featureId = decodeURIComponent(featureActivity[1]);
    const feature = await database
      .prepare(
        `SELECT id FROM entitlement_features
         WHERE id = ? AND organization_id = ? AND deleted_at IS NULL LIMIT 1`,
      )
      .bind(featureId, organizationId)
      .first<{ id: string }>();
    if (!feature) throw new ApiError(404, "feature_not_found", "Feature was not found");
    return activity(database, organizationId, "feature", feature.id, requestId);
  }

  const metricActivity = url.pathname.match(
    /^\/api\/operator\/v1\/billable-metrics\/([^/]+)\/activity$/,
  );
  if (request.method === "GET" && metricActivity?.[1]) {
    const code = decodeURIComponent(metricActivity[1]);
    const metric = await database
      .prepare(
        `SELECT id FROM billable_metrics
         WHERE organization_id = ? AND code = ? AND active = 1 LIMIT 1`,
      )
      .bind(organizationId, code)
      .first<{ id: string }>();
    if (!metric)
      throw new ApiError(404, "billable_metric_not_found", "Billable metric was not found");
    return activity(database, organizationId, "billable_metric", metric.id, requestId);
  }

  const planEntitlements = url.pathname.match(
    /^\/api\/operator\/v1\/plans\/([^/]+)\/entitlements$/,
  );
  if (planEntitlements?.[1] && (request.method === "GET" || request.method === "PUT")) {
    const planCode = decodeURIComponent(planEntitlements[1]);
    const plan = await database
      .prepare(
        "SELECT id FROM plans WHERE organization_id = ? AND code = ? AND pending_deletion = 0",
      )
      .bind(organizationId, planCode)
      .first<{ id: string }>();
    if (!plan) throw new ApiError(404, "plan_not_found", "Plan was not found");
    if (request.method === "PUT") {
      await replacePlanEntitlements(request, database, organizationId, plan.id);
    }
    return listPlanEntitlements(database, organizationId, plan.id, planCode, requestId);
  }

  return null;
}

async function activity(
  database: D1Database,
  organizationId: string,
  aggregateType: string,
  aggregateId: string,
  requestId: string,
): Promise<Response> {
  const result = await database
    .prepare(
      `SELECT event_id, event_type, aggregate_version, payload_json, occurred_at
       FROM outbox_events
       WHERE organization_id = ? AND aggregate_type = ? AND aggregate_id = ?
       ORDER BY occurred_at DESC, aggregate_version DESC LIMIT 100`,
    )
    .bind(organizationId, aggregateType, aggregateId)
    .all<ActivityRow>();
  return json(
    {
      activity_logs: result.results.map((row) => ({
        lago_id: row.event_id,
        event_type: row.event_type,
        version: row.aggregate_version,
        payload: parseValue(row.payload_json),
        occurred_at: row.occurred_at,
      })),
    },
    { requestId },
  );
}

async function listPlanEntitlements(
  database: D1Database,
  organizationId: string,
  planId: string,
  planCode: string,
  requestId: string,
): Promise<Response> {
  const result = await database
    .prepare(
      `SELECT entitlement.id AS entitlement_id, feature.id AS feature_id,
              feature.code AS feature_code, feature.name AS feature_name,
              privilege.id AS privilege_id, privilege.code AS privilege_code,
              privilege.name AS privilege_name, privilege.value_type, privilege.config_json,
              value.value_json
       FROM plan_entitlements entitlement
       JOIN entitlement_features feature ON feature.id = entitlement.entitlement_feature_id
       LEFT JOIN entitlement_privileges privilege
         ON privilege.entitlement_feature_id = feature.id AND privilege.deleted_at IS NULL
       LEFT JOIN entitlement_values value
         ON value.plan_entitlement_id = entitlement.id
        AND value.entitlement_privilege_id = privilege.id
       WHERE entitlement.organization_id = ? AND entitlement.plan_id = ?
         AND entitlement.deleted_at IS NULL AND feature.deleted_at IS NULL
       ORDER BY feature.name, feature.code, privilege.created_at, privilege.id`,
    )
    .bind(organizationId, planId)
    .all<EntitlementRow>();
  const byFeature = new Map<string, Record<string, unknown>>();
  for (const row of result.results) {
    let entitlement = byFeature.get(row.feature_id);
    if (!entitlement) {
      entitlement = {
        lago_id: row.entitlement_id,
        feature_id: row.feature_id,
        feature_code: row.feature_code,
        feature_name: row.feature_name,
        privileges: [],
      };
      byFeature.set(row.feature_id, entitlement);
    }
    if (row.privilege_id && row.privilege_code && row.value_type) {
      (entitlement.privileges as unknown[]).push({
        privilege_id: row.privilege_id,
        privilege_code: row.privilege_code,
        privilege_name: row.privilege_name,
        value_type: row.value_type,
        config: parseValue(row.config_json ?? "{}"),
        value: row.value_json === null ? null : parseValue(row.value_json),
      });
    }
  }
  return json({ plan_code: planCode, entitlements: [...byFeature.values()] }, { requestId });
}

async function replacePlanEntitlements(
  request: Request,
  database: D1Database,
  organizationId: string,
  planId: string,
): Promise<void> {
  const body = await parseJsonObject(request);
  const raw = body.entitlements;
  if (!Array.isArray(raw) || raw.length > 100) {
    throw new ApiError(
      422,
      "validation_error",
      "entitlements must be an array of at most 100 items",
    );
  }
  const normalized: NormalizedEntitlement[] = [];
  const seenFeatures = new Set<string>();
  for (const candidate of raw) {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
      throw new ApiError(422, "validation_error", "Each entitlement must be an object");
    }
    const input = candidate as Record<string, unknown>;
    const featureCode = typeof input.feature_code === "string" ? input.feature_code.trim() : "";
    if (!featureCode || seenFeatures.has(featureCode)) {
      throw new ApiError(422, "validation_error", "Feature codes must be non-empty and unique");
    }
    seenFeatures.add(featureCode);
    const feature = await database
      .prepare(
        `SELECT id FROM entitlement_features
         WHERE organization_id = ? AND code = ? AND deleted_at IS NULL LIMIT 1`,
      )
      .bind(organizationId, featureCode)
      .first<{ id: string }>();
    if (!feature) throw new ApiError(422, "invalid_feature", `Unknown feature: ${featureCode}`);
    const rawPrivileges = input.privileges ?? [];
    if (!Array.isArray(rawPrivileges) || rawPrivileges.length > 100) {
      throw new ApiError(422, "validation_error", "privileges must be an array");
    }
    const values: NormalizedValue[] = [];
    const seenPrivileges = new Set<string>();
    for (const valueCandidate of rawPrivileges) {
      if (!valueCandidate || typeof valueCandidate !== "object" || Array.isArray(valueCandidate)) {
        throw new ApiError(422, "validation_error", "Each privilege value must be an object");
      }
      const valueInput = valueCandidate as Record<string, unknown>;
      const privilegeCode =
        typeof valueInput.privilege_code === "string" ? valueInput.privilege_code.trim() : "";
      if (!privilegeCode || seenPrivileges.has(privilegeCode)) {
        throw new ApiError(422, "validation_error", "Privilege codes must be non-empty and unique");
      }
      seenPrivileges.add(privilegeCode);
      const privilege = await database
        .prepare(
          `SELECT id, value_type, config_json FROM entitlement_privileges
           WHERE organization_id = ? AND entitlement_feature_id = ? AND code = ?
             AND deleted_at IS NULL LIMIT 1`,
        )
        .bind(organizationId, feature.id, privilegeCode)
        .first<{ id: string; value_type: string; config_json: string }>();
      if (!privilege)
        throw new ApiError(422, "invalid_privilege", `Unknown privilege: ${privilegeCode}`);
      values.push({
        privilegeId: privilege.id,
        value: normalizeEntitlementValue(
          valueInput.value,
          privilege.value_type,
          privilege.config_json,
        ),
      });
    }
    normalized.push({ featureId: feature.id, featureCode, values });
  }

  const now = new Date().toISOString();
  const statements: D1PreparedStatement[] = [
    database
      .prepare(
        `DELETE FROM entitlement_values WHERE organization_id = ? AND plan_entitlement_id IN
           (SELECT id FROM plan_entitlements WHERE organization_id = ? AND plan_id = ?)`,
      )
      .bind(organizationId, organizationId, planId),
    database
      .prepare(
        `UPDATE plan_entitlements SET deleted_at = ?, updated_at = ?
         WHERE organization_id = ? AND plan_id = ? AND deleted_at IS NULL`,
      )
      .bind(now, now, organizationId, planId),
  ];
  for (const entitlement of normalized) {
    const entitlementId = crypto.randomUUID();
    statements.push(
      database
        .prepare(
          `INSERT INTO plan_entitlements
           (id, organization_id, plan_id, entitlement_feature_id, created_at, updated_at, deleted_at)
           VALUES (?, ?, ?, ?, ?, ?, NULL)`,
        )
        .bind(entitlementId, organizationId, planId, entitlement.featureId, now, now),
      ...entitlement.values.map((value) =>
        database
          .prepare(
            `INSERT INTO entitlement_values
             (id, organization_id, plan_entitlement_id, entitlement_privilege_id,
              value_json, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
          )
          .bind(
            crypto.randomUUID(),
            organizationId,
            entitlementId,
            value.privilegeId,
            JSON.stringify(value.value),
            now,
            now,
          ),
      ),
    );
  }
  await database.batch(statements);
}

function normalizeEntitlementValue(
  value: unknown,
  valueType: string,
  configJson: string,
): boolean | number | string {
  if (valueType === "boolean" && typeof value === "boolean") return value;
  if (valueType === "integer" && Number.isSafeInteger(value)) return Number(value);
  if (valueType === "string" && typeof value === "string" && value.length <= 1000) return value;
  if (valueType === "select" && typeof value === "string") {
    const config = parseValue(configJson) as { select_options?: unknown };
    if (Array.isArray(config.select_options) && config.select_options.includes(value)) return value;
  }
  throw new ApiError(422, "invalid_entitlement_value", `Invalid ${valueType} privilege value`);
}

function parseValue(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
}
