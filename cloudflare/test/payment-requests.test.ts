import { env, SELF } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { sha256Hex } from "../src/auth/api-key";

const apiKey = "payment-request-api-key";
const headers = { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" };

beforeEach(async () => {
  const now = "2026-08-15T03:30:00.000Z";
  await env.BILLING_DB.batch([
    env.BILLING_DB.prepare(
      `INSERT OR IGNORE INTO organizations (id, external_id, name, created_at, updated_at)
       VALUES ('org-payment-request', 'payment-request', 'Payment Request', ?, ?)`,
    ).bind(now, now),
    env.BILLING_DB.prepare(
      `INSERT OR IGNORE INTO organizations (id, external_id, name, created_at, updated_at)
       VALUES ('org-payment-request-other', 'payment-request-other', 'Other', ?, ?)`,
    ).bind(now, now),
    env.BILLING_DB.prepare(
      `INSERT OR IGNORE INTO api_keys
       (id, organization_id, key_prefix, key_hash, created_at, revoked_at)
       VALUES ('key-payment-request', 'org-payment-request', 'payment-request', ?, ?, NULL)`,
    ).bind(await sha256Hex(apiKey), now),
    env.BILLING_DB.prepare(
      `INSERT OR IGNORE INTO customers
       (id, organization_id, external_id, email, name, currency, metadata_json, version,
        created_at, updated_at)
       VALUES ('customer-payment-request', 'org-payment-request', 'customer-payment-request',
               'BILLING@EXAMPLE.COM', 'Payment Customer', 'USD', '{}', 1, ?, ?)`,
    ).bind(now, now),
    env.BILLING_DB.prepare(
      `INSERT OR IGNORE INTO customers
       (id, organization_id, external_id, name, currency, metadata_json, version, created_at,
        updated_at)
       VALUES ('customer-payment-request-second', 'org-payment-request',
               'customer-payment-request-second', 'Second Customer', 'USD', '{}', 1, ?, ?)`,
    ).bind(now, now),
    env.BILLING_DB.prepare(
      `INSERT OR IGNORE INTO customers
       (id, organization_id, external_id, name, currency, metadata_json, version, created_at,
        updated_at)
       VALUES ('customer-payment-request-other', 'org-payment-request-other',
               'customer-payment-request-other', 'Other Customer', 'USD', '{}', 1, ?, ?)`,
    ).bind(now, now),
    invoiceStatement("invoice-payment-request-one", "customer-payment-request", "USD", 1000, now),
    invoiceStatement("invoice-payment-request-two", "customer-payment-request", "USD", 700, now),
    invoiceStatement(
      "invoice-payment-request-customer-mismatch",
      "customer-payment-request-second",
      "USD",
      500,
      now,
    ),
    env.BILLING_DB.prepare(
      `INSERT OR IGNORE INTO invoices
       (id, organization_id, customer_id, number, status, payment_status, currency,
        subtotal_minor, tax_minor, credits_minor, total_due_minor, version, finalized_at,
        payment_overdue, created_at, updated_at)
       VALUES ('invoice-payment-request-other', 'org-payment-request-other',
               'customer-payment-request-other', 'INV-OTHER', 'finalized', 'pending', 'USD',
               900, 0, 0, 900, 1, ?, 1, ?, ?)`,
    ).bind(now, now, now),
    env.BILLING_DB.prepare(
      `DELETE FROM outbox_events WHERE organization_id = 'org-payment-request'
       AND event_type = 'payment_request.created'`,
    ),
    env.BILLING_DB.prepare(
      `DELETE FROM payment_requests WHERE organization_id = 'org-payment-request'`,
    ),
    env.BILLING_DB.prepare(
      `DELETE FROM payment_attempts WHERE organization_id = 'org-payment-request'`,
    ),
    env.BILLING_DB.prepare(
      `UPDATE invoices SET payment_status = 'pending', payment_overdue = 1,
                           ready_for_payment_processing = 1, version = 1, updated_at = ?
       WHERE organization_id = 'org-payment-request'`,
    ).bind(now),
  ]);
});

describe("payment requests", () => {
  it("creates an internal multi-invoice request without invoking a payment provider", async () => {
    const response = await createRequest([
      "invoice-payment-request-one",
      "invoice-payment-request-two",
    ]);
    expect(response.status).toBe(200);
    const body = await response.json<{
      payment_request: {
        lago_id: string;
        amount_cents: number;
        amount_currency: string;
        email: string;
        payment_status: string;
        customer: { external_id: string };
        invoices: Array<{ lago_id: string; total_due_amount_cents: number }>;
      };
    }>();
    expect(body.payment_request).toMatchObject({
      amount_cents: 1700,
      amount_currency: "USD",
      email: "billing@example.com",
      payment_status: "pending",
      customer: { external_id: "customer-payment-request" },
    });
    expect(body.payment_request.invoices).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          lago_id: "invoice-payment-request-one",
          total_due_amount_cents: 1000,
        }),
        expect.objectContaining({
          lago_id: "invoice-payment-request-two",
          total_due_amount_cents: 700,
        }),
      ]),
    );
    await expect(
      env.BILLING_DB.prepare(
        `SELECT COUNT(*) AS total FROM invoices_payment_requests WHERE payment_request_id = ?`,
      )
        .bind(body.payment_request.lago_id)
        .first(),
    ).resolves.toEqual({ total: 2 });
    await expect(
      env.BILLING_DB.prepare(
        `SELECT COUNT(*) AS total FROM payment_attempts
         WHERE organization_id = 'org-payment-request'`,
      ).first(),
    ).resolves.toEqual({ total: 0 });
    await expect(
      env.BILLING_DB.prepare(
        `SELECT event_type, aggregate_type, aggregate_id FROM outbox_events
         WHERE organization_id = 'org-payment-request' AND event_type = 'payment_request.created'`,
      ).first(),
    ).resolves.toEqual({
      event_type: "payment_request.created",
      aggregate_type: "payment_request",
      aggregate_id: body.payment_request.lago_id,
    });

    const shown = await SELF.fetch(
      `https://lago.test/api/v1/payment_requests/${body.payment_request.lago_id}`,
      { headers },
    );
    expect(shown.status).toBe(200);
    await expect(shown.json()).resolves.toMatchObject({
      payment_request: { lago_id: body.payment_request.lago_id, amount_cents: 1700 },
    });
    const nested = await SELF.fetch(
      "https://lago.test/api/v1/customers/customer-payment-request/payment_requests?payment_status=pending&currency=usd",
      { headers },
    );
    await expect(nested.json()).resolves.toMatchObject({
      payment_requests: [{ lago_id: body.payment_request.lago_id }],
      meta: { current_page: 1, total_count: 1, total_pages: 1 },
    });
  });

  it("rejects unknown, cross-tenant, mismatched-customer, non-overdue, and mixed-currency invoices", async () => {
    expect((await createRequest(["missing-invoice"])).status).toBe(404);
    expect((await createRequest(["invoice-payment-request-other"])).status).toBe(404);
    const mismatch = await createRequest(["invoice-payment-request-customer-mismatch"]);
    expect(mismatch.status).toBe(422);
    await expect(mismatch.json()).resolves.toMatchObject({ code: "invoice_customer_mismatch" });

    await env.BILLING_DB.prepare(
      `UPDATE invoices SET payment_overdue = 0 WHERE id = 'invoice-payment-request-one'`,
    ).run();
    const current = await createRequest(["invoice-payment-request-one"]);
    await expect(current.json()).resolves.toMatchObject({ code: "invoices_not_overdue" });
    await env.BILLING_DB.prepare(
      `UPDATE invoices SET payment_overdue = 1, ready_for_payment_processing = 0
       WHERE id = 'invoice-payment-request-one'`,
    ).run();
    const paused = await createRequest(["invoice-payment-request-one"]);
    await expect(paused.json()).resolves.toMatchObject({
      code: "invoices_not_ready_for_payment_processing",
    });
    await env.BILLING_DB.prepare(
      `UPDATE invoices SET ready_for_payment_processing = 1, currency = 'EUR'
       WHERE id = 'invoice-payment-request-one'`,
    ).run();
    const mixed = await createRequest([
      "invoice-payment-request-one",
      "invoice-payment-request-two",
    ]);
    await expect(mixed.json()).resolves.toMatchObject({
      code: "invoices_have_different_currencies",
    });
    await expect(
      env.BILLING_DB.prepare(
        `SELECT COUNT(*) AS total FROM payment_requests
         WHERE organization_id = 'org-payment-request'`,
      ).first(),
    ).resolves.toEqual({ total: 0 });
  });

  it("allows immediate checkout collection for a finalized zero-term invoice", async () => {
    await env.BILLING_DB.prepare(
      `UPDATE invoices
       SET payment_overdue = 0, net_payment_term = 0, payment_due_date = '2026-08-15'
       WHERE id = 'invoice-payment-request-one'`,
    ).run();
    const response = await createRequest(["invoice-payment-request-one"], "checkout");
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      payment_request: {
        amount_cents: 1000,
        payment_status: "pending",
      },
    });
  });

  it("rolls back a request if a linked invoice version or ownership changes", async () => {
    const now = "2026-08-15T03:31:00.000Z";
    await expect(
      env.BILLING_DB.batch([
        env.BILLING_DB.prepare(
          `INSERT INTO payment_requests
           (id, organization_id, customer_id, amount_minor, currency, payment_status,
            ready_for_payment_processing, version, created_at, updated_at)
           VALUES ('payment-request-stale', 'org-payment-request', 'customer-payment-request',
                   1000, 'USD', 'pending', 1, 1, ?, ?)`,
        ).bind(now, now),
        env.BILLING_DB.prepare(
          `INSERT INTO invoices_payment_requests
           (id, organization_id, payment_request_id, invoice_id, invoice_version, created_at,
            updated_at)
           VALUES ('link-payment-request-stale', 'org-payment-request', 'payment-request-stale',
                   'invoice-payment-request-one', 999, ?, ?)`,
        ).bind(now, now),
      ]),
    ).rejects.toThrow();
    await expect(
      env.BILLING_DB.prepare(
        `SELECT COUNT(*) AS total FROM payment_requests WHERE id = 'payment-request-stale'`,
      ).first(),
    ).resolves.toEqual({ total: 0 });
  });
});

function createRequest(invoiceIds: string[], collectionMode?: "checkout") {
  return SELF.fetch("https://lago.test/api/v1/payment_requests", {
    method: "POST",
    headers,
    body: JSON.stringify({
      payment_request: {
        external_customer_id: "customer-payment-request",
        lago_invoice_ids: invoiceIds,
        ...(collectionMode ? { collection_mode: collectionMode } : {}),
      },
    }),
  });
}

function invoiceStatement(
  id: string,
  customerId: string,
  currency: string,
  amountMinor: number,
  now: string,
) {
  return env.BILLING_DB.prepare(
    `INSERT OR IGNORE INTO invoices
     (id, organization_id, customer_id, number, status, payment_status, currency,
      subtotal_minor, tax_minor, credits_minor, total_due_minor, version, finalized_at,
      payment_overdue, created_at, updated_at)
     VALUES (?, 'org-payment-request', ?, ?, 'finalized', 'pending', ?, ?, 0, 0, ?, 1, ?, 1, ?, ?)`,
  ).bind(id, customerId, `INV-${id}`, currency, amountMinor, amountMinor, now, now, now);
}
