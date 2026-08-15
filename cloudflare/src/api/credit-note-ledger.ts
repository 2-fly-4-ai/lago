import type { AuthContext } from "../auth/api-key";
import { sha256Hex } from "../auth/api-key";
import type { DomainEvent } from "../domain-events";
import { ApiError, json, objectAt, optionalString, parseJsonObject, requiredString } from "../http";
import { deterministicUuid } from "../identifiers";
import { stableJson } from "../json";

type CreditNoteRow = {
  id: string;
  invoice_id: string;
  invoice_number: string | null;
  customer_id: string;
  customer_external_id: string;
  sequential_id: number;
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
  idempotency_key: string;
  request_sha256: string;
  issuing_date: string;
  created_at: string;
  updated_at: string;
  voided_at: string | null;
  pdf_status: "generating" | "ready" | "failed" | null;
  pdf_object_key: string | null;
};

type InputItem = { lineId: string; amountMinor: number };
const REASONS = new Set([
  "duplicated_charge",
  "product_unsatisfactory",
  "order_change",
  "order_cancellation",
  "fraudulent_charge",
  "other",
]);

export async function handleCreditNoteLedgerRequest(
  request: Request,
  env: Env,
  auth: AuthContext,
  requestId: string,
): Promise<Response | null> {
  const url = new URL(request.url);
  if (request.method === "POST" && url.pathname === "/api/v1/credit_notes")
    return createCreditNote(request, env, auth, requestId);
  if (request.method === "GET" && url.pathname === "/api/v1/credit_notes")
    return listCreditNotes(url, env.BILLING_DB, auth, requestId);
  const match = url.pathname.match(
    /^\/api\/v1\/credit_notes\/([^/]+)(?:\/(void|download|download_pdf|download_xml|resend_email))?$/,
  );
  if (!match?.[1]) return null;
  const id = decodeURIComponent(match[1]);
  if (request.method === "GET" && !match[2])
    return showCreditNote(id, env.BILLING_DB, auth, requestId, url.origin);
  if (request.method === "PUT" && match[2] === "void")
    return voidCreditNote(id, env, auth, requestId, url.origin);
  if (
    (request.method === "POST" || request.method === "GET") &&
    (match[2] === "download" || match[2] === "download_pdf")
  )
    return downloadCreditNote(id, env, auth, requestId);
  if (match[2] === "download_xml")
    throw new ApiError(
      422,
      "credit_note_xml_disabled",
      "Credit note XML requires e-invoicing, which is not implemented by the Cloudflare subset",
    );
  if (match[2])
    throw new ApiError(
      422,
      "unsupported_credit_note_side_effect",
      `${match[2]} is not implemented for Cloudflare credit notes`,
    );
  return null;
}

async function createCreditNote(
  request: Request,
  env: Env,
  auth: AuthContext,
  requestId: string,
): Promise<Response> {
  const input = objectAt(await parseJsonObject(request), "credit_note");
  rejectSideEffects(input);
  const idempotencyKey = requiredIdempotencyKey(request);
  const invoiceId = requiredString(input, "invoice_id");
  const items = parseItems(input.items);
  const total = items.reduce((sum, item) => safeAdd(sum, item.amountMinor), 0);
  const requestedCredit =
    input.credit_amount_cents === undefined
      ? total
      : positiveInteger(input.credit_amount_cents, "credit_amount_cents");
  if (requestedCredit !== total)
    throw new ApiError(422, "does_not_match_item_amounts", "Credit amount must equal item amounts");
  const reason = optionalString(input, "reason") ?? "other";
  if (!REASONS.has(reason)) throw new ApiError(422, "validation_error", "reason is invalid");
  const description = optionalString(input, "description");
  const requestHash = await sha256Hex(
    stableJson({ description, invoiceId, items, reason, requestedCredit }),
  );
  const existing = await findCreditNoteByIdempotencyKey(
    env.BILLING_DB,
    auth.organizationId,
    idempotencyKey,
  );
  if (existing) {
    if (existing.request_sha256 !== requestHash)
      throw new ApiError(
        409,
        "idempotency_conflict",
        "Idempotency-Key was already used with different credit note values",
      );
    return json(
      {
        credit_note: await serializeCreditNote(
          env.BILLING_DB,
          existing,
          new URL(request.url).origin,
        ),
      },
      { requestId },
    );
  }
  const invoice = await env.BILLING_DB.prepare(
    `SELECT id, customer_id, number, status, currency, subtotal_minor, tax_minor,
            coupons_minor, prepaid_credit_minor, credit_notes_minor
     FROM invoices WHERE organization_id = ? AND id = ? LIMIT 1`,
  )
    .bind(auth.organizationId, invoiceId)
    .first<{
      id: string;
      customer_id: string;
      number: string | null;
      status: string;
      currency: string;
      subtotal_minor: number;
      tax_minor: number;
      coupons_minor: number;
      prepaid_credit_minor: number;
      credit_notes_minor: number;
    }>();
  if (!invoice || invoice.status !== "finalized")
    throw new ApiError(404, "invoice_not_found", "Finalized invoice was not found");
  await validateItems(items, env.BILLING_DB, invoice.id, auth.organizationId);
  const remainingInvoice =
    invoice.subtotal_minor + invoice.tax_minor - invoice.coupons_minor - invoice.credit_notes_minor;
  if (total > remainingInvoice)
    throw new ApiError(
      422,
      "higher_than_remaining_invoice_amount",
      "Credit note exceeds the remaining invoice amount",
    );
  const now = new Date().toISOString();
  const sequence = await env.BILLING_DB.prepare(
    "SELECT COALESCE(MAX(sequential_id), 0) + 1 AS next FROM credit_notes WHERE invoice_id = ?",
  )
    .bind(invoiceId)
    .first<{ next: number }>();
  const sequentialId = sequence?.next ?? 1;
  const id = await deterministicUuid("credit-note", `${auth.organizationId}:${idempotencyKey}`);
  const number = `${invoice.number ?? invoice.id}-CN${String(sequentialId).padStart(3, "0")}`;
  const event = creditNoteEvent("credit_note.created", id, 1, auth.organizationId, requestId, now, {
    invoiceId,
    totalAmountMinor: total,
  });
  const persistedItems = await Promise.all(
    items.map(async (item) => ({
      ...item,
      id: await deterministicUuid("credit-note-item", `${id}:${item.lineId}`),
    })),
  );
  const statements: D1PreparedStatement[] = [
    env.BILLING_DB.prepare(
      `INSERT INTO credit_notes
       (id, organization_id, customer_id, invoice_id, sequential_id, number, status,
        credit_status, reason, description, currency, total_amount_minor, credit_amount_minor,
        balance_amount_minor, version, idempotency_key, request_sha256, issuing_date, created_at,
        updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 'finalized', 'available', ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?)`,
    ).bind(
      id,
      auth.organizationId,
      invoice.customer_id,
      invoiceId,
      sequentialId,
      number,
      reason,
      description,
      invoice.currency,
      total,
      total,
      total,
      idempotencyKey,
      requestHash,
      now.slice(0, 10),
      now,
      now,
    ),
    ...persistedItems.map((item) =>
      env.BILLING_DB.prepare(
        `INSERT INTO credit_note_items
       (id, organization_id, credit_note_id, invoice_line_id, amount_minor,
        precise_amount_minor, currency, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(
        item.id,
        auth.organizationId,
        id,
        item.lineId,
        item.amountMinor,
        String(item.amountMinor),
        invoice.currency,
        now,
      ),
    ),
    outboxStatement(env.BILLING_DB, auth.organizationId, event),
  ];
  try {
    await env.BILLING_DB.batch(statements);
  } catch {
    const concurrent = await findCreditNoteByIdempotencyKey(
      env.BILLING_DB,
      auth.organizationId,
      idempotencyKey,
    );
    if (concurrent) {
      if (concurrent.request_sha256 !== requestHash)
        throw new ApiError(409, "idempotency_conflict", "Idempotency-Key is already in use");
      return json(
        {
          credit_note: await serializeCreditNote(
            env.BILLING_DB,
            concurrent,
            new URL(request.url).origin,
          ),
        },
        { requestId },
      );
    }
    throw new ApiError(
      409,
      "credit_note_sequence_conflict",
      "Credit note changed concurrently; retry the request",
    );
  }
  await env.DOMAIN_EVENTS.send(event);
  const note = await findCreditNote(env.BILLING_DB, auth.organizationId, id);
  if (!note) throw new ApiError(500, "persistence_error", "Credit note was not persisted");
  return json(
    {
      credit_note: await serializeCreditNote(env.BILLING_DB, note, new URL(request.url).origin),
    },
    { requestId },
  );
}

async function listCreditNotes(
  url: URL,
  db: D1Database,
  auth: AuthContext,
  requestId: string,
): Promise<Response> {
  const external = url.searchParams.get("external_customer_id")?.trim() || null;
  const where = external
    ? "cn.organization_id = ? AND c.external_id = ?"
    : "cn.organization_id = ?";
  const bindings = external ? [auth.organizationId, external] : [auth.organizationId];
  const rows = await db
    .prepare(
      `${creditNoteSelect()} WHERE ${where} ORDER BY cn.created_at DESC, cn.id DESC LIMIT 100`,
    )
    .bind(...bindings)
    .all<CreditNoteRow>();
  return json(
    {
      credit_notes: await Promise.all(
        rows.results.map((note) => serializeCreditNote(db, note, url.origin)),
      ),
      meta: pagination(rows.results.length),
    },
    { requestId },
  );
}

async function showCreditNote(
  id: string,
  db: D1Database,
  auth: AuthContext,
  requestId: string,
  origin: string,
): Promise<Response> {
  const note = await findCreditNote(db, auth.organizationId, id);
  if (!note) throw new ApiError(404, "credit_note_not_found", "Credit note was not found");
  return json({ credit_note: await serializeCreditNote(db, note, origin) }, { requestId });
}

async function voidCreditNote(
  id: string,
  env: Env,
  auth: AuthContext,
  requestId: string,
  origin: string,
): Promise<Response> {
  let note = await findCreditNote(env.BILLING_DB, auth.organizationId, id);
  if (!note) throw new ApiError(404, "credit_note_not_found", "Credit note was not found");
  if (note.status === "draft")
    throw new ApiError(422, "credit_note_not_finalized", "Draft credit notes cannot be voided");
  if (note.credit_status === "voided")
    return json(
      { credit_note: await serializeCreditNote(env.BILLING_DB, note, origin) },
      { requestId },
    );
  if (note.credit_status !== "available" || note.balance_amount_minor !== note.credit_amount_minor)
    throw new ApiError(
      422,
      "no_voidable_amount",
      "Only a fully unconsumed credit balance can be voided",
    );
  const now = new Date().toISOString();
  const event = creditNoteEvent(
    "credit_note.voided",
    note.id,
    note.version + 1,
    auth.organizationId,
    requestId,
    now,
    { balanceAmountMinor: note.balance_amount_minor },
  );
  const results = await env.BILLING_DB.batch([
    env.BILLING_DB.prepare(
      `UPDATE credit_notes SET credit_status = 'voided', balance_amount_minor = 0,
       voided_at = ?, updated_at = ?, version = version + 1
       WHERE id = ? AND organization_id = ? AND version = ? AND credit_status = 'available'
         AND balance_amount_minor = credit_amount_minor`,
    ).bind(now, now, note.id, auth.organizationId, note.version),
    env.BILLING_DB.prepare(
      `INSERT INTO outbox_events
       (event_id, organization_id, event_type, event_version, aggregate_type, aggregate_id,
        aggregate_version, causation_id, correlation_id, payload_json, occurred_at, published_at)
       SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL
       FROM credit_notes
       WHERE id = ? AND organization_id = ? AND credit_status = 'voided'
         AND version = ? AND voided_at = ?`,
    ).bind(
      event.id,
      auth.organizationId,
      event.type,
      event.version,
      event.aggregateType,
      event.aggregateId,
      event.aggregateVersion,
      event.causationId,
      event.correlationId,
      stableJson(event.payload),
      event.occurredAt,
      note.id,
      auth.organizationId,
      note.version + 1,
      now,
    ),
  ]);
  if ((results[0]?.meta.changes ?? 0) < 1 || results[1]?.meta.changes !== 1)
    throw new ApiError(409, "credit_note_version_conflict", "Credit note changed concurrently");
  await env.DOMAIN_EVENTS.send(event);
  note = await findCreditNote(env.BILLING_DB, auth.organizationId, id);
  if (!note) throw new ApiError(500, "persistence_error", "Credit note disappeared");
  return json(
    { credit_note: await serializeCreditNote(env.BILLING_DB, note, origin) },
    { requestId },
  );
}

async function downloadCreditNote(
  id: string,
  env: Env,
  auth: AuthContext,
  requestId: string,
): Promise<Response> {
  const note = await findCreditNote(env.BILLING_DB, auth.organizationId, id);
  if (!note) throw new ApiError(404, "credit_note_not_found", "Credit note was not found");
  if (note.status !== "finalized")
    throw new ApiError(422, "credit_note_not_finalized", "Only finalized credit notes have PDFs");
  if (note.pdf_status === "ready" && note.pdf_object_key) {
    const object = await env.BILLING_ARTIFACTS.get(note.pdf_object_key);
    if (!object)
      throw new ApiError(503, "artifact_missing", "Credit note PDF artifact is unavailable");
    const safeNumber = note.number.replaceAll(/[^A-Za-z0-9._-]/g, "_");
    return new Response(object.body, {
      headers: {
        "Cache-Control": "private, no-store",
        "Content-Disposition": `attachment; filename="credit-note-${safeNumber}.pdf"`,
        "Content-Type": "application/pdf",
        "X-Request-Id": requestId,
      },
    });
  }
  await dispatchCreditNoteDocument(env, note.id, auth.organizationId, note.version, requestId);
  return json(
    {
      credit_note: await serializeCreditNote(env.BILLING_DB, note, ""),
      document_status: note.pdf_status === "failed" ? "retrying" : "generating",
    },
    { requestId, status: 202 },
  );
}

export async function dispatchCreditNoteDocument(
  env: Pick<Env, "DOCUMENT_WORKFLOW">,
  creditNoteId: string,
  organizationId: string,
  creditNoteVersion: number,
  correlationId: string,
): Promise<void> {
  try {
    await env.DOCUMENT_WORKFLOW.create({
      id: `credit-note-pdf-${creditNoteId}-v${creditNoteVersion}`,
      params: {
        kind: "credit_note",
        creditNoteId,
        organizationId,
        correlationId,
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message.toLowerCase() : "";
    if (!message.includes("already exists")) throw error;
  }
}

function parseItems(value: unknown): InputItem[] {
  if (!Array.isArray(value) || value.length === 0)
    throw new ApiError(422, "validation_error", "items must be a non-empty array");
  const seen = new Set<string>();
  return value.map((raw) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw))
      throw new ApiError(422, "validation_error", "Each item must be an object");
    const input = raw as Record<string, unknown>;
    const lineId = requiredString(input, "fee_id");
    if (seen.has(lineId))
      throw new ApiError(422, "validation_error", "fee_id values must be unique");
    seen.add(lineId);
    return { lineId, amountMinor: positiveInteger(input.amount_cents, "amount_cents") };
  });
}

async function validateItems(
  items: InputItem[],
  db: D1Database,
  invoiceId: string,
  organizationId: string,
) {
  for (const item of items) {
    const { lineId, amountMinor } = item;
    const line = await db
      .prepare(
        `SELECT il.amount_minor,
              COALESCE((SELECT SUM(cni.amount_minor) FROM credit_note_items cni
                JOIN credit_notes cn ON cn.id = cni.credit_note_id
                WHERE cni.invoice_line_id = il.id AND cn.credit_status <> 'voided'), 0) AS credited
       FROM invoice_lines il JOIN invoices i ON i.id = il.invoice_id
       WHERE il.id = ? AND il.invoice_id = ? AND i.organization_id = ? LIMIT 1`,
      )
      .bind(lineId, invoiceId, organizationId)
      .first<{ amount_minor: number; credited: number }>();
    if (!line) throw new ApiError(404, "fee_not_found", "Invoice fee was not found");
    if (amountMinor > line.amount_minor - line.credited)
      throw new ApiError(
        422,
        "higher_than_remaining_fee_amount",
        "Item exceeds the remaining fee amount",
      );
  }
}

function creditNoteSelect() {
  return `SELECT cn.id, cn.invoice_id, i.number AS invoice_number, cn.customer_id, c.external_id AS customer_external_id, cn.sequential_id, cn.number, CASE WHEN cn.allocation_state = 'draft' THEN 'draft' ELSE cn.status END AS status, cn.credit_status, cn.reason, cn.description, cn.currency, cn.total_amount_minor, cn.credit_amount_minor, cn.balance_amount_minor, cn.refund_amount_minor, cn.offset_amount_minor, cn.taxes_amount_minor, cn.coupons_adjustment_minor, cn.version, cn.idempotency_key, cn.request_sha256, cn.issuing_date, cn.created_at, cn.updated_at, cn.voided_at, artifact.status AS pdf_status, artifact.object_key AS pdf_object_key FROM credit_notes cn JOIN invoices i ON i.id = cn.invoice_id JOIN customers c ON c.id = cn.customer_id LEFT JOIN credit_note_document_artifacts artifact ON artifact.credit_note_id = cn.id AND artifact.credit_note_version = cn.version`;
}
async function findCreditNote(db: D1Database, org: string, id: string) {
  return db
    .prepare(`${creditNoteSelect()} WHERE cn.organization_id = ? AND cn.id = ? LIMIT 1`)
    .bind(org, id)
    .first<CreditNoteRow>();
}
async function findCreditNoteByIdempotencyKey(db: D1Database, org: string, key: string) {
  return db
    .prepare(
      `${creditNoteSelect()} WHERE cn.organization_id = ? AND cn.idempotency_key = ? LIMIT 1`,
    )
    .bind(org, key)
    .first<CreditNoteRow>();
}
async function serializeCreditNote(db: D1Database, note: CreditNoteRow, origin: string) {
  const items = await db
    .prepare(
      `SELECT cni.id, cni.invoice_line_id, cni.amount_minor, cni.precise_amount_minor,
            cni.currency, il.description, il.line_type, il.source_type, il.source_id
     FROM credit_note_items cni JOIN invoice_lines il ON il.id = cni.invoice_line_id
     WHERE cni.credit_note_id = ? ORDER BY cni.created_at, cni.id`,
    )
    .bind(note.id)
    .all<{
      id: string;
      invoice_line_id: string;
      amount_minor: number;
      precise_amount_minor: string;
      currency: string;
      description: string;
      line_type: string;
      source_type: string;
      source_id: string;
    }>();
  return {
    lago_id: note.id,
    sequential_id: note.sequential_id,
    number: note.number,
    lago_invoice_id: note.invoice_id,
    invoice_number: note.invoice_number,
    issuing_date: note.issuing_date,
    credit_status: note.credit_status,
    refund_status: null,
    reason: note.reason,
    description: note.description,
    currency: note.currency,
    total_amount_cents: note.total_amount_minor,
    precise_total_amount_cents: String(note.total_amount_minor),
    taxes_amount_cents: note.taxes_amount_minor,
    precise_taxes_amount_cents: "0",
    sub_total_excluding_taxes_amount_cents: note.total_amount_minor,
    balance_amount_cents: note.balance_amount_minor,
    credit_amount_cents: note.credit_amount_minor,
    refund_amount_cents: note.refund_amount_minor,
    offset_amount_cents: note.offset_amount_minor,
    coupons_adjustment_amount_cents: note.coupons_adjustment_minor,
    taxes_rate: 0,
    created_at: note.created_at,
    updated_at: note.updated_at,
    file_url:
      note.pdf_status === "ready" && note.pdf_object_key
        ? `${origin}/api/v1/credit_notes/${encodeURIComponent(note.id)}/download`
        : null,
    xml_url: null,
    voided_at: note.voided_at,
    customer: { lago_id: note.customer_id, external_id: note.customer_external_id },
    items: items.results.map((item) => ({
      lago_id: item.id,
      amount_cents: item.amount_minor,
      precise_amount_cents: item.precise_amount_minor,
      amount_currency: item.currency,
      fee: {
        lago_id: item.invoice_line_id,
        item: {
          type: item.line_type,
          code: item.source_id,
          name: item.description,
          item_type: item.source_type,
        },
      },
    })),
    applied_taxes: [],
    error_details: [],
  };
}

function positiveInteger(value: unknown, field: string) {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0)
    throw new ApiError(422, "validation_error", `${field} must be a positive integer`);
  return value;
}
function safeAdd(left: number, right: number) {
  const total = left + right;
  if (!Number.isSafeInteger(total))
    throw new ApiError(422, "invalid_minor_amount", "Credit amount exceeds supported precision");
  return total;
}
function rejectSideEffects(input: Record<string, unknown>) {
  for (const field of ["refund_amount_cents", "offset_amount_cents", "metadata"])
    if (input[field] !== undefined && input[field] !== null && input[field] !== 0)
      throw new ApiError(422, "unsupported_credit_note_side_effect", `${field} is not implemented`);
}
function requiredIdempotencyKey(request: Request) {
  const value = request.headers.get("Idempotency-Key")?.trim();
  if (!value)
    throw new ApiError(
      422,
      "idempotency_key_required",
      "Idempotency-Key is required for credit note creation",
    );
  if (value.length > 200)
    throw new ApiError(422, "validation_error", "Idempotency-Key is too long");
  return value;
}
function creditNoteEvent(
  type: string,
  id: string,
  version: number,
  organizationId: string,
  correlationId: string,
  occurredAt: string,
  payload: Record<string, unknown>,
): DomainEvent {
  return {
    id: `${type.replaceAll(".", "-")}:${id}:v${version}`,
    type,
    version: 1,
    aggregateType: "credit_note",
    aggregateId: id,
    aggregateVersion: version,
    occurredAt,
    causationId: correlationId,
    correlationId,
    payload: { organizationId, ...payload },
  };
}
function outboxStatement(db: D1Database, org: string, event: DomainEvent) {
  return db
    .prepare(
      `INSERT INTO outbox_events (event_id, organization_id, event_type, event_version, aggregate_type, aggregate_id, aggregate_version, causation_id, correlation_id, payload_json, occurred_at, published_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
    )
    .bind(
      event.id,
      org,
      event.type,
      event.version,
      event.aggregateType,
      event.aggregateId,
      event.aggregateVersion,
      event.causationId,
      event.correlationId,
      stableJson(event.payload),
      event.occurredAt,
    );
}
function pagination(total: number) {
  return {
    current_page: total === 0 ? 0 : 1,
    next_page: null,
    prev_page: null,
    total_pages: total === 0 ? 0 : 1,
    total_count: total,
  };
}
