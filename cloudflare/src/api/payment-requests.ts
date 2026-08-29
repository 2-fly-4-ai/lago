import type { AuthContext } from "../auth/api-key";
import type { DomainEvent } from "../domain-events";
import { ApiError, json, objectAt, optionalString, parseJsonObject, requiredString } from "../http";
import { deterministicUuid } from "../identifiers";
import { stableJson } from "../json";
import {
  findCustomer,
  findInvoice,
  serializeCustomer,
  serializeInvoice,
  type InvoiceRow,
} from "./lago-compatibility";

type PaymentRequestRow = {
  id: string;
  organization_id: string;
  customer_id: string;
  external_customer_id: string;
  amount_minor: number;
  currency: string;
  email: string | null;
  payment_attempts: number;
  payment_status: "pending" | "succeeded" | "failed";
  ready_for_payment_processing: number;
  version: number;
  created_at: string;
  updated_at: string;
};

export async function handlePaymentRequestApi(
  request: Request,
  env: Pick<Env, "BILLING_DB">,
  auth: AuthContext,
  requestId: string,
): Promise<Response | null> {
  const url = new URL(request.url);
  if (url.pathname === "/api/v1/payment_requests") {
    if (request.method === "POST") return createPaymentRequest(request, env, auth, requestId);
    if (request.method === "GET") return listPaymentRequests(url, env.BILLING_DB, auth, requestId);
  }

  const paymentRequestMatch = url.pathname.match(/^\/api\/v1\/payment_requests\/([^/]+)$/);
  if (request.method === "GET" && paymentRequestMatch?.[1]) {
    return showPaymentRequest(
      decodeURIComponent(paymentRequestMatch[1]),
      env.BILLING_DB,
      auth,
      requestId,
    );
  }

  const customerMatch = url.pathname.match(/^\/api\/v1\/customers\/([^/]+)\/payment_requests$/);
  if (request.method === "GET" && customerMatch?.[1]) {
    const externalCustomerId = decodeURIComponent(customerMatch[1]);
    if (!(await findCustomer(env.BILLING_DB, auth.organizationId, externalCustomerId))) {
      throw new ApiError(404, "customer_not_found", "Customer was not found");
    }
    return listPaymentRequests(url, env.BILLING_DB, auth, requestId, externalCustomerId);
  }

  return null;
}

async function createPaymentRequest(
  request: Request,
  env: Pick<Env, "BILLING_DB">,
  auth: AuthContext,
  requestId: string,
): Promise<Response> {
  const input = objectAt(await parseJsonObject(request), "payment_request");
  const unsupported = Object.keys(input).find(
    (key) =>
      !["collection_mode", "email", "external_customer_id", "lago_invoice_ids"].includes(key),
  );
  if (unsupported) {
    throw new ApiError(
      422,
      "unsupported_payment_request_feature",
      `${unsupported} is not implemented for payment requests`,
    );
  }
  const collectionMode = optionalString(input, "collection_mode");
  if (collectionMode !== null && collectionMode !== "checkout") {
    throw new ApiError(
      422,
      "unsupported_payment_request_collection_mode",
      "collection_mode must be checkout when provided",
    );
  }
  const externalCustomerId = requiredString(input, "external_customer_id");
  const customer = await findCustomer(env.BILLING_DB, auth.organizationId, externalCustomerId);
  if (!customer) throw new ApiError(404, "customer_not_found", "Customer was not found");
  const invoiceIds = invoiceIdList(input.lago_invoice_ids);
  const invoices = await Promise.all(
    invoiceIds.map((invoiceId) => findInvoice(env.BILLING_DB, auth.organizationId, invoiceId)),
  );
  if (invoices.some((invoice) => !invoice)) {
    throw new ApiError(404, "invoice_not_found", "One or more invoices were not found");
  }
  const ownedInvoices = invoices as InvoiceRow[];
  if (ownedInvoices.some((invoice) => invoice.customer_id !== customer.id)) {
    throw new ApiError(
      422,
      "invoice_customer_mismatch",
      "Every invoice must belong to the payment request customer",
    );
  }
  const today = new Date().toISOString().slice(0, 10);
  if (
    ownedInvoices.some(
      (invoice) =>
        invoice.payment_overdue !== 1 &&
        !(
          collectionMode === "checkout" &&
          invoice.net_payment_term === 0 &&
          (invoice.payment_due_date === null || invoice.payment_due_date <= today)
        ),
    )
  ) {
    throw new ApiError(422, "invoices_not_overdue", "Every invoice must be payment overdue");
  }
  if (
    ownedInvoices.some(
      (invoice) =>
        invoice.status !== "finalized" ||
        invoice.payment_status === "succeeded" ||
        invoice.ready_for_payment_processing !== 1 ||
        outstandingMinor(invoice) <= 0,
    )
  ) {
    throw new ApiError(
      422,
      "invoices_not_ready_for_payment_processing",
      "Every invoice must be finalized with an outstanding balance",
    );
  }
  const currency = ownedInvoices[0]!.currency;
  if (ownedInvoices.some((invoice) => invoice.currency !== currency)) {
    throw new ApiError(
      422,
      "invoices_have_different_currencies",
      "Every invoice must use the same currency",
    );
  }
  const amountMinor = ownedInvoices.reduce(
    (sum, invoice) => safeAdd(sum, outstandingMinor(invoice)),
    0,
  );
  if (amountMinor <= 0) {
    throw new ApiError(
      422,
      "payment_request_amount_empty",
      "Payment request amount must be positive",
    );
  }
  if (collectionMode === "checkout" && invoiceIds.length === 1) {
    const existingId = await env.BILLING_DB.prepare(
      `SELECT request.id
       FROM payment_requests request
       JOIN invoices_payment_requests link ON link.payment_request_id = request.id
       WHERE request.organization_id = ? AND request.customer_id = ?
         AND request.collection_mode = 'checkout'
         AND request.payment_status IN ('pending', 'succeeded')
         AND link.invoice_id = ?
       ORDER BY request.created_at, request.id LIMIT 1`,
    )
      .bind(auth.organizationId, customer.id, invoiceIds[0])
      .first<{ id: string }>();
    if (existingId) {
      const existing = await findPaymentRequest(env.BILLING_DB, auth.organizationId, existingId.id);
      if (!existing) throw new Error("payment_request_idempotency_lookup_failed");
      return json(
        { payment_request: await serializePaymentRequest(env.BILLING_DB, existing) },
        { requestId },
      );
    }
  }
  const email = normalizedEmail(optionalString(input, "email") ?? customer.email);
  const paymentRequestId =
    collectionMode === "checkout" && invoiceIds.length === 1
      ? await deterministicUuid(
          "checkout-payment-request",
          `${auth.organizationId}:${customer.id}:${invoiceIds[0]}`,
        )
      : crypto.randomUUID();
  const now = new Date().toISOString();
  const event = paymentRequestCreatedEvent(
    paymentRequestId,
    auth.organizationId,
    customer.id,
    invoiceIds,
    amountMinor,
    currency,
    requestId,
    now,
  );
  const statements: D1PreparedStatement[] = [
    env.BILLING_DB.prepare(
      `INSERT OR IGNORE INTO payment_requests
       (id, organization_id, customer_id, amount_minor, currency, email, payment_attempts,
        payment_status, ready_for_payment_processing, version, collection_mode, created_at,
        updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 0, 'pending', 1, 1, ?, ?, ?)`,
    ).bind(
      paymentRequestId,
      auth.organizationId,
      customer.id,
      amountMinor,
      currency,
      email,
      collectionMode ?? "overdue",
      now,
      now,
    ),
  ];
  for (const invoice of ownedInvoices) {
    statements.push(
      env.BILLING_DB.prepare(
        `INSERT OR IGNORE INTO invoices_payment_requests
         (id, organization_id, payment_request_id, invoice_id, invoice_version, created_at,
          updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).bind(
        await deterministicUuid(
          "invoice-payment-request",
          `${auth.organizationId}:${paymentRequestId}:${invoice.id}`,
        ),
        auth.organizationId,
        paymentRequestId,
        invoice.id,
        invoice.version,
        now,
        now,
      ),
    );
  }
  statements.push(outboxStatement(env.BILLING_DB, auth.organizationId, event));
  await env.BILLING_DB.batch(statements);
  const created = await findPaymentRequest(env.BILLING_DB, auth.organizationId, paymentRequestId);
  if (!created) throw new Error("payment_request_persistence_failed");
  return json(
    { payment_request: await serializePaymentRequest(env.BILLING_DB, created) },
    { requestId },
  );
}

async function listPaymentRequests(
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
  const paymentStatus = optionalPaymentStatus(url.searchParams.get("payment_status"));
  const currency = optionalCurrency(url.searchParams.get("currency"));
  const conditions = ["request.organization_id = ?"];
  const bindings: unknown[] = [auth.organizationId];
  if (externalCustomerId) {
    conditions.push("customer.external_id = ?");
    bindings.push(externalCustomerId);
  }
  if (paymentStatus) {
    conditions.push("request.payment_status = ?");
    bindings.push(paymentStatus);
  }
  if (currency) {
    conditions.push("request.currency = ?");
    bindings.push(currency);
  }
  const where = conditions.join(" AND ");
  const count = await database
    .prepare(
      `SELECT COUNT(*) AS total FROM payment_requests request
       JOIN customers customer ON customer.id = request.customer_id WHERE ${where}`,
    )
    .bind(...bindings)
    .first<{ total: number }>();
  const rows = await database
    .prepare(
      `${paymentRequestSelect()} WHERE ${where}
       ORDER BY request.created_at DESC, request.id DESC LIMIT ? OFFSET ?`,
    )
    .bind(...bindings, perPage, offset)
    .all<PaymentRequestRow>();
  return json(
    {
      payment_requests: await Promise.all(
        rows.results.map((paymentRequest) => serializePaymentRequest(database, paymentRequest)),
      ),
      meta: pagination(count?.total ?? 0, page, perPage),
    },
    { requestId },
  );
}

async function showPaymentRequest(
  paymentRequestId: string,
  database: D1Database,
  auth: AuthContext,
  requestId: string,
): Promise<Response> {
  const paymentRequest = await findPaymentRequest(database, auth.organizationId, paymentRequestId);
  if (!paymentRequest) {
    throw new ApiError(404, "payment_request_not_found", "Payment request was not found");
  }
  return json(
    { payment_request: await serializePaymentRequest(database, paymentRequest) },
    { requestId },
  );
}

async function findPaymentRequest(
  database: D1Database,
  organizationId: string,
  paymentRequestId: string,
): Promise<PaymentRequestRow | null> {
  return database
    .prepare(
      `${paymentRequestSelect()} WHERE request.organization_id = ? AND request.id = ? LIMIT 1`,
    )
    .bind(organizationId, paymentRequestId)
    .first<PaymentRequestRow>();
}

function paymentRequestSelect(): string {
  return `SELECT request.id, request.organization_id, request.customer_id,
                 customer.external_id AS external_customer_id,
                 request.amount_minor, request.currency, request.email, request.payment_attempts,
                 request.payment_status, request.ready_for_payment_processing, request.version,
                 request.created_at, request.updated_at
          FROM payment_requests request JOIN customers customer ON customer.id = request.customer_id`;
}

async function serializePaymentRequest(
  database: D1Database,
  paymentRequest: PaymentRequestRow,
): Promise<Record<string, unknown>> {
  const [customer, linked] = await Promise.all([
    findCustomer(database, paymentRequest.organization_id, paymentRequest.external_customer_id),
    database
      .prepare(
        `SELECT invoice_id FROM invoices_payment_requests
         WHERE organization_id = ? AND payment_request_id = ? ORDER BY created_at, invoice_id`,
      )
      .bind(paymentRequest.organization_id, paymentRequest.id)
      .all<{ invoice_id: string }>(),
  ]);
  if (!customer) throw new Error("payment_request_customer_missing");
  const invoiceRows = await Promise.all(
    linked.results.map((link) =>
      findInvoice(database, paymentRequest.organization_id, link.invoice_id),
    ),
  );
  if (invoiceRows.some((invoice) => !invoice)) throw new Error("payment_request_invoice_missing");
  return {
    lago_id: paymentRequest.id,
    amount_cents: paymentRequest.amount_minor,
    amount_currency: paymentRequest.currency,
    email: paymentRequest.email,
    payment_status: paymentRequest.payment_status,
    created_at: paymentRequest.created_at,
    customer: await serializeCustomer(database, customer, paymentRequest.organization_id),
    invoices: await Promise.all(
      (invoiceRows as InvoiceRow[]).map((invoice) => serializeInvoice(database, invoice)),
    ),
  };
}

function invoiceIdList(value: unknown): string[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 100) {
    throw new ApiError(
      422,
      "validation_error",
      "lago_invoice_ids must contain between 1 and 100 invoice IDs",
    );
  }
  const ids = value.map((invoiceId) => {
    if (typeof invoiceId !== "string" || !invoiceId.trim()) {
      throw new ApiError(422, "validation_error", "lago_invoice_ids must contain strings");
    }
    return invoiceId.trim();
  });
  if (new Set(ids).size !== ids.length) {
    throw new ApiError(422, "validation_error", "lago_invoice_ids must not contain duplicates");
  }
  return ids;
}

function outstandingMinor(invoice: InvoiceRow): number {
  const outstanding = invoice.total_due_minor - invoice.total_paid_minor;
  if (!Number.isSafeInteger(outstanding)) throw new Error("payment_request_amount_overflow");
  return Math.max(outstanding, 0);
}

function safeAdd(left: number, right: number): number {
  const value = left + right;
  if (!Number.isSafeInteger(value)) throw new Error("payment_request_amount_overflow");
  return value;
}

function normalizedEmail(value: string | null): string | null {
  if (!value) return null;
  const email = value.trim().toLowerCase();
  if (email.length > 255 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new ApiError(422, "validation_error", "email must be a valid email address");
  }
  return email;
}

function optionalPaymentStatus(value: string | null): PaymentRequestRow["payment_status"] | null {
  if (!value) return null;
  if (!["pending", "succeeded", "failed"].includes(value)) {
    throw new ApiError(422, "validation_error", "payment_status is invalid");
  }
  return value as PaymentRequestRow["payment_status"];
}

function optionalCurrency(value: string | null): string | null {
  if (!value) return null;
  const currency = value.trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(currency)) {
    throw new ApiError(422, "validation_error", "currency must be an ISO-4217 code");
  }
  return currency;
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

function paymentRequestCreatedEvent(
  paymentRequestId: string,
  organizationId: string,
  customerId: string,
  invoiceIds: string[],
  amountMinor: number,
  currency: string,
  requestId: string,
  occurredAt: string,
): DomainEvent {
  return {
    id: `payment-request-created:${paymentRequestId}:v1`,
    type: "payment_request.created",
    version: 1,
    aggregateType: "payment_request",
    aggregateId: paymentRequestId,
    aggregateVersion: 1,
    occurredAt,
    causationId: requestId,
    correlationId: requestId,
    payload: {
      organizationId,
      paymentRequestId,
      customerId,
      invoiceIds,
      amountMinor,
      currency,
    },
  };
}

function outboxStatement(
  database: D1Database,
  organizationId: string,
  event: DomainEvent,
): D1PreparedStatement {
  return database
    .prepare(
      `INSERT OR IGNORE INTO outbox_events
       (event_id, organization_id, event_type, event_version, aggregate_type, aggregate_id,
        aggregate_version, causation_id, correlation_id, payload_json, occurred_at, published_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
    )
    .bind(
      event.id,
      organizationId,
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
