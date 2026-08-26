import type { AuthContext } from "../auth/api-key";
import type { DomainEvent } from "../domain-events";
import { ApiError, json, objectAt, optionalString, parseJsonObject } from "../http";
import { deterministicUuid } from "../identifiers";
import { stableJson } from "../json";
import { rateCharge } from "../rating/charge-models";
import { Decimal } from "../rating/decimal";
import { parseChargeModel } from "../usage/charge-properties";
import { createPayInAdvanceFixedChargeDeltaInvoice } from "../billing/pay-in-advance-fixed-charges";
import {
  guardedReplaceTaxTargetStatements,
  normalizeTaxCodes,
  replaceTaxTargetStatements,
  resolveActiveTaxes,
  taxesForTarget,
  type ResolvedTax,
} from "../billing/tax-targets";
import {
  normalizeChargeFilters,
  parseStoredBillableMetricFilters,
  parseStoredChargeFilters,
  serializeChargeFilter,
  type ChargeFilter,
} from "../usage/charge-filters";

type SubscriptionPlanRow = {
  subscription_id: string;
  subscription_version: number;
  subscription_status: string;
  subscription_started_at: string | null;
  current_period_start: string | null;
  current_period_end: string | null;
  plan_id: string;
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
  plan_version: number;
};

type GraphChargeRow = {
  id: string;
  billable_metric_id: string;
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
  version: number;
};

type GraphFixedChargeRow = {
  id: string;
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
  created_at: string;
};

type NormalizedFixedChargeOverride = {
  invoiceDisplayName: string | null;
  properties: Record<string, unknown>;
  units: string;
  applyUnitsImmediately: boolean;
  taxCodes: string[] | undefined;
};

type FixedChargeUnitEventInput = {
  id: string;
  subscriptionId: string;
  fixedChargeId: string;
  fixedChargeVersion: number;
  units: string;
  effectiveAt: string;
  billImmediately: boolean;
};

type ClonedGraphCharge = {
  id: string;
  parentId: string;
  billableMetricId: string;
  code: string;
  invoiceDisplayName: string | null;
  chargeModel: string;
  propertiesJson: string;
  filtersJson: string;
  invoiceable: number;
  payInAdvance: number;
  prorated: number;
  minAmountMinor: number;
  acceptsTargetWallet: number;
};

type ClonedGraphFixedCharge = {
  id: string;
  parentId: string;
  addOnId: string;
  code: string;
  invoiceDisplayName: string | null;
  chargeModel: string;
  propertiesJson: string;
  units: string;
  payInAdvance: number;
  prorated: number;
};

type ClonedMinimumCommitment = {
  id: string;
  parentId: string;
  amountMinor: number;
  invoiceDisplayName: string | null;
};

type PreparedPlanOverrideGraph = {
  childPlanId: string;
  nextVersion: number;
  clonedCharges: ClonedGraphCharge[];
  clonedFixedCharges: ClonedGraphFixedCharge[];
  clonedCommitment: ClonedMinimumCommitment | null;
};

type OverrideGraphTransforms = {
  charge?: (source: GraphChargeRow, clone: ClonedGraphCharge) => Promise<ClonedGraphCharge>;
  fixedCharge?: (
    source: GraphFixedChargeRow,
    clone: ClonedGraphFixedCharge,
  ) => Promise<ClonedGraphFixedCharge>;
};

type Mutation =
  | { kind: "create"; input: Record<string, unknown> }
  | { kind: "update"; filterId: string; input: Record<string, unknown> }
  | { kind: "delete"; filterId: string };

const MAX_GRAPH_CHARGES = 100;
const MAX_GRAPH_FIXED_CHARGES = 100;
const MAX_GRAPH_JSON_BYTES = 512 * 1024;

export async function handleSubscriptionChargeFilterRequest(
  request: Request,
  env: Env,
  auth: AuthContext,
  requestId: string,
): Promise<Response | null> {
  const url = new URL(request.url);
  const fixedChargeCollection = url.pathname.match(
    /^\/api\/v1\/subscriptions\/([^/]+)\/fixed_charges$/,
  );
  if (fixedChargeCollection?.[1] && request.method === "GET") {
    return listFixedCharges(
      decodeURIComponent(fixedChargeCollection[1]),
      url,
      env.BILLING_DB,
      auth,
      requestId,
    );
  }
  const fixedChargeMember = url.pathname.match(
    /^\/api\/v1\/subscriptions\/([^/]+)\/fixed_charges\/([^/]+)$/,
  );
  if (fixedChargeMember?.[1] && fixedChargeMember[2]) {
    const externalId = decodeURIComponent(fixedChargeMember[1]);
    const fixedChargeCode = decodeURIComponent(fixedChargeMember[2]);
    if (request.method === "GET") {
      return showFixedCharge(externalId, fixedChargeCode, env.BILLING_DB, auth, requestId);
    }
    if (request.method === "PUT") {
      return updateSubscriptionFixedCharge(
        externalId,
        fixedChargeCode,
        objectAt(await parseJsonObject(request), "fixed_charge"),
        env,
        auth,
        requestId,
      );
    }
  }

  const collection = url.pathname.match(
    /^\/api\/v1\/subscriptions\/([^/]+)\/charges\/([^/]+)\/filters$/,
  );
  if (collection?.[1] && collection[2]) {
    const externalId = decodeURIComponent(collection[1]);
    const chargeCode = decodeURIComponent(collection[2]);
    if (request.method === "GET") {
      return listFilters(externalId, chargeCode, url, env.BILLING_DB, auth, requestId);
    }
    if (request.method === "POST") {
      return mutateFilter(
        externalId,
        chargeCode,
        { kind: "create", input: objectAt(await parseJsonObject(request), "filter") },
        env,
        auth,
        requestId,
      );
    }
  }

  const member = url.pathname.match(
    /^\/api\/v1\/subscriptions\/([^/]+)\/charges\/([^/]+)\/filters\/([^/]+)$/,
  );
  if (!member?.[1] || !member[2] || !member[3]) return null;
  const externalId = decodeURIComponent(member[1]);
  const chargeCode = decodeURIComponent(member[2]);
  const filterId = decodeURIComponent(member[3]);
  if (request.method === "GET") {
    return showFilter(externalId, chargeCode, filterId, env.BILLING_DB, auth, requestId);
  }
  if (request.method === "PUT") {
    return mutateFilter(
      externalId,
      chargeCode,
      { kind: "update", filterId, input: objectAt(await parseJsonObject(request), "filter") },
      env,
      auth,
      requestId,
    );
  }
  if (request.method === "DELETE") {
    return mutateFilter(externalId, chargeCode, { kind: "delete", filterId }, env, auth, requestId);
  }
  return null;
}

async function listFixedCharges(
  externalId: string,
  url: URL,
  database: D1Database,
  auth: AuthContext,
  requestId: string,
): Promise<Response> {
  const plan = await requireSubscriptionPlan(database, auth.organizationId, externalId);
  const page = positiveInteger(url.searchParams.get("page"), 1);
  const perPage = Math.min(positiveInteger(url.searchParams.get("per_page"), 20), 100);
  const offset = (page - 1) * perPage;
  const count = await database
    .prepare("SELECT COUNT(*) AS total FROM fixed_charges WHERE plan_id = ? AND active = 1")
    .bind(plan.plan_id)
    .first<{ total: number }>();
  const result = await database
    .prepare(
      `${graphFixedChargeSelect()} WHERE fc.plan_id = ? AND fc.active = 1
       ORDER BY fc.created_at DESC, fc.id DESC LIMIT ? OFFSET ?`,
    )
    .bind(plan.plan_id, perPage, offset)
    .all<GraphFixedChargeRow>();
  return json(
    {
      fixed_charges: await Promise.all(
        result.results.map((charge) => serializeFixedCharge(database, auth.organizationId, charge)),
      ),
      meta: pagination(count?.total ?? 0, page, perPage),
    },
    { requestId },
  );
}

async function showFixedCharge(
  externalId: string,
  fixedChargeCode: string,
  database: D1Database,
  auth: AuthContext,
  requestId: string,
): Promise<Response> {
  const { fixedCharge } = await requireSubscriptionFixedCharge(
    database,
    auth.organizationId,
    externalId,
    fixedChargeCode,
  );
  return json(
    { fixed_charge: await serializeFixedCharge(database, auth.organizationId, fixedCharge) },
    { requestId },
  );
}

async function updateSubscriptionFixedCharge(
  externalId: string,
  fixedChargeCode: string,
  input: Record<string, unknown>,
  env: Env,
  auth: AuthContext,
  requestId: string,
): Promise<Response> {
  const current = await requireSubscriptionFixedCharge(
    env.BILLING_DB,
    auth.organizationId,
    externalId,
    fixedChargeCode,
  );
  const normalized = normalizeFixedChargeOverride(current.fixedCharge, input);
  if (current.plan.parent_id === null) {
    return createFixedChargePlanOverride(
      current.plan,
      current.fixedCharge,
      normalized,
      env,
      auth,
      requestId,
    );
  }
  return mutateExistingFixedChargeOverride(
    current.plan,
    current.fixedCharge,
    normalized,
    env,
    auth,
    requestId,
  );
}

async function listFilters(
  externalId: string,
  chargeCode: string,
  url: URL,
  database: D1Database,
  auth: AuthContext,
  requestId: string,
): Promise<Response> {
  const { charge } = await requireSubscriptionCharge(
    database,
    auth.organizationId,
    externalId,
    chargeCode,
  );
  const filters = chargeFilters(charge);
  const page = positiveInteger(url.searchParams.get("page"), 1);
  const perPage = Math.min(positiveInteger(url.searchParams.get("per_page"), 20), 100);
  const offset = (page - 1) * perPage;
  return json(
    {
      filters: filters
        .slice(offset, offset + perPage)
        .map((filter) => serializeChargeFilter(filter, charge.code)),
      meta: pagination(filters.length, page, perPage),
    },
    { requestId },
  );
}

async function showFilter(
  externalId: string,
  chargeCode: string,
  filterId: string,
  database: D1Database,
  auth: AuthContext,
  requestId: string,
): Promise<Response> {
  const { charge } = await requireSubscriptionCharge(
    database,
    auth.organizationId,
    externalId,
    chargeCode,
  );
  const filter = requireFilter(charge, filterId);
  return json({ filter: serializeChargeFilter(filter, charge.code) }, { requestId });
}

async function mutateFilter(
  externalId: string,
  chargeCode: string,
  mutation: Mutation,
  env: Env,
  auth: AuthContext,
  requestId: string,
): Promise<Response> {
  const current = await requireSubscriptionCharge(
    env.BILLING_DB,
    auth.organizationId,
    externalId,
    chargeCode,
  );
  if (current.plan.parent_id === null) {
    return createPlanOverride(current.plan, current.charge, mutation, env, auth, requestId);
  }
  return mutateExistingOverride(current.plan, current.charge, mutation, env, auth, requestId);
}

async function createPlanOverride(
  plan: SubscriptionPlanRow,
  targetCharge: GraphChargeRow,
  mutation: Mutation,
  env: Env,
  auth: AuthContext,
  requestId: string,
): Promise<Response> {
  const originalFilters = chargeFilters(targetCharge);
  if (mutation.kind !== "create") requireFilter(targetCharge, mutation.filterId);
  let resultFilter: ChargeFilter | null = null;
  let childTargetChargeId = "";
  const prepared = await preparePlanOverrideGraph(plan, env, auth.organizationId, {
    charge: async (source, clone) => {
      if (source.id !== targetCharge.id) return clone;
      const clonedFilters = chargeFiltersFromJson(clone.filtersJson, source, clone.id);
      const nextFilters = await applyMutation(
        source,
        clonedFilters,
        originalFilters,
        mutation,
        clone.id,
      );
      childTargetChargeId = clone.id;
      resultFilter = mutationResult(originalFilters, clonedFilters, nextFilters, mutation);
      return { ...clone, filtersJson: stableJson(nextFilters) };
    },
  });
  if (!childTargetChargeId) {
    throw new ApiError(409, "charge_version_conflict", "Charge changed concurrently");
  }
  const now = new Date().toISOString();
  const subscriptionEvent = domainEvent(
    "subscription.updated",
    "subscription",
    plan.subscription_id,
    plan.subscription_version + 1,
    auth.organizationId,
    requestId,
    now,
    { planCode: plan.code, planId: prepared.childPlanId },
  );
  const chargeEvent = domainEvent(
    "charge.updated",
    "charge",
    childTargetChargeId,
    1,
    auth.organizationId,
    requestId,
    now,
    { code: targetCharge.code, planCode: plan.code, subscriptionId: plan.subscription_id },
  );
  await persistPlanOverrideGraph(
    plan,
    prepared,
    subscriptionEvent,
    chargeEvent,
    "charge",
    [],
    null,
    now,
    env,
    auth,
  );
  if (!resultFilter)
    throw new ApiError(500, "persistence_error", "Charge filter was not persisted");
  return json({ filter: serializeChargeFilter(resultFilter, targetCharge.code) }, { requestId });
}

async function createFixedChargePlanOverride(
  plan: SubscriptionPlanRow,
  targetFixedCharge: GraphFixedChargeRow,
  normalized: NormalizedFixedChargeOverride,
  env: Env,
  auth: AuthContext,
  requestId: string,
): Promise<Response> {
  let childTargetId = "";
  const prepared = await preparePlanOverrideGraph(plan, env, auth.organizationId, {
    fixedCharge: async (source, clone) => {
      if (source.id !== targetFixedCharge.id) return clone;
      childTargetId = clone.id;
      return {
        ...clone,
        invoiceDisplayName: normalized.invoiceDisplayName,
        propertiesJson: stableJson(normalized.properties),
        units: normalized.units,
      };
    },
  });
  if (!childTargetId) {
    throw new ApiError(409, "fixed_charge_version_conflict", "Fixed charge changed concurrently");
  }
  const targetTaxes =
    normalized.taxCodes === undefined
      ? null
      : await resolveActiveTaxes(env.BILLING_DB, auth.organizationId, normalized.taxCodes);
  const now = new Date().toISOString();
  const unitEvents = await prepareFixedChargeUnitEvents(
    plan,
    childTargetId,
    targetFixedCharge.units,
    normalized.units,
    1,
    normalized.applyUnitsImmediately,
    now,
  );
  const subscriptionEvent = domainEvent(
    "subscription.updated",
    "subscription",
    plan.subscription_id,
    plan.subscription_version + 1,
    auth.organizationId,
    requestId,
    now,
    { planCode: plan.code, planId: prepared.childPlanId },
  );
  const fixedChargeEvent = domainEvent(
    "fixed_charge.updated",
    "fixed_charge",
    childTargetId,
    1,
    auth.organizationId,
    requestId,
    now,
    { code: targetFixedCharge.code, planCode: plan.code, subscriptionId: plan.subscription_id },
  );
  await persistPlanOverrideGraph(
    plan,
    prepared,
    subscriptionEvent,
    fixedChargeEvent,
    "fixed_charge",
    unitEvents,
    targetTaxes ? { targetId: childTargetId, taxes: targetTaxes } : null,
    now,
    env,
    auth,
  );
  if (targetFixedCharge.pay_in_advance === 1 && normalized.applyUnitsImmediately) {
    await createPayInAdvanceFixedChargeDeltaInvoice(env, plan.subscription_id, now, requestId);
  }
  const persisted = await requireFixedChargeById(
    env.BILLING_DB,
    auth.organizationId,
    prepared.childPlanId,
    childTargetId,
  );
  return json(
    {
      fixed_charge: await serializeFixedCharge(env.BILLING_DB, auth.organizationId, persisted),
    },
    { requestId },
  );
}

async function preparePlanOverrideGraph(
  plan: SubscriptionPlanRow,
  env: Env,
  organizationId: string,
  transforms: OverrideGraphTransforms,
): Promise<PreparedPlanOverrideGraph> {
  const charges = await env.BILLING_DB.prepare(
    `${graphChargeSelect()} WHERE ch.plan_id = ? AND ch.active = 1
     ORDER BY ch.created_at, ch.id LIMIT ?`,
  )
    .bind(plan.plan_id, MAX_GRAPH_CHARGES + 1)
    .all<GraphChargeRow>();
  if (charges.results.length > MAX_GRAPH_CHARGES) {
    throw new ApiError(
      422,
      "plan_override_too_large",
      `Subscription plan overrides support at most ${MAX_GRAPH_CHARGES} usage charges`,
    );
  }
  const fixedCharges = await env.BILLING_DB.prepare(
    `${graphFixedChargeSelect()} WHERE fc.plan_id = ? AND fc.active = 1
     ORDER BY fc.created_at, fc.id LIMIT ?`,
  )
    .bind(plan.plan_id, MAX_GRAPH_FIXED_CHARGES + 1)
    .all<GraphFixedChargeRow>();
  if (fixedCharges.results.length > MAX_GRAPH_FIXED_CHARGES) {
    throw new ApiError(
      422,
      "plan_override_too_large",
      `Subscription plan overrides support at most ${MAX_GRAPH_FIXED_CHARGES} fixed charges`,
    );
  }
  const childPlanId = await deterministicUuid(
    "subscription-plan-override",
    `${plan.subscription_id}:${plan.plan_id}`,
  );
  const commitment = await env.BILLING_DB.prepare(
    `SELECT id, amount_minor, invoice_display_name
     FROM minimum_commitments WHERE organization_id = ? AND plan_id = ? LIMIT 1`,
  )
    .bind(organizationId, plan.plan_id)
    .first<{ id: string; amount_minor: number; invoice_display_name: string | null }>();
  const clonedCommitment = commitment
    ? {
        id: await deterministicUuid(
          "subscription-commitment-override",
          `${childPlanId}:${commitment.id}`,
        ),
        parentId: commitment.id,
        amountMinor: commitment.amount_minor,
        invoiceDisplayName: commitment.invoice_display_name,
      }
    : null;
  const nextVersion = await nextPlanVersion(env.BILLING_DB, organizationId, plan.code);
  const clonedCharges: ClonedGraphCharge[] = [];
  for (const source of charges.results) {
    const id = await deterministicUuid(
      "subscription-charge-override",
      `${childPlanId}:${source.id}`,
    );
    const clone: ClonedGraphCharge = {
      id,
      parentId: source.id,
      billableMetricId: source.billable_metric_id,
      code: source.code,
      invoiceDisplayName: source.invoice_display_name,
      chargeModel: source.charge_model,
      propertiesJson: source.properties_json,
      filtersJson: stableJson(await cloneFilters(source, id)),
      invoiceable: source.invoiceable,
      payInAdvance: source.pay_in_advance,
      prorated: source.prorated,
      minAmountMinor: source.min_amount_minor,
      acceptsTargetWallet: source.accepts_target_wallet,
    };
    clonedCharges.push(transforms.charge ? await transforms.charge(source, clone) : clone);
  }
  const clonedFixedCharges: ClonedGraphFixedCharge[] = [];
  for (const source of fixedCharges.results) {
    const clone: ClonedGraphFixedCharge = {
      id: await deterministicUuid(
        "subscription-fixed-charge-override",
        `${childPlanId}:${source.id}`,
      ),
      parentId: source.id,
      addOnId: source.add_on_id,
      code: source.code,
      invoiceDisplayName: source.invoice_display_name,
      chargeModel: source.charge_model,
      propertiesJson: source.properties_json,
      units: source.units,
      payInAdvance: source.pay_in_advance,
      prorated: source.prorated,
    };
    clonedFixedCharges.push(
      transforms.fixedCharge ? await transforms.fixedCharge(source, clone) : clone,
    );
  }
  const chargesJson = stableJson(clonedCharges);
  const fixedChargesJson = stableJson(clonedFixedCharges);
  if (
    new TextEncoder().encode(chargesJson).byteLength +
      new TextEncoder().encode(fixedChargesJson).byteLength >
    MAX_GRAPH_JSON_BYTES
  ) {
    throw new ApiError(
      422,
      "plan_override_too_large",
      "Subscription plan override pricing data exceeds the supported size",
    );
  }
  return { childPlanId, nextVersion, clonedCharges, clonedFixedCharges, clonedCommitment };
}

async function persistPlanOverrideGraph(
  plan: SubscriptionPlanRow,
  prepared: PreparedPlanOverrideGraph,
  subscriptionEvent: DomainEvent,
  mutationEvent: DomainEvent,
  mutationKind: "charge" | "fixed_charge",
  unitEvents: FixedChargeUnitEventInput[],
  fixedChargeTaxOverride: { targetId: string; taxes: ResolvedTax[] } | null,
  now: string,
  env: Env,
  auth: AuthContext,
): Promise<void> {
  const chargesJson = stableJson(prepared.clonedCharges);
  const fixedChargesJson = stableJson(prepared.clonedFixedCharges);
  const mutationOutbox =
    mutationKind === "charge"
      ? conditionalChargeOutboxStatement(
          env.BILLING_DB,
          auth.organizationId,
          mutationEvent,
          mutationEvent.aggregateId,
          1,
          now,
        )
      : conditionalFixedChargeOutboxStatement(
          env.BILLING_DB,
          auth.organizationId,
          mutationEvent,
          mutationEvent.aggregateId,
          1,
          now,
        );
  const results = await env.BILLING_DB.batch([
    env.BILLING_DB.prepare(
      `INSERT INTO plans
       (id, organization_id, parent_id, code, name, invoice_display_name, description, interval,
        amount_minor, currency, trial_period, pay_in_advance, bill_charges_monthly,
        bill_fixed_charges_monthly, metadata_json, request_sha256, pending_deletion, version,
        active, created_at, updated_at)
       SELECT ?, organization_id, id, code, name, invoice_display_name, description, interval,
              amount_minor, currency, trial_period, pay_in_advance, bill_charges_monthly,
              bill_fixed_charges_monthly, metadata_json, NULL, 0, ?, 1, ?, ?
       FROM plans
       WHERE id = ? AND organization_id = ? AND active = 1 AND pending_deletion = 0
         AND parent_id IS NULL
         AND EXISTS (
           SELECT 1 FROM subscriptions
           WHERE id = ? AND organization_id = ? AND plan_id = ? AND version = ?
         )`,
    ).bind(
      prepared.childPlanId,
      prepared.nextVersion,
      now,
      now,
      plan.plan_id,
      auth.organizationId,
      plan.subscription_id,
      auth.organizationId,
      plan.plan_id,
      plan.subscription_version,
    ),
    env.BILLING_DB.prepare(
      `INSERT INTO charges
       (id, organization_id, parent_id, plan_id, billable_metric_id, code,
        invoice_display_name, charge_model, properties_json, filters_json, invoiceable,
        pay_in_advance, prorated, min_amount_minor, accepts_target_wallet, version, active,
        created_at, updated_at)
       SELECT json_extract(value, '$.id'), ?, json_extract(value, '$.parentId'), ?,
              json_extract(value, '$.billableMetricId'), json_extract(value, '$.code'),
              json_extract(value, '$.invoiceDisplayName'), json_extract(value, '$.chargeModel'),
              json_extract(value, '$.propertiesJson'), json_extract(value, '$.filtersJson'),
              json_extract(value, '$.invoiceable'), json_extract(value, '$.payInAdvance'),
              json_extract(value, '$.prorated'), json_extract(value, '$.minAmountMinor'),
              json_extract(value, '$.acceptsTargetWallet'), 1, 1, ?, ?
       FROM json_each(?)
       WHERE EXISTS (SELECT 1 FROM plans WHERE id = ? AND parent_id = ?)`,
    ).bind(
      auth.organizationId,
      prepared.childPlanId,
      now,
      now,
      chargesJson,
      prepared.childPlanId,
      plan.plan_id,
    ),
    env.BILLING_DB.prepare(
      `INSERT INTO fixed_charges
       (id, organization_id, parent_id, plan_id, add_on_id, code, invoice_display_name,
        charge_model, properties_json, units, pay_in_advance, prorated, version, active,
        created_at, updated_at)
       SELECT json_extract(value, '$.id'), ?, json_extract(value, '$.parentId'), ?,
              json_extract(value, '$.addOnId'), json_extract(value, '$.code'),
              json_extract(value, '$.invoiceDisplayName'), json_extract(value, '$.chargeModel'),
              json_extract(value, '$.propertiesJson'), json_extract(value, '$.units'),
              json_extract(value, '$.payInAdvance'), json_extract(value, '$.prorated'),
              1, 1, ?, ?
       FROM json_each(?)
       WHERE EXISTS (SELECT 1 FROM plans WHERE id = ? AND parent_id = ?)`,
    ).bind(
      auth.organizationId,
      prepared.childPlanId,
      now,
      now,
      fixedChargesJson,
      prepared.childPlanId,
      plan.plan_id,
    ),
    env.BILLING_DB.prepare(
      `INSERT INTO minimum_commitments
       (id, organization_id, plan_id, amount_minor, invoice_display_name, created_at, updated_at)
       SELECT ?, ?, ?, ?, ?, ?, ?
       WHERE ? IS NOT NULL AND EXISTS (
         SELECT 1 FROM plans WHERE id = ? AND parent_id = ?
       )`,
    ).bind(
      prepared.clonedCommitment?.id ?? null,
      auth.organizationId,
      prepared.childPlanId,
      prepared.clonedCommitment?.amountMinor ?? null,
      prepared.clonedCommitment?.invoiceDisplayName ?? null,
      now,
      now,
      prepared.clonedCommitment?.id ?? null,
      prepared.childPlanId,
      plan.plan_id,
    ),
    env.BILLING_DB.prepare(
      `UPDATE subscriptions SET plan_id = ?, version = version + 1, updated_at = ?
       WHERE id = ? AND organization_id = ? AND plan_id = ? AND version = ?
         AND EXISTS (SELECT 1 FROM plans WHERE id = ? AND parent_id = ?)`,
    ).bind(
      prepared.childPlanId,
      now,
      plan.subscription_id,
      auth.organizationId,
      plan.plan_id,
      plan.subscription_version,
      prepared.childPlanId,
      plan.plan_id,
    ),
    fixedChargeUnitEventInsertStatement(env.BILLING_DB, auth.organizationId, unitEvents, now),
    conditionalOutboxStatement(
      env.BILLING_DB,
      auth.organizationId,
      subscriptionEvent,
      plan.subscription_id,
      plan.subscription_version + 1,
      now,
    ),
    mutationOutbox,
    env.BILLING_DB.prepare(
      `INSERT INTO tax_targets
       (organization_id, tax_id, target_type, target_id, created_at)
       SELECT organization_id, tax_id, 'plan', ?, ? FROM tax_targets
       WHERE organization_id = ? AND target_type = 'plan' AND target_id = ?`,
    ).bind(prepared.childPlanId, now, auth.organizationId, plan.plan_id),
    env.BILLING_DB.prepare(
      `INSERT INTO tax_targets
       (organization_id, tax_id, target_type, target_id, created_at)
       SELECT target.organization_id, target.tax_id, 'charge', child.id, ?
       FROM tax_targets target JOIN charges child ON child.parent_id = target.target_id
       WHERE target.organization_id = ? AND target.target_type = 'charge'
         AND child.organization_id = ? AND child.plan_id = ?`,
    ).bind(now, auth.organizationId, auth.organizationId, prepared.childPlanId),
    env.BILLING_DB.prepare(
      `INSERT INTO tax_targets
       (organization_id, tax_id, target_type, target_id, created_at)
       SELECT target.organization_id, target.tax_id, 'fixed_charge', child.id, ?
       FROM tax_targets target JOIN fixed_charges child ON child.parent_id = target.target_id
       WHERE target.organization_id = ? AND target.target_type = 'fixed_charge'
         AND child.organization_id = ? AND child.plan_id = ?`,
    ).bind(now, auth.organizationId, auth.organizationId, prepared.childPlanId),
    env.BILLING_DB.prepare(
      `INSERT INTO tax_targets
       (organization_id, tax_id, target_type, target_id, created_at)
       SELECT organization_id, tax_id, 'commitment', ?, ? FROM tax_targets
       WHERE organization_id = ? AND target_type = 'commitment' AND target_id = ?
         AND ? IS NOT NULL`,
    ).bind(
      prepared.clonedCommitment?.id ?? "",
      now,
      auth.organizationId,
      prepared.clonedCommitment?.parentId ?? "",
      prepared.clonedCommitment?.id ?? null,
    ),
    ...(fixedChargeTaxOverride
      ? replaceTaxTargetStatements(
          env.BILLING_DB,
          auth.organizationId,
          "fixed_charge",
          fixedChargeTaxOverride.targetId,
          fixedChargeTaxOverride.taxes,
          now,
        )
      : []),
  ]);
  if (
    results[0]?.meta.changes !== 1 ||
    results[1]?.meta.changes !== prepared.clonedCharges.length ||
    results[2]?.meta.changes !== prepared.clonedFixedCharges.length ||
    results[3]?.meta.changes !== (prepared.clonedCommitment ? 1 : 0) ||
    results[4]?.meta.changes !== 1 ||
    results[5]?.meta.changes !== unitEvents.length ||
    results[6]?.meta.changes !== 1 ||
    results[7]?.meta.changes !== 1
  ) {
    throw new ApiError(409, "subscription_version_conflict", "Subscription changed concurrently");
  }
  await env.DOMAIN_EVENTS.send(subscriptionEvent);
  await env.DOMAIN_EVENTS.send(mutationEvent);
}

async function mutateExistingOverride(
  plan: SubscriptionPlanRow,
  charge: GraphChargeRow,
  mutation: Mutation,
  env: Env,
  auth: AuthContext,
  requestId: string,
): Promise<Response> {
  const filters = chargeFilters(charge);
  if (mutation.kind !== "create") requireFilter(charge, mutation.filterId);
  const next = await applyMutation(charge, filters, filters, mutation, charge.id);
  const resultFilter = mutationResult(filters, filters, next, mutation);
  const now = new Date().toISOString();
  const event = domainEvent(
    "charge.updated",
    "charge",
    charge.id,
    charge.version + 1,
    auth.organizationId,
    requestId,
    now,
    { code: charge.code, planCode: plan.code, subscriptionId: plan.subscription_id },
  );
  const results = await env.BILLING_DB.batch([
    env.BILLING_DB.prepare(
      `UPDATE charges SET filters_json = ?, version = version + 1, updated_at = ?
       WHERE id = ? AND organization_id = ? AND plan_id = ? AND active = 1 AND version = ?`,
    ).bind(stableJson(next), now, charge.id, auth.organizationId, plan.plan_id, charge.version),
    conditionalChargeOutboxStatement(
      env.BILLING_DB,
      auth.organizationId,
      event,
      charge.id,
      charge.version + 1,
      now,
    ),
  ]);
  if (results[0]?.meta.changes !== 1 || results[1]?.meta.changes !== 1) {
    throw new ApiError(409, "charge_version_conflict", "Charge changed concurrently");
  }
  await env.DOMAIN_EVENTS.send(event);
  if (!resultFilter)
    throw new ApiError(500, "persistence_error", "Charge filter was not persisted");
  return json({ filter: serializeChargeFilter(resultFilter, charge.code) }, { requestId });
}

async function mutateExistingFixedChargeOverride(
  plan: SubscriptionPlanRow,
  fixedCharge: GraphFixedChargeRow,
  normalized: NormalizedFixedChargeOverride,
  env: Env,
  auth: AuthContext,
  requestId: string,
): Promise<Response> {
  const now = new Date().toISOString();
  const nextVersion = fixedCharge.version + 1;
  const unitEvents = await prepareFixedChargeUnitEvents(
    plan,
    fixedCharge.id,
    fixedCharge.units,
    normalized.units,
    nextVersion,
    normalized.applyUnitsImmediately,
    now,
  );
  const event = domainEvent(
    "fixed_charge.updated",
    "fixed_charge",
    fixedCharge.id,
    nextVersion,
    auth.organizationId,
    requestId,
    now,
    { code: fixedCharge.code, planCode: plan.code, subscriptionId: plan.subscription_id },
  );
  const targetTaxes =
    normalized.taxCodes === undefined
      ? null
      : await resolveActiveTaxes(env.BILLING_DB, auth.organizationId, normalized.taxCodes);
  const taxStatements = targetTaxes
    ? guardedReplaceTaxTargetStatements(
        env.BILLING_DB,
        auth.organizationId,
        "fixed_charge",
        fixedCharge.id,
        targetTaxes,
        now,
        nextVersion,
      )
    : [];
  const results = await env.BILLING_DB.batch([
    env.BILLING_DB.prepare(
      `UPDATE fixed_charges
       SET invoice_display_name = ?, properties_json = ?, units = ?,
           version = version + 1, updated_at = ?
       WHERE id = ? AND organization_id = ? AND plan_id = ? AND active = 1 AND version = ?`,
    ).bind(
      normalized.invoiceDisplayName,
      stableJson(normalized.properties),
      normalized.units,
      now,
      fixedCharge.id,
      auth.organizationId,
      plan.plan_id,
      fixedCharge.version,
    ),
    ...taxStatements,
    fixedChargeUnitEventInsertStatement(env.BILLING_DB, auth.organizationId, unitEvents, now),
    conditionalFixedChargeOutboxStatement(
      env.BILLING_DB,
      auth.organizationId,
      event,
      fixedCharge.id,
      nextVersion,
      now,
    ),
  ]);
  if (
    (results[0]?.meta.changes ?? 0) < 1 ||
    (results[1 + taxStatements.length]?.meta.changes ?? 0) < (unitEvents.length === 0 ? 0 : 1) ||
    results[2 + taxStatements.length]?.meta.changes !== 1
  ) {
    throw new ApiError(409, "fixed_charge_version_conflict", "Fixed charge changed concurrently");
  }
  await env.DOMAIN_EVENTS.send(event);
  if (fixedCharge.pay_in_advance === 1 && normalized.applyUnitsImmediately) {
    await createPayInAdvanceFixedChargeDeltaInvoice(env, plan.subscription_id, now, requestId);
  }
  const persisted = await requireFixedChargeById(
    env.BILLING_DB,
    auth.organizationId,
    plan.plan_id,
    fixedCharge.id,
  );
  return json(
    {
      fixed_charge: await serializeFixedCharge(env.BILLING_DB, auth.organizationId, persisted),
    },
    { requestId },
  );
}

async function applyMutation(
  charge: GraphChargeRow,
  filters: ChargeFilter[],
  sourceFilters: ChargeFilter[],
  mutation: Mutation,
  identityScope: string,
): Promise<ChargeFilter[]> {
  const metricFilters = parseStoredBillableMetricFilters(charge.metric_filters_json);
  if (mutation.kind === "create") {
    const created = (
      await normalizeChargeFilters(
        [mutation.input],
        metricFilters,
        charge.charge_model,
        identityScope,
        `${identityScope}:subscription`,
      )
    )[0]!;
    if (filters.some((filter) => stableJson(filter.values) === stableJson(created.values))) {
      throw new ApiError(422, "value_already_exist", "Charge filter values already exist");
    }
    return [...filters, created];
  }
  const sourceIndex = sourceFilters.findIndex((filter) => filter.lagoId === mutation.filterId);
  if (sourceIndex < 0 || !filters[sourceIndex]) {
    throw new ApiError(404, "charge_filter_not_found", "Charge filter was not found");
  }
  if (mutation.kind === "delete") return filters.filter((_, index) => index !== sourceIndex);
  const current = filters[sourceIndex]!;
  const normalized = (
    await normalizeChargeFilters(
      [
        {
          invoice_display_name:
            mutation.input.invoice_display_name === undefined
              ? current.invoiceDisplayName
              : mutation.input.invoice_display_name,
          properties:
            mutation.input.properties === undefined
              ? current.properties
              : mutation.input.properties,
          values: current.values,
        },
      ],
      metricFilters,
      charge.charge_model,
      identityScope,
    )
  )[0]!;
  const updated = { ...normalized, lagoId: current.lagoId };
  return filters.map((filter, index) => (index === sourceIndex ? updated : filter));
}

function mutationResult(
  sourceFilters: ChargeFilter[],
  clonedFilters: ChargeFilter[],
  nextFilters: ChargeFilter[],
  mutation: Mutation,
): ChargeFilter | null {
  if (mutation.kind === "create") return nextFilters.at(-1) ?? null;
  const sourceIndex = sourceFilters.findIndex((filter) => filter.lagoId === mutation.filterId);
  if (sourceIndex < 0) return null;
  if (mutation.kind === "delete") return clonedFilters[sourceIndex] ?? null;
  return nextFilters[sourceIndex] ?? null;
}

async function cloneFilters(
  charge: GraphChargeRow,
  childChargeId: string,
): Promise<ChargeFilter[]> {
  const filters = chargeFilters(charge);
  return Promise.all(
    filters.map(async (filter) => ({
      ...filter,
      lagoId: await deterministicUuid(
        "subscription-charge-filter-override",
        `${childChargeId}:${filter.lagoId}`,
      ),
    })),
  );
}

async function prepareFixedChargeUnitEvents(
  plan: SubscriptionPlanRow,
  fixedChargeId: string,
  previousUnits: string,
  nextUnits: string,
  fixedChargeVersion: number,
  applyUnitsImmediately: boolean,
  now: string,
): Promise<FixedChargeUnitEventInput[]> {
  if (!["active", "past_due"].includes(plan.subscription_status)) return [];
  const periodStart = plan.current_period_start ?? plan.subscription_started_at;
  const periodEnd = plan.current_period_end;
  if (
    !periodStart ||
    !periodEnd ||
    !Number.isFinite(Date.parse(periodStart)) ||
    !Number.isFinite(Date.parse(periodEnd))
  ) {
    throw new ApiError(
      409,
      "subscription_period_unavailable",
      "Subscription fixed-charge units require an active billing period",
    );
  }
  const baselineId = await deterministicUuid(
    "fixed-charge-unit-event",
    `${plan.subscription_id}:${fixedChargeId}:v0`,
  );
  const changeId = await deterministicUuid(
    "fixed-charge-unit-event",
    `${plan.subscription_id}:${fixedChargeId}:v${fixedChargeVersion}`,
  );
  return [
    {
      id: baselineId,
      subscriptionId: plan.subscription_id,
      fixedChargeId,
      fixedChargeVersion: 0,
      units: previousUnits,
      effectiveAt: periodStart,
      billImmediately: false,
    },
    {
      id: changeId,
      subscriptionId: plan.subscription_id,
      fixedChargeId,
      fixedChargeVersion,
      units: nextUnits,
      effectiveAt: applyUnitsImmediately ? now : periodEnd,
      billImmediately: applyUnitsImmediately,
    },
  ];
}

function fixedChargeUnitEventInsertStatement(
  database: D1Database,
  organizationId: string,
  unitEvents: FixedChargeUnitEventInput[],
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
         SELECT 1 FROM subscriptions s
         JOIN fixed_charges fc ON fc.plan_id = s.plan_id
         WHERE s.id = json_extract(event.value, '$.subscriptionId')
           AND s.organization_id = ?
           AND fc.id = json_extract(event.value, '$.fixedChargeId')
           AND fc.organization_id = ?
           AND fc.active = 1
       )`,
    )
    .bind(organizationId, createdAt, stableJson(unitEvents), organizationId, organizationId);
}

function chargeFiltersFromJson(
  filtersJson: string,
  source: GraphChargeRow,
  identityScope: string,
): ChargeFilter[] {
  return parseStoredChargeFilters(
    filtersJson,
    parseStoredBillableMetricFilters(source.metric_filters_json),
    source.charge_model,
    identityScope,
  );
}

async function requireSubscriptionPlan(
  database: D1Database,
  organizationId: string,
  externalId: string,
): Promise<SubscriptionPlanRow> {
  const plan = await database
    .prepare(
      `SELECT s.id AS subscription_id, s.version AS subscription_version,
              s.status AS subscription_status, s.started_at AS subscription_started_at,
              s.current_period_start, s.current_period_end, s.plan_id,
              p.parent_id, p.code, p.name, p.invoice_display_name, p.description, p.interval,
              p.amount_minor, p.currency, p.trial_period, p.pay_in_advance,
              p.bill_charges_monthly, p.bill_fixed_charges_monthly, p.metadata_json,
              p.version AS plan_version
       FROM subscriptions s JOIN plans p ON p.id = s.plan_id
       WHERE s.organization_id = ? AND s.external_id = ?
         AND (s.status IN ('active', 'past_due') OR
              (s.status = 'pending' AND s.previous_subscription_id IS NULL))
       ORDER BY CASE WHEN s.status IN ('active', 'past_due') THEN 0 ELSE 1 END,
                s.generation DESC LIMIT 1`,
    )
    .bind(organizationId, externalId)
    .first<SubscriptionPlanRow>();
  if (!plan) throw new ApiError(404, "subscription_not_found", "Subscription was not found");
  return plan;
}

async function requireSubscriptionCharge(
  database: D1Database,
  organizationId: string,
  externalId: string,
  chargeCode: string,
): Promise<{ plan: SubscriptionPlanRow; charge: GraphChargeRow }> {
  const plan = await requireSubscriptionPlan(database, organizationId, externalId);
  const charge = await database
    .prepare(
      `${graphChargeSelect()} WHERE ch.plan_id = ? AND ch.code = ? AND ch.active = 1 LIMIT 1`,
    )
    .bind(plan.plan_id, chargeCode)
    .first<GraphChargeRow>();
  if (!charge) throw new ApiError(404, "charge_not_found", "Charge was not found");
  return { plan, charge };
}

async function requireSubscriptionFixedCharge(
  database: D1Database,
  organizationId: string,
  externalId: string,
  fixedChargeCode: string,
): Promise<{ plan: SubscriptionPlanRow; fixedCharge: GraphFixedChargeRow }> {
  const plan = await requireSubscriptionPlan(database, organizationId, externalId);
  const fixedCharge = await database
    .prepare(
      `${graphFixedChargeSelect()}
       WHERE fc.plan_id = ? AND fc.code = ? AND fc.active = 1 LIMIT 1`,
    )
    .bind(plan.plan_id, fixedChargeCode)
    .first<GraphFixedChargeRow>();
  if (!fixedCharge) throw new ApiError(404, "fixed_charge_not_found", "Fixed charge was not found");
  return { plan, fixedCharge };
}

async function requireFixedChargeById(
  database: D1Database,
  organizationId: string,
  planId: string,
  fixedChargeId: string,
): Promise<GraphFixedChargeRow> {
  const fixedCharge = await database
    .prepare(
      `${graphFixedChargeSelect()}
       WHERE fc.organization_id = ? AND fc.plan_id = ? AND fc.id = ? AND fc.active = 1 LIMIT 1`,
    )
    .bind(organizationId, planId, fixedChargeId)
    .first<GraphFixedChargeRow>();
  if (!fixedCharge) throw new ApiError(500, "persistence_error", "Fixed charge was not persisted");
  return fixedCharge;
}

function graphChargeSelect(): string {
  return `SELECT ch.id, ch.billable_metric_id, ch.code, ch.invoice_display_name,
                 ch.charge_model, ch.properties_json, ch.filters_json,
                 bm.filters_json AS metric_filters_json, ch.invoiceable, ch.pay_in_advance,
                 ch.prorated, ch.min_amount_minor, ch.accepts_target_wallet,
                 ch.version
          FROM charges ch JOIN billable_metrics bm ON bm.id = ch.billable_metric_id`;
}

function graphFixedChargeSelect(): string {
  return `SELECT fc.id, fc.parent_id, fc.add_on_id, ao.code AS add_on_code, fc.code,
                 fc.invoice_display_name, fc.charge_model, fc.properties_json, fc.units,
                 fc.pay_in_advance, fc.prorated, fc.version, fc.created_at
          FROM fixed_charges fc JOIN add_ons ao ON ao.id = fc.add_on_id`;
}

async function serializeFixedCharge(
  database: D1Database,
  organizationId: string,
  charge: GraphFixedChargeRow,
): Promise<Record<string, unknown>> {
  const taxes = await taxesForTarget(database, organizationId, "fixed_charge", charge.id);
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
    taxes: taxes.map((tax) => ({
      lago_id: tax.id,
      code: tax.code,
      name: tax.name,
      description: tax.description,
      rate: Number(tax.rate),
    })),
  };
}

function normalizeFixedChargeOverride(
  current: GraphFixedChargeRow,
  input: Record<string, unknown>,
): NormalizedFixedChargeOverride {
  if (
    input.apply_units_immediately !== undefined &&
    typeof input.apply_units_immediately !== "boolean"
  ) {
    throw new ApiError(422, "validation_error", "apply_units_immediately must be boolean");
  }
  const taxCodes = normalizeTaxCodes(input.tax_codes);
  for (const field of ["id", "parent_id", "code", "add_on_id", "add_on_code"]) {
    if (input[field] !== undefined && input[field] !== null) {
      throw new ApiError(
        422,
        "unsupported_fixed_charge_feature",
        `${field} cannot be changed by a subscription fixed-charge override`,
      );
    }
  }
  if (input.charge_model !== undefined && input.charge_model !== current.charge_model) {
    throw new ApiError(
      422,
      "unsupported_fixed_charge_feature",
      "A subscription fixed-charge override cannot change its charge model",
    );
  }
  for (const [field, currentValue] of [
    ["pay_in_advance", current.pay_in_advance === 1],
    ["prorated", current.prorated === 1],
  ] as const) {
    if (input[field] !== undefined && input[field] !== currentValue) {
      throw new ApiError(
        422,
        "unsupported_fixed_charge_feature",
        `A subscription fixed-charge override cannot change ${field}`,
      );
    }
  }
  const invoiceDisplayName =
    input.invoice_display_name === undefined
      ? current.invoice_display_name
      : optionalString(input, "invoice_display_name");
  const properties =
    input.properties === undefined
      ? parseObject(current.properties_json)
      : optionalObject(input.properties, "properties");
  const units =
    input.units === undefined
      ? nonNegativeDecimal(current.units, "units")
      : nonNegativeDecimal(input.units, "units");
  try {
    const rated = Decimal.parse(
      rateCharge(units, parseChargeModel(current.charge_model, properties)).amountCents,
    );
    if (rated.isNegative()) throw new Error("negative");
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError(422, "validation_error", "Fixed charge has invalid rating properties");
  }
  return {
    invoiceDisplayName,
    properties,
    units,
    applyUnitsImmediately: input.apply_units_immediately === true,
    taxCodes,
  };
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

function nonNegativeDecimal(value: unknown, field: string): string {
  if (typeof value !== "string" && typeof value !== "number") {
    throw new ApiError(422, "validation_error", `${field} must be a non-negative decimal`);
  }
  try {
    const decimal = Decimal.parse(value);
    if (decimal.isNegative()) throw new Error("negative");
    return decimal.toString();
  } catch {
    throw new ApiError(422, "validation_error", `${field} must be a non-negative decimal`);
  }
}

function chargeFilters(charge: GraphChargeRow): ChargeFilter[] {
  return parseStoredChargeFilters(
    charge.filters_json,
    parseStoredBillableMetricFilters(charge.metric_filters_json),
    charge.charge_model,
    charge.id,
  );
}

function requireFilter(charge: GraphChargeRow, filterId: string): ChargeFilter {
  const filter = chargeFilters(charge).find((candidate) => candidate.lagoId === filterId);
  if (!filter) throw new ApiError(404, "charge_filter_not_found", "Charge filter was not found");
  return filter;
}

async function nextPlanVersion(
  database: D1Database,
  organizationId: string,
  code: string,
): Promise<number> {
  const row = await database
    .prepare(
      "SELECT COALESCE(MAX(version), 0) + 1 AS version FROM plans WHERE organization_id = ? AND code = ?",
    )
    .bind(organizationId, code)
    .first<{ version: number }>();
  return row?.version ?? 1;
}

function domainEvent(
  type: string,
  aggregateType: string,
  id: string,
  version: number,
  organizationId: string,
  correlationId: string,
  occurredAt: string,
  payload: Record<string, unknown>,
): DomainEvent {
  const cleanPayload = Object.fromEntries(
    Object.entries(payload).filter(([, value]) => value !== undefined),
  );
  return {
    id: `${type.replaceAll(".", "-")}:${id}:v${version}`,
    type,
    version: 1,
    aggregateType,
    aggregateId: id,
    aggregateVersion: version,
    occurredAt,
    causationId: correlationId,
    correlationId,
    payload: { organizationId, ...cleanPayload },
  };
}

function conditionalOutboxStatement(
  database: D1Database,
  organizationId: string,
  event: DomainEvent,
  subscriptionId: string,
  version: number,
  updatedAt: string,
): D1PreparedStatement {
  return database
    .prepare(
      `INSERT INTO outbox_events
       (event_id, organization_id, event_type, event_version, aggregate_type, aggregate_id,
        aggregate_version, causation_id, correlation_id, payload_json, occurred_at, published_at)
       SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL
       WHERE EXISTS (
         SELECT 1 FROM subscriptions WHERE id = ? AND organization_id = ?
           AND version = ? AND updated_at = ?
       )`,
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
      subscriptionId,
      organizationId,
      version,
      updatedAt,
    );
}

function conditionalChargeOutboxStatement(
  database: D1Database,
  organizationId: string,
  event: DomainEvent,
  chargeId: string,
  version: number,
  updatedAt: string,
): D1PreparedStatement {
  return database
    .prepare(
      `INSERT INTO outbox_events
       (event_id, organization_id, event_type, event_version, aggregate_type, aggregate_id,
        aggregate_version, causation_id, correlation_id, payload_json, occurred_at, published_at)
       SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL
       WHERE EXISTS (
         SELECT 1 FROM charges WHERE id = ? AND organization_id = ?
           AND version = ? AND updated_at = ?
       )`,
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
      chargeId,
      organizationId,
      version,
      updatedAt,
    );
}

function conditionalFixedChargeOutboxStatement(
  database: D1Database,
  organizationId: string,
  event: DomainEvent,
  fixedChargeId: string,
  version: number,
  updatedAt: string,
): D1PreparedStatement {
  return database
    .prepare(
      `INSERT INTO outbox_events
       (event_id, organization_id, event_type, event_version, aggregate_type, aggregate_id,
        aggregate_version, causation_id, correlation_id, payload_json, occurred_at, published_at)
       SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL
       WHERE EXISTS (
         SELECT 1 FROM fixed_charges WHERE id = ? AND organization_id = ?
           AND active = 1 AND version = ? AND updated_at = ?
       )`,
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
      version,
      updatedAt,
    );
}

function positiveInteger(value: string | null, fallback: number): number {
  if (value === null) return fallback;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function pagination(total: number, page: number, perPage: number): Record<string, number | null> {
  const totalPages = Math.ceil(total / perPage);
  return {
    current_page: page,
    next_page: page < totalPages ? page + 1 : null,
    prev_page: page > 1 ? page - 1 : null,
    total_pages: totalPages,
    total_count: total,
  };
}
