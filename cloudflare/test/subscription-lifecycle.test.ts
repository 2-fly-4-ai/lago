import { env, SELF } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { sha256Hex } from "../src/auth/api-key";

const apiKey = "subscription-lifecycle-key";
const headers = { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" };

beforeEach(async () => {
  const now = "2026-08-13T00:00:00.000Z";
  await env.BILLING_DB.batch([
    env.BILLING_DB.prepare(
      `INSERT OR IGNORE INTO organizations (id, external_id, name, created_at, updated_at)
       VALUES ('org-lifecycle', 'lifecycle', 'Lifecycle', ?, ?)`,
    ).bind(now, now),
    env.BILLING_DB.prepare(
      `INSERT OR IGNORE INTO api_keys
       (id, organization_id, key_prefix, key_hash, created_at, revoked_at)
       VALUES ('key-lifecycle', 'org-lifecycle', 'sub-life', ?, ?, NULL)`,
    ).bind(await sha256Hex(apiKey), now),
    env.BILLING_DB.prepare(
      `INSERT OR IGNORE INTO customers
       (id, organization_id, external_id, currency, metadata_json, created_at, updated_at)
       VALUES ('customer-lifecycle', 'org-lifecycle', 'customer-external', 'USD', '{}', ?, ?)`,
    ).bind(now, now),
    env.BILLING_DB.prepare(
      `INSERT OR IGNORE INTO plans
       (id, organization_id, code, name, interval, amount_minor, currency, version,
        active, created_at, updated_at)
       VALUES ('plan-lifecycle', 'org-lifecycle', 'monthly', 'Monthly', 'monthly',
               1000, 'USD', 1, 1, ?, ?)`,
    ).bind(now, now),
    env.BILLING_DB.prepare(
      `INSERT OR IGNORE INTO subscriptions
       (id, organization_id, customer_id, plan_id, external_id, status, started_at,
        current_period_start, current_period_end, version, created_at, updated_at)
       VALUES ('subscription-lifecycle', 'org-lifecycle', 'customer-lifecycle',
               'plan-lifecycle', 'subscription-external', 'active', ?, ?,
               '2026-09-13T00:00:00.000Z', 1, ?, ?)`,
    ).bind(now, now, now, now),
    env.BILLING_DB.prepare(
      `UPDATE subscriptions SET name = NULL, status = 'active', started_at = ?,
       current_period_start = ?, current_period_end = '2026-09-13T00:00:00.000Z',
       canceled_at = NULL, terminated_at = NULL, version = 1, updated_at = ?
       WHERE id = 'subscription-lifecycle'`,
    ).bind(now, now, now),
    env.BILLING_DB.prepare(
      `DELETE FROM outbox_events WHERE aggregate_id = 'subscription-lifecycle'
       AND event_type IN ('subscription.updated', 'subscription.terminated')`,
    ),
  ]);
});

describe("subscription lifecycle", () => {
  it("updates only the safe name field with an optimistic outbox event", async () => {
    const updated = await api("/api/v1/subscriptions/subscription-external", "PUT", {
      subscription: { name: "Renamed subscription" },
    });
    expect(updated.status).toBe(200);
    await expect(updated.json()).resolves.toMatchObject({
      subscription: { external_id: "subscription-external", name: "Renamed subscription" },
    });
    const event = await env.BILLING_DB.prepare(
      `SELECT event_type, aggregate_version FROM outbox_events
       WHERE event_type = 'subscription.updated' AND aggregate_id = 'subscription-lifecycle'`,
    ).first<{ event_type: string; aggregate_version: number }>();
    expect(event).toEqual({ event_type: "subscription.updated", aggregate_version: 2 });

    const guarded = await api("/api/v1/subscriptions/subscription-external", "PUT", {
      subscription: { ending_at: "2026-09-01T00:00:00.000Z" },
    });
    expect(guarded.status).toBe(422);
    await expect(guarded.json()).resolves.toMatchObject({
      code: "unsupported_subscription_feature",
    });
  });

  it("lists, shows, and idempotently terminates only with explicit no-invoice choices", async () => {
    await expect(
      apiJson("/api/v1/subscriptions?external_customer_id=customer-external"),
    ).resolves.toMatchObject({
      meta: { total_count: 1 },
      subscriptions: [{ external_id: "subscription-external", status: "active" }],
    });
    await expect(apiJson("/api/v1/subscriptions/subscription-external")).resolves.toMatchObject({
      subscription: { status: "active", plan_code: "monthly" },
    });

    const guarded = await api("/api/v1/subscriptions/subscription-external", "DELETE");
    expect(guarded.status).toBe(422);
    await expect(guarded.json()).resolves.toMatchObject({
      code: "unsupported_termination_invoicing",
    });

    const path =
      "/api/v1/subscriptions/subscription-external?on_termination_invoice=skip&on_termination_credit_note=skip";
    const first = await api(path, "DELETE");
    expect(first.status).toBe(200);
    const firstBody = await first.json<{ subscription: { terminated_at: string } }>();
    expect(firstBody.subscription.terminated_at).toBeTruthy();

    const replay = await api(path, "DELETE");
    expect(replay.status).toBe(200);
    await expect(replay.json()).resolves.toMatchObject({
      subscription: { status: "terminated", terminated_at: firstBody.subscription.terminated_at },
    });

    const counts = await env.BILLING_DB.prepare(
      `SELECT
         (SELECT COUNT(*) FROM outbox_events
          WHERE event_type = 'subscription.terminated'
            AND aggregate_id = 'subscription-lifecycle') AS events,
         (SELECT version FROM subscriptions WHERE id = 'subscription-lifecycle') AS version`,
    ).first<{ events: number; version: number }>();
    expect(counts).toEqual({ events: 1, version: 2 });
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
