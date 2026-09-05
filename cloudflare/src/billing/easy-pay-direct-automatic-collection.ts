import { sha256Hex } from "../auth/api-key";
import { resolveCheckoutTaxCode } from "../api/easy-pay-direct-tax";
import type { DomainEvent } from "../domain-events";
import { deterministicUuid } from "../identifiers";
import { stableJson } from "../json";
import {
  chargeEasyPayDirectStoredMethod,
  findEasyPayDirectGatewayTransactionByOrderId,
  type GatewayTransactionResult,
} from "../providers/easy-pay-direct";
import { reconcilePaymentRequest, type PendingReceipt } from "../reconciliation/authorize-net";
import { calculateLocalD1Tax } from "../tax/local-d1";

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
  gateway_customer_vault_id: string;
  initial_transaction_id: string;
};

type AutomaticExecution = {
  id: string;
  organization_id: string;
  payment_request_id: string;
  customer_id: string;
  provider_profile_id: string;
  provider_account_code: string;
  request_sha256: string;
  gateway_customer_vault_id: string;
  initial_transaction_id: string;
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
  billing_address_sha256: string;
  billing_country: string;
  billing_state: string | null;
  billing_postal_code: string | null;
};

export type AutomaticCollectionOutcome = "processed" | "deferred" | "not_applicable";

export async function prepareEasyPayDirectAutomaticCollection(
  env: Env,
  invoiceId: string,
  correlationId: string,
): Promise<AutomaticCollectionOutcome> {
  if (!automaticCollectionEnabled(env)) return "not_applicable";
  const existing = await executionForInvoice(env.BILLING_DB, invoiceId);
  if (existing) return "processed";
  const candidate = await loadRenewalCandidate(
    env.BILLING_DB,
    invoiceId,
    automaticCollectionScopeMode(env),
  );
  if (!candidate) return "not_applicable";

  const now = new Date().toISOString();
  let amountMinor = candidate.total_due_minor;
  let invoiceVersion = candidate.invoice_version;
  const statements: D1PreparedStatement[] = [];

  if (env.EASY_PAY_DIRECT_TAX_MODE === "enforced") {
    if (env.EASY_PAY_DIRECT_TAX_PROVIDER !== "local_d1") {
      throw new Error("easy_pay_direct_automatic_tax_provider_unsupported");
    }
    const source = await latestCommittedTaxQuote(env.BILLING_DB, candidate);
    if (!source) throw new Error("easy_pay_direct_automatic_tax_address_missing");
    const taxableSubtotal = candidate.subtotal_minor - candidate.credits_minor;
    if (!Number.isSafeInteger(taxableSubtotal) || taxableSubtotal <= 0) {
      throw new Error("easy_pay_direct_automatic_tax_subtotal_invalid");
    }
    const taxCode = resolveCheckoutTaxCode(candidate.plan_interval, env);
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
      address: {
        country: source.billing_country,
        state: source.billing_state,
        postalCode: source.billing_postal_code,
      },
      currency: candidate.currency,
      maxDataAgeDays: env.EASY_PAY_DIRECT_TAX_MAX_DATA_AGE_DAYS,
      organizationId: candidate.organization_id,
      requestHash,
      subtotalMinor: taxableSubtotal,
      taxCode,
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
          billing_country, billing_state, billing_postal_code, currency, subtotal_minor,
          tax_minor, total_minor, tax_code, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
        candidate.currency,
        calculation.subtotalMinor,
        calculation.taxMinor,
        calculation.totalMinor,
        taxCode,
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
        initial_transaction_id, order_reference, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
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
  let execution = await loadExecution(env.BILLING_DB, paymentRequestId);
  if (!execution) {
    await prepareEasyPayDirectDunningCollection(env, paymentRequestId);
    execution = await loadExecution(env.BILLING_DB, paymentRequestId);
  }
  if (!execution) return "not_applicable";
  if (execution.status === "succeeded" || execution.status === "failed") return "processed";
  // A processing lease expiring does not prove that the gateway rejected the charge.
  // Both states are reconciled by provider reads, never by another submission.
  if (execution.status === "unknown" || execution.status === "processing") return "deferred";
  if (String(env.PAYMENT_MUTATIONS_ENABLED) !== "1") return "deferred";

  const now = new Date();
  const leaseExpiresAt = new Date(now.getTime() + 2 * 60 * 1000).toISOString();
  const claimed = await env.BILLING_DB.prepare(
    `UPDATE easy_pay_direct_automatic_payment_executions
     SET status = 'processing', attempt_count = attempt_count + 1,
         lease_expires_at = ?, updated_at = ?
     WHERE id = ? AND status = 'pending' AND EXISTS (
       SELECT 1 FROM payment_requests request
       JOIN provider_customer_profiles profile
         ON profile.id = easy_pay_direct_automatic_payment_executions.provider_profile_id
        AND profile.organization_id = request.organization_id
        AND profile.customer_id = request.customer_id
        AND profile.provider = 'easy_pay_direct' AND profile.status = 'active'
        AND profile.gateway_customer_vault_id = easy_pay_direct_automatic_payment_executions.gateway_customer_vault_id
        AND profile.initial_transaction_id = easy_pay_direct_automatic_payment_executions.initial_transaction_id
       WHERE request.id = easy_pay_direct_automatic_payment_executions.payment_request_id
         AND request.payment_status = 'pending' AND request.ready_for_payment_processing = 1
         AND ${recurringInvoiceEligibilitySql()}
     )
     RETURNING id`,
  )
    .bind(leaseExpiresAt, now.toISOString(), execution.id, automaticCollectionScopeMode(env))
    .first<{ id: string }>();
  if (!claimed) return "deferred";

  let transaction: GatewayTransactionResult;
  try {
    transaction = await chargeEasyPayDirectStoredMethod(
      env,
      {
        amountMinor: execution.amount_minor,
        currency: execution.currency,
        customerVaultId: execution.gateway_customer_vault_id,
        initialTransactionId: execution.initial_transaction_id,
        orderId: execution.order_reference,
        orderDescription: `SERP subscription renewal ${execution.payment_request_id}`,
        idempotencyKey: execution.request_sha256,
      },
      fetcher,
    );
  } catch {
    await markUnknown(env.BILLING_DB, execution.id, "easy_pay_direct_gateway_outcome_unknown");
    return "deferred";
  }
  if (transaction.orderId && transaction.orderId !== execution.order_reference) {
    await markUnknown(env.BILLING_DB, execution.id, "easy_pay_direct_order_identity_mismatch");
    return "deferred";
  }
  if (transaction.status === "unknown" || (transaction.status === "succeeded" && !transaction.id)) {
    await markUnknown(
      env.BILLING_DB,
      execution.id,
      transaction.responseCode ?? "easy_pay_direct_gateway_outcome_unknown",
      transaction.responseText,
    );
    return "deferred";
  }
  await reconcileAutomaticOutcome(env, execution, transaction);
  return "processed";
}

async function prepareEasyPayDirectDunningCollection(
  env: Env,
  paymentRequestId: string,
): Promise<void> {
  const row = await env.BILLING_DB.prepare(
    `SELECT request.id AS payment_request_id, request.organization_id, request.customer_id,
              request.amount_minor, request.currency,
              COALESCE(customer.payment_provider_code, 'default') AS provider_account_code,
              profile.id AS provider_profile_id, profile.gateway_customer_vault_id,
              profile.initial_transaction_id
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
         AND request.payment_status = 'pending' AND request.ready_for_payment_processing = 1
         AND customer.payment_provider = 'easy_pay_direct'
         AND profile.gateway_customer_vault_id IS NOT NULL
         AND profile.initial_transaction_id IS NOT NULL
         AND lower(profile.gateway_customer_vault_id) NOT LIKE 'vault-test-%'
         AND lower(profile.gateway_customer_vault_id) NOT LIKE 'synthetic-%'
         AND ${recurringInvoiceEligibilitySql()}
       LIMIT 1`,
  )
    .bind(paymentRequestId, automaticCollectionScopeMode(env))
    .first<{
      payment_request_id: string;
      organization_id: string;
      customer_id: string;
      amount_minor: number;
      currency: string;
      provider_account_code: string;
      provider_profile_id: string;
      gateway_customer_vault_id: string;
      initial_transaction_id: string;
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
        initial_transaction_id, order_reference, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)
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
    )
    .run();
}

// Every linked invoice must be eligible; one scoped invoice must not authorize a
// mixed request containing unscoped or one-time purchases.
function recurringInvoiceEligibilitySql(): string {
  return `EXISTS (
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
      OR subscription.payment_method_type IS NOT 'provider'
      OR subscription.payment_method_id IS NOT profile.id
      OR subscription.status NOT IN ('active', 'past_due')
      OR plan.interval NOT IN ('weekly', 'monthly', 'quarterly', 'yearly')
      OR (? <> 'all' AND NOT EXISTS (
        SELECT 1 FROM easy_pay_direct_automatic_collection_scopes scope
        WHERE scope.subscription_id = subscription.id
          AND scope.organization_id = request.organization_id AND scope.status = 'enabled'
      ))
    )
  )`;
}

export async function reconcileEasyPayDirectAutomaticCollection(
  env: Env,
  executionId: string,
  fetcher: typeof fetch = fetch,
): Promise<AutomaticCollectionOutcome> {
  const execution = await loadExecutionById(env.BILLING_DB, executionId);
  if (!execution || execution.status === "succeeded" || execution.status === "failed") {
    return "processed";
  }
  if (
    execution.status === "unknown" &&
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
  const transaction = await findEasyPayDirectGatewayTransactionByOrderId(
    env,
    execution.order_reference,
    fetcher,
  );
  await env.BILLING_DB.prepare(
    `UPDATE easy_pay_direct_automatic_payment_executions
     SET last_provider_read_at = ?, updated_at = ? WHERE id = ?`,
  )
    .bind(new Date().toISOString(), new Date().toISOString(), execution.id)
    .run();
  if (!transaction || transaction.status === "unknown") return "deferred";
  if (transaction.amountMinor !== null && transaction.amountMinor !== execution.amount_minor) {
    throw new Error("easy_pay_direct_automatic_provider_amount_mismatch");
  }
  if (transaction.currency !== null && transaction.currency !== execution.currency) {
    throw new Error("easy_pay_direct_automatic_provider_currency_mismatch");
  }
  await reconcileAutomaticOutcome(env, execution, transaction);
  return "processed";
}

export async function dispatchPendingEasyPayDirectAutomaticCollections(
  env: Env,
  correlationId: string,
): Promise<number> {
  if (!automaticCollectionEnabled(env)) return 0;
  const invoiceIds = await pendingEasyPayDirectAutomaticCollectionInvoices(
    env.BILLING_DB,
    automaticCollectionScopeMode(env),
  );
  let dispatched = 0;
  for (const invoiceId of invoiceIds) {
    if (
      (await prepareEasyPayDirectAutomaticCollection(env, invoiceId, correlationId)) === "processed"
    ) {
      dispatched += 1;
    }
  }
  return dispatched;
}

export async function pendingEasyPayDirectAutomaticCollectionInvoices(
  database: D1Database,
  scopeMode: "scoped" | "all",
): Promise<string[]> {
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
        AND profile.provider = 'easy_pay_direct'
        AND profile.status = 'active'
       WHERE invoice.status = 'finalized' AND invoice.payment_status = 'pending'
         AND invoice.ready_for_payment_processing = 1
         AND invoice.total_due_minor > 0
         AND invoice.net_payment_term = 0
         AND (invoice.payment_due_date IS NULL OR date(invoice.payment_due_date) <= date('now'))
         AND subscription.payment_method_type = 'provider'
         AND subscription.status IN ('active', 'past_due')
         AND plan.interval IN ('weekly', 'monthly', 'quarterly', 'yearly')
         AND customer.payment_provider = 'easy_pay_direct'
         AND (? = 'all' OR EXISTS (
           SELECT 1 FROM easy_pay_direct_automatic_collection_scopes scope
           WHERE scope.subscription_id = subscription.id
             AND scope.organization_id = invoice.organization_id
             AND scope.status = 'enabled'
         ))
         AND profile.gateway_customer_vault_id IS NOT NULL
         AND profile.initial_transaction_id IS NOT NULL
         AND lower(profile.gateway_customer_vault_id) NOT LIKE 'vault-test-%'
         AND lower(profile.gateway_customer_vault_id) NOT LIKE 'synthetic-%'
         AND NOT EXISTS (
           SELECT 1 FROM invoices_payment_requests link WHERE link.invoice_id = invoice.id
         )
       ORDER BY invoice.created_at, invoice.id LIMIT 100`,
    )
    .bind(scopeMode)
    .all<{ id: string }>();
  return rows.results.map((row) => row.id);
}

export async function pendingEasyPayDirectAutomaticExecutions(
  database: D1Database,
): Promise<string[]> {
  const rows = await database
    .prepare(
      `SELECT id FROM easy_pay_direct_automatic_payment_executions
       WHERE status IN ('processing', 'unknown')
       ORDER BY updated_at, id LIMIT 100`,
    )
    .all<{ id: string }>();
  return rows.results.map((row) => row.id);
}

async function loadRenewalCandidate(
  database: D1Database,
  invoiceId: string,
  scopeMode: "scoped" | "all",
): Promise<RenewalCandidate | null> {
  return database
    .prepare(
      `SELECT invoice.id AS invoice_id, invoice.organization_id, invoice.customer_id,
              invoice.subscription_id, customer.email AS customer_email,
              COALESCE(customer.payment_provider_code, 'default') AS provider_account_code,
              invoice.currency, invoice.subtotal_minor, invoice.tax_minor,
              invoice.credits_minor, invoice.total_due_minor, invoice.version AS invoice_version,
              plan.interval AS plan_interval, profile.id AS provider_profile_id,
              profile.gateway_customer_vault_id, profile.initial_transaction_id
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
         AND (? = 'all' OR EXISTS (
           SELECT 1 FROM easy_pay_direct_automatic_collection_scopes scope
           WHERE scope.subscription_id = subscription.id
             AND scope.organization_id = invoice.organization_id
             AND scope.status = 'enabled'
         ))
         AND profile.gateway_customer_vault_id IS NOT NULL
         AND profile.initial_transaction_id IS NOT NULL
         AND lower(profile.gateway_customer_vault_id) NOT LIKE 'vault-test-%'
         AND lower(profile.gateway_customer_vault_id) NOT LIKE 'synthetic-%'
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
      `SELECT quote.id, quote.billing_address_sha256, quote.billing_country,
              quote.billing_state, quote.billing_postal_code
       FROM easy_pay_direct_checkout_tax_quotes quote
       JOIN payment_requests request ON request.id = quote.payment_request_id
       WHERE quote.organization_id = ? AND request.customer_id = ?
         AND quote.status = 'committed'
       ORDER BY quote.committed_at DESC, quote.created_at DESC, quote.id DESC LIMIT 1`,
    )
    .bind(candidate.organization_id, candidate.customer_id)
    .first<SourceTaxQuote>();
}

async function executionForInvoice(
  database: D1Database,
  invoiceId: string,
): Promise<string | null> {
  const row = await database
    .prepare(
      `SELECT execution.id
       FROM easy_pay_direct_automatic_payment_executions execution
       JOIN invoices_payment_requests link
         ON link.payment_request_id = execution.payment_request_id
       WHERE link.invoice_id = ? LIMIT 1`,
    )
    .bind(invoiceId)
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
    isInvalidCustomerVaultFailure(transaction.responseCode, transaction.responseText)
  ) {
    await env.BILLING_DB.prepare(
      `UPDATE provider_customer_profiles
       SET status = 'disabled', updated_at = ?
       WHERE id = ? AND organization_id = ? AND provider = 'easy_pay_direct'
         AND status = 'active' AND gateway_customer_vault_id = ?
         AND initial_transaction_id = ?`,
    )
      .bind(
        now,
        execution.provider_profile_id,
        execution.organization_id,
        execution.gateway_customer_vault_id,
        execution.initial_transaction_id,
      )
      .run();
  }
  await env.BILLING_DB.prepare(
    `UPDATE easy_pay_direct_automatic_payment_executions
     SET status = ?, provider_transaction_id = ?, provider_response_code = ?,
         failure_code = ?, failure_message = ?, lease_expires_at = NULL,
         updated_at = ?, completed_at = ?
     WHERE id = ? AND status IN ('processing', 'unknown')`,
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

function automaticCollectionScopeMode(env: Env): "scoped" | "all" {
  return env.EASY_PAY_DIRECT_AUTOMATIC_COLLECTION_SCOPE_MODE === "all" ? "all" : "scoped";
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
