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
      `UPDATE customers SET invoice_grace_period = 0, updated_at = ?
       WHERE id = 'customer-lifecycle'`,
    ).bind(now),
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

  it("creates a non-consuming grace-period termination draft and finalizes it from immutable boundaries", async () => {
    const customer = await api("/api/v1/customers", "POST", {
      customer: {
        external_id: "customer-termination-grace",
        currency: "USD",
        billing_configuration: { invoice_grace_period: 3 },
      },
    });
    expect(customer.status).toBe(200);
    const created = await api("/api/v1/subscriptions", "POST", {
      subscription: {
        external_customer_id: "customer-termination-grace",
        external_id: "subscription-termination-grace",
        plan_code: "monthly",
      },
    });
    expect(created.status).toBe(200);
    const createdBody = await created.json<{ subscription: { lago_id: string } }>();
    const original = await env.BILLING_DB.prepare(
      "SELECT current_period_end FROM subscriptions WHERE id = ?",
    )
      .bind(createdBody.subscription.lago_id)
      .first<{ current_period_end: string }>();
    const wallet = await api("/api/v1/wallets", "POST", {
      wallet: {
        external_customer_id: "customer-termination-grace",
        code: "termination-grace-wallet",
        currency: "USD",
        rate_amount: "1",
        granted_credits: "20",
      },
    });
    expect(wallet.status).toBe(200);

    const terminated = await api("/api/v1/subscriptions/subscription-termination-grace", "DELETE");
    const terminatedBody = await terminated.json();
    expect({ status: terminated.status, body: terminatedBody }).toMatchObject({
      status: 200,
      body: { subscription: { status: "terminated" } },
    });
    const draft = await env.BILLING_DB.prepare(
      `SELECT i.id, i.status, i.version, i.applied_grace_period,
              i.total_due_minor, i.credits_minor,
              CAST(julianday(i.expected_finalization_date) - julianday(date(i.created_at))
                AS INTEGER) AS grace_days,
              sic.context_type, sic.period_start, sic.period_end, sic.terminated_at,
              s.current_period_end AS terminated_period_end,
              (SELECT COUNT(*) FROM wallet_transactions wt
               WHERE wt.invoice_id = i.id AND wt.transaction_type = 'outbound') AS allocations,
              (SELECT COUNT(*) FROM outbox_events o WHERE o.aggregate_id = i.id
               AND o.event_type = 'invoice.drafted') AS drafted_events,
              (SELECT COUNT(*) FROM outbox_events o WHERE o.aggregate_id = i.id
               AND o.event_type = 'invoice.finalized') AS finalized_events
       FROM invoices i
       JOIN subscription_invoice_contexts sic ON sic.invoice_id = i.id
       JOIN subscriptions s ON s.id = i.subscription_id
       WHERE i.subscription_id = ? AND sic.context_type = 'termination'`,
    )
      .bind(createdBody.subscription.lago_id)
      .first<{
        id: string;
        status: string;
        version: number;
        applied_grace_period: number;
        total_due_minor: number;
        credits_minor: number;
        grace_days: number;
        context_type: string;
        period_start: string;
        period_end: string;
        terminated_at: string;
        terminated_period_end: string;
        allocations: number;
        drafted_events: number;
        finalized_events: number;
      }>();
    expect(draft).toMatchObject({
      status: "draft",
      version: 1,
      applied_grace_period: 3,
      total_due_minor: 0,
      grace_days: 3,
      context_type: "termination",
      allocations: 0,
      drafted_events: 1,
      finalized_events: 0,
    });
    expect(draft?.credits_minor).toBeGreaterThan(0);
    expect(draft?.period_end).toBe(original?.current_period_end);
    expect(draft?.terminated_period_end).toBe(draft?.terminated_at);

    const refreshed = await api(`/api/v1/invoices/${draft?.id}/refresh`, "PUT");
    expect(refreshed.status).toBe(200);
    await expect(refreshed.json()).resolves.toMatchObject({
      invoice: { status: "draft", version_number: 2, total_amount_cents: 0 },
    });
    await expect(
      env.BILLING_DB.prepare(
        `SELECT COUNT(*) AS total FROM wallet_transactions
         WHERE invoice_id = ? AND transaction_type = 'outbound'`,
      )
        .bind(draft?.id)
        .first(),
    ).resolves.toEqual({ total: 0 });

    const finalized = await api(`/api/v1/invoices/${draft?.id}/finalize`, "PUT");
    expect(finalized.status).toBe(200);
    await expect(finalized.json()).resolves.toMatchObject({
      invoice: { status: "finalized", version_number: 3, total_amount_cents: 0 },
    });
    const replay = await api(`/api/v1/invoices/${draft?.id}/finalize`, "PUT");
    expect(replay.status).toBe(200);
    await expect(
      env.BILLING_DB.prepare(
        `SELECT i.status, i.version,
                (SELECT COUNT(*) FROM wallet_transactions wt
                 WHERE wt.invoice_id = i.id AND wt.transaction_type = 'outbound') AS allocations,
                (SELECT COUNT(*) FROM outbox_events o WHERE o.aggregate_id = i.id
                 AND o.event_type = 'invoice.finalized') AS finalized_events
         FROM invoices i WHERE i.id = ?`,
      )
        .bind(draft?.id)
        .first(),
    ).resolves.toEqual({ status: "finalized", version: 3, allocations: 1, finalized_events: 1 });
  });

  it("accepts ending_at with grace and creates one scheduled termination draft", async () => {
    const endingAt = new Date(Date.now() + 2 * 86_400_000).toISOString();
    const customer = await api("/api/v1/customers", "POST", {
      customer: {
        external_id: "customer-scheduled-grace",
        currency: "USD",
        billing_configuration: { invoice_grace_period: 2 },
      },
    });
    expect(customer.status).toBe(200);
    const created = await api("/api/v1/subscriptions", "POST", {
      subscription: {
        external_customer_id: "customer-scheduled-grace",
        external_id: "subscription-scheduled-grace",
        plan_code: "monthly",
        ending_at: endingAt,
      },
    });
    expect(created.status).toBe(200);
    const createdBody = await created.json<{ subscription: { lago_id: string } }>();

    await expect(terminateEndedSubscriptions(env, endingAt, "scheduled-grace-due")).resolves.toBe(
      1,
    );
    await expect(
      terminateEndedSubscriptions(env, endingAt, "scheduled-grace-replay"),
    ).resolves.toBe(0);
    await expect(
      env.BILLING_DB.prepare(
        `SELECT s.status,
                (SELECT COUNT(*) FROM invoices i WHERE i.subscription_id = s.id
                 AND i.status = 'draft' AND i.applied_grace_period = 2) AS drafts,
                (SELECT COUNT(*) FROM subscription_invoice_contexts sic
                 WHERE sic.subscription_id = s.id AND sic.context_type = 'termination') AS contexts,
                (SELECT COUNT(*) FROM outbox_events o JOIN invoices i ON i.id = o.aggregate_id
                 WHERE i.subscription_id = s.id AND o.event_type = 'invoice.drafted') AS events
         FROM subscriptions s WHERE s.id = ?`,
      )
        .bind(createdBody.subscription.lago_id)
        .first(),
    ).resolves.toEqual({ status: "terminated", drafts: 1, contexts: 1, events: 1 });
  });

  it("rolls back the entire grace-period termination batch on a late transition failure", async () => {
    const customer = await api("/api/v1/customers", "POST", {
      customer: {
        external_id: "customer-termination-grace-rollback",
        currency: "USD",
        billing_configuration: { invoice_grace_period: 1 },
      },
    });
    expect(customer.status).toBe(200);
    const created = await api("/api/v1/subscriptions", "POST", {
      subscription: {
        external_customer_id: "customer-termination-grace-rollback",
        external_id: "subscription-termination-grace-rollback",
        plan_code: "monthly",
      },
    });
    expect(created.status).toBe(200);
    const createdBody = await created.json<{ subscription: { lago_id: string } }>();
    await env.BILLING_DB.prepare(
      `CREATE TRIGGER test_abort_grace_termination
       BEFORE UPDATE OF status ON subscriptions
       WHEN NEW.id = '${createdBody.subscription.lago_id}' AND NEW.status = 'terminated'
       BEGIN SELECT RAISE(ABORT, 'test_grace_termination_abort'); END`,
    ).run();
    const failed = await api(
      "/api/v1/subscriptions/subscription-termination-grace-rollback",
      "DELETE",
    );
    expect(failed.status).toBe(500);
    await env.BILLING_DB.prepare("DROP TRIGGER test_abort_grace_termination").run();
    await expect(
      env.BILLING_DB.prepare(
        `SELECT s.status, s.version,
                (SELECT COUNT(*) FROM invoices i WHERE i.subscription_id = s.id) AS invoices,
                (SELECT COUNT(*) FROM subscription_invoice_contexts sic
                 WHERE sic.subscription_id = s.id) AS contexts,
                (SELECT COUNT(*) FROM outbox_events o WHERE o.aggregate_id = s.id
                 AND o.event_type = 'subscription.terminated') AS events
         FROM subscriptions s WHERE s.id = ?`,
      )
        .bind(createdBody.subscription.lago_id)
        .first(),
    ).resolves.toEqual({ status: "active", version: 1, invoices: 0, contexts: 0, events: 0 });
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

  it("separates pay-in-advance final usage from unused-period credits", async () => {
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
        `INSERT INTO billable_metrics
         (id, organization_id, code, name, aggregation_type, field_name, recurring,
          properties_json, version, active, created_at, updated_at)
         VALUES ('metric-lifecycle-advance', 'org-lifecycle', 'advance-units', 'Advance units',
                 'sum_agg', 'quantity', 0, '{}', 1, 1, ?, ?)`,
      ).bind(now, now),
      env.BILLING_DB.prepare(
        `INSERT INTO charges
         (id, organization_id, plan_id, billable_metric_id, code, charge_model,
          properties_json, invoiceable, pay_in_advance, prorated, min_amount_minor,
          version, active, created_at, updated_at)
         VALUES ('charge-lifecycle-advance', 'org-lifecycle', 'plan-lifecycle-advance',
                 'metric-lifecycle-advance', 'advance-unit-charge', 'standard',
                 '{"amount":"2.5"}', 1, 0, 0, 0, 1, 1, ?, ?)`,
      ).bind(now, now),
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

    const creditSource = await api("/api/v1/subscriptions", "POST", {
      subscription: {
        external_customer_id: "customer-external",
        external_id: "subscription-external-advance-credit",
        plan_code: "monthly-advance",
      },
    });
    expect(creditSource.status).toBe(200);
    const creditSourceBody = await creditSource.json<{ subscription: { lago_id: string } }>();
    const credited = await api(
      "/api/v1/subscriptions/subscription-external-advance-credit?on_termination_invoice=skip",
      "DELETE",
    );
    expect(credited.status).toBe(200);
    await expect(credited.json()).resolves.toMatchObject({
      subscription: { status: "terminated" },
    });
    const creditState = await env.BILLING_DB.prepare(
      `SELECT cn.id, cn.total_amount_minor, cn.balance_amount_minor, cn.reason,
              cni.precise_amount_minor,
              (SELECT payload_json FROM outbox_events o WHERE o.aggregate_id = cn.id
                AND o.event_type = 'credit_note.created') AS event_payload_json,
              (SELECT COUNT(*) FROM outbox_events o WHERE o.aggregate_id = cn.id
                AND o.event_type = 'credit_note.created') AS credit_events
       FROM credit_notes cn JOIN credit_note_items cni ON cni.credit_note_id = cn.id
       WHERE cn.customer_id = 'customer-lifecycle' AND cn.reason = 'order_cancellation'
         AND cn.invoice_id IN (
           SELECT id FROM invoices WHERE subscription_id = ?
         )`,
    )
      .bind(creditSourceBody.subscription.lago_id)
      .first<{
        id: string;
        total_amount_minor: number;
        balance_amount_minor: number;
        reason: string;
        precise_amount_minor: string;
        event_payload_json: string;
        credit_events: number;
      }>();
    expect(creditState).toBeTruthy();
    expect(creditState).toMatchObject({
      balance_amount_minor: creditState?.total_amount_minor,
      reason: "order_cancellation",
      credit_events: 1,
    });
    expect(creditState?.total_amount_minor).toBeGreaterThan(0);
    const creditEventPayload = JSON.parse(creditState?.event_payload_json ?? "{}") as {
      unusedDays: number;
      fullPeriodDays: number;
    };
    const expectedCredit =
      (1000 * creditEventPayload.unusedDays) / creditEventPayload.fullPeriodDays;
    expect(Math.round(Number(creditState?.precise_amount_minor))).toBe(
      creditState?.total_amount_minor,
    );
    expect(Number(creditState?.precise_amount_minor)).toBeCloseTo(expectedCredit, 10);
    const creditReplay = await api(
      "/api/v1/subscriptions/subscription-external-advance-credit?on_termination_invoice=skip",
      "DELETE",
    );
    expect(creditReplay.status).toBe(200);
    await expect(
      env.BILLING_DB.prepare(
        `SELECT COUNT(*) AS total FROM credit_notes WHERE invoice_id IN
         (SELECT id FROM invoices WHERE subscription_id = ?)`,
      )
        .bind(creditSourceBody.subscription.lago_id)
        .first(),
    ).resolves.toEqual({ total: 1 });

    await env.BILLING_DB.prepare(
      `INSERT INTO customers
       (id, organization_id, external_id, currency, metadata_json, created_at, updated_at)
       VALUES ('customer-lifecycle-combined', 'org-lifecycle', 'customer-combined-external',
               'USD', '{}', ?, ?)`,
    )
      .bind(now, now)
      .run();
    const usageSource = await api("/api/v1/subscriptions", "POST", {
      subscription: {
        external_customer_id: "customer-combined-external",
        external_id: "subscription-external-advance-usage",
        plan_code: "monthly-advance",
      },
    });
    expect(usageSource.status).toBe(200);
    const usageSourceBody = await usageSource.json<{ subscription: { lago_id: string } }>();
    const usageAt = new Date().toISOString();
    await env.BILLING_DB.prepare(
      `INSERT INTO usage_events
       (id, organization_id, subscription_id, customer_id, billable_metric_id,
        transaction_id, code, timestamp, timestamp_ms, properties_json, request_sha256,
        archive_key, created_at)
       VALUES ('event-lifecycle-advance', 'org-lifecycle', ?, 'customer-lifecycle-combined',
               'metric-lifecycle-advance', 'advance-usage', 'advance-units', ?, ?,
               '{"quantity":"10"}', 'advance-usage-hash', 'advance-usage-archive', ?)`,
    )
      .bind(usageSourceBody.subscription.lago_id, usageAt, Date.parse(usageAt), usageAt)
      .run();
    const combinedWallet = await api("/api/v1/wallets", "POST", {
      wallet: {
        external_customer_id: "customer-combined-external",
        name: "Combined termination fallback",
        code: "combined-termination-fallback",
        currency: "USD",
        rate_amount: "1",
        granted_credits: "1",
      },
    });
    expect(combinedWallet.status).toBe(200);

    const combinedTerminated = await api(
      "/api/v1/subscriptions/subscription-external-advance-usage",
      "DELETE",
    );
    const combinedTerminatedBody = await combinedTerminated.json();
    expect({ status: combinedTerminated.status, body: combinedTerminatedBody }).toMatchObject({
      status: 200,
      body: { subscription: { status: "terminated" } },
    });
    const combinedState = await env.BILLING_DB.prepare(
      `SELECT i.subtotal_minor, i.credit_notes_minor, i.total_due_minor,
              il.quantity_decimal, il.precise_amount_minor,
              cn.total_amount_minor AS credit_total_minor,
              cn.balance_amount_minor AS credit_balance_minor, cn.credit_status,
              cna.amount_minor AS applied_minor,
              (SELECT COUNT(*) FROM invoice_lines all_lines
               WHERE all_lines.invoice_id = i.id AND all_lines.line_type = 'subscription')
                AS subscription_lines,
              (SELECT COUNT(*) FROM outbox_events o WHERE o.aggregate_id = cn.id
               AND o.event_type = 'credit_note.created') AS credit_events,
              (SELECT COUNT(*) FROM outbox_events o WHERE o.aggregate_id = cn.id
               AND o.event_type = 'credit_note.applied') AS applied_events,
              (SELECT rowid FROM outbox_events o WHERE o.aggregate_id = cn.id
               AND o.event_type = 'credit_note.created') AS created_event_rowid,
              (SELECT rowid FROM outbox_events o WHERE o.aggregate_id = cn.id
               AND o.event_type = 'credit_note.applied') AS applied_event_rowid
       FROM invoices i JOIN invoice_lines il ON il.invoice_id = i.id AND il.line_type = 'usage'
       JOIN credit_note_applications cna ON cna.invoice_id = i.id
       JOIN credit_notes cn ON cn.id = cna.credit_note_id
       WHERE i.subscription_id = ?`,
    )
      .bind(usageSourceBody.subscription.lago_id)
      .first<{
        subtotal_minor: number;
        credit_notes_minor: number;
        total_due_minor: number;
        quantity_decimal: string;
        precise_amount_minor: string;
        credit_total_minor: number;
        credit_balance_minor: number;
        credit_status: string;
        applied_minor: number;
        subscription_lines: number;
        credit_events: number;
        applied_events: number;
        created_event_rowid: number;
        applied_event_rowid: number;
      }>();
    expect(combinedState).toMatchObject({
      subtotal_minor: 25,
      credit_notes_minor: 25,
      total_due_minor: 0,
      quantity_decimal: "10",
      precise_amount_minor: "25",
      credit_status: "available",
      applied_minor: 25,
      subscription_lines: 0,
      credit_events: 1,
      applied_events: 1,
    });
    expect(combinedState?.credit_total_minor).toBeGreaterThan(25);
    expect(combinedState?.credit_balance_minor).toBe((combinedState?.credit_total_minor ?? 0) - 25);
    expect(combinedState?.created_event_rowid).toBeLessThan(
      combinedState?.applied_event_rowid ?? 0,
    );
    await expect(
      env.BILLING_DB.prepare(
        `SELECT w.balance_minor, w.consumed_minor,
                (SELECT COUNT(*) FROM wallet_transactions wt
                 WHERE wt.wallet_id = w.id AND wt.transaction_type = 'outbound') AS outbound
         FROM wallets w WHERE w.customer_id = 'customer-lifecycle-combined'`,
      ).first(),
    ).resolves.toEqual({ balance_minor: 100, consumed_minor: 0, outbound: 0 });
    expect(
      (await api("/api/v1/subscriptions/subscription-external-advance-usage", "DELETE")).status,
    ).toBe(200);
    await expect(
      env.BILLING_DB.prepare(
        `SELECT (SELECT COUNT(*) FROM invoices WHERE subscription_id = ?) AS invoices,
                (SELECT COUNT(*) FROM credit_notes WHERE invoice_id IN
                  (SELECT id FROM invoices WHERE subscription_id = ?)) AS credit_notes,
                (SELECT COUNT(*) FROM credit_note_applications WHERE invoice_id IN
                  (SELECT id FROM invoices WHERE subscription_id = ?)) AS applications`,
      )
        .bind(
          usageSourceBody.subscription.lago_id,
          usageSourceBody.subscription.lago_id,
          usageSourceBody.subscription.lago_id,
        )
        .first(),
    ).resolves.toEqual({ invoices: 2, credit_notes: 1, applications: 1 });

    const skipSource = await api("/api/v1/subscriptions", "POST", {
      subscription: {
        external_customer_id: "customer-external",
        external_id: "subscription-external-advance-usage-skip",
        plan_code: "monthly-advance",
      },
    });
    expect(skipSource.status).toBe(200);
    const skipSourceBody = await skipSource.json<{ subscription: { lago_id: string } }>();
    const skipUsageAt = new Date().toISOString();
    await env.BILLING_DB.prepare(
      `INSERT INTO usage_events
       (id, organization_id, subscription_id, customer_id, billable_metric_id,
        transaction_id, code, timestamp, timestamp_ms, properties_json, request_sha256,
        archive_key, created_at)
       VALUES ('event-lifecycle-advance-skip', 'org-lifecycle', ?, 'customer-lifecycle',
               'metric-lifecycle-advance', 'advance-usage-skip', 'advance-units', ?, ?,
               '{"quantity":"10"}', 'advance-usage-skip-hash', 'advance-usage-skip-archive', ?)`,
    )
      .bind(skipSourceBody.subscription.lago_id, skipUsageAt, Date.parse(skipUsageAt), skipUsageAt)
      .run();
    const usageTerminated = await api(
      "/api/v1/subscriptions/subscription-external-advance-usage-skip?on_termination_credit_note=skip",
      "DELETE",
    );
    expect(usageTerminated.status).toBe(200);
    await expect(usageTerminated.json()).resolves.toMatchObject({
      subscription: { status: "terminated" },
    });
    await expect(
      env.BILLING_DB.prepare(
        `SELECT i.subtotal_minor, i.total_due_minor, il.line_type, il.quantity_decimal,
                il.precise_amount_minor, il.amount_minor,
                (SELECT COUNT(*) FROM invoice_lines all_lines
                 WHERE all_lines.invoice_id = i.id AND all_lines.line_type = 'subscription')
                  AS subscription_lines
         FROM invoices i JOIN invoice_lines il ON il.invoice_id = i.id
         WHERE i.subscription_id = ? AND il.line_type = 'usage'`,
      )
        .bind(skipSourceBody.subscription.lago_id)
        .first(),
    ).resolves.toEqual({
      subtotal_minor: 25,
      total_due_minor: 25,
      line_type: "usage",
      quantity_decimal: "10",
      precise_amount_minor: "25",
      amount_minor: 25,
      subscription_lines: 0,
    });
    await expect(
      env.BILLING_DB.prepare("SELECT COUNT(*) AS total FROM invoices WHERE subscription_id = ?")
        .bind(skipSourceBody.subscription.lago_id)
        .first(),
    ).resolves.toEqual({ total: 2 });

    await env.BILLING_DB.prepare(
      `INSERT INTO customers
       (id, organization_id, external_id, currency, metadata_json, created_at, updated_at)
       VALUES ('customer-lifecycle-rollback', 'org-lifecycle', 'customer-rollback-external',
               'USD', '{}', ?, ?)`,
    )
      .bind(now, now)
      .run();
    const rollbackSource = await api("/api/v1/subscriptions", "POST", {
      subscription: {
        external_customer_id: "customer-rollback-external",
        external_id: "subscription-external-advance-rollback",
        plan_code: "monthly-advance",
      },
    });
    expect(rollbackSource.status).toBe(200);
    const rollbackSourceBody = await rollbackSource.json<{ subscription: { lago_id: string } }>();
    expect(rollbackSourceBody.subscription.lago_id).toMatch(/^[0-9a-f-]{36}$/);
    await env.BILLING_DB.prepare(
      `CREATE TRIGGER abort_combined_termination_invoice
       BEFORE INSERT ON invoices
       WHEN NEW.subscription_id = '${rollbackSourceBody.subscription.lago_id}'
         AND NEW.status = 'finalized'
       BEGIN
         SELECT RAISE(ABORT, 'synthetic_combined_termination_failure');
       END`,
    ).run();
    const rolledBack = await api(
      "/api/v1/subscriptions/subscription-external-advance-rollback",
      "DELETE",
    );
    expect(rolledBack.status).toBe(500);
    await expect(
      env.BILLING_DB.prepare(
        `SELECT s.status, s.version,
                (SELECT COUNT(*) FROM invoices i WHERE i.subscription_id = s.id) AS invoices,
                (SELECT COUNT(*) FROM credit_notes cn JOIN invoices i ON i.id = cn.invoice_id
                  WHERE i.subscription_id = s.id) AS credit_notes,
                (SELECT COUNT(*) FROM credit_note_applications cna JOIN invoices i ON i.id = cna.invoice_id
                  WHERE i.subscription_id = s.id) AS applications,
                (SELECT COUNT(*) FROM outbox_events o WHERE o.aggregate_id = s.id
                  AND o.event_type = 'subscription.terminated') AS termination_events
         FROM subscriptions s WHERE s.id = ?`,
      )
        .bind(rollbackSourceBody.subscription.lago_id)
        .first(),
    ).resolves.toEqual({
      status: "active",
      version: 1,
      invoices: 1,
      credit_notes: 0,
      applications: 0,
      termination_events: 0,
    });

    await env.BILLING_DB.prepare(
      `INSERT INTO minimum_commitments
       (id, organization_id, plan_id, amount_minor, invoice_display_name, created_at, updated_at)
       VALUES ('commitment-lifecycle-advance', 'org-lifecycle', 'plan-lifecycle-advance', 2000,
               'Advance minimum', ?, ?)`,
    )
      .bind(now, now)
      .run();
    const guardedSource = await api("/api/v1/subscriptions", "POST", {
      subscription: {
        external_customer_id: "customer-external",
        external_id: "subscription-external-advance-commitment",
        plan_code: "monthly-advance",
      },
    });
    expect(guardedSource.status).toBe(200);
    const commitmentGuard = await api(
      "/api/v1/subscriptions/subscription-external-advance-commitment?on_termination_invoice=skip",
      "DELETE",
    );
    expect(commitmentGuard.status).toBe(422);
    await expect(commitmentGuard.json()).resolves.toMatchObject({
      code: "unsupported_termination_minimum_commitment",
    });
  });

  it("terminates a due UTC ending_at exactly once with a final in-arrears invoice", async () => {
    const endingAt = new Date(Date.now() + 2 * 86_400_000).toISOString();
    const now = new Date().toISOString();
    await env.BILLING_DB.batch([
      env.BILLING_DB.prepare(
        `INSERT INTO add_ons
         (id, organization_id, code, name, amount_minor, currency, status, version,
          request_sha256, created_at, updated_at)
         VALUES ('add-on-scheduled-end', 'org-lifecycle', 'scheduled-seat', 'Scheduled seat',
                 100, 'USD', 'active', 1, 'scheduled-seat-hash', ?, ?)`,
      ).bind(now, now),
      env.BILLING_DB.prepare(
        `INSERT INTO fixed_charges
         (id, organization_id, plan_id, add_on_id, code, charge_model, properties_json,
          units, pay_in_advance, prorated, created_at, updated_at)
         VALUES ('fixed-scheduled-end', 'org-lifecycle', 'plan-lifecycle',
                 'add-on-scheduled-end', 'scheduled-seat-fixed', 'standard',
                 '{"amount":"100"}', '2.5', 0, 0, ?, ?)`,
      ).bind(now, now),
      env.BILLING_DB.prepare(
        `INSERT INTO minimum_commitments
         (id, organization_id, plan_id, amount_minor, invoice_display_name, created_at, updated_at)
         VALUES ('commitment-scheduled-end', 'org-lifecycle', 'plan-lifecycle', 10000,
                 'Scheduled minimum', ?, ?)`,
      ).bind(now, now),
    ]);
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
                (SELECT COUNT(*) FROM invoice_lines il JOIN invoices i ON i.id = il.invoice_id
                  WHERE i.subscription_id = s.id AND il.line_type = 'fixed_charge') AS fixed_lines,
                (SELECT COUNT(*) FROM invoice_lines il JOIN invoices i ON i.id = il.invoice_id
                  WHERE i.subscription_id = s.id AND il.line_type = 'commitment') AS commitment_lines,
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
      fixed_lines: 1,
      commitment_lines: 1,
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
        `INSERT INTO add_ons
         (id, organization_id, code, name, amount_minor, currency, status, version,
          request_sha256, created_at, updated_at)
         VALUES ('add-on-termination', 'org-termination', 'termination-seat',
                 'Termination seat', 100, 'USD', 'active', 1,
                 'termination-seat-hash', ?, ?)`,
      ).bind(periodStart, periodStart),
      env.BILLING_DB.prepare(
        `INSERT INTO fixed_charges
         (id, organization_id, plan_id, add_on_id, code, charge_model, properties_json,
          units, pay_in_advance, prorated, created_at, updated_at)
         VALUES ('fixed-termination', 'org-termination', 'plan-termination',
                 'add-on-termination', 'termination-seat-fixed', 'standard',
                 '{"amount":"100"}', '2.5', 0, 0, ?, ?)`,
      ).bind(periodStart, periodStart),
      env.BILLING_DB.prepare(
        `INSERT INTO minimum_commitments
         (id, organization_id, plan_id, amount_minor, invoice_display_name, created_at, updated_at)
         VALUES ('commitment-termination', 'org-termination', 'plan-termination', 6000,
                 'Termination minimum', ?, ?)`,
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
    expect(result).toMatchObject({ totalDueMinor: 400, lineCount: 4, terminatedAt });
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
      subtotal_minor: 400,
      total_due_minor: 400,
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
        line_type: "commitment",
        quantity_decimal: "1",
        precise_amount_minor: "53.333333333333333333",
        amount_minor: 53,
      },
      {
        line_type: "fixed_charge",
        quantity_decimal: "2.5",
        precise_amount_minor: "250",
        amount_minor: 250,
      },
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
        targetAmountMinor: 400,
        billableDays: 2,
        fullPeriodDays: 30,
        periodStart,
        periodEnd: "2023-09-07T00:00:00.000Z",
      },
      {
        contextType: "termination",
        fixedChargeCode: "termination-seat-fixed",
        periodStart,
        periodEnd: "2023-09-07T00:00:00.000Z",
      },
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
