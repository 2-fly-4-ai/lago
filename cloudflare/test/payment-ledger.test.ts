import { env, SELF } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { sha256Hex } from "../src/auth/api-key";
import { handlePaymentLedgerRequest } from "../src/api/payment-ledger";

const apiKey = "payment-ledger-api-key";
const headers = { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" };

beforeEach(async () => {
  const now = new Date().toISOString();
  await env.BILLING_DB.batch([
    env.BILLING_DB.prepare(
      `INSERT OR IGNORE INTO organizations (id, external_id, name, created_at, updated_at)
       VALUES ('org-payment-ledger', 'payment-ledger', 'Payment Ledger', ?, ?)`,
    ).bind(now, now),
    env.BILLING_DB.prepare(
      `INSERT OR IGNORE INTO api_keys
       (id, organization_id, key_prefix, key_hash, created_at, revoked_at)
       VALUES ('key-payment-ledger', 'org-payment-ledger', 'payment-ledger', ?, ?, NULL)`,
    ).bind(await sha256Hex(apiKey), now),
    env.BILLING_DB.prepare(
      `INSERT OR IGNORE INTO customers
       (id, organization_id, external_id, name, currency, metadata_json, version, created_at, updated_at)
       VALUES ('customer-payment-ledger', 'org-payment-ledger', 'customer-payment-ledger',
               'Payment Customer', 'USD', '{}', 1, ?, ?)`,
    ).bind(now, now),
    env.BILLING_DB.prepare(
      `INSERT OR IGNORE INTO invoices
       (id, organization_id, customer_id, number, status, payment_status, currency,
        subtotal_minor, tax_minor, credits_minor, total_due_minor, version,
        finalized_at, created_at, updated_at)
       VALUES ('invoice-payment-ledger', 'org-payment-ledger', 'customer-payment-ledger',
               'INV-PAYMENT', 'finalized', 'pending', 'USD', 1000, 0, 0, 1000, 1, ?, ?, ?)`,
    ).bind(now, now, now),
    env.BILLING_DB.prepare(
      "DELETE FROM payment_attempts WHERE organization_id = 'org-payment-ledger'",
    ),
    env.BILLING_DB.prepare(
      `DELETE FROM outbox_events WHERE organization_id = 'org-payment-ledger'
       AND event_type IN ('payment.recorded', 'invoice.payment_status_updated')`,
    ),
    env.BILLING_DB.prepare(
      `UPDATE invoices SET payment_status = 'pending', payment_overdue = 1, version = 1, updated_at = ?
       WHERE id = 'invoice-payment-ledger'`,
    ).bind(now),
  ]);
});

describe("payment ledger", () => {
  it("keeps manual payment recording behind the payment mutation kill switch", async () => {
    const response = await SELF.fetch("https://lago.test/api/v1/payments", {
      method: "POST",
      headers,
      body: JSON.stringify({
        payment: { invoice_id: "invoice-payment-ledger", amount_cents: 1000, reference: "wire" },
      }),
    });
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({ code: "payment_mutations_disabled" });
    const count = await env.BILLING_DB.prepare(
      "SELECT COUNT(*) AS total FROM payment_attempts WHERE organization_id = 'org-payment-ledger'",
    ).first<{ total: number }>();
    expect(count?.total).toBe(0);
  });

  it("isolates payment reads by organization and customer", async () => {
    const now = new Date().toISOString();
    await env.BILLING_DB.prepare(
      `INSERT INTO payment_attempts
       (id, organization_id, invoice_id, provider, provider_account_code,
        provider_transaction_id, idempotency_key, amount_minor, currency, status,
        payment_type, version, created_at, updated_at)
       VALUES ('payment-ledger-visible', 'org-payment-ledger', 'invoice-payment-ledger',
               'authorize_net', 'authorize-net-default', 'provider-transaction',
               'provider-payment', 1000, 'USD', 'succeeded', 'provider', 1, ?, ?)`,
    )
      .bind(now, now)
      .run();
    const response = await SELF.fetch(
      "https://lago.test/api/v1/customers/customer-payment-ledger/payments",
      { headers },
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      payments: [
        {
          lago_id: "payment-ledger-visible",
          invoice_numbers: ["INV-PAYMENT"],
          provider_payment_id: "provider-transaction",
        },
      ],
      meta: { total_count: 1 },
    });
    const missing = await SELF.fetch(
      "https://lago.test/api/v1/customers/unknown-customer/payments",
      { headers },
    );
    expect(missing.status).toBe(404);
  });

  it("records partial and final manual settlements idempotently when explicitly enabled", async () => {
    const testEnv = { ...env, PAYMENT_MUTATIONS_ENABLED: "1" } as unknown as Env;
    const auth = {
      organizationId: "org-payment-ledger",
      organizationExternalId: "payment-ledger",
      apiKeyId: "key-payment-ledger",
    };
    const record = (amount: number, reference: string) =>
      handlePaymentLedgerRequest(
        new Request("https://lago.test/api/v1/payments", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            payment: {
              invoice_id: "invoice-payment-ledger",
              amount_cents: amount,
              reference,
            },
          }),
        }),
        testEnv,
        auth,
        `request-${reference}`,
      );

    const linkTime = new Date().toISOString();
    await env.BILLING_DB.prepare(
      `INSERT INTO payment_links
       (invoice_id, provider, provider_account_code, payment_url, provider_token_sha256,
        expires_at, created_at, updated_at)
       VALUES ('invoice-payment-ledger', 'authorize_net', 'authorize-net-default',
               'https://lago.test/stale-payment-link', 'stale-token', NULL, ?, ?)`,
    )
      .bind(linkTime, linkTime)
      .run();

    const partial = await record(400, "wire-1");
    expect(partial?.status).toBe(200);
    const partialBody = await partial?.json<{ payment: { lago_id: string } }>();
    const replay = await record(400, "wire-1");
    await expect(replay?.json()).resolves.toMatchObject({
      payment: { lago_id: partialBody?.payment.lago_id },
    });
    await expect(
      env.BILLING_DB.prepare(
        `SELECT payment_status, payment_overdue, version FROM invoices
         WHERE id = 'invoice-payment-ledger'`,
      ).first(),
    ).resolves.toEqual({ payment_status: "pending", payment_overdue: 1, version: 2 });
    const partialInvoice = await SELF.fetch(
      "https://lago.test/api/v1/invoices/invoice-payment-ledger",
      { headers },
    );
    await expect(partialInvoice.json()).resolves.toMatchObject({
      invoice: { total_due_amount_cents: 600, total_paid_amount_cents: 400 },
    });
    await expect(
      env.BILLING_DB.prepare(
        "SELECT COUNT(*) AS total FROM payment_links WHERE invoice_id = 'invoice-payment-ledger'",
      ).first(),
    ).resolves.toEqual({ total: 0 });
    await expect(record(700, "wire-overpayment")).rejects.toMatchObject({
      code: "payment_amount_exceeds_due",
    });

    const final = await record(600, "wire-2");
    expect(final?.status).toBe(200);
    await expect(
      env.BILLING_DB.prepare(
        `SELECT payment_status, payment_overdue, version FROM invoices
         WHERE id = 'invoice-payment-ledger'`,
      ).first(),
    ).resolves.toEqual({ payment_status: "succeeded", payment_overdue: 0, version: 3 });
    const settledInvoice = await SELF.fetch(
      "https://lago.test/api/v1/invoices/invoice-payment-ledger",
      { headers },
    );
    await expect(settledInvoice.json()).resolves.toMatchObject({
      invoice: { total_due_amount_cents: 0, total_paid_amount_cents: 1000 },
    });
    const events = await env.BILLING_DB.prepare(
      `SELECT event_type, COUNT(*) AS total FROM outbox_events
       WHERE organization_id = 'org-payment-ledger'
         AND event_type IN ('payment.recorded', 'invoice.payment_status_updated')
       GROUP BY event_type ORDER BY event_type`,
    ).all();
    expect(events.results).toEqual([
      { event_type: "invoice.payment_status_updated", total: 1 },
      { event_type: "payment.recorded", total: 2 },
    ]);
  });
});
