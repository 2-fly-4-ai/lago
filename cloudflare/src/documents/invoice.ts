import { deterministicUuid } from "../identifiers";

const MAX_PDF_BYTES = 10 * 1024 * 1024;

type InvoiceDocumentRow = {
  id: string;
  organization_id: string;
  number: string | null;
  status: string;
  currency: string;
  subtotal_minor: number;
  tax_minor: number;
  credits_minor: number;
  total_due_minor: number;
  version: number;
  finalized_at: string | null;
  customer_external_id: string;
  customer_name: string | null;
  customer_email: string | null;
};

type InvoiceLineDocumentRow = {
  description: string;
  quantity_decimal: string;
  unit_amount_decimal: string;
  amount_minor: number;
};

export type PdfRenderer = {
  render(html: string): Promise<Response>;
};

export function browserPdfRenderer(browser: BrowserRun): PdfRenderer {
  return {
    render: (html) =>
      browser.quickAction("pdf", {
        html,
        gotoOptions: { waitUntil: "load", timeout: 30_000 },
        rejectResourceTypes: ["image", "media", "font", "websocket"],
        actionTimeout: 30_000,
        cacheTTL: 0,
        pdfOptions: {
          format: "a4",
          printBackground: true,
          preferCSSPageSize: true,
          margin: { top: "12mm", right: "12mm", bottom: "12mm", left: "12mm" },
          tagged: true,
          timeout: 30_000,
        },
      }),
  };
}

export async function generateInvoicePdf(
  env: Pick<Env, "BILLING_DB" | "BILLING_ARTIFACTS">,
  invoiceId: string,
  renderer: PdfRenderer,
): Promise<{ artifactId: string; objectKey: string; sha256: string; byteLength: number }> {
  const invoice = await loadInvoice(env.BILLING_DB, invoiceId);
  if (!invoice || invoice.status !== "finalized") throw new Error("invoice_not_finalized");
  const lines = await loadLines(env.BILLING_DB, invoice.id);
  const artifactId = await deterministicUuid("invoice-pdf", `${invoice.id}:v${invoice.version}`);
  const objectKey = `invoices/${invoice.organization_id}/${invoice.id}/v${invoice.version}.pdf`;
  const now = new Date().toISOString();
  await env.BILLING_DB.prepare(
    `INSERT INTO document_artifacts
     (id, organization_id, resource_type, resource_id, resource_version, artifact_type,
      status, created_at, updated_at)
     VALUES (?, ?, 'invoice', ?, ?, 'pdf', 'generating', ?, ?)
     ON CONFLICT(resource_type, resource_id, resource_version, artifact_type) DO UPDATE SET
       status = CASE WHEN document_artifacts.status = 'ready' THEN 'ready' ELSE 'generating' END,
       failure_code = NULL,
       updated_at = excluded.updated_at`,
  )
    .bind(artifactId, invoice.organization_id, invoice.id, invoice.version, now, now)
    .run();
  const existing = await env.BILLING_DB.prepare(
    `SELECT object_key, content_sha256, byte_length FROM document_artifacts
     WHERE id = ? AND status = 'ready'`,
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
    const response = await renderer.render(renderInvoiceHtml(invoice, lines));
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
        invoiceId: invoice.id,
        invoiceVersion: String(invoice.version),
        sha256,
      },
    });
    const generatedAt = new Date().toISOString();
    await env.BILLING_DB.prepare(
      `UPDATE document_artifacts
       SET status = 'ready', object_key = ?, content_sha256 = ?, byte_length = ?,
           generated_at = ?, updated_at = ?
       WHERE id = ?`,
    )
      .bind(objectKey, sha256, bytes.byteLength, generatedAt, generatedAt, artifactId)
      .run();
    return { artifactId, objectKey, sha256, byteLength: bytes.byteLength };
  } catch (error) {
    const code = error instanceof Error ? error.message.slice(0, 100) : "unknown_error";
    await env.BILLING_DB.prepare(
      `UPDATE document_artifacts SET status = 'failed', failure_code = ?, updated_at = ?
       WHERE id = ? AND status <> 'ready'`,
    )
      .bind(code, new Date().toISOString(), artifactId)
      .run();
    throw error;
  }
}

export function renderInvoiceHtml(
  invoice: InvoiceDocumentRow,
  lines: InvoiceLineDocumentRow[],
): string {
  const rows = lines
    .map(
      (line) =>
        `<tr><td>${escapeHtml(line.description)}</td><td class="number">${escapeHtml(line.quantity_decimal)}</td><td class="number">${formatMinor(line.unit_amount_decimal, invoice.currency)}</td><td class="number">${formatMinor(String(line.amount_minor), invoice.currency)}</td></tr>`,
    )
    .join("");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Invoice ${escapeHtml(invoice.number ?? invoice.id)}</title><style>@page{size:A4;margin:12mm}*{box-sizing:border-box}body{font:13px system-ui,sans-serif;color:#172033}h1{font-size:28px;margin:0}.header{display:flex;justify-content:space-between;border-bottom:2px solid #172033;padding-bottom:18px}.meta{text-align:right}.customer{margin:28px 0}table{width:100%;border-collapse:collapse}th,td{padding:10px;border-bottom:1px solid #d7dce5;text-align:left}.number{text-align:right}.totals{margin:24px 0 0 auto;width:45%}.totals div{display:flex;justify-content:space-between;padding:5px}.total{font-size:17px;font-weight:700;border-top:2px solid #172033;margin-top:5px;padding-top:10px!important}.footer{margin-top:40px;color:#667085;font-size:11px}</style></head><body><section class="header"><div><h1>Invoice</h1><div>${escapeHtml(invoice.number ?? invoice.id)}</div></div><div class="meta"><strong>${escapeHtml(invoice.status.toUpperCase())}</strong><br>Issued ${escapeHtml(invoice.finalized_at?.slice(0, 10) ?? "—")}</div></section><section class="customer"><strong>Bill to</strong><br>${escapeHtml(invoice.customer_name ?? invoice.customer_external_id)}<br>${escapeHtml(invoice.customer_email ?? "")}</section><table><thead><tr><th>Description</th><th class="number">Quantity</th><th class="number">Unit</th><th class="number">Amount</th></tr></thead><tbody>${rows}</tbody></table><section class="totals"><div><span>Subtotal</span><span>${formatMinor(String(invoice.subtotal_minor), invoice.currency)}</span></div><div><span>Tax</span><span>${formatMinor(String(invoice.tax_minor), invoice.currency)}</span></div><div><span>Credits</span><span>-${formatMinor(String(invoice.credits_minor), invoice.currency)}</span></div><div class="total"><span>Total due</span><span>${formatMinor(String(invoice.total_due_minor), invoice.currency)}</span></div></section><div class="footer">Generated from immutable invoice version ${invoice.version}. Amounts are shown in ${escapeHtml(invoice.currency)}.</div></body></html>`;
}

async function loadInvoice(database: D1Database, invoiceId: string) {
  return database
    .prepare(
      `SELECT i.id, i.organization_id, i.number, i.status, i.currency, i.subtotal_minor,
              i.tax_minor, i.credits_minor, i.total_due_minor, i.version, i.finalized_at,
              c.external_id AS customer_external_id, c.name AS customer_name,
              c.email AS customer_email
       FROM invoices i JOIN customers c ON c.id = i.customer_id WHERE i.id = ? LIMIT 1`,
    )
    .bind(invoiceId)
    .first<InvoiceDocumentRow>();
}

async function loadLines(database: D1Database, invoiceId: string) {
  const result = await database
    .prepare(
      `SELECT description, quantity_decimal, unit_amount_decimal, amount_minor
       FROM invoice_lines WHERE invoice_id = ? ORDER BY created_at, id`,
    )
    .bind(invoiceId)
    .all<InvoiceLineDocumentRow>();
  return [...result.results];
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

function formatMinor(value: string, currency: string): string {
  const number = Number(value) / 100;
  return Number.isFinite(number)
    ? new Intl.NumberFormat("en", { style: "currency", currency }).format(number)
    : `${currency} ${escapeHtml(value)}`;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
