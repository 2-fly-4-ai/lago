import type { AuthContext } from "../auth/api-key";
import { sha256Hex } from "../auth/api-key";
import type { DomainEvent } from "../domain-events";
import { ApiError, json, objectAt, optionalString, parseJsonObject, requiredString } from "../http";
import { deterministicUuid } from "../identifiers";
import { stableJson } from "../json";

type PaymentRow = {
  id: string;
  organization_id: string;
  payable_id: string;
  payable_type: "Invoice" | "PaymentRequest";
  invoice_ids_json: string;
  invoice_numbers_json: string;
  customer_id: string;
  external_customer_id: string;
  provider: string;
  provider_account_code: string;
  provider_transaction_id: string | null;
  amount_minor: number;
  currency: string;
  status: string;
  payment_type: "provider" | "manual";
  reference: string | null;
  version: number;
  created_at: string;
};

type InvoicePaymentRow = {
  id: string;
  number: string | null;
  customer_id: string;
  external_customer_id: string;
  currency: string;
  total_due_minor: number;
  payment_status: string;
  status: string;
  version: number;
};

export async function handlePaymentLedgerRequest(
  request: Request,
  env: Env,
  auth: AuthContext,
  requestId: string,
): Promise<Response | null> {
  const url = new URL(request.url);
  if (url.pathname === "/api/v1/payments") {
    if (request.method === "GET") return listPayments(url, env.BILLING_DB, auth, requestId);
    if (request.method === "POST") return recordManualPayment(request, env, auth, requestId);
  }

  const paymentMatch = url.pathname.match(/^\/api\/v1\/payments\/([^/]+)$/);
  if (request.method === "GET" && paymentMatch?.[1])
    return showPayment(decodeURIComponent(paymentMatch[1]), env.BILLING_DB, auth, requestId);

  const customerMatch = url.pathname.match(/^\/api\/v1\/customers\/([^/]+)\/payments$/);
  if (request.method === "GET" && customerMatch?.[1]) {
    const externalCustomerId = decodeURIComponent(customerMatch[1]);
    const exists = await env.BILLING_DB.prepare(
      "SELECT id FROM customers WHERE organization_id = ? AND external_id = ? LIMIT 1",
    )
      .bind(auth.organizationId, externalCustomerId)
      .first();
    if (!exists) throw new ApiError(404, "customer_not_found", "Customer was not found");
    return listPayments(url, env.BILLING_DB, auth, requestId, externalCustomerId);
  }
  return null;
}

async function listPayments(
  url: URL,
  database: D1Database,
  auth: AuthContext,
  requestId: string,
  pathCustomerId?: string,
): Promise<Response> {
  const page = pageValue(url.searchParams.get("page"));
  const perPage = Math.min(pageValue(url.searchParams.get("per_page"), 20), 100);
  const offset = (page - 1) * perPage;
  const externalCustomerId =
    pathCustomerId ?? url.searchParams.get("external_customer_id")?.trim() ?? null;
  const invoiceId = url.searchParams.get("invoice_id")?.trim() || null;
  const conditions = ["ledger.organization_id = ?"];
  const bindings: unknown[] = [auth.organizationId];
  if (externalCustomerId) {
    conditions.push("ledger.external_customer_id = ?");
    bindings.push(externalCustomerId);
  }
  if (invoiceId) {
    conditions.push("EXISTS (SELECT 1 FROM json_each(ledger.invoice_ids_json) WHERE value = ?)");
    bindings.push(invoiceId);
  }
  const where = conditions.join(" AND ");
  const count = await database
    .prepare(`SELECT COUNT(*) AS total FROM (${paymentRows()}) ledger WHERE ${where}`)
    .bind(...bindings)
    .first<{ total: number }>();
  const rows = await database
    .prepare(
      `SELECT * FROM (${paymentRows()}) ledger
       WHERE ${where} ORDER BY ledger.created_at DESC, ledger.id DESC LIMIT ? OFFSET ?`,
    )
    .bind(...bindings, perPage, offset)
    .all<PaymentRow>();
  return json(
    {
      payments: rows.results.map(serializePayment),
      meta: pagination(count?.total ?? 0, page, perPage),
    },
    { requestId },
  );
}

async function showPayment(
  paymentId: string,
  database: D1Database,
  auth: AuthContext,
  requestId: string,
): Promise<Response> {
  const payment = await findPayment(database, auth.organizationId, paymentId);
  if (!payment) throw new ApiError(404, "payment_not_found", "Payment was not found");
  return json({ payment: serializePayment(payment) }, { requestId });
}

async function recordManualPayment(
  request: Request,
  env: Env,
  auth: AuthContext,
  requestId: string,
): Promise<Response> {
  if (String(env.PAYMENT_MUTATIONS_ENABLED) !== "1")
    throw new ApiError(503, "payment_mutations_disabled", "Payment mutations are disabled");
  const input = objectAt(await parseJsonObject(request), "payment");
  const unsupported = Object.keys(input).find(
    (key) => !["invoice_id", "amount_cents", "reference", "paid_at"].includes(key),
  );
  if (unsupported)
    throw new ApiError(
      422,
      "unsupported_payment_feature",
      `${unsupported} is not implemented by the Cloudflare payment ledger`,
    );
  const invoiceId = requiredString(input, "invoice_id");
  const amountMinor = positiveInteger(input.amount_cents, "amount_cents");
  const reference = requiredString(input, "reference");
  if (reference.length > 40)
    throw new ApiError(422, "validation_error", "reference cannot exceed 40 characters");
  const paidAt = parsePaidAt(optionalString(input, "paid_at"));
  const normalized = { amountMinor, invoiceId, paidAt, reference };
  const requestHash = await sha256Hex(stableJson(normalized));
  const idempotencyKey = `manual-payment:${requestHash}`;
  const paymentId = await deterministicUuid(
    "manual-payment",
    `${auth.organizationId}:${requestHash}`,
  );
  const existing = await findPayment(env.BILLING_DB, auth.organizationId, paymentId);
  if (existing) return json({ payment: serializePayment(existing) }, { requestId });

  const invoice = await findInvoice(env.BILLING_DB, auth.organizationId, invoiceId);
  if (!invoice) throw new ApiError(404, "invoice_not_found", "Invoice was not found");
  if (invoice.status !== "finalized" || invoice.payment_status === "succeeded")
    throw new ApiError(422, "invoice_not_payable", "Invoice is not payable");
  const paid = await successfulPaymentTotal(env.BILLING_DB, invoice.id);
  if (amountMinor > invoice.total_due_minor - paid)
    throw new ApiError(422, "payment_amount_exceeds_due", "Payment exceeds the invoice balance");

  const now = new Date().toISOString();
  const createdAt = paidAt ?? now;
  const paymentEvent = domainEvent(
    "payment.recorded",
    "payment",
    paymentId,
    1,
    auth.organizationId,
    requestId,
    now,
    { amountMinor, currency: invoice.currency, invoiceId, paymentId, reference },
  );
  const nextInvoiceStatus =
    paid + amountMinor === invoice.total_due_minor ? "succeeded" : invoice.payment_status;
  const invoiceEvent =
    nextInvoiceStatus !== invoice.payment_status
      ? domainEvent(
          "invoice.payment_status_updated",
          "invoice",
          invoice.id,
          invoice.version + 1,
          auth.organizationId,
          requestId,
          now,
          { invoiceId: invoice.id, paymentStatus: nextInvoiceStatus },
        )
      : null;
  const statements = [
    env.BILLING_DB.prepare(
      `UPDATE invoices SET payment_status = ?,
       payment_overdue = CASE WHEN ? = 'succeeded' THEN 0 ELSE payment_overdue END,
       ready_for_payment_processing = CASE WHEN ? = 'succeeded' THEN 0
                                           ELSE ready_for_payment_processing END,
       version = version + 1, updated_at = ?
       WHERE id = ? AND organization_id = ? AND version = ? AND payment_status <> 'succeeded'`,
    ).bind(
      nextInvoiceStatus,
      nextInvoiceStatus,
      nextInvoiceStatus,
      now,
      invoice.id,
      auth.organizationId,
      invoice.version,
    ),
    env.BILLING_DB.prepare(
      `INSERT INTO payment_attempts
       (id, organization_id, invoice_id, provider, provider_account_code,
        provider_transaction_id, idempotency_key, amount_minor, currency, status,
        failure_code, failure_message, payment_type, reference, version, created_at, updated_at)
       SELECT ?, ?, ?, 'manual', 'manual', NULL, ?, ?, ?, 'succeeded', NULL, NULL,
              'manual', ?, 1, ?, ?
       FROM invoices
       WHERE id = ? AND organization_id = ? AND version = ? AND updated_at = ?`,
    ).bind(
      paymentId,
      auth.organizationId,
      invoice.id,
      idempotencyKey,
      amountMinor,
      invoice.currency,
      reference,
      createdAt,
      now,
      invoice.id,
      auth.organizationId,
      invoice.version + 1,
      now,
    ),
    env.BILLING_DB.prepare(
      `INSERT INTO outbox_events
       (event_id, organization_id, event_type, event_version, aggregate_type,
        aggregate_id, aggregate_version, causation_id, correlation_id, payload_json,
        occurred_at, published_at)
       SELECT ?, ?, ?, 1, 'payment', ?, 1, ?, ?, ?, ?, NULL
       FROM payment_attempts WHERE id = ? AND organization_id = ?`,
    ).bind(
      paymentEvent.id,
      auth.organizationId,
      paymentEvent.type,
      paymentId,
      requestId,
      requestId,
      stableJson(paymentEvent.payload),
      now,
      paymentId,
      auth.organizationId,
    ),
    env.BILLING_DB.prepare("DELETE FROM payment_links WHERE invoice_id = ?").bind(invoice.id),
  ];
  if (invoiceEvent)
    statements.push(
      env.BILLING_DB.prepare(
        `INSERT INTO outbox_events
         (event_id, organization_id, event_type, event_version, aggregate_type,
          aggregate_id, aggregate_version, causation_id, correlation_id, payload_json,
          occurred_at, published_at)
         SELECT ?, ?, ?, 1, 'invoice', ?, ?, ?, ?, ?, ?, NULL
         FROM invoices WHERE id = ? AND organization_id = ? AND version = ? AND updated_at = ?`,
      ).bind(
        invoiceEvent.id,
        auth.organizationId,
        invoiceEvent.type,
        invoice.id,
        invoice.version + 1,
        requestId,
        requestId,
        stableJson(invoiceEvent.payload),
        now,
        invoice.id,
        auth.organizationId,
        invoice.version + 1,
        now,
      ),
    );
  try {
    const results = await env.BILLING_DB.batch(statements);
    if (
      results[0]?.meta.changes !== 1 ||
      results[1]?.meta.changes !== 1 ||
      results[2]?.meta.changes !== 1
    )
      throw new Error("payment_version_conflict");
  } catch (error) {
    const concurrent = await findPayment(env.BILLING_DB, auth.organizationId, paymentId);
    if (concurrent) return json({ payment: serializePayment(concurrent) }, { requestId });
    if (error instanceof Error && error.message.includes("payment_version_conflict"))
      throw new ApiError(409, "payment_version_conflict", "Invoice changed concurrently");
    throw error;
  }
  await env.DOMAIN_EVENTS.send(paymentEvent);
  if (invoiceEvent) await env.DOMAIN_EVENTS.send(invoiceEvent);
  const payment = await findPayment(env.BILLING_DB, auth.organizationId, paymentId);
  if (!payment) throw new ApiError(500, "persistence_error", "Payment was not persisted");
  return json({ payment: serializePayment(payment) }, { requestId });
}

function paymentRows(): string {
  return `SELECT payment.id, payment.organization_id, payment.invoice_id AS payable_id,
                 'Invoice' AS payable_type, json_array(payment.invoice_id) AS invoice_ids_json,
                 CASE WHEN invoice.number IS NULL THEN '[]' ELSE json_array(invoice.number) END
                   AS invoice_numbers_json,
                 invoice.customer_id, customer.external_id AS external_customer_id,
                 payment.provider, payment.provider_account_code,
                 payment.provider_transaction_id, payment.amount_minor, payment.currency,
                 payment.status, payment.payment_type, payment.reference, payment.version,
                 payment.created_at
          FROM payment_attempts payment
          JOIN invoices invoice ON invoice.id = payment.invoice_id
          JOIN customers customer ON customer.id = invoice.customer_id
          UNION ALL
          SELECT payment.id, payment.organization_id, payment.payment_request_id AS payable_id,
                 'PaymentRequest' AS payable_type,
                 COALESCE((
                   SELECT json_group_array(invoice_id) FROM (
                     SELECT link.invoice_id
                     FROM invoices_payment_requests link
                     WHERE link.payment_request_id = request.id
                     ORDER BY link.created_at, link.invoice_id
                   )
                 ), '[]') AS invoice_ids_json,
                 COALESCE((
                   SELECT json_group_array(number) FROM (
                     SELECT invoice.number
                     FROM invoices_payment_requests link
                     JOIN invoices invoice ON invoice.id = link.invoice_id
                     WHERE link.payment_request_id = request.id AND invoice.number IS NOT NULL
                     ORDER BY link.created_at, invoice.id
                   )
                 ), '[]') AS invoice_numbers_json,
                 request.customer_id, customer.external_id AS external_customer_id,
                 payment.provider, payment.provider_account_code,
                 payment.provider_transaction_id, payment.amount_minor, payment.currency,
                 payment.status, 'provider' AS payment_type, NULL AS reference, payment.version,
                 payment.created_at
          FROM payment_request_payments payment
          JOIN payment_requests request ON request.id = payment.payment_request_id
          JOIN customers customer ON customer.id = request.customer_id`;
}

async function findPayment(
  database: D1Database,
  organizationId: string,
  paymentId: string,
): Promise<PaymentRow | null> {
  return database
    .prepare(
      `SELECT * FROM (${paymentRows()}) ledger
       WHERE ledger.organization_id = ? AND ledger.id = ? LIMIT 1`,
    )
    .bind(organizationId, paymentId)
    .first<PaymentRow>();
}

async function findInvoice(
  database: D1Database,
  organizationId: string,
  invoiceId: string,
): Promise<InvoicePaymentRow | null> {
  return database
    .prepare(
      `SELECT i.id, i.number, i.customer_id, c.external_id AS external_customer_id,
              i.currency, i.total_due_minor, i.payment_status, i.status, i.version
       FROM invoices i JOIN customers c ON c.id = i.customer_id
       WHERE i.organization_id = ? AND i.id = ? LIMIT 1`,
    )
    .bind(organizationId, invoiceId)
    .first<InvoicePaymentRow>();
}

async function successfulPaymentTotal(database: D1Database, invoiceId: string): Promise<number> {
  const value = await database
    .prepare(
      `SELECT COALESCE(SUM(amount_minor), 0) AS total FROM (
         SELECT amount_minor FROM payment_attempts
         WHERE invoice_id = ? AND status = 'succeeded'
         UNION ALL
         SELECT amount_minor FROM payment_request_payment_allocations WHERE invoice_id = ?
       )`,
    )
    .bind(invoiceId, invoiceId)
    .first<{ total: number }>();
  return value?.total ?? 0;
}

function serializePayment(payment: PaymentRow): Record<string, unknown> {
  const provider = payment.payment_type === "provider";
  const invoiceIds = jsonStringArray(payment.invoice_ids_json);
  const invoiceNumbers = jsonStringArray(payment.invoice_numbers_json);
  return {
    lago_id: payment.id,
    lago_customer_id: payment.customer_id,
    external_customer_id: payment.external_customer_id,
    invoice_ids: invoiceIds,
    invoice_numbers: invoiceNumbers,
    lago_payable_id: payment.payable_id,
    payable_type: payment.payable_type,
    amount_cents: payment.amount_minor,
    amount_currency: payment.currency,
    status: payment.status,
    payment_status: payableStatus(payment.status),
    type: payment.payment_type,
    reference: payment.reference,
    payment_provider_code: provider ? payment.provider_account_code : null,
    payment_provider_type: provider ? providerType(payment.provider) : null,
    external_payment_id: payment.provider_transaction_id,
    provider_payment_id: payment.provider_transaction_id,
    provider_customer_id: null,
    next_action: {},
    created_at: payment.created_at,
  };
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

function payableStatus(status: string): "pending" | "processing" | "succeeded" | "failed" {
  if (status === "succeeded" || status === "failed") return status;
  if (status === "submitted") return "processing";
  return "pending";
}

function providerType(provider: string): string {
  return provider === "authorize_net"
    ? "PaymentProviders::AuthorizeNetProvider"
    : `PaymentProviders::${provider}Provider`;
}

function domainEvent(
  type: string,
  aggregateType: string,
  aggregateId: string,
  aggregateVersion: number,
  organizationId: string,
  requestId: string,
  occurredAt: string,
  payload: Record<string, unknown>,
): DomainEvent {
  return {
    id: `${type.replaceAll(".", "-")}:${aggregateId}:v${aggregateVersion}`,
    type,
    version: 1,
    aggregateType,
    aggregateId,
    aggregateVersion,
    occurredAt,
    causationId: requestId,
    correlationId: requestId,
    payload: { organizationId, ...payload },
  };
}

function positiveInteger(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0)
    throw new ApiError(422, "validation_error", `${field} must be a positive integer`);
  return value as number;
}

function parsePaidAt(value: string | null): string | null {
  if (!value) return null;
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime()))
    throw new ApiError(422, "validation_error", "paid_at must be an ISO-8601 timestamp");
  return parsed.toISOString();
}

function pageValue(value: string | null, fallback = 1): number {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function pagination(total: number, page: number, perPage: number) {
  const totalPages = total === 0 ? 0 : Math.ceil(total / perPage);
  return {
    current_page: total === 0 ? 0 : page,
    next_page: page < totalPages ? page + 1 : null,
    prev_page: page > 1 && page <= totalPages ? page - 1 : null,
    total_pages: totalPages,
    total_count: total,
  };
}
