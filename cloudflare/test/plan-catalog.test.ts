import { env, SELF } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { sha256Hex } from "../src/auth/api-key";

const apiKey = "plan-catalog-test-key";
const headers = { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" };

beforeEach(async () => {
  const now = "2026-08-13T00:00:00.000Z";
  await env.BILLING_DB.batch([
    env.BILLING_DB.prepare(
      `INSERT OR IGNORE INTO organizations (id, external_id, name, created_at, updated_at)
       VALUES ('org-plan-catalog', 'plan-catalog', 'Plan Catalog', ?, ?)`,
    ).bind(now, now),
    env.BILLING_DB.prepare(
      `INSERT OR IGNORE INTO api_keys
       (id, organization_id, key_prefix, key_hash, created_at, revoked_at)
       VALUES ('key-plan-catalog', 'org-plan-catalog', 'plan-cat', ?, ?, NULL)`,
    ).bind(await sha256Hex(apiKey), now),
    env.BILLING_DB.prepare(
      `INSERT OR IGNORE INTO billable_metrics
       (id, organization_id, code, name, aggregation_type, field_name, recurring,
        properties_json, version, active, created_at, updated_at)
       VALUES ('metric-plan-catalog', 'org-plan-catalog', 'requests', 'Requests',
               'count_agg', NULL, 0, '{}', 1, 1, ?, ?)`,
    ).bind(now, now),
  ]);
});

describe("Lago-compatible plan catalog", () => {
  it("atomically creates and replays a plan with embedded charges", async () => {
    const payload = {
      plan: {
        name: "Pro",
        invoice_display_name: "Pro plan",
        code: "pro",
        interval: "monthly",
        description: "Synthetic plan",
        amount_cents: 1000,
        amount_currency: "usd",
        pay_in_advance: true,
        metadata: { tier: "pro" },
        charges: [
          {
            billable_metric_id: "metric-plan-catalog",
            code: "requests-charge",
            charge_model: "standard",
            accepts_target_wallet: true,
            properties: { amount: "2.5" },
          },
        ],
      },
    };
    const first = await api("/api/v1/plans", "POST", payload);
    expect(first.status).toBe(200);
    const firstBody = await first.json<{ plan: { lago_id: string } }>();
    await expect(apiJson("/api/v1/plans/pro")).resolves.toMatchObject({
      plan: {
        lago_id: firstBody.plan.lago_id,
        code: "pro",
        amount_cents: 1000,
        amount_currency: "USD",
        pay_in_advance: true,
        metadata: { tier: "pro" },
        charges: [
          {
            code: "requests-charge",
            billable_metric_code: "requests",
            charge_model: "standard",
            accepts_target_wallet: true,
            properties: { amount: "2.5" },
          },
        ],
      },
    });

    const replay = await api("/api/v1/plans", "POST", payload);
    expect(replay.status).toBe(200);
    await expect(replay.json()).resolves.toMatchObject({
      plan: { lago_id: firstBody.plan.lago_id },
    });
    await expect(apiJson("/api/v1/plans")).resolves.toMatchObject({
      meta: { total_count: 1 },
      plans: [{ lago_id: firstBody.plan.lago_id }],
    });

    const changed = await api("/api/v1/plans", "POST", {
      plan: { ...payload.plan, amount_cents: 2000 },
    });
    expect(changed.status).toBe(422);
    await expect(changed.json()).resolves.toMatchObject({ code: "value_already_exist" });
  });

  it("fails explicitly for catalog behavior not yet implemented", async () => {
    const response = await api("/api/v1/plans", "POST", {
      plan: {
        name: "Unsupported",
        code: "unsupported",
        interval: "monthly",
        amount_cents: 100,
        amount_currency: "USD",
        tax_codes: ["vat"],
      },
    });
    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toMatchObject({ code: "unsupported_tax_target" });
  });

  it("updates safe scalar fields, retires standalone plans, and reuses codes safely", async () => {
    const payload = {
      plan: {
        name: "Mutable",
        code: "mutable",
        interval: "monthly",
        amount_cents: 100,
        amount_currency: "USD",
        pay_in_advance: true,
        metadata: { version: 1 },
      },
    };
    const created = await api("/api/v1/plans", "POST", payload);
    const planId = (await created.json<{ plan: { lago_id: string } }>()).plan.lago_id;
    const updated = await api("/api/v1/plans/mutable", "PUT", {
      plan: {
        code: "mutable-renamed",
        name: "Mutable renamed",
        invoice_display_name: "Mutable invoice",
        description: "Updated safely",
        amount_cents: 250,
        amount_currency: "EUR",
        interval: "quarterly",
        pay_in_advance: false,
        metadata: { version: 2 },
      },
    });
    expect(updated.status).toBe(200);
    await expect(updated.json()).resolves.toMatchObject({
      plan: {
        lago_id: planId,
        code: "mutable-renamed",
        name: "Mutable renamed",
        invoice_display_name: "Mutable invoice",
        description: "Updated safely",
        amount_cents: 250,
        amount_currency: "EUR",
        interval: "quarterly",
        pay_in_advance: false,
        metadata: { version: 2 },
      },
    });
    expect((await api("/api/v1/plans/mutable")).status).toBe(404);
    const events = await env.BILLING_DB.prepare(
      `SELECT event_type, aggregate_version FROM outbox_events
       WHERE aggregate_type = 'plan' AND aggregate_id = ? ORDER BY aggregate_version`,
    )
      .bind(planId)
      .all<{ event_type: string; aggregate_version: number }>();
    expect(events.results).toEqual([
      { event_type: "plan.created", aggregate_version: 1 },
      { event_type: "plan.updated", aggregate_version: 2 },
    ]);

    const graph = await api("/api/v1/plans/mutable-renamed", "PUT", {
      plan: { charges: [] },
    });
    expect(graph.status).toBe(422);
    await expect(graph.json()).resolves.toMatchObject({ code: "unsupported_plan_update" });
    const deleted = await api("/api/v1/plans/mutable-renamed", "DELETE");
    expect(deleted.status).toBe(200);
    await expect(deleted.json()).resolves.toMatchObject({
      plan: { lago_id: planId, code: "mutable-renamed" },
    });
    expect((await api("/api/v1/plans/mutable-renamed")).status).toBe(404);
    expect((await api("/api/v1/plans/mutable-renamed", "DELETE")).status).toBe(404);

    const recreated = await api("/api/v1/plans", "POST", {
      plan: {
        name: "Mutable generation two",
        code: "mutable-renamed",
        interval: "monthly",
        amount_cents: 300,
        amount_currency: "USD",
      },
    });
    expect(recreated.status).toBe(200);
    const recreatedId = (await recreated.json<{ plan: { lago_id: string } }>()).plan.lago_id;
    expect(recreatedId).not.toBe(planId);
    expect((await api("/api/v1/plans/mutable-renamed", "DELETE")).status).toBe(200);
    expect(
      (
        await api("/api/v1/plans", "POST", {
          plan: {
            name: "Mutable generation three",
            code: "mutable-renamed",
            interval: "yearly",
            amount_cents: 400,
            amount_currency: "USD",
          },
        })
      ).status,
    ).toBe(200);
    await expect(
      env.BILLING_DB.prepare(
        `SELECT version, active FROM plans
         WHERE organization_id = 'org-plan-catalog' AND code = 'mutable-renamed'
         ORDER BY version`,
      ).all(),
    ).resolves.toMatchObject({
      results: [
        { active: 0, version: 3 },
        { active: 0, version: 5 },
        { active: 1, version: 6 },
      ],
    });
    await expect(
      env.BILLING_DB.prepare("SELECT COUNT(*) AS total FROM plan_mutation_guards").first(),
    ).resolves.toEqual({ total: 0 });
  });

  it("limits attached-plan updates to Rails-safe mutable scalar fields", async () => {
    await expect(
      api("/api/v1/plans", "POST", {
        plan: {
          name: "Attached",
          code: "attached",
          interval: "monthly",
          amount_cents: 100,
          amount_currency: "USD",
        },
      }),
    ).resolves.toMatchObject({ status: 200 });
    const now = "2026-08-14T00:00:00.000Z";
    await env.BILLING_DB.batch([
      env.BILLING_DB.prepare(
        `INSERT INTO customers
         (id, organization_id, external_id, currency, metadata_json, created_at, updated_at)
         VALUES ('customer-attached-plan', 'org-plan-catalog', 'customer-attached-plan',
                 'USD', '{}', ?, ?)`,
      ).bind(now, now),
      env.BILLING_DB.prepare(
        `INSERT INTO subscriptions
         (id, organization_id, customer_id, plan_id, external_id, status, version,
          created_at, updated_at)
         SELECT 'subscription-attached-plan', organization_id, 'customer-attached-plan', id,
                'subscription-attached-plan', 'active', 1, ?, ?
         FROM plans WHERE organization_id = 'org-plan-catalog' AND code = 'attached' AND active = 1`,
      ).bind(now, now),
    ]);
    const safe = await api("/api/v1/plans/attached", "PUT", {
      plan: { name: "Attached renamed", amount_cents: 150, metadata: { safe: true } },
    });
    expect(safe.status).toBe(200);
    await expect(safe.json()).resolves.toMatchObject({
      plan: { name: "Attached renamed", amount_cents: 150, metadata: { safe: true } },
    });
    const unsafe = await api("/api/v1/plans/attached", "PUT", {
      plan: { interval: "yearly" },
    });
    expect(unsafe.status).toBe(422);
    await expect(unsafe.json()).resolves.toMatchObject({ code: "plan_in_use" });
    const deleted = await api("/api/v1/plans/attached", "DELETE");
    expect(deleted.status).toBe(422);
    await expect(deleted.json()).resolves.toMatchObject({ code: "plan_in_use" });
  });

  it("retires an unused plan graph while preserving its relational catalog history", async () => {
    const addOn = await api("/api/v1/add_ons", "POST", {
      add_on: {
        name: "Plan lifecycle seats",
        code: "plan-lifecycle-seats",
        amount_cents: 100,
        amount_currency: "USD",
      },
    });
    expect(addOn.status).toBe(200);
    const addOnId = (await addOn.json<{ add_on: { lago_id: string } }>()).add_on.lago_id;
    const created = await api("/api/v1/plans", "POST", {
      plan: {
        name: "Retirable graph",
        code: "retirable-graph",
        interval: "monthly",
        amount_cents: 500,
        amount_currency: "USD",
        charges: [
          {
            billable_metric_id: "metric-plan-catalog",
            code: "retirable-usage",
            charge_model: "standard",
            properties: { amount: "2" },
          },
        ],
        fixed_charges: [
          {
            add_on_id: addOnId,
            code: "retirable-fixed",
            charge_model: "standard",
            units: "1",
            properties: { amount: "100" },
          },
        ],
        minimum_commitment: { amount_cents: 1000 },
      },
    });
    expect(created.status).toBe(200);
    const planId = (await created.json<{ plan: { lago_id: string } }>()).plan.lago_id;
    const deleted = await api("/api/v1/plans/retirable-graph", "DELETE");
    expect(deleted.status).toBe(200);
    await expect(deleted.json()).resolves.toMatchObject({
      plan: {
        lago_id: planId,
        charges: [{ code: "retirable-usage" }],
        fixed_charges: [{ code: "retirable-fixed" }],
        minimum_commitment: { amount_cents: 1000 },
      },
    });
    await expect(
      env.BILLING_DB.prepare(
        `SELECT plan.active AS plan_active, plan.version AS plan_version,
                charge.active AS charge_active, charge.version AS charge_version,
                fixed.active AS fixed_active, fixed.version AS fixed_version,
                commitment.amount_minor,
                (SELECT COUNT(*) FROM outbox_events
                 WHERE aggregate_type = 'plan' AND aggregate_id = plan.id
                   AND event_type = 'plan.deleted') AS delete_events
         FROM plans plan
         JOIN charges charge ON charge.plan_id = plan.id
         JOIN fixed_charges fixed ON fixed.plan_id = plan.id
         JOIN minimum_commitments commitment ON commitment.plan_id = plan.id
         WHERE plan.id = ?`,
      )
        .bind(planId)
        .first(),
    ).resolves.toEqual({
      amount_minor: 1000,
      charge_active: 0,
      charge_version: 2,
      delete_events: 1,
      fixed_active: 0,
      fixed_version: 2,
      plan_active: 0,
      plan_version: 2,
    });
  });

  it("creates and serializes a minimum commitment while rejecting commitment tax targeting", async () => {
    const payload = {
      plan: {
        name: "Committed",
        code: "committed",
        interval: "monthly",
        amount_cents: 100,
        amount_currency: "USD",
        minimum_commitment: {
          amount_cents: 1000,
          invoice_display_name: "Monthly minimum",
        },
      },
    };
    const created = await api("/api/v1/plans", "POST", payload);
    expect(created.status).toBe(200);
    await expect(created.json()).resolves.toMatchObject({
      plan: {
        code: "committed",
        minimum_commitment: {
          amount_cents: 1000,
          invoice_display_name: "Monthly minimum",
          interval: "monthly",
        },
      },
    });
    expect((await api("/api/v1/plans", "POST", payload)).status).toBe(200);

    const targeted = await api("/api/v1/plans", "POST", {
      plan: {
        ...payload.plan,
        code: "committed-tax",
        minimum_commitment: { amount_cents: 1000, tax_codes: ["tax"] },
      },
    });
    expect(targeted.status).toBe(422);
    await expect(targeted.json()).resolves.toMatchObject({ code: "unsupported_tax_target" });
  });
});

function api(path: string, method = "GET", body?: Record<string, unknown>): Promise<Response> {
  return SELF.fetch(`https://lago.test${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
}

async function apiJson(path: string): Promise<unknown> {
  const response = await api(path);
  expect(response.status).toBe(200);
  return response.json();
}
