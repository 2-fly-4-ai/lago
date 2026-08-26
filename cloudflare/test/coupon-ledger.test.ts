import { env, SELF } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { sha256Hex } from "../src/auth/api-key";
import { closeBillingPeriod } from "../src/billing/close-period";

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
  it("creates and replays fixed and plan-targeted coupons", async () => {
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

    expect(
      (
        await request("/api/v1/plans", "POST", {
          plan: {
            code: "coupon-target-plan",
            name: "Coupon target plan",
            interval: "monthly",
            amount_cents: 1000,
            amount_currency: "USD",
          },
        })
      ).status,
    ).toBe(200);
    const targeted = await request("/api/v1/coupons", "POST", {
      coupon: {
        ...payload.coupon,
        code: "TARGETED",
        applies_to: { plan_codes: ["coupon-target-plan"] },
      },
    });
    expect(targeted.status).toBe(200);
    await expect(targeted.json()).resolves.toMatchObject({
      coupon: {
        limited_plans: true,
        limited_billable_metrics: false,
        plan_codes: ["coupon-target-plan"],
      },
    });
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

  it("limits a coupon to its plan and taxes only the discounted matching base", async () => {
    for (const code of ["target-match", "target-miss"]) {
      expect(
        (
          await request("/api/v1/plans", "POST", {
            plan: {
              code,
              name: code,
              interval: "monthly",
              amount_cents: 1000,
              amount_currency: "USD",
              pay_in_advance: true,
            },
          })
        ).status,
      ).toBe(200);
    }
    expect(
      (
        await request("/api/v1/taxes", "POST", {
          tax: {
            code: "coupon-vat",
            name: "Coupon VAT",
            rate: 10,
            applied_to_organization: true,
          },
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await request("/api/v1/coupons", "POST", {
          coupon: {
            code: "MATCH-ONLY",
            name: "Match only",
            coupon_type: "percentage",
            percentage_rate: 50,
            frequency: "once",
            applies_to: { plan_codes: ["target-match"] },
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
              coupon_code: "MATCH-ONLY",
            },
          },
          { "Idempotency-Key": "apply-match-only" },
        )
      ).status,
    ).toBe(200);

    const miss = await createSubscription("coupon-target-miss-subscription", "target-miss");
    await expect(invoiceForSubscription(miss)).resolves.toEqual({
      coupons_minor: 0,
      tax_minor: 100,
      total_due_minor: 1100,
    });

    const match = await createSubscription("coupon-target-match-subscription", "target-match");
    await expect(invoiceForSubscription(match)).resolves.toEqual({
      coupons_minor: 500,
      tax_minor: 50,
      total_due_minor: 550,
    });
    await expect(
      env.BILLING_DB.prepare(
        `SELECT allocation.amount_minor, line.line_type
         FROM coupon_credit_lines allocation
         JOIN invoice_lines line ON line.id = allocation.invoice_line_id
         JOIN invoices invoice ON invoice.id = allocation.invoice_id
         WHERE invoice.subscription_id = ?`,
      )
        .bind(match)
        .first(),
    ).resolves.toEqual({ amount_minor: 500, line_type: "subscription" });
  });

  it("limits a coupon to matching billable-metric lines", async () => {
    const metricIds = new Map<string, string>();
    for (const code of ["coupon-metric-match", "coupon-metric-miss"]) {
      const response = await request("/api/v1/billable_metrics", "POST", {
        billable_metric: { code, name: code, aggregation_type: "count_agg" },
      });
      expect(response.status, await response.clone().text()).toBe(200);
      const body = await response.json<{ billable_metric: { lago_id: string } }>();
      metricIds.set(code, body.billable_metric.lago_id);
    }
    expect(
      (
        await request("/api/v1/plans", "POST", {
          plan: {
            code: "coupon-metric-plan",
            name: "Coupon metric plan",
            interval: "monthly",
            amount_cents: 100,
            amount_currency: "USD",
          },
        })
      ).status,
    ).toBe(200);
    for (const [code, metricId] of metricIds) {
      expect(
        (
          await request("/api/v1/plans/coupon-metric-plan/charges", "POST", {
            charge: {
              code: `${code}-charge`,
              billable_metric_id: metricId,
              charge_model: "standard",
              properties: { amount: "100" },
            },
          })
        ).status,
      ).toBe(200);
    }
    expect(
      (
        await request("/api/v1/coupons", "POST", {
          coupon: {
            code: "METRIC-ONLY",
            name: "Metric only",
            coupon_type: "percentage",
            percentage_rate: 50,
            frequency: "once",
            applies_to: { billable_metric_codes: ["coupon-metric-match"] },
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
              coupon_code: "METRIC-ONLY",
            },
          },
          { "Idempotency-Key": "apply-metric-only" },
        )
      ).status,
    ).toBe(200);
    const subscriptionResponse = await request("/api/v1/subscriptions", "POST", {
      subscription: {
        external_customer_id: "customer-coupon-external",
        external_id: "coupon-metric-subscription",
        plan_code: "coupon-metric-plan",
      },
    });
    expect(subscriptionResponse.status, await subscriptionResponse.clone().text()).toBe(200);
    const subscription = await subscriptionResponse.json<{
      subscription: {
        lago_id: string;
        status: string;
        started_at: string;
        current_billing_period_ending_at: string;
      };
    }>();
    expect(subscription.subscription.status).toBe("active");
    for (const code of metricIds.keys()) {
      const event = await request("/api/v1/events", "POST", {
        event: {
          transaction_id: `${code}-event`,
          external_subscription_id: "coupon-metric-subscription",
          code,
          timestamp: Math.floor(Date.parse(subscription.subscription.started_at) / 1000) + 1,
          properties: {},
        },
      });
      expect(event.status, await event.clone().text()).toBe(200);
    }
    const close = await closeBillingPeriod(
      env,
      subscription.subscription.lago_id,
      subscription.subscription.current_billing_period_ending_at,
      "coupon-metric-close",
    );
    expect(close).toMatchObject({ lineCount: 3 });
    await expect(
      env.BILLING_DB.prepare("SELECT coupons_minor FROM invoices WHERE id = ?")
        .bind(close.invoiceId)
        .first(),
    ).resolves.toEqual({ coupons_minor: 50 });
    await expect(
      env.BILLING_DB.prepare(
        `SELECT allocation.amount_minor, metric.code
         FROM coupon_credit_lines allocation
         JOIN invoice_lines line ON line.id = allocation.invoice_line_id
         JOIN charges charge ON charge.id = line.source_id
         JOIN billable_metrics metric ON metric.id = charge.billable_metric_id
         WHERE allocation.invoice_id = ?`,
      )
        .bind(close.invoiceId)
        .all(),
    ).resolves.toMatchObject({
      results: [{ amount_minor: 50, code: "coupon-metric-match" }],
    });
  });
});

async function createSubscription(externalId: string, planCode: string): Promise<string> {
  const response = await request("/api/v1/subscriptions", "POST", {
    subscription: {
      external_customer_id: "customer-coupon-external",
      external_id: externalId,
      plan_code: planCode,
    },
  });
  expect(response.status, await response.clone().text()).toBe(200);
  const body = await response.json<{ subscription: { lago_id: string } }>();
  return body.subscription.lago_id;
}

async function invoiceForSubscription(subscriptionId: string) {
  return env.BILLING_DB.prepare(
    `SELECT coupons_minor, tax_minor, total_due_minor
     FROM invoices WHERE subscription_id = ? ORDER BY created_at DESC LIMIT 1`,
  )
    .bind(subscriptionId)
    .first();
}

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
