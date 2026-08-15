import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import {
  dailyUsageRollups,
  invoiceDailyUsageCandidates,
  projectInvoiceDailyUsage,
  projectScheduledDailyUsage,
  scheduledDailyUsageCandidates,
} from "../src/usage/daily-usage";

const now = "2026-08-15T07:15:00.000Z";

beforeAll(async () => {
  await env.BILLING_DB.batch([
    env.BILLING_DB.prepare(
      `INSERT INTO organizations (id, external_id, name, created_at, updated_at)
       VALUES ('org-daily', 'daily-test', 'Daily Test', ?, ?)`,
    ).bind(now, now),
    env.BILLING_DB.prepare(
      `INSERT INTO customers
       (id, organization_id, external_id, name, currency, timezone, metadata_json,
        created_at, updated_at)
       VALUES ('customer-daily', 'org-daily', 'daily-customer', 'Daily Customer', 'USD',
               'America/Los_Angeles', '{}', ?, ?)`,
    ).bind(now, now),
    env.BILLING_DB.prepare(
      `INSERT INTO plans
       (id, organization_id, code, name, interval, amount_minor, currency, version, active,
        created_at, updated_at)
       VALUES ('plan-daily', 'org-daily', 'daily-plan', 'Daily Plan', 'monthly', 0, 'USD',
               1, 1, ?, ?)`,
    ).bind(now, now),
    env.BILLING_DB.prepare(
      `INSERT INTO billable_metrics
       (id, organization_id, code, name, aggregation_type, field_name, version, active,
        created_at, updated_at)
       VALUES ('metric-daily', 'org-daily', 'daily_units', 'Daily units', 'sum_agg', 'units',
               1, 1, ?, ?)`,
    ).bind(now, now),
    env.BILLING_DB.prepare(
      `INSERT INTO charges
       (id, organization_id, plan_id, billable_metric_id, code, charge_model,
        properties_json, version, active, created_at, updated_at)
       VALUES ('charge-daily', 'org-daily', 'plan-daily', 'metric-daily', 'daily-charge',
               'standard', '{"amount":"10"}', 1, 1, ?, ?)`,
    ).bind(now, now),
    subscriptionStatement("scheduled", "daily-scheduled", "2026-08-14", now),
    subscriptionStatement("invoice", "daily-invoice", "2026-08-14", now),
    usageEventStatement(
      "event-daily-first",
      "subscription-daily-scheduled",
      "daily-scheduled",
      "daily-event-first",
      "2026-08-14T06:00:00.000Z",
      "1",
      now,
    ),
    usageEventStatement(
      "event-daily-second",
      "subscription-daily-scheduled",
      "daily-scheduled",
      "daily-event-second",
      "2026-08-14T18:00:00.000Z",
      "2",
      now,
    ),
  ]);
});

describe("Cloudflare daily revenue analytics projection", () => {
  it("creates local-midnight cumulative snapshots and exact normalized daily deltas", async () => {
    const firstTriggeredAt = Date.parse("2026-08-14T07:15:00.000Z");
    const firstCandidates = await scheduledDailyUsageCandidates(env.BILLING_DB, firstTriggeredAt);
    expect(firstCandidates.map((candidate) => candidate.id)).toContain(
      "subscription-daily-scheduled",
    );
    const first = firstCandidates.find(
      (candidate) => candidate.id === "subscription-daily-scheduled",
    );
    expect(first).toMatchObject({
      usageDate: "2026-08-13",
      calculatedThrough: "2026-08-14T07:00:00.000Z",
    });
    await expect(
      projectScheduledDailyUsage(env.BILLING_DB, first!, new Date(firstTriggeredAt).toISOString()),
    ).resolves.toBe(true);

    const secondTriggeredAt = Date.parse(now);
    const secondCandidates = await scheduledDailyUsageCandidates(env.BILLING_DB, secondTriggeredAt);
    const second = secondCandidates.find(
      (candidate) => candidate.id === "subscription-daily-scheduled",
    );
    expect(second).toMatchObject({
      usageDate: "2026-08-14",
      calculatedThrough: "2026-08-15T07:00:00.000Z",
    });
    await expect(projectScheduledDailyUsage(env.BILLING_DB, second!, now)).resolves.toBe(true);

    await expect(
      env.BILLING_DB.prepare(
        `SELECT snapshot.usage_date, snapshot.amount_minor, line.cumulative_units_decimal,
                line.delta_units_decimal, line.cumulative_amount_minor,
                line.delta_amount_minor, line.billable_metric_code
         FROM daily_usage_snapshots snapshot
         JOIN daily_usage_charge_snapshots line ON line.daily_usage_snapshot_id = snapshot.id
         WHERE snapshot.subscription_id = 'subscription-daily-scheduled'
         ORDER BY snapshot.usage_date`,
      ).all(),
    ).resolves.toMatchObject({
      results: [
        {
          usage_date: "2026-08-13",
          amount_minor: 10,
          cumulative_units_decimal: "1",
          delta_units_decimal: "1",
          cumulative_amount_minor: 10,
          delta_amount_minor: 10,
          billable_metric_code: "daily_units",
        },
        {
          usage_date: "2026-08-14",
          amount_minor: 30,
          cumulative_units_decimal: "3",
          delta_units_decimal: "2",
          cumulative_amount_minor: 30,
          delta_amount_minor: 20,
          billable_metric_code: "daily_units",
        },
      ],
    });
    await expect(
      dailyUsageRollups(env.BILLING_DB, "org-daily", "2026-08-13", "2026-08-14"),
    ).resolves.toEqual([
      {
        usageDate: "2026-08-13",
        billableMetricCode: "daily_units",
        currency: "USD",
        amountMinor: 10,
        units: "1",
      },
      {
        usageDate: "2026-08-14",
        billableMetricCode: "daily_units",
        currency: "USD",
        amountMinor: 20,
        units: "2",
      },
    ]);
    const replay = await scheduledDailyUsageCandidates(env.BILLING_DB, secondTriggeredAt);
    expect(replay.some((candidate) => candidate.id === "subscription-daily-scheduled")).toBe(false);
  });

  it("repairs invoice-boundary snapshots idempotently when an invoice version changes", async () => {
    await env.BILLING_DB.batch([
      env.BILLING_DB.prepare(
        `INSERT INTO invoices
         (id, organization_id, customer_id, subscription_id, number, status, payment_status,
          currency, subtotal_minor, tax_minor, credits_minor, total_due_minor, version,
          finalized_at, issuing_date, created_at, updated_at)
         VALUES ('invoice-daily', 'org-daily', 'customer-daily', 'subscription-daily-invoice',
                 'INV-DAILY', 'finalized', 'pending', 'USD', 40, 0, 0, 40, 1, ?,
                 '2026-08-14', ?, ?)`,
      ).bind(now, now, now),
      env.BILLING_DB.prepare(
        `INSERT INTO invoice_subscriptions
         (invoice_id, subscription_id, organization_id, invoicing_reason, period_start,
          period_end, created_at)
         VALUES ('invoice-daily', 'subscription-daily-invoice', 'org-daily',
                 'subscription_periodic', '2026-08-01T07:00:00.000Z',
                 '2026-08-15T07:00:00.000Z', ?)`,
      ).bind(now),
      invoiceUsageLineStatement(40, "4", 4, now),
    ]);
    let candidates = await invoiceDailyUsageCandidates(env.BILLING_DB);
    let candidate = candidates.find((entry) => entry.invoiceId === "invoice-daily");
    expect(candidate).toMatchObject({
      subscriptionId: "subscription-daily-invoice",
      usageDate: "2026-08-14",
      invoiceVersion: 1,
    });
    await expect(projectInvoiceDailyUsage(env.BILLING_DB, candidate!)).resolves.toBe(true);
    expect(
      (await invoiceDailyUsageCandidates(env.BILLING_DB)).some(
        (entry) => entry.invoiceId === "invoice-daily",
      ),
    ).toBe(false);

    const refreshedAt = "2026-08-15T08:00:00.000Z";
    await env.BILLING_DB.batch([
      env.BILLING_DB.prepare(
        `UPDATE invoices SET version = 2, subtotal_minor = 60, total_due_minor = 60,
         updated_at = ? WHERE id = 'invoice-daily'`,
      ).bind(refreshedAt),
      env.BILLING_DB.prepare(
        `UPDATE invoice_lines SET quantity_decimal = '6', unit_amount_decimal = '10',
         amount_minor = 60, metadata_json = json_set(metadata_json, '$.eventCount', 6)
         WHERE id = 'line-daily-invoice'`,
      ),
    ]);
    candidates = await invoiceDailyUsageCandidates(env.BILLING_DB);
    candidate = candidates.find((entry) => entry.invoiceId === "invoice-daily");
    expect(candidate?.invoiceVersion).toBe(2);
    await expect(projectInvoiceDailyUsage(env.BILLING_DB, candidate!)).resolves.toBe(true);
    await expect(
      env.BILLING_DB.prepare(
        `SELECT snapshot.source_type, snapshot.source_invoice_version, snapshot.amount_minor,
                line.cumulative_units_decimal, line.cumulative_amount_minor
         FROM daily_usage_snapshots snapshot
         JOIN daily_usage_charge_snapshots line ON line.daily_usage_snapshot_id = snapshot.id
         WHERE snapshot.subscription_id = 'subscription-daily-invoice'`,
      ).first(),
    ).resolves.toEqual({
      source_type: "invoice",
      source_invoice_version: 2,
      amount_minor: 60,
      cumulative_units_decimal: "6",
      cumulative_amount_minor: 60,
    });
  });
});

function subscriptionStatement(
  suffix: string,
  externalId: string,
  lastReceivedEventOn: string,
  createdAt: string,
): D1PreparedStatement {
  return env.BILLING_DB.prepare(
    `INSERT INTO subscriptions
     (id, organization_id, customer_id, plan_id, external_id, status, subscription_at,
      started_at, current_period_start, current_period_end, billing_timezone,
      last_received_event_on, generation, version, created_at, updated_at)
     VALUES (?, 'org-daily', 'customer-daily', 'plan-daily', ?, 'active',
             '2026-08-01T07:00:00.000Z', '2026-08-01T07:00:00.000Z',
             '2026-08-01T07:00:00.000Z', '2026-09-01T07:00:00.000Z',
             'America/Los_Angeles', ?, 1, 1, ?, ?)`,
  ).bind(`subscription-daily-${suffix}`, externalId, lastReceivedEventOn, createdAt, createdAt);
}

function usageEventStatement(
  id: string,
  subscriptionId: string,
  externalSubscriptionId: string,
  transactionId: string,
  timestamp: string,
  units: string,
  createdAt: string,
): D1PreparedStatement {
  return env.BILLING_DB.prepare(
    `INSERT INTO usage_events
     (id, organization_id, subscription_id, customer_id, billable_metric_id, transaction_id,
      code, timestamp, timestamp_ms, properties_json, request_sha256, archive_key, created_at,
      external_subscription_id)
     VALUES (?, 'org-daily', ?, 'customer-daily', 'metric-daily', ?, 'daily_units', ?, ?, ?, ?,
             ?, ?, ?)`,
  ).bind(
    id,
    subscriptionId,
    transactionId,
    timestamp,
    Date.parse(timestamp),
    JSON.stringify({ units }),
    `hash-${id}`,
    `usage-events/daily/${id}.json`,
    createdAt,
    externalSubscriptionId,
  );
}

function invoiceUsageLineStatement(
  amount: number,
  units: string,
  events: number,
  createdAt: string,
): D1PreparedStatement {
  return env.BILLING_DB.prepare(
    `INSERT INTO invoice_lines
     (id, invoice_id, line_type, description, quantity_decimal, unit_amount_decimal,
      amount_minor, source_type, source_id, metadata_json, created_at, precise_amount_minor)
     VALUES ('line-daily-invoice', 'invoice-daily', 'usage', 'Daily usage', ?, '10', ?,
             'charge', 'charge-daily', ?, ?, ?)`,
  ).bind(
    units,
    amount,
    JSON.stringify({
      billableMetricCode: "daily_units",
      chargeCode: "daily-charge",
      chargeModel: "standard",
      eventCount: events,
      periodStart: "2026-08-01T07:00:00.000Z",
      periodEnd: "2026-08-15T07:00:00.000Z",
    }),
    createdAt,
    String(amount),
  );
}
