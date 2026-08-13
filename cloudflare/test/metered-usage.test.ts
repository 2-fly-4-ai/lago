import { env, SELF } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { sha256Hex } from "../src/auth/api-key";

const apiKey = "metered-usage-test-key";
const headers = { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" };

beforeEach(async () => {
  const now = "2026-08-13T00:00:00.000Z";
  await env.BILLING_DB.batch([
    env.BILLING_DB.prepare(
      `INSERT OR IGNORE INTO organizations (id, external_id, name, created_at, updated_at)
       VALUES ('org-usage', 'usage-test', 'Usage Test', ?, ?)`,
    ).bind(now, now),
    env.BILLING_DB.prepare(
      `INSERT OR IGNORE INTO api_keys
       (id, organization_id, key_prefix, key_hash, created_at, revoked_at)
       VALUES ('key-usage', 'org-usage', 'metered-', ?, ?, NULL)`,
    ).bind(await sha256Hex(apiKey), now),
    env.BILLING_DB.prepare(
      `INSERT OR IGNORE INTO customers
       (id, organization_id, external_id, email, name, currency, metadata_json, created_at, updated_at)
       VALUES ('customer-usage', 'org-usage', 'customer-external', 'person@example.test',
               'Usage Customer', 'USD', '{}', ?, ?)`,
    ).bind(now, now),
    env.BILLING_DB.prepare(
      `INSERT OR IGNORE INTO plans
       (id, organization_id, code, name, interval, amount_minor, currency, version,
        active, created_at, updated_at)
       VALUES ('plan-usage', 'org-usage', 'metered-plan', 'Metered Plan', 'monthly', 0,
               'USD', 1, 1, ?, ?)`,
    ).bind(now, now),
    env.BILLING_DB.prepare(
      `INSERT OR IGNORE INTO subscriptions
       (id, organization_id, customer_id, plan_id, external_id, status, started_at,
        current_period_start, current_period_end, version, created_at, updated_at)
       VALUES ('subscription-usage', 'org-usage', 'customer-usage', 'plan-usage',
               'subscription-external', 'active', '2026-08-01T00:00:00.000Z',
               '2026-08-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z', 1, ?, ?)`,
    ).bind(now, now),
  ]);
});

describe("Lago-compatible metered usage", () => {
  it("creates configuration, deduplicates events, archives them, and rates exact usage", async () => {
    const metricResponse = await api("/api/v1/billable_metrics", {
      method: "POST",
      body: {
        billable_metric: {
          name: "API tokens",
          code: "api_tokens",
          aggregation_type: "sum_agg",
          field_name: "tokens",
        },
      },
    });
    expect(metricResponse.status).toBe(200);
    const metric = await metricResponse.json<{ billable_metric: { lago_id: string } }>();

    const chargeResponse = await api("/api/v1/plans/metered-plan/charges", {
      method: "POST",
      body: {
        charge: {
          billable_metric_id: metric.billable_metric.lago_id,
          code: "api-token-charge",
          charge_model: "standard",
          properties: { amount: "10" },
        },
      },
    });
    expect(chargeResponse.status).toBe(200);

    const first = await createEvent("event-one", "0.1");
    expect(first.status).toBe(200);
    const firstBody = await first.json<{ event: { lago_id: string; timestamp: string } }>();
    expect(firstBody.event.timestamp).toBe("2026-08-13T00:00:00.000Z");

    const replay = await createEvent("event-one", "0.1");
    await expect(replay.json<{ event: { lago_id: string } }>()).resolves.toMatchObject({
      event: { lago_id: firstBody.event.lago_id },
    });
    const conflict = await createEvent("event-one", "9");
    expect(conflict.status).toBe(409);
    await expect(conflict.json()).resolves.toMatchObject({ code: "event_idempotency_conflict" });

    expect((await createEvent("event-two", "0.2")).status).toBe(200);
    const eventRow = await env.BILLING_DB.prepare(
      "SELECT archive_key, request_sha256 FROM usage_events WHERE id = ?",
    )
      .bind(firstBody.event.lago_id)
      .first<{ archive_key: string; request_sha256: string }>();
    expect(eventRow?.request_sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(eventRow && (await env.BILLING_ARTIFACTS.head(eventRow.archive_key))).not.toBeNull();

    const usage = await api(
      "/api/v1/customers/customer-external/current_usage?external_subscription_id=subscription-external",
    );
    expect(usage.status).toBe(200);
    await expect(usage.json()).resolves.toMatchObject({
      customer_usage: {
        amount_cents: 3,
        total_amount_cents: 3,
        charges_usage: [
          {
            units: "0.3",
            events_count: 2,
            amount_cents: 3,
            billable_metric: { code: "api_tokens", aggregation_type: "sum_agg" },
            charge: { charge_model: "standard" },
          },
        ],
      },
    });

    const listed = await api(
      "/api/v1/events?code=api_tokens&external_subscription_id=subscription-external",
    );
    expect(listed.status).toBe(200);
    await expect(listed.json()).resolves.toMatchObject({ meta: { total_count: 2 } });
  });

  it("rejects unknown subscriptions, metrics, and malformed aggregation properties", async () => {
    const missingMetric = await createEvent("missing-metric", "1", "absent_metric");
    expect(missingMetric.status).toBe(404);
    await expect(missingMetric.json()).resolves.toMatchObject({
      code: "billable_metric_not_found",
    });

    const metricResponse = await api("/api/v1/billable_metrics", {
      method: "POST",
      body: {
        billable_metric: {
          name: "Units",
          code: "invalid_tokens",
          aggregation_type: "sum_agg",
          field_name: "tokens",
        },
      },
    });
    expect(metricResponse.status).toBe(200);

    const invalid = await api("/api/v1/events", {
      method: "POST",
      body: {
        event: {
          transaction_id: "invalid-value",
          code: "invalid_tokens",
          external_subscription_id: "subscription-external",
          timestamp: 1786579200,
          properties: { tokens: "not-a-number" },
        },
      },
    });
    expect(invalid.status).toBe(422);

    const unknownSubscription = await api("/api/v1/events", {
      method: "POST",
      body: {
        event: {
          transaction_id: "unknown-subscription",
          code: "invalid_tokens",
          external_subscription_id: "does-not-exist",
          timestamp: 1786579200,
          properties: { tokens: "1" },
        },
      },
    });
    expect(unknownSubscription.status).toBe(404);
    await expect(unknownSubscription.json()).resolves.toMatchObject({
      code: "subscription_not_found",
    });
  });
});

async function createEvent(
  transactionId: string,
  tokens: string,
  code = "api_tokens",
): Promise<Response> {
  return api("/api/v1/events", {
    method: "POST",
    body: {
      event: {
        transaction_id: transactionId,
        code,
        external_subscription_id: "subscription-external",
        timestamp: 1786579200,
        properties: { tokens },
      },
    },
  });
}

async function api(
  path: string,
  options: { method?: string; body?: Record<string, unknown> } = {},
): Promise<Response> {
  return SELF.fetch(`https://lago.test${path}`, {
    method: options.method ?? "GET",
    headers,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
}
