import type { AuthContext } from "../auth/api-key";
import { sha256Hex } from "../auth/api-key";
import type { DomainEvent } from "../domain-events";
import { ApiError, json, objectAt, optionalString, parseJsonObject, requiredString } from "../http";
import { deterministicUuid } from "../identifiers";
import { stableJson } from "../json";
import { Decimal } from "../rating/decimal";

type CouponRow = {
  id: string;
  code: string;
  name: string;
  description: string | null;
  coupon_type: string;
  amount_minor: number | null;
  currency: string | null;
  percentage_rate: string | null;
  frequency: string;
  frequency_duration: number | null;
  expiration: string;
  expiration_at: string | null;
  reusable: number;
  status: string;
  request_sha256: string;
  created_at: string;
  terminated_at: string | null;
};

type AppliedCouponRow = {
  id: string;
  coupon_id: string;
  coupon_code: string;
  coupon_name: string;
  coupon_description: string | null;
  coupon_status: string;
  customer_id: string;
  customer_external_id: string;
  status: string;
  amount_minor: number | null;
  currency: string | null;
  percentage_rate: string | null;
  frequency: string;
  frequency_duration: number | null;
  frequency_duration_remaining: number | null;
  expiration_at: string | null;
  idempotency_key: string | null;
  request_sha256: string;
  created_at: string;
  terminated_at: string | null;
  termination_reason: string | null;
  version: number;
  consumed_minor: number;
};

const COUPON_TYPES = new Set(["fixed_amount", "percentage"]);
const FREQUENCIES = new Set(["once", "recurring", "forever"]);
const EXPIRATIONS = new Set(["no_expiration", "time_limit"]);

export async function handleCouponLedgerRequest(
  request: Request,
  env: Env,
  auth: AuthContext,
  requestId: string,
): Promise<Response | null> {
  const url = new URL(request.url);
  if (request.method === "POST" && url.pathname === "/api/v1/coupons") {
    return createCoupon(request, env, auth, requestId);
  }
  if (request.method === "GET" && url.pathname === "/api/v1/coupons") {
    return listCoupons(url, env.BILLING_DB, auth, requestId);
  }
  const couponMatch = url.pathname.match(/^\/api\/v1\/coupons\/([^/]+)$/);
  if (request.method === "GET" && couponMatch?.[1]) {
    return showCoupon(decodeURIComponent(couponMatch[1]), env.BILLING_DB, auth, requestId);
  }
  if (request.method === "POST" && url.pathname === "/api/v1/applied_coupons") {
    return applyCoupon(request, env, auth, requestId);
  }
  if (request.method === "GET" && url.pathname === "/api/v1/applied_coupons") {
    return listAppliedCoupons(url, env.BILLING_DB, auth, requestId);
  }
  const customerAppliedMatch = url.pathname.match(
    /^\/api\/v1\/customers\/([^/]+)\/applied_coupons(?:\/([^/]+))?$/,
  );
  if (customerAppliedMatch?.[1]) {
    const externalCustomerId = decodeURIComponent(customerAppliedMatch[1]);
    if (request.method === "GET" && !customerAppliedMatch[2]) {
      url.searchParams.set("external_customer_id", externalCustomerId);
      return listAppliedCoupons(url, env.BILLING_DB, auth, requestId);
    }
    if (request.method === "DELETE" && customerAppliedMatch[2]) {
      return terminateAppliedCoupon(
        externalCustomerId,
        decodeURIComponent(customerAppliedMatch[2]),
        env,
        auth,
        requestId,
      );
    }
  }
  return null;
}

async function createCoupon(
  request: Request,
  env: Env,
  auth: AuthContext,
  requestId: string,
): Promise<Response> {
  const input = objectAt(await parseJsonObject(request), "coupon");
  rejectCouponTargets(input.applies_to);
  const code = requiredString(input, "code");
  const name = requiredString(input, "name");
  const couponType = enumValue(input, "coupon_type", COUPON_TYPES);
  const frequency = enumValue(input, "frequency", FREQUENCIES);
  const expiration = enumValue(input, "expiration", EXPIRATIONS, "no_expiration");
  const amountMinor =
    couponType === "fixed_amount" ? positiveInteger(input.amount_cents, "amount_cents") : null;
  const currency =
    couponType === "fixed_amount" ? requiredCurrency(input, "amount_currency") : null;
  const percentageRate =
    couponType === "percentage" ? percentage(input.percentage_rate, "percentage_rate") : null;
  const frequencyDuration =
    frequency === "recurring"
      ? positiveInteger(input.frequency_duration, "frequency_duration")
      : null;
  const expirationAt =
    expiration === "time_limit" ? isoTimestamp(input.expiration_at, "expiration_at") : null;
  const reusable = optionalBoolean(input.reusable, true);
  const normalized = {
    amountMinor,
    code,
    couponType,
    currency,
    description: optionalString(input, "description"),
    expiration,
    expirationAt,
    frequency,
    frequencyDuration,
    name,
    percentageRate,
    reusable,
  };
  const requestHash = await sha256Hex(stableJson(normalized));
  const existing = await findCoupon(env.BILLING_DB, auth.organizationId, code);
  if (existing) {
    if (existing.request_sha256 === requestHash) {
      return json({ coupon: serializeCoupon(existing) }, { requestId });
    }
    throw new ApiError(422, "value_already_exist", "Coupon code already exists");
  }
  const now = new Date().toISOString();
  const id = await deterministicUuid("coupon", `${auth.organizationId}:${code}`);
  const event: DomainEvent = {
    id: `coupon-created:${id}:v1`,
    type: "coupon.created",
    version: 1,
    aggregateType: "coupon",
    aggregateId: id,
    aggregateVersion: 1,
    occurredAt: now,
    causationId: requestId,
    correlationId: requestId,
    payload: { organizationId: auth.organizationId, couponId: id, code },
  };
  try {
    await env.BILLING_DB.batch([
      env.BILLING_DB.prepare(
        `INSERT INTO coupons
       (id, organization_id, code, name, description, coupon_type, amount_minor, currency,
        percentage_rate, frequency, frequency_duration, expiration, expiration_at, reusable,
        status, request_sha256, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?)`,
      ).bind(
        id,
        auth.organizationId,
        code,
        name,
        normalized.description,
        couponType,
        amountMinor,
        currency,
        percentageRate,
        frequency,
        frequencyDuration,
        expiration,
        expirationAt,
        reusable ? 1 : 0,
        requestHash,
        now,
        now,
      ),
      outboxStatement(env.BILLING_DB, auth.organizationId, event),
    ]);
  } catch (error) {
    const concurrent = await findCoupon(env.BILLING_DB, auth.organizationId, code);
    if (!concurrent) throw error;
    if (concurrent.request_sha256 !== requestHash) {
      throw new ApiError(422, "value_already_exist", "Coupon code already exists");
    }
    return json({ coupon: serializeCoupon(concurrent) }, { requestId });
  }
  await env.DOMAIN_EVENTS.send(event);
  const coupon = await findCoupon(env.BILLING_DB, auth.organizationId, code);
  if (!coupon) throw new ApiError(500, "persistence_error", "Coupon was not persisted");
  return json({ coupon: serializeCoupon(coupon) }, { requestId });
}

async function listCoupons(
  url: URL,
  database: D1Database,
  auth: AuthContext,
  requestId: string,
): Promise<Response> {
  const page = pageValue(url.searchParams.get("page"));
  const perPage = Math.min(pageValue(url.searchParams.get("per_page"), 20), 100);
  const offset = (page - 1) * perPage;
  const count = await database
    .prepare("SELECT COUNT(*) AS total FROM coupons WHERE organization_id = ?")
    .bind(auth.organizationId)
    .first<{ total: number }>();
  const rows = await database
    .prepare(
      `${couponSelect()} WHERE organization_id = ? ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`,
    )
    .bind(auth.organizationId, perPage, offset)
    .all<CouponRow>();
  return json(
    {
      coupons: rows.results.map(serializeCoupon),
      meta: pagination(count?.total ?? 0, page, perPage),
    },
    { requestId },
  );
}

async function showCoupon(
  code: string,
  database: D1Database,
  auth: AuthContext,
  requestId: string,
): Promise<Response> {
  const coupon = await findCoupon(database, auth.organizationId, code);
  if (!coupon) throw new ApiError(404, "coupon_not_found", "Coupon was not found");
  return json({ coupon: serializeCoupon(coupon) }, { requestId });
}

async function applyCoupon(
  request: Request,
  env: Env,
  auth: AuthContext,
  requestId: string,
): Promise<Response> {
  const input = objectAt(await parseJsonObject(request), "applied_coupon");
  const externalCustomerId = requiredString(input, "external_customer_id");
  const couponCode = requiredString(input, "coupon_code");
  const customer = await env.BILLING_DB.prepare(
    "SELECT id, currency FROM customers WHERE organization_id = ? AND external_id = ? LIMIT 1",
  )
    .bind(auth.organizationId, externalCustomerId)
    .first<{ id: string; currency: string | null }>();
  if (!customer) throw new ApiError(404, "customer_not_found", "Customer was not found");
  const coupon = await findCoupon(env.BILLING_DB, auth.organizationId, couponCode);
  if (!coupon || coupon.status !== "active" || isExpired(coupon)) {
    throw new ApiError(404, "coupon_not_found", "Active coupon was not found");
  }
  const terms = normalizeAppliedTerms(input, coupon);
  if (terms.currency && customer.currency && terms.currency !== customer.currency) {
    throw new ApiError(422, "currency_mismatch", "Coupon and customer currencies must match");
  }
  const idempotencyKey = normalizedIdempotencyKey(request.headers.get("Idempotency-Key"));
  const requestHash = await sha256Hex(
    stableJson({ couponCode, externalCustomerId, idempotencyKey, ...terms }),
  );
  if (idempotencyKey) {
    const replay = await findAppliedByIdempotency(
      env.BILLING_DB,
      auth.organizationId,
      idempotencyKey,
    );
    if (replay) {
      if (replay.request_sha256 !== requestHash) {
        throw new ApiError(
          409,
          "idempotency_conflict",
          "Idempotency key was reused with different input",
        );
      }
      return json({ applied_coupon: serializeAppliedCoupon(replay) }, { requestId });
    }
  }
  const commandKey = `coupon-apply:${idempotencyKey ?? crypto.randomUUID()}`;
  const account = env.BILLING_ACCOUNTS.getByName(`customer:${customer.id}`);
  const reservation = await account.reserveCommand({
    idempotencyKey: commandKey,
    commandType: "coupon.apply",
    requestHash,
  });
  if (!reservation.ok)
    throw new ApiError(409, reservation.error, "Coupon application conflicts with another command");
  if (reservation.replayed && reservation.reservation.status !== "completed") {
    throw new ApiError(409, "coupon_application_in_progress", "Coupon application is in progress");
  }
  if (reservation.replayed && idempotencyKey) {
    const replay = await findAppliedByIdempotency(
      env.BILLING_DB,
      auth.organizationId,
      idempotencyKey,
    );
    if (replay) return json({ applied_coupon: serializeAppliedCoupon(replay) }, { requestId });
  }
  try {
    if (coupon.reusable === 0) {
      const used = await env.BILLING_DB.prepare(
        "SELECT id FROM applied_coupons WHERE customer_id = ? AND coupon_id = ? LIMIT 1",
      )
        .bind(customer.id, coupon.id)
        .first();
      if (used)
        throw new ApiError(
          422,
          "coupon_is_not_reusable",
          "Coupon was already applied to this customer",
        );
    }
    const now = new Date().toISOString();
    const id = idempotencyKey
      ? await deterministicUuid("applied-coupon", `${auth.organizationId}:${idempotencyKey}`)
      : crypto.randomUUID();
    const event: DomainEvent = {
      id: `applied-coupon-created:${id}:v1`,
      type: "applied_coupon.created",
      version: 1,
      aggregateType: "applied_coupon",
      aggregateId: id,
      aggregateVersion: 1,
      occurredAt: now,
      causationId: requestId,
      correlationId: requestId,
      payload: {
        organizationId: auth.organizationId,
        appliedCouponId: id,
        couponId: coupon.id,
        customerId: customer.id,
      },
    };
    await env.BILLING_DB.batch([
      env.BILLING_DB.prepare(
        `INSERT INTO applied_coupons
         (id, organization_id, customer_id, coupon_id, amount_minor, currency, percentage_rate,
          frequency, frequency_duration, frequency_duration_remaining, status, termination_reason,
          reuse_slot, idempotency_key, request_sha256, version, created_at, updated_at, terminated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', NULL, ?, ?, ?, 1, ?, ?, NULL)`,
      ).bind(
        id,
        auth.organizationId,
        customer.id,
        coupon.id,
        terms.amountMinor,
        terms.currency,
        terms.percentageRate,
        terms.frequency,
        terms.frequencyDuration,
        terms.frequencyDuration,
        coupon.reusable === 0 ? 0 : null,
        idempotencyKey,
        requestHash,
        now,
        now,
      ),
      env.BILLING_DB.prepare(
        "UPDATE customers SET currency = COALESCE(currency, ?), updated_at = ? WHERE id = ?",
      ).bind(terms.currency, now, customer.id),
      outboxStatement(env.BILLING_DB, auth.organizationId, event),
    ]);
    await env.DOMAIN_EVENTS.send(event);
    await account.completeCommand(commandKey, { appliedCouponId: id });
    const applied = await findAppliedById(env.BILLING_DB, auth.organizationId, id);
    if (!applied) throw new ApiError(500, "persistence_error", "Applied coupon was not persisted");
    return json({ applied_coupon: serializeAppliedCoupon(applied) }, { requestId });
  } catch (error) {
    await account.releaseCommand(commandKey, requestHash);
    if (coupon.reusable === 0) {
      const used = await env.BILLING_DB.prepare(
        "SELECT id FROM applied_coupons WHERE customer_id = ? AND coupon_id = ? LIMIT 1",
      )
        .bind(customer.id, coupon.id)
        .first();
      if (used) {
        throw new ApiError(
          422,
          "coupon_is_not_reusable",
          "Coupon was already applied to this customer",
        );
      }
    }
    throw error;
  }
}

async function listAppliedCoupons(
  url: URL,
  database: D1Database,
  auth: AuthContext,
  requestId: string,
): Promise<Response> {
  const externalCustomerId = url.searchParams.get("external_customer_id")?.trim() || null;
  const status = url.searchParams.get("status")?.trim() || null;
  if (status && status !== "active" && status !== "terminated") {
    throw new ApiError(422, "validation_error", "status must be active or terminated");
  }
  const page = pageValue(url.searchParams.get("page"));
  const perPage = Math.min(pageValue(url.searchParams.get("per_page"), 20), 100);
  const conditions = ["ac.organization_id = ?"];
  const bindings: unknown[] = [auth.organizationId];
  if (externalCustomerId) {
    conditions.push("c.external_id = ?");
    bindings.push(externalCustomerId);
  }
  if (status) {
    conditions.push("ac.status = ?");
    bindings.push(status);
  }
  const where = conditions.join(" AND ");
  const count = await database
    .prepare(
      `SELECT COUNT(*) AS total FROM applied_coupons ac JOIN customers c ON c.id = ac.customer_id WHERE ${where}`,
    )
    .bind(...bindings)
    .first<{ total: number }>();
  const rows = await database
    .prepare(
      `${appliedCouponSelect()} WHERE ${where} ORDER BY ac.created_at DESC, ac.id DESC LIMIT ? OFFSET ?`,
    )
    .bind(...bindings, perPage, (page - 1) * perPage)
    .all<AppliedCouponRow>();
  return json(
    {
      applied_coupons: rows.results.map(serializeAppliedCoupon),
      meta: pagination(count?.total ?? 0, page, perPage),
    },
    { requestId },
  );
}

async function terminateAppliedCoupon(
  externalCustomerId: string,
  appliedCouponId: string,
  env: Env,
  auth: AuthContext,
  requestId: string,
): Promise<Response> {
  let applied = await findAppliedForCustomer(
    env.BILLING_DB,
    auth.organizationId,
    externalCustomerId,
    appliedCouponId,
  );
  if (!applied) throw new ApiError(404, "applied_coupon_not_found", "Applied coupon was not found");
  if (applied.status === "terminated" && applied.termination_reason === "manual")
    return json({ applied_coupon: serializeAppliedCoupon(applied) }, { requestId });
  const account = env.BILLING_ACCOUNTS.getByName(`customer:${applied.customer_id}`);
  const requestHash = await sha256Hex(stableJson({ appliedCouponId, operation: "terminate" }));
  const commandKey = `coupon-terminate:${appliedCouponId}`;
  const reservation = await account.reserveCommand({
    idempotencyKey: commandKey,
    commandType: "coupon.terminate",
    requestHash,
  });
  if (!reservation.ok)
    throw new ApiError(409, reservation.error, "Coupon termination conflicts with another command");
  if (!reservation.replayed) {
    const now = new Date().toISOString();
    const nextVersion = applied.version + 1;
    const event: DomainEvent = {
      id: `applied-coupon-terminated:${applied.id}:v${nextVersion}`,
      type: "applied_coupon.terminated",
      version: 1,
      aggregateType: "applied_coupon",
      aggregateId: applied.id,
      aggregateVersion: nextVersion,
      occurredAt: now,
      causationId: requestId,
      correlationId: requestId,
      payload: {
        organizationId: auth.organizationId,
        appliedCouponId: applied.id,
        customerId: applied.customer_id,
      },
    };
    const results = await env.BILLING_DB.batch([
      env.BILLING_DB.prepare(
        `UPDATE applied_coupons SET status = 'terminated', termination_reason = 'manual',
         terminated_at = COALESCE(terminated_at, ?), updated_at = ?, version = version + 1
         WHERE id = ? AND organization_id = ? AND version = ?`,
      ).bind(now, now, applied.id, auth.organizationId, applied.version),
      outboxStatement(env.BILLING_DB, auth.organizationId, event),
    ]);
    if (results[0]?.meta.changes !== 1)
      throw new ApiError(409, "coupon_version_conflict", "Applied coupon changed concurrently");
    await env.DOMAIN_EVENTS.send(event);
    await account.completeCommand(commandKey, { terminatedAt: now });
  }
  applied = await findAppliedById(env.BILLING_DB, auth.organizationId, applied.id);
  if (!applied) throw new ApiError(500, "persistence_error", "Applied coupon disappeared");
  return json({ applied_coupon: serializeAppliedCoupon(applied) }, { requestId });
}

function couponSelect() {
  return `SELECT id, code, name, description, coupon_type, amount_minor, currency,
    percentage_rate, frequency, frequency_duration, expiration, expiration_at, reusable,
    status, request_sha256, created_at, terminated_at FROM coupons`;
}

async function findCoupon(database: D1Database, organizationId: string, code: string) {
  return database
    .prepare(`${couponSelect()} WHERE organization_id = ? AND code = ? LIMIT 1`)
    .bind(organizationId, code)
    .first<CouponRow>();
}

function appliedCouponSelect() {
  return `SELECT ac.id, ac.coupon_id, cp.code AS coupon_code, cp.name AS coupon_name,
    cp.description AS coupon_description, cp.status AS coupon_status, ac.customer_id,
    c.external_id AS customer_external_id, ac.status, ac.amount_minor, ac.currency,
    ac.percentage_rate, ac.frequency, ac.frequency_duration,
    ac.frequency_duration_remaining, cp.expiration_at, ac.idempotency_key,
    ac.request_sha256, ac.created_at, ac.terminated_at, ac.termination_reason, ac.version,
    COALESCE((SELECT SUM(cc.amount_minor) FROM coupon_credits cc
      JOIN invoices i ON i.id = cc.invoice_id
      WHERE cc.applied_coupon_id = ac.id AND i.status <> 'voided'), 0) AS consumed_minor
    FROM applied_coupons ac JOIN coupons cp ON cp.id = ac.coupon_id
    JOIN customers c ON c.id = ac.customer_id`;
}

async function findAppliedById(database: D1Database, organizationId: string, id: string) {
  return database
    .prepare(`${appliedCouponSelect()} WHERE ac.organization_id = ? AND ac.id = ? LIMIT 1`)
    .bind(organizationId, id)
    .first<AppliedCouponRow>();
}

async function findAppliedByIdempotency(database: D1Database, organizationId: string, key: string) {
  return database
    .prepare(
      `${appliedCouponSelect()} WHERE ac.organization_id = ? AND ac.idempotency_key = ? LIMIT 1`,
    )
    .bind(organizationId, key)
    .first<AppliedCouponRow>();
}

async function findAppliedForCustomer(
  database: D1Database,
  organizationId: string,
  externalCustomerId: string,
  id: string,
) {
  return database
    .prepare(
      `${appliedCouponSelect()} WHERE ac.organization_id = ? AND c.external_id = ? AND ac.id = ? LIMIT 1`,
    )
    .bind(organizationId, externalCustomerId, id)
    .first<AppliedCouponRow>();
}

function serializeCoupon(row: CouponRow): Record<string, unknown> {
  return {
    lago_id: row.id,
    name: row.name,
    code: row.code,
    description: row.description,
    coupon_type: row.coupon_type,
    amount_cents: row.amount_minor,
    amount_currency: row.currency,
    percentage_rate: row.percentage_rate,
    frequency: row.frequency,
    frequency_duration: row.frequency_duration,
    reusable: row.reusable === 1,
    limited_plans: false,
    limited_billable_metrics: false,
    plan_codes: [],
    billable_metric_codes: [],
    created_at: row.created_at,
    expiration: row.expiration,
    expiration_at: row.expiration_at,
    terminated_at: row.terminated_at,
  };
}

function serializeAppliedCoupon(row: AppliedCouponRow): Record<string, unknown> {
  const remaining =
    row.frequency === "once" && row.amount_minor !== null
      ? Math.max(0, row.amount_minor - row.consumed_minor)
      : null;
  return {
    lago_id: row.id,
    lago_coupon_id: row.coupon_id,
    coupon_code: row.coupon_code,
    coupon_name: row.coupon_name,
    coupon_description: row.coupon_description,
    coupon_status: row.coupon_status,
    lago_customer_id: row.customer_id,
    external_customer_id: row.customer_external_id,
    status: row.status,
    amount_cents: row.amount_minor,
    amount_cents_remaining: remaining,
    amount_currency: row.currency,
    percentage_rate: row.percentage_rate,
    frequency: row.frequency,
    frequency_duration: row.frequency_duration,
    frequency_duration_remaining: row.frequency_duration_remaining,
    expiration_at: row.expiration_at,
    created_at: row.created_at,
    terminated_at: row.terminated_at,
  };
}

function normalizeAppliedTerms(input: Record<string, unknown>, coupon: CouponRow) {
  const frequency =
    input.frequency === undefined ? coupon.frequency : enumValue(input, "frequency", FREQUENCIES);
  const amountMinor =
    coupon.coupon_type === "fixed_amount"
      ? input.amount_cents === undefined
        ? coupon.amount_minor
        : positiveInteger(input.amount_cents, "amount_cents")
      : null;
  const currency =
    coupon.coupon_type === "fixed_amount"
      ? input.amount_currency === undefined
        ? coupon.currency
        : requiredCurrency(input, "amount_currency")
      : null;
  const percentageRate =
    coupon.coupon_type === "percentage"
      ? input.percentage_rate === undefined
        ? coupon.percentage_rate
        : percentage(input.percentage_rate, "percentage_rate")
      : null;
  const frequencyDuration =
    frequency === "recurring"
      ? input.frequency_duration === undefined
        ? coupon.frequency_duration
        : positiveInteger(input.frequency_duration, "frequency_duration")
      : null;
  if (frequency === "recurring" && frequencyDuration === null) {
    throw new ApiError(422, "validation_error", "frequency_duration is required");
  }
  return { amountMinor, currency, percentageRate, frequency, frequencyDuration };
}

function rejectCouponTargets(value: unknown): void {
  if (value === undefined || value === null) return;
  if (typeof value !== "object" || Array.isArray(value))
    throw new ApiError(422, "validation_error", "applies_to must be an object");
  if (
    Object.values(value as Record<string, unknown>).some((entry) =>
      Array.isArray(entry) ? entry.length > 0 : entry != null,
    )
  ) {
    throw new ApiError(
      422,
      "unsupported_coupon_targets",
      "Plan and billable-metric coupon targets are not implemented",
    );
  }
}

function enumValue(
  input: Record<string, unknown>,
  field: string,
  allowed: Set<string>,
  fallback?: string,
): string {
  const value = input[field] ?? fallback;
  if (typeof value !== "string" || !allowed.has(value))
    throw new ApiError(422, "validation_error", `${field} is invalid`);
  return value;
}

function positiveInteger(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0)
    throw new ApiError(422, "validation_error", `${field} must be a positive integer`);
  return value;
}

function requiredCurrency(input: Record<string, unknown>, field: string): string {
  const value = requiredString(input, field).toUpperCase();
  if (!/^[A-Z]{3}$/.test(value))
    throw new ApiError(422, "validation_error", `${field} must be an ISO currency code`);
  return value;
}

function percentage(value: unknown, field: string): string {
  if ((typeof value !== "string" && typeof value !== "number") || String(value).trim() === "")
    throw new ApiError(422, "validation_error", `${field} is required`);
  let decimal: Decimal;
  try {
    decimal = Decimal.parse(String(value));
  } catch {
    throw new ApiError(422, "validation_error", `${field} must be a decimal`);
  }
  if (decimal.compare(Decimal.zero()) <= 0 || decimal.compare(Decimal.parse(100)) > 0)
    throw new ApiError(422, "validation_error", `${field} must be greater than 0 and at most 100`);
  return decimal.toString();
}

function isoTimestamp(value: unknown, field: string): string {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value)))
    throw new ApiError(422, "validation_error", `${field} must be an ISO timestamp`);
  return new Date(value).toISOString();
}

function optionalBoolean(value: unknown, fallback: boolean): boolean {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== "boolean")
    throw new ApiError(422, "validation_error", "reusable must be a boolean");
  return value;
}

function normalizedIdempotencyKey(value: string | null): string | null {
  const normalized = value?.trim() || null;
  if (normalized && normalized.length > 200)
    throw new ApiError(422, "validation_error", "Idempotency-Key is too long");
  return normalized;
}

function isExpired(coupon: CouponRow): boolean {
  return (
    coupon.expiration === "time_limit" &&
    coupon.expiration_at !== null &&
    Date.parse(coupon.expiration_at) <= Date.now()
  );
}

function pageValue(value: string | null, fallback = 1): number {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
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

function outboxStatement(
  database: D1Database,
  organizationId: string,
  event: DomainEvent,
): D1PreparedStatement {
  return database
    .prepare(
      `INSERT INTO outbox_events
       (event_id, organization_id, event_type, event_version, aggregate_type,
        aggregate_id, aggregate_version, causation_id, correlation_id, payload_json,
        occurred_at, published_at)
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
