import type { AuthContext } from "../auth/api-key";
import { sha256Hex } from "../auth/api-key";
import { ApiError, json, objectAt, optionalString, parseJsonObject, requiredString } from "../http";
import { deterministicUuid } from "../identifiers";
import { stableJson } from "../json";
import { parseChargeModel } from "../usage/charge-properties";

type PlanRow = {
  id: string;
  code: string;
  name: string;
  invoice_display_name: string | null;
  description: string | null;
  interval: string;
  amount_minor: number;
  currency: string;
  trial_period: number | null;
  pay_in_advance: number;
  bill_charges_monthly: number | null;
  bill_fixed_charges_monthly: number | null;
  metadata_json: string;
  request_sha256: string | null;
  pending_deletion: number;
  created_at: string;
};

type ChargeRow = {
  id: string;
  billable_metric_id: string;
  billable_metric_code: string;
  code: string;
  invoice_display_name: string | null;
  charge_model: string;
  properties_json: string;
  invoiceable: number;
  pay_in_advance: number;
  prorated: number;
  min_amount_minor: number;
  created_at: string;
};

type NormalizedCharge = {
  id: string;
  metricId: string;
  code: string;
  invoiceDisplayName: string | null;
  chargeModel: string;
  properties: Record<string, unknown>;
  invoiceable: number;
  payInAdvance: number;
  prorated: number;
  minAmountMinor: number;
};

type NormalizedCommitment = {
  id: string;
  amountMinor: number;
  invoiceDisplayName: string | null;
};

const INTERVALS = new Set(["weekly", "monthly", "quarterly", "yearly", "one_time"]);

export async function handlePlanCatalogRequest(
  request: Request,
  database: D1Database,
  auth: AuthContext,
  requestId: string,
): Promise<Response | null> {
  const url = new URL(request.url);
  if (request.method === "POST" && url.pathname === "/api/v1/plans") {
    return createPlan(request, database, auth, requestId);
  }
  if (request.method === "GET" && url.pathname === "/api/v1/plans") {
    return listPlans(url, database, auth, requestId);
  }
  const match = url.pathname.match(/^\/api\/v1\/plans\/([^/]+)$/);
  if (request.method === "GET" && match?.[1]) {
    return showPlan(decodeURIComponent(match[1]), database, auth, requestId);
  }
  return null;
}

async function createPlan(
  request: Request,
  database: D1Database,
  auth: AuthContext,
  requestId: string,
): Promise<Response> {
  const body = await parseJsonObject(request);
  const input = objectAt(body, "plan");
  const code = requiredString(input, "code");
  const name = requiredString(input, "name");
  const interval = requiredString(input, "interval");
  if (!INTERVALS.has(interval)) {
    throw new ApiError(422, "validation_error", `Unsupported interval: ${interval}`);
  }
  const amountMinor = nonNegativeInteger(input.amount_cents, "amount_cents");
  const currency = requiredString(input, "amount_currency").toUpperCase();
  if (!/^[A-Z]{3}$/.test(currency)) {
    throw new ApiError(422, "validation_error", "amount_currency must be an ISO currency code");
  }
  const metadata = optionalObject(input.metadata, "metadata");
  if (Array.isArray(input.tax_codes) && input.tax_codes.length > 0)
    throw new ApiError(
      422,
      "unsupported_tax_target",
      "Plan tax targeting is not implemented; use organization-default taxes",
    );
  rejectNonEmpty(input, ["fixed_charges", "usage_thresholds"]);
  const minimumCommitment = await normalizeMinimumCommitment(
    input.minimum_commitment,
    auth.organizationId,
    code,
  );
  const normalizedRequest = {
    amountMinor,
    billChargesMonthly: optionalBooleanInteger(input.bill_charges_monthly),
    billFixedChargesMonthly: optionalBooleanInteger(input.bill_fixed_charges_monthly),
    charges: input.charges ?? [],
    code,
    currency,
    description: optionalString(input, "description"),
    interval,
    invoiceDisplayName: optionalString(input, "invoice_display_name"),
    metadata,
    minimumCommitment,
    name,
    payInAdvance: booleanInteger(input.pay_in_advance, false),
    trialPeriod: optionalNonNegativeNumber(input.trial_period, "trial_period"),
  };
  const requestHash = await sha256Hex(stableJson(normalizedRequest));
  const existing = await findPlan(database, auth.organizationId, code);
  if (existing) {
    if (existing.request_sha256 === requestHash) {
      return json({ plan: await serializePlan(database, existing) }, { requestId });
    }
    throw new ApiError(422, "value_already_exist", "Plan code already exists");
  }

  const planId = await deterministicUuid("plan", `${auth.organizationId}:${code}`);
  const charges = await normalizeCharges(
    input.charges,
    database,
    auth.organizationId,
    planId,
    code,
  );
  const now = new Date().toISOString();
  await database.batch([
    database
      .prepare(
        `INSERT INTO plans
         (id, organization_id, code, name, interval, amount_minor, currency, version,
          active, created_at, updated_at, invoice_display_name, description, trial_period,
          pay_in_advance, bill_charges_monthly, bill_fixed_charges_monthly, metadata_json,
          request_sha256, pending_deletion)
         VALUES (?, ?, ?, ?, ?, ?, ?, 1, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`,
      )
      .bind(
        planId,
        auth.organizationId,
        code,
        name,
        interval,
        amountMinor,
        currency,
        now,
        now,
        normalizedRequest.invoiceDisplayName,
        normalizedRequest.description,
        normalizedRequest.trialPeriod,
        normalizedRequest.payInAdvance,
        normalizedRequest.billChargesMonthly,
        normalizedRequest.billFixedChargesMonthly,
        stableJson(metadata),
        requestHash,
      ),
    ...charges.map((charge) =>
      database
        .prepare(
          `INSERT INTO charges
           (id, organization_id, plan_id, billable_metric_id, code, invoice_display_name,
            charge_model, properties_json, invoiceable, pay_in_advance, prorated,
            min_amount_minor, version, active, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 1, ?, ?)`,
        )
        .bind(
          charge.id,
          auth.organizationId,
          planId,
          charge.metricId,
          charge.code,
          charge.invoiceDisplayName,
          charge.chargeModel,
          stableJson(charge.properties),
          charge.invoiceable,
          charge.payInAdvance,
          charge.prorated,
          charge.minAmountMinor,
          now,
          now,
        ),
    ),
    ...(minimumCommitment
      ? [
          database
            .prepare(
              `INSERT INTO minimum_commitments
               (id, organization_id, plan_id, amount_minor, invoice_display_name,
                created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
            )
            .bind(
              minimumCommitment.id,
              auth.organizationId,
              planId,
              minimumCommitment.amountMinor,
              minimumCommitment.invoiceDisplayName,
              now,
              now,
            ),
        ]
      : []),
  ]);
  const plan = await findPlan(database, auth.organizationId, code);
  if (!plan) throw new ApiError(500, "persistence_error", "Plan was not persisted");
  return json({ plan: await serializePlan(database, plan) }, { requestId });
}

async function listPlans(
  url: URL,
  database: D1Database,
  auth: AuthContext,
  requestId: string,
): Promise<Response> {
  const page = positiveInteger(url.searchParams.get("page"), 1);
  const perPage = Math.min(positiveInteger(url.searchParams.get("per_page"), 20), 100);
  const offset = (page - 1) * perPage;
  const count = await database
    .prepare("SELECT COUNT(*) AS total FROM plans WHERE organization_id = ? AND active = 1")
    .bind(auth.organizationId)
    .first<{ total: number }>();
  const result = await database
    .prepare(`${planSelect()} WHERE organization_id = ? AND active = 1
              ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`)
    .bind(auth.organizationId, perPage, offset)
    .all<PlanRow>();
  return json(
    {
      plans: await Promise.all(result.results.map((plan) => serializePlan(database, plan))),
      meta: pagination(count?.total ?? 0, page, perPage),
    },
    { requestId },
  );
}

async function showPlan(
  code: string,
  database: D1Database,
  auth: AuthContext,
  requestId: string,
): Promise<Response> {
  const plan = await findPlan(database, auth.organizationId, code);
  if (!plan) throw new ApiError(404, "plan_not_found", "Plan was not found");
  return json({ plan: await serializePlan(database, plan) }, { requestId });
}

function planSelect(): string {
  return `SELECT id, code, name, invoice_display_name, description, interval, amount_minor,
                 currency, trial_period, pay_in_advance, bill_charges_monthly,
                 bill_fixed_charges_monthly, metadata_json, request_sha256,
                 pending_deletion, created_at FROM plans`;
}

async function findPlan(database: D1Database, organizationId: string, code: string) {
  return database
    .prepare(`${planSelect()} WHERE organization_id = ? AND code = ? AND active = 1
              ORDER BY version DESC LIMIT 1`)
    .bind(organizationId, code)
    .first<PlanRow>();
}

async function serializePlan(
  database: D1Database,
  plan: PlanRow,
): Promise<Record<string, unknown>> {
  const charges = await database
    .prepare(
      `SELECT ch.id, ch.billable_metric_id, bm.code AS billable_metric_code, ch.code,
              ch.invoice_display_name, ch.charge_model, ch.properties_json, ch.invoiceable,
              ch.pay_in_advance, ch.prorated, ch.min_amount_minor, ch.created_at
       FROM charges ch JOIN billable_metrics bm ON bm.id = ch.billable_metric_id
       WHERE ch.plan_id = ? AND ch.active = 1 ORDER BY ch.created_at, ch.id`,
    )
    .bind(plan.id)
    .all<ChargeRow>();
  const commitment = await database
    .prepare(
      `SELECT id, amount_minor, invoice_display_name, created_at, updated_at
       FROM minimum_commitments WHERE plan_id = ? LIMIT 1`,
    )
    .bind(plan.id)
    .first<{
      id: string;
      amount_minor: number;
      invoice_display_name: string | null;
      created_at: string;
      updated_at: string;
    }>();
  return {
    lago_id: plan.id,
    name: plan.name,
    invoice_display_name: plan.invoice_display_name,
    created_at: plan.created_at,
    code: plan.code,
    interval: plan.interval,
    description: plan.description,
    amount_cents: plan.amount_minor,
    amount_currency: plan.currency,
    trial_period: plan.trial_period,
    pay_in_advance: plan.pay_in_advance === 1,
    bill_charges_monthly:
      plan.bill_charges_monthly === null ? null : plan.bill_charges_monthly === 1,
    bill_fixed_charges_monthly:
      plan.bill_fixed_charges_monthly === null ? null : plan.bill_fixed_charges_monthly === 1,
    customers_count: 0,
    active_subscriptions_count: 0,
    draft_invoices_count: 0,
    parent_id: null,
    pending_deletion: plan.pending_deletion === 1,
    charges: charges.results.map(serializeCharge),
    fixed_charges: [],
    entitlements: [],
    usage_thresholds: [],
    applicable_usage_thresholds: [],
    taxes: [],
    metadata: parseObject(plan.metadata_json),
    minimum_commitment: commitment
      ? {
          lago_id: commitment.id,
          plan_code: plan.code,
          invoice_display_name: commitment.invoice_display_name,
          amount_cents: commitment.amount_minor,
          interval: plan.interval,
          created_at: commitment.created_at,
          updated_at: commitment.updated_at,
          taxes: [],
        }
      : null,
  };
}

async function normalizeMinimumCommitment(
  value: unknown,
  organizationId: string,
  planCode: string,
): Promise<NormalizedCommitment | null> {
  if (value === undefined || value === null) return null;
  const input = optionalObject(value, "minimum_commitment");
  if (Array.isArray(input.tax_codes) && input.tax_codes.length > 0)
    throw new ApiError(
      422,
      "unsupported_tax_target",
      "Commitment-specific tax targeting is not implemented",
    );
  const amountMinor = nonNegativeInteger(input.amount_cents, "minimum_commitment.amount_cents");
  if (amountMinor === 0)
    throw new ApiError(422, "validation_error", "minimum_commitment.amount_cents must be positive");
  return {
    id: await deterministicUuid("minimum-commitment", `${organizationId}:${planCode}`),
    amountMinor,
    invoiceDisplayName: optionalString(input, "invoice_display_name"),
  };
}

function serializeCharge(charge: ChargeRow): Record<string, unknown> {
  return {
    lago_id: charge.id,
    lago_billable_metric_id: charge.billable_metric_id,
    code: charge.code,
    invoice_display_name: charge.invoice_display_name,
    billable_metric_code: charge.billable_metric_code,
    created_at: charge.created_at,
    charge_model: charge.charge_model,
    invoiceable: charge.invoiceable === 1,
    pay_in_advance: charge.pay_in_advance === 1,
    prorated: charge.prorated === 1,
    min_amount_cents: charge.min_amount_minor,
    properties: parseObject(charge.properties_json),
    filters: [],
    taxes: [],
    applied_pricing_unit: null,
    lago_parent_id: null,
  };
}

async function normalizeCharges(
  value: unknown,
  database: D1Database,
  organizationId: string,
  planId: string,
  planCode: string,
): Promise<NormalizedCharge[]> {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value))
    throw new ApiError(422, "validation_error", "charges must be an array");
  const charges: NormalizedCharge[] = [];
  const seen = new Set<string>();
  for (const [index, entry] of value.entries()) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new ApiError(422, "validation_error", `charges[${index}] must be an object`);
    }
    const input = entry as Record<string, unknown>;
    const metricId = requiredString(input, "billable_metric_id");
    const metric = await database
      .prepare(
        `SELECT id, code FROM billable_metrics
         WHERE organization_id = ? AND id = ? AND active = 1 LIMIT 1`,
      )
      .bind(organizationId, metricId)
      .first<{ id: string; code: string }>();
    if (!metric)
      throw new ApiError(404, "billable_metric_not_found", "Billable metric was not found");
    const code = optionalString(input, "code") ?? `${planCode}-${metric.code}`;
    if (seen.has(code)) throw new ApiError(422, "value_already_exist", "Charge code is duplicated");
    seen.add(code);
    const chargeModel = requiredString(input, "charge_model");
    const properties = optionalObject(input.properties, "properties");
    parseChargeModel(chargeModel, properties);
    charges.push({
      id: await deterministicUuid("charge", `${planId}:${code}`),
      metricId,
      code,
      invoiceDisplayName: optionalString(input, "invoice_display_name"),
      chargeModel,
      properties,
      invoiceable: booleanInteger(input.invoiceable, true),
      payInAdvance: booleanInteger(input.pay_in_advance, false),
      prorated: booleanInteger(input.prorated, false),
      minAmountMinor:
        input.min_amount_cents === undefined
          ? 0
          : nonNegativeInteger(input.min_amount_cents, "min_amount_cents"),
    });
  }
  return charges;
}

function optionalObject(value: unknown, field: string): Record<string, unknown> {
  if (value === undefined || value === null) return {};
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ApiError(422, "validation_error", `${field} must be an object`);
  }
  return value as Record<string, unknown>;
}

function parseObject(value: string): Record<string, unknown> {
  try {
    return optionalObject(JSON.parse(value) as unknown, "stored JSON");
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError(500, "invalid_stored_json", "Stored JSON could not be decoded");
  }
}

function booleanInteger(value: unknown, fallback: boolean): 0 | 1 {
  if (value === undefined || value === null) return fallback ? 1 : 0;
  if (typeof value !== "boolean") throw new ApiError(422, "validation_error", "must be boolean");
  return value ? 1 : 0;
}

function optionalBooleanInteger(value: unknown): 0 | 1 | null {
  return value === undefined || value === null ? null : booleanInteger(value, false);
}

function nonNegativeInteger(value: unknown, field: string): number {
  const number = typeof value === "string" && value.trim() ? Number(value) : value;
  if (!Number.isSafeInteger(number) || Number(number) < 0) {
    throw new ApiError(422, "validation_error", `${field} must be a non-negative integer`);
  }
  return Number(number);
}

function optionalNonNegativeNumber(value: unknown, field: string): number | null {
  if (value === undefined || value === null) return null;
  const number = typeof value === "string" && value.trim() ? Number(value) : value;
  if (typeof number !== "number" || !Number.isFinite(number) || number < 0) {
    throw new ApiError(422, "validation_error", `${field} must be a non-negative number`);
  }
  return number;
}

function rejectNonEmpty(input: Record<string, unknown>, fields: string[]): void {
  for (const field of fields) {
    const value = input[field];
    if (value === undefined || value === null) continue;
    if (Array.isArray(value) && value.length === 0) continue;
    if (typeof value === "object" && !Array.isArray(value) && Object.keys(value).length === 0)
      continue;
    throw new ApiError(
      422,
      "unsupported_plan_feature",
      `${field} is not implemented by the Cloudflare plan catalog`,
    );
  }
}

function positiveInteger(value: string | null, fallback: number): number {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function pagination(total: number, page: number, perPage: number): Record<string, number | null> {
  const totalPages = total === 0 ? 0 : Math.ceil(total / perPage);
  return {
    current_page: total === 0 ? 0 : page,
    next_page: page < totalPages ? page + 1 : null,
    prev_page: page > 1 && page <= totalPages ? page - 1 : null,
    total_pages: totalPages,
    total_count: total,
  };
}
