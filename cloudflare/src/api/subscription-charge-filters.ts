import type { AuthContext } from "../auth/api-key";
import type { DomainEvent } from "../domain-events";
import { ApiError, json, objectAt, parseJsonObject } from "../http";
import { deterministicUuid } from "../identifiers";
import { stableJson } from "../json";
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
  add_on_id: string;
  code: string;
  invoice_display_name: string | null;
  charge_model: string;
  properties_json: string;
  units: string;
  pay_in_advance: number;
  prorated: number;
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
    `SELECT id, add_on_id, code, invoice_display_name, charge_model, properties_json, units,
            pay_in_advance, prorated
     FROM fixed_charges WHERE plan_id = ? AND active = 1
     ORDER BY created_at, id LIMIT ?`,
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
  const nextVersion = await nextPlanVersion(env.BILLING_DB, auth.organizationId, plan.code);
  let resultFilter: ChargeFilter | null = null;
  const clonedCharges: Array<Record<string, unknown>> = [];
  let childTargetChargeId = "";
  for (const charge of charges.results) {
    const childChargeId = await deterministicUuid(
      "subscription-charge-override",
      `${childPlanId}:${charge.id}`,
    );
    const clonedFilters = await cloneFilters(charge, childChargeId);
    const isTarget = charge.id === targetCharge.id;
    const nextFilters = isTarget
      ? await applyMutation(charge, clonedFilters, originalFilters, mutation, childChargeId)
      : clonedFilters;
    if (isTarget) {
      childTargetChargeId = childChargeId;
      resultFilter = mutationResult(originalFilters, clonedFilters, nextFilters, mutation);
    }
    clonedCharges.push({
      id: childChargeId,
      parentId: charge.id,
      billableMetricId: charge.billable_metric_id,
      code: charge.code,
      invoiceDisplayName: charge.invoice_display_name,
      chargeModel: charge.charge_model,
      propertiesJson: charge.properties_json,
      filtersJson: stableJson(nextFilters),
      invoiceable: charge.invoiceable,
      payInAdvance: charge.pay_in_advance,
      prorated: charge.prorated,
      minAmountMinor: charge.min_amount_minor,
      acceptsTargetWallet: charge.accepts_target_wallet,
    });
  }
  if (!childTargetChargeId) {
    throw new ApiError(409, "charge_version_conflict", "Charge changed concurrently");
  }
  const clonedFixedCharges = await Promise.all(
    fixedCharges.results.map(async (charge) => ({
      id: await deterministicUuid(
        "subscription-fixed-charge-override",
        `${childPlanId}:${charge.id}`,
      ),
      parentId: charge.id,
      addOnId: charge.add_on_id,
      code: charge.code,
      invoiceDisplayName: charge.invoice_display_name,
      chargeModel: charge.charge_model,
      propertiesJson: charge.properties_json,
      units: charge.units,
      payInAdvance: charge.pay_in_advance,
      prorated: charge.prorated,
    })),
  );
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

  const now = new Date().toISOString();
  const subscriptionEvent = domainEvent(
    "subscription.updated",
    "subscription",
    plan.subscription_id,
    plan.subscription_version + 1,
    auth.organizationId,
    requestId,
    now,
    { externalId: undefined, planCode: plan.code, planId: childPlanId },
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
      childPlanId,
      nextVersion,
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
    ).bind(auth.organizationId, childPlanId, now, now, chargesJson, childPlanId, plan.plan_id),
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
    ).bind(auth.organizationId, childPlanId, now, now, fixedChargesJson, childPlanId, plan.plan_id),
    env.BILLING_DB.prepare(
      `UPDATE subscriptions SET plan_id = ?, version = version + 1, updated_at = ?
       WHERE id = ? AND organization_id = ? AND plan_id = ? AND version = ?
         AND EXISTS (SELECT 1 FROM plans WHERE id = ? AND parent_id = ?)`,
    ).bind(
      childPlanId,
      now,
      plan.subscription_id,
      auth.organizationId,
      plan.plan_id,
      plan.subscription_version,
      childPlanId,
      plan.plan_id,
    ),
    conditionalOutboxStatement(
      env.BILLING_DB,
      auth.organizationId,
      subscriptionEvent,
      plan.subscription_id,
      plan.subscription_version + 1,
      now,
    ),
    conditionalChargeOutboxStatement(
      env.BILLING_DB,
      auth.organizationId,
      chargeEvent,
      childTargetChargeId,
      1,
      now,
    ),
  ]);
  if (
    results[0]?.meta.changes !== 1 ||
    results[1]?.meta.changes !== clonedCharges.length ||
    results[2]?.meta.changes !== clonedFixedCharges.length ||
    results[3]?.meta.changes !== 1 ||
    results[4]?.meta.changes !== 1 ||
    results[5]?.meta.changes !== 1
  ) {
    throw new ApiError(409, "subscription_version_conflict", "Subscription changed concurrently");
  }
  await env.DOMAIN_EVENTS.send(subscriptionEvent);
  await env.DOMAIN_EVENTS.send(chargeEvent);
  if (!resultFilter)
    throw new ApiError(500, "persistence_error", "Charge filter was not persisted");
  return json({ filter: serializeChargeFilter(resultFilter, targetCharge.code) }, { requestId });
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

async function requireSubscriptionCharge(
  database: D1Database,
  organizationId: string,
  externalId: string,
  chargeCode: string,
): Promise<{ plan: SubscriptionPlanRow; charge: GraphChargeRow }> {
  const plan = await database
    .prepare(
      `SELECT s.id AS subscription_id, s.version AS subscription_version, s.plan_id,
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
  const charge = await database
    .prepare(
      `${graphChargeSelect()} WHERE ch.plan_id = ? AND ch.code = ? AND ch.active = 1 LIMIT 1`,
    )
    .bind(plan.plan_id, chargeCode)
    .first<GraphChargeRow>();
  if (!charge) throw new ApiError(404, "charge_not_found", "Charge was not found");
  return { plan, charge };
}

function graphChargeSelect(): string {
  return `SELECT ch.id, ch.billable_metric_id, ch.code, ch.invoice_display_name,
                 ch.charge_model, ch.properties_json, ch.filters_json,
                 bm.filters_json AS metric_filters_json, ch.invoiceable, ch.pay_in_advance,
                 ch.prorated, ch.min_amount_minor, ch.accepts_target_wallet,
                 ch.version
          FROM charges ch JOIN billable_metrics bm ON bm.id = ch.billable_metric_id`;
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
