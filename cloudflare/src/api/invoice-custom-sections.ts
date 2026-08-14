import type { AuthContext } from "../auth/api-key";
import { sha256Hex } from "../auth/api-key";
import type { DomainEvent } from "../domain-events";
import { ApiError, json, objectAt, optionalString, parseJsonObject, requiredString } from "../http";
import { stableJson } from "../json";
import {
  normalizeCustomSectionCodes,
  resolveCustomSectionIds,
} from "../subscriptions/custom-sections";

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
  const billingEntityMatch = url.pathname.match(
    /^\/api\/v1\/billing_entities\/([^/]+)\/invoice_custom_sections$/,
  );
  if (billingEntityMatch?.[1]) {
    if (decodeURIComponent(billingEntityMatch[1]) !== "default")
      throw new ApiError(
        422,
        "unsupported_billing_entity",
        "Multiple billing entities are not implemented by the Cloudflare billing subset",
      );
    if (request.method === "GET") return showDefaultSections(env.BILLING_DB, auth, requestId);
    if (request.method === "PUT") return updateDefaultSections(request, env, auth, requestId);
  }
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

async function showDefaultSections(database: D1Database, auth: AuthContext, requestId: string) {
  const organization = await findOrganizationSectionVersion(database, auth.organizationId);
  if (!organization)
    throw new ApiError(404, "organization_not_found", "Organization was not found");
  const sections = await listLinkedSections(
    database,
    "organization_invoice_custom_sections",
    "organization_id",
    auth.organizationId,
  );
  return json(
    {
      billing_entity: {
        lago_id: auth.organizationId,
        code: "default",
        invoice_custom_sections: sections,
        version_number: organization.invoice_custom_section_version,
      },
    },
    { requestId },
  );
}

async function updateDefaultSections(
  request: Request,
  env: Env,
  auth: AuthContext,
  requestId: string,
) {
  const input = objectAt(await parseJsonObject(request), "billing_entity");
  rejectUnsupported(input, ["invoice_custom_section_codes"]);
  const codes = normalizeCustomSectionCodes(input.invoice_custom_section_codes);
  if (codes === undefined)
    throw new ApiError(422, "validation_error", "invoice_custom_section_codes is required");
  const sectionIds =
    (await resolveCustomSectionIds(env.BILLING_DB, auth.organizationId, codes)) ?? [];
  const organization = await findOrganizationSectionVersion(env.BILLING_DB, auth.organizationId);
  if (!organization)
    throw new ApiError(404, "organization_not_found", "Organization was not found");
  const currentIds = await linkedSectionIds(
    env.BILLING_DB,
    "organization_invoice_custom_sections",
    "organization_id",
    auth.organizationId,
  );
  if (sameIds(currentIds, sectionIds)) return showDefaultSections(env.BILLING_DB, auth, requestId);

  const now = new Date().toISOString();
  const nextVersion = organization.invoice_custom_section_version + 1;
  const event = defaultSectionsEvent(auth, requestId, nextVersion, now, sectionIds);
  const statements: D1PreparedStatement[] = [
    env.BILLING_DB.prepare(
      `UPDATE organizations
       SET invoice_custom_section_version = invoice_custom_section_version + 1, updated_at = ?
       WHERE id = ? AND invoice_custom_section_version = ?`,
    ).bind(now, auth.organizationId, organization.invoice_custom_section_version),
    env.BILLING_DB.prepare(
      `DELETE FROM organization_invoice_custom_sections
       WHERE organization_id = ?
         AND EXISTS (SELECT 1 FROM organizations WHERE id = ?
                     AND invoice_custom_section_version = ? AND updated_at = ?)`,
    ).bind(auth.organizationId, auth.organizationId, nextVersion, now),
  ];
  for (const sectionId of sectionIds) {
    statements.push(
      env.BILLING_DB.prepare(
        `INSERT OR IGNORE INTO organization_invoice_custom_sections
         (organization_id, invoice_custom_section_id, created_at)
         SELECT ?, ?, ? FROM organizations
         WHERE id = ? AND invoice_custom_section_version = ? AND updated_at = ?`,
      ).bind(auth.organizationId, sectionId, now, auth.organizationId, nextVersion, now),
    );
  }
  statements.push(conditionalOrganizationOutboxStatement(env.BILLING_DB, auth, event, now));
  const results = await env.BILLING_DB.batch(statements);
  if ((results[0]?.meta.changes ?? 0) < 1 || results.at(-1)?.meta.changes !== 1)
    throw new ApiError(
      409,
      "billing_entity_version_conflict",
      "Default billing entity changed concurrently",
    );
  await env.DOMAIN_EVENTS.send(event);
  return showDefaultSections(env.BILLING_DB, auth, requestId);
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
    env.BILLING_DB.prepare(
      `DELETE FROM customers_invoice_custom_sections
       WHERE invoice_custom_section_id = ? AND organization_id = ?
         AND EXISTS (SELECT 1 FROM invoice_custom_sections WHERE id = ? AND version = ?)`,
    ).bind(section.id, auth.organizationId, section.id, section.version + 1),
    env.BILLING_DB.prepare(
      `DELETE FROM organization_invoice_custom_sections
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
  if ((results[0]?.meta.changes ?? 0) < 1 || results[4]?.meta.changes !== 1)
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

function findOrganizationSectionVersion(database: D1Database, organizationId: string) {
  return database
    .prepare("SELECT invoice_custom_section_version FROM organizations WHERE id = ? LIMIT 1")
    .bind(organizationId)
    .first<{ invoice_custom_section_version: number }>();
}

async function linkedSectionIds(
  database: D1Database,
  table: "organization_invoice_custom_sections" | "customers_invoice_custom_sections",
  ownerColumn: "organization_id" | "customer_id",
  ownerId: string,
) {
  const rows = await database
    .prepare(
      `SELECT invoice_custom_section_id FROM ${table}
       WHERE ${ownerColumn} = ? ORDER BY invoice_custom_section_id`,
    )
    .bind(ownerId)
    .all<{ invoice_custom_section_id: string }>();
  return rows.results.map((row) => row.invoice_custom_section_id);
}

async function listLinkedSections(
  database: D1Database,
  table: "organization_invoice_custom_sections" | "customers_invoice_custom_sections",
  ownerColumn: "organization_id" | "customer_id",
  ownerId: string,
) {
  const rows = await database
    .prepare(
      `SELECT cs.id, cs.organization_id, cs.code, cs.name, cs.description, cs.details,
              cs.display_name, cs.section_type, cs.status, cs.version, cs.request_sha256,
              cs.created_at, cs.updated_at, cs.terminated_at
       FROM invoice_custom_sections cs
       JOIN ${table} link ON link.invoice_custom_section_id = cs.id
       WHERE link.${ownerColumn} = ? AND cs.status = 'active'
       ORDER BY cs.name, cs.code`,
    )
    .bind(ownerId)
    .all<SectionRow>();
  return rows.results.map(serializeSection);
}

function sameIds(left: string[], right: string[]) {
  const sortedRight = [...right].sort();
  return (
    left.length === sortedRight.length && left.every((value, index) => value === sortedRight[index])
  );
}

function defaultSectionsEvent(
  auth: AuthContext,
  requestId: string,
  version: number,
  occurredAt: string,
  sectionIds: string[],
): DomainEvent {
  return {
    id: `billing-entity-invoice-custom-sections-updated:${auth.organizationId}:v${version}`,
    type: "billing_entity.invoice_custom_sections_updated",
    version: 1,
    aggregateType: "billing_entity",
    aggregateId: auth.organizationId,
    aggregateVersion: version,
    occurredAt,
    causationId: requestId,
    correlationId: requestId,
    payload: {
      organizationId: auth.organizationId,
      code: "default",
      invoiceCustomSectionIds: sectionIds,
    },
  };
}

function conditionalOrganizationOutboxStatement(
  database: D1Database,
  auth: AuthContext,
  event: DomainEvent,
  expectedUpdatedAt: string,
) {
  return database
    .prepare(
      `INSERT INTO outbox_events
       (event_id, organization_id, event_type, event_version, aggregate_type, aggregate_id,
        aggregate_version, causation_id, correlation_id, payload_json, occurred_at, published_at)
       SELECT ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, NULL FROM organizations
       WHERE id = ? AND invoice_custom_section_version = ? AND updated_at = ?
       ON CONFLICT(event_id) DO NOTHING`,
    )
    .bind(
      event.id,
      auth.organizationId,
      event.type,
      event.aggregateType,
      event.aggregateId,
      event.aggregateVersion,
      event.causationId,
      event.correlationId,
      stableJson(event.payload),
      event.occurredAt,
      auth.organizationId,
      event.aggregateVersion,
      expectedUpdatedAt,
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
