import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { handleOperatorAnalyticsRequest } from "../src/operator/analytics";
import { recordedPayments } from "../src/operator/recorded-payments";

async function fixture() {
  const org = crypto.randomUUID();
  const customer = crypto.randomUUID();
  const plan = crypto.randomUUID();
  const subscription = crypto.randomUUID();
  const now = "2026-09-01T00:00:00.000Z";
  await env.BILLING_DB.batch([
    env.BILLING_DB.prepare(`INSERT INTO organizations
      (id,external_id,name,created_at,updated_at) VALUES (?,?, 'Synthetic analytics',?,?)`).bind(
      org,
      org,
      now,
      now,
    ),
    env.BILLING_DB.prepare(`INSERT INTO customers
      (id,organization_id,external_id,created_at,updated_at) VALUES (?,?, 'synthetic',?,?)`).bind(
      customer,
      org,
      now,
      now,
    ),
    env.BILLING_DB.prepare(`INSERT INTO plans
      (id,organization_id,code,name,interval,amount_minor,currency,created_at,updated_at)
      VALUES (?,?,'one-time','One time','one_time',1700,'USD',?,?)`).bind(plan, org, now, now),
    env.BILLING_DB.prepare(`INSERT INTO subscriptions
      (id,organization_id,customer_id,plan_id,external_id,status,started_at,
       current_period_start,current_period_end,created_at,updated_at)
      VALUES (?,?,?,?,'synthetic-sub','active',?,?,?, ?,?)`).bind(
      subscription,
      org,
      customer,
      plan,
      now,
      now,
      "2026-10-01T00:00:00.000Z",
      now,
      now,
    ),
  ]);
  return { org, customer, plan, subscription, now };
}

async function read(org: string, metric = "") {
  const response = await handleOperatorAnalyticsRequest(
    new Request(
      `https://operator.test/api/operator/v1/analytics?from=2026-09-01&to=2026-09-30${metric ? `&billable_metric_code=${metric}` : ""}`,
    ),
    env.BILLING_DB,
    org,
    "synthetic-audit",
  );
  return (await response!.json()) as {
    analytics: {
      revenue_streams: {
        total_amount_minor: number;
        basis: string;
        includes_unpaid: boolean;
        breakdown: { stream: string; amount_minor: number; invoice_count: number }[];
      };
      mrr: {
        amount_minor: number;
        subscriptions_count: number;
        plan_breakdown: unknown[];
        basis: string;
        date_range_applies: boolean;
        discounts_applied: boolean;
      };
      usage: {
        total_amount_minor: number;
        total_units: string | number;
        total_events_count: number;
      };
      invoices: {
        collection_breakdown: {
          status: string;
          amount_minor: number;
          invoice_count: number;
        }[];
      };
    };
  };
}

describe("operator analytics financial semantics", () => {
  it("rejects impossible calendar dates instead of silently normalizing the report range", async () => {
    const f = await fixture();
    await expect(
      handleOperatorAnalyticsRequest(
        new Request(
          "https://operator.test/api/operator/v1/analytics?from=2026-02-30&to=2026-03-01",
        ),
        env.BILLING_DB,
        f.org,
        "invalid-calendar-date",
      ),
    ).rejects.toMatchObject({ code: "validation_error" });
  });

  it("forecasts complete UTC months with zero-activity months retained", async () => {
    const f = await fixture();
    const now = new Date().toISOString();
    await env.BILLING_DB.prepare(`INSERT INTO invoices
      (id,organization_id,customer_id,number,status,payment_status,currency,subtotal_minor,total_due_minor,finalized_at,created_at,updated_at)
      VALUES (?,?,?,'CURRENT','finalized','pending','USD',99999,99999,?,?,?)`)
      .bind(crypto.randomUUID(), f.org, f.customer, now, now, now)
      .run();
    const response = await handleOperatorAnalyticsRequest(
      new Request("https://operator.test/api/operator/v1/forecasts"),
      env.BILLING_DB,
      f.org,
      "forecast",
    );
    const body = (await response!.json()) as {
      forecast: {
        historical_months: { period: string; amount_minor: number }[];
        methodology: string;
      };
    };
    expect(body.forecast.historical_months).toHaveLength(12);
    expect(
      body.forecast.historical_months.every(
        (row) => row.amount_minor === 0 && row.period < now.slice(0, 7),
      ),
    ).toBe(true);
    expect(body.forecast.methodology).toContain("not a cash-collection forecast");
  });

  it("reports canonical successful receipts once, by currency and record date, not invoice value", async () => {
    const f = await fixture();
    const invoice = crypto.randomUUID();
    const request = crypto.randomUUID();
    const payment = crypto.randomUUID();
    await env.BILLING_DB.batch([
      env.BILLING_DB.prepare(`INSERT INTO invoices (id,organization_id,customer_id,number,status,payment_status,currency,subtotal_minor,total_due_minor,finalized_at,created_at,updated_at)
        VALUES (?,?,?,'SYNTHETIC','finalized','pending','USD',1700,1700,'2026-08-01','2026-08-01','2026-08-01')`).bind(
        invoice,
        f.org,
        f.customer,
      ),
      env.BILLING_DB.prepare(`INSERT INTO payment_requests (id,organization_id,customer_id,amount_minor,currency,payment_status,created_at,updated_at,collection_mode)
        VALUES (?,?,?,450,'USD','succeeded',?,?,'checkout')`).bind(
        request,
        f.org,
        f.customer,
        f.now,
        f.now,
      ),
      env.BILLING_DB.prepare(`INSERT INTO invoices_payment_requests (id,organization_id,payment_request_id,invoice_id,invoice_version,created_at,updated_at)
        VALUES (?,?,?,?,1,?,?)`).bind(crypto.randomUUID(), f.org, request, invoice, f.now, f.now),
      env.BILLING_DB.prepare(`INSERT INTO payment_request_payments (id,organization_id,payment_request_id,provider,provider_account_code,provider_transaction_id,idempotency_key,amount_minor,currency,status,created_at,updated_at)
        VALUES (?,?,?,'easy_pay_direct','synthetic',?,?,450,'USD','succeeded',?,?)`).bind(
        payment,
        f.org,
        request,
        payment,
        payment,
        f.now,
        f.now,
      ),
      env.BILLING_DB.prepare(`INSERT INTO payment_attempts (id,organization_id,invoice_id,provider,provider_account_code,provider_transaction_id,idempotency_key,amount_minor,currency,status,created_at,updated_at)
        VALUES (?,?,?,'easy_pay_direct','synthetic',?,?,450,'USD','succeeded',?,?)`).bind(
        crypto.randomUUID(),
        f.org,
        invoice,
        payment,
        crypto.randomUUID(),
        f.now,
        f.now,
      ),
      env.BILLING_DB.prepare(`INSERT INTO payment_attempts (id,organization_id,invoice_id,provider,provider_account_code,idempotency_key,amount_minor,currency,status,created_at,updated_at)
        VALUES (?,?,?,'easy_pay_direct','synthetic',?,1700,'USD','unknown',?,?)`).bind(
        crypto.randomUUID(),
        f.org,
        invoice,
        crypto.randomUUID(),
        f.now,
        f.now,
      ),
    ]);
    const report = await recordedPayments(env.BILLING_DB, f.org, "2026-09-01", "2026-09-30", null);
    expect(report).toMatchObject({
      settlement_verified: false,
      timezone: "UTC",
      includes_internal_purchases: true,
      currencies: [
        {
          currency: "USD",
          paid_minor: 450,
          refunded_minor: 0,
          net_minor: 450,
          payment_count: 1,
          refund_count: 0,
        },
      ],
    });
    expect(
      (await recordedPayments(env.BILLING_DB, f.org, "2026-08-01", "2026-08-31", null)).currencies,
    ).toEqual([]);
    expect(
      (
        await recordedPayments(
          env.BILLING_DB,
          crypto.randomUUID(),
          "2026-09-01",
          "2026-09-30",
          null,
        )
      ).currencies,
    ).toEqual([]);
    expect(
      (
        await recordedPayments(
          env.BILLING_DB,
          f.org,
          "2026-09-01",
          "2026-09-30",
          crypto.randomUUID(),
        )
      ).currencies,
    ).toEqual([]);
    // Pending refunds and credit-only notes are not refunded cash. A succeeded
    // provider-operation mirror must be counted only once.
    const note = crypto.randomUUID();
    const refund = crypto.randomUUID();
    const attempt = await env.BILLING_DB.prepare(
      "SELECT id FROM payment_attempts WHERE organization_id = ? AND provider_transaction_id = ?",
    )
      .bind(f.org, payment)
      .first<string>("id");
    await env.BILLING_DB.batch([
      env.BILLING_DB.prepare(`INSERT INTO credit_notes
        (id,organization_id,customer_id,invoice_id,sequential_id,number,status,credit_status,reason,currency,total_amount_minor,credit_amount_minor,balance_amount_minor,idempotency_key,request_sha256,issuing_date,created_at,updated_at)
        VALUES (?,?,?,?,1,?,'finalized','available','other','USD',100,100,100,?,'synthetic','2026-09-01',?,?)`).bind(
        note,
        f.org,
        f.customer,
        invoice,
        note,
        note,
        f.now,
        f.now,
      ),
      env.BILLING_DB.prepare(`INSERT INTO credit_note_refunds (id,organization_id,credit_note_id,invoice_id,provider_mode,provider_refund_id,amount_minor,currency,status,created_at,updated_at)
        VALUES (?,?,?,?,'easy_pay_direct_live',?,100,'USD','pending',?,?)`).bind(
        refund,
        f.org,
        note,
        invoice,
        refund,
        f.now,
        f.now,
      ),
      env.BILLING_DB.prepare(`INSERT INTO provider_refund_operations (id,organization_id,credit_note_id,invoice_id,payment_attempt_id,provider,provider_account_code,provider_payment_id,provider_refund_id,idempotency_key,request_sha256,amount_minor,currency,status,created_at,updated_at)
        VALUES (?,?,?,?,?,'easy_pay_direct','synthetic',?,?,?,'synthetic',100,'USD','pending',?,?)`).bind(
        refund,
        f.org,
        note,
        invoice,
        attempt,
        payment,
        refund,
        refund,
        f.now,
        f.now,
      ),
    ]);
    expect(
      (await recordedPayments(env.BILLING_DB, f.org, "2026-09-01", "2026-09-30", null))
        .currencies[0]?.refunded_minor,
    ).toBe(0);
    await env.BILLING_DB.batch([
      env.BILLING_DB.prepare("UPDATE credit_note_refunds SET status='succeeded' WHERE id=?").bind(
        refund,
      ),
      env.BILLING_DB.prepare(
        "UPDATE provider_refund_operations SET status='succeeded' WHERE id=?",
      ).bind(refund),
    ]);
    expect(
      (await recordedPayments(env.BILLING_DB, f.org, "2026-09-01", "2026-09-30", null)).currencies,
    ).toEqual([
      {
        currency: "USD",
        paid_minor: 450,
        refunded_minor: 100,
        net_minor: 350,
        payment_count: 1,
        refund_count: 1,
      },
    ]);
  });

  it("classifies a one-time compatibility subscription as one-off and excludes it from recurring counts", async () => {
    const f = await fixture();
    await env.BILLING_DB.prepare(`INSERT INTO invoices
      (id,organization_id,customer_id,subscription_id,number,status,payment_status,currency,
       subtotal_minor,tax_minor,credits_minor,total_due_minor,finalized_at,created_at,updated_at)
      VALUES (?,?,?,?,'SYNTHETIC','finalized','pending','USD',1700,0,0,1700,?,?,?)`)
      .bind(crypto.randomUUID(), f.org, f.customer, f.subscription, f.now, f.now, f.now)
      .run();
    const { analytics } = await read(f.org);
    expect(analytics.revenue_streams.breakdown).toEqual([
      { stream: "one_off", amount_minor: 1700, invoice_count: 1 },
    ]);
    expect(analytics.revenue_streams).toMatchObject({
      basis: "finalized_invoice_value",
      includes_unpaid: true,
      total_amount_minor: 1700,
    });
    expect(analytics.mrr).toMatchObject({
      amount_minor: 0,
      subscriptions_count: 0,
      plan_breakdown: [],
      basis: "current_list_price_run_rate",
      date_range_applies: false,
      discounts_applied: false,
    });
  });

  it("classifies an unknown automatic renewal as provider review required", async () => {
    const f = await fixture();
    const invoice = crypto.randomUUID();
    const request = crypto.randomUUID();
    const profile = crypto.randomUUID();
    const execution = crypto.randomUUID();
    await env.BILLING_DB.batch([
      env.BILLING_DB.prepare(
        `UPDATE customers SET payment_provider = 'easy_pay_direct',
         payment_provider_code = 'synthetic' WHERE id = ? AND organization_id = ?`,
      ).bind(f.customer, f.org),
      env.BILLING_DB.prepare(`INSERT INTO invoices
        (id,organization_id,customer_id,number,status,payment_status,currency,subtotal_minor,
         total_due_minor,finalized_at,payment_due_date,created_at,updated_at)
        VALUES (?,?,?,'AUTOMATIC-UNKNOWN','finalized','pending','USD',900,900,?,?,?,?)`).bind(
        invoice,
        f.org,
        f.customer,
        f.now,
        f.now,
        f.now,
        f.now,
      ),
      env.BILLING_DB.prepare(`INSERT INTO payment_requests
        (id,organization_id,customer_id,amount_minor,currency,payment_status,collection_mode,
         created_at,updated_at)
        VALUES (?,?,?,900,'USD','pending','checkout',?,?)`).bind(
        request,
        f.org,
        f.customer,
        f.now,
        f.now,
      ),
      env.BILLING_DB.prepare(`INSERT INTO invoices_payment_requests
        (id,organization_id,payment_request_id,invoice_id,invoice_version,created_at,updated_at)
        VALUES (?,?,?,?,1,?,?)`).bind(crypto.randomUUID(), f.org, request, invoice, f.now, f.now),
      env.BILLING_DB.prepare(`INSERT INTO provider_customer_profiles
        (id,organization_id,customer_id,provider,provider_account_code,provider_customer_id,
         gateway_customer_vault_id,initial_transaction_id,status,created_at,updated_at)
        VALUES (?,?,?,'easy_pay_direct','synthetic',?,'synthetic-vault','synthetic-initial',
                'active',?,?)`).bind(profile, f.org, f.customer, profile, f.now, f.now),
      env.BILLING_DB.prepare(`INSERT INTO easy_pay_direct_automatic_payment_executions
        (id,organization_id,payment_request_id,customer_id,provider_profile_id,
         provider_account_code,request_sha256,gateway_customer_vault_id,initial_transaction_id,
         order_reference,status,created_at,updated_at)
        VALUES (?,?,?,?,?,'synthetic','synthetic-hash','synthetic-vault','synthetic-initial',?,
                'unknown',?,?)`).bind(
        execution,
        f.org,
        request,
        f.customer,
        profile,
        execution,
        f.now,
        f.now,
      ),
    ]);

    expect((await read(f.org)).analytics.invoices.collection_breakdown).toEqual([
      { status: "provider_review_required", amount_minor: 900, invoice_count: 1 },
    ]);
  });

  it("does not multiply a daily usage snapshot across charges and filters the selected metric amount", async () => {
    const f = await fixture();
    const snapshot = crypto.randomUUID();
    await env.BILLING_DB.prepare(`INSERT INTO daily_usage_snapshots
      (id,organization_id,customer_id,subscription_id,external_subscription_id,usage_date,
       from_datetime,to_datetime,calculated_through,refreshed_at,currency,amount_minor,
       total_amount_minor,usage_json,usage_diff_json,source_type,created_at,updated_at)
      VALUES (?,?,?,?,'synthetic-sub','2026-09-01',?,?,?,?,'USD',300,300,'{}','{}','scheduled',?,?)`)
      .bind(snapshot, f.org, f.customer, f.subscription, f.now, f.now, f.now, f.now, f.now, f.now)
      .run();
    for (const [metric, amount] of [
      ["requests", 100],
      ["storage", 200],
    ] as const) {
      await env.BILLING_DB.prepare(`INSERT INTO daily_usage_charge_snapshots
        (id,daily_usage_snapshot_id,organization_id,customer_id,subscription_id,charge_id,
         billable_metric_id,billable_metric_code,currency,cumulative_units_decimal,
         delta_units_decimal,cumulative_events_count,delta_events_count,cumulative_amount_minor,
         delta_amount_minor,cumulative_usage_json,delta_usage_json,created_at,updated_at)
        VALUES (?,?,?,?,?,?,?,?,'USD','1','1',1,1,?,?,'{}','{}',?,?)`)
        .bind(
          crypto.randomUUID(),
          snapshot,
          f.org,
          f.customer,
          f.subscription,
          metric,
          metric,
          metric,
          amount,
          amount,
          f.now,
          f.now,
        )
        .run();
    }
    expect((await read(f.org)).analytics.usage).toMatchObject({
      total_amount_minor: 300,
      total_events_count: 2,
    });
    expect((await read(f.org, "requests")).analytics.usage).toMatchObject({
      total_amount_minor: 100,
      total_events_count: 1,
    });
    expect((await read(f.org, "storage")).analytics.usage.total_amount_minor).toBe(200);
    expect((await read(f.org, "missing")).analytics.usage.total_amount_minor).toBe(0);
    const other = await fixture();
    expect((await read(other.org)).analytics.usage.total_amount_minor).toBe(0);
  });
});
