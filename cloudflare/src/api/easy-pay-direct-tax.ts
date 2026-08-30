import { sha256Hex } from "../auth/api-key";
import { ApiError, json, objectAt, parseJsonObject, requiredString } from "../http";
import { deterministicUuid } from "../identifiers";
import { stableJson } from "../json";
import {
  createEasyPayDirectCheckoutUrl,
  verifyEasyPayDirectCheckoutToken,
} from "../providers/easy-pay-direct";
import { calculateLocalD1Tax } from "../tax/local-d1";

const STRIPE_TAX_CALCULATIONS_URL = "https://api.stripe.com/v1/tax/calculations";
const STRIPE_TAX_TRANSACTIONS_URL =
  "https://api.stripe.com/v1/tax/transactions/create_from_calculation";
const MAX_STRIPE_RESPONSE_BYTES = 256 * 1024;

export type BillingAddress = {
  country: string;
  state: string | null;
  postalCode: string | null;
};

type TaxableCheckout = {
  checkout_intent_id: string;
  organization_id: string;
  payment_request_id: string;
  customer_id: string;
  provider_account_code: string;
  idempotency_key: string;
  currency: string;
  intent_amount_minor: number;
  request_amount_minor: number;
  payment_request_version: number;
  invoice_id: string;
  invoice_version: number;
  subtotal_minor: number;
  tax_minor: number;
  credits_minor: number;
  total_due_minor: number;
  invoice_count: number;
  plan_interval: string | null;
};

type TaxCalculation = {
  id: string;
  providerCode: "local_d1" | "stripe_test";
  currency: string;
  subtotalMinor: number;
  taxMinor: number;
  totalMinor: number;
  expiresAt: string;
  localRuleSetId: string | null;
  localRuleId: string | null;
};

export async function handleEasyPayDirectTaxQuote(
  request: Request,
  env: Env,
  requestId: string,
  fetcher: typeof fetch = fetch,
): Promise<Response> {
  if (env.EASY_PAY_DIRECT_TAX_MODE === "disabled" || !env.EASY_PAY_DIRECT_TAX_MODE) {
    throw new ApiError(503, "checkout_tax_disabled", "Checkout tax calculation is disabled");
  }
  const provider = env.EASY_PAY_DIRECT_TAX_PROVIDER;
  if (provider !== "stripe_test" && provider !== "local_d1") {
    throw new ApiError(503, "checkout_tax_provider_disabled", "Checkout tax provider is disabled");
  }
  const input = await parseJsonObject(request);
  const checkoutToken = requiredString(input, "checkout");
  if (checkoutToken.length > 2_048) {
    throw new ApiError(422, "invalid_checkout_tax_quote", "Checkout tax request is invalid");
  }
  const signingSecret = env.EASY_PAY_DIRECT_CHECKOUT_SIGNING_SECRET?.trim();
  if (!signingSecret) {
    throw new ApiError(503, "provider_not_configured", "Checkout signing is not configured");
  }
  const tokenPayload = await verifyEasyPayDirectCheckoutToken(checkoutToken, signingSecret);
  const checkout = await loadTaxableCheckout(
    env.BILLING_DB,
    tokenPayload.intent,
    await sha256Hex(checkoutToken),
  );
  validateTaxableCheckout(checkout);
  const address = normalizeBillingAddress(objectAt(input, "billing_address"));
  const addressHash = await sha256Hex(stableJson(address));
  const taxCode = resolveCheckoutTaxCode(checkout.plan_interval, env);
  const taxableSubtotal = checkout.subtotal_minor - checkout.credits_minor;
  const requestHash = await sha256Hex(
    stableJson({
      address,
      checkout_intent_id: checkout.checkout_intent_id,
      currency: checkout.currency,
      subtotal_minor: taxableSubtotal,
      tax_code: taxCode,
    }),
  );
  const calculation: TaxCalculation =
    provider === "stripe_test"
      ? await createStripeTaxCalculation(
          env,
          {
            address,
            currency: checkout.currency,
            idempotencyKey: `lago-epd-tax-${checkout.checkout_intent_id}-${addressHash}`,
            reference: checkout.payment_request_id,
            subtotalMinor: taxableSubtotal,
            taxCode,
          },
          fetcher,
        )
      : await createLocalTaxCalculation(env, {
          address,
          currency: checkout.currency,
          organizationId: checkout.organization_id,
          requestHash,
          subtotalMinor: taxableSubtotal,
          taxCode,
        });
  const quoteId = await deterministicUuid(
    "easy-pay-direct-checkout-tax-quote",
    `${checkout.organization_id}:${calculation.providerCode}:${calculation.id}`,
  );
  const now = new Date().toISOString();
  if (env.EASY_PAY_DIRECT_TAX_MODE === "shadow") {
    await env.BILLING_DB.prepare(
      `INSERT INTO easy_pay_direct_checkout_tax_quotes
       (id, organization_id, payment_request_id, invoice_id, source_checkout_intent_id,
        provider_code, provider_calculation_id, local_rule_set_id, local_rule_id,
        request_sha256, billing_address_sha256,
        billing_country, billing_state, billing_postal_code, currency, subtotal_minor,
        tax_minor, total_minor, tax_code, status, expires_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'quoted', ?, ?, ?)
       ON CONFLICT(provider_code, provider_calculation_id) DO NOTHING`,
    )
      .bind(
        quoteId,
        checkout.organization_id,
        checkout.payment_request_id,
        checkout.invoice_id,
        checkout.checkout_intent_id,
        calculation.providerCode,
        calculation.id,
        calculation.localRuleSetId,
        calculation.localRuleId,
        requestHash,
        addressHash,
        address.country,
        address.state,
        address.postalCode,
        checkout.currency,
        calculation.subtotalMinor,
        calculation.taxMinor,
        calculation.totalMinor,
        taxCode,
        calculation.expiresAt,
        now,
        now,
      )
      .run();
    return taxQuoteResponse(
      {
        quoteId,
        checkoutToken,
        calculation,
        chargedTotalMinor: checkout.intent_amount_minor,
        mode: "shadow",
      },
      requestId,
    );
  }

  const replacementIntentId = await deterministicUuid(
    "payment-request-checkout-tax-intent",
    `${checkout.checkout_intent_id}:${quoteId}`,
  );
  const replacementVersion = checkout.payment_request_version + 1;
  const requestSha256 = await sha256Hex(
    stableJson({
      amountMinor: calculation.totalMinor,
      currency: checkout.currency,
      organizationId: checkout.organization_id,
      paymentRequestId: checkout.payment_request_id,
      paymentRequestVersion: replacementVersion,
      provider: "easy_pay_direct",
      providerAccountCode: checkout.provider_account_code,
      taxQuoteId: quoteId,
    }),
  );
  const generated = await createEasyPayDirectCheckoutUrl(env, {
    checkoutIntentId: replacementIntentId,
  });
  const generatedTokenHash = await sha256Hex(generated.token);
  const replacementIdempotencyKey = `${checkout.idempotency_key}:tax:${quoteId}`;
  const eventId = `payment-request-checkout-tax-applied:${quoteId}`;
  const results = await env.BILLING_DB.batch([
    env.BILLING_DB.prepare(
      `UPDATE easy_pay_direct_checkout_tax_quotes
       SET status = 'superseded', active_checkout_intent_id = NULL, updated_at = ?
       WHERE active_checkout_intent_id = ? AND status = 'applied'`,
    ).bind(now, checkout.checkout_intent_id),
    env.BILLING_DB.prepare(
      `INSERT INTO easy_pay_direct_checkout_tax_quotes
       (id, organization_id, payment_request_id, invoice_id, source_checkout_intent_id,
        provider_code, provider_calculation_id, local_rule_set_id, local_rule_id,
        request_sha256, billing_address_sha256,
        billing_country, billing_state, billing_postal_code, currency, subtotal_minor,
        tax_minor, total_minor, tax_code, status, expires_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'quoted', ?, ?, ?)
       ON CONFLICT(provider_code, provider_calculation_id) DO NOTHING`,
    ).bind(
      quoteId,
      checkout.organization_id,
      checkout.payment_request_id,
      checkout.invoice_id,
      checkout.checkout_intent_id,
      calculation.providerCode,
      calculation.id,
      calculation.localRuleSetId,
      calculation.localRuleId,
      requestHash,
      addressHash,
      address.country,
      address.state,
      address.postalCode,
      checkout.currency,
      calculation.subtotalMinor,
      calculation.taxMinor,
      calculation.totalMinor,
      taxCode,
      calculation.expiresAt,
      now,
      now,
    ),
    env.BILLING_DB.prepare(
      `INSERT INTO easy_pay_direct_checkout_tax_repricing_guards
       (quote_id, organization_id, payment_request_id, invoice_id,
        source_checkout_intent_id, expected_payment_request_version,
        expected_invoice_version, expected_amount_minor, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      quoteId,
      checkout.organization_id,
      checkout.payment_request_id,
      checkout.invoice_id,
      checkout.checkout_intent_id,
      checkout.payment_request_version,
      checkout.invoice_version,
      checkout.intent_amount_minor,
      now,
    ),
    env.BILLING_DB.prepare(
      `UPDATE invoices
       SET tax_minor = ?, total_due_minor = ?, version = version + 1, updated_at = ?
       WHERE id = ? AND organization_id = ? AND version = ?
         AND status = 'finalized' AND payment_status = 'pending'
         AND ready_for_payment_processing = 1
         AND subtotal_minor - credits_minor = ? AND total_due_minor = ?`,
    ).bind(
      calculation.taxMinor,
      calculation.totalMinor,
      now,
      checkout.invoice_id,
      checkout.organization_id,
      checkout.invoice_version,
      calculation.subtotalMinor,
      checkout.intent_amount_minor,
    ),
    env.BILLING_DB.prepare(
      `UPDATE invoices_payment_requests
       SET invoice_version = ?, updated_at = ?
       WHERE payment_request_id = ? AND invoice_id = ? AND invoice_version = ?`,
    ).bind(
      checkout.invoice_version + 1,
      now,
      checkout.payment_request_id,
      checkout.invoice_id,
      checkout.invoice_version,
    ),
    env.BILLING_DB.prepare(
      `UPDATE payment_requests
       SET amount_minor = ?, version = version + 1, updated_at = ?
       WHERE id = ? AND organization_id = ? AND version = ?
         AND amount_minor = ? AND collection_mode = 'checkout'
         AND payment_status = 'pending' AND ready_for_payment_processing = 1`,
    ).bind(
      calculation.totalMinor,
      now,
      checkout.payment_request_id,
      checkout.organization_id,
      checkout.payment_request_version,
      checkout.request_amount_minor,
    ),
    env.BILLING_DB.prepare(
      `UPDATE payment_request_checkout_intents
       SET status = 'failed', payment_url = NULL, provider_token_sha256 = NULL,
           failure_code = 'superseded_by_tax_quote',
           failure_message = 'Checkout total was replaced by a destination tax quote',
           version = version + 1, updated_at = ?, completed_at = ?
       WHERE id = ? AND organization_id = ? AND status = 'succeeded'
         AND amount_minor = ? AND payment_request_version = ?`,
    ).bind(
      now,
      now,
      checkout.checkout_intent_id,
      checkout.organization_id,
      checkout.intent_amount_minor,
      checkout.payment_request_version,
    ),
    env.BILLING_DB.prepare(
      `INSERT INTO payment_request_checkout_intents
       (id, organization_id, payment_request_id, customer_id, provider,
        provider_account_code, idempotency_key, request_sha256, amount_minor, currency,
        payment_request_version, status, payment_url, provider_token_sha256, expires_at,
        version, created_at, updated_at, completed_at)
       VALUES (?, ?, ?, ?, 'easy_pay_direct', ?, ?, ?, ?, ?, ?, 'succeeded', ?, ?, ?, 2, ?, ?, ?)`,
    ).bind(
      replacementIntentId,
      checkout.organization_id,
      checkout.payment_request_id,
      checkout.customer_id,
      checkout.provider_account_code,
      replacementIdempotencyKey,
      requestSha256,
      calculation.totalMinor,
      checkout.currency,
      replacementVersion,
      generated.paymentUrl,
      generatedTokenHash,
      generated.expiresAt,
      now,
      now,
      now,
    ),
    env.BILLING_DB.prepare(
      `UPDATE easy_pay_direct_checkout_tax_quotes
       SET status = 'applied', active_checkout_intent_id = ?, updated_at = ?
       WHERE id = ? AND status = 'quoted'`,
    ).bind(replacementIntentId, now, quoteId),
    env.BILLING_DB.prepare(
      `INSERT INTO outbox_events
       (event_id, organization_id, event_type, event_version, aggregate_type,
        aggregate_id, aggregate_version, causation_id, correlation_id, payload_json,
        occurred_at, published_at)
       VALUES (?, ?, 'payment_request.checkout_tax_applied', 1, 'payment_request_checkout',
               ?, 1, ?, ?, ?, ?, NULL)
       ON CONFLICT(event_id) DO NOTHING`,
    ).bind(
      eventId,
      checkout.organization_id,
      replacementIntentId,
      checkout.checkout_intent_id,
      quoteId,
      stableJson({
        checkoutIntentId: replacementIntentId,
        paymentRequestId: checkout.payment_request_id,
        provider: calculation.providerCode,
        subtotalMinor: calculation.subtotalMinor,
        taxMinor: calculation.taxMinor,
        totalMinor: calculation.totalMinor,
      }),
      now,
    ),
  ]);
  if (
    results[3]?.meta.changes !== 1 ||
    results[4]?.meta.changes !== 1 ||
    results[5]?.meta.changes !== 1 ||
    results[6]?.meta.changes !== 1 ||
    results[7]?.meta.changes !== 1 ||
    results[8]?.meta.changes !== 1
  ) {
    throw new ApiError(
      409,
      "checkout_tax_state_changed",
      "Checkout changed while destination tax was calculated; refresh and try again",
    );
  }
  return taxQuoteResponse(
    {
      quoteId,
      checkoutToken: generated.token,
      calculation,
      chargedTotalMinor: calculation.totalMinor,
      mode: "enforced",
    },
    requestId,
  );
}

export function normalizeBillingAddress(input: Record<string, unknown>): BillingAddress {
  const country = requiredString(input, "country").trim().toUpperCase();
  const state = optionalLocationPart(input.state, 100)?.toUpperCase() ?? null;
  const postalCode = optionalLocationPart(input.postal_code, 20)?.toUpperCase() ?? null;
  if (!/^[A-Z]{2}$/.test(country)) {
    throw new ApiError(422, "invalid_billing_address", "Select a valid billing country");
  }
  if (country === "US" && (!state || !postalCode)) {
    throw new ApiError(
      422,
      "invalid_billing_address",
      "US billing addresses require state and ZIP code",
    );
  }
  if (["CA", "AU"].includes(country) && !state) {
    throw new ApiError(422, "invalid_billing_address", "State or province is required");
  }
  return { country, state, postalCode };
}

export async function requireAppliedCheckoutTaxQuote(
  database: D1Database,
  checkoutIntentId: string,
  quoteId: unknown,
  billingAddress: unknown,
): Promise<{ quoteId: string; billingAddressHash: string } | null> {
  if (typeof quoteId !== "string" || quoteId.length > 100) return null;
  if (!billingAddress || typeof billingAddress !== "object" || Array.isArray(billingAddress)) {
    return null;
  }
  const address = normalizeBillingAddress(billingAddress as Record<string, unknown>);
  const addressHash = await sha256Hex(stableJson(address));
  const row = await database
    .prepare(
      `SELECT id FROM easy_pay_direct_checkout_tax_quotes
       WHERE id = ? AND active_checkout_intent_id = ? AND billing_address_sha256 = ?
         AND status = 'applied' AND datetime(expires_at) > datetime('now') LIMIT 1`,
    )
    .bind(quoteId, checkoutIntentId, addressHash)
    .first<{ id: string }>();
  return row ? { quoteId: row.id, billingAddressHash: addressHash } : null;
}

export async function commitAppliedCheckoutTaxQuote(
  env: Env,
  executionId: string,
  providerTransactionId: string,
  fetcher: typeof fetch = fetch,
): Promise<"committed" | "not_applicable" | "retry"> {
  const quote = await env.BILLING_DB.prepare(
    `SELECT quote.id, quote.provider_code, quote.provider_calculation_id, quote.status
     FROM easy_pay_direct_payment_executions execution
     JOIN easy_pay_direct_checkout_tax_quotes quote ON quote.id = execution.tax_quote_id
     WHERE execution.id = ? AND execution.provider_transaction_id = ?
     LIMIT 1`,
  )
    .bind(executionId, providerTransactionId)
    .first<{
      id: string;
      provider_code: string;
      provider_calculation_id: string;
      status: string;
    }>();
  if (!quote) return "not_applicable";
  if (quote.status === "committed") return "committed";
  if (quote.status !== "applied" && quote.status !== "commit_failed") return "retry";
  if (quote.provider_code === "local_d1") {
    const now = new Date().toISOString();
    const result = await env.BILLING_DB.prepare(
      `UPDATE easy_pay_direct_checkout_tax_quotes
       SET status = 'committed', failure_code = NULL, committed_at = ?, updated_at = ?
       WHERE id = ? AND provider_code = 'local_d1'
         AND status IN ('applied', 'commit_failed')`,
    )
      .bind(now, now, quote.id)
      .run();
    return result.meta.changes === 1 ? "committed" : "retry";
  }
  if (quote.provider_code !== "stripe_test") return "retry";
  const key = env.STRIPE_RESTRICTED_API_KEY?.trim();
  if (!key || (!key.startsWith("rk_test_") && !key.startsWith("sk_test_"))) return "retry";
  const body = new URLSearchParams({
    calculation: quote.provider_calculation_id,
    reference: providerTransactionId.slice(0, 500),
  });
  let response: Response;
  try {
    response = await fetcher(STRIPE_TAX_TRANSACTIONS_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/x-www-form-urlencoded",
        "Idempotency-Key": `lago-epd-tax-commit-${quote.id}`.slice(0, 255),
      },
      body,
    });
  } catch {
    await markTaxCommitFailed(env.BILLING_DB, quote.id, "stripe_tax_commit_unavailable");
    return "retry";
  }
  const raw = await response.text();
  let payload: unknown;
  try {
    payload = raw.length <= MAX_STRIPE_RESPONSE_BYTES ? (JSON.parse(raw) as unknown) : null;
  } catch {
    payload = null;
  }
  const row =
    payload && typeof payload === "object" && !Array.isArray(payload)
      ? (payload as Record<string, unknown>)
      : null;
  if (
    !response.ok ||
    !row ||
    typeof row.id !== "string" ||
    !row.id.startsWith("tax_") ||
    row.livemode !== false
  ) {
    await markTaxCommitFailed(env.BILLING_DB, quote.id, "stripe_tax_commit_rejected");
    return "retry";
  }
  const now = new Date().toISOString();
  await env.BILLING_DB.prepare(
    `UPDATE easy_pay_direct_checkout_tax_quotes
     SET status = 'committed', failure_code = NULL, committed_at = ?, updated_at = ?
     WHERE id = ? AND status IN ('applied', 'commit_failed')`,
  )
    .bind(now, now, quote.id)
    .run();
  return "committed";
}

async function createStripeTaxCalculation(
  env: Env,
  input: {
    address: BillingAddress;
    currency: string;
    idempotencyKey: string;
    reference: string;
    subtotalMinor: number;
    taxCode: string;
  },
  fetcher: typeof fetch,
): Promise<TaxCalculation> {
  const key = env.STRIPE_RESTRICTED_API_KEY?.trim();
  if (!key || (!key.startsWith("rk_test_") && !key.startsWith("sk_test_"))) {
    throw new ApiError(
      503,
      "checkout_tax_test_key_required",
      "Stripe Tax test credentials are not configured",
    );
  }
  const body = new URLSearchParams({
    currency: input.currency.toLowerCase(),
    "customer_details[address][country]": input.address.country,
    "customer_details[address_source]": "billing",
    "line_items[0][amount]": String(input.subtotalMinor),
    "line_items[0][reference]": input.reference,
    "line_items[0][tax_behavior]": "exclusive",
    "line_items[0][tax_code]": input.taxCode,
  });
  if (input.address.state) body.set("customer_details[address][state]", input.address.state);
  if (input.address.postalCode) {
    body.set("customer_details[address][postal_code]", input.address.postalCode);
  }
  let response: Response;
  try {
    response = await fetcher(STRIPE_TAX_CALCULATIONS_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/x-www-form-urlencoded",
        "Idempotency-Key": input.idempotencyKey.slice(0, 255),
      },
      body,
    });
  } catch {
    throw new ApiError(503, "checkout_tax_unavailable", "Destination tax is unavailable");
  }
  const raw = await response.text();
  if (raw.length > MAX_STRIPE_RESPONSE_BYTES) {
    throw new ApiError(503, "checkout_tax_invalid_response", "Destination tax response is invalid");
  }
  let payload: unknown;
  try {
    payload = JSON.parse(raw) as unknown;
  } catch {
    payload = null;
  }
  if (!response.ok || !payload || typeof payload !== "object" || Array.isArray(payload)) {
    console.warn(
      JSON.stringify({
        event: "stripe_tax_calculation_rejected",
        status: response.status,
        ...stripeErrorDiagnostic(payload),
      }),
    );
    throw new ApiError(503, "checkout_tax_failed", "Destination tax could not be calculated");
  }
  const row = payload as Record<string, unknown>;
  const totalMinor = Number(row.amount_total);
  const expiresAtSeconds = Number(row.expires_at);
  if (
    typeof row.id !== "string" ||
    !row.id.startsWith("taxcalc_") ||
    row.currency !== input.currency.toLowerCase() ||
    row.livemode !== false ||
    !Number.isSafeInteger(totalMinor) ||
    totalMinor < input.subtotalMinor ||
    !Number.isSafeInteger(expiresAtSeconds) ||
    expiresAtSeconds * 1000 <= Date.now()
  ) {
    throw new ApiError(503, "checkout_tax_invalid_response", "Destination tax response is invalid");
  }
  return {
    id: row.id,
    providerCode: "stripe_test",
    currency: input.currency,
    subtotalMinor: input.subtotalMinor,
    taxMinor: totalMinor - input.subtotalMinor,
    totalMinor,
    expiresAt: new Date(expiresAtSeconds * 1000).toISOString(),
    localRuleSetId: null,
    localRuleId: null,
  };
}

async function createLocalTaxCalculation(
  env: Env,
  input: {
    address: BillingAddress;
    currency: string;
    organizationId: string;
    requestHash: string;
    subtotalMinor: number;
    taxCode: string;
  },
): Promise<TaxCalculation> {
  const calculation = await calculateLocalD1Tax(env.BILLING_DB, {
    address: input.address,
    currency: input.currency,
    maxDataAgeDays: env.EASY_PAY_DIRECT_TAX_MAX_DATA_AGE_DAYS,
    organizationId: input.organizationId,
    requestHash: input.requestHash,
    subtotalMinor: input.subtotalMinor,
    taxCode: input.taxCode,
  });
  return {
    ...calculation,
    providerCode: "local_d1",
    localRuleSetId: calculation.ruleSetId,
    localRuleId: calculation.ruleId,
  };
}

async function loadTaxableCheckout(
  database: D1Database,
  intentId: string,
  tokenHash: string,
): Promise<TaxableCheckout | null> {
  return database
    .prepare(
      `SELECT intent.id AS checkout_intent_id, intent.organization_id,
              intent.payment_request_id, intent.customer_id, intent.provider_account_code,
              intent.idempotency_key, intent.currency,
              intent.amount_minor AS intent_amount_minor,
              request.amount_minor AS request_amount_minor,
              request.version AS payment_request_version,
              invoice.id AS invoice_id, invoice.version AS invoice_version,
              invoice.subtotal_minor, invoice.tax_minor, invoice.credits_minor,
              invoice.total_due_minor,
              (SELECT plan.interval
               FROM invoice_subscriptions invoice_subscription
               JOIN subscriptions subscription
                 ON subscription.id = invoice_subscription.subscription_id
               JOIN plans plan ON plan.id = subscription.plan_id
               WHERE invoice_subscription.invoice_id = invoice.id
               ORDER BY invoice_subscription.created_at DESC LIMIT 1) AS plan_interval,
              (SELECT COUNT(*) FROM invoices_payment_requests counted
               WHERE counted.payment_request_id = request.id) AS invoice_count
       FROM payment_request_checkout_intents intent
       JOIN payment_requests request ON request.id = intent.payment_request_id
        AND request.organization_id = intent.organization_id
       JOIN invoices_payment_requests link ON link.payment_request_id = request.id
       JOIN invoices invoice ON invoice.id = link.invoice_id
        AND invoice.organization_id = intent.organization_id
       WHERE intent.id = ? AND intent.provider = 'easy_pay_direct'
         AND intent.provider_token_sha256 = ? AND intent.status = 'succeeded'
         AND request.collection_mode = 'checkout' AND request.payment_status = 'pending'
         AND request.ready_for_payment_processing = 1
         AND invoice.status = 'finalized' AND invoice.payment_status = 'pending'
         AND invoice.ready_for_payment_processing = 1
       LIMIT 1`,
    )
    .bind(intentId, tokenHash)
    .first<TaxableCheckout>();
}

function validateTaxableCheckout(
  checkout: TaxableCheckout | null,
): asserts checkout is TaxableCheckout {
  if (!checkout) {
    throw new ApiError(409, "checkout_tax_state_changed", "Checkout is no longer taxable");
  }
  if (
    checkout.invoice_count !== 1 ||
    checkout.intent_amount_minor !== checkout.request_amount_minor ||
    checkout.intent_amount_minor !== checkout.total_due_minor ||
    checkout.subtotal_minor - checkout.credits_minor <= 0
  ) {
    throw new ApiError(
      409,
      "checkout_tax_unsupported_balance",
      "Checkout balance cannot be repriced safely",
    );
  }
}

export function resolveCheckoutTaxCode(
  interval: string | null,
  env: Pick<Env, "EASY_PAY_DIRECT_TAX_CODE" | "EASY_PAY_DIRECT_ONE_TIME_TAX_CODE">,
): string {
  if (interval === "one_time") {
    return normalizeTaxCode(env.EASY_PAY_DIRECT_ONE_TIME_TAX_CODE, "one-time");
  }
  if (new Set(["weekly", "monthly", "quarterly", "yearly"]).has(interval ?? "")) {
    return normalizeTaxCode(env.EASY_PAY_DIRECT_TAX_CODE, "recurring");
  }
  throw new ApiError(
    409,
    "checkout_tax_classification_missing",
    "Checkout plan tax classification is unavailable",
  );
}

function normalizeTaxCode(value: string | undefined, classification: string): string {
  const normalized = value?.trim();
  if (!normalized || !/^txcd_\d{8}$/.test(normalized)) {
    throw new ApiError(
      503,
      "checkout_tax_code_missing",
      `${classification} checkout tax code is not configured`,
    );
  }
  return normalized;
}

function optionalLocationPart(value: unknown, maxLength: number): string | null {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string") {
    throw new ApiError(422, "invalid_billing_address", "Billing address is invalid");
  }
  const normalized = value.trim();
  if (!normalized || normalized.length > maxLength || hasControlCharacter(normalized)) {
    throw new ApiError(422, "invalid_billing_address", "Billing address is invalid");
  }
  return normalized;
}

function hasControlCharacter(value: string): boolean {
  return Array.from(value).some((character) => {
    const code = character.codePointAt(0) ?? 0;
    return code <= 31 || code === 127;
  });
}

function stripeErrorDiagnostic(payload: unknown): {
  stripeErrorCode: string | null;
  stripeErrorType: string | null;
  stripeErrorParam: string | null;
  stripeRequestLogUrl: string | null;
} {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return {
      stripeErrorCode: null,
      stripeErrorType: null,
      stripeErrorParam: null,
      stripeRequestLogUrl: null,
    };
  }
  const envelope = payload as Record<string, unknown>;
  const error =
    envelope.error && typeof envelope.error === "object" && !Array.isArray(envelope.error)
      ? (envelope.error as Record<string, unknown>)
      : null;
  return {
    stripeErrorCode: diagnosticString(error?.code, 100),
    stripeErrorType: diagnosticString(error?.type, 100),
    stripeErrorParam: diagnosticString(error?.param, 200),
    stripeRequestLogUrl: diagnosticString(error?.request_log_url, 1_000),
  };
}

function diagnosticString(value: unknown, maxLength: number): string | null {
  return typeof value === "string" && value.length <= maxLength ? value : null;
}

async function markTaxCommitFailed(database: D1Database, quoteId: string, code: string) {
  await database
    .prepare(
      `UPDATE easy_pay_direct_checkout_tax_quotes
       SET status = 'commit_failed', failure_code = ?, updated_at = ?
       WHERE id = ? AND status IN ('applied', 'commit_failed')`,
    )
    .bind(code, new Date().toISOString(), quoteId)
    .run();
}

function taxQuoteResponse(
  input: {
    quoteId: string;
    checkoutToken: string;
    calculation: TaxCalculation;
    chargedTotalMinor: number;
    mode: "shadow" | "enforced";
  },
  requestId: string,
): Response {
  return json(
    {
      tax_quote: {
        id: input.quoteId,
        checkout: input.checkoutToken,
        currency: input.calculation.currency,
        subtotal_cents: input.calculation.subtotalMinor,
        tax_cents: input.calculation.taxMinor,
        total_cents: input.calculation.totalMinor,
        charged_total_cents: input.chargedTotalMinor,
        mode: input.mode,
        expires_at: input.calculation.expiresAt,
      },
    },
    { requestId },
  );
}
