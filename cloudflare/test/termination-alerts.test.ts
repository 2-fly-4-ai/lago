import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { enqueueTerminationAlerts } from "../src/billing/termination-alerts";

beforeAll(async () => {
  const now = "2026-08-01T00:00:00.000Z";
  await env.BILLING_DB.batch([
    env.BILLING_DB.prepare(
      `INSERT INTO organizations (id, external_id, name, created_at, updated_at)
       VALUES ('org-termination-alert', 'org-termination-alert', 'Termination Alert', ?, ?)`,
    ).bind(now, now),
    env.BILLING_DB.prepare(
      `INSERT INTO customers
       (id, organization_id, external_id, currency, metadata_json, created_at, updated_at)
       VALUES ('customer-termination-alert', 'org-termination-alert',
               'customer-termination-alert', 'USD', '{}', ?, ?)`,
    ).bind(now, now),
    env.BILLING_DB.prepare(
      `INSERT INTO plans
       (id, organization_id, code, name, interval, amount_minor, currency, version, active,
        created_at, updated_at)
       VALUES ('plan-termination-alert', 'org-termination-alert', 'termination-alert-plan',
               'Termination Alert Plan', 'monthly', 0, 'USD', 1, 1, ?, ?)`,
    ).bind(now, now),
    ...[
      ["fifteen", "active", "2026-08-16T18:00:00.000Z"],
      ["forty-five", "active", "2026-09-15T00:00:00.000Z"],
      ["pending", "pending", "2026-08-16T00:00:00.000Z"],
      ["ten", "active", "2026-08-11T00:00:00.000Z"],
    ].map(([suffix, status, endingAt]) =>
      env.BILLING_DB.prepare(
        `INSERT INTO subscriptions
         (id, organization_id, customer_id, plan_id, external_id, status, subscription_at,
          started_at, current_period_start, current_period_end, ending_at, generation, version,
          created_at, updated_at)
         VALUES (?, 'org-termination-alert', 'customer-termination-alert',
                 'plan-termination-alert', ?, ?, ?, ?, ?, '2026-10-01T00:00:00.000Z', ?, 1, 1, ?, ?)`,
      ).bind(
        `subscription-alert-${suffix}`,
        `subscription-alert-${suffix}`,
        status,
        now,
        status === "active" ? now : null,
        status === "active" ? now : null,
        endingAt,
        now,
        now,
      ),
    ),
  ]);
});

describe("subscription termination alerts", () => {
  it("enqueues exact 15/45-day windows once per UTC day", async () => {
    await expect(
      enqueueTerminationAlerts(env.BILLING_DB, "2026-08-01T12:50:00.000Z", "alert-run"),
    ).resolves.toEqual({ candidates: 2, enqueued: 2 });
    await expect(
      enqueueTerminationAlerts(env.BILLING_DB, "2026-08-01T12:50:00.000Z", "alert-run-replay"),
    ).resolves.toEqual({ candidates: 2, enqueued: 0 });
    await expect(
      enqueueTerminationAlerts(env.BILLING_DB, "2026-08-02T12:50:00.000Z", "alert-next-day"),
    ).resolves.toEqual({ candidates: 0, enqueued: 0 });
    const alerts = await env.BILLING_DB.prepare(
      `SELECT aggregate_id, event_type, payload_json FROM outbox_events
       WHERE event_type = 'subscription.termination_alert' ORDER BY aggregate_id`,
    ).all<{ aggregate_id: string; event_type: string; payload_json: string }>();
    expect(alerts.results).toHaveLength(2);
    expect(alerts.results.map((alert) => alert.aggregate_id)).toEqual([
      "subscription-alert-fifteen",
      "subscription-alert-forty-five",
    ]);
    expect(JSON.parse(alerts.results[0]!.payload_json)).toMatchObject({
      externalSubscriptionId: "subscription-alert-fifteen",
      endingAt: "2026-08-16T18:00:00.000Z",
    });
  });
});
