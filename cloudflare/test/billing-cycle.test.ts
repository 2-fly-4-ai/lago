import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { closeBillingPeriod } from "../src/billing/close-period";

beforeEach(async () => {
  const now = "2026-08-13T00:00:00.000Z";
  await env.BILLING_DB.batch([
    env.BILLING_DB.prepare(
      `INSERT OR IGNORE INTO organizations (id, external_id, name, created_at, updated_at)
       VALUES ('org-cycle', 'cycle-test', 'Cycle Test', ?, ?)`,
    ).bind(now, now),
    env.BILLING_DB.prepare(
      `INSERT OR IGNORE INTO customers
       (id, organization_id, external_id, currency, metadata_json, created_at, updated_at)
       VALUES ('customer-cycle', 'org-cycle', 'customer-cycle-external', 'USD', '{}', ?, ?)`,
    ).bind(now, now),
    env.BILLING_DB.prepare(
      `INSERT OR IGNORE INTO plans
       (id, organization_id, code, name, interval, amount_minor, currency, version,
        active, created_at, updated_at)
       VALUES ('plan-cycle', 'org-cycle', 'cycle-plan', 'Cycle Plan', 'monthly', 1000,
               'USD', 1, 1, ?, ?)`,
    ).bind(now, now),
    env.BILLING_DB.prepare(
      `INSERT OR IGNORE INTO subscriptions
       (id, organization_id, customer_id, plan_id, external_id, status, started_at,
        current_period_start, current_period_end, version, created_at, updated_at)
       VALUES ('subscription-cycle', 'org-cycle', 'customer-cycle', 'plan-cycle',
               'subscription-cycle-external', 'active', '2026-07-31T00:00:00.000Z',
               '2026-07-31T00:00:00.000Z', '2026-08-31T00:00:00.000Z', 1, ?, ?)`,
    ).bind(now, now),
    env.BILLING_DB.prepare(
      `INSERT OR IGNORE INTO billable_metrics
       (id, organization_id, code, name, aggregation_type, field_name, recurring,
        properties_json, version, active, created_at, updated_at)
       VALUES ('metric-cycle', 'org-cycle', 'units', 'Units', 'sum_agg', 'quantity',
               0, '{}', 1, 1, ?, ?)`,
    ).bind(now, now),
    env.BILLING_DB.prepare(
      `INSERT OR IGNORE INTO charges
       (id, organization_id, plan_id, billable_metric_id, code, charge_model,
        properties_json, invoiceable, pay_in_advance, prorated, min_amount_minor,
        version, active, created_at, updated_at)
       VALUES ('charge-cycle', 'org-cycle', 'plan-cycle', 'metric-cycle', 'unit-charge',
               'standard', '{"amount":"2.5"}', 1, 0, 0, 0, 1, 1, ?, ?)`,
    ).bind(now, now),
    eventStatement("event-cycle-1", "inside-1", "2026-08-13T00:00:00.000Z", "0.1", now),
    eventStatement("event-cycle-2", "inside-2", "2026-08-20T00:00:00.000Z", "0.2", now),
    eventStatement("event-boundary", "boundary", "2026-08-31T00:00:00.000Z", "99", now),
  ]);
});

describe("billing period close", () => {
  it("creates one reconciled invoice and advances a month-end subscription once", async () => {
    const first = await closeBillingPeriod(
      env,
      "subscription-cycle",
      "2026-08-31T00:00:00.000Z",
      "cycle-test-1",
    );
    expect(first).toMatchObject({ replayed: false, totalDueMinor: 1001, lineCount: 2 });
    expect(first.nextPeriodEnd).toBe("2026-09-30T00:00:00.000Z");

    const replay = await closeBillingPeriod(
      env,
      "subscription-cycle",
      "2026-08-31T00:00:00.000Z",
      "cycle-test-replay",
    );
    expect(replay).toMatchObject({
      replayed: true,
      invoiceId: first.invoiceId,
      totalDueMinor: 1001,
      lineCount: 2,
    });

    const counts = await env.BILLING_DB.prepare(
      `SELECT
         (SELECT COUNT(*) FROM billing_cycles WHERE subscription_id = 'subscription-cycle') AS cycles,
         (SELECT COUNT(*) FROM invoices WHERE subscription_id = 'subscription-cycle') AS invoices,
         (SELECT COUNT(*) FROM outbox_events WHERE event_type = 'invoice.finalized'
           AND aggregate_id = ?) AS events`,
    )
      .bind(first.invoiceId)
      .first<{ cycles: number; invoices: number; events: number }>();
    expect(counts).toEqual({ cycles: 1, invoices: 1, events: 1 });

    const lines = await env.BILLING_DB.prepare(
      `SELECT line_type, amount_minor, precise_amount_minor, quantity_decimal
       FROM invoice_lines WHERE invoice_id = ? ORDER BY line_type`,
    )
      .bind(first.invoiceId)
      .all<{
        line_type: string;
        amount_minor: number;
        precise_amount_minor: string;
        quantity_decimal: string;
      }>();
    expect(lines.results).toEqual([
      {
        line_type: "subscription",
        amount_minor: 1000,
        precise_amount_minor: "1000",
        quantity_decimal: "1",
      },
      {
        line_type: "usage",
        amount_minor: 1,
        precise_amount_minor: "0.75",
        quantity_decimal: "0.3",
      },
    ]);
  });
});

function eventStatement(
  id: string,
  transactionId: string,
  timestamp: string,
  quantity: string,
  createdAt: string,
): D1PreparedStatement {
  return env.BILLING_DB.prepare(
    `INSERT OR IGNORE INTO usage_events
     (id, organization_id, subscription_id, customer_id, billable_metric_id,
      transaction_id, code, timestamp, timestamp_ms, properties_json, request_sha256,
      archive_key, created_at)
     VALUES (?, 'org-cycle', 'subscription-cycle', 'customer-cycle', 'metric-cycle', ?,
             'units', ?, ?, ?, ?, ?, ?)`,
  ).bind(
    id,
    transactionId,
    timestamp,
    Date.parse(timestamp),
    JSON.stringify({ quantity }),
    `hash-${id}`,
    `test/${id}.json`,
    createdAt,
  );
}
