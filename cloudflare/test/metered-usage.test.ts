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
    const metricReplay = await api("/api/v1/billable_metrics", {
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
    await expect(metricReplay.json()).resolves.toMatchObject({
      billable_metric: { lago_id: metric.billable_metric.lago_id },
    });

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
    const chargeReplay = await api("/api/v1/plans/metered-plan/charges", {
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
    expect(chargeReplay.status).toBe(200);
    await expect(
      api("/api/v1/plans/metered-plan/charges").then((response) => response.json()),
    ).resolves.toMatchObject({
      meta: { total_count: 1 },
      charges: [{ code: "api-token-charge", billable_metric_code: "api_tokens" }],
    });
    await expect(
      api("/api/v1/plans/metered-plan/charges/api-token-charge").then((response) =>
        response.json(),
      ),
    ).resolves.toMatchObject({
      charge: {
        code: "api-token-charge",
        charge_model: "standard",
        properties: { amount: "10" },
      },
    });
    const chargeEvent = await env.BILLING_DB.prepare(
      `SELECT event_type FROM outbox_events
       WHERE aggregate_type = 'charge' AND event_type = 'charge.created'`,
    ).first<{ event_type: string }>();
    expect(chargeEvent?.event_type).toBe("charge.created");

    const safeUpdate = await api("/api/v1/billable_metrics/api_tokens", {
      method: "PUT",
      body: { billable_metric: { name: "API tokens renamed", description: "Attached safely" } },
    });
    expect(safeUpdate.status).toBe(200);
    await expect(safeUpdate.json()).resolves.toMatchObject({
      billable_metric: {
        lago_id: metric.billable_metric.lago_id,
        code: "api_tokens",
        name: "API tokens renamed",
        description: "Attached safely",
      },
    });
    const unsafeUpdate = await api("/api/v1/billable_metrics/api_tokens", {
      method: "PUT",
      body: { billable_metric: { code: "api_tokens_changed" } },
    });
    expect(unsafeUpdate.status).toBe(422);
    await expect(unsafeUpdate.json()).resolves.toMatchObject({ code: "billable_metric_in_use" });

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
    const catalogEvents = await env.BILLING_DB.prepare(
      `SELECT event_type, aggregate_version FROM outbox_events
       WHERE aggregate_type = 'billable_metric' AND aggregate_id = ? ORDER BY aggregate_version`,
    )
      .bind(metric.billable_metric.lago_id)
      .all<{ event_type: string; aggregate_version: number }>();
    expect(catalogEvents.results).toEqual([
      { event_type: "billable_metric.created", aggregate_version: 1 },
      { event_type: "billable_metric.updated", aggregate_version: 2 },
    ]);
  });

  it("atomically ingests, archives, and exposes batches while rejecting partial writes", async () => {
    const metric = await api("/api/v1/billable_metrics", {
      method: "POST",
      body: {
        billable_metric: {
          name: "Batch tokens",
          code: "batch_tokens",
          aggregation_type: "sum_agg",
          field_name: "tokens",
        },
      },
    });
    expect(metric.status).toBe(200);
    const events = [
      {
        transaction_id: "batch-one",
        code: "batch_tokens",
        external_subscription_id: "subscription-external",
        timestamp: 1786579200,
        properties: { tokens: "1.25" },
      },
      {
        transaction_id: "batch-two",
        code: "batch_tokens",
        external_subscription_id: "subscription-external",
        timestamp: 1786579260,
        properties: { tokens: "2.75" },
      },
    ];
    const batch = await api("/api/v1/events/batch", { method: "POST", body: { events } });
    expect(batch.status).toBe(200);
    await expect(batch.json()).resolves.toMatchObject({
      events: [
        { transaction_id: "batch-one", external_subscription_id: "subscription-external" },
        { transaction_id: "batch-two", external_subscription_id: "subscription-external" },
      ],
    });
    const evidence = await env.BILLING_DB.prepare(
      `SELECT
         (SELECT COUNT(*) FROM usage_events
          WHERE transaction_id IN ('batch-one', 'batch-two')) AS events,
         (SELECT COUNT(*) FROM outbox_events
          WHERE event_type = 'usage_event.ingested'
            AND aggregate_id IN (
              SELECT id FROM usage_events WHERE transaction_id IN ('batch-one', 'batch-two')
            )) AS outbox_events`,
    ).first<{ events: number; outbox_events: number }>();
    expect(evidence).toEqual({ events: 2, outbox_events: 2 });
    const archives = await env.BILLING_DB.prepare(
      `SELECT archive_key FROM usage_events
       WHERE transaction_id IN ('batch-one', 'batch-two') ORDER BY transaction_id`,
    ).all<{ archive_key: string }>();
    await expect(
      Promise.all(archives.results.map((event) => env.BILLING_ARTIFACTS.head(event.archive_key))),
    ).resolves.toEqual([expect.anything(), expect.anything()]);
    await expect(
      api("/api/v1/events/batch-one").then((response) => response.json()),
    ).resolves.toMatchObject({
      event: { transaction_id: "batch-one", properties: { tokens: "1.25" } },
    });

    const replay = await api("/api/v1/events/batch", { method: "POST", body: { events } });
    expect(replay.status).toBe(422);
    await expect(replay.json()).resolves.toMatchObject({
      code: "batch_validation_error",
      error_details: { "0": { code: "value_already_exist" } },
    });
    const invalid = await api("/api/v1/events/batch", {
      method: "POST",
      body: {
        events: [
          { ...events[0], transaction_id: "batch-valid-but-rolled-back" },
          { ...events[1], transaction_id: "batch-invalid", timestamp: "not-a-timestamp" },
        ],
      },
    });
    expect(invalid.status).toBe(422);
    await expect(invalid.json()).resolves.toMatchObject({
      error_details: { "1": { code: "invalid_format" } },
    });
    await expect(
      env.BILLING_DB.prepare(
        "SELECT COUNT(*) AS total FROM usage_events WHERE transaction_id = 'batch-valid-but-rolled-back'",
      ).first(),
    ).resolves.toEqual({ total: 0 });
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

  it("rejects metric options the current usage engine cannot honor", async () => {
    for (const [suffix, unsupported] of [
      ["recurring", { recurring: true }],
      ["rounding", { rounding_function: "round", rounding_precision: 2 }],
      ["weighted", { weighted_interval: "seconds" }],
      ["expression", { expression: "event.properties.tokens" }],
      ["filters", { filters: [{ key: "region", values: ["us"] }] }],
    ] as const) {
      const response = await api("/api/v1/billable_metrics", {
        method: "POST",
        body: {
          billable_metric: {
            name: `Unsupported ${suffix}`,
            code: `unsupported_${suffix}`,
            aggregation_type: "sum_agg",
            field_name: "tokens",
            ...unsupported,
          },
        },
      });
      expect(response.status).toBe(422);
      await expect(response.json()).resolves.toMatchObject({
        code: "unsupported_billable_metric_feature",
      });
    }
    const deleted = await api("/api/v1/billable_metrics/anything", { method: "DELETE" });
    expect(deleted.status).toBe(422);
    await expect(deleted.json()).resolves.toMatchObject({
      code: "unsupported_billable_metric_deletion",
    });
  });

  it("rejects charge options the recurring invoice path cannot honor", async () => {
    const metricResponse = await api("/api/v1/billable_metrics", {
      method: "POST",
      body: {
        billable_metric: {
          name: "Guarded units",
          code: "guarded_units",
          aggregation_type: "sum_agg",
          field_name: "units",
        },
      },
    });
    const metricId = (await metricResponse.json<{ billable_metric: { lago_id: string } }>())
      .billable_metric.lago_id;
    for (const [suffix, unsupported] of [
      ["advance", { pay_in_advance: true }],
      ["prorated", { prorated: true }],
      ["filters", { filters: [{ properties: {}, values: {} }] }],
      ["tax", { tax_codes: ["vat"] }],
    ] as const) {
      const response = await api("/api/v1/plans/metered-plan/charges", {
        method: "POST",
        body: {
          charge: {
            billable_metric_id: metricId,
            code: `guarded-${suffix}`,
            charge_model: "standard",
            properties: { amount: "10" },
            ...unsupported,
          },
        },
      });
      expect(response.status).toBe(422);
    }
    const update = await api("/api/v1/plans/metered-plan/charges/anything", {
      method: "PUT",
      body: { charge: { invoice_display_name: "Changed" } },
    });
    expect(update.status).toBe(422);
    await expect(update.json()).resolves.toMatchObject({ code: "unsupported_charge_update" });
    const deletion = await api("/api/v1/plans/metered-plan/charges/anything", {
      method: "DELETE",
    });
    expect(deletion.status).toBe(422);
    await expect(deletion.json()).resolves.toMatchObject({ code: "unsupported_charge_deletion" });
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
