import type { AuthContext } from "../auth/api-key";
import { sha256Hex } from "../auth/api-key";
import { ApiError, json, objectAt, optionalString, parseJsonObject, requiredString } from "../http";
import { deterministicUuid } from "../identifiers";
import { stableJson } from "../json";
import type { DomainEvent } from "../domain-events";
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
import { handleTaxLedgerRequest } from "./tax-ledger";
import { Decimal } from "../rating/decimal";
import { handleWebhookEndpointRequest } from "./webhook-endpoints";
import { handleAddOnLedgerRequest } from "./add-on-ledger";
import { handlePaymentLedgerRequest } from "./payment-ledger";
import {
  calculateManualTaxes,
  manualTaxStatements,
  totalManualTaxMinor,
} from "../billing/manual-taxes";
import { paymentDueDate } from "../billing/payment-terms";
import { finalizeInvoice } from "../billing/finalize-invoice";
import { refreshSubscriptionDraft } from "../billing/refresh-draft-invoice";

type CustomerRow = {
  id: string;
  external_id: string;
  email: string | null;
  name: string | null;
  currency: string | null;
  metadata_json: string;
  payment_provider: string | null;
  payment_provider_code: string | null;
  net_payment_term: number | null;
  invoice_grace_period: number | null;
  version: number;
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
  total_paid_minor: number;
  net_payment_term: number;
  payment_due_date: string | null;
  payment_overdue: number;
  issuing_date: string | null;
  expected_finalization_date: string | null;
  invoice_type: "subscription" | "one_off";
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

  const planResponse = await handlePlanCatalogRequest(request, env, auth, requestId);
  if (planResponse) return planResponse;

  const addOnResponse = await handleAddOnLedgerRequest(request, env, auth, requestId);
  if (addOnResponse) return addOnResponse;

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

  const taxResponse = await handleTaxLedgerRequest(request, env, auth, requestId);
  if (taxResponse) return taxResponse;

  const webhookEndpointResponse = await handleWebhookEndpointRequest(request, env, auth, requestId);
  if (webhookEndpointResponse) return webhookEndpointResponse;

  const paymentResponse = await handlePaymentLedgerRequest(request, env, auth, requestId);
  if (paymentResponse) return paymentResponse;

  if (request.method === "POST" && url.pathname === "/api/v1/customers") {
    return upsertCustomer(request, null, env, auth, requestId);
  }

  if (request.method === "GET" && url.pathname === "/api/v1/customers") {
    return listCustomers(url, env.BILLING_DB, auth, requestId);
  }

  const customerMatch = url.pathname.match(/^\/api\/v1\/customers\/([^/]+)$/);
  if (request.method === "GET" && customerMatch?.[1]) {
    return showCustomer(decodeURIComponent(customerMatch[1]), env.BILLING_DB, auth, requestId);
  }
  if (request.method === "DELETE" && customerMatch?.[1]) {
    throw new ApiError(
      422,
      "unsupported_customer_deletion",
      "Customer deletion is not implemented until anonymization and dependency cleanup are ported",
    );
  }

  if (request.method === "POST" && url.pathname === "/api/v1/subscriptions") {
    return createSubscription(request, env, auth, requestId);
  }

  if (request.method === "POST" && url.pathname === "/api/v1/invoices") {
    return createOneOffInvoice(request, env, auth, requestId);
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

  const invoiceFinalizeMatch = url.pathname.match(/^\/api\/v1\/invoices\/([^/]+)\/finalize$/);
  if (request.method === "PUT" && invoiceFinalizeMatch?.[1]) {
    return finalizeDraftInvoice(decodeURIComponent(invoiceFinalizeMatch[1]), env, auth, requestId);
  }

  const invoiceRefreshMatch = url.pathname.match(/^\/api\/v1\/invoices\/([^/]+)\/refresh$/);
  if (request.method === "PUT" && invoiceRefreshMatch?.[1]) {
    return refreshDraftInvoice(decodeURIComponent(invoiceRefreshMatch[1]), env, auth, requestId);
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
  pathExternalId: string | null,
  env: Env,
  auth: AuthContext,
  requestId: string,
): Promise<Response> {
  const database = env.BILLING_DB;
  const body = await parseJsonObject(request);
  const input = objectAt(body, "customer");
  rejectUnsupportedTaxTarget(input, "customer");
  rejectUnsupportedCustomerFields(input);
  const bodyExternalId =
    input.external_id === undefined ? null : requiredString(input, "external_id");
  const externalId = pathExternalId ?? bodyExternalId;
  if (!externalId) throw new ApiError(422, "validation_error", "external_id is required");
  if (pathExternalId && bodyExternalId && pathExternalId !== bodyExternalId)
    throw new ApiError(
      422,
      "customer_external_id_mismatch",
      "Customer external_id must match the request path",
    );
  const existing = await findCustomer(database, auth.organizationId, externalId);
  const billingConfiguration = readCustomerBillingConfiguration(input.billing_configuration);
  const normalized = {
    name: input.name === undefined ? (existing?.name ?? null) : optionalString(input, "name"),
    email:
      input.email === undefined
        ? (existing?.email ?? null)
        : normalizeEmail(optionalString(input, "email")),
    currency:
      input.currency === undefined
        ? (existing?.currency ?? null)
        : (optionalString(input, "currency")?.toUpperCase() ?? existing?.currency ?? null),
    metadata:
      input.metadata === undefined
        ? parseCustomerMetadata(existing?.metadata_json)
        : normalizeMetadata(input.metadata),
    paymentProvider:
      billingConfiguration === null
        ? (existing?.payment_provider ?? null)
        : optionalString(billingConfiguration, "payment_provider"),
    paymentProviderCode:
      billingConfiguration === null
        ? (existing?.payment_provider_code ?? null)
        : optionalString(billingConfiguration, "payment_provider_code"),
    netPaymentTerm:
      input.net_payment_term === undefined
        ? (existing?.net_payment_term ?? null)
        : input.net_payment_term === null
          ? null
          : nonNegativeInteger(input.net_payment_term, "net_payment_term"),
    invoiceGracePeriod: (() => {
      const value =
        billingConfiguration && "invoice_grace_period" in billingConfiguration
          ? billingConfiguration.invoice_grace_period
          : input.invoice_grace_period;
      return value === undefined
        ? (existing?.invoice_grace_period ?? null)
        : value === null
          ? null
          : nonNegativeInteger(value, "billing_configuration.invoice_grace_period");
    })(),
  };
  validateCustomerProvider(normalized.paymentProvider, normalized.paymentProviderCode);

  if (existing) {
    if (customerMatches(existing, normalized))
      return json({ customer: serializeCustomer(existing) }, { requestId });
    return updateCustomer(existing, normalized, env, auth, requestId);
  }

  const now = new Date().toISOString();
  const id = await deterministicUuid("customer", `${auth.organizationId}:${externalId}`);
  const event = customerEvent(
    "customer.created",
    id,
    externalId,
    1,
    normalized,
    auth.organizationId,
    requestId,
    now,
  );
  try {
    await database.batch([
      database
        .prepare(
          `INSERT INTO customers
           (id, organization_id, external_id, email, name, currency, metadata_json,
            payment_provider, payment_provider_code, net_payment_term, invoice_grace_period,
            version, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
        )
        .bind(
          id,
          auth.organizationId,
          externalId,
          normalized.email,
          normalized.name,
          normalized.currency,
          stableJson(normalized.metadata),
          normalized.paymentProvider,
          normalized.paymentProviderCode,
          normalized.netPaymentTerm,
          normalized.invoiceGracePeriod,
          now,
          now,
        ),
      customerOutboxStatement(database, auth.organizationId, event),
    ]);
  } catch (error) {
    const concurrent = await findCustomer(database, auth.organizationId, externalId);
    if (concurrent && customerMatches(concurrent, normalized))
      return json({ customer: serializeCustomer(concurrent) }, { requestId });
    if (!concurrent) throw error;
    throw new ApiError(409, "customer_version_conflict", "Customer changed concurrently");
  }

  const customer = await findCustomer(database, auth.organizationId, externalId);
  if (!customer) throw new ApiError(500, "persistence_error", "Customer was not persisted");
  await env.DOMAIN_EVENTS.send(event);
  return json({ customer: serializeCustomer(customer) }, { requestId });
}

type NormalizedCustomer = {
  name: string | null;
  email: string | null;
  currency: string | null;
  metadata: Array<{ key: string; value: string; display_in_invoice: boolean }>;
  paymentProvider: string | null;
  paymentProviderCode: string | null;
  netPaymentTerm: number | null;
  invoiceGracePeriod: number | null;
};

async function updateCustomer(
  customer: CustomerRow,
  normalized: NormalizedCustomer,
  env: Env,
  auth: AuthContext,
  requestId: string,
): Promise<Response> {
  const now = new Date().toISOString();
  const nextVersion = customer.version + 1;
  const event = customerEvent(
    "customer.updated",
    customer.id,
    customer.external_id,
    nextVersion,
    normalized,
    auth.organizationId,
    requestId,
    now,
  );
  const results = await env.BILLING_DB.batch([
    env.BILLING_DB.prepare(
      `UPDATE customers
       SET email = ?, name = ?, currency = ?, metadata_json = ?, payment_provider = ?,
           payment_provider_code = ?, net_payment_term = ?, invoice_grace_period = ?,
           version = version + 1, updated_at = ?
       WHERE id = ? AND organization_id = ? AND version = ?`,
    ).bind(
      normalized.email,
      normalized.name,
      normalized.currency,
      stableJson(normalized.metadata),
      normalized.paymentProvider,
      normalized.paymentProviderCode,
      normalized.netPaymentTerm,
      normalized.invoiceGracePeriod,
      now,
      customer.id,
      auth.organizationId,
      customer.version,
    ),
    env.BILLING_DB.prepare(
      `INSERT INTO outbox_events
       (event_id, organization_id, event_type, event_version, aggregate_type,
        aggregate_id, aggregate_version, causation_id, correlation_id, payload_json,
        occurred_at, published_at)
       SELECT ?, ?, ?, 1, 'customer', ?, ?, ?, ?, ?, ?, NULL
       FROM customers WHERE id = ? AND organization_id = ? AND version = ? AND updated_at = ?`,
    ).bind(
      event.id,
      auth.organizationId,
      event.type,
      customer.id,
      nextVersion,
      requestId,
      requestId,
      stableJson(event.payload),
      now,
      customer.id,
      auth.organizationId,
      nextVersion,
      now,
    ),
    env.BILLING_DB.prepare(
      `UPDATE invoices
       SET applied_grace_period = COALESCE(
             (SELECT invoice_grace_period FROM customers WHERE id = ?),
             (SELECT invoice_grace_period FROM organizations WHERE id = ?), 0
           ),
           expected_finalization_date = date(
             (SELECT period_end FROM billing_cycles WHERE invoice_id = invoices.id LIMIT 1),
             printf('+%d days', COALESCE(
               (SELECT invoice_grace_period FROM customers WHERE id = ?),
               (SELECT invoice_grace_period FROM organizations WHERE id = ?), 0
             ))
           ),
           ready_to_be_refreshed = 1, updated_at = ?
       WHERE customer_id = ? AND organization_id = ? AND status = 'draft'
         AND EXISTS (SELECT 1 FROM billing_cycles WHERE invoice_id = invoices.id)
         AND EXISTS (
           SELECT 1 FROM customers
           WHERE id = ? AND organization_id = ? AND version = ? AND updated_at = ?
         )`,
    ).bind(
      customer.id,
      auth.organizationId,
      customer.id,
      auth.organizationId,
      now,
      customer.id,
      auth.organizationId,
      customer.id,
      auth.organizationId,
      nextVersion,
      now,
    ),
  ]);
  if (results[0]?.meta.changes !== 1 || results[1]?.meta.changes !== 1)
    throw new ApiError(409, "customer_version_conflict", "Customer changed concurrently");
  await env.DOMAIN_EVENTS.send(event);
  const updated = await findCustomer(env.BILLING_DB, auth.organizationId, customer.external_id);
  if (!updated) throw new ApiError(500, "persistence_error", "Customer disappeared");
  return json({ customer: serializeCustomer(updated) }, { requestId });
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
              payment_provider_code, net_payment_term, invoice_grace_period, version,
              created_at, updated_at
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
  rejectUnsupportedSubscriptionCreate(input, body);
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
  const organizationBilling = await database
    .prepare(
      "SELECT net_payment_term, invoice_grace_period FROM organizations WHERE id = ? LIMIT 1",
    )
    .bind(auth.organizationId)
    .first<{ net_payment_term: number; invoice_grace_period: number }>();
  const invoiceGracePeriod =
    customer.invoice_grace_period ?? organizationBilling?.invoice_grace_period ?? 0;
  if (invoiceGracePeriod > 0) {
    throw new ApiError(
      422,
      "unsupported_initial_invoice_grace_period",
      "Grace-period initial subscription invoices are not implemented; create with zero grace and update before renewal billing",
    );
  }

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
  const netPaymentTerm = customer.net_payment_term ?? organizationBilling?.net_payment_term ?? 0;
  const dueDate = paymentDueDate(timestamp, netPaymentTerm);
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
  const invoiceTaxes = await calculateManualTaxes(
    database,
    auth.organizationId,
    invoiceId,
    [{ id: invoiceLineId, amountMinor: plan.amount_minor }],
    couponsMinor,
  );
  const taxMinor = totalManualTaxMinor(invoiceTaxes);
  const creditNoteAllocations = await calculateCreditNoteAllocations(
    database,
    auth.organizationId,
    customer.id,
    invoiceId,
    plan.currency,
    plan.amount_minor + taxMinor - couponsMinor,
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
    plan.amount_minor + taxMinor - couponsMinor - creditNotesMinor,
  );
  const prepaidCreditMinor = walletAllocations.reduce(
    (total, allocation) => safeAddMinor(total, allocation.amountMinor),
    0,
  );
  const creditsMinor = safeAddMinor(
    safeAddMinor(couponsMinor, creditNotesMinor),
    prepaidCreditMinor,
  );
  const totalDueMinor = plan.amount_minor + taxMinor - creditsMinor;
  const subscriptionEvent = {
    id: `subscription-created:${subscriptionId}:v1`,
    type: "subscription.created",
    aggregateType: "subscription",
    aggregateId: subscriptionId,
    payload: {
      organizationId: auth.organizationId,
      subscriptionId,
      externalSubscriptionId: externalId,
      externalCustomerId,
      planCode,
      startedAt: timestamp,
    },
  };
  const invoiceEvent = {
    id: `invoice-finalized:${invoiceId}:v1`,
    type: "invoice.finalized",
    aggregateType: "invoice",
    aggregateId: invoiceId,
    payload: {
      organizationId: auth.organizationId,
      subscriptionId,
      billingCycleId: null,
      couponsMinor,
      taxMinor,
      creditNotesMinor,
      prepaidCreditMinor,
      totalDueMinor,
      currency: plan.currency,
      periodStart: timestamp,
      periodEnd,
    },
  };

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
          finalized_at, issuing_date, created_at, updated_at, coupons_minor, prepaid_credit_minor,
          credit_notes_minor, net_payment_term, payment_due_date, payment_overdue)
         VALUES (?, ?, ?, ?, ?, 'finalized', 'pending', ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`,
        )
        .bind(
          invoiceId,
          auth.organizationId,
          customer.id,
          subscriptionId,
          invoiceNumber,
          plan.currency,
          plan.amount_minor,
          taxMinor,
          creditsMinor,
          totalDueMinor,
          timestamp,
          timestamp.slice(0, 10),
          timestamp,
          timestamp,
          couponsMinor,
          prepaidCreditMinor,
          creditNotesMinor,
          netPaymentTerm,
          dueDate,
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
    statements.push(
      ...manualTaxStatements(
        database,
        auth.organizationId,
        invoiceId,
        plan.currency,
        invoiceTaxes,
        timestamp,
      ),
    );
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
    for (const event of [subscriptionEvent, invoiceEvent]) {
      statements.push(
        database
          .prepare(
            `INSERT INTO outbox_events
             (event_id, organization_id, event_type, event_version, aggregate_type,
              aggregate_id, aggregate_version, causation_id, correlation_id, payload_json,
              occurred_at, published_at)
             VALUES (?, ?, ?, 1, ?, ?, 1, ?, ?, ?, ?, NULL)`,
          )
          .bind(
            event.id,
            auth.organizationId,
            event.type,
            event.aggregateType,
            event.aggregateId,
            requestId,
            requestId,
            stableJson(event.payload),
            timestamp,
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
  await Promise.all([
    env.DOMAIN_EVENTS.send({
      ...subscriptionEvent,
      version: 1,
      aggregateVersion: 1,
      occurredAt: timestamp,
      causationId: requestId,
      correlationId: requestId,
    }),
    env.DOMAIN_EVENTS.send({
      ...invoiceEvent,
      version: 1,
      aggregateVersion: 1,
      occurredAt: timestamp,
      causationId: requestId,
      correlationId: requestId,
    }),
  ]);
  return json({ subscription: serializeSubscription(subscription) }, { requestId });
}

function rejectUnsupportedSubscriptionCreate(
  input: Record<string, unknown>,
  body: Record<string, unknown>,
): void {
  for (const field of [
    "billing_entity_code",
    "billing_entity_id",
    "billing_time",
    "subscription_at",
    "ending_at",
    "progressive_billing_disabled",
    "invoice_custom_section",
    "activation_rules",
    "payment_method",
    "usage_thresholds",
    "plan_overrides",
  ]) {
    if (input[field] === undefined || input[field] === null) continue;
    throw new ApiError(
      422,
      "unsupported_subscription_feature",
      `${field} is not implemented by the Cloudflare subscription lifecycle`,
    );
  }
  if (body.authorization !== undefined)
    throw new ApiError(
      422,
      "unsupported_subscription_feature",
      "Payment authorization during subscription creation is not implemented",
    );
}

function safeAddMinor(left: number, right: number): number {
  const total = left + right;
  if (!Number.isSafeInteger(total) || total < 0) {
    throw new ApiError(422, "invalid_minor_amount", "Coupon amount exceeds supported precision");
  }
  return total;
}

function rejectUnsupportedTaxTarget(input: Record<string, unknown>, target: string) {
  if (Array.isArray(input.tax_codes) && input.tax_codes.length > 0)
    throw new ApiError(
      422,
      "unsupported_tax_target",
      `${target} tax targeting is not implemented; use organization-default taxes`,
    );
  if (input.tax_provider_code !== undefined)
    throw new ApiError(
      422,
      "unsupported_tax_provider",
      "External tax provider configuration is not implemented",
    );
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
              i.payment_status, i.invoice_type, i.currency, i.subtotal_minor, i.tax_minor,
              i.credits_minor, i.coupons_minor, i.credit_notes_minor, i.prepaid_credit_minor,
              i.total_due_minor,
              COALESCE((SELECT SUM(p.amount_minor) FROM payment_attempts p
                        WHERE p.invoice_id = i.id AND p.status = 'succeeded'), 0) AS total_paid_minor,
              i.net_payment_term, i.payment_due_date, i.payment_overdue,
              i.issuing_date, i.expected_finalization_date,
              i.version, i.finalized_at,
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
        applied_taxes: await serializeInvoiceTaxes(database, invoice),
      },
    },
    { requestId },
  );
}

async function createOneOffInvoice(
  request: Request,
  env: Env,
  auth: AuthContext,
  requestId: string,
): Promise<Response> {
  const input = objectAt(await parseJsonObject(request), "invoice");
  const supported = new Set(["external_customer_id", "currency", "skip_psp", "fees"]);
  const unsupported = Object.keys(input).find((key) => !supported.has(key));
  if (unsupported)
    throw new ApiError(
      422,
      "unsupported_one_off_invoice_feature",
      `${unsupported} is not implemented by the Cloudflare one-off invoice ledger`,
    );
  if (input.skip_psp !== true)
    throw new ApiError(
      422,
      "automatic_payment_not_supported",
      "One-off invoices require skip_psp=true until automatic payment workflow dispatch is ported",
    );
  const externalCustomerId = requiredString(input, "external_customer_id");
  const customer = await findCustomer(env.BILLING_DB, auth.organizationId, externalCustomerId);
  if (!customer) throw new ApiError(404, "customer_not_found", "Customer was not found");
  const requestedCurrency = optionalString(input, "currency")?.toUpperCase() ?? customer.currency;
  if (!requestedCurrency)
    throw new ApiError(422, "currency_required", "Customer or invoice currency is required");
  if (customer.currency !== requestedCurrency)
    throw new ApiError(
      422,
      "currency_mismatch",
      "Invoice currency must match the configured customer currency",
    );
  if (!Array.isArray(input.fees) || input.fees.length === 0)
    throw new ApiError(422, "validation_error", "fees must be a non-empty array");
  if (input.fees.length > 100)
    throw new ApiError(422, "validation_error", "fees cannot contain more than 100 entries");

  const normalizedFees = await Promise.all(
    input.fees.map(async (value, index) => {
      if (!value || typeof value !== "object" || Array.isArray(value))
        throw new ApiError(422, "validation_error", `fees[${index}] must be an object`);
      const fee = value as Record<string, unknown>;
      const allowed = new Set([
        "add_on_code",
        "invoice_display_name",
        "unit_amount_cents",
        "units",
        "description",
        "tax_codes",
      ]);
      const unsupportedFee = Object.keys(fee).find((key) => !allowed.has(key));
      if (unsupportedFee)
        throw new ApiError(
          422,
          "unsupported_one_off_invoice_feature",
          `fees[${index}].${unsupportedFee} is not implemented`,
        );
      if (fee.tax_codes !== undefined) {
        if (!Array.isArray(fee.tax_codes))
          throw new ApiError(422, "validation_error", `fees[${index}].tax_codes must be an array`);
        if (fee.tax_codes.length > 0)
          throw new ApiError(
            422,
            "unsupported_tax_target",
            "One-off fee tax targeting is not implemented; use organization-default taxes",
          );
      }
      const code = requiredString(fee, "add_on_code");
      const addOn = await env.BILLING_DB.prepare(
        `SELECT id, code, name, invoice_display_name, description, amount_minor, currency
         FROM add_ons WHERE organization_id = ? AND code = ? AND status = 'active' LIMIT 1`,
      )
        .bind(auth.organizationId, code)
        .first<{
          id: string;
          code: string;
          name: string;
          invoice_display_name: string | null;
          description: string | null;
          amount_minor: number;
          currency: string;
        }>();
      if (!addOn) throw new ApiError(404, "add_on_not_found", `Add-on ${code} was not found`);
      if (addOn.currency !== requestedCurrency)
        throw new ApiError(422, "currency_mismatch", `Add-on ${code} currency does not match`);
      const unitAmountMinor =
        fee.unit_amount_cents === undefined
          ? addOn.amount_minor
          : nonNegativeInteger(fee.unit_amount_cents, `fees[${index}].unit_amount_cents`);
      const units = positiveDecimal(fee.units ?? 1, `fees[${index}].units`);
      const precise = Decimal.parse(unitAmountMinor).multiply(Decimal.parse(units));
      const rounded = Number(precise.round());
      if (!Number.isSafeInteger(rounded) || rounded < 0)
        throw new ApiError(422, "invalid_minor_amount", `fees[${index}] amount is invalid`);
      return {
        addOn,
        description: optionalString(fee, "description") ?? addOn.description ?? addOn.name,
        invoiceDisplayName:
          optionalString(fee, "invoice_display_name") ?? addOn.invoice_display_name ?? addOn.name,
        precise: precise.toString(),
        rounded,
        unitAmountMinor,
        units,
      };
    }),
  );
  const normalized = {
    currency: requestedCurrency,
    externalCustomerId,
    fees: normalizedFees.map((fee) => ({
      addOnCode: fee.addOn.code,
      description: fee.description,
      invoiceDisplayName: fee.invoiceDisplayName,
      precise: fee.precise,
      unitAmountMinor: fee.unitAmountMinor,
      units: fee.units,
    })),
    skipPsp: true,
  };
  const requestHash = await sha256Hex(stableJson(normalized));
  const replay = await env.BILLING_DB.prepare(
    `SELECT id FROM invoices WHERE organization_id = ? AND invoice_type = 'one_off'
     AND request_sha256 = ? LIMIT 1`,
  )
    .bind(auth.organizationId, requestHash)
    .first<{ id: string }>();
  if (replay) return showInvoice(replay.id, env.BILLING_DB, auth, requestId);

  const invoiceId = await deterministicUuid(
    "one-off-invoice",
    `${auth.organizationId}:${requestHash}`,
  );
  const now = new Date().toISOString();
  const netPaymentTerm = customer.net_payment_term ?? 0;
  const dueDate = paymentDueDate(now, netPaymentTerm);
  const lines = await Promise.all(
    normalizedFees.map(async (fee, index) => ({
      ...fee,
      id: await deterministicUuid("one-off-invoice-line", `${invoiceId}:${index}`),
    })),
  );
  const subtotalMinor = lines.reduce((sum, line) => safeAddMinor(sum, line.rounded), 0);
  const invoiceTaxes = await calculateManualTaxes(
    env.BILLING_DB,
    auth.organizationId,
    invoiceId,
    lines.map((line) => ({ id: line.id, amountMinor: line.rounded })),
    0,
  );
  const taxMinor = totalManualTaxMinor(invoiceTaxes);
  const totalDueMinor = safeAddMinor(subtotalMinor, taxMinor);
  const paymentStatus = totalDueMinor === 0 ? "succeeded" : "pending";
  const eventId = `invoice-one-off-created:${invoiceId}:v1`;
  const eventPayload = {
    organizationId: auth.organizationId,
    invoiceId,
    customerId: customer.id,
    externalCustomerId,
    currency: requestedCurrency,
    subtotalMinor,
    taxMinor,
    totalDueMinor,
  };
  const statements: D1PreparedStatement[] = [
    env.BILLING_DB.prepare(
      `INSERT INTO invoices
       (id, organization_id, customer_id, subscription_id, number, status, payment_status,
        currency, subtotal_minor, tax_minor, credits_minor, total_due_minor, version,
        finalized_at, issuing_date, created_at, updated_at, invoice_type, request_sha256,
        net_payment_term, payment_due_date, payment_overdue)
       VALUES (?, ?, ?, NULL, ?, 'finalized', ?, ?, ?, ?, 0, ?, 1, ?, ?, ?, ?, 'one_off', ?, ?, ?, 0)`,
    ).bind(
      invoiceId,
      auth.organizationId,
      customer.id,
      `INV-${invoiceId.slice(0, 8).toUpperCase()}`,
      paymentStatus,
      requestedCurrency,
      subtotalMinor,
      taxMinor,
      totalDueMinor,
      now,
      now.slice(0, 10),
      now,
      now,
      requestHash,
      netPaymentTerm,
      dueDate,
    ),
    ...lines.map((line, index) =>
      env.BILLING_DB.prepare(
        `INSERT INTO invoice_lines
         (id, invoice_id, line_type, description, quantity_decimal, unit_amount_decimal,
          amount_minor, source_type, source_id, metadata_json, created_at, precise_amount_minor,
          display_order)
         VALUES (?, ?, 'add_on', ?, ?, ?, ?, 'add_on', ?, ?, ?, ?, ?)`,
      ).bind(
        line.id,
        invoiceId,
        line.description,
        line.units,
        String(line.unitAmountMinor),
        line.rounded,
        line.addOn.id,
        stableJson({
          code: line.addOn.code,
          invoiceDisplayName: line.invoiceDisplayName,
          name: line.addOn.name,
        }),
        now,
        line.precise,
        index,
      ),
    ),
    ...manualTaxStatements(
      env.BILLING_DB,
      auth.organizationId,
      invoiceId,
      requestedCurrency,
      invoiceTaxes,
      now,
    ),
    env.BILLING_DB.prepare(
      `INSERT INTO outbox_events
       (event_id, organization_id, event_type, event_version, aggregate_type,
        aggregate_id, aggregate_version, causation_id, correlation_id, payload_json,
        occurred_at, published_at)
       VALUES (?, ?, 'invoice.one_off_created', 1, 'invoice', ?, 1, ?, ?, ?, ?, NULL)`,
    ).bind(
      eventId,
      auth.organizationId,
      invoiceId,
      requestId,
      requestId,
      stableJson(eventPayload),
      now,
    ),
  ];
  try {
    await env.BILLING_DB.batch(statements);
  } catch (error) {
    const concurrent = await env.BILLING_DB.prepare(
      `SELECT id FROM invoices WHERE organization_id = ? AND invoice_type = 'one_off'
       AND request_sha256 = ? LIMIT 1`,
    )
      .bind(auth.organizationId, requestHash)
      .first<{ id: string }>();
    if (concurrent) return showInvoice(concurrent.id, env.BILLING_DB, auth, requestId);
    throw error;
  }
  await env.DOMAIN_EVENTS.send({
    id: eventId,
    type: "invoice.one_off_created",
    version: 1,
    aggregateType: "invoice",
    aggregateId: invoiceId,
    aggregateVersion: 1,
    occurredAt: now,
    causationId: requestId,
    correlationId: requestId,
    payload: eventPayload,
  });
  return showInvoice(invoiceId, env.BILLING_DB, auth, requestId);
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

async function finalizeDraftInvoice(
  invoiceId: string,
  env: Env,
  auth: AuthContext,
  requestId: string,
): Promise<Response> {
  const invoice = await findInvoice(env.BILLING_DB, auth.organizationId, invoiceId);
  if (!invoice) throw new ApiError(404, "invoice_not_found", "Invoice was not found");
  if (invoice.status === "finalized") {
    return showInvoice(invoice.id, env.BILLING_DB, auth, requestId);
  }
  if (invoice.status !== "draft") {
    throw new ApiError(422, "invoice_not_draft", "Only draft invoices can be finalized");
  }
  try {
    await finalizeInvoice(
      env,
      invoice.id,
      auth.organizationId,
      new Date().toISOString(),
      requestId,
    );
  } catch (error) {
    if (error instanceof Error && error.message === "invoice_version_conflict") {
      throw new ApiError(409, "invoice_version_conflict", "Invoice changed concurrently");
    }
    if (error instanceof Error && error.message === "invoice_refresh_in_progress") {
      throw new ApiError(409, "invoice_refresh_in_progress", "Invoice refresh is in progress");
    }
    throw error;
  }
  return showInvoice(invoice.id, env.BILLING_DB, auth, requestId);
}

async function refreshDraftInvoice(
  invoiceId: string,
  env: Env,
  auth: AuthContext,
  requestId: string,
): Promise<Response> {
  const invoice = await findInvoice(env.BILLING_DB, auth.organizationId, invoiceId);
  if (!invoice) throw new ApiError(404, "invoice_not_found", "Invoice was not found");
  if (invoice.status !== "draft") {
    throw new ApiError(422, "invoice_not_draft", "Only draft invoices can be refreshed");
  }
  try {
    await refreshSubscriptionDraft(
      env,
      invoice.id,
      auth.organizationId,
      new Date().toISOString(),
      requestId,
      false,
    );
  } catch (error) {
    if (error instanceof Error && error.message === "invoice_version_conflict") {
      throw new ApiError(409, "invoice_version_conflict", "Invoice changed concurrently");
    }
    if (error instanceof Error && error.message === "invoice_refresh_in_progress") {
      throw new ApiError(409, "invoice_refresh_in_progress", "Invoice refresh is in progress");
    }
    if (error instanceof Error && error.message === "draft_subscription_not_found") {
      throw new ApiError(
        422,
        "draft_subscription_not_found",
        "Draft invoice no longer has an active billable subscription",
      );
    }
    throw error;
  }
  return showInvoice(invoice.id, env.BILLING_DB, auth, requestId);
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
              i.number, i.status, i.payment_status, i.invoice_type, i.currency, i.subtotal_minor,
              i.tax_minor, i.credits_minor, i.coupons_minor, i.credit_notes_minor, i.prepaid_credit_minor,
              i.total_due_minor,
              COALESCE((SELECT SUM(p.amount_minor) FROM payment_attempts p
                        WHERE p.invoice_id = i.id AND p.status = 'succeeded'), 0) AS total_paid_minor,
              i.net_payment_term, i.payment_due_date, i.payment_overdue,
              i.issuing_date, i.expected_finalization_date, i.version,
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
              amount_minor, source_type, source_id, metadata_json, precise_amount_minor, created_at
       FROM invoice_lines WHERE invoice_id = ? ORDER BY display_order, created_at, id`,
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
      metadata_json: string;
      precise_amount_minor: string | null;
      created_at: string;
    }>();
  return Promise.all(
    result.results.map(async (line) => {
      const appliedTaxes = await serializeInvoiceLineTaxes(database, line.id);
      const metadata = parseObjectJson(line.metadata_json);
      return {
        lago_id: line.id,
        lago_invoice_id: invoice.id,
        lago_charge_id: line.source_type === "charge" ? line.source_id : null,
        lago_subscription_id: null,
        item: {
          type: line.line_type,
          code: typeof metadata.code === "string" ? metadata.code : line.source_id,
          name: typeof metadata.name === "string" ? metadata.name : line.description,
          description: line.description,
          invoice_display_name:
            typeof metadata.invoiceDisplayName === "string"
              ? metadata.invoiceDisplayName
              : line.description,
          lago_item_id: line.source_id,
          item_type: line.source_type,
        },
        pay_in_advance: false,
        invoiceable: true,
        amount_cents: line.amount_minor,
        amount_currency: invoice.currency,
        precise_amount_cents: line.precise_amount_minor ?? String(line.amount_minor),
        taxes_amount_cents: totalSnapshotTaxMinor(appliedTaxes),
        unit_amount_cents: line.unit_amount_decimal,
        units: line.quantity_decimal,
        description: line.description,
        payment_status: invoice.payment_status,
        applied_taxes: appliedTaxes,
        created_at: line.created_at,
      };
    }),
  );
}

async function serializeInvoiceLineTaxes(database: D1Database, invoiceLineId: string) {
  const result = await database
    .prepare(
      `SELECT id, tax_id, tax_name, tax_code, tax_description, tax_rate,
              amount_minor, precise_amount_minor, taxable_base_minor, currency, created_at
       FROM invoice_line_taxes WHERE invoice_line_id = ? ORDER BY created_at, id`,
    )
    .bind(invoiceLineId)
    .all<{
      id: string;
      tax_id: string;
      tax_name: string;
      tax_code: string;
      tax_description: string | null;
      tax_rate: string;
      amount_minor: number;
      precise_amount_minor: string;
      taxable_base_minor: number;
      currency: string;
      created_at: string;
    }>();
  return result.results.map(serializeAppliedTax);
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

async function serializeInvoiceTaxes(database: D1Database, invoice: InvoiceRow) {
  const result = await database
    .prepare(
      `SELECT id, tax_id, tax_name, tax_code, tax_description, tax_rate,
              amount_minor, precise_amount_minor, taxable_base_minor, currency, created_at
       FROM invoice_taxes WHERE invoice_id = ? ORDER BY created_at, id`,
    )
    .bind(invoice.id)
    .all<{
      id: string;
      tax_id: string;
      tax_name: string;
      tax_code: string;
      tax_description: string | null;
      tax_rate: string;
      amount_minor: number;
      precise_amount_minor: string;
      taxable_base_minor: number;
      currency: string;
      created_at: string;
    }>();
  return result.results.map(serializeAppliedTax);
}

function serializeAppliedTax(tax: {
  id: string;
  tax_id: string;
  tax_name: string;
  tax_code: string;
  tax_description: string | null;
  tax_rate: string;
  amount_minor: number;
  precise_amount_minor: string;
  taxable_base_minor: number;
  currency: string;
  created_at: string;
}) {
  return {
    lago_id: tax.id,
    lago_tax_id: tax.tax_id,
    tax_name: tax.tax_name,
    tax_code: tax.tax_code,
    tax_description: tax.tax_description,
    tax_rate: Number(tax.tax_rate),
    amount_cents: tax.amount_minor,
    precise_amount_cents: tax.precise_amount_minor,
    taxable_base_amount_cents: tax.taxable_base_minor,
    amount_currency: tax.currency,
    created_at: tax.created_at,
  };
}

function totalSnapshotTaxMinor(taxes: Array<{ precise_amount_cents: string }>) {
  const precise = taxes.reduce(
    (sum, tax) => sum.add(Decimal.parse(tax.precise_amount_cents)),
    Decimal.zero(),
  );
  const rounded = Number(precise.round());
  if (!Number.isSafeInteger(rounded) || rounded < 0) throw new Error("invalid_tax_amount");
  return rounded;
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
            i.payment_status, i.invoice_type, i.currency, i.subtotal_minor, i.tax_minor,
            i.credits_minor, i.coupons_minor, i.credit_notes_minor, i.prepaid_credit_minor,
            i.total_due_minor,
            COALESCE((SELECT SUM(p.amount_minor) FROM payment_attempts p
                      WHERE p.invoice_id = i.id AND p.status = 'succeeded'), 0) AS total_paid_minor,
            i.net_payment_term, i.payment_due_date, i.payment_overdue,
            i.issuing_date, i.expected_finalization_date,
            i.version, i.finalized_at,
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
  const outstandingMinor = invoice.total_due_minor - invoice.total_paid_minor;
  if (outstandingMinor <= 0) {
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
        amountMinor: outstandingMinor,
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
        amountMinor: outstandingMinor,
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
              payment_provider_code, net_payment_term, invoice_grace_period, version,
              created_at, updated_at
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
  const metadata = parseCustomerMetadata(customer.metadata_json);
  return {
    lago_id: customer.id,
    external_id: customer.external_id,
    name: customer.name,
    email: customer.email,
    currency: customer.currency,
    net_payment_term: customer.net_payment_term,
    version_number: customer.version,
    created_at: customer.created_at,
    updated_at: customer.updated_at,
    billing_configuration: {
      payment_provider: customer.payment_provider,
      payment_provider_code: customer.payment_provider_code,
      invoice_grace_period: customer.invoice_grace_period,
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
    issuing_date: invoice.issuing_date,
    expected_finalization_date: invoice.expected_finalization_date,
    payment_due_date: invoice.payment_due_date,
    payment_overdue: invoice.payment_overdue === 1,
    net_payment_term: invoice.net_payment_term,
    invoice_type: invoice.invoice_type,
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
    total_due_amount_cents: Math.max(invoice.total_due_minor - invoice.total_paid_minor, 0),
    total_paid_amount_cents: invoice.total_paid_minor,
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

function readCustomerBillingConfiguration(value: unknown): Record<string, unknown> | null {
  if (value === undefined) return null;
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new ApiError(422, "validation_error", "billing_configuration must be an object");
  const configuration = value as Record<string, unknown>;
  const supported = new Set([
    "payment_provider",
    "payment_provider_code",
    "invoice_grace_period",
    "sync",
    "sync_with_provider",
  ]);
  const unsupported = Object.keys(configuration).find((key) => !supported.has(key));
  if (unsupported)
    throw new ApiError(
      422,
      "unsupported_customer_feature",
      `billing_configuration.${unsupported} is not implemented by the Cloudflare customer ledger`,
    );
  for (const flag of ["sync", "sync_with_provider"]) {
    if (configuration[flag] !== undefined && typeof configuration[flag] !== "boolean")
      throw new ApiError(422, "validation_error", `billing_configuration.${flag} must be boolean`);
  }
  return configuration;
}

function rejectUnsupportedCustomerFields(input: Record<string, unknown>): void {
  const supported = new Set([
    "external_id",
    "name",
    "email",
    "currency",
    "metadata",
    "billing_configuration",
    "net_payment_term",
    "invoice_grace_period",
    "tax_codes",
    "tax_provider_code",
  ]);
  const unsupported = Object.keys(input).find((key) => !supported.has(key));
  if (unsupported)
    throw new ApiError(
      422,
      "unsupported_customer_feature",
      `${unsupported} is not implemented by the Cloudflare customer ledger`,
    );
}

function validateCustomerProvider(provider: string | null, code: string | null): void {
  if (provider !== null && provider !== "authorize_net")
    throw new ApiError(
      422,
      "unsupported_payment_provider",
      "Only authorize_net is implemented by the Cloudflare checkout path",
    );
  if ((provider === null) !== (code === null))
    throw new ApiError(
      422,
      "invalid_payment_provider_configuration",
      "payment_provider and payment_provider_code must be configured together",
    );
}

function customerMatches(customer: CustomerRow, normalized: NormalizedCustomer): boolean {
  return (
    customer.name === normalized.name &&
    customer.email === normalized.email &&
    customer.currency === normalized.currency &&
    customer.payment_provider === normalized.paymentProvider &&
    customer.payment_provider_code === normalized.paymentProviderCode &&
    customer.net_payment_term === normalized.netPaymentTerm &&
    customer.invoice_grace_period === normalized.invoiceGracePeriod &&
    stableJson(parseCustomerMetadata(customer.metadata_json)) === stableJson(normalized.metadata)
  );
}

function parseCustomerMetadata(
  value: string | undefined,
): Array<{ key: string; value: string; display_in_invoice: boolean }> {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed)
      ? (parsed as Array<{ key: string; value: string; display_in_invoice: boolean }>)
      : [];
  } catch {
    return [];
  }
}

function customerEvent(
  type: "customer.created" | "customer.updated",
  customerId: string,
  externalId: string,
  aggregateVersion: number,
  normalized: NormalizedCustomer,
  organizationId: string,
  requestId: string,
  occurredAt: string,
): DomainEvent {
  return {
    id: `${type.replace(".", "-")}:${customerId}:v${aggregateVersion}`,
    type,
    version: 1,
    aggregateType: "customer",
    aggregateId: customerId,
    aggregateVersion,
    occurredAt,
    causationId: requestId,
    correlationId: requestId,
    payload: {
      organizationId,
      customerId,
      externalCustomerId: externalId,
      email: normalized.email,
      name: normalized.name,
      currency: normalized.currency,
      paymentProvider: normalized.paymentProvider,
      paymentProviderCode: normalized.paymentProviderCode,
      netPaymentTerm: normalized.netPaymentTerm,
      invoiceGracePeriod: normalized.invoiceGracePeriod,
      metadata: normalized.metadata,
    },
  };
}

function customerOutboxStatement(
  database: D1Database,
  organizationId: string,
  event: DomainEvent,
): D1PreparedStatement {
  return database
    .prepare(
      `INSERT INTO outbox_events
       (event_id, organization_id, event_type, event_version, aggregate_type,
        aggregate_id, aggregate_version, causation_id, correlation_id, payload_json,
        occurred_at, published_at)
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

function normalizeMetadata(
  value: unknown,
): Array<{ key: string; value: string; display_in_invoice: boolean }> {
  if (!Array.isArray(value))
    throw new ApiError(422, "validation_error", "metadata must be an array");
  if (value.length > 20)
    throw new ApiError(422, "validation_error", "metadata cannot contain more than 20 entries");
  return value.map((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry))
      throw new ApiError(422, "validation_error", "metadata entries must be objects");
    const object = entry as Record<string, unknown>;
    if (typeof object.key !== "string" || !object.key.trim() || typeof object.value !== "string")
      throw new ApiError(
        422,
        "validation_error",
        "metadata entries require string key and value fields",
      );
    if (object.display_in_invoice !== undefined && typeof object.display_in_invoice !== "boolean")
      throw new ApiError(422, "validation_error", "display_in_invoice must be boolean");
    return {
      key: object.key,
      value: object.value,
      display_in_invoice: object.display_in_invoice === true,
    };
  });
}

function normalizeEmail(email: string | null): string | null {
  return email?.trim().toLowerCase() || null;
}

function nonNegativeInteger(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0)
    throw new ApiError(422, "validation_error", `${field} must be a non-negative integer`);
  return value as number;
}

function positiveDecimal(value: unknown, field: string): string {
  if (typeof value !== "string" && typeof value !== "number")
    throw new ApiError(422, "validation_error", `${field} must be a positive decimal`);
  try {
    const decimal = Decimal.parse(value);
    if (decimal.isNegative() || decimal.isZero()) throw new Error("not_positive");
    return decimal.toString();
  } catch {
    throw new ApiError(422, "validation_error", `${field} must be a positive decimal`);
  }
}

function parseObjectJson(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
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
