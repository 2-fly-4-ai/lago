import { env, SELF } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { sha256Hex } from "../src/auth/api-key";

const apiKey = "one-off-invoice-key";
const headers = { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" };

beforeEach(async () => {
  const now = "2026-08-14T00:00:00.000Z";
  await env.BILLING_DB.batch([
    env.BILLING_DB.prepare(
      `INSERT OR IGNORE INTO organizations (id, external_id, name, created_at, updated_at)
       VALUES ('org-one-off', 'one-off', 'One-off Test', ?, ?)`,
    ).bind(now, now),
    env.BILLING_DB.prepare(
      `INSERT OR IGNORE INTO api_keys
       (id, organization_id, key_prefix, key_hash, created_at, revoked_at)
       VALUES ('key-one-off', 'org-one-off', 'one-off', ?, ?, NULL)`,
    ).bind(await sha256Hex(apiKey), now),
    env.BILLING_DB.prepare(
      `INSERT OR IGNORE INTO customers
       (id, organization_id, external_id, name, currency, metadata_json, net_payment_term,
        version, created_at, updated_at)
       VALUES ('customer-one-off', 'org-one-off', 'customer-one-off', 'One-off Customer',
               'EUR', '{}', 14, 1, ?, ?)`,
    ).bind(now, now),
    env.BILLING_DB.prepare(
      `INSERT OR IGNORE INTO add_ons
       (id, organization_id, code, name, invoice_display_name, description, amount_minor,
        currency, status, version, request_sha256, created_at, updated_at)
       VALUES ('addon-one-off-first', 'org-one-off', 'first', 'First add-on', 'First display',
               'First description', 500, 'EUR', 'active', 1, 'hash-first', ?, ?)`,
    ).bind(now, now),
    env.BILLING_DB.prepare(
      `INSERT OR IGNORE INTO add_ons
       (id, organization_id, code, name, invoice_display_name, description, amount_minor,
        currency, status, version, request_sha256, created_at, updated_at)
       VALUES ('addon-one-off-second', 'org-one-off', 'second', 'Second add-on', NULL,
               'Second description', 400, 'EUR', 'active', 1, 'hash-second', ?, ?)`,
    ).bind(now, now),
    env.BILLING_DB.prepare(
      `INSERT OR IGNORE INTO taxes
       (id, organization_id, code, name, description, rate, applied_to_organization,
        status, version, request_sha256, created_at, updated_at)
       VALUES ('tax-one-off', 'org-one-off', 'vat-20', 'VAT 20%', NULL, '20', 1,
               'active', 1, 'hash-tax', ?, ?)`,
    ).bind(now, now),
  ]);
});

describe("one-off invoice ledger", () => {
  it("creates and replays a finalized add-on invoice with immutable tax snapshots", async () => {
    const body = {
      invoice: {
        external_customer_id: "customer-one-off",
        currency: "EUR",
        skip_psp: true,
        fees: [
          {
            add_on_code: "first",
            invoice_display_name: "Invoice item #1",
            unit_amount_cents: 1200,
            units: 2,
            description: "desc-123",
          },
          { add_on_code: "second" },
        ],
      },
    };
    const first = await request(body);
    expect(first.status).toBe(200);
    const firstBody = await first.json<{
      invoice: {
        lago_id: string;
        invoice_type: string;
        fees_amount_cents: number;
        taxes_amount_cents: number;
        total_amount_cents: number;
        issuing_date: string;
        payment_due_date: string;
        payment_overdue: boolean;
        net_payment_term: number;
        fees: Array<{ item: { code: string; invoice_display_name: string } }>;
        applied_taxes: Array<{ tax_code: string }>;
      };
    }>();
    expect(firstBody.invoice).toMatchObject({
      invoice_type: "one_off",
      fees_amount_cents: 2800,
      taxes_amount_cents: 560,
      total_amount_cents: 3360,
      net_payment_term: 14,
      payment_overdue: false,
      applied_taxes: [{ tax_code: "vat-20" }],
    });
    const expectedDueDate = new Date(`${firstBody.invoice.issuing_date}T00:00:00.000Z`);
    expectedDueDate.setUTCDate(expectedDueDate.getUTCDate() + 14);
    expect(firstBody.invoice.payment_due_date).toBe(expectedDueDate.toISOString().slice(0, 10));
    expect(firstBody.invoice.fees).toEqual([
      expect.objectContaining({
        item: expect.objectContaining({ code: "first", invoice_display_name: "Invoice item #1" }),
      }),
      expect.objectContaining({ item: expect.objectContaining({ code: "second" }) }),
    ]);

    const replay = await request(body);
    await expect(replay.json()).resolves.toMatchObject({
      invoice: { lago_id: firstBody.invoice.lago_id },
    });
    await expect(
      env.BILLING_DB.prepare(
        `SELECT COUNT(*) AS total FROM invoices
         WHERE organization_id = 'org-one-off' AND invoice_type = 'one_off'`,
      ).first(),
    ).resolves.toEqual({ total: 1 });
    await expect(
      env.BILLING_DB.prepare(
        `SELECT event_type, COUNT(*) AS total FROM outbox_events
         WHERE organization_id = 'org-one-off' AND event_type = 'invoice.one_off_created'`,
      ).first(),
    ).resolves.toEqual({ event_type: "invoice.one_off_created", total: 1 });
  });

  it("rejects automatic payment and targeted fee taxes until those workflows are ported", async () => {
    const automatic = await request({
      invoice: {
        external_customer_id: "customer-one-off",
        currency: "EUR",
        fees: [{ add_on_code: "first" }],
      },
    });
    expect(automatic.status).toBe(422);
    await expect(automatic.json()).resolves.toMatchObject({
      code: "automatic_payment_not_supported",
    });
    const targetedTax = await request({
      invoice: {
        external_customer_id: "customer-one-off",
        currency: "EUR",
        skip_psp: true,
        fees: [{ add_on_code: "first", tax_codes: ["vat-20"] }],
      },
    });
    expect(targetedTax.status).toBe(422);
    await expect(targetedTax.json()).resolves.toMatchObject({ code: "unsupported_tax_target" });
  });
});

function request(body: unknown) {
  return SELF.fetch("https://lago.test/api/v1/invoices", {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}
