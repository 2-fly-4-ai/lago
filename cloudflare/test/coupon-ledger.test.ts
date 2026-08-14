import { env, SELF } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { sha256Hex } from "../src/auth/api-key";

const apiKey = "coupon-ledger-key";

beforeEach(async () => {
  const now = "2026-08-13T00:00:00.000Z";
  await env.BILLING_DB.batch([
    env.BILLING_DB.prepare("DELETE FROM coupon_credits WHERE organization_id = 'org-coupon'"),
    env.BILLING_DB.prepare("DELETE FROM applied_coupons WHERE organization_id = 'org-coupon'"),
    env.BILLING_DB.prepare("DELETE FROM coupons WHERE organization_id = 'org-coupon'"),
    env.BILLING_DB.prepare(
      `DELETE FROM outbox_events WHERE organization_id = 'org-coupon'
       AND aggregate_type IN ('coupon', 'applied_coupon')`,
    ),
  ]);
  await env.BILLING_DB.batch([
    env.BILLING_DB.prepare(
      `INSERT OR IGNORE INTO organizations (id, external_id, name, created_at, updated_at)
       VALUES ('org-coupon', 'coupon-test', 'Coupon Test', ?, ?)`,
    ).bind(now, now),
    env.BILLING_DB.prepare(
      `INSERT OR IGNORE INTO api_keys
       (id, organization_id, key_prefix, key_hash, created_at, revoked_at)
       VALUES ('key-coupon', 'org-coupon', 'coupon-l', ?, ?, NULL)`,
    ).bind(await sha256Hex(apiKey), now),
    env.BILLING_DB.prepare(
      `INSERT OR IGNORE INTO customers
       (id, organization_id, external_id, currency, metadata_json, created_at, updated_at)
       VALUES ('customer-coupon', 'org-coupon', 'customer-coupon-external', 'USD', '{}', ?, ?)`,
    ).bind(now, now),
  ]);
});

describe("coupon ledger API", () => {
  it("creates and replays a fixed coupon while rejecting targeted allocation", async () => {
    const payload = {
      coupon: {
        code: "WELCOME",
        name: "Welcome",
        coupon_type: "fixed_amount",
        amount_cents: 500,
        amount_currency: "usd",
        frequency: "once",
        expiration: "no_expiration",
        reusable: false,
      },
    };
    const first = await request("/api/v1/coupons", "POST", payload);
    expect(first.status).toBe(200);
    await expect(first.json()).resolves.toMatchObject({
      coupon: {
        code: "WELCOME",
        amount_cents: 500,
        amount_currency: "USD",
        reusable: false,
      },
    });
    expect((await request("/api/v1/coupons", "POST", payload)).status).toBe(200);
    const count = await env.BILLING_DB.prepare(
      "SELECT COUNT(*) AS total FROM coupons WHERE organization_id = 'org-coupon' AND code = 'WELCOME'",
    ).first<{ total: number }>();
    expect(count?.total).toBe(1);
    await expect(
      env.BILLING_DB.prepare(
        "SELECT COUNT(*) AS total FROM outbox_events WHERE event_type = 'coupon.created'",
      ).first(),
    ).resolves.toEqual({ total: 1 });

    const targeted = await request("/api/v1/coupons", "POST", {
      coupon: {
        ...payload.coupon,
        code: "TARGETED",
        applies_to: { plan_codes: ["plan"] },
      },
    });
    expect(targeted.status).toBe(422);
    await expect(targeted.json()).resolves.toMatchObject({ code: "unsupported_coupon_targets" });
  });

  it("applies a snapshotted recurring coupon idempotently and terminates it", async () => {
    await createPercentageCoupon("RECURRING", 10, "recurring", 2);
    const payload = {
      applied_coupon: {
        external_customer_id: "customer-coupon-external",
        coupon_code: "RECURRING",
      },
    };
    const first = await request("/api/v1/applied_coupons", "POST", payload, {
      "Idempotency-Key": "apply-recurring",
    });
    expect(first.status).toBe(200);
    const firstBody = await first.json<{ applied_coupon: { lago_id: string } }>();
    expect(firstBody.applied_coupon).toMatchObject({
      percentage_rate: "10",
      frequency_duration: 2,
      frequency_duration_remaining: 2,
      status: "active",
    });
    const replay = await request("/api/v1/applied_coupons", "POST", payload, {
      "Idempotency-Key": "apply-recurring",
    });
    await expect(replay.json()).resolves.toMatchObject({
      applied_coupon: { lago_id: firstBody.applied_coupon.lago_id },
    });

    const listed = await request(
      "/api/v1/customers/customer-coupon-external/applied_coupons?status=active",
    );
    await expect(listed.json()).resolves.toMatchObject({
      applied_coupons: [{ lago_id: firstBody.applied_coupon.lago_id }],
      meta: { total_count: 1 },
    });

    const terminated = await request(
      `/api/v1/customers/customer-coupon-external/applied_coupons/${firstBody.applied_coupon.lago_id}`,
      "DELETE",
    );
    expect(terminated.status).toBe(200);
    await expect(terminated.json()).resolves.toMatchObject({
      applied_coupon: { status: "terminated" },
    });
    await expect(
      env.BILLING_DB.prepare(
        `SELECT COUNT(*) AS total FROM outbox_events
         WHERE aggregate_id = ? AND event_type IN ('applied_coupon.created', 'applied_coupon.terminated')`,
      )
        .bind(firstBody.applied_coupon.lago_id)
        .first(),
    ).resolves.toEqual({ total: 2 });
  });

  it("rejects a non-reusable coupon after its first customer application", async () => {
    await request("/api/v1/coupons", "POST", {
      coupon: {
        code: "SINGLE",
        name: "Single",
        coupon_type: "fixed_amount",
        amount_cents: 100,
        amount_currency: "USD",
        frequency: "once",
        reusable: false,
      },
    });
    const payload = {
      applied_coupon: {
        external_customer_id: "customer-coupon-external",
        coupon_code: "SINGLE",
      },
    };
    expect((await request("/api/v1/applied_coupons", "POST", payload)).status).toBe(200);
    const duplicate = await request("/api/v1/applied_coupons", "POST", payload);
    expect(duplicate.status).toBe(422);
    await expect(duplicate.json()).resolves.toMatchObject({ code: "coupon_is_not_reusable" });
  });

  it("applies coupon credits to the initial subscription invoice", async () => {
    expect(
      (
        await request("/api/v1/plans", "POST", {
          plan: {
            code: "coupon-plan",
            name: "Coupon plan",
            interval: "monthly",
            amount_cents: 1000,
            amount_currency: "USD",
            pay_in_advance: true,
          },
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await request("/api/v1/coupons", "POST", {
          coupon: {
            code: "FIRST-BILL",
            name: "First bill",
            coupon_type: "percentage",
            percentage_rate: "12.5",
            frequency: "once",
          },
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await request(
          "/api/v1/applied_coupons",
          "POST",
          {
            applied_coupon: {
              external_customer_id: "customer-coupon-external",
              coupon_code: "FIRST-BILL",
            },
          },
          { "Idempotency-Key": "apply-first-bill" },
        )
      ).status,
    ).toBe(200);

    const subscription = await request("/api/v1/subscriptions", "POST", {
      subscription: {
        external_customer_id: "customer-coupon-external",
        external_id: "coupon-subscription",
        plan_code: "coupon-plan",
      },
    });
    expect(subscription.status).toBe(200);
    const invoices = await request(
      "/api/v1/invoices?external_customer_id=customer-coupon-external",
    );
    const invoiceList = await invoices.json<{
      invoices: Array<{
        lago_id: string;
        coupons_amount_cents: number;
        total_amount_cents: number;
      }>;
    }>();
    expect(invoiceList.invoices[0]).toMatchObject({
      coupons_amount_cents: 125,
      total_amount_cents: 875,
    });
    const shown = await request(`/api/v1/invoices/${invoiceList.invoices[0]?.lago_id}`);
    await expect(shown.json()).resolves.toMatchObject({
      invoice: {
        coupons_amount_cents: 125,
        credit_notes_amount_cents: 0,
        credits: [{ amount_cents: 125, item: { code: "FIRST-BILL", type: "coupon" } }],
      },
    });
  });
});

async function createPercentageCoupon(
  code: string,
  rate: number,
  frequency: string,
  frequencyDuration?: number,
): Promise<void> {
  const response = await request("/api/v1/coupons", "POST", {
    coupon: {
      code,
      name: code,
      coupon_type: "percentage",
      percentage_rate: rate,
      frequency,
      frequency_duration: frequencyDuration,
      reusable: true,
    },
  });
  expect(response.status).toBe(200);
}

function request(
  path: string,
  method = "GET",
  body?: unknown,
  headers?: Record<string, string>,
): Promise<Response> {
  return SELF.fetch(`https://lago.test${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      ...(body ? { "Content-Type": "application/json" } : {}),
      ...headers,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
}
