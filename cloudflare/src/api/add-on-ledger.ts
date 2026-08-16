import type { AuthContext } from "../auth/api-key";
import { sha256Hex } from "../auth/api-key";
import type { DomainEvent } from "../domain-events";
import { ApiError, json, objectAt, optionalString, parseJsonObject, requiredString } from "../http";
import { stableJson } from "../json";

type AddOnRow = {
  id: string;
  code: string;
  name: string;
  invoice_display_name: string | null;
  description: string | null;
  amount_minor: number;
  currency: string;
  status: string;
  version: number;
  request_sha256: string;
  created_at: string;
  updated_at: string;
  terminated_at: string | null;
};

export async function handleAddOnLedgerRequest(
  request: Request,
  env: Pick<Env, "BILLING_DB" | "DOMAIN_EVENTS">,
  auth: AuthContext,
  requestId: string,
): Promise<Response | null> {
  const url = new URL(request.url);
  if (request.method === "POST" && url.pathname === "/api/v1/add_ons")
    return createAddOn(request, env, auth, requestId);
  if (request.method === "GET" && url.pathname === "/api/v1/add_ons")
    return listAddOns(url, env.BILLING_DB, auth, requestId);
  const match = url.pathname.match(/^\/api\/v1\/add_ons\/([^/]+)$/);
  if (!match?.[1]) return null;
  const code = decodeURIComponent(match[1]);
  if (request.method === "GET") return showAddOn(code, env.BILLING_DB, auth, requestId);
  if (request.method === "PUT") return updateAddOn(code, request, env, auth, requestId);
  if (request.method === "DELETE") return terminateAddOn(code, env, auth, requestId);
  return null;
}

async function createAddOn(
  request: Request,
  env: Pick<Env, "BILLING_DB" | "DOMAIN_EVENTS">,
  auth: AuthContext,
  requestId: string,
) {
  const input = objectAt(await parseJsonObject(request), "add_on");
  rejectTaxCodes(input);
  const normalized = {
    code: requiredString(input, "code"),
    name: requiredString(input, "name"),
    invoiceDisplayName: optionalString(input, "invoice_display_name"),
    description: optionalString(input, "description"),
    amountMinor: positiveInteger(input.amount_cents, "amount_cents"),
    currency: currency(input.amount_currency),
  };
  const requestHash = await sha256Hex(stableJson(normalized));
  const existing = await findActive(env.BILLING_DB, auth.organizationId, normalized.code);
  if (existing) {
    if (existing.request_sha256 === requestHash)
      return json({ add_on: serializeAddOn(existing) }, { requestId });
    throw new ApiError(422, "value_already_exist", "Add-on code already exists");
  }
  const now = new Date().toISOString();
  const id = crypto.randomUUID();
  const event = addOnEvent("add_on.created", id, 1, auth.organizationId, requestId, now, {
    code: normalized.code,
  });
  try {
    await env.BILLING_DB.batch([
      env.BILLING_DB.prepare(
        `INSERT INTO add_ons
         (id, organization_id, code, name, invoice_display_name, description, amount_minor,
          currency, status, version, request_sha256, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', 1, ?, ?, ?)`,
      ).bind(
        id,
        auth.organizationId,
        normalized.code,
        normalized.name,
        normalized.invoiceDisplayName,
        normalized.description,
        normalized.amountMinor,
        normalized.currency,
        requestHash,
        now,
        now,
      ),
      outboxStatement(env.BILLING_DB, auth.organizationId, event),
    ]);
  } catch (error) {
    const concurrent = await findActive(env.BILLING_DB, auth.organizationId, normalized.code);
    if (concurrent?.request_sha256 === requestHash)
      return json({ add_on: serializeAddOn(concurrent) }, { requestId });
    if (!concurrent) throw error;
    throw new ApiError(422, "value_already_exist", "Add-on code already exists");
  }
  await env.DOMAIN_EVENTS.send(event);
  const addOn = await findActive(env.BILLING_DB, auth.organizationId, normalized.code);
  if (!addOn) throw new ApiError(500, "persistence_error", "Add-on was not persisted");
  return json({ add_on: serializeAddOn(addOn) }, { requestId });
}

async function listAddOns(url: URL, database: D1Database, auth: AuthContext, requestId: string) {
  const page = pageValue(url.searchParams.get("page"));
  const perPage = Math.min(pageValue(url.searchParams.get("per_page"), 20), 100);
  const offset = (page - 1) * perPage;
  const count = await database
    .prepare(
      "SELECT COUNT(*) AS total FROM add_ons WHERE organization_id = ? AND status = 'active'",
    )
    .bind(auth.organizationId)
    .first<{ total: number }>();
  const rows = await database
    .prepare(
      `${addOnSelect()} WHERE organization_id = ? AND status = 'active'
       ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`,
    )
    .bind(auth.organizationId, perPage, offset)
    .all<AddOnRow>();
  const total = count?.total ?? 0;
  const pages = total === 0 ? 0 : Math.ceil(total / perPage);
  return json(
    {
      add_ons: rows.results.map(serializeAddOn),
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

async function showAddOn(code: string, database: D1Database, auth: AuthContext, requestId: string) {
  const addOn = await findActive(database, auth.organizationId, code);
  if (!addOn) throw new ApiError(404, "add_on_not_found", "Add-on was not found");
  return json({ add_on: serializeAddOn(addOn) }, { requestId });
}

async function updateAddOn(
  code: string,
  request: Request,
  env: Pick<Env, "BILLING_DB" | "DOMAIN_EVENTS">,
  auth: AuthContext,
  requestId: string,
) {
  const addOn = await findActive(env.BILLING_DB, auth.organizationId, code);
  if (!addOn) throw new ApiError(404, "add_on_not_found", "Add-on was not found");
  const input = objectAt(await parseJsonObject(request), "add_on");
  rejectTaxCodes(input);
  const next = {
    code: input.code === undefined ? addOn.code : requiredString(input, "code"),
    name: input.name === undefined ? addOn.name : requiredString(input, "name"),
    invoiceDisplayName:
      input.invoice_display_name === undefined
        ? addOn.invoice_display_name
        : optionalString(input, "invoice_display_name"),
    description:
      input.description === undefined ? addOn.description : optionalString(input, "description"),
    amountMinor:
      input.amount_cents === undefined
        ? addOn.amount_minor
        : positiveInteger(input.amount_cents, "amount_cents"),
    currency:
      input.amount_currency === undefined ? addOn.currency : currency(input.amount_currency),
  };
  if (next.currency !== addOn.currency) {
    const mismatch = await env.BILLING_DB.prepare(
      `SELECT fc.id FROM fixed_charges fc JOIN plans p ON p.id = fc.plan_id
       WHERE fc.add_on_id = ? AND fc.active = 1 AND p.currency <> ? LIMIT 1`,
    )
      .bind(addOn.id, next.currency)
      .first();
    if (mismatch)
      throw new ApiError(
        422,
        "currency_mismatch",
        "An in-use add-on currency must match every referencing plan",
      );
  }
  const now = new Date().toISOString();
  const event = addOnEvent(
    "add_on.updated",
    addOn.id,
    addOn.version + 1,
    auth.organizationId,
    requestId,
    now,
    { code: next.code },
  );
  try {
    const results = await env.BILLING_DB.batch([
      env.BILLING_DB.prepare(
        `UPDATE add_ons SET code = ?, name = ?, invoice_display_name = ?, description = ?,
         amount_minor = ?, currency = ?, version = version + 1, updated_at = ?
         WHERE id = ? AND organization_id = ? AND status = 'active' AND version = ?`,
      ).bind(
        next.code,
        next.name,
        next.invoiceDisplayName,
        next.description,
        next.amountMinor,
        next.currency,
        now,
        addOn.id,
        auth.organizationId,
        addOn.version,
      ),
      conditionalOutboxStatement(
        env.BILLING_DB,
        auth.organizationId,
        event,
        addOn.id,
        addOn.version + 1,
        now,
      ),
    ]);
    if ((results[0]?.meta.changes ?? 0) < 1 || results[1]?.meta.changes !== 1)
      throw new ApiError(409, "add_on_version_conflict", "Add-on changed concurrently");
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError(422, "value_already_exist", "Add-on code already exists");
  }
  await env.DOMAIN_EVENTS.send(event);
  const updated = await findActive(env.BILLING_DB, auth.organizationId, next.code);
  if (!updated) throw new ApiError(500, "persistence_error", "Add-on disappeared");
  return json({ add_on: serializeAddOn(updated) }, { requestId });
}

async function terminateAddOn(
  code: string,
  env: Pick<Env, "BILLING_DB" | "DOMAIN_EVENTS">,
  auth: AuthContext,
  requestId: string,
) {
  const addOn = await findActive(env.BILLING_DB, auth.organizationId, code);
  if (!addOn) throw new ApiError(404, "add_on_not_found", "Add-on was not found");
  const used = await env.BILLING_DB.prepare(
    "SELECT id FROM fixed_charges WHERE add_on_id = ? AND active = 1 LIMIT 1",
  )
    .bind(addOn.id)
    .first();
  if (used)
    throw new ApiError(422, "add_on_in_use", "Add-on is referenced by an active plan fixed charge");
  const now = new Date().toISOString();
  const event = addOnEvent(
    "add_on.terminated",
    addOn.id,
    addOn.version + 1,
    auth.organizationId,
    requestId,
    now,
    { code },
  );
  const results = await env.BILLING_DB.batch([
    env.BILLING_DB.prepare(
      `UPDATE add_ons SET status = 'terminated', terminated_at = ?, updated_at = ?,
       version = version + 1 WHERE id = ? AND organization_id = ? AND status = 'active' AND version = ?`,
    ).bind(now, now, addOn.id, auth.organizationId, addOn.version),
    conditionalOutboxStatement(
      env.BILLING_DB,
      auth.organizationId,
      event,
      addOn.id,
      addOn.version + 1,
      now,
    ),
  ]);
  if ((results[0]?.meta.changes ?? 0) < 1 || results[1]?.meta.changes !== 1)
    throw new ApiError(409, "add_on_version_conflict", "Add-on changed concurrently");
  await env.DOMAIN_EVENTS.send(event);
  return json(
    {
      add_on: serializeAddOn({
        ...addOn,
        status: "terminated",
        version: addOn.version + 1,
        updated_at: now,
        terminated_at: now,
      }),
    },
    { requestId },
  );
}

function findActive(database: D1Database, organizationId: string, code: string) {
  return database
    .prepare(
      `${addOnSelect()} WHERE organization_id = ? AND code = ? AND status = 'active' LIMIT 1`,
    )
    .bind(organizationId, code)
    .first<AddOnRow>();
}

function addOnSelect() {
  return "SELECT id, code, name, invoice_display_name, description, amount_minor, currency, status, version, request_sha256, created_at, updated_at, terminated_at FROM add_ons";
}

function serializeAddOn(addOn: AddOnRow) {
  return {
    lago_id: addOn.id,
    name: addOn.name,
    invoice_display_name: addOn.invoice_display_name,
    code: addOn.code,
    amount_cents: addOn.amount_minor,
    amount_currency: addOn.currency,
    created_at: addOn.created_at,
    description: addOn.description,
    taxes: [],
  };
}

function rejectTaxCodes(input: Record<string, unknown>) {
  if (Array.isArray(input.tax_codes) && input.tax_codes.length > 0)
    throw new ApiError(422, "unsupported_tax_target", "Add-on tax targeting is not implemented");
}

function positiveInteger(value: unknown, field: string) {
  if (!Number.isSafeInteger(value) || Number(value) <= 0)
    throw new ApiError(422, "validation_error", `${field} must be a positive integer`);
  return Number(value);
}

function currency(value: unknown) {
  const code = typeof value === "string" ? value.trim().toUpperCase() : "";
  if (!/^[A-Z]{3}$/.test(code))
    throw new ApiError(422, "validation_error", "amount_currency must be an ISO currency code");
  return code;
}

function pageValue(value: string | null, fallback = 1) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function addOnEvent(
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
    aggregateType: "add_on",
    aggregateId: id,
    aggregateVersion: version,
    occurredAt,
    causationId: correlationId,
    correlationId,
    payload: { organizationId, ...payload },
  };
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

function conditionalOutboxStatement(
  database: D1Database,
  organizationId: string,
  event: DomainEvent,
  addOnId: string,
  expectedVersion: number,
  expectedUpdatedAt: string,
): D1PreparedStatement {
  return database
    .prepare(
      `INSERT INTO outbox_events
       (event_id, organization_id, event_type, event_version, aggregate_type, aggregate_id,
        aggregate_version, causation_id, correlation_id, payload_json, occurred_at, published_at)
       SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL FROM add_ons
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
      addOnId,
      organizationId,
      expectedVersion,
      expectedUpdatedAt,
    );
}
