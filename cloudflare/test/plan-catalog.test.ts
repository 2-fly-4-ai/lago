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
        metadata: { tier: "pro" },
        charges: [
          {
            billable_metric_id: "metric-plan-catalog",
            code: "requests-charge",
            charge_model: "standard",
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
        metadata: { tier: "pro" },
        charges: [
          {
            code: "requests-charge",
            billable_metric_code: "requests",
            charge_model: "standard",
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
    await expect(response.json()).resolves.toMatchObject({ code: "unsupported_plan_feature" });
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
