import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { generateInvoicePdf, renderInvoiceHtml } from "../src/documents/invoice";

beforeEach(async () => {
  const now = "2026-08-13T00:00:00.000Z";
  await env.BILLING_DB.prepare(
    "DELETE FROM document_artifacts WHERE organization_id = 'org-document'",
  ).run();
  await env.BILLING_DB.batch([
    env.BILLING_DB.prepare(
      `INSERT OR IGNORE INTO organizations (id, external_id, name, created_at, updated_at)
       VALUES ('org-document', 'document', 'Document', ?, ?)`,
    ).bind(now, now),
    env.BILLING_DB.prepare(
      `INSERT OR IGNORE INTO customers
       (id, organization_id, external_id, email, name, currency, metadata_json, created_at, updated_at)
       VALUES ('customer-document', 'org-document', 'customer<&>', 'person@example.test',
               'Customer <Example>', 'USD', '{}', ?, ?)`,
    ).bind(now, now),
    env.BILLING_DB.prepare(
      `INSERT OR IGNORE INTO invoices
       (id, organization_id, customer_id, number, status, payment_status, currency,
        subtotal_minor, tax_minor, credits_minor, total_due_minor, version,
        finalized_at, issuing_date, created_at, updated_at)
       VALUES ('invoice-document', 'org-document', 'customer-document', 'INV-<&>',
               'finalized', 'pending', 'USD', 1250, 0, 0, 1250, 1, ?, '2026-08-13', ?, ?)`,
    ).bind(now, now, now),
    env.BILLING_DB.prepare(
      `INSERT OR IGNORE INTO invoice_lines
       (id, invoice_id, line_type, description, quantity_decimal, unit_amount_decimal,
        amount_minor, source_type, source_id, metadata_json, created_at)
       VALUES ('line-document', 'invoice-document', 'subscription', 'Plan <script>',
               '1', '1250', 1250, 'plan', 'plan-document', '{}', ?)`,
    ).bind(now),
  ]);
});

describe("invoice documents", () => {
  it("renders escaped deterministic HTML", () => {
    const html = renderInvoiceHtml(
      {
        id: "invoice",
        organization_id: "org",
        number: "INV-<&>",
        status: "finalized",
        currency: "USD",
        subtotal_minor: 1250,
        tax_minor: 0,
        credits_minor: 0,
        total_due_minor: 1250,
        version: 1,
        finalized_at: "2026-08-13T00:00:00.000Z",
        issuing_date: "2026-08-12",
        customer_external_id: "customer",
        customer_name: "Customer <Example>",
        customer_email: "person@example.test",
      },
      [
        {
          description: "Plan <script>",
          quantity_decimal: "1",
          unit_amount_decimal: "1250",
          amount_minor: 1250,
        },
      ],
    );
    expect(html).toContain("Customer &lt;Example&gt;");
    expect(html).toContain("Plan &lt;script&gt;");
    expect(html).not.toContain("<script>");
    expect(html).toContain("$12.50");
  });

  it("archives one checksummed PDF and replays without rerendering", async () => {
    const pdf = new TextEncoder().encode("%PDF-1.7\nsynthetic pdf\n%%EOF");
    const render = vi.fn(
      async () => new Response(pdf, { headers: { "Content-Type": "application/pdf" } }),
    );
    const first = await generateInvoicePdf(env, "invoice-document", { render });
    expect(first.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(first.byteLength).toBe(pdf.byteLength);
    expect(await (await env.BILLING_ARTIFACTS.get(first.objectKey))?.text()).toBe(
      new TextDecoder().decode(pdf),
    );

    const replay = await generateInvoicePdf(env, "invoice-document", { render });
    expect(replay).toEqual(first);
    expect(render).toHaveBeenCalledTimes(1);
  });

  it("fails closed and records invalid browser output", async () => {
    await expect(
      generateInvoicePdf(env, "invoice-document", {
        render: async () => new Response("not a pdf", { status: 200 }),
      }),
    ).rejects.toThrow("invalid_pdf_signature");
    await expect(
      env.BILLING_DB.prepare(
        "SELECT status, failure_code FROM document_artifacts WHERE resource_id = 'invoice-document'",
      ).first(),
    ).resolves.toMatchObject({ status: "failed", failure_code: "invalid_pdf_signature" });
  });

  it("rejects an oversized PDF stream before archiving it", async () => {
    const chunk = new Uint8Array(1024 * 1024);
    chunk.set(new TextEncoder().encode("%PDF-"));
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        for (let index = 0; index < 11; index += 1) controller.enqueue(chunk);
        controller.close();
      },
    });
    await expect(
      generateInvoicePdf(env, "invoice-document", {
        render: async () => new Response(body, { status: 200 }),
      }),
    ).rejects.toThrow("pdf_too_large");
    await expect(
      env.BILLING_DB.prepare(
        "SELECT status, failure_code FROM document_artifacts WHERE resource_id = 'invoice-document'",
      ).first(),
    ).resolves.toMatchObject({ status: "failed", failure_code: "pdf_too_large" });
  });
});
