import { env, SELF } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { sha256Hex } from "../src/auth/api-key";
import { activatePendingSubscriptions } from "../src/billing/activate-pending-subscriptions";
import {
  terminateEndedSubscriptions,
  terminateSubscriptionWithInvoice,
} from "../src/billing/terminate-subscription";
import { terminationBillingWindowUtc } from "../src/billing/subscription-invoice-calculation";

const apiKey = "subscription-lifecycle-key";
const headers = { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" };

beforeEach(async () => {
  const now = "2026-08-13T00:00:00.000Z";
  await env.BILLING_DB.batch([
    env.BILLING_DB.prepare(
      `INSERT OR IGNORE INTO organizations (id, external_id, name, created_at, updated_at)
       VALUES ('org-lifecycle', 'lifecycle', 'Lifecycle', ?, ?)`,
    ).bind(now, now),
    env.BILLING_DB.prepare(
      `INSERT OR IGNORE INTO api_keys
       (id, organization_id, key_prefix, key_hash, created_at, revoked_at)
       VALUES ('key-lifecycle', 'org-lifecycle', 'sub-life', ?, ?, NULL)`,
    ).bind(await sha256Hex(apiKey), now),
    env.BILLING_DB.prepare(
      `INSERT OR IGNORE INTO customers
       (id, organization_id, external_id, currency, metadata_json, created_at, updated_at)
       VALUES ('customer-lifecycle', 'org-lifecycle', 'customer-external', 'USD', '{}', ?, ?)`,
    ).bind(now, now),
    env.BILLING_DB.prepare(
      `INSERT OR IGNORE INTO plans
       (id, organization_id, code, name, interval, amount_minor, currency, version,
        active, created_at, updated_at)
       VALUES ('plan-lifecycle', 'org-lifecycle', 'monthly', 'Monthly', 'monthly',
               1000, 'USD', 1, 1, ?, ?)`,
    ).bind(now, now),
    env.BILLING_DB.prepare(
      `INSERT OR IGNORE INTO subscriptions
       (id, organization_id, customer_id, plan_id, external_id, status, started_at,
        current_period_start, current_period_end, version, created_at, updated_at)
       VALUES ('subscription-lifecycle', 'org-lifecycle', 'customer-lifecycle',
               'plan-lifecycle', 'subscription-external', 'active', ?, ?,
               '2026-09-13T00:00:00.000Z', 1, ?, ?)`,
    ).bind(now, now, now, now),
    env.BILLING_DB.prepare(
      `UPDATE subscriptions SET name = NULL, status = 'active', started_at = ?,
       current_period_start = ?, current_period_end = '2026-09-13T00:00:00.000Z',
       canceled_at = NULL, terminated_at = NULL, version = 1, updated_at = ?
       WHERE id = 'subscription-lifecycle'`,
    ).bind(now, now, now),
    env.BILLING_DB.prepare(
      `DELETE FROM outbox_events WHERE aggregate_id = 'subscription-lifecycle'
       AND event_type IN ('subscription.updated', 'subscription.terminated')`,
    ),
  ]);
});

describe("subscription lifecycle", () => {
  it("updates only the safe name field with an optimistic outbox event", async () => {
    const updated = await api("/api/v1/subscriptions/subscription-external", "PUT", {
      subscription: { name: "Renamed subscription" },
    });
    expect(updated.status).toBe(200);
    await expect(updated.json()).resolves.toMatchObject({
      subscription: { external_id: "subscription-external", name: "Renamed subscription" },
    });
    const event = await env.BILLING_DB.prepare(
      `SELECT event_type, aggregate_version FROM outbox_events
       WHERE event_type = 'subscription.updated' AND aggregate_id = 'subscription-lifecycle'`,
    ).first<{ event_type: string; aggregate_version: number }>();
    expect(event).toEqual({ event_type: "subscription.updated", aggregate_version: 2 });

    const guarded = await api("/api/v1/subscriptions/subscription-external", "PUT", {
      subscription: { ending_at: "2026-09-01T00:00:00.000Z" },
    });
    expect(guarded.status).toBe(422);
    await expect(guarded.json()).resolves.toMatchObject({
      code: "unsupported_subscription_feature",
    });
  });

  it("lists, shows, and idempotently terminates an in-arrears subscription with a final invoice", async () => {
    await expect(
      apiJson("/api/v1/subscriptions?external_customer_id=customer-external"),
    ).resolves.toMatchObject({
      meta: { total_count: 1 },
      subscriptions: [{ external_id: "subscription-external", status: "active" }],
    });
    await expect(apiJson("/api/v1/subscriptions/subscription-external")).resolves.toMatchObject({
      subscription: { status: "active", plan_code: "monthly" },
    });

    const path = "/api/v1/subscriptions/subscription-external";
    const first = await api(path, "DELETE");
    expect(first.status).toBe(200);
    const firstBody = await first.json<{ subscription: { terminated_at: string } }>();
    expect(firstBody.subscription.terminated_at).toBeTruthy();

    const replay = await api(path, "DELETE");
    expect(replay.status).toBe(200);
    await expect(replay.json()).resolves.toMatchObject({
      subscription: { status: "terminated", terminated_at: firstBody.subscription.terminated_at },
    });

    const state = await env.BILLING_DB.prepare(
      `SELECT
         (SELECT COUNT(*) FROM outbox_events
          WHERE event_type = 'subscription.terminated'
            AND aggregate_id = 'subscription-lifecycle') AS events,
         (SELECT version FROM subscriptions WHERE id = 'subscription-lifecycle') AS version,
         i.id AS invoice_id, i.subtotal_minor, i.total_due_minor,
         il.precise_amount_minor, il.metadata_json,
         (SELECT COUNT(*) FROM outbox_events
          WHERE event_type = 'invoice.finalized' AND aggregate_id = i.id) AS invoice_events
       FROM invoices i JOIN invoice_lines il ON il.invoice_id = i.id
       WHERE i.subscription_id = 'subscription-lifecycle' AND il.line_type = 'subscription'`,
    ).first<{
      events: number;
      version: number;
      invoice_id: string;
      subtotal_minor: number;
      total_due_minor: number;
      precise_amount_minor: string;
      metadata_json: string;
      invoice_events: number;
    }>();
    expect(state).toBeTruthy();
    const metadata = JSON.parse(state?.metadata_json ?? "{}") as {
      contextType: string;
      billableDays: number;
      fullPeriodDays: number;
      terminatedAt: string;
    };
    const expected = Math.round((1000 * metadata.billableDays) / metadata.fullPeriodDays);
    expect(state).toMatchObject({
      events: 1,
      version: 2,
      subtotal_minor: expected,
      total_due_minor: expected,
      invoice_events: 1,
    });
    expect(Number(state?.precise_amount_minor)).toBeCloseTo(
      (1000 * metadata.billableDays) / metadata.fullPeriodDays,
      10,
    );
    expect(metadata).toMatchObject({
      contextType: "termination",
      terminatedAt: firstBody.subscription.terminated_at,
    });
  });

  it("reschedules and cancels a pending subscription without creating an invoice", async () => {
    const firstStart = new Date(Date.now() + 120_000).toISOString();
    const created = await api("/api/v1/subscriptions", "POST", {
      subscription: {
        external_customer_id: "customer-external",
        external_id: "pending-subscription-external",
        plan_code: "monthly",
        subscription_at: firstStart,
      },
    });
    expect(created.status).toBe(200);
    const createdBody = await created.json<{ subscription: { lago_id: string } }>();

    const rescheduledAt = new Date(Date.now() + 240_000).toISOString();
    const updated = await api("/api/v1/subscriptions/pending-subscription-external", "PUT", {
      subscription: { name: "Rescheduled", subscription_at: rescheduledAt },
    });
    expect(updated.status).toBe(200);
    await expect(updated.json()).resolves.toMatchObject({
      subscription: {
        status: "pending",
        name: "Rescheduled",
        subscription_at: rescheduledAt,
        started_at: null,
      },
    });
    await expect(
      activatePendingSubscriptions(env, firstStart, "rescheduled-before-new-start"),
    ).resolves.toBe(0);

    const backdated = await api("/api/v1/subscriptions/pending-subscription-external", "PUT", {
      subscription: { subscription_at: new Date(Date.now() - 60_000).toISOString() },
    });
    expect(backdated.status).toBe(422);
    await expect(backdated.json()).resolves.toMatchObject({
      code: "unsupported_subscription_feature",
    });

    const canceled = await api("/api/v1/subscriptions/pending-subscription-external", "DELETE");
    expect(canceled.status).toBe(200);
    const canceledBody = await canceled.json<{
      subscription: { status: string; canceled_at: string; terminated_at: null };
    }>();
    expect(canceledBody.subscription).toMatchObject({ status: "canceled", terminated_at: null });
    expect(canceledBody.subscription.canceled_at).toBeTruthy();

    const replay = await api("/api/v1/subscriptions/pending-subscription-external", "DELETE");
    expect(replay.status).toBe(200);
    await expect(replay.json()).resolves.toMatchObject({
      subscription: {
        status: "canceled",
        canceled_at: canceledBody.subscription.canceled_at,
      },
    });
    await expect(
      activatePendingSubscriptions(env, rescheduledAt, "canceled-pending-activation"),
    ).resolves.toBe(0);

    await expect(
      env.BILLING_DB.prepare(
        `SELECT s.status, s.version,
                (SELECT COUNT(*) FROM invoices i WHERE i.subscription_id = s.id) AS invoices,
                (SELECT COUNT(*) FROM outbox_events o WHERE o.aggregate_id = s.id
                  AND o.event_type = 'subscription.updated') AS updated_events,
                (SELECT COUNT(*) FROM outbox_events o WHERE o.aggregate_id = s.id
                  AND o.event_type = 'subscription.terminated') AS terminated_events
         FROM subscriptions s WHERE s.id = ?`,
      )
        .bind(createdBody.subscription.lago_id)
        .first(),
    ).resolves.toEqual({
      status: "canceled",
      version: 3,
      invoices: 0,
      updated_events: 1,
      terminated_events: 1,
    });
  });

  it("keeps pay-in-advance termination invoices and unused-period credits guarded", async () => {
    const now = new Date().toISOString();
    await env.BILLING_DB.batch([
      env.BILLING_DB.prepare(
        `INSERT INTO plans
         (id, organization_id, code, name, interval, amount_minor, currency, pay_in_advance,
          version, active, created_at, updated_at)
         VALUES ('plan-lifecycle-advance', 'org-lifecycle', 'monthly-advance',
                 'Monthly advance', 'monthly', 1000, 'USD', 1, 1, 1, ?, ?)`,
      ).bind(now, now),
      env.BILLING_DB.prepare(
        `INSERT INTO subscriptions
         (id, organization_id, customer_id, plan_id, external_id, status, started_at,
          current_period_start, current_period_end, version, created_at, updated_at)
         VALUES ('subscription-lifecycle-advance', 'org-lifecycle', 'customer-lifecycle',
                 'plan-lifecycle-advance', 'subscription-external-advance', 'active', ?, ?,
                 '2026-09-13T00:00:00.000Z', 1, ?, ?)`,
      ).bind(now, now, now, now),
    ]);

    const scheduledGuard = await api("/api/v1/subscriptions", "POST", {
      subscription: {
        external_customer_id: "customer-external",
        external_id: "subscription-external-advance-scheduled",
        plan_code: "monthly-advance",
        ending_at: new Date(Date.now() + 2 * 86_400_000).toISOString(),
      },
    });
    expect(scheduledGuard.status).toBe(422);
    await expect(scheduledGuard.json()).resolves.toMatchObject({
      code: "unsupported_scheduled_termination",
    });

    const creditGuard = await api("/api/v1/subscriptions/subscription-external-advance", "DELETE");
    expect(creditGuard.status).toBe(422);
    await expect(creditGuard.json()).resolves.toMatchObject({
      code: "unsupported_termination_credit_note",
    });

    const invoiceGuard = await api(
      "/api/v1/subscriptions/subscription-external-advance?on_termination_credit_note=skip",
      "DELETE",
    );
    expect(invoiceGuard.status).toBe(422);
    await expect(invoiceGuard.json()).resolves.toMatchObject({
      code: "unsupported_termination_invoicing",
    });

    const skipped = await api(
      "/api/v1/subscriptions/subscription-external-advance?on_termination_invoice=skip&on_termination_credit_note=skip",
      "DELETE",
    );
    expect(skipped.status).toBe(200);
    await expect(skipped.json()).resolves.toMatchObject({
      subscription: { status: "terminated" },
    });
    await expect(
      env.BILLING_DB.prepare(
        "SELECT COUNT(*) AS total FROM invoices WHERE subscription_id = 'subscription-lifecycle-advance'",
      ).first(),
    ).resolves.toEqual({ total: 0 });
  });

  it("terminates a due UTC ending_at exactly once with a final in-arrears invoice", async () => {
    const endingAt = new Date(Date.now() + 2 * 86_400_000).toISOString();
    const created = await api("/api/v1/subscriptions", "POST", {
      subscription: {
        external_customer_id: "customer-external",
        external_id: "subscription-scheduled-end",
        plan_code: "monthly",
        ending_at: endingAt,
      },
    });
    expect(created.status).toBe(200);
    const createdBody = await created.json<{
      subscription: { lago_id: string; ending_at: string; status: string };
    }>();
    expect(createdBody.subscription).toMatchObject({ ending_at: endingAt, status: "active" });
    const replay = await api("/api/v1/subscriptions", "POST", {
      subscription: {
        external_customer_id: "customer-external",
        external_id: "subscription-scheduled-end",
        plan_code: "monthly",
        ending_at: endingAt,
      },
    });
    expect(replay.status).toBe(200);
    await expect(replay.json()).resolves.toMatchObject({
      subscription: { lago_id: createdBody.subscription.lago_id, ending_at: endingAt },
    });
    const conflict = await api("/api/v1/subscriptions", "POST", {
      subscription: {
        external_customer_id: "customer-external",
        external_id: "subscription-scheduled-end",
        plan_code: "monthly",
        ending_at: new Date(Date.parse(endingAt) + 86_400_000).toISOString(),
      },
    });
    expect(conflict.status).toBe(409);
    await expect(conflict.json()).resolves.toMatchObject({
      code: "subscription_idempotency_conflict",
    });

    await expect(
      terminateEndedSubscriptions(
        env,
        new Date(Date.parse(endingAt) - 1).toISOString(),
        "scheduled-end-before",
      ),
    ).resolves.toBe(0);
    await expect(terminateEndedSubscriptions(env, endingAt, "scheduled-end-due")).resolves.toBe(1);
    await expect(terminateEndedSubscriptions(env, endingAt, "scheduled-end-replay")).resolves.toBe(
      0,
    );

    await expect(
      env.BILLING_DB.prepare(
        `SELECT s.status, s.ending_at, s.terminated_at,
                (SELECT COUNT(*) FROM invoices i WHERE i.subscription_id = s.id) AS invoices,
                (SELECT COUNT(*) FROM outbox_events o WHERE o.aggregate_id = s.id
                  AND o.event_type = 'subscription.terminated') AS terminated_events,
                (SELECT COUNT(*) FROM outbox_events o JOIN invoices i ON i.id = o.aggregate_id
                  WHERE i.subscription_id = s.id AND o.event_type = 'invoice.finalized')
                  AS invoice_events
         FROM subscriptions s WHERE s.id = ?`,
      )
        .bind(createdBody.subscription.lago_id)
        .first(),
    ).resolves.toEqual({
      status: "terminated",
      ending_at: endingAt,
      terminated_at: endingAt,
      invoices: 1,
      terminated_events: 1,
      invoice_events: 1,
    });
  });

  it("matches legacy inclusive-day proration and excludes usage at the partial boundary", async () => {
    const periodStart = "2023-09-05T00:00:00.000Z";
    const periodEnd = "2023-10-05T00:00:00.000Z";
    const terminatedAt = "2023-09-06T00:15:00.000Z";
    await env.BILLING_DB.batch([
      env.BILLING_DB.prepare(
        `INSERT INTO organizations (id, external_id, name, created_at, updated_at)
         VALUES ('org-termination', 'termination', 'Termination', ?, ?)`,
      ).bind(periodStart, periodStart),
      env.BILLING_DB.prepare(
        `INSERT INTO customers
         (id, organization_id, external_id, currency, metadata_json, created_at, updated_at)
         VALUES ('customer-termination', 'org-termination', 'customer-termination-external',
                 'USD', '{}', ?, ?)`,
      ).bind(periodStart, periodStart),
      env.BILLING_DB.prepare(
        `INSERT INTO plans
         (id, organization_id, code, name, interval, amount_minor, currency, pay_in_advance,
          version, active, created_at, updated_at)
         VALUES ('plan-termination', 'org-termination', 'termination-plan', 'Termination plan',
                 'monthly', 1000, 'USD', 0, 1, 1, ?, ?)`,
      ).bind(periodStart, periodStart),
      env.BILLING_DB.prepare(
        `INSERT INTO subscriptions
         (id, organization_id, customer_id, plan_id, external_id, status, started_at,
          current_period_start, current_period_end, version, created_at, updated_at)
         VALUES ('subscription-termination', 'org-termination', 'customer-termination',
                 'plan-termination', 'subscription-termination-external', 'active', ?, ?, ?, 1, ?, ?)`,
      ).bind(periodStart, periodStart, periodEnd, periodStart, periodStart),
      env.BILLING_DB.prepare(
        `INSERT INTO billable_metrics
         (id, organization_id, code, name, aggregation_type, field_name, recurring,
          properties_json, version, active, created_at, updated_at)
         VALUES ('metric-termination', 'org-termination', 'termination-units', 'Termination units',
                 'sum_agg', 'quantity', 0, '{}', 1, 1, ?, ?)`,
      ).bind(periodStart, periodStart),
      env.BILLING_DB.prepare(
        `INSERT INTO charges
         (id, organization_id, plan_id, billable_metric_id, code, charge_model,
          properties_json, invoiceable, pay_in_advance, prorated, min_amount_minor,
          version, active, created_at, updated_at)
         VALUES ('charge-termination', 'org-termination', 'plan-termination', 'metric-termination',
                 'termination-charge', 'standard', '{"amount":"10"}', 1, 0, 0, 0, 1, 1, ?, ?)`,
      ).bind(periodStart, periodStart),
      terminationUsageEvent(
        "event-termination-start",
        "usage-start",
        "2023-09-05T12:00:00.000Z",
        "1",
        periodStart,
      ),
      terminationUsageEvent(
        "event-termination-last-day",
        "usage-last-day",
        "2023-09-06T23:59:59.000Z",
        "2",
        periodStart,
      ),
      terminationUsageEvent(
        "event-termination-boundary",
        "usage-boundary",
        "2023-09-07T00:00:00.000Z",
        "100",
        periodStart,
      ),
    ]);
    expect(terminationBillingWindowUtc(periodStart, periodEnd, terminatedAt)).toEqual({
      billableDays: 2,
      fullPeriodDays: 30,
      usagePeriodEnd: "2023-09-07T00:00:00.000Z",
    });

    const result = await terminateSubscriptionWithInvoice(
      env,
      "subscription-termination",
      1,
      terminatedAt,
      "termination-test",
    );
    expect(result).toMatchObject({ totalDueMinor: 97, lineCount: 2, terminatedAt });
    await expect(
      env.BILLING_DB.prepare(
        `SELECT s.status, s.version, s.terminated_at, s.current_period_end,
                i.status AS invoice_status, i.subtotal_minor, i.total_due_minor,
                (SELECT COUNT(*) FROM outbox_events o
                 WHERE o.aggregate_id = i.id AND o.event_type = 'invoice.finalized') AS invoice_events,
                (SELECT COUNT(*) FROM outbox_events o
                 WHERE o.aggregate_id = s.id AND o.event_type = 'subscription.terminated')
                  AS subscription_events
         FROM subscriptions s JOIN invoices i ON i.subscription_id = s.id
         WHERE s.id = 'subscription-termination'`,
      ).first(),
    ).resolves.toEqual({
      status: "terminated",
      version: 2,
      terminated_at: terminatedAt,
      current_period_end: terminatedAt,
      invoice_status: "finalized",
      subtotal_minor: 97,
      total_due_minor: 97,
      invoice_events: 1,
      subscription_events: 1,
    });
    const lines = await env.BILLING_DB.prepare(
      `SELECT line_type, quantity_decimal, precise_amount_minor, amount_minor, metadata_json
       FROM invoice_lines WHERE invoice_id = ? ORDER BY line_type`,
    )
      .bind(result.invoiceId)
      .all<{
        line_type: string;
        quantity_decimal: string;
        precise_amount_minor: string;
        amount_minor: number;
        metadata_json: string;
      }>();
    expect(lines.results.map(({ metadata_json: _metadata, ...line }) => line)).toEqual([
      {
        line_type: "subscription",
        quantity_decimal: "1",
        precise_amount_minor: "66.666666666666666667",
        amount_minor: 67,
      },
      {
        line_type: "usage",
        quantity_decimal: "3",
        precise_amount_minor: "30",
        amount_minor: 30,
      },
    ]);
    expect(lines.results.map((line) => JSON.parse(line.metadata_json))).toMatchObject([
      {
        contextType: "termination",
        billableDays: 2,
        fullPeriodDays: 30,
        periodStart,
        periodEnd: "2023-09-07T00:00:00.000Z",
        terminatedAt,
      },
      {
        contextType: "termination",
        eventCount: 2,
        periodStart,
        periodEnd: "2023-09-07T00:00:00.000Z",
      },
    ]);
  });
});

function api(path: string, method = "GET", body?: Record<string, unknown>): Promise<Response> {
  return SELF.fetch(`https://lago.test${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
}

async function apiJson(path: string): Promise<unknown> {
  const response = await api(path);
  expect(response.status).toBe(200);
  return response.json();
}

function terminationUsageEvent(
  id: string,
  transactionId: string,
  timestamp: string,
  quantity: string,
  createdAt: string,
): D1PreparedStatement {
  return env.BILLING_DB.prepare(
    `INSERT INTO usage_events
     (id, organization_id, subscription_id, customer_id, billable_metric_id,
      transaction_id, code, timestamp, timestamp_ms, properties_json, request_sha256,
      archive_key, created_at)
     VALUES (?, 'org-termination', 'subscription-termination', 'customer-termination',
             'metric-termination', ?, 'termination-units', ?, ?, ?, ?, ?, ?)`,
  ).bind(
    id,
    transactionId,
    timestamp,
    Date.parse(timestamp),
    JSON.stringify({ quantity }),
    `${id}-hash`,
    `${id}-archive`,
    createdAt,
  );
}
