import {
  createExecutionContext,
  createMessageBatch,
  env,
  getQueueResult,
  SELF,
} from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import worker from "../src/index";
import { sha256Hex } from "../src/auth/api-key";
import {
  processPayInAdvanceUsageEvent,
  repairPendingPayInAdvanceUsageInvoices,
} from "../src/billing/pay-in-advance-usage";
import {
  calculateSubscriptionInvoice,
  findBillableSubscription,
} from "../src/billing/subscription-invoice-calculation";

const apiKey = "advance-usage-test-key";
const headers = { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" };

beforeEach(async () => {
  const now = "2026-08-15T00:00:00.000Z";
  await env.BILLING_DB.batch([
    env.BILLING_DB.prepare(
      `INSERT OR IGNORE INTO organizations (id, external_id, name, created_at, updated_at)
       VALUES ('org-advance-usage', 'advance-usage', 'Advance Usage', ?, ?)`,
    ).bind(now, now),
    env.BILLING_DB.prepare(
      `INSERT OR IGNORE INTO api_keys
       (id, organization_id, key_prefix, key_hash, created_at, revoked_at)
       VALUES ('key-advance-usage', 'org-advance-usage', 'advance-', ?, ?, NULL)`,
    ).bind(await sha256Hex(apiKey), now),
    env.BILLING_DB.prepare(
      `INSERT OR IGNORE INTO customers
       (id, organization_id, external_id, email, name, currency, metadata_json, created_at,
        updated_at)
       VALUES ('customer-advance-usage', 'org-advance-usage', 'advance-customer',
               'advance@example.test', 'Advance Customer', 'USD', '{}', ?, ?)`,
    ).bind(now, now),
    env.BILLING_DB.prepare(
      `INSERT OR IGNORE INTO plans
       (id, organization_id, code, name, interval, amount_minor, currency, version, active,
        created_at, updated_at)
       VALUES ('plan-advance-usage', 'org-advance-usage', 'advance-usage-plan',
               'Advance Usage Plan', 'monthly', 0, 'USD', 1, 1, ?, ?)`,
    ).bind(now, now),
    env.BILLING_DB.prepare(
      `INSERT OR IGNORE INTO subscriptions
       (id, organization_id, customer_id, plan_id, external_id, status, started_at,
        current_period_start, current_period_end, version, created_at, updated_at)
       VALUES ('subscription-advance-usage', 'org-advance-usage', 'customer-advance-usage',
               'plan-advance-usage', 'advance-subscription', 'active',
               '2026-08-01T00:00:00.000Z', '2026-08-01T00:00:00.000Z',
               '2026-09-01T00:00:00.000Z', 1, ?, ?)`,
    ).bind(now, now),
  ]);
});

describe("pay-in-advance usage charges", () => {
  it("creates one filtered marginal invoice per charge and safely replays Queue delivery", async () => {
    const metricId = await createMetric("advance_units", "sum_agg", {
      field_name: "units",
      filters: [{ key: "region", values: ["us", "eu"] }],
    });
    const filtered = await createCharge(metricId, "filtered-advance", "standard", {
      properties: { amount: "2" },
      accepts_target_wallet: true,
      filters: [
        {
          invoice_display_name: "EU usage",
          values: { region: ["eu"] },
          properties: { amount: "7" },
        },
      ],
    });
    expect(filtered.status, await filtered.clone().text()).toBe(200);
    const graduated = await createCharge(metricId, "graduated-advance", "graduated", {
      properties: {
        graduated_ranges: [
          { from_value: "0", to_value: "1", per_unit_amount: "10", flat_amount: "0" },
          { from_value: "2", to_value: null, per_unit_amount: "20", flat_amount: "0" },
        ],
      },
    });
    expect(graduated.status, await graduated.clone().text()).toBe(200);
    expect(
      (
        await api("/api/v1/taxes", "POST", {
          tax: { name: "VAT", code: "advance-vat", rate: "20", applied_to_organization: true },
        })
      ).status,
    ).toBe(200);

    const firstEventId = await createEvent("advance-event-one", "advance_units", {
      units: "1",
      region: "eu",
      target_wallet_code: "regional-wallet",
    });
    await dispatchUsageEvent(firstEventId);
    const secondEventId = await createEvent(
      "advance-event-two",
      "advance_units",
      {
        units: "1",
        region: "eu",
        target_wallet_code: "regional-wallet",
      },
      1_786_579_201,
    );
    await dispatchUsageEvent(secondEventId);

    const billings = await env.BILLING_DB.prepare(
      `SELECT billing.usage_event_id, charge.code, billing.billed_units,
              billing.precise_amount_minor, billing.amount_minor,
              billing.charge_filter_id, billing.target_wallet_code, billing.invoice_id
       FROM pay_in_advance_usage_billings billing
       JOIN charges charge ON charge.id = billing.charge_id
       JOIN usage_events event ON event.id = billing.usage_event_id
       ORDER BY event.timestamp_ms, charge.code`,
    ).all<{
      usage_event_id: string;
      code: string;
      billed_units: string;
      precise_amount_minor: string;
      amount_minor: number;
      charge_filter_id: string | null;
      target_wallet_code: string | null;
      invoice_id: string;
    }>();
    expect(billings.results).toHaveLength(4);
    expect(
      billings.results
        .filter((billing) => billing.code === "filtered-advance")
        .map((billing) => billing.amount_minor),
    ).toEqual([7, 7]);
    expect(
      billings.results
        .filter((billing) => billing.code === "graduated-advance")
        .map((billing) => billing.amount_minor),
    ).toEqual([10, 20]);
    expect(billings.results.every((billing) => billing.billed_units === "1")).toBe(true);
    expect(
      billings.results
        .filter((billing) => billing.code === "filtered-advance")
        .every((billing) => billing.target_wallet_code === "regional-wallet"),
    ).toBe(true);
    expect(
      billings.results
        .filter((billing) => billing.code === "graduated-advance")
        .every((billing) => billing.target_wallet_code === null),
    ).toBe(true);
    expect(
      billings.results
        .filter((billing) => billing.code === "filtered-advance")
        .every((billing) => billing.charge_filter_id !== null),
    ).toBe(true);

    const invoices = await env.BILLING_DB.prepare(
      `SELECT invoice.subtotal_minor, invoice.tax_minor, invoice.total_due_minor,
              line.amount_minor, line.metadata_json
       FROM invoices invoice JOIN invoice_lines line ON line.invoice_id = invoice.id
       WHERE invoice.id IN (SELECT invoice_id FROM pay_in_advance_usage_billings)
       ORDER BY line.amount_minor`,
    ).all<{
      subtotal_minor: number;
      tax_minor: number;
      total_due_minor: number;
      amount_minor: number;
      metadata_json: string;
    }>();
    expect(invoices.results.map((invoice) => invoice.amount_minor)).toEqual([7, 7, 10, 20]);
    expect(invoices.results.map((invoice) => invoice.tax_minor)).toEqual([1, 1, 2, 4]);
    expect(invoices.results.map((invoice) => invoice.total_due_minor)).toEqual([8, 8, 12, 24]);
    expect(
      invoices.results.every((invoice) => {
        const metadata = JSON.parse(invoice.metadata_json) as Record<string, unknown>;
        return (
          metadata.contextType === "in_advance_charge" && metadata.billingMode === "in_advance"
        );
      }),
    ).toBe(true);
    expect(
      invoices.results
        .filter((invoice) => {
          const metadata = JSON.parse(invoice.metadata_json) as Record<string, unknown>;
          return metadata.chargeCode === "filtered-advance";
        })
        .every((invoice) => {
          const metadata = JSON.parse(invoice.metadata_json) as Record<string, unknown>;
          return metadata.targetWalletCode === "regional-wallet";
        }),
    ).toBe(true);

    await expect(
      processPayInAdvanceUsageEvent(env, secondEventId, "advance-usage-replay"),
    ).resolves.toEqual({ invoiceCount: 0, replayedCount: 2 });
    const invoiceCount = await env.BILLING_DB.prepare(
      `SELECT COUNT(*) AS total FROM invoices
       WHERE id IN (SELECT invoice_id FROM pay_in_advance_usage_billings)`,
    ).first<{ total: number }>();
    expect(invoiceCount?.total).toBe(4);

    const subscription = await findBillableSubscription(
      env.BILLING_DB,
      "subscription-advance-usage",
    );
    const renewal = await calculateSubscriptionInvoice(
      env.BILLING_DB,
      subscription!,
      "advance-usage-renewal",
      "advance-usage-cycle",
      "2026-08-01T00:00:00.000Z",
      "2026-09-01T00:00:00.000Z",
    );
    expect(renewal.lines.some((line) => line.lineType === "usage")).toBe(false);
  });

  it("repairs a persisted event that was not delivered to the Queue", async () => {
    const metricId = await createMetric("repair_count", "count_agg");
    expect(await createCharge(metricId, "repair-charge", "standard")).toHaveProperty("status", 200);
    const eventId = await createEvent("advance-repair-event", "repair_count", {});
    await expect(
      repairPendingPayInAdvanceUsageInvoices(
        env,
        "2026-09-01T00:00:00.000Z",
        "advance-usage-repair",
      ),
    ).resolves.toBe(1);
    await expect(
      repairPendingPayInAdvanceUsageInvoices(
        env,
        "2026-09-01T00:00:00.000Z",
        "advance-usage-repair-replay",
      ),
    ).resolves.toBe(0);
    await expect(
      env.BILLING_DB.prepare(
        `SELECT amount_minor FROM pay_in_advance_usage_billings WHERE usage_event_id = ?`,
      )
        .bind(eventId)
        .first(),
    ).resolves.toEqual({ amount_minor: 5 });
  });

  it("keeps unsupported advance configurations explicit in direct and embedded catalogs", async () => {
    const countMetricId = await createMetric("guard_count", "count_agg");
    const maxMetricId = await createMetric("guard_max", "max_agg", { field_name: "value" });
    const unsupported = [
      createCharge(countMetricId, "noninvoiceable", "standard", { invoiceable: false }),
      createCharge(countMetricId, "minimum", "standard", { min_amount_cents: 1 }),
      createCharge(countMetricId, "volume", "volume", {
        properties: {
          volume_ranges: [
            { from_value: "0", to_value: null, per_unit_amount: "1", flat_amount: "0" },
          ],
        },
      }),
      createCharge(countMetricId, "prorated", "standard", { prorated: true }),
      createCharge(maxMetricId, "max", "standard"),
    ];
    for (const response of await Promise.all(unsupported)) expect(response.status).toBe(422);

    const embedded = await api("/api/v1/plans", "POST", {
      plan: {
        name: "Embedded advance usage",
        code: "embedded-advance-usage",
        interval: "monthly",
        amount_cents: 0,
        amount_currency: "USD",
        charges: [
          {
            billable_metric_id: countMetricId,
            code: "embedded-advance-charge",
            charge_model: "standard",
            properties: { amount: "3" },
            pay_in_advance: true,
          },
        ],
      },
    });
    expect(embedded.status, await embedded.clone().text()).toBe(200);
    await expect(embedded.json()).resolves.toMatchObject({
      plan: { charges: [{ code: "embedded-advance-charge", pay_in_advance: true }] },
    });
  });
});

async function createMetric(
  code: string,
  aggregationType: string,
  extra: Record<string, unknown> = {},
): Promise<string> {
  const response = await api("/api/v1/billable_metrics", "POST", {
    billable_metric: {
      name: code,
      code,
      aggregation_type: aggregationType,
      ...extra,
    },
  });
  expect(response.status, await response.clone().text()).toBe(200);
  return (await response.json<{ billable_metric: { lago_id: string } }>()).billable_metric.lago_id;
}

function createCharge(
  metricId: string,
  code: string,
  chargeModel: string,
  extra: Record<string, unknown> = {},
): Promise<Response> {
  return api("/api/v1/plans/advance-usage-plan/charges", "POST", {
    charge: {
      billable_metric_id: metricId,
      code,
      charge_model: chargeModel,
      properties: { amount: "5" },
      pay_in_advance: true,
      ...extra,
    },
  });
}

async function createEvent(
  transactionId: string,
  code: string,
  properties: Record<string, unknown>,
  timestamp = 1_786_579_200,
): Promise<string> {
  const response = await api("/api/v1/events", "POST", {
    event: {
      transaction_id: transactionId,
      code,
      external_subscription_id: "advance-subscription",
      timestamp,
      properties,
    },
  });
  expect(response.status, await response.clone().text()).toBe(200);
  return (await response.json<{ event: { lago_id: string } }>()).event.lago_id;
}

async function dispatchUsageEvent(eventId: string) {
  const row = await env.BILLING_DB.prepare(
    `SELECT event_id, event_type, event_version, aggregate_type, aggregate_id,
            aggregate_version, occurred_at, causation_id, correlation_id, payload_json
     FROM outbox_events WHERE event_id = ? LIMIT 1`,
  )
    .bind(`usage-event-ingested:${eventId}`)
    .first<{
      event_id: string;
      event_type: string;
      event_version: number;
      aggregate_type: string;
      aggregate_id: string;
      aggregate_version: number;
      occurred_at: string;
      causation_id: string | null;
      correlation_id: string;
      payload_json: string;
    }>();
  expect(row).not.toBeNull();
  const batch = createMessageBatch("serp-dev-lago-domain-events", [
    {
      id: `message-${eventId}`,
      timestamp: new Date(),
      attempts: 1,
      body: {
        id: row!.event_id,
        type: row!.event_type,
        version: row!.event_version,
        aggregateType: row!.aggregate_type,
        aggregateId: row!.aggregate_id,
        aggregateVersion: row!.aggregate_version,
        occurredAt: row!.occurred_at,
        causationId: row!.causation_id,
        correlationId: row!.correlation_id,
        payload: JSON.parse(row!.payload_json) as Record<string, unknown>,
      },
    },
  ]);
  const context = createExecutionContext();
  await worker.queue(batch, env);
  return getQueueResult(batch, context);
}

function api(path: string, method = "GET", body?: Record<string, unknown>): Promise<Response> {
  return SELF.fetch(`https://lago.test${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
}
