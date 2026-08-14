import { env, SELF } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { sha256Hex } from "../src/auth/api-key";
import { closeBillingPeriod } from "../src/billing/close-period";
import { finalizeDueInvoices } from "../src/schedules/maintenance";

const apiKey = "subscription-plan-change-key";
const headers = { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" };

beforeEach(async () => {
  const now = new Date().toISOString();
  await env.BILLING_DB.batch([
    env.BILLING_DB.prepare(
      `INSERT OR IGNORE INTO organizations (id, external_id, name, created_at, updated_at)
       VALUES ('org-plan-change', 'org-plan-change', 'Plan Change', ?, ?)`,
    ).bind(now, now),
    env.BILLING_DB.prepare(
      `INSERT OR IGNORE INTO api_keys
       (id, organization_id, key_prefix, key_hash, created_at, revoked_at)
       VALUES ('key-plan-change', 'org-plan-change', 'plan-change', ?, ?, NULL)`,
    ).bind(await sha256Hex(apiKey), now),
    env.BILLING_DB.prepare(
      `INSERT OR IGNORE INTO customers
       (id, organization_id, external_id, currency, metadata_json, created_at, updated_at)
       VALUES ('customer-plan-change', 'org-plan-change', 'customer-plan-change', 'USD', '{}', ?, ?)`,
    ).bind(now, now),
    env.BILLING_DB.prepare(
      `UPDATE customers SET invoice_grace_period = 0 WHERE id = 'customer-plan-change'`,
    ),
    ...[
      ["plan-change-base", "plan-change-base", 1200],
      ["plan-change-upgrade", "plan-change-upgrade", 2400],
      ["plan-change-upgrade-two", "plan-change-upgrade-two", 3600],
      ["plan-change-downgrade", "plan-change-downgrade", 600],
    ].map(([id, code, amount]) =>
      env.BILLING_DB.prepare(
        `INSERT OR IGNORE INTO plans
         (id, organization_id, code, name, interval, amount_minor, currency, version,
          active, created_at, updated_at)
         VALUES (?, 'org-plan-change', ?, ?, 'monthly', ?, 'USD', 1, 1, ?, ?)`,
      ).bind(id, code, code, amount, now, now),
    ),
    env.BILLING_DB.prepare(
      `UPDATE plans SET pay_in_advance = 0, trial_period = NULL
       WHERE organization_id = 'org-plan-change'`,
    ),
  ]);
});

describe("subscription plan generations", () => {
  it("changes an initial future subscription in place without creating a generation", async () => {
    const futureStart = new Date(Date.now() + 3_600_000).toISOString();
    const created = await SELF.fetch("https://lago.test/api/v1/subscriptions", {
      method: "POST",
      headers,
      body: JSON.stringify({
        subscription: {
          external_customer_id: "customer-plan-change",
          external_id: "subscription-pending-plan-change",
          plan_code: "plan-change-base",
          subscription_at: futureStart,
        },
      }),
    });
    const createdBody = await created.json<{ subscription: { lago_id: string } }>();
    const changed = await createSubscription(
      "subscription-pending-plan-change",
      "plan-change-upgrade",
    );
    expect(changed.status).toBe(200);
    await expect(changed.json()).resolves.toMatchObject({
      subscription: {
        lago_id: createdBody.subscription.lago_id,
        plan_code: "plan-change-upgrade",
        status: "pending",
        subscription_at: futureStart,
      },
    });
    await expect(generationState("subscription-pending-plan-change")).resolves.toHaveLength(1);
  });

  it("atomically upgrades to a new active generation and replays by external id", async () => {
    const created = await createSubscription("subscription-upgrade", "plan-change-base");
    expect(created.status).toBe(200);
    const createdBody = await created.json<{ subscription: { lago_id: string } }>();
    const tenDaysAgo = new Date(Date.now() - 10 * 86_400_000).toISOString();
    await env.BILLING_DB.prepare(
      `UPDATE subscriptions SET started_at = ?, subscription_at = ?, current_period_start = ?
       WHERE id = ?`,
    )
      .bind(tenDaysAgo, tenDaysAgo, tenDaysAgo, createdBody.subscription.lago_id)
      .run();

    const upgraded = await createSubscription("subscription-upgrade", "plan-change-upgrade");
    expect(upgraded.status).toBe(200);
    const upgradedBody = await upgraded.json<{
      subscription: { lago_id: string; plan_code: string; status: string };
    }>();
    expect(upgradedBody.subscription).toMatchObject({
      plan_code: "plan-change-upgrade",
      status: "active",
    });
    expect(upgradedBody.subscription.lago_id).not.toBe(createdBody.subscription.lago_id);

    await expect(generationState("subscription-upgrade")).resolves.toEqual([
      {
        id: createdBody.subscription.lago_id,
        plan_code: "plan-change-base",
        status: "terminated",
        generation: 1,
        previous_subscription_id: null,
      },
      {
        id: upgradedBody.subscription.lago_id,
        plan_code: "plan-change-upgrade",
        status: "active",
        generation: 2,
        previous_subscription_id: createdBody.subscription.lago_id,
      },
    ]);
    const invoice = await env.BILLING_DB.prepare(
      `SELECT i.status, i.total_due_minor,
              (SELECT COUNT(*) FROM invoice_subscriptions ins WHERE ins.invoice_id = i.id) AS owners,
              (SELECT COUNT(*) FROM plan_change_invoice_contexts pc WHERE pc.invoice_id = i.id
                AND pc.transition_kind = 'upgrade') AS contexts,
              (SELECT COUNT(*) FROM outbox_events o WHERE o.aggregate_id = i.id
                AND o.event_type = 'invoice.finalized') AS invoice_events
       FROM invoices i JOIN invoice_subscriptions ins ON ins.invoice_id = i.id
       WHERE ins.subscription_id = ? AND ins.invoicing_reason = 'upgrading'
       ORDER BY i.created_at DESC LIMIT 1`,
    )
      .bind(upgradedBody.subscription.lago_id)
      .first();
    expect(invoice).toMatchObject({
      status: "finalized",
      owners: 2,
      contexts: 1,
      invoice_events: 1,
    });
    expect(Number((invoice as { total_due_minor: number }).total_due_minor)).toBeGreaterThan(0);

    const replay = await createSubscription("subscription-upgrade", "plan-change-upgrade");
    expect(replay.status).toBe(200);
    await expect(replay.json()).resolves.toMatchObject({
      subscription: { lago_id: upgradedBody.subscription.lago_id },
    });
    await expect(generationState("subscription-upgrade")).resolves.toHaveLength(2);
  });

  it("queues a downgrade without mutating the active generation", async () => {
    const created = await createSubscription("subscription-downgrade", "plan-change-base");
    const createdBody = await created.json<{ subscription: { lago_id: string } }>();
    const downgraded = await createSubscription("subscription-downgrade", "plan-change-downgrade");
    expect(downgraded.status).toBe(200);
    await expect(downgraded.json()).resolves.toMatchObject({
      subscription: {
        lago_id: createdBody.subscription.lago_id,
        plan_code: "plan-change-base",
        next_plan_code: "plan-change-downgrade",
      },
    });
    const generations = await generationState("subscription-downgrade");
    expect(generations).toMatchObject([
      { status: "active", generation: 1, previous_subscription_id: null },
      {
        status: "pending",
        generation: 2,
        previous_subscription_id: createdBody.subscription.lago_id,
      },
    ]);

    const replay = await createSubscription("subscription-downgrade", "plan-change-downgrade");
    expect(replay.status).toBe(200);
    await expect(generationState("subscription-downgrade")).resolves.toHaveLength(2);

    const boundary = await env.BILLING_DB.prepare(
      "SELECT current_period_end FROM subscriptions WHERE id = ?",
    )
      .bind(createdBody.subscription.lago_id)
      .first<{ current_period_end: string }>();
    expect(boundary?.current_period_end).toBeTruthy();
    const closed = await closeBillingPeriod(
      env,
      createdBody.subscription.lago_id,
      boundary!.current_period_end,
      "downgrade-boundary",
    );
    expect(closed.totalDueMinor).toBe(1200);
    await expect(generationState("subscription-downgrade")).resolves.toMatchObject([
      { status: "terminated", generation: 1 },
      { status: "active", generation: 2 },
    ]);
    await expect(
      env.BILLING_DB.prepare(
        `SELECT pc.transition_kind,
                (SELECT COUNT(*) FROM invoice_subscriptions ins
                 WHERE ins.invoice_id = pc.invoice_id) AS owners
         FROM plan_change_invoice_contexts pc WHERE pc.invoice_id = ?`,
      )
        .bind(closed.invoiceId)
        .first(),
    ).resolves.toEqual({ transition_kind: "downgrade", owners: 2 });
    await expect(
      closeBillingPeriod(
        env,
        createdBody.subscription.lago_id,
        boundary!.current_period_end,
        "downgrade-boundary-replay",
      ),
    ).resolves.toMatchObject({ invoiceId: closed.invoiceId, replayed: true });
  });

  it("rolls back every generation, invoice, and event when the late insert fails", async () => {
    const created = await createSubscription("subscription-upgrade-rollback", "plan-change-base");
    const createdBody = await created.json<{ subscription: { lago_id: string } }>();
    await env.BILLING_DB.prepare(
      `CREATE TRIGGER test_abort_plan_change_generation
       BEFORE INSERT ON subscriptions
       WHEN NEW.previous_subscription_id = '${createdBody.subscription.lago_id}'
       BEGIN SELECT RAISE(ABORT, 'test_plan_change_abort'); END`,
    ).run();
    const failed = await createSubscription("subscription-upgrade-rollback", "plan-change-upgrade");
    expect(failed.status).toBe(409);
    await env.BILLING_DB.prepare("DROP TRIGGER test_abort_plan_change_generation").run();

    await expect(generationState("subscription-upgrade-rollback")).resolves.toEqual([
      {
        id: createdBody.subscription.lago_id,
        plan_code: "plan-change-base",
        status: "active",
        generation: 1,
        previous_subscription_id: null,
      },
    ]);
    await expect(
      env.BILLING_DB.prepare(
        `SELECT
           (SELECT COUNT(*) FROM invoice_subscriptions ins
            WHERE ins.subscription_id = ?) AS invoices,
           (SELECT COUNT(*) FROM outbox_events o
            WHERE o.aggregate_id = ? AND o.event_type = 'subscription.terminated') AS events`,
      )
        .bind(createdBody.subscription.lago_id, createdBody.subscription.lago_id)
        .first(),
    ).resolves.toEqual({ invoices: 0, events: 0 });
  });

  it("credits the unused prepaid generation into the single upgrade invoice", async () => {
    await env.BILLING_DB.prepare(
      `UPDATE plans SET pay_in_advance = 1
       WHERE id IN ('plan-change-base', 'plan-change-upgrade')`,
    ).run();
    const created = await createSubscription("subscription-upgrade-prepaid", "plan-change-base");
    expect(created.status).toBe(200);
    const createdBody = await created.json<{ subscription: { lago_id: string } }>();
    const upgraded = await createSubscription(
      "subscription-upgrade-prepaid",
      "plan-change-upgrade",
    );
    expect(upgraded.status).toBe(200);

    const state = await env.BILLING_DB.prepare(
      `SELECT i.subtotal_minor, i.credit_notes_minor, i.total_due_minor,
              (SELECT COUNT(*) FROM credit_notes cn
               WHERE cn.invoice_id = source.id AND cn.reason = 'order_cancellation') AS notes,
              (SELECT COUNT(*) FROM invoice_subscriptions ins
               WHERE ins.invoice_id = i.id) AS owners
       FROM plan_change_invoice_contexts pc
       JOIN invoices i ON i.id = pc.invoice_id
       JOIN invoices source ON source.subscription_id = pc.previous_subscription_id
         AND source.id != i.id
       WHERE pc.previous_subscription_id = ?
       ORDER BY source.created_at LIMIT 1`,
    )
      .bind(createdBody.subscription.lago_id)
      .first<{
        subtotal_minor: number;
        credit_notes_minor: number;
        total_due_minor: number;
        notes: number;
        owners: number;
      }>();
    expect(state?.notes).toBe(1);
    expect(state?.owners).toBe(2);
    expect(state?.credit_notes_minor).toBeGreaterThan(0);
    expect(state?.total_due_minor).toBe(state!.subtotal_minor - state!.credit_notes_minor);
  });

  it("finalizes a draft prepaid source before applying its upgrade credit", async () => {
    await env.BILLING_DB.batch([
      env.BILLING_DB.prepare(
        `UPDATE plans SET pay_in_advance = 1
         WHERE id IN ('plan-change-base', 'plan-change-upgrade')`,
      ),
      env.BILLING_DB.prepare(
        "UPDATE customers SET invoice_grace_period = 2 WHERE id = 'customer-plan-change'",
      ),
    ]);
    const created = await createSubscription(
      "subscription-upgrade-prepaid-draft",
      "plan-change-base",
    );
    const createdBody = await created.json<{ subscription: { lago_id: string } }>();
    const upgraded = await createSubscription(
      "subscription-upgrade-prepaid-draft",
      "plan-change-upgrade",
    );
    expect(upgraded.status).toBe(200);

    const invoices = await env.BILLING_DB.prepare(
      `SELECT
         (SELECT sic.invoice_id FROM subscription_invoice_contexts sic
          WHERE sic.subscription_id = ? AND sic.context_type = 'initial') AS source_id,
         (SELECT pc.invoice_id FROM plan_change_invoice_contexts pc
          WHERE pc.previous_subscription_id = ?) AS upgrade_id`,
    )
      .bind(createdBody.subscription.lago_id, createdBody.subscription.lago_id)
      .first<{ source_id: string; upgrade_id: string }>();
    expect(invoices?.source_id).toBeTruthy();
    expect(invoices?.upgrade_id).toBeTruthy();
    await expect(
      env.BILLING_DB.prepare(
        `SELECT cn.allocation_state,
                (SELECT COUNT(*) FROM invoice_subscriptions ins
                 WHERE ins.invoice_id = ?) AS source_owners,
                (SELECT COUNT(*) FROM invoice_subscriptions ins
                 WHERE ins.invoice_id = ?) AS upgrade_owners
         FROM termination_credit_note_contexts tc
         JOIN credit_notes cn ON cn.id = tc.credit_note_id
         WHERE tc.subscription_id = ?`,
      )
        .bind(invoices!.source_id, invoices!.upgrade_id, createdBody.subscription.lago_id)
        .first(),
    ).resolves.toEqual({ allocation_state: "draft", source_owners: 1, upgrade_owners: 2 });

    const premature = await api(`/api/v1/invoices/${invoices!.upgrade_id}/finalize`, "PUT");
    expect(premature.status).toBe(422);
    await expect(premature.json()).resolves.toMatchObject({
      code: "termination_credit_note_not_finalized",
    });
    expect((await api(`/api/v1/invoices/${invoices!.source_id}/finalize`, "PUT")).status).toBe(200);
    await env.BILLING_DB.prepare(
      `CREATE TRIGGER abort_upgrade_credit_application
       BEFORE INSERT ON credit_note_applications
       WHEN NEW.invoice_id = '${invoices!.upgrade_id}'
       BEGIN SELECT RAISE(ABORT, 'synthetic_upgrade_credit_failure'); END`,
    ).run();
    const rolledBack = await api(`/api/v1/invoices/${invoices!.upgrade_id}/finalize`, "PUT");
    expect(rolledBack.status).toBe(500);
    await expect(
      env.BILLING_DB.prepare(
        `SELECT i.status, cn.credit_status, cn.allocation_state,
                (SELECT COUNT(*) FROM credit_note_applications cna
                 WHERE cna.invoice_id = i.id) AS applications
         FROM invoices i
         JOIN termination_credit_note_contexts tc ON tc.subscription_id = ?
         JOIN credit_notes cn ON cn.id = tc.credit_note_id
         WHERE i.id = ?`,
      )
        .bind(createdBody.subscription.lago_id, invoices!.upgrade_id)
        .first(),
    ).resolves.toEqual({
      status: "draft",
      credit_status: "available",
      allocation_state: "finalized",
      applications: 0,
    });
    await env.BILLING_DB.prepare("DROP TRIGGER abort_upgrade_credit_application").run();
    const finalized = await api(`/api/v1/invoices/${invoices!.upgrade_id}/finalize`, "PUT");
    expect(finalized.status).toBe(200);
    await expect(
      env.BILLING_DB.prepare(
        `SELECT i.status, i.subtotal_minor, i.credit_notes_minor, i.total_due_minor,
                cn.allocation_state,
                (SELECT COUNT(*) FROM credit_note_applications cna
                 WHERE cna.invoice_id = i.id) AS applications,
                (SELECT COUNT(*) FROM outbox_events o
                 WHERE o.aggregate_id = cn.id AND o.event_type = 'credit_note.created') AS events
         FROM invoices i
         JOIN termination_credit_note_contexts tc ON tc.subscription_id = ?
         JOIN credit_notes cn ON cn.id = tc.credit_note_id
         WHERE i.id = ?`,
      )
        .bind(createdBody.subscription.lago_id, invoices!.upgrade_id)
        .first<{
          status: string;
          subtotal_minor: number;
          credit_notes_minor: number;
          total_due_minor: number;
          allocation_state: string;
          applications: number;
          events: number;
        }>(),
    ).resolves.toMatchObject({
      status: "finalized",
      allocation_state: "finalized",
      applications: 1,
      events: 1,
    });
    const totals = await env.BILLING_DB.prepare(
      "SELECT subtotal_minor, credit_notes_minor, total_due_minor FROM invoices WHERE id = ?",
    )
      .bind(invoices!.upgrade_id)
      .first<{ subtotal_minor: number; credit_notes_minor: number; total_due_minor: number }>();
    expect(totals!.credit_notes_minor).toBeGreaterThan(0);
    expect(totals!.total_due_minor).toBe(totals!.subtotal_minor - totals!.credit_notes_minor);
  });

  it("uses the ownership graph to credit and finalize a second upgrade", async () => {
    await env.BILLING_DB.batch([
      env.BILLING_DB.prepare(
        `UPDATE plans SET pay_in_advance = CASE WHEN id = 'plan-change-base' THEN 0 ELSE 1 END
         WHERE id IN ('plan-change-base', 'plan-change-upgrade', 'plan-change-upgrade-two')`,
      ),
      env.BILLING_DB.prepare(
        "UPDATE customers SET invoice_grace_period = 2 WHERE id = 'customer-plan-change'",
      ),
    ]);
    expect(
      (await createSubscription("subscription-upgrade-chain", "plan-change-base")).status,
    ).toBe(200);
    const firstUpgrade = await createSubscription(
      "subscription-upgrade-chain",
      "plan-change-upgrade",
    );
    const firstBody = await firstUpgrade.json<{ subscription: { lago_id: string } }>();
    expect(firstUpgrade.status).toBe(200);
    const secondUpgrade = await createSubscription(
      "subscription-upgrade-chain",
      "plan-change-upgrade-two",
    );
    expect(secondUpgrade.status).toBe(200);

    const pair = await env.BILLING_DB.prepare(
      `SELECT source.invoice_id AS source_id, dependent.invoice_id AS dependent_id
       FROM plan_change_invoice_contexts source
       JOIN plan_change_invoice_contexts dependent
         ON dependent.previous_subscription_id = source.next_subscription_id
       WHERE source.next_subscription_id = ?`,
    )
      .bind(firstBody.subscription.lago_id)
      .first<{ source_id: string; dependent_id: string }>();
    expect(pair?.source_id).toBeTruthy();
    expect(pair?.dependent_id).toBeTruthy();
    const cutoff = new Date().toISOString();
    await env.BILLING_DB.prepare(
      "UPDATE invoices SET expected_finalization_date = date(?) WHERE id IN (?, ?)",
    )
      .bind(cutoff, pair!.source_id, pair!.dependent_id)
      .run();
    await expect(finalizeDueInvoices(env, cutoff, "upgrade-chain-finalize")).resolves.toBe(2);
    await expect(finalizeDueInvoices(env, cutoff, "upgrade-chain-replay")).resolves.toBe(0);

    await expect(
      env.BILLING_DB.prepare(
        `SELECT
           (SELECT COUNT(*) FROM invoices WHERE id IN (?, ?) AND status = 'finalized') AS finalized,
           (SELECT COUNT(*) FROM invoice_subscriptions WHERE invoice_id IN (?, ?)) AS owners,
           cn.allocation_state, source_line.source_id,
           (SELECT COUNT(*) FROM credit_note_applications cna
            WHERE cna.invoice_id = ?) AS applications
         FROM termination_credit_note_contexts tc
         JOIN credit_notes cn ON cn.id = tc.credit_note_id
         JOIN credit_note_items cni ON cni.credit_note_id = cn.id
         JOIN invoice_lines source_line ON source_line.id = cni.invoice_line_id
         WHERE tc.subscription_id = ?`,
      )
        .bind(
          pair!.source_id,
          pair!.dependent_id,
          pair!.source_id,
          pair!.dependent_id,
          pair!.dependent_id,
          firstBody.subscription.lago_id,
        )
        .first(),
    ).resolves.toEqual({
      finalized: 2,
      owners: 4,
      allocation_state: "finalized",
      source_id: "plan-change-upgrade",
      applications: 1,
    });
    await expect(generationState("subscription-upgrade-chain")).resolves.toMatchObject([
      { status: "terminated", generation: 1 },
      { status: "terminated", generation: 2 },
      { status: "active", generation: 3 },
    ]);
  });

  it("anchors a later plan trial to the first generation and defers its prepaid base", async () => {
    await env.BILLING_DB.prepare(
      `UPDATE plans SET pay_in_advance = 1, trial_period = 10
       WHERE id = 'plan-change-upgrade'`,
    ).run();
    const created = await createSubscription("subscription-upgrade-trial", "plan-change-base");
    const createdBody = await created.json<{ subscription: { lago_id: string } }>();
    const initialStart = new Date(Date.now() - 5 * 86_400_000).toISOString();
    await env.BILLING_DB.prepare(
      `UPDATE subscriptions SET started_at = ?, subscription_at = ?, current_period_start = ?
       WHERE id = ?`,
    )
      .bind(initialStart, initialStart, initialStart, createdBody.subscription.lago_id)
      .run();
    const upgraded = await createSubscription("subscription-upgrade-trial", "plan-change-upgrade");
    expect(upgraded.status).toBe(200);
    const upgradedBody = await upgraded.json<{ subscription: { lago_id: string } }>();
    const generation = await env.BILLING_DB.prepare(
      `SELECT trial_started_at, trial_end_at,
              (SELECT COUNT(*) FROM invoice_subscriptions ins
               JOIN invoice_lines il ON il.invoice_id = ins.invoice_id
               WHERE ins.subscription_id = subscriptions.id
                 AND il.source_type = 'plan' AND il.source_id = subscriptions.plan_id) AS target_lines
       FROM subscriptions WHERE id = ?`,
    )
      .bind(upgradedBody.subscription.lago_id)
      .first<{ trial_started_at: string; trial_end_at: string; target_lines: number }>();
    expect(generation?.trial_started_at).toBe(initialStart);
    expect(Date.parse(generation!.trial_end_at) - Date.parse(initialStart)).toBe(10 * 86_400_000);
    expect(generation?.target_lines).toBe(0);
  });

  it("refreshes and finalizes an in-arrears upgrade draft from immutable generations", async () => {
    await env.BILLING_DB.prepare(
      "UPDATE customers SET invoice_grace_period = 2 WHERE id = 'customer-plan-change'",
    ).run();
    const created = await createSubscription("subscription-upgrade-grace", "plan-change-base");
    const createdBody = await created.json<{ subscription: { lago_id: string } }>();
    const tenDaysAgo = new Date(Date.now() - 10 * 86_400_000).toISOString();
    await env.BILLING_DB.prepare(
      `UPDATE subscriptions SET started_at = ?, subscription_at = ?, current_period_start = ?
       WHERE id = ?`,
    )
      .bind(tenDaysAgo, tenDaysAgo, tenDaysAgo, createdBody.subscription.lago_id)
      .run();

    const upgraded = await createSubscription("subscription-upgrade-grace", "plan-change-upgrade");
    expect(upgraded.status).toBe(200);
    const draft = await env.BILLING_DB.prepare(
      `SELECT i.id, i.status, i.total_due_minor, pc.transition_kind
       FROM invoices i JOIN plan_change_invoice_contexts pc ON pc.invoice_id = i.id
       WHERE pc.previous_subscription_id = ?`,
    )
      .bind(createdBody.subscription.lago_id)
      .first<{ id: string; status: string; total_due_minor: number; transition_kind: string }>();
    expect(draft).toMatchObject({ status: "draft", transition_kind: "upgrade" });
    expect(draft?.total_due_minor).toBeGreaterThan(0);

    await env.BILLING_DB.prepare(
      "UPDATE plans SET name = 'Upgraded plan renamed' WHERE id = 'plan-change-upgrade'",
    ).run();
    await expect(
      env.BILLING_DB.prepare("SELECT ready_to_be_refreshed FROM invoices WHERE id = ?")
        .bind(draft?.id)
        .first(),
    ).resolves.toEqual({ ready_to_be_refreshed: 1 });

    const refreshed = await api(`/api/v1/invoices/${draft?.id}/refresh`, "PUT");
    expect(refreshed.status).toBe(200);
    await expect(refreshed.json()).resolves.toMatchObject({
      invoice: { status: "draft", version_number: 2 },
    });
    const finalized = await api(`/api/v1/invoices/${draft?.id}/finalize`, "PUT");
    expect(finalized.status).toBe(200);
    await expect(finalized.json()).resolves.toMatchObject({
      invoice: { status: "finalized", version_number: 3 },
    });
  });

  it("converges concurrent downgrade commands on one pending generation", async () => {
    const created = await createSubscription("subscription-downgrade-race", "plan-change-base");
    expect(created.status).toBe(200);
    const responses = await Promise.all([
      createSubscription("subscription-downgrade-race", "plan-change-downgrade"),
      createSubscription("subscription-downgrade-race", "plan-change-downgrade"),
    ]);
    const statuses = responses.map((response) => response.status);
    expect(statuses).toContain(200);
    expect(statuses.every((status) => status === 200 || status === 409)).toBe(true);
    await expect(generationState("subscription-downgrade-race")).resolves.toMatchObject([
      { status: "active", generation: 1 },
      { status: "pending", generation: 2 },
    ]);
  });

  it("cancels a queued downgrade in the same transaction that terminates the current plan", async () => {
    const created = await createSubscription("subscription-downgrade-cancel", "plan-change-base");
    expect(created.status).toBe(200);
    const queued = await createSubscription(
      "subscription-downgrade-cancel",
      "plan-change-downgrade",
    );
    expect(queued.status).toBe(200);
    const terminated = await api("/api/v1/subscriptions/subscription-downgrade-cancel", "DELETE");
    expect(terminated.status).toBe(200);
    await expect(generationState("subscription-downgrade-cancel")).resolves.toMatchObject([
      { status: "terminated", generation: 1 },
      { status: "canceled", generation: 2 },
    ]);
  });

  it("rolls back both sides of a failed downgrade boundary transition", async () => {
    const created = await createSubscription("subscription-downgrade-rollback", "plan-change-base");
    const createdBody = await created.json<{ subscription: { lago_id: string } }>();
    await createSubscription("subscription-downgrade-rollback", "plan-change-downgrade");
    const boundary = await env.BILLING_DB.prepare(
      "SELECT current_period_end FROM subscriptions WHERE id = ?",
    )
      .bind(createdBody.subscription.lago_id)
      .first<{ current_period_end: string }>();
    await env.BILLING_DB.prepare(
      `CREATE TRIGGER test_abort_downgrade_context
       BEFORE INSERT ON plan_change_invoice_contexts
       WHEN NEW.transition_kind = 'downgrade'
       BEGIN SELECT RAISE(ABORT, 'test_downgrade_abort'); END`,
    ).run();
    await expect(
      closeBillingPeriod(
        env,
        createdBody.subscription.lago_id,
        boundary!.current_period_end,
        "downgrade-rollback",
      ),
    ).rejects.toThrow("test_downgrade_abort");
    await env.BILLING_DB.prepare("DROP TRIGGER test_abort_downgrade_context").run();
    await expect(generationState("subscription-downgrade-rollback")).resolves.toMatchObject([
      { status: "active", generation: 1 },
      { status: "pending", generation: 2 },
    ]);
    await expect(
      env.BILLING_DB.prepare(`SELECT COUNT(*) AS total FROM invoices WHERE subscription_id = ?`)
        .bind(createdBody.subscription.lago_id)
        .first(),
    ).resolves.toEqual({ total: 0 });
  });
});

function createSubscription(externalId: string, planCode: string): Promise<Response> {
  return SELF.fetch("https://lago.test/api/v1/subscriptions", {
    method: "POST",
    headers,
    body: JSON.stringify({
      subscription: {
        external_customer_id: "customer-plan-change",
        external_id: externalId,
        plan_code: planCode,
      },
    }),
  });
}

function api(path: string, method: string): Promise<Response> {
  return SELF.fetch(`https://lago.test${path}`, { method, headers });
}

async function generationState(externalId: string) {
  const result = await env.BILLING_DB.prepare(
    `SELECT s.id, p.code AS plan_code, s.status, s.generation, s.previous_subscription_id
     FROM subscriptions s JOIN plans p ON p.id = s.plan_id
     WHERE s.organization_id = 'org-plan-change' AND s.external_id = ?
     ORDER BY s.generation`,
  )
    .bind(externalId)
    .all<{
      id: string;
      plan_code: string;
      status: string;
      generation: number;
      previous_subscription_id: string | null;
    }>();
  return [...result.results];
}
