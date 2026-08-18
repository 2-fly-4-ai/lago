import { env, SELF } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { closeBillingPeriod } from "../src/billing/close-period";
import { activatePendingSubscriptions } from "../src/billing/activate-pending-subscriptions";
import { sha256Hex } from "../src/auth/api-key";
import monthEndGolden from "../fixtures/billing/month-end-reconciliation.json";

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
       (id, organization_id, code, name, interval, amount_minor, currency, pay_in_advance,
        version, active, created_at, updated_at)
       VALUES ('plan-cycle', 'org-cycle', 'cycle-plan', 'Cycle Plan', 'monthly', 1000,
               'USD', 1, 1, 1, ?, ?)`,
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
  it("does not create an initial invoice for an in-arrears plan", async () => {
    const now = new Date().toISOString();
    await env.BILLING_DB.prepare(
      `INSERT INTO plans
       (id, organization_id, code, name, interval, amount_minor, currency, pay_in_advance,
        version, active, created_at, updated_at)
       VALUES ('plan-arrears', 'org-cycle', 'arrears-plan', 'Arrears Plan', 'monthly', 700,
               'USD', 0, 1, 1, ?, ?)`,
    )
      .bind(now, now)
      .run();
    const immediate = await invoiceRequest("/api/v1/subscriptions", "POST", {
      subscription: {
        external_customer_id: "customer-cycle-external",
        external_id: "subscription-arrears-immediate",
        plan_code: "arrears-plan",
      },
    });
    expect(immediate.status).toBe(200);
    const immediateBody = await immediate.json<{ subscription: { lago_id: string } }>();

    const futureAt = new Date(Date.now() + 60_000).toISOString();
    const future = await invoiceRequest("/api/v1/subscriptions", "POST", {
      subscription: {
        external_customer_id: "customer-cycle-external",
        external_id: "subscription-arrears-future",
        plan_code: "arrears-plan",
        subscription_at: futureAt,
      },
    });
    expect(future.status).toBe(200);
    const futureBody = await future.json<{ subscription: { lago_id: string } }>();
    await expect(activatePendingSubscriptions(env, futureAt, "activate-arrears")).resolves.toBe(1);

    const states = await env.BILLING_DB.prepare(
      `SELECT s.external_id, s.status,
              (SELECT COUNT(*) FROM invoices i WHERE i.subscription_id = s.id) AS invoices
       FROM subscriptions s WHERE s.id IN (?, ?) ORDER BY s.external_id`,
    )
      .bind(immediateBody.subscription.lago_id, futureBody.subscription.lago_id)
      .all();
    expect(states.results).toEqual([
      { external_id: "subscription-arrears-future", status: "active", invoices: 0 },
      { external_id: "subscription-arrears-immediate", status: "active", invoices: 0 },
    ]);
    await expect(
      env.BILLING_DB.prepare(
        `SELECT
           (SELECT COUNT(*) FROM outbox_events
            WHERE event_type = 'subscription.created'
              AND aggregate_id IN (?, ?)) AS created_events,
           (SELECT COUNT(*) FROM outbox_events
            WHERE event_type = 'subscription.started' AND aggregate_id = ?) AS started_events`,
      )
        .bind(
          immediateBody.subscription.lago_id,
          futureBody.subscription.lago_id,
          immediateBody.subscription.lago_id,
        )
        .first(),
    ).resolves.toEqual({ created_events: 2, started_events: 1 });
  });

  it("defers a future subscription and activates it with exactly one initial invoice", async () => {
    const subscriptionAt = new Date(Date.now() + 60_000).toISOString();
    const customerResponse = await invoiceRequest("/api/v1/customers", "POST", {
      customer: { external_id: "customer-future-external", currency: "USD" },
    });
    expect(customerResponse.status).toBe(200);
    const pendingResponse = await invoiceRequest("/api/v1/subscriptions", "POST", {
      subscription: {
        external_customer_id: "customer-future-external",
        external_id: "subscription-future-external",
        plan_code: "cycle-plan",
        subscription_at: subscriptionAt,
      },
    });
    expect(pendingResponse.status).toBe(200);
    const pendingBody = await pendingResponse.json<{
      subscription: { lago_id: string; status: string; subscription_at: string; started_at: null };
    }>();
    expect(pendingBody.subscription).toMatchObject({
      status: "pending",
      subscription_at: subscriptionAt,
      started_at: null,
    });
    const replayResponse = await invoiceRequest("/api/v1/subscriptions", "POST", {
      subscription: {
        external_customer_id: "customer-future-external",
        external_id: "subscription-future-external",
        plan_code: "cycle-plan",
        subscription_at: subscriptionAt,
      },
    });
    expect(replayResponse.status).toBe(200);
    await expect(replayResponse.json()).resolves.toMatchObject({
      subscription: { lago_id: pendingBody.subscription.lago_id, status: "pending" },
    });
    await expect(
      env.BILLING_DB.prepare("SELECT COUNT(*) AS total FROM invoices WHERE subscription_id = ?")
        .bind(pendingBody.subscription.lago_id)
        .first(),
    ).resolves.toEqual({ total: 0 });

    const beforeActivation = new Date(Date.parse(subscriptionAt) - 1).toISOString();
    await expect(
      activatePendingSubscriptions(env, beforeActivation, "pending-activation-before"),
    ).resolves.toBe(0);
    await expect(
      activatePendingSubscriptions(env, subscriptionAt, "pending-activation"),
    ).resolves.toBe(1);
    await expect(
      activatePendingSubscriptions(env, subscriptionAt, "pending-activation-replay"),
    ).resolves.toBe(0);

    await expect(
      env.BILLING_DB.prepare(
        `SELECT s.status, s.version, s.subscription_at, s.started_at,
                s.current_period_start,
                (SELECT COUNT(*) FROM invoices i WHERE i.subscription_id = s.id) AS invoices,
                (SELECT status FROM invoices i WHERE i.subscription_id = s.id LIMIT 1)
                  AS invoice_status,
                (SELECT COUNT(*) FROM outbox_events o
                 WHERE o.aggregate_id = s.id AND o.event_type = 'subscription.created') AS created,
                (SELECT COUNT(*) FROM outbox_events o
                 WHERE o.aggregate_id = s.id AND o.event_type = 'subscription.started') AS started
         FROM subscriptions s WHERE s.id = ?`,
      )
        .bind(pendingBody.subscription.lago_id)
        .first(),
    ).resolves.toEqual({
      status: "active",
      version: 2,
      subscription_at: subscriptionAt,
      started_at: subscriptionAt,
      current_period_start: subscriptionAt,
      invoices: 1,
      invoice_status: "finalized",
      created: 1,
      started: 1,
    });
    const invoiceEvents = await env.BILLING_DB.prepare(
      `SELECT COUNT(*) AS total FROM outbox_events o JOIN invoices i ON i.id = o.aggregate_id
       WHERE i.subscription_id = ? AND o.event_type = 'invoice.finalized'`,
    )
      .bind(pendingBody.subscription.lago_id)
      .first<{ total: number }>();
    expect(invoiceEvents?.total).toBe(1);
  });

  it("persists manual or provider-default policy across pending plan replacement", async () => {
    const now = new Date().toISOString();
    await env.BILLING_DB.prepare(
      `INSERT INTO plans
       (id, organization_id, code, name, interval, amount_minor, currency, pay_in_advance,
        version, active, created_at, updated_at)
       VALUES ('plan-policy-target', 'org-cycle', 'policy-target', 'Policy target', 'monthly',
               1200, 'USD', 1, 1, 1, ?, ?)`,
    )
      .bind(now, now)
      .run();
    const customer = await invoiceRequest("/api/v1/customers", "POST", {
      customer: { external_id: "customer-policy-external", currency: "USD" },
    });
    expect(customer.status).toBe(200);
    const subscriptionAt = new Date(Date.now() + 86_400_000).toISOString();
    const created = await invoiceRequest("/api/v1/subscriptions", "POST", {
      subscription: {
        external_customer_id: "customer-policy-external",
        external_id: "subscription-policy-external",
        plan_code: "cycle-plan",
        subscription_at: subscriptionAt,
        payment_method: { payment_method_type: "manual" },
      },
    });
    expect(created.status).toBe(200);
    await expect(created.json()).resolves.toMatchObject({
      subscription: {
        status: "pending",
        payment_method: { payment_method_id: null, payment_method_type: "manual" },
      },
    });

    const replaced = await invoiceRequest("/api/v1/subscriptions", "POST", {
      subscription: {
        external_customer_id: "customer-policy-external",
        external_id: "subscription-policy-external",
        plan_code: "policy-target",
        subscription_at: subscriptionAt,
      },
    });
    expect(replaced.status).toBe(200);
    await expect(replaced.json()).resolves.toMatchObject({
      subscription: {
        plan_code: "policy-target",
        payment_method: { payment_method_id: null, payment_method_type: "manual" },
      },
    });

    const providerDefault = await invoiceRequest(
      "/api/v1/subscriptions/subscription-policy-external",
      "PUT",
      { subscription: { payment_method: { payment_method_type: "provider" } } },
    );
    expect(providerDefault.status).toBe(200);
    await expect(providerDefault.json()).resolves.toMatchObject({
      subscription: {
        payment_method: { payment_method_id: null, payment_method_type: "provider" },
      },
    });
    const rejected = await invoiceRequest(
      "/api/v1/subscriptions/subscription-policy-external",
      "PUT",
      {
        subscription: {
          payment_method: { payment_method_id: "pm_external", payment_method_type: "provider" },
        },
      },
    );
    expect(rejected.status).toBe(422);
    await expect(rejected.json()).resolves.toMatchObject({
      code: "unsupported_subscription_payment_method",
    });
    const cleared = await invoiceRequest(
      "/api/v1/subscriptions/subscription-policy-external",
      "PUT",
      { subscription: { payment_method: null } },
    );
    expect(cleared.status).toBe(200);
    await expect(cleared.json()).resolves.toMatchObject({
      subscription: { payment_method: { payment_method_id: null, payment_method_type: null } },
    });
    await expect(
      env.BILLING_DB.prepare(
        `UPDATE subscriptions SET payment_method_id = 'unowned-provider-id'
         WHERE organization_id = 'org-cycle' AND external_id = 'subscription-policy-external'`,
      ).run(),
    ).rejects.toThrow("invalid_subscription_payment_method");
  });

  it("activates a backdated subscription without creating a retroactive invoice", async () => {
    const subscriptionAt = new Date(Date.now() - 45 * 86_400_000).toISOString();
    const customerResponse = await invoiceRequest("/api/v1/customers", "POST", {
      customer: { external_id: "customer-backdated-external", currency: "USD" },
    });
    expect(customerResponse.status).toBe(200);
    const response = await invoiceRequest("/api/v1/subscriptions", "POST", {
      subscription: {
        external_customer_id: "customer-backdated-external",
        external_id: "subscription-backdated-external",
        plan_code: "cycle-plan",
        billing_time: "anniversary",
        subscription_at: subscriptionAt,
      },
    });
    expect(response.status).toBe(200);
    const body = await response.json<{ subscription: { lago_id: string } }>();
    await expect(
      env.BILLING_DB.prepare(
        `SELECT status, subscription_at, started_at, current_period_start, current_period_end,
                (SELECT COUNT(*) FROM invoices WHERE subscription_id = subscriptions.id) AS invoices,
                (SELECT COUNT(*) FROM outbox_events
                 WHERE aggregate_id = subscriptions.id AND event_type = 'subscription.created')
                  AS created_events,
                (SELECT COUNT(*) FROM outbox_events
                 WHERE aggregate_id = subscriptions.id AND event_type = 'subscription.started')
                  AS started_events
         FROM subscriptions WHERE id = ?`,
      )
        .bind(body.subscription.lago_id)
        .first<{
          status: string;
          subscription_at: string;
          started_at: string;
          current_period_start: string;
          current_period_end: string;
          invoices: number;
          created_events: number;
          started_events: number;
        }>(),
    ).resolves.toMatchObject({
      status: "active",
      subscription_at: subscriptionAt,
      started_at: subscriptionAt,
      invoices: 0,
      created_events: 1,
      started_events: 1,
    });
    const persisted = await env.BILLING_DB.prepare(
      "SELECT current_period_start, current_period_end FROM subscriptions WHERE id = ?",
    )
      .bind(body.subscription.lago_id)
      .first<{ current_period_start: string; current_period_end: string }>();
    expect(Date.parse(persisted!.current_period_start)).toBeLessThanOrEqual(Date.now());
    expect(Date.parse(persisted!.current_period_end)).toBeGreaterThan(Date.now());

    const replay = await invoiceRequest("/api/v1/subscriptions", "POST", {
      subscription: {
        external_customer_id: "customer-backdated-external",
        external_id: "subscription-backdated-external",
        plan_code: "cycle-plan",
        billing_time: "anniversary",
        subscription_at: subscriptionAt,
      },
    });
    expect(replay.status).toBe(200);
    await expect(replay.json()).resolves.toMatchObject({
      subscription: { lago_id: body.subscription.lago_id, status: "active" },
    });
    await expect(
      env.BILLING_DB.prepare("SELECT COUNT(*) AS total FROM subscriptions WHERE external_id = ?")
        .bind("subscription-backdated-external")
        .first(),
    ).resolves.toEqual({ total: 1 });

    const close = await closeBillingPeriod(
      env,
      body.subscription.lago_id,
      persisted!.current_period_end,
      "backdated-cycle-close",
    );
    expect(close.replayed).toBe(false);
    await expect(
      env.BILLING_DB.prepare(
        `SELECT json_extract(metadata_json, '$.periodStart') AS period_start,
                json_extract(metadata_json, '$.periodEnd') AS period_end
         FROM invoice_lines WHERE invoice_id = ? AND line_type = 'subscription'`,
      )
        .bind(close.invoiceId)
        .first(),
    ).resolves.toEqual({
      period_start: persisted!.current_period_end,
      period_end: close.nextPeriodEnd,
    });
    await expect(
      closeBillingPeriod(
        env,
        body.subscription.lago_id,
        persisted!.current_period_end,
        "backdated-cycle-replay",
      ),
    ).resolves.toMatchObject({ invoiceId: close.invoiceId, replayed: true });
  });

  it("keeps backdated one-time subscriptions behind an explicit guard", async () => {
    const now = new Date().toISOString();
    await env.BILLING_DB.prepare(
      `INSERT INTO plans
       (id, organization_id, code, name, interval, amount_minor, currency, pay_in_advance,
        version, active, created_at, updated_at)
       VALUES ('plan-backdated-one-time', 'org-cycle', 'backdated-one-time', 'One time',
               'one_time', 1000, 'USD', 1, 1, 1, ?, ?)`,
    )
      .bind(now, now)
      .run();
    const response = await invoiceRequest("/api/v1/subscriptions", "POST", {
      subscription: {
        external_customer_id: "customer-cycle-external",
        external_id: "subscription-backdated-one-time",
        plan_code: "backdated-one-time",
        subscription_at: new Date(Date.now() - 45 * 86_400_000).toISOString(),
      },
    });
    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toMatchObject({
      code: "unsupported_subscription_feature",
      message: "Backdated one-time subscriptions are not implemented by the Cloudflare lifecycle",
    });
  });

  it("creates one reconciled invoice and advances a month-end subscription once", async () => {
    const expected = monthEndGolden.expected;
    const [expectedSubscriptionLine, expectedUsageLine] = expected.lines;
    const [expectedSubscriptionPeriod, expectedUsagePeriod] = expected.line_periods;
    if (
      !expectedSubscriptionLine ||
      !expectedUsageLine ||
      !expectedSubscriptionPeriod ||
      !expectedUsagePeriod
    ) {
      throw new Error("month_end_golden_fixture_incomplete");
    }
    const first = await closeBillingPeriod(
      env,
      "subscription-cycle",
      monthEndGolden.period.end,
      "cycle-test-1",
    );
    expect(first).toMatchObject({
      replayed: false,
      totalDueMinor: expected.total_due_minor,
      lineCount: expected.line_count,
    });
    expect(first.nextPeriodEnd).toBe(monthEndGolden.period.next_end);

    const replay = await closeBillingPeriod(
      env,
      "subscription-cycle",
      monthEndGolden.period.end,
      "cycle-test-replay",
    );
    expect(replay).toMatchObject({
      replayed: true,
      invoiceId: first.invoiceId,
      totalDueMinor: expected.total_due_minor,
      lineCount: expected.line_count,
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
        `SELECT i.subtotal_minor, i.tax_minor, i.credits_minor, i.total_due_minor,
                (SELECT COALESCE(SUM(il.amount_minor), 0) FROM invoice_lines il
                 WHERE il.invoice_id = i.id) AS line_total_minor,
                ac.status,
                (SELECT COUNT(*) FROM coupon_credits WHERE invoice_id = i.id) AS credit_count
         FROM invoices i JOIN applied_coupons ac ON ac.id = 'applied-cycle'
         WHERE i.id = ?`,
      )
        .bind(first.invoiceId)
        .first(),
    ).resolves.toEqual({
      subtotal_minor: expected.subtotal_minor,
      tax_minor: expected.tax_minor,
      credits_minor: expected.credits_minor,
      total_due_minor: expected.total_due_minor,
      line_total_minor: expected.subtotal_minor,
      status: "terminated",
      credit_count: 1,
    });

    const reconciled = await env.BILLING_DB.prepare(
      `SELECT subtotal_minor, tax_minor, credits_minor, total_due_minor
       FROM invoices WHERE id = ?`,
    )
      .bind(first.invoiceId)
      .first<{
        subtotal_minor: number;
        tax_minor: number;
        credits_minor: number;
        total_due_minor: number;
      }>();
    expect(reconciled).not.toBeNull();
    expect(reconciled!.subtotal_minor + reconciled!.tax_minor - reconciled!.credits_minor).toBe(
      reconciled!.total_due_minor,
    );

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
    expect(lines.results).toEqual(expected.lines);
    const periods = await env.BILLING_DB.prepare(
      `SELECT line_type, metadata_json FROM invoice_lines
       WHERE invoice_id = ? AND line_type IN ('subscription', 'usage') ORDER BY line_type`,
    )
      .bind(first.invoiceId)
      .all<{ line_type: string; metadata_json: string }>();
    expect(
      periods.results.map((line) => ({
        line_type: line.line_type,
        ...JSON.parse(line.metadata_json),
      })),
    ).toEqual([
      {
        line_type: "subscription",
        billingCycleId: first.billingCycleId,
        billingMode: expectedSubscriptionPeriod.billing_mode,
        periodStart: expectedSubscriptionPeriod.period_start,
        periodEnd: expectedSubscriptionPeriod.period_end,
      },
      {
        line_type: "usage",
        billingCycleId: first.billingCycleId,
        billableMetricCode: expectedUsagePeriod.billable_metric_code,
        chargeCode: expectedUsagePeriod.charge_code,
        chargeModel: expectedUsagePeriod.charge_model,
        eventCount: expectedUsagePeriod.event_count,
        periodStart: expectedUsagePeriod.period_start,
        periodEnd: expectedUsagePeriod.period_end,
      },
    ]);

    await expect(
      env.BILLING_DB.prepare(
        `SELECT current_period_start, current_period_end FROM subscriptions WHERE id = ?`,
      )
        .bind("subscription-cycle")
        .first(),
    ).resolves.toEqual({
      current_period_start: monthEndGolden.period.next_start,
      current_period_end: monthEndGolden.period.next_end,
    });

    const shown = await invoiceRequest(`/api/v1/invoices/${first.invoiceId}`);
    expect(shown.status).toBe(200);
    await expect(shown.json()).resolves.toMatchObject({
      invoice: {
        lago_id: first.invoiceId,
        status: "finalized",
        coupons_amount_cents: expected.credits_minor,
        credit_notes_amount_cents: 0,
        total_amount_cents: expected.total_due_minor,
        credits: [
          {
            amount_cents: expected.credits_minor,
            amount_currency: monthEndGolden.inputs.currency,
            before_taxes: true,
            item: { type: "coupon", code: "cycle-credit", name: "Cycle credit" },
          },
        ],
        fees: [
          { item: { type: "subscription" }, amount_cents: expectedSubscriptionLine.amount_minor },
          {
            item: { type: "usage" },
            amount_cents: expectedUsageLine.amount_minor,
            precise_amount_cents: expectedUsageLine.precise_amount_minor,
          },
        ],
      },
    });

    await env.BILLING_DB.prepare("UPDATE invoices SET payment_status = 'succeeded' WHERE id = ?")
      .bind(first.invoiceId)
      .run();
    const voided = await invoiceRequest(`/api/v1/invoices/${first.invoiceId}/void`, "POST");
    expect(voided.status).toBe(200);
    const voidedBody = await voided.json<{ invoice: { voided_at: string } }>();
    expect(voidedBody.invoice.voided_at).toBeTruthy();
    const voidReplay = await invoiceRequest(`/api/v1/invoices/${first.invoiceId}/void`, "POST");
    await expect(voidReplay.json()).resolves.toMatchObject({
      invoice: {
        status: "voided",
        payment_status: "succeeded",
        voided_at: voidedBody.invoice.voided_at,
      },
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

  it("rounds aggregated usage before recurring invoice rating", async () => {
    const now = "2026-08-13T00:00:00.000Z";
    await env.BILLING_DB.batch([
      env.BILLING_DB.prepare(
        `INSERT INTO plans
         (id, organization_id, code, name, interval, amount_minor, currency, version,
          active, created_at, updated_at)
         VALUES ('plan-rounded-cycle', 'org-cycle', 'rounded-cycle-plan', 'Rounded cycle plan',
                 'monthly', 0, 'USD', 1, 1, ?, ?)`,
      ).bind(now, now),
      env.BILLING_DB.prepare(
        `INSERT INTO billable_metrics
         (id, organization_id, code, name, aggregation_type, field_name, recurring,
          rounding_function, rounding_precision, properties_json, version, active,
          created_at, updated_at)
         VALUES ('metric-rounded-cycle', 'org-cycle', 'rounded-cycle-units',
                 'Rounded cycle units', 'sum_agg', 'quantity', 0, 'ceil', 1, '{}', 1, 1, ?, ?)`,
      ).bind(now, now),
      env.BILLING_DB.prepare(
        `INSERT INTO subscriptions
         (id, organization_id, customer_id, plan_id, external_id, status, started_at,
          current_period_start, current_period_end, version, created_at, updated_at)
         VALUES ('subscription-rounded-cycle', 'org-cycle', 'customer-cycle',
                 'plan-rounded-cycle', 'subscription-rounded-cycle-external', 'active',
                 '2026-07-31T00:00:00.000Z', '2026-07-31T00:00:00.000Z',
                 '2026-08-31T00:00:00.000Z', 1, ?, ?)`,
      ).bind(now, now),
      env.BILLING_DB.prepare(
        `INSERT INTO charges
         (id, organization_id, plan_id, billable_metric_id, code, charge_model,
          properties_json, invoiceable, pay_in_advance, prorated, min_amount_minor,
          version, active, created_at, updated_at)
         VALUES ('charge-rounded-cycle', 'org-cycle', 'plan-rounded-cycle',
                 'metric-rounded-cycle', 'rounded-cycle-charge', 'standard', '{"amount":"10"}',
                 1, 0, 0, 0, 1, 1, ?, ?)`,
      ).bind(now, now),
      ...["one", "two"].map((suffix, index) =>
        env.BILLING_DB.prepare(
          `INSERT INTO usage_events
           (id, organization_id, subscription_id, customer_id, billable_metric_id,
            transaction_id, code, timestamp, timestamp_ms, properties_json, request_sha256,
            archive_key, created_at)
           VALUES (?, 'org-cycle', 'subscription-rounded-cycle', 'customer-cycle',
                   'metric-rounded-cycle', ?, 'rounded-cycle-units', ?, ?,
                   '{"quantity":"1.231"}', ?, ?, ?)`,
        ).bind(
          `event-rounded-cycle-${suffix}`,
          `rounded-cycle-${suffix}`,
          `2026-08-13T00:0${index}:00.000Z`,
          Date.parse(`2026-08-13T00:0${index}:00.000Z`),
          `rounded-cycle-hash-${suffix}`,
          `rounded-cycle-archive-${suffix}`,
          now,
        ),
      ),
    ]);
    const result = await closeBillingPeriod(
      env,
      "subscription-rounded-cycle",
      "2026-08-31T00:00:00.000Z",
      "cycle-rounded",
    );
    expect(result).toMatchObject({ totalDueMinor: 25, lineCount: 2 });
    await expect(
      env.BILLING_DB.prepare(
        `SELECT quantity_decimal, precise_amount_minor, amount_minor
         FROM invoice_lines WHERE invoice_id = ? AND line_type = 'usage'`,
      )
        .bind(result.invoiceId)
        .first(),
    ).resolves.toEqual({ quantity_decimal: "2.5", precise_amount_minor: "25", amount_minor: 25 });
  });

  it("persists recurring weighted units and the carried end-of-period state", async () => {
    const now = "2026-09-15T00:00:00.000Z";
    const externalSubscriptionId = "subscription-weighted-cycle-external";
    const weightedEvents = [
      ["a", "2026-09-01T00:00:00.000Z", "2"],
      ["b", "2026-09-01T01:00:00.000Z", "3"],
      ["c", "2026-09-01T01:30:00.000Z", "1"],
      ["d", "2026-09-01T02:00:00.000Z", "-4"],
      ["e", "2026-09-01T04:00:00.000Z", "-2"],
      ["f", "2026-09-01T05:00:00.000Z", "10"],
      ["g", "2026-09-01T05:30:00.000Z", "-10"],
    ] as const;
    await env.BILLING_DB.batch([
      env.BILLING_DB.prepare(
        `INSERT INTO plans
         (id, organization_id, code, name, interval, amount_minor, currency, version,
          active, created_at, updated_at)
         VALUES ('plan-weighted-cycle', 'org-cycle', 'weighted-cycle-plan',
                 'Weighted cycle plan', 'monthly', 0, 'USD', 1, 1, ?, ?)`,
      ).bind(now, now),
      env.BILLING_DB.prepare(
        `INSERT INTO billable_metrics
         (id, organization_id, code, name, aggregation_type, field_name, recurring,
          weighted_interval, properties_json, version, active, created_at, updated_at)
         VALUES ('metric-weighted-cycle', 'org-cycle', 'weighted-cycle-units',
                 'Weighted cycle units', 'weighted_sum_agg', 'delta', 1, 'seconds', '{}',
                 1, 1, ?, ?)`,
      ).bind(now, now),
      env.BILLING_DB.prepare(
        `INSERT INTO subscriptions
         (id, organization_id, customer_id, plan_id, external_id, status, started_at,
          current_period_start, current_period_end, terminated_at, version, created_at, updated_at)
         VALUES ('subscription-weighted-cycle-prior', 'org-cycle', 'customer-cycle',
                 'plan-weighted-cycle', ?, 'terminated', '2026-08-01T00:00:00.000Z',
                 '2026-08-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z',
                 '2026-09-01T00:00:00.000Z', 1, ?, ?)`,
      ).bind(externalSubscriptionId, now, now),
      env.BILLING_DB.prepare(
        `INSERT INTO subscriptions
         (id, organization_id, customer_id, plan_id, external_id, status, started_at,
          current_period_start, current_period_end, version, created_at, updated_at,
          previous_subscription_id, transition_kind, transition_at, generation)
         VALUES ('subscription-weighted-cycle', 'org-cycle', 'customer-cycle',
                 'plan-weighted-cycle', ?, 'active', '2026-09-01T00:00:00.000Z',
                 '2026-09-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z', 1, ?, ?,
                 'subscription-weighted-cycle-prior', 'upgrade',
                 '2026-09-01T00:00:00.000Z', 2)`,
      ).bind(externalSubscriptionId, now, now),
      env.BILLING_DB.prepare(
        `INSERT INTO charges
         (id, organization_id, plan_id, billable_metric_id, code, charge_model,
          properties_json, invoiceable, pay_in_advance, prorated, min_amount_minor,
          version, active, created_at, updated_at)
         VALUES ('charge-weighted-cycle', 'org-cycle', 'plan-weighted-cycle',
                 'metric-weighted-cycle', 'weighted-cycle-charge', 'standard',
                 '{"amount":"1"}', 1, 0, 0, 0, 1, 1, ?, ?)`,
      ).bind(now, now),
      weightedEventStatement(
        "baseline",
        "2026-08-15T00:00:00.000Z",
        "1000",
        externalSubscriptionId,
        now,
        "subscription-weighted-cycle-prior",
      ),
      ...weightedEvents.map(([suffix, timestamp, delta]) =>
        weightedEventStatement(suffix, timestamp, delta, externalSubscriptionId, now),
      ),
    ]);

    const result = await closeBillingPeriod(
      env,
      "subscription-weighted-cycle",
      "2026-10-01T00:00:00.000Z",
      "cycle-weighted",
    );
    expect(result).toMatchObject({ totalDueMinor: 1000, lineCount: 2 });
    const line = await env.BILLING_DB.prepare(
      `SELECT quantity_decimal, precise_amount_minor, amount_minor, metadata_json
       FROM invoice_lines WHERE invoice_id = ? AND line_type = 'usage'`,
    )
      .bind(result.invoiceId)
      .first<{
        quantity_decimal: string;
        precise_amount_minor: string;
        amount_minor: number;
        metadata_json: string;
      }>();
    expect(line).toMatchObject({
      quantity_decimal: "1000.02291666666666666667",
      precise_amount_minor: "1000.02291666666666666667",
      amount_minor: 1000,
    });
    expect(JSON.parse(line!.metadata_json)).toMatchObject({ totalAggregatedUnits: "1000" });
  });

  it("creates a non-consuming draft, refreshes flagged late usage, and allocates credits only when finalized", async () => {
    const now = "2026-08-13T00:00:00.000Z";
    await env.BILLING_DB.batch([
      env.BILLING_DB.prepare(
        `INSERT INTO customers
         (id, organization_id, external_id, currency, metadata_json, invoice_grace_period,
          created_at, updated_at)
         VALUES ('customer-draft', 'org-cycle', 'customer-draft-external', 'USD', '{}', 3, ?, ?)`,
      ).bind(now, now),
      env.BILLING_DB.prepare(
        `INSERT INTO subscriptions
         (id, organization_id, customer_id, plan_id, external_id, status, started_at,
          current_period_start, current_period_end, version, created_at, updated_at)
         VALUES ('subscription-draft', 'org-cycle', 'customer-draft', 'plan-cycle',
                 'subscription-draft-external', 'active', '2026-07-31T00:00:00.000Z',
                 '2026-07-31T00:00:00.000Z', '2026-08-31T00:00:00.000Z', 1, ?, ?)`,
      ).bind(now, now),
      env.BILLING_DB.prepare(
        `INSERT INTO applied_coupons
         (id, organization_id, customer_id, coupon_id, amount_minor, currency,
          percentage_rate, frequency, frequency_duration, frequency_duration_remaining,
          status, termination_reason, reuse_slot, request_sha256, version, created_at, updated_at)
         VALUES ('applied-draft', 'org-cycle', 'customer-draft', 'coupon-cycle', 100, 'USD',
                 NULL, 'once', NULL, NULL, 'active', NULL, NULL, 'applied-draft-hash', 1, ?, ?)`,
      ).bind(now, now),
      eventStatement(
        "event-draft-1",
        "draft-inside-1",
        "2026-08-13T00:00:00.000Z",
        "0.1",
        now,
        "subscription-draft",
        "customer-draft",
      ),
      eventStatement(
        "event-draft-2",
        "draft-inside-2",
        "2026-08-20T00:00:00.000Z",
        "0.2",
        now,
        "subscription-draft",
        "customer-draft",
      ),
    ]);
    const drafted = await closeBillingPeriod(
      env,
      "subscription-draft",
      "2026-08-31T00:00:00.000Z",
      "cycle-draft",
    );
    await expect(
      env.BILLING_DB.prepare(
        `SELECT i.status, i.total_due_minor, i.issuing_date, i.expected_finalization_date,
                i.applied_grace_period, i.version, ac.status AS coupon_status,
                (SELECT COUNT(*) FROM coupon_credits WHERE invoice_id = i.id) AS coupon_credits,
                (SELECT COUNT(*) FROM credit_note_applications WHERE invoice_id = i.id) AS credit_notes,
                (SELECT COUNT(*) FROM wallet_transactions WHERE invoice_id = i.id) AS wallets
         FROM invoices i JOIN applied_coupons ac ON ac.id = 'applied-draft'
         WHERE i.id = ?`,
      )
        .bind(drafted.invoiceId)
        .first(),
    ).resolves.toEqual({
      status: "draft",
      total_due_minor: 901,
      issuing_date: "2026-08-30",
      expected_finalization_date: "2026-09-03",
      applied_grace_period: 3,
      version: 1,
      coupon_status: "active",
      coupon_credits: 0,
      credit_notes: 0,
      wallets: 0,
    });

    const lateUsage = await invoiceRequest("/api/v1/events", "POST", {
      event: {
        transaction_id: "late-draft-usage",
        code: "units",
        external_subscription_id: "subscription-draft-external",
        timestamp: Date.parse("2026-08-25T00:00:00.000Z") / 1000,
        properties: { quantity: "1" },
      },
    });
    expect(lateUsage.status).toBe(200);
    await expect(
      env.BILLING_DB.prepare("SELECT ready_to_be_refreshed FROM invoices WHERE id = ?")
        .bind(drafted.invoiceId)
        .first(),
    ).resolves.toEqual({ ready_to_be_refreshed: 1 });

    const refreshed = await invoiceRequest(`/api/v1/invoices/${drafted.invoiceId}/refresh`, "PUT");
    expect(refreshed.status).toBe(200);
    await expect(refreshed.json()).resolves.toMatchObject({
      invoice: { status: "draft", total_amount_cents: 903, version_number: 2 },
    });
    await expect(
      env.BILLING_DB.prepare(
        `SELECT ready_to_be_refreshed,
                (SELECT COUNT(*) FROM coupon_credits WHERE invoice_id = invoices.id) AS credits
         FROM invoices WHERE id = ?`,
      )
        .bind(drafted.invoiceId)
        .first(),
    ).resolves.toEqual({ ready_to_be_refreshed: 0, credits: 0 });

    const finalized = await invoiceRequest(`/api/v1/invoices/${drafted.invoiceId}/finalize`, "PUT");
    expect(finalized.status).toBe(200);
    await expect(finalized.json()).resolves.toMatchObject({
      invoice: { status: "finalized", total_amount_cents: 903, version_number: 3 },
    });
    await expect(
      env.BILLING_DB.prepare(
        `SELECT i.status, i.total_due_minor, ac.status AS coupon_status,
                (SELECT COUNT(*) FROM coupon_credits WHERE invoice_id = i.id) AS coupon_credits,
                (SELECT COUNT(*) FROM outbox_events WHERE aggregate_id = i.id
                  AND event_type = 'invoice.drafted') AS drafted_events,
                (SELECT COUNT(*) FROM outbox_events WHERE aggregate_id = i.id
                  AND event_type = 'invoice.refreshed') AS refreshed_events,
                (SELECT COUNT(*) FROM outbox_events WHERE aggregate_id = i.id
                  AND event_type = 'invoice.finalized') AS finalized_events
         FROM invoices i JOIN applied_coupons ac ON ac.id = 'applied-draft'
         WHERE i.id = ?`,
      )
        .bind(drafted.invoiceId)
        .first(),
    ).resolves.toEqual({
      status: "finalized",
      total_due_minor: 903,
      coupon_status: "terminated",
      coupon_credits: 1,
      drafted_events: 1,
      refreshed_events: 1,
      finalized_events: 1,
    });
  });

  it("creates, refreshes, and finalizes an initial grace-period subscription draft", async () => {
    const customer = await invoiceRequest("/api/v1/customers", "POST", {
      customer: {
        external_id: "customer-initial-grace",
        currency: "USD",
        billing_configuration: { invoice_grace_period: 2 },
      },
    });
    expect(customer.status).toBe(200);
    await expect(customer.json()).resolves.toMatchObject({
      customer: { billing_configuration: { invoice_grace_period: 2 } },
    });
    const subscription = await invoiceRequest("/api/v1/subscriptions", "POST", {
      subscription: {
        external_customer_id: "customer-initial-grace",
        external_id: "subscription-initial-grace",
        plan_code: "cycle-plan",
      },
    });
    expect(subscription.status).toBe(200);
    const subscriptionBody = await subscription.json<{
      subscription: { lago_id: string };
    }>();
    const initial = await env.BILLING_DB.prepare(
      `SELECT i.id, i.status, i.version, i.issuing_date, i.expected_finalization_date,
              CAST(julianday(i.expected_finalization_date) - julianday(date(i.created_at)) AS INTEGER)
                AS grace_days,
              (SELECT COUNT(*) FROM subscription_invoice_contexts sic
               WHERE sic.invoice_id = i.id AND sic.context_type = 'initial') AS contexts,
              (SELECT COUNT(*) FROM coupon_credits WHERE invoice_id = i.id) AS coupon_credits
       FROM invoices i WHERE i.subscription_id = ?`,
    )
      .bind(subscriptionBody.subscription.lago_id)
      .first<{
        id: string;
        status: string;
        version: number;
        issuing_date: string;
        expected_finalization_date: string;
        grace_days: number;
        contexts: number;
        coupon_credits: number;
      }>();
    expect(initial).toMatchObject({
      status: "draft",
      version: 1,
      grace_days: 2,
      contexts: 1,
      coupon_credits: 0,
    });
    expect(initial?.issuing_date).toBe(initial?.expected_finalization_date);

    const appliedCoupon = await invoiceRequest("/api/v1/applied_coupons", "POST", {
      applied_coupon: {
        external_customer_id: "customer-initial-grace",
        coupon_code: "cycle-credit",
      },
    });
    expect(appliedCoupon.status).toBe(200);
    await expect(draftRefreshState(initial?.id)).resolves.toEqual({
      ready_to_be_refreshed: 1,
      coupon_credits: 0,
    });

    const refreshed = await invoiceRequest(`/api/v1/invoices/${initial?.id}/refresh`, "PUT");
    expect(refreshed.status).toBe(200);
    await expect(refreshed.json()).resolves.toMatchObject({
      invoice: { status: "draft", version_number: 2, total_amount_cents: 900 },
    });
    await expect(draftRefreshState(initial?.id)).resolves.toEqual({
      ready_to_be_refreshed: 0,
      coupon_credits: 0,
    });

    const renamed = await invoiceRequest(
      "/api/v1/subscriptions/subscription-initial-grace",
      "PUT",
      { subscription: { name: "Renamed initial draft" } },
    );
    expect(renamed.status).toBe(200);
    await expect(draftRefreshState(initial?.id)).resolves.toMatchObject({
      ready_to_be_refreshed: 1,
    });
    const renamedRefresh = await invoiceRequest(`/api/v1/invoices/${initial?.id}/refresh`, "PUT");
    await expect(renamedRefresh.json()).resolves.toMatchObject({
      invoice: { status: "draft", version_number: 3, total_amount_cents: 900 },
    });
    await expect(
      env.BILLING_DB.prepare(
        "SELECT description FROM invoice_lines WHERE invoice_id = ? AND line_type = 'subscription'",
      )
        .bind(initial?.id)
        .first(),
    ).resolves.toEqual({ description: "Renamed initial draft" });

    const repriced = await invoiceRequest("/api/v1/plans/cycle-plan", "PUT", {
      plan: { amount_cents: 1200 },
    });
    expect(repriced.status).toBe(200);
    await expect(draftRefreshState(initial?.id)).resolves.toMatchObject({
      ready_to_be_refreshed: 1,
    });
    const repricedRefresh = await invoiceRequest(`/api/v1/invoices/${initial?.id}/refresh`, "PUT");
    await expect(repricedRefresh.json()).resolves.toMatchObject({
      invoice: { status: "draft", version_number: 4, total_amount_cents: 1100 },
    });

    const terminated = await invoiceRequest(
      "/api/v1/subscriptions/subscription-initial-grace?on_termination_invoice=skip&on_termination_credit_note=skip",
      "DELETE",
    );
    expect(terminated.status).toBe(200);
    await expect(terminated.json()).resolves.toMatchObject({
      subscription: { status: "terminated" },
    });
    await expect(draftRefreshState(initial?.id)).resolves.toMatchObject({
      ready_to_be_refreshed: 1,
    });
    const terminatedRefresh = await invoiceRequest(
      `/api/v1/invoices/${initial?.id}/refresh`,
      "PUT",
    );
    await expect(terminatedRefresh.json()).resolves.toMatchObject({
      invoice: { status: "draft", version_number: 5, total_amount_cents: 1100 },
    });

    const finalized = await invoiceRequest(`/api/v1/invoices/${initial?.id}/finalize`, "PUT");
    expect(finalized.status).toBe(200);
    await expect(finalized.json()).resolves.toMatchObject({
      invoice: { status: "finalized", version_number: 6, total_amount_cents: 1100 },
    });
    await expect(draftRefreshState(initial?.id)).resolves.toEqual({
      ready_to_be_refreshed: 0,
      coupon_credits: 1,
    });
  });
});

async function draftRefreshState(invoiceId: string | undefined): Promise<{
  ready_to_be_refreshed: number;
  coupon_credits: number;
} | null> {
  return env.BILLING_DB.prepare(
    `SELECT ready_to_be_refreshed,
            (SELECT COUNT(*) FROM coupon_credits WHERE invoice_id = invoices.id) AS coupon_credits
     FROM invoices WHERE id = ?`,
  )
    .bind(invoiceId)
    .first();
}

function invoiceRequest(path: string, method = "GET", body?: unknown): Promise<Response> {
  return SELF.fetch(`https://lago.test${path}`, {
    method,
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

function eventStatement(
  id: string,
  transactionId: string,
  timestamp: string,
  quantity: string,
  createdAt: string,
  subscriptionId = "subscription-cycle",
  customerId = "customer-cycle",
): D1PreparedStatement {
  return env.BILLING_DB.prepare(
    `INSERT OR IGNORE INTO usage_events
     (id, organization_id, subscription_id, customer_id, billable_metric_id,
      transaction_id, code, timestamp, timestamp_ms, properties_json, request_sha256,
      archive_key, created_at)
     VALUES (?, 'org-cycle', ?, ?, 'metric-cycle', ?,
             'units', ?, ?, ?, ?, ?, ?)`,
  ).bind(
    id,
    subscriptionId,
    customerId,
    transactionId,
    timestamp,
    Date.parse(timestamp),
    JSON.stringify({ quantity }),
    `hash-${id}`,
    `test/${id}.json`,
    createdAt,
  );
}

function weightedEventStatement(
  suffix: string,
  timestamp: string,
  delta: string,
  externalSubscriptionId: string,
  createdAt: string,
  subscriptionId = "subscription-weighted-cycle",
): D1PreparedStatement {
  return env.BILLING_DB.prepare(
    `INSERT INTO usage_events
     (id, organization_id, subscription_id, customer_id, billable_metric_id,
      transaction_id, code, timestamp, timestamp_ms, properties_json, request_sha256,
      archive_key, created_at, external_subscription_id)
     VALUES (?, 'org-cycle', ?, 'customer-cycle',
             'metric-weighted-cycle', ?, 'weighted-cycle-units', ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(
    `event-weighted-cycle-${suffix}`,
    subscriptionId,
    `weighted-cycle-${suffix}`,
    timestamp,
    Date.parse(timestamp),
    JSON.stringify({ delta }),
    `weighted-cycle-hash-${suffix}`,
    `weighted-cycle/${suffix}.json`,
    createdAt,
    externalSubscriptionId,
  );
}
