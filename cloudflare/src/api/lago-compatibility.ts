import type { AuthContext } from "../auth/api-key";
import { sha256Hex } from "../auth/api-key";
import { ApiError, json, objectAt, optionalString, parseJsonObject, requiredString } from "../http";
import { deterministicUuid } from "../identifiers";
import { createAuthorizeNetPaymentUrl } from "../providers/authorize-net";
import { nextPeriodEnd } from "../billing/periods";
import { calculateCouponCredits } from "../billing/coupon-credits";
import {
  calculateWalletAllocations,
  walletAllocationStatements,
  walletRecreditStatements,
} from "../billing/wallet-credits";
import {
  calculateCreditNoteAllocations,
  creditNoteAllocationStatements,
  creditNoteRecreditStatements,
} from "../billing/credit-note-credits";
import { handleMeteredUsageRequest } from "./metered-usage";
import { handlePlanCatalogRequest } from "./plan-catalog";
import { handleSubscriptionLifecycleRequest } from "./subscription-lifecycle";
import { handleCouponLedgerRequest } from "./coupon-ledger";
import { handleWalletLedgerRequest } from "./wallet-ledger";
import { handleCreditNoteLedgerRequest } from "./credit-note-ledger";

type CustomerRow = {
  id: string;
  external_id: string;
  email: string | null;
  name: string | null;
  currency: string | null;
  metadata_json: string;
  payment_provider: string | null;
  payment_provider_code: string | null;
  created_at: string;
  updated_at: string;
};

type SubscriptionRow = {
  id: string;
  external_id: string;
  customer_id: string;
  customer_external_id: string;
  plan_code: string;
  plan_amount_minor: number;
  plan_currency: string;
  plan_interval: string;
  name: string | null;
  request_sha256: string | null;
  status: string;
  started_at: string | null;
  current_period_start: string | null;
  current_period_end: string | null;
  canceled_at: string | null;
  terminated_at: string | null;
  created_at: string;
};

type InvoiceRow = {
  id: string;
  customer_id: string;
  customer_external_id: string;
  customer_email?: string | null;
  payment_provider: string | null;
  payment_provider_code: string | null;
  number: string | null;
  status: string;
  payment_status: string;
  currency: string;
  subtotal_minor: number;
  tax_minor: number;
  credits_minor: number;
  coupons_minor: number;
  credit_notes_minor: number;
  prepaid_credit_minor: number;
  total_due_minor: number;
  version: number;
  finalized_at: string | null;
  voided_at: string | null;
  created_at: string;
  updated_at: string;
};

export async function handleLagoCompatibilityRequest(
  request: Request,
  env: Env,
  auth: AuthContext,
  requestId: string,
): Promise<Response | null> {
  const url = new URL(request.url);

  const planResponse = await handlePlanCatalogRequest(request, env.BILLING_DB, auth, requestId);
  if (planResponse) return planResponse;

  const lifecycleResponse = await handleSubscriptionLifecycleRequest(request, env, auth, requestId);
  if (lifecycleResponse) return lifecycleResponse;

  const meteredUsageResponse = await handleMeteredUsageRequest(request, env, auth, requestId);
  if (meteredUsageResponse) return meteredUsageResponse;

  const couponResponse = await handleCouponLedgerRequest(request, env, auth, requestId);
  if (couponResponse) return couponResponse;

  const walletResponse = await handleWalletLedgerRequest(request, env, auth, requestId);
  if (walletResponse) return walletResponse;

  const creditNoteResponse = await handleCreditNoteLedgerRequest(request, env, auth, requestId);
  if (creditNoteResponse) return creditNoteResponse;

  if (request.method === "POST" && url.pathname === "/api/v1/customers") {
    return upsertCustomer(request, env.BILLING_DB, auth, requestId);
  }

  if (request.method === "GET" && url.pathname === "/api/v1/customers") {
    return listCustomers(url, env.BILLING_DB, auth, requestId);
  }

  const customerMatch = url.pathname.match(/^\/api\/v1\/customers\/([^/]+)$/);
  if (request.method === "GET" && customerMatch?.[1]) {
    return showCustomer(decodeURIComponent(customerMatch[1]), env.BILLING_DB, auth, requestId);
  }

  if (request.method === "POST" && url.pathname === "/api/v1/subscriptions") {
    return createSubscription(request, env, auth, requestId);
  }

  if (request.method === "GET" && url.pathname === "/api/v1/invoices") {
    return listInvoices(url, env.BILLING_DB, auth, requestId);
  }

  const invoiceMatch = url.pathname.match(/^\/api\/v1\/invoices\/([^/]+)$/);
  if (request.method === "GET" && invoiceMatch?.[1]) {
    return showInvoice(decodeURIComponent(invoiceMatch[1]), env.BILLING_DB, auth, requestId);
  }

  const invoiceVoidMatch = url.pathname.match(/^\/api\/v1\/invoices\/([^/]+)\/void$/);
  if (request.method === "POST" && invoiceVoidMatch?.[1]) {
    return voidInvoice(request, decodeURIComponent(invoiceVoidMatch[1]), env, auth, requestId);
  }

  const invoiceDownloadMatch = url.pathname.match(
    /^\/api\/v1\/invoices\/([^/]+)\/(?:download|download_pdf)$/,
  );
  if (request.method === "POST" && invoiceDownloadMatch?.[1]) {
    return requestInvoicePdf(decodeURIComponent(invoiceDownloadMatch[1]), env, auth, requestId);
  }

  const paymentUrlMatch = url.pathname.match(/^\/api\/v1\/invoices\/([^/]+)\/payment_url$/);
  if (request.method === "POST" && paymentUrlMatch?.[1]) {
    return generateInvoicePaymentUrl(decodeURIComponent(paymentUrlMatch[1]), env, auth, requestId);
  }

  return null;
}

async function upsertCustomer(
  request: Request,
  database: D1Database,
  auth: AuthContext,
  requestId: string,
): Promise<Response> {
  const body = await parseJsonObject(request);
  const input = objectAt(body, "customer");
  const externalId = requiredString(input, "external_id");
  const name = optionalString(input, "name");
  const email = normalizeEmail(optionalString(input, "email"));
  const currency = optionalString(input, "currency")?.toUpperCase() ?? null;
  const billingConfiguration = readOptionalObject(input.billing_configuration);
  const paymentProvider = optionalString(billingConfiguration, "payment_provider");
  const paymentProviderCode = optionalString(billingConfiguration, "payment_provider_code");
  const metadata = normalizeMetadata(input.metadata);
  const now = new Date().toISOString();

  await database
    .prepare(
      `INSERT INTO customers
       (id, organization_id, external_id, email, name, currency, metadata_json,
        payment_provider, payment_provider_code, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (organization_id, external_id) DO UPDATE SET
         email = excluded.email,
         name = excluded.name,
         currency = COALESCE(excluded.currency, customers.currency),
         metadata_json = excluded.metadata_json,
         payment_provider = excluded.payment_provider,
         payment_provider_code = excluded.payment_provider_code,
         updated_at = excluded.updated_at`,
    )
    .bind(
      await deterministicUuid("customer", `${auth.organizationId}:${externalId}`),
      auth.organizationId,
      externalId,
      email,
      name,
      currency,
      JSON.stringify(metadata),
      paymentProvider,
      paymentProviderCode,
      now,
      now,
    )
    .run();

  const customer = await findCustomer(database, auth.organizationId, externalId);
  if (!customer) throw new ApiError(500, "persistence_error", "Customer was not persisted");
  return json({ customer: serializeCustomer(customer) }, { requestId });
}

async function listCustomers(
  url: URL,
  database: D1Database,
  auth: AuthContext,
  requestId: string,
): Promise<Response> {
  const page = positiveInteger(url.searchParams.get("page"), 1);
  const perPage = Math.min(positiveInteger(url.searchParams.get("per_page"), 20), 100);
  const offset = (page - 1) * perPage;
  const search = url.searchParams.get("search_term")?.trim().toLowerCase() || null;
  const where = search
    ? `organization_id = ? AND (
         lower(external_id) LIKE ? ESCAPE '\\' OR
         lower(COALESCE(name, '')) LIKE ? ESCAPE '\\' OR
         lower(COALESCE(email, '')) LIKE ? ESCAPE '\\'
       )`
    : "organization_id = ?";
  const pattern = search ? `%${escapeLike(search)}%` : null;
  const bindings = pattern
    ? [auth.organizationId, pattern, pattern, pattern]
    : [auth.organizationId];
  const count = await database
    .prepare(`SELECT COUNT(*) AS total FROM customers WHERE ${where}`)
    .bind(...bindings)
    .first<{ total: number }>();
  const result = await database
    .prepare(
      `SELECT id, external_id, email, name, currency, metadata_json, payment_provider,
              payment_provider_code, created_at, updated_at
       FROM customers WHERE ${where}
       ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`,
    )
    .bind(...bindings, perPage, offset)
    .all<CustomerRow>();
  return json(
    {
      customers: result.results.map(serializeCustomer),
      meta: pagination(totalCount(count), page, perPage),
    },
    { requestId },
  );
}

async function showCustomer(
  externalId: string,
  database: D1Database,
  auth: AuthContext,
  requestId: string,
): Promise<Response> {
  const customer = await findCustomer(database, auth.organizationId, externalId);
  if (!customer) throw new ApiError(404, "customer_not_found", "Customer was not found");
  return json({ customer: serializeCustomer(customer) }, { requestId });
}

async function createSubscription(
  request: Request,
  env: Env,
  auth: AuthContext,
  requestId: string,
): Promise<Response> {
  const database = env.BILLING_DB;
  const body = await parseJsonObject(request);
  const input = objectAt(body, "subscription");
  const externalCustomerId = requiredString(input, "external_customer_id");
  const externalId = requiredString(input, "external_id");
  const planCode = requiredString(input, "plan_code");
  const name = optionalString(input, "name");
  const requestHash = await sha256Hex(
    JSON.stringify({ externalCustomerId, externalId, name, planCode }),
  );

  const existing = await findSubscription(database, auth.organizationId, externalId);
  if (existing) {
    assertSubscriptionReplay(existing, { externalCustomerId, name, planCode, requestHash });
    return json({ subscription: serializeSubscription(existing) }, { requestId });
  }

  const customer = await findCustomer(database, auth.organizationId, externalCustomerId);
  if (!customer) throw new ApiError(404, "customer_not_found", "Customer was not found");

  const plan = await database
    .prepare(
      `SELECT id, code, name, interval, amount_minor, currency
       FROM plans
       WHERE organization_id = ? AND code = ? AND active = 1
       ORDER BY version DESC LIMIT 1`,
    )
    .bind(auth.organizationId, planCode)
    .first<{
      id: string;
      code: string;
      name: string;
      interval: string;
      amount_minor: number;
      currency: string;
    }>();
  if (!plan) throw new ApiError(404, "plan_not_found", "Plan was not found");

  const now = new Date();
  const timestamp = now.toISOString();
  const periodEnd = nextPeriodEnd(now, plan.interval).toISOString();
  const commandKey = `${auth.organizationId}:${externalId}`;
  const subscriptionId = await deterministicUuid("subscription", commandKey);
  const invoiceId = await deterministicUuid("initial-invoice", commandKey);
  const invoiceLineId = await deterministicUuid("initial-invoice-line", commandKey);
  const invoiceNumber = invoiceId.replaceAll("-", "").slice(0, 20).toUpperCase();
  const couponCredits = await calculateCouponCredits(
    database,
    auth.organizationId,
    customer.id,
    invoiceId,
    plan.currency,
    plan.amount_minor,
  );
  const couponsMinor = couponCredits.reduce(
    (total, credit) => safeAddMinor(total, credit.amountMinor),
    0,
  );
  const creditNoteAllocations = await calculateCreditNoteAllocations(
    database,
    auth.organizationId,
    customer.id,
    invoiceId,
    plan.currency,
    plan.amount_minor - couponsMinor,
  );
  const creditNotesMinor = creditNoteAllocations.reduce(
    (total, allocation) => safeAddMinor(total, allocation.amountMinor),
    0,
  );
  const walletAllocations = await calculateWalletAllocations(
    database,
    auth.organizationId,
    customer.id,
    invoiceId,
    plan.currency,
    plan.amount_minor - couponsMinor - creditNotesMinor,
  );
  const prepaidCreditMinor = walletAllocations.reduce(
    (total, allocation) => safeAddMinor(total, allocation.amountMinor),
    0,
  );
  const creditsMinor = safeAddMinor(
    safeAddMinor(couponsMinor, creditNotesMinor),
    prepaidCreditMinor,
  );
  const totalDueMinor = plan.amount_minor - creditsMinor;

  try {
    const statements: D1PreparedStatement[] = [
      database
        .prepare(
          `INSERT INTO subscriptions
         (id, organization_id, customer_id, plan_id, external_id, status, started_at,
          current_period_start, current_period_end, version, created_at, updated_at,
          name, request_sha256)
         VALUES (?, ?, ?, ?, ?, 'active', ?, ?, ?, 1, ?, ?, ?, ?)`,
        )
        .bind(
          subscriptionId,
          auth.organizationId,
          customer.id,
          plan.id,
          externalId,
          timestamp,
          timestamp,
          periodEnd,
          timestamp,
          timestamp,
          name,
          requestHash,
        ),
      database
        .prepare(
          `INSERT INTO invoices
         (id, organization_id, customer_id, subscription_id, number, status, payment_status,
          currency, subtotal_minor, tax_minor, credits_minor, total_due_minor, version,
          finalized_at, created_at, updated_at, coupons_minor, prepaid_credit_minor,
          credit_notes_minor)
         VALUES (?, ?, ?, ?, ?, 'finalized', 'pending', ?, ?, 0, ?, ?, 1, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          invoiceId,
          auth.organizationId,
          customer.id,
          subscriptionId,
          invoiceNumber,
          plan.currency,
          plan.amount_minor,
          creditsMinor,
          totalDueMinor,
          timestamp,
          timestamp,
          timestamp,
          couponsMinor,
          prepaidCreditMinor,
          creditNotesMinor,
        ),
      database
        .prepare(
          `INSERT INTO invoice_lines
         (id, invoice_id, line_type, description, quantity_decimal, unit_amount_decimal,
          amount_minor, source_type, source_id, metadata_json, created_at)
         VALUES (?, ?, 'subscription', ?, '1', ?, ?, 'plan', ?, '{}', ?)`,
        )
        .bind(
          invoiceLineId,
          invoiceId,
          name ?? plan.name,
          String(plan.amount_minor),
          plan.amount_minor,
          plan.id,
          timestamp,
        ),
    ];
    for (const credit of couponCredits) {
      statements.push(
        database
          .prepare(
            `INSERT INTO coupon_credits
             (id, organization_id, invoice_id, applied_coupon_id, applied_coupon_version,
              amount_minor, currency, before_taxes, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?)`,
          )
          .bind(
            credit.id,
            auth.organizationId,
            invoiceId,
            credit.appliedCouponId,
            credit.expectedVersion,
            credit.amountMinor,
            plan.currency,
            timestamp,
          ),
        database
          .prepare(
            `UPDATE applied_coupons
             SET frequency_duration_remaining = ?,
                 status = CASE WHEN ? = 1 THEN 'terminated' ELSE status END,
                 termination_reason = CASE WHEN ? = 1 THEN 'consumed' ELSE termination_reason END,
                 terminated_at = CASE WHEN ? = 1 THEN ? ELSE terminated_at END,
                 version = version + 1, updated_at = ?
             WHERE id = ? AND organization_id = ? AND status = 'active' AND version = ?`,
          )
          .bind(
            credit.nextRemaining,
            credit.terminates ? 1 : 0,
            credit.terminates ? 1 : 0,
            credit.terminates ? 1 : 0,
            timestamp,
            timestamp,
            credit.appliedCouponId,
            auth.organizationId,
            credit.expectedVersion,
          ),
      );
    }
    for (const allocation of walletAllocations) {
      statements.push(
        ...walletAllocationStatements(
          database,
          auth.organizationId,
          invoiceId,
          allocation,
          timestamp,
          requestId,
        ),
      );
    }
    for (const allocation of creditNoteAllocations) {
      statements.push(
        ...creditNoteAllocationStatements(
          database,
          auth.organizationId,
          invoiceId,
          allocation,
          timestamp,
          requestId,
        ),
      );
    }
    const results = await database.batch(statements);
    for (let offset = 0; offset < couponCredits.length; offset += 1) {
      const update = results[4 + offset * 2];
      if (!update || update.meta.changes !== 1) throw new Error("coupon_version_conflict");
    }
  } catch (error) {
    const concurrent = await findSubscription(database, auth.organizationId, externalId);
    if (!concurrent) {
      const message = error instanceof Error ? error.message : "";
      if (message.includes("coupon_version_conflict")) {
        throw new ApiError(
          409,
          "coupon_version_conflict",
          "Coupon changed during subscription creation; retry the request",
        );
      }
      throw error;
    }
    assertSubscriptionReplay(concurrent, { externalCustomerId, name, planCode, requestHash });
    return json({ subscription: serializeSubscription(concurrent) }, { requestId });
  }

  const subscription = await findSubscription(database, auth.organizationId, externalId);
  if (!subscription) throw new ApiError(500, "persistence_error", "Subscription was not persisted");
  assertSubscriptionReplay(subscription, { externalCustomerId, name, planCode, requestHash });
  return json({ subscription: serializeSubscription(subscription) }, { requestId });
}

function safeAddMinor(left: number, right: number): number {
  const total = left + right;
  if (!Number.isSafeInteger(total) || total < 0) {
    throw new ApiError(422, "invalid_minor_amount", "Coupon amount exceeds supported precision");
  }
  return total;
}

async function listInvoices(
  url: URL,
  database: D1Database,
  auth: AuthContext,
  requestId: string,
): Promise<Response> {
  const externalCustomerId =
    url.searchParams.get("external_customer_id")?.trim() ||
    url.searchParams.get("customer_external_id")?.trim();
  const page = positiveInteger(url.searchParams.get("page"), 1);
  const perPage = Math.min(positiveInteger(url.searchParams.get("per_page"), 100), 100);
  const offset = (page - 1) * perPage;

  const where = externalCustomerId
    ? "i.organization_id = ? AND c.external_id = ?"
    : "i.organization_id = ?";
  const bindings = externalCustomerId
    ? [auth.organizationId, externalCustomerId]
    : [auth.organizationId];
  const count = await database
    .prepare(
      `SELECT COUNT(*) AS total
       FROM invoices i JOIN customers c ON c.id = i.customer_id
       WHERE ${where}`,
    )
    .bind(...bindings)
    .first<{ total: number }>();

  const result = await database
    .prepare(
      `SELECT i.id, i.customer_id, c.external_id AS customer_external_id,
              c.payment_provider, c.payment_provider_code, i.number, i.status,
              i.payment_status, i.currency, i.subtotal_minor, i.tax_minor,
              i.credits_minor, i.coupons_minor, i.credit_notes_minor, i.prepaid_credit_minor,
              i.total_due_minor, i.version, i.finalized_at,
              i.voided_at, i.created_at, i.updated_at
       FROM invoices i JOIN customers c ON c.id = i.customer_id
       WHERE ${where}
       ORDER BY i.created_at DESC, i.id DESC
       LIMIT ? OFFSET ?`,
    )
    .bind(...bindings, perPage, offset)
    .all<InvoiceRow>();

  const totalCount = count?.total ?? 0;
  const totalPages = totalCount === 0 ? 0 : Math.ceil(totalCount / perPage);
  return json(
    {
      invoices: result.results.map(serializeInvoice),
      meta: {
        current_page: totalCount === 0 ? 0 : page,
        next_page: page < totalPages ? page + 1 : null,
        prev_page: page > 1 && page <= totalPages ? page - 1 : null,
        total_pages: totalPages,
        total_count: totalCount,
      },
    },
    { requestId },
  );
}

async function showInvoice(
  invoiceId: string,
  database: D1Database,
  auth: AuthContext,
  requestId: string,
): Promise<Response> {
  const invoice = await findInvoice(database, auth.organizationId, invoiceId);
  if (!invoice) throw new ApiError(404, "invoice_not_found", "Invoice was not found");
  return json(
    {
      invoice: {
        ...serializeInvoice(invoice),
        fees: await serializeInvoiceLines(database, invoice),
        credits: await serializeCouponCredits(database, invoice),
        wallet_transactions: await serializeInvoiceWalletTransactions(database, invoice),
      },
    },
    { requestId },
  );
}

async function voidInvoice(
  request: Request,
  invoiceId: string,
  env: Env,
  auth: AuthContext,
  requestId: string,
): Promise<Response> {
  const body = await parseJsonObjectOrEmpty(request);
  if (
    body.generate_credit_note === true ||
    body.refund_amount !== undefined ||
    body.credit_amount !== undefined
  ) {
    throw new ApiError(
      422,
      "unsupported_void_credit_note",
      "Credit-note and refund generation during void is not implemented",
    );
  }
  let invoice = await findInvoice(env.BILLING_DB, auth.organizationId, invoiceId);
  if (!invoice) throw new ApiError(404, "invoice_not_found", "Invoice was not found");
  if (invoice.status === "voided") {
    return json(
      {
        invoice: {
          ...serializeInvoice(invoice),
          fees: await serializeInvoiceLines(env.BILLING_DB, invoice),
        },
      },
      { requestId },
    );
  }
  if (invoice.status !== "finalized") {
    throw new ApiError(422, "not_voidable", "Only finalized invoices can be voided");
  }
  if (invoice.payment_status === "succeeded") {
    throw new ApiError(
      422,
      "unsupported_paid_invoice_void",
      "Paid invoice void requires credit-note/refund ledger support",
    );
  }
  const requestHash = await sha256Hex(
    JSON.stringify({ invoiceId, version: invoice.version, operation: "void" }),
  );
  const reservationKey = `invoice-void:${invoice.id}:v${invoice.version}`;
  const account = env.BILLING_ACCOUNTS.getByName(`customer:${invoice.customer_id}`);
  const reservation = await account.reserveCommand({
    idempotencyKey: reservationKey,
    commandType: "invoice.void",
    requestHash,
  });
  if (!reservation.ok) {
    throw new ApiError(409, reservation.error, "Invoice void conflicts with another command");
  }
  if (reservation.replayed && reservation.reservation.status !== "completed") {
    throw new ApiError(409, "invoice_void_in_progress", "Invoice void is in progress");
  }
  if (!reservation.replayed) {
    const voidedAt = new Date().toISOString();
    const eventId = `invoice-voided:${invoice.id}:v${invoice.version + 1}`;
    const payload = {
      organizationId: auth.organizationId,
      invoiceId: invoice.id,
      voidedAt,
      totalDueMinor: invoice.total_due_minor,
      paymentStatus: invoice.payment_status,
    };
    try {
      const walletRecredits = await walletRecreditStatements(
        env.BILLING_DB,
        auth.organizationId,
        invoice.id,
        voidedAt,
        requestId,
      );
      const creditNoteRecredits = await creditNoteRecreditStatements(
        env.BILLING_DB,
        auth.organizationId,
        invoice.id,
        voidedAt,
        requestId,
      );
      const results = await env.BILLING_DB.batch([
        env.BILLING_DB.prepare(
          `UPDATE invoices SET status = 'voided', voided_at = ?, version = version + 1,
             updated_at = ?
           WHERE id = ? AND organization_id = ? AND status = 'finalized'
             AND payment_status <> 'succeeded' AND version = ?`,
        ).bind(voidedAt, voidedAt, invoice.id, auth.organizationId, invoice.version),
        env.BILLING_DB.prepare(
          `INSERT INTO outbox_events
           (event_id, organization_id, event_type, event_version, aggregate_type,
            aggregate_id, aggregate_version, causation_id, correlation_id, payload_json,
            occurred_at, published_at)
           SELECT ?, ?, 'invoice.voided', 1, 'invoice', ?, ?, ?, ?, ?, ?, NULL
           FROM invoices
           WHERE id = ? AND organization_id = ? AND status = 'voided'
             AND version = ? AND voided_at = ?`,
        ).bind(
          eventId,
          auth.organizationId,
          invoice.id,
          invoice.version + 1,
          requestId,
          requestId,
          JSON.stringify(payload),
          voidedAt,
          invoice.id,
          auth.organizationId,
          invoice.version + 1,
          voidedAt,
        ),
        env.BILLING_DB.prepare(
          `UPDATE applied_coupons
           SET frequency_duration_remaining = CASE
                 WHEN frequency = 'recurring' THEN MIN(frequency_duration,
                   frequency_duration_remaining + 1)
                 ELSE frequency_duration_remaining
               END,
               status = CASE WHEN termination_reason = 'consumed' THEN 'active' ELSE status END,
               termination_reason = CASE WHEN termination_reason = 'consumed' THEN NULL ELSE termination_reason END,
               terminated_at = CASE WHEN termination_reason = 'consumed' THEN NULL ELSE terminated_at END,
               version = version + 1, updated_at = ?
           WHERE id IN (SELECT applied_coupon_id FROM coupon_credits WHERE invoice_id = ?)`,
        ).bind(voidedAt, invoice.id),
        ...walletRecredits,
        ...creditNoteRecredits,
      ]);
      if (results[0]?.meta.changes !== 1 || results[1]?.meta.changes !== 1) {
        throw new Error("invoice_version_conflict");
      }
      await env.DOMAIN_EVENTS.send({
        id: eventId,
        type: "invoice.voided",
        version: 1,
        aggregateType: "invoice",
        aggregateId: invoice.id,
        aggregateVersion: invoice.version + 1,
        occurredAt: voidedAt,
        causationId: requestId,
        correlationId: requestId,
        payload,
      });
      await account.completeCommand(reservationKey, { voidedAt, eventId });
    } catch (error) {
      await account.releaseCommand(reservationKey, requestHash);
      throw error;
    }
  }
  invoice = await findInvoice(env.BILLING_DB, auth.organizationId, invoiceId);
  if (!invoice) throw new ApiError(500, "persistence_error", "Invoice disappeared");
  return json(
    {
      invoice: {
        ...serializeInvoice(invoice),
        fees: await serializeInvoiceLines(env.BILLING_DB, invoice),
      },
    },
    { requestId },
  );
}

async function requestInvoicePdf(
  invoiceId: string,
  env: Env,
  auth: AuthContext,
  requestId: string,
): Promise<Response> {
  const invoice = await findInvoice(env.BILLING_DB, auth.organizationId, invoiceId);
  if (!invoice) throw new ApiError(404, "invoice_not_found", "Invoice was not found");
  if (invoice.status !== "finalized") {
    throw new ApiError(422, "invoice_not_finalized", "Only finalized invoices have PDFs");
  }
  const artifact = await env.BILLING_DB.prepare(
    `SELECT status, object_key FROM document_artifacts
     WHERE resource_type = 'invoice' AND resource_id = ? AND resource_version = ?
       AND artifact_type = 'pdf' LIMIT 1`,
  )
    .bind(invoice.id, invoice.version)
    .first<{ status: string; object_key: string | null }>();
  if (artifact?.status === "ready" && artifact.object_key) {
    const object = await env.BILLING_ARTIFACTS.get(artifact.object_key);
    if (!object) throw new ApiError(503, "artifact_missing", "Invoice PDF artifact is unavailable");
    const safeNumber = (invoice.number ?? invoice.id).replaceAll(/[^A-Za-z0-9._-]/g, "_");
    return new Response(object.body, {
      headers: {
        "Cache-Control": "private, no-store",
        "Content-Disposition": `attachment; filename="invoice-${safeNumber}.pdf"`,
        "Content-Type": "application/pdf",
        "X-Request-Id": requestId,
      },
    });
  }
  const workflowId = `invoice-pdf-${invoice.id}-v${invoice.version}`;
  try {
    await env.DOCUMENT_WORKFLOW.create({
      id: workflowId,
      params: {
        invoiceId: invoice.id,
        organizationId: auth.organizationId,
        correlationId: requestId,
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message.toLowerCase() : "";
    if (!message.includes("already exists")) throw error;
  }
  return json(
    { invoice: { ...serializeInvoice(invoice), file_url: null }, document_status: "generating" },
    { requestId, status: 202 },
  );
}

async function findInvoice(
  database: D1Database,
  organizationId: string,
  invoiceId: string,
): Promise<InvoiceRow | null> {
  return database
    .prepare(
      `SELECT i.id, i.customer_id, c.external_id AS customer_external_id,
              c.email AS customer_email, c.payment_provider, c.payment_provider_code,
              i.number, i.status, i.payment_status, i.currency, i.subtotal_minor,
              i.tax_minor, i.credits_minor, i.coupons_minor, i.credit_notes_minor, i.prepaid_credit_minor,
              i.total_due_minor, i.version,
              i.finalized_at, i.voided_at, i.created_at, i.updated_at
       FROM invoices i JOIN customers c ON c.id = i.customer_id
       WHERE i.organization_id = ? AND i.id = ? LIMIT 1`,
    )
    .bind(organizationId, invoiceId)
    .first<InvoiceRow>();
}

async function serializeInvoiceLines(
  database: D1Database,
  invoice: InvoiceRow,
): Promise<Array<Record<string, unknown>>> {
  const result = await database
    .prepare(
      `SELECT id, line_type, description, quantity_decimal, unit_amount_decimal,
              amount_minor, source_type, source_id, precise_amount_minor, created_at
       FROM invoice_lines WHERE invoice_id = ? ORDER BY created_at, id`,
    )
    .bind(invoice.id)
    .all<{
      id: string;
      line_type: string;
      description: string;
      quantity_decimal: string;
      unit_amount_decimal: string;
      amount_minor: number;
      source_type: string;
      source_id: string;
      precise_amount_minor: string | null;
      created_at: string;
    }>();
  return result.results.map((line) => ({
    lago_id: line.id,
    lago_invoice_id: invoice.id,
    lago_charge_id: line.source_type === "charge" ? line.source_id : null,
    lago_subscription_id: null,
    item: {
      type: line.line_type,
      code: line.source_id,
      name: line.description,
      description: line.description,
      invoice_display_name: line.description,
      lago_item_id: line.source_id,
      item_type: line.source_type,
    },
    pay_in_advance: false,
    invoiceable: true,
    amount_cents: line.amount_minor,
    amount_currency: invoice.currency,
    precise_amount_cents: line.precise_amount_minor ?? String(line.amount_minor),
    unit_amount_cents: line.unit_amount_decimal,
    units: line.quantity_decimal,
    description: line.description,
    payment_status: invoice.payment_status,
    created_at: line.created_at,
  }));
}

async function serializeCouponCredits(
  database: D1Database,
  invoice: InvoiceRow,
): Promise<Array<Record<string, unknown>>> {
  const result = await database
    .prepare(
      `SELECT cc.id, cc.amount_minor, cc.currency, cc.before_taxes,
              ac.id AS applied_coupon_id, cp.id AS coupon_id, cp.code, cp.name, cp.description
       FROM coupon_credits cc JOIN applied_coupons ac ON ac.id = cc.applied_coupon_id
       JOIN coupons cp ON cp.id = ac.coupon_id
       WHERE cc.invoice_id = ? ORDER BY cc.created_at, cc.id`,
    )
    .bind(invoice.id)
    .all<{
      id: string;
      amount_minor: number;
      currency: string;
      before_taxes: number;
      applied_coupon_id: string;
      coupon_id: string;
      code: string;
      name: string;
      description: string | null;
    }>();
  return result.results.map((credit) => ({
    lago_id: credit.id,
    amount_cents: credit.amount_minor,
    amount_currency: credit.currency,
    before_taxes: credit.before_taxes === 1,
    lago_applied_coupon_id: credit.applied_coupon_id,
    item: {
      lago_item_id: credit.coupon_id,
      type: "coupon",
      code: credit.code,
      name: credit.name,
      description: credit.description,
    },
    invoice: { lago_id: invoice.id, payment_status: invoice.payment_status },
  }));
}

async function serializeInvoiceWalletTransactions(
  database: D1Database,
  invoice: InvoiceRow,
): Promise<Array<Record<string, unknown>>> {
  const result = await database
    .prepare(
      `SELECT wt.id, wt.wallet_id, wt.amount_minor, wt.credit_amount, wt.created_at,
              w.code, w.name, w.currency
       FROM wallet_transactions wt JOIN wallets w ON w.id = wt.wallet_id
       WHERE wt.invoice_id = ? AND wt.transaction_type = 'outbound'
         AND wt.transaction_status = 'invoiced'
       ORDER BY wt.created_at, wt.id`,
    )
    .bind(invoice.id)
    .all<{
      id: string;
      wallet_id: string;
      amount_minor: number;
      credit_amount: string;
      created_at: string;
      code: string;
      name: string | null;
      currency: string;
    }>();
  return result.results.map((transaction) => ({
    lago_id: transaction.id,
    lago_wallet_id: transaction.wallet_id,
    lago_invoice_id: invoice.id,
    status: "settled",
    source: "manual",
    transaction_status: "invoiced",
    transaction_type: "outbound",
    amount_cents: transaction.amount_minor,
    amount_currency: transaction.currency,
    credit_amount: transaction.credit_amount,
    wallet_code: transaction.code,
    wallet_name: transaction.name,
    created_at: transaction.created_at,
  }));
}

async function parseJsonObjectOrEmpty(request: Request): Promise<Record<string, unknown>> {
  const contentLength = request.headers.get("Content-Length");
  if (contentLength === "0" || (!contentLength && !request.body)) return {};
  return parseJsonObject(request);
}

async function generateInvoicePaymentUrl(
  invoiceId: string,
  env: Env,
  auth: AuthContext,
  requestId: string,
): Promise<Response> {
  const invoice = await env.BILLING_DB.prepare(
    `SELECT i.id, i.customer_id, c.external_id AS customer_external_id,
            c.email AS customer_email,
            c.payment_provider, c.payment_provider_code, i.number, i.status,
            i.payment_status, i.currency, i.subtotal_minor, i.tax_minor,
            i.credits_minor, i.coupons_minor, i.credit_notes_minor, i.prepaid_credit_minor,
            i.total_due_minor, i.version, i.finalized_at,
            i.voided_at, i.created_at, i.updated_at
     FROM invoices i JOIN customers c ON c.id = i.customer_id
     WHERE i.organization_id = ? AND i.id = ? LIMIT 1`,
  )
    .bind(auth.organizationId, invoiceId)
    .first<InvoiceRow>();
  if (!invoice) throw new ApiError(404, "invoice_not_found", "Invoice was not found");
  if (invoice.status !== "finalized" || invoice.payment_status === "succeeded") {
    throw new ApiError(422, "invalid_invoice_status_or_payment_status", "Invoice is not payable");
  }
  if (invoice.payment_provider !== "authorize_net") {
    throw new ApiError(
      422,
      "invalid_payment_provider",
      "Authorize.Net is not configured for this customer",
    );
  }

  let paymentUrl = await env.BILLING_DB.prepare(
    `SELECT payment_url FROM payment_links
     WHERE invoice_id = ? AND (expires_at IS NULL OR expires_at > ?)`,
  )
    .bind(invoice.id, new Date().toISOString())
    .first<{ payment_url: string }>();

  if (!paymentUrl) {
    if (String(env.PAYMENT_MUTATIONS_ENABLED) !== "1") {
      throw new ApiError(
        503,
        "payment_mutations_disabled",
        "Payment provider mutations are disabled",
      );
    }
    const reservationKey = `payment-url:${invoice.id}:v${invoice.version}`;
    const reservationHash = await sha256Hex(
      JSON.stringify({
        amountMinor: invoice.total_due_minor,
        currency: invoice.currency,
        invoiceId: invoice.id,
      }),
    );
    const billingAccount = env.BILLING_ACCOUNTS.getByName(`invoice:${invoice.id}`);
    const reservation = await billingAccount.reserveCommand({
      idempotencyKey: reservationKey,
      commandType: "authorize_net.payment_url.create",
      requestHash: reservationHash,
    });
    if (!reservation.ok) {
      throw new ApiError(
        409,
        reservation.error,
        "Payment URL command conflicts with an existing request",
      );
    }
    if (
      reservation.replayed &&
      reservation.reservation.status === "completed" &&
      reservation.reservation.responseJson
    ) {
      const completed = parsePaymentUrlReservation(reservation.reservation.responseJson);
      if (completed) paymentUrl = { payment_url: completed.paymentUrl };
    }
    if (reservation.replayed && !paymentUrl) {
      throw new ApiError(
        409,
        "payment_url_creation_in_progress",
        "Payment URL creation is already in progress",
      );
    }
    if (paymentUrl) {
      return paymentUrlResponse(invoice, paymentUrl.payment_url, requestId);
    }

    try {
      const generated = await createAuthorizeNetPaymentUrl(env, {
        invoiceId: invoice.id,
        invoiceNumber: invoice.number ?? invoice.id,
        customerId: invoice.customer_id,
        externalCustomerId: invoice.customer_external_id,
        customerEmail: invoice.customer_email,
        organizationId: auth.organizationId,
        amountMinor: invoice.total_due_minor,
        currency: invoice.currency,
      });
      const tokenSha256 = await sha256Hex(generated.token);
      const now = new Date().toISOString();
      await env.BILLING_DB.prepare(
        `INSERT INTO payment_links
         (invoice_id, provider, provider_account_code, payment_url, provider_token_sha256,
          expires_at, created_at, updated_at)
         VALUES (?, 'authorize_net', ?, ?, ?, ?, ?, ?)
         ON CONFLICT(invoice_id) DO UPDATE SET
           payment_url = excluded.payment_url,
           provider_token_sha256 = excluded.provider_token_sha256,
           expires_at = excluded.expires_at,
           updated_at = excluded.updated_at`,
      )
        .bind(
          invoice.id,
          invoice.payment_provider_code ?? "default",
          generated.paymentUrl,
          tokenSha256,
          generated.expiresAt,
          now,
          now,
        )
        .run();
      await billingAccount.completeCommand(reservationKey, {
        paymentUrl: generated.paymentUrl,
        tokenSha256,
        expiresAt: generated.expiresAt,
      });
      paymentUrl = { payment_url: generated.paymentUrl };
    } catch (error) {
      await billingAccount.releaseCommand(reservationKey, reservationHash);
      throw error;
    }
  }

  return paymentUrlResponse(invoice, paymentUrl.payment_url, requestId);
}

function paymentUrlResponse(invoice: InvoiceRow, paymentUrl: string, requestId: string): Response {
  return json(
    {
      invoice_payment_details: {
        lago_customer_id: invoice.customer_id,
        external_customer_id: invoice.customer_external_id,
        payment_provider: invoice.payment_provider,
        lago_invoice_id: invoice.id,
        payment_url: paymentUrl,
      },
    },
    { requestId },
  );
}

function parsePaymentUrlReservation(responseJson: string): { paymentUrl: string } | null {
  try {
    const parsed = JSON.parse(responseJson) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const paymentUrl = (parsed as Record<string, unknown>).paymentUrl;
    return typeof paymentUrl === "string" && paymentUrl ? { paymentUrl } : null;
  } catch {
    return null;
  }
}

async function findCustomer(
  database: D1Database,
  organizationId: string,
  externalId: string,
): Promise<CustomerRow | null> {
  return database
    .prepare(
      `SELECT id, external_id, email, name, currency, metadata_json, payment_provider,
              payment_provider_code, created_at, updated_at
       FROM customers WHERE organization_id = ? AND external_id = ? LIMIT 1`,
    )
    .bind(organizationId, externalId)
    .first<CustomerRow>();
}

async function findSubscription(
  database: D1Database,
  organizationId: string,
  externalId: string,
): Promise<SubscriptionRow | null> {
  return database
    .prepare(
      `SELECT s.id, s.external_id, s.customer_id, c.external_id AS customer_external_id,
              p.code AS plan_code, p.amount_minor AS plan_amount_minor,
              p.currency AS plan_currency, p.interval AS plan_interval,
              s.name, s.request_sha256,
              s.status, s.started_at, s.current_period_start, s.current_period_end,
              s.canceled_at, s.terminated_at, s.created_at
       FROM subscriptions s
       JOIN customers c ON c.id = s.customer_id
       JOIN plans p ON p.id = s.plan_id
       WHERE s.organization_id = ? AND s.external_id = ? LIMIT 1`,
    )
    .bind(organizationId, externalId)
    .first<SubscriptionRow>();
}

function serializeCustomer(customer: CustomerRow): Record<string, unknown> {
  const metadata = JSON.parse(customer.metadata_json) as Array<Record<string, unknown>>;
  return {
    lago_id: customer.id,
    external_id: customer.external_id,
    name: customer.name,
    email: customer.email,
    currency: customer.currency,
    created_at: customer.created_at,
    updated_at: customer.updated_at,
    billing_configuration: {
      payment_provider: customer.payment_provider,
      payment_provider_code: customer.payment_provider_code,
    },
    metadata,
  };
}

function serializeSubscription(subscription: SubscriptionRow): Record<string, unknown> {
  return {
    lago_id: subscription.id,
    external_id: subscription.external_id,
    lago_customer_id: subscription.customer_id,
    external_customer_id: subscription.customer_external_id,
    name: subscription.name,
    plan_code: subscription.plan_code,
    plan_amount_cents: subscription.plan_amount_minor,
    plan_amount_currency: subscription.plan_currency,
    status: subscription.status,
    billing_time: "anniversary",
    subscription_at: subscription.started_at,
    started_at: subscription.started_at,
    terminated_at: subscription.terminated_at,
    canceled_at: subscription.canceled_at,
    created_at: subscription.created_at,
    current_billing_period_started_at: subscription.current_period_start,
    current_billing_period_ending_at: subscription.current_period_end,
    payment_method: { payment_method_id: null, payment_method_type: null },
  };
}

function serializeInvoice(invoice: InvoiceRow): Record<string, unknown> {
  return {
    lago_id: invoice.id,
    number: invoice.number,
    issuing_date: invoice.finalized_at?.slice(0, 10) ?? null,
    payment_due_date: null,
    invoice_type: "subscription",
    status: invoice.status,
    payment_status: invoice.payment_status,
    currency: invoice.currency,
    fees_amount_cents: invoice.subtotal_minor,
    taxes_amount_cents: invoice.tax_minor,
    coupons_amount_cents: invoice.coupons_minor,
    credit_notes_amount_cents: invoice.credit_notes_minor,
    prepaid_credit_amount_cents: invoice.prepaid_credit_minor,
    prepaid_granted_credit_amount_cents: invoice.prepaid_credit_minor,
    prepaid_purchased_credit_amount_cents: 0,
    sub_total_excluding_taxes_amount_cents: invoice.subtotal_minor,
    sub_total_including_taxes_amount_cents: invoice.subtotal_minor + invoice.tax_minor,
    total_amount_cents: invoice.total_due_minor,
    total_due_amount_cents: invoice.total_due_minor,
    total_paid_amount_cents: invoice.payment_status === "succeeded" ? invoice.total_due_minor : 0,
    version_number: invoice.version,
    created_at: invoice.created_at,
    updated_at: invoice.updated_at,
    voided_at: invoice.voided_at,
    customer: {
      lago_id: invoice.customer_id,
      external_id: invoice.customer_external_id,
      billing_configuration: {
        payment_provider: invoice.payment_provider,
        payment_provider_code: invoice.payment_provider_code,
      },
    },
  };
}

function readOptionalObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function normalizeMetadata(
  value: unknown,
): Array<{ key: string; value: string; display_in_invoice: boolean }> {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return [];
    const object = entry as Record<string, unknown>;
    if (typeof object.key !== "string" || typeof object.value !== "string") return [];
    return [
      {
        key: object.key,
        value: object.value,
        display_in_invoice: object.display_in_invoice === true,
      },
    ];
  });
}

function normalizeEmail(email: string | null): string | null {
  return email?.trim().toLowerCase() || null;
}

function positiveInteger(value: string | null, fallback: number): number {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function totalCount(value: { total: number } | null): number {
  return value?.total ?? 0;
}

function pagination(total: number, page: number, perPage: number): Record<string, number | null> {
  const totalPages = total === 0 ? 0 : Math.ceil(total / perPage);
  return {
    current_page: total === 0 ? 0 : page,
    next_page: page < totalPages ? page + 1 : null,
    prev_page: page > 1 && page <= totalPages ? page - 1 : null,
    total_pages: totalPages,
    total_count: total,
  };
}

function escapeLike(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_");
}

function assertSubscriptionReplay(
  subscription: SubscriptionRow,
  input: { externalCustomerId: string; name: string | null; planCode: string; requestHash: string },
): void {
  const matchesLegacyFields =
    subscription.customer_external_id === input.externalCustomerId &&
    subscription.plan_code === input.planCode &&
    subscription.name === input.name;
  if (
    (subscription.request_sha256 && subscription.request_sha256 !== input.requestHash) ||
    !matchesLegacyFields
  ) {
    throw new ApiError(
      409,
      "subscription_idempotency_conflict",
      "Subscription external_id was reused with different attributes",
    );
  }
}
