import { env, SELF } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { sha256Hex } from "../src/auth/api-key";
import { closeBillingPeriod } from "../src/billing/close-period";
import {
  calculateSubscriptionInvoice,
  findBillableSubscription,
} from "../src/billing/subscription-invoice-calculation";
import { followingPeriodEnd } from "../src/billing/periods";

const apiKey = "add-on-fixed-charge-test-key";
const headers = { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" };

beforeEach(async () => {
  const now = "2026-08-14T00:00:00.000Z";
  await env.BILLING_DB.batch([
    env.BILLING_DB.prepare(
      `INSERT OR IGNORE INTO organizations (id, external_id, name, created_at, updated_at)
       VALUES ('org-fixed-charge', 'fixed-charge-test', 'Fixed Charge Test', ?, ?)`,
    ).bind(now, now),
    env.BILLING_DB.prepare(
      `INSERT OR IGNORE INTO api_keys
       (id, organization_id, key_prefix, key_hash, created_at, revoked_at)
       VALUES ('key-fixed-charge', 'org-fixed-charge', 'fixed-ch', ?, ?, NULL)`,
    ).bind(await sha256Hex(apiKey), now),
  ]);
});

describe("Lago-compatible add-ons and recurring fixed charges", () => {
  it("maintains the add-on ledger and bills a fixed fee before commitment credits", async () => {
    expect(
      (
        await api("/api/v1/taxes", "POST", {
          tax: {
            code: "fixed-tax",
            name: "Fixed tax",
            rate: "6",
            applied_to_organization: false,
          },
        })
      ).status,
    ).toBe(200);
    const addOnPayload = {
      add_on: {
        name: "Seat",
        invoice_display_name: "Platform seats",
        code: "seat",
        amount_cents: 100,
        amount_currency: "usd",
        description: "Synthetic recurring seat",
        tax_codes: ["fixed-tax"],
      },
    };
    const created = await api("/api/v1/add_ons", "POST", addOnPayload);
    expect(created.status).toBe(200);
    const createdBody = await created.json<{ add_on: { lago_id: string } }>();
    const addOnId = createdBody.add_on.lago_id;
    expect((await api("/api/v1/add_ons", "POST", addOnPayload)).status).toBe(200);
    await expect(apiJson("/api/v1/add_ons/seat")).resolves.toMatchObject({
      add_on: {
        lago_id: addOnId,
        code: "seat",
        amount_cents: 100,
        amount_currency: "USD",
        taxes: [{ code: "fixed-tax", rate: 6 }],
      },
    });
    await expect(apiJson("/api/v1/add_ons")).resolves.toMatchObject({
      meta: { total_count: 1 },
      add_ons: [{ lago_id: addOnId }],
    });

    const planPayload = {
      plan: {
        name: "Fixed Plan",
        code: "fixed-plan",
        interval: "monthly",
        amount_cents: 500,
        amount_currency: "USD",
        pay_in_advance: true,
        fixed_charges: [
          {
            add_on_id: addOnId,
            code: "seat-fixed",
            charge_model: "standard",
            units: "2.5",
            properties: { amount: "100" },
            tax_codes: ["fixed-tax"],
          },
        ],
        minimum_commitment: {
          amount_cents: 1000,
          invoice_display_name: "Monthly minimum",
        },
      },
    };
    const plan = await api("/api/v1/plans", "POST", planPayload);
    expect(plan.status).toBe(200);
    await expect(plan.json()).resolves.toMatchObject({
      plan: {
        code: "fixed-plan",
        fixed_charges: [
          {
            lago_add_on_id: addOnId,
            add_on_code: "seat",
            code: "seat-fixed",
            charge_model: "standard",
            units: "2.5",
            pay_in_advance: false,
            prorated: false,
            properties: { amount: "100" },
            taxes: [{ code: "fixed-tax", rate: 6 }],
          },
        ],
      },
    });
    expect((await api("/api/v1/plans", "POST", planPayload)).status).toBe(200);
    await expect(apiJson("/api/v1/plans/fixed-plan/fixed_charges")).resolves.toMatchObject({
      meta: { total_count: 1 },
      fixed_charges: [
        {
          lago_add_on_id: addOnId,
          code: "seat-fixed",
          add_on_code: "seat",
          units: "2.5",
        },
      ],
    });
    await expect(
      apiJson("/api/v1/plans/fixed-plan/fixed_charges/seat-fixed"),
    ).resolves.toMatchObject({
      fixed_charge: {
        lago_add_on_id: addOnId,
        code: "seat-fixed",
        charge_model: "standard",
        properties: { amount: "100" },
        taxes: [{ code: "fixed-tax", rate: 6 }],
      },
    });
    const standalonePayload = {
      fixed_charge: {
        add_on_id: addOnId,
        code: "seat-extra",
        invoice_display_name: "Extra seats",
        charge_model: "standard",
        units: "1",
        properties: { amount: "100" },
      },
    };
    const standalone = await api(
      "/api/v1/plans/fixed-plan/fixed_charges",
      "POST",
      standalonePayload,
    );
    expect(standalone.status).toBe(200);
    const standaloneId = (await standalone.json<{ fixed_charge: { lago_id: string } }>())
      .fixed_charge.lago_id;
    await expect(
      api("/api/v1/plans/fixed-plan/fixed_charges", "POST", standalonePayload).then((response) =>
        response.json(),
      ),
    ).resolves.toMatchObject({ fixed_charge: { lago_id: standaloneId } });
    const standaloneUpdate = await api("/api/v1/plans/fixed-plan/fixed_charges/seat-extra", "PUT", {
      fixed_charge: {
        code: "seat-extra-renamed",
        invoice_display_name: "Renamed extra seats",
        charge_model: "standard",
        units: "2",
        properties: { amount: "100" },
        tax_codes: [],
      },
    });
    expect(standaloneUpdate.status).toBe(200);
    await expect(standaloneUpdate.json()).resolves.toMatchObject({
      fixed_charge: {
        lago_id: standaloneId,
        code: "seat-extra-renamed",
        units: "2",
        taxes: [],
      },
    });
    const updateReplay = await api(
      "/api/v1/plans/fixed-plan/fixed_charges/seat-extra-renamed",
      "PUT",
      {
        fixed_charge: {
          invoice_display_name: "Renamed extra seats",
          units: "2",
          properties: { amount: "100" },
        },
      },
    );
    expect(updateReplay.status).toBe(200);
    await expect(
      env.BILLING_DB.prepare(
        `SELECT fc.version,
                (SELECT COUNT(*) FROM outbox_events
                 WHERE aggregate_type = 'fixed_charge' AND aggregate_id = fc.id) AS events
         FROM fixed_charges fc WHERE fc.id = ?`,
      )
        .bind(standaloneId)
        .first(),
    ).resolves.toEqual({ events: 2, version: 2 });
    expect(
      (
        await api("/api/v1/plans/fixed-plan/fixed_charges/seat-extra-renamed", "DELETE", {
          fixed_charge: { cascade_updates: true },
        })
      ).status,
    ).toBe(200);
    expect((await api("/api/v1/plans/fixed-plan/fixed_charges/seat-extra-renamed")).status).toBe(
      404,
    );
    const unavailable = await api("/api/v1/plans/fixed-plan/fixed_charges", "POST", {
      fixed_charge: { ...standalonePayload.fixed_charge, code: "seat-extra-renamed" },
    });
    expect(unavailable.status).toBe(422);
    await expect(unavailable.json()).resolves.toMatchObject({
      code: "fixed_charge_code_unavailable",
    });

    expect(
      (
        await api("/api/v1/customers", "POST", {
          customer: { external_id: "fixed-customer", name: "Fixed Customer", currency: "USD" },
        })
      ).status,
    ).toBe(200);
    const subscriptionResponse = await api("/api/v1/subscriptions", "POST", {
      subscription: {
        external_customer_id: "fixed-customer",
        external_id: "fixed-subscription",
        plan_code: "fixed-plan",
      },
    });
    expect(subscriptionResponse.status).toBe(200);
    const subscription = await subscriptionResponse.json<{
      subscription: { lago_id: string; current_billing_period_ending_at: string };
    }>();

    const draftAt = "2026-08-14T01:00:00.000Z";
    await env.BILLING_DB.batch([
      env.BILLING_DB.prepare(
        `INSERT INTO invoices
         (id, organization_id, customer_id, subscription_id, number, status, payment_status,
          currency, subtotal_minor, tax_minor, credits_minor, total_due_minor, version,
          created_at, updated_at)
         VALUES ('fixed-charge-draft', 'org-fixed-charge',
                 (SELECT customer_id FROM subscriptions WHERE id = ?), ?, NULL, 'draft',
                 'pending', 'USD', 0, 0, 0, 0, 1, ?, ?)`,
      ).bind(
        subscription.subscription.lago_id,
        subscription.subscription.lago_id,
        draftAt,
        draftAt,
      ),
      env.BILLING_DB.prepare(
        `INSERT INTO invoice_subscriptions
         (invoice_id, subscription_id, organization_id, invoicing_reason,
          period_start, period_end, created_at)
         VALUES ('fixed-charge-draft', ?, 'org-fixed-charge', 'subscription_periodic',
                 NULL, NULL, ?)`,
      ).bind(subscription.subscription.lago_id, draftAt),
    ]);

    const attachedUpdate = await api("/api/v1/plans/fixed-plan/fixed_charges/seat-fixed", "PUT", {
      fixed_charge: {
        code: "ignored-attached-code",
        invoice_display_name: "Attached seat fee",
        charge_model: "volume",
        units: "2.5",
        properties: { amount: "100" },
      },
    });
    expect(attachedUpdate.status).toBe(200);
    await expect(attachedUpdate.json()).resolves.toMatchObject({
      fixed_charge: {
        code: "seat-fixed",
        invoice_display_name: "Attached seat fee",
        charge_model: "standard",
        units: "2.5",
      },
    });
    await expect(
      env.BILLING_DB.prepare(
        "SELECT ready_to_be_refreshed FROM invoices WHERE id = 'fixed-charge-draft'",
      ).first(),
    ).resolves.toEqual({ ready_to_be_refreshed: 1 });
    await env.BILLING_DB.prepare("DELETE FROM invoices WHERE id = 'fixed-charge-draft'").run();

    const initialInvoice = await env.BILLING_DB.prepare(
      `SELECT subtotal_minor, total_due_minor,
              (SELECT COUNT(*) FROM invoice_lines il WHERE il.invoice_id = i.id
               AND il.line_type = 'fixed_charge') AS fixed_lines
       FROM invoices i WHERE subscription_id = ? ORDER BY created_at LIMIT 1`,
    )
      .bind(subscription.subscription.lago_id)
      .first<{ subtotal_minor: number; total_due_minor: number; fixed_lines: number }>();
    expect(initialInvoice).toEqual({ subtotal_minor: 500, total_due_minor: 500, fixed_lines: 0 });

    const close = await closeBillingPeriod(
      env,
      subscription.subscription.lago_id,
      subscription.subscription.current_billing_period_ending_at,
      "fixed-charge-close",
    );
    expect(close).toMatchObject({ replayed: false, totalDueMinor: 1015, lineCount: 3 });
    const lines = await env.BILLING_DB.prepare(
      `SELECT line_type, source_type, amount_minor, precise_amount_minor, quantity_decimal
       FROM invoice_lines WHERE invoice_id = ? ORDER BY line_type`,
    )
      .bind(close.invoiceId)
      .all<{
        line_type: string;
        source_type: string;
        amount_minor: number;
        precise_amount_minor: string;
        quantity_decimal: string;
      }>();
    expect(lines.results).toEqual([
      {
        line_type: "commitment",
        source_type: "commitment",
        amount_minor: 250,
        precise_amount_minor: "250",
        quantity_decimal: "1",
      },
      {
        line_type: "fixed_charge",
        source_type: "fixed_charge",
        amount_minor: 250,
        precise_amount_minor: "250",
        quantity_decimal: "2.5",
      },
      {
        line_type: "subscription",
        source_type: "plan",
        amount_minor: 500,
        precise_amount_minor: "500",
        quantity_decimal: "1",
      },
    ]);
    await expect(
      env.BILLING_DB.prepare(
        `SELECT tax_code, tax_rate, taxable_base_minor, amount_minor
         FROM invoice_taxes WHERE invoice_id = ?`,
      )
        .bind(close.invoiceId)
        .first(),
    ).resolves.toEqual({
      tax_code: "fixed-tax",
      tax_rate: "6",
      taxable_base_minor: 250,
      amount_minor: 15,
    });

    const usedDelete = await api("/api/v1/add_ons/seat", "DELETE");
    expect(usedDelete.status).toBe(422);
    await expect(usedDelete.json()).resolves.toMatchObject({ code: "add_on_in_use" });
    const mismatchedUpdate = await api("/api/v1/add_ons/seat", "PUT", {
      add_on: { amount_currency: "EUR" },
    });
    expect(mismatchedUpdate.status).toBe(422);
    await expect(mismatchedUpdate.json()).resolves.toMatchObject({ code: "currency_mismatch" });
    expect((await api("/api/v1/plans/fixed-plan/fixed_charges/seat-fixed", "DELETE")).status).toBe(
      200,
    );
    await expect(
      env.BILLING_DB.prepare(
        `SELECT fc.active, fc.version,
                (SELECT amount_minor FROM invoice_lines
                 WHERE invoice_id = ? AND line_type = 'fixed_charge') AS historical_amount
         FROM fixed_charges fc WHERE fc.code = 'seat-fixed'`,
      )
        .bind(close.invoiceId)
        .first(),
    ).resolves.toEqual({ active: 0, historical_amount: 250, version: 3 });
    expect((await api("/api/v1/add_ons/seat", "DELETE")).status).toBe(200);
    const events = await env.BILLING_DB.prepare(
      `SELECT COUNT(*) AS total FROM outbox_events
       WHERE aggregate_type = 'add_on' AND aggregate_id = ?`,
    )
      .bind(addOnId)
      .first<{ total: number }>();
    expect(events?.total).toBe(2);
  });

  it("updates and terminates unused add-ons while enforcing advance fixed-charge models", async () => {
    const unused = await api("/api/v1/add_ons", "POST", {
      add_on: {
        name: "Unused",
        code: "unused",
        amount_cents: 200,
        amount_currency: "USD",
      },
    });
    const unusedId = (await unused.json<{ add_on: { lago_id: string } }>()).add_on.lago_id;
    const updated = await api("/api/v1/add_ons/unused", "PUT", {
      add_on: { code: "unused-renamed", name: "Unused renamed", amount_cents: 250 },
    });
    expect(updated.status).toBe(200);
    await expect(updated.json()).resolves.toMatchObject({
      add_on: { lago_id: unusedId, code: "unused-renamed", amount_cents: 250 },
    });
    expect((await api("/api/v1/add_ons/unused-renamed", "DELETE")).status).toBe(200);
    expect((await api("/api/v1/add_ons/unused-renamed")).status).toBe(404);

    const advanceAddOn = await api("/api/v1/add_ons", "POST", {
      add_on: {
        name: "Advance",
        code: "advance",
        amount_cents: 200,
        amount_currency: "USD",
      },
    });
    const advanceAddOnId = (await advanceAddOn.json<{ add_on: { lago_id: string } }>()).add_on
      .lago_id;
    const planBase = {
      name: "Advance fixed plan",
      interval: "monthly",
      amount_cents: 100,
      amount_currency: "USD",
    };
    const supportedAdvance = await api("/api/v1/plans", "POST", {
      plan: {
        ...planBase,
        code: "supported-advance",
        fixed_charges: [
          {
            add_on_id: advanceAddOnId,
            code: "supported-advance",
            charge_model: "standard",
            units: 1,
            properties: { amount: "100" },
            pay_in_advance: true,
            prorated: true,
          },
        ],
      },
    });
    expect(supportedAdvance.status).toBe(200);
    await expect(supportedAdvance.json()).resolves.toMatchObject({
      plan: {
        fixed_charges: [{ pay_in_advance: true, prorated: true }],
      },
    });

    for (const [suffix, chargeModel, prorated] of [
      ["volume", "volume", false],
      ["graduated-prorated", "graduated", true],
    ] as const) {
      const response = await api("/api/v1/plans", "POST", {
        plan: {
          ...planBase,
          code: `invalid-${suffix}`,
          fixed_charges: [
            {
              add_on_id: advanceAddOnId,
              code: `invalid-${suffix}`,
              charge_model: chargeModel,
              units: 1,
              properties:
                chargeModel === "graduated"
                  ? { graduated_ranges: [{ from_value: 0, to_value: null, per_unit_amount: "1" }] }
                  : { volume_ranges: [{ from_value: 0, to_value: null, per_unit_amount: "1" }] },
              pay_in_advance: true,
              prorated,
            },
          ],
        },
      });
      expect(response.status).toBe(422);
      await expect(response.json()).resolves.toMatchObject({
        code: "invalid_charge_model",
      });
    }

    for (const [suffix, planFields, expectedCode] of [
      [
        "monthly-split",
        { interval: "yearly", bill_fixed_charges_monthly: true },
        "unsupported_fixed_charge_feature",
      ],
      ["one-time", { interval: "one_time" }, "unsupported_plan_feature"],
    ] as const) {
      const response = await api("/api/v1/plans", "POST", {
        plan: {
          ...planBase,
          ...planFields,
          code: `unsafe-${suffix}`,
          fixed_charges: [
            {
              add_on_id: unusedId,
              code: `unsafe-${suffix}`,
              charge_model: "standard",
              units: 1,
              properties: { amount: "100" },
            },
          ],
        },
      });
      expect(response.status).toBe(422);
      await expect(response.json()).resolves.toMatchObject({
        code: expectedCode,
      });
    }
  });

  it("effective-dates attached-plan fixed-charge creates and unit updates", async () => {
    const addOn = await api("/api/v1/add_ons", "POST", {
      add_on: {
        name: "Timing add-on",
        code: "timing-addon",
        amount_cents: 100,
        amount_currency: "USD",
      },
    });
    expect(addOn.status).toBe(200);
    const addOnId = (await addOn.json<{ add_on: { lago_id: string } }>()).add_on.lago_id;
    const plan = await api("/api/v1/plans", "POST", {
      plan: {
        name: "Timing plan",
        code: "timing-plan",
        interval: "monthly",
        amount_cents: 0,
        amount_currency: "USD",
        fixed_charges: [
          {
            add_on_id: addOnId,
            code: "timing-root",
            charge_model: "standard",
            properties: { amount: "100" },
            units: "1",
          },
        ],
      },
    });
    expect(plan.status).toBe(200);
    expect(
      (
        await api("/api/v1/customers", "POST", {
          customer: { external_id: "timing-customer", currency: "USD" },
        })
      ).status,
    ).toBe(200);
    const subscriptionResponse = await api("/api/v1/subscriptions", "POST", {
      subscription: {
        external_customer_id: "timing-customer",
        external_id: "timing-subscription",
        plan_code: "timing-plan",
      },
    });
    expect(subscriptionResponse.status).toBe(200);
    const subscriptionId = (
      await subscriptionResponse.json<{ subscription: { lago_id: string } }>()
    ).subscription.lago_id;
    const subscription = await findBillableSubscription(env.BILLING_DB, subscriptionId);
    expect(subscription).not.toBeNull();
    const periodStart = subscription!.current_period_start;
    const periodEnd = subscription!.current_period_end;
    const nextEnd = followingPeriodEnd(
      new Date(periodEnd),
      subscription!.interval,
      subscription!.billing_time,
      subscription!.billing_timezone,
    ).toISOString();

    const scheduledUpdate = await api(
      "/api/v1/plans/timing-plan/fixed_charges/timing-root",
      "PUT",
      { fixed_charge: { properties: { amount: "100" }, units: "2" } },
    );
    expect(scheduledUpdate.status, await scheduledUpdate.clone().text()).toBe(200);
    const rootId = (await scheduledUpdate.json<{ fixed_charge: { lago_id: string } }>())
      .fixed_charge.lago_id;
    let calculation = await calculateSubscriptionInvoice(
      env.BILLING_DB,
      subscription!,
      "catalog-unit-current-scheduled",
      "catalog-unit-current-scheduled-cycle",
      periodStart,
      periodEnd,
    );
    expect(calculation.lines.find((line) => line.sourceId === rootId)).toMatchObject({
      units: "1",
      rounded: 100,
    });

    const immediateUpdate = await api(
      "/api/v1/plans/timing-plan/fixed_charges/timing-root",
      "PUT",
      {
        fixed_charge: {
          properties: { amount: "100" },
          units: "3",
          apply_units_immediately: true,
        },
      },
    );
    expect(immediateUpdate.status, await immediateUpdate.clone().text()).toBe(200);
    const scheduledCreate = await api("/api/v1/plans/timing-plan/fixed_charges", "POST", {
      fixed_charge: {
        add_on_id: addOnId,
        code: "timing-scheduled-create",
        charge_model: "standard",
        properties: { amount: "50" },
        units: "4",
      },
    });
    expect(scheduledCreate.status, await scheduledCreate.clone().text()).toBe(200);
    const scheduledId = (await scheduledCreate.json<{ fixed_charge: { lago_id: string } }>())
      .fixed_charge.lago_id;
    const immediateCreate = await api("/api/v1/plans/timing-plan/fixed_charges", "POST", {
      fixed_charge: {
        add_on_id: addOnId,
        code: "timing-immediate-create",
        charge_model: "standard",
        properties: { amount: "50" },
        units: "4",
        apply_units_immediately: true,
      },
    });
    expect(immediateCreate.status, await immediateCreate.clone().text()).toBe(200);
    const immediateId = (await immediateCreate.json<{ fixed_charge: { lago_id: string } }>())
      .fixed_charge.lago_id;

    calculation = await calculateSubscriptionInvoice(
      env.BILLING_DB,
      subscription!,
      "catalog-unit-current-immediate",
      "catalog-unit-current-immediate-cycle",
      periodStart,
      periodEnd,
    );
    expect(calculation.lines.find((line) => line.sourceId === rootId)).toMatchObject({
      units: "3",
      rounded: 300,
    });
    expect(calculation.lines.find((line) => line.sourceId === scheduledId)).toMatchObject({
      units: "0",
      rounded: 0,
    });
    expect(calculation.lines.find((line) => line.sourceId === immediateId)).toMatchObject({
      units: "4",
      rounded: 200,
    });
    const next = await calculateSubscriptionInvoice(
      env.BILLING_DB,
      subscription!,
      "catalog-unit-next",
      "catalog-unit-next-cycle",
      periodEnd,
      nextEnd,
    );
    expect(next.lines.find((line) => line.sourceId === rootId)).toMatchObject({
      units: "3",
      rounded: 300,
    });
    expect(next.lines.find((line) => line.sourceId === scheduledId)).toMatchObject({
      units: "4",
      rounded: 200,
    });
    await expect(
      env.BILLING_DB.prepare(
        `SELECT fixed_charge_id, fixed_charge_version, units, effective_at
         FROM fixed_charge_unit_events WHERE subscription_id = ?
         ORDER BY fixed_charge_id, fixed_charge_version`,
      )
        .bind(subscriptionId)
        .all(),
    ).resolves.toMatchObject({
      results: expect.arrayContaining([
        expect.objectContaining({
          fixed_charge_id: rootId,
          fixed_charge_version: 0,
          units: "1",
        }),
        expect.objectContaining({
          fixed_charge_id: rootId,
          fixed_charge_version: 2,
          units: "2",
          effective_at: periodEnd,
        }),
        expect.objectContaining({
          fixed_charge_id: rootId,
          fixed_charge_version: 3,
          units: "3",
        }),
        expect.objectContaining({
          fixed_charge_id: scheduledId,
          fixed_charge_version: 1,
          units: "4",
          effective_at: periodEnd,
        }),
        expect.objectContaining({
          fixed_charge_id: immediateId,
          fixed_charge_version: 1,
          units: "4",
        }),
      ]),
    });
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
