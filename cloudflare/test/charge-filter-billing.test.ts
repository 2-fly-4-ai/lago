import { env, SELF } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { sha256Hex } from "../src/auth/api-key";
import { closeBillingPeriod } from "../src/billing/close-period";

const apiKey = "charge-filter-billing-key";
const headers = { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" };
const now = "2026-08-15T00:00:00.000Z";

beforeEach(async () => {
  await env.BILLING_DB.batch([
    env.BILLING_DB.prepare(
      `INSERT OR IGNORE INTO organizations (id, external_id, name, created_at, updated_at)
       VALUES ('org-filter-billing', 'filter-billing', 'Filter Billing', ?, ?)`,
    ).bind(now, now),
    env.BILLING_DB.prepare(
      `INSERT OR IGNORE INTO api_keys
       (id, organization_id, key_prefix, key_hash, created_at, revoked_at)
       VALUES ('key-filter-billing', 'org-filter-billing', 'charge-f', ?, ?, NULL)`,
    ).bind(await sha256Hex(apiKey), now),
    env.BILLING_DB.prepare(
      `INSERT OR IGNORE INTO customers
       (id, organization_id, external_id, currency, metadata_json, created_at, updated_at)
       VALUES ('customer-filter-billing', 'org-filter-billing', 'customer-filter-billing',
               'USD', '{}', ?, ?)`,
    ).bind(now, now),
    env.BILLING_DB.prepare(
      `INSERT OR IGNORE INTO plans
       (id, organization_id, code, name, interval, amount_minor, currency, version,
        active, created_at, updated_at)
       VALUES ('plan-filter-billing', 'org-filter-billing', 'filter-plan', 'Filter Plan',
               'monthly', 0, 'USD', 1, 1, ?, ?)`,
    ).bind(now, now),
    env.BILLING_DB.prepare(
      `INSERT OR IGNORE INTO subscriptions
       (id, organization_id, customer_id, plan_id, external_id, status, started_at,
        current_period_start, current_period_end, version, created_at, updated_at)
       VALUES ('subscription-filter-billing', 'org-filter-billing', 'customer-filter-billing',
               'plan-filter-billing', 'subscription-filter-billing', 'active',
               '2026-08-01T00:00:00.000Z', '2026-08-01T00:00:00.000Z',
               '2026-09-01T00:00:00.000Z', 1, ?, ?)`,
    ).bind(now, now),
  ]);
});

describe("filtered charge billing", () => {
  it("persists filter/base partitions and one charge-wide minimum true-up line", async () => {
    const metric = await api("/api/v1/billable_metrics", {
      billable_metric: {
        name: "Filtered events",
        code: "invoice_filtered_events",
        aggregation_type: "count_agg",
        filters: [
          { key: "cloud", values: ["aws", "gcp"] },
          { key: "region", values: ["eu", "us"] },
        ],
      },
    }).then((response) => response.json<{ billable_metric: { lago_id: string } }>());
    const charge = await api("/api/v1/plans/filter-plan/charges", {
      charge: {
        billable_metric_id: metric.billable_metric.lago_id,
        code: "invoice-filter-charge",
        charge_model: "standard",
        properties: { amount: "5" },
        min_amount_cents: 100,
        filters: [
          {
            invoice_display_name: "Europe",
            properties: { amount: "10" },
            values: { region: ["eu"] },
          },
          {
            invoice_display_name: "Europe AWS",
            properties: { amount: "20" },
            values: { cloud: ["aws"], region: ["eu"] },
          },
        ],
      },
    }).then((response) =>
      response.json<{
        charge: { lago_id: string; filters: Array<{ lago_id: string }> };
      }>(),
    );

    for (const [id, properties] of [
      ["invoice-filter-specific", { cloud: "aws", region: "eu" }],
      ["invoice-filter-broad", { cloud: "gcp", region: "eu" }],
      ["invoice-filter-base", { cloud: "gcp", region: "us" }],
    ] as const) {
      const response = await api("/api/v1/events", {
        event: {
          transaction_id: id,
          code: "invoice_filtered_events",
          external_subscription_id: "subscription-filter-billing",
          timestamp: Date.parse(now) / 1000,
          properties,
        },
      });
      expect(response.status).toBe(200);
    }

    const closed = await closeBillingPeriod(
      env,
      "subscription-filter-billing",
      "2026-09-01T00:00:00.000Z",
      "charge-filter-close",
    );
    expect(closed).toMatchObject({ lineCount: 5, totalDueMinor: 100 });
    const lines = await env.BILLING_DB.prepare(
      `SELECT amount_minor, source_id, metadata_json FROM invoice_lines
       WHERE invoice_id = ? AND line_type = 'usage' ORDER BY amount_minor`,
    )
      .bind(closed.invoiceId)
      .all<{ amount_minor: number; source_id: string; metadata_json: string }>();
    expect(lines.results.map(({ amount_minor }) => amount_minor)).toEqual([5, 10, 20, 65]);
    expect(new Set(lines.results.map(({ source_id }) => source_id)).size).toBe(4);
    expect(lines.results.map(({ metadata_json }) => JSON.parse(metadata_json))).toEqual([
      expect.objectContaining({ chargeCode: "invoice-filter-charge" }),
      expect.objectContaining({
        chargeFilterValues: { region: ["eu"] },
        chargeId: charge.charge.lago_id,
      }),
      expect.objectContaining({
        chargeFilterValues: { cloud: ["aws"], region: ["eu"] },
        chargeId: charge.charge.lago_id,
      }),
      expect.objectContaining({
        chargeId: charge.charge.lago_id,
        eventCount: 0,
        trueUp: true,
        trueUpParentSourceId: charge.charge.lago_id,
      }),
    ]);
    expect(new Set(charge.charge.filters.map(({ lago_id }) => lago_id))).toEqual(
      new Set(lines.results.slice(1, 3).map(({ source_id }) => source_id)),
    );
  });

  it("carries recurring weighted baselines independently across filter partitions and generations", async () => {
    await env.BILLING_DB.batch([
      env.BILLING_DB.prepare(
        `INSERT OR IGNORE INTO plans
         (id, organization_id, code, name, interval, amount_minor, currency, version,
          active, created_at, updated_at)
         VALUES ('plan-filter-weighted', 'org-filter-billing', 'weighted-filter-plan',
                 'Weighted Filter Plan', 'monthly', 0, 'USD', 1, 1, ?, ?)`,
      ).bind(now, now),
      env.BILLING_DB.prepare(
        `UPDATE subscriptions
         SET status = 'terminated', started_at = '2026-07-01T00:00:00.000Z',
             current_period_start = '2026-07-01T00:00:00.000Z',
             current_period_end = '2026-08-01T00:00:00.000Z',
             terminated_at = '2026-08-01T00:00:00.000Z', generation = 1,
             plan_id = 'plan-filter-weighted'
         WHERE id = 'subscription-filter-billing'`,
      ),
      env.BILLING_DB.prepare(
        `INSERT INTO subscriptions
         (id, organization_id, customer_id, plan_id, external_id, status, started_at,
          current_period_start, current_period_end, version, created_at, updated_at,
          previous_subscription_id, transition_kind, transition_at, generation)
         VALUES ('subscription-filter-weighted', 'org-filter-billing',
                 'customer-filter-billing', 'plan-filter-weighted',
                 'subscription-filter-billing', 'active', '2026-08-01T00:00:00.000Z',
                 '2026-08-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z', 1, ?, ?,
                 'subscription-filter-billing', 'upgrade',
                 '2026-08-01T00:00:00.000Z', 2)`,
      ).bind(now, now),
    ]);
    const metric = await api("/api/v1/billable_metrics", {
      billable_metric: {
        name: "Filtered weighted seats",
        code: "filtered_weighted_seats",
        aggregation_type: "weighted_sum_agg",
        field_name: "delta",
        recurring: true,
        weighted_interval: "seconds",
        filters: [{ key: "region", values: ["eu", "us"] }],
      },
    }).then((response) => response.json<{ billable_metric: { lago_id: string } }>());
    const charge = await api("/api/v1/plans/weighted-filter-plan/charges", {
      charge: {
        billable_metric_id: metric.billable_metric.lago_id,
        code: "filtered-weighted-charge",
        charge_model: "standard",
        properties: { amount: "1" },
        filters: [
          {
            invoice_display_name: "Europe seats",
            properties: { amount: "2" },
            values: { region: ["eu"] },
          },
        ],
      },
    }).then((response) =>
      response.json<{
        charge: { lago_id: string; filters: Array<{ lago_id: string }> };
      }>(),
    );
    const filterId = charge.charge.filters[0]!.lago_id;

    for (const [id, timestamp, delta, region] of [
      ["weighted-filter-prior-eu", "2026-07-15T00:00:00.000Z", "10", "eu"],
      ["weighted-filter-prior-us", "2026-07-15T00:01:00.000Z", "20", "us"],
      ["weighted-filter-current-eu", "2026-08-01T00:00:00.000Z", "2", "eu"],
      ["weighted-filter-current-us", "2026-08-01T00:00:00.000Z", "3", "us"],
    ] as const) {
      const response = await api("/api/v1/events", {
        event: {
          transaction_id: id,
          code: "filtered_weighted_seats",
          external_subscription_id: "subscription-filter-billing",
          timestamp: Date.parse(timestamp) / 1000,
          properties: { delta, region },
        },
      });
      expect(response.status).toBe(200);
    }

    const usage = await SELF.fetch(
      "https://lago.test/api/v1/customers/customer-filter-billing/current_usage?external_subscription_id=subscription-filter-billing",
      { headers },
    ).then((response) =>
      response.json<{
        customer_usage: {
          amount_cents: number;
          charges_usage: Array<{
            units: string;
            total_aggregated_units: string;
            amount_cents: number;
            billable_metric: { code: string };
            filters: Array<{
              units: string;
              total_aggregated_units: string;
              amount_cents: number;
            }>;
          }>;
        };
      }>(),
    );
    expect(usage.customer_usage.amount_cents).toBe(47);
    expect(
      usage.customer_usage.charges_usage.find(
        ({ billable_metric }) => billable_metric.code === "filtered_weighted_seats",
      ),
    ).toMatchObject({
      units: "35",
      total_aggregated_units: "35",
      amount_cents: 47,
      filters: [{ units: "12", total_aggregated_units: "12", amount_cents: 24 }],
    });

    const closed = await closeBillingPeriod(
      env,
      "subscription-filter-weighted",
      "2026-09-01T00:00:00.000Z",
      "weighted-filter-close",
    );
    expect(closed).toMatchObject({ lineCount: 3, totalDueMinor: 47 });
    const lines = await env.BILLING_DB.prepare(
      `SELECT amount_minor, quantity_decimal, source_id, metadata_json
       FROM invoice_lines WHERE invoice_id = ? AND line_type = 'usage'
       ORDER BY amount_minor`,
    )
      .bind(closed.invoiceId)
      .all<{
        amount_minor: number;
        quantity_decimal: string;
        source_id: string;
        metadata_json: string;
      }>();
    expect(lines.results).toMatchObject([
      { amount_minor: 23, quantity_decimal: "23", source_id: charge.charge.lago_id },
      { amount_minor: 24, quantity_decimal: "12", source_id: filterId },
    ]);
    expect(lines.results.map(({ metadata_json }) => JSON.parse(metadata_json))).toEqual([
      expect.objectContaining({ totalAggregatedUnits: "23" }),
      expect.objectContaining({ chargeFilterId: filterId, totalAggregatedUnits: "12" }),
    ]);
  });
});

function api(path: string, body: Record<string, unknown>): Promise<Response> {
  return SELF.fetch(`https://lago.test${path}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}
