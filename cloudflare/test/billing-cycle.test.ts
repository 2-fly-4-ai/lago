import { env, SELF } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { closeBillingPeriod } from "../src/billing/close-period";
import { sha256Hex } from "../src/auth/api-key";

const apiKey = "billing-cycle-key";

beforeEach(async () => {
  const now = "2026-08-13T00:00:00.000Z";
  await env.BILLING_DB.batch([
    env.BILLING_DB.prepare(
      `INSERT OR IGNORE INTO organizations (id, external_id, name, created_at, updated_at)
       VALUES ('org-cycle', 'cycle-test', 'Cycle Test', ?, ?)`,
    ).bind(now, now),
    env.BILLING_DB.prepare(
      `INSERT OR IGNORE INTO api_keys
       (id, organization_id, key_prefix, key_hash, created_at, revoked_at)
       VALUES ('key-cycle', 'org-cycle', 'billing-', ?, ?, NULL)`,
    ).bind(await sha256Hex(apiKey), now),
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
    env.BILLING_DB.prepare(
      `INSERT OR IGNORE INTO coupons
       (id, organization_id, code, name, coupon_type, amount_minor, currency,
        percentage_rate, frequency, frequency_duration, expiration, expiration_at,
        reusable, status, request_sha256, created_at, updated_at)
       VALUES ('coupon-cycle', 'org-cycle', 'cycle-credit', 'Cycle credit', 'fixed_amount',
               100, 'USD', NULL, 'once', NULL, 'no_expiration', NULL, 1, 'active',
               'coupon-cycle-hash', ?, ?)`,
    ).bind(now, now),
    env.BILLING_DB.prepare(
      `INSERT OR IGNORE INTO applied_coupons
       (id, organization_id, customer_id, coupon_id, amount_minor, currency,
        percentage_rate, frequency, frequency_duration, frequency_duration_remaining,
        status, termination_reason, reuse_slot, request_sha256, version, created_at, updated_at)
       VALUES ('applied-cycle', 'org-cycle', 'customer-cycle', 'coupon-cycle', 100, 'USD',
               NULL, 'once', NULL, NULL, 'active', NULL, NULL, 'applied-cycle-hash', 1, ?, ?)`,
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
    expect(first).toMatchObject({ replayed: false, totalDueMinor: 901, lineCount: 2 });
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
      totalDueMinor: 901,
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
    await expect(
      env.BILLING_DB.prepare(
        `SELECT i.credits_minor, i.total_due_minor, ac.status,
                (SELECT COUNT(*) FROM coupon_credits WHERE invoice_id = i.id) AS credit_count
         FROM invoices i JOIN applied_coupons ac ON ac.id = 'applied-cycle'
         WHERE i.id = ?`,
      )
        .bind(first.invoiceId)
        .first(),
    ).resolves.toEqual({
      credits_minor: 100,
      total_due_minor: 901,
      status: "terminated",
      credit_count: 1,
    });

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

    const shown = await invoiceRequest(`/api/v1/invoices/${first.invoiceId}`);
    expect(shown.status).toBe(200);
    await expect(shown.json()).resolves.toMatchObject({
      invoice: {
        lago_id: first.invoiceId,
        status: "finalized",
        coupons_amount_cents: 100,
        credit_notes_amount_cents: 0,
        total_amount_cents: 901,
        credits: [
          {
            amount_cents: 100,
            amount_currency: "USD",
            before_taxes: true,
            item: { type: "coupon", code: "cycle-credit", name: "Cycle credit" },
          },
        ],
        fees: [
          { item: { type: "subscription" }, amount_cents: 1000 },
          { item: { type: "usage" }, amount_cents: 1, precise_amount_cents: "0.75" },
        ],
      },
    });

    const voided = await invoiceRequest(`/api/v1/invoices/${first.invoiceId}/void`, "POST");
    expect(voided.status).toBe(200);
    const voidedBody = await voided.json<{ invoice: { voided_at: string } }>();
    expect(voidedBody.invoice.voided_at).toBeTruthy();
    const voidReplay = await invoiceRequest(`/api/v1/invoices/${first.invoiceId}/void`, "POST");
    await expect(voidReplay.json()).resolves.toMatchObject({
      invoice: { status: "voided", voided_at: voidedBody.invoice.voided_at },
    });
    const voidCount = await env.BILLING_DB.prepare(
      "SELECT COUNT(*) AS total FROM outbox_events WHERE event_type = 'invoice.voided' AND aggregate_id = ?",
    )
      .bind(first.invoiceId)
      .first<{ total: number }>();
    expect(voidCount?.total).toBe(1);
    await expect(
      env.BILLING_DB.prepare(
        `SELECT ac.status, ac.termination_reason,
                COALESCE(SUM(CASE WHEN i.status <> 'voided' THEN cc.amount_minor ELSE 0 END), 0) AS consumed
         FROM applied_coupons ac LEFT JOIN coupon_credits cc ON cc.applied_coupon_id = ac.id
         LEFT JOIN invoices i ON i.id = cc.invoice_id WHERE ac.id = 'applied-cycle'
         GROUP BY ac.id`,
      ).first(),
    ).resolves.toEqual({ status: "active", termination_reason: null, consumed: 0 });
  });

  it("adds only the minimum-commitment shortfall as an auditable fee", async () => {
    const now = "2026-08-13T00:00:00.000Z";
    await env.BILLING_DB.batch([
      env.BILLING_DB.prepare(
        `INSERT INTO plans
         (id, organization_id, code, name, interval, amount_minor, currency, version,
          active, created_at, updated_at)
         VALUES ('plan-commitment-cycle', 'org-cycle', 'commitment-cycle-plan',
                 'Commitment Cycle Plan', 'monthly', 1000, 'USD', 1, 1, ?, ?)`,
      ).bind(now, now),
      env.BILLING_DB.prepare(
        `INSERT INTO subscriptions
         (id, organization_id, customer_id, plan_id, external_id, status, started_at,
          current_period_start, current_period_end, version, created_at, updated_at)
         VALUES ('subscription-commitment-cycle', 'org-cycle', 'customer-cycle',
                 'plan-commitment-cycle', 'subscription-commitment-cycle-external', 'active',
                 '2026-07-31T00:00:00.000Z', '2026-07-31T00:00:00.000Z',
                 '2026-08-31T00:00:00.000Z', 1, ?, ?)`,
      ).bind(now, now),
      env.BILLING_DB.prepare(
        `INSERT INTO minimum_commitments
         (id, organization_id, plan_id, amount_minor, invoice_display_name, created_at, updated_at)
         VALUES ('commitment-cycle', 'org-cycle', 'plan-commitment-cycle', 1500,
                 'Monthly minimum', ?, ?)`,
      ).bind(now, now),
      env.BILLING_DB.prepare(
        `INSERT INTO charges
         (id, organization_id, plan_id, billable_metric_id, code, charge_model,
          properties_json, invoiceable, pay_in_advance, prorated, min_amount_minor,
          version, active, created_at, updated_at)
         VALUES ('charge-commitment-cycle', 'org-cycle', 'plan-commitment-cycle',
                 'metric-cycle', 'commitment-unit-charge', 'standard', '{"amount":"2.5"}',
                 1, 0, 0, 0, 1, 1, ?, ?)`,
      ).bind(now, now),
      env.BILLING_DB.prepare(
        `INSERT INTO usage_events
         (id, organization_id, subscription_id, customer_id, billable_metric_id,
          transaction_id, code, timestamp, timestamp_ms, properties_json, request_sha256,
          archive_key, created_at)
         VALUES ('event-commitment-cycle', 'org-cycle', 'subscription-commitment-cycle',
                 'customer-cycle', 'metric-cycle', 'commitment-usage', 'units',
                 '2026-08-13T00:00:00.000Z', ?, '{"quantity":"0.3"}',
                 'commitment-event-hash', 'commitment-event-archive', ?)`,
      ).bind(Date.parse("2026-08-13T00:00:00.000Z"), now),
    ]);
    const result = await closeBillingPeriod(
      env,
      "subscription-commitment-cycle",
      "2026-08-31T00:00:00.000Z",
      "cycle-commitment",
    );
    expect(result).toMatchObject({ totalDueMinor: 1400, lineCount: 3 });
    await expect(
      env.BILLING_DB.prepare(
        `SELECT amount_minor, precise_amount_minor, description, source_type
         FROM invoice_lines WHERE invoice_id = ? AND line_type = 'commitment'`,
      )
        .bind(result.invoiceId)
        .first(),
    ).resolves.toEqual({
      amount_minor: 499,
      precise_amount_minor: "499.25",
      description: "Monthly minimum",
      source_type: "commitment",
    });
  });
});

function invoiceRequest(path: string, method = "GET"): Promise<Response> {
  return SELF.fetch(`https://lago.test${path}`, {
    method,
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
  });
}

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
