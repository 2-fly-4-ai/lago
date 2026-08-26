import { env, SELF } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { sha256Hex } from "../src/auth/api-key";
import { billEndedTrialSubscriptions } from "../src/billing/bill-ended-trials";
import { closeBillingPeriod } from "../src/billing/close-period";
import { refreshSubscriptionDraft } from "../src/billing/refresh-draft-invoice";

const apiKey = "trial-billing-test-key";
const headers = { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" };

beforeEach(async () => {
  const now = "2026-08-13T00:00:00.000Z";
  await env.BILLING_DB.batch([
    env.BILLING_DB.prepare(
      `INSERT OR IGNORE INTO organizations (id, external_id, name, created_at, updated_at)
       VALUES ('org-trial-billing', 'trial-billing', 'Trial Billing', ?, ?)`,
    ).bind(now, now),
    env.BILLING_DB.prepare(
      `INSERT OR IGNORE INTO api_keys
       (id, organization_id, key_prefix, key_hash, created_at, revoked_at)
       VALUES ('key-trial-billing', 'org-trial-billing', 'trial-key', ?, ?, NULL)`,
    ).bind(await sha256Hex(apiKey), now),
  ]);
});

describe("free-trial billing", () => {
  it("accepts customer timezone and plan trial fields, then bills the prorated base exactly once", async () => {
    const customer = await api("/api/v1/customers", "POST", {
      customer: {
        external_id: "trial-customer",
        name: "Trial Customer",
        currency: "EUR",
        timezone: "Europe/Paris",
      },
    });
    expect(customer.status).toBe(200);
    await expect(customer.json()).resolves.toMatchObject({
      customer: { external_id: "trial-customer", timezone: "Europe/Paris" },
    });

    const plan = await api("/api/v1/plans", "POST", {
      plan: {
        code: "trial-monthly",
        name: "Trial Monthly",
        interval: "monthly",
        amount_cents: 5_000_000,
        amount_currency: "EUR",
        pay_in_advance: true,
        trial_period: 10,
      },
    });
    expect(plan.status).toBe(200);
    await expect(plan.json()).resolves.toMatchObject({ plan: { trial_period: 10 } });

    const created = await api("/api/v1/subscriptions", "POST", {
      subscription: {
        external_customer_id: "trial-customer",
        external_id: "trial-subscription",
        plan_code: "trial-monthly",
      },
    });
    expect(created.status).toBe(200);
    await expect(created.json()).resolves.toMatchObject({
      subscription: {
        external_id: "trial-subscription",
        billing_time: "calendar",
        billing_timezone: "Europe/Paris",
      },
    });
    const shown = await SELF.fetch("https://lago.test/api/v1/subscriptions/trial-subscription", {
      headers,
    });
    await expect(shown.json()).resolves.toMatchObject({
      subscription: {
        billing_time: "calendar",
        billing_timezone: "Europe/Paris",
      },
    });

    const before = await env.BILLING_DB.prepare(
      `SELECT s.id, s.trial_started_at, s.trial_end_at, s.trial_ended_at,
              (SELECT COUNT(*) FROM invoices i WHERE i.subscription_id = s.id) AS invoices
       FROM subscriptions s WHERE s.external_id = 'trial-subscription'`,
    ).first<{
      id: string;
      trial_started_at: string;
      trial_end_at: string;
      trial_ended_at: string | null;
      invoices: number;
    }>();
    expect(before).toMatchObject({ trial_ended_at: null, invoices: 0 });
    expect(
      Date.parse(before?.trial_end_at ?? "") - Date.parse(before?.trial_started_at ?? ""),
    ).toBe(10 * 86_400_000);

    await expect(
      billEndedTrialSubscriptions(env, before?.trial_end_at ?? "", "trial-due"),
    ).resolves.toBe(1);
    await expect(
      billEndedTrialSubscriptions(env, before?.trial_end_at ?? "", "trial-replay"),
    ).resolves.toBe(0);

    const billed = await env.BILLING_DB.prepare(
      `SELECT s.trial_ended_at, i.status, i.subtotal_minor, il.precise_amount_minor,
              il.metadata_json,
              (SELECT COUNT(*) FROM invoices duplicate
               WHERE duplicate.subscription_id = s.id
                 AND EXISTS (
                   SELECT 1 FROM invoice_lines duplicate_line
                   WHERE duplicate_line.invoice_id = duplicate.id
                     AND duplicate_line.source_type = 'plan'
                 )) AS invoices,
              (SELECT COUNT(*) FROM outbox_events oe
               WHERE oe.aggregate_id = s.id AND oe.event_type = 'subscription.trial_ended') AS events
       FROM subscriptions s
       JOIN invoices i ON i.subscription_id = s.id
       JOIN invoice_lines il ON il.invoice_id = i.id AND il.line_type = 'subscription'
       WHERE s.id = ?`,
    )
      .bind(before?.id)
      .first<{
        trial_ended_at: string;
        status: string;
        subtotal_minor: number;
        precise_amount_minor: string;
        metadata_json: string;
        invoices: number;
        events: number;
      }>();
    const metadata = JSON.parse(billed?.metadata_json ?? "{}") as {
      contextType: string;
      billingTime: string;
      billingTimezone: string;
      billableDays: number;
      fullPeriodDays: number;
    };
    const expected = Math.round((5_000_000 * metadata.billableDays) / metadata.fullPeriodDays);
    expect(billed).toMatchObject({
      trial_ended_at: before?.trial_end_at,
      status: "finalized",
      subtotal_minor: expected,
      invoices: 1,
      events: 1,
    });
    expect(Number(billed?.precise_amount_minor)).toBeCloseTo(
      (5_000_000 * metadata.billableDays) / metadata.fullPeriodDays,
      8,
    );
    expect(metadata).toMatchObject({
      contextType: "initial",
      billingTime: "calendar",
      billingTimezone: "Europe/Paris",
    });
    await expect(
      env.BILLING_DB.prepare(
        `UPDATE subscriptions SET trial_end_at = '2099-01-01T00:00:00.000Z'
         WHERE id = ?`,
      )
        .bind(before?.id)
        .run(),
    ).rejects.toThrow("invalid_subscription_trial_transition");
    const immutable = await env.BILLING_DB.prepare(
      "SELECT trial_end_at, trial_ended_at FROM subscriptions WHERE id = ?",
    )
      .bind(before?.id)
      .first<{ trial_end_at: string; trial_ended_at: string }>();
    expect(immutable).toEqual({
      trial_end_at: before?.trial_end_at,
      trial_ended_at: before?.trial_end_at,
    });
  });

  it("rejects invalid timezone and billing-time values without persisting data", async () => {
    const customer = await api("/api/v1/customers", "POST", {
      customer: { external_id: "invalid-zone", timezone: "Mars/Olympus_Mons" },
    });
    expect(customer.status).toBe(422);
    await expect(customer.json()).resolves.toMatchObject({ code: "validation_error" });

    await api("/api/v1/customers", "POST", {
      customer: { external_id: "valid-zone", timezone: "Asia/Tokyo" },
    });
    await api("/api/v1/plans", "POST", {
      plan: {
        code: "invalid-billing-time-plan",
        name: "Invalid billing time plan",
        interval: "monthly",
        amount_cents: 100,
        amount_currency: "JPY",
      },
    });
    const subscription = await api("/api/v1/subscriptions", "POST", {
      subscription: {
        external_customer_id: "valid-zone",
        external_id: "invalid-billing-time",
        plan_code: "invalid-billing-time-plan",
        billing_time: "lunar",
      },
    });
    expect(subscription.status).toBe(422);
    await expect(subscription.json()).resolves.toMatchObject({ code: "validation_error" });
  });

  it("closes usage periods during a long trial and bills only the remaining calendar days", async () => {
    await seedDirectTrial({
      suffix: "long",
      start: "2024-03-05T11:12:00.000Z",
      periodEnd: "2024-03-31T22:00:00.000Z",
      trialEnd: "2024-04-14T10:12:00.000Z",
      timezone: "Europe/Paris",
    });
    const firstClose = await closeBillingPeriod(
      env,
      "subscription-trial-long",
      "2024-03-31T22:00:00.000Z",
      "long-trial-first-period",
    );
    expect(firstClose).toMatchObject({ totalDueMinor: 0, lineCount: 0 });
    expect(firstClose.nextPeriodEnd).toBe("2024-04-30T22:00:00.000Z");

    await expect(
      billEndedTrialSubscriptions(env, "2024-04-14T10:12:00.000Z", "long-trial-ended"),
    ).resolves.toBe(1);
    const invoices = await env.BILLING_DB.prepare(
      `SELECT i.subtotal_minor, COUNT(il.id) AS lines
       FROM invoices i LEFT JOIN invoice_lines il ON il.invoice_id = i.id
       WHERE i.subscription_id = 'subscription-trial-long'
       GROUP BY i.id, i.created_at ORDER BY i.created_at, i.id`,
    ).all<{ subtotal_minor: number; lines: number }>();
    expect(invoices.results).toHaveLength(2);
    expect(invoices.results).toEqual(
      expect.arrayContaining([
        { subtotal_minor: 0, lines: 0 },
        { subtotal_minor: Math.round((3_100 * 17) / 30), lines: 1 },
      ]),
    );
  });

  it("lets the billing owner win at an exact period boundary without a duplicate trial invoice", async () => {
    await seedDirectTrial({
      suffix: "boundary",
      start: "2024-03-01T00:00:00.000Z",
      periodEnd: "2024-04-01T00:00:00.000Z",
      trialEnd: "2024-04-01T00:00:00.000Z",
      timezone: "UTC",
    });
    const close = await closeBillingPeriod(
      env,
      "subscription-trial-boundary",
      "2024-04-01T00:00:00.000Z",
      "boundary-billing-owner",
    );
    expect(close).toMatchObject({ totalDueMinor: 3_100, lineCount: 1 });
    await expect(
      billEndedTrialSubscriptions(env, "2024-04-01T00:00:00.000Z", "boundary-trial-owner"),
    ).resolves.toBe(1);
    const state = await env.BILLING_DB.prepare(
      `SELECT s.trial_ended_at,
              (SELECT COUNT(*) FROM invoices i WHERE i.subscription_id = s.id) AS invoices,
              (SELECT COUNT(*) FROM invoice_lines il JOIN invoices i ON i.id = il.invoice_id
               WHERE i.subscription_id = s.id AND il.source_type = 'plan') AS plan_lines
       FROM subscriptions s WHERE s.id = 'subscription-trial-boundary'`,
    ).first<{ trial_ended_at: string; invoices: number; plan_lines: number }>();
    expect(state).toEqual({
      trial_ended_at: "2024-04-01T00:00:00.000Z",
      invoices: 1,
      plan_lines: 1,
    });
  });

  it("recovers a missed boundary close before ending the trial", async () => {
    await seedDirectTrial({
      suffix: "missed-boundary",
      start: "2024-03-01T00:00:00.000Z",
      periodEnd: "2024-04-01T00:00:00.000Z",
      trialEnd: "2024-04-01T00:00:00.000Z",
      timezone: "UTC",
    });
    await expect(
      billEndedTrialSubscriptions(env, "2024-04-01T00:00:00.000Z", "missed-boundary-trial-owner"),
    ).resolves.toBe(1);
    const state = await env.BILLING_DB.prepare(
      `SELECT s.current_period_start, s.current_period_end, s.trial_ended_at,
              (SELECT COUNT(*) FROM invoices i WHERE i.subscription_id = s.id) AS invoices,
              (SELECT COUNT(*) FROM invoice_lines il JOIN invoices i ON i.id = il.invoice_id
               WHERE i.subscription_id = s.id AND il.source_type = 'plan') AS plan_lines
       FROM subscriptions s WHERE s.id = 'subscription-trial-missed-boundary'`,
    ).first<{
      current_period_start: string;
      current_period_end: string;
      trial_ended_at: string;
      invoices: number;
      plan_lines: number;
    }>();
    expect(state).toEqual({
      current_period_start: "2024-04-01T00:00:00.000Z",
      current_period_end: "2024-05-01T00:00:00.000Z",
      trial_ended_at: "2024-04-01T00:00:00.000Z",
      invoices: 1,
      plan_lines: 1,
    });
  });

  it("prorates an in-arrears base from the trial end without an immediate trial invoice", async () => {
    await seedDirectTrial({
      suffix: "arrears",
      start: "2024-03-01T00:00:00.000Z",
      periodEnd: "2024-04-01T00:00:00.000Z",
      trialEnd: "2024-03-15T00:00:00.000Z",
      timezone: "UTC",
      payInAdvance: false,
    });
    await expect(
      billEndedTrialSubscriptions(env, "2024-03-15T00:00:00.000Z", "arrears-trial-end"),
    ).resolves.toBe(1);
    const beforeClose = await env.BILLING_DB.prepare(
      `SELECT trial_ended_at,
              (SELECT COUNT(*) FROM invoices i WHERE i.subscription_id = s.id) AS invoices
       FROM subscriptions s WHERE s.id = 'subscription-trial-arrears'`,
    ).first<{ trial_ended_at: string; invoices: number }>();
    expect(beforeClose).toEqual({
      trial_ended_at: "2024-03-15T00:00:00.000Z",
      invoices: 0,
    });

    const close = await closeBillingPeriod(
      env,
      "subscription-trial-arrears",
      "2024-04-01T00:00:00.000Z",
      "arrears-period-close",
    );
    expect(close).toMatchObject({ totalDueMinor: 1_700, lineCount: 1 });
    const line = await env.BILLING_DB.prepare(
      `SELECT precise_amount_minor, metadata_json FROM invoice_lines
       WHERE invoice_id = ? AND source_type = 'plan'`,
    )
      .bind(close.invoiceId)
      .first<{ precise_amount_minor: string; metadata_json: string }>();
    expect(Number(line?.precise_amount_minor)).toBeCloseTo((3_100 * 17) / 31, 10);
    expect(JSON.parse(line?.metadata_json ?? "{}")).toMatchObject({
      trialEndAt: "2024-03-15T00:00:00.000Z",
      billableDays: 17,
      fullPeriodDays: 31,
    });
  });

  it("ends a trial without duplicating a base invoice already issued on day one", async () => {
    await seedDirectTrial({
      suffix: "already-billed",
      start: "2024-03-05T12:12:00.000Z",
      periodEnd: "2024-04-01T00:00:00.000Z",
      trialEnd: "2024-03-15T12:12:00.000Z",
      timezone: "UTC",
    });
    await env.BILLING_DB.batch([
      env.BILLING_DB.prepare(
        `INSERT INTO invoices
         (id, organization_id, customer_id, subscription_id, status, payment_status, currency,
          subtotal_minor, total_due_minor, finalized_at, created_at, updated_at)
         VALUES ('invoice-trial-already-billed', 'org-trial-billing',
                 'customer-trial-already-billed', 'subscription-trial-already-billed',
                 'finalized', 'pending', 'USD', 3100, 3100, ?, ?, ?)`,
      ).bind("2024-03-05T12:12:00.000Z", "2024-03-05T12:12:00.000Z", "2024-03-05T12:12:00.000Z"),
      env.BILLING_DB.prepare(
        `INSERT INTO invoice_lines
         (id, invoice_id, line_type, description, quantity_decimal, unit_amount_decimal,
          amount_minor, source_type, source_id, metadata_json, created_at)
         VALUES ('line-trial-already-billed', 'invoice-trial-already-billed', 'subscription',
                 'Already billed', '1', '3100', 3100, 'plan', 'plan-trial-already-billed',
                 '{}', '2024-03-05T12:12:00.000Z')`,
      ),
      env.BILLING_DB.prepare(
        `INSERT INTO subscription_invoice_contexts
         (invoice_id, organization_id, subscription_id, context_type, period_start,
          period_end, created_at)
         VALUES ('invoice-trial-already-billed', 'org-trial-billing',
                 'subscription-trial-already-billed', 'initial',
                 '2024-03-05T12:12:00.000Z', '2024-04-01T00:00:00.000Z',
                 '2024-03-05T12:12:00.000Z')`,
      ),
    ]);
    await expect(
      billEndedTrialSubscriptions(env, "2024-03-15T12:12:00.000Z", "already-billed-trial-end"),
    ).resolves.toBe(1);
    const state = await env.BILLING_DB.prepare(
      `SELECT s.trial_ended_at,
              (SELECT COUNT(*) FROM invoices i WHERE i.subscription_id = s.id) AS invoices
       FROM subscriptions s WHERE s.id = 'subscription-trial-already-billed'`,
    ).first<{ trial_ended_at: string; invoices: number }>();
    expect(state).toEqual({ trial_ended_at: "2024-03-15T12:12:00.000Z", invoices: 1 });
  });

  it("refreshes and finalizes a grace-period trial invoice without adding charges", async () => {
    await api("/api/v1/customers", "POST", {
      customer: {
        external_id: "trial-grace-customer",
        currency: "USD",
        timezone: "Asia/Tokyo",
        invoice_grace_period: 2,
      },
    });
    await api("/api/v1/plans", "POST", {
      plan: {
        code: "trial-grace-plan",
        name: "Trial Grace Plan",
        interval: "monthly",
        amount_cents: 3_000,
        amount_currency: "USD",
        pay_in_advance: true,
        trial_period: 10,
      },
    });
    await api("/api/v1/subscriptions", "POST", {
      subscription: {
        external_customer_id: "trial-grace-customer",
        external_id: "trial-grace-subscription",
        plan_code: "trial-grace-plan",
      },
    });
    const subscription = await env.BILLING_DB.prepare(
      "SELECT trial_end_at FROM subscriptions WHERE external_id = 'trial-grace-subscription'",
    ).first<{ trial_end_at: string }>();
    const trialEnd = subscription?.trial_end_at ?? "";
    await expect(billEndedTrialSubscriptions(env, trialEnd, "trial-grace-end")).resolves.toBe(1);
    const draft = await env.BILLING_DB.prepare(
      `SELECT i.id, i.subtotal_minor, i.expected_finalization_date
       FROM invoices i
       JOIN subscription_invoice_contexts context ON context.invoice_id = i.id
       WHERE i.subscription_id =
         (SELECT id FROM subscriptions WHERE external_id = 'trial-grace-subscription')
         AND i.status = 'draft' AND context.context_type = 'initial'
         AND context.period_start = ?`,
    )
      .bind(trialEnd)
      .first<{ id: string; subtotal_minor: number; expected_finalization_date: string }>();
    expect(draft?.id).toBeTruthy();

    const refreshedAt = new Date(Date.parse(trialEnd) + 3_600_000).toISOString();
    const refreshed = await refreshSubscriptionDraft(
      env,
      draft?.id ?? "",
      "org-trial-billing",
      refreshedAt,
      "trial-grace-refresh",
      false,
    );
    expect(refreshed).toMatchObject({ finalized: false, lineCount: 1 });
    expect(refreshed.totalDueMinor).toBe(draft?.subtotal_minor);

    const finalizedAt = `${draft?.expected_finalization_date}T12:00:00.000Z`;
    const finalized = await refreshSubscriptionDraft(
      env,
      draft?.id ?? "",
      "org-trial-billing",
      finalizedAt,
      "trial-grace-finalize",
      true,
    );
    expect(finalized).toMatchObject({ finalized: true, lineCount: 1 });
    expect(finalized.totalDueMinor).toBe(draft?.subtotal_minor);
    const counts = await env.BILLING_DB.prepare(
      `SELECT
         (SELECT COUNT(*) FROM invoices WHERE id = ?) AS invoices,
         (SELECT COUNT(*) FROM invoice_lines WHERE invoice_id = ?) AS lines`,
    )
      .bind(draft?.id, draft?.id)
      .first<{ invoices: number; lines: number }>();
    expect(counts).toEqual({ invoices: 1, lines: 1 });
  });
});

async function api(path: string, method: string, body: unknown): Promise<Response> {
  return SELF.fetch(`https://lago.test${path}`, {
    method,
    headers,
    body: JSON.stringify(body),
  });
}

async function seedDirectTrial(input: {
  suffix: string;
  start: string;
  periodEnd: string;
  trialEnd: string;
  timezone: string;
  payInAdvance?: boolean;
}): Promise<void> {
  await env.BILLING_DB.batch([
    env.BILLING_DB.prepare(
      `INSERT INTO customers
       (id, organization_id, external_id, currency, metadata_json, timezone, created_at, updated_at)
       VALUES (?, 'org-trial-billing', ?, 'USD', '{}', ?, ?, ?)`,
    ).bind(
      `customer-trial-${input.suffix}`,
      `customer-trial-${input.suffix}`,
      input.timezone,
      input.start,
      input.start,
    ),
    env.BILLING_DB.prepare(
      `INSERT INTO plans
       (id, organization_id, code, name, interval, amount_minor, currency, pay_in_advance,
        trial_period, version, active, created_at, updated_at)
       VALUES (?, 'org-trial-billing', ?, ?, 'monthly', 3100, 'USD', ?, 40, 1, 1, ?, ?)`,
    ).bind(
      `plan-trial-${input.suffix}`,
      `plan-trial-${input.suffix}`,
      `Plan ${input.suffix}`,
      input.payInAdvance === false ? 0 : 1,
      input.start,
      input.start,
    ),
    env.BILLING_DB.prepare(
      `INSERT INTO subscriptions
       (id, organization_id, customer_id, plan_id, external_id, status, subscription_at,
        started_at, current_period_start, current_period_end, version, created_at, updated_at,
        billing_time, billing_timezone, trial_started_at, trial_end_at)
       VALUES (?, 'org-trial-billing', ?, ?, ?, 'active', ?, ?, ?, ?, 1, ?, ?,
               'calendar', ?, ?, ?)`,
    ).bind(
      `subscription-trial-${input.suffix}`,
      `customer-trial-${input.suffix}`,
      `plan-trial-${input.suffix}`,
      `subscription-trial-${input.suffix}`,
      input.start,
      input.start,
      input.start,
      input.periodEnd,
      input.start,
      input.start,
      input.timezone,
      input.start,
      input.trialEnd,
    ),
  ]);
}
