import { paymentRows } from "../api/payment-ledger";
import { deterministicUuid } from "../identifiers";
import type { PdfRenderer } from "./invoice";

const MAX_PDF_BYTES = 10 * 1024 * 1024;

type PaymentReceiptDocumentRow = {
  id: string;
  organization_id: string;
  number: string;
  version: number;
  payment_id: string;
  payable_type: "Invoice" | "PaymentRequest";
  invoice_ids_json: string;
  invoice_numbers_json: string;
  provider: string;
  provider_account_code: string;
  provider_transaction_id: string | null;
  payment_type: "provider" | "manual";
  reference: string | null;
  amount_minor: number;
  currency: string;
  payment_created_at: string;
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

type ReceiptInvoiceRow = {
  id: string;
  number: string | null;
  total_due_minor: number;
  currency: string;
};

export async function generatePaymentReceiptPdf(
  env: Pick<Env, "BILLING_DB" | "BILLING_ARTIFACTS">,
  paymentReceiptId: string,
  renderer: PdfRenderer,
): Promise<{ artifactId: string; objectKey: string; sha256: string; byteLength: number }> {
  const receipt = await loadPaymentReceipt(env.BILLING_DB, paymentReceiptId);
  if (!receipt) throw new Error("payment_receipt_not_found");
  const invoices = await loadInvoices(env.BILLING_DB, jsonStringArray(receipt.invoice_ids_json));
  const artifactId = await deterministicUuid(
    "payment-receipt-pdf",
    `${receipt.id}:v${receipt.version}`,
  );
  const objectKey = `payment-receipts/${receipt.organization_id}/${receipt.id}/v${receipt.version}.pdf`;
  const now = new Date().toISOString();
  await env.BILLING_DB.prepare(
    `INSERT INTO payment_receipt_document_artifacts
     (id, organization_id, payment_receipt_id, receipt_version, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'generating', ?, ?)
     ON CONFLICT(payment_receipt_id, receipt_version) DO UPDATE SET
       status = CASE
         WHEN payment_receipt_document_artifacts.status = 'ready' THEN 'ready'
         ELSE 'generating'
       END,
       failure_code = NULL,
       updated_at = excluded.updated_at`,
  )
    .bind(artifactId, receipt.organization_id, receipt.id, receipt.version, now, now)
    .run();
  const existing = await env.BILLING_DB.prepare(
    `SELECT object_key, content_sha256, byte_length
     FROM payment_receipt_document_artifacts WHERE id = ? AND status = 'ready'`,
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
    const response = await renderer.render(renderPaymentReceiptHtml(receipt, invoices));
    if (!response.ok || !response.body) throw new Error(`browser_pdf_error:${response.status}`);
    const declared = Number.parseInt(response.headers.get("Content-Length") ?? "", 10);
    if (Number.isFinite(declared) && declared > MAX_PDF_BYTES) throw new Error("pdf_too_large");
    const bytes = await readBoundedBytes(response.body, MAX_PDF_BYTES);
    if (bytes.byteLength === 0) throw new Error("invalid_pdf_size");
    if (!startsWithPdfSignature(bytes)) throw new Error("invalid_pdf_signature");
    const sha256 = await sha256HexBytes(bytes);
    await env.BILLING_ARTIFACTS.put(objectKey, bytes, {
      httpMetadata: { contentType: "application/pdf" },
      customMetadata: {
        paymentReceiptId: receipt.id,
        receiptVersion: String(receipt.version),
        sha256,
      },
    });
    const generatedAt = new Date().toISOString();
    await env.BILLING_DB.batch([
      env.BILLING_DB.prepare(
        `UPDATE payment_receipt_document_artifacts
         SET status = 'ready', object_key = ?, content_sha256 = ?, byte_length = ?,
             generated_at = ?, updated_at = ?
         WHERE id = ?`,
      ).bind(objectKey, sha256, bytes.byteLength, generatedAt, generatedAt, artifactId),
      env.BILLING_DB.prepare(
        `INSERT INTO outbox_events
         (event_id, organization_id, event_type, event_version, aggregate_type, aggregate_id,
          aggregate_version, causation_id, correlation_id, payload_json, occurred_at, published_at)
         VALUES (?, ?, 'payment_receipt.generated', 1, 'payment_receipt', ?, ?, ?, ?, ?, ?, NULL)
         ON CONFLICT(event_id) DO NOTHING`,
      ).bind(
        `payment-receipt-generated:${receipt.id}:v${receipt.version}`,
        receipt.organization_id,
        receipt.id,
        receipt.version,
        receipt.payment_id,
        receipt.payment_id,
        JSON.stringify({
          organizationId: receipt.organization_id,
          paymentReceiptId: receipt.id,
          receiptVersion: receipt.version,
        }),
        generatedAt,
      ),
    ]);
    return { artifactId, objectKey, sha256, byteLength: bytes.byteLength };
  } catch (error) {
    const code = error instanceof Error ? error.message.slice(0, 100) : "unknown_error";
    await env.BILLING_DB.prepare(
      `UPDATE payment_receipt_document_artifacts
       SET status = 'failed', failure_code = ?, updated_at = ?
       WHERE id = ? AND status <> 'ready'`,
    )
      .bind(code, new Date().toISOString(), artifactId)
      .run();
    throw error;
  }
}

export function renderPaymentReceiptHtml(
  receipt: PaymentReceiptDocumentRow,
  invoices: ReceiptInvoiceRow[],
): string {
  const invoiceRows = invoices
    .map(
      (invoice) =>
        `<tr><td>${escapeHtml(invoice.number ?? invoice.id)}</td><td class="number">${formatMinor(invoice.total_due_minor, invoice.currency)}</td></tr>`,
    )
    .join("");
  const invoiceTable =
    invoiceRows.length === 0
      ? ""
      : `<section class="invoices"><h2>Paid invoices</h2><table><thead><tr><th>Invoice</th><th class="number">Invoice total</th></tr></thead><tbody>${invoiceRows}</tbody></table></section>`;
  const paymentMethod =
    receipt.payment_type === "manual"
      ? receipt.reference
        ? `Manual · ${receipt.reference}`
        : "Manual"
      : `${humanize(receipt.provider)}${receipt.provider_transaction_id ? ` · ${receipt.provider_transaction_id}` : ""}`;
  const organizationAddress = [
    receipt.organization_address_line1,
    receipt.organization_address_line2,
    [receipt.organization_zipcode, receipt.organization_city].filter(Boolean).join(" "),
    receipt.organization_state,
    receipt.organization_country,
    receipt.organization_email,
  ]
    .filter((value): value is string => !!value)
    .map((value) => `<div>${escapeHtml(value)}</div>`)
    .join("");
  const legalDetails = [receipt.organization_legal_number, receipt.organization_tax_id]
    .filter((value): value is string => !!value)
    .map((value) => `<div>${escapeHtml(value)}</div>`)
    .join("");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Payment receipt ${escapeHtml(receipt.number)}</title><style>@page{size:A4;margin:12mm}*{box-sizing:border-box}body{font:13px system-ui,sans-serif;color:#172033}h1{font-size:28px;margin:0}.header{display:flex;justify-content:space-between;border-bottom:2px solid #172033;padding-bottom:18px}.meta{text-align:right}.parties{display:grid;grid-template-columns:1fr 1fr;gap:32px;margin:28px 0}.label{color:#667085;font-size:11px;text-transform:uppercase;letter-spacing:.04em;margin-bottom:6px}.amount{font-size:30px;font-weight:700;margin:28px 0 5px}.paid-on{color:#475467}.details{margin:24px 0}.details div{display:flex;gap:16px;padding:5px 0}.details strong{min-width:125px}table{width:100%;border-collapse:collapse}th,td{padding:10px;border-bottom:1px solid #d7dce5;text-align:left}.number{text-align:right}.invoices{margin-top:28px}.invoices h2{font-size:16px}.footer{white-space:pre-wrap;margin-top:40px;color:#667085;font-size:11px}</style></head><body><section class="header"><div><h1>Payment receipt</h1><div>${escapeHtml(receipt.number)}</div></div><div class="meta"><strong>PAID</strong><br>${escapeHtml(receipt.payment_created_at.slice(0, 10))}</div></section><section class="parties"><div><div class="label">From</div><strong>${escapeHtml(receipt.organization_legal_name ?? receipt.organization_name)}</strong>${legalDetails}${organizationAddress}</div><div><div class="label">To</div><strong>${escapeHtml(receipt.customer_name ?? receipt.customer_external_id)}</strong>${receipt.customer_email ? `<div>${escapeHtml(receipt.customer_email)}</div>` : ""}<div>${escapeHtml(receipt.customer_external_id)}</div></div></section><div class="amount">${formatMinor(receipt.amount_minor, receipt.currency)}</div><div class="paid-on">Paid on ${escapeHtml(receipt.payment_created_at.slice(0, 10))}</div><section class="details"><div><strong>Payment method</strong><span>${escapeHtml(paymentMethod)}</span></div><div><strong>Payment ID</strong><span>${escapeHtml(receipt.payment_id)}</span></div><div><strong>Payable type</strong><span>${escapeHtml(receipt.payable_type)}</span></div></section>${invoiceTable}<div class="footer">${receipt.invoice_footer ? `${escapeHtml(receipt.invoice_footer)}\n\n` : ""}Generated from immutable payment receipt version ${receipt.version}. XML e-invoicing is not enabled.</div></body></html>`;
}

async function loadPaymentReceipt(database: D1Database, paymentReceiptId: string) {
  return database
    .prepare(
      `SELECT receipt.id, receipt.organization_id, receipt.number, receipt.version,
              receipt.payment_id, payment.payable_type, payment.invoice_ids_json,
              payment.invoice_numbers_json, payment.provider, payment.provider_account_code,
              payment.provider_transaction_id, payment.payment_type, payment.reference,
              payment.amount_minor, payment.currency,
              payment.created_at AS payment_created_at,
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
       FROM payment_receipts receipt
       JOIN (${paymentRows()}) payment ON payment.id = receipt.payment_id
         AND ((receipt.payment_kind = 'invoice' AND payment.payable_type = 'Invoice')
           OR (receipt.payment_kind = 'payment_request'
               AND payment.payable_type = 'PaymentRequest'))
       JOIN organizations organization ON organization.id = receipt.organization_id
       JOIN customers customer ON customer.id = receipt.customer_id
       WHERE receipt.id = ? LIMIT 1`,
    )
    .bind(paymentReceiptId)
    .first<PaymentReceiptDocumentRow>();
}

async function loadInvoices(database: D1Database, invoiceIds: string[]) {
  if (invoiceIds.length === 0) return [];
  const placeholders = invoiceIds.map(() => "?").join(", ");
  const result = await database
    .prepare(
      `SELECT id, number, total_due_minor, currency FROM invoices
       WHERE id IN (${placeholders}) ORDER BY created_at, id`,
    )
    .bind(...invoiceIds)
    .all<ReceiptInvoiceRow>();
  return [...result.results];
}

function jsonStringArray(value: string): string[] {
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed)
      ? parsed.filter((entry): entry is string => typeof entry === "string")
      : [];
  } catch {
    return [];
  }
}

async function sha256HexBytes(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function readBoundedBytes(stream: ReadableStream<Uint8Array>, maximum: number) {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maximum) throw new Error("pdf_too_large");
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

function startsWithPdfSignature(bytes: Uint8Array): boolean {
  return bytes.length >= 5 && String.fromCharCode(...bytes.slice(0, 5)) === "%PDF-";
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
