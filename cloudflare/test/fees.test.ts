import { env, SELF } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { sha256Hex } from "../src/auth/api-key";

const apiKey = "fees-test-key";
const otherApiKey = "fees-other-key";
const headers = { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" };

beforeEach(async () => {
  const now = "2026-08-15T00:00:00.000Z";
  await env.BILLING_DB.batch([
    env.BILLING_DB.prepare(
      `INSERT OR IGNORE INTO organizations (id, external_id, name, created_at, updated_at)
       VALUES ('org-fees', 'fees', 'Fees', ?, ?)`,
    ).bind(now, now),
    env.BILLING_DB.prepare(
      `INSERT OR IGNORE INTO api_keys
       (id, organization_id, key_prefix, key_hash, created_at, revoked_at)
       VALUES ('key-fees', 'org-fees', 'fees', ?, ?, NULL)`,
    ).bind(await sha256Hex(apiKey), now),
    env.BILLING_DB.prepare(
      `INSERT OR IGNORE INTO organizations (id, external_id, name, created_at, updated_at)
       VALUES ('org-fees-other', 'fees-other', 'Fees Other', ?, ?)`,
    ).bind(now, now),
    env.BILLING_DB.prepare(
      `INSERT OR IGNORE INTO api_keys
       (id, organization_id, key_prefix, key_hash, created_at, revoked_at)
       VALUES ('key-fees-other', 'org-fees-other', 'fees-other', ?, ?, NULL)`,
    ).bind(await sha256Hex(otherApiKey), now),
  ]);

  expect(
    (
      await SELF.fetch("https://lago.test/api/v1/plans", {
        method: "POST",
        headers,
        body: JSON.stringify({
          plan: {
            name: "Fees monthly",
            code: "fees-monthly",
            interval: "monthly",
            amount_cents: 1000,
            amount_currency: "USD",
            pay_in_advance: true,
          },
        }),
      })
    ).status,
  ).toBe(200);
  expect(
    (
      await SELF.fetch("https://lago.test/api/v1/customers", {
        method: "POST",
        headers,
        body: JSON.stringify({
          customer: {
            external_id: "fees-customer",
            name: "Fees Customer",
            currency: "USD",
          },
        }),
      })
    ).status,
  ).toBe(200);
  expect(
    (
      await SELF.fetch("https://lago.test/api/v1/subscriptions", {
        method: "POST",
        headers,
        body: JSON.stringify({
          subscription: {
            external_customer_id: "fees-customer",
            external_id: "fees-subscription",
            plan_code: "fees-monthly",
            name: "Fees Subscription",
          },
        }),
      })
    ).status,
  ).toBe(200);
});

describe("fee compatibility API", () => {
  it("lists, filters, and shows tenant-scoped immutable invoice fees", async () => {
    const listed = await api("/api/v1/fees?external_customer_id=fees-customer&currency=usd");
    expect(listed.status).toBe(200);
    const body = await listed.json<{
      fees: Array<{
        lago_id: string;
        lago_invoice_id: string;
        external_subscription_id: string;
        external_customer_id: string;
        amount_cents: number;
        amount_currency: string;
        total_amount_cents: number;
        payment_status: string;
        item: { type: string };
      }>;
      meta: { total_count: number };
    }>();
    expect(body.meta.total_count).toBe(1);
    expect(body.fees[0]).toMatchObject({
      external_subscription_id: "fees-subscription",
      external_customer_id: "fees-customer",
      amount_cents: 1000,
      amount_currency: "USD",
      total_amount_cents: 1000,
      payment_status: "pending",
    });

    const shown = await api(`/api/v1/fees/${body.fees[0]!.lago_id}`);
    expect(shown.status).toBe(200);
    await expect(shown.json()).resolves.toMatchObject({
      fee: {
        lago_id: body.fees[0]!.lago_id,
        lago_invoice_id: body.fees[0]!.lago_invoice_id,
        precise_amount: 10,
        units: "1",
        applied_taxes: [],
      },
    });

    const matchingType = await api(
      `/api/v1/fees?fee_type=${encodeURIComponent(body.fees[0]!.item.type)}`,
    );
    await expect(matchingType.json()).resolves.toMatchObject({ meta: { total_count: 1 } });
    const missing = await api("/api/v1/fees?external_customer_id=missing");
    await expect(missing.json()).resolves.toMatchObject({ fees: [], meta: { total_count: 0 } });
  });

  it("returns tax snapshots without crossing tenants or allowing line mutation", async () => {
    const first = await api("/api/v1/fees");
    const firstBody = await first.json<{
      fees: Array<{ lago_id: string; lago_invoice_id: string }>;
    }>();
    const fee = firstBody.fees[0]!;
    const now = "2026-08-15T00:01:00.000Z";
    await env.BILLING_DB.batch([
      env.BILLING_DB.prepare(
        `INSERT INTO taxes
         (id, organization_id, code, name, description, rate, applied_to_organization, status,
          version, request_sha256, created_at, updated_at, terminated_at)
         VALUES ('tax-fees', 'org-fees', 'vat', 'VAT', 'Synthetic VAT', '10', 0, 'active',
                 1, 'tax-fees-request', ?, ?, NULL)`,
      ).bind(now, now),
      env.BILLING_DB.prepare(
        `INSERT INTO invoice_line_taxes
         (id, organization_id, invoice_id, invoice_line_id, tax_id, tax_code, tax_name,
          tax_description, tax_rate, taxable_base_minor, amount_minor, precise_amount_minor,
          currency, created_at)
         VALUES ('line-tax-fees', 'org-fees', ?, ?, 'tax-fees', 'vat', 'VAT',
                 'Synthetic VAT', '10', 1000, 100, '100', 'USD', ?)`,
      ).bind(fee.lago_invoice_id, fee.lago_id, now),
    ]);

    const shown = await api(`/api/v1/fees/${fee.lago_id}`);
    await expect(shown.json()).resolves.toMatchObject({
      fee: {
        taxes_amount_cents: 100,
        total_amount_cents: 1100,
        applied_taxes: [
          {
            lago_id: "line-tax-fees",
            lago_tax_id: "tax-fees",
            tax_code: "vat",
            amount_cents: 100,
          },
        ],
      },
    });

    const other = await SELF.fetch(`https://lago.test/api/v1/fees/${fee.lago_id}`, {
      headers: { Authorization: `Bearer ${otherApiKey}` },
    });
    expect(other.status).toBe(404);
    await expect(other.json()).resolves.toMatchObject({ code: "fee_not_found" });

    const mutation = await api(`/api/v1/fees/${fee.lago_id}`, "PUT", {
      fee: { payment_status: "succeeded" },
    });
    expect(mutation.status).toBe(422);
    await expect(mutation.json()).resolves.toMatchObject({ code: "unsupported_fee_mutation" });
  });

  it("validates pagination and timestamp filters", async () => {
    const pagination = await api("/api/v1/fees?page=0");
    expect(pagination.status).toBe(422);
    await expect(pagination.json()).resolves.toMatchObject({ code: "validation_error" });

    const timestamp = await api("/api/v1/fees?created_at_from=not-a-date");
    expect(timestamp.status).toBe(422);
    await expect(timestamp.json()).resolves.toMatchObject({ code: "validation_error" });
  });
});

function api(path: string, method = "GET", body?: unknown): Promise<Response> {
  return SELF.fetch(`https://lago.test${path}`, {
    method,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}
