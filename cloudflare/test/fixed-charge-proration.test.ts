import { env, SELF } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { sha256Hex } from "../src/auth/api-key";
import { fixedChargePeriodUnits } from "../src/billing/fixed-charge-units";
import {
  calculateSubscriptionInvoice,
  calculateTerminationSubscriptionInvoice,
  findBillableSubscription,
} from "../src/billing/subscription-invoice-calculation";
import { rateProratedFixedCharge } from "../src/rating/charge-models";
import { Decimal } from "../src/rating/decimal";

const apiKey = "fixed-charge-proration-test-key";
const headers = { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" };

beforeEach(async () => {
  const now = "2026-08-15T00:00:00.000Z";
  await env.BILLING_DB.batch([
    env.BILLING_DB.prepare(
      `INSERT OR IGNORE INTO organizations (id, external_id, name, created_at, updated_at)
       VALUES ('org-fixed-proration', 'fixed-proration', 'Fixed Proration', ?, ?)`,
    ).bind(now, now),
    env.BILLING_DB.prepare(
      `INSERT OR IGNORE INTO api_keys
       (id, organization_id, key_prefix, key_hash, created_at, revoked_at)
       VALUES ('key-fixed-proration', 'org-fixed-proration', 'fixed-pr', ?, ?, NULL)`,
    ).bind(await sha256Hex(apiKey), now),
  ]);
});

describe("fixed-charge local-day proration", () => {
  it("weights unit states and lets a later immediate value supersede an older scheduled value", () => {
    const events = [
      { fixedChargeVersion: 0, units: "10", effectiveAt: "2026-08-01T00:00:00.000Z" },
      { fixedChargeVersion: 2, units: "20", effectiveAt: "2026-08-16T00:00:00.000Z" },
      { fixedChargeVersion: 3, units: "30", effectiveAt: "2026-09-01T00:00:00.000Z" },
      { fixedChargeVersion: 4, units: "40", effectiveAt: "2026-08-20T00:00:00.000Z" },
    ];
    expect(
      fixedChargePeriodUnits(
        "40",
        true,
        events,
        "2026-08-01T00:00:00.000Z",
        "2026-09-01T00:00:00.000Z",
        31,
        "UTC",
      ),
    ).toEqual({ fullUnits: "40", proratedUnits: "22.903226" });
    expect(
      fixedChargePeriodUnits(
        "40",
        true,
        events,
        "2026-09-01T00:00:00.000Z",
        "2026-10-01T00:00:00.000Z",
        30,
        "UTC",
      ),
    ).toEqual({ fullUnits: "40", proratedUnits: "40" });
  });

  it("uses row fallback for a first partial period and zero before a scheduled create", () => {
    expect(
      fixedChargePeriodUnits(
        "8",
        false,
        [],
        "2026-03-17T00:00:00.000Z",
        "2026-04-01T00:00:00.000Z",
        31,
        "UTC",
      ),
    ).toEqual({ fullUnits: "8", proratedUnits: "3.870968" });
    expect(
      fixedChargePeriodUnits(
        "8",
        true,
        [{ fixedChargeVersion: 1, units: "8", effectiveAt: "2026-04-01T00:00:00.000Z" }],
        "2026-03-01T00:00:00.000Z",
        "2026-04-01T00:00:00.000Z",
        31,
        "UTC",
      ),
    ).toEqual({ fullUnits: "0", proratedUnits: "0" });
  });

  it("weights civil days rather than elapsed hours across a timezone transition", () => {
    expect(
      fixedChargePeriodUnits(
        "2",
        true,
        [
          { fixedChargeVersion: 0, units: "1", effectiveAt: "2026-03-01T05:00:00.000Z" },
          { fixedChargeVersion: 2, units: "2", effectiveAt: "2026-03-08T05:00:00.000Z" },
        ],
        "2026-03-01T05:00:00.000Z",
        "2026-04-01T04:00:00.000Z",
        31,
        "America/New_York",
      ),
    ).toEqual({ fullUnits: "2", proratedUnits: "1.774193" });
  });

  it("rates standard, volume, and graduated models with Lago's proration inputs", () => {
    expect(
      rateProratedFixedCharge("40", "22.903226", {
        model: "standard",
        amount: "100",
      }).amountCents,
    ).toBe("2290.3226");
    expect(
      rateProratedFixedCharge("40", "22.903226", {
        model: "volume",
        ranges: [
          { fromValue: 0, toValue: 10, perUnitAmount: "1", flatAmount: "100" },
          { fromValue: 11, toValue: null, perUnitAmount: "2", flatAmount: "200" },
        ],
      }).amountCents,
    ).toBe("245.806452");
    const graduated = rateProratedFixedCharge("40", "22.903226", {
      model: "graduated",
      ranges: [
        { fromValue: 0, toValue: 10, perUnitAmount: "1", flatAmount: "100" },
        { fromValue: 11, toValue: null, perUnitAmount: "2", flatAmount: "200" },
      ],
    });
    expect(Decimal.parse(graduated.amountCents).roundToScale(6, "half_up").toString()).toBe(
      "340.080646",
    );
    expect(
      rateProratedFixedCharge("0", "5", {
        model: "graduated",
        ranges: [
          { fromValue: 0, toValue: 10, perUnitAmount: "1", flatAmount: "100" },
          { fromValue: 11, toValue: null, perUnitAmount: "2", flatAmount: "200" },
        ],
      }).amountCents,
    ).toBe("105");
  });

  it("persists prorated catalog charges and bills renewal and termination windows", async () => {
    const addOn = await api("/api/v1/add_ons", "POST", {
      add_on: {
        name: "Prorated seats",
        code: "prorated-seats",
        amount_cents: 100,
        amount_currency: "USD",
      },
    });
    expect(addOn.status).toBe(200);
    const addOnId = (await addOn.json<{ add_on: { lago_id: string } }>()).add_on.lago_id;
    const plan = await api("/api/v1/plans", "POST", {
      plan: {
        name: "Prorated plan",
        code: "prorated-plan",
        interval: "monthly",
        amount_cents: 0,
        amount_currency: "USD",
        fixed_charges: [
          {
            add_on_id: addOnId,
            code: "prorated-seat-fee",
            charge_model: "standard",
            properties: { amount: "100" },
            units: "10",
            prorated: true,
          },
        ],
      },
    });
    expect(plan.status, await plan.clone().text()).toBe(200);
    const planBody = await plan.json<{
      plan: { fixed_charges: Array<{ lago_id: string; prorated: boolean }> };
    }>();
    const fixedCharge = planBody.plan.fixed_charges[0]!;
    expect(fixedCharge.prorated).toBe(true);
    expect(
      (
        await api("/api/v1/customers", "POST", {
          customer: { external_id: "prorated-customer", currency: "USD" },
        })
      ).status,
    ).toBe(200);
    const createdSubscription = await api("/api/v1/subscriptions", "POST", {
      subscription: {
        external_customer_id: "prorated-customer",
        external_id: "prorated-subscription",
        plan_code: "prorated-plan",
      },
    });
    expect(createdSubscription.status).toBe(200);
    const subscriptionId = (await createdSubscription.json<{ subscription: { lago_id: string } }>())
      .subscription.lago_id;
    await env.BILLING_DB.batch([
      env.BILLING_DB.prepare(
        `UPDATE subscriptions
         SET started_at = '2026-08-01T00:00:00.000Z',
             current_period_start = '2026-08-01T00:00:00.000Z',
             current_period_end = '2026-09-01T00:00:00.000Z'
         WHERE id = ?`,
      ).bind(subscriptionId),
      env.BILLING_DB.prepare(
        "UPDATE fixed_charges SET units = '40', version = 4 WHERE id = ?",
      ).bind(fixedCharge.lago_id),
      ...[
        {
          id: "proration-event-0",
          version: 0,
          units: "10",
          effectiveAt: "2026-08-01T00:00:00.000Z",
          createdAt: "2026-08-01T00:00:00.000Z",
        },
        {
          id: "proration-event-2",
          version: 2,
          units: "20",
          effectiveAt: "2026-08-16T00:00:00.000Z",
          createdAt: "2026-08-16T00:00:00.000Z",
        },
        {
          id: "proration-event-3",
          version: 3,
          units: "30",
          effectiveAt: "2026-09-01T00:00:00.000Z",
          createdAt: "2026-08-18T00:00:00.000Z",
        },
        {
          id: "proration-event-4",
          version: 4,
          units: "40",
          effectiveAt: "2026-08-20T00:00:00.000Z",
          createdAt: "2026-08-20T00:00:00.000Z",
        },
      ].map(({ id, version, units, effectiveAt, createdAt }) =>
        env.BILLING_DB.prepare(
          `INSERT INTO fixed_charge_unit_events
           (id, organization_id, subscription_id, fixed_charge_id, fixed_charge_version, units,
            effective_at, created_at)
           VALUES (?, 'org-fixed-proration', ?, ?, ?, ?, ?, ?)`,
        ).bind(id, subscriptionId, fixedCharge.lago_id, version, units, effectiveAt, createdAt),
      ),
    ]);
    const subscription = await findBillableSubscription(env.BILLING_DB, subscriptionId);
    expect(subscription).not.toBeNull();
    const current = await calculateSubscriptionInvoice(
      env.BILLING_DB,
      subscription!,
      "prorated-current-invoice",
      "prorated-current-cycle",
      "2026-08-01T00:00:00.000Z",
      "2026-09-01T00:00:00.000Z",
    );
    expect(current.lines.find((line) => line.sourceId === fixedCharge.lago_id)).toMatchObject({
      units: "40",
      precise: "2290.3226",
      rounded: 2290,
    });
    const next = await calculateSubscriptionInvoice(
      env.BILLING_DB,
      subscription!,
      "prorated-next-invoice",
      "prorated-next-cycle",
      "2026-09-01T00:00:00.000Z",
      "2026-10-01T00:00:00.000Z",
    );
    expect(next.lines.find((line) => line.sourceId === fixedCharge.lago_id)).toMatchObject({
      units: "40",
      precise: "4000",
      rounded: 4000,
    });
    const termination = await calculateTerminationSubscriptionInvoice(
      env.BILLING_DB,
      subscription!,
      "prorated-termination-invoice",
      "prorated-termination",
      "2026-08-20T12:00:00.000Z",
      undefined,
      {
        periodStart: "2026-08-01T00:00:00.000Z",
        periodEnd: "2026-09-01T00:00:00.000Z",
      },
    );
    expect(termination.lines.find((line) => line.sourceId === fixedCharge.lago_id)).toMatchObject({
      units: "40",
      precise: "870.9678",
      rounded: 871,
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
