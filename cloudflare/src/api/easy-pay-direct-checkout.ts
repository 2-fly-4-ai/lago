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
  resolveEasyPayDirectSuccessRedirect,
  vaultEasyPayDirectCard,
  type CommerceOrder,
  type GatewayVaultFailureDetails,
  type GatewayTransactionResult,
} from "../providers/easy-pay-direct";
import { reconcilePaymentRequest, type PendingReceipt } from "../reconciliation/authorize-net";
import {
  commitAppliedCheckoutTaxQuote,
  requireAppliedCheckoutTaxQuote,
} from "./easy-pay-direct-tax";

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
  checkout_intent_id: string;
  status: "pending" | "processing" | "succeeded" | "failed" | "unknown";
  payment_token_sha256: string;
  phone_sha256: string;
  phone_ciphertext: string | null;
  phone_iv: string | null;
  email_sha256: string | null;
  tax_quote_id: string | null;
  billing_address_sha256: string | null;
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
  last_checkpoint:
    | "created"
    | "gateway_vaulted"
    | "provider_customer"
    | "provider_payment_method"
    | "provider_product"
    | "provider_order";
  resume_count: number;
  updated_at: string;
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
  const returnTo = resolveEasyPayDirectSuccessRedirect(
    typeof body.return_to === "string" ? body.return_to : null,
    env.EASY_PAY_DIRECT_SUCCESS_REDIRECT_URL,
  );
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
  const appliedTaxQuote =
    surface === "product_checkout" && env.EASY_PAY_DIRECT_TAX_MODE === "enforced"
      ? await requireAppliedCheckoutTaxQuote(
          env.BILLING_DB,
          checkout.checkout_intent_id,
          body.tax_quote_id,
          body.billing_address,
        )
      : null;
  if (
    surface === "product_checkout" &&
    env.EASY_PAY_DIRECT_TAX_MODE === "enforced" &&
    !appliedTaxQuote
  ) {
    throw new ApiError(
      409,
      "checkout_tax_quote_required",
      "Confirm the billing address and updated total before paying",
    );
  }
  const submittedEmail = typeof body.email === "string" ? body.email : null;
  const customerEmail = normalizeCheckoutEmail(checkout.customer_email ?? submittedEmail);
  if (!customerEmail) {
    throw new ApiError(
      422,
      "easy_pay_direct_customer_email_required",
      "Enter a valid email address to continue",
    );
  }
  if (
    checkout.customer_email &&
    submittedEmail &&
    normalizeCheckoutEmail(submittedEmail) !== normalizeCheckoutEmail(checkout.customer_email)
  ) {
    throw new ApiError(
      409,
      "easy_pay_direct_checkout_replay_mismatch",
      "The checkout email does not match the signed customer",
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
  const emailHash = await sha256Hex(customerEmail);
  const executionId = await deterministicUuid(
    "easy-pay-direct-payment-execution",
    checkout.checkout_intent_id,
  );
  const now = new Date().toISOString();
  const termsAcceptedAt = surface === "product_checkout" ? now : null;
  const termsVersion = surface === "product_checkout" ? CHECKOUT_TERMS_VERSION : null;
  const encryptedPhone = await encryptExecutionPhone(phone, signingSecret, executionId);
  await env.BILLING_DB.prepare(
    `INSERT INTO easy_pay_direct_payment_executions
     (id, organization_id, checkout_intent_id, payment_request_id, provider_account_code,
      request_sha256, payment_token_sha256, phone_sha256, phone_ciphertext, phone_iv, email_sha256,
      tax_quote_id, billing_address_sha256,
      terms_accepted_at, terms_version,
      customer_idempotency_key, payment_method_idempotency_key,
      product_idempotency_key, order_idempotency_key, status, created_at, updated_at)
     SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?
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
      encryptedPhone.ciphertext,
      encryptedPhone.iv,
      emailHash,
      appliedTaxQuote?.quoteId ?? null,
      appliedTaxQuote?.billingAddressHash ?? null,
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
  const execution = await loadExecution(env.BILLING_DB, checkout.checkout_intent_id);
  if (!execution || execution.id !== executionId)
    throw new ApiError(409, "easy_pay_direct_checkout_conflict", "Checkout was already submitted");
  if (
    (execution.payment_token_sha256 !== paymentTokenHash && !execution.customer_vault_id) ||
    execution.phone_sha256 !== phoneHash ||
    execution.email_sha256 !== emailHash ||
    execution.tax_quote_id !== (appliedTaxQuote?.quoteId ?? null) ||
    execution.billing_address_sha256 !== (appliedTaxQuote?.billingAddressHash ?? null)
  ) {
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
  if (!checkout.customer_email) {
    const updated = await env.BILLING_DB.prepare(
      `UPDATE customers SET email = ?, updated_at = ?
       WHERE id = ? AND organization_id = ?
         AND (email IS NULL OR trim(email) = '' OR lower(trim(email)) = ?)`,
    )
      .bind(
        customerEmail,
        new Date().toISOString(),
        checkout.customer_id,
        checkout.organization_id,
        customerEmail,
      )
      .run();
    if (updated.meta.changes !== 1) {
      throw new ApiError(
        409,
        "easy_pay_direct_checkout_replay_mismatch",
        "The checkout customer email changed",
      );
    }
    checkout.customer_email = customerEmail;
  }
  const paymentRequestUpdated = await env.BILLING_DB.prepare(
    `UPDATE payment_requests SET email = ?, updated_at = ?
     WHERE id = ? AND organization_id = ?
       AND (email IS NULL OR trim(email) = '' OR lower(trim(email)) = ?)`,
  )
    .bind(
      customerEmail,
      new Date().toISOString(),
      checkout.payment_request_id,
      checkout.organization_id,
      customerEmail,
    )
    .run();
  if (paymentRequestUpdated.meta.changes !== 1) {
    throw new ApiError(
      409,
      "easy_pay_direct_checkout_replay_mismatch",
      "The checkout payment email changed",
    );
  }
  if (execution.status === "succeeded")
    return successResponse(execution.provider_transaction_id, requestId, true, returnTo);
  if (
    (execution.status === "processing" || execution.status === "unknown") &&
    execution.provider_transaction_id
  )
    return processingResponse(execution.provider_transaction_id, requestId, true, returnTo);
  if (checkout.payment_status === "succeeded" || checkout.ready_for_payment_processing !== 1) {
    throw new ApiError(409, "easy_pay_direct_checkout_state_changed", "Checkout state changed");
  }
  const resumableUnknown =
    execution.status === "unknown" &&
    Boolean(execution.customer_vault_id && execution.gateway_billing_id);
  if (execution.status !== "pending" && !resumableUnknown) {
    throw new ApiError(
      409,
      `easy_pay_direct_${execution.status}`,
      execution.failure_message || "Checkout outcome requires reconciliation",
    );
  }
  const claimed = await env.BILLING_DB.prepare(
    `UPDATE easy_pay_direct_payment_executions
     SET status = 'processing', completed_at = NULL, failure_code = NULL, failure_message = NULL,
         resume_count = resume_count + CASE WHEN status = 'unknown' THEN 1 ELSE 0 END,
         updated_at = ?
     WHERE id = ? AND status IN ('pending', 'unknown')
       AND (status = 'pending' OR (customer_vault_id IS NOT NULL AND gateway_billing_id IS NOT NULL))`,
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
          customerEmail,
          firstName: names.firstName,
          lastName: names.lastName,
          phone,
          idempotencyKey: execution.order_idempotency_key,
        },
        fetcher,
      );
      return await finalizeGatewayTestOutcome(
        env,
        checkout,
        executionId,
        transaction,
        requestId,
        returnTo,
        fetcher,
      );
    }

    const order = await advanceEasyPayDirectOrder(
      env,
      checkout,
      execution,
      { paymentToken, phone, surface },
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
    if (order.status === "succeeded") {
      try {
        await finalizeCommerceOrderSuccess(env, checkout, executionId, order, fetcher);
        return successResponse(order.id, requestId, false, returnTo);
      } catch (error) {
        console.error("easy_pay_direct_inline_reconciliation_failed", {
          executionId,
          paymentRequestId: checkout.payment_request_id,
          providerTransactionId: order.id,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return processingResponse(order.id, requestId, false, returnTo);
  } catch (error) {
    const current = await loadExecution(env.BILLING_DB, checkout.checkout_intent_id);
    if (current?.status === "processing" && !current.provider_transaction_id) {
      const gatewayFailure = gatewayVaultFailureDetails(error);
      if (gatewayFailure?.definitive) {
        await markExecution(
          env.BILLING_DB,
          executionId,
          "failed",
          null,
          gatewayFailure.providerResponseText,
          error instanceof ApiError ? error.code : "easy_pay_direct_gateway_vault_failed",
          gatewayFailure.providerResponseCode,
        );
      } else {
        await markExecution(
          env.BILLING_DB,
          executionId,
          "unknown",
          null,
          "Provider outcome requires reconciliation",
        );
      }
    }
    throw error;
  }
}

type EasyPayDirectAdvanceInput = {
  paymentToken: string | null;
  phone: string;
  surface: CheckoutSurface;
};

async function advanceEasyPayDirectOrder(
  env: Env,
  checkout: CheckoutRow,
  initialExecution: ExecutionRow,
  input: EasyPayDirectAdvanceInput,
  fetcher: typeof fetch,
): Promise<CommerceOrder> {
  let execution = initialExecution;
  const customerEmail = checkout.customer_email;
  if (!customerEmail) throw new Error("easy_pay_direct_customer_email_missing");
  const profile = await loadProfile(env.BILLING_DB, checkout);
  let customerVaultId = execution.customer_vault_id ?? profile?.gateway_customer_vault_id ?? null;
  let gatewayBillingId = execution.gateway_billing_id ?? profile?.gateway_billing_id ?? null;

  if (!customerVaultId || !gatewayBillingId) {
    if (!input.paymentToken) throw new Error("easy_pay_direct_vault_checkpoint_missing");
    const vault =
      input.surface === "synthetic_qa" || env.EASY_PAY_DIRECT_NETWORK_MODE === "test"
        ? { customerVaultId: input.paymentToken, billingId: input.paymentToken }
        : await vaultEasyPayDirectCard(
            env,
            {
              paymentToken: input.paymentToken,
              billingId: execution.payment_method_idempotency_key,
              existingCustomerVaultId: profile?.gateway_customer_vault_id,
            },
            fetcher,
          );
    customerVaultId = vault.customerVaultId;
    gatewayBillingId = vault.billingId;
  }
  await checkpointExecution(env.BILLING_DB, execution.id, "gateway_vaulted", {
    customerVaultId,
    gatewayBillingId,
  });

  execution = (await loadExecution(env.BILLING_DB, checkout.checkout_intent_id))!;
  const names = splitCustomerName(checkout.customer_name, customerEmail);
  let providerCustomerId = execution.provider_customer_id ?? profile?.provider_customer_id ?? null;
  let providerPaymentMethodId =
    execution.provider_payment_method_id ?? profile?.provider_payment_method_id ?? null;
  if (!providerCustomerId) {
    const existingCustomer = await findEasyPayDirectCustomerByEmail(env, customerEmail, fetcher);
    if (existingCustomer) {
      providerCustomerId = existingCustomer.id;
    } else {
      const customer = await createEasyPayDirectCustomer(
        env,
        {
          email: customerEmail,
          firstName: names.firstName,
          lastName: names.lastName,
          phone: input.phone,
          gatewayVaultId: customerVaultId,
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
  await checkpointExecution(env.BILLING_DB, execution.id, "provider_customer", {
    providerCustomerId,
  });

  if (!providerPaymentMethodId) {
    providerPaymentMethodId = (
      await addEasyPayDirectPaymentMethod(
        env,
        {
          customerId: providerCustomerId,
          billingId: gatewayBillingId,
          idempotencyKey: execution.payment_method_idempotency_key,
        },
        fetcher,
      )
    ).id;
  }
  await checkpointExecution(env.BILLING_DB, execution.id, "provider_payment_method", {
    providerPaymentMethodId,
  });
  await upsertProfile(env.BILLING_DB, checkout, {
    providerCustomerId,
    providerPaymentMethodId,
    gatewayCustomerVaultId: customerVaultId,
    gatewayBillingId,
  });

  execution = (await loadExecution(env.BILLING_DB, checkout.checkout_intent_id))!;
  let productId = execution.provider_product_id;
  if (!productId) {
    productId = (
      await createEasyPayDirectProduct(
        env,
        {
          paymentRequestId: checkout.payment_request_id,
          amountMinor: checkout.amount_minor,
          currency: checkout.currency,
          idempotencyKey: execution.product_idempotency_key,
        },
        fetcher,
      )
    ).id;
  }
  await checkpointExecution(env.BILLING_DB, execution.id, "provider_product", {
    providerProductId: productId,
  });

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
  await checkpointExecution(env.BILLING_DB, execution.id, "provider_order", {
    providerTransactionId: order.id,
    providerResponseCode: order.status,
  });
  return order;
}

export async function resumeEasyPayDirectExecution(
  env: Env,
  executionId: string,
  fetcher: typeof fetch = fetch,
): Promise<"advanced" | "deferred"> {
  const loaded = await loadExecutionAndCheckoutById(env.BILLING_DB, executionId);
  if (!loaded || !["processing", "unknown"].includes(loaded.execution.status)) return "deferred";
  if (loaded.execution.provider_transaction_id) return "advanced";
  if (!loaded.execution.customer_vault_id || !loaded.execution.gateway_billing_id)
    return "deferred";

  const claimed = await env.BILLING_DB.prepare(
    `UPDATE easy_pay_direct_payment_executions
     SET status = 'processing', completed_at = NULL, failure_code = NULL, failure_message = NULL,
         resume_count = resume_count + 1, updated_at = ?
     WHERE id = ? AND customer_vault_id IS NOT NULL AND gateway_billing_id IS NOT NULL
       AND (status = 'unknown' OR (status = 'processing' AND updated_at <= ?))`,
  )
    .bind(new Date().toISOString(), executionId, new Date(Date.now() - 120_000).toISOString())
    .run();
  if (claimed.meta.changes !== 1) return "deferred";

  const signingSecret = env.EASY_PAY_DIRECT_CHECKOUT_SIGNING_SECRET?.trim();
  if (!signingSecret) throw new Error("easy_pay_direct_checkout_signing_secret_missing");
  const phone = await decryptExecutionPhone(
    loaded.execution.phone_ciphertext,
    loaded.execution.phone_iv,
    signingSecret,
    executionId,
  );
  if (!phone) {
    await markExecution(
      env.BILLING_DB,
      executionId,
      "unknown",
      null,
      "Recovery phone checkpoint is unavailable",
      "easy_pay_direct_recovery_checkpoint_missing",
    );
    return "deferred";
  }
  try {
    await advanceEasyPayDirectOrder(
      env,
      loaded.checkout,
      { ...loaded.execution, status: "processing" },
      { paymentToken: null, phone, surface: "product_checkout" },
      fetcher,
    );
    return "advanced";
  } catch (error) {
    await markExecution(
      env.BILLING_DB,
      executionId,
      "unknown",
      null,
      "Provider outcome requires reconciliation",
    );
    throw error;
  }
}

async function finalizeGatewayTestOutcome(
  env: Env,
  checkout: CheckoutRow,
  executionId: string,
  transaction: GatewayTransactionResult,
  requestId: string,
  returnTo: string | null,
  fetcher: typeof fetch,
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
     SET status = ?, updated_at = ?, completed_at = ?, phone_ciphertext = NULL, phone_iv = NULL
     WHERE id = ? AND status = 'processing'`,
  )
    .bind(normalizedStatus, timestamp, timestamp, executionId)
    .run();

  if (normalizedStatus === "failed") {
    throw new ApiError(422, "easy_pay_direct_declined", failureMessage || "Payment was declined");
  }
  await commitAppliedCheckoutTaxQuote(env, executionId, providerTransactionId, fetcher);
  return successResponse(providerTransactionId, requestId, false, returnTo);
}

async function finalizeCommerceOrderSuccess(
  env: Env,
  checkout: CheckoutRow,
  executionId: string,
  order: CommerceOrder,
  fetcher: typeof fetch,
): Promise<void> {
  const timestamp = new Date().toISOString();
  const receiptId = await deterministicUuid(
    "easy-pay-direct-inline-confirmation",
    `${checkout.provider_account_code}:${order.id}:${order.status}`,
  );
  const providerEventId = `inline:${order.id}:${order.status}`;
  const payloadHash = await sha256Hex(
    JSON.stringify({
      id: order.id,
      status: order.status,
      total: order.total,
      currency: order.currency,
    }),
  );
  await env.BILLING_DB.batch([
    env.BILLING_DB.prepare(
      `INSERT INTO webhook_receipts
       (id, provider, provider_account_code, provider_event_id, signature_valid,
        payload_sha256, received_at, processed_at, processing_error_code)
       VALUES (?, 'easy_pay_direct_inline_confirmation', ?, ?, 0, ?, ?, NULL, NULL)
       ON CONFLICT(provider, provider_account_code, provider_event_id) DO NOTHING`,
    ).bind(receiptId, checkout.provider_account_code, providerEventId, payloadHash, timestamp),
    env.BILLING_DB.prepare(
      `INSERT INTO provider_webhook_events
       (receipt_id, organization_id, event_type, provider_transaction_id, invoice_id,
        normalized_status, normalized_at, payment_request_id)
       VALUES (?, ?, 'order.inline_confirmed', ?, NULL, NULL, NULL, NULL)
       ON CONFLICT(receipt_id) DO NOTHING`,
    ).bind(receiptId, checkout.organization_id, order.id),
  ]);

  try {
    const receipt: PendingReceipt = {
      receipt_id: receiptId,
      organization_id: checkout.organization_id,
      provider_account_code: checkout.provider_account_code,
      event_type: "order.inline_confirmed",
      provider_transaction_id: order.id,
      archive_key: null,
      processed_at: null,
    };
    try {
      await reconcilePaymentRequest(
        env.BILLING_DB,
        receipt,
        checkout.payment_request_id,
        {
          id: order.id,
          amountMinor: order.total,
          failureCode: null,
          failureMessage: null,
        },
        "succeeded",
        "easy_pay_direct",
      );
    } catch (error) {
      const paymentRequest = await env.BILLING_DB.prepare(
        "SELECT payment_status FROM payment_requests WHERE id = ? AND organization_id = ? LIMIT 1",
      )
        .bind(checkout.payment_request_id, checkout.organization_id)
        .first<{ payment_status: string }>();
      if (paymentRequest?.payment_status !== "succeeded") throw error;
      await reconcilePaymentRequest(
        env.BILLING_DB,
        receipt,
        checkout.payment_request_id,
        {
          id: order.id,
          amountMinor: order.total,
          failureCode: null,
          failureMessage: null,
        },
        "succeeded",
        "easy_pay_direct",
      );
    }

    await env.BILLING_DB.prepare(
      `UPDATE easy_pay_direct_payment_executions
       SET status = 'succeeded', failure_code = NULL, failure_message = NULL,
           updated_at = ?, completed_at = ?, phone_ciphertext = NULL, phone_iv = NULL
       WHERE id = ? AND status IN ('processing', 'unknown')`,
    )
      .bind(timestamp, timestamp, executionId)
      .run();
    await commitAppliedCheckoutTaxQuote(env, executionId, order.id, fetcher);
  } catch (error) {
    await env.BILLING_DB.prepare(
      `UPDATE webhook_receipts
       SET processed_at = COALESCE(processed_at, ?),
           processing_error_code = COALESCE(processing_error_code, 'inline_reconciliation_failed')
       WHERE id = ?`,
    )
      .bind(new Date().toISOString(), receiptId)
      .run();
    throw error;
  }
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
      `SELECT id, checkout_intent_id, status, payment_token_sha256, phone_sha256,
              phone_ciphertext, phone_iv, email_sha256, tax_quote_id, billing_address_sha256,
              terms_accepted_at, terms_version,
            customer_idempotency_key,
            payment_method_idempotency_key, product_idempotency_key, order_idempotency_key,
            provider_transaction_id, provider_customer_id, provider_payment_method_id,
            provider_product_id, customer_vault_id, gateway_billing_id,
            provider_response_code, failure_message, last_checkpoint, resume_count, updated_at
     FROM easy_pay_direct_payment_executions WHERE checkout_intent_id = ? LIMIT 1`,
    )
    .bind(checkoutIntentId)
    .first<ExecutionRow>();
}

async function loadExecutionById(
  database: D1Database,
  executionId: string,
): Promise<ExecutionRow | null> {
  return database
    .prepare(
      `SELECT id, checkout_intent_id, status, payment_token_sha256, phone_sha256,
              phone_ciphertext, phone_iv, email_sha256, tax_quote_id, billing_address_sha256,
              terms_accepted_at, terms_version,
              customer_idempotency_key, payment_method_idempotency_key,
              product_idempotency_key, order_idempotency_key, provider_transaction_id,
              provider_customer_id, provider_payment_method_id, provider_product_id,
              customer_vault_id, gateway_billing_id, provider_response_code,
              failure_message, last_checkpoint, resume_count, updated_at
       FROM easy_pay_direct_payment_executions WHERE id = ? LIMIT 1`,
    )
    .bind(executionId)
    .first<ExecutionRow>();
}

async function loadCheckoutByIntentId(
  database: D1Database,
  intentId: string,
): Promise<CheckoutRow | null> {
  return database
    .prepare(
      `SELECT intent.id AS checkout_intent_id, intent.organization_id, intent.payment_request_id,
              intent.customer_id, intent.provider_account_code, intent.request_sha256,
              intent.expires_at, intent.amount_minor, intent.currency,
              customer.email AS customer_email, customer.name AS customer_name,
              customer.external_id AS external_customer_id, request.payment_status,
              request.ready_for_payment_processing
       FROM payment_request_checkout_intents intent
       JOIN customers customer ON customer.id = intent.customer_id
        AND customer.organization_id = intent.organization_id
       JOIN payment_requests request ON request.id = intent.payment_request_id
        AND request.organization_id = intent.organization_id
       WHERE intent.id = ? AND intent.provider = 'easy_pay_direct' LIMIT 1`,
    )
    .bind(intentId)
    .first<CheckoutRow>();
}

async function loadExecutionAndCheckoutById(
  database: D1Database,
  executionId: string,
): Promise<{ execution: ExecutionRow; checkout: CheckoutRow } | null> {
  const execution = await loadExecutionById(database, executionId);
  if (!execution) return null;
  const checkout = await loadCheckoutByIntentId(database, execution.checkout_intent_id);
  return checkout ? { execution, checkout } : null;
}

function normalizeCheckoutEmail(value: string | null | undefined): string | null {
  const normalized = value?.trim().toLowerCase();
  if (!normalized || normalized.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(normalized)) {
    return null;
  }
  return normalized;
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

async function checkpointExecution(
  database: D1Database,
  executionId: string,
  checkpoint: ExecutionRow["last_checkpoint"],
  values: {
    customerVaultId?: string;
    gatewayBillingId?: string;
    providerCustomerId?: string;
    providerPaymentMethodId?: string;
    providerProductId?: string;
    providerTransactionId?: string;
    providerResponseCode?: string;
  },
): Promise<void> {
  const updated = await database
    .prepare(
      `UPDATE easy_pay_direct_payment_executions
       SET customer_vault_id = COALESCE(?, customer_vault_id),
           gateway_billing_id = COALESCE(?, gateway_billing_id),
           provider_customer_id = COALESCE(?, provider_customer_id),
           provider_payment_method_id = COALESCE(?, provider_payment_method_id),
           provider_product_id = COALESCE(?, provider_product_id),
           provider_transaction_id = COALESCE(?, provider_transaction_id),
           provider_response_code = COALESCE(?, provider_response_code),
           last_checkpoint = ?, updated_at = ?
       WHERE id = ? AND status = 'processing'`,
    )
    .bind(
      values.customerVaultId ?? null,
      values.gatewayBillingId ?? null,
      values.providerCustomerId ?? null,
      values.providerPaymentMethodId ?? null,
      values.providerProductId ?? null,
      values.providerTransactionId ?? null,
      values.providerResponseCode ?? null,
      checkpoint,
      new Date().toISOString(),
      executionId,
    )
    .run();
  if (updated.meta.changes !== 1) throw new Error("easy_pay_direct_checkpoint_conflict");
}

async function markExecution(
  database: D1Database,
  executionId: string,
  status: "failed" | "unknown",
  providerOrderId: string | null,
  message: string,
  failureCode: string | null = null,
  providerResponseCode: string | null = null,
): Promise<void> {
  const timestamp = new Date().toISOString();
  await database
    .prepare(
      `UPDATE easy_pay_direct_payment_executions SET status = ?, provider_transaction_id = ?,
       provider_response_code = ?, failure_code = ?, failure_message = ?, updated_at = ?,
       completed_at = ?,
       phone_ciphertext = CASE WHEN ? = 'failed' THEN NULL ELSE phone_ciphertext END,
       phone_iv = CASE WHEN ? = 'failed' THEN NULL ELSE phone_iv END
       WHERE id = ? AND status = 'processing'`,
    )
    .bind(
      status,
      providerOrderId,
      providerResponseCode,
      failureCode,
      message.slice(0, 500),
      timestamp,
      timestamp,
      status,
      status,
      executionId,
    )
    .run();
}

function gatewayVaultFailureDetails(error: unknown): GatewayVaultFailureDetails | null {
  if (!(error instanceof ApiError) || !error.details || typeof error.details !== "object") {
    return null;
  }
  const details = error.details as Partial<GatewayVaultFailureDetails>;
  if (details.provider !== "easy_pay_direct_gateway" || details.phase !== "vault") return null;
  return {
    provider: "easy_pay_direct_gateway",
    phase: "vault",
    definitive: details.definitive === true,
    providerResponseCode:
      typeof details.providerResponseCode === "string" ? details.providerResponseCode : null,
    providerResponseText:
      typeof details.providerResponseText === "string"
        ? details.providerResponseText.slice(0, 500)
        : "EPD Gateway rejected the vault request",
    providerReferenceId:
      typeof details.providerReferenceId === "string" ? details.providerReferenceId : null,
  };
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

async function encryptExecutionPhone(
  phone: string,
  signingSecret: string,
  executionId: string,
): Promise<{ ciphertext: string; iv: string }> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await executionPhoneKey(signingSecret, executionId, ["encrypt"]);
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    new TextEncoder().encode(phone),
  );
  return {
    ciphertext: encodeBase64Url(new Uint8Array(ciphertext)),
    iv: encodeBase64Url(iv),
  };
}

async function decryptExecutionPhone(
  ciphertext: string | null,
  iv: string | null,
  signingSecret: string,
  executionId: string,
): Promise<string | null> {
  if (!ciphertext || !iv) return null;
  try {
    const key = await executionPhoneKey(signingSecret, executionId, ["decrypt"]);
    const plaintext = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: decodeBase64Url(iv) },
      key,
      decodeBase64Url(ciphertext),
    );
    return new TextDecoder().decode(plaintext);
  } catch {
    return null;
  }
}

async function executionPhoneKey(
  signingSecret: string,
  executionId: string,
  usages: Array<"encrypt" | "decrypt">,
): Promise<CryptoKey> {
  const material = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(`easy-pay-direct-recovery:${executionId}:${signingSecret}`),
  );
  return crypto.subtle.importKey("raw", material, { name: "AES-GCM" }, false, usages);
}

function encodeBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/gu, "-").replace(/\//gu, "_").replace(/=+$/gu, "");
}

function decodeBase64Url(value: string): Uint8Array {
  const padded = value
    .replace(/-/gu, "+")
    .replace(/_/gu, "/")
    .padEnd(Math.ceil(value.length / 4) * 4, "=");
  const binary = atob(padded);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function processingResponse(
  orderId: string | null,
  requestId: string,
  replayed: boolean,
  redirectUrl: string | null,
): Response {
  return json(
    {
      status: "processing",
      provider: "easy_pay_direct",
      provider_order_id: orderId,
      replayed,
      redirect_url: redirectUrl,
    },
    { requestId },
  );
}

function successResponse(
  orderId: string | null,
  requestId: string,
  replayed: boolean,
  redirectUrl: string | null,
): Response {
  return json(
    {
      status: "succeeded",
      provider: "easy_pay_direct",
      provider_order_id: orderId,
      replayed,
      redirect_url: redirectUrl,
    },
    { requestId },
  );
}
