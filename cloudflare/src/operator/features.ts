import { ApiError, json, objectAt, optionalString, parseJsonObject, requiredString } from "../http";
import { stableJson } from "../json";

type FeatureRow = {
  id: string;
  code: string;
  name: string | null;
  description: string | null;
  version: number;
  created_at: string;
  updated_at: string;
  plans_count: number;
  subscriptions_count: number;
};

type PrivilegeRow = {
  id: string;
  code: string;
  name: string | null;
  value_type: PrivilegeValueType;
  config_json: string;
  version: number;
  created_at: string;
  updated_at: string;
};

type PrivilegeValueType = "boolean" | "integer" | "string" | "select";

type NormalizedPrivilege = {
  id: string | null;
  code: string;
  name: string | null;
  valueType: PrivilegeValueType;
  config: { select_options?: string[] };
};

type NormalizedFeature = {
  code: string;
  name: string | null;
  description: string | null;
  privileges: NormalizedPrivilege[];
};

export async function handleOperatorFeaturesRequest(
  request: Request,
  database: D1Database,
  organizationId: string,
  requestId: string,
): Promise<Response | null> {
  const url = new URL(request.url);
  if (!/^\/api\/operator\/v1\/features(?:\/|$)/.test(url.pathname)) return null;

  if (request.method === "GET" && url.pathname === "/api/operator/v1/features") {
    return listFeatures(url, database, organizationId, requestId);
  }
  if (request.method === "POST" && url.pathname === "/api/operator/v1/features") {
    return createFeature(request, database, organizationId, requestId);
  }

  const match = url.pathname.match(/^\/api\/operator\/v1\/features\/([^/]+)$/);
  if (!match?.[1]) return null;
  const featureId = decodeURIComponent(match[1]);
  if (request.method === "GET") {
    return showFeature(featureId, database, organizationId, requestId);
  }
  if (request.method === "PUT") {
    return updateFeature(featureId, request, database, organizationId, requestId);
  }
  if (request.method === "DELETE") {
    return deleteFeature(featureId, database, organizationId, requestId);
  }
  return null;
}

async function listFeatures(
  url: URL,
  database: D1Database,
  organizationId: string,
  requestId: string,
): Promise<Response> {
  const search = url.searchParams.get("search")?.trim().slice(0, 255) ?? "";
  const page = boundedInteger(url.searchParams.get("page"), 1, 1, 10_000);
  const perPage = boundedInteger(url.searchParams.get("per_page"), 20, 1, 100);
  const offset = (page - 1) * perPage;
  const searchPattern = `%${escapeLike(search)}%`;
  const where = search
    ? `feature.organization_id = ? AND feature.deleted_at IS NULL
       AND (feature.code LIKE ? ESCAPE '\\' OR feature.name LIKE ? ESCAPE '\\')`
    : "feature.organization_id = ? AND feature.deleted_at IS NULL";
  const countStatement = database.prepare(
    `SELECT COUNT(*) AS total FROM entitlement_features feature WHERE ${where}`,
  );
  const listStatement = database.prepare(
    `SELECT feature.id, feature.code, feature.name, feature.description, feature.version,
            feature.created_at, feature.updated_at,
            COUNT(DISTINCT entitlement.plan_id) AS plans_count,
            COUNT(DISTINCT subscription.id) AS subscriptions_count
     FROM entitlement_features feature
     LEFT JOIN plan_entitlements entitlement
       ON entitlement.entitlement_feature_id = feature.id AND entitlement.deleted_at IS NULL
     LEFT JOIN subscriptions subscription
       ON subscription.plan_id = entitlement.plan_id AND subscription.status IN ('active', 'pending')
     WHERE ${where}
     GROUP BY feature.id
     ORDER BY feature.created_at DESC, feature.id DESC
     LIMIT ? OFFSET ?`,
  );
  const count = search
    ? await countStatement
        .bind(organizationId, searchPattern, searchPattern)
        .first<{ total: number }>()
    : await countStatement.bind(organizationId).first<{ total: number }>();
  const result = search
    ? await listStatement
        .bind(organizationId, searchPattern, searchPattern, perPage, offset)
        .all<FeatureRow>()
    : await listStatement.bind(organizationId, perPage, offset).all<FeatureRow>();
  const total = count?.total ?? 0;
  return json(
    {
      features: result.results.map(serializeFeature),
      meta: {
        current_page: page,
        total_pages: Math.max(1, Math.ceil(total / perPage)),
        total_count: total,
        per_page: perPage,
      },
    },
    { requestId },
  );
}

async function showFeature(
  featureId: string,
  database: D1Database,
  organizationId: string,
  requestId: string,
): Promise<Response> {
  const feature = await findFeature(database, organizationId, featureId);
  if (!feature) throw new ApiError(404, "feature_not_found", "Feature was not found");
  const privileges = await listPrivileges(database, organizationId, feature.id);
  return json(
    { feature: { ...serializeFeature(feature), privileges: privileges.map(serializePrivilege) } },
    { requestId },
  );
}

async function createFeature(
  request: Request,
  database: D1Database,
  organizationId: string,
  requestId: string,
): Promise<Response> {
  const input = normalizeFeatureInput(objectAt(await parseJsonObject(request), "feature"));
  const duplicate = await findFeatureByCode(database, organizationId, input.code);
  if (duplicate) throw new ApiError(422, "value_already_exist", "Feature code already exists");
  const featureId = crypto.randomUUID();
  const now = new Date().toISOString();
  const statements = [
    database
      .prepare(
        `INSERT INTO entitlement_features
         (id, organization_id, code, name, description, version, created_at, updated_at, deleted_at)
         VALUES (?, ?, ?, ?, ?, 1, ?, ?, NULL)`,
      )
      .bind(featureId, organizationId, input.code, input.name, input.description, now, now),
    ...input.privileges.map((privilege) =>
      database
        .prepare(
          `INSERT INTO entitlement_privileges
           (id, organization_id, entitlement_feature_id, code, name, value_type, config_json,
            version, created_at, updated_at, deleted_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?, NULL)`,
        )
        .bind(
          crypto.randomUUID(),
          organizationId,
          featureId,
          privilege.code,
          privilege.name,
          privilege.valueType,
          JSON.stringify(privilege.config),
          now,
          now,
        ),
    ),
    featureActivityStatement(
      database,
      organizationId,
      featureId,
      1,
      "feature.created",
      requestId,
      now,
      { code: input.code, name: input.name },
    ),
  ];
  try {
    await database.batch(statements);
  } catch (error) {
    if (await findFeatureByCode(database, organizationId, input.code)) {
      throw new ApiError(422, "value_already_exist", "Feature code already exists");
    }
    throw error;
  }
  return responseForFeature(database, organizationId, featureId, requestId, 201);
}

async function updateFeature(
  featureId: string,
  request: Request,
  database: D1Database,
  organizationId: string,
  requestId: string,
): Promise<Response> {
  const current = await findFeature(database, organizationId, featureId);
  if (!current) throw new ApiError(404, "feature_not_found", "Feature was not found");
  const input = normalizeFeatureInput(objectAt(await parseJsonObject(request), "feature"), {
    code: current.code,
  });
  if (input.code !== current.code) {
    throw new ApiError(422, "immutable_feature_code", "Feature code cannot be changed");
  }
  const currentPrivileges = await listPrivileges(database, organizationId, featureId);
  const byId = new Map(currentPrivileges.map((privilege) => [privilege.id, privilege]));
  const retainedIds = new Set<string>();
  const now = new Date().toISOString();
  const statements: D1PreparedStatement[] = [
    database
      .prepare(
        `UPDATE entitlement_features
         SET name = ?, description = ?, version = version + 1, updated_at = ?
         WHERE id = ? AND organization_id = ? AND deleted_at IS NULL AND version = ?`,
      )
      .bind(input.name, input.description, now, featureId, organizationId, current.version),
    featureActivityStatement(
      database,
      organizationId,
      featureId,
      current.version + 1,
      "feature.updated",
      requestId,
      now,
      { code: current.code, name: input.name },
    ),
  ];
  for (const privilege of input.privileges) {
    const existing = privilege.id ? byId.get(privilege.id) : undefined;
    if (privilege.id && !existing) {
      throw new ApiError(422, "invalid_privilege", "Privilege does not belong to this feature");
    }
    if (existing) {
      if (existing.code !== privilege.code || existing.value_type !== privilege.valueType) {
        throw new ApiError(
          422,
          "immutable_privilege_contract",
          "Existing privilege code and value type cannot be changed",
        );
      }
      retainedIds.add(existing.id);
      statements.push(
        database
          .prepare(
            `UPDATE entitlement_privileges
             SET name = ?, config_json = ?, version = version + 1, updated_at = ?
             WHERE id = ? AND organization_id = ? AND entitlement_feature_id = ?
               AND deleted_at IS NULL AND version = ?`,
          )
          .bind(
            privilege.name,
            JSON.stringify(privilege.config),
            now,
            existing.id,
            organizationId,
            featureId,
            existing.version,
          ),
      );
    } else {
      statements.push(
        database
          .prepare(
            `INSERT INTO entitlement_privileges
             (id, organization_id, entitlement_feature_id, code, name, value_type, config_json,
              version, created_at, updated_at, deleted_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?, NULL)`,
          )
          .bind(
            crypto.randomUUID(),
            organizationId,
            featureId,
            privilege.code,
            privilege.name,
            privilege.valueType,
            JSON.stringify(privilege.config),
            now,
            now,
          ),
      );
    }
  }
  for (const existing of currentPrivileges) {
    if (!retainedIds.has(existing.id)) {
      statements.push(
        database
          .prepare(
            `UPDATE entitlement_privileges
             SET deleted_at = ?, updated_at = ?, version = version + 1
             WHERE id = ? AND organization_id = ? AND entitlement_feature_id = ?
               AND deleted_at IS NULL`,
          )
          .bind(now, now, existing.id, organizationId, featureId),
      );
    }
  }
  try {
    const results = await database.batch(statements);
    if (results[0]?.meta.changes !== 1) {
      throw new ApiError(409, "feature_version_conflict", "Feature changed concurrently");
    }
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError(422, "value_is_duplicated", "Privilege codes must be unique");
  }
  return responseForFeature(database, organizationId, featureId, requestId);
}

async function deleteFeature(
  featureId: string,
  database: D1Database,
  organizationId: string,
  requestId: string,
): Promise<Response> {
  const feature = await findFeature(database, organizationId, featureId);
  if (!feature) throw new ApiError(404, "feature_not_found", "Feature was not found");
  const attached = await database
    .prepare(
      `SELECT 1 AS attached FROM plan_entitlements
       WHERE organization_id = ? AND entitlement_feature_id = ? AND deleted_at IS NULL LIMIT 1`,
    )
    .bind(organizationId, featureId)
    .first<{ attached: number }>();
  if (attached) {
    throw new ApiError(422, "feature_in_use", "Feature is attached to at least one plan");
  }
  const now = new Date().toISOString();
  const results = await database.batch([
    database
      .prepare(
        `UPDATE entitlement_privileges SET deleted_at = ?, updated_at = ?, version = version + 1
         WHERE organization_id = ? AND entitlement_feature_id = ? AND deleted_at IS NULL`,
      )
      .bind(now, now, organizationId, featureId),
    database
      .prepare(
        `UPDATE entitlement_features SET deleted_at = ?, updated_at = ?, version = version + 1
         WHERE id = ? AND organization_id = ? AND deleted_at IS NULL AND version = ?`,
      )
      .bind(now, now, featureId, organizationId, feature.version),
    featureActivityStatement(
      database,
      organizationId,
      featureId,
      feature.version + 1,
      "feature.deleted",
      requestId,
      now,
      { code: feature.code, name: feature.name },
    ),
  ]);
  if (results[1]?.meta.changes !== 1) {
    throw new ApiError(409, "feature_version_conflict", "Feature changed concurrently");
  }
  return json({ feature: serializeFeature(feature) }, { requestId });
}

async function responseForFeature(
  database: D1Database,
  organizationId: string,
  featureId: string,
  requestId: string,
  status = 200,
): Promise<Response> {
  const feature = await findFeature(database, organizationId, featureId);
  if (!feature) throw new ApiError(500, "persistence_error", "Feature was not persisted");
  const privileges = await listPrivileges(database, organizationId, featureId);
  return json(
    { feature: { ...serializeFeature(feature), privileges: privileges.map(serializePrivilege) } },
    { requestId, status },
  );
}

async function findFeature(
  database: D1Database,
  organizationId: string,
  featureId: string,
): Promise<FeatureRow | null> {
  return database
    .prepare(
      `SELECT feature.id, feature.code, feature.name, feature.description, feature.version,
              feature.created_at, feature.updated_at,
              COUNT(DISTINCT entitlement.plan_id) AS plans_count,
              COUNT(DISTINCT subscription.id) AS subscriptions_count
       FROM entitlement_features feature
       LEFT JOIN plan_entitlements entitlement
         ON entitlement.entitlement_feature_id = feature.id AND entitlement.deleted_at IS NULL
       LEFT JOIN subscriptions subscription
         ON subscription.plan_id = entitlement.plan_id AND subscription.status IN ('active', 'pending')
       WHERE feature.id = ? AND feature.organization_id = ? AND feature.deleted_at IS NULL
       GROUP BY feature.id`,
    )
    .bind(featureId, organizationId)
    .first<FeatureRow>();
}

async function findFeatureByCode(
  database: D1Database,
  organizationId: string,
  code: string,
): Promise<{ id: string } | null> {
  return database
    .prepare(
      `SELECT id FROM entitlement_features
       WHERE organization_id = ? AND code = ? AND deleted_at IS NULL LIMIT 1`,
    )
    .bind(organizationId, code)
    .first<{ id: string }>();
}

async function listPrivileges(
  database: D1Database,
  organizationId: string,
  featureId: string,
): Promise<PrivilegeRow[]> {
  const result = await database
    .prepare(
      `SELECT id, code, name, value_type, config_json, version, created_at, updated_at
       FROM entitlement_privileges
       WHERE organization_id = ? AND entitlement_feature_id = ? AND deleted_at IS NULL
       ORDER BY created_at, id`,
    )
    .bind(organizationId, featureId)
    .all<PrivilegeRow>();
  return result.results;
}

function normalizeFeatureInput(
  input: Record<string, unknown>,
  defaults: { code?: string } = {},
): NormalizedFeature {
  const code =
    defaults.code && input.code === undefined ? defaults.code : requiredString(input, "code");
  validateCode(code, "Feature code");
  const rawPrivileges = input.privileges ?? [];
  if (!Array.isArray(rawPrivileges) || rawPrivileges.length > 100) {
    throw new ApiError(422, "validation_error", "privileges must be an array of at most 100 items");
  }
  const privileges = rawPrivileges.map((value, index) => normalizePrivilege(value, index));
  if (new Set(privileges.map((privilege) => privilege.code)).size !== privileges.length) {
    throw new ApiError(422, "value_is_duplicated", "Privilege codes must be unique");
  }
  const name = optionalString(input, "name");
  const description = optionalString(input, "description");
  if (name && name.length > 255) throw new ApiError(422, "validation_error", "name is too long");
  if (description && description.length > 600) {
    throw new ApiError(422, "validation_error", "description is too long");
  }
  return { code, name, description, privileges };
}

function normalizePrivilege(value: unknown, index: number): NormalizedPrivilege {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ApiError(422, "validation_error", `privileges.${index} must be an object`);
  }
  const input = value as Record<string, unknown>;
  const code = requiredString(input, "code");
  validateCode(code, `privileges.${index}.code`);
  const candidateType = requiredString(input, "value_type");
  if (!new Set(["boolean", "integer", "string", "select"]).has(candidateType)) {
    throw new ApiError(422, "validation_error", `privileges.${index}.value_type is invalid`);
  }
  const valueType = candidateType as PrivilegeValueType;
  const name = optionalString(input, "name");
  if (name && name.length > 255) {
    throw new ApiError(422, "validation_error", `privileges.${index}.name is too long`);
  }
  const idValue = input.id;
  const id = typeof idValue === "string" && idValue.trim() ? idValue.trim() : null;
  if (valueType !== "select") return { id, code, name, valueType, config: {} };
  const rawConfig = input.config;
  if (!rawConfig || typeof rawConfig !== "object" || Array.isArray(rawConfig)) {
    throw new ApiError(422, "validation_error", `privileges.${index}.config is required`);
  }
  const rawOptions = (rawConfig as Record<string, unknown>).select_options;
  if (!Array.isArray(rawOptions) || rawOptions.length === 0 || rawOptions.length > 100) {
    throw new ApiError(
      422,
      "validation_error",
      `privileges.${index}.config.select_options must contain 1 to 100 items`,
    );
  }
  const selectOptions = rawOptions.map((option) => {
    if (typeof option !== "string" || !option.trim() || option.trim().length > 255) {
      throw new ApiError(422, "validation_error", "Select options must be non-empty strings");
    }
    return option.trim();
  });
  if (new Set(selectOptions).size !== selectOptions.length) {
    throw new ApiError(422, "value_is_duplicated", "Select options must be unique");
  }
  return { id, code, name, valueType, config: { select_options: selectOptions } };
}

function validateCode(value: string, field: string): void {
  if (value.length > 255 || !/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(value)) {
    throw new ApiError(422, "validation_error", `${field} contains invalid characters`);
  }
}

function serializeFeature(row: FeatureRow) {
  return {
    lago_id: row.id,
    code: row.code,
    name: row.name,
    description: row.description,
    plans_count: Number(row.plans_count) || 0,
    subscriptions_count: Number(row.subscriptions_count) || 0,
    version: row.version,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function serializePrivilege(row: PrivilegeRow) {
  return {
    lago_id: row.id,
    code: row.code,
    name: row.name,
    value_type: row.value_type,
    config: parseJsonObjectValue(row.config_json),
    version: row.version,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function parseJsonObjectValue(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function boundedInteger(
  value: string | null,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  if (value === null || value === "") return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new ApiError(422, "validation_error", "Pagination value is invalid");
  }
  return parsed;
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, "\\$&");
}

function featureActivityStatement(
  database: D1Database,
  organizationId: string,
  featureId: string,
  version: number,
  eventType: string,
  requestId: string,
  occurredAt: string,
  payload: Record<string, unknown>,
): D1PreparedStatement {
  return database
    .prepare(
      `INSERT INTO outbox_events
       (event_id, organization_id, event_type, event_version, aggregate_type, aggregate_id,
        aggregate_version, causation_id, correlation_id, payload_json, occurred_at, published_at)
       VALUES (?, ?, ?, 1, 'feature', ?, ?, ?, ?, ?, ?, NULL)`,
    )
    .bind(
      `feature-${eventType.split(".").at(-1)}:${featureId}:v${version}`,
      organizationId,
      eventType,
      featureId,
      version,
      requestId,
      requestId,
      stableJson({ organizationId, featureId, ...payload }),
      occurredAt,
    );
}
