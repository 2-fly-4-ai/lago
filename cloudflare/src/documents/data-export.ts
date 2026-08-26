import type { DomainEvent } from "../domain-events";
import {
  dataExportOutboxStatement,
  type DataExportResourceType,
  type DataExportRow,
  requiredDataExport,
} from "../api/data-exports";
import { stableJson } from "../json";

type GenerationResult = {
  dataExportId: string;
  objectKey: string;
  etag: string;
  byteSize: number;
  rowCount: number;
  filename: string;
};

type CsvState = { rowCount: number };
type Cursor = { createdAt: string; id: string } | null;
type Filters = Record<string, unknown>;

const PAGE_SIZE = 100;
const INVOICE_HEADERS = [
  "lago_id",
  "sequential_id",
  "partner_billing",
  "issuing_date",
  "customer_lago_id",
  "customer_external_id",
  "customer_name",
  "customer_email",
  "customer_country",
  "customer_tax_identification_number",
  "invoice_number",
  "invoice_type",
  "payment_status",
  "status",
  "file_url",
  "currency",
  "fees_amount_cents",
  "coupons_amount_cents",
  "taxes_amount_cents",
  "credit_notes_amount_cents",
  "prepaid_credit_amount_cents",
  "total_amount_cents",
  "payment_due_date",
  "payment_dispute_lost_at",
  "payment_overdue",
  "total_due_amount_cents",
  "total_paid_amount_cents",
  "total_offsetted_credit_note_amount_cents",
  "progressive_billing_credit_amount_cents",
];
const INVOICE_FEE_HEADERS = [
  "invoice_lago_id",
  "invoice_number",
  "invoice_issuing_date",
  "fee_lago_id",
  "fee_item_type",
  "fee_item_code",
  "fee_item_name",
  "fee_item_description",
  "fee_item_invoice_display_name",
  "fee_item_filter_invoice_display_name",
  "fee_item_grouped_by",
  "subscription_external_id",
  "subscription_plan_code",
  "fee_from_date_utc",
  "fee_to_date_utc",
  "fee_amount_currency",
  "fee_units",
  "fee_precise_unit_amount",
  "fee_taxes_amount_cents",
  "fee_total_amount_cents",
];
const CREDIT_NOTE_HEADERS = [
  "lago_id",
  "sequential_id",
  "partner_billing",
  "issuing_date",
  "customer_lago_id",
  "customer_external_id",
  "customer_name",
  "customer_email",
  "customer_country",
  "customer_tax_identification_number",
  "number",
  "invoice_number",
  "credit_status",
  "refund_status",
  "reason",
  "description",
  "currency",
  "total_amount_cents",
  "taxes_amount_cents",
  "sub_total_excluding_taxes_amount_cents",
  "coupons_adjustment_amount_cents",
  "offset_amount_cents",
  "credit_amount_cents",
  "balance_amount_cents",
  "refund_amount_cents",
  "file_url",
];
const CREDIT_NOTE_ITEM_HEADERS = [
  "credit_note_lago_id",
  "credit_note_number",
  "credit_note_invoice_number",
  "credit_note_issuing_date",
  "credit_note_item_lago_id",
  "credit_note_item_fee_lago_id",
  "credit_note_item_currency",
  "credit_note_item_amount_cents",
];

export async function generateDataExport(
  env: Env,
  dataExportId: string,
): Promise<GenerationResult> {
  let row = await ownedDataExport(env.BILLING_DB, dataExportId);
  if (row.status === "completed") return completedResult(env, row);
  if (row.status === "failed") throw new Error("data_export_failed");
  if (row.status === "pending") row = await claimDataExport(env, row);
  if (row.status !== "processing") throw new Error("data_export_not_processing");

  const filters = parseFilters(row.resource_query_json);
  const objectKey = `data-exports/${row.organization_id}/${row.id}/v1.csv`;
  const filename = `${compactTimestamp(row.created_at)}_${row.resource_type}.csv`;
  const measurement = await measureCsv(env.BILLING_DB, row, filters);
  const fixed = new FixedLengthStream(measurement.byteSize);
  const writer = fixed.writable.getWriter();
  const write = writeCsv(writer, env.BILLING_DB, row, filters, measurement.rowCount);
  const put = env.BILLING_ARTIFACTS.put(objectKey, fixed.readable, {
    httpMetadata: {
      contentType: "text/csv; charset=utf-8",
      contentDisposition: `attachment; filename="${filename}"`,
    },
    customMetadata: {
      dataExportId: row.id,
      organizationId: row.organization_id,
      resourceType: row.resource_type,
    },
  });
  const [object] = await Promise.all([put, write]);
  if (!object) throw new Error("data_export_r2_write_failed");
  return completeDataExport(env, row, {
    dataExportId: row.id,
    objectKey,
    etag: object.etag,
    byteSize: object.size,
    rowCount: measurement.rowCount,
    filename,
  });
}

async function measureCsv(
  database: D1Database,
  row: DataExportRow,
  filters: Filters,
): Promise<{ byteSize: number; rowCount: number }> {
  const state: CsvState = { rowCount: 0 };
  let byteSize = 0;
  const encoder = new TextEncoder();
  for await (const chunk of csvChunks(database, row, filters, state)) {
    byteSize += encoder.encode(chunk).byteLength;
  }
  return { byteSize, rowCount: state.rowCount };
}

async function writeCsv(
  writer: WritableStreamDefaultWriter<Uint8Array>,
  database: D1Database,
  row: DataExportRow,
  filters: Filters,
  expectedRows: number,
): Promise<void> {
  const state: CsvState = { rowCount: 0 };
  const encoder = new TextEncoder();
  try {
    for await (const chunk of csvChunks(database, row, filters, state)) {
      await writer.write(encoder.encode(chunk));
    }
    if (state.rowCount !== expectedRows) throw new Error("data_export_snapshot_changed");
    await writer.close();
  } catch (error) {
    await writer.abort(error);
    throw error;
  }
}

export async function failDataExport(
  env: Pick<Env, "BILLING_DB" | "DOMAIN_EVENTS">,
  dataExportId: string,
  correlationId: string,
): Promise<void> {
  const row = await ownedDataExport(env.BILLING_DB, dataExportId);
  if (row.status === "completed" || row.status === "failed") return;
  const now = new Date().toISOString();
  const nextVersion = row.version + 1;
  const event = exportEvent("data_export.failed", row, nextVersion, now, correlationId, {
    status: "failed",
    errorCode: "data_export_generation_failed",
  });
  const results = await env.BILLING_DB.batch([
    env.BILLING_DB.prepare(
      `UPDATE data_exports SET status = 'failed', error_code = 'data_export_generation_failed',
       version = version + 1, updated_at = ?
       WHERE id = ? AND organization_id = ? AND version = ? AND status IN ('pending', 'processing')`,
    ).bind(now, row.id, row.organization_id, row.version),
    dataExportOutboxStatement(env.BILLING_DB, row.organization_id, event),
  ]);
  if ((results[0]?.meta.changes ?? 0) === 1) await env.DOMAIN_EVENTS.send(event);
}

async function claimDataExport(env: Env, row: DataExportRow): Promise<DataExportRow> {
  const now = new Date().toISOString();
  const event = exportEvent("data_export.processing", row, row.version + 1, now, row.id, {
    status: "processing",
  });
  try {
    const results = await env.BILLING_DB.batch([
      env.BILLING_DB.prepare(
        `UPDATE data_exports SET status = 'processing', started_at = ?, version = version + 1,
         updated_at = ? WHERE id = ? AND organization_id = ? AND version = ? AND status = 'pending'`,
      ).bind(now, now, row.id, row.organization_id, row.version),
      dataExportOutboxStatement(env.BILLING_DB, row.organization_id, event),
    ]);
    if ((results[0]?.meta.changes ?? 0) === 1) await env.DOMAIN_EVENTS.send(event);
  } catch {
    // A concurrent/replayed workflow may already own the processing transition.
  }
  return ownedDataExport(env.BILLING_DB, row.id);
}

async function completeDataExport(
  env: Env,
  row: DataExportRow,
  result: GenerationResult,
): Promise<GenerationResult> {
  const now = new Date().toISOString();
  const expiresAt = new Date(Date.parse(now) + 7 * 24 * 60 * 60 * 1000).toISOString();
  const event = exportEvent("data_export.completed", row, row.version + 1, now, row.id, {
    status: "completed",
    resourceType: row.resource_type,
    rowCount: result.rowCount,
  });
  try {
    const results = await env.BILLING_DB.batch([
      env.BILLING_DB.prepare(
        `UPDATE data_exports SET status = 'completed', object_key = ?, filename = ?, etag = ?,
         byte_size = ?, row_count = ?, completed_at = ?, expires_at = ?, version = version + 1,
         updated_at = ? WHERE id = ? AND organization_id = ? AND version = ? AND status = 'processing'`,
      ).bind(
        result.objectKey,
        result.filename,
        result.etag,
        result.byteSize,
        result.rowCount,
        now,
        expiresAt,
        now,
        row.id,
        row.organization_id,
        row.version,
      ),
      dataExportOutboxStatement(env.BILLING_DB, row.organization_id, event),
    ]);
    if ((results[0]?.meta.changes ?? 0) !== 1) throw new Error("data_export_version_conflict");
    await env.DOMAIN_EVENTS.send(event);
    return result;
  } catch (error) {
    const current = await ownedDataExport(env.BILLING_DB, row.id);
    if (current.status === "completed") return completedResult(env, current);
    throw error;
  }
}

async function completedResult(
  env: Pick<Env, "BILLING_ARTIFACTS">,
  row: DataExportRow,
): Promise<GenerationResult> {
  if (!row.object_key || !row.filename || row.row_count === null)
    throw new Error("invalid_data_export_artifact");
  const object = await env.BILLING_ARTIFACTS.head(row.object_key);
  if (!object) throw new Error("data_export_artifact_missing");
  return {
    dataExportId: row.id,
    objectKey: row.object_key,
    etag: object.etag,
    byteSize: object.size,
    rowCount: row.row_count,
    filename: row.filename,
  };
}

async function ownedDataExport(database: D1Database, id: string): Promise<DataExportRow> {
  const owner = await database
    .prepare("SELECT organization_id FROM data_exports WHERE id = ? LIMIT 1")
    .bind(id)
    .first<{ organization_id: string }>();
  if (!owner) throw new Error("data_export_not_found");
  return requiredDataExport(database, owner.organization_id, id);
}

async function* csvChunks(
  database: D1Database,
  row: DataExportRow,
  filters: Filters,
  state: CsvState,
): AsyncGenerator<string> {
  yield `${csvLine(headersFor(row.resource_type))}\n`;
  let cursor: Cursor = null;
  while (true) {
    if (row.resource_type === "invoices" || row.resource_type === "invoice_fees") {
      const invoices = await invoiceBatch(database, row, filters, cursor);
      if (invoices.length === 0) return;
      if (row.resource_type === "invoices") {
        const lines = invoices.map(invoiceCsvRow);
        state.rowCount += lines.length;
        yield lines.map((line) => `${csvLine(line)}\n`).join("");
      } else {
        const fees = await feeRows(
          database,
          invoices.map((invoice) => invoice.id),
        );
        state.rowCount += fees.length;
        if (fees.length > 0) yield fees.map((fee) => `${csvLine(feeCsvRow(fee))}\n`).join("");
      }
      const last = invoices.at(-1)!;
      cursor = { createdAt: last.created_at, id: last.id };
      continue;
    }

    const notes = await creditNoteBatch(database, row, filters, cursor);
    if (notes.length === 0) return;
    if (row.resource_type === "credit_notes") {
      const lines = notes.map(creditNoteCsvRow);
      state.rowCount += lines.length;
      yield lines.map((line) => `${csvLine(line)}\n`).join("");
    } else {
      const items = await creditNoteItemRows(
        database,
        notes.map((note) => note.id),
      );
      state.rowCount += items.length;
      if (items.length > 0)
        yield items.map((item) => `${csvLine(creditNoteItemCsvRow(item))}\n`).join("");
    }
    const last = notes.at(-1)!;
    cursor = { createdAt: last.created_at, id: last.id };
  }
}

type InvoiceExportRow = {
  id: string;
  number: string | null;
  issuing_date: string | null;
  customer_id: string;
  customer_external_id: string;
  customer_name: string | null;
  customer_email: string | null;
  invoice_type: string;
  payment_status: string;
  status: string;
  currency: string;
  subtotal_minor: number;
  coupons_minor: number;
  tax_minor: number;
  credit_notes_minor: number;
  prepaid_credit_minor: number;
  total_due_minor: number;
  payment_due_date: string | null;
  payment_overdue: number;
  total_paid_minor: number;
  total_offset_minor: number;
  progressive_credit_minor: number;
  pdf_ready: number;
  created_at: string;
};

async function invoiceBatch(
  database: D1Database,
  exportRow: DataExportRow,
  filters: Filters,
  cursor: Cursor,
): Promise<InvoiceExportRow[]> {
  const where = ["i.organization_id = ?", "i.created_at <= ?"];
  const values: (string | number)[] = [exportRow.organization_id, exportRow.created_at];
  numberFilter(where, values, "i.total_due_minor", filters.amount_from, ">=");
  numberFilter(where, values, "i.total_due_minor", filters.amount_to, "<=");
  exactFilter(where, values, "i.currency", filters.currency);
  exactFilter(where, values, "c.external_id", filters.customer_external_id);
  arrayFilter(where, values, "i.invoice_type", filters.invoice_type);
  dateFilter(where, values, "i.issuing_date", filters.issuing_date_from, ">=");
  dateFilter(where, values, "i.issuing_date", filters.issuing_date_to, "<=");
  booleanFilter(where, values, "i.payment_overdue", filters.payment_overdue);
  arrayFilter(where, values, "i.payment_status", filters.payment_status);
  arrayFilter(where, values, "i.status", filters.status);
  retainedBillingEntityFilter(where, filters.billing_entity_ids, exportRow.organization_id);
  if (filters.payment_dispute_lost === true || filters.self_billed === true) where.push("0 = 1");
  if (typeof filters.search_term === "string") {
    where.push(
      "(LOWER(COALESCE(i.number, '')) LIKE ? ESCAPE '\\' OR LOWER(c.external_id) LIKE ? ESCAPE '\\' OR LOWER(COALESCE(c.name, '')) LIKE ? ESCAPE '\\' OR LOWER(COALESCE(c.email, '')) LIKE ? ESCAPE '\\')",
    );
    const term = `%${escapeLike(filters.search_term.toLowerCase())}%`;
    values.push(term, term, term, term);
  }
  addCursor(where, values, "i", cursor);
  const result = await database
    .prepare(
      `SELECT i.id, i.number, i.issuing_date, i.customer_id,
              c.external_id AS customer_external_id, c.name AS customer_name,
              c.email AS customer_email, i.invoice_type, i.payment_status, i.status, i.currency,
              i.subtotal_minor, i.coupons_minor, i.tax_minor, i.credit_notes_minor,
              i.prepaid_credit_minor, i.total_due_minor, i.payment_due_date, i.payment_overdue,
              COALESCE((SELECT SUM(amount_minor) FROM (
                SELECT payment.amount_minor FROM payment_attempts payment
                WHERE payment.invoice_id = i.id AND payment.status = 'succeeded'
                UNION ALL
                SELECT allocation.amount_minor FROM payment_request_payment_allocations allocation
                WHERE allocation.invoice_id = i.id
              )), 0) AS total_paid_minor,
              COALESCE((SELECT SUM(offset_amount_minor) FROM credit_notes note
                WHERE note.invoice_id = i.id AND note.credit_status <> 'voided'), 0) AS total_offset_minor,
              COALESCE(i.progressive_billing_credit_minor, 0) AS progressive_credit_minor,
              CASE WHEN artifact.status = 'ready' THEN 1 ELSE 0 END AS pdf_ready,
              i.created_at
       FROM invoices i JOIN customers c ON c.id = i.customer_id
       LEFT JOIN document_artifacts artifact
         ON artifact.resource_type = 'invoice' AND artifact.resource_id = i.id
        AND artifact.resource_version = i.version AND artifact.artifact_type = 'pdf'
       WHERE ${where.join(" AND ")}
       ORDER BY i.created_at DESC, i.id DESC LIMIT ?`,
    )
    .bind(...values, PAGE_SIZE)
    .all<InvoiceExportRow>();
  return result.results;
}

function invoiceCsvRow(row: InvoiceExportRow): unknown[] {
  return [
    row.id,
    null,
    false,
    row.issuing_date,
    row.customer_id,
    row.customer_external_id,
    row.customer_name,
    row.customer_email,
    null,
    null,
    row.number,
    row.invoice_type,
    row.payment_status,
    row.status,
    row.pdf_ready === 1 ? `/api/v1/invoices/${encodeURIComponent(row.id)}/download` : null,
    row.currency,
    row.subtotal_minor,
    row.coupons_minor,
    row.tax_minor,
    row.credit_notes_minor,
    row.prepaid_credit_minor,
    row.total_due_minor,
    row.payment_due_date,
    null,
    row.payment_overdue === 1,
    Math.max(row.total_due_minor - row.total_paid_minor, 0),
    row.total_paid_minor,
    row.total_offset_minor,
    row.progressive_credit_minor,
  ];
}

type FeeExportRow = {
  invoice_id: string;
  invoice_number: string | null;
  invoice_issuing_date: string | null;
  fee_id: string;
  line_type: string;
  description: string;
  quantity_decimal: string;
  unit_amount_decimal: string;
  amount_minor: number;
  source_id: string;
  metadata_json: string;
  currency: string;
  external_subscription_id: string | null;
  plan_code: string | null;
  taxes_minor: number;
};

async function feeRows(database: D1Database, invoiceIds: string[]): Promise<FeeExportRow[]> {
  if (invoiceIds.length === 0) return [];
  const result = await database
    .prepare(
      `SELECT line.invoice_id, invoice.number AS invoice_number,
              invoice.issuing_date AS invoice_issuing_date, line.id AS fee_id, line.line_type,
              line.description, line.quantity_decimal, line.unit_amount_decimal, line.amount_minor,
              line.source_id, line.metadata_json, invoice.currency,
              subscription.external_id AS external_subscription_id, plan.code AS plan_code,
              COALESCE((SELECT SUM(tax.amount_minor) FROM invoice_line_taxes tax
                WHERE tax.invoice_line_id = line.id), 0) AS taxes_minor
       FROM invoice_lines line JOIN invoices invoice ON invoice.id = line.invoice_id
       LEFT JOIN subscriptions subscription ON subscription.id = invoice.subscription_id
       LEFT JOIN plans plan ON plan.id = subscription.plan_id
       WHERE line.invoice_id IN (${placeholders(invoiceIds.length)})
       ORDER BY invoice.created_at DESC, invoice.id DESC, line.created_at, line.id`,
    )
    .bind(...invoiceIds)
    .all<FeeExportRow>();
  return result.results;
}

function feeCsvRow(row: FeeExportRow): unknown[] {
  const metadata = parseObject(row.metadata_json);
  return [
    row.invoice_id,
    row.invoice_number,
    row.invoice_issuing_date,
    row.fee_id,
    row.line_type,
    stringMetadata(metadata, "code") ?? row.source_id,
    stringMetadata(metadata, "name") ?? row.description,
    row.description,
    stringMetadata(metadata, "invoiceDisplayName") ?? row.description,
    stringMetadata(metadata, "filterInvoiceDisplayName"),
    metadata.groupedBy ?? null,
    row.external_subscription_id,
    row.plan_code,
    stringMetadata(metadata, "fromDate") ?? stringMetadata(metadata, "periodStart"),
    stringMetadata(metadata, "toDate") ?? stringMetadata(metadata, "periodEnd"),
    row.currency,
    row.quantity_decimal,
    row.unit_amount_decimal,
    row.taxes_minor,
    row.amount_minor + row.taxes_minor,
  ];
}

type CreditNoteExportRow = {
  id: string;
  sequential_id: number;
  issuing_date: string;
  customer_id: string;
  customer_external_id: string;
  customer_name: string | null;
  customer_email: string | null;
  number: string;
  invoice_number: string | null;
  credit_status: string;
  reason: string;
  description: string | null;
  currency: string;
  total_amount_minor: number;
  taxes_amount_minor: number;
  coupons_adjustment_minor: number;
  offset_amount_minor: number;
  credit_amount_minor: number;
  balance_amount_minor: number;
  refund_amount_minor: number;
  pdf_ready: number;
  created_at: string;
};

async function creditNoteBatch(
  database: D1Database,
  exportRow: DataExportRow,
  filters: Filters,
  cursor: Cursor,
): Promise<CreditNoteExportRow[]> {
  const where = ["cn.organization_id = ?", "cn.created_at <= ?"];
  const values: (string | number)[] = [exportRow.organization_id, exportRow.created_at];
  numberFilter(
    where,
    values,
    "COALESCE(financial.total_amount_minor, cn.total_amount_minor)",
    filters.amount_from,
    ">=",
  );
  numberFilter(
    where,
    values,
    "COALESCE(financial.total_amount_minor, cn.total_amount_minor)",
    filters.amount_to,
    "<=",
  );
  exactFilter(where, values, "cn.currency", filters.currency);
  exactFilter(where, values, "c.external_id", filters.customer_external_id);
  exactFilter(where, values, "cn.customer_id", filters.customer_id);
  exactFilter(where, values, "invoice.number", filters.invoice_number);
  arrayFilter(where, values, "cn.credit_status", filters.credit_status);
  arrayFilter(where, values, "cn.reason", filters.reason);
  dateFilter(where, values, "cn.issuing_date", filters.issuing_date_from, ">=");
  dateFilter(where, values, "cn.issuing_date", filters.issuing_date_to, "<=");
  retainedBillingEntityFilter(where, filters.billing_entity_ids, exportRow.organization_id);
  if (filters.self_billed === true) where.push("0 = 1");
  arrayFilter(where, values, "financial.refund_status", filters.refund_status);
  if (Array.isArray(filters.types) && !filters.types.includes("credit")) where.push("0 = 1");
  if (typeof filters.search_term === "string") {
    where.push(
      "(LOWER(cn.number) LIKE ? ESCAPE '\\' OR LOWER(COALESCE(invoice.number, '')) LIKE ? ESCAPE '\\' OR LOWER(c.external_id) LIKE ? ESCAPE '\\' OR LOWER(COALESCE(c.name, '')) LIKE ? ESCAPE '\\')",
    );
    const term = `%${escapeLike(filters.search_term.toLowerCase())}%`;
    values.push(term, term, term, term);
  }
  addCursor(where, values, "cn", cursor);
  const result = await database
    .prepare(
      `SELECT cn.id, cn.sequential_id, cn.issuing_date, cn.customer_id,
              c.external_id AS customer_external_id, c.name AS customer_name,
              c.email AS customer_email, cn.number, invoice.number AS invoice_number,
              cn.credit_status, cn.reason, cn.description, cn.currency,
              COALESCE(financial.total_amount_minor, cn.total_amount_minor) AS total_amount_minor,
              COALESCE(financial.taxes_amount_minor, cn.taxes_amount_minor) AS taxes_amount_minor,
              COALESCE(financial.coupons_adjustment_minor, cn.coupons_adjustment_minor)
                AS coupons_adjustment_minor,
              COALESCE(financial.offset_amount_minor, cn.offset_amount_minor) AS offset_amount_minor,
              COALESCE(financial.credit_amount_minor, cn.credit_amount_minor) AS credit_amount_minor,
              cn.balance_amount_minor,
              COALESCE(financial.refund_amount_minor, cn.refund_amount_minor) AS refund_amount_minor,
              CASE WHEN artifact.status = 'ready' THEN 1 ELSE 0 END AS pdf_ready, cn.created_at
       FROM credit_notes cn JOIN customers c ON c.id = cn.customer_id
       JOIN invoices invoice ON invoice.id = cn.invoice_id
       LEFT JOIN credit_note_financials financial ON financial.credit_note_id = cn.id
       LEFT JOIN credit_note_document_artifacts artifact
         ON artifact.credit_note_id = cn.id AND artifact.credit_note_version = cn.version
       WHERE ${where.join(" AND ")}
       ORDER BY cn.created_at DESC, cn.id DESC LIMIT ?`,
    )
    .bind(...values, PAGE_SIZE)
    .all<CreditNoteExportRow>();
  return result.results;
}

function creditNoteCsvRow(row: CreditNoteExportRow): unknown[] {
  return [
    row.id,
    row.sequential_id,
    false,
    row.issuing_date,
    row.customer_id,
    row.customer_external_id,
    row.customer_name,
    row.customer_email,
    null,
    null,
    row.number,
    row.invoice_number,
    row.credit_status,
    null,
    row.reason,
    row.description,
    row.currency,
    row.total_amount_minor,
    row.taxes_amount_minor,
    row.total_amount_minor - row.taxes_amount_minor,
    row.coupons_adjustment_minor,
    row.offset_amount_minor,
    row.credit_amount_minor,
    row.balance_amount_minor,
    row.refund_amount_minor,
    row.pdf_ready === 1 ? `/api/v1/credit_notes/${encodeURIComponent(row.id)}/download` : null,
  ];
}

type CreditNoteItemExportRow = {
  credit_note_id: string;
  credit_note_number: string;
  invoice_number: string | null;
  issuing_date: string;
  item_id: string;
  invoice_line_id: string;
  currency: string;
  amount_minor: number;
};

async function creditNoteItemRows(
  database: D1Database,
  creditNoteIds: string[],
): Promise<CreditNoteItemExportRow[]> {
  if (creditNoteIds.length === 0) return [];
  const result = await database
    .prepare(
      `SELECT cn.id AS credit_note_id, cn.number AS credit_note_number,
              invoice.number AS invoice_number, cn.issuing_date, item.id AS item_id,
              item.invoice_line_id, item.currency, item.amount_minor
       FROM credit_note_items item JOIN credit_notes cn ON cn.id = item.credit_note_id
       JOIN invoices invoice ON invoice.id = cn.invoice_id
       WHERE item.credit_note_id IN (${placeholders(creditNoteIds.length)})
       ORDER BY cn.created_at DESC, cn.id DESC, item.created_at, item.id`,
    )
    .bind(...creditNoteIds)
    .all<CreditNoteItemExportRow>();
  return result.results;
}

function creditNoteItemCsvRow(row: CreditNoteItemExportRow): unknown[] {
  return [
    row.credit_note_id,
    row.credit_note_number,
    row.invoice_number,
    row.issuing_date,
    row.item_id,
    row.invoice_line_id,
    row.currency,
    row.amount_minor,
  ];
}

function headersFor(resourceType: DataExportResourceType): string[] {
  if (resourceType === "invoices") return INVOICE_HEADERS;
  if (resourceType === "invoice_fees") return INVOICE_FEE_HEADERS;
  if (resourceType === "credit_notes") return CREDIT_NOTE_HEADERS;
  return CREDIT_NOTE_ITEM_HEADERS;
}

function csvLine(values: unknown[]): string {
  return values.map(csvValue).join(",");
}

function csvValue(value: unknown): string {
  if (value === null || value === undefined) return "";
  let normalized: string;
  if (typeof value === "boolean") normalized = value ? "true" : "false";
  else if (typeof value === "number") normalized = String(value);
  else if (typeof value === "object") normalized = stableJson(value);
  else normalized = String(value);
  if (/^[=+@\t\r-]/.test(normalized) && typeof value === "string") normalized = `'${normalized}`;
  return /[",\r\n]/.test(normalized) ? `"${normalized.replaceAll('"', '""')}"` : normalized;
}

function parseFilters(value: string): Filters {
  const parsed = JSON.parse(value) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
    throw new Error("invalid_data_export_filters");
  return parsed as Filters;
}

function parseObject(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function stringMetadata(value: Record<string, unknown>, key: string): string | null {
  const candidate = value[key];
  return typeof candidate === "string" ? candidate : null;
}

function exactFilter(
  where: string[],
  values: (string | number)[],
  column: string,
  value: unknown,
): void {
  if (typeof value !== "string") return;
  where.push(`${column} = ?`);
  values.push(value);
}

function numberFilter(
  where: string[],
  values: (string | number)[],
  column: string,
  value: unknown,
  operator: ">=" | "<=",
): void {
  if (typeof value !== "number") return;
  where.push(`${column} ${operator} ?`);
  values.push(value);
}

function dateFilter(
  where: string[],
  values: (string | number)[],
  column: string,
  value: unknown,
  operator: ">=" | "<=",
): void {
  if (typeof value !== "string") return;
  where.push(`${column} ${operator} ?`);
  values.push(value);
}

function booleanFilter(
  where: string[],
  values: (string | number)[],
  column: string,
  value: unknown,
): void {
  if (typeof value !== "boolean") return;
  where.push(`${column} = ?`);
  values.push(value ? 1 : 0);
}

function arrayFilter(
  where: string[],
  values: (string | number)[],
  column: string,
  value: unknown,
): void {
  if (!Array.isArray(value) || value.length === 0) return;
  where.push(`${column} IN (${placeholders(value.length)})`);
  values.push(...(value as string[]));
}

function retainedBillingEntityFilter(
  where: string[],
  value: unknown,
  organizationId: string,
): void {
  if (!Array.isArray(value) || value.length === 0) return;
  if (!value.includes(organizationId)) where.push("0 = 1");
}

function addCursor(
  where: string[],
  values: (string | number)[],
  alias: string,
  cursor: Cursor,
): void {
  if (!cursor) return;
  where.push(`(${alias}.created_at < ? OR (${alias}.created_at = ? AND ${alias}.id < ?))`);
  values.push(cursor.createdAt, cursor.createdAt, cursor.id);
}

function placeholders(count: number): string {
  return Array.from({ length: count }, () => "?").join(", ");
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (match) => `\\${match}`);
}

function compactTimestamp(value: string): string {
  return value
    .replaceAll(/[-:TZ.]/g, "")
    .slice(0, 14)
    .padEnd(14, "0");
}

function exportEvent(
  type: string,
  row: Pick<DataExportRow, "id" | "organization_id">,
  version: number,
  occurredAt: string,
  correlationId: string,
  values: Record<string, unknown>,
): DomainEvent {
  return {
    id: `${type}:${row.id}:v${version}`,
    type,
    version: 1,
    aggregateType: "data_export",
    aggregateId: row.id,
    aggregateVersion: version,
    occurredAt,
    causationId: correlationId,
    correlationId,
    payload: { organizationId: row.organization_id, dataExportId: row.id, ...values },
  };
}
