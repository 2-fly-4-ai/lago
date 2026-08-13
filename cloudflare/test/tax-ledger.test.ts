import { env, SELF } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { sha256Hex } from "../src/auth/api-key";

const apiKey = "tax-ledger-key";

beforeEach(async () => {
  const now = "2026-08-14T00:00:00.000Z";
  await env.BILLING_DB.batch([
    env.BILLING_DB.prepare(
      `INSERT OR IGNORE INTO organizations (id, external_id, name, created_at, updated_at)
       VALUES ('org-tax', 'tax-test', 'Tax Test', ?, ?)`,
    ).bind(now, now),
    env.BILLING_DB.prepare(
      `INSERT OR IGNORE INTO api_keys
       (id, organization_id, key_prefix, key_hash, created_at, revoked_at)
       VALUES ('key-tax', 'org-tax', 'tax-ledg', ?, ?, NULL)`,
    ).bind(await sha256Hex(apiKey), now),
    env.BILLING_DB.prepare(
      `INSERT OR IGNORE INTO customers
       (id, organization_id, external_id, currency, metadata_json, created_at, updated_at)
       VALUES ('customer-tax', 'org-tax', 'customer-tax-external', 'USD', '{}', ?, ?)`,
    ).bind(now, now),
  ]);
});

describe("manual tax ledger", () => {
  it("snapshots default taxes on the discounted base before applying later credits", async () => {
    const taxPayload = {
      tax: {
        code: "sales-tax",
        name: "Sales tax",
        rate: "8.25",
        description: "Synthetic manual tax",
        applied_to_organization: true,
      },
    };
    const created = await request("/api/v1/taxes", "POST", taxPayload);
    expect(created.status).toBe(200);
    const createdBody = await created.json<{ tax: { lago_id: string } }>();
    expect(createdBody.tax).toMatchObject({
      code: "sales-tax",
      rate: 8.25,
      applied_to_organization: true,
    });
    await expect(
      request("/api/v1/taxes", "POST", taxPayload).then((response) => response.json()),
    ).resolves.toMatchObject({ tax: { lago_id: createdBody.tax.lago_id } });

    expect(
      (
        await request("/api/v1/coupons", "POST", {
          coupon: {
            code: "TAX-DISCOUNT",
            name: "Tax discount",
            coupon_type: "fixed_amount",
            amount_cents: 100,
            amount_currency: "USD",
            frequency: "once",
            expiration: "no_expiration",
            reusable: true,
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
              external_customer_id: "customer-tax-external",
              coupon_code: "TAX-DISCOUNT",
            },
          },
          { "Idempotency-Key": "tax-discount-application" },
        )
      ).status,
    ).toBe(200);
    expect(
      (
        await request("/api/v1/plans", "POST", {
          plan: {
            code: "tax-plan",
            name: "Tax plan",
            interval: "monthly",
            amount_cents: 1000,
            amount_currency: "USD",
          },
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await request("/api/v1/subscriptions", "POST", {
          subscription: {
            external_customer_id: "customer-tax-external",
            external_id: "tax-subscription",
            plan_code: "tax-plan",
          },
        })
      ).status,
    ).toBe(200);
    const invoice = await env.BILLING_DB.prepare(
      `SELECT i.id FROM subscriptions s JOIN invoices i ON i.subscription_id = s.id
       WHERE s.organization_id = 'org-tax' AND s.external_id = 'tax-subscription' LIMIT 1`,
    ).first<{ id: string }>();
    expect(invoice).not.toBeNull();
    await expect(
      request(`/api/v1/invoices/${invoice!.id}`).then((response) => response.json()),
    ).resolves.toMatchObject({
      invoice: {
        fees_amount_cents: 1000,
        coupons_amount_cents: 100,
        taxes_amount_cents: 74,
        total_amount_cents: 974,
        applied_taxes: [
          {
            lago_tax_id: createdBody.tax.lago_id,
            tax_code: "sales-tax",
            tax_rate: 8.25,
            taxable_base_amount_cents: 900,
            amount_cents: 74,
            precise_amount_cents: "74.25",
          },
        ],
        fees: [
          {
            taxes_amount_cents: 74,
            applied_taxes: [
              {
                tax_code: "sales-tax",
                taxable_base_amount_cents: 900,
                precise_amount_cents: "74.25",
              },
            ],
          },
        ],
      },
    });

    const updated = await request("/api/v1/taxes/sales-tax", "PUT", {
      tax: { code: "sales-tax-updated", name: "Updated sales tax", rate: "9" },
    });
    expect(updated.status).toBe(200);
    await expect(updated.json()).resolves.toMatchObject({
      tax: { code: "sales-tax-updated", name: "Updated sales tax", rate: 9 },
    });
    await expect(
      request(`/api/v1/invoices/${invoice!.id}`).then((response) => response.json()),
    ).resolves.toMatchObject({
      invoice: { applied_taxes: [{ tax_code: "sales-tax", tax_rate: 8.25 }] },
    });

    const terminated = await request("/api/v1/taxes/sales-tax-updated", "DELETE");
    expect(terminated.status).toBe(200);
    await expect(
      request("/api/v1/taxes").then((response) => response.json()),
    ).resolves.toMatchObject({
      taxes: [],
      meta: { total_count: 0 },
    });
    expect((await request("/api/v1/taxes/sales-tax-updated")).status).toBe(404);
  });

  it("rejects unproved targeted and provider tax modes", async () => {
    const customer = await request("/api/v1/customers", "POST", {
      customer: { external_id: "targeted-tax", tax_codes: ["sales-tax"] },
    });
    expect(customer.status).toBe(422);
    await expect(customer.json()).resolves.toMatchObject({ code: "unsupported_tax_target" });
    const plan = await request("/api/v1/plans", "POST", {
      plan: {
        code: "targeted-tax-plan",
        name: "Targeted tax plan",
        interval: "monthly",
        amount_cents: 100,
        amount_currency: "USD",
        tax_codes: ["sales-tax"],
      },
    });
    expect(plan.status).toBe(422);
    await expect(plan.json()).resolves.toMatchObject({ code: "unsupported_tax_target" });
  });
});

function request(path: string, method = "GET", body?: unknown, headers?: Record<string, string>) {
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
