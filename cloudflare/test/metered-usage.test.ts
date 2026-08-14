import { env, SELF } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { sha256Hex } from "../src/auth/api-key";
import { cleanupDeletedMetricEvents } from "../src/schedules/maintenance";

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
          accepts_target_wallet: true,
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
          accepts_target_wallet: true,
          properties: { amount: "10" },
        },
      },
    });
    expect(chargeReplay.status).toBe(200);
    await expect(
      api("/api/v1/plans/metered-plan/charges").then((response) => response.json()),
    ).resolves.toMatchObject({
      meta: { total_count: 1 },
      charges: [
        {
          code: "api-token-charge",
          billable_metric_code: "api_tokens",
          accepts_target_wallet: true,
        },
      ],
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
  });

  it("retires a metric graph, preserves finalized history, and safely recreates its code", async () => {
    const created = await api("/api/v1/billable_metrics", {
      method: "POST",
      body: {
        billable_metric: {
          name: "Retirable units",
          code: "retirable_units",
          aggregation_type: "sum_agg",
          field_name: "tokens",
        },
      },
    });
    expect(created.status).toBe(200);
    const originalMetricId = (await created.json<{ billable_metric: { lago_id: string } }>())
      .billable_metric.lago_id;
    const charge = await api("/api/v1/plans/metered-plan/charges", {
      method: "POST",
      body: {
        charge: {
          billable_metric_id: originalMetricId,
          code: "retirable-charge",
          charge_model: "standard",
          properties: { amount: "10" },
        },
      },
    });
    const originalChargeId = (await charge.json<{ charge: { lago_id: string } }>()).charge.lago_id;
    const usage = await createEvent("retirable-event", "2", "retirable_units");
    expect(usage.status).toBe(200);
    const usageId = (await usage.json<{ event: { lago_id: string } }>()).event.lago_id;
    const archived = await env.BILLING_DB.prepare(
      "SELECT archive_key FROM usage_events WHERE id = ?",
    )
      .bind(usageId)
      .first<{ archive_key: string }>();
    expect(archived && (await env.BILLING_ARTIFACTS.head(archived.archive_key))).not.toBeNull();

    const wallet = await api("/api/v1/wallets", {
      method: "POST",
      body: {
        wallet: {
          external_customer_id: "customer-external",
          code: "retirable-wallet",
          currency: "USD",
          rate_amount: "1",
          granted_credits: "1",
          applies_to: { billable_metric_codes: ["retirable_units"] },
        },
      },
    });
    expect(wallet.status).toBe(200);
    const walletId = (await wallet.json<{ wallet: { lago_id: string } }>()).wallet.lago_id;

    const now = "2026-08-13T01:00:00.000Z";
    await env.BILLING_DB.batch([
      env.BILLING_DB.prepare(
        `INSERT INTO invoices
         (id, organization_id, customer_id, subscription_id, number, status, payment_status,
          currency, subtotal_minor, tax_minor, credits_minor, total_due_minor, version,
          created_at, updated_at)
         VALUES ('metric-draft', 'org-usage', 'customer-usage', 'subscription-usage', NULL,
                 'draft', 'pending', 'USD', 0, 0, 0, 0, 1, ?, ?)`,
      ).bind(now, now),
      env.BILLING_DB.prepare(
        `INSERT INTO invoices
         (id, organization_id, customer_id, subscription_id, number, status, payment_status,
          currency, subtotal_minor, tax_minor, credits_minor, total_due_minor, version,
          finalized_at, created_at, updated_at)
         VALUES ('metric-finalized', 'org-usage', 'customer-usage', 'subscription-usage',
                 'INV-METRIC-FINAL', 'finalized', 'pending', 'USD', 321, 0, 0, 321, 1, ?, ?, ?)`,
      ).bind(now, now, now),
      env.BILLING_DB.prepare(
        `INSERT INTO invoice_lines
         (id, invoice_id, line_type, description, quantity_decimal, unit_amount_decimal,
          amount_minor, source_type, source_id, metadata_json, created_at)
         VALUES ('metric-final-line', 'metric-finalized', 'charge', 'Historical metric', '1',
                 '321', 321, 'charge', ?, ?, ?)`,
      ).bind(originalChargeId, JSON.stringify({ billableMetricId: originalMetricId }), now),
    ]);

    const deleted = await api("/api/v1/billable_metrics/retirable_units", { method: "DELETE" });
    expect(deleted.status).toBe(200);
    await expect(deleted.json()).resolves.toMatchObject({
      billable_metric: { lago_id: originalMetricId, code: "retirable_units" },
    });
    expect((await api("/api/v1/billable_metrics/retirable_units")).status).toBe(404);
    expect(
      (await api("/api/v1/billable_metrics/retirable_units", { method: "DELETE" })).status,
    ).toBe(404);
    expect((await api("/api/v1/plans/metered-plan/charges/retirable-charge")).status).toBe(404);
    expect((await api("/api/v1/events/retirable-event")).status).toBe(404);
    await expect(
      api("/api/v1/events?code=retirable_units").then((response) => response.json()),
    ).resolves.toMatchObject({ meta: { total_count: 0 }, events: [] });
    await expect(
      api(`/api/v1/wallets/${walletId}`).then((response) => response.json()),
    ).resolves.toMatchObject({
      wallet: { applies_to: { billable_metric_codes: [] } },
    });
    await expect(
      env.BILLING_DB.prepare(
        `SELECT metric.active AS metric_active, metric.version AS metric_version,
                charge.active AS charge_active, charge.version AS charge_version,
                event.deleted_at IS NOT NULL AS event_deleted,
                draft.ready_to_be_refreshed,
                line.amount_minor,
                (SELECT COUNT(*) FROM billable_metric_cleanup_tasks
                 WHERE billable_metric_id = metric.id) AS cleanup_tasks,
                (SELECT COUNT(*) FROM billable_metric_mutation_guards) AS mutation_guards,
                (SELECT COUNT(*) FROM outbox_events
                 WHERE aggregate_type = 'billable_metric' AND aggregate_id = metric.id
                   AND event_type = 'billable_metric.deleted') AS delete_events
         FROM billable_metrics metric
         JOIN charges charge ON charge.billable_metric_id = metric.id
         JOIN usage_events event ON event.billable_metric_id = metric.id
         JOIN invoices draft ON draft.id = 'metric-draft'
         JOIN invoice_lines line ON line.id = 'metric-final-line'
         WHERE metric.id = ? AND charge.id = ? AND event.id = ?`,
      )
        .bind(originalMetricId, originalChargeId, usageId)
        .first(),
    ).resolves.toEqual({
      charge_active: 0,
      charge_version: 2,
      cleanup_tasks: 1,
      delete_events: 1,
      event_deleted: 0,
      metric_active: 0,
      metric_version: 2,
      mutation_guards: 0,
      amount_minor: 321,
      ready_to_be_refreshed: 1,
    });

    const recreated = await api("/api/v1/billable_metrics", {
      method: "POST",
      body: {
        billable_metric: {
          name: "Retirable units v2",
          code: "retirable_units",
          aggregation_type: "sum_agg",
          field_name: "tokens",
        },
      },
    });
    expect(recreated.status).toBe(200);
    const recreatedMetricId = (await recreated.json<{ billable_metric: { lago_id: string } }>())
      .billable_metric.lago_id;
    expect(recreatedMetricId).not.toBe(originalMetricId);
    expect((await createEvent("retirable-event-v2", "3", "retirable_units")).status).toBe(200);
    await expect(
      env.BILLING_DB.prepare(
        `SELECT billable_metric_id FROM usage_events
         WHERE transaction_id = 'retirable-event-v2'`,
      ).first(),
    ).resolves.toEqual({ billable_metric_id: recreatedMetricId });

    expect(
      (await api("/api/v1/billable_metrics/retirable_units", { method: "DELETE" })).status,
    ).toBe(200);
    const third = await api("/api/v1/billable_metrics", {
      method: "POST",
      body: {
        billable_metric: {
          name: "Retirable units v3",
          code: "retirable_units",
          aggregation_type: "sum_agg",
          field_name: "tokens",
        },
      },
    });
    expect(third.status).toBe(200);
    await expect(
      env.BILLING_DB.prepare(
        `SELECT version, active FROM billable_metrics
         WHERE organization_id = 'org-usage' AND code = 'retirable_units'
         ORDER BY version`,
      ).all(),
    ).resolves.toMatchObject({
      results: [
        { active: 0, version: 2 },
        { active: 0, version: 4 },
        { active: 1, version: 5 },
      ],
    });

    await expect(cleanupDeletedMetricEvents(env)).resolves.toEqual({
      artifactsDeleted: 2,
      eventsDeleted: 2,
      tasksCompleted: 2,
    });
    expect(archived && (await env.BILLING_ARTIFACTS.head(archived.archive_key))).toBeNull();
    await expect(
      env.BILLING_DB.prepare(
        `SELECT
           (SELECT COUNT(*) FROM artifact_cleanup_tasks
            WHERE resource_type = 'usage_event') AS artifacts,
           (SELECT COUNT(*) FROM billable_metric_cleanup_tasks) AS metric_tasks,
           (SELECT deleted_at IS NOT NULL FROM usage_events WHERE id = ?) AS event_deleted`,
      )
        .bind(usageId)
        .first(),
    ).resolves.toEqual({ artifacts: 0, event_deleted: 1, metric_tasks: 0 });
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
  });

  it("updates, invalidates drafts, soft-deletes, and safely recreates standalone charges", async () => {
    const metricResponse = await api("/api/v1/billable_metrics", {
      method: "POST",
      body: {
        billable_metric: {
          name: "Mutable units",
          code: "mutable_units",
          aggregation_type: "sum_agg",
          field_name: "units",
        },
      },
    });
    const metricId = (await metricResponse.json<{ billable_metric: { lago_id: string } }>())
      .billable_metric.lago_id;
    const created = await api("/api/v1/plans/metered-plan/charges", {
      method: "POST",
      body: {
        charge: {
          billable_metric_id: metricId,
          code: "mutable-charge",
          charge_model: "standard",
          properties: { amount: "10" },
        },
      },
    });
    expect(created.status).toBe(200);
    const createdCharge = await created.json<{ charge: { lago_id: string } }>();
    const now = "2026-08-13T01:00:00.000Z";
    await env.BILLING_DB.batch([
      env.BILLING_DB.prepare(
        `INSERT INTO invoices
         (id, organization_id, customer_id, subscription_id, number, status, payment_status,
          currency, subtotal_minor, tax_minor, credits_minor, total_due_minor, version,
          created_at, updated_at)
         VALUES ('charge-draft', 'org-usage', 'customer-usage', 'subscription-usage', NULL,
                 'draft', 'pending', 'USD', 0, 0, 0, 0, 1, ?, ?)`,
      ).bind(now, now),
      env.BILLING_DB.prepare(
        `INSERT INTO invoices
         (id, organization_id, customer_id, subscription_id, number, status, payment_status,
          currency, subtotal_minor, tax_minor, credits_minor, total_due_minor, version,
          finalized_at, created_at, updated_at)
         VALUES ('charge-finalized', 'org-usage', 'customer-usage', 'subscription-usage',
                 'INV-CHARGE-FINAL', 'finalized', 'pending', 'USD', 123, 0, 0, 123, 1, ?, ?, ?)`,
      ).bind(now, now, now),
      env.BILLING_DB.prepare(
        `INSERT INTO invoice_lines
         (id, invoice_id, line_type, description, quantity_decimal, unit_amount_decimal,
          amount_minor, source_type, source_id, metadata_json, created_at)
         VALUES ('charge-final-line', 'charge-finalized', 'charge', 'Historical charge', '1',
                 '123', 123, 'charge', ?, '{}', ?)`,
      ).bind(createdCharge.charge.lago_id, now),
    ]);

    const updated = await api("/api/v1/plans/metered-plan/charges/mutable-charge", {
      method: "PUT",
      body: {
        charge: {
          code: "ignored-on-attached-plan",
          charge_model: "volume",
          invoice_display_name: "Updated usage",
          invoiceable: false,
          min_amount_cents: 999,
          accepts_target_wallet: true,
          properties: { amount: "20" },
        },
      },
    });
    expect(updated.status).toBe(200);
    await expect(updated.json()).resolves.toMatchObject({
      charge: {
        lago_id: createdCharge.charge.lago_id,
        code: "mutable-charge",
        charge_model: "standard",
        invoice_display_name: "Updated usage",
        invoiceable: true,
        min_amount_cents: 0,
        accepts_target_wallet: true,
        properties: { amount: "20" },
      },
    });
    const replay = await api("/api/v1/plans/metered-plan/charges/mutable-charge", {
      method: "PUT",
      body: {
        charge: {
          invoice_display_name: "Updated usage",
          accepts_target_wallet: true,
          properties: { amount: "20" },
        },
      },
    });
    expect(replay.status).toBe(200);
    await expect(
      env.BILLING_DB.prepare(
        `SELECT ch.version, i.ready_to_be_refreshed,
                (SELECT COUNT(*) FROM outbox_events
                 WHERE aggregate_type = 'charge' AND aggregate_id = ch.id) AS events
         FROM charges ch JOIN invoices i ON i.id = 'charge-draft'
         WHERE ch.id = ?`,
      )
        .bind(createdCharge.charge.lago_id)
        .first(),
    ).resolves.toEqual({ events: 2, ready_to_be_refreshed: 1, version: 2 });

    const deleted = await api("/api/v1/plans/metered-plan/charges/mutable-charge", {
      method: "DELETE",
    });
    expect(deleted.status).toBe(200);
    await expect(deleted.json()).resolves.toMatchObject({
      charge: { lago_id: createdCharge.charge.lago_id, code: "mutable-charge" },
    });
    expect((await api("/api/v1/plans/metered-plan/charges/mutable-charge")).status).toBe(404);
    await expect(
      env.BILLING_DB.prepare(
        "SELECT COUNT(*) AS total FROM charges WHERE code = 'mutable-charge' AND active = 1",
      ).first(),
    ).resolves.toEqual({ total: 0 });
    await expect(
      env.BILLING_DB.prepare(
        `SELECT ch.active, ch.version, il.amount_minor,
                (SELECT COUNT(*) FROM outbox_events
                 WHERE aggregate_type = 'charge' AND aggregate_id = ch.id) AS events
         FROM charges ch JOIN invoice_lines il ON il.id = 'charge-final-line'
         WHERE ch.id = ?`,
      )
        .bind(createdCharge.charge.lago_id)
        .first(),
    ).resolves.toEqual({ active: 0, amount_minor: 123, events: 3, version: 3 });

    const recreated = await api("/api/v1/plans/metered-plan/charges", {
      method: "POST",
      body: {
        charge: {
          billable_metric_id: metricId,
          code: "mutable-charge",
          charge_model: "standard",
          properties: { amount: "30" },
        },
      },
    });
    expect(recreated.status).toBe(200);
    const recreatedCharge = await recreated.json<{ charge: { lago_id: string } }>();
    expect(recreatedCharge.charge.lago_id).not.toBe(createdCharge.charge.lago_id);
    const cascadeDelete = await api("/api/v1/plans/metered-plan/charges/mutable-charge", {
      method: "DELETE",
      body: { charge: { cascade_updates: true } },
    });
    expect(cascadeDelete.status).toBe(422);
    await expect(cascadeDelete.json()).resolves.toMatchObject({
      code: "unsupported_charge_feature",
    });
    expect(
      (await api("/api/v1/plans/metered-plan/charges/mutable-charge", { method: "DELETE" })).status,
    ).toBe(200);
    expect(
      (await api("/api/v1/plans/metered-plan/charges/mutable-charge", { method: "DELETE" })).status,
    ).toBe(404);
  });

  it("updates the full supported charge shape before a plan has subscriptions", async () => {
    const [firstMetricResponse, secondMetricResponse] = await Promise.all([
      api("/api/v1/billable_metrics", {
        method: "POST",
        body: {
          billable_metric: {
            name: "Catalog metric one",
            code: "catalog_metric_one",
            aggregation_type: "sum_agg",
            field_name: "units",
          },
        },
      }),
      api("/api/v1/billable_metrics", {
        method: "POST",
        body: {
          billable_metric: {
            name: "Catalog metric two",
            code: "catalog_metric_two",
            aggregation_type: "sum_agg",
            field_name: "units",
          },
        },
      }),
    ]);
    const firstMetricId = (
      await firstMetricResponse.json<{ billable_metric: { lago_id: string } }>()
    ).billable_metric.lago_id;
    const secondMetricId = (
      await secondMetricResponse.json<{ billable_metric: { lago_id: string } }>()
    ).billable_metric.lago_id;
    expect(
      (
        await api("/api/v1/plans", {
          method: "POST",
          body: {
            plan: {
              name: "Unattached catalog",
              code: "unattached-catalog",
              interval: "monthly",
              amount_cents: 0,
              amount_currency: "USD",
            },
          },
        })
      ).status,
    ).toBe(200);
    const created = await api("/api/v1/plans/unattached-catalog/charges", {
      method: "POST",
      body: {
        charge: {
          billable_metric_id: firstMetricId,
          code: "full-mutable",
          charge_model: "standard",
          properties: { amount: "10" },
        },
      },
    });
    expect(created.status).toBe(200);
    const chargeId = (await created.json<{ charge: { lago_id: string } }>()).charge.lago_id;
    const updated = await api("/api/v1/plans/unattached-catalog/charges/full-mutable", {
      method: "PUT",
      body: {
        charge: {
          billable_metric_id: secondMetricId,
          code: "full-mutated",
          invoice_display_name: "Packages",
          charge_model: "package",
          properties: { amount: "50", package_size: "10" },
          invoiceable: false,
          min_amount_cents: 25,
          accepts_target_wallet: true,
        },
      },
    });
    expect(updated.status).toBe(200);
    await expect(updated.json()).resolves.toMatchObject({
      charge: {
        lago_id: chargeId,
        lago_billable_metric_id: secondMetricId,
        billable_metric_code: "catalog_metric_two",
        code: "full-mutated",
        invoice_display_name: "Packages",
        charge_model: "package",
        properties: { amount: "50", package_size: "10" },
        invoiceable: false,
        min_amount_cents: 25,
        accepts_target_wallet: true,
      },
    });
    expect((await api("/api/v1/plans/unattached-catalog/charges/full-mutable")).status).toBe(404);
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
