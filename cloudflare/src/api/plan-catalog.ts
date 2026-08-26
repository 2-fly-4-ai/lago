import type { AuthContext } from "../auth/api-key";
import { sha256Hex } from "../auth/api-key";
import type { DomainEvent } from "../domain-events";
import { ApiError, json, objectAt, optionalString, parseJsonObject, requiredString } from "../http";
import { deterministicUuid } from "../identifiers";
import { stableJson } from "../json";
import { rateCharge } from "../rating/charge-models";
import { Decimal } from "../rating/decimal";
import { parseChargeModel } from "../usage/charge-properties";
import {
  normalizeChargeFilters,
  parseStoredBillableMetricFilters,
  parseStoredChargeFilters,
  serializeChargeFilter,
  type ChargeFilter,
} from "../usage/charge-filters";
import {
  ensurePlanDeletionWorkflow,
  findPlanDeletionTask,
  preparePlanDeletion,
} from "../billing/plan-deletion";
import { createPayInAdvanceFixedChargeDeltaInvoice } from "../billing/pay-in-advance-fixed-charges";
import { validatePayInAdvanceUsageConfiguration } from "../usage/pay-in-advance-validation";
import {
  guardedReplaceTaxTargetStatements,
  normalizeTaxCodes,
  replaceTaxTargetStatements,
  resolveActiveTaxes,
  taxesForTarget,
  type ResolvedTax,
} from "../billing/tax-targets";
import {
  normalizeUsageThresholdInputs,
  prepareUsageThresholds,
  serializeUsageThreshold,
  usageThresholdInsertStatements,
  type UsageThresholdRow,
} from "../usage/thresholds";

type PlanRow = {
  id: string;
  organization_id: string;
  parent_id: string | null;
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
  version: number;
  created_at: string;
  updated_at: string;
};

type ChargeRow = {
  id: string;
  billable_metric_id: string;
  billable_metric_code: string;
  code: string;
  invoice_display_name: string | null;
  charge_model: string;
  properties_json: string;
  filters_json: string;
  metric_filters_json: string;
  invoiceable: number;
  pay_in_advance: number;
  prorated: number;
  min_amount_minor: number;
  accepts_target_wallet: number;
  created_at: string;
};

type FixedChargeRow = {
  id: string;
  plan_id: string;
  parent_id: string | null;
  add_on_id: string;
  add_on_code: string;
  code: string;
  invoice_display_name: string | null;
  charge_model: string;
  properties_json: string;
  units: string;
  pay_in_advance: number;
  prorated: number;
  version: number;
  active: number;
  created_at: string;
  updated_at: string;
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
  acceptsTargetWallet: number;
  filters: ChargeFilter[];
  taxes: ResolvedTax[];
};

type NormalizedCommitment = {
  id: string;
  amountMinor: number;
  invoiceDisplayName: string | null;
  taxes: ResolvedTax[];
};

type NormalizedFixedCharge = {
  id: string;
  addOnId: string;
  code: string;
  invoiceDisplayName: string | null;
  chargeModel: "standard" | "graduated" | "volume";
  properties: Record<string, unknown>;
  units: string;
  payInAdvance: 0 | 1;
  prorated: 0 | 1;
  applyUnitsImmediately: boolean;
  taxes: ResolvedTax[];
};

type PreparedFixedChargeCascadeUpdate = {
  id: string;
  planId: string;
  code: string;
  version: number;
  previousUnits: string;
  propertiesJson: string;
  units: string;
};

type FixedChargeUnitChange = {
  fixedChargeId: string;
  fixedChargeVersion: number;
  planId: string;
  previousUnits: string | null;
  units: string;
};

type PreparedFixedChargeUnitEvent = {
  id: string;
  subscriptionId: string;
  fixedChargeId: string;
  fixedChargeVersion: number;
  units: string;
  effectiveAt: string;
  billImmediately: boolean;
};

type PreparedFixedChargeUnitEvents = {
  events: PreparedFixedChargeUnitEvent[];
  requiredChangeCount: number;
  changes: FixedChargeUnitChange[];
  guards: Array<{
    subscriptionId: string;
    planId: string;
    version: number;
    currentPeriodStart: string | null;
    currentPeriodEnd: string | null;
  }>;
};

type PreparedFixedChargeCascade = {
  enabled: boolean;
  guards: Array<{ id: string; version: number }>;
  updates: PreparedFixedChargeCascadeUpdate[];
};

type PreparedFixedChargeCascadeCreate = {
  id: string;
  version: 0;
  planId: string;
  planVersion: number;
  addOnId: string;
  code: string;
  invoiceDisplayName: string | null;
  chargeModel: "standard" | "graduated" | "volume";
  propertiesJson: string;
  units: string;
  payInAdvance: 0 | 1;
  prorated: 0 | 1;
};

type PreparedFixedChargeCascadeDelete = {
  id: string;
  code: string;
  version: number;
};

type PreparedPlanAmountCascade = {
  id: string;
  code: string;
  version: number;
};

const INTERVALS = new Set(["weekly", "monthly", "quarterly", "yearly", "one_time"]);

type PlanCatalogEnv = Pick<Env, "BILLING_DB" | "DOMAIN_EVENTS" | "PLAN_DELETION_WORKFLOW">;

export async function handlePlanCatalogRequest(
  request: Request,
  env: PlanCatalogEnv,
  auth: AuthContext,
  requestId: string,
): Promise<Response | null> {
  const url = new URL(request.url);
  const fixedChargesMatch = url.pathname.match(/^\/api\/v1\/plans\/([^/]+)\/fixed_charges$/);
  if (request.method === "GET" && fixedChargesMatch?.[1]) {
    return listFixedCharges(
      decodeURIComponent(fixedChargesMatch[1]),
      url,
      env.BILLING_DB,
      auth,
      requestId,
    );
  }
  if (request.method === "POST" && fixedChargesMatch?.[1]) {
    return createFixedCharge(
      request,
      decodeURIComponent(fixedChargesMatch[1]),
      env,
      auth,
      requestId,
    );
  }
  const fixedChargeMatch = url.pathname.match(
    /^\/api\/v1\/plans\/([^/]+)\/fixed_charges\/([^/]+)$/,
  );
  if (request.method === "GET" && fixedChargeMatch?.[1] && fixedChargeMatch[2]) {
    return showFixedCharge(
      decodeURIComponent(fixedChargeMatch[1]),
      decodeURIComponent(fixedChargeMatch[2]),
      env.BILLING_DB,
      auth,
      requestId,
    );
  }
  if (request.method === "PUT" && fixedChargeMatch?.[1] && fixedChargeMatch[2]) {
    return updateFixedCharge(
      request,
      decodeURIComponent(fixedChargeMatch[1]),
      decodeURIComponent(fixedChargeMatch[2]),
      env,
      auth,
      requestId,
    );
  }
  if (request.method === "DELETE" && fixedChargeMatch?.[1] && fixedChargeMatch[2]) {
    return deleteFixedCharge(
      request,
      decodeURIComponent(fixedChargeMatch[1]),
      decodeURIComponent(fixedChargeMatch[2]),
      env,
      auth,
      requestId,
    );
  }
  if (request.method === "POST" && url.pathname === "/api/v1/plans") {
    return createPlan(request, env, auth, requestId);
  }
  if (request.method === "GET" && url.pathname === "/api/v1/plans") {
    return listPlans(url, env.BILLING_DB, auth, requestId);
  }
  const match = url.pathname.match(/^\/api\/v1\/plans\/([^/]+)$/);
  if (request.method === "GET" && match?.[1]) {
    return showPlan(decodeURIComponent(match[1]), env.BILLING_DB, auth, requestId);
  }
  if (request.method === "PUT" && match?.[1]) {
    return updatePlan(decodeURIComponent(match[1]), request, env, auth, requestId);
  }
  if (request.method === "DELETE" && match?.[1]) {
    return deletePlan(decodeURIComponent(match[1]), env, auth, requestId);
  }
  return null;
}

async function createPlan(
  request: Request,
  env: PlanCatalogEnv,
  auth: AuthContext,
  requestId: string,
): Promise<Response> {
  const database = env.BILLING_DB;
  const body = await parseJsonObject(request);
  const input = objectAt(body, "plan");
  const code = requiredString(input, "code");
  const name = requiredString(input, "name");
  const interval = requiredString(input, "interval");
  if (!INTERVALS.has(interval)) {
    throw new ApiError(422, "validation_error", `Unsupported interval: ${interval}`);
  }
  if (interval === "one_time")
    throw new ApiError(
      422,
      "unsupported_plan_feature",
      "One-time plan lifecycle is not implemented",
    );
  const amountMinor = nonNegativeInteger(input.amount_cents, "amount_cents");
  const currency = requiredString(input, "amount_currency").toUpperCase();
  if (!/^[A-Z]{3}$/.test(currency)) {
    throw new ApiError(422, "validation_error", "amount_currency must be an ISO currency code");
  }
  if (input.bill_charges_monthly === true)
    throw new ApiError(
      422,
      "unsupported_plan_feature",
      "Monthly split billing for usage charges is not implemented",
    );
  const metadata = optionalObject(input.metadata, "metadata");
  const usageThresholdInputs = normalizeUsageThresholdInputs(input.usage_thresholds);
  const planTaxCodes = normalizeTaxCodes(input.tax_codes) ?? [];
  const planTaxes = await resolveActiveTaxes(database, auth.organizationId, planTaxCodes);
  const minimumCommitment = await normalizeMinimumCommitment(
    input.minimum_commitment,
    database,
    auth.organizationId,
    code,
  );
  const billFixedChargesMonthly = optionalBooleanInteger(input.bill_fixed_charges_monthly);
  if (hasEntries(input.fixed_charges) && billFixedChargesMonthly === 1)
    throw new ApiError(
      422,
      "unsupported_fixed_charge_feature",
      "Monthly split billing for fixed charges is not implemented",
    );
  if (hasEntries(input.fixed_charges) && interval === "one_time")
    throw new ApiError(
      422,
      "unsupported_fixed_charge_feature",
      "Recurring fixed charges cannot be attached to a one-time plan",
    );
  const normalizedRequest = {
    amountMinor,
    billChargesMonthly: optionalBooleanInteger(input.bill_charges_monthly),
    billFixedChargesMonthly,
    charges: input.charges ?? [],
    fixedCharges: input.fixed_charges ?? [],
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
    taxCodes: planTaxCodes,
    usageThresholds: usageThresholdInputs,
  };
  const requestHash = await sha256Hex(stableJson(normalizedRequest));
  const existing = await findPlan(database, auth.organizationId, code);
  if (existing) {
    if (existing.request_sha256 === requestHash) {
      return json({ plan: await serializePlan(database, existing) }, { requestId });
    }
    throw new ApiError(422, "value_already_exist", "Plan code already exists");
  }

  const identity = await nextPlanIdentity(database, auth.organizationId, code);
  const planId = identity.id;
  const charges = await normalizeCharges(
    input.charges,
    database,
    auth.organizationId,
    planId,
    code,
  );
  const fixedCharges = await normalizeFixedCharges(
    input.fixed_charges,
    database,
    auth.organizationId,
    planId,
    currency,
  );
  const usageThresholds = await prepareUsageThresholds(
    "plan",
    auth.organizationId,
    planId,
    identity.version,
    usageThresholdInputs,
  );
  const now = new Date().toISOString();
  const event = planEvent(
    "plan.created",
    planId,
    identity.version,
    auth.organizationId,
    requestId,
    now,
    {
      code,
    },
  );
  try {
    await database.batch([
      database
        .prepare(
          `INSERT INTO plans
         (id, organization_id, code, name, interval, amount_minor, currency, version,
          active, created_at, updated_at, invoice_display_name, description, trial_period,
          pay_in_advance, bill_charges_monthly, bill_fixed_charges_monthly, metadata_json,
          request_sha256, pending_deletion)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`,
        )
        .bind(
          planId,
          auth.organizationId,
          code,
          name,
          interval,
          amountMinor,
          currency,
          identity.version,
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
            charge_model, properties_json, filters_json, invoiceable, pay_in_advance, prorated,
            min_amount_minor, accepts_target_wallet, version, active, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 1, ?, ?)`,
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
            stableJson(charge.filters),
            charge.invoiceable,
            charge.payInAdvance,
            charge.prorated,
            charge.minAmountMinor,
            charge.acceptsTargetWallet,
            now,
            now,
          ),
      ),
      ...fixedCharges.map((charge) =>
        database
          .prepare(
            `INSERT INTO fixed_charges
           (id, organization_id, plan_id, add_on_id, code, invoice_display_name,
            charge_model, properties_json, units, pay_in_advance, prorated, version, active,
            created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 1, ?, ?)`,
          )
          .bind(
            charge.id,
            auth.organizationId,
            planId,
            charge.addOnId,
            charge.code,
            charge.invoiceDisplayName,
            charge.chargeModel,
            stableJson(charge.properties),
            charge.units,
            charge.payInAdvance,
            charge.prorated,
            now,
            now,
          ),
      ),
      ...usageThresholdInsertStatements(
        database,
        auth.organizationId,
        { planId },
        usageThresholds,
        now,
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
      ...replaceTaxTargetStatements(database, auth.organizationId, "plan", planId, planTaxes, now),
      ...charges.flatMap((charge) =>
        replaceTaxTargetStatements(
          database,
          auth.organizationId,
          "charge",
          charge.id,
          charge.taxes,
          now,
        ),
      ),
      ...fixedCharges.flatMap((charge) =>
        replaceTaxTargetStatements(
          database,
          auth.organizationId,
          "fixed_charge",
          charge.id,
          charge.taxes,
          now,
        ),
      ),
      ...(minimumCommitment
        ? replaceTaxTargetStatements(
            database,
            auth.organizationId,
            "commitment",
            minimumCommitment.id,
            minimumCommitment.taxes,
            now,
          )
        : []),
      outboxStatement(database, auth.organizationId, event),
    ]);
  } catch (error) {
    const concurrent = await findPlan(database, auth.organizationId, code);
    if (concurrent?.request_sha256 === requestHash)
      return json({ plan: await serializePlan(database, concurrent) }, { requestId });
    if (concurrent) throw new ApiError(422, "value_already_exist", "Plan code already exists");
    throw error;
  }
  await env.DOMAIN_EVENTS.send(event);
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
    .prepare(
      "SELECT COUNT(*) AS total FROM plans WHERE organization_id = ? AND active = 1 AND parent_id IS NULL",
    )
    .bind(auth.organizationId)
    .first<{ total: number }>();
  const result = await database
    .prepare(`${planSelect()} WHERE organization_id = ? AND active = 1 AND parent_id IS NULL
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

async function listFixedCharges(
  planCode: string,
  url: URL,
  database: D1Database,
  auth: AuthContext,
  requestId: string,
): Promise<Response> {
  const plan = await findPlan(database, auth.organizationId, planCode);
  if (!plan) throw new ApiError(404, "plan_not_found", "Plan was not found");
  const page = positiveInteger(url.searchParams.get("page"), 1);
  const perPage = Math.min(positiveInteger(url.searchParams.get("per_page"), 20), 100);
  const offset = (page - 1) * perPage;
  const count = await database
    .prepare("SELECT COUNT(*) AS total FROM fixed_charges WHERE plan_id = ? AND active = 1")
    .bind(plan.id)
    .first<{ total: number }>();
  const result = await database
    .prepare(`${fixedChargeSelect()} WHERE fc.plan_id = ? AND fc.active = 1
              ORDER BY fc.created_at DESC, fc.id DESC LIMIT ? OFFSET ?`)
    .bind(plan.id, perPage, offset)
    .all<FixedChargeRow>();
  return json(
    {
      fixed_charges: await Promise.all(
        result.results.map(async (charge) =>
          serializeFixedCharge(
            charge,
            await taxesForTarget(database, auth.organizationId, "fixed_charge", charge.id),
          ),
        ),
      ),
      meta: pagination(count?.total ?? 0, page, perPage),
    },
    { requestId },
  );
}

async function createFixedCharge(
  request: Request,
  planCode: string,
  env: PlanCatalogEnv,
  auth: AuthContext,
  requestId: string,
): Promise<Response> {
  const database = env.BILLING_DB;
  const plan = await findPlan(database, auth.organizationId, planCode);
  if (!plan) throw new ApiError(404, "plan_not_found", "Plan was not found");
  assertPlanMutationAvailable(plan);
  const input = objectAt(await parseJsonObject(request), "fixed_charge");
  const cascade = cascadeRequested(input);
  const normalized = (
    await normalizeFixedCharges([input], database, auth.organizationId, plan.id, plan.currency)
  )[0];
  if (!normalized) throw new ApiError(422, "validation_error", "Fixed charge is invalid");
  const existing = await findFixedCharge(database, plan.id, normalized.code);
  if (existing) {
    if (sameFixedCharge(existing, normalized))
      return json(
        {
          fixed_charge: serializeFixedCharge(
            existing,
            await taxesForTarget(database, auth.organizationId, "fixed_charge", existing.id),
          ),
        },
        { requestId },
      );
    throw new ApiError(422, "value_already_exist", "Fixed-charge code already exists");
  }
  const historical = await database
    .prepare("SELECT id FROM fixed_charges WHERE plan_id = ? AND code = ? LIMIT 1")
    .bind(plan.id, normalized.code)
    .first();
  if (historical)
    throw new ApiError(
      422,
      "fixed_charge_code_unavailable",
      "A deleted fixed-charge code cannot be reused yet",
    );
  const now = new Date().toISOString();
  const cascadeCreates = cascade
    ? await prepareFixedChargeCreateCascade(database, plan.id, normalized)
    : [];
  const cascadeJson = stableJson(cascadeCreates);
  const cascadeGuardJson = stableJson(
    cascadeCreates.map(({ planId, planVersion }) => ({ id: planId, version: planVersion })),
  );
  const cascadeEnabled = cascade ? 1 : 0;
  const cascadeCount = cascadeCreates.length;
  const unitEvents = await prepareFixedChargeUnitEvents(
    database,
    auth.organizationId,
    [
      {
        fixedChargeId: normalized.id,
        fixedChargeVersion: 1,
        planId: plan.id,
        previousUnits: null,
        units: normalized.units,
      },
      ...cascadeCreates.map((child) => ({
        fixedChargeId: child.id,
        fixedChargeVersion: 1,
        planId: child.planId,
        previousUnits: null,
        units: child.units,
      })),
    ],
    normalized.applyUnitsImmediately,
    now,
  );
  const unitEventGuardEnabled = unitEvents.changes.length > 0 ? 1 : 0;
  const unitEventGuardJson = stableJson(unitEvents.guards);
  const unitEventChangesJson = stableJson(unitEvents.changes);
  const event = fixedChargeEvent(
    "fixed_charge.created",
    normalized.id,
    1,
    auth.organizationId,
    requestId,
    now,
    { code: normalized.code, planCode },
  );
  const childEvents = cascadeCreates.map((child) =>
    fixedChargeEvent("fixed_charge.created", child.id, 1, auth.organizationId, requestId, now, {
      code: child.code,
      planCode,
      cascadedFromFixedChargeId: normalized.id,
    }),
  );
  try {
    const results = await database.batch([
      database
        .prepare(
          `INSERT INTO fixed_charges
           (id, organization_id, plan_id, add_on_id, code, invoice_display_name,
            charge_model, properties_json, units, pay_in_advance, prorated, version, active,
            created_at, updated_at)
           SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 1, ?, ?
           WHERE (
             ? = 0 OR (
               ? = (
                 SELECT COUNT(*) FROM json_each(?) expected
                 JOIN plans child ON child.id = json_extract(expected.value, '$.id')
                 WHERE child.organization_id = ? AND child.active = 1
                   AND child.parent_id = ?
                   AND child.version = json_extract(expected.value, '$.version')
               )
               AND ? = (
                 SELECT COUNT(*) FROM plans child
                 WHERE child.organization_id = ? AND child.active = 1 AND child.parent_id = ?
                   AND EXISTS (
                     SELECT 1 FROM subscriptions subscription
                     WHERE subscription.plan_id = child.id
                       AND subscription.status IN ('active', 'pending')
                   )
               )
             )
           )
           AND (
             ? = 0 OR (
               ? = (
                 SELECT COUNT(*) FROM json_each(?) expected
                 JOIN subscriptions subscription
                   ON subscription.id = json_extract(expected.value, '$.subscriptionId')
                 WHERE subscription.organization_id = ?
                   AND subscription.status IN ('active', 'past_due')
                   AND subscription.plan_id = json_extract(expected.value, '$.planId')
                   AND subscription.version = json_extract(expected.value, '$.version')
                   AND subscription.current_period_start
                         IS json_extract(expected.value, '$.currentPeriodStart')
                   AND subscription.current_period_end
                         IS json_extract(expected.value, '$.currentPeriodEnd')
               )
               AND ? = (
                 SELECT COUNT(*) FROM json_each(?) change
                 JOIN subscriptions subscription
                   ON subscription.plan_id = json_extract(change.value, '$.planId')
                 WHERE subscription.organization_id = ?
                   AND subscription.status IN ('active', 'past_due')
               )
             )
           )`,
        )
        .bind(
          normalized.id,
          auth.organizationId,
          plan.id,
          normalized.addOnId,
          normalized.code,
          normalized.invoiceDisplayName,
          normalized.chargeModel,
          stableJson(normalized.properties),
          normalized.units,
          normalized.payInAdvance,
          normalized.prorated,
          now,
          now,
          cascadeEnabled,
          cascadeCount,
          cascadeGuardJson,
          auth.organizationId,
          plan.id,
          cascadeCount,
          auth.organizationId,
          plan.id,
          unitEventGuardEnabled,
          unitEvents.requiredChangeCount,
          unitEventGuardJson,
          auth.organizationId,
          unitEvents.requiredChangeCount,
          unitEventChangesJson,
          auth.organizationId,
        ),
      database
        .prepare(
          `INSERT INTO fixed_charges
           (id, organization_id, parent_id, plan_id, add_on_id, code, invoice_display_name,
            charge_model, properties_json, units, pay_in_advance, prorated, version, active,
            created_at, updated_at)
           SELECT json_extract(row.value, '$.id'), ?, ?, json_extract(row.value, '$.planId'),
                  json_extract(row.value, '$.addOnId'), json_extract(row.value, '$.code'),
                  json_extract(row.value, '$.invoiceDisplayName'),
                  json_extract(row.value, '$.chargeModel'),
                  json_extract(row.value, '$.propertiesJson'),
                  json_extract(row.value, '$.units'), json_extract(row.value, '$.payInAdvance'),
                  json_extract(row.value, '$.prorated'), 1, 1, ?, ?
           FROM json_each(?) row
           WHERE EXISTS (
             SELECT 1 FROM fixed_charges parent
             WHERE parent.id = ? AND parent.organization_id = ? AND parent.active = 1
               AND parent.version = 1 AND parent.updated_at = ?
           )`,
        )
        .bind(
          auth.organizationId,
          normalized.id,
          now,
          now,
          cascadeJson,
          normalized.id,
          auth.organizationId,
          now,
        ),
      fixedChargeUnitEventInsertStatement(database, auth.organizationId, unitEvents.events, now),
      conditionalFixedChargeOutboxStatement(
        database,
        auth.organizationId,
        event,
        normalized.id,
        1,
        now,
        1,
      ),
      bulkFixedChargeCascadeOutboxStatement(
        database,
        auth.organizationId,
        childEvents,
        cascadeCreates,
        now,
        1,
      ),
      ...replaceTaxTargetStatements(
        database,
        auth.organizationId,
        "fixed_charge",
        normalized.id,
        normalized.taxes,
        now,
      ),
    ]);
    if (
      (results[0]?.meta.changes ?? 0) < 1 ||
      (results[1]?.meta.changes ?? 0) < cascadeCount ||
      results[2]?.meta.changes !== unitEvents.requiredChangeCount ||
      results[3]?.meta.changes !== 1 ||
      (results[4]?.meta.changes ?? 0) !== cascadeCount
    ) {
      throw new ApiError(
        409,
        "fixed_charge_version_conflict",
        "Fixed-charge graph changed concurrently",
      );
    }
  } catch (error) {
    if (error instanceof ApiError) throw error;
    const concurrent = await findFixedCharge(database, plan.id, normalized.code);
    if (concurrent && sameFixedCharge(concurrent, normalized))
      return json(
        {
          fixed_charge: serializeFixedCharge(
            concurrent,
            await taxesForTarget(database, auth.organizationId, "fixed_charge", concurrent.id),
          ),
        },
        { requestId },
      );
    if (concurrent)
      throw new ApiError(422, "value_already_exist", "Fixed-charge code already exists");
    throw error;
  }
  await env.DOMAIN_EVENTS.send(event);
  for (const childEvent of childEvents) await env.DOMAIN_EVENTS.send(childEvent);
  if (normalized.payInAdvance === 1 && normalized.applyUnitsImmediately) {
    await billImmediateAdvanceFixedChargeEvents(env, unitEvents.events, now, requestId);
  }
  const created = await findFixedCharge(database, plan.id, normalized.code);
  if (!created) throw new ApiError(500, "persistence_error", "Fixed charge was not persisted");
  return json({ fixed_charge: serializeFixedCharge(created, normalized.taxes) }, { requestId });
}

async function updateFixedCharge(
  request: Request,
  planCode: string,
  fixedChargeCode: string,
  env: PlanCatalogEnv,
  auth: AuthContext,
  requestId: string,
): Promise<Response> {
  const database = env.BILLING_DB;
  const plan = await findPlan(database, auth.organizationId, planCode);
  if (!plan) throw new ApiError(404, "plan_not_found", "Plan was not found");
  assertPlanMutationAvailable(plan);
  const fixedCharge = await findFixedCharge(database, plan.id, fixedChargeCode);
  if (!fixedCharge) throw new ApiError(404, "fixed_charge_not_found", "Fixed charge was not found");
  const input = objectAt(await parseJsonObject(request), "fixed_charge");
  rejectUnsupportedFixedChargeMutation(input, fixedCharge);
  const taxCodes = normalizeTaxCodes(input.tax_codes);
  const currentTaxes = await taxesForTarget(
    database,
    auth.organizationId,
    "fixed_charge",
    fixedCharge.id,
  );
  const cascade = cascadeRequested(input);
  const attached = await database
    .prepare("SELECT id FROM subscriptions WHERE plan_id = ? LIMIT 1")
    .bind(plan.id)
    .first();
  const nextCode =
    attached || input.code === undefined ? fixedCharge.code : requiredString(input, "code");
  const nextModel =
    attached || input.charge_model === undefined
      ? supportedFixedChargeModel(fixedCharge.charge_model)
      : supportedFixedChargeModel(input.charge_model);
  const nextProperties =
    input.properties === undefined
      ? parseObject(fixedCharge.properties_json)
      : optionalObject(input.properties, "properties");
  const next = {
    id: fixedCharge.id,
    addOnId: fixedCharge.add_on_id,
    code: nextCode,
    invoiceDisplayName:
      input.invoice_display_name === undefined
        ? fixedCharge.invoice_display_name
        : optionalString(input, "invoice_display_name"),
    chargeModel: nextModel,
    properties: nextProperties,
    units:
      input.units === undefined
        ? fixedCharge.units
        : nonNegativeDecimal(input.units, "fixed_charge.units"),
    payInAdvance: fixedCharge.pay_in_advance === 1 ? 1 : 0,
    prorated: fixedCharge.prorated === 1 ? 1 : 0,
    applyUnitsImmediately: input.apply_units_immediately === true,
    taxes:
      taxCodes === undefined
        ? currentTaxes
        : await resolveActiveTaxes(database, auth.organizationId, taxCodes),
  } satisfies NormalizedFixedCharge;
  validateFixedChargeRating(next.units, next.chargeModel, next.properties, "fixed_charge");
  if (next.code !== fixedCharge.code) {
    const duplicate = await findFixedCharge(database, plan.id, next.code);
    if (duplicate)
      throw new ApiError(422, "value_already_exist", "Fixed-charge code already exists");
  }
  if (sameFixedCharge(fixedCharge, next) && sameTaxSets(currentTaxes, next.taxes) && !cascade)
    return json({ fixed_charge: serializeFixedCharge(fixedCharge, currentTaxes) }, { requestId });
  const now = new Date().toISOString();
  const fixedChargeCascade = cascade
    ? await prepareFixedChargeUpdateCascade(database, fixedCharge, next)
    : emptyFixedChargeCascade();
  const cascadeJson = stableJson(fixedChargeCascade.updates);
  const cascadeGuardJson = stableJson(fixedChargeCascade.guards);
  const cascadeEnabled = fixedChargeCascade.enabled ? 1 : 0;
  const cascadeCount = fixedChargeCascade.updates.length;
  const cascadeGuardCount = fixedChargeCascade.guards.length;
  const unitEvents = await prepareFixedChargeUnitEvents(
    database,
    auth.organizationId,
    [
      {
        fixedChargeId: fixedCharge.id,
        fixedChargeVersion: fixedCharge.version + 1,
        planId: fixedCharge.plan_id,
        previousUnits: fixedCharge.units,
        units: next.units,
      },
      ...fixedChargeCascade.updates.map((child) => ({
        fixedChargeId: child.id,
        fixedChargeVersion: child.version + 1,
        planId: child.planId,
        previousUnits: child.previousUnits,
        units: child.units,
      })),
    ],
    next.applyUnitsImmediately,
    now,
  );
  const unitEventGuardEnabled = unitEvents.changes.length > 0 ? 1 : 0;
  const unitEventGuardJson = stableJson(unitEvents.guards);
  const unitEventChangesJson = stableJson(unitEvents.changes);
  const event = fixedChargeEvent(
    "fixed_charge.updated",
    fixedCharge.id,
    fixedCharge.version + 1,
    auth.organizationId,
    requestId,
    now,
    { code: next.code, planCode },
  );
  const childEvents = fixedChargeCascade.updates.map((child) =>
    fixedChargeEvent(
      "fixed_charge.updated",
      child.id,
      child.version + 1,
      auth.organizationId,
      requestId,
      now,
      { code: child.code, planCode, cascadedFromFixedChargeId: fixedCharge.id },
    ),
  );
  try {
    const results = await database.batch([
      database
        .prepare(
          `UPDATE fixed_charges SET code = ?, invoice_display_name = ?, charge_model = ?,
           properties_json = ?, units = ?, version = version + 1, updated_at = ?
           WHERE id = ? AND organization_id = ? AND plan_id = ? AND active = 1 AND version = ?
             AND (
               ? = 0 OR (
                 ? = (
                   SELECT COUNT(*) FROM json_each(?) expected
                   JOIN fixed_charges child ON child.id = json_extract(expected.value, '$.id')
                   WHERE child.organization_id = ? AND child.active = 1
                     AND child.parent_id = ?
                     AND child.version = json_extract(expected.value, '$.version')
                 )
                 AND ? = (
                   SELECT COUNT(*) FROM fixed_charges child
                   WHERE child.organization_id = ? AND child.active = 1 AND child.parent_id = ?
                     AND EXISTS (
                       SELECT 1 FROM subscriptions subscription
                       WHERE subscription.plan_id = child.plan_id
                         AND subscription.status IN ('active', 'pending')
                     )
                 )
               )
             )
             AND (
               ? = 0 OR (
                 ? = (
                   SELECT COUNT(*) FROM json_each(?) expected
                   JOIN subscriptions subscription
                     ON subscription.id = json_extract(expected.value, '$.subscriptionId')
                   WHERE subscription.organization_id = ?
                     AND subscription.status IN ('active', 'past_due')
                     AND subscription.plan_id = json_extract(expected.value, '$.planId')
                     AND subscription.version = json_extract(expected.value, '$.version')
                     AND subscription.current_period_start
                           IS json_extract(expected.value, '$.currentPeriodStart')
                     AND subscription.current_period_end
                           IS json_extract(expected.value, '$.currentPeriodEnd')
                 )
                 AND ? = (
                   SELECT COUNT(*) FROM json_each(?) change
                   JOIN subscriptions subscription
                     ON subscription.plan_id = json_extract(change.value, '$.planId')
                   WHERE subscription.organization_id = ?
                     AND subscription.status IN ('active', 'past_due')
                 )
               )
             )`,
        )
        .bind(
          next.code,
          next.invoiceDisplayName,
          next.chargeModel,
          stableJson(next.properties),
          next.units,
          now,
          fixedCharge.id,
          auth.organizationId,
          plan.id,
          fixedCharge.version,
          cascadeEnabled,
          cascadeGuardCount,
          cascadeGuardJson,
          auth.organizationId,
          fixedCharge.id,
          cascadeGuardCount,
          auth.organizationId,
          fixedCharge.id,
          unitEventGuardEnabled,
          unitEvents.requiredChangeCount,
          unitEventGuardJson,
          auth.organizationId,
          unitEvents.requiredChangeCount,
          unitEventChangesJson,
          auth.organizationId,
        ),
      database
        .prepare(
          `UPDATE fixed_charges AS child
           SET code = (
                 SELECT json_extract(update_row.value, '$.code') FROM json_each(?) update_row
                 WHERE json_extract(update_row.value, '$.id') = child.id
               ),
               properties_json = (
                 SELECT json_extract(update_row.value, '$.propertiesJson')
                 FROM json_each(?) update_row
                 WHERE json_extract(update_row.value, '$.id') = child.id
               ),
               units = (
                 SELECT json_extract(update_row.value, '$.units') FROM json_each(?) update_row
                 WHERE json_extract(update_row.value, '$.id') = child.id
               ),
               version = version + 1,
               updated_at = ?
           WHERE child.id IN (SELECT json_extract(value, '$.id') FROM json_each(?))
             AND child.organization_id = ? AND child.active = 1 AND child.parent_id = ?
             AND child.version = (
               SELECT json_extract(update_row.value, '$.version') FROM json_each(?) update_row
               WHERE json_extract(update_row.value, '$.id') = child.id
             )
             AND EXISTS (
               SELECT 1 FROM fixed_charges parent
               WHERE parent.id = ? AND parent.organization_id = ? AND parent.active = 1
                 AND parent.version = ? AND parent.updated_at = ?
             )`,
        )
        .bind(
          cascadeJson,
          cascadeJson,
          cascadeJson,
          now,
          cascadeJson,
          auth.organizationId,
          fixedCharge.id,
          cascadeJson,
          fixedCharge.id,
          auth.organizationId,
          fixedCharge.version + 1,
          now,
        ),
      fixedChargeUnitEventInsertStatement(database, auth.organizationId, unitEvents.events, now),
      conditionalFixedChargeOutboxStatement(
        database,
        auth.organizationId,
        event,
        fixedCharge.id,
        fixedCharge.version + 1,
        now,
        1,
      ),
      bulkFixedChargeCascadeOutboxStatement(
        database,
        auth.organizationId,
        childEvents,
        fixedChargeCascade.updates,
        now,
        1,
      ),
      ...(taxCodes === undefined
        ? []
        : guardedReplaceTaxTargetStatements(
            database,
            auth.organizationId,
            "fixed_charge",
            fixedCharge.id,
            next.taxes,
            now,
            fixedCharge.version + 1,
          )),
    ]);
    if (
      (results[0]?.meta.changes ?? 0) < 1 ||
      (results[1]?.meta.changes ?? 0) < cascadeCount ||
      (results[2]?.meta.changes ?? 0) < unitEvents.requiredChangeCount ||
      results[3]?.meta.changes !== 1 ||
      (results[4]?.meta.changes ?? 0) !== cascadeCount
    )
      throw new ApiError(409, "fixed_charge_version_conflict", "Fixed charge changed concurrently");
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError(422, "value_already_exist", "Fixed-charge code already exists");
  }
  await env.DOMAIN_EVENTS.send(event);
  for (const childEvent of childEvents) await env.DOMAIN_EVENTS.send(childEvent);
  if (fixedCharge.pay_in_advance === 1 && next.applyUnitsImmediately) {
    await billImmediateAdvanceFixedChargeEvents(env, unitEvents.events, now, requestId);
  }
  const updated = await findFixedCharge(database, plan.id, next.code);
  if (!updated) throw new ApiError(500, "persistence_error", "Fixed charge disappeared");
  return json({ fixed_charge: serializeFixedCharge(updated, next.taxes) }, { requestId });
}

async function deleteFixedCharge(
  request: Request,
  planCode: string,
  fixedChargeCode: string,
  env: PlanCatalogEnv,
  auth: AuthContext,
  requestId: string,
): Promise<Response> {
  const database = env.BILLING_DB;
  const plan = await findPlan(database, auth.organizationId, planCode);
  if (!plan) throw new ApiError(404, "plan_not_found", "Plan was not found");
  assertPlanMutationAvailable(plan);
  const fixedCharge = await findFixedCharge(database, plan.id, fixedChargeCode);
  if (!fixedCharge) throw new ApiError(404, "fixed_charge_not_found", "Fixed charge was not found");
  let cascade = false;
  if (request.body !== null) {
    const input = objectAt(await parseJsonObject(request), "fixed_charge");
    rejectUnsupportedFixedChargeMutation(input, fixedCharge);
    cascade = cascadeRequested(input);
  }
  const now = new Date().toISOString();
  const cascadeDeletes = cascade
    ? await prepareFixedChargeDeleteCascade(database, fixedCharge.id)
    : [];
  const cascadeJson = stableJson(cascadeDeletes);
  const cascadeEnabled = cascade ? 1 : 0;
  const cascadeCount = cascadeDeletes.length;
  const event = fixedChargeEvent(
    "fixed_charge.deleted",
    fixedCharge.id,
    fixedCharge.version + 1,
    auth.organizationId,
    requestId,
    now,
    { code: fixedCharge.code, planCode },
  );
  const childEvents = cascadeDeletes.map((child) =>
    fixedChargeEvent(
      "fixed_charge.deleted",
      child.id,
      child.version + 1,
      auth.organizationId,
      requestId,
      now,
      { code: child.code, planCode, cascadedFromFixedChargeId: fixedCharge.id },
    ),
  );
  const results = await database.batch([
    database
      .prepare(
        `UPDATE fixed_charges SET active = 0, version = version + 1, updated_at = ?
         WHERE id = ? AND organization_id = ? AND plan_id = ? AND active = 1 AND version = ?
           AND (
             ? = 0 OR (
               ? = (
                 SELECT COUNT(*) FROM json_each(?) expected
                 JOIN fixed_charges child ON child.id = json_extract(expected.value, '$.id')
                 WHERE child.organization_id = ? AND child.active = 1
                   AND child.parent_id = ?
                   AND child.version = json_extract(expected.value, '$.version')
               )
               AND ? = (
                 SELECT COUNT(*) FROM fixed_charges child
                 WHERE child.organization_id = ? AND child.active = 1 AND child.parent_id = ?
                   AND EXISTS (
                     SELECT 1 FROM subscriptions subscription
                     WHERE subscription.plan_id = child.plan_id
                       AND subscription.status IN ('active', 'pending')
                   )
               )
             )
           )`,
      )
      .bind(
        now,
        fixedCharge.id,
        auth.organizationId,
        plan.id,
        fixedCharge.version,
        cascadeEnabled,
        cascadeCount,
        cascadeJson,
        auth.organizationId,
        fixedCharge.id,
        cascadeCount,
        auth.organizationId,
        fixedCharge.id,
      ),
    database
      .prepare(
        `UPDATE fixed_charges AS child SET active = 0, version = version + 1, updated_at = ?
         WHERE child.id IN (SELECT json_extract(value, '$.id') FROM json_each(?))
           AND child.organization_id = ? AND child.active = 1 AND child.parent_id = ?
           AND child.version = (
             SELECT json_extract(delete_row.value, '$.version') FROM json_each(?) delete_row
             WHERE json_extract(delete_row.value, '$.id') = child.id
           )
           AND EXISTS (
             SELECT 1 FROM fixed_charges parent
             WHERE parent.id = ? AND parent.organization_id = ? AND parent.active = 0
               AND parent.version = ? AND parent.updated_at = ?
           )`,
      )
      .bind(
        now,
        cascadeJson,
        auth.organizationId,
        fixedCharge.id,
        cascadeJson,
        fixedCharge.id,
        auth.organizationId,
        fixedCharge.version + 1,
        now,
      ),
    conditionalFixedChargeOutboxStatement(
      database,
      auth.organizationId,
      event,
      fixedCharge.id,
      fixedCharge.version + 1,
      now,
      0,
    ),
    bulkFixedChargeCascadeOutboxStatement(
      database,
      auth.organizationId,
      childEvents,
      cascadeDeletes,
      now,
      0,
    ),
  ]);
  if (
    (results[0]?.meta.changes ?? 0) < 1 ||
    (results[1]?.meta.changes ?? 0) < cascadeCount ||
    results[2]?.meta.changes !== 1 ||
    (results[3]?.meta.changes ?? 0) !== cascadeCount
  )
    throw new ApiError(409, "fixed_charge_version_conflict", "Fixed charge changed concurrently");
  await env.DOMAIN_EVENTS.send(event);
  for (const childEvent of childEvents) await env.DOMAIN_EVENTS.send(childEvent);
  return json(
    {
      fixed_charge: serializeFixedCharge(
        fixedCharge,
        await taxesForTarget(database, auth.organizationId, "fixed_charge", fixedCharge.id),
      ),
    },
    { requestId },
  );
}

async function showFixedCharge(
  planCode: string,
  fixedChargeCode: string,
  database: D1Database,
  auth: AuthContext,
  requestId: string,
): Promise<Response> {
  const plan = await findPlan(database, auth.organizationId, planCode);
  if (!plan) throw new ApiError(404, "plan_not_found", "Plan was not found");
  const charge = await database
    .prepare(
      `${fixedChargeSelect()} WHERE fc.plan_id = ? AND fc.code = ? AND fc.active = 1 LIMIT 1`,
    )
    .bind(plan.id, fixedChargeCode)
    .first<FixedChargeRow>();
  if (!charge) throw new ApiError(404, "fixed_charge_not_found", "Fixed charge was not found");
  return json(
    {
      fixed_charge: serializeFixedCharge(
        charge,
        await taxesForTarget(database, auth.organizationId, "fixed_charge", charge.id),
      ),
    },
    { requestId },
  );
}

function fixedChargeSelect(): string {
  return `SELECT fc.id, fc.plan_id, fc.parent_id, fc.add_on_id, ao.code AS add_on_code, fc.code,
                 fc.invoice_display_name, fc.charge_model, fc.properties_json, fc.units,
                 fc.pay_in_advance, fc.prorated, fc.version, fc.active,
                 fc.created_at, fc.updated_at
          FROM fixed_charges fc JOIN add_ons ao ON ao.id = fc.add_on_id`;
}

function findFixedCharge(database: D1Database, planId: string, code: string) {
  return database
    .prepare(
      `${fixedChargeSelect()} WHERE fc.plan_id = ? AND fc.code = ? AND fc.active = 1 LIMIT 1`,
    )
    .bind(planId, code)
    .first<FixedChargeRow>();
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

async function updatePlan(
  code: string,
  request: Request,
  env: PlanCatalogEnv,
  auth: AuthContext,
  requestId: string,
): Promise<Response> {
  const plan = await findPlan(env.BILLING_DB, auth.organizationId, code);
  if (!plan) throw new ApiError(404, "plan_not_found", "Plan was not found");
  assertPlanMutationAvailable(plan);
  const input = objectAt(await parseJsonObject(request), "plan");
  rejectUpdateGraph(input);
  const taxCodes = normalizeTaxCodes(input.tax_codes);
  const nextTaxes =
    taxCodes === undefined
      ? await taxesForTarget(env.BILLING_DB, auth.organizationId, "plan", plan.id)
      : await resolveActiveTaxes(env.BILLING_DB, auth.organizationId, taxCodes);
  const usageThresholdInputs =
    input.usage_thresholds === undefined
      ? null
      : normalizeUsageThresholdInputs(input.usage_thresholds);
  const cascade = cascadeRequested(input);
  if (input.bill_charges_monthly === true || input.bill_fixed_charges_monthly === true)
    throw new ApiError(422, "unsupported_plan_feature", "Monthly split billing is not implemented");
  const attached = await env.BILLING_DB.prepare(
    "SELECT id FROM subscriptions WHERE plan_id = ? LIMIT 1",
  )
    .bind(plan.id)
    .first();
  const nextCode = input.code === undefined ? plan.code : requiredString(input, "code");
  const nextInterval =
    input.interval === undefined ? plan.interval : requiredString(input, "interval");
  if (!INTERVALS.has(nextInterval))
    throw new ApiError(422, "validation_error", `Unsupported interval: ${nextInterval}`);
  if (nextInterval === "one_time")
    throw new ApiError(
      422,
      "unsupported_plan_feature",
      "One-time plan lifecycle is not implemented",
    );
  const nextCurrency =
    input.amount_currency === undefined
      ? plan.currency
      : requiredString(input, "amount_currency").toUpperCase();
  if (!/^[A-Z]{3}$/.test(nextCurrency))
    throw new ApiError(422, "validation_error", "amount_currency must be an ISO currency code");
  if (nextCode !== plan.code) {
    const duplicate = await findPlan(env.BILLING_DB, auth.organizationId, nextCode);
    if (duplicate) throw new ApiError(422, "value_already_exist", "Plan code already exists");
  }
  if (
    attached &&
    (nextCode !== plan.code ||
      nextInterval !== plan.interval ||
      nextCurrency !== plan.currency ||
      input.trial_period !== undefined ||
      input.pay_in_advance !== undefined ||
      input.bill_charges_monthly !== undefined ||
      input.bill_fixed_charges_monthly !== undefined)
  )
    throw new ApiError(
      422,
      "plan_in_use",
      "Only name, invoice display name, description, amount, and metadata can change on an in-use plan",
    );
  const next = {
    code: nextCode,
    name: input.name === undefined ? plan.name : requiredString(input, "name"),
    invoiceDisplayName:
      input.invoice_display_name === undefined
        ? plan.invoice_display_name
        : optionalString(input, "invoice_display_name"),
    description:
      input.description === undefined ? plan.description : optionalString(input, "description"),
    interval: nextInterval,
    amountMinor:
      input.amount_cents === undefined
        ? plan.amount_minor
        : nonNegativeInteger(input.amount_cents, "amount_cents"),
    currency: nextCurrency,
    trialPeriod:
      input.trial_period === undefined
        ? plan.trial_period
        : optionalNonNegativeNumber(input.trial_period, "trial_period"),
    payInAdvance:
      input.pay_in_advance === undefined
        ? plan.pay_in_advance
        : booleanInteger(input.pay_in_advance, false),
    billChargesMonthly:
      input.bill_charges_monthly === undefined
        ? plan.bill_charges_monthly
        : optionalBooleanInteger(input.bill_charges_monthly),
    billFixedChargesMonthly:
      input.bill_fixed_charges_monthly === undefined
        ? plan.bill_fixed_charges_monthly
        : optionalBooleanInteger(input.bill_fixed_charges_monthly),
    metadata:
      input.metadata === undefined
        ? parseObject(plan.metadata_json)
        : optionalObject(input.metadata, "metadata"),
  };
  const now = new Date().toISOString();
  const replacementUsageThresholds =
    usageThresholdInputs === null
      ? null
      : await prepareUsageThresholds(
          "plan",
          auth.organizationId,
          plan.id,
          plan.version + 1,
          usageThresholdInputs,
        );
  const cascadeChildren =
    cascade && next.amountMinor !== plan.amount_minor
      ? await preparePlanAmountCascade(env.BILLING_DB, plan.id, plan.amount_minor)
      : [];
  const cascadeJson = stableJson(cascadeChildren);
  const cascadeEnabled = cascade && next.amountMinor !== plan.amount_minor ? 1 : 0;
  const cascadeCount = cascadeChildren.length;
  const event = planEvent(
    "plan.updated",
    plan.id,
    plan.version + 1,
    auth.organizationId,
    requestId,
    now,
    { code: next.code },
  );
  const childEvents = cascadeChildren.map((child) =>
    planEvent("plan.updated", child.id, child.version + 1, auth.organizationId, requestId, now, {
      code: child.code,
      cascadedFromPlanId: plan.id,
    }),
  );
  const usageThresholdStatements =
    replacementUsageThresholds === null
      ? []
      : [
          env.BILLING_DB.prepare(
            `UPDATE usage_thresholds
             SET deleted_at = ?, version = version + 1, updated_at = ?
             WHERE organization_id = ? AND plan_id = ? AND deleted_at IS NULL
               AND EXISTS (
                 SELECT 1 FROM plans
                 WHERE id = ? AND organization_id = ? AND active = 1
                   AND version = ? AND updated_at = ?
               )`,
          ).bind(
            now,
            now,
            auth.organizationId,
            plan.id,
            plan.id,
            auth.organizationId,
            plan.version + 1,
            now,
          ),
          ...replacementUsageThresholds.map((threshold) =>
            env.BILLING_DB.prepare(
              `INSERT INTO usage_thresholds
               (id, organization_id, plan_id, subscription_id, amount_minor, recurring,
                threshold_display_name, version, deleted_at, created_at, updated_at)
               SELECT ?, ?, ?, NULL, ?, ?, ?, 1, NULL, ?, ?
               WHERE EXISTS (
                 SELECT 1 FROM plans
                 WHERE id = ? AND organization_id = ? AND active = 1
                   AND version = ? AND updated_at = ?
               )`,
            ).bind(
              threshold.id,
              auth.organizationId,
              plan.id,
              threshold.amountMinor,
              threshold.recurring,
              threshold.displayName,
              now,
              now,
              plan.id,
              auth.organizationId,
              plan.version + 1,
              now,
            ),
          ),
        ];
  try {
    const results = await env.BILLING_DB.batch([
      planMutationGuardStatement(env.BILLING_DB, requestId, auth.organizationId, plan, 1, now),
      env.BILLING_DB.prepare(
        `UPDATE plans SET code = ?, name = ?, invoice_display_name = ?, description = ?,
         interval = ?, amount_minor = ?, currency = ?, trial_period = ?, pay_in_advance = ?,
         bill_charges_monthly = ?, bill_fixed_charges_monthly = ?, metadata_json = ?,
         version = version + 1, updated_at = ?
         WHERE id = ? AND organization_id = ? AND active = 1 AND version = ?
           AND EXISTS (SELECT 1 FROM plan_mutation_guards
                       WHERE request_id = ? AND plan_id = ?)
           AND (
             ? = 0 OR (
               ? = (
                 SELECT COUNT(*) FROM json_each(?) expected
                 JOIN plans child ON child.id = json_extract(expected.value, '$.id')
                 WHERE child.organization_id = ? AND child.active = 1
                   AND child.parent_id = ? AND child.amount_minor = ?
                   AND child.version = json_extract(expected.value, '$.version')
               )
               AND ? = (
                 SELECT COUNT(*) FROM plans child
                 WHERE child.organization_id = ? AND child.active = 1
                   AND child.parent_id = ? AND child.amount_minor = ?
               )
             )
           )`,
      ).bind(
        next.code,
        next.name,
        next.invoiceDisplayName,
        next.description,
        next.interval,
        next.amountMinor,
        next.currency,
        next.trialPeriod,
        next.payInAdvance,
        next.billChargesMonthly,
        next.billFixedChargesMonthly,
        stableJson(next.metadata),
        now,
        plan.id,
        auth.organizationId,
        plan.version,
        requestId,
        plan.id,
        cascadeEnabled,
        cascadeCount,
        cascadeJson,
        auth.organizationId,
        plan.id,
        plan.amount_minor,
        cascadeCount,
        auth.organizationId,
        plan.id,
        plan.amount_minor,
      ),
      env.BILLING_DB.prepare(
        `UPDATE plans AS child SET amount_minor = ?, version = version + 1, updated_at = ?
         WHERE child.id IN (SELECT json_extract(value, '$.id') FROM json_each(?))
           AND child.organization_id = ? AND child.active = 1
           AND child.parent_id = ? AND child.amount_minor = ?
           AND child.version = (
             SELECT json_extract(update_row.value, '$.version') FROM json_each(?) update_row
             WHERE json_extract(update_row.value, '$.id') = child.id
           )
           AND EXISTS (
             SELECT 1 FROM plans parent
             WHERE parent.id = ? AND parent.organization_id = ? AND parent.active = 1
               AND parent.version = ? AND parent.updated_at = ?
           )`,
      ).bind(
        next.amountMinor,
        now,
        cascadeJson,
        auth.organizationId,
        plan.id,
        plan.amount_minor,
        cascadeJson,
        plan.id,
        auth.organizationId,
        plan.version + 1,
        now,
      ),
      guardedPlanOutboxStatement(
        env.BILLING_DB,
        auth.organizationId,
        event,
        plan.id,
        plan.version + 1,
        now,
        1,
        requestId,
      ),
      bulkPlanCascadeOutboxStatement(
        env.BILLING_DB,
        auth.organizationId,
        childEvents,
        cascadeChildren,
        now,
      ),
      clearPlanMutationGuardStatement(env.BILLING_DB, requestId, plan.id),
      ...usageThresholdStatements,
      ...(taxCodes === undefined
        ? []
        : guardedReplaceTaxTargetStatements(
            env.BILLING_DB,
            auth.organizationId,
            "plan",
            plan.id,
            nextTaxes,
            now,
            plan.version + 1,
          )),
    ]);
    const insertedThresholdResults =
      replacementUsageThresholds === null
        ? []
        : results.slice(7, 7 + replacementUsageThresholds.length);
    if (
      results[0]?.meta.changes !== 1 ||
      (results[1]?.meta.changes ?? 0) < 1 ||
      (results[2]?.meta.changes ?? 0) < cascadeCount ||
      results[3]?.meta.changes !== 1 ||
      (results[4]?.meta.changes ?? 0) !== cascadeCount ||
      results[5]?.meta.changes !== 1 ||
      insertedThresholdResults.some((result) => result.meta.changes !== 1)
    )
      throw new ApiError(409, "plan_version_conflict", "Plan changed concurrently");
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError(422, "value_already_exist", "Plan code already exists");
  }
  await env.DOMAIN_EVENTS.send(event);
  for (const childEvent of childEvents) await env.DOMAIN_EVENTS.send(childEvent);
  const updated = await findPlan(env.BILLING_DB, auth.organizationId, next.code);
  if (!updated) throw new ApiError(500, "persistence_error", "Plan disappeared");
  return json({ plan: await serializePlan(env.BILLING_DB, updated) }, { requestId });
}

async function deletePlan(
  code: string,
  env: PlanCatalogEnv,
  auth: AuthContext,
  requestId: string,
): Promise<Response> {
  const database = env.BILLING_DB;
  const plan = await findPlan(database, auth.organizationId, code);
  if (!plan) throw new ApiError(404, "plan_not_found", "Plan was not found");
  const serialized = await serializePlan(database, plan);
  const existingTask = await findPlanDeletionTask(database, plan.id);
  if (plan.pending_deletion === 1 || existingTask) {
    if (!existingTask) {
      throw new ApiError(
        500,
        "plan_deletion_task_missing",
        "Plan deletion state is missing its durable task",
      );
    }
    try {
      await ensurePlanDeletionWorkflow(env, existingTask, true);
    } catch {
      // The durable task is also dispatched by the five-minute reconciliation workflow.
    }
    return json({ plan: { ...serialized, pending_deletion: true } }, { requestId });
  }

  const overriddenSubscription = await database
    .prepare(
      `SELECT s.id FROM subscriptions s JOIN plans child ON child.id = s.plan_id
       WHERE s.organization_id = ? AND child.parent_id = ?
         AND s.status IN ('pending', 'active', 'past_due') LIMIT 1`,
    )
    .bind(auth.organizationId, plan.id)
    .first();
  if (overriddenSubscription) {
    throw new ApiError(
      409,
      "plan_has_overridden_subscriptions",
      "Plan deletion must wait until its subscription overrides are retired",
    );
  }

  const subscription = await database
    .prepare("SELECT id FROM subscriptions WHERE organization_id = ? AND plan_id = ? LIMIT 1")
    .bind(auth.organizationId, plan.id)
    .first();
  if (subscription) {
    const now = new Date().toISOString();
    let task;
    try {
      task = await preparePlanDeletion(
        { BILLING_DB: database },
        {
          id: plan.id,
          organizationId: auth.organizationId,
          code: plan.code,
          version: plan.version,
          pendingDeletion: false,
        },
        requestId,
        now,
      );
    } catch (error) {
      if (error instanceof Error && error.message === "plan_version_conflict") {
        throw new ApiError(409, error.message, "Plan changed concurrently");
      }
      throw error;
    }
    try {
      await ensurePlanDeletionWorkflow(env, task);
    } catch {
      // The durable task is also dispatched by the five-minute reconciliation workflow.
    }
    return json({ plan: { ...serialized, pending_deletion: true } }, { requestId });
  }

  const now = new Date().toISOString();
  const event = planEvent(
    "plan.deleted",
    plan.id,
    plan.version + 1,
    auth.organizationId,
    requestId,
    now,
    { code: plan.code },
  );
  const guarded = `EXISTS (
    SELECT 1 FROM plan_mutation_guards WHERE request_id = ? AND plan_id = ?
  )`;
  const results = await database.batch([
    database
      .prepare(
        `INSERT INTO plan_mutation_guards
         (request_id, organization_id, plan_id, source_version, target_version,
          target_active, created_at)
         SELECT ?, organization_id, id, version, version + 1, 0, ? FROM plans
         WHERE id = ? AND organization_id = ? AND active = 1 AND pending_deletion = 0
           AND version = ?
           AND NOT EXISTS (SELECT 1 FROM subscriptions WHERE plan_id = plans.id)`,
      )
      .bind(requestId, now, plan.id, auth.organizationId, plan.version),
    database
      .prepare(
        `UPDATE charges SET active = 0, version = version + 1, updated_at = ?
         WHERE organization_id = ? AND plan_id = ? AND active = 1 AND ${guarded}`,
      )
      .bind(now, auth.organizationId, plan.id, requestId, plan.id),
    database
      .prepare(
        `UPDATE fixed_charges SET active = 0, version = version + 1, updated_at = ?
         WHERE organization_id = ? AND plan_id = ? AND active = 1 AND ${guarded}`,
      )
      .bind(now, auth.organizationId, plan.id, requestId, plan.id),
    database
      .prepare(
        `UPDATE plans SET active = 0, pending_deletion = 0,
                          version = version + 1, updated_at = ?
         WHERE id = ? AND organization_id = ? AND active = 1 AND version = ? AND ${guarded}`,
      )
      .bind(now, plan.id, auth.organizationId, plan.version, requestId, plan.id),
    guardedPlanOutboxStatement(
      database,
      auth.organizationId,
      event,
      plan.id,
      plan.version + 1,
      now,
      0,
      requestId,
    ),
    clearPlanMutationGuardStatement(database, requestId, plan.id),
  ]);
  if (
    results[0]?.meta.changes !== 1 ||
    results[3]?.meta.changes !== 1 ||
    results[4]?.meta.changes !== 1 ||
    results[5]?.meta.changes !== 1
  )
    throw new ApiError(409, "plan_version_conflict", "Plan changed concurrently");
  await env.DOMAIN_EVENTS.send(event);
  return json({ plan: serialized }, { requestId });
}

function planSelect(): string {
  return `SELECT id, organization_id, parent_id, code, name, invoice_display_name, description, interval, amount_minor,
                 currency, trial_period, pay_in_advance, bill_charges_monthly,
                 bill_fixed_charges_monthly, metadata_json, request_sha256,
                 pending_deletion, version, created_at, updated_at FROM plans`;
}

async function findPlan(database: D1Database, organizationId: string, code: string) {
  return database
    .prepare(`${planSelect()} WHERE organization_id = ? AND code = ? AND active = 1
              AND parent_id IS NULL
              ORDER BY version DESC LIMIT 1`)
    .bind(organizationId, code)
    .first<PlanRow>();
}

function assertPlanMutationAvailable(plan: PlanRow): void {
  if (plan.pending_deletion === 1) {
    throw new ApiError(
      409,
      "plan_deletion_in_progress",
      "Plan cannot change while asynchronous deletion is in progress",
    );
  }
}

async function nextPlanIdentity(
  database: D1Database,
  organizationId: string,
  code: string,
): Promise<{ id: string; version: number }> {
  const prior = await database
    .prepare(
      `SELECT COALESCE(MAX(version), 0) AS version
       FROM plans WHERE organization_id = ? AND code = ?`,
    )
    .bind(organizationId, code)
    .first<{ version: number }>();
  const version = (prior?.version ?? 0) + 1;
  for (let generation = 1; generation <= 100; generation += 1) {
    const seed =
      generation === 1 ? `${organizationId}:${code}` : `${organizationId}:${code}:${generation}`;
    const id = await deterministicUuid("plan", seed);
    const existing = await database
      .prepare("SELECT id FROM plans WHERE id = ? LIMIT 1")
      .bind(id)
      .first<{ id: string }>();
    if (!existing) return { id, version };
  }
  throw new ApiError(409, "plan_generation_conflict", "Plan code has too many generations");
}

async function serializePlan(
  database: D1Database,
  plan: PlanRow,
): Promise<Record<string, unknown>> {
  const charges = await database
    .prepare(
      `SELECT ch.id, ch.billable_metric_id, bm.code AS billable_metric_code, ch.code,
              ch.invoice_display_name, ch.charge_model, ch.properties_json, ch.filters_json, ch.invoiceable,
              ch.pay_in_advance, ch.prorated, ch.min_amount_minor, ch.created_at
              , ch.accepts_target_wallet, bm.filters_json AS metric_filters_json
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
  const fixedCharges = await database
    .prepare(`${fixedChargeSelect()} WHERE fc.plan_id = ? AND fc.active = 1
              ORDER BY fc.created_at, fc.id`)
    .bind(plan.id)
    .all<FixedChargeRow>();
  const usageThresholds = await database
    .prepare(
      `SELECT id, amount_minor, recurring, threshold_display_name, created_at, updated_at
       FROM usage_thresholds WHERE plan_id = ? AND deleted_at IS NULL
       ORDER BY recurring, amount_minor, id`,
    )
    .bind(plan.id)
    .all<UsageThresholdRow>();
  const [planTaxes, chargeTaxes, fixedChargeTaxes, commitmentTaxes] = await Promise.all([
    taxesForTarget(database, plan.organization_id, "plan", plan.id),
    Promise.all(
      charges.results.map((charge) =>
        taxesForTarget(database, plan.organization_id, "charge", charge.id),
      ),
    ),
    Promise.all(
      fixedCharges.results.map((charge) =>
        taxesForTarget(database, plan.organization_id, "fixed_charge", charge.id),
      ),
    ),
    commitment
      ? taxesForTarget(database, plan.organization_id, "commitment", commitment.id)
      : Promise.resolve([]),
  ]);
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
    charges: charges.results.map((charge, index) =>
      serializeCharge(charge, chargeTaxes[index] ?? []),
    ),
    fixed_charges: fixedCharges.results.map((charge, index) =>
      serializeFixedCharge(charge, fixedChargeTaxes[index] ?? []),
    ),
    entitlements: [],
    usage_thresholds: usageThresholds.results.map(serializeUsageThreshold),
    applicable_usage_thresholds: usageThresholds.results.map(serializeUsageThreshold),
    taxes: serializeTaxes(planTaxes),
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
          taxes: serializeTaxes(commitmentTaxes),
        }
      : null,
  };
}

function serializeFixedCharge(
  charge: FixedChargeRow,
  taxes: ResolvedTax[] = [],
): Record<string, unknown> {
  return {
    lago_id: charge.id,
    lago_add_on_id: charge.add_on_id,
    code: charge.code,
    invoice_display_name: charge.invoice_display_name,
    add_on_code: charge.add_on_code,
    created_at: charge.created_at,
    charge_model: charge.charge_model,
    pay_in_advance: charge.pay_in_advance === 1,
    prorated: charge.prorated === 1,
    properties: parseObject(charge.properties_json),
    units: charge.units,
    lago_parent_id: charge.parent_id,
    taxes: serializeTaxes(taxes),
  };
}

function sameFixedCharge(charge: FixedChargeRow, normalized: NormalizedFixedCharge): boolean {
  return (
    charge.add_on_id === normalized.addOnId &&
    charge.code === normalized.code &&
    charge.invoice_display_name === normalized.invoiceDisplayName &&
    charge.charge_model === normalized.chargeModel &&
    stableJson(parseObject(charge.properties_json)) === stableJson(normalized.properties) &&
    Decimal.parse(charge.units).compare(Decimal.parse(normalized.units)) === 0 &&
    charge.pay_in_advance === normalized.payInAdvance &&
    charge.prorated === normalized.prorated
  );
}

const MAX_FIXED_CHARGE_CASCADE_CHILDREN = 100;
const MAX_FIXED_CHARGE_CASCADE_JSON_BYTES = 512 * 1024;
const MAX_FIXED_CHARGE_UNIT_EVENT_SUBSCRIPTIONS = 200;

async function billImmediateAdvanceFixedChargeEvents(
  env: PlanCatalogEnv,
  events: PreparedFixedChargeUnitEvent[],
  effectiveAt: string,
  correlationId: string,
): Promise<void> {
  const subscriptionIds = [
    ...new Set(
      events
        .filter((event) => event.effectiveAt === effectiveAt)
        .map((event) => event.subscriptionId),
    ),
  ];
  for (const subscriptionId of subscriptionIds) {
    await createPayInAdvanceFixedChargeDeltaInvoice(
      env,
      subscriptionId,
      effectiveAt,
      correlationId,
    );
  }
}

async function prepareFixedChargeCreateCascade(
  database: D1Database,
  parentPlanId: string,
  fixedCharge: NormalizedFixedCharge,
): Promise<PreparedFixedChargeCascadeCreate[]> {
  const result = await database
    .prepare(
      `SELECT child.id, child.version FROM plans child
       WHERE child.parent_id = ? AND child.active = 1
         AND EXISTS (
           SELECT 1 FROM subscriptions subscription
           WHERE subscription.plan_id = child.id
             AND subscription.status IN ('active', 'pending')
         )
       ORDER BY child.created_at, child.id LIMIT ?`,
    )
    .bind(parentPlanId, MAX_FIXED_CHARGE_CASCADE_CHILDREN + 1)
    .all<{ id: string; version: number }>();
  if (result.results.length > MAX_FIXED_CHARGE_CASCADE_CHILDREN) {
    throw new ApiError(
      422,
      "fixed_charge_cascade_too_large",
      `Fixed-charge cascades support at most ${MAX_FIXED_CHARGE_CASCADE_CHILDREN} active child plans`,
    );
  }
  const creates: PreparedFixedChargeCascadeCreate[] = [];
  for (const childPlan of result.results) {
    creates.push({
      id: await deterministicUuid(
        "fixed-charge-cascade-create",
        `${childPlan.id}:${fixedCharge.id}`,
      ),
      version: 0,
      planId: childPlan.id,
      planVersion: childPlan.version,
      addOnId: fixedCharge.addOnId,
      code: fixedCharge.code,
      invoiceDisplayName: fixedCharge.invoiceDisplayName,
      chargeModel: fixedCharge.chargeModel,
      propertiesJson: stableJson(fixedCharge.properties),
      units: fixedCharge.units,
      payInAdvance: fixedCharge.payInAdvance,
      prorated: fixedCharge.prorated,
    });
  }
  assertFixedChargeCascadeSize(creates);
  return creates;
}

async function prepareFixedChargeUpdateCascade(
  database: D1Database,
  parent: FixedChargeRow,
  next: NormalizedFixedCharge,
): Promise<PreparedFixedChargeCascade> {
  const result = await database
    .prepare(
      `${fixedChargeSelect()} WHERE fc.parent_id = ? AND fc.active = 1
       AND EXISTS (
         SELECT 1 FROM subscriptions subscription
         WHERE subscription.plan_id = fc.plan_id
           AND subscription.status IN ('active', 'pending')
       )
       ORDER BY fc.created_at, fc.id LIMIT ?`,
    )
    .bind(parent.id, MAX_FIXED_CHARGE_CASCADE_CHILDREN + 1)
    .all<FixedChargeRow>();
  if (result.results.length > MAX_FIXED_CHARGE_CASCADE_CHILDREN) {
    throw new ApiError(
      422,
      "fixed_charge_cascade_too_large",
      `Fixed-charge cascades support at most ${MAX_FIXED_CHARGE_CASCADE_CHILDREN} active child charges`,
    );
  }
  const guards = result.results.map(({ id, version }) => ({ id, version }));
  const updates: PreparedFixedChargeCascadeUpdate[] = [];
  const parentProperties = parseObject(parent.properties_json);
  for (const child of result.results) {
    if (child.charge_model !== next.chargeModel) continue;
    const childProperties = parseObject(child.properties_json);
    const equalProperties =
      parent.charge_model === child.charge_model &&
      stableJson(parentProperties) === stableJson(childProperties) &&
      Decimal.parse(parent.units).compare(Decimal.parse(child.units)) === 0;
    const properties = equalProperties ? next.properties : childProperties;
    const units = equalProperties ? next.units : child.units;
    if (
      child.code !== next.code ||
      stableJson(childProperties) !== stableJson(properties) ||
      Decimal.parse(child.units).compare(Decimal.parse(units)) !== 0
    ) {
      updates.push({
        id: child.id,
        planId: child.plan_id,
        code: next.code,
        version: child.version,
        previousUnits: child.units,
        propertiesJson: stableJson(properties),
        units,
      });
    }
  }
  const prepared = { enabled: true, guards, updates } satisfies PreparedFixedChargeCascade;
  assertFixedChargeCascadeSize(prepared);
  return prepared;
}

async function prepareFixedChargeDeleteCascade(
  database: D1Database,
  parentFixedChargeId: string,
): Promise<PreparedFixedChargeCascadeDelete[]> {
  const result = await database
    .prepare(
      `SELECT child.id, child.code, child.version FROM fixed_charges child
       WHERE child.parent_id = ? AND child.active = 1
         AND EXISTS (
           SELECT 1 FROM subscriptions subscription
           WHERE subscription.plan_id = child.plan_id
             AND subscription.status IN ('active', 'pending')
         )
       ORDER BY child.created_at, child.id LIMIT ?`,
    )
    .bind(parentFixedChargeId, MAX_FIXED_CHARGE_CASCADE_CHILDREN + 1)
    .all<PreparedFixedChargeCascadeDelete>();
  if (result.results.length > MAX_FIXED_CHARGE_CASCADE_CHILDREN) {
    throw new ApiError(
      422,
      "fixed_charge_cascade_too_large",
      `Fixed-charge cascades support at most ${MAX_FIXED_CHARGE_CASCADE_CHILDREN} active child charges`,
    );
  }
  return [...result.results];
}

function emptyFixedChargeCascade(): PreparedFixedChargeCascade {
  return { enabled: false, guards: [], updates: [] };
}

async function prepareFixedChargeUnitEvents(
  database: D1Database,
  organizationId: string,
  changes: FixedChargeUnitChange[],
  applyUnitsImmediately: boolean,
  now: string,
): Promise<PreparedFixedChargeUnitEvents> {
  const unitChanges = changes.filter(
    (change) =>
      change.previousUnits === null ||
      Decimal.parse(change.previousUnits).compare(Decimal.parse(change.units)) !== 0,
  );
  if (unitChanges.length === 0) {
    return { events: [], requiredChangeCount: 0, changes: [], guards: [] };
  }
  const result = await database
    .prepare(
      `SELECT subscription.id AS subscription_id, subscription.version AS subscription_version,
              subscription.started_at AS subscription_started_at,
              subscription.current_period_start, subscription.current_period_end,
              json_extract(change.value, '$.planId') AS plan_id,
              json_extract(change.value, '$.fixedChargeId') AS fixed_charge_id,
              json_extract(change.value, '$.fixedChargeVersion') AS fixed_charge_version,
              json_extract(change.value, '$.previousUnits') AS previous_units,
              json_extract(change.value, '$.units') AS units
       FROM json_each(?) change
       JOIN subscriptions subscription
         ON subscription.plan_id = json_extract(change.value, '$.planId')
       WHERE subscription.organization_id = ?
         AND subscription.status IN ('active', 'past_due')
       ORDER BY subscription.id, fixed_charge_id
       LIMIT ?`,
    )
    .bind(stableJson(unitChanges), organizationId, MAX_FIXED_CHARGE_UNIT_EVENT_SUBSCRIPTIONS + 1)
    .all<{
      subscription_id: string;
      subscription_version: number;
      subscription_started_at: string | null;
      current_period_start: string | null;
      current_period_end: string | null;
      plan_id: string;
      fixed_charge_id: string;
      fixed_charge_version: number;
      previous_units: string | null;
      units: string;
    }>();
  if (result.results.length > MAX_FIXED_CHARGE_UNIT_EVENT_SUBSCRIPTIONS) {
    throw new ApiError(
      422,
      "fixed_charge_unit_events_too_large",
      `Fixed-charge unit changes support at most ${MAX_FIXED_CHARGE_UNIT_EVENT_SUBSCRIPTIONS} active subscription event targets`,
    );
  }
  const events: PreparedFixedChargeUnitEvent[] = [];
  for (const row of result.results) {
    const periodStart = row.current_period_start ?? row.subscription_started_at;
    const periodEnd = row.current_period_end;
    if (
      !periodStart ||
      !periodEnd ||
      !Number.isFinite(Date.parse(periodStart)) ||
      !Number.isFinite(Date.parse(periodEnd))
    ) {
      throw new ApiError(
        409,
        "subscription_period_unavailable",
        "Fixed-charge units require an active billing period",
      );
    }
    if (row.previous_units !== null) {
      events.push({
        id: await deterministicUuid(
          "fixed-charge-unit-event",
          `${row.subscription_id}:${row.fixed_charge_id}:v0`,
        ),
        subscriptionId: row.subscription_id,
        fixedChargeId: row.fixed_charge_id,
        fixedChargeVersion: 0,
        units: row.previous_units,
        effectiveAt: periodStart,
        billImmediately: false,
      });
    }
    events.push({
      id: await deterministicUuid(
        "fixed-charge-unit-event",
        `${row.subscription_id}:${row.fixed_charge_id}:v${row.fixed_charge_version}`,
      ),
      subscriptionId: row.subscription_id,
      fixedChargeId: row.fixed_charge_id,
      fixedChargeVersion: row.fixed_charge_version,
      units: row.units,
      effectiveAt: applyUnitsImmediately ? now : periodEnd,
      billImmediately: applyUnitsImmediately,
    });
  }
  if (
    new TextEncoder().encode(stableJson(events)).byteLength > MAX_FIXED_CHARGE_CASCADE_JSON_BYTES
  ) {
    throw new ApiError(
      422,
      "fixed_charge_unit_events_too_large",
      "Fixed-charge unit event data exceeds the supported size",
    );
  }
  return {
    events,
    requiredChangeCount: result.results.length,
    changes: unitChanges,
    guards: result.results.map((row) => ({
      subscriptionId: row.subscription_id,
      planId: row.plan_id,
      version: row.subscription_version,
      currentPeriodStart: row.current_period_start,
      currentPeriodEnd: row.current_period_end,
    })),
  };
}

function fixedChargeUnitEventInsertStatement(
  database: D1Database,
  organizationId: string,
  events: PreparedFixedChargeUnitEvent[],
  createdAt: string,
): D1PreparedStatement {
  return database
    .prepare(
      `INSERT OR IGNORE INTO fixed_charge_unit_events
       (id, organization_id, subscription_id, fixed_charge_id, fixed_charge_version, units,
        effective_at, bill_immediately, created_at)
       SELECT json_extract(event.value, '$.id'), ?,
              json_extract(event.value, '$.subscriptionId'),
              json_extract(event.value, '$.fixedChargeId'),
              json_extract(event.value, '$.fixedChargeVersion'),
              json_extract(event.value, '$.units'),
              json_extract(event.value, '$.effectiveAt'),
              CASE WHEN json_extract(event.value, '$.billImmediately') THEN 1 ELSE 0 END, ?
       FROM json_each(?) event
       WHERE EXISTS (
         SELECT 1 FROM subscriptions subscription
         JOIN fixed_charges fixed ON fixed.plan_id = subscription.plan_id
         WHERE subscription.id = json_extract(event.value, '$.subscriptionId')
           AND subscription.organization_id = ?
           AND fixed.id = json_extract(event.value, '$.fixedChargeId')
           AND fixed.organization_id = ?
           AND fixed.active = 1
       )`,
    )
    .bind(organizationId, createdAt, stableJson(events), organizationId, organizationId);
}

function assertFixedChargeCascadeSize(value: unknown): void {
  if (
    new TextEncoder().encode(stableJson(value)).byteLength > MAX_FIXED_CHARGE_CASCADE_JSON_BYTES
  ) {
    throw new ApiError(
      422,
      "fixed_charge_cascade_too_large",
      "Fixed-charge cascade pricing data exceeds the supported size",
    );
  }
}

function cascadeRequested(input: Record<string, unknown>): boolean {
  const value = input.cascade_updates;
  return value === true || value === 1 || value === "1" || value === "true" || value === "on";
}

async function normalizeMinimumCommitment(
  value: unknown,
  database: D1Database,
  organizationId: string,
  planCode: string,
): Promise<NormalizedCommitment | null> {
  if (value === undefined || value === null) return null;
  const input = optionalObject(value, "minimum_commitment");
  const taxCodes = normalizeTaxCodes(input.tax_codes) ?? [];
  const amountMinor = nonNegativeInteger(input.amount_cents, "minimum_commitment.amount_cents");
  if (amountMinor === 0)
    throw new ApiError(422, "validation_error", "minimum_commitment.amount_cents must be positive");
  return {
    id: await deterministicUuid("minimum-commitment", `${organizationId}:${planCode}`),
    amountMinor,
    invoiceDisplayName: optionalString(input, "invoice_display_name"),
    taxes: await resolveActiveTaxes(database, organizationId, taxCodes),
  };
}

function serializeCharge(charge: ChargeRow, taxes: ResolvedTax[] = []): Record<string, unknown> {
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
    accepts_target_wallet: charge.accepts_target_wallet === 1,
    properties: parseObject(charge.properties_json),
    filters: parseStoredChargeFilters(
      charge.filters_json,
      parseStoredBillableMetricFilters(charge.metric_filters_json),
      charge.charge_model,
      charge.id,
    ).map((filter) => serializeChargeFilter(filter, charge.code)),
    taxes: serializeTaxes(taxes),
    applied_pricing_unit: null,
    lago_parent_id: null,
  };
}

function serializeTaxes(taxes: ResolvedTax[]) {
  return taxes.map((tax) => ({
    lago_id: tax.id,
    code: tax.code,
    name: tax.name,
    description: tax.description,
    rate: Number(tax.rate),
  }));
}

function sameTaxSets(left: ResolvedTax[], right: ResolvedTax[]): boolean {
  const leftIds = left.map((tax) => tax.id).sort();
  const rightIds = right.map((tax) => tax.id).sort();
  return leftIds.length === rightIds.length && leftIds.every((id, index) => id === rightIds[index]);
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
    rejectUnsupportedChargeFeatures(input);
    const taxCodes = normalizeTaxCodes(input.tax_codes) ?? [];
    const metricId = requiredString(input, "billable_metric_id");
    const metric = await database
      .prepare(
        `SELECT id, code, aggregation_type, filters_json FROM billable_metrics
         WHERE organization_id = ? AND id = ? AND active = 1 LIMIT 1`,
      )
      .bind(organizationId, metricId)
      .first<{ id: string; code: string; aggregation_type: string; filters_json: string }>();
    if (!metric)
      throw new ApiError(404, "billable_metric_not_found", "Billable metric was not found");
    const code = optionalString(input, "code") ?? `${planCode}-${metric.code}`;
    if (seen.has(code)) throw new ApiError(422, "value_already_exist", "Charge code is duplicated");
    seen.add(code);
    const chargeModel = requiredString(input, "charge_model");
    const properties = optionalObject(input.properties, "properties");
    parseChargeModel(chargeModel, properties);
    const invoiceable = booleanInteger(input.invoiceable, true);
    const payInAdvance = booleanInteger(input.pay_in_advance, false);
    const prorated = booleanInteger(input.prorated, false);
    const id = await deterministicUuid("charge", `${planId}:${code}`);
    const minAmountMinor =
      input.min_amount_cents === undefined
        ? 0
        : nonNegativeInteger(input.min_amount_cents, "min_amount_cents");
    const acceptsTargetWallet = booleanInteger(input.accepts_target_wallet, false);
    validatePayInAdvanceUsageConfiguration({
      payInAdvance,
      prorated,
      invoiceable,
      minAmountMinor,
      aggregationType: metric.aggregation_type,
      chargeModel,
      properties,
    });
    const filters = await normalizeChargeFilters(
      input.filters,
      parseStoredBillableMetricFilters(metric.filters_json),
      chargeModel,
      id,
    );
    charges.push({
      id,
      metricId,
      code,
      invoiceDisplayName: optionalString(input, "invoice_display_name"),
      chargeModel,
      properties,
      invoiceable,
      payInAdvance,
      prorated,
      minAmountMinor,
      acceptsTargetWallet,
      filters,
      taxes: await resolveActiveTaxes(database, organizationId, taxCodes),
    });
  }
  return charges;
}

function rejectUnsupportedChargeFeatures(input: Record<string, unknown>): void {
  for (const field of ["applied_pricing_unit", "regroup_paid_fees", "cascade_updates"]) {
    const value = input[field];
    if (value === undefined || value === null || value === false) continue;
    if (Array.isArray(value) && value.length === 0) continue;
    throw new ApiError(
      422,
      "unsupported_charge_feature",
      `${field} is not implemented by the Cloudflare charge catalog`,
    );
  }
}

async function normalizeFixedCharges(
  value: unknown,
  database: D1Database,
  organizationId: string,
  planId: string,
  planCurrency: string,
): Promise<NormalizedFixedCharge[]> {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value))
    throw new ApiError(422, "validation_error", "fixed_charges must be an array");
  const fixedCharges: NormalizedFixedCharge[] = [];
  const seen = new Set<string>();
  for (const [index, entry] of value.entries()) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry))
      throw new ApiError(422, "validation_error", `fixed_charges[${index}] must be an object`);
    const input = entry as Record<string, unknown>;
    if (input.id !== undefined || input.parent_id !== undefined)
      throw new ApiError(
        422,
        "unsupported_fixed_charge_feature",
        "Fixed-charge overrides and parent inheritance are not implemented",
      );
    const payInAdvance = booleanInteger(input.pay_in_advance, false);
    const prorated = booleanInteger(input.prorated, false);
    if (
      input.apply_units_immediately !== undefined &&
      typeof input.apply_units_immediately !== "boolean"
    )
      throw new ApiError(422, "validation_error", "apply_units_immediately must be boolean");
    const taxCodes = normalizeTaxCodes(input.tax_codes) ?? [];
    const addOnId = requiredString(input, "add_on_id");
    const addOn = await database
      .prepare(
        `SELECT id, code, currency FROM add_ons
         WHERE id = ? AND organization_id = ? AND status = 'active' LIMIT 1`,
      )
      .bind(addOnId, organizationId)
      .first<{ id: string; code: string; currency: string }>();
    if (!addOn) throw new ApiError(404, "add_on_not_found", "Add-on was not found");
    if (addOn.currency !== planCurrency)
      throw new ApiError(
        422,
        "currency_mismatch",
        "Fixed-charge add-on currency must match the plan currency",
      );
    const code = optionalString(input, "code") ?? addOn.code;
    if (seen.has(code))
      throw new ApiError(422, "value_already_exist", "Fixed-charge code is duplicated");
    seen.add(code);
    const chargeModel = supportedFixedChargeModel(input.charge_model);
    validateFixedChargeTiming(chargeModel, payInAdvance, prorated);
    const properties = optionalObject(input.properties, "properties");
    const units = nonNegativeDecimal(input.units ?? 1, `fixed_charges[${index}].units`);
    validateFixedChargeRating(units, chargeModel, properties, `fixed_charges[${index}]`);
    fixedCharges.push({
      id: await deterministicUuid("fixed-charge", `${planId}:${code}`),
      addOnId,
      code,
      invoiceDisplayName: optionalString(input, "invoice_display_name"),
      chargeModel,
      properties,
      units,
      payInAdvance,
      prorated,
      applyUnitsImmediately: input.apply_units_immediately === true,
      taxes: await resolveActiveTaxes(database, organizationId, taxCodes),
    });
  }
  return fixedCharges;
}

function supportedFixedChargeModel(value: unknown): "standard" | "graduated" | "volume" {
  if (value === "standard" || value === "graduated" || value === "volume") return value;
  throw new ApiError(
    422,
    "unsupported_charge_model",
    `Unsupported fixed-charge model: ${String(value)}`,
  );
}

function validateFixedChargeRating(
  units: string,
  chargeModel: "standard" | "graduated" | "volume",
  properties: Record<string, unknown>,
  field: string,
): void {
  try {
    const rated = Decimal.parse(
      rateCharge(units, parseChargeModel(chargeModel, properties)).amountCents,
    );
    if (rated.isNegative()) throw new Error("negative");
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError(422, "validation_error", `${field} has invalid rating properties`);
  }
}

function validateFixedChargeTiming(
  chargeModel: "standard" | "graduated" | "volume",
  payInAdvance: 0 | 1,
  prorated: 0 | 1,
): void {
  if (payInAdvance === 1 && chargeModel === "volume") {
    throw new ApiError(
      422,
      "invalid_charge_model",
      "Volume fixed charges cannot be billed in advance",
    );
  }
  if (payInAdvance === 1 && prorated === 1 && chargeModel === "graduated") {
    throw new ApiError(
      422,
      "invalid_charge_model",
      "Prorated graduated fixed charges cannot be billed in advance",
    );
  }
}

function rejectUnsupportedFixedChargeMutation(
  input: Record<string, unknown>,
  current?: FixedChargeRow,
): void {
  for (const field of ["id", "parent_id"]) {
    const value = input[field];
    if (value === undefined || value === null || value === false) continue;
    throw new ApiError(
      422,
      "unsupported_fixed_charge_feature",
      `${field} is not implemented for fixed-charge mutations`,
    );
  }
  if (input.pay_in_advance !== undefined)
    booleanInteger(input.pay_in_advance, current?.pay_in_advance === 1);
  if (input.prorated !== undefined) booleanInteger(input.prorated, current?.prorated === 1);
  if (
    input.apply_units_immediately !== undefined &&
    typeof input.apply_units_immediately !== "boolean"
  )
    throw new ApiError(422, "validation_error", "apply_units_immediately must be boolean");
  for (const field of ["add_on_id", "add_on_code"]) {
    if (input[field] !== undefined)
      throw new ApiError(
        422,
        "unsupported_fixed_charge_feature",
        "A fixed charge cannot change its add-on",
      );
  }
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

function nonNegativeDecimal(value: unknown, field: string): string {
  if (typeof value !== "string" && typeof value !== "number")
    throw new ApiError(422, "validation_error", `${field} must be a non-negative decimal`);
  try {
    const decimal = Decimal.parse(value);
    if (decimal.isNegative()) throw new Error("negative");
    return decimal.toString();
  } catch {
    throw new ApiError(422, "validation_error", `${field} must be a non-negative decimal`);
  }
}

function rejectUpdateGraph(input: Record<string, unknown>): void {
  for (const field of ["charges", "fixed_charges", "minimum_commitment"]) {
    if (input[field] === undefined) continue;
    throw new ApiError(
      422,
      "unsupported_plan_update",
      `${field} mutation is not implemented by the Cloudflare plan catalog`,
    );
  }
}

const MAX_PLAN_AMOUNT_CASCADE_CHILDREN = 100;
const MAX_PLAN_AMOUNT_CASCADE_JSON_BYTES = 64 * 1024;

async function preparePlanAmountCascade(
  database: D1Database,
  parentPlanId: string,
  oldAmountMinor: number,
): Promise<PreparedPlanAmountCascade[]> {
  const result = await database
    .prepare(
      `SELECT id, code, version FROM plans
       WHERE parent_id = ? AND active = 1 AND amount_minor = ?
       ORDER BY created_at, id LIMIT ?`,
    )
    .bind(parentPlanId, oldAmountMinor, MAX_PLAN_AMOUNT_CASCADE_CHILDREN + 1)
    .all<PreparedPlanAmountCascade>();
  if (result.results.length > MAX_PLAN_AMOUNT_CASCADE_CHILDREN) {
    throw new ApiError(
      422,
      "plan_cascade_too_large",
      `Plan amount cascades support at most ${MAX_PLAN_AMOUNT_CASCADE_CHILDREN} unchanged child plans`,
    );
  }
  const prepared = [...result.results];
  if (
    new TextEncoder().encode(stableJson(prepared)).byteLength > MAX_PLAN_AMOUNT_CASCADE_JSON_BYTES
  ) {
    throw new ApiError(
      422,
      "plan_cascade_too_large",
      "Plan amount cascade data exceeds the supported size",
    );
  }
  return prepared;
}

function planEvent(
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
    aggregateType: "plan",
    aggregateId: id,
    aggregateVersion: version,
    occurredAt,
    causationId: correlationId,
    correlationId,
    payload: { organizationId, ...payload },
  };
}

function fixedChargeEvent(
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
    aggregateType: "fixed_charge",
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

function planMutationGuardStatement(
  database: D1Database,
  requestId: string,
  organizationId: string,
  plan: PlanRow,
  targetActive: 0 | 1,
  now: string,
): D1PreparedStatement {
  return database
    .prepare(
      `INSERT INTO plan_mutation_guards
       (request_id, organization_id, plan_id, source_version, target_version,
        target_active, created_at)
       SELECT ?, organization_id, id, version, version + 1, ?, ? FROM plans
       WHERE id = ? AND organization_id = ? AND active = 1 AND version = ?`,
    )
    .bind(requestId, targetActive, now, plan.id, organizationId, plan.version);
}

function guardedPlanOutboxStatement(
  database: D1Database,
  organizationId: string,
  event: DomainEvent,
  planId: string,
  expectedVersion: number,
  expectedUpdatedAt: string,
  expectedActive: 0 | 1,
  requestId: string,
): D1PreparedStatement {
  return database
    .prepare(
      `INSERT INTO outbox_events
       (event_id, organization_id, event_type, event_version, aggregate_type, aggregate_id,
        aggregate_version, causation_id, correlation_id, payload_json, occurred_at, published_at)
       SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL
       FROM plans plan JOIN plan_mutation_guards guard
         ON guard.plan_id = plan.id AND guard.organization_id = plan.organization_id
       WHERE guard.request_id = ? AND guard.target_active = ? AND guard.target_version = ?
         AND plan.id = ? AND plan.organization_id = ? AND plan.active = ?
         AND plan.version = ? AND plan.updated_at = ?`,
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
      requestId,
      expectedActive,
      expectedVersion,
      planId,
      organizationId,
      expectedActive,
      expectedVersion,
      expectedUpdatedAt,
    );
}

function bulkPlanCascadeOutboxStatement(
  database: D1Database,
  organizationId: string,
  events: DomainEvent[],
  cascades: PreparedPlanAmountCascade[],
  updatedAt: string,
): D1PreparedStatement {
  const rows = events.map((event, index) => ({
    eventId: event.id,
    eventType: event.type,
    eventVersion: event.version,
    aggregateType: event.aggregateType,
    aggregateId: event.aggregateId,
    aggregateVersion: event.aggregateVersion,
    causationId: event.causationId,
    correlationId: event.correlationId,
    payloadJson: stableJson(event.payload),
    occurredAt: event.occurredAt,
    expectedVersion: cascades[index]!.version + 1,
  }));
  return database
    .prepare(
      `INSERT INTO outbox_events
       (event_id, organization_id, event_type, event_version, aggregate_type, aggregate_id,
        aggregate_version, causation_id, correlation_id, payload_json, occurred_at, published_at)
       SELECT json_extract(row.value, '$.eventId'), ?,
              json_extract(row.value, '$.eventType'),
              json_extract(row.value, '$.eventVersion'),
              json_extract(row.value, '$.aggregateType'),
              json_extract(row.value, '$.aggregateId'),
              json_extract(row.value, '$.aggregateVersion'),
              json_extract(row.value, '$.causationId'),
              json_extract(row.value, '$.correlationId'),
              json_extract(row.value, '$.payloadJson'),
              json_extract(row.value, '$.occurredAt'), NULL
       FROM json_each(?) row
       JOIN plans child ON child.id = json_extract(row.value, '$.aggregateId')
       WHERE child.organization_id = ? AND child.active = 1
         AND child.version = json_extract(row.value, '$.expectedVersion')
         AND child.updated_at = ?`,
    )
    .bind(organizationId, stableJson(rows), organizationId, updatedAt);
}

function clearPlanMutationGuardStatement(
  database: D1Database,
  requestId: string,
  planId: string,
): D1PreparedStatement {
  return database
    .prepare("DELETE FROM plan_mutation_guards WHERE request_id = ? AND plan_id = ?")
    .bind(requestId, planId);
}

function conditionalFixedChargeOutboxStatement(
  database: D1Database,
  organizationId: string,
  event: DomainEvent,
  fixedChargeId: string,
  expectedVersion: number,
  expectedUpdatedAt: string,
  expectedActive: 0 | 1,
): D1PreparedStatement {
  return database
    .prepare(
      `INSERT INTO outbox_events
       (event_id, organization_id, event_type, event_version, aggregate_type, aggregate_id,
        aggregate_version, causation_id, correlation_id, payload_json, occurred_at, published_at)
       SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL FROM fixed_charges
       WHERE id = ? AND organization_id = ? AND active = ? AND version = ? AND updated_at = ?`,
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
      fixedChargeId,
      organizationId,
      expectedActive,
      expectedVersion,
      expectedUpdatedAt,
    );
}

function bulkFixedChargeCascadeOutboxStatement(
  database: D1Database,
  organizationId: string,
  events: DomainEvent[],
  cascades: Array<{ version: number }>,
  updatedAt: string,
  expectedActive: 0 | 1,
): D1PreparedStatement {
  const rows = events.map((event, index) => ({
    eventId: event.id,
    eventType: event.type,
    eventVersion: event.version,
    aggregateType: event.aggregateType,
    aggregateId: event.aggregateId,
    aggregateVersion: event.aggregateVersion,
    causationId: event.causationId,
    correlationId: event.correlationId,
    payloadJson: stableJson(event.payload),
    occurredAt: event.occurredAt,
    expectedVersion: cascades[index]!.version + 1,
  }));
  return database
    .prepare(
      `INSERT INTO outbox_events
       (event_id, organization_id, event_type, event_version, aggregate_type, aggregate_id,
        aggregate_version, causation_id, correlation_id, payload_json, occurred_at, published_at)
       SELECT json_extract(row.value, '$.eventId'), ?,
              json_extract(row.value, '$.eventType'),
              json_extract(row.value, '$.eventVersion'),
              json_extract(row.value, '$.aggregateType'),
              json_extract(row.value, '$.aggregateId'),
              json_extract(row.value, '$.aggregateVersion'),
              json_extract(row.value, '$.causationId'),
              json_extract(row.value, '$.correlationId'),
              json_extract(row.value, '$.payloadJson'),
              json_extract(row.value, '$.occurredAt'), NULL
       FROM json_each(?) row
       JOIN fixed_charges child ON child.id = json_extract(row.value, '$.aggregateId')
       WHERE child.organization_id = ? AND child.active = ?
         AND child.version = json_extract(row.value, '$.expectedVersion')
         AND child.updated_at = ?`,
    )
    .bind(organizationId, stableJson(rows), organizationId, expectedActive, updatedAt);
}

function hasEntries(value: unknown): boolean {
  return Array.isArray(value) ? value.length > 0 : value !== undefined && value !== null;
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
