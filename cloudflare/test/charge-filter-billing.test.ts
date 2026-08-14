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
  it("persists one invoice line per filter partition plus the unmatched base partition", async () => {
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
    expect(closed).toMatchObject({ lineCount: 4, totalDueMinor: 35 });
    const lines = await env.BILLING_DB.prepare(
      `SELECT amount_minor, source_id, metadata_json FROM invoice_lines
       WHERE invoice_id = ? AND line_type = 'usage' ORDER BY amount_minor`,
    )
      .bind(closed.invoiceId)
      .all<{ amount_minor: number; source_id: string; metadata_json: string }>();
    expect(lines.results.map(({ amount_minor }) => amount_minor)).toEqual([5, 10, 20]);
    expect(new Set(lines.results.map(({ source_id }) => source_id)).size).toBe(3);
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
    ]);
    expect(new Set(charge.charge.filters.map(({ lago_id }) => lago_id))).toEqual(
      new Set(lines.results.slice(1).map(({ source_id }) => source_id)),
    );
  });
});

function api(path: string, body: Record<string, unknown>): Promise<Response> {
  return SELF.fetch(`https://lago.test${path}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}
