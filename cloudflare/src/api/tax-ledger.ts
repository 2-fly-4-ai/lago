import type { AuthContext } from "../auth/api-key";
import { sha256Hex } from "../auth/api-key";
import type { DomainEvent } from "../domain-events";
import { ApiError, json, objectAt, optionalString, parseJsonObject, requiredString } from "../http";
import { stableJson } from "../json";
import { Decimal } from "../rating/decimal";

type TaxRow = {
  id: string;
  code: string;
  name: string;
  description: string | null;
  rate: string;
  applied_to_organization: number;
  status: string;
  version: number;
  request_sha256: string;
  created_at: string;
  updated_at: string;
  terminated_at: string | null;
};

export async function handleTaxLedgerRequest(
  request: Request,
  env: Pick<Env, "BILLING_DB" | "DOMAIN_EVENTS">,
  auth: AuthContext,
  requestId: string,
): Promise<Response | null> {
  const url = new URL(request.url);
  if (request.method === "POST" && url.pathname === "/api/v1/taxes")
    return createTax(request, env, auth, requestId);
  if (request.method === "GET" && url.pathname === "/api/v1/taxes")
    return listTaxes(url, env.BILLING_DB, auth, requestId);
  const match = url.pathname.match(/^\/api\/v1\/taxes\/([^/]+)$/);
  if (!match?.[1]) return null;
  const code = decodeURIComponent(match[1]);
  if (request.method === "GET") return showTax(code, env.BILLING_DB, auth, requestId);
  if (request.method === "PUT") return updateTax(code, request, env, auth, requestId);
  if (request.method === "DELETE") return terminateTax(code, env, auth, requestId);
  return null;
}

async function createTax(
  request: Request,
  env: Pick<Env, "BILLING_DB" | "DOMAIN_EVENTS">,
  auth: AuthContext,
  requestId: string,
) {
  const input = objectAt(await parseJsonObject(request), "tax");
  const normalized = {
    code: requiredString(input, "code"),
    name: requiredString(input, "name"),
    description: optionalString(input, "description"),
    rate: taxRate(input.rate),
    appliedToOrganization: optionalBoolean(input.applied_to_organization, false),
  };
  const requestHash = await sha256Hex(stableJson(normalized));
  const existing = await findActiveTax(env.BILLING_DB, auth.organizationId, normalized.code);
  if (existing) {
    if (existing.request_sha256 === requestHash)
      return json({ tax: serializeTax(existing) }, { requestId });
    throw new ApiError(422, "value_already_exist", "Tax code already exists");
  }
  const now = new Date().toISOString();
  const id = crypto.randomUUID();
  const event = taxEvent("tax.created", id, 1, auth.organizationId, requestId, now, {
    code: normalized.code,
  });
  try {
    await env.BILLING_DB.batch([
      env.BILLING_DB.prepare(
        `INSERT INTO taxes
         (id, organization_id, code, name, description, rate, applied_to_organization,
          status, version, request_sha256, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'active', 1, ?, ?, ?)`,
      ).bind(
        id,
        auth.organizationId,
        normalized.code,
        normalized.name,
        normalized.description,
        normalized.rate,
        normalized.appliedToOrganization ? 1 : 0,
        requestHash,
        now,
        now,
      ),
      ...(normalized.appliedToOrganization
        ? [
            env.BILLING_DB.prepare(
              `INSERT INTO tax_targets
               (organization_id, tax_id, target_type, target_id, created_at)
               VALUES (?, ?, 'billing_entity', ?, ?)`,
            ).bind(auth.organizationId, id, auth.organizationId, now),
          ]
        : []),
      outboxStatement(env.BILLING_DB, auth.organizationId, event),
    ]);
  } catch (error) {
    const concurrent = await findActiveTax(env.BILLING_DB, auth.organizationId, normalized.code);
    if (!concurrent) throw error;
    if (concurrent.request_sha256 !== requestHash)
      throw new ApiError(422, "value_already_exist", "Tax code already exists");
    return json({ tax: serializeTax(concurrent) }, { requestId });
  }
  await env.DOMAIN_EVENTS.send(event);
  const tax = await findActiveTax(env.BILLING_DB, auth.organizationId, normalized.code);
  if (!tax) throw new ApiError(500, "persistence_error", "Tax was not persisted");
  return json({ tax: serializeTax(tax) }, { requestId });
}

async function listTaxes(url: URL, database: D1Database, auth: AuthContext, requestId: string) {
  const page = pageValue(url.searchParams.get("page"));
  const perPage = Math.min(pageValue(url.searchParams.get("per_page"), 20), 100);
  const offset = (page - 1) * perPage;
  const count = await database
    .prepare("SELECT COUNT(*) AS total FROM taxes WHERE organization_id = ? AND status = 'active'")
    .bind(auth.organizationId)
    .first<{ total: number }>();
  const rows = await database
    .prepare(
      `${taxSelect()} WHERE organization_id = ? AND status = 'active'
       ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`,
    )
    .bind(auth.organizationId, perPage, offset)
    .all<TaxRow>();
  return json(
    {
      taxes: rows.results.map(serializeTax),
      meta: pagination(count?.total ?? 0, page, perPage),
    },
    { requestId },
  );
}

async function showTax(code: string, database: D1Database, auth: AuthContext, requestId: string) {
  const tax = await findActiveTax(database, auth.organizationId, code);
  if (!tax) throw new ApiError(404, "tax_not_found", "Tax was not found");
  return json({ tax: serializeTax(tax) }, { requestId });
}

async function updateTax(
  code: string,
  request: Request,
  env: Pick<Env, "BILLING_DB" | "DOMAIN_EVENTS">,
  auth: AuthContext,
  requestId: string,
) {
  const tax = await findActiveTax(env.BILLING_DB, auth.organizationId, code);
  if (!tax) throw new ApiError(404, "tax_not_found", "Tax was not found");
  const input = objectAt(await parseJsonObject(request), "tax");
  const nextCode = input.code === undefined ? tax.code : requiredString(input, "code");
  const nextName = input.name === undefined ? tax.name : requiredString(input, "name");
  const nextDescription =
    input.description === undefined ? tax.description : optionalString(input, "description");
  const nextRate = input.rate === undefined ? tax.rate : taxRate(input.rate);
  const nextApplied =
    input.applied_to_organization === undefined
      ? tax.applied_to_organization === 1
      : optionalBoolean(input.applied_to_organization, false);
  const now = new Date().toISOString();
  const event = taxEvent(
    "tax.updated",
    tax.id,
    tax.version + 1,
    auth.organizationId,
    requestId,
    now,
    {
      code: nextCode,
    },
  );
  try {
    const results = await env.BILLING_DB.batch([
      env.BILLING_DB.prepare(
        `UPDATE taxes SET code = ?, name = ?, description = ?, rate = ?,
         applied_to_organization = ?, version = version + 1, updated_at = ?
         WHERE id = ? AND organization_id = ? AND status = 'active' AND version = ?`,
      ).bind(
        nextCode,
        nextName,
        nextDescription,
        nextRate,
        nextApplied ? 1 : 0,
        now,
        tax.id,
        auth.organizationId,
        tax.version,
      ),
      env.BILLING_DB.prepare(
        `DELETE FROM tax_targets
         WHERE organization_id = ? AND tax_id = ? AND target_type = 'billing_entity'
           AND target_id = ? AND EXISTS (
             SELECT 1 FROM taxes
             WHERE id = ? AND organization_id = ? AND version = ? AND updated_at = ?
           )`,
      ).bind(
        auth.organizationId,
        tax.id,
        auth.organizationId,
        tax.id,
        auth.organizationId,
        tax.version + 1,
        now,
      ),
      ...(nextApplied
        ? [
            env.BILLING_DB.prepare(
              `INSERT INTO tax_targets
               (organization_id, tax_id, target_type, target_id, created_at)
               SELECT ?, ?, 'billing_entity', ?, ? FROM taxes
               WHERE id = ? AND organization_id = ? AND version = ? AND updated_at = ?`,
            ).bind(
              auth.organizationId,
              tax.id,
              auth.organizationId,
              now,
              tax.id,
              auth.organizationId,
              tax.version + 1,
              now,
            ),
          ]
        : []),
      conditionalOutboxStatement(
        env.BILLING_DB,
        auth.organizationId,
        event,
        tax.id,
        tax.version + 1,
        now,
      ),
    ]);
    if ((results[0]?.meta.changes ?? 0) < 1 || results[1]?.meta.changes !== 1)
      throw new ApiError(409, "tax_version_conflict", "Tax changed concurrently");
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError(422, "value_already_exist", "Tax code already exists");
  }
  await env.DOMAIN_EVENTS.send(event);
  const updated = await findActiveTax(env.BILLING_DB, auth.organizationId, nextCode);
  if (!updated) throw new ApiError(500, "persistence_error", "Tax disappeared");
  return json({ tax: serializeTax(updated) }, { requestId });
}

async function terminateTax(
  code: string,
  env: Pick<Env, "BILLING_DB" | "DOMAIN_EVENTS">,
  auth: AuthContext,
  requestId: string,
) {
  let tax = await findTax(env.BILLING_DB, auth.organizationId, code);
  if (!tax) throw new ApiError(404, "tax_not_found", "Tax was not found");
  if (tax.status === "terminated") return json({ tax: serializeTax(tax) }, { requestId });
  const now = new Date().toISOString();
  const event = taxEvent(
    "tax.terminated",
    tax.id,
    tax.version + 1,
    auth.organizationId,
    requestId,
    now,
    {
      code,
    },
  );
  const results = await env.BILLING_DB.batch([
    env.BILLING_DB.prepare(
      `UPDATE taxes SET status = 'terminated', applied_to_organization = 0,
       terminated_at = ?, updated_at = ?, version = version + 1
       WHERE id = ? AND organization_id = ? AND status = 'active' AND version = ?`,
    ).bind(now, now, tax.id, auth.organizationId, tax.version),
    conditionalOutboxStatement(
      env.BILLING_DB,
      auth.organizationId,
      event,
      tax.id,
      tax.version + 1,
      now,
    ),
  ]);
  if ((results[0]?.meta.changes ?? 0) < 1 || results[1]?.meta.changes !== 1)
    throw new ApiError(409, "tax_version_conflict", "Tax changed concurrently");
  await env.DOMAIN_EVENTS.send(event);
  tax = await findTax(env.BILLING_DB, auth.organizationId, code);
  if (!tax) throw new ApiError(500, "persistence_error", "Tax disappeared");
  return json({ tax: serializeTax(tax) }, { requestId });
}

function findTax(database: D1Database, organizationId: string, code: string) {
  return database
    .prepare(
      `${taxSelect()} WHERE organization_id = ? AND code = ?
       ORDER BY CASE status WHEN 'active' THEN 0 ELSE 1 END, created_at DESC, id DESC LIMIT 1`,
    )
    .bind(organizationId, code)
    .first<TaxRow>();
}

function findActiveTax(database: D1Database, organizationId: string, code: string) {
  return database
    .prepare(`${taxSelect()} WHERE organization_id = ? AND code = ? AND status = 'active' LIMIT 1`)
    .bind(organizationId, code)
    .first<TaxRow>();
}

function taxSelect() {
  return "SELECT id, code, name, description, rate, applied_to_organization, status, version, request_sha256, created_at, updated_at, terminated_at FROM taxes";
}

function serializeTax(tax: TaxRow) {
  return {
    lago_id: tax.id,
    name: tax.name,
    code: tax.code,
    rate: Number(tax.rate),
    description: tax.description,
    applied_to_organization: tax.applied_to_organization === 1,
    add_ons_count: 0,
    customers_count: 0,
    plans_count: 0,
    charges_count: 0,
    commitments_count: 0,
    created_at: tax.created_at,
  };
}

function taxRate(value: unknown) {
  let decimal: Decimal;
  try {
    decimal = Decimal.parse(String(value));
  } catch {
    throw new ApiError(422, "validation_error", "rate must be a decimal");
  }
  if (decimal.compare(Decimal.zero()) < 0 || decimal.compare(Decimal.parse(100)) > 0)
    throw new ApiError(422, "validation_error", "rate must be between 0 and 100");
  return decimal.toString();
}

function optionalBoolean(value: unknown, fallback: boolean) {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== "boolean")
    throw new ApiError(422, "validation_error", "applied_to_organization must be a boolean");
  return value;
}

function pageValue(value: string | null, fallback = 1) {
  if (value === null) return fallback;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function pagination(total: number, page: number, perPage: number) {
  const pages = total === 0 ? 0 : Math.ceil(total / perPage);
  return {
    current_page: total === 0 ? 0 : page,
    next_page: page < pages ? page + 1 : null,
    prev_page: page > 1 && pages > 0 ? page - 1 : null,
    total_pages: pages,
    total_count: total,
  };
}

function taxEvent(
  type: string,
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
    aggregateType: "tax",
    aggregateId: id,
    aggregateVersion: version,
    occurredAt,
    causationId: correlationId,
    correlationId,
    payload: { organizationId, ...payload },
  };
}

function outboxStatement(database: D1Database, organizationId: string, event: DomainEvent) {
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

function conditionalOutboxStatement(
  database: D1Database,
  organizationId: string,
  event: DomainEvent,
  taxId: string,
  expectedVersion: number,
  expectedUpdatedAt: string,
) {
  return database
    .prepare(
      `INSERT INTO outbox_events
       (event_id, organization_id, event_type, event_version, aggregate_type, aggregate_id,
        aggregate_version, causation_id, correlation_id, payload_json, occurred_at, published_at)
       SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL FROM taxes
       WHERE id = ? AND organization_id = ? AND version = ? AND updated_at = ?`,
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
      taxId,
      organizationId,
      expectedVersion,
      expectedUpdatedAt,
    );
}
