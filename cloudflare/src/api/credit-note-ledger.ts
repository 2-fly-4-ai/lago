import type { AuthContext } from "../auth/api-key";
import { sha256Hex } from "../auth/api-key";
import type { DomainEvent } from "../domain-events";
import { ApiError, json, objectAt, optionalString, parseJsonObject, requiredString } from "../http";
import { deterministicUuid } from "../identifiers";
import { stableJson } from "../json";
import type { ProviderFinancialServiceBinding } from "../provider-financial-service";
import { refundEasyPayDirectOrder } from "../providers/easy-pay-direct";
import { createStripeRefund } from "../providers/stripe";
import { Decimal } from "../rating/decimal";

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
  items_amount_minor: number;
  precise_taxes_amount_minor: string;
  refund_status: string | null;
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

export type CreditNoteInputItem = { lineId: string; amountMinor: number };
type CreditNoteMutationEnv = {
  BILLING_DB: D1Database;
  DOMAIN_EVENTS: Queue;
  CREDIT_NOTE_REFUND_MODE?: string;
  STRIPE_NETWORK_MODE?: string;
  STRIPE_RESTRICTED_API_KEY?: string;
  STRIPE_ACCOUNT_CODE?: string;
  STRIPE_ORGANIZATION_ID?: string;
  STRIPE_LIVEMODE_ALLOWED?: string;
  EASY_PAY_DIRECT_COMMERCE_API_KEY?: string;
  EASY_PAY_DIRECT_NETWORK_MODE?: string;
  EASY_PAY_DIRECT_LIVEMODE_ALLOWED?: string;
  EASY_PAY_DIRECT_ACCOUNT_CODE?: string;
  EASY_PAY_DIRECT_ORGANIZATION_ID?: string;
  PROVIDER_FINANCIALS?: ProviderFinancialServiceBinding;
};
export type CalculatedCreditNoteItem = CreditNoteInputItem & {
  couponAdjustmentMinor: number;
  taxableBaseMinor: number;
  taxes: CalculatedCreditNoteTax[];
};
export type CalculatedCreditNoteTax = {
  invoiceLineTaxId: string;
  taxId: string;
  code: string;
  name: string;
  description: string | null;
  rate: string;
  taxableBaseMinor: number;
  amountMinor: number;
  preciseAmountMinor: string;
};
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

export async function createCreditNote(
  request: Request,
  env: CreditNoteMutationEnv,
  auth: AuthContext,
  requestId: string,
  providerFetcher: typeof fetch = fetch,
): Promise<Response> {
  const input = objectAt(await parseJsonObject(request), "credit_note");
  rejectUnsupportedFields(input);
  const idempotencyKey = requiredIdempotencyKey(request);
  const invoiceId = requiredString(input, "invoice_id");
  const items = parseItems(input.items);
  const requestedCreditInput = optionalNonNegativeInteger(
    input.credit_amount_cents,
    "credit_amount_cents",
  );
  const requestedRefund =
    optionalNonNegativeInteger(input.refund_amount_cents, "refund_amount_cents") ?? 0;
  const requestedOffset =
    optionalNonNegativeInteger(input.offset_amount_cents, "offset_amount_cents") ?? 0;
  const reason = optionalString(input, "reason") ?? "other";
  if (!REASONS.has(reason)) throw new ApiError(422, "validation_error", "reason is invalid");
  const description = optionalString(input, "description");
  const requestHash = await sha256Hex(
    stableJson({
      description,
      invoiceId,
      items,
      reason,
      requestedCreditInput,
      requestedOffset,
      requestedRefund,
    }),
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
    await resumeProviderRefundIfNeeded(
      env,
      auth.organizationId,
      existing.id,
      reason,
      providerFetcher,
    );
    const reconciled = await findCreditNoteByIdempotencyKey(
      env.BILLING_DB,
      auth.organizationId,
      idempotencyKey,
    );
    return json(
      {
        credit_note: await serializeCreditNote(
          env.BILLING_DB,
          reconciled ?? existing,
          new URL(request.url).origin,
        ),
      },
      { requestId },
    );
  }
  const invoice = await env.BILLING_DB.prepare(
    `SELECT id, customer_id, number, status, currency, subtotal_minor, tax_minor, total_due_minor,
            version, coupons_minor, prepaid_credit_minor, credit_notes_minor,
            payment_dispute_lost_at
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
      total_due_minor: number;
      version: number;
      coupons_minor: number;
      prepaid_credit_minor: number;
      credit_notes_minor: number;
      payment_dispute_lost_at: string | null;
    }>();
  if (!invoice || invoice.status !== "finalized")
    throw new ApiError(404, "invoice_not_found", "Finalized invoice was not found");
  const calculatedItems = await calculateCreditNoteItems(
    items,
    env.BILLING_DB,
    invoice.id,
    auth.organizationId,
  );
  const itemsAmount = calculatedItems.reduce((sum, item) => safeAdd(sum, item.amountMinor), 0);
  const taxesAmount = calculatedItems.reduce(
    (sum, item) => item.taxes.reduce((taxSum, tax) => safeAdd(taxSum, tax.amountMinor), sum),
    0,
  );
  const couponsAdjustment = calculatedItems.reduce(
    (sum, item) => safeAdd(sum, item.couponAdjustmentMinor),
    0,
  );
  const total = safeAdd(itemsAmount, taxesAmount) - couponsAdjustment;
  if (!Number.isSafeInteger(total) || total <= 0)
    throw new ApiError(422, "invalid_credit_note_total", "Credit note total must be positive");
  const hasNonCreditSplit = requestedRefund > 0 || requestedOffset > 0;
  const requestedCredit = requestedCreditInput ?? (hasNonCreditSplit ? 0 : total);
  if (safeAdd(safeAdd(requestedCredit, requestedRefund), requestedOffset) !== total)
    throw new ApiError(
      422,
      "does_not_match_item_amounts",
      "Credit, refund, and offset amounts must equal the adjusted item total",
    );
  if (requestedRefund > 0) {
    if (invoice.payment_dispute_lost_at) {
      throw new ApiError(
        422,
        "refund_unavailable_after_lost_dispute",
        "A provider refund cannot be issued after the invoice dispute was lost",
      );
    }
    if (
      env.CREDIT_NOTE_REFUND_MODE !== "sandbox" &&
      env.CREDIT_NOTE_REFUND_MODE !== "stripe_test" &&
      env.CREDIT_NOTE_REFUND_MODE !== "easy_pay_direct_test"
    )
      throw new ApiError(
        503,
        "credit_note_refunds_disabled",
        "Credit note refunds are disabled unless an isolated test adapter is enabled",
      );
    const refundable = await refundableAmount(env.BILLING_DB, auth.organizationId, invoice.id);
    if (requestedRefund > refundable)
      throw new ApiError(
        422,
        "refund_amount_exceeds_paid_amount",
        "Refund amount exceeds successful payments that have not already been refunded",
      );
  }
  const refundPayment =
    requestedRefund > 0
      ? await refundablePaymentAttempt(
          env.BILLING_DB,
          auth.organizationId,
          invoice.id,
          requestedRefund,
        )
      : null;
  if (requestedRefund > 0 && !refundPayment) {
    throw new ApiError(
      422,
      "refund_payment_source_not_found",
      "Refund execution requires one successful payment that covers the requested amount",
    );
  }
  if (requestedRefund > 0 && env.CREDIT_NOTE_REFUND_MODE === "stripe_test") {
    if (refundPayment?.provider !== "stripe") {
      throw new ApiError(
        422,
        "stripe_refund_payment_required",
        "Stripe test-mode refunds require a successful Stripe payment",
      );
    }
    if (
      !env.STRIPE_ACCOUNT_CODE?.trim() ||
      refundPayment.provider_account_code !== env.STRIPE_ACCOUNT_CODE.trim()
    ) {
      throw new ApiError(
        503,
        "stripe_account_mapping_invalid",
        "The payment does not match the configured Stripe test account",
      );
    }
    if (
      !env.STRIPE_ORGANIZATION_ID?.trim() ||
      auth.organizationId !== env.STRIPE_ORGANIZATION_ID.trim()
    ) {
      throw new ApiError(
        503,
        "stripe_organization_mapping_invalid",
        "The request does not match the configured synthetic Stripe organization",
      );
    }
  }
  if (requestedRefund > 0 && env.CREDIT_NOTE_REFUND_MODE === "easy_pay_direct_test") {
    if (refundPayment?.provider !== "easy_pay_direct") {
      throw new ApiError(
        422,
        "easy_pay_direct_refund_payment_required",
        "Easy Pay Direct test refunds require a successful Easy Pay Direct payment",
      );
    }
    if (
      !env.PROVIDER_FINANCIALS &&
      (!env.EASY_PAY_DIRECT_ACCOUNT_CODE?.trim() ||
        refundPayment.provider_account_code !== env.EASY_PAY_DIRECT_ACCOUNT_CODE?.trim())
    ) {
      throw new ApiError(
        503,
        "easy_pay_direct_account_mapping_invalid",
        "The payment does not match the configured Easy Pay Direct test account",
      );
    }
    if (
      !env.PROVIDER_FINANCIALS &&
      (!env.EASY_PAY_DIRECT_ORGANIZATION_ID?.trim() ||
        auth.organizationId !== env.EASY_PAY_DIRECT_ORGANIZATION_ID?.trim())
    ) {
      throw new ApiError(
        503,
        "easy_pay_direct_organization_mapping_invalid",
        "The request does not match the configured Easy Pay Direct synthetic organization",
      );
    }
  }
  const paidAmount = await successfulPaymentAmount(env.BILLING_DB, invoice.id);
  const outstandingAmount = Math.max(invoice.total_due_minor - paidAmount, 0);
  if (requestedOffset > outstandingAmount)
    throw new ApiError(
      422,
      "offset_amount_exceeds_due_amount",
      "Offset amount exceeds the source invoice balance",
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
    calculatedItems.map(async (item) => ({
      ...item,
      id: await deterministicUuid("credit-note-item", `${id}:${item.lineId}`),
      taxes: await Promise.all(
        item.taxes.map(async (tax) => ({
          ...tax,
          id: await deterministicUuid("credit-note-tax", `${id}:${item.lineId}:${tax.taxId}`),
        })),
      ),
    })),
  );
  const preciseTaxesAmount = calculatedItems
    .flatMap((item) => item.taxes)
    .reduce((sum, tax) => sum.add(Decimal.parse(tax.preciseAmountMinor)), Decimal.zero())
    .toString();
  const refundStatus =
    requestedRefund > 0
      ? env.CREDIT_NOTE_REFUND_MODE === "stripe_test" ||
        env.CREDIT_NOTE_REFUND_MODE === "easy_pay_direct_test"
        ? "pending"
        : "succeeded"
      : null;
  const statements: D1PreparedStatement[] = [
    env.BILLING_DB.prepare(
      `INSERT INTO credit_notes
       (id, organization_id, customer_id, invoice_id, sequential_id, number, status,
        credit_status, reason, description, currency, total_amount_minor, credit_amount_minor,
        balance_amount_minor, version, idempotency_key, request_sha256, issuing_date, created_at,
        updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 'finalized', ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?)`,
    ).bind(
      id,
      auth.organizationId,
      invoice.customer_id,
      invoiceId,
      sequentialId,
      number,
      requestedCredit > 0 ? "available" : "consumed",
      reason,
      description,
      invoice.currency,
      total,
      total,
      requestedCredit,
      idempotencyKey,
      requestHash,
      now.slice(0, 10),
      now,
      now,
    ),
    env.BILLING_DB.prepare(
      `INSERT INTO credit_note_financials
       (credit_note_id, organization_id, items_amount_minor, taxes_amount_minor,
        coupons_adjustment_minor, total_amount_minor, credit_amount_minor,
        refund_amount_minor, offset_amount_minor, precise_taxes_amount_minor,
        refund_status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      id,
      auth.organizationId,
      itemsAmount,
      taxesAmount,
      couponsAdjustment,
      total,
      requestedCredit,
      requestedRefund,
      requestedOffset,
      preciseTaxesAmount,
      refundStatus,
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
    ...persistedItems.map((item) =>
      env.BILLING_DB.prepare(
        `INSERT INTO credit_note_item_adjustments
         (credit_note_item_id, organization_id, coupon_adjustment_minor,
          taxable_base_minor, created_at) VALUES (?, ?, ?, ?, ?)`,
      ).bind(item.id, auth.organizationId, item.couponAdjustmentMinor, item.taxableBaseMinor, now),
    ),
    ...persistedItems.flatMap((item) =>
      item.taxes.map((tax) =>
        env.BILLING_DB.prepare(
          `INSERT INTO credit_note_taxes
           (id, organization_id, credit_note_id, credit_note_item_id,
            invoice_line_tax_id, tax_id, tax_code, tax_name, tax_description,
            tax_rate, taxable_base_minor, amount_minor, precise_amount_minor,
            currency, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).bind(
          tax.id,
          auth.organizationId,
          id,
          item.id,
          tax.invoiceLineTaxId,
          tax.taxId,
          tax.code,
          tax.name,
          tax.description,
          tax.rate,
          tax.taxableBaseMinor,
          tax.amountMinor,
          tax.preciseAmountMinor,
          invoice.currency,
          now,
        ),
      ),
    ),
    ...(requestedOffset > 0
      ? [
          env.BILLING_DB.prepare(
            `INSERT INTO credit_note_offsets
             (id, organization_id, credit_note_id, invoice_id, amount_minor, status, created_at)
             VALUES (?, ?, ?, ?, ?, 'succeeded', ?)`,
          ).bind(
            await deterministicUuid("credit-note-offset", id),
            auth.organizationId,
            id,
            invoice.id,
            requestedOffset,
            now,
          ),
          env.BILLING_DB.prepare(
            `UPDATE invoices
             SET credits_minor = credits_minor + ?, credit_notes_minor = credit_notes_minor + ?,
                 total_due_minor = total_due_minor - ?,
                 payment_status = CASE
                   WHEN total_due_minor - ? = COALESCE((SELECT SUM(payment.amount_minor)
                     FROM payment_attempts payment
                     WHERE payment.invoice_id = invoices.id AND payment.status = 'succeeded'), 0)
                   THEN 'succeeded' ELSE payment_status END,
                 ready_for_payment_processing = CASE
                   WHEN total_due_minor - ? = COALESCE((SELECT SUM(payment.amount_minor)
                     FROM payment_attempts payment
                     WHERE payment.invoice_id = invoices.id AND payment.status = 'succeeded'), 0)
                   THEN 0 ELSE ready_for_payment_processing END,
                 version = version + 1, updated_at = ?
             WHERE id = ? AND organization_id = ? AND status = 'finalized'
               AND total_due_minor - COALESCE((SELECT SUM(payment.amount_minor)
                 FROM payment_attempts payment
                 WHERE payment.invoice_id = invoices.id AND payment.status = 'succeeded'), 0) >= ?`,
          ).bind(
            requestedOffset,
            requestedOffset,
            requestedOffset,
            requestedOffset,
            requestedOffset,
            now,
            invoice.id,
            auth.organizationId,
            requestedOffset,
          ),
        ]
      : []),
    ...(requestedRefund > 0
      ? [
          env.BILLING_DB.prepare(
            `INSERT INTO credit_note_refunds
             (id, organization_id, credit_note_id, invoice_id, provider_mode,
              provider_refund_id, amount_minor, currency, status, failure_message,
              created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)`,
          ).bind(
            await deterministicUuid("credit-note-refund", id),
            auth.organizationId,
            id,
            invoice.id,
            env.CREDIT_NOTE_REFUND_MODE === "stripe_test"
              ? "stripe_test"
              : env.CREDIT_NOTE_REFUND_MODE === "easy_pay_direct_test"
                ? "easy_pay_direct_test"
                : "sandbox",
            env.CREDIT_NOTE_REFUND_MODE === "stripe_test" ||
              env.CREDIT_NOTE_REFUND_MODE === "easy_pay_direct_test"
              ? null
              : `sandbox-refund:${id}`,
            requestedRefund,
            invoice.currency,
            refundStatus,
            now,
            now,
          ),
          env.BILLING_DB.prepare(
            `INSERT INTO provider_refund_operations
             (id, organization_id, credit_note_id, invoice_id, payment_attempt_id, provider,
              provider_account_code, provider_payment_id, provider_refund_id, idempotency_key,
              request_sha256, amount_minor, currency, status, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          ).bind(
            await deterministicUuid("provider-refund-operation", id),
            auth.organizationId,
            id,
            invoice.id,
            refundPayment!.id,
            refundPayment!.provider,
            refundPayment!.provider_account_code,
            refundPayment!.provider_transaction_id,
            env.CREDIT_NOTE_REFUND_MODE === "stripe_test" ||
              env.CREDIT_NOTE_REFUND_MODE === "easy_pay_direct_test"
              ? null
              : `sandbox-refund:${id}`,
            env.CREDIT_NOTE_REFUND_MODE === "stripe_test"
              ? `stripe-refund:${id}`
              : env.CREDIT_NOTE_REFUND_MODE === "easy_pay_direct_test"
                ? `easy-pay-direct-refund:${id}`
                : `sandbox:${idempotencyKey}`,
            requestHash,
            requestedRefund,
            invoice.currency,
            refundStatus,
            now,
            now,
          ),
        ]
      : []),
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
  if (
    requestedRefund > 0 &&
    (env.CREDIT_NOTE_REFUND_MODE === "stripe_test" ||
      env.CREDIT_NOTE_REFUND_MODE === "easy_pay_direct_test")
  ) {
    await resumeProviderRefundIfNeeded(env, auth.organizationId, id, reason, providerFetcher);
  }
  const note = await findCreditNote(env.BILLING_DB, auth.organizationId, id);
  if (!note) throw new ApiError(500, "persistence_error", "Credit note was not persisted");
  return json(
    {
      credit_note: await serializeCreditNote(env.BILLING_DB, note, new URL(request.url).origin),
    },
    { requestId },
  );
}

export async function listCreditNotes(
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

export async function showCreditNote(
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

export async function voidCreditNote(
  id: string,
  env: CreditNoteMutationEnv,
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
  if (
    note.refund_amount_minor > 0 ||
    note.offset_amount_minor > 0 ||
    note.credit_status !== "available" ||
    note.balance_amount_minor !== note.credit_amount_minor
  )
    throw new ApiError(
      422,
      "no_voidable_amount",
      "Only a fully unconsumed credit-only note can be voided",
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

function parseItems(value: unknown): CreditNoteInputItem[] {
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

export async function calculateCreditNoteItems(
  items: CreditNoteInputItem[],
  db: D1Database,
  invoiceId: string,
  organizationId: string,
): Promise<CalculatedCreditNoteItem[]> {
  const calculated: CalculatedCreditNoteItem[] = [];
  for (const item of items) {
    const { lineId, amountMinor } = item;
    const line = await db
      .prepare(
        `SELECT il.amount_minor,
              COALESCE((SELECT SUM(cni.amount_minor) FROM credit_note_items cni
                JOIN credit_notes cn ON cn.id = cni.credit_note_id
                WHERE cni.invoice_line_id = il.id AND cn.credit_status <> 'voided'), 0) AS credited
              , COALESCE((SELECT SUM(coupon_line.amount_minor)
                  FROM coupon_credit_lines coupon_line
                  WHERE coupon_line.invoice_line_id = il.id), 0) AS coupon_minor
       FROM invoice_lines il JOIN invoices i ON i.id = il.invoice_id
       WHERE il.id = ? AND il.invoice_id = ? AND i.organization_id = ? LIMIT 1`,
      )
      .bind(lineId, invoiceId, organizationId)
      .first<{ amount_minor: number; credited: number; coupon_minor: number }>();
    if (!line) throw new ApiError(404, "fee_not_found", "Invoice fee was not found");
    if (amountMinor > line.amount_minor - line.credited)
      throw new ApiError(
        422,
        "higher_than_remaining_fee_amount",
        "Item exceeds the remaining fee amount",
      );
    const previousCoupon = proportionalRounded(line.coupon_minor, line.credited, line.amount_minor);
    const cumulativeCoupon = proportionalRounded(
      line.coupon_minor,
      safeAdd(line.credited, amountMinor),
      line.amount_minor,
    );
    const couponAdjustmentMinor = cumulativeCoupon - previousCoupon;
    const previousTaxableBase = Math.max(line.credited - previousCoupon, 0);
    const taxableBaseMinor = Math.max(amountMinor - couponAdjustmentMinor, 0);
    const cumulativeTaxableBase = safeAdd(previousTaxableBase, taxableBaseMinor);
    const sourceTaxes = await db
      .prepare(
        `SELECT id, tax_id, tax_code, tax_name, tax_description, tax_rate
         FROM invoice_line_taxes
         WHERE organization_id = ? AND invoice_id = ? AND invoice_line_id = ?
         ORDER BY created_at, id`,
      )
      .bind(organizationId, invoiceId, lineId)
      .all<{
        id: string;
        tax_id: string;
        tax_code: string;
        tax_name: string;
        tax_description: string | null;
        tax_rate: string;
      }>();
    const taxes = sourceTaxes.results.map((tax): CalculatedCreditNoteTax => {
      const previousPrecise = Decimal.parse(previousTaxableBase)
        .multiply(Decimal.parse(tax.tax_rate))
        .divideByInteger(100n);
      const cumulativePrecise = Decimal.parse(cumulativeTaxableBase)
        .multiply(Decimal.parse(tax.tax_rate))
        .divideByInteger(100n);
      const precise = cumulativePrecise.subtract(previousPrecise);
      const amount = cumulativePrecise.round() - previousPrecise.round();
      const amountMinor = Number(amount);
      if (!Number.isSafeInteger(amountMinor) || amountMinor < 0)
        throw new ApiError(422, "invalid_minor_amount", "Calculated credit note tax is invalid");
      return {
        invoiceLineTaxId: tax.id,
        taxId: tax.tax_id,
        code: tax.tax_code,
        name: tax.tax_name,
        description: tax.tax_description,
        rate: tax.tax_rate,
        taxableBaseMinor,
        amountMinor,
        preciseAmountMinor: precise.toString(),
      };
    });
    calculated.push({
      ...item,
      couponAdjustmentMinor,
      taxableBaseMinor,
      taxes,
    });
  }
  return calculated;
}

function creditNoteSelect() {
  return `SELECT cn.id, cn.invoice_id, i.number AS invoice_number, cn.customer_id, c.external_id AS customer_external_id, cn.sequential_id, cn.number, CASE WHEN cn.allocation_state = 'draft' THEN 'draft' ELSE cn.status END AS status, cn.credit_status, cn.reason, cn.description, cn.currency, COALESCE(financial.total_amount_minor, cn.total_amount_minor) AS total_amount_minor, COALESCE(financial.credit_amount_minor, cn.credit_amount_minor) AS credit_amount_minor, cn.balance_amount_minor, COALESCE(financial.refund_amount_minor, cn.refund_amount_minor) AS refund_amount_minor, COALESCE(financial.offset_amount_minor, cn.offset_amount_minor) AS offset_amount_minor, COALESCE(financial.taxes_amount_minor, cn.taxes_amount_minor) AS taxes_amount_minor, COALESCE(financial.coupons_adjustment_minor, cn.coupons_adjustment_minor) AS coupons_adjustment_minor, COALESCE(financial.items_amount_minor, cn.total_amount_minor) AS items_amount_minor, COALESCE(financial.precise_taxes_amount_minor, CAST(cn.taxes_amount_minor AS TEXT)) AS precise_taxes_amount_minor, financial.refund_status, cn.version, cn.idempotency_key, cn.request_sha256, cn.issuing_date, cn.created_at, cn.updated_at, cn.voided_at, artifact.status AS pdf_status, artifact.object_key AS pdf_object_key FROM credit_notes cn JOIN invoices i ON i.id = cn.invoice_id JOIN customers c ON c.id = cn.customer_id LEFT JOIN credit_note_financials financial ON financial.credit_note_id = cn.id LEFT JOIN credit_note_document_artifacts artifact ON artifact.credit_note_id = cn.id AND artifact.credit_note_version = cn.version`;
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
  const taxes = await db
    .prepare(
      `SELECT MIN(id) AS id, tax_id, tax_name, tax_code, tax_description, tax_rate,
              SUM(taxable_base_minor) AS taxable_base_minor,
              SUM(amount_minor) AS amount_minor, currency, MIN(created_at) AS created_at
       FROM credit_note_taxes WHERE credit_note_id = ?
       GROUP BY tax_id, tax_name, tax_code, tax_description, tax_rate, currency
       ORDER BY MIN(created_at), tax_id`,
    )
    .bind(note.id)
    .all<{
      id: string;
      tax_id: string;
      tax_name: string;
      tax_code: string;
      tax_description: string | null;
      tax_rate: string;
      taxable_base_minor: number;
      amount_minor: number;
      currency: string;
      created_at: string;
    }>();
  return {
    lago_id: note.id,
    sequential_id: note.sequential_id,
    number: note.number,
    lago_invoice_id: note.invoice_id,
    invoice_number: note.invoice_number,
    issuing_date: note.issuing_date,
    credit_status: note.credit_status,
    refund_status: note.refund_status,
    reason: note.reason,
    description: note.description,
    currency: note.currency,
    total_amount_cents: note.total_amount_minor,
    precise_total_amount_cents: String(note.total_amount_minor),
    taxes_amount_cents: note.taxes_amount_minor,
    precise_taxes_amount_cents: note.precise_taxes_amount_minor,
    sub_total_excluding_taxes_amount_cents: note.items_amount_minor - note.coupons_adjustment_minor,
    balance_amount_cents: note.balance_amount_minor,
    credit_amount_cents: note.credit_amount_minor,
    refund_amount_cents: note.refund_amount_minor,
    offset_amount_cents: note.offset_amount_minor,
    coupons_adjustment_amount_cents: note.coupons_adjustment_minor,
    taxes_rate: taxes.results.reduce((sum, tax) => sum + Number(tax.tax_rate), 0),
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
    applied_taxes: taxes.results.map((tax) => ({
      lago_id: tax.id,
      lago_tax_id: tax.tax_id,
      tax_name: tax.tax_name,
      tax_code: tax.tax_code,
      tax_description: tax.tax_description,
      tax_rate: Number(tax.tax_rate),
      amount_cents: tax.amount_minor,
      precise_amount_cents: String(tax.amount_minor),
      taxable_base_amount_cents: tax.taxable_base_minor,
      amount_currency: tax.currency,
      created_at: tax.created_at,
    })),
    error_details: [],
  };
}

function positiveInteger(value: unknown, field: string) {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0)
    throw new ApiError(422, "validation_error", `${field} must be a positive integer`);
  return value;
}
function optionalNonNegativeInteger(value: unknown, field: string): number | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)
    throw new ApiError(422, "validation_error", `${field} must be a non-negative integer`);
  return value;
}
function safeAdd(left: number, right: number) {
  const total = left + right;
  if (!Number.isSafeInteger(total))
    throw new ApiError(422, "invalid_minor_amount", "Credit amount exceeds supported precision");
  return total;
}
function rejectUnsupportedFields(input: Record<string, unknown>) {
  if (input.metadata !== undefined && input.metadata !== null)
    throw new ApiError(
      422,
      "unsupported_credit_note_feature",
      "metadata is not implemented for Cloudflare credit notes",
    );
}
function proportionalRounded(total: number, part: number, whole: number): number {
  if (total === 0 || part === 0) return 0;
  const numerator = BigInt(total) * BigInt(part);
  const denominator = BigInt(whole);
  const quotient = numerator / denominator;
  const remainder = numerator % denominator;
  const rounded = remainder * 2n >= denominator ? quotient + 1n : quotient;
  const result = Number(rounded);
  if (!Number.isSafeInteger(result))
    throw new ApiError(422, "invalid_minor_amount", "Prorated amount exceeds supported precision");
  return result;
}
async function successfulPaymentAmount(db: D1Database, invoiceId: string): Promise<number> {
  const result = await db
    .prepare(
      `SELECT COALESCE(SUM(amount_minor), 0) AS amount
       FROM payment_attempts WHERE invoice_id = ? AND status = 'succeeded'`,
    )
    .bind(invoiceId)
    .first<{ amount: number }>();
  return result?.amount ?? 0;
}
async function refundableAmount(
  db: D1Database,
  organizationId: string,
  invoiceId: string,
): Promise<number> {
  const paid = await successfulPaymentAmount(db, invoiceId);
  const refunded = await db
    .prepare(
      `SELECT COALESCE(SUM(amount_minor), 0) AS amount FROM credit_note_refunds
       WHERE organization_id = ? AND invoice_id = ? AND status = 'succeeded'`,
    )
    .bind(organizationId, invoiceId)
    .first<{ amount: number }>();
  return Math.max(paid - (refunded?.amount ?? 0), 0);
}

async function refundablePaymentAttempt(
  db: D1Database,
  organizationId: string,
  invoiceId: string,
  amountMinor: number,
): Promise<{
  id: string;
  provider: string;
  provider_account_code: string;
  provider_transaction_id: string;
} | null> {
  return db
    .prepare(
      `SELECT id, provider, provider_account_code, provider_transaction_id
       FROM payment_attempts
       WHERE organization_id = ? AND invoice_id = ? AND status = 'succeeded'
         AND provider_transaction_id IS NOT NULL AND amount_minor >= ?
       ORDER BY created_at DESC, id DESC LIMIT 1`,
    )
    .bind(organizationId, invoiceId, amountMinor)
    .first<{
      id: string;
      provider: string;
      provider_account_code: string;
      provider_transaction_id: string;
    }>();
}

async function resumeProviderRefundIfNeeded(
  env: CreditNoteMutationEnv,
  organizationId: string,
  creditNoteId: string,
  reason: string,
  providerFetcher: typeof fetch,
): Promise<void> {
  if (env.CREDIT_NOTE_REFUND_MODE === "easy_pay_direct_test") {
    await resumeEasyPayDirectRefundIfNeeded(env, organizationId, creditNoteId, providerFetcher);
    return;
  }
  if (env.CREDIT_NOTE_REFUND_MODE !== "stripe_test") return;
  const operation = await env.BILLING_DB.prepare(
    `SELECT id, invoice_id, provider_account_code, provider_payment_id, idempotency_key,
            amount_minor, currency, status
     FROM provider_refund_operations
     WHERE organization_id = ? AND credit_note_id = ? AND provider = 'stripe'
     LIMIT 1`,
  )
    .bind(organizationId, creditNoteId)
    .first<{
      id: string;
      invoice_id: string;
      provider_account_code: string;
      provider_payment_id: string;
      idempotency_key: string;
      amount_minor: number;
      currency: string;
      status: string;
    }>();
  if (!operation || operation.status === "succeeded") return;
  if (
    operation.provider_account_code !== env.STRIPE_ACCOUNT_CODE?.trim() ||
    organizationId !== env.STRIPE_ORGANIZATION_ID?.trim()
  ) {
    throw new ApiError(
      503,
      "stripe_refund_mapping_changed",
      "The pending refund no longer matches the configured synthetic Stripe boundary",
    );
  }

  try {
    const result = await createStripeRefund(
      env,
      {
        organizationId,
        invoiceId: operation.invoice_id,
        creditNoteId,
        paymentIntentId: operation.provider_payment_id,
        amountMinor: operation.amount_minor,
        currency: operation.currency,
        idempotencyKey: operation.idempotency_key,
        reason: stripeRefundReason(reason),
      },
      providerFetcher,
    );
    const now = new Date().toISOString();
    const financialStatus =
      result.status === "succeeded"
        ? "succeeded"
        : result.status === "failed" || result.status === "canceled"
          ? "failed"
          : "pending";
    await env.BILLING_DB.batch([
      env.BILLING_DB.prepare(
        `UPDATE provider_refund_operations
         SET provider_refund_id = ?, status = ?, failure_code = ?, failure_message = ?,
             updated_at = ?
         WHERE id = ? AND organization_id = ? AND status <> 'succeeded'`,
      ).bind(
        result.id,
        result.status,
        result.failureReason,
        result.failureReason,
        now,
        operation.id,
        organizationId,
      ),
      env.BILLING_DB.prepare(
        `UPDATE credit_note_refunds
         SET provider_refund_id = ?, status = ?, failure_message = ?, updated_at = ?
         WHERE organization_id = ? AND credit_note_id = ? AND status <> 'succeeded'`,
      ).bind(result.id, result.status, result.failureReason, now, organizationId, creditNoteId),
      env.BILLING_DB.prepare(
        `UPDATE credit_note_financials SET refund_status = ?
         WHERE organization_id = ? AND credit_note_id = ? AND refund_status <> 'succeeded'`,
      ).bind(financialStatus, organizationId, creditNoteId),
    ]);
  } catch (error) {
    const now = new Date().toISOString();
    const message = boundedProviderFailure(error);
    await env.BILLING_DB.batch([
      env.BILLING_DB.prepare(
        `UPDATE provider_refund_operations
         SET status = 'failed', failure_code = 'stripe_request_failed', failure_message = ?,
             updated_at = ?
         WHERE id = ? AND organization_id = ? AND status <> 'succeeded'`,
      ).bind(message, now, operation.id, organizationId),
      env.BILLING_DB.prepare(
        `UPDATE credit_note_refunds
         SET status = 'failed', failure_message = ?, updated_at = ?
         WHERE organization_id = ? AND credit_note_id = ? AND status <> 'succeeded'`,
      ).bind(message, now, organizationId, creditNoteId),
      env.BILLING_DB.prepare(
        `UPDATE credit_note_financials SET refund_status = 'failed'
         WHERE organization_id = ? AND credit_note_id = ? AND refund_status <> 'succeeded'`,
      ).bind(organizationId, creditNoteId),
    ]);
    throw error;
  }
}

async function resumeEasyPayDirectRefundIfNeeded(
  env: CreditNoteMutationEnv,
  organizationId: string,
  creditNoteId: string,
  providerFetcher: typeof fetch,
): Promise<void> {
  const operation = await env.BILLING_DB.prepare(
    `SELECT id, provider_account_code, provider_payment_id, provider_idempotency_key,
            amount_minor, currency, status
     FROM provider_refund_operations
     WHERE organization_id = ? AND credit_note_id = ? AND provider = 'easy_pay_direct'
     LIMIT 1`,
  )
    .bind(organizationId, creditNoteId)
    .first<{
      id: string;
      provider_account_code: string;
      provider_payment_id: string;
      provider_idempotency_key: string | null;
      amount_minor: number;
      currency: string;
      status: string;
    }>();
  if (!operation || operation.status === "succeeded") return;
  if (
    !env.PROVIDER_FINANCIALS &&
    (operation.provider_account_code !== env.EASY_PAY_DIRECT_ACCOUNT_CODE?.trim() ||
      organizationId !== env.EASY_PAY_DIRECT_ORGANIZATION_ID?.trim() ||
      env.EASY_PAY_DIRECT_NETWORK_MODE !== "test")
  ) {
    throw new ApiError(
      503,
      "easy_pay_direct_refund_mapping_changed",
      "The pending refund no longer matches the configured Easy Pay Direct test boundary",
    );
  }

  try {
    const providerIdempotencyKey = operation.provider_idempotency_key ?? crypto.randomUUID();
    if (!operation.provider_idempotency_key) {
      await env.BILLING_DB.prepare(
        `UPDATE provider_refund_operations SET provider_idempotency_key = ?, updated_at = ?
         WHERE id = ? AND provider_idempotency_key IS NULL`,
      )
        .bind(providerIdempotencyKey, new Date().toISOString(), operation.id)
        .run();
    }
    const result = env.PROVIDER_FINANCIALS
      ? await env.PROVIDER_FINANCIALS.refundEasyPayDirect({
          organizationId,
          providerAccountCode: operation.provider_account_code,
          orderId: operation.provider_payment_id,
          amountMinor: operation.amount_minor,
          currency: operation.currency,
          idempotencyKey: providerIdempotencyKey,
        })
      : await refundEasyPayDirectOrder(
          env as Env,
          {
            orderId: operation.provider_payment_id,
            amountMinor: operation.amount_minor,
            currency: operation.currency,
            idempotencyKey: providerIdempotencyKey,
          },
          providerFetcher,
        );
    const now = new Date().toISOString();
    const status = result.status === "unknown" ? "pending" : result.status;
    const failureMessage = result.status === "succeeded" ? null : result.responseText.slice(0, 500);
    await env.BILLING_DB.batch([
      env.BILLING_DB.prepare(
        `UPDATE provider_refund_operations
         SET provider_refund_id = ?, status = ?, failure_code = ?, failure_message = ?,
             updated_at = ?
         WHERE id = ? AND organization_id = ? AND status <> 'succeeded'`,
      ).bind(
        result.id,
        status,
        result.status === "failed" ? "easy_pay_direct_refund_failed" : null,
        failureMessage,
        now,
        operation.id,
        organizationId,
      ),
      env.BILLING_DB.prepare(
        `UPDATE credit_note_refunds
         SET provider_refund_id = ?, status = ?, failure_message = ?, updated_at = ?
         WHERE organization_id = ? AND credit_note_id = ? AND status <> 'succeeded'`,
      ).bind(result.id, status, failureMessage, now, organizationId, creditNoteId),
      env.BILLING_DB.prepare(
        `UPDATE credit_note_financials SET refund_status = ?
         WHERE organization_id = ? AND credit_note_id = ? AND refund_status <> 'succeeded'`,
      ).bind(
        status === "succeeded" ? "succeeded" : status === "failed" ? "failed" : "pending",
        organizationId,
        creditNoteId,
      ),
    ]);
  } catch (error) {
    const now = new Date().toISOString();
    const message = boundedProviderFailure(error);
    await env.BILLING_DB.batch([
      env.BILLING_DB.prepare(
        `UPDATE provider_refund_operations
         SET status = 'failed', failure_code = 'easy_pay_direct_request_failed',
             failure_message = ?, updated_at = ?
         WHERE id = ? AND organization_id = ? AND status <> 'succeeded'`,
      ).bind(message, now, operation.id, organizationId),
      env.BILLING_DB.prepare(
        `UPDATE credit_note_refunds SET status = 'failed', failure_message = ?, updated_at = ?
         WHERE organization_id = ? AND credit_note_id = ? AND status <> 'succeeded'`,
      ).bind(message, now, organizationId, creditNoteId),
      env.BILLING_DB.prepare(
        `UPDATE credit_note_financials SET refund_status = 'failed'
         WHERE organization_id = ? AND credit_note_id = ? AND refund_status <> 'succeeded'`,
      ).bind(organizationId, creditNoteId),
    ]);
    throw error;
  }
}

function stripeRefundReason(reason: string): "duplicate" | "fraudulent" | "requested_by_customer" {
  if (reason === "duplicated_charge") return "duplicate";
  if (reason === "fraudulent_charge") return "fraudulent";
  return "requested_by_customer";
}

function boundedProviderFailure(error: unknown): string {
  const message = error instanceof Error ? error.message : "Stripe refund request failed";
  return message.slice(0, 500);
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
