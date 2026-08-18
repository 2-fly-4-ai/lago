import { env, SELF } from "cloudflare:test";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { dispatchCreditNoteDocument } from "../src/api/credit-note-ledger";
import { sha256Hex } from "../src/auth/api-key";
import { generateCreditNotePdf } from "../src/documents/credit-note";

const apiKey = "credit-note-document-api-key";
const headers = { Authorization: `Bearer ${apiKey}` };
const noteId = "credit-note-document";
const v1Key = `credit-notes/org-credit-note-document/${noteId}/v1.pdf`;
const v2Key = `credit-notes/org-credit-note-document/${noteId}/v2.pdf`;

beforeEach(async () => {
  const now = "2026-08-15T02:00:00.000Z";
  await Promise.all([env.BILLING_ARTIFACTS.delete(v1Key), env.BILLING_ARTIFACTS.delete(v2Key)]);
  await env.BILLING_DB.batch([
    env.BILLING_DB.prepare(
      "DELETE FROM credit_note_document_artifacts WHERE organization_id = 'org-credit-note-document'",
    ),
    env.BILLING_DB.prepare(
      "DELETE FROM outbox_events WHERE organization_id = 'org-credit-note-document'",
    ),
    env.BILLING_DB.prepare(
      "DELETE FROM credit_note_taxes WHERE organization_id = 'org-credit-note-document'",
    ),
    env.BILLING_DB.prepare(
      "DELETE FROM credit_note_item_adjustments WHERE organization_id = 'org-credit-note-document'",
    ),
    env.BILLING_DB.prepare(
      "DELETE FROM credit_note_offsets WHERE organization_id = 'org-credit-note-document'",
    ),
    env.BILLING_DB.prepare(
      "DELETE FROM credit_note_refunds WHERE organization_id = 'org-credit-note-document'",
    ),
    env.BILLING_DB.prepare(
      "DELETE FROM credit_note_financials WHERE organization_id = 'org-credit-note-document'",
    ),
    env.BILLING_DB.prepare(
      "DELETE FROM credit_note_items WHERE organization_id = 'org-credit-note-document'",
    ),
    env.BILLING_DB.prepare(
      "DELETE FROM credit_notes WHERE organization_id = 'org-credit-note-document'",
    ),
    env.BILLING_DB.prepare(
      "DELETE FROM invoice_lines WHERE invoice_id = 'invoice-credit-note-document'",
    ),
    env.BILLING_DB.prepare(
      "DELETE FROM invoices WHERE organization_id = 'org-credit-note-document'",
    ),
    env.BILLING_DB.prepare(
      "DELETE FROM api_keys WHERE organization_id = 'org-credit-note-document'",
    ),
    env.BILLING_DB.prepare(
      "DELETE FROM customers WHERE organization_id = 'org-credit-note-document'",
    ),
    env.BILLING_DB.prepare("DELETE FROM organizations WHERE id = 'org-credit-note-document'"),
    env.BILLING_DB.prepare(
      `INSERT INTO organizations
       (id, external_id, name, legal_name, address_line1, city, country, email,
        invoice_footer, created_at, updated_at)
       VALUES ('org-credit-note-document', 'credit-note-document', 'Credit <Org>',
               'Credit & Company', '2 <Edge> Road', 'Workers City', 'US',
               'credit@example.test', 'Credit footer <safe>', ?, ?)`,
    ).bind(now, now),
    env.BILLING_DB.prepare(
      `INSERT INTO customers
       (id, organization_id, external_id, email, name, currency, metadata_json,
        created_at, updated_at)
       VALUES ('customer-credit-note-document', 'org-credit-note-document', 'credit-customer<&>',
               'customer@example.test', 'Customer <Credit>', 'USD', '{}', ?, ?)`,
    ).bind(now, now),
    env.BILLING_DB.prepare(
      `INSERT INTO invoices
       (id, organization_id, customer_id, number, status, payment_status, currency,
        subtotal_minor, tax_minor, credits_minor, total_due_minor, version, finalized_at,
        issuing_date, created_at, updated_at)
       VALUES ('invoice-credit-note-document', 'org-credit-note-document',
               'customer-credit-note-document', 'INV-CREDIT-<&>', 'finalized', 'pending', 'USD',
               1000, 0, 0, 1000, 1, ?, '2026-08-15', ?, ?)`,
    ).bind(now, now, now),
    env.BILLING_DB.prepare(
      `INSERT INTO invoice_lines
       (id, invoice_id, line_type, description, quantity_decimal, unit_amount_decimal,
        amount_minor, source_type, source_id, metadata_json, created_at)
       VALUES ('line-credit-note-document', 'invoice-credit-note-document', 'subscription',
               'Plan <script>', '1', '1000', 1000, 'plan', 'plan-credit-note-document', '{}', ?)`,
    ).bind(now),
    env.BILLING_DB.prepare(
      `INSERT INTO credit_notes
       (id, organization_id, customer_id, invoice_id, sequential_id, number, status,
        credit_status, reason, description, currency, total_amount_minor, credit_amount_minor,
        balance_amount_minor, version, idempotency_key, request_sha256, issuing_date,
        created_at, updated_at)
       VALUES (?, 'org-credit-note-document', 'customer-credit-note-document',
               'invoice-credit-note-document', 1, 'CN-<&>', 'finalized', 'available',
               'order_change', 'Description <safe> & complete', 'USD', 500, 500, 500, 1,
               'credit-note-document', 'synthetic-request-hash', '2026-08-15', ?, ?)`,
    ).bind(noteId, now, now),
    env.BILLING_DB.prepare(
      `INSERT INTO credit_note_items
       (id, organization_id, credit_note_id, invoice_line_id, amount_minor,
        precise_amount_minor, currency, created_at)
       VALUES ('item-credit-note-document', 'org-credit-note-document', ?,
               'line-credit-note-document', 500, '500', 'USD', ?)`,
    ).bind(noteId, now),
    env.BILLING_DB.prepare(
      `INSERT INTO api_keys
       (id, organization_id, key_prefix, key_hash, created_at, revoked_at)
       VALUES ('key-credit-note-document', 'org-credit-note-document', 'credit-doc', ?, ?, NULL)`,
    ).bind(await sha256Hex(apiKey), now),
  ]);
});

describe("credit note documents", () => {
  it("archives one escaped checksummed PDF and replays without rerendering", async () => {
    const pdf = new TextEncoder().encode("%PDF-1.7\nsynthetic credit note\n%%EOF");
    const render = vi.fn(async (_html: string) => new Response(pdf, { status: 200 }));
    const first = await generateCreditNotePdf(env, noteId, { render });
    const html = render.mock.calls[0]?.[0] ?? "";
    expect(html).toContain("Credit &amp; Company");
    expect(html).toContain("Customer &lt;Credit&gt;");
    expect(html).toContain("INV-CREDIT-&lt;&amp;&gt;");
    expect(html).toContain("Plan &lt;script&gt;");
    expect(html).not.toContain("<script>");
    expect(html).toContain("$5.00");
    expect(first.objectKey).toBe(v1Key);
    expect(first.sha256).toMatch(/^[0-9a-f]{64}$/);

    const replay = await generateCreditNotePdf(env, noteId, { render });
    expect(replay).toEqual(first);
    expect(render).toHaveBeenCalledTimes(1);
    await expect(
      env.BILLING_DB.prepare(
        `SELECT COUNT(*) AS count FROM outbox_events
         WHERE aggregate_id = ? AND event_type = 'credit_note.generated'
           AND payload_json NOT LIKE '%amount%' AND payload_json NOT LIKE '%customer%'`,
      )
        .bind(noteId)
        .first(),
    ).resolves.toEqual({ count: 1 });
  });

  it("serves private PDFs and regenerates a distinct immutable version after voiding", async () => {
    const v1Pdf = new TextEncoder().encode("%PDF-1.7\nv1\n%%EOF");
    await generateCreditNotePdf(env, noteId, {
      render: async () => new Response(v1Pdf, { status: 200 }),
    });
    const shown = await api(`/api/v1/credit_notes/${noteId}`);
    await expect(shown.json()).resolves.toMatchObject({
      credit_note: {
        file_url: `https://lago.test/api/v1/credit_notes/${noteId}/download`,
        xml_url: null,
      },
    });
    const download = await api(`/api/v1/credit_notes/${noteId}/download`, "POST");
    expect(download.status).toBe(200);
    expect(download.headers.get("Cache-Control")).toBe("private, no-store");
    expect(new Uint8Array(await download.arrayBuffer())).toEqual(v1Pdf);

    const voided = await api(`/api/v1/credit_notes/${noteId}/void`, "PUT");
    expect(voided.status).toBe(200);
    await expect(voided.json()).resolves.toMatchObject({
      credit_note: { credit_status: "voided", file_url: null },
    });
    const v2Pdf = new TextEncoder().encode("%PDF-1.7\nv2 voided\n%%EOF");
    const render = vi.fn(async (_html: string) => new Response(v2Pdf, { status: 200 }));
    const generated = await generateCreditNotePdf(env, noteId, { render });
    expect(generated.objectKey).toBe(v2Key);
    expect(render.mock.calls[0]?.[0]).toContain("VOIDED");
    expect(await (await env.BILLING_ARTIFACTS.get(v1Key))?.text()).toContain("v1");
    expect(await (await env.BILLING_ARTIFACTS.get(v2Key))?.text()).toContain("v2 voided");
  });

  it("records invalid browser output and keeps XML explicitly disabled", async () => {
    await expect(
      generateCreditNotePdf(env, noteId, {
        render: async () => new Response("not a pdf", { status: 200 }),
      }),
    ).rejects.toThrow("invalid_pdf_signature");
    await expect(
      env.BILLING_DB.prepare(
        "SELECT status, failure_code FROM credit_note_document_artifacts WHERE credit_note_id = ?",
      )
        .bind(noteId)
        .first(),
    ).resolves.toEqual({ status: "failed", failure_code: "invalid_pdf_signature" });
    const xml = await api(`/api/v1/credit_notes/${noteId}/download_xml`, "POST");
    expect(xml.status).toBe(422);
    await expect(xml.json()).resolves.toMatchObject({ code: "credit_note_xml_disabled" });
  });

  it("dispatches a deterministic workflow and rejects stale artifact identity", async () => {
    const create = vi.fn(async () => ({ id: "workflow" }));
    await dispatchCreditNoteDocument(
      { DOCUMENT_WORKFLOW: { create } } as unknown as Pick<Env, "DOCUMENT_WORKFLOW">,
      noteId,
      "org-credit-note-document",
      1,
      "credit-note-correlation",
    );
    expect(create).toHaveBeenCalledWith({
      id: `credit-note-pdf-${noteId}-v1`,
      params: {
        kind: "credit_note",
        creditNoteId: noteId,
        organizationId: "org-credit-note-document",
        correlationId: "credit-note-correlation",
      },
    });
    await expect(
      env.BILLING_DB.prepare(
        `INSERT INTO credit_note_document_artifacts
         (id, organization_id, credit_note_id, credit_note_version, status,
          created_at, updated_at)
         VALUES ('stale-credit-note-document', 'org-credit-note-document', ?, 2, 'generating',
                 '2026-08-15T02:00:00.000Z', '2026-08-15T02:00:00.000Z')`,
      )
        .bind(noteId)
        .run(),
    ).rejects.toThrow(/invalid_credit_note_document_tenant_or_version/);
  });
});

function api(path: string, method = "GET"): Promise<Response> {
  return SELF.fetch(`https://lago.test${path}`, { method, headers });
}
