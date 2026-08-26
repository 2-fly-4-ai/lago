import { ApiError, json } from "../http";
import { authenticateOperatorAccess, type OperatorEnv } from "./access";
import type { JWTVerifyGetKey } from "jose";

type ActivityRow = {
  event_id: string;
  event_type: string;
  aggregate_type: string;
  aggregate_id: string;
  aggregate_version: number;
  payload_json: string;
  occurred_at: string;
  published_at: string | null;
};

type ApiLogRow = {
  id: string;
  request_id: string;
  method: string;
  route_template: string;
  response_status: number;
  duration_ms: number;
  occurred_at: string;
};

type UsageEventRow = {
  id: string;
  transaction_id: string;
  code: string;
  external_subscription_id: string | null;
  timestamp: string;
  created_at: string;
};

type WebhookLogRow = {
  id: string;
  webhook_endpoint_id: string;
  event_id: string;
  event_type: string;
  status: string;
  attempts: number;
  http_status: number | null;
  last_attempted_at: string | null;
  created_at: string;
  updated_at: string;
};

export async function handleOperatorObservabilityRequest(
  request: Request,
  database: D1Database,
  organizationId: string,
  requestId: string,
): Promise<Response | null> {
  if (request.method !== "GET") return null;
  const url = new URL(request.url);

  const activityMatch = url.pathname.match(
    /^\/api\/operator\/v1\/observability\/activity-logs(?:\/([^/]+))?$/,
  );
  if (activityMatch) {
    const logId = activityMatch[1] ? decodeURIComponent(activityMatch[1]) : null;
    return activityLogs(database, organizationId, requestId, logId, url.searchParams);
  }

  const apiLogMatch = url.pathname.match(
    /^\/api\/operator\/v1\/observability\/api-logs(?:\/([^/]+))?$/,
  );
  if (apiLogMatch) {
    const logId = apiLogMatch[1] ? decodeURIComponent(apiLogMatch[1]) : null;
    return apiLogs(database, organizationId, requestId, logId, url.searchParams);
  }

  const eventMatch = url.pathname.match(
    /^\/api\/operator\/v1\/observability\/events(?:\/([^/]+))?$/,
  );
  if (eventMatch) {
    const eventId = eventMatch[1] ? decodeURIComponent(eventMatch[1]) : null;
    return usageEvents(database, organizationId, requestId, eventId, url.searchParams);
  }

  const webhookMatch = url.pathname.match(
    /^\/api\/operator\/v1\/webhook-endpoints\/([^/]+)\/logs(?:\/([^/]+))?$/,
  );
  if (webhookMatch?.[1]) {
    return webhookLogs(
      database,
      organizationId,
      requestId,
      decodeURIComponent(webhookMatch[1]),
      webhookMatch[2] ? decodeURIComponent(webhookMatch[2]) : null,
      url.searchParams,
    );
  }

  return null;
}

export async function recordOperatorApiLog(
  request: Request,
  env: OperatorEnv,
  keySet: JWTVerifyGetKey | undefined,
  requestId: string,
  status: number,
  durationMs: number,
): Promise<void> {
  const url = new URL(request.url);
  if (!url.pathname.startsWith("/api/operator/v1/") || url.pathname.includes("/observability/")) {
    return;
  }
  try {
    const operator = await authenticateOperatorAccess(request, env, keySet);
    const occurredAt = new Date().toISOString();
    const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1_000).toISOString();
    await env.BILLING_DB.batch([
      env.BILLING_DB.prepare(
        `INSERT INTO operator_api_logs
         (id, organization_id, membership_id, request_id, method, route_template,
          response_status, duration_ms, occurred_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(
        crypto.randomUUID(),
        operator.organizationId,
        operator.membershipId,
        requestId,
        request.method,
        routeTemplate(url.pathname),
        status,
        Math.max(0, Math.round(durationMs)),
        occurredAt,
        expiresAt,
      ),
      env.BILLING_DB.prepare(
        `DELETE FROM operator_api_logs
         WHERE id IN (SELECT id FROM operator_api_logs WHERE expires_at < ? ORDER BY expires_at LIMIT 50)`,
      ).bind(occurredAt),
    ]);
  } catch {
    // Observability must never alter the operator response or weaken Access.
  }
}

async function activityLogs(
  database: D1Database,
  organizationId: string,
  requestId: string,
  logId: string | null,
  search: URLSearchParams,
): Promise<Response> {
  const aggregateType = boundedFilter(search.get("resource_type"), 80);
  const aggregateId = boundedFilter(search.get("resource_id"), 200);
  const statements: string[] = ["organization_id = ?"];
  const values: unknown[] = [organizationId];
  if (logId) {
    statements.push("event_id = ?");
    values.push(logId);
  }
  if (aggregateType) {
    statements.push("aggregate_type = ?");
    values.push(aggregateType);
  }
  if (aggregateId) {
    statements.push("aggregate_id = ?");
    values.push(aggregateId);
  }
  const result = await database
    .prepare(
      `SELECT event_id, event_type, aggregate_type, aggregate_id, aggregate_version,
              payload_json, occurred_at, published_at
       FROM outbox_events WHERE ${statements.join(" AND ")}
       ORDER BY occurred_at DESC, aggregate_version DESC LIMIT ${logId ? 1 : listLimit(search)}`,
    )
    .bind(...values)
    .all<ActivityRow>();
  if (logId && result.results.length === 0) {
    throw new ApiError(404, "activity_log_not_found", "Activity log was not found");
  }
  const rows = result.results.map((row) => ({
    lago_id: row.event_id,
    event_type: row.event_type,
    resource_type: row.aggregate_type,
    resource_id: row.aggregate_id,
    version: row.aggregate_version,
    changes: safePayload(row.payload_json),
    occurred_at: row.occurred_at,
    delivery_status: row.published_at ? "published" : "pending",
  }));
  return json(logId ? { activity_log: rows[0] } : { activity_logs: rows }, { requestId });
}

async function apiLogs(
  database: D1Database,
  organizationId: string,
  requestId: string,
  logId: string | null,
  search: URLSearchParams,
): Promise<Response> {
  const result = await database
    .prepare(
      `SELECT id, request_id, method, route_template, response_status, duration_ms, occurred_at
       FROM operator_api_logs WHERE organization_id = ?${logId ? " AND id = ?" : ""}
       ORDER BY occurred_at DESC, id DESC LIMIT ${logId ? 1 : listLimit(search)}`,
    )
    .bind(...(logId ? [organizationId, logId] : [organizationId]))
    .all<ApiLogRow>();
  if (logId && result.results.length === 0) {
    throw new ApiError(404, "api_log_not_found", "API log was not found");
  }
  const rows = result.results.map((row) => ({
    lago_id: row.id,
    request_id: row.request_id,
    method: row.method,
    path: row.route_template,
    status: row.response_status,
    duration_ms: row.duration_ms,
    occurred_at: row.occurred_at,
    request_body: "Not retained",
    response_body: "Not retained",
  }));
  return json(logId ? { api_log: rows[0] } : { api_logs: rows }, { requestId });
}

async function usageEvents(
  database: D1Database,
  organizationId: string,
  requestId: string,
  eventId: string | null,
  search: URLSearchParams,
): Promise<Response> {
  const result = await database
    .prepare(
      `SELECT id, transaction_id, code, external_subscription_id, timestamp, created_at
       FROM usage_events WHERE organization_id = ? AND deleted_at IS NULL${eventId ? " AND id = ?" : ""}
       ORDER BY timestamp_ms DESC, id DESC LIMIT ${eventId ? 1 : listLimit(search)}`,
    )
    .bind(...(eventId ? [organizationId, eventId] : [organizationId]))
    .all<UsageEventRow>();
  if (eventId && result.results.length === 0) {
    throw new ApiError(404, "event_not_found", "Event was not found");
  }
  const rows = result.results.map((row) => ({
    lago_id: row.id,
    transaction_id: row.transaction_id,
    code: row.code,
    external_subscription_id: row.external_subscription_id,
    timestamp: row.timestamp,
    received_at: row.created_at,
    properties: "Redacted from operator logs",
  }));
  return json(eventId ? { event: rows[0] } : { events: rows }, { requestId });
}

async function webhookLogs(
  database: D1Database,
  organizationId: string,
  requestId: string,
  endpointId: string,
  logId: string | null,
  search: URLSearchParams,
): Promise<Response> {
  const endpoint = await database
    .prepare(
      "SELECT id FROM webhook_endpoints WHERE id = ? AND organization_id = ? AND status = 'active'",
    )
    .bind(endpointId, organizationId)
    .first<{ id: string }>();
  if (!endpoint)
    throw new ApiError(404, "webhook_endpoint_not_found", "Webhook endpoint was not found");
  const result = await database
    .prepare(
      `SELECT id, webhook_endpoint_id, event_id, event_type, status, attempts, http_status,
              last_attempted_at, created_at, updated_at
       FROM outbound_webhook_deliveries
       WHERE organization_id = ? AND webhook_endpoint_id = ?${logId ? " AND id = ?" : ""}
       ORDER BY updated_at DESC, id DESC LIMIT ${logId ? 1 : listLimit(search)}`,
    )
    .bind(...(logId ? [organizationId, endpointId, logId] : [organizationId, endpointId]))
    .all<WebhookLogRow>();
  if (logId && result.results.length === 0) {
    throw new ApiError(404, "webhook_log_not_found", "Webhook log was not found");
  }
  const rows = result.results.map((row) => ({
    lago_id: row.id,
    webhook_endpoint_id: row.webhook_endpoint_id,
    event_id: row.event_id,
    event_type: row.event_type,
    status: row.status,
    attempts: row.attempts,
    http_status: row.http_status,
    last_attempted_at: row.last_attempted_at,
    created_at: row.created_at,
    updated_at: row.updated_at,
    payload: "Not retained in operator responses",
    response: "Not retained in operator responses",
    retry_available: false,
  }));
  return json(logId ? { webhook_log: rows[0] } : { webhook_logs: rows }, { requestId });
}

function listLimit(search: URLSearchParams): number {
  const candidate = Number(search.get("limit") ?? 50);
  return Number.isInteger(candidate) ? Math.min(100, Math.max(1, candidate)) : 50;
}

function boundedFilter(value: string | null, max: number): string | null {
  const candidate = value?.trim();
  return candidate && candidate.length <= max ? candidate : null;
}

function routeTemplate(pathname: string): string {
  const segments = pathname.split("/").filter(Boolean);
  if (segments.length <= 4) return pathname;
  return `/${segments.slice(0, 4).join("/")}/${segments
    .slice(4)
    .map((segment) => (actionSegment(segment) ? segment : ":id"))
    .join("/")}`;
}

function actionSegment(segment: string): boolean {
  return new Set([
    "activity",
    "entitlements",
    "finalize",
    "refresh",
    "void",
    "rotate",
    "terminate",
    "logs",
  ]).has(segment);
}

function safePayload(raw: string): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(raw);
    return scrubValue(value, 0) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function scrubValue(value: unknown, depth: number): unknown {
  if (depth > 3) return "[redacted]";
  if (Array.isArray(value)) return value.slice(0, 20).map((item) => scrubValue(item, depth + 1));
  if (!value || typeof value !== "object") return value;
  const output: Record<string, unknown> = {};
  for (const [key, candidate] of Object.entries(value as Record<string, unknown>).slice(0, 50)) {
    if (/email|name|address|token|secret|password|key|url|body|payload|properties/i.test(key)) {
      output[key] = "[redacted]";
    } else {
      output[key] = scrubValue(candidate, depth + 1);
    }
  }
  return output;
}
