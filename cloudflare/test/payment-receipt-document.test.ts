import { env, SELF } from "cloudflare:test";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { dispatchPaymentReceiptDocument } from "../src/api/payment-receipts";
import { sha256Hex } from "../src/auth/api-key";
import { generatePaymentReceiptPdf } from "../src/documents/payment-receipt";

const apiKey = "payment-receipt-document-api-key";
const headers = { Authorization: `Bearer ${apiKey}` };
const receiptId = "payment-receipt:payment-receipt-document";
const objectKey = `payment-receipts/org-payment-receipt-document/${receiptId}/v1.pdf`;

beforeEach(async () => {
  const now = "2026-08-15T01:00:00.000Z";
  await env.BILLING_ARTIFACTS.delete(objectKey);
  await env.BILLING_DB.batch([
    env.BILLING_DB.prepare(
      "DELETE FROM payment_receipt_document_artifacts WHERE organization_id = 'org-payment-receipt-document'",
    ),
    env.BILLING_DB.prepare(
      "DELETE FROM outbox_events WHERE organization_id = 'org-payment-receipt-document'",
    ),
    env.BILLING_DB.prepare(
      "DELETE FROM payment_receipts WHERE organization_id = 'org-payment-receipt-document'",
    ),
    env.BILLING_DB.prepare(
      "DELETE FROM payment_attempts WHERE organization_id = 'org-payment-receipt-document'",
    ),
    env.BILLING_DB.prepare(
      "DELETE FROM invoice_lines WHERE invoice_id = 'invoice-payment-receipt-document'",
    ),
    env.BILLING_DB.prepare(
      "DELETE FROM invoices WHERE organization_id = 'org-payment-receipt-document'",
    ),
    env.BILLING_DB.prepare(
      "DELETE FROM api_keys WHERE organization_id = 'org-payment-receipt-document'",
    ),
    env.BILLING_DB.prepare(
      "DELETE FROM customers WHERE organization_id = 'org-payment-receipt-document'",
    ),
    env.BILLING_DB.prepare("DELETE FROM organizations WHERE id = 'org-payment-receipt-document'"),
    env.BILLING_DB.prepare(
      `INSERT INTO organizations
       (id, external_id, name, legal_name, address_line1, city, country, email,
        invoice_footer, created_at, updated_at)
       VALUES ('org-payment-receipt-document', 'payment-receipt-document',
               'Receipt <Org>', 'Receipt & Company', '1 <Cloud> Street', 'Edge City', 'US',
               'billing@example.test', 'Thank you <customer>', ?, ?)`,
    ).bind(now, now),
    env.BILLING_DB.prepare(
      `INSERT INTO customers
       (id, organization_id, external_id, email, name, currency, metadata_json,
        created_at, updated_at)
       VALUES ('customer-payment-receipt-document', 'org-payment-receipt-document',
               'customer<&>', 'customer@example.test', 'Customer <Example>', 'USD', '{}', ?, ?)`,
    ).bind(now, now),
    env.BILLING_DB.prepare(
      `INSERT INTO invoices
       (id, organization_id, customer_id, number, status, payment_status, currency,
        subtotal_minor, tax_minor, credits_minor, total_due_minor, version, finalized_at,
        issuing_date, created_at, updated_at)
       VALUES ('invoice-payment-receipt-document', 'org-payment-receipt-document',
               'customer-payment-receipt-document', 'INV-<&>', 'finalized', 'succeeded', 'USD',
               2500, 0, 0, 2500, 1, ?, '2026-08-15', ?, ?)`,
    ).bind(now, now, now),
    env.BILLING_DB.prepare(
      `INSERT INTO invoice_lines
       (id, invoice_id, line_type, description, quantity_decimal, unit_amount_decimal,
        amount_minor, source_type, source_id, metadata_json, created_at)
       VALUES ('line-payment-receipt-document', 'invoice-payment-receipt-document',
               'subscription', 'Plan <script>', '1', '2500', 2500, 'plan',
               'plan-payment-receipt-document', '{}', ?)`,
    ).bind(now),
    env.BILLING_DB.prepare(
      `INSERT INTO api_keys
       (id, organization_id, key_prefix, key_hash, created_at, revoked_at)
       VALUES ('key-payment-receipt-document', 'org-payment-receipt-document', 'receipt-doc',
               ?, ?, NULL)`,
    ).bind(await sha256Hex(apiKey), now),
    env.BILLING_DB.prepare(
      `INSERT INTO payment_attempts
       (id, organization_id, invoice_id, provider, provider_account_code,
        provider_transaction_id, idempotency_key, amount_minor, currency, status,
        payment_type, reference, version, created_at, updated_at)
       VALUES ('payment-receipt-document', 'org-payment-receipt-document',
               'invoice-payment-receipt-document', 'manual', 'manual', NULL,
               'payment-receipt-document', 2500, 'USD', 'succeeded', 'manual',
               'wire <reference>', 1, ?, ?)`,
    ).bind(now, now),
  ]);
});

describe("payment receipt documents", () => {
  it("archives one escaped checksummed PDF and emits one value-free generated event", async () => {
    const pdf = new TextEncoder().encode("%PDF-1.7\nsynthetic receipt pdf\n%%EOF");
    const render = vi.fn(
      async (_html: string) =>
        new Response(pdf, { headers: { "Content-Type": "application/pdf" } }),
    );
    const first = await generatePaymentReceiptPdf(env, receiptId, { render });
    const html = render.mock.calls[0]?.[0] ?? "";
    expect(html).toContain("Receipt &amp; Company");
    expect(html).toContain("Customer &lt;Example&gt;");
    expect(html).toContain("INV-&lt;&amp;&gt;");
    expect(html).toContain("wire &lt;reference&gt;");
    expect(html).not.toContain("<script>");
    expect(html).toContain("$25.00");
    expect(first.objectKey).toBe(objectKey);
    expect(first.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(await (await env.BILLING_ARTIFACTS.get(first.objectKey))?.text()).toBe(
      new TextDecoder().decode(pdf),
    );

    const replay = await generatePaymentReceiptPdf(env, receiptId, { render });
    expect(replay).toEqual(first);
    expect(render).toHaveBeenCalledTimes(1);
    await expect(
      env.BILLING_DB.prepare(
        `SELECT COUNT(*) AS count FROM outbox_events
         WHERE aggregate_id = ? AND event_type = 'payment_receipt.generated'
           AND payload_json NOT LIKE '%amount%' AND payload_json NOT LIKE '%customer%'`,
      )
        .bind(receiptId)
        .first(),
    ).resolves.toEqual({ count: 1 });
  });

  it("fails closed on invalid browser output and can retry the immutable artifact", async () => {
    await expect(
      generatePaymentReceiptPdf(env, receiptId, {
        render: async () => new Response("not a pdf", { status: 200 }),
      }),
    ).rejects.toThrow("invalid_pdf_signature");
    await expect(
      env.BILLING_DB.prepare(
        "SELECT status, failure_code FROM payment_receipt_document_artifacts WHERE payment_receipt_id = ?",
      )
        .bind(receiptId)
        .first(),
    ).resolves.toEqual({ status: "failed", failure_code: "invalid_pdf_signature" });

    const pdf = new TextEncoder().encode("%PDF-1.7\nretry\n%%EOF");
    await expect(
      generatePaymentReceiptPdf(env, receiptId, {
        render: async () => new Response(pdf, { status: 200 }),
      }),
    ).resolves.toMatchObject({ objectKey });
  });

  it("returns an authenticated private download and projects file_url only when ready", async () => {
    const before = await api(`/api/v1/payment_receipts/${encodeURIComponent(receiptId)}`);
    await expect(before.json()).resolves.toMatchObject({
      payment_receipt: { file_url: null, xml_url: null },
    });
    const pdf = new TextEncoder().encode("%PDF-1.7\ndownload\n%%EOF");
    await generatePaymentReceiptPdf(env, receiptId, {
      render: async () => new Response(pdf, { status: 200 }),
    });

    const shown = await api(`/api/v1/payment_receipts/${encodeURIComponent(receiptId)}`);
    const shownBody = await shown.json<{ payment_receipt: { file_url: string; xml_url: null } }>();
    expect(shownBody.payment_receipt.file_url).toBe(
      `https://lago.test/api/v1/payment_receipts/${encodeURIComponent(receiptId)}/download`,
    );
    expect(shownBody.payment_receipt.xml_url).toBeNull();
    const download = await api(
      `/api/v1/payment_receipts/${encodeURIComponent(receiptId)}/download`,
    );
    expect(download.status).toBe(200);
    expect(download.headers.get("Cache-Control")).toBe("private, no-store");
    expect(download.headers.get("Content-Type")).toBe("application/pdf");
    expect(download.headers.get("Content-Disposition")).toContain(
      "payment-receipt-customer___-RCPT-000001.pdf",
    );
    expect(new Uint8Array(await download.arrayBuffer())).toEqual(pdf);
  });

  it("dispatches one deterministic receipt workflow and accepts duplicate delivery", async () => {
    const create = vi.fn(async () => ({ id: "workflow" }));
    await dispatchPaymentReceiptDocument(
      { DOCUMENT_WORKFLOW: { create } } as unknown as Pick<Env, "DOCUMENT_WORKFLOW">,
      receiptId,
      "org-payment-receipt-document",
      1,
      "receipt-correlation",
    );
    expect(create).toHaveBeenCalledWith({
      id: `payment-receipt-pdf-${receiptId}-v1`,
      params: {
        kind: "payment_receipt",
        paymentReceiptId: receiptId,
        organizationId: "org-payment-receipt-document",
        correlationId: "receipt-correlation",
      },
    });

    const duplicate = vi.fn(async () => {
      throw new Error("workflow instance already exists");
    });
    await expect(
      dispatchPaymentReceiptDocument(
        { DOCUMENT_WORKFLOW: { create: duplicate } } as unknown as Pick<Env, "DOCUMENT_WORKFLOW">,
        receiptId,
        "org-payment-receipt-document",
        1,
        "receipt-correlation",
      ),
    ).resolves.toBeUndefined();
  });

  it("rejects cross-tenant or stale artifact identity", async () => {
    await expect(
      env.BILLING_DB.prepare(
        `INSERT INTO payment_receipt_document_artifacts
         (id, organization_id, payment_receipt_id, receipt_version, status, created_at, updated_at)
         VALUES ('invalid-receipt-artifact', 'org-payment-receipt-document', ?, 2,
                 'generating', '2026-08-15T01:00:00.000Z', '2026-08-15T01:00:00.000Z')`,
      )
        .bind(receiptId)
        .run(),
    ).rejects.toThrow(/invalid_payment_receipt_document_tenant_or_version/);
  });
});

function api(path: string): Promise<Response> {
  return SELF.fetch(`https://lago.test${path}`, { headers });
}
