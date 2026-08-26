import { env, SELF } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { sha256Hex } from "../src/auth/api-key";
import { closeBillingPeriod } from "../src/billing/close-period";
import {
  calculateSubscriptionInvoice,
  findBillableSubscription,
} from "../src/billing/subscription-invoice-calculation";
import { refreshWalletOngoingBalances } from "../src/schedules/wallet-balances";

const apiKey = "event-targeted-wallets-key";
const now = "2026-08-15T00:00:00.000Z";
const periodEnd = "2026-09-01T00:00:00.000Z";

beforeEach(async () => {
  await env.BILLING_DB.batch([
    env.BILLING_DB.prepare(`DELETE FROM outbox_events WHERE organization_id = 'org-target-events'`),
    env.BILLING_DB.prepare(
      `DELETE FROM wallet_projection_guards
       WHERE wallet_id IN ('wallet-target-one', 'wallet-target-two')`,
    ),
    env.BILLING_DB.prepare(
      `DELETE FROM wallet_transaction_consumptions
       WHERE inbound_transaction_id IN
         (SELECT id FROM wallet_transactions WHERE organization_id = 'org-target-events')
          OR outbound_transaction_id IN
         (SELECT id FROM wallet_transactions WHERE organization_id = 'org-target-events')`,
    ),
    env.BILLING_DB.prepare(
      `DELETE FROM wallet_transactions WHERE organization_id = 'org-target-events'`,
    ),
    env.BILLING_DB.prepare(
      `DELETE FROM wallet_targets WHERE organization_id = 'org-target-events'`,
    ),
    env.BILLING_DB.prepare(`DELETE FROM wallets WHERE organization_id = 'org-target-events'`),
    env.BILLING_DB.prepare(
      `UPDATE billing_cycles SET invoice_id = NULL WHERE organization_id = 'org-target-events'`,
    ),
    env.BILLING_DB.prepare(`DELETE FROM invoices WHERE organization_id = 'org-target-events'`),
    env.BILLING_DB.prepare(
      `DELETE FROM billing_cycles WHERE organization_id = 'org-target-events'`,
    ),
    env.BILLING_DB.prepare(`DELETE FROM usage_events WHERE organization_id = 'org-target-events'`),
    env.BILLING_DB.prepare(
      `DELETE FROM usage_subscription_activities WHERE organization_id = 'org-target-events'`,
    ),
    env.BILLING_DB.prepare(
      `DELETE FROM lifetime_usages WHERE organization_id = 'org-target-events'`,
    ),
    env.BILLING_DB.prepare(`DELETE FROM subscriptions WHERE organization_id = 'org-target-events'`),
    env.BILLING_DB.prepare(`DELETE FROM charges WHERE organization_id = 'org-target-events'`),
    env.BILLING_DB.prepare(`DELETE FROM plans WHERE organization_id = 'org-target-events'`),
    env.BILLING_DB.prepare(
      `DELETE FROM billable_metrics WHERE organization_id = 'org-target-events'`,
    ),
    env.BILLING_DB.prepare(`DELETE FROM api_keys WHERE organization_id = 'org-target-events'`),
    env.BILLING_DB.prepare(`DELETE FROM customers WHERE organization_id = 'org-target-events'`),
    env.BILLING_DB.prepare(`DELETE FROM organizations WHERE id = 'org-target-events'`),
  ]);
  await env.BILLING_DB.batch([
    env.BILLING_DB.prepare(
      `INSERT INTO organizations (id, external_id, name, created_at, updated_at)
       VALUES ('org-target-events', 'target-events', 'Target Events', ?, ?)`,
    ).bind(now, now),
    env.BILLING_DB.prepare(
      `INSERT INTO api_keys
       (id, organization_id, key_prefix, key_hash, created_at, revoked_at)
       VALUES ('key-target-events', 'org-target-events', 'event-ta', ?, ?, NULL)`,
    ).bind(await sha256Hex(apiKey), now),
    env.BILLING_DB.prepare(
      `INSERT INTO customers
       (id, organization_id, external_id, currency, metadata_json, created_at, updated_at)
       VALUES ('customer-target-events', 'org-target-events', 'customer-target-events-external',
               'USD', '{}', ?, ?)`,
    ).bind(now, now),
    env.BILLING_DB.prepare(
      `INSERT INTO billable_metrics
       (id, organization_id, code, name, aggregation_type, field_name, properties_json,
        version, active, created_at, updated_at)
       VALUES ('metric-target-events', 'org-target-events', 'target-units', 'Target Units',
               'sum_agg', 'value', '{}', 1, 1, ?, ?)`,
    ).bind(now, now),
    env.BILLING_DB.prepare(
      `INSERT INTO plans
       (id, organization_id, code, name, interval, amount_minor, currency, version,
        active, created_at, updated_at)
       VALUES ('plan-target-events', 'org-target-events', 'target-plan', 'Target Plan',
               'monthly', 0, 'USD', 1, 1, ?, ?)`,
    ).bind(now, now),
    env.BILLING_DB.prepare(
      `INSERT INTO charges
       (id, organization_id, plan_id, billable_metric_id, code, charge_model,
        properties_json, invoiceable, pay_in_advance, prorated, min_amount_minor,
        accepts_target_wallet, version, active, created_at, updated_at)
       VALUES ('charge-target-events', 'org-target-events', 'plan-target-events',
               'metric-target-events', 'target-charge', 'standard', '{"amount":"10"}',
               1, 0, 0, 0, 1, 1, 1, ?, ?)`,
    ).bind(now, now),
    env.BILLING_DB.prepare(
      `INSERT INTO subscriptions
       (id, organization_id, customer_id, plan_id, external_id, status, started_at,
        current_period_start, current_period_end, version, created_at, updated_at)
       VALUES ('subscription-target-events', 'org-target-events', 'customer-target-events',
               'plan-target-events', 'subscription-target-events-external', 'active',
               '2026-08-01T00:00:00.000Z', '2026-08-01T00:00:00.000Z', ?, 1, ?, ?)`,
    ).bind(periodEnd, now, now),
    walletStatement("wallet-target-one", "wallet_1", 10, 200),
    walletStatement("wallet-target-two", "wallet_2", 20, 250),
    lotStatement("wallet-target-one", 10, 200),
    lotStatement("wallet-target-two", 20, 250),
  ]);
});

describe("events targeting wallets", () => {
  it("groups accepted targets and routes projection and invoice credits to exact wallets", async () => {
    await createEvent("target-event-1", "10", "wallet_1");
    await createEvent("target-event-2", "5", "wallet_1");
    await createEvent("target-event-3", "20", "wallet_2");

    await expect(
      refreshWalletOngoingBalances(env, now, "target-wallet-projection"),
    ).resolves.toMatchObject({ customers: 1, wallets: 2 });
    await expect(walletBalances()).resolves.toEqual([
      { code: "wallet_1", ongoing_balance_minor: 50, ongoing_usage_balance_minor: 150 },
      { code: "wallet_2", ongoing_balance_minor: 50, ongoing_usage_balance_minor: 200 },
    ]);

    const closed = await closeBillingPeriod(
      env,
      "subscription-target-events",
      periodEnd,
      "target-wallet-close",
    );
    expect(closed).toMatchObject({ lineCount: 3, totalDueMinor: 0 });
    const lines = await env.BILLING_DB.prepare(
      `SELECT amount_minor, source_id, metadata_json FROM invoice_lines
       WHERE invoice_id = ? AND line_type = 'usage' ORDER BY amount_minor`,
    )
      .bind(closed.invoiceId)
      .all<{ amount_minor: number; source_id: string; metadata_json: string }>();
    expect(lines.results).toHaveLength(2);
    expect(lines.results.map((line) => line.amount_minor)).toEqual([150, 200]);
    expect(new Set(lines.results.map((line) => line.source_id)).size).toBe(2);
    expect(lines.results.map((line) => JSON.parse(line.metadata_json))).toEqual([
      expect.objectContaining({
        chargeId: "charge-target-events",
        targetWalletCode: "wallet_1",
        groupedBy: { target_wallet_code: "wallet_1" },
      }),
      expect.objectContaining({
        chargeId: "charge-target-events",
        targetWalletCode: "wallet_2",
        groupedBy: { target_wallet_code: "wallet_2" },
      }),
    ]);
    await expect(
      env.BILLING_DB.prepare(
        `SELECT wallet_id, amount_minor FROM wallet_transactions
         WHERE invoice_id = ? ORDER BY amount_minor`,
      )
        .bind(closed.invoiceId)
        .all(),
    ).resolves.toMatchObject({
      results: [
        { wallet_id: "wallet-target-one", amount_minor: 150 },
        { wallet_id: "wallet-target-two", amount_minor: 200 },
      ],
    });
    const invoice = await api(`/api/v1/invoices/${closed.invoiceId}`).then((response) =>
      response.json<{ invoice: { fees: Array<{ lago_charge_id: string | null }> } }>(),
    );
    expect(invoice.invoice.fees.filter((fee) => fee.lago_charge_id !== null)).toEqual([
      expect.objectContaining({ lago_charge_id: "charge-target-events" }),
      expect.objectContaining({ lago_charge_id: "charge-target-events" }),
    ]);
  });

  it("accepts a missing target and records one replay-safe event error", async () => {
    const created = await createEvent("target-event-missing", "10", "missing-wallet");
    expect(created.status).toBe(200);
    expect((await createEvent("target-event-missing", "10", "missing-wallet")).status).toBe(200);
    await expect(
      env.BILLING_DB.prepare(
        `SELECT event_type, payload_json FROM outbox_events
         WHERE aggregate_type = 'usage_event' AND event_type = 'event.error'`,
      ).all<{ event_type: string; payload_json: string }>(),
    ).resolves.toMatchObject({
      results: [
        {
          event_type: "event.error",
          payload_json: expect.stringContaining("target_wallet_code_not_found"),
        },
      ],
    });
  });

  it("partitions filtered events by target wallet with distinct lines and exact allocations", async () => {
    const filterPeriodEnd = "2026-10-01T00:00:00.000Z";
    await env.BILLING_DB.prepare(
      `UPDATE subscriptions SET current_period_end = ?
       WHERE id = 'subscription-target-events'`,
    )
      .bind(filterPeriodEnd)
      .run();
    await env.BILLING_DB.prepare(
      `UPDATE billable_metrics
       SET filters_json = '[{"key":"region","values":["eu","us"]}]'
       WHERE id = 'metric-target-events'`,
    ).run();
    const filterResponse = await api(
      "/api/v1/plans/target-plan/charges/target-charge/filters",
      "POST",
      {
        filter: {
          invoice_display_name: "Europe",
          properties: { amount: "20" },
          values: { region: ["eu"] },
        },
      },
    );
    expect(filterResponse.status).toBe(200);
    const filterId = (await filterResponse.json<{ filter: { lago_id: string } }>()).filter.lago_id;

    for (const [id, value, region, target] of [
      ["filter-target-eu-one", "2", "eu", "wallet_1"],
      ["filter-target-eu-two", "3", "eu", "wallet_2"],
      ["filter-target-base", "4", "us", "wallet_1"],
    ] as const) {
      const response = await api("/api/v1/events", "POST", {
        event: {
          transaction_id: id,
          code: "target-units",
          external_subscription_id: "subscription-target-events-external",
          timestamp: Date.parse(now) / 1000,
          properties: { region, target_wallet_code: target, value },
        },
      });
      expect(response.status).toBe(200);
    }

    const usage = await api(
      "/api/v1/customers/customer-target-events-external/current_usage?external_subscription_id=subscription-target-events-external",
    ).then((response) =>
      response.json<{
        customer_usage: {
          amount_cents: number;
          charges_usage: Array<{ amount_cents: number; filters: Array<{ amount_cents: number }> }>;
        };
      }>(),
    );
    expect(usage.customer_usage).toMatchObject({
      amount_cents: 140,
      charges_usage: [{ amount_cents: 140, filters: [{ amount_cents: 100 }] }],
    });

    const closed = await closeBillingPeriod(
      env,
      "subscription-target-events",
      filterPeriodEnd,
      "filter-target-close",
    );
    expect(closed).toMatchObject({ lineCount: 4, totalDueMinor: 0 });
    const lines = await env.BILLING_DB.prepare(
      `SELECT amount_minor, source_id, metadata_json FROM invoice_lines
       WHERE invoice_id = ? AND line_type = 'usage' ORDER BY amount_minor, source_id`,
    )
      .bind(closed.invoiceId)
      .all<{ amount_minor: number; source_id: string; metadata_json: string }>();
    expect(lines.results.map(({ amount_minor }) => amount_minor)).toEqual([40, 40, 60]);
    expect(new Set(lines.results.map(({ source_id }) => source_id)).size).toBe(3);
    expect(lines.results.map(({ metadata_json }) => JSON.parse(metadata_json))).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          chargeFilterId: filterId,
          targetWalletCode: "wallet_1",
        }),
        expect.objectContaining({
          chargeFilterId: filterId,
          targetWalletCode: "wallet_2",
        }),
        expect.objectContaining({
          targetWalletCode: "wallet_1",
        }),
      ]),
    );
    await expect(
      env.BILLING_DB.prepare(
        `SELECT wallet_id, amount_minor FROM wallet_transactions
         WHERE invoice_id = ? ORDER BY wallet_id`,
      )
        .bind(closed.invoiceId)
        .all(),
    ).resolves.toMatchObject({
      results: [
        { amount_minor: 80, wallet_id: "wallet-target-one" },
        { amount_minor: 60, wallet_id: "wallet-target-two" },
      ],
    });
  });

  it("carries recurring weighted state per filter and wallet, including an idle wallet group", async () => {
    await env.BILLING_DB.batch([
      env.BILLING_DB.prepare("UPDATE charges SET active = 0 WHERE id = 'charge-target-events'"),
      env.BILLING_DB.prepare("DELETE FROM subscriptions WHERE id = 'subscription-target-events'"),
      env.BILLING_DB.prepare(
        `INSERT INTO subscriptions
         (id, organization_id, customer_id, plan_id, external_id, status, started_at,
          current_period_start, current_period_end, version, created_at, updated_at)
         VALUES ('subscription-target-weighted', 'org-target-events', 'customer-target-events',
                 'plan-target-events', 'subscription-target-weighted-external', 'active',
                 '2026-07-01T00:00:00.000Z', '2026-08-01T00:00:00.000Z', ?, 1, ?, ?)`,
      ).bind(periodEnd, now, now),
    ]);
    const metricResponse = await api("/api/v1/billable_metrics", "POST", {
      billable_metric: {
        name: "Weighted target seats",
        code: "weighted_target_seats",
        aggregation_type: "weighted_sum_agg",
        field_name: "delta",
        recurring: true,
        weighted_interval: "seconds",
        filters: [{ key: "region", values: ["eu", "us"] }],
      },
    });
    expect(metricResponse.status).toBe(200);
    const metricId = (await metricResponse.json<{ billable_metric: { lago_id: string } }>())
      .billable_metric.lago_id;
    const chargeResponse = await api("/api/v1/plans/target-plan/charges", "POST", {
      charge: {
        billable_metric_id: metricId,
        code: "weighted-target-charge",
        charge_model: "standard",
        accepts_target_wallet: true,
        properties: { amount: "1" },
        filters: [
          {
            invoice_display_name: "Weighted Europe",
            properties: { amount: "2" },
            values: { region: ["eu"] },
          },
        ],
      },
    });
    expect(chargeResponse.status).toBe(200);
    const charge = await chargeResponse.json<{
      charge: { lago_id: string; filters: Array<{ lago_id: string }> };
    }>();
    const filterId = charge.charge.filters[0]!.lago_id;

    for (const [id, timestamp, delta, region, targetWalletCode] of [
      ["weighted-target-prior-eu-one", "2026-07-15T00:00:00.000Z", "10", "eu", "wallet_1"],
      ["weighted-target-prior-eu-two", "2026-07-15T00:01:00.000Z", "20", "eu", "wallet_2"],
      ["weighted-target-prior-us-one", "2026-07-15T00:02:00.000Z", "30", "us", "wallet_1"],
      ["weighted-target-current-eu-one", "2026-08-01T00:00:00.000Z", "2", "eu", "wallet_1"],
      ["weighted-target-current-us-one", "2026-08-01T00:00:00.000Z", "4", "us", "wallet_1"],
    ] as const) {
      const response = await api("/api/v1/events", "POST", {
        event: {
          transaction_id: id,
          code: "weighted_target_seats",
          external_subscription_id: "subscription-target-weighted-external",
          timestamp: Date.parse(timestamp) / 1000,
          properties: { delta, region, target_wallet_code: targetWalletCode },
        },
      });
      expect(response.status).toBe(200);
    }

    const usage = await api(
      "/api/v1/customers/customer-target-events-external/current_usage?external_subscription_id=subscription-target-weighted-external",
    ).then((response) =>
      response.json<{
        customer_usage: {
          amount_cents: number;
          charges_usage: Array<{
            units: string;
            total_aggregated_units: string;
            filters: Array<{
              units: string;
              total_aggregated_units: string;
              amount_cents: number;
            }>;
          }>;
        };
      }>(),
    );
    expect(usage.customer_usage).toMatchObject({
      amount_cents: 98,
      charges_usage: [
        {
          units: "66",
          total_aggregated_units: "66",
          filters: [{ units: "32", total_aggregated_units: "32", amount_cents: 64 }],
        },
      ],
    });

    const closed = await closeBillingPeriod(
      env,
      "subscription-target-weighted",
      periodEnd,
      "weighted-target-close",
    );
    expect(closed).toMatchObject({ lineCount: 4, totalDueMinor: 0 });
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
    expect(
      lines.results.map(({ amount_minor, quantity_decimal }) => ({
        amount_minor,
        quantity_decimal,
      })),
    ).toEqual([
      { amount_minor: 24, quantity_decimal: "12" },
      { amount_minor: 34, quantity_decimal: "34" },
      { amount_minor: 40, quantity_decimal: "20" },
    ]);
    expect(new Set(lines.results.map(({ source_id }) => source_id)).size).toBe(3);
    expect(lines.results.map(({ metadata_json }) => JSON.parse(metadata_json))).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          chargeFilterId: filterId,
          eventCount: 1,
          targetWalletCode: "wallet_1",
          totalAggregatedUnits: "12",
        }),
        expect.objectContaining({
          chargeFilterId: filterId,
          eventCount: 0,
          targetWalletCode: "wallet_2",
          totalAggregatedUnits: "20",
        }),
        expect.objectContaining({
          eventCount: 1,
          targetWalletCode: "wallet_1",
          totalAggregatedUnits: "34",
        }),
      ]),
    );
    await expect(
      env.BILLING_DB.prepare(
        `SELECT wallet_id, amount_minor FROM wallet_transactions
         WHERE invoice_id = ? ORDER BY wallet_id`,
      )
        .bind(closed.invoiceId)
        .all(),
    ).resolves.toMatchObject({
      results: [
        { amount_minor: 58, wallet_id: "wallet-target-one" },
        { amount_minor: 40, wallet_id: "wallet-target-two" },
      ],
    });
  });

  it("ignores target properties for an opt-out charge and validates malformed codes", async () => {
    await env.BILLING_DB.prepare(
      "UPDATE charges SET accepts_target_wallet = 0 WHERE id = 'charge-target-events'",
    ).run();
    await expect(
      env.BILLING_DB.prepare(
        "SELECT accepts_target_wallet FROM charges WHERE id = 'charge-target-events'",
      ).first(),
    ).resolves.toEqual({ accepts_target_wallet: 0 });
    await env.BILLING_DB.prepare(
      `UPDATE wallets SET allowed_fee_types_json = '[]' WHERE id = 'wallet-target-one'`,
    ).run();
    expect((await createEvent("target-event-opt-out-1", "10", "wallet_1")).status).toBe(200);
    expect((await createEvent("target-event-opt-out-2", "20", "wallet_2")).status).toBe(200);
    const subscription = await findBillableSubscription(
      env.BILLING_DB,
      "subscription-target-events",
    );
    expect(subscription).not.toBeNull();
    const calculation = await calculateSubscriptionInvoice(
      env.BILLING_DB,
      subscription!,
      "target-wallet-opt-out-invoice",
      "target-wallet-opt-out-cycle",
      "2026-08-01T00:00:00.000Z",
      periodEnd,
    );
    expect(calculation).toMatchObject({ totalDueMinor: 100 });
    expect(calculation.lines.filter((line) => line.lineType === "usage")).toEqual([
      expect.objectContaining({ rounded: 300, sourceId: "charge-target-events" }),
    ]);
    expect(
      calculation.walletAllocations.map(({ walletId, amountMinor }) => ({
        walletId,
        amountMinor,
      })),
    ).toEqual([{ walletId: "wallet-target-one", amountMinor: 200 }]);

    const malformed = await api("/api/v1/events", "POST", {
      event: {
        transaction_id: "target-event-malformed",
        code: "target-units",
        external_subscription_id: "subscription-target-events-external",
        timestamp: Date.parse(now) / 1000,
        properties: { value: "1", target_wallet_code: 42 },
      },
    });
    expect(malformed.status).toBe(422);
    await expect(malformed.json()).resolves.toMatchObject({ code: "validation_error" });
  });
});

function walletStatement(id: string, code: string, priority: number, balanceMinor: number) {
  return env.BILLING_DB.prepare(
    `INSERT INTO wallets
     (id, organization_id, customer_id, code, currency, currency_exponent, rate_amount,
      priority, balance_minor, ongoing_balance_minor, ongoing_usage_balance_minor,
      consumed_minor, status, version, request_sha256, created_at, updated_at,
      allowed_fee_types_json)
     VALUES (?, 'org-target-events', 'customer-target-events', ?, 'USD', 2, '1', ?, ?, ?, 0,
             0, 'active', 1, ?, ?, ?, '["subscription"]')`,
  ).bind(id, code, priority, balanceMinor, balanceMinor, `${id}-hash`, now, now);
}

function lotStatement(walletId: string, priority: number, amountMinor: number) {
  return env.BILLING_DB.prepare(
    `INSERT INTO wallet_transactions
     (id, organization_id, wallet_id, transaction_type, transaction_status, status, source,
      amount_minor, credit_amount, remaining_minor, priority, wallet_version, request_sha256,
      settled_at, created_at, updated_at)
     VALUES (?, 'org-target-events', ?, 'inbound', 'granted', 'settled', 'manual', ?, ?, ?, ?, 1,
             ?, ?, ?, ?)`,
  ).bind(
    `${walletId}-lot`,
    walletId,
    amountMinor,
    String(amountMinor / 100),
    amountMinor,
    priority,
    `${walletId}-lot-hash`,
    now,
    now,
    now,
  );
}

function createEvent(transactionId: string, value: string, targetWalletCode: string) {
  return api("/api/v1/events", "POST", {
    event: {
      transaction_id: transactionId,
      code: "target-units",
      external_subscription_id: "subscription-target-events-external",
      timestamp: Date.parse(now) / 1000,
      properties: { value, target_wallet_code: targetWalletCode },
    },
  });
}

async function walletBalances() {
  const result = await env.BILLING_DB.prepare(
    `SELECT code, ongoing_balance_minor, ongoing_usage_balance_minor
     FROM wallets WHERE customer_id = 'customer-target-events' ORDER BY priority`,
  ).all();
  return result.results;
}

function api(path: string, method = "GET", body?: unknown): Promise<Response> {
  return SELF.fetch(`https://lago.test${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
}
