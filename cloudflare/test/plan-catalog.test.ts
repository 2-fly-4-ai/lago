import { env, introspectWorkflow, SELF } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { sha256Hex } from "../src/auth/api-key";
import { preparePlanDeletion } from "../src/billing/plan-deletion";
import { deterministicUuid } from "../src/identifiers";

const apiKey = "plan-catalog-test-key";
const headers = { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" };

beforeEach(async () => {
  const now = "2026-08-13T00:00:00.000Z";
  await env.BILLING_DB.batch([
    env.BILLING_DB.prepare(
      `INSERT OR IGNORE INTO organizations (id, external_id, name, created_at, updated_at)
       VALUES ('org-plan-catalog', 'plan-catalog', 'Plan Catalog', ?, ?)`,
    ).bind(now, now),
    env.BILLING_DB.prepare(
      `INSERT OR IGNORE INTO api_keys
       (id, organization_id, key_prefix, key_hash, created_at, revoked_at)
       VALUES ('key-plan-catalog', 'org-plan-catalog', 'plan-cat', ?, ?, NULL)`,
    ).bind(await sha256Hex(apiKey), now),
    env.BILLING_DB.prepare(
      `INSERT OR IGNORE INTO billable_metrics
       (id, organization_id, code, name, aggregation_type, field_name, recurring,
        properties_json, version, active, created_at, updated_at)
       VALUES ('metric-plan-catalog', 'org-plan-catalog', 'requests', 'Requests',
               'count_agg', NULL, 0, '{}', 1, 1, ?, ?)`,
    ).bind(now, now),
  ]);
});

describe("Lago-compatible plan catalog", () => {
  it("atomically creates and replays a plan with embedded charges", async () => {
    const payload = {
      plan: {
        name: "Pro",
        invoice_display_name: "Pro plan",
        code: "pro",
        interval: "monthly",
        description: "Synthetic plan",
        amount_cents: 1000,
        amount_currency: "usd",
        pay_in_advance: true,
        metadata: { tier: "pro" },
        charges: [
          {
            billable_metric_id: "metric-plan-catalog",
            code: "requests-charge",
            charge_model: "standard",
            accepts_target_wallet: true,
            properties: { amount: "2.5" },
          },
        ],
      },
    };
    const first = await api("/api/v1/plans", "POST", payload);
    expect(first.status).toBe(200);
    const firstBody = await first.json<{ plan: { lago_id: string } }>();
    await expect(apiJson("/api/v1/plans/pro")).resolves.toMatchObject({
      plan: {
        lago_id: firstBody.plan.lago_id,
        code: "pro",
        amount_cents: 1000,
        amount_currency: "USD",
        pay_in_advance: true,
        metadata: { tier: "pro" },
        charges: [
          {
            code: "requests-charge",
            billable_metric_code: "requests",
            charge_model: "standard",
            accepts_target_wallet: true,
            properties: { amount: "2.5" },
          },
        ],
      },
    });

    const replay = await api("/api/v1/plans", "POST", payload);
    expect(replay.status).toBe(200);
    await expect(replay.json()).resolves.toMatchObject({
      plan: { lago_id: firstBody.plan.lago_id },
    });
    await expect(apiJson("/api/v1/plans")).resolves.toMatchObject({
      meta: { total_count: 1 },
      plans: [{ lago_id: firstBody.plan.lago_id }],
    });

    const changed = await api("/api/v1/plans", "POST", {
      plan: { ...payload.plan, amount_cents: 2000 },
    });
    expect(changed.status).toBe(422);
    await expect(changed.json()).resolves.toMatchObject({ code: "value_already_exist" });
  });

  it("creates embedded charge filters from the metric filter catalog", async () => {
    await env.BILLING_DB.prepare(
      `UPDATE billable_metrics SET filters_json = '[{"key":"region","values":["eu","us"]}]'
       WHERE id = 'metric-plan-catalog'`,
    ).run();
    const response = await api("/api/v1/plans", "POST", {
      plan: {
        name: "Filtered",
        code: "filtered-plan",
        interval: "monthly",
        amount_cents: 0,
        amount_currency: "USD",
        charges: [
          {
            billable_metric_id: "metric-plan-catalog",
            code: "filtered-requests",
            charge_model: "standard",
            properties: { amount: "1" },
            filters: [
              {
                invoice_display_name: "Europe",
                properties: { amount: "2" },
                values: { region: ["eu"] },
              },
            ],
          },
        ],
      },
    });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      plan: {
        charges: [
          {
            code: "filtered-requests",
            filters: [
              {
                charge_code: "filtered-requests",
                invoice_display_name: "Europe",
                properties: { amount: "2" },
                values: { region: ["eu"] },
              },
            ],
          },
        ],
      },
    });
  });

  it("atomically creates, serializes, and replays plan usage thresholds", async () => {
    const payload = {
      plan: {
        name: "Progressive",
        code: "progressive",
        interval: "monthly",
        amount_cents: 0,
        amount_currency: "USD",
        usage_thresholds: [
          {
            amount_cents: 1000,
            recurring: false,
            threshold_display_name: "First thousand",
          },
          { amount_cents: 500, recurring: true },
        ],
      },
    };
    const first = await api("/api/v1/plans", "POST", payload);
    expect(first.status).toBe(200);
    const firstBody = await first.json<{
      plan: {
        lago_id: string;
        usage_thresholds: Array<{ lago_id: string; amount_cents: number }>;
      };
    }>();
    expect(firstBody.plan.usage_thresholds).toMatchObject([
      {
        amount_cents: 1000,
        recurring: false,
        threshold_display_name: "First thousand",
      },
      { amount_cents: 500, recurring: true, threshold_display_name: null },
    ]);
    await expect(apiJson("/api/v1/plans/progressive")).resolves.toMatchObject({
      plan: {
        lago_id: firstBody.plan.lago_id,
        usage_thresholds: firstBody.plan.usage_thresholds,
        applicable_usage_thresholds: firstBody.plan.usage_thresholds,
      },
    });

    const replay = await api("/api/v1/plans", "POST", payload);
    expect(replay.status).toBe(200);
    await expect(replay.json()).resolves.toMatchObject({
      plan: {
        lago_id: firstBody.plan.lago_id,
        usage_thresholds: firstBody.plan.usage_thresholds,
      },
    });
    await expect(
      env.BILLING_DB.prepare(
        `SELECT COUNT(*) AS total FROM usage_thresholds WHERE plan_id = ? AND deleted_at IS NULL`,
      )
        .bind(firstBody.plan.lago_id)
        .first(),
    ).resolves.toEqual({ total: 2 });
  });

  it("preserves omitted plan thresholds and atomically replaces or clears supplied sets", async () => {
    const created = await api("/api/v1/plans", "POST", {
      plan: {
        name: "Mutable thresholds",
        code: "mutable-thresholds",
        interval: "monthly",
        amount_cents: 0,
        amount_currency: "USD",
        usage_thresholds: [
          { amount_cents: 100, recurring: false, threshold_display_name: "Original" },
        ],
      },
    });
    expect(created.status).toBe(200);
    const original = await created.json<{
      plan: { lago_id: string; usage_thresholds: Array<{ lago_id: string }> };
    }>();
    const originalThresholdId = original.plan.usage_thresholds[0]!.lago_id;

    const scalarOnly = await api("/api/v1/plans/mutable-thresholds", "PUT", {
      plan: { name: "Scalar update" },
    });
    expect(scalarOnly.status).toBe(200);
    await expect(scalarOnly.json()).resolves.toMatchObject({
      plan: { usage_thresholds: [{ lago_id: originalThresholdId, amount_cents: 100 }] },
    });

    const replaced = await api("/api/v1/plans/mutable-thresholds", "PUT", {
      plan: {
        name: "Replacement update",
        usage_thresholds: [
          { amount_cents: 250, recurring: false, threshold_display_name: "Replacement" },
          { amount_cents: 50, recurring: true },
        ],
      },
    });
    expect(replaced.status).toBe(200);
    const replacedBody = await replaced.json<{
      plan: { usage_thresholds: Array<{ lago_id: string }> };
    }>();
    expect(replacedBody.plan.usage_thresholds).toMatchObject([
      { amount_cents: 250, recurring: false, threshold_display_name: "Replacement" },
      { amount_cents: 50, recurring: true },
    ]);
    expect(replacedBody.plan.usage_thresholds.map((threshold) => threshold.lago_id)).not.toContain(
      originalThresholdId,
    );
    await expect(
      env.BILLING_DB.prepare(
        `SELECT COUNT(*) AS total,
                SUM(CASE WHEN deleted_at IS NULL THEN 1 ELSE 0 END) AS active
         FROM usage_thresholds WHERE plan_id = ?`,
      )
        .bind(original.plan.lago_id)
        .first(),
    ).resolves.toEqual({ active: 2, total: 3 });

    const invalid = await api("/api/v1/plans/mutable-thresholds", "PUT", {
      plan: {
        name: "Must not persist",
        usage_thresholds: [
          { amount_cents: 50, recurring: true },
          { amount_cents: 75, recurring: true },
        ],
      },
    });
    expect(invalid.status).toBe(422);
    await expect(invalid.json()).resolves.toMatchObject({
      code: "multiple_recurring_thresholds",
    });
    await expect(apiJson("/api/v1/plans/mutable-thresholds")).resolves.toMatchObject({
      plan: { name: "Replacement update", usage_thresholds: replacedBody.plan.usage_thresholds },
    });

    const cleared = await api("/api/v1/plans/mutable-thresholds", "PUT", {
      plan: { usage_thresholds: [] },
    });
    expect(cleared.status).toBe(200);
    await expect(cleared.json()).resolves.toMatchObject({
      plan: { usage_thresholds: [], applicable_usage_thresholds: [] },
    });
    await expect(
      env.BILLING_DB.prepare(
        `SELECT COUNT(*) AS total FROM usage_thresholds
         WHERE plan_id = ? AND deleted_at IS NULL`,
      )
        .bind(original.plan.lago_id)
        .first(),
    ).resolves.toEqual({ total: 0 });
  });

  it("rejects invalid usage-threshold sets before persisting a plan", async () => {
    const base = {
      name: "Invalid thresholds",
      interval: "monthly",
      amount_cents: 0,
      amount_currency: "USD",
    };
    const cases = [
      {
        code: "zero-threshold",
        usage_thresholds: [{ amount_cents: 0, recurring: false }],
        error: "validation_error",
      },
      {
        code: "duplicate-threshold",
        usage_thresholds: [
          { amount_cents: 100, recurring: false },
          { amount_cents: 100, recurring: false },
        ],
        error: "duplicated_values",
      },
      {
        code: "multiple-recurring-thresholds",
        usage_thresholds: [
          { amount_cents: 100, recurring: true },
          { amount_cents: 200, recurring: true },
        ],
        error: "multiple_recurring_thresholds",
      },
    ];
    for (const invalid of cases) {
      const response = await api("/api/v1/plans", "POST", {
        plan: { ...base, code: invalid.code, usage_thresholds: invalid.usage_thresholds },
      });
      expect(response.status).toBe(422);
      await expect(response.json()).resolves.toMatchObject({ code: invalid.error });
    }
    await expect(
      env.BILLING_DB.prepare(
        `SELECT COUNT(*) AS total FROM plans
         WHERE organization_id = 'org-plan-catalog'
           AND code IN ('zero-threshold', 'duplicate-threshold', 'multiple-recurring-thresholds')`,
      ).first(),
    ).resolves.toEqual({ total: 0 });
  });

  it("rolls back the whole plan graph when an embedded threshold insert conflicts", async () => {
    const targetPlanId = await deterministicUuid("plan", "org-plan-catalog:threshold-atomicity");
    const collidingThresholdId = await deterministicUuid(
      "usage-threshold",
      `plan:org-plan-catalog:${targetPlanId}:1:0:100`,
    );
    const now = "2026-08-15T00:00:00.000Z";
    await env.BILLING_DB.batch([
      env.BILLING_DB.prepare(
        `INSERT INTO plans
         (id, organization_id, code, name, interval, amount_minor, currency, version,
          active, created_at, updated_at, metadata_json, pending_deletion)
         VALUES ('plan-threshold-collision-owner', 'org-plan-catalog',
                 'threshold-collision-owner', 'Collision owner', 'monthly', 0, 'USD', 1,
                 1, ?, ?, '{}', 0)`,
      ).bind(now, now),
      env.BILLING_DB.prepare(
        `INSERT INTO usage_thresholds
         (id, organization_id, plan_id, subscription_id, amount_minor, recurring,
          version, deleted_at, created_at, updated_at)
         VALUES (?, 'org-plan-catalog', 'plan-threshold-collision-owner', NULL,
                 999, 0, 1, NULL, ?, ?)`,
      ).bind(collidingThresholdId, now, now),
    ]);

    const response = await api("/api/v1/plans", "POST", {
      plan: {
        name: "Atomic thresholds",
        code: "threshold-atomicity",
        interval: "monthly",
        amount_cents: 0,
        amount_currency: "USD",
        usage_thresholds: [{ amount_cents: 100, recurring: false }],
      },
    });
    expect(response.status).toBe(500);
    await expect(
      env.BILLING_DB.prepare("SELECT COUNT(*) AS total FROM plans WHERE id = ?")
        .bind(targetPlanId)
        .first(),
    ).resolves.toEqual({ total: 0 });
    await expect(
      env.BILLING_DB.prepare("SELECT COUNT(*) AS total FROM outbox_events WHERE aggregate_id = ?")
        .bind(targetPlanId)
        .first(),
    ).resolves.toEqual({ total: 0 });
  });

  it("fails explicitly for catalog behavior not yet implemented", async () => {
    const response = await api("/api/v1/plans", "POST", {
      plan: {
        name: "Unsupported",
        code: "unsupported",
        interval: "monthly",
        amount_cents: 100,
        amount_currency: "USD",
        tax_codes: ["vat"],
      },
    });
    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toMatchObject({ code: "unsupported_tax_target" });
  });

  it("updates safe scalar fields, retires standalone plans, and reuses codes safely", async () => {
    const payload = {
      plan: {
        name: "Mutable",
        code: "mutable",
        interval: "monthly",
        amount_cents: 100,
        amount_currency: "USD",
        pay_in_advance: true,
        metadata: { version: 1 },
      },
    };
    const created = await api("/api/v1/plans", "POST", payload);
    const planId = (await created.json<{ plan: { lago_id: string } }>()).plan.lago_id;
    const updated = await api("/api/v1/plans/mutable", "PUT", {
      plan: {
        code: "mutable-renamed",
        name: "Mutable renamed",
        invoice_display_name: "Mutable invoice",
        description: "Updated safely",
        amount_cents: 250,
        amount_currency: "EUR",
        interval: "quarterly",
        pay_in_advance: false,
        metadata: { version: 2 },
      },
    });
    expect(updated.status).toBe(200);
    await expect(updated.json()).resolves.toMatchObject({
      plan: {
        lago_id: planId,
        code: "mutable-renamed",
        name: "Mutable renamed",
        invoice_display_name: "Mutable invoice",
        description: "Updated safely",
        amount_cents: 250,
        amount_currency: "EUR",
        interval: "quarterly",
        pay_in_advance: false,
        metadata: { version: 2 },
      },
    });
    expect((await api("/api/v1/plans/mutable")).status).toBe(404);
    const events = await env.BILLING_DB.prepare(
      `SELECT event_type, aggregate_version FROM outbox_events
       WHERE aggregate_type = 'plan' AND aggregate_id = ? ORDER BY aggregate_version`,
    )
      .bind(planId)
      .all<{ event_type: string; aggregate_version: number }>();
    expect(events.results).toEqual([
      { event_type: "plan.created", aggregate_version: 1 },
      { event_type: "plan.updated", aggregate_version: 2 },
    ]);

    const graph = await api("/api/v1/plans/mutable-renamed", "PUT", {
      plan: { charges: [] },
    });
    expect(graph.status).toBe(422);
    await expect(graph.json()).resolves.toMatchObject({ code: "unsupported_plan_update" });
    const deleted = await api("/api/v1/plans/mutable-renamed", "DELETE");
    expect(deleted.status).toBe(200);
    await expect(deleted.json()).resolves.toMatchObject({
      plan: { lago_id: planId, code: "mutable-renamed" },
    });
    expect((await api("/api/v1/plans/mutable-renamed")).status).toBe(404);
    expect((await api("/api/v1/plans/mutable-renamed", "DELETE")).status).toBe(404);

    const recreated = await api("/api/v1/plans", "POST", {
      plan: {
        name: "Mutable generation two",
        code: "mutable-renamed",
        interval: "monthly",
        amount_cents: 300,
        amount_currency: "USD",
      },
    });
    expect(recreated.status).toBe(200);
    const recreatedId = (await recreated.json<{ plan: { lago_id: string } }>()).plan.lago_id;
    expect(recreatedId).not.toBe(planId);
    expect((await api("/api/v1/plans/mutable-renamed", "DELETE")).status).toBe(200);
    expect(
      (
        await api("/api/v1/plans", "POST", {
          plan: {
            name: "Mutable generation three",
            code: "mutable-renamed",
            interval: "yearly",
            amount_cents: 400,
            amount_currency: "USD",
          },
        })
      ).status,
    ).toBe(200);
    await expect(
      env.BILLING_DB.prepare(
        `SELECT version, active FROM plans
         WHERE organization_id = 'org-plan-catalog' AND code = 'mutable-renamed'
         ORDER BY version`,
      ).all(),
    ).resolves.toMatchObject({
      results: [
        { active: 0, version: 3 },
        { active: 0, version: 5 },
        { active: 1, version: 6 },
      ],
    });
    await expect(
      env.BILLING_DB.prepare("SELECT COUNT(*) AS total FROM plan_mutation_guards").first(),
    ).resolves.toEqual({ total: 0 });
  });

  it("limits attached-plan updates to Rails-safe mutable scalar fields", async () => {
    await expect(
      api("/api/v1/plans", "POST", {
        plan: {
          name: "Attached",
          code: "attached",
          interval: "monthly",
          amount_cents: 100,
          amount_currency: "USD",
        },
      }),
    ).resolves.toMatchObject({ status: 200 });
    const now = "2026-08-14T00:00:00.000Z";
    await env.BILLING_DB.batch([
      env.BILLING_DB.prepare(
        `INSERT INTO customers
         (id, organization_id, external_id, currency, metadata_json, created_at, updated_at)
         VALUES ('customer-attached-plan', 'org-plan-catalog', 'customer-attached-plan',
                 'USD', '{}', ?, ?)`,
      ).bind(now, now),
      env.BILLING_DB.prepare(
        `INSERT INTO subscriptions
         (id, organization_id, customer_id, plan_id, external_id, status, version,
          created_at, updated_at, on_termination_invoice)
         SELECT 'subscription-attached-plan', organization_id, 'customer-attached-plan', id,
                'subscription-attached-plan', 'active', 1, ?, ?, 'skip'
         FROM plans WHERE organization_id = 'org-plan-catalog' AND code = 'attached' AND active = 1`,
      ).bind(now, now),
    ]);
    const safe = await api("/api/v1/plans/attached", "PUT", {
      plan: { name: "Attached renamed", amount_cents: 150, metadata: { safe: true } },
    });
    expect(safe.status).toBe(200);
    await expect(safe.json()).resolves.toMatchObject({
      plan: { name: "Attached renamed", amount_cents: 150, metadata: { safe: true } },
    });
    const unsafe = await api("/api/v1/plans/attached", "PUT", {
      plan: { interval: "yearly" },
    });
    expect(unsafe.status).toBe(422);
    await expect(unsafe.json()).resolves.toMatchObject({ code: "plan_in_use" });
  });

  it("asynchronously terminates plan generations, finalizes drafts, and retires history once", async () => {
    const created = await api("/api/v1/plans", "POST", {
      plan: {
        name: "Async retirement",
        code: "async-retirement",
        interval: "monthly",
        amount_cents: 900,
        amount_currency: "USD",
        pay_in_advance: true,
        minimum_commitment: { amount_cents: 100000 },
      },
    });
    expect(created.status).toBe(200);
    const planId = (await created.json<{ plan: { lago_id: string } }>()).plan.lago_id;
    const now = new Date().toISOString();
    await env.BILLING_DB.batch([
      env.BILLING_DB.prepare(
        `INSERT INTO customers
         (id, organization_id, external_id, currency, invoice_grace_period,
          metadata_json, created_at, updated_at)
         VALUES ('customer-async-plan', 'org-plan-catalog', 'customer-async-plan', 'USD', 2,
                 '{}', ?, ?)`,
      ).bind(now, now),
      env.BILLING_DB.prepare(
        `INSERT INTO subscriptions
         (id, organization_id, customer_id, plan_id, external_id, status, started_at,
          current_period_start, current_period_end, version, created_at, updated_at,
          subscription_at, generation, transition_kind, on_termination_credit_note)
         VALUES ('subscription-async-active', 'org-plan-catalog', 'customer-async-plan', ?,
                 'subscription-async', 'active', '2026-08-01T00:00:00.000Z',
                 '2026-08-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z', 1, ?, ?,
                 '2026-08-01T00:00:00.000Z', 1, 'initial', 'skip')`,
      ).bind(planId, now, now),
      env.BILLING_DB.prepare(
        `INSERT INTO subscriptions
         (id, organization_id, customer_id, plan_id, external_id, status, version,
          created_at, updated_at, subscription_at, previous_subscription_id,
          generation, transition_kind, transition_at)
         VALUES ('subscription-async-pending', 'org-plan-catalog', 'customer-async-plan', ?,
                 'subscription-async', 'pending', 1, ?, ?, '2026-08-01T00:00:00.000Z',
                 'subscription-async-active', 2, 'downgrade', '2026-09-01T00:00:00.000Z')`,
      ).bind(planId, now, now),
    ]);

    const workflow = await introspectWorkflow(env.PLAN_DELETION_WORKFLOW);
    try {
      await workflow.modifyAll(async (modifier) => {
        await modifier.disableRetryDelays();
        await modifier.mockStepError(
          { name: "process subscription batch 1" },
          new Error("synthetic_transient_plan_deletion_failure"),
          1,
        );
      });
      const first = await api("/api/v1/plans/async-retirement", "DELETE");
      expect(first.status).toBe(200);
      await expect(first.json()).resolves.toMatchObject({
        plan: { lago_id: planId, pending_deletion: true },
      });
      const replay = await api("/api/v1/plans/async-retirement", "DELETE");
      expect(replay.status).toBe(200);
      await expect(replay.json()).resolves.toMatchObject({
        plan: { lago_id: planId, pending_deletion: true },
      });

      const instances = await workflow.get();
      expect(instances).toHaveLength(1);
      await instances[0]!.waitForStatus("complete");
      await expect(instances[0]!.getOutput()).resolves.toMatchObject({
        status: "completed",
        retired: true,
      });
    } finally {
      await workflow.dispose();
    }

    await expect(
      env.BILLING_DB.prepare(
        `SELECT active, pending_deletion, version,
                (SELECT status FROM plan_deletion_tasks WHERE plan_id = plans.id) AS task_status,
                (SELECT COUNT(*) FROM outbox_events
                 WHERE aggregate_id = plans.id AND event_type = 'plan.deleted') AS delete_events
         FROM plans WHERE id = ?`,
      )
        .bind(planId)
        .first(),
    ).resolves.toEqual({
      active: 0,
      delete_events: 1,
      pending_deletion: 0,
      task_status: "completed",
      version: 2,
    });
    await expect(
      env.BILLING_DB.prepare(
        `SELECT id, status, version FROM subscriptions
         WHERE plan_id = ? ORDER BY generation`,
      )
        .bind(planId)
        .all(),
    ).resolves.toMatchObject({
      results: [
        { id: "subscription-async-active", status: "terminated", version: 2 },
        { id: "subscription-async-pending", status: "canceled", version: 2 },
      ],
    });
    await expect(
      env.BILLING_DB.prepare(
        `SELECT invoice.status, COUNT(*) AS total,
                (SELECT COUNT(*) FROM invoice_lines line
                 WHERE line.invoice_id = invoice.id AND line.line_type = 'commitment')
                  AS commitment_lines
         FROM invoices invoice
         WHERE invoice.subscription_id = 'subscription-async-active' GROUP BY invoice.status`,
      ).first(),
    ).resolves.toEqual({ status: "finalized", total: 1, commitment_lines: 1 });
    await expect(
      env.BILLING_DB.prepare(
        `SELECT status, COUNT(*) AS total FROM plan_deletion_subscription_tasks
         WHERE plan_deletion_task_id =
           (SELECT id FROM plan_deletion_tasks WHERE plan_id = ?)
         GROUP BY status`,
      )
        .bind(planId)
        .first(),
    ).resolves.toEqual({ status: "completed", total: 2 });
    expect((await api("/api/v1/plans/async-retirement")).status).toBe(404);
    await expect(
      env.BILLING_DB.prepare(
        `INSERT INTO subscriptions
         (id, organization_id, customer_id, plan_id, external_id, status, version,
          created_at, updated_at)
         VALUES ('subscription-after-delete', 'org-plan-catalog', 'customer-async-plan', ?,
                 'subscription-after-delete', 'pending', 1, ?, ?)`,
      )
        .bind(planId, now, now)
        .run(),
    ).rejects.toThrow(/plan_not_subscribable/);
  });

  it("closes the plan snapshot before asynchronous deletion can race new catalog work", async () => {
    const created = await api("/api/v1/plans", "POST", {
      plan: {
        name: "Frozen deletion",
        code: "frozen-deletion",
        interval: "monthly",
        amount_cents: 400,
        amount_currency: "USD",
        charges: [
          {
            billable_metric_id: "metric-plan-catalog",
            code: "frozen-charge",
            charge_model: "standard",
            properties: { amount: "1" },
          },
        ],
      },
    });
    const planId = (await created.json<{ plan: { lago_id: string } }>()).plan.lago_id;
    const plan = await env.BILLING_DB.prepare("SELECT version FROM plans WHERE id = ? LIMIT 1")
      .bind(planId)
      .first<{ version: number }>();
    expect(plan).not.toBeNull();
    const now = new Date().toISOString();
    await preparePlanDeletion(
      { BILLING_DB: env.BILLING_DB },
      {
        id: planId,
        organizationId: "org-plan-catalog",
        code: "frozen-deletion",
        version: plan!.version,
        pendingDeletion: false,
      },
      "freeze-plan-request",
      now,
    );

    await expect(apiJson("/api/v1/plans/frozen-deletion")).resolves.toMatchObject({
      plan: { pending_deletion: true },
    });
    const planUpdate = await api("/api/v1/plans/frozen-deletion", "PUT", {
      plan: { name: "Too late" },
    });
    expect(planUpdate.status).toBe(409);
    await expect(planUpdate.json()).resolves.toMatchObject({
      code: "plan_deletion_in_progress",
    });
    const chargeUpdate = await api("/api/v1/plans/frozen-deletion/charges/frozen-charge", "PUT", {
      charge: { invoice_display_name: "Too late" },
    });
    expect(chargeUpdate.status).toBe(409);
    await expect(chargeUpdate.json()).resolves.toMatchObject({
      code: "plan_deletion_in_progress",
    });

    await env.BILLING_DB.prepare(
      `INSERT INTO customers
       (id, organization_id, external_id, currency, metadata_json, created_at, updated_at)
       VALUES ('customer-frozen-plan', 'org-plan-catalog', 'customer-frozen-plan', 'USD', '{}', ?, ?)`,
    )
      .bind(now, now)
      .run();
    await expect(
      env.BILLING_DB.prepare(
        `INSERT INTO subscriptions
         (id, organization_id, customer_id, plan_id, external_id, status, version,
          created_at, updated_at)
         VALUES ('subscription-frozen-plan', 'org-plan-catalog', 'customer-frozen-plan', ?,
                 'subscription-frozen-plan', 'pending', 1, ?, ?)`,
      )
        .bind(planId, now, now)
        .run(),
    ).rejects.toThrow(/plan_not_subscribable/);
    await expect(
      env.BILLING_DB.prepare(
        `UPDATE charges SET invoice_display_name = 'Too late'
         WHERE plan_id = ? AND code = 'frozen-charge'`,
      )
        .bind(planId)
        .run(),
    ).rejects.toThrow(/plan_deletion_in_progress/);
    await expect(
      env.BILLING_DB.prepare(
        `SELECT status, COUNT(*) AS total FROM plan_deletion_subscription_tasks
         WHERE plan_deletion_task_id =
           (SELECT id FROM plan_deletion_tasks WHERE plan_id = ?)
         GROUP BY status`,
      )
        .bind(planId)
        .first(),
    ).resolves.toBeNull();
  });

  it("retires an unused plan graph while preserving its relational catalog history", async () => {
    const addOn = await api("/api/v1/add_ons", "POST", {
      add_on: {
        name: "Plan lifecycle seats",
        code: "plan-lifecycle-seats",
        amount_cents: 100,
        amount_currency: "USD",
      },
    });
    expect(addOn.status).toBe(200);
    const addOnId = (await addOn.json<{ add_on: { lago_id: string } }>()).add_on.lago_id;
    const created = await api("/api/v1/plans", "POST", {
      plan: {
        name: "Retirable graph",
        code: "retirable-graph",
        interval: "monthly",
        amount_cents: 500,
        amount_currency: "USD",
        charges: [
          {
            billable_metric_id: "metric-plan-catalog",
            code: "retirable-usage",
            charge_model: "standard",
            properties: { amount: "2" },
          },
        ],
        fixed_charges: [
          {
            add_on_id: addOnId,
            code: "retirable-fixed",
            charge_model: "standard",
            units: "1",
            properties: { amount: "100" },
          },
        ],
        minimum_commitment: { amount_cents: 1000 },
      },
    });
    expect(created.status).toBe(200);
    const planId = (await created.json<{ plan: { lago_id: string } }>()).plan.lago_id;
    const deleted = await api("/api/v1/plans/retirable-graph", "DELETE");
    expect(deleted.status).toBe(200);
    await expect(deleted.json()).resolves.toMatchObject({
      plan: {
        lago_id: planId,
        charges: [{ code: "retirable-usage" }],
        fixed_charges: [{ code: "retirable-fixed" }],
        minimum_commitment: { amount_cents: 1000 },
      },
    });
    await expect(
      env.BILLING_DB.prepare(
        `SELECT plan.active AS plan_active, plan.version AS plan_version,
                charge.active AS charge_active, charge.version AS charge_version,
                fixed.active AS fixed_active, fixed.version AS fixed_version,
                commitment.amount_minor,
                (SELECT COUNT(*) FROM outbox_events
                 WHERE aggregate_type = 'plan' AND aggregate_id = plan.id
                   AND event_type = 'plan.deleted') AS delete_events
         FROM plans plan
         JOIN charges charge ON charge.plan_id = plan.id
         JOIN fixed_charges fixed ON fixed.plan_id = plan.id
         JOIN minimum_commitments commitment ON commitment.plan_id = plan.id
         WHERE plan.id = ?`,
      )
        .bind(planId)
        .first(),
    ).resolves.toEqual({
      amount_minor: 1000,
      charge_active: 0,
      charge_version: 2,
      delete_events: 1,
      fixed_active: 0,
      fixed_version: 2,
      plan_active: 0,
      plan_version: 2,
    });
  });

  it("creates and serializes a minimum commitment while rejecting commitment tax targeting", async () => {
    const payload = {
      plan: {
        name: "Committed",
        code: "committed",
        interval: "monthly",
        amount_cents: 100,
        amount_currency: "USD",
        minimum_commitment: {
          amount_cents: 1000,
          invoice_display_name: "Monthly minimum",
        },
      },
    };
    const created = await api("/api/v1/plans", "POST", payload);
    expect(created.status).toBe(200);
    await expect(created.json()).resolves.toMatchObject({
      plan: {
        code: "committed",
        minimum_commitment: {
          amount_cents: 1000,
          invoice_display_name: "Monthly minimum",
          interval: "monthly",
        },
      },
    });
    expect((await api("/api/v1/plans", "POST", payload)).status).toBe(200);

    const targeted = await api("/api/v1/plans", "POST", {
      plan: {
        ...payload.plan,
        code: "committed-tax",
        minimum_commitment: { amount_cents: 1000, tax_codes: ["tax"] },
      },
    });
    expect(targeted.status).toBe(422);
    await expect(targeted.json()).resolves.toMatchObject({ code: "unsupported_tax_target" });
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
