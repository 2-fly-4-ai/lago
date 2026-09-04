import { env, SELF } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sha256Hex } from "../src/auth/api-key";
import {
  calculateSubscriptionInvoice,
  findBillableSubscription,
} from "../src/billing/subscription-invoice-calculation";

const apiKey = "subscription-filter-test-key";
const headers = { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" };
const originalFilter = {
  lagoId: "filter-subscription-parent",
  invoiceDisplayName: "Parent Europe",
  properties: { amount: "2" },
  values: { region: ["eu"] },
};

beforeEach(async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-08-20T12:00:00.000Z"));
  const now = "2026-08-15T00:00:00.000Z";
  await env.BILLING_DB.batch([
    env.BILLING_DB.prepare("DELETE FROM tax_targets WHERE organization_id = 'org-sub-filter'"),
    env.BILLING_DB.prepare(
      "DELETE FROM minimum_commitments WHERE organization_id = 'org-sub-filter'",
    ),
    env.BILLING_DB.prepare(
      `UPDATE subscriptions SET plan_id = 'plan-sub-filter', version = 1, updated_at = ?
       WHERE id = 'subscription-sub-filter'`,
    ).bind(now),
    env.BILLING_DB.prepare(
      "DELETE FROM fixed_charge_unit_events WHERE organization_id = 'org-sub-filter'",
    ),
    env.BILLING_DB.prepare(
      "DELETE FROM fixed_charges WHERE organization_id = 'org-sub-filter' AND parent_id IS NOT NULL",
    ),
    env.BILLING_DB.prepare(
      `DELETE FROM fixed_charges WHERE organization_id = 'org-sub-filter' AND parent_id IS NULL
       AND id != 'fixed-sub-filter'`,
    ),
    env.BILLING_DB.prepare(
      "DELETE FROM charges WHERE organization_id = 'org-sub-filter' AND parent_id IS NOT NULL",
    ),
    env.BILLING_DB.prepare(
      `DELETE FROM charges WHERE organization_id = 'org-sub-filter' AND parent_id IS NULL
       AND id NOT IN ('charge-sub-filter', 'charge-sub-filter-two')`,
    ),
    env.BILLING_DB.prepare(
      "DELETE FROM plans WHERE organization_id = 'org-sub-filter' AND parent_id IS NOT NULL",
    ),
    env.BILLING_DB.prepare(
      `UPDATE plans SET amount_minor = 1000, version = 1, updated_at = ?
       WHERE id = 'plan-sub-filter'`,
    ).bind(now),
    env.BILLING_DB.prepare("DELETE FROM outbox_events WHERE organization_id = 'org-sub-filter'"),
    env.BILLING_DB.prepare(
      `UPDATE charges SET code = 'requests-charge', invoice_display_name = NULL,
                          charge_model = 'standard', properties_json = '{"amount":"1"}',
                          filters_json = ?, version = 1, active = 1, updated_at = ?
       WHERE id = 'charge-sub-filter'`,
    ).bind(JSON.stringify([originalFilter]), now),
    env.BILLING_DB.prepare(
      `UPDATE fixed_charges SET code = 'support-fixed', invoice_display_name = NULL,
                                charge_model = 'standard', properties_json = '{"amount":"500"}',
                                units = '1', version = 1, active = 1, updated_at = ?
       WHERE id = 'fixed-sub-filter'`,
    ).bind(now),
  ]);
  await env.BILLING_DB.batch([
    env.BILLING_DB.prepare(
      `INSERT OR IGNORE INTO organizations (id, external_id, name, created_at, updated_at)
       VALUES ('org-sub-filter', 'subscription-filter', 'Subscription Filter', ?, ?)`,
    ).bind(now, now),
    env.BILLING_DB.prepare(
      `INSERT OR IGNORE INTO api_keys
       (id, organization_id, key_prefix, key_hash, created_at, revoked_at)
       VALUES ('key-sub-filter', 'org-sub-filter', 'sub-filt', ?, ?, NULL)`,
    ).bind(await sha256Hex(apiKey), now),
    env.BILLING_DB.prepare(
      `INSERT OR IGNORE INTO customers
       (id, organization_id, external_id, email, name, currency, metadata_json, created_at, updated_at)
       VALUES ('customer-sub-filter', 'org-sub-filter', 'customer-sub-filter',
               'filter@example.test', 'Filter Customer', 'USD', '{}', ?, ?)`,
    ).bind(now, now),
    env.BILLING_DB.prepare(
      `INSERT OR IGNORE INTO plans
       (id, organization_id, code, name, interval, amount_minor, currency, version, active,
        created_at, updated_at)
       VALUES ('plan-sub-filter', 'org-sub-filter', 'filter-plan', 'Filter Plan', 'monthly',
               1000, 'USD', 1, 1, ?, ?)`,
    ).bind(now, now),
    env.BILLING_DB.prepare(
      `INSERT OR IGNORE INTO billable_metrics
       (id, organization_id, code, name, aggregation_type, field_name, recurring,
        properties_json, filters_json, version, active, created_at, updated_at)
       VALUES ('metric-sub-filter', 'org-sub-filter', 'requests', 'Requests', 'count_agg',
               NULL, 0, '{}', '[{"key":"region","values":["asia","eu","us"]}]', 1, 1, ?, ?)`,
    ).bind(now, now),
    env.BILLING_DB.prepare(
      `INSERT OR IGNORE INTO billable_metrics
       (id, organization_id, code, name, aggregation_type, field_name, recurring,
        properties_json, filters_json, version, active, created_at, updated_at)
       VALUES ('metric-sub-filter-two', 'org-sub-filter', 'storage', 'Storage', 'sum_agg',
               'gb', 0, '{}', '[]', 1, 1, ?, ?)`,
    ).bind(now, now),
    env.BILLING_DB.prepare(
      `INSERT OR IGNORE INTO charges
       (id, organization_id, plan_id, billable_metric_id, code, charge_model,
        properties_json, filters_json, version, active, created_at, updated_at)
       VALUES ('charge-sub-filter', 'org-sub-filter', 'plan-sub-filter', 'metric-sub-filter',
               'requests-charge', 'standard', '{"amount":"1"}', ?, 1, 1, ?, ?)`,
    ).bind(JSON.stringify([originalFilter]), now, now),
    env.BILLING_DB.prepare(
      `INSERT OR IGNORE INTO charges
       (id, organization_id, plan_id, billable_metric_id, code, charge_model,
        properties_json, filters_json, version, active, created_at, updated_at)
       VALUES ('charge-sub-filter-two', 'org-sub-filter', 'plan-sub-filter',
               'metric-sub-filter-two', 'storage-charge', 'standard', '{"amount":"3"}',
               '[]', 1, 1, ?, ?)`,
    ).bind(now, now),
    env.BILLING_DB.prepare(
      `INSERT OR IGNORE INTO add_ons
       (id, organization_id, code, name, amount_minor, currency, status, version,
        request_sha256, created_at, updated_at)
       VALUES ('addon-sub-filter', 'org-sub-filter', 'support', 'Support', 500, 'USD',
               'active', 1, 'setup', ?, ?)`,
    ).bind(now, now),
    env.BILLING_DB.prepare(
      `INSERT OR IGNORE INTO fixed_charges
       (id, organization_id, plan_id, add_on_id, code, charge_model, properties_json,
        units, version, active, created_at, updated_at)
       VALUES ('fixed-sub-filter', 'org-sub-filter', 'plan-sub-filter', 'addon-sub-filter',
               'support-fixed', 'standard', '{"amount":"500"}', '1', 1, 1, ?, ?)`,
    ).bind(now, now),
    env.BILLING_DB.prepare(
      `INSERT OR IGNORE INTO subscriptions
       (id, organization_id, customer_id, plan_id, external_id, status, started_at,
        current_period_start, current_period_end, version, created_at, updated_at)
       VALUES ('subscription-sub-filter', 'org-sub-filter', 'customer-sub-filter',
               'plan-sub-filter', 'subscription-sub-filter', 'active',
               '2026-08-01T00:00:00.000Z', '2026-08-01T00:00:00.000Z',
               '2026-09-01T00:00:00.000Z', 1, ?, ?)`,
    ).bind(now, now),
  ]);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("subscription charge-filter overrides", () => {
  it("clones the complete pricing graph once and keeps the catalog root isolated", async () => {
    const created = await api(
      "/api/v1/subscriptions/subscription-sub-filter/charges/requests-charge/filters",
      "POST",
      {
        filter: {
          invoice_display_name: "Subscriber US",
          properties: { amount: "7" },
          values: { region: ["us"] },
        },
      },
    );
    expect(created.status).toBe(200);
    const body = await created.json<{ filter: { lago_id: string } }>();
    expect(body.filter.lago_id).not.toBe(originalFilter.lagoId);

    const graph = await env.BILLING_DB.prepare(
      `SELECT s.plan_id, s.version AS subscription_version, child.parent_id,
              (SELECT COUNT(*) FROM charges WHERE plan_id = child.id AND active = 1) AS charges,
              (SELECT COUNT(*) FROM fixed_charges WHERE plan_id = child.id AND active = 1) AS fixed_charges,
              (SELECT COUNT(*) FROM minimum_commitments WHERE plan_id = child.id) AS commitments,
              (SELECT COUNT(*) FROM charges WHERE plan_id = child.id AND parent_id IS NOT NULL) AS parented_charges,
              (SELECT COUNT(*) FROM fixed_charges WHERE plan_id = child.id AND parent_id IS NOT NULL) AS parented_fixed
       FROM subscriptions s JOIN plans child ON child.id = s.plan_id
       WHERE s.id = 'subscription-sub-filter'`,
    ).first();
    expect(graph).toMatchObject({
      parent_id: "plan-sub-filter",
      subscription_version: 2,
      charges: 2,
      fixed_charges: 1,
      commitments: 0,
      parented_charges: 2,
      parented_fixed: 1,
    });

    const catalog = await api("/api/v1/plans");
    await expect(catalog.json()).resolves.toMatchObject({
      meta: { total_count: 1 },
      plans: [{ lago_id: "plan-sub-filter", code: "filter-plan" }],
    });
    const listed = await api(
      "/api/v1/subscriptions/subscription-sub-filter/charges/requests-charge/filters",
    );
    const listedBody = await listed.json<{
      filters: Array<{ lago_id: string; values: Record<string, string[]> }>;
    }>();
    expect(listedBody.filters).toHaveLength(2);
    expect(listedBody.filters.map((filter) => filter.lago_id)).not.toContain(originalFilter.lagoId);
    expect(listedBody.filters).toContainEqual(
      expect.objectContaining({ lago_id: body.filter.lago_id, values: { region: ["us"] } }),
    );

    await env.BILLING_DB.prepare(
      `UPDATE charges SET properties_json = '{"amount":"99"}', filters_json = '[]'
       WHERE id = 'charge-sub-filter'`,
    ).run();
    const childCharge = await env.BILLING_DB.prepare(
      `SELECT properties_json, filters_json FROM charges
       WHERE parent_id = 'charge-sub-filter' AND active = 1`,
    ).first<{ properties_json: string; filters_json: string }>();
    expect(childCharge?.properties_json).toBe('{"amount":"1"}');
    expect(JSON.parse(childCharge?.filters_json ?? "[]")).toHaveLength(2);

    const event = await api("/api/v1/events", "POST", {
      event: {
        transaction_id: "subscription-filter-base-event",
        code: "requests",
        external_subscription_id: "subscription-sub-filter",
        timestamp: 1786579200,
        properties: {},
      },
    });
    expect(event.status).toBe(200);
    const usage = await api(
      "/api/v1/customers/customer-sub-filter/current_usage?external_subscription_id=subscription-sub-filter",
    );
    const usageBody = await usage.json<{
      customer_usage: {
        amount_cents: number;
        charges_usage: Array<{
          amount_cents: number;
          units: string;
          billable_metric: { code: string };
        }>;
      };
    }>();
    expect(usageBody.customer_usage.amount_cents).toBe(1);
    expect(
      usageBody.customer_usage.charges_usage.find(
        (charge) => charge.billable_metric.code === "requests",
      ),
    ).toMatchObject({ amount_cents: 1, units: "1" });

    const deletion = await api("/api/v1/plans/filter-plan", "DELETE");
    expect(deletion.status).toBe(409);
    await expect(deletion.json()).resolves.toMatchObject({
      code: "plan_has_overridden_subscriptions",
    });

    const updated = await api(
      `/api/v1/subscriptions/subscription-sub-filter/charges/requests-charge/filters/${body.filter.lago_id}`,
      "PUT",
      { filter: { invoice_display_name: "Subscriber US updated", properties: { amount: "8" } } },
    );
    expect(updated.status).toBe(200);
    await expect(updated.json()).resolves.toMatchObject({
      filter: {
        lago_id: body.filter.lago_id,
        invoice_display_name: "Subscriber US updated",
        properties: { amount: "8" },
        values: { region: ["us"] },
      },
    });
    const counts = await env.BILLING_DB.prepare(
      `SELECT (SELECT COUNT(*) FROM plans WHERE organization_id = 'org-sub-filter') AS plans,
              (SELECT COUNT(*) FROM charges WHERE organization_id = 'org-sub-filter') AS charges,
              (SELECT version FROM charges WHERE parent_id = 'charge-sub-filter') AS child_version`,
    ).first();
    expect(counts).toEqual({ plans: 2, charges: 4, child_version: 2 });
  });

  it("preserves minimum commitments and targeted taxes when cloning an override graph", async () => {
    const now = "2026-08-15T00:00:00.000Z";
    await env.BILLING_DB.batch([
      env.BILLING_DB.prepare(
        `INSERT OR IGNORE INTO taxes
         (id, organization_id, code, name, description, rate, applied_to_organization,
          status, version, request_sha256, created_at, updated_at)
         VALUES ('tax-sub-filter-clone', 'org-sub-filter', 'clone-vat', 'Clone VAT', NULL,
                 '10', 0, 'active', 1, 'clone-vat-hash', ?, ?)`,
      ).bind(now, now),
      env.BILLING_DB.prepare(
        `INSERT INTO minimum_commitments
         (id, organization_id, plan_id, amount_minor, invoice_display_name, created_at, updated_at)
         VALUES ('commitment-sub-filter', 'org-sub-filter', 'plan-sub-filter', 2000,
                 'Monthly minimum', ?, ?)`,
      ).bind(now, now),
      ...[
        "plan:plan-sub-filter",
        "charge:charge-sub-filter",
        "fixed_charge:fixed-sub-filter",
        "commitment:commitment-sub-filter",
      ].map((target) => {
        const [targetType, targetId] = target.split(":");
        return env.BILLING_DB.prepare(
          `INSERT INTO tax_targets
             (organization_id, tax_id, target_type, target_id, created_at)
             VALUES ('org-sub-filter', 'tax-sub-filter-clone', ?, ?, ?)`,
        ).bind(targetType, targetId, now);
      }),
    ]);

    const response = await api(
      "/api/v1/subscriptions/subscription-sub-filter/charges/requests-charge/filters",
      "POST",
      {
        filter: {
          invoice_display_name: "Subscriber US",
          properties: { amount: "7" },
          values: { region: ["us"] },
        },
      },
    );
    expect(response.status, await response.clone().text()).toBe(200);

    const graph = await env.BILLING_DB.prepare(
      `SELECT child.id AS plan_id, commitment.id AS commitment_id,
              (SELECT COUNT(*) FROM tax_targets target
               WHERE target.organization_id = 'org-sub-filter' AND (
                 (target.target_type = 'plan' AND target.target_id = child.id)
                 OR (target.target_type = 'charge' AND target.target_id IN (
                   SELECT id FROM charges WHERE plan_id = child.id
                 ))
                 OR (target.target_type = 'fixed_charge' AND target.target_id IN (
                   SELECT id FROM fixed_charges WHERE plan_id = child.id
                 ))
                 OR (target.target_type = 'commitment' AND target.target_id = commitment.id)
               )) AS targeted_rows
       FROM subscriptions subscription JOIN plans child ON child.id = subscription.plan_id
       JOIN minimum_commitments commitment ON commitment.plan_id = child.id
       WHERE subscription.id = 'subscription-sub-filter'`,
    ).first<{ plan_id: string; commitment_id: string; targeted_rows: number }>();
    expect(graph).toMatchObject({ targeted_rows: 4 });

    const subscription = await findBillableSubscription(env.BILLING_DB, "subscription-sub-filter");
    expect(subscription).not.toBeNull();
    const calculation = await calculateSubscriptionInvoice(
      env.BILLING_DB,
      subscription!,
      "subscription-filter-clone-invoice",
      "subscription-filter-clone-cycle",
      "2026-08-01T00:00:00.000Z",
      "2026-09-01T00:00:00.000Z",
    );
    expect(calculation.lines.find((line) => line.lineType === "commitment")).toBeDefined();
    expect(calculation.subtotalMinor).toBe(2000);
    expect(calculation.invoiceTaxes).toEqual([
      expect.objectContaining({ code: "clone-vat", amountMinor: 200 }),
    ]);
  });

  it("maps parent filter IDs onto fresh child IDs for update and delete", async () => {
    const updated = await api(
      `/api/v1/subscriptions/subscription-sub-filter/charges/requests-charge/filters/${originalFilter.lagoId}`,
      "PUT",
      { filter: { invoice_display_name: "Subscriber Europe", properties: { amount: "5" } } },
    );
    expect(updated.status).toBe(200);
    const updatedBody = await updated.json<{ filter: { lago_id: string } }>();
    expect(updatedBody.filter.lago_id).not.toBe(originalFilter.lagoId);
    await expect(updatedBody).toMatchObject({
      filter: {
        invoice_display_name: "Subscriber Europe",
        properties: { amount: "5" },
        values: { region: ["eu"] },
      },
    });

    const deleted = await api(
      `/api/v1/subscriptions/subscription-sub-filter/charges/requests-charge/filters/${updatedBody.filter.lago_id}`,
      "DELETE",
    );
    expect(deleted.status).toBe(200);
    await expect(deleted.json()).resolves.toMatchObject({
      filter: { lago_id: updatedBody.filter.lago_id, values: { region: ["eu"] } },
    });
    await expect(
      api("/api/v1/subscriptions/subscription-sub-filter/charges/requests-charge/filters").then(
        (response) => response.json(),
      ),
    ).resolves.toMatchObject({ filters: [], meta: { total_count: 0 } });
  });

  it("rejects duplicate values without creating an override graph", async () => {
    const response = await api(
      "/api/v1/subscriptions/subscription-sub-filter/charges/requests-charge/filters",
      "POST",
      { filter: { properties: { amount: "4" }, values: { region: ["eu"] } } },
    );
    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toMatchObject({ code: "value_already_exist" });
    const counts = await env.BILLING_DB.prepare(
      `SELECT (SELECT COUNT(*) FROM plans WHERE organization_id = 'org-sub-filter') AS plans,
              (SELECT COUNT(*) FROM charges WHERE organization_id = 'org-sub-filter') AS charges`,
    ).first();
    expect(counts).toEqual({ plans: 1, charges: 2 });
  });

  it("cascades plan amounts only while child pricing remains inherited", async () => {
    const override = await api(
      "/api/v1/subscriptions/subscription-sub-filter/charges/requests-charge/filters",
      "POST",
      { filter: { properties: { amount: "7" }, values: { region: ["us"] } } },
    );
    expect(override.status).toBe(200);

    const inherited = await api("/api/v1/plans/filter-plan", "PUT", {
      plan: { amount_cents: 1200, cascade_updates: true },
    });
    expect(inherited.status, await inherited.clone().text()).toBe(200);
    await expect(
      env.BILLING_DB.prepare(
        "SELECT amount_minor FROM plans WHERE parent_id = 'plan-sub-filter'",
      ).first(),
    ).resolves.toEqual({ amount_minor: 1200 });

    await env.BILLING_DB.prepare(
      "UPDATE plans SET amount_minor = 1500 WHERE parent_id = 'plan-sub-filter'",
    ).run();
    const preserved = await api("/api/v1/plans/filter-plan", "PUT", {
      plan: { amount_cents: 1300, cascade_updates: true },
    });
    expect(preserved.status).toBe(200);
    const isolated = await api("/api/v1/plans/filter-plan", "PUT", {
      plan: { amount_cents: 1400, cascade_updates: false },
    });
    expect(isolated.status).toBe(200);
    await expect(
      env.BILLING_DB.prepare(
        `SELECT parent.amount_minor AS parent_amount, parent.version AS parent_version,
                child.amount_minor AS child_amount, child.version AS child_version
         FROM plans parent JOIN plans child ON child.parent_id = parent.id
         WHERE parent.id = 'plan-sub-filter'`,
      ).first(),
    ).resolves.toEqual({
      parent_amount: 1400,
      parent_version: 4,
      child_amount: 1500,
      child_version: 3,
    });
    await expect(env.BILLING_DB.prepare("PRAGMA foreign_key_check").all()).resolves.toMatchObject({
      results: [],
    });
  });

  it("cascades inherited charge pricing and filters without overwriting child customizations", async () => {
    const asia = await api("/api/v1/plans/filter-plan/charges/requests-charge/filters", "POST", {
      filter: {
        invoice_display_name: "Parent Asia",
        properties: { amount: "3" },
        values: { region: ["asia"] },
      },
    });
    expect(asia.status).toBe(200);

    const override = await api(
      "/api/v1/subscriptions/subscription-sub-filter/charges/requests-charge/filters",
      "POST",
      { filter: { properties: { amount: "7" }, values: { region: ["us"] } } },
    );
    expect(override.status).toBe(200);

    const childEurope = (await subscriptionFilters()).find(
      (filter) => filter.values.region?.[0] === "eu",
    );
    const customized = await api(
      `/api/v1/subscriptions/subscription-sub-filter/charges/requests-charge/filters/${childEurope?.lago_id}`,
      "PUT",
      { filter: { properties: { amount: "99" } } },
    );
    expect(customized.status).toBe(200);

    const cascaded = await api("/api/v1/plans/filter-plan/charges/requests-charge", "PUT", {
      charge: {
        code: "requests-renamed",
        invoice_display_name: "Parent display only",
        charge_model: "standard",
        properties: { amount: "5" },
        filters: [
          {
            invoice_display_name: "Europe cascaded",
            properties: { amount: "6" },
            values: { region: ["eu"] },
          },
          {
            invoice_display_name: "Asia cascaded",
            properties: { amount: "8" },
            values: { region: ["asia"] },
          },
        ],
        cascade_updates: true,
      },
    });
    expect(cascaded.status).toBe(200);
    const child = await env.BILLING_DB.prepare(
      `SELECT ch.code, ch.invoice_display_name, ch.properties_json, ch.filters_json
       FROM charges ch JOIN plans child_plan ON child_plan.id = ch.plan_id
       WHERE child_plan.parent_id = 'plan-sub-filter' AND ch.parent_id = 'charge-sub-filter'`,
    ).first<{
      code: string;
      invoice_display_name: string | null;
      properties_json: string;
      filters_json: string;
    }>();
    expect(child).toMatchObject({
      code: "requests-renamed",
      invoice_display_name: null,
      properties_json: '{"amount":"5"}',
    });
    const filters = JSON.parse(child?.filters_json ?? "[]") as Array<{
      invoiceDisplayName: string | null;
      properties: Record<string, unknown>;
      values: Record<string, string[]>;
    }>;
    expect(filters).toEqual([
      expect.objectContaining({
        invoiceDisplayName: "Parent Europe",
        properties: { amount: "99" },
        values: { region: ["eu"] },
      }),
      expect.objectContaining({
        invoiceDisplayName: "Asia cascaded",
        properties: { amount: "8" },
        values: { region: ["asia"] },
      }),
      expect.objectContaining({ properties: { amount: "7" }, values: { region: ["us"] } }),
    ]);

    await env.BILLING_DB.prepare(
      `UPDATE charges SET properties_json = '{"amount":"99"}'
       WHERE parent_id = 'charge-sub-filter'`,
    ).run();
    const preserved = await api("/api/v1/plans/filter-plan/charges/requests-renamed", "PUT", {
      charge: {
        charge_model: "standard",
        properties: { amount: "8" },
        cascade_updates: true,
      },
    });
    expect(preserved.status).toBe(200);
    await expect(
      env.BILLING_DB.prepare(
        "SELECT properties_json FROM charges WHERE parent_id = 'charge-sub-filter'",
      ).first(),
    ).resolves.toEqual({ properties_json: '{"amount":"99"}' });
  });

  it("cascades a new catalog charge into every eligible child plan", async () => {
    const override = await api(
      "/api/v1/subscriptions/subscription-sub-filter/charges/requests-charge/filters",
      "POST",
      { filter: { properties: { amount: "7" }, values: { region: ["us"] } } },
    );
    expect(override.status).toBe(200);

    const created = await api("/api/v1/plans/filter-plan/charges", "POST", {
      charge: {
        billable_metric_id: "metric-sub-filter-two",
        code: "new-storage-charge",
        invoice_display_name: "New storage",
        charge_model: "standard",
        properties: { amount: "10" },
        min_amount_cents: 25,
        cascade_updates: true,
      },
    });
    expect(created.status).toBe(200);
    const createdBody = await created.json<{ charge: { lago_id: string } }>();
    const rows = await env.BILLING_DB.prepare(
      `SELECT id, parent_id, plan_id, invoice_display_name, properties_json, min_amount_minor,
              version, active
       FROM charges WHERE code = 'new-storage-charge' ORDER BY parent_id IS NOT NULL`,
    ).all<{
      id: string;
      parent_id: string | null;
      plan_id: string;
      invoice_display_name: string | null;
      properties_json: string;
      min_amount_minor: number;
      version: number;
      active: number;
    }>();
    expect(rows.results).toHaveLength(2);
    expect(rows.results[0]).toMatchObject({
      id: createdBody.charge.lago_id,
      parent_id: null,
      plan_id: "plan-sub-filter",
    });
    expect(rows.results[1]).toMatchObject({
      parent_id: createdBody.charge.lago_id,
      invoice_display_name: "New storage",
      properties_json: '{"amount":"10"}',
      min_amount_minor: 25,
      version: 1,
      active: 1,
    });
    expect(rows.results[1]?.id).not.toBe(createdBody.charge.lago_id);

    const deleted = await api("/api/v1/plans/filter-plan/charges/new-storage-charge", "DELETE", {
      charge: { cascade_updates: true },
    });
    expect(deleted.status).toBe(200);
    const retired = await env.BILLING_DB.prepare(
      `SELECT active, version FROM charges WHERE code = 'new-storage-charge'
       ORDER BY parent_id IS NOT NULL`,
    ).all<{ active: number; version: number }>();
    expect(retired.results).toEqual([
      { active: 0, version: 2 },
      { active: 0, version: 2 },
    ]);
  });

  it("cascades inherited fixed-charge pricing without overwriting child customizations", async () => {
    const override = await api(
      "/api/v1/subscriptions/subscription-sub-filter/charges/requests-charge/filters",
      "POST",
      { filter: { properties: { amount: "7" }, values: { region: ["us"] } } },
    );
    expect(override.status).toBe(200);

    const cascaded = await api("/api/v1/plans/filter-plan/fixed_charges/support-fixed", "PUT", {
      fixed_charge: {
        code: "support-renamed",
        invoice_display_name: "Parent display only",
        charge_model: "standard",
        properties: { amount: "600" },
        units: "2",
        cascade_updates: true,
      },
    });
    expect(cascaded.status).toBe(200);
    await expect(
      env.BILLING_DB.prepare(
        `SELECT code, invoice_display_name, properties_json, units
         FROM fixed_charges WHERE parent_id = 'fixed-sub-filter'`,
      ).first(),
    ).resolves.toEqual({
      code: "support-renamed",
      invoice_display_name: null,
      properties_json: '{"amount":"600"}',
      units: "2",
    });
    const subscription = await findBillableSubscription(env.BILLING_DB, "subscription-sub-filter");
    expect(subscription).not.toBeNull();
    const current = await calculateSubscriptionInvoice(
      env.BILLING_DB,
      subscription!,
      "fixed-cascade-current",
      "fixed-cascade-current-cycle",
      "2026-08-01T00:00:00.000Z",
      "2026-09-01T00:00:00.000Z",
    );
    const next = await calculateSubscriptionInvoice(
      env.BILLING_DB,
      subscription!,
      "fixed-cascade-next",
      "fixed-cascade-next-cycle",
      "2026-09-01T00:00:00.000Z",
      "2026-10-01T00:00:00.000Z",
    );
    expect(current.lines.find((line) => line.lineType === "fixed_charge")).toMatchObject({
      units: "1",
      rounded: 600,
    });
    expect(next.lines.find((line) => line.lineType === "fixed_charge")).toMatchObject({
      units: "2",
      rounded: 1200,
    });

    await env.BILLING_DB.prepare(
      `UPDATE fixed_charges SET properties_json = '{"amount":"999"}', units = '9'
       WHERE parent_id = 'fixed-sub-filter'`,
    ).run();
    const preserved = await api("/api/v1/plans/filter-plan/fixed_charges/support-renamed", "PUT", {
      fixed_charge: {
        code: "support-final",
        charge_model: "standard",
        properties: { amount: "700" },
        units: "3",
        cascade_updates: true,
      },
    });
    expect(preserved.status).toBe(200);
    await expect(
      env.BILLING_DB.prepare(
        `SELECT code, properties_json, units FROM fixed_charges
         WHERE parent_id = 'fixed-sub-filter'`,
      ).first(),
    ).resolves.toEqual({
      code: "support-final",
      properties_json: '{"amount":"999"}',
      units: "9",
    });

    await env.BILLING_DB.prepare(
      "UPDATE fixed_charges SET charge_model = 'volume' WHERE parent_id = 'fixed-sub-filter'",
    ).run();
    const modelMismatch = await api(
      "/api/v1/plans/filter-plan/fixed_charges/support-final",
      "PUT",
      {
        fixed_charge: {
          code: "support-parent-model",
          charge_model: "standard",
          cascade_updates: true,
        },
      },
    );
    expect(modelMismatch.status).toBe(200);
    await expect(
      env.BILLING_DB.prepare(
        "SELECT code, charge_model FROM fixed_charges WHERE parent_id = 'fixed-sub-filter'",
      ).first(),
    ).resolves.toEqual({ code: "support-final", charge_model: "volume" });
  });

  it("creates and retires cascaded fixed charges with independent child identity", async () => {
    const override = await api(
      "/api/v1/subscriptions/subscription-sub-filter/charges/requests-charge/filters",
      "POST",
      { filter: { properties: { amount: "7" }, values: { region: ["us"] } } },
    );
    expect(override.status).toBe(200);

    const created = await api("/api/v1/plans/filter-plan/fixed_charges", "POST", {
      fixed_charge: {
        add_on_id: "addon-sub-filter",
        code: "priority-support",
        invoice_display_name: "Priority support",
        charge_model: "standard",
        properties: { amount: "800" },
        units: "4",
        prorated: true,
        cascade_updates: true,
      },
    });
    expect(created.status).toBe(200);
    const createdBody = await created.json<{ fixed_charge: { lago_id: string } }>();
    const rows = await env.BILLING_DB.prepare(
      `SELECT id, parent_id, plan_id, invoice_display_name, properties_json, units, prorated,
              version, active
       FROM fixed_charges WHERE code = 'priority-support' ORDER BY parent_id IS NOT NULL`,
    ).all<{
      id: string;
      parent_id: string | null;
      plan_id: string;
      invoice_display_name: string | null;
      properties_json: string;
      units: string;
      prorated: number;
      version: number;
      active: number;
    }>();
    expect(rows.results).toHaveLength(2);
    expect(rows.results[0]).toMatchObject({
      id: createdBody.fixed_charge.lago_id,
      parent_id: null,
      plan_id: "plan-sub-filter",
    });
    expect(rows.results[1]).toMatchObject({
      parent_id: createdBody.fixed_charge.lago_id,
      invoice_display_name: "Priority support",
      properties_json: '{"amount":"800"}',
      units: "4",
      prorated: 1,
      version: 1,
      active: 1,
    });
    expect(rows.results[1]?.id).not.toBe(createdBody.fixed_charge.lago_id);
    const subscription = await findBillableSubscription(env.BILLING_DB, "subscription-sub-filter");
    expect(subscription).not.toBeNull();
    const current = await calculateSubscriptionInvoice(
      env.BILLING_DB,
      subscription!,
      "fixed-create-cascade-current",
      "fixed-create-cascade-current-cycle",
      "2026-08-01T00:00:00.000Z",
      "2026-09-01T00:00:00.000Z",
    );
    const next = await calculateSubscriptionInvoice(
      env.BILLING_DB,
      subscription!,
      "fixed-create-cascade-next",
      "fixed-create-cascade-next-cycle",
      "2026-09-01T00:00:00.000Z",
      "2026-10-01T00:00:00.000Z",
    );
    expect(current.lines.find((line) => line.sourceId === rows.results[1]?.id)).toMatchObject({
      units: "0",
      rounded: 0,
    });
    expect(next.lines.find((line) => line.sourceId === rows.results[1]?.id)).toMatchObject({
      units: "4",
      rounded: 3200,
    });

    const deleted = await api(
      "/api/v1/plans/filter-plan/fixed_charges/priority-support",
      "DELETE",
      { fixed_charge: { cascade_updates: true } },
    );
    expect(deleted.status).toBe(200);
    const retired = await env.BILLING_DB.prepare(
      `SELECT active, version FROM fixed_charges WHERE code = 'priority-support'
       ORDER BY parent_id IS NOT NULL`,
    ).all<{ active: number; version: number }>();
    expect(retired.results).toEqual([
      { active: 0, version: 2 },
      { active: 0, version: 2 },
    ]);
  });

  it("cascades catalog filter changes while preserving subscriber-customized pricing", async () => {
    const override = await api(
      "/api/v1/subscriptions/subscription-sub-filter/charges/requests-charge/filters",
      "POST",
      { filter: { properties: { amount: "7" }, values: { region: ["us"] } } },
    );
    expect(override.status).toBe(200);

    const parentOnly = await api(
      `/api/v1/plans/filter-plan/charges/requests-charge/filters/${originalFilter.lagoId}`,
      "PUT",
      { filter: { invoice_display_name: "Parent no cascade" } },
    );
    expect(parentOnly.status).toBe(200);
    let childFilters = await subscriptionFilters();
    expect(childFilters.find((filter) => filter.values.region?.[0] === "eu")).toMatchObject({
      invoice_display_name: "Parent Europe",
      properties: { amount: "2" },
    });

    const firstCascade = await api(
      `/api/v1/plans/filter-plan/charges/requests-charge/filters/${originalFilter.lagoId}`,
      "PUT",
      { filter: { properties: { amount: "5" }, cascade_updates: true } },
    );
    expect(firstCascade.status).toBe(200);
    childFilters = await subscriptionFilters();
    const childEurope = childFilters.find((filter) => filter.values.region?.[0] === "eu");
    expect(childEurope).toMatchObject({
      invoice_display_name: "Parent no cascade",
      properties: { amount: "5" },
    });

    const customized = await api(
      `/api/v1/subscriptions/subscription-sub-filter/charges/requests-charge/filters/${childEurope?.lago_id}`,
      "PUT",
      { filter: { properties: { amount: "99" } } },
    );
    expect(customized.status).toBe(200);
    const secondCascade = await api(
      `/api/v1/plans/filter-plan/charges/requests-charge/filters/${originalFilter.lagoId}`,
      "PUT",
      { filter: { properties: { amount: "6" }, cascade_updates: true } },
    );
    expect(secondCascade.status).toBe(200);
    childFilters = await subscriptionFilters();
    expect(childFilters.find((filter) => filter.lago_id === childEurope?.lago_id)).toMatchObject({
      properties: { amount: "99" },
    });

    const created = await api("/api/v1/plans/filter-plan/charges/requests-charge/filters", "POST", {
      filter: {
        invoice_display_name: "Asia",
        properties: { amount: "8" },
        values: { region: ["asia"] },
        cascade_updates: true,
      },
    });
    expect(created.status).toBe(200);
    const createdBody = await created.json<{ filter: { lago_id: string } }>();
    childFilters = await subscriptionFilters();
    const childAsia = childFilters.find((filter) => filter.values.region?.[0] === "asia");
    expect(childAsia).toMatchObject({
      invoice_display_name: "Asia",
      properties: { amount: "8" },
    });
    expect(childAsia?.lago_id).not.toBe(createdBody.filter.lago_id);

    const oversizedDelete = await SELF.fetch(
      `https://lago.test/api/v1/plans/filter-plan/charges/requests-charge/filters/${createdBody.filter.lago_id}`,
      { method: "DELETE", headers, body: "x".repeat(16 * 1024 + 1) },
    );
    expect(oversizedDelete.status).toBe(413);
    await expect(oversizedDelete.json()).resolves.toMatchObject({ code: "payload_too_large" });

    const deleted = await api(
      `/api/v1/plans/filter-plan/charges/requests-charge/filters/${createdBody.filter.lago_id}`,
      "DELETE",
      { filter: { cascade_updates: true } },
    );
    expect(deleted.status).toBe(200);
    childFilters = await subscriptionFilters();
    expect(childFilters.some((filter) => filter.values.region?.[0] === "asia")).toBe(false);
  });

  it("lists, shows, creates, and updates a subscription fixed-charge override", async () => {
    const initialList = await api(
      "/api/v1/subscriptions/subscription-sub-filter/fixed_charges?per_page=1",
    );
    expect(initialList.status).toBe(200);
    await expect(initialList.json()).resolves.toMatchObject({
      fixed_charges: [
        {
          lago_id: "fixed-sub-filter",
          lago_parent_id: null,
          lago_add_on_id: "addon-sub-filter",
          add_on_code: "support",
          code: "support-fixed",
          properties: { amount: "500" },
          units: "1",
          taxes: [],
        },
      ],
      meta: { current_page: 1, total_count: 1, total_pages: 1 },
    });
    const initialShow = await api(
      "/api/v1/subscriptions/subscription-sub-filter/fixed_charges/support-fixed",
    );
    expect(initialShow.status).toBe(200);
    await expect(initialShow.json()).resolves.toMatchObject({
      fixed_charge: { lago_id: "fixed-sub-filter", lago_parent_id: null },
    });

    expect(
      (
        await api("/api/v1/taxes", "POST", {
          tax: {
            code: "vat",
            name: "VAT",
            rate: 10,
            applied_to_organization: false,
          },
        })
      ).status,
    ).toBe(200);

    const created = await api(
      "/api/v1/subscriptions/subscription-sub-filter/fixed_charges/support-fixed",
      "PUT",
      {
        fixed_charge: {
          invoice_display_name: "Subscriber support",
          charge_model: "standard",
          properties: { amount: "750" },
          units: "2",
          apply_units_immediately: false,
          tax_codes: ["vat"],
        },
      },
    );
    expect(created.status, await created.clone().text()).toBe(200);
    const createdBody = await created.json<{
      fixed_charge: { lago_id: string; lago_parent_id: string | null };
    }>();
    expect(createdBody.fixed_charge.lago_id).not.toBe("fixed-sub-filter");
    expect(createdBody.fixed_charge).toMatchObject({
      lago_parent_id: "fixed-sub-filter",
      invoice_display_name: "Subscriber support",
      charge_model: "standard",
      properties: { amount: "750" },
      units: "2",
      taxes: [{ code: "vat", rate: 10 }],
    });
    const overriddenSubscription = await findBillableSubscription(
      env.BILLING_DB,
      "subscription-sub-filter",
    );
    expect(overriddenSubscription).not.toBeNull();
    const currentCalculation = await calculateSubscriptionInvoice(
      env.BILLING_DB,
      overriddenSubscription!,
      "subscription-fixed-current",
      "subscription-fixed-current-cycle",
      "2026-08-01T00:00:00.000Z",
      "2026-09-01T00:00:00.000Z",
    );
    expect(currentCalculation.lines.find((line) => line.lineType === "fixed_charge")).toMatchObject(
      { units: "1", rounded: 750 },
    );

    const graph = await env.BILLING_DB.prepare(
      `SELECT s.version AS subscription_version, p.parent_id,
              (SELECT COUNT(*) FROM plans WHERE organization_id = 'org-sub-filter') AS plans,
              (SELECT COUNT(*) FROM charges WHERE organization_id = 'org-sub-filter') AS charges,
              (SELECT COUNT(*) FROM fixed_charges WHERE organization_id = 'org-sub-filter') AS fixed_charges,
              (SELECT filters_json FROM charges WHERE plan_id = s.plan_id
                AND parent_id = 'charge-sub-filter') AS filters_json
       FROM subscriptions s JOIN plans p ON p.id = s.plan_id
       WHERE s.id = 'subscription-sub-filter'`,
    ).first<{
      subscription_version: number;
      parent_id: string | null;
      plans: number;
      charges: number;
      fixed_charges: number;
      filters_json: string;
    }>();
    expect(graph).toMatchObject({
      subscription_version: 2,
      parent_id: "plan-sub-filter",
      plans: 2,
      charges: 4,
      fixed_charges: 2,
    });
    expect(JSON.parse(graph?.filters_json ?? "[]")).toEqual([
      expect.objectContaining({ values: { region: ["eu"] } }),
    ]);

    const updated = await api(
      "/api/v1/subscriptions/subscription-sub-filter/fixed_charges/support-fixed",
      "PUT",
      { fixed_charge: { properties: { amount: "900" }, units: 3 } },
    );
    expect(updated.status, await updated.clone().text()).toBe(200);
    await expect(updated.json()).resolves.toMatchObject({
      fixed_charge: {
        lago_id: createdBody.fixed_charge.lago_id,
        lago_parent_id: "fixed-sub-filter",
        invoice_display_name: "Subscriber support",
        properties: { amount: "900" },
        units: "3",
        taxes: [{ code: "vat", rate: 10 }],
      },
    });
    const currentAfterSecondUpdate = await calculateSubscriptionInvoice(
      env.BILLING_DB,
      overriddenSubscription!,
      "subscription-fixed-current-second",
      "subscription-fixed-current-second-cycle",
      "2026-08-01T00:00:00.000Z",
      "2026-09-01T00:00:00.000Z",
    );
    expect(
      currentAfterSecondUpdate.lines.find((line) => line.lineType === "fixed_charge"),
    ).toMatchObject({ units: "1", rounded: 900 });
    const nextCalculation = await calculateSubscriptionInvoice(
      env.BILLING_DB,
      overriddenSubscription!,
      "subscription-fixed-next",
      "subscription-fixed-next-cycle",
      "2026-09-01T00:00:00.000Z",
      "2026-10-01T00:00:00.000Z",
    );
    expect(nextCalculation.lines.find((line) => line.lineType === "fixed_charge")).toMatchObject({
      units: "3",
      rounded: 2700,
    });
    await expect(
      env.BILLING_DB.prepare(
        `SELECT invoice_display_name, properties_json, units, version
         FROM fixed_charges WHERE id = 'fixed-sub-filter'`,
      ).first(),
    ).resolves.toEqual({
      invoice_display_name: null,
      properties_json: '{"amount":"500"}',
      units: "1",
      version: 1,
    });
    await expect(
      env.BILLING_DB.prepare(
        `SELECT COUNT(*) AS total FROM outbox_events
         WHERE organization_id = 'org-sub-filter' AND event_type = 'fixed_charge.updated'`,
      ).first(),
    ).resolves.toEqual({ total: 2 });
    await expect(
      env.BILLING_DB.prepare(
        `SELECT fixed_charge_version, units, effective_at
         FROM fixed_charge_unit_events
         WHERE subscription_id = 'subscription-sub-filter'
         ORDER BY fixed_charge_version`,
      ).all(),
    ).resolves.toMatchObject({
      results: [
        { fixed_charge_version: 0, units: "1", effective_at: "2026-08-01T00:00:00.000Z" },
        { fixed_charge_version: 1, units: "2", effective_at: "2026-09-01T00:00:00.000Z" },
        { fixed_charge_version: 2, units: "3", effective_at: "2026-09-01T00:00:00.000Z" },
      ],
    });
  });

  it("rejects invalid or immutable subscription fixed-charge fields before cloning the plan", async () => {
    const malformedImmediate = await api(
      "/api/v1/subscriptions/subscription-sub-filter/fixed_charges/support-fixed",
      "PUT",
      { fixed_charge: { units: "2", apply_units_immediately: "yes" } },
    );
    expect(malformedImmediate.status).toBe(422);
    await expect(malformedImmediate.json()).resolves.toMatchObject({ code: "validation_error" });
    const identity = await api(
      "/api/v1/subscriptions/subscription-sub-filter/fixed_charges/support-fixed",
      "PUT",
      { fixed_charge: { code: "renamed" } },
    );
    expect(identity.status).toBe(422);
    await expect(identity.json()).resolves.toMatchObject({
      code: "unsupported_fixed_charge_feature",
    });
    await expect(
      env.BILLING_DB.prepare(
        `SELECT (SELECT COUNT(*) FROM plans WHERE organization_id = 'org-sub-filter') AS plans,
                (SELECT COUNT(*) FROM fixed_charges WHERE organization_id = 'org-sub-filter') AS fixed_charges`,
      ).first(),
    ).resolves.toEqual({ plans: 1, fixed_charges: 1 });
  });

  it("applies subscription fixed-charge units immediately only when requested", async () => {
    const response = await api(
      "/api/v1/subscriptions/subscription-sub-filter/fixed_charges/support-fixed",
      "PUT",
      {
        fixed_charge: {
          properties: { amount: "600" },
          units: "2",
          apply_units_immediately: true,
        },
      },
    );
    expect(response.status, await response.clone().text()).toBe(200);
    const subscription = await findBillableSubscription(env.BILLING_DB, "subscription-sub-filter");
    expect(subscription).not.toBeNull();
    const calculation = await calculateSubscriptionInvoice(
      env.BILLING_DB,
      subscription!,
      "subscription-fixed-immediate",
      "subscription-fixed-immediate-cycle",
      "2026-08-01T00:00:00.000Z",
      "2026-09-01T00:00:00.000Z",
    );
    expect(calculation.lines.find((line) => line.lineType === "fixed_charge")).toMatchObject({
      units: "2",
      rounded: 1200,
    });
    const events = await env.BILLING_DB.prepare(
      `SELECT fixed_charge_version, units, effective_at
       FROM fixed_charge_unit_events
       WHERE subscription_id = 'subscription-sub-filter'
       ORDER BY fixed_charge_version`,
    ).all<{ fixed_charge_version: number; units: string; effective_at: string }>();
    expect(events.results).toHaveLength(2);
    expect(events.results[0]).toEqual({
      fixed_charge_version: 0,
      units: "1",
      effective_at: "2026-08-01T00:00:00.000Z",
    });
    expect(Date.parse(events.results[1]?.effective_at ?? "")).toBeGreaterThan(
      Date.parse("2026-08-01T00:00:00.000Z"),
    );
    expect(Date.parse(events.results[1]?.effective_at ?? "")).toBeLessThan(
      Date.parse("2026-09-01T00:00:00.000Z"),
    );
  });

  it("lets a newer immediate unit change supersede an older scheduled change", async () => {
    const scheduled = await api(
      "/api/v1/subscriptions/subscription-sub-filter/fixed_charges/support-fixed",
      "PUT",
      { fixed_charge: { properties: { amount: "600" }, units: "2" } },
    );
    expect(scheduled.status).toBe(200);
    const immediate = await api(
      "/api/v1/subscriptions/subscription-sub-filter/fixed_charges/support-fixed",
      "PUT",
      { fixed_charge: { units: "3", apply_units_immediately: true } },
    );
    expect(immediate.status, await immediate.clone().text()).toBe(200);
    const subscription = await findBillableSubscription(env.BILLING_DB, "subscription-sub-filter");
    expect(subscription).not.toBeNull();
    const current = await calculateSubscriptionInvoice(
      env.BILLING_DB,
      subscription!,
      "subscription-fixed-mixed-current",
      "subscription-fixed-mixed-current-cycle",
      "2026-08-01T00:00:00.000Z",
      "2026-09-01T00:00:00.000Z",
    );
    const next = await calculateSubscriptionInvoice(
      env.BILLING_DB,
      subscription!,
      "subscription-fixed-mixed-next",
      "subscription-fixed-mixed-next-cycle",
      "2026-09-01T00:00:00.000Z",
      "2026-10-01T00:00:00.000Z",
    );
    expect(current.lines.find((line) => line.lineType === "fixed_charge")).toMatchObject({
      units: "3",
      rounded: 1800,
    });
    expect(next.lines.find((line) => line.lineType === "fixed_charge")).toMatchObject({
      units: "3",
      rounded: 1800,
    });
  });

  it("returns precise not-found errors for subscription fixed-charge routes", async () => {
    const missingCharge = await api(
      "/api/v1/subscriptions/subscription-sub-filter/fixed_charges/missing",
    );
    expect(missingCharge.status).toBe(404);
    await expect(missingCharge.json()).resolves.toMatchObject({ code: "fixed_charge_not_found" });
    const missingSubscription = await api(
      "/api/v1/subscriptions/missing/fixed_charges/support-fixed",
    );
    expect(missingSubscription.status).toBe(404);
    await expect(missingSubscription.json()).resolves.toMatchObject({
      code: "subscription_not_found",
    });
  });
});

async function subscriptionFilters(): Promise<
  Array<{
    lago_id: string;
    invoice_display_name: string | null;
    properties: Record<string, unknown>;
    values: Record<string, string[]>;
  }>
> {
  const response = await api(
    "/api/v1/subscriptions/subscription-sub-filter/charges/requests-charge/filters",
  );
  expect(response.status).toBe(200);
  const body = await response.json<{
    filters: Array<{
      lago_id: string;
      invoice_display_name: string | null;
      properties: Record<string, unknown>;
      values: Record<string, string[]>;
    }>;
  }>();
  return body.filters;
}

function api(path: string, method = "GET", body?: Record<string, unknown>): Promise<Response> {
  return SELF.fetch(`https://lago.test${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
}
