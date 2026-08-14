import { env, SELF } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { sha256Hex } from "../src/auth/api-key";
import { repairPendingPayInAdvanceFixedChargeInvoices } from "../src/billing/pay-in-advance-fixed-charges";
import {
  calculateSubscriptionInvoice,
  calculateTerminationSubscriptionInvoice,
  findBillableSubscription,
} from "../src/billing/subscription-invoice-calculation";

const apiKey = "advance-fixed-charge-test-key";
const headers = { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" };

beforeEach(async () => {
  const now = "2026-08-15T00:00:00.000Z";
  await env.BILLING_DB.batch([
    env.BILLING_DB.prepare(
      `INSERT OR IGNORE INTO organizations (id, external_id, name, created_at, updated_at)
       VALUES ('org-advance-fixed', 'advance-fixed', 'Advance Fixed', ?, ?)`,
    ).bind(now, now),
    env.BILLING_DB.prepare(
      `INSERT OR IGNORE INTO api_keys
       (id, organization_id, key_prefix, key_hash, created_at, revoked_at)
       VALUES ('key-advance-fixed', 'org-advance-fixed', 'advance-', ?, ?, NULL)`,
    ).bind(await sha256Hex(apiKey), now),
  ]);
});

describe("pay-in-advance fixed charges", () => {
  it("combines the base plan and fixed charge on an in-advance starting invoice", async () => {
    const addOn = await api("/api/v1/add_ons", "POST", {
      add_on: {
        name: "Combined seats",
        code: "combined-seats",
        amount_cents: 100,
        amount_currency: "USD",
      },
    });
    expect(addOn.status).toBe(200);
    const addOnId = (await addOn.json<{ add_on: { lago_id: string } }>()).add_on.lago_id;
    const plan = await api("/api/v1/plans", "POST", {
      plan: {
        name: "Combined advance plan",
        code: "combined-advance-plan",
        interval: "monthly",
        amount_cents: 1_000,
        amount_currency: "USD",
        pay_in_advance: true,
        fixed_charges: [
          {
            add_on_id: addOnId,
            code: "combined-seat-fee",
            charge_model: "standard",
            properties: { amount: "100" },
            units: "2",
            pay_in_advance: true,
          },
        ],
      },
    });
    expect(plan.status, await plan.clone().text()).toBe(200);
    expect(
      (
        await api("/api/v1/customers", "POST", {
          customer: { external_id: "combined-customer", currency: "USD", timezone: "UTC" },
        })
      ).status,
    ).toBe(200);
    const created = await api("/api/v1/subscriptions", "POST", {
      subscription: {
        external_customer_id: "combined-customer",
        external_id: "combined-subscription",
        plan_code: "combined-advance-plan",
      },
    });
    expect(created.status, await created.clone().text()).toBe(200);
    const subscriptionId = (await created.json<{ subscription: { lago_id: string } }>())
      .subscription.lago_id;
    const invoices = await env.BILLING_DB.prepare(
      `SELECT id, subtotal_minor, total_due_minor
       FROM invoices WHERE subscription_id = ? ORDER BY created_at, id`,
    )
      .bind(subscriptionId)
      .all<{ id: string; subtotal_minor: number; total_due_minor: number }>();
    expect(invoices.results).toHaveLength(1);
    expect(invoices.results[0]).toMatchObject({ subtotal_minor: 1_200, total_due_minor: 1_200 });
    const lines = await env.BILLING_DB.prepare(
      `SELECT line_type, amount_minor, metadata_json
       FROM invoice_lines WHERE invoice_id = ? ORDER BY line_type, id`,
    )
      .bind(invoices.results[0]!.id)
      .all<{ line_type: string; amount_minor: number; metadata_json: string }>();
    expect(lines.results).toHaveLength(2);
    expect(lines.results.map((line) => [line.line_type, line.amount_minor])).toEqual([
      ["fixed_charge", 200],
      ["subscription", 1_000],
    ]);
    expect(JSON.parse(lines.results[0]!.metadata_json)).toMatchObject({
      billingMode: "in_advance",
      contextType: "in_advance_charge",
    });
  });

  it("invoices at activation during a base trial and bills the upcoming renewal period", async () => {
    const addOn = await api("/api/v1/add_ons", "POST", {
      add_on: {
        name: "Advance seats",
        code: "advance-seats",
        amount_cents: 100,
        amount_currency: "USD",
      },
    });
    expect(addOn.status).toBe(200);
    const addOnId = (await addOn.json<{ add_on: { lago_id: string } }>()).add_on.lago_id;
    const plan = await api("/api/v1/plans", "POST", {
      plan: {
        name: "Advance plan",
        code: "advance-plan",
        interval: "monthly",
        amount_cents: 0,
        amount_currency: "USD",
        trial_period: 10,
        fixed_charges: [
          {
            add_on_id: addOnId,
            code: "advance-seat-fee",
            charge_model: "standard",
            properties: { amount: "100" },
            units: "2",
            pay_in_advance: true,
          },
        ],
      },
    });
    expect(plan.status, await plan.clone().text()).toBe(200);
    const fixedChargeId = (
      await plan.json<{ plan: { fixed_charges: Array<{ lago_id: string }> } }>()
    ).plan.fixed_charges[0]!.lago_id;
    expect(
      (
        await api("/api/v1/customers", "POST", {
          customer: { external_id: "advance-customer", currency: "USD", timezone: "UTC" },
        })
      ).status,
    ).toBe(200);
    const subscriptionRequest = {
      subscription: {
        external_customer_id: "advance-customer",
        external_id: "advance-subscription",
        plan_code: "advance-plan",
      },
    };
    const created = await api("/api/v1/subscriptions", "POST", subscriptionRequest);
    expect(created.status, await created.clone().text()).toBe(200);
    const subscriptionId = (await created.json<{ subscription: { lago_id: string } }>())
      .subscription.lago_id;

    const activationInvoice = await env.BILLING_DB.prepare(
      `SELECT id, status, subtotal_minor, total_due_minor
       FROM invoices WHERE subscription_id = ? ORDER BY created_at, id LIMIT 1`,
    )
      .bind(subscriptionId)
      .first<{ id: string; status: string; subtotal_minor: number; total_due_minor: number }>();
    expect(activationInvoice).toMatchObject({
      status: "finalized",
      subtotal_minor: 200,
      total_due_minor: 200,
    });
    const activationLine = await env.BILLING_DB.prepare(
      `SELECT quantity_decimal, amount_minor, metadata_json FROM invoice_lines
       WHERE invoice_id = ? AND source_id = ? LIMIT 1`,
    )
      .bind(activationInvoice!.id, fixedChargeId)
      .first<{ quantity_decimal: string; amount_minor: number; metadata_json: string }>();
    expect(activationLine).toMatchObject({ quantity_decimal: "2", amount_minor: 200 });
    expect(JSON.parse(activationLine!.metadata_json)).toMatchObject({
      contextType: "in_advance_charge",
      billingMode: "in_advance",
    });
    expect((await api("/api/v1/subscriptions", "POST", subscriptionRequest)).status).toBe(200);
    const invoiceCount = await env.BILLING_DB.prepare(
      "SELECT COUNT(*) AS total FROM invoices WHERE subscription_id = ?",
    )
      .bind(subscriptionId)
      .first<{ total: number }>();
    expect(invoiceCount?.total).toBe(1);

    const increase = await api("/api/v1/plans/advance-plan/fixed_charges/advance-seat-fee", "PUT", {
      fixed_charge: { units: "5", apply_units_immediately: true },
    });
    expect(increase.status, await increase.clone().text()).toBe(200);
    const increaseLine = await env.BILLING_DB.prepare(
      `SELECT line.quantity_decimal, line.amount_minor, line.metadata_json
       FROM invoice_lines line JOIN invoices invoice ON invoice.id = line.invoice_id
       WHERE invoice.subscription_id = ? AND line.source_id = ?
         AND json_extract(line.metadata_json, '$.contextType') = 'in_advance_charge_delta'
       ORDER BY line.created_at DESC, line.id DESC LIMIT 1`,
    )
      .bind(subscriptionId, fixedChargeId)
      .first<{ quantity_decimal: string; amount_minor: number; metadata_json: string }>();
    expect(increaseLine).toMatchObject({ quantity_decimal: "3", amount_minor: 300 });
    expect(JSON.parse(increaseLine!.metadata_json)).toMatchObject({
      requestedUnits: "5",
      previouslyPaidUnits: "2",
    });

    const decrease = await api("/api/v1/plans/advance-plan/fixed_charges/advance-seat-fee", "PUT", {
      fixed_charge: { units: "1", apply_units_immediately: true },
    });
    expect(decrease.status, await decrease.clone().text()).toBe(200);
    const deltaLines = await env.BILLING_DB.prepare(
      `SELECT line.quantity_decimal, line.amount_minor, line.metadata_json
       FROM invoice_lines line JOIN invoices invoice ON invoice.id = line.invoice_id
       WHERE invoice.subscription_id = ? AND line.source_id = ?
         AND json_extract(line.metadata_json, '$.contextType') = 'in_advance_charge_delta'
       ORDER BY line.created_at, line.id`,
    )
      .bind(subscriptionId, fixedChargeId)
      .all<{ quantity_decimal: string; amount_minor: number; metadata_json: string }>();
    expect(deltaLines.results).toHaveLength(2);
    expect(deltaLines.results[1]).toMatchObject({ quantity_decimal: "0", amount_minor: 0 });
    expect(JSON.parse(deltaLines.results[1]!.metadata_json)).toMatchObject({
      requestedUnits: "1",
      previouslyPaidUnits: "5",
    });
    const invoicesBeforeRepair = await env.BILLING_DB.prepare(
      "SELECT COUNT(*) AS total FROM invoices WHERE subscription_id = ?",
    )
      .bind(subscriptionId)
      .first<{ total: number }>();
    await env.BILLING_DB.prepare(
      `UPDATE fixed_charge_unit_events SET advance_billed_at = NULL, advance_invoice_id = NULL
       WHERE id = (
         SELECT id FROM fixed_charge_unit_events
         WHERE subscription_id = ? AND fixed_charge_id = ? AND bill_immediately = 1
         ORDER BY fixed_charge_version DESC LIMIT 1
       )`,
    )
      .bind(subscriptionId, fixedChargeId)
      .run();
    expect(
      await repairPendingPayInAdvanceFixedChargeInvoices(
        env,
        "2099-01-01T00:00:00.000Z",
        "advance-repair",
      ),
    ).toBe(1);
    const invoicesAfterRepair = await env.BILLING_DB.prepare(
      "SELECT COUNT(*) AS total FROM invoices WHERE subscription_id = ?",
    )
      .bind(subscriptionId)
      .first<{ total: number }>();
    expect(invoicesAfterRepair?.total).toBe(invoicesBeforeRepair?.total);
    const repairedEvent = await env.BILLING_DB.prepare(
      `SELECT advance_billed_at, advance_invoice_id FROM fixed_charge_unit_events
       WHERE subscription_id = ? AND fixed_charge_id = ? AND bill_immediately = 1
       ORDER BY fixed_charge_version DESC LIMIT 1`,
    )
      .bind(subscriptionId, fixedChargeId)
      .first<{ advance_billed_at: string | null; advance_invoice_id: string | null }>();
    expect(repairedEvent?.advance_billed_at).not.toBeNull();
    expect(repairedEvent?.advance_invoice_id).not.toBeNull();

    await env.BILLING_DB.batch([
      env.BILLING_DB.prepare(
        `UPDATE subscriptions SET current_period_start = '2026-08-01T00:00:00.000Z',
          current_period_end = '2026-09-01T00:00:00.000Z' WHERE id = ?`,
      ).bind(subscriptionId),
      env.BILLING_DB.prepare(
        `INSERT INTO fixed_charge_unit_events
         (id, organization_id, subscription_id, fixed_charge_id, fixed_charge_version, units,
          effective_at, created_at)
         VALUES ('advance-next-event', 'org-advance-fixed', ?, ?, 4, '3',
                 '2026-09-01T00:00:00.000Z', '2026-08-20T00:00:00.000Z')`,
      ).bind(subscriptionId, fixedChargeId),
    ]);
    const subscription = await findBillableSubscription(env.BILLING_DB, subscriptionId);
    expect(subscription).not.toBeNull();
    const renewal = await calculateSubscriptionInvoice(
      env.BILLING_DB,
      subscription!,
      "advance-renewal-invoice",
      "advance-renewal-cycle",
      "2026-08-01T00:00:00.000Z",
      "2026-09-01T00:00:00.000Z",
    );
    const renewalLine = renewal.lines.find((line) => line.sourceId === fixedChargeId);
    expect(renewalLine).toMatchObject({ units: "3", precise: "300", rounded: 300 });
    expect(JSON.parse(renewalLine!.metadataJson)).toMatchObject({
      billingMode: "in_advance",
      periodStart: "2026-09-01T00:00:00.000Z",
      periodEnd: "2026-10-01T00:00:00.000Z",
    });

    const termination = await calculateTerminationSubscriptionInvoice(
      env.BILLING_DB,
      subscription!,
      "advance-termination-invoice",
      "advance-termination",
      "2026-08-20T12:00:00.000Z",
      undefined,
      {
        periodStart: "2026-08-01T00:00:00.000Z",
        periodEnd: "2026-09-01T00:00:00.000Z",
      },
    );
    expect(termination.lines.some((line) => line.sourceId === fixedChargeId)).toBe(false);
  });
});

function api(path: string, method = "GET", body?: Record<string, unknown>): Promise<Response> {
  return SELF.fetch(`https://lago.test${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
}
