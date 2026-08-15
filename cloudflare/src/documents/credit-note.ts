import { deterministicUuid } from "../identifiers";
import { sha256HexBytes, type PdfRenderer, validatedPdfBytes } from "./invoice";

type CreditNoteDocumentRow = {
  id: string;
  organization_id: string;
  invoice_id: string;
  invoice_number: string | null;
  number: string;
  status: string;
  credit_status: string;
  reason: string;
  description: string | null;
  currency: string;
  total_amount_minor: number;
  credit_amount_minor: number;
  balance_amount_minor: number;
  refund_amount_minor: number;
  offset_amount_minor: number;
  taxes_amount_minor: number;
  coupons_adjustment_minor: number;
  version: number;
  issuing_date: string;
  organization_name: string;
  organization_legal_name: string | null;
  organization_legal_number: string | null;
  organization_address_line1: string | null;
  organization_address_line2: string | null;
  organization_city: string | null;
  organization_state: string | null;
  organization_zipcode: string | null;
  organization_country: string | null;
  organization_email: string | null;
  organization_tax_id: string | null;
  invoice_footer: string | null;
  customer_external_id: string;
  customer_name: string | null;
  customer_email: string | null;
};

type CreditNoteItemDocumentRow = {
  description: string;
  amount_minor: number;
};

export async function generateCreditNotePdf(
  env: Pick<Env, "BILLING_DB" | "BILLING_ARTIFACTS">,
  creditNoteId: string,
  renderer: PdfRenderer,
): Promise<{ artifactId: string; objectKey: string; sha256: string; byteLength: number }> {
  const note = await loadCreditNote(env.BILLING_DB, creditNoteId);
  if (!note) throw new Error("credit_note_not_found");
  if (note.status !== "finalized") throw new Error("credit_note_not_finalized");
  const items = await loadItems(env.BILLING_DB, note.id);
  const artifactId = await deterministicUuid("credit-note-pdf", `${note.id}:v${note.version}`);
  const objectKey = `credit-notes/${note.organization_id}/${note.id}/v${note.version}.pdf`;
  const now = new Date().toISOString();
  await env.BILLING_DB.prepare(
    `INSERT INTO credit_note_document_artifacts
     (id, organization_id, credit_note_id, credit_note_version, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'generating', ?, ?)
     ON CONFLICT(credit_note_id, credit_note_version) DO UPDATE SET
       status = CASE
         WHEN credit_note_document_artifacts.status = 'ready' THEN 'ready'
         ELSE 'generating'
       END,
       failure_code = NULL,
       updated_at = excluded.updated_at`,
  )
    .bind(artifactId, note.organization_id, note.id, note.version, now, now)
    .run();
  const existing = await env.BILLING_DB.prepare(
    `SELECT object_key, content_sha256, byte_length
     FROM credit_note_document_artifacts WHERE id = ? AND status = 'ready'`,
  )
    .bind(artifactId)
    .first<{ object_key: string; content_sha256: string; byte_length: number }>();
  if (existing) {
    return {
      artifactId,
      objectKey: existing.object_key,
      sha256: existing.content_sha256,
      byteLength: existing.byte_length,
    };
  }

  try {
    const response = await renderer.render(renderCreditNoteHtml(note, items));
    const bytes = await validatedPdfBytes(response);
    const sha256 = await sha256HexBytes(bytes);
    await env.BILLING_ARTIFACTS.put(objectKey, bytes, {
      httpMetadata: { contentType: "application/pdf" },
      customMetadata: {
        creditNoteId: note.id,
        creditNoteVersion: String(note.version),
        sha256,
      },
    });
    const generatedAt = new Date().toISOString();
    await env.BILLING_DB.batch([
      env.BILLING_DB.prepare(
        `UPDATE credit_note_document_artifacts
         SET status = 'ready', object_key = ?, content_sha256 = ?, byte_length = ?,
             generated_at = ?, updated_at = ? WHERE id = ?`,
      ).bind(objectKey, sha256, bytes.byteLength, generatedAt, generatedAt, artifactId),
      env.BILLING_DB.prepare(
        `INSERT INTO outbox_events
         (event_id, organization_id, event_type, event_version, aggregate_type, aggregate_id,
          aggregate_version, causation_id, correlation_id, payload_json, occurred_at, published_at)
         VALUES (?, ?, 'credit_note.generated', 1, 'credit_note', ?, ?, ?, ?, ?, ?, NULL)
         ON CONFLICT(event_id) DO NOTHING`,
      ).bind(
        `credit-note-generated:${note.id}:v${note.version}`,
        note.organization_id,
        note.id,
        note.version,
        note.id,
        note.id,
        JSON.stringify({
          organizationId: note.organization_id,
          creditNoteId: note.id,
          creditNoteVersion: note.version,
        }),
        generatedAt,
      ),
    ]);
    return { artifactId, objectKey, sha256, byteLength: bytes.byteLength };
  } catch (error) {
    const code = error instanceof Error ? error.message.slice(0, 100) : "unknown_error";
    await env.BILLING_DB.prepare(
      `UPDATE credit_note_document_artifacts
       SET status = 'failed', failure_code = ?, updated_at = ?
       WHERE id = ? AND status <> 'ready'`,
    )
      .bind(code, new Date().toISOString(), artifactId)
      .run();
    throw error;
  }
}

export function renderCreditNoteHtml(
  note: CreditNoteDocumentRow,
  items: CreditNoteItemDocumentRow[],
): string {
  return renderCreditNoteHtmlTemplate(note, items).replace(
    "system-ui,sans-serif",
    "Arial,sans-serif",
  );
}

function renderCreditNoteHtmlTemplate(
  note: CreditNoteDocumentRow,
  items: CreditNoteItemDocumentRow[],
): string {
  const itemRows = items
    .map(
      (item) =>
        `<tr><td>${escapeHtml(item.description)}</td><td class="number">${formatMinor(item.amount_minor, note.currency)}</td></tr>`,
    )
    .join("");
  const organizationAddress = [
    note.organization_address_line1,
    note.organization_address_line2,
    [note.organization_zipcode, note.organization_city].filter(Boolean).join(" "),
    note.organization_state,
    note.organization_country,
    note.organization_email,
  ]
    .filter((value): value is string => !!value)
    .map((value) => `<div>${escapeHtml(value)}</div>`)
    .join("");
  const legalDetails = [note.organization_legal_number, note.organization_tax_id]
    .filter((value): value is string => !!value)
    .map((value) => `<div>${escapeHtml(value)}</div>`)
    .join("");
  const status = note.credit_status === "voided" ? "VOIDED" : "FINALIZED";
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Credit note ${escapeHtml(note.number)}</title><style>@page{size:A4;margin:12mm}*{box-sizing:border-box}body{font:13px system-ui,sans-serif;color:#172033}h1{font-size:28px;margin:0}.header{display:flex;justify-content:space-between;border-bottom:2px solid #172033;padding-bottom:18px}.meta{text-align:right}.parties{display:grid;grid-template-columns:1fr 1fr;gap:32px;margin:28px 0}.label{color:#667085;font-size:11px;text-transform:uppercase;letter-spacing:.04em;margin-bottom:6px}.amount{font-size:30px;font-weight:700;margin:28px 0 5px}.notice{color:#475467}.description{white-space:pre-wrap;margin:18px 0}.details{margin:24px 0}.details div{display:flex;gap:16px;padding:5px 0}.details strong{min-width:125px}table{width:100%;border-collapse:collapse;margin-top:24px}th,td{padding:10px;border-bottom:1px solid #d7dce5;text-align:left}.number{text-align:right}.totals{margin:24px 0 0 auto;width:48%}.totals div{display:flex;justify-content:space-between;padding:5px}.total{font-size:17px;font-weight:700;border-top:2px solid #172033;margin-top:5px;padding-top:10px!important}.footer{white-space:pre-wrap;margin-top:40px;color:#667085;font-size:11px}</style></head><body><section class="header"><div><h1>Credit note</h1><div>${escapeHtml(note.number)}</div></div><div class="meta"><strong>${status}</strong><br>${escapeHtml(note.issuing_date)}</div></section><section class="parties"><div><div class="label">Credit from</div><strong>${escapeHtml(note.organization_legal_name ?? note.organization_name)}</strong>${legalDetails}${organizationAddress}</div><div><div class="label">Credit to</div><strong>${escapeHtml(note.customer_name ?? note.customer_external_id)}</strong>${note.customer_email ? `<div>${escapeHtml(note.customer_email)}</div>` : ""}<div>${escapeHtml(note.customer_external_id)}</div></div></section><div class="amount">${formatMinor(note.total_amount_minor, note.currency)}</div><div class="notice">Issued ${escapeHtml(note.issuing_date)}</div>${note.description ? `<div class="description">${escapeHtml(note.description)}</div>` : ""}<section class="details"><div><strong>Invoice</strong><span>${escapeHtml(note.invoice_number ?? note.invoice_id)}</span></div><div><strong>Reason</strong><span>${escapeHtml(humanize(note.reason))}</span></div></section><table><thead><tr><th>Item</th><th class="number">Amount</th></tr></thead><tbody>${itemRows}</tbody></table><section class="totals"><div><span>Subtotal excluding tax</span><span>${formatMinor(note.total_amount_minor - note.taxes_amount_minor, note.currency)}</span></div><div><span>Tax</span><span>${formatMinor(note.taxes_amount_minor, note.currency)}</span></div>${note.coupons_adjustment_minor > 0 ? `<div><span>Coupon adjustment</span><span>-${formatMinor(note.coupons_adjustment_minor, note.currency)}</span></div>` : ""}<div><span>Customer balance credit</span><span>${formatMinor(note.credit_amount_minor, note.currency)}</span></div>${note.refund_amount_minor > 0 ? `<div><span>Refunded</span><span>${formatMinor(note.refund_amount_minor, note.currency)}</span></div>` : ""}${note.offset_amount_minor > 0 ? `<div><span>Invoice offset</span><span>${formatMinor(note.offset_amount_minor, note.currency)}</span></div>` : ""}<div class="total"><span>Total</span><span>${formatMinor(note.total_amount_minor, note.currency)}</span></div></section><div class="footer">${note.invoice_footer ? `${escapeHtml(note.invoice_footer)}\n\n` : ""}Generated from immutable credit note version ${note.version}. XML e-invoicing is not enabled.</div></body></html>`;
}

async function loadCreditNote(database: D1Database, creditNoteId: string) {
  return database
    .prepare(
      `SELECT note.id, note.organization_id, note.invoice_id,
              invoice.number AS invoice_number, note.number,
              CASE WHEN note.allocation_state = 'draft' THEN 'draft' ELSE note.status END AS status,
              note.credit_status, note.reason, note.description, note.currency,
              note.total_amount_minor, note.credit_amount_minor, note.balance_amount_minor,
              note.refund_amount_minor, note.offset_amount_minor, note.taxes_amount_minor,
              note.coupons_adjustment_minor, note.version, note.issuing_date,
              organization.name AS organization_name,
              organization.legal_name AS organization_legal_name,
              organization.legal_number AS organization_legal_number,
              organization.address_line1 AS organization_address_line1,
              organization.address_line2 AS organization_address_line2,
              organization.city AS organization_city, organization.state AS organization_state,
              organization.zipcode AS organization_zipcode,
              organization.country AS organization_country,
              organization.email AS organization_email,
              organization.tax_identification_number AS organization_tax_id,
              organization.invoice_footer,
              customer.external_id AS customer_external_id,
              customer.name AS customer_name, customer.email AS customer_email
       FROM credit_notes note
       JOIN invoices invoice ON invoice.id = note.invoice_id
       JOIN organizations organization ON organization.id = note.organization_id
       JOIN customers customer ON customer.id = note.customer_id
       WHERE note.id = ? LIMIT 1`,
    )
    .bind(creditNoteId)
    .first<CreditNoteDocumentRow>();
}

async function loadItems(database: D1Database, creditNoteId: string) {
  const result = await database
    .prepare(
      `SELECT invoice_line.description, item.amount_minor
       FROM credit_note_items item
       JOIN invoice_lines invoice_line ON invoice_line.id = item.invoice_line_id
       WHERE item.credit_note_id = ? ORDER BY item.created_at, item.id`,
    )
    .bind(creditNoteId)
    .all<CreditNoteItemDocumentRow>();
  return [...result.results];
}

function formatMinor(value: number, currency: string): string {
  return new Intl.NumberFormat("en", { style: "currency", currency }).format(value / 100);
}

function humanize(value: string): string {
  return value
    .split("_")
    .filter(Boolean)
    .map((word) => `${word[0]?.toUpperCase() ?? ""}${word.slice(1)}`)
    .join(" ");
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
