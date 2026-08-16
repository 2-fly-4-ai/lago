import type { AuthContext } from "../auth/api-key";
import { sha256Hex } from "../auth/api-key";
import type { DomainEvent } from "../domain-events";
import { ApiError, json, objectAt, parseJsonObject } from "../http";
import { deterministicUuid } from "../identifiers";
import { stableJson } from "../json";

export type DataExportResourceType =
  | "invoices"
  | "invoice_fees"
  | "credit_notes"
  | "credit_note_items";

export type DataExportRow = {
  id: string;
  organization_id: string;
  requested_by_api_key_id: string | null;
  format: "csv";
  resource_type: DataExportResourceType;
  resource_query_json: string;
  status: "pending" | "processing" | "completed" | "failed";
  version: number;
  idempotency_key: string;
  request_sha256: string;
  object_key: string | null;
  filename: string | null;
  etag: string | null;
  byte_size: number | null;
  row_count: number | null;
  error_code: string | null;
  started_at: string | null;
  completed_at: string | null;
  expires_at: string | null;
  created_at: string;
  updated_at: string;
};

type DataExportCreateEnv = Pick<Env, "BILLING_DB" | "DOCUMENT_WORKFLOW" | "DOMAIN_EVENTS"> & {
  TEST_MIGRATIONS?: Env["TEST_MIGRATIONS"];
};

const RESOURCE_TYPES = new Set<DataExportResourceType>([
  "invoices",
  "invoice_fees",
  "credit_notes",
  "credit_note_items",
]);
const INVOICE_FILTERS = new Set([
  "amount_from",
  "amount_to",
  "billing_entity_ids",
  "currency",
  "customer_external_id",
  "invoice_type",
  "issuing_date_from",
  "issuing_date_to",
  "payment_dispute_lost",
  "payment_overdue",
  "payment_status",
  "search_term",
  "self_billed",
  "status",
]);
const CREDIT_NOTE_FILTERS = new Set([
  "amount_from",
  "amount_to",
  "billing_entity_ids",
  "credit_status",
  "currency",
  "customer_external_id",
  "customer_id",
  "invoice_number",
  "issuing_date_from",
  "issuing_date_to",
  "reason",
  "refund_status",
  "search_term",
  "self_billed",
  "types",
]);
const ARRAY_ENUMS = new Map<string, Set<string>>([
  [
    "invoice_type",
    new Set([
      "subscription",
      "add_on",
      "credit",
      "one_off",
      "advance_charges",
      "progressive_billing",
    ]),
  ],
  ["payment_status", new Set(["pending", "succeeded", "failed"])],
  [
    "status",
    new Set(["draft", "finalized", "voided", "failed", "pending", "generating", "open", "closed"]),
  ],
  ["credit_status", new Set(["available", "consumed", "voided"])],
  ["refund_status", new Set(["pending", "succeeded", "failed"])],
  [
    "reason",
    new Set([
      "duplicated_charge",
      "product_unsatisfactory",
      "order_change",
      "order_cancellation",
      "fraudulent_charge",
      "other",
    ]),
  ],
  ["types", new Set(["credit", "refund", "offset"])],
]);

export async function handleDataExportsApi(
  request: Request,
  env: Env,
  auth: AuthContext,
  requestId: string,
): Promise<Response | null> {
  const url = new URL(request.url);
  if (url.pathname === "/api/v1/data_exports") {
    if (request.method === "POST") return createDataExport(request, env, auth, requestId);
    if (request.method === "GET") return listDataExports(url, env.BILLING_DB, auth, requestId);
    return null;
  }
  const match = url.pathname.match(/^\/api\/v1\/data_exports\/([^/]+)(?:\/(download|resend))?$/);
  if (!match?.[1]) return null;
  const exportId = decodeURIComponent(match[1]);
  const action = match[2];
  if (!action && request.method === "GET") {
    return showDataExport(exportId, env.BILLING_DB, auth, requestId);
  }
  if (action === "download" && request.method === "GET") {
    return downloadDataExport(exportId, env, auth, requestId);
  }
  if (action === "resend" && request.method === "POST") {
    await requiredDataExport(env.BILLING_DB, auth.organizationId, exportId);
    throw new ApiError(
      422,
      "data_export_email_disabled",
      "Data-export completion email is disabled in the isolated Cloudflare environment",
    );
  }
  return null;
}

export async function createDataExport(
  request: Request,
  env: DataExportCreateEnv,
  auth: AuthContext,
  requestId: string,
  requester?: { operatorMembershipId: string },
): Promise<Response> {
  const idempotencyKey = requiredIdempotencyKey(request);
  const input = objectAt(await parseJsonObject(request), "data_export");
  if (input.format !== "csv") {
    throw new ApiError(422, "validation_error", "format must be csv");
  }
  if (
    typeof input.resource_type !== "string" ||
    !RESOURCE_TYPES.has(input.resource_type as DataExportResourceType)
  ) {
    throw new ApiError(422, "validation_error", "resource_type is invalid");
  }
  const resourceType = input.resource_type as DataExportResourceType;
  const filters = normalizeFilters(input.filters, resourceType);
  const normalized = { format: "csv", resourceType, filters };
  const requestHash = await sha256Hex(stableJson(normalized));
  const replay = await findDataExportByIdempotency(
    env.BILLING_DB,
    auth.organizationId,
    idempotencyKey,
  );
  if (replay) {
    if (replay.request_sha256 !== requestHash) {
      throw new ApiError(
        409,
        "idempotency_conflict",
        "Idempotency-Key was reused with different export values",
      );
    }
    if (!env.TEST_MIGRATIONS)
      await dispatchDataExport(env, replay.id, auth.organizationId, requestId);
    return json({ data_export: serializeDataExport(replay) }, { requestId });
  }

  const now = new Date().toISOString();
  const exportId = await deterministicUuid(
    "data-export",
    `${auth.organizationId}:${idempotencyKey}`,
  );
  const event = dataExportEvent(
    "data_export.created",
    exportId,
    1,
    auth.organizationId,
    requestId,
    now,
    { status: "pending", resourceType },
  );
  const requestedByApiKeyId = requester ? null : auth.apiKeyId;
  const requestedByOperatorMembershipId = requester?.operatorMembershipId ?? null;
  try {
    await env.BILLING_DB.batch([
      env.BILLING_DB.prepare(
        `INSERT INTO data_exports
         (id, organization_id, requested_by_api_key_id, requested_by_operator_membership_id,
          format, resource_type,
          resource_query_json, status, version, idempotency_key, request_sha256,
          created_at, updated_at)
         VALUES (?, ?, ?, ?, 'csv', ?, ?, 'pending', 1, ?, ?, ?, ?)`,
      ).bind(
        exportId,
        auth.organizationId,
        requestedByApiKeyId,
        requestedByOperatorMembershipId,
        resourceType,
        stableJson(filters),
        idempotencyKey,
        requestHash,
        now,
        now,
      ),
      outboxStatement(env.BILLING_DB, auth.organizationId, event),
    ]);
  } catch (error) {
    const concurrent = await findDataExportByIdempotency(
      env.BILLING_DB,
      auth.organizationId,
      idempotencyKey,
    );
    if (!concurrent) throw error;
    if (concurrent.request_sha256 !== requestHash) {
      throw new ApiError(
        409,
        "idempotency_conflict",
        "Idempotency-Key was reused with different export values",
      );
    }
    if (!env.TEST_MIGRATIONS)
      await dispatchDataExport(env, concurrent.id, auth.organizationId, requestId);
    return json({ data_export: serializeDataExport(concurrent) }, { requestId });
  }
  await env.DOMAIN_EVENTS.send(event);
  if (!env.TEST_MIGRATIONS) await dispatchDataExport(env, exportId, auth.organizationId, requestId);
  const created = await requiredDataExport(env.BILLING_DB, auth.organizationId, exportId);
  return json({ data_export: serializeDataExport(created) }, { requestId });
}

export async function listDataExports(
  url: URL,
  database: D1Database,
  auth: AuthContext,
  requestId: string,
): Promise<Response> {
  const page = queryInteger(url.searchParams.get("page"), 1, "page");
  const perPage = Math.min(queryInteger(url.searchParams.get("per_page"), 20, "per_page"), 100);
  const count = await database
    .prepare("SELECT COUNT(*) AS total FROM data_exports WHERE organization_id = ?")
    .bind(auth.organizationId)
    .first<{ total: number }>();
  const rows = await database
    .prepare(
      `${dataExportSelect()} WHERE organization_id = ? ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`,
    )
    .bind(auth.organizationId, perPage, (page - 1) * perPage)
    .all<DataExportRow>();
  return json(
    {
      data_exports: rows.results.map(serializeDataExport),
      meta: pagination(count?.total ?? 0, page, perPage),
    },
    { requestId },
  );
}

export async function showDataExport(
  exportId: string,
  database: D1Database,
  auth: AuthContext,
  requestId: string,
): Promise<Response> {
  const row = await requiredDataExport(database, auth.organizationId, exportId);
  return json({ data_export: serializeDataExport(row) }, { requestId });
}

async function downloadDataExport(
  exportId: string,
  env: Env,
  auth: AuthContext,
  requestId: string,
): Promise<Response> {
  const row = await requiredDataExport(env.BILLING_DB, auth.organizationId, exportId);
  if (row.status !== "completed" || !row.object_key || !row.filename) {
    throw new ApiError(422, "data_export_not_ready", "Data export is not ready for download");
  }
  if (!row.expires_at || Date.parse(row.expires_at) <= Date.now()) {
    throw new ApiError(410, "data_export_expired", "Data export has expired");
  }
  const object = await env.BILLING_ARTIFACTS.get(row.object_key);
  if (!object) throw new ApiError(503, "artifact_missing", "Data export artifact is unavailable");
  return new Response(object.body, {
    headers: {
      "Cache-Control": "private, no-store",
      "Content-Disposition": `attachment; filename="${safeFilename(row.filename)}"`,
      "Content-Type": "text/csv; charset=utf-8",
      ETag: object.httpEtag,
      "X-Request-Id": requestId,
    },
  });
}

export async function dispatchDataExport(
  env: Pick<Env, "DOCUMENT_WORKFLOW">,
  dataExportId: string,
  organizationId: string,
  correlationId: string,
): Promise<void> {
  try {
    await env.DOCUMENT_WORKFLOW.create({
      id: `data-export-${dataExportId}`,
      params: { kind: "data_export", dataExportId, organizationId, correlationId },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message.toLowerCase() : "";
    if (!message.includes("already exists")) throw error;
  }
}

export async function requiredDataExport(
  database: D1Database,
  organizationId: string,
  exportId: string,
): Promise<DataExportRow> {
  const row = await database
    .prepare(`${dataExportSelect()} WHERE organization_id = ? AND id = ? LIMIT 1`)
    .bind(organizationId, exportId)
    .first<DataExportRow>();
  if (!row) throw new ApiError(404, "data_export_not_found", "Data export was not found");
  return row;
}

function findDataExportByIdempotency(
  database: D1Database,
  organizationId: string,
  idempotencyKey: string,
): Promise<DataExportRow | null> {
  return database
    .prepare(`${dataExportSelect()} WHERE organization_id = ? AND idempotency_key = ? LIMIT 1`)
    .bind(organizationId, idempotencyKey)
    .first<DataExportRow>();
}

function dataExportSelect(): string {
  return `SELECT id, organization_id, requested_by_api_key_id, format, resource_type,
    resource_query_json, status, version, idempotency_key, request_sha256, object_key, filename,
    etag, byte_size, row_count, error_code, started_at, completed_at, expires_at, created_at,
    updated_at FROM data_exports`;
}

function serializeDataExport(row: DataExportRow): Record<string, unknown> {
  const expired = row.expires_at !== null && Date.parse(row.expires_at) <= Date.now();
  return {
    lago_id: row.id,
    format: row.format,
    resource_type: row.resource_type,
    status: row.status,
    file_url:
      row.status === "completed" && !expired
        ? `/api/v1/data_exports/${encodeURIComponent(row.id)}/download`
        : null,
    filename: row.filename,
    byte_size: row.byte_size,
    row_count: row.row_count,
    error_code: row.error_code,
    started_at: row.started_at,
    completed_at: row.completed_at,
    expires_at: row.expires_at,
    created_at: row.created_at,
    updated_at: row.updated_at,
    version: row.version,
  };
}

function normalizeFilters(
  value: unknown,
  resourceType: DataExportResourceType,
): Record<string, unknown> {
  if (value === undefined || value === null) return {};
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new ApiError(422, "validation_error", "filters must be an object");
  }
  const input = value as Record<string, unknown>;
  const allowed = resourceType.startsWith("invoice") ? INVOICE_FILTERS : CREDIT_NOTE_FILTERS;
  const unsupported = Object.keys(input).find((key) => !allowed.has(key));
  if (unsupported) {
    throw new ApiError(422, "validation_error", `filters.${unsupported} is not supported`);
  }
  const result: Record<string, unknown> = {};
  for (const [key, raw] of Object.entries(input)) {
    if (raw === undefined || raw === null || raw === "") continue;
    if (key === "amount_from" || key === "amount_to") {
      if (typeof raw !== "number" || !Number.isSafeInteger(raw) || raw < 0) {
        throw new ApiError(
          422,
          "validation_error",
          `filters.${key} must be a non-negative integer`,
        );
      }
      result[key] = raw;
      continue;
    }
    if (key === "payment_dispute_lost" || key === "payment_overdue" || key === "self_billed") {
      if (typeof raw !== "boolean") {
        throw new ApiError(422, "validation_error", `filters.${key} must be a boolean`);
      }
      result[key] = raw;
      continue;
    }
    if (key === "billing_entity_ids") {
      result[key] = stringArray(raw, key, null);
      continue;
    }
    const enumValues = ARRAY_ENUMS.get(key);
    if (enumValues) {
      result[key] = stringArray(raw, key, enumValues);
      continue;
    }
    if (typeof raw !== "string" || !raw.trim()) {
      throw new ApiError(422, "validation_error", `filters.${key} must be a string`);
    }
    const normalized = raw.trim();
    if (key === "currency") {
      if (!/^[A-Za-z]{3}$/.test(normalized)) {
        throw new ApiError(
          422,
          "validation_error",
          "filters.currency must be an ISO currency code",
        );
      }
      result[key] = normalized.toUpperCase();
    } else if (key === "issuing_date_from" || key === "issuing_date_to") {
      result[key] = isoDate(normalized, `filters.${key}`);
    } else {
      if (normalized.length > 200) {
        throw new ApiError(422, "validation_error", `filters.${key} is too long`);
      }
      result[key] = normalized;
    }
  }
  if (
    typeof result.amount_from === "number" &&
    typeof result.amount_to === "number" &&
    result.amount_from > result.amount_to
  ) {
    throw new ApiError(422, "validation_error", "filters.amount_from must not exceed amount_to");
  }
  if (
    typeof result.issuing_date_from === "string" &&
    typeof result.issuing_date_to === "string" &&
    result.issuing_date_from > result.issuing_date_to
  ) {
    throw new ApiError(
      422,
      "validation_error",
      "filters.issuing_date_from must not exceed issuing_date_to",
    );
  }
  return result;
}

function stringArray(value: unknown, field: string, allowed: Set<string> | null): string[] {
  if (!Array.isArray(value) || value.length > 100) {
    throw new ApiError(
      422,
      "validation_error",
      `filters.${field} must be an array of at most 100 values`,
    );
  }
  const values = value.map((item) => {
    if (typeof item !== "string" || !item.trim()) {
      throw new ApiError(422, "validation_error", `filters.${field} contains an invalid value`);
    }
    const normalized = item.trim();
    if (allowed && !allowed.has(normalized)) {
      throw new ApiError(422, "validation_error", `filters.${field} contains an unsupported value`);
    }
    return normalized;
  });
  return [...new Set(values)].sort();
}

function isoDate(value: string, field: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new ApiError(422, "validation_error", `${field} must use YYYY-MM-DD`);
  }
  const date = new Date(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== value) {
    throw new ApiError(422, "validation_error", `${field} is not a valid date`);
  }
  return value;
}

function requiredIdempotencyKey(request: Request): string {
  const value = request.headers.get("Idempotency-Key")?.trim();
  if (!value) throw new ApiError(422, "idempotency_key_required", "Idempotency-Key is required");
  if (value.length > 200)
    throw new ApiError(422, "validation_error", "Idempotency-Key is too long");
  return value;
}

function queryInteger(value: string | null, fallback: number, field: string): number {
  if (value === null || value === "") return fallback;
  if (!/^\d+$/.test(value)) {
    throw new ApiError(422, "validation_error", `${field} must be a positive integer`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new ApiError(422, "validation_error", `${field} must be a positive integer`);
  }
  return parsed;
}

function pagination(total: number, page: number, perPage: number) {
  const pages = total === 0 ? 0 : Math.ceil(total / perPage);
  return {
    current_page: total === 0 ? 0 : page,
    next_page: page < pages ? page + 1 : null,
    prev_page: page > 1 && page <= pages ? page - 1 : null,
    total_pages: pages,
    total_count: total,
  };
}

function safeFilename(value: string): string {
  return value.replaceAll(/[^A-Za-z0-9._-]/g, "_");
}

function dataExportEvent(
  type: string,
  exportId: string,
  aggregateVersion: number,
  organizationId: string,
  requestId: string,
  occurredAt: string,
  values: Record<string, unknown>,
): DomainEvent {
  return {
    id: `${type}:${exportId}:v${aggregateVersion}`,
    type,
    version: 1,
    aggregateType: "data_export",
    aggregateId: exportId,
    aggregateVersion,
    occurredAt,
    causationId: requestId,
    correlationId: requestId,
    payload: { organizationId, dataExportId: exportId, ...values },
  };
}

export function dataExportOutboxStatement(
  database: D1Database,
  organizationId: string,
  event: DomainEvent,
): D1PreparedStatement {
  return outboxStatement(database, organizationId, event);
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
