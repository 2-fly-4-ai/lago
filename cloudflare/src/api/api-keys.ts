import type { AuthContext } from "../auth/api-key";
import { sha256Hex } from "../auth/api-key";
import { ApiError, json, objectAt, optionalString, parseJsonObject } from "../http";

type ApiKeyRow = {
  id: string;
  organization_id: string;
  key_prefix: string;
  name: string | null;
  permissions_json: string;
  value_ending: string | null;
  created_at: string;
  updated_at: string | null;
  expires_at: string | null;
  revoked_at: string | null;
  last_used_at: string | null;
  version: number;
};

export async function handleApiKeysApi(
  request: Request,
  env: Pick<Env, "BILLING_DB">,
  auth: AuthContext,
  requestId: string,
): Promise<Response | null> {
  const url = new URL(request.url);
  if (url.pathname === "/api/v1/api_keys") {
    if (request.method === "GET") return listApiKeys(env.BILLING_DB, auth, url, requestId);
    if (request.method === "POST") {
      return createApiKey(request, env.BILLING_DB, auth, requestId);
    }
    return null;
  }

  const rotateMatch = url.pathname.match(/^\/api\/v1\/api_keys\/([^/]+)\/rotate$/);
  if (rotateMatch?.[1] && request.method === "POST") {
    return rotateApiKey(
      request,
      env.BILLING_DB,
      auth,
      decodeURIComponent(rotateMatch[1]),
      requestId,
    );
  }

  const keyMatch = url.pathname.match(/^\/api\/v1\/api_keys\/([^/]+)$/);
  if (!keyMatch?.[1]) return null;
  const keyId = decodeURIComponent(keyMatch[1]);
  if (request.method === "GET") return showApiKey(env.BILLING_DB, auth, keyId, requestId);
  if (request.method === "PUT") {
    return updateApiKey(request, env.BILLING_DB, auth, keyId, requestId);
  }
  if (request.method === "DELETE") {
    return revokeApiKey(env.BILLING_DB, auth, keyId, requestId);
  }
  return null;
}

async function listApiKeys(
  database: D1Database,
  auth: AuthContext,
  url: URL,
  requestId: string,
): Promise<Response> {
  const page = positiveInteger(url.searchParams.get("page"), 1);
  const perPage = Math.min(positiveInteger(url.searchParams.get("per_page"), 20), 100);
  const status = url.searchParams.get("status")?.trim() || "active";
  if (!new Set(["active", "revoked", "all"]).has(status)) {
    throw new ApiError(422, "validation_error", "status must be active, revoked, or all");
  }
  const now = new Date().toISOString();
  const statusSql =
    status === "active"
      ? "AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > ?)"
      : status === "revoked"
        ? "AND (revoked_at IS NOT NULL OR expires_at <= ?)"
        : "";
  const values: Array<string | number> = [auth.organizationId];
  if (status !== "all") values.push(now);
  const total = await database
    .prepare(
      `SELECT COUNT(*) AS total FROM api_keys
       WHERE organization_id = ? ${statusSql}`,
    )
    .bind(...values)
    .first<{ total: number }>();
  const rows = await database
    .prepare(
      `${apiKeySelect()} WHERE organization_id = ? ${statusSql}
       ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`,
    )
    .bind(...values, perPage, (page - 1) * perPage)
    .all<ApiKeyRow>();
  const count = Number(total?.total ?? 0);
  return json(
    {
      api_keys: rows.results.map(serializeSanitizedApiKey),
      meta: paginationMeta(count, page, perPage),
    },
    { requestId },
  );
}

async function showApiKey(
  database: D1Database,
  auth: AuthContext,
  keyId: string,
  requestId: string,
): Promise<Response> {
  const key = await findApiKey(database, auth.organizationId, keyId);
  if (!key) throw new ApiError(404, "api_key_not_found", "API key was not found");
  return json({ api_key: serializeSanitizedApiKey(key) }, { requestId });
}

async function createApiKey(
  request: Request,
  database: D1Database,
  auth: AuthContext,
  requestId: string,
): Promise<Response> {
  const input = objectAt(await parseJsonObject(request), "api_key");
  const name = apiKeyName(input);
  assertEmptyPermissions(input.permissions);
  const generated = await generatedApiKey();
  const now = new Date().toISOString();
  const keyId = crypto.randomUUID();
  const event = apiKeyEvent(
    database,
    "api_key.created",
    keyId,
    1,
    auth.organizationId,
    requestId,
    now,
    { name },
  );
  await database.batch([
    database
      .prepare(
        `INSERT INTO api_keys
         (id, organization_id, key_prefix, key_hash, created_at, revoked_at, last_used_at,
          name, permissions_json, value_ending, expires_at, version, updated_at)
         VALUES (?, ?, ?, ?, ?, NULL, NULL, ?, '{}', ?, NULL, 1, ?)`,
      )
      .bind(
        keyId,
        auth.organizationId,
        generated.prefix,
        generated.hash,
        now,
        name,
        generated.ending,
        now,
      ),
    event,
  ]);
  const key = await findApiKey(database, auth.organizationId, keyId);
  if (!key) throw new Error("api_key_create_missing");
  return json(
    { api_key: { ...serializeSanitizedApiKey(key), value: generated.value } },
    { requestId },
  );
}

async function updateApiKey(
  request: Request,
  database: D1Database,
  auth: AuthContext,
  keyId: string,
  requestId: string,
): Promise<Response> {
  const current = await findApiKey(database, auth.organizationId, keyId);
  if (!current) throw new ApiError(404, "api_key_not_found", "API key was not found");
  const input = objectAt(await parseJsonObject(request), "api_key");
  const name = input.name === undefined ? current.name : apiKeyName(input);
  assertEmptyPermissions(input.permissions);
  const nextVersion = current.version + 1;
  const now = new Date().toISOString();
  const result = await mutationBatch(database, [
    database
      .prepare(
        `UPDATE api_keys SET name = ?, version = ?, updated_at = ?
         WHERE id = ? AND organization_id = ? AND version = ?`,
      )
      .bind(name, nextVersion, now, keyId, auth.organizationId, current.version),
    apiKeyEvent(
      database,
      "api_key.updated",
      keyId,
      nextVersion,
      auth.organizationId,
      requestId,
      now,
      { name },
    ),
  ]);
  if (result[0]?.meta.changes !== 1) {
    throw new ApiError(409, "stale_api_key", "API key changed concurrently");
  }
  const updated = await findApiKey(database, auth.organizationId, keyId);
  if (!updated) throw new Error("api_key_update_missing");
  return json({ api_key: serializeSanitizedApiKey(updated) }, { requestId });
}

async function rotateApiKey(
  request: Request,
  database: D1Database,
  auth: AuthContext,
  keyId: string,
  requestId: string,
): Promise<Response> {
  const current = await findApiKey(database, auth.organizationId, keyId);
  if (!current || current.revoked_at) {
    throw new ApiError(404, "api_key_not_found", "API key was not found");
  }
  const input = objectAt(await parseJsonObject(request), "api_key");
  const name = input.name === undefined ? current.name : apiKeyName(input);
  const expiresAt = optionalExpiry(input.expires_at);
  const generated = await generatedApiKey();
  const now = new Date().toISOString();
  const effectiveExpiry = expiresAt ?? now;
  if (effectiveExpiry < now) {
    throw new ApiError(422, "validation_error", "expires_at cannot be in the past");
  }
  const newKeyId = crypto.randomUUID();
  const nextVersion = current.version + 1;
  const event = apiKeyEvent(
    database,
    "api_key.rotated",
    newKeyId,
    1,
    auth.organizationId,
    requestId,
    now,
    { name, replaced_api_key_id: current.id, previous_version: nextVersion },
  );
  const result = await mutationBatch(database, [
    database
      .prepare(
        `UPDATE api_keys SET expires_at = ?, version = ?, updated_at = ?
         WHERE id = ? AND organization_id = ? AND version = ? AND revoked_at IS NULL`,
      )
      .bind(effectiveExpiry, nextVersion, now, current.id, auth.organizationId, current.version),
    database
      .prepare(
        `INSERT INTO api_keys
         (id, organization_id, key_prefix, key_hash, created_at, revoked_at, last_used_at,
          name, permissions_json, value_ending, expires_at, version, updated_at)
         VALUES (?, ?, ?, ?, ?, NULL, NULL, ?, '{}', ?, NULL, 1, ?)`,
      )
      .bind(
        newKeyId,
        auth.organizationId,
        generated.prefix,
        generated.hash,
        now,
        name,
        generated.ending,
        now,
      ),
    event,
  ]);
  if (result[0]?.meta.changes !== 1) {
    throw new ApiError(409, "stale_api_key", "API key changed concurrently");
  }
  const created = await findApiKey(database, auth.organizationId, newKeyId);
  if (!created) throw new Error("api_key_rotation_missing");
  return json(
    { api_key: { ...serializeSanitizedApiKey(created), value: generated.value } },
    { requestId },
  );
}

async function revokeApiKey(
  database: D1Database,
  auth: AuthContext,
  keyId: string,
  requestId: string,
): Promise<Response> {
  const current = await findApiKey(database, auth.organizationId, keyId);
  if (!current || current.revoked_at) {
    throw new ApiError(404, "api_key_not_found", "API key was not found");
  }
  const now = new Date().toISOString();
  const remaining = await database
    .prepare(
      `SELECT COUNT(*) AS total FROM api_keys
       WHERE organization_id = ? AND id <> ? AND revoked_at IS NULL
         AND expires_at IS NULL`,
    )
    .bind(auth.organizationId, keyId)
    .first<{ total: number }>();
  if (Number(remaining?.total ?? 0) === 0) {
    throw new ApiError(
      422,
      "last_non_expiring_api_key",
      "At least one other non-expiring API key must remain active",
    );
  }
  const nextVersion = current.version + 1;
  const result = await mutationBatch(database, [
    database
      .prepare(
        `UPDATE api_keys SET revoked_at = ?, expires_at = COALESCE(expires_at, ?),
                version = ?, updated_at = ?
         WHERE id = ? AND organization_id = ? AND version = ? AND revoked_at IS NULL`,
      )
      .bind(now, now, nextVersion, now, keyId, auth.organizationId, current.version),
    apiKeyEvent(
      database,
      "api_key.revoked",
      keyId,
      nextVersion,
      auth.organizationId,
      requestId,
      now,
      { name: current.name },
    ),
  ]);
  if (result[0]?.meta.changes !== 1) {
    throw new ApiError(409, "stale_api_key", "API key changed concurrently");
  }
  const revoked = await findApiKey(database, auth.organizationId, keyId);
  if (!revoked) throw new Error("api_key_revoke_missing");
  return json({ api_key: serializeSanitizedApiKey(revoked) }, { requestId });
}

function findApiKey(
  database: D1Database,
  organizationId: string,
  keyId: string,
): Promise<ApiKeyRow | null> {
  return database
    .prepare(`${apiKeySelect()} WHERE organization_id = ? AND id = ? LIMIT 1`)
    .bind(organizationId, keyId)
    .first<ApiKeyRow>();
}

function apiKeySelect(): string {
  return `SELECT id, organization_id, key_prefix, name, permissions_json, value_ending,
                 created_at, updated_at, expires_at, revoked_at, last_used_at, version
          FROM api_keys`;
}

function serializeSanitizedApiKey(key: ApiKeyRow) {
  return {
    id: key.id,
    name: key.name,
    permissions: parsePermissions(key.permissions_json),
    value: key.value_ending ? `••••••••${key.value_ending}` : `••••••••${key.key_prefix.slice(-3)}`,
    created_at: key.created_at,
    expires_at: key.expires_at,
    revoked_at: key.revoked_at,
    last_used_at: key.last_used_at,
    version: key.version,
  };
}

async function generatedApiKey(): Promise<{
  value: string;
  prefix: string;
  ending: string;
  hash: string;
}> {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  const random = [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  const value = `lago_${random}`;
  return {
    value,
    prefix: value.slice(0, 12),
    ending: value.slice(-3),
    hash: await sha256Hex(value),
  };
}

function apiKeyName(input: Record<string, unknown>): string | null {
  const name = optionalString(input, "name");
  if (name && name.length > 255) {
    throw new ApiError(422, "validation_error", "name must not exceed 255 characters");
  }
  return name;
}

function assertEmptyPermissions(value: unknown): void {
  if (value === undefined || value === null) return;
  const emptyObject =
    typeof value === "object" && !Array.isArray(value) && Object.keys(value).length === 0;
  const emptyArray = Array.isArray(value) && value.length === 0;
  if (!emptyObject && !emptyArray) {
    throw new ApiError(
      422,
      "unsupported_api_key_permissions",
      "Fine-grained API-key permissions are not enforced by the Cloudflare API yet",
    );
  }
}

function optionalExpiry(value: unknown): string | null {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string") {
    throw new ApiError(422, "validation_error", "expires_at must be an ISO timestamp");
  }
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) {
    throw new ApiError(422, "validation_error", "expires_at must be an ISO timestamp");
  }
  return parsed.toISOString();
}

function parsePermissions(value: string): Record<string, never> {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, never>;
    }
  } catch {
    // The migration check prevents invalid JSON; keep serialization fail-closed.
  }
  return {};
}

function apiKeyEvent(
  database: D1Database,
  eventType: string,
  aggregateId: string,
  aggregateVersion: number,
  organizationId: string,
  correlationId: string,
  occurredAt: string,
  payload: Record<string, unknown>,
): D1PreparedStatement {
  return database
    .prepare(
      `INSERT INTO outbox_events
       (event_id, organization_id, event_type, event_version, aggregate_type,
        aggregate_id, aggregate_version, causation_id, correlation_id, payload_json,
        occurred_at, published_at)
       VALUES (?, ?, ?, 1, 'api_key', ?, ?, NULL, ?, ?, ?, NULL)`,
    )
    .bind(
      crypto.randomUUID(),
      organizationId,
      eventType,
      aggregateId,
      aggregateVersion,
      correlationId,
      JSON.stringify(payload),
      occurredAt,
    );
}

async function mutationBatch(
  database: D1Database,
  statements: D1PreparedStatement[],
): Promise<D1Result<unknown>[]> {
  try {
    return await database.batch(statements);
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    if (
      message.includes("api_key_outbox_version_conflict") ||
      message.includes("api_key_rotation_version_conflict")
    ) {
      throw new ApiError(409, "stale_api_key", "API key changed concurrently");
    }
    throw error;
  }
}

function positiveInteger(value: string | null, fallback: number): number {
  if (value === null || value === "") return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new ApiError(422, "validation_error", "Pagination values must be positive integers");
  }
  return parsed;
}

function paginationMeta(total: number, page: number, perPage: number) {
  const totalPages = total === 0 ? 0 : Math.ceil(total / perPage);
  return {
    current_page: total === 0 ? 0 : page,
    next_page: page < totalPages ? page + 1 : null,
    prev_page: page > 1 && page <= totalPages ? page - 1 : null,
    total_pages: totalPages,
    total_count: total,
  };
}
