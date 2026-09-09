import { sha256Hex } from "../auth/api-key";
import {
  normalizeBillingAddress,
  resolveCheckoutTaxCode,
  type BillingAddress,
} from "../api/easy-pay-direct-tax";
import type { DomainEvent } from "../domain-events";
import { deterministicUuid } from "../identifiers";
import { ApiError } from "../http";
import {
  requireEasyPayDirectOrderEvidence,
  hasSuccessfulEasyPayDirectPayment,
} from "./easy-pay-direct-order-evidence";
import { stableJson } from "../json";
import {
  chargeEasyPayDirectStoredMethod,
  findEasyPayDirectGatewayTransactionByOrderId,
  type GatewayTransactionResult,
} from "../providers/easy-pay-direct";
import { reconcilePaymentRequest, type PendingReceipt } from "../reconciliation/authorize-net";
import { decryptBillingAddress } from "../tax/billing-address-vault";
import { calculateLocalD1Tax } from "../tax/local-d1";
import { checkoutTaxSnapshotStatements } from "../tax/checkout-tax-snapshots";
import { NO_IN_FLIGHT_EPD_PAYMENT_FOR_INVOICE_SQL } from "./easy-pay-direct-in-flight";
import { easyPayDirectOutstandingInvoiceBalanceSql } from "./easy-pay-direct-recovery-policy";
import {
  chargeCommerceRenewal,
  readCommerceRenewal,
  commerceRenewalSandboxAllowed,
} from "./easy-pay-direct-commerce-renewal";

type RenewalCandidate = {
  invoice_id: string;
  organization_id: string;
  customer_id: string;
  subscription_id: string;
  customer_email: string | null;
  provider_account_code: string;
  currency: string;
  subtotal_minor: number;
  tax_minor: number;
  credits_minor: number;
  total_due_minor: number;
  invoice_version: number;
  plan_interval: string;
  provider_profile_id: string;
  gateway_customer_vault_id: string | null;
  initial_transaction_id: string | null;
  payment_backend: "gateway_vault" | "commerce_elements";
  provider_customer_id: string;
  provider_payment_method_id: string | null;
};

type AutomaticExecution = {
  id: string;
  organization_id: string;
  payment_request_id: string;
  customer_id: string;
  provider_profile_id: string;
  provider_account_code: string;
  request_sha256: string;
  gateway_customer_vault_id: string | null;
  initial_transaction_id: string | null;
  payment_backend: "gateway_vault" | "commerce_elements";
  commerce_customer_id: string | null;
  commerce_payment_method_id: string | null;
  product_idempotency_key: string | null;
  order_idempotency_key: string | null;
  commerce_product_id: string | null;
  commerce_order_id: string | null;
  order_submit_started_at: string | null;
  order_reference: string;
  status: "pending" | "processing" | "succeeded" | "failed" | "unknown";
  provider_transaction_id: string | null;
  failure_code: string | null;
  failure_message: string | null;
  amount_minor: number;
  currency: string;
};

type SourceTaxQuote = {
  id: string;
  tax_code: string;
  billing_address_sha256: string;
  billing_country: string;
  billing_state: string | null;
  billing_postal_code: string | null;
  local_calculation_method: "static" | "wa_dor_address" | null;
  billing_address_ciphertext: string | null;
  billing_address_iv: string | null;
  billing_address_key_id: string | null;
};

export type AutomaticCollectionOutcome = "processed" | "deferred" | "not_applicable";
import {
  automaticCollectionScopeMode,
  configuredAutomaticCollectionScope,
  productPolicyEligibilitySql,
  recurringSubscriptionEligibilitySql,
  savedProfileEligibilitySql,
  type CollectionScopeMode,
} from "./easy-pay-direct-renewal-eligibility";

// Only proven paid checkouts can enroll; neither shared plans nor a customer's
// latest metadata authorize another subscription. Operator-disabled scopes stay off.
export async function enrollProductScopedAutomaticCollections(
  database: D1Database,
  configuredScope: { organizationId: string; accountCode: string },
): Promise<number> {
  if (!configuredScope.organizationId.trim() || !configuredScope.accountCode.trim()) return 0;
  const now = new Date().toISOString();
  const result = await database
    .prepare(`
    INSERT INTO easy_pay_direct_automatic_collection_scopes
      (subscription_id, organization_id, status, reason, created_at, updated_at)
    SELECT subscription.id, subscription.organization_id, 'enabled',
      'paid product-scoped checkout', ?, ?
    FROM subscriptions subscription
    JOIN plans plan ON plan.id = subscription.plan_id AND plan.organization_id = subscription.organization_id
    JOIN customers customer ON customer.id = subscription.customer_id AND customer.organization_id = subscription.organization_id
    JOIN provider_customer_profiles profile ON profile.id = subscription.payment_method_id
      AND profile.organization_id = subscription.organization_id AND profile.customer_id = subscription.customer_id
      AND profile.provider = 'easy_pay_direct' AND profile.status = 'active'
    JOIN payment_request_checkout_intents intent ON intent.id = profile.checkout_intent_id
      AND intent.organization_id = subscription.organization_id AND intent.customer_id = subscription.customer_id
      AND intent.provider = 'easy_pay_direct'
    JOIN payment_requests request ON request.id = intent.payment_request_id
      AND request.organization_id = subscription.organization_id AND request.customer_id = subscription.customer_id
      AND request.payment_status = 'succeeded'
    JOIN easy_pay_direct_payment_executions execution ON execution.checkout_intent_id = intent.id
      AND execution.organization_id = subscription.organization_id
      AND execution.status = 'succeeded' AND execution.terms_accepted_at IS NOT NULL
    WHERE subscription.status IN ('active', 'past_due') AND subscription.payment_method_type = 'provider'
      AND subscription.organization_id = ? AND profile.provider_account_code = ?
      AND plan.interval IN ('weekly', 'monthly', 'quarterly', 'yearly')
      AND ${savedProfileEligibilitySql()}
      AND customer.payment_provider = 'easy_pay_direct'
      AND profile.provider_account_code = COALESCE(customer.payment_provider_code, 'default')
      AND ${productPolicyEligibilitySql("product_scoped")}
      AND NOT EXISTS (SELECT 1 FROM customer_closure_holds hold WHERE hold.customer_id = customer.id)
      AND NOT EXISTS (SELECT 1 FROM customer_closure_email_holds hold WHERE hold.organization_id = customer.organization_id AND hold.email = lower(customer.email))
      AND EXISTS (
        SELECT 1 FROM invoices_payment_requests link
        JOIN invoices invoice ON invoice.id = link.invoice_id AND invoice.organization_id = subscription.organization_id
        JOIN subscription_invoice_contexts context ON context.invoice_id = invoice.id AND context.context_type = 'initial'
        WHERE link.payment_request_id = request.id AND link.organization_id = subscription.organization_id
          AND invoice.subscription_id = subscription.id AND invoice.customer_id = subscription.customer_id
          AND invoice.payment_status = 'succeeded' AND invoice.status = 'finalized'
      )
    ON CONFLICT(subscription_id) DO NOTHING
  `)
    .bind(now, now, configuredScope.organizationId, configuredScope.accountCode)
    .run();
  return result.meta.changes;
}

export async function prepareEasyPayDirectAutomaticCollection(
  env: Env,
  invoiceId: string,
  correlationId: string,
  fetcher: typeof fetch = fetch,
): Promise<AutomaticCollectionOutcome> {
  if (!automaticCollectionEnabled(env)) return "not_applicable";
  const configuredScope = configuredAutomaticCollectionScope(env);
  if (!configuredScope) return "not_applicable";
  const existing = await executionForInvoice(env.BILLING_DB, invoiceId, configuredScope);
  if (existing) return "processed";
  const candidate = await loadRenewalCandidate(
    env.BILLING_DB,
    invoiceId,
    automaticCollectionScopeMode(env),
  );
  if (
    !candidate ||
    candidate.organization_id !== configuredScope.organizationId ||
    candidate.provider_account_code !== configuredScope.accountCode
  )
    return "not_applicable";

  const now = new Date().toISOString();
  let amountMinor = candidate.total_due_minor;
  let invoiceVersion = candidate.invoice_version;
  const statements: D1PreparedStatement[] = [];

  if (env.EASY_PAY_DIRECT_TAX_MODE === "enforced") {
    if (env.EASY_PAY_DIRECT_TAX_PROVIDER !== "local_d1") {
      throw new ApiError(
        503,
        "easy_pay_direct_automatic_tax_provider_unsupported",
        "easy_pay_direct_automatic_tax_provider_unsupported",
      );
    }
    const source = await latestCommittedTaxQuote(env.BILLING_DB, candidate);
    if (!source)
      throw new ApiError(
        503,
        "easy_pay_direct_automatic_tax_address_missing",
        "easy_pay_direct_automatic_tax_address_missing",
      );
    const address = await automaticTaxAddress(env, source);
    const taxableSubtotal = candidate.subtotal_minor - candidate.credits_minor;
    if (!Number.isSafeInteger(taxableSubtotal) || taxableSubtotal <= 0) {
      throw new Error("easy_pay_direct_automatic_tax_subtotal_invalid");
    }
    const taxCode = resolveCheckoutTaxCode(JSON.stringify([source.tax_code]));
    const requestHash = await sha256Hex(
      stableJson({
        address_sha256: source.billing_address_sha256,
        currency: candidate.currency,
        invoice_id: candidate.invoice_id,
        subtotal_minor: taxableSubtotal,
        tax_code: taxCode,
      }),
    );
    const calculation = await calculateLocalD1Tax(env.BILLING_DB, {
      address,
      currency: candidate.currency,
      fetcher,
      maxDataAgeDays: env.EASY_PAY_DIRECT_TAX_MAX_DATA_AGE_DAYS,
      organizationId: candidate.organization_id,
      requestHash,
      subtotalMinor: taxableSubtotal,
      taxCode,
      confirmedAddress: source.local_calculation_method === "wa_dor_address",
    });
    const quoteId = await deterministicUuid(
      "easy-pay-direct-automatic-tax",
      `${candidate.organization_id}:${candidate.invoice_id}:${calculation.id}`,
    );
    statements.push(
      env.BILLING_DB.prepare(
        `INSERT INTO easy_pay_direct_automatic_tax_quotes
         (id, organization_id, invoice_id, source_checkout_tax_quote_id,
          local_rule_set_id, local_rule_id, request_sha256, billing_address_sha256,
          billing_country, billing_state, billing_postal_code, local_calculation_method,
          rate_location_code, rate_jurisdiction, rate_period, rate_valid_through,
          state_rate_ppm, local_rate_ppm, currency, subtotal_minor,
          tax_minor, total_minor, tax_code, local_collection_mode, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(
        quoteId,
        candidate.organization_id,
        candidate.invoice_id,
        source.id,
        calculation.ruleSetId,
        calculation.ruleId,
        requestHash,
        source.billing_address_sha256,
        source.billing_country,
        source.billing_state,
        source.billing_postal_code,
        calculation.calculationMethod,
        calculation.rateResolution?.locationCode ?? null,
        calculation.rateResolution?.jurisdiction ?? null,
        calculation.rateResolution?.period ?? null,
        calculation.rateResolution?.validThrough ?? null,
        calculation.rateResolution?.stateRatePpm ?? null,
        calculation.rateResolution?.localRatePpm ?? null,
        candidate.currency,
        calculation.subtotalMinor,
        calculation.taxMinor,
        calculation.totalMinor,
        taxCode,
        calculation.collectionMode,
        now,
        now,
      ),
      env.BILLING_DB.prepare(
        `UPDATE invoices
         SET tax_minor = ?, total_due_minor = ?, version = version + 1, updated_at = ?
         WHERE id = ? AND organization_id = ? AND version = ?
           AND status = 'finalized' AND payment_status = 'pending'
           AND ready_for_payment_processing = 1`,
      ).bind(
        calculation.taxMinor,
        calculation.totalMinor,
        now,
        candidate.invoice_id,
        candidate.organization_id,
        candidate.invoice_version,
      ),
    );
    statements.push(
      ...(await checkoutTaxSnapshotStatements(env.BILLING_DB, {
        organizationId: candidate.organization_id,
        invoiceId: candidate.invoice_id,
        quoteId,
        ruleId: calculation.ruleId,
        country: source.billing_country,
        collectionMode: calculation.collectionMode,
        rateResolution: calculation.rateResolution ?? null,
        subtotalMinor: calculation.subtotalMinor,
        taxMinor: calculation.taxMinor,
        currency: candidate.currency,
        now,
      })),
    );
    amountMinor = calculation.totalMinor;
    invoiceVersion += 1;
  }

  if (!Number.isSafeInteger(amountMinor) || amountMinor <= 0) {
    throw new Error("easy_pay_direct_automatic_amount_invalid");
  }
  const paymentRequestId = await deterministicUuid(
    "easy-pay-direct-automatic-payment-request",
    `${candidate.organization_id}:${candidate.invoice_id}`,
  );
  const executionId = await deterministicUuid(
    "easy-pay-direct-automatic-execution",
    `${candidate.organization_id}:${paymentRequestId}`,
  );
  const linkId = await deterministicUuid(
    "invoice-payment-request",
    `${candidate.organization_id}:${paymentRequestId}:${candidate.invoice_id}`,
  );
  const requestHash = await sha256Hex(
    stableJson({
      amount_minor: amountMinor,
      currency: candidate.currency,
      invoice_id: candidate.invoice_id,
      payment_request_id: paymentRequestId,
      profile_id: candidate.provider_profile_id,
    }),
  );
  const event = paymentRequestCreatedEvent(
    candidate,
    paymentRequestId,
    amountMinor,
    correlationId,
    now,
  );
  statements.push(
    env.BILLING_DB.prepare(
      `INSERT INTO payment_requests
       (id, organization_id, customer_id, amount_minor, currency, email, payment_attempts,
        payment_status, ready_for_payment_processing, version, source, collection_mode,
        created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 0, 'pending', 1, 1, 'manual', 'checkout', ?, ?)`,
    ).bind(
      paymentRequestId,
      candidate.organization_id,
      candidate.customer_id,
      amountMinor,
      candidate.currency,
      candidate.customer_email,
      now,
      now,
    ),
    env.BILLING_DB.prepare(
      `INSERT INTO invoices_payment_requests
       (id, organization_id, payment_request_id, invoice_id, invoice_version, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      linkId,
      candidate.organization_id,
      paymentRequestId,
      candidate.invoice_id,
      invoiceVersion,
      now,
      now,
    ),
    env.BILLING_DB.prepare(
      `INSERT INTO easy_pay_direct_automatic_payment_executions
       (id, organization_id, payment_request_id, customer_id, provider_profile_id,
        provider_account_code, request_sha256, gateway_customer_vault_id,
        initial_transaction_id, order_reference, status, created_at, updated_at,
        payment_backend, commerce_customer_id, commerce_payment_method_id, product_idempotency_key, order_idempotency_key, charge_transport)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      executionId,
      candidate.organization_id,
      paymentRequestId,
      candidate.customer_id,
      candidate.provider_profile_id,
      candidate.provider_account_code,
      requestHash,
      candidate.gateway_customer_vault_id,
      candidate.initial_transaction_id,
      paymentRequestId,
      now,
      now,
      candidate.payment_backend,
      candidate.payment_backend === "commerce_elements" ? candidate.provider_customer_id : null,
      candidate.payment_backend === "commerce_elements"
        ? candidate.provider_payment_method_id
        : null,
      candidate.payment_backend === "commerce_elements" ? crypto.randomUUID() : null,
      candidate.payment_backend === "commerce_elements" ? crypto.randomUUID() : null,
      candidate.payment_backend === "commerce_elements" ? "commerce" : "gateway",
    ),
    outboxStatement(env.BILLING_DB, candidate.organization_id, event),
  );
  await env.BILLING_DB.batch(statements);
  await env.DOMAIN_EVENTS.send(event);
  return "processed";
}

export async function processEasyPayDirectAutomaticCollection(
  env: Env,
  paymentRequestId: string,
  fetcher: typeof fetch = fetch,
): Promise<AutomaticCollectionOutcome> {
  if (!automaticCollectionEnabled(env)) return "not_applicable";
  const configuredScope = configuredAutomaticCollectionScope(env);
  if (!configuredScope) return "not_applicable";
  let execution = await loadExecution(env.BILLING_DB, paymentRequestId);
  if (!execution) {
    await prepareEasyPayDirectDunningCollection(env, paymentRequestId);
    execution = await loadExecution(env.BILLING_DB, paymentRequestId);
  }
  if (!execution) return "not_applicable";
  if (
    execution.organization_id !== configuredScope.organizationId ||
    execution.provider_account_code !== configuredScope.accountCode
  )
    return "not_applicable";
  if (execution.status === "succeeded" || execution.status === "failed") return "processed";
  // A processing lease expiring does not prove that the gateway rejected the charge.
  // Both states are reconciled by provider reads, never by another submission.
  if (execution.status === "unknown" || execution.status === "processing") return "deferred";
  if (String(env.PAYMENT_MUTATIONS_ENABLED) !== "1") return "deferred";
  if (execution.payment_backend === "commerce_elements" && !commerceRenewalSandboxAllowed(env))
    return "deferred";

  const now = new Date();
  const leaseExpiresAt = new Date(now.getTime() + 2 * 60 * 1000).toISOString();
  const claimed = await env.BILLING_DB.prepare(
    `UPDATE easy_pay_direct_automatic_payment_executions
     SET status = 'processing', attempt_count = attempt_count + 1,
         lease_expires_at = ?, updated_at = ?
     WHERE id = ? AND status = 'pending' AND EXISTS (
       SELECT 1 FROM customers customer WHERE customer.id = easy_pay_direct_automatic_payment_executions.customer_id
       AND customer.organization_id = easy_pay_direct_automatic_payment_executions.organization_id
       AND customer.payment_provider = 'easy_pay_direct'
       AND COALESCE(customer.payment_provider_code, 'default') = easy_pay_direct_automatic_payment_executions.provider_account_code
       AND NOT EXISTS (SELECT 1 FROM customer_closure_holds h WHERE h.customer_id = customer.id)
       AND NOT EXISTS (SELECT 1 FROM customer_closure_email_holds h WHERE h.organization_id = customer.organization_id AND h.email = lower(customer.email))
     ) AND EXISTS (
       SELECT 1 FROM payment_requests request
       JOIN provider_customer_profiles profile
         ON profile.id = easy_pay_direct_automatic_payment_executions.provider_profile_id
        AND profile.organization_id = request.organization_id
        AND profile.customer_id = request.customer_id
        AND profile.provider = 'easy_pay_direct' AND profile.status = 'active'
        AND profile.provider_account_code = easy_pay_direct_automatic_payment_executions.provider_account_code
        AND profile.payment_backend = easy_pay_direct_automatic_payment_executions.payment_backend
        AND ((profile.payment_backend = 'gateway_vault'
          AND profile.gateway_customer_vault_id = easy_pay_direct_automatic_payment_executions.gateway_customer_vault_id
          AND profile.initial_transaction_id = easy_pay_direct_automatic_payment_executions.initial_transaction_id)
         OR (profile.payment_backend = 'commerce_elements'
          AND profile.provider_customer_id = easy_pay_direct_automatic_payment_executions.commerce_customer_id
          AND profile.provider_payment_method_id = easy_pay_direct_automatic_payment_executions.commerce_payment_method_id))
        AND ${savedProfileEligibilitySql()}
       WHERE request.id = easy_pay_direct_automatic_payment_executions.payment_request_id
         AND request.payment_status = 'pending' AND request.ready_for_payment_processing = 1
         AND ${recurringInvoiceEligibilitySql(automaticCollectionScopeMode(env))}
     )
     RETURNING id`,
  )
    .bind(leaseExpiresAt, now.toISOString(), execution.id, automaticCollectionScopeMode(env))
    .first<{ id: string }>();
  if (!claimed) return "deferred";

  let transaction: GatewayTransactionResult;
  try {
    if (execution.payment_backend === "commerce_elements") {
      transaction = await chargeCommerceRenewal(env, execution, fetcher);
    } else {
      const method = await env.BILLING_DB.prepare(
        "SELECT gateway_billing_id FROM provider_customer_profiles WHERE id = ? AND organization_id = ?",
      )
        .bind(execution.provider_profile_id, execution.organization_id)
        .first<{ gateway_billing_id: string | null }>();
      if (!method) throw new Error("easy_pay_direct_renewal_profile_missing");
      transaction = await chargeEasyPayDirectStoredMethod(
        env,
        {
          amountMinor: execution.amount_minor,
          currency: execution.currency,
          customerVaultId: execution.gateway_customer_vault_id!,
          billingId: method.gateway_billing_id,
          initialTransactionId: execution.initial_transaction_id!,
          orderId: execution.order_reference,
          orderDescription: `SERP subscription renewal ${execution.payment_request_id}`,
          idempotencyKey: execution.request_sha256,
        },
        fetcher,
      );
    }
  } catch {
    await markUnknown(env.BILLING_DB, execution.id, "easy_pay_direct_gateway_outcome_unknown");
    return "deferred";
  }
  if (execution.payment_backend !== "commerce_elements") {
    if (transaction.id?.trim() === "0") transaction = { ...transaction, id: null };
    const successfulHttp =
      transaction.httpStatus !== undefined &&
      transaction.httpStatus >= 200 &&
      transaction.httpStatus < 300;
    const definitiveFailure =
      !transaction.authCode &&
      ((transaction.rawStatus === "2" && /^2\d{2}$/u.test(transaction.responseCode ?? "")) ||
        (transaction.rawStatus === "3" && transaction.responseCode === "300" && !transaction.id));
    // Communication errors, duplicate responses and malformed status tuples are
    // not declines. Keep the shared invoice locked until a provider GET resolves
    // them; otherwise dunning could create a second charge. Do not persist code
    // 300 here: legacy invalid-vault recovery interprets that as definitive.
    if (!successfulHttp || (transaction.status === "failed" && !definitiveFailure)) {
      await markUnknown(
        env.BILLING_DB,
        execution.id,
        "easy_pay_direct_gateway_outcome_unknown",
        transaction.responseText,
      );
      return "deferred";
    }
  }
  if (transaction.orderId && transaction.orderId !== execution.order_reference) {
    await markUnknown(env.BILLING_DB, execution.id, "easy_pay_direct_order_identity_mismatch");
    return "deferred";
  }
  if (transaction.status === "unknown" || (transaction.status === "succeeded" && !transaction.id)) {
    await markUnknown(
      env.BILLING_DB,
      execution.id,
      execution.payment_backend === "commerce_elements"
        ? (transaction.responseCode ?? "easy_pay_direct_gateway_outcome_unknown")
        : "easy_pay_direct_gateway_outcome_unknown",
      transaction.responseText,
    );
    return "deferred";
  }
  if (execution.payment_backend !== "commerce_elements" && transaction.status === "succeeded") {
    // An approval response carries no trustworthy amount/currency. Persist the
    // exact charge identity before querying; a lost read must NEVER repeat sale.
    await env.BILLING_DB.prepare(`UPDATE easy_pay_direct_automatic_payment_executions
      SET provider_transaction_id = ?, status = 'unknown', lease_expires_at = NULL,
          failure_code = 'easy_pay_direct_approval_requires_evidence', updated_at = ?
      WHERE id = ? AND status = 'processing'
        AND (provider_transaction_id IS NULL OR provider_transaction_id = ?)`)
      .bind(transaction.id, new Date().toISOString(), execution.id, transaction.id)
      .run();
    return reconcileEasyPayDirectAutomaticCollection(env, execution.id, fetcher);
  }
  await reconcileAutomaticOutcome(env, execution, transaction);
  return "processed";
}

async function prepareEasyPayDirectDunningCollection(
  env: Env,
  paymentRequestId: string,
): Promise<void> {
  const configuredScope = configuredAutomaticCollectionScope(env);
  if (!configuredScope) return;
  const row = await env.BILLING_DB.prepare(
    `SELECT request.id AS payment_request_id, request.organization_id, request.customer_id,
              request.amount_minor, request.currency,
              COALESCE(customer.payment_provider_code, 'default') AS provider_account_code,
              profile.id AS provider_profile_id, profile.gateway_customer_vault_id,
              profile.initial_transaction_id, profile.payment_backend, profile.provider_customer_id, profile.provider_payment_method_id
       FROM payment_requests request
       JOIN customers customer ON customer.id = request.customer_id
        AND customer.organization_id = request.organization_id
       JOIN provider_customer_profiles profile
         ON profile.organization_id = request.organization_id
        AND profile.customer_id = request.customer_id
        AND profile.provider = 'easy_pay_direct'
        AND profile.provider_account_code = COALESCE(customer.payment_provider_code, 'default')
        AND profile.status = 'active'
       WHERE request.id = ? AND request.source = 'dunning'
         AND request.organization_id = ? AND profile.provider_account_code = ?
         AND request.payment_status = 'pending' AND request.ready_for_payment_processing = 1
         AND customer.payment_provider = 'easy_pay_direct'
         AND ${savedProfileEligibilitySql()}
         AND ${recurringInvoiceEligibilitySql(automaticCollectionScopeMode(env))}
       LIMIT 1`,
  )
    .bind(
      paymentRequestId,
      configuredScope.organizationId,
      configuredScope.accountCode,
      automaticCollectionScopeMode(env),
    )
    .first<{
      payment_request_id: string;
      organization_id: string;
      customer_id: string;
      amount_minor: number;
      currency: string;
      provider_account_code: string;
      provider_profile_id: string;
      gateway_customer_vault_id: string | null;
      initial_transaction_id: string | null;
      payment_backend: "gateway_vault" | "commerce_elements";
      provider_customer_id: string;
      provider_payment_method_id: string | null;
    }>();
  if (!row) return;
  const executionId = await deterministicUuid(
    "easy-pay-direct-automatic-execution",
    `${row.organization_id}:${row.payment_request_id}`,
  );
  const requestHash = await sha256Hex(
    stableJson({
      amount_minor: row.amount_minor,
      currency: row.currency,
      payment_request_id: row.payment_request_id,
      profile_id: row.provider_profile_id,
      source: "dunning",
    }),
  );
  const now = new Date().toISOString();
  await env.BILLING_DB.prepare(
    `INSERT INTO easy_pay_direct_automatic_payment_executions
       (id, organization_id, payment_request_id, customer_id, provider_profile_id,
        provider_account_code, request_sha256, gateway_customer_vault_id,
        initial_transaction_id, order_reference, status, created_at, updated_at,
        payment_backend, commerce_customer_id, commerce_payment_method_id, product_idempotency_key, order_idempotency_key, charge_transport)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(payment_request_id) DO NOTHING`,
  )
    .bind(
      executionId,
      row.organization_id,
      row.payment_request_id,
      row.customer_id,
      row.provider_profile_id,
      row.provider_account_code,
      requestHash,
      row.gateway_customer_vault_id,
      row.initial_transaction_id,
      row.payment_request_id,
      now,
      now,
      row.payment_backend,
      row.payment_backend === "commerce_elements" ? row.provider_customer_id : null,
      row.payment_backend === "commerce_elements" ? row.provider_payment_method_id : null,
      row.payment_backend === "commerce_elements" ? crypto.randomUUID() : null,
      row.payment_backend === "commerce_elements" ? crypto.randomUUID() : null,
      row.payment_backend === "commerce_elements" ? "commerce" : "gateway",
    )
    .run();
}

// Every linked invoice must be eligible; one scoped invoice must not authorize a
// mixed request containing unscoped or one-time purchases.
function recurringInvoiceEligibilitySql(mode: CollectionScopeMode): string {
  return `${easyPayDirectOutstandingInvoiceBalanceSql("request")} AND EXISTS (
    SELECT 1 FROM invoices_payment_requests link WHERE link.payment_request_id = request.id
  ) AND NOT EXISTS (
    SELECT 1 FROM invoices_payment_requests link
    LEFT JOIN invoices invoice ON invoice.id = link.invoice_id
      AND invoice.organization_id = request.organization_id
      AND invoice.customer_id = request.customer_id
    LEFT JOIN subscriptions subscription ON subscription.id = invoice.subscription_id
      AND subscription.organization_id = request.organization_id
      AND subscription.customer_id = request.customer_id
    LEFT JOIN plans plan ON plan.id = subscription.plan_id
      AND plan.organization_id = request.organization_id
    WHERE link.payment_request_id = request.id AND (
      link.organization_id IS NOT request.organization_id
      OR invoice.id IS NULL OR subscription.id IS NULL OR plan.id IS NULL
      OR invoice.status IS NOT 'finalized' OR invoice.payment_status = 'succeeded'
      OR invoice.ready_for_payment_processing IS NOT 1
      OR invoice.version IS NOT link.invoice_version OR invoice.currency IS NOT request.currency
      OR NOT (${NO_IN_FLIGHT_EPD_PAYMENT_FOR_INVOICE_SQL})
      OR NOT COALESCE((${recurringSubscriptionEligibilitySql(mode)}), 0)
    )
  )`;
}

export async function reconcileEasyPayDirectAutomaticCollection(
  env: Env,
  executionId: string,
  fetcher: typeof fetch = fetch,
): Promise<AutomaticCollectionOutcome> {
  const execution = await loadExecutionById(env.BILLING_DB, executionId);
  const configuredScope = configuredAutomaticCollectionScope(env);
  if (
    !configuredScope ||
    (execution &&
      (execution.organization_id !== configuredScope.organizationId ||
        execution.provider_account_code !== configuredScope.accountCode))
  )
    return "not_applicable";
  if (!execution || execution.status === "succeeded" || execution.status === "failed") {
    return "processed";
  }
  if (
    execution.status === "unknown" &&
    execution.payment_backend === "gateway_vault" &&
    execution.provider_transaction_id === null &&
    isInvalidCustomerVaultFailure(execution.failure_code, execution.failure_message)
  ) {
    await reconcileAutomaticOutcome(env, execution, {
      id: null,
      status: "failed",
      responseCode: execution.failure_code,
      responseText: execution.failure_message ?? "Invalid Customer Vault ID",
      authCode: null,
      orderId: execution.order_reference,
      customerVaultId: execution.gateway_customer_vault_id,
      rawStatus: null,
    });
    return "processed";
  }
  if (String(env.PROVIDER_READS_ENABLED) !== "1") return "deferred";
  // Record the attempt before the network wait, including outages. The queue
  // orders by updated_at, so an unavailable order must not monopolize its slot.
  await env.BILLING_DB.prepare(
    `UPDATE easy_pay_direct_automatic_payment_executions
     SET last_provider_read_at = ?, updated_at = ? WHERE id = ?`,
  )
    .bind(new Date().toISOString(), new Date().toISOString(), execution.id)
    .run();
  let transaction;
  try {
    if (execution.payment_backend === "commerce_elements") {
      transaction = await readCommerceRenewal(env, execution, fetcher);
      if (!transaction || transaction.status === "unknown") return "deferred";
    } else {
      transaction = await findEasyPayDirectGatewayTransactionByOrderId(
        env,
        execution.order_reference,
        fetcher,
      );
      if (!transaction || transaction.status === "unknown") return "deferred";
      await requireEasyPayDirectOrderEvidence(
        env.BILLING_DB,
        execution.organization_id,
        execution.payment_request_id,
        { id: transaction.id, total: transaction.amountMinor, currency: transaction.currency },
        execution.provider_transaction_id ?? transaction.id!,
      );
    }
  } catch (error) {
    if (!(error instanceof ApiError)) throw error;
    await env.BILLING_DB.prepare(
      `UPDATE easy_pay_direct_automatic_payment_executions
       SET failure_code = ?, failure_message = ?
       WHERE id = ? AND status IN ('processing', 'unknown')`,
    )
      .bind(
        error.code,
        "Renewal outcome needs a verified provider read; do not resubmit",
        execution.id,
      )
      .run();
    return "deferred";
  }
  await reconcileAutomaticOutcome(env, execution, transaction);
  return "processed";
}

export async function dispatchPendingEasyPayDirectAutomaticCollections(
  env: Env,
  correlationId: string,
): Promise<number> {
  if (!automaticCollectionEnabled(env)) return 0;
  const configuredScope = configuredAutomaticCollectionScope(env);
  if (!configuredScope) return 0;
  await enrollProductScopedAutomaticCollections(env.BILLING_DB, configuredScope);
  const invoiceIds = await pendingEasyPayDirectAutomaticCollectionInvoices(
    env.BILLING_DB,
    automaticCollectionScopeMode(env),
    configuredScope,
  );
  let dispatched = await redispatchPendingEasyPayDirectAutomaticCollections(env, correlationId);
  for (const invoiceId of invoiceIds) {
    try {
      if (
        (await prepareEasyPayDirectAutomaticCollection(env, invoiceId, correlationId)) ===
        "processed"
      )
        dispatched += 1;
    } catch (error) {
      if (!(error instanceof ApiError)) throw error;
      // A tax/address prerequisite failure is local to this invoice. Rotate it
      // durably without changing money or version so later invoices can proceed.
      // Unexpected database/programming failures still abort the operation.
      await env.BILLING_DB.prepare(
        `UPDATE invoices SET updated_at = ?
         WHERE id = ? AND status = 'finalized' AND payment_status = 'pending'
           AND NOT EXISTS (SELECT 1 FROM invoices_payment_requests link WHERE link.invoice_id = invoices.id)`,
      )
        .bind(new Date().toISOString(), invoiceId)
        .run();
      console.warn(
        JSON.stringify({
          level: "warn",
          event: "easy_pay_direct_automatic_collection_deferred",
          code: error.code,
        }),
      );
    }
  }
  return dispatched;
}

// A disabled consumer can acknowledge the original event without claiming the
// execution. Recover only never-submitted pending work, with a new event identity
// because the original may already be in processed_messages. The existing atomic
// charge claim rechecks every current eligibility and shared-invoice guard.
export async function redispatchPendingEasyPayDirectAutomaticCollections(
  env: Env,
  correlationId: string,
): Promise<number> {
  if (!automaticCollectionEnabled(env) || String(env.PAYMENT_MUTATIONS_ENABLED) !== "1") return 0;
  const configuredScope = configuredAutomaticCollectionScope(env);
  if (!configuredScope) return 0;
  const cutoff = new Date(Date.now() - 5 * 60_000).toISOString();
  const candidates = await env.BILLING_DB.prepare(
    `SELECT execution.id, execution.organization_id, execution.payment_request_id,
            execution.updated_at, request.customer_id, request.amount_minor, request.currency,
            (SELECT json_group_array(link.invoice_id) FROM invoices_payment_requests link
             WHERE link.organization_id = execution.organization_id
               AND link.payment_request_id = execution.payment_request_id) AS invoice_ids_json
     FROM easy_pay_direct_automatic_payment_executions execution
     JOIN payment_requests request ON request.id = execution.payment_request_id
       AND request.organization_id = execution.organization_id
     WHERE execution.status = 'pending' AND julianday(execution.updated_at) <= julianday(?)
       AND execution.organization_id = ? AND execution.provider_account_code = ?
     ORDER BY julianday(execution.updated_at), execution.id LIMIT 100`,
  )
    .bind(cutoff, configuredScope.organizationId, configuredScope.accountCode)
    .all<{
      id: string;
      organization_id: string;
      payment_request_id: string;
      updated_at: string;
      customer_id: string;
      amount_minor: number;
      currency: string;
      invoice_ids_json: string;
    }>();
  let dispatched = 0;
  for (const candidate of candidates.results) {
    const now = new Date().toISOString();
    const event: DomainEvent = {
      id: `automatic-collection-recovery:${crypto.randomUUID()}`,
      type: "payment_request.created",
      version: 1,
      aggregateType: "payment_request",
      aggregateId: candidate.payment_request_id,
      aggregateVersion: 1,
      occurredAt: now,
      causationId: correlationId,
      correlationId,
      payload: {
        organizationId: candidate.organization_id,
        paymentRequestId: candidate.payment_request_id,
        customerId: candidate.customer_id,
        amountMinor: candidate.amount_minor,
        currency: candidate.currency,
        invoiceIds: JSON.parse(candidate.invoice_ids_json),
        automaticCollection: true,
        recovery: true,
      },
    };
    const results = await env.BILLING_DB.batch([
      env.BILLING_DB.prepare(
        `INSERT INTO outbox_events
         (event_id, organization_id, event_type, event_version, aggregate_type,
          aggregate_id, aggregate_version, causation_id, correlation_id, payload_json,
          occurred_at, published_at)
         SELECT ?, organization_id, 'payment_request.created', 1, 'payment_request',
                payment_request_id, 1, ?, ?, ?, ?, NULL
         FROM easy_pay_direct_automatic_payment_executions
         WHERE id = ? AND organization_id = ? AND status = 'pending' AND updated_at = ?`,
      ).bind(
        event.id,
        correlationId,
        correlationId,
        stableJson(event.payload),
        now,
        candidate.id,
        candidate.organization_id,
        candidate.updated_at,
      ),
      env.BILLING_DB.prepare(
        `UPDATE easy_pay_direct_automatic_payment_executions SET updated_at = ?
         WHERE id = ? AND organization_id = ? AND status = 'pending' AND updated_at = ?
           AND EXISTS (SELECT 1 FROM outbox_events WHERE event_id = ? AND organization_id = ?)`,
      ).bind(
        now,
        candidate.id,
        candidate.organization_id,
        candidate.updated_at,
        event.id,
        candidate.organization_id,
      ),
    ]);
    if (results[0]?.meta.changes !== 1) continue;
    // The durable outbox survives a send failure; do not reset the pending claim
    // or ever turn a processing/unknown attempt back into chargeable work.
    await env.DOMAIN_EVENTS.send(event);
    dispatched += 1;
  }
  return dispatched;
}

export async function pendingEasyPayDirectAutomaticCollectionInvoices(
  database: D1Database,
  scopeMode: CollectionScopeMode,
  configuredScope: { organizationId: string; accountCode: string },
): Promise<string[]> {
  if (!configuredScope.organizationId.trim() || !configuredScope.accountCode.trim()) return [];
  const rows = await database
    .prepare(
      `SELECT invoice.id
       FROM invoices invoice
       JOIN subscriptions subscription
         ON subscription.id = invoice.subscription_id
        AND subscription.organization_id = invoice.organization_id
       JOIN plans plan
         ON plan.id = subscription.plan_id
        AND plan.organization_id = subscription.organization_id
       JOIN customers customer
         ON customer.id = invoice.customer_id
        AND customer.organization_id = invoice.organization_id
       JOIN provider_customer_profiles profile
         ON profile.id = subscription.payment_method_id
        AND profile.customer_id = customer.id
        AND profile.organization_id = invoice.organization_id
        AND profile.provider_account_code = COALESCE(customer.payment_provider_code, 'default')
        AND profile.provider = 'easy_pay_direct'
        AND profile.status = 'active'
       WHERE invoice.status = 'finalized' AND invoice.payment_status = 'pending'
         AND invoice.organization_id = ? AND profile.provider_account_code = ?
         AND invoice.ready_for_payment_processing = 1
         AND invoice.total_due_minor > 0
         AND invoice.net_payment_term = 0
         AND (invoice.payment_due_date IS NULL OR date(invoice.payment_due_date) <= date('now'))
         AND subscription.payment_method_type = 'provider'
         AND subscription.status IN ('active', 'past_due')
         AND plan.interval IN ('weekly', 'monthly', 'quarterly', 'yearly')
         AND customer.payment_provider = 'easy_pay_direct'
         AND ${productPolicyEligibilitySql(scopeMode)}
         AND (? = 'all' OR EXISTS (
           SELECT 1 FROM easy_pay_direct_automatic_collection_scopes scope
           WHERE scope.subscription_id = subscription.id
             AND scope.organization_id = invoice.organization_id
             AND scope.status = 'enabled'
         ))
         AND ${savedProfileEligibilitySql()}
         AND NOT EXISTS (
           SELECT 1 FROM invoices_payment_requests link WHERE link.invoice_id = invoice.id
         )
       ORDER BY invoice.updated_at, invoice.id LIMIT 100`,
    )
    .bind(configuredScope.organizationId, configuredScope.accountCode, scopeMode)
    .all<{ id: string }>();
  return rows.results.map((row) => row.id);
}

export async function pendingEasyPayDirectAutomaticExecutions(env: Env): Promise<string[]> {
  const configuredScope = configuredAutomaticCollectionScope(env);
  if (!configuredScope) return [];
  const rows = await env.BILLING_DB.prepare(
    `SELECT id FROM easy_pay_direct_automatic_payment_executions
       WHERE status IN ('processing', 'unknown')
         AND organization_id = ? AND provider_account_code = ?
       ORDER BY updated_at, id LIMIT 100`,
  )
    .bind(configuredScope.organizationId, configuredScope.accountCode)
    .all<{ id: string }>();
  return rows.results.map((row) => row.id);
}

async function loadRenewalCandidate(
  database: D1Database,
  invoiceId: string,
  scopeMode: CollectionScopeMode,
): Promise<RenewalCandidate | null> {
  return database
    .prepare(
      `SELECT invoice.id AS invoice_id, invoice.organization_id, invoice.customer_id,
              invoice.subscription_id, customer.email AS customer_email,
              COALESCE(customer.payment_provider_code, 'default') AS provider_account_code,
              invoice.currency, invoice.subtotal_minor, invoice.tax_minor,
              invoice.credits_minor, invoice.total_due_minor, invoice.version AS invoice_version,
              plan.interval AS plan_interval, profile.id AS provider_profile_id,
              profile.gateway_customer_vault_id, profile.initial_transaction_id,
              profile.payment_backend, profile.provider_customer_id, profile.provider_payment_method_id
       FROM invoices invoice
       JOIN customers customer ON customer.id = invoice.customer_id
       JOIN subscriptions subscription ON subscription.id = invoice.subscription_id
       JOIN plans plan ON plan.id = subscription.plan_id
       JOIN provider_customer_profiles profile
         ON profile.id = subscription.payment_method_id
        AND profile.organization_id = invoice.organization_id
        AND profile.customer_id = invoice.customer_id
        AND profile.provider = 'easy_pay_direct'
        AND profile.provider_account_code = COALESCE(customer.payment_provider_code, 'default')
        AND profile.status = 'active'
       WHERE invoice.id = ? AND invoice.status = 'finalized'
         AND invoice.payment_status = 'pending' AND invoice.ready_for_payment_processing = 1
         AND invoice.total_due_minor > 0
         AND invoice.net_payment_term = 0
         AND (invoice.payment_due_date IS NULL OR date(invoice.payment_due_date) <= date('now'))
         AND subscription.payment_method_type = 'provider'
         AND subscription.status IN ('active', 'past_due')
         AND plan.interval IN ('weekly', 'monthly', 'quarterly', 'yearly')
         AND customer.payment_provider = 'easy_pay_direct'
         AND ${productPolicyEligibilitySql(scopeMode)}
         AND (? = 'all' OR EXISTS (
           SELECT 1 FROM easy_pay_direct_automatic_collection_scopes scope
           WHERE scope.subscription_id = subscription.id
             AND scope.organization_id = invoice.organization_id
             AND scope.status = 'enabled'
         ))
         AND ${savedProfileEligibilitySql()}
         AND NOT EXISTS (
           SELECT 1 FROM invoices_payment_requests link WHERE link.invoice_id = invoice.id
         )
       LIMIT 1`,
    )
    .bind(invoiceId, scopeMode)
    .first<RenewalCandidate>();
}

async function latestCommittedTaxQuote(
  database: D1Database,
  candidate: RenewalCandidate,
): Promise<SourceTaxQuote | null> {
  return database
    .prepare(
      `SELECT quote.id, quote.tax_code, quote.billing_address_sha256, quote.billing_country,
              quote.billing_state, quote.billing_postal_code, quote.local_calculation_method,
              quote.billing_address_ciphertext, quote.billing_address_iv,
              quote.billing_address_key_id
       FROM easy_pay_direct_checkout_tax_quotes quote
       JOIN payment_requests request ON request.id = quote.payment_request_id
        AND request.organization_id = quote.organization_id
       JOIN invoices source_invoice ON source_invoice.id = quote.invoice_id
        AND source_invoice.organization_id = quote.organization_id
        AND source_invoice.customer_id = request.customer_id
       WHERE quote.organization_id = ? AND request.customer_id = ?
         AND source_invoice.subscription_id = ?
         AND quote.status = 'committed'
       ORDER BY quote.committed_at DESC, quote.created_at DESC, quote.id DESC LIMIT 1`,
    )
    .bind(candidate.organization_id, candidate.customer_id, candidate.subscription_id)
    .first<SourceTaxQuote>();
}

async function automaticTaxAddress(env: Env, source: SourceTaxQuote): Promise<BillingAddress> {
  if (source.local_calculation_method !== "wa_dor_address") {
    return {
      country: source.billing_country,
      state: source.billing_state,
      postalCode: source.billing_postal_code,
      addressLine: null,
      city: null,
    };
  }
  const secret = env.INDIRECT_TAX_ADDRESS_ENCRYPTION_SECRET?.trim();
  const keyId = env.INDIRECT_TAX_ADDRESS_ENCRYPTION_KEY_ID?.trim();
  if (
    !secret ||
    secret.length < 32 ||
    !keyId ||
    keyId !== source.billing_address_key_id ||
    !source.billing_address_ciphertext ||
    !source.billing_address_iv
  ) {
    throw new ApiError(
      503,
      "easy_pay_direct_automatic_tax_address_unavailable",
      "easy_pay_direct_automatic_tax_address_unavailable",
    );
  }
  const decrypted = await decryptBillingAddress(
    source.billing_address_ciphertext,
    source.billing_address_iv,
    secret,
    source.id,
  );
  const address = normalizeBillingAddress({
    country: decrypted.country,
    state: decrypted.state,
    postal_code: decrypted.postalCode,
    address_line: decrypted.addressLine,
    city: decrypted.city,
  });
  const identity: Record<string, string | null> = {
    country: address.country,
    postalCode: address.postalCode,
    state: address.state,
  };
  if (address.addressLine) identity.addressLine = address.addressLine;
  if (address.city) identity.city = address.city;
  if ((await sha256Hex(stableJson(identity))) !== source.billing_address_sha256) {
    throw new ApiError(
      503,
      "easy_pay_direct_automatic_tax_address_mismatch",
      "easy_pay_direct_automatic_tax_address_mismatch",
    );
  }
  return address;
}

async function executionForInvoice(
  database: D1Database,
  invoiceId: string,
  configuredScope: { organizationId: string; accountCode: string },
): Promise<string | null> {
  const row = await database
    .prepare(
      `SELECT execution.id
       FROM easy_pay_direct_automatic_payment_executions execution
       JOIN invoices_payment_requests link
         ON link.payment_request_id = execution.payment_request_id
       WHERE link.invoice_id = ? AND execution.organization_id = ?
         AND execution.provider_account_code = ? LIMIT 1`,
    )
    .bind(invoiceId, configuredScope.organizationId, configuredScope.accountCode)
    .first<{ id: string }>();
  return row?.id ?? null;
}

async function loadExecution(
  database: D1Database,
  paymentRequestId: string,
): Promise<AutomaticExecution | null> {
  return database
    .prepare(`${executionSelect()} WHERE execution.payment_request_id = ? LIMIT 1`)
    .bind(paymentRequestId)
    .first<AutomaticExecution>();
}

async function loadExecutionById(
  database: D1Database,
  executionId: string,
): Promise<AutomaticExecution | null> {
  return database
    .prepare(`${executionSelect()} WHERE execution.id = ? LIMIT 1`)
    .bind(executionId)
    .first<AutomaticExecution>();
}

function executionSelect(): string {
  return `SELECT execution.id, execution.organization_id, execution.payment_request_id,
                 execution.customer_id, execution.provider_profile_id,
                 execution.provider_account_code,
                 execution.request_sha256, execution.gateway_customer_vault_id,
                 execution.initial_transaction_id, execution.order_reference,
                 execution.status, execution.provider_transaction_id,
                 execution.failure_code, execution.failure_message,
                 execution.payment_backend, execution.commerce_customer_id, execution.commerce_payment_method_id,
                 execution.product_idempotency_key, execution.order_idempotency_key,
                 execution.commerce_product_id, execution.commerce_order_id, execution.order_submit_started_at,
                 request.amount_minor, request.currency
          FROM easy_pay_direct_automatic_payment_executions execution
          JOIN payment_requests request ON request.id = execution.payment_request_id`;
}

async function reconcileAutomaticOutcome(
  env: Env,
  execution: AutomaticExecution,
  transaction: GatewayTransactionResult,
): Promise<void> {
  const providerTransactionId = transaction.id;
  if (
    transaction.status === "failed" &&
    providerTransactionId &&
    (await hasSuccessfulEasyPayDirectPayment(
      env.BILLING_DB,
      execution.organization_id,
      execution.payment_request_id,
      execution.provider_account_code,
      providerTransactionId,
    ))
  )
    return;
  if (!providerTransactionId && transaction.status !== "failed") {
    throw new Error("easy_pay_direct_automatic_transaction_id_missing");
  }
  const reconciliationReference =
    providerTransactionId ??
    `no-provider-transaction:${await deterministicUuid(
      "easy-pay-direct-automatic-definitive-failure",
      `${execution.provider_account_code}:${execution.order_reference}:${transaction.responseCode ?? "failed"}`,
    )}`;
  const now = new Date().toISOString();
  const receiptId = await deterministicUuid(
    "easy-pay-direct-automatic-receipt",
    `${execution.provider_account_code}:${reconciliationReference}:${transaction.status}`,
  );
  const providerEventId = `automatic:${reconciliationReference}:${transaction.status}`;
  const payloadHash = await sha256Hex(
    stableJson({
      order_reference: execution.order_reference,
      response_code: transaction.responseCode,
      status: transaction.status,
      transaction_id: providerTransactionId,
    }),
  );
  await env.BILLING_DB.batch([
    env.BILLING_DB.prepare(
      `INSERT INTO webhook_receipts
       (id, provider, provider_account_code, provider_event_id, signature_valid,
        payload_sha256, received_at, processed_at, processing_error_code)
       VALUES (?, 'easy_pay_direct_automatic', ?, ?, 0, ?, ?, NULL, NULL)
       ON CONFLICT(provider, provider_account_code, provider_event_id) DO NOTHING`,
    ).bind(receiptId, execution.provider_account_code, providerEventId, payloadHash, now),
    env.BILLING_DB.prepare(
      `INSERT INTO provider_webhook_events
       (receipt_id, organization_id, event_type, provider_transaction_id, invoice_id,
        normalized_status, normalized_at, payment_request_id)
       VALUES (?, ?, 'transaction.automatic.reconciled', ?, NULL, NULL, NULL, NULL)
       ON CONFLICT(receipt_id) DO NOTHING`,
    ).bind(receiptId, execution.organization_id, providerTransactionId),
  ]);
  const receipt: PendingReceipt = {
    receipt_id: receiptId,
    organization_id: execution.organization_id,
    provider_account_code: execution.provider_account_code,
    event_type: "transaction.automatic.reconciled",
    provider_transaction_id: providerTransactionId,
    archive_key: null,
    processed_at: null,
  };
  // The ledger batch and execution update are separate. A crash between them
  // must resume finalization without inserting the same reconciliation guard.
  const savedReceipt = await env.BILLING_DB.prepare(
    "SELECT processed_at FROM webhook_receipts WHERE id = ?",
  )
    .bind(receiptId)
    .first<{ processed_at: string | null }>();
  if (!savedReceipt?.processed_at)
    await reconcilePaymentRequest(
      env.BILLING_DB,
      receipt,
      execution.payment_request_id,
      {
        id: reconciliationReference,
        amountMinor: execution.amount_minor,
        failureCode:
          transaction.status === "failed"
            ? (transaction.responseCode ?? "easy_pay_direct_declined")
            : null,
        failureMessage: transaction.status === "failed" ? transaction.responseText : null,
      },
      transaction.status,
      "easy_pay_direct",
    );
  if (
    transaction.status === "failed" &&
    execution.payment_backend === "gateway_vault" &&
    isInvalidCustomerVaultFailure(transaction.responseCode, transaction.responseText)
  ) {
    await env.BILLING_DB.prepare(
      `UPDATE provider_customer_profiles
       SET status = 'disabled', updated_at = ?
       WHERE id = ? AND organization_id = ? AND provider = 'easy_pay_direct'
         AND status = 'active' AND gateway_customer_vault_id = ?
         AND initial_transaction_id = ?
         AND NOT EXISTS (SELECT 1 FROM payment_request_payments paid
           WHERE paid.payment_request_id = ? AND paid.organization_id = provider_customer_profiles.organization_id
             AND paid.provider = 'easy_pay_direct'
             AND paid.provider_account_code = provider_customer_profiles.provider_account_code
             AND paid.provider_transaction_id = ? AND paid.status = 'succeeded')`,
    )
      .bind(
        now,
        execution.provider_profile_id,
        execution.organization_id,
        execution.gateway_customer_vault_id,
        execution.initial_transaction_id,
        execution.payment_request_id,
        providerTransactionId,
      )
      .run();
  }
  await env.BILLING_DB.prepare(
    `UPDATE easy_pay_direct_automatic_payment_executions
     SET status = ?, provider_transaction_id = ?, provider_response_code = ?,
         failure_code = ?, failure_message = ?, lease_expires_at = NULL,
         updated_at = ?, completed_at = ?
     WHERE id = ? AND status IN ('processing', 'unknown')
       AND (? <> 'failed' OR NOT EXISTS (SELECT 1 FROM payment_request_payments paid
         WHERE paid.organization_id = easy_pay_direct_automatic_payment_executions.organization_id
           AND paid.payment_request_id = easy_pay_direct_automatic_payment_executions.payment_request_id
           AND paid.provider = 'easy_pay_direct'
           AND paid.provider_account_code = easy_pay_direct_automatic_payment_executions.provider_account_code
           AND paid.provider_transaction_id = ? AND paid.status = 'succeeded'))`,
  )
    .bind(
      transaction.status,
      providerTransactionId,
      transaction.responseCode,
      transaction.status === "failed"
        ? (transaction.responseCode ?? "easy_pay_direct_declined")
        : null,
      transaction.status === "failed" ? transaction.responseText.slice(0, 500) : null,
      now,
      now,
      execution.id,
      transaction.status,
      providerTransactionId,
    )
    .run();
}

function isInvalidCustomerVaultFailure(
  responseCode: string | null,
  responseText: string | null,
): boolean {
  return responseCode === "300" && /invalid customer vault id/iu.test(responseText ?? "");
}

async function markUnknown(
  database: D1Database,
  executionId: string,
  failureCode: string,
  failureMessage: string | null = null,
): Promise<void> {
  const now = new Date().toISOString();
  await database
    .prepare(
      `UPDATE easy_pay_direct_automatic_payment_executions
       SET status = 'unknown', failure_code = ?, failure_message = ?,
           lease_expires_at = NULL, updated_at = ?
       WHERE id = ? AND status = 'processing'`,
    )
    .bind(failureCode, failureMessage?.slice(0, 500) ?? null, now, executionId)
    .run();
}

function automaticCollectionEnabled(env: Env): boolean {
  return String(env.EASY_PAY_DIRECT_AUTOMATIC_COLLECTION_ENABLED) === "1";
}

function paymentRequestCreatedEvent(
  candidate: RenewalCandidate,
  paymentRequestId: string,
  amountMinor: number,
  correlationId: string,
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
    causationId: correlationId,
    correlationId,
    payload: {
      organizationId: candidate.organization_id,
      paymentRequestId,
      customerId: candidate.customer_id,
      invoiceIds: [candidate.invoice_id],
      amountMinor,
      currency: candidate.currency,
      automaticCollection: true,
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
