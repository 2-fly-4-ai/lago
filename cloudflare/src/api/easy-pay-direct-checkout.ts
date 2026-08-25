import { sha256Hex } from "../auth/api-key";
import { ApiError, json, parseJsonObject, requiredString } from "../http";
import { deterministicUuid } from "../identifiers";
import {
  addEasyPayDirectPaymentMethod,
  chargeEasyPayDirectGatewayTestToken,
  createEasyPayDirectCustomer,
  createEasyPayDirectOrder,
  createEasyPayDirectProduct,
  easyPayDirectPaymentTokenHash,
  findEasyPayDirectCustomerByEmail,
  vaultEasyPayDirectCard,
  type GatewayTransactionResult,
} from "../providers/easy-pay-direct";
import { reconcilePaymentRequest, type PendingReceipt } from "../reconciliation/authorize-net";

const CHECKOUT_TERMS_VERSION = "apps-serp-terms-and-privacy-2026-08-25";

type CheckoutRow = {
  checkout_intent_id: string;
  organization_id: string;
  payment_request_id: string;
  customer_id: string;
  provider_account_code: string;
  request_sha256: string;
  expires_at: string | null;
  amount_minor: number;
  currency: string;
  customer_email: string | null;
  customer_name: string | null;
  external_customer_id: string;
  payment_status: string;
  ready_for_payment_processing: number;
};

type ExecutionRow = {
  id: string;
  status: "pending" | "processing" | "succeeded" | "failed" | "unknown";
  payment_token_sha256: string;
  phone_sha256: string;
  terms_accepted_at: string | null;
  terms_version: string | null;
  customer_idempotency_key: string;
  payment_method_idempotency_key: string;
  product_idempotency_key: string;
  order_idempotency_key: string;
  provider_transaction_id: string | null;
  provider_customer_id: string | null;
  provider_payment_method_id: string | null;
  provider_product_id: string | null;
  customer_vault_id: string | null;
  gateway_billing_id: string | null;
  provider_response_code: string | null;
  failure_message: string | null;
};

type CheckoutSurface = "product_checkout" | "synthetic_qa";

type ProviderProfile = {
  provider_customer_id: string;
  provider_payment_method_id: string | null;
  gateway_customer_vault_id: string | null;
  gateway_billing_id: string | null;
};

export async function handleEasyPayDirectCheckoutSubmission(
  request: Request,
  env: Env,
  requestId: string,
  fetcher: typeof fetch = fetch,
  surface: CheckoutSurface = "product_checkout",
): Promise<Response> {
  const body = await parseJsonObject(request);
  const checkoutToken = requiredString(body, "checkout");
  const paymentToken = requiredString(body, "payment_token");
  const phone = requiredString(body, "phone");
  if (surface === "product_checkout" && body.terms_accepted !== true) {
    throw new ApiError(
      422,
      "easy_pay_direct_terms_required",
      "Accept the Terms of Service and Privacy Policy to continue",
    );
  }
  if (
    checkoutToken.length > 2_048 ||
    paymentToken.length > 512 ||
    !/^\+[1-9]\d{7,14}$/u.test(phone)
  ) {
    throw new ApiError(422, "invalid_easy_pay_direct_submission", "Checkout submission is invalid");
  }
  const signingSecret = env.EASY_PAY_DIRECT_CHECKOUT_SIGNING_SECRET?.trim();
  if (!signingSecret)
    throw new ApiError(
      503,
      "provider_not_configured",
      "EASY_PAY_DIRECT_CHECKOUT_SIGNING_SECRET is not configured",
    );
  const { verifyEasyPayDirectCheckoutToken } = await import("../providers/easy-pay-direct");
  const tokenPayload = await verifyEasyPayDirectCheckoutToken(checkoutToken, signingSecret);
  const checkoutTokenHash = await sha256Hex(checkoutToken);
  const checkout = await loadCheckout(env.BILLING_DB, tokenPayload.intent, checkoutTokenHash);
  if (!checkout)
    throw new ApiError(401, "easy_pay_direct_checkout_invalid", "Checkout link is invalid");
  if (!checkout.expires_at || Date.parse(checkout.expires_at) <= Date.now()) {
    throw new ApiError(410, "easy_pay_direct_checkout_expired", "Checkout link has expired");
  }
  if (!checkout.customer_email) {
    throw new ApiError(
      422,
      "easy_pay_direct_customer_email_required",
      "Customer email is required for Easy Pay Direct",
    );
  }
  if (surface === "product_checkout" && env.EASY_PAY_DIRECT_NETWORK_MODE === "test") {
    throw new ApiError(
      503,
      "easy_pay_direct_gateway_test_not_configured",
      "The product checkout requires Easy Pay Direct Gateway test mode",
    );
  }
  if (surface === "synthetic_qa" && env.EASY_PAY_DIRECT_NETWORK_MODE === "production") {
    throw new ApiError(
      404,
      "easy_pay_direct_sandbox_tool_unavailable",
      "The Easy Pay Direct sandbox tool is unavailable",
    );
  }

  const paymentTokenHash = await easyPayDirectPaymentTokenHash(paymentToken);
  const phoneHash = await sha256Hex(phone);
  const executionId = await deterministicUuid(
    "easy-pay-direct-payment-execution",
    checkout.checkout_intent_id,
  );
  const now = new Date().toISOString();
  const termsAcceptedAt = surface === "product_checkout" ? now : null;
  const termsVersion = surface === "product_checkout" ? CHECKOUT_TERMS_VERSION : null;
  await env.BILLING_DB.prepare(
    `INSERT INTO easy_pay_direct_payment_executions
     (id, organization_id, checkout_intent_id, payment_request_id, provider_account_code,
      request_sha256, payment_token_sha256, phone_sha256, terms_accepted_at, terms_version,
      customer_idempotency_key, payment_method_idempotency_key,
      product_idempotency_key, order_idempotency_key, status, created_at, updated_at)
     SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?
     WHERE NOT EXISTS (
       SELECT 1 FROM easy_pay_direct_payment_executions WHERE checkout_intent_id = ?
     )
     ON CONFLICT(checkout_intent_id) DO NOTHING`,
  )
    .bind(
      executionId,
      checkout.organization_id,
      checkout.checkout_intent_id,
      checkout.payment_request_id,
      checkout.provider_account_code,
      checkout.request_sha256,
      paymentTokenHash,
      phoneHash,
      termsAcceptedAt,
      termsVersion,
      crypto.randomUUID(),
      crypto.randomUUID(),
      crypto.randomUUID(),
      crypto.randomUUID(),
      now,
      now,
      checkout.checkout_intent_id,
    )
    .run();
  let execution = await loadExecution(env.BILLING_DB, checkout.checkout_intent_id);
  if (!execution || execution.id !== executionId)
    throw new ApiError(409, "easy_pay_direct_checkout_conflict", "Checkout was already submitted");
  if (execution.payment_token_sha256 !== paymentTokenHash || execution.phone_sha256 !== phoneHash) {
    throw new ApiError(
      409,
      "easy_pay_direct_checkout_replay_mismatch",
      "Checkout was already submitted with different payment details",
    );
  }
  if (
    surface === "product_checkout" &&
    (!execution.terms_accepted_at || execution.terms_version !== CHECKOUT_TERMS_VERSION)
  ) {
    throw new ApiError(
      409,
      "easy_pay_direct_checkout_replay_mismatch",
      "Checkout was already submitted without the current terms acceptance",
    );
  }
  if (execution.status === "succeeded")
    return successResponse(env, execution.provider_transaction_id, requestId, true);
  if (execution.status === "processing" && execution.provider_transaction_id)
    return processingResponse(env, execution.provider_transaction_id, requestId, true);
  if (checkout.payment_status === "succeeded" || checkout.ready_for_payment_processing !== 1) {
    throw new ApiError(409, "easy_pay_direct_checkout_state_changed", "Checkout state changed");
  }
  if (execution.status !== "pending") {
    throw new ApiError(
      409,
      `easy_pay_direct_${execution.status}`,
      execution.failure_message || "Checkout outcome requires reconciliation",
    );
  }
  const claimed = await env.BILLING_DB.prepare(
    "UPDATE easy_pay_direct_payment_executions SET status = 'processing', updated_at = ? WHERE id = ? AND status = 'pending'",
  )
    .bind(new Date().toISOString(), executionId)
    .run();
  if (claimed.meta.changes !== 1)
    throw new ApiError(409, "easy_pay_direct_processing", "Checkout is already processing");

  try {
    if (surface === "product_checkout" && env.EASY_PAY_DIRECT_NETWORK_MODE === "gateway_test") {
      const names = splitCustomerName(checkout.customer_name, checkout.customer_email);
      const transaction = await chargeEasyPayDirectGatewayTestToken(
        env,
        {
          paymentToken,
          amountMinor: checkout.amount_minor,
          currency: checkout.currency,
          orderId: checkout.payment_request_id,
          orderDescription: `Lago payment request ${checkout.payment_request_id}`,
          customerEmail: checkout.customer_email,
          firstName: names.firstName,
          lastName: names.lastName,
          phone,
          idempotencyKey: execution.order_idempotency_key,
        },
        fetcher,
      );
      return await finalizeGatewayTestOutcome(env, checkout, executionId, transaction, requestId);
    }

    const profile = await loadProfile(env.BILLING_DB, checkout);
    const vault =
      surface === "synthetic_qa" || env.EASY_PAY_DIRECT_NETWORK_MODE === "test"
        ? { customerVaultId: paymentToken, billingId: paymentToken }
        : await vaultEasyPayDirectCard(
            env,
            { paymentToken, existingCustomerVaultId: profile?.gateway_customer_vault_id },
            fetcher,
          );
    const names = splitCustomerName(checkout.customer_name, checkout.customer_email);
    let providerCustomerId = profile?.provider_customer_id ?? null;
    let providerPaymentMethodId: string | null = null;
    if (!providerCustomerId) {
      const existingCustomer = await findEasyPayDirectCustomerByEmail(
        env,
        checkout.customer_email,
        fetcher,
      );
      if (existingCustomer) {
        providerCustomerId = existingCustomer.id;
      } else {
        const customer = await createEasyPayDirectCustomer(
          env,
          {
            email: checkout.customer_email,
            firstName: names.firstName,
            lastName: names.lastName,
            phone,
            gatewayVaultId: vault.customerVaultId,
            idempotencyKey: execution.customer_idempotency_key,
            metadata: {
              lago_customer_id: checkout.customer_id,
              lago_external_customer_id: checkout.external_customer_id,
            },
          },
          fetcher,
        );
        providerCustomerId = customer.id;
        providerPaymentMethodId = customer.default_payment_method ?? null;
      }
    }
    if (!providerPaymentMethodId) {
      providerPaymentMethodId = (
        await addEasyPayDirectPaymentMethod(
          env,
          {
            customerId: providerCustomerId,
            billingId: vault.billingId,
            idempotencyKey: execution.payment_method_idempotency_key,
          },
          fetcher,
        )
      ).id;
    }
    await upsertProfile(env.BILLING_DB, checkout, {
      providerCustomerId,
      providerPaymentMethodId,
      gatewayCustomerVaultId: vault.customerVaultId,
      gatewayBillingId: vault.billingId,
    });
    await env.BILLING_DB.prepare(
      `UPDATE easy_pay_direct_payment_executions
       SET provider_customer_id = ?, provider_payment_method_id = ?, customer_vault_id = ?,
           gateway_billing_id = ?, updated_at = ? WHERE id = ? AND status = 'processing'`,
    )
      .bind(
        providerCustomerId,
        providerPaymentMethodId,
        vault.customerVaultId,
        vault.billingId,
        new Date().toISOString(),
        executionId,
      )
      .run();

    execution = (await loadExecution(env.BILLING_DB, checkout.checkout_intent_id))!;
    let productId = execution.provider_product_id;
    if (!productId) {
      const product = await createEasyPayDirectProduct(
        env,
        {
          paymentRequestId: checkout.payment_request_id,
          amountMinor: checkout.amount_minor,
          currency: checkout.currency,
          idempotencyKey: execution.product_idempotency_key,
        },
        fetcher,
      );
      productId = product.id;
      await env.BILLING_DB.prepare(
        "UPDATE easy_pay_direct_payment_executions SET provider_product_id = ?, updated_at = ? WHERE id = ? AND status = 'processing'",
      )
        .bind(productId, new Date().toISOString(), executionId)
        .run();
    }
    const order = await createEasyPayDirectOrder(
      env,
      {
        customerId: providerCustomerId,
        paymentMethodId: providerPaymentMethodId,
        productId,
        paymentRequestId: checkout.payment_request_id,
        checkoutIntentId: checkout.checkout_intent_id,
        currency: checkout.currency,
        idempotencyKey: execution.order_idempotency_key,
      },
      fetcher,
    );
    if (
      order.total !== checkout.amount_minor ||
      order.currency.toUpperCase() !== checkout.currency
    ) {
      throw new ApiError(
        409,
        "easy_pay_direct_order_amount_mismatch",
        "Easy Pay Direct order amount did not match the payment request",
      );
    }
    if (order.status === "failed") {
      await markExecution(
        env.BILLING_DB,
        executionId,
        "failed",
        order.id,
        order.failure_reason || "Payment failed",
      );
      throw new ApiError(
        422,
        "easy_pay_direct_declined",
        order.failure_reason?.slice(0, 500) || "Payment was declined",
      );
    }
    if (order.status !== "succeeded" && order.status !== "pending") {
      await markExecution(
        env.BILLING_DB,
        executionId,
        "unknown",
        order.id,
        `Unexpected order status: ${order.status}`,
      );
      throw new ApiError(
        503,
        "easy_pay_direct_outcome_unknown",
        "Easy Pay Direct order requires reconciliation",
      );
    }
    await env.BILLING_DB.prepare(
      `UPDATE easy_pay_direct_payment_executions
       SET provider_transaction_id = ?, provider_response_code = ?, updated_at = ?
       WHERE id = ? AND status = 'processing'`,
    )
      .bind(order.id, order.status, new Date().toISOString(), executionId)
      .run();
    return processingResponse(env, order.id, requestId, false);
  } catch (error) {
    const current = await loadExecution(env.BILLING_DB, checkout.checkout_intent_id);
    if (current?.status === "processing" && !current.provider_transaction_id) {
      await markExecution(
        env.BILLING_DB,
        executionId,
        "unknown",
        null,
        "Provider outcome requires reconciliation",
      );
    }
    throw error;
  }
}

async function finalizeGatewayTestOutcome(
  env: Env,
  checkout: CheckoutRow,
  executionId: string,
  transaction: GatewayTransactionResult,
  requestId: string,
): Promise<Response> {
  const timestamp = new Date().toISOString();
  const providerTransactionId = transaction.id?.trim() || null;
  if (!providerTransactionId || transaction.status === "unknown") {
    await env.BILLING_DB.prepare(
      `UPDATE easy_pay_direct_payment_executions
       SET status = 'unknown', provider_transaction_id = ?, provider_response_code = ?,
           failure_code = 'easy_pay_direct_gateway_outcome_unknown', failure_message = ?,
           updated_at = ?, completed_at = ?
       WHERE id = ? AND status = 'processing'`,
    )
      .bind(
        providerTransactionId,
        transaction.responseCode,
        transaction.responseText.slice(0, 500),
        timestamp,
        timestamp,
        executionId,
      )
      .run();
    throw new ApiError(
      503,
      "easy_pay_direct_gateway_outcome_unknown",
      "Easy Pay Direct Gateway outcome requires reconciliation",
    );
  }

  const normalizedStatus = transaction.status;
  const failureCode =
    normalizedStatus === "failed"
      ? transaction.responseCode || "easy_pay_direct_gateway_declined"
      : null;
  const failureMessage =
    normalizedStatus === "failed" ? transaction.responseText.slice(0, 500) : null;
  await env.BILLING_DB.prepare(
    `UPDATE easy_pay_direct_payment_executions
     SET provider_transaction_id = ?, provider_response_code = ?, customer_vault_id = ?,
         failure_code = ?, failure_message = ?, updated_at = ?
     WHERE id = ? AND status = 'processing'`,
  )
    .bind(
      providerTransactionId,
      transaction.responseCode,
      transaction.customerVaultId,
      failureCode,
      failureMessage,
      timestamp,
      executionId,
    )
    .run();

  const receiptId = await deterministicUuid(
    "easy-pay-direct-gateway-test-receipt",
    `${checkout.provider_account_code}:${providerTransactionId}:${normalizedStatus}`,
  );
  const providerEventId = `gateway-test:${providerTransactionId}:${normalizedStatus}`;
  const payloadHash = await sha256Hex(
    JSON.stringify({
      id: providerTransactionId,
      status: normalizedStatus,
      response_code: transaction.responseCode,
      response_text: transaction.responseText,
      amount_minor: checkout.amount_minor,
      currency: checkout.currency,
    }),
  );
  await env.BILLING_DB.batch([
    env.BILLING_DB.prepare(
      `INSERT INTO webhook_receipts
       (id, provider, provider_account_code, provider_event_id, signature_valid,
        payload_sha256, received_at, processed_at, processing_error_code)
       VALUES (?, 'easy_pay_direct_gateway_test', ?, ?, 0, ?, ?, NULL, NULL)
       ON CONFLICT(provider, provider_account_code, provider_event_id) DO NOTHING`,
    ).bind(receiptId, checkout.provider_account_code, providerEventId, payloadHash, timestamp),
    env.BILLING_DB.prepare(
      `INSERT INTO provider_webhook_events
       (receipt_id, organization_id, event_type, provider_transaction_id, invoice_id,
        normalized_status, normalized_at, payment_request_id)
       VALUES (?, ?, 'transaction.test.reconciled', ?, NULL, NULL, NULL, NULL)
       ON CONFLICT(receipt_id) DO NOTHING`,
    ).bind(receiptId, checkout.organization_id, providerTransactionId),
  ]);

  const receipt: PendingReceipt = {
    receipt_id: receiptId,
    organization_id: checkout.organization_id,
    provider_account_code: checkout.provider_account_code,
    event_type: "transaction.test.reconciled",
    provider_transaction_id: providerTransactionId,
    archive_key: null,
    processed_at: null,
  };
  await reconcilePaymentRequest(
    env.BILLING_DB,
    receipt,
    checkout.payment_request_id,
    {
      id: providerTransactionId,
      amountMinor: checkout.amount_minor,
      failureCode,
      failureMessage,
    },
    normalizedStatus,
    "easy_pay_direct",
  );
  await env.BILLING_DB.prepare(
    `UPDATE easy_pay_direct_payment_executions
     SET status = ?, updated_at = ?, completed_at = ?
     WHERE id = ? AND status = 'processing'`,
  )
    .bind(normalizedStatus, timestamp, timestamp, executionId)
    .run();

  if (normalizedStatus === "failed") {
    throw new ApiError(422, "easy_pay_direct_declined", failureMessage || "Payment was declined");
  }
  return successResponse(env, providerTransactionId, requestId, false);
}

async function loadCheckout(
  database: D1Database,
  intentId: string,
  tokenHash: string,
): Promise<CheckoutRow | null> {
  return database
    .prepare(
      `SELECT intent.id AS checkout_intent_id, intent.organization_id, intent.payment_request_id,
            intent.customer_id, intent.provider_account_code, intent.request_sha256, intent.expires_at,
            intent.amount_minor, intent.currency, customer.email AS customer_email,
            customer.name AS customer_name, customer.external_id AS external_customer_id,
            request.payment_status, request.ready_for_payment_processing
     FROM payment_request_checkout_intents intent
     JOIN customers customer ON customer.id = intent.customer_id AND customer.organization_id = intent.organization_id
     JOIN payment_requests request ON request.id = intent.payment_request_id AND request.organization_id = intent.organization_id
     WHERE intent.id = ? AND intent.provider = 'easy_pay_direct'
       AND intent.provider_token_sha256 = ? AND intent.status = 'succeeded' LIMIT 1`,
    )
    .bind(intentId, tokenHash)
    .first<CheckoutRow>();
}

async function loadExecution(
  database: D1Database,
  checkoutIntentId: string,
): Promise<ExecutionRow | null> {
  return database
    .prepare(
      `SELECT id, status, payment_token_sha256, phone_sha256, terms_accepted_at, terms_version,
            customer_idempotency_key,
            payment_method_idempotency_key, product_idempotency_key, order_idempotency_key,
            provider_transaction_id, provider_customer_id, provider_payment_method_id,
            provider_product_id, customer_vault_id, gateway_billing_id,
            provider_response_code, failure_message
     FROM easy_pay_direct_payment_executions WHERE checkout_intent_id = ? LIMIT 1`,
    )
    .bind(checkoutIntentId)
    .first<ExecutionRow>();
}

async function loadProfile(
  database: D1Database,
  checkout: CheckoutRow,
): Promise<ProviderProfile | null> {
  return database
    .prepare(
      `SELECT provider_customer_id, provider_payment_method_id, gateway_customer_vault_id, gateway_billing_id
     FROM provider_customer_profiles
     WHERE customer_id = ? AND provider = 'easy_pay_direct' AND provider_account_code = ? LIMIT 1`,
    )
    .bind(checkout.customer_id, checkout.provider_account_code)
    .first<ProviderProfile>();
}

async function upsertProfile(
  database: D1Database,
  checkout: CheckoutRow,
  input: {
    providerCustomerId: string;
    providerPaymentMethodId: string;
    gatewayCustomerVaultId: string;
    gatewayBillingId: string;
  },
): Promise<void> {
  const timestamp = new Date().toISOString();
  await database
    .prepare(
      `INSERT INTO provider_customer_profiles
     (id, organization_id, customer_id, provider, provider_account_code,
      provider_customer_id, provider_payment_method_id, gateway_customer_vault_id,
      gateway_billing_id, status, created_at, updated_at)
     VALUES (?, ?, ?, 'easy_pay_direct', ?, ?, ?, ?, ?, 'active', ?, ?)
     ON CONFLICT(customer_id, provider, provider_account_code) DO UPDATE SET
       provider_customer_id = excluded.provider_customer_id,
       provider_payment_method_id = excluded.provider_payment_method_id,
       gateway_customer_vault_id = excluded.gateway_customer_vault_id,
       gateway_billing_id = excluded.gateway_billing_id,
       status = 'active', updated_at = excluded.updated_at`,
    )
    .bind(
      await deterministicUuid(
        "easy-pay-direct-customer-profile",
        `${checkout.provider_account_code}:${checkout.customer_id}`,
      ),
      checkout.organization_id,
      checkout.customer_id,
      checkout.provider_account_code,
      input.providerCustomerId,
      input.providerPaymentMethodId,
      input.gatewayCustomerVaultId,
      input.gatewayBillingId,
      timestamp,
      timestamp,
    )
    .run();
}

async function markExecution(
  database: D1Database,
  executionId: string,
  status: "failed" | "unknown",
  providerOrderId: string | null,
  message: string,
): Promise<void> {
  const timestamp = new Date().toISOString();
  await database
    .prepare(
      `UPDATE easy_pay_direct_payment_executions SET status = ?, provider_transaction_id = ?,
       failure_message = ?, updated_at = ?, completed_at = ? WHERE id = ? AND status = 'processing'`,
    )
    .bind(status, providerOrderId, message.slice(0, 500), timestamp, timestamp, executionId)
    .run();
}

function splitCustomerName(
  name: string | null,
  email: string,
): { firstName: string; lastName: string } {
  const parts = (name ?? "").trim().split(/\s+/u).filter(Boolean);
  if (parts.length >= 2)
    return { firstName: parts[0]!.slice(0, 100), lastName: parts.slice(1).join(" ").slice(0, 100) };
  if (parts.length === 1) return { firstName: parts[0]!.slice(0, 100), lastName: "Customer" };
  const local = email
    .split("@")[0]
    ?.replace(/[^a-z0-9]+/giu, " ")
    .trim();
  return { firstName: local?.slice(0, 100) || "SERP", lastName: "Customer" };
}

function processingResponse(
  env: Env,
  orderId: string | null,
  requestId: string,
  replayed: boolean,
): Response {
  return json(
    {
      status: "processing",
      provider: "easy_pay_direct",
      provider_order_id: orderId,
      replayed,
      redirect_url: env.EASY_PAY_DIRECT_SUCCESS_REDIRECT_URL?.trim() || null,
    },
    { requestId },
  );
}

function successResponse(
  env: Env,
  orderId: string | null,
  requestId: string,
  replayed: boolean,
): Response {
  return json(
    {
      status: "succeeded",
      provider: "easy_pay_direct",
      provider_order_id: orderId,
      replayed,
      redirect_url: env.EASY_PAY_DIRECT_SUCCESS_REDIRECT_URL?.trim() || null,
    },
    { requestId },
  );
}
