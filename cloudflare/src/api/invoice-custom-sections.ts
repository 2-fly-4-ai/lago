import type { AuthContext } from "../auth/api-key";
import { sha256Hex } from "../auth/api-key";
import type { DomainEvent } from "../domain-events";
import { ApiError, json, objectAt, optionalString, parseJsonObject, requiredString } from "../http";
import { stableJson } from "../json";

type SectionRow = {
  id: string;
  organization_id: string;
  code: string;
  name: string;
  description: string | null;
  details: string | null;
  display_name: string | null;
  section_type: "manual" | "system_generated";
  status: "active" | "terminated";
  version: number;
  request_sha256: string;
  created_at: string;
  updated_at: string;
  terminated_at: string | null;
};

export async function handleInvoiceCustomSectionRequest(
  request: Request,
  env: Env,
  auth: AuthContext,
  requestId: string,
): Promise<Response | null> {
  const url = new URL(request.url);
  if (url.pathname === "/api/v1/invoice_custom_sections") {
    if (request.method === "POST") return createSection(request, env, auth, requestId);
    if (request.method === "GET") return listSections(url, env.BILLING_DB, auth, requestId);
  }
  const match = url.pathname.match(/^\/api\/v1\/invoice_custom_sections\/([^/]+)$/);
  if (!match?.[1]) return null;
  const code = decodeURIComponent(match[1]);
  if (request.method === "GET") return showSection(code, env.BILLING_DB, auth, requestId);
  if (request.method === "PUT") return updateSection(code, request, env, auth, requestId);
  if (request.method === "DELETE") return terminateSection(code, env, auth, requestId);
  return null;
}

async function createSection(request: Request, env: Env, auth: AuthContext, requestId: string) {
  const input = objectAt(await parseJsonObject(request), "invoice_custom_section");
  rejectUnsupported(input, ["code", "name", "description", "details", "display_name"]);
  const normalized = {
    code: requiredString(input, "code"),
    name: requiredString(input, "name"),
    description: optionalString(input, "description"),
    details: optionalString(input, "details"),
    displayName: optionalString(input, "display_name"),
  };
  const requestHash = await sha256Hex(stableJson(normalized));
  const existing = await findActive(env.BILLING_DB, auth.organizationId, normalized.code);
  if (existing) {
    if (existing.request_sha256 === requestHash)
      return json({ invoice_custom_section: serializeSection(existing) }, { requestId });
    throw new ApiError(422, "value_already_exist", "Invoice custom section code already exists");
  }
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const event = sectionEvent("invoice_custom_section.created", id, 1, auth, requestId, now, {
    code: normalized.code,
  });
  try {
    await env.BILLING_DB.batch([
      env.BILLING_DB.prepare(
        `INSERT INTO invoice_custom_sections
         (id, organization_id, code, name, description, details, display_name, section_type,
          status, version, request_sha256, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'manual', 'active', 1, ?, ?, ?)`,
      ).bind(
        id,
        auth.organizationId,
        normalized.code,
        normalized.name,
        normalized.description,
        normalized.details,
        normalized.displayName,
        requestHash,
        now,
        now,
      ),
      outboxStatement(env.BILLING_DB, auth.organizationId, event),
    ]);
  } catch (error) {
    const concurrent = await findActive(env.BILLING_DB, auth.organizationId, normalized.code);
    if (concurrent?.request_sha256 === requestHash)
      return json({ invoice_custom_section: serializeSection(concurrent) }, { requestId });
    if (!concurrent) throw error;
    throw new ApiError(422, "value_already_exist", "Invoice custom section code already exists");
  }
  await env.DOMAIN_EVENTS.send(event);
  const section = await findActive(env.BILLING_DB, auth.organizationId, normalized.code);
  if (!section) throw new ApiError(500, "persistence_error", "Invoice custom section disappeared");
  return json({ invoice_custom_section: serializeSection(section) }, { requestId });
}

async function listSections(url: URL, database: D1Database, auth: AuthContext, requestId: string) {
  const page = positivePage(url.searchParams.get("page"));
  const perPage = Math.min(positivePage(url.searchParams.get("per_page"), 20), 100);
  const offset = (page - 1) * perPage;
  const count = await database
    .prepare(
      "SELECT COUNT(*) AS total FROM invoice_custom_sections WHERE organization_id = ? AND status = 'active'",
    )
    .bind(auth.organizationId)
    .first<{ total: number }>();
  const rows = await database
    .prepare(
      `${sectionSelect()} WHERE organization_id = ? AND status = 'active'
       ORDER BY name, code LIMIT ? OFFSET ?`,
    )
    .bind(auth.organizationId, perPage, offset)
    .all<SectionRow>();
  const total = count?.total ?? 0;
  const pages = total === 0 ? 0 : Math.ceil(total / perPage);
  return json(
    {
      invoice_custom_sections: rows.results.map(serializeSection),
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

async function showSection(
  code: string,
  database: D1Database,
  auth: AuthContext,
  requestId: string,
) {
  const section = await findActive(database, auth.organizationId, code);
  if (!section)
    throw new ApiError(
      404,
      "invoice_custom_section_not_found",
      "Invoice custom section was not found",
    );
  return json({ invoice_custom_section: serializeSection(section) }, { requestId });
}

async function updateSection(
  code: string,
  request: Request,
  env: Env,
  auth: AuthContext,
  requestId: string,
) {
  const section = await findActive(env.BILLING_DB, auth.organizationId, code);
  if (!section)
    throw new ApiError(
      404,
      "invoice_custom_section_not_found",
      "Invoice custom section was not found",
    );
  const input = objectAt(await parseJsonObject(request), "invoice_custom_section");
  rejectUnsupported(input, ["code", "name", "description", "details", "display_name"]);
  const next = {
    code: input.code === undefined ? section.code : requiredString(input, "code"),
    name: input.name === undefined ? section.name : requiredString(input, "name"),
    description:
      input.description === undefined ? section.description : optionalString(input, "description"),
    details: input.details === undefined ? section.details : optionalString(input, "details"),
    displayName:
      input.display_name === undefined
        ? section.display_name
        : optionalString(input, "display_name"),
  };
  const now = new Date().toISOString();
  const event = sectionEvent(
    "invoice_custom_section.updated",
    section.id,
    section.version + 1,
    auth,
    requestId,
    now,
    { code: next.code },
  );
  try {
    const results = await env.BILLING_DB.batch([
      env.BILLING_DB.prepare(
        `UPDATE invoice_custom_sections
         SET code = ?, name = ?, description = ?, details = ?, display_name = ?,
             version = version + 1, updated_at = ?
         WHERE id = ? AND organization_id = ? AND status = 'active' AND version = ?`,
      ).bind(
        next.code,
        next.name,
        next.description,
        next.details,
        next.displayName,
        now,
        section.id,
        auth.organizationId,
        section.version,
      ),
      conditionalOutboxStatement(
        env.BILLING_DB,
        auth.organizationId,
        event,
        section.id,
        section.version + 1,
        now,
      ),
    ]);
    if ((results[0]?.meta.changes ?? 0) < 1 || results[1]?.meta.changes !== 1)
      throw new ApiError(
        409,
        "invoice_custom_section_version_conflict",
        "Invoice custom section changed concurrently",
      );
  } catch (error) {
    if (error instanceof ApiError) throw error;
    if (isUniqueConstraintError(error))
      throw new ApiError(422, "value_already_exist", "Invoice custom section code already exists");
    throw error;
  }
  await env.DOMAIN_EVENTS.send(event);
  const updated = await findActive(env.BILLING_DB, auth.organizationId, next.code);
  if (!updated) throw new ApiError(500, "persistence_error", "Invoice custom section disappeared");
  return json({ invoice_custom_section: serializeSection(updated) }, { requestId });
}

async function terminateSection(code: string, env: Env, auth: AuthContext, requestId: string) {
  const section = await findActive(env.BILLING_DB, auth.organizationId, code);
  if (!section)
    throw new ApiError(
      404,
      "invoice_custom_section_not_found",
      "Invoice custom section was not found",
    );
  const now = new Date().toISOString();
  const event = sectionEvent(
    "invoice_custom_section.terminated",
    section.id,
    section.version + 1,
    auth,
    requestId,
    now,
    { code },
  );
  const results = await env.BILLING_DB.batch([
    env.BILLING_DB.prepare(
      `UPDATE invoice_custom_sections
       SET status = 'terminated', terminated_at = ?, version = version + 1, updated_at = ?
       WHERE id = ? AND organization_id = ? AND status = 'active' AND version = ?`,
    ).bind(now, now, section.id, auth.organizationId, section.version),
    env.BILLING_DB.prepare(
      `DELETE FROM subscriptions_invoice_custom_sections
       WHERE invoice_custom_section_id = ? AND organization_id = ?
         AND EXISTS (SELECT 1 FROM invoice_custom_sections WHERE id = ? AND version = ?)`,
    ).bind(section.id, auth.organizationId, section.id, section.version + 1),
    conditionalOutboxStatement(
      env.BILLING_DB,
      auth.organizationId,
      event,
      section.id,
      section.version + 1,
      now,
    ),
  ]);
  if ((results[0]?.meta.changes ?? 0) < 1 || results[2]?.meta.changes !== 1)
    throw new ApiError(
      409,
      "invoice_custom_section_version_conflict",
      "Invoice custom section changed concurrently",
    );
  await env.DOMAIN_EVENTS.send(event);
  return json(
    {
      invoice_custom_section: serializeSection({
        ...section,
        status: "terminated",
        terminated_at: now,
        updated_at: now,
        version: section.version + 1,
      }),
    },
    { requestId },
  );
}

function findActive(database: D1Database, organizationId: string, code: string) {
  return database
    .prepare(
      `${sectionSelect()} WHERE organization_id = ? AND code = ? AND status = 'active' LIMIT 1`,
    )
    .bind(organizationId, code)
    .first<SectionRow>();
}

function sectionSelect() {
  return `SELECT id, organization_id, code, name, description, details, display_name, section_type,
                 status, version, request_sha256, created_at, updated_at, terminated_at
          FROM invoice_custom_sections`;
}

function serializeSection(section: SectionRow) {
  return {
    lago_id: section.id,
    organization_id: section.organization_id,
    code: section.code,
    name: section.name,
    description: section.description,
    details: section.details,
    display_name: section.display_name,
  };
}

function rejectUnsupported(input: Record<string, unknown>, allowed: string[]) {
  const unsupported = Object.keys(input).find((key) => !allowed.includes(key));
  if (unsupported)
    throw new ApiError(
      422,
      "unsupported_invoice_custom_section_feature",
      `${unsupported} is not implemented by the Cloudflare invoice custom-section catalog`,
    );
}

function positivePage(value: string | null, fallback = 1) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function isUniqueConstraintError(error: unknown): boolean {
  return error instanceof Error && error.message.toLowerCase().includes("unique constraint");
}

function sectionEvent(
  type: string,
  id: string,
  version: number,
  auth: AuthContext,
  requestId: string,
  occurredAt: string,
  payload: Record<string, unknown>,
): DomainEvent {
  return {
    id: `${type.replaceAll(".", "-")}:${id}:v${version}`,
    type,
    version: 1,
    aggregateType: "invoice_custom_section",
    aggregateId: id,
    aggregateVersion: version,
    occurredAt,
    causationId: requestId,
    correlationId: requestId,
    payload: { organizationId: auth.organizationId, ...payload },
  };
}

function outboxStatement(database: D1Database, organizationId: string, event: DomainEvent) {
  return database
    .prepare(
      `INSERT INTO outbox_events
       (event_id, organization_id, event_type, event_version, aggregate_type, aggregate_id,
        aggregate_version, causation_id, correlation_id, payload_json, occurred_at, published_at)
       VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, NULL)`,
    )
    .bind(
      event.id,
      organizationId,
      event.type,
      event.aggregateType,
      event.aggregateId,
      event.aggregateVersion,
      event.causationId,
      event.correlationId,
      stableJson(event.payload),
      event.occurredAt,
    );
}

function conditionalOutboxStatement(
  database: D1Database,
  organizationId: string,
  event: DomainEvent,
  sectionId: string,
  expectedVersion: number,
  expectedUpdatedAt: string,
) {
  return database
    .prepare(
      `INSERT INTO outbox_events
       (event_id, organization_id, event_type, event_version, aggregate_type, aggregate_id,
        aggregate_version, causation_id, correlation_id, payload_json, occurred_at, published_at)
       SELECT ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, NULL FROM invoice_custom_sections
       WHERE id = ? AND organization_id = ? AND version = ? AND updated_at = ?
       ON CONFLICT(event_id) DO NOTHING`,
    )
    .bind(
      event.id,
      organizationId,
      event.type,
      event.aggregateType,
      event.aggregateId,
      event.aggregateVersion,
      event.causationId,
      event.correlationId,
      stableJson(event.payload),
      event.occurredAt,
      sectionId,
      organizationId,
      expectedVersion,
      expectedUpdatedAt,
    );
}
