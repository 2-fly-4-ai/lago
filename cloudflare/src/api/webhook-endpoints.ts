import type { AuthContext } from "../auth/api-key";
import { ApiError, json, objectAt, optionalString, parseJsonObject, requiredString } from "../http";
import { stableJson } from "../json";

type EndpointRow = {
  id: string;
  organization_id: string;
  webhook_url: string;
  signature_algo: string;
  name: string | null;
  event_types_json: string | null;
  status: string;
  version: number;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
};

const EVENT_TYPE = /^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)+$/;

export async function handleWebhookEndpointRequest(
  request: Request,
  env: Env,
  auth: AuthContext,
  requestId: string,
): Promise<Response | null> {
  const url = new URL(request.url);
  if (request.method === "POST" && url.pathname === "/api/v1/webhook_endpoints")
    return createEndpoint(request, env, auth, requestId);
  if (request.method === "GET" && url.pathname === "/api/v1/webhook_endpoints")
    return listEndpoints(url, env.BILLING_DB, auth, requestId);
  const match = url.pathname.match(/^\/api\/v1\/webhook_endpoints\/([^/]+)$/);
  if (!match?.[1]) return null;
  const id = decodeURIComponent(match[1]);
  if (request.method === "GET") return showEndpoint(id, env.BILLING_DB, auth, requestId);
  if (request.method === "PUT") return updateEndpoint(id, request, env, auth, requestId);
  if (request.method === "DELETE") return deleteEndpoint(id, env, auth, requestId);
  return null;
}

async function createEndpoint(request: Request, env: Env, auth: AuthContext, requestId: string) {
  requireOutboundEnabled(env);
  const input = objectAt(await parseJsonObject(request), "webhook_endpoint");
  const webhookUrl = secureWebhookUrl(requiredString(input, "webhook_url"));
  const signatureAlgo = optionalString(input, "signature_algo") ?? "hmac";
  if (signatureAlgo !== "hmac")
    throw new ApiError(422, "unsupported_signature_algorithm", "Only HMAC-SHA256 is implemented");
  const eventTypes = normalizeEventTypes(input.event_types);
  const existing = await env.BILLING_DB.prepare(
    `${endpointSelect()} WHERE organization_id = ? AND webhook_url = ? AND status = 'active' LIMIT 1`,
  )
    .bind(auth.organizationId, webhookUrl)
    .first<EndpointRow>();
  if (existing) throw new ApiError(422, "value_already_exist", "Webhook URL already exists");
  const now = new Date().toISOString();
  const id = crypto.randomUUID();
  try {
    await env.BILLING_DB.prepare(
      `INSERT INTO webhook_endpoints
       (id, organization_id, webhook_url, signature_algo, name, event_types_json, status,
        version, created_at, updated_at) VALUES (?, ?, ?, 'hmac', ?, ?, 'active', 1, ?, ?)`,
    )
      .bind(
        id,
        auth.organizationId,
        webhookUrl,
        optionalString(input, "name"),
        eventTypes === null ? null : stableJson(eventTypes),
        now,
        now,
      )
      .run();
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    if (message.includes("webhook_endpoint_limit"))
      throw new ApiError(422, "exceeded_limit", "At most ten webhook endpoints are allowed");
    throw new ApiError(422, "value_already_exist", "Webhook URL already exists");
  }
  const endpoint = await findEndpoint(env.BILLING_DB, auth.organizationId, id);
  if (!endpoint) throw new ApiError(500, "persistence_error", "Webhook endpoint was not persisted");
  return json({ webhook_endpoint: serializeEndpoint(endpoint) }, { requestId });
}

export async function listEndpoints(
  url: URL,
  database: D1Database,
  auth: AuthContext,
  requestId: string,
) {
  const page = positivePage(url.searchParams.get("page"));
  const perPage = Math.min(positivePage(url.searchParams.get("per_page"), 20), 100);
  const offset = (page - 1) * perPage;
  const count = await database
    .prepare(
      "SELECT COUNT(*) AS total FROM webhook_endpoints WHERE organization_id = ? AND status = 'active'",
    )
    .bind(auth.organizationId)
    .first<{ total: number }>();
  const rows = await database
    .prepare(
      `${endpointSelect()} WHERE organization_id = ? AND status = 'active'
       ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`,
    )
    .bind(auth.organizationId, perPage, offset)
    .all<EndpointRow>();
  const total = count?.total ?? 0;
  const pages = total === 0 ? 0 : Math.ceil(total / perPage);
  return json(
    {
      webhook_endpoints: rows.results.map(serializeEndpoint),
      meta: {
        current_page: total === 0 ? 0 : page,
        next_page: page < pages ? page + 1 : null,
        prev_page: page > 1 && pages > 0 ? page - 1 : null,
        total_pages: pages,
        total_count: total,
      },
    },
    { requestId },
  );
}

export async function showEndpoint(
  id: string,
  database: D1Database,
  auth: AuthContext,
  requestId: string,
) {
  const endpoint = await findEndpoint(database, auth.organizationId, id);
  if (!endpoint || endpoint.status !== "active")
    throw new ApiError(404, "webhook_endpoint_not_found", "Webhook endpoint was not found");
  return json({ webhook_endpoint: serializeEndpoint(endpoint) }, { requestId });
}

async function updateEndpoint(
  id: string,
  request: Request,
  env: Env,
  auth: AuthContext,
  requestId: string,
) {
  requireOutboundEnabled(env);
  const endpoint = await findEndpoint(env.BILLING_DB, auth.organizationId, id);
  if (!endpoint || endpoint.status !== "active")
    throw new ApiError(404, "webhook_endpoint_not_found", "Webhook endpoint was not found");
  const input = objectAt(await parseJsonObject(request), "webhook_endpoint");
  const signatureAlgo =
    input.signature_algo === undefined
      ? endpoint.signature_algo
      : requiredString(input, "signature_algo");
  if (signatureAlgo !== "hmac")
    throw new ApiError(422, "unsupported_signature_algorithm", "Only HMAC-SHA256 is implemented");
  const webhookUrl =
    input.webhook_url === undefined
      ? endpoint.webhook_url
      : secureWebhookUrl(requiredString(input, "webhook_url"));
  const eventTypes =
    input.event_types === undefined
      ? endpoint.event_types_json
      : normalizeEventTypes(input.event_types) === null
        ? null
        : stableJson(normalizeEventTypes(input.event_types));
  const now = new Date().toISOString();
  try {
    const result = await env.BILLING_DB.prepare(
      `UPDATE webhook_endpoints SET webhook_url = ?, signature_algo = 'hmac', name = ?,
       event_types_json = ?, version = version + 1, updated_at = ?
       WHERE id = ? AND organization_id = ? AND status = 'active' AND version = ?`,
    )
      .bind(
        webhookUrl,
        input.name === undefined ? endpoint.name : optionalString(input, "name"),
        eventTypes,
        now,
        id,
        auth.organizationId,
        endpoint.version,
      )
      .run();
    if (result.meta.changes !== 1)
      throw new ApiError(409, "webhook_endpoint_version_conflict", "Endpoint changed concurrently");
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError(422, "value_already_exist", "Webhook URL already exists");
  }
  const updated = await findEndpoint(env.BILLING_DB, auth.organizationId, id);
  if (!updated) throw new ApiError(500, "persistence_error", "Webhook endpoint disappeared");
  return json({ webhook_endpoint: serializeEndpoint(updated) }, { requestId });
}

async function deleteEndpoint(id: string, env: Env, auth: AuthContext, requestId: string) {
  requireOutboundEnabled(env);
  let endpoint = await findEndpoint(env.BILLING_DB, auth.organizationId, id);
  if (!endpoint)
    throw new ApiError(404, "webhook_endpoint_not_found", "Webhook endpoint was not found");
  if (endpoint.status === "deleted")
    return json({ webhook_endpoint: serializeEndpoint(endpoint) }, { requestId });
  const now = new Date().toISOString();
  const result = await env.BILLING_DB.prepare(
    `UPDATE webhook_endpoints SET status = 'deleted', deleted_at = ?, updated_at = ?,
     version = version + 1 WHERE id = ? AND organization_id = ? AND status = 'active' AND version = ?`,
  )
    .bind(now, now, id, auth.organizationId, endpoint.version)
    .run();
  if (result.meta.changes !== 1)
    throw new ApiError(409, "webhook_endpoint_version_conflict", "Endpoint changed concurrently");
  endpoint = await findEndpoint(env.BILLING_DB, auth.organizationId, id);
  if (!endpoint) throw new ApiError(500, "persistence_error", "Webhook endpoint disappeared");
  return json({ webhook_endpoint: serializeEndpoint(endpoint) }, { requestId });
}

function findEndpoint(database: D1Database, organizationId: string, id: string) {
  return database
    .prepare(`${endpointSelect()} WHERE organization_id = ? AND id = ? LIMIT 1`)
    .bind(organizationId, id)
    .first<EndpointRow>();
}

function endpointSelect() {
  return "SELECT id, organization_id, webhook_url, signature_algo, name, event_types_json, status, version, created_at, updated_at, deleted_at FROM webhook_endpoints";
}

function serializeEndpoint(endpoint: EndpointRow) {
  return {
    lago_id: endpoint.id,
    lago_organization_id: endpoint.organization_id,
    webhook_url: endpoint.webhook_url,
    signature_algo: endpoint.signature_algo,
    name: endpoint.name,
    event_types: endpoint.event_types_json
      ? (JSON.parse(endpoint.event_types_json) as string[])
      : null,
    created_at: endpoint.created_at,
  };
}

function normalizeEventTypes(value: unknown): string[] | null {
  if (value === undefined || value === null) return null;
  if (!Array.isArray(value))
    throw new ApiError(422, "validation_error", "event_types must be an array");
  const normalized = [
    ...new Set(
      value.map((item) => {
        if (typeof item !== "string" || !item.trim())
          throw new ApiError(422, "validation_error", "event_types must contain strings");
        return item.trim().toLowerCase();
      }),
    ),
  ];
  if (normalized.length === 1 && normalized[0] === "*") return null;
  if (normalized.some((item) => !EVENT_TYPE.test(item)))
    throw new ApiError(422, "validation_error", "event_types contains an invalid event type");
  return normalized;
}

function secureWebhookUrl(value: string) {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ApiError(422, "validation_error", "webhook_url must be a valid URL");
  }
  if (url.protocol !== "https:" || url.username || url.password || url.port)
    throw new ApiError(
      422,
      "unsafe_webhook_url",
      "webhook_url must use HTTPS without credentials or an explicit port",
    );
  const host = url.hostname.toLowerCase();
  if (isPrivateHost(host))
    throw new ApiError(422, "unsafe_webhook_url", "Private webhook targets are not allowed");
  return url.toString();
}

function isPrivateHost(host: string) {
  const normalized = host.replace(/^\[|\]$/g, "").toLowerCase();
  return (
    normalized === "localhost" ||
    normalized.endsWith(".localhost") ||
    normalized.endsWith(".local") ||
    normalized.endsWith(".internal") ||
    normalized === "0.0.0.0" ||
    normalized.startsWith("127.") ||
    normalized.startsWith("10.") ||
    normalized.startsWith("169.254.") ||
    normalized.startsWith("192.168.") ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(normalized) ||
    /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(normalized) ||
    normalized === "::" ||
    normalized === "::1" ||
    normalized.startsWith("fc") ||
    normalized.startsWith("fd") ||
    /^fe[89ab]/.test(normalized)
  );
}

function requireOutboundEnabled(env: Env) {
  const flag = env.OUTBOUND_WEBHOOKS_ENABLED as string;
  if (flag !== "1")
    throw new ApiError(
      503,
      "outbound_webhooks_disabled",
      "Outbound webhooks require an approved signing-secret configuration",
    );
}

function positivePage(value: string | null, fallback = 1) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}
