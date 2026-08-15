import { env, SELF } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { sha256Hex } from "../src/auth/api-key";
import { handlePaymentLedgerRequest } from "../src/api/payment-ledger";

const apiKey = "payment-receipt-api-key";
const headers = { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" };

beforeEach(async () => {
  const now = "2026-08-15T00:00:00.000Z";
  await env.BILLING_DB.batch([
    env.BILLING_DB.prepare(
      `DELETE FROM outbox_events WHERE organization_id = 'org-payment-receipt-api'`,
    ),
    env.BILLING_DB.prepare(
      `DELETE FROM payment_receipts WHERE organization_id = 'org-payment-receipt-api'`,
    ),
    env.BILLING_DB.prepare(
      `DELETE FROM payment_request_payment_allocations
       WHERE organization_id = 'org-payment-receipt-api'`,
    ),
    env.BILLING_DB.prepare(
      `DELETE FROM payment_request_payments WHERE organization_id = 'org-payment-receipt-api'`,
    ),
    env.BILLING_DB.prepare(
      `DELETE FROM invoices_payment_requests WHERE organization_id = 'org-payment-receipt-api'`,
    ),
    env.BILLING_DB.prepare(
      `DELETE FROM payment_requests WHERE organization_id = 'org-payment-receipt-api'`,
    ),
    env.BILLING_DB.prepare(
      `DELETE FROM payment_attempts WHERE organization_id = 'org-payment-receipt-api'`,
    ),
    env.BILLING_DB.prepare(
      `DELETE FROM invoices WHERE organization_id = 'org-payment-receipt-api'`,
    ),
    env.BILLING_DB.prepare(
      `DELETE FROM api_keys WHERE organization_id = 'org-payment-receipt-api'`,
    ),
    env.BILLING_DB.prepare(
      `DELETE FROM customers WHERE organization_id = 'org-payment-receipt-api'`,
    ),
    env.BILLING_DB.prepare(`DELETE FROM organizations WHERE id = 'org-payment-receipt-api'`),
    env.BILLING_DB.prepare(
      `INSERT INTO organizations (id, external_id, name, created_at, updated_at)
       VALUES ('org-payment-receipt-api', 'payment-receipt-api', 'Payment Receipt API', ?, ?)`,
    ).bind(now, now),
    env.BILLING_DB.prepare(
      `INSERT INTO api_keys
       (id, organization_id, key_prefix, key_hash, created_at, revoked_at)
       VALUES ('key-payment-receipt-api', 'org-payment-receipt-api', 'receipt', ?, ?, NULL)`,
    ).bind(await sha256Hex(apiKey), now),
    env.BILLING_DB.prepare(
      `INSERT INTO customers
       (id, organization_id, external_id, name, currency, metadata_json, version,
        created_at, updated_at)
       VALUES ('customer-payment-receipt-api', 'org-payment-receipt-api', 'receipt-customer',
               'Receipt Customer', 'USD', '{}', 1, ?, ?)`,
    ).bind(now, now),
    env.BILLING_DB.prepare(
      `INSERT INTO invoices
       (id, organization_id, customer_id, number, status, payment_status, currency,
        subtotal_minor, tax_minor, credits_minor, total_due_minor, version,
        payment_overdue, finalized_at, created_at, updated_at)
       VALUES ('invoice-payment-receipt-api', 'org-payment-receipt-api',
               'customer-payment-receipt-api', 'INV-RECEIPT', 'finalized', 'pending', 'USD',
               1000, 0, 0, 1000, 1, 1, ?, ?, ?)`,
    ).bind(now, now, now),
  ]);
});

describe("payment receipt compatibility API", () => {
  it("creates only the final manual-payment receipt and exposes list/show/filter boundaries", async () => {
    const partial = await recordManualPayment(400, "wire-partial");
    expect(partial.status).toBe(200);
    await expect(receiptCounts()).resolves.toEqual({ receipts: 0, counter: 0, events: 0 });

    const final = await recordManualPayment(600, "wire-final");
    expect(final.status).toBe(200);
    await expect(receiptCounts()).resolves.toEqual({ receipts: 1, counter: 1, events: 1 });
    await recordManualPayment(600, "wire-final");
    await expect(receiptCounts()).resolves.toEqual({ receipts: 1, counter: 1, events: 1 });

    const list = await api("/api/v1/payment_receipts?invoice_id=invoice-payment-receipt-api");
    expect(list.status).toBe(200);
    const body = await list.json<{
      payment_receipts: Array<{
        lago_id: string;
        number: string;
        file_url: null;
        xml_url: null;
        payment: { invoice_ids: string[]; amount_cents: number; type: string };
      }>;
      meta: { total_count: number };
    }>();
    expect(body.meta.total_count).toBe(1);
    expect(body.payment_receipts[0]).toMatchObject({
      number: "receipt-customer-RCPT-000001",
      file_url: null,
      xml_url: null,
      payment: {
        invoice_ids: ["invoice-payment-receipt-api"],
        amount_cents: 600,
        type: "manual",
      },
    });
    const receiptId = body.payment_receipts[0]!.lago_id;
    await expect(
      api(`/api/v1/payment_receipts/${receiptId}`).then((response) => response.json()),
    ).resolves.toMatchObject({
      payment_receipt: { lago_id: receiptId, number: "receipt-customer-RCPT-000001" },
    });
    const empty = await api("/api/v1/payment_receipts?invoice_id=missing-invoice");
    await expect(empty.json()).resolves.toMatchObject({
      payment_receipts: [],
      meta: { total_count: 0 },
    });
    const resend = await api(`/api/v1/payment_receipts/${receiptId}/resend_email`, "POST", {});
    expect(resend.status).toBe(503);
    await expect(resend.json()).resolves.toMatchObject({ code: "payment_receipt_email_disabled" });
  });

  it("creates a provider receipt when payment-first reconciliation later settles the invoice", async () => {
    const now = "2026-08-15T00:01:00.000Z";
    await env.BILLING_DB.prepare(
      `INSERT INTO payment_attempts
       (id, organization_id, invoice_id, provider, provider_account_code,
        provider_transaction_id, idempotency_key, amount_minor, currency, status,
        payment_type, version, created_at, updated_at)
       VALUES ('payment-provider-receipt', 'org-payment-receipt-api',
               'invoice-payment-receipt-api', 'authorize_net', 'authorize-net-default',
               'provider-receipt', 'provider-receipt', 1000, 'USD', 'succeeded',
               'provider', 1, ?, ?)`,
    )
      .bind(now, now)
      .run();
    await expect(receiptCounts()).resolves.toEqual({ receipts: 0, counter: 0, events: 0 });
    await env.BILLING_DB.prepare(
      `UPDATE invoices SET payment_status = 'succeeded', version = version + 1, updated_at = ?
       WHERE id = 'invoice-payment-receipt-api'`,
    )
      .bind(now)
      .run();
    await expect(receiptCounts()).resolves.toEqual({ receipts: 1, counter: 1, events: 1 });
    await env.BILLING_DB.prepare(
      `UPDATE payment_attempts SET status = 'succeeded', updated_at = ?
       WHERE id = 'payment-provider-receipt'`,
    )
      .bind(now)
      .run();
    await expect(receiptCounts()).resolves.toEqual({ receipts: 1, counter: 1, events: 1 });
  });

  it("creates and filters a payment-request receipt after request settlement", async () => {
    const now = "2026-08-15T00:02:00.000Z";
    await env.BILLING_DB.batch([
      env.BILLING_DB.prepare(
        `INSERT INTO payment_requests
         (id, organization_id, customer_id, amount_minor, currency, email, payment_attempts,
          payment_status, ready_for_payment_processing, version, created_at, updated_at)
         VALUES ('request-payment-receipt', 'org-payment-receipt-api',
                 'customer-payment-receipt-api', 1000, 'USD', NULL, 0, 'pending', 1, 1, ?, ?)`,
      ).bind(now, now),
      env.BILLING_DB.prepare(
        `INSERT INTO invoices_payment_requests
         (id, organization_id, payment_request_id, invoice_id, invoice_version,
          created_at, updated_at)
         VALUES ('request-link-payment-receipt', 'org-payment-receipt-api',
                 'request-payment-receipt', 'invoice-payment-receipt-api', 1, ?, ?)`,
      ).bind(now, now),
      env.BILLING_DB.prepare(
        `INSERT INTO payment_request_payments
         (id, organization_id, payment_request_id, provider, provider_account_code,
          provider_transaction_id, idempotency_key, amount_minor, currency, status,
          version, created_at, updated_at)
         VALUES ('request-payment-success', 'org-payment-receipt-api',
                 'request-payment-receipt', 'authorize_net', 'authorize-net-default',
                 'request-provider-receipt', 'request-provider-receipt', 1000, 'USD',
                 'succeeded', 1, ?, ?)`,
      ).bind(now, now),
    ]);
    await expect(receiptCounts()).resolves.toEqual({ receipts: 0, counter: 0, events: 0 });
    await env.BILLING_DB.prepare(
      `UPDATE payment_requests
       SET payment_status = 'succeeded', version = version + 1, updated_at = ?
       WHERE id = 'request-payment-receipt'`,
    )
      .bind(now)
      .run();
    await expect(receiptCounts()).resolves.toEqual({ receipts: 1, counter: 1, events: 1 });
    const response = await api("/api/v1/payment_receipts?invoice_id=invoice-payment-receipt-api");
    await expect(response.json()).resolves.toMatchObject({
      payment_receipts: [
        {
          payment: {
            lago_id: "request-payment-success",
            payable_type: "PaymentRequest",
            invoice_ids: ["invoice-payment-receipt-api"],
          },
        },
      ],
      meta: { total_count: 1 },
    });
  });

  it("enforces tenant/version guards and rolls the payable back when receipt audit fails", async () => {
    await expect(
      env.BILLING_DB.prepare(
        `INSERT INTO payment_receipts
         (id, organization_id, billing_entity_id, payment_id, payment_kind, customer_id, number,
          version, created_at, updated_at)
         VALUES ('invalid-receipt', 'org-payment-receipt-api', 'org-payment-receipt-api',
                 'missing-payment', 'invoice', 'customer-payment-receipt-api', 'INVALID-RCPT', 1,
                 '2026-08-15T00:03:00.000Z', '2026-08-15T00:03:00.000Z')`,
      ).run(),
    ).rejects.toThrow(/invalid_payment_receipt_tenant_or_state/);
    await expect(
      env.BILLING_DB.prepare(
        `INSERT INTO outbox_events
         (event_id, organization_id, event_type, event_version, aggregate_type, aggregate_id,
          aggregate_version, causation_id, correlation_id, payload_json, occurred_at, published_at)
         VALUES ('stale-receipt-event', 'org-payment-receipt-api', 'payment_receipt.created', 1,
                 'payment_receipt', 'missing-receipt', 1, NULL, 'stale-receipt', '{}',
                 '2026-08-15T00:03:00.000Z', NULL)`,
      ).run(),
    ).rejects.toThrow(/payment_receipt_outbox_version_conflict/);

    await env.BILLING_DB.prepare(
      `CREATE TRIGGER reject_payment_receipt_audit BEFORE INSERT ON outbox_events
       WHEN NEW.event_type = 'payment_receipt.created'
       BEGIN SELECT RAISE(ABORT, 'synthetic_payment_receipt_audit_failure'); END`,
    ).run();
    const now = "2026-08-15T00:04:00.000Z";
    await expect(
      env.BILLING_DB.batch([
        env.BILLING_DB.prepare(
          `UPDATE invoices SET payment_status = 'succeeded', version = version + 1, updated_at = ?
           WHERE id = 'invoice-payment-receipt-api'`,
        ).bind(now),
        env.BILLING_DB.prepare(
          `INSERT INTO payment_attempts
           (id, organization_id, invoice_id, provider, provider_account_code,
            provider_transaction_id, idempotency_key, amount_minor, currency, status,
            payment_type, version, created_at, updated_at)
           VALUES ('payment-receipt-rollback', 'org-payment-receipt-api',
                   'invoice-payment-receipt-api', 'manual', 'manual', NULL,
                   'payment-receipt-rollback', 1000, 'USD', 'succeeded', 'manual', 1, ?, ?)`,
        ).bind(now, now),
      ]),
    ).rejects.toThrow(/synthetic_payment_receipt_audit_failure/);
    await expect(
      env.BILLING_DB.prepare(
        `SELECT payment_status, version FROM invoices WHERE id = 'invoice-payment-receipt-api'`,
      ).first(),
    ).resolves.toEqual({ payment_status: "pending", version: 1 });
    await expect(receiptCounts()).resolves.toEqual({ receipts: 0, counter: 0, events: 0 });
  });
});

async function recordManualPayment(amount: number, reference: string): Promise<Response> {
  const response = await handlePaymentLedgerRequest(
    new Request("https://lago.test/api/v1/payments", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        payment: {
          invoice_id: "invoice-payment-receipt-api",
          amount_cents: amount,
          reference,
        },
      }),
    }),
    { ...env, PAYMENT_MUTATIONS_ENABLED: "1" } as unknown as Env,
    {
      organizationId: "org-payment-receipt-api",
      organizationExternalId: "payment-receipt-api",
      apiKeyId: "key-payment-receipt-api",
    },
    `request-${reference}`,
  );
  if (!response) throw new Error("Payment handler did not return a response");
  return response;
}

async function receiptCounts() {
  return env.BILLING_DB.prepare(
    `SELECT
       (SELECT COUNT(*) FROM payment_receipts
        WHERE organization_id = 'org-payment-receipt-api') AS receipts,
       (SELECT payment_receipt_counter FROM customers
        WHERE id = 'customer-payment-receipt-api') AS counter,
       (SELECT COUNT(*) FROM outbox_events
        WHERE organization_id = 'org-payment-receipt-api'
          AND event_type = 'payment_receipt.created') AS events`,
  ).first();
}

function api(path: string, method = "GET", body?: unknown): Promise<Response> {
  return SELF.fetch(`https://lago.test${path}`, {
    method,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}
