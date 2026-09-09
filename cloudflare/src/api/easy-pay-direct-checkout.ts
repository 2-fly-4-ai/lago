import { sha256Hex } from "../auth/api-key";
import { ApiError, json, parseJsonObject, requiredString } from "../http";
import { deterministicUuid } from "../identifiers";
import {
  EASY_PAY_DIRECT_PAYABLE_EXECUTION_SQL,
  EASY_PAY_DIRECT_REPLAY_WINDOW_SQL,
} from "../billing/easy-pay-direct-recovery-policy";
import { requireEasyPayDirectOrderEvidence } from "../billing/easy-pay-direct-order-evidence";
import { easyPayDirectPurchaseKind } from "../billing/easy-pay-direct-purchase-kind";
import {
  addEasyPayDirectPaymentMethod,
  chargeEasyPayDirectGatewayToken,
  createEasyPayDirectCustomer,
  createEasyPayDirectOrder,
  createEasyPayDirectProduct,
  easyPayDirectPaymentTokenHash,
  findEasyPayDirectCustomerByEmail,
  findEasyPayDirectGatewayTransactionByOrderId,
  isEasyPayDirectDirectGatewayCheckout,
  retrieveEasyPayDirectCustomer,
  resolveEasyPayDirectSuccessRedirect,
  vaultEasyPayDirectCard,
  type CommerceOrder,
  type CommerceCustomer,
  type GatewayVaultFailureDetails,
  type GatewayTransactionResult,
  type GatewayTransactionQueryResult,
} from "../providers/easy-pay-direct";
import { requireEasyPayDirectElementsMode } from "../providers/easy-pay-direct-elements-mode";
import {
  publishPaymentRequestOutboxEvents,
  reconcilePaymentRequest,
  type PendingReceipt,
} from "../reconciliation/authorize-net";
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
  customer_currency: string | null;
  customer_email: string | null;
  customer_name: string | null;
  external_customer_id: string;
  payment_status: string;
  ready_for_payment_processing: number;
};

type ExecutionRow = {
  id: string;
  charge_transport: "legacy_unknown" | "commerce" | "gateway";
  payment_backend: "gateway_vault" | "commerce_elements";
  contact_name_sha256: string | null;
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
  failure_code: string | null;
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
  id: string;
  payment_backend: "gateway_vault" | "commerce_elements";
  provider_customer_id: string;
  provider_payment_method_id: string | null;
  gateway_customer_vault_id: string | null;
  gateway_billing_id: string | null;
  initial_transaction_id: string | null;
};

export async function handleEasyPayDirectCheckoutSubmission(
  request: Request,
  env: Env,
  requestId: string,
  fetcher: typeof fetch = fetch,
  surface: CheckoutSurface = "product_checkout",
): Promise<Response> {
  const body = await parseJsonObject(request);
  const configuredBackend = env.EASY_PAY_DIRECT_CHECKOUT_BACKEND;
  const supportedBackend =
    configuredBackend === undefined ||
    configuredBackend === "gateway_vault" ||
    configuredBackend === "gateway_direct" ||
    configuredBackend === "legacy_commerce_bridge" ||
    configuredBackend === "commerce_elements";
  if (surface === "product_checkout" && !supportedBackend) {
    throw new ApiError(
      503,
      "easy_pay_direct_checkout_backend_unsafe",
      "Payments are temporarily unavailable.",
    );
  }
  if (
    surface === "product_checkout" &&
    env.EASY_PAY_DIRECT_NETWORK_MODE === "production" &&
    (configuredBackend === undefined ||
      configuredBackend === "gateway_vault" ||
      configuredBackend === "legacy_commerce_bridge") &&
    env.EASY_PAY_DIRECT_LEGACY_BRIDGE_ALLOWED !== "1"
  ) {
    throw new ApiError(
      503,
      "easy_pay_direct_checkout_backend_unsafe",
      "Payments are temporarily unavailable.",
    );
  }
  const directGateway = surface === "product_checkout" && isEasyPayDirectDirectGatewayCheckout(env);
  const paymentBackend =
    surface === "product_checkout" && env.EASY_PAY_DIRECT_CHECKOUT_BACKEND === "commerce_elements"
      ? "commerce_elements"
      : "gateway_vault";
  if (paymentBackend === "commerce_elements") requireEasyPayDirectElementsMode(env);
  const checkoutToken = requiredString(body, "checkout");
  const paymentToken = requiredString(body, "payment_token");
  if (paymentBackend === "commerce_elements" && !/^cct_[A-Za-z0-9_-]+$/u.test(paymentToken)) {
    throw new ApiError(
      422,
      "easy_pay_direct_elements_token_invalid",
      "Please enter your card in the secure payment fields.",
    );
  }
  const phone = requiredString(body, "phone");
  const contactNames =
    paymentBackend === "commerce_elements"
      ? {
          firstName: requiredString(body, "first_name").trim(),
          lastName: requiredString(body, "last_name").trim(),
        }
      : undefined;
  if (
    contactNames &&
    Object.values(contactNames).some(
      (value) => !value || value.length > 100 || /[<>\p{Cc}]/u.test(value),
    )
  ) {
    throw new ApiError(
      422,
      "easy_pay_direct_elements_contact_invalid",
      "Enter your first and last name.",
    );
  }
  const contactNameHash = contactNames ? await sha256Hex(JSON.stringify(contactNames)) : null;
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
  if (
    surface === "product_checkout" &&
    (env.PAYMENT_MUTATIONS_ENABLED !== "1" ||
      checkout.organization_id !== env.EASY_PAY_DIRECT_ORGANIZATION_ID ||
      checkout.provider_account_code !== env.EASY_PAY_DIRECT_ACCOUNT_CODE)
  ) {
    throw new ApiError(
      503,
      "easy_pay_direct_payments_disabled",
      "Payments are not enabled for this checkout.",
    );
  }
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
  if (checkout.customer_currency && checkout.customer_currency !== checkout.currency) {
    throw new ApiError(
      409,
      "easy_pay_direct_checkout_currency_mismatch",
      "The checkout currency does not match the customer billing currency",
    );
  }
  const customerCurrencyUpdated = await env.BILLING_DB.prepare(
    `UPDATE customers SET currency = COALESCE(currency, ?),
       version = version + CASE WHEN currency IS NULL THEN 1 ELSE 0 END,
       updated_at = CASE WHEN currency IS NULL THEN ? ELSE updated_at END
     WHERE id = ? AND organization_id = ? AND (currency IS NULL OR currency = ?)
       AND NOT EXISTS (SELECT 1 FROM invoices invoice
         WHERE invoice.customer_id = customers.id AND invoice.organization_id = customers.organization_id
           AND invoice.currency <> ?)
       AND NOT EXISTS (SELECT 1 FROM payment_requests request
         WHERE request.customer_id = customers.id AND request.organization_id = customers.organization_id
           AND request.currency <> ?)
       AND NOT EXISTS (SELECT 1 FROM subscriptions subscription
         JOIN plans plan ON plan.id = subscription.plan_id
           AND plan.organization_id = subscription.organization_id
         WHERE subscription.customer_id = customers.id
           AND subscription.organization_id = customers.organization_id AND plan.currency <> ?)
       AND NOT EXISTS (SELECT 1 FROM wallets wallet
         WHERE wallet.customer_id = customers.id AND wallet.organization_id = customers.organization_id
           AND wallet.currency <> ?)`,
  )
    .bind(
      checkout.currency,
      new Date().toISOString(),
      checkout.customer_id,
      checkout.organization_id,
      checkout.currency,
      checkout.currency,
      checkout.currency,
      checkout.currency,
      checkout.currency,
    )
    .run();
  if (customerCurrencyUpdated.meta.changes !== 1) {
    throw new ApiError(
      409,
      "easy_pay_direct_checkout_currency_mismatch",
      "The checkout currency does not match the customer billing currency",
    );
  }
  checkout.customer_currency = checkout.currency;
  if (
    paymentBackend === "gateway_vault" &&
    surface === "product_checkout" &&
    env.EASY_PAY_DIRECT_NETWORK_MODE === "test"
  ) {
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
  const chargeTransport =
    paymentBackend === "gateway_vault" && directGateway ? "gateway" : "commerce";
  const termsAcceptedAt = surface === "product_checkout" ? now : null;
  const termsVersion = surface === "product_checkout" ? CHECKOUT_TERMS_VERSION : null;
  const encryptedPhone = await encryptExecutionPhone(phone, signingSecret, executionId);
  await env.BILLING_DB.prepare(
    `INSERT INTO easy_pay_direct_payment_executions
     (id, charge_transport, payment_backend, contact_name_sha256, organization_id, checkout_intent_id, payment_request_id, provider_account_code,
      request_sha256, payment_token_sha256, phone_sha256, phone_ciphertext, phone_iv, email_sha256,
      tax_quote_id, billing_address_sha256,
      terms_accepted_at, terms_version,
      customer_idempotency_key, payment_method_idempotency_key,
      product_idempotency_key, order_idempotency_key, status, created_at, updated_at)
     SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?
     WHERE NOT EXISTS (
       SELECT 1 FROM easy_pay_direct_payment_executions WHERE checkout_intent_id = ?
     )
     ON CONFLICT(checkout_intent_id) DO NOTHING`,
  )
    .bind(
      executionId,
      chargeTransport,
      paymentBackend,
      contactNameHash,
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
    execution.payment_backend !== paymentBackend ||
    (execution.charge_transport !== chargeTransport && execution.status !== "succeeded") ||
    execution.contact_name_sha256 !== contactNameHash
  )
    throw new ApiError(
      409,
      "easy_pay_direct_checkout_backend_changed",
      "This checkout needs review before another payment attempt.",
    );
  const retryableReadOnlyPreflight =
    execution.status === "pending" &&
    execution.failure_code === "easy_pay_direct_customer_lookup_retryable" &&
    !execution.customer_vault_id &&
    !execution.gateway_billing_id &&
    !execution.provider_customer_id &&
    !execution.provider_payment_method_id &&
    !execution.provider_product_id &&
    !execution.provider_transaction_id;
  if (
    (execution.payment_token_sha256 !== paymentTokenHash &&
      !execution.customer_vault_id &&
      !retryableReadOnlyPreflight) ||
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
  if (checkout.payment_status === "succeeded") {
    await publishPaymentRequestOutboxEvents(
      env.BILLING_DB,
      env.DOMAIN_EVENTS,
      checkout.organization_id,
      checkout.payment_request_id,
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
    !isPaymentSetupReviewCode(execution.failure_code) &&
    Boolean(execution.customer_vault_id && execution.gateway_billing_id);
  if (execution.status !== "pending" && !resumableUnknown) {
    throw new ApiError(
      409,
      `easy_pay_direct_${execution.status}`,
      execution.failure_message || "Checkout outcome requires reconciliation",
    );
  }
  const gatewayPurchaseKind =
    chargeTransport === "gateway"
      ? await easyPayDirectPurchaseKind(
          env.BILLING_DB,
          checkout.organization_id,
          checkout.payment_request_id,
        )
      : null;
  if (directGateway && !gatewayPurchaseKind) {
    throw new ApiError(
      409,
      "easy_pay_direct_purchase_kind_unverified",
      "The purchase billing terms need review before payment.",
    );
  }
  if (gatewayPurchaseKind && env.PROVIDER_READS_ENABLED !== "1") {
    throw new ApiError(
      503,
      "provider_reads_disabled",
      "Payment confirmation is unavailable. Please try later.",
    );
  }
  const claimed = await env.BILLING_DB.prepare(
    `UPDATE easy_pay_direct_payment_executions
     SET status = 'processing', completed_at = NULL, failure_code = NULL, failure_message = NULL,
         resume_count = resume_count + CASE WHEN status = 'unknown' THEN 1 ELSE 0 END,
         updated_at = ?
     WHERE id = ? AND status IN ('pending', 'unknown')
       AND COALESCE(failure_code, '') NOT IN (${EASY_PAY_DIRECT_SETUP_REVIEW_CODES.map(() => "?").join(", ")})
       AND ${EASY_PAY_DIRECT_PAYABLE_EXECUTION_SQL}
       AND (status = 'pending' OR (customer_vault_id IS NOT NULL AND gateway_billing_id IS NOT NULL))`,
  )
    .bind(new Date().toISOString(), executionId, ...EASY_PAY_DIRECT_SETUP_REVIEW_CODES)
    .run();
  if (claimed.meta.changes !== 1)
    throw new ApiError(409, "easy_pay_direct_processing", "Checkout is already processing");

  try {
    await requireEasyPayDirectReplayWindow(env.BILLING_DB, executionId);
    if (paymentBackend === "gateway_vault" && directGateway) {
      const names = splitCustomerName(checkout.customer_name, checkout.customer_email);
      const transaction = await chargeEasyPayDirectGatewayToken(
        env,
        {
          paymentToken,
          purchaseKind: gatewayPurchaseKind!,
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
      return await finalizeGatewayOutcome(
        env,
        checkout,
        executionId,
        transaction,
        requestId,
        returnTo,
        fetcher,
        gatewayPurchaseKind!,
      );
    }

    const order = await advanceEasyPayDirectOrder(
      env,
      checkout,
      execution,
      { paymentToken, phone, surface, billingAddress: body.billing_address, contactNames },
      fetcher,
    );
    await requireEasyPayDirectOrderEvidence(
      env.BILLING_DB,
      checkout.organization_id,
      checkout.payment_request_id,
      order,
      order.id,
    );
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
        await publishPaymentRequestOutboxEvents(
          env.BILLING_DB,
          env.DOMAIN_EVENTS,
          checkout.organization_id,
          checkout.payment_request_id,
        );
        return successResponse(order.id, requestId, false, returnTo);
      } catch (error) {
        console.error("easy_pay_direct_inline_reconciliation_failed", {
          executionId,
          paymentRequestId: checkout.payment_request_id,
          providerTransactionId: order.id,
          error_code: error instanceof ApiError ? error.code : "post_payment_finalization_failed",
        });
      }
    }
    return processingResponse(order.id, requestId, false, returnTo);
  } catch (error) {
    const current = await loadExecution(env.BILLING_DB, checkout.checkout_intent_id);
    if (current?.status === "processing" && !current.provider_transaction_id) {
      if (
        error instanceof ApiError &&
        error.code === "easy_pay_direct_customer_lookup_retryable" &&
        execution.status === "pending" &&
        !current.customer_vault_id &&
        !current.gateway_billing_id &&
        !current.provider_customer_id &&
        !current.provider_payment_method_id &&
        !current.provider_product_id
      ) {
        // Only the read-only preflight failed. No token was consumed on this
        // attempt. Never reset an uncertain vault/attachment/order operation.
        await env.BILLING_DB.prepare(
          `UPDATE easy_pay_direct_payment_executions
           SET status = 'pending', failure_code = ?, failure_message = ?,
               completed_at = NULL, updated_at = ?
           WHERE id = ? AND status = 'processing'
             AND customer_vault_id IS NULL AND gateway_billing_id IS NULL
             AND provider_customer_id IS NULL AND provider_payment_method_id IS NULL
             AND provider_product_id IS NULL AND provider_transaction_id IS NULL`,
        )
          .bind(error.code, error.message, new Date().toISOString(), executionId)
          .run();
        throw error;
      }
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
      } else if (
        error instanceof ApiError &&
        (isPaymentSetupReviewCode(error.code) ||
          error.code === "easy_pay_direct_customer_lookup_retryable")
      ) {
        await markExecution(
          env.BILLING_DB,
          executionId,
          "unknown",
          null,
          error.message,
          error.code,
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
    if (
      env.EASY_PAY_DIRECT_NETWORK_MODE === "gateway_test" &&
      current?.status === "processing" &&
      current.provider_transaction_id
    ) {
      // The sale returned, but local finalization failed. Release only this
      // completed submission for read-only recovery; never submit the sale again.
      await markExecution(
        env.BILLING_DB,
        executionId,
        "unknown",
        current.provider_transaction_id,
        "Gateway result requires local finalization",
      );
    }
    throw error;
  }
}

/**
 * Read-only browser recovery for an interrupted checkout submission. The signed
 * checkout token identifies the intent; this endpoint never accepts card data,
 * calls EPD, or changes the execution. Provider reconciliation remains the
 * only process allowed to advance an ambiguous provider outcome.
 */
export async function handleEasyPayDirectCheckoutStatus(
  request: Request,
  env: Env,
  requestId: string,
): Promise<Response> {
  const body = await parseJsonObject(request);
  const checkoutToken = requiredString(body, "checkout");
  if (checkoutToken.length > 2_048)
    throw new ApiError(422, "invalid_easy_pay_direct_submission", "Checkout status is invalid");
  const signingSecret = env.EASY_PAY_DIRECT_CHECKOUT_SIGNING_SECRET?.trim();
  if (!signingSecret)
    throw new ApiError(503, "provider_not_configured", "Payment status is unavailable");
  const { verifyEasyPayDirectCheckoutToken } = await import("../providers/easy-pay-direct");
  const tokenPayload = await verifyEasyPayDirectCheckoutToken(checkoutToken, signingSecret);
  const checkout = await loadCheckout(
    env.BILLING_DB,
    tokenPayload.intent,
    await sha256Hex(checkoutToken),
  );
  if (!checkout)
    throw new ApiError(401, "easy_pay_direct_checkout_invalid", "Checkout link is invalid");
  const execution = await loadExecution(env.BILLING_DB, checkout.checkout_intent_id);
  if (!execution) return json({ status: "not_submitted" }, { requestId });
  if (execution.status === "succeeded" || checkout.payment_status === "succeeded") {
    return successResponse(execution.provider_transaction_id, requestId, true, null);
  }
  if (execution.status === "failed") {
    return json(
      {
        status: "failed",
        message: "This payment was not completed. Start a new checkout before trying another card.",
      },
      { requestId },
    );
  }
  if (execution.provider_transaction_id) {
    return processingResponse(execution.provider_transaction_id, requestId, true, null);
  }
  if (
    execution.status === "pending" &&
    execution.failure_code === "easy_pay_direct_customer_lookup_retryable" &&
    !execution.provider_customer_id &&
    !execution.provider_payment_method_id &&
    !execution.provider_product_id
  ) {
    return json(
      {
        status: "retryable",
        message: "The payment was not submitted. Reload the secure card fields to try again.",
      },
      { requestId },
    );
  }
  return json(
    {
      status: "review",
      message: "Payment confirmation is still pending. Do not submit another payment.",
    },
    { requestId },
  );
}

type EasyPayDirectAdvanceInput = {
  paymentToken: string | null;
  phone: string;
  surface: CheckoutSurface;
  billingAddress?: unknown;
  contactNames?: { firstName: string; lastName: string };
};

async function advanceElementsOrder(
  env: Env,
  checkout: CheckoutRow,
  execution: ExecutionRow,
  input: EasyPayDirectAdvanceInput,
  fetcher: typeof fetch,
): Promise<CommerceOrder> {
  const epd = await import("../providers/easy-pay-direct-elements");
  const email = checkout.customer_email;
  if (!email || !input.paymentToken) throw new Error("easy_pay_direct_elements_capture_missing");
  const names = input.contactNames;
  if (!names)
    throw new ApiError(
      422,
      "easy_pay_direct_elements_contact_invalid",
      "Enter your first and last name.",
    );
  // Use a verified customer, but always attach THIS submission's card. Never
  // silently substitute a previously saved default payment method.
  let customerId = execution.provider_customer_id;
  if (!customerId) {
    let existing: import("../providers/easy-pay-direct-elements").ElementsCustomer | null;
    try {
      existing = await epd.findEasyPayDirectElementsCustomerByEmail(env, email, fetcher);
    } catch (error) {
      // This GET is the only Elements step that is provably pre-mutation. A
      // transient transport/provider failure here cannot have consumed the cct
      // or created a remote resource, so the execution may safely be retried.
      if (error instanceof ApiError && (error.status === 429 || error.status >= 500)) {
        throw new ApiError(
          503,
          "easy_pay_direct_customer_lookup_retryable",
          "Payment setup is temporarily unavailable. Please try again shortly.",
        );
      }
      throw error;
    }
    await requireEasyPayDirectReplayWindow(env.BILLING_DB, execution.id);
    customerId =
      existing?.id ??
      (
        await epd.createEasyPayDirectElementsCustomer(
          env,
          {
            email,
            firstName: names.firstName,
            lastName: names.lastName,
            phone: input.phone,
            idempotencyKey: execution.customer_idempotency_key,
            metadata: { lago_customer_id: checkout.customer_id },
          },
          fetcher,
        )
      ).id;
    await checkpointExecution(env.BILLING_DB, execution.id, "provider_customer", {
      providerCustomerId: customerId,
    });
  }
  await epd.retrieveEasyPayDirectElementsCustomer(env, { customerId, email }, fetcher);
  let paymentMethodId = execution.provider_payment_method_id;
  if (!paymentMethodId) {
    const address =
      input.billingAddress &&
      typeof input.billingAddress === "object" &&
      !Array.isArray(input.billingAddress)
        ? (input.billingAddress as Record<string, unknown>)
        : {};
    const billingDetails: import("../providers/easy-pay-direct-elements").ElementsBillingDetails = {
      email,
      phone: input.phone,
    };
    for (const [source, target] of [
      ["address_line", "address1"],
      ["city", "city"],
      ["state", "state"],
      ["postal_code", "zip"],
      ["country", "country"],
    ] as const) {
      if (typeof address[source] === "string" && address[source].trim())
        billingDetails[target] = address[source].trim();
    }
    await requireEasyPayDirectReplayWindow(env.BILLING_DB, execution.id);
    paymentMethodId = (
      await epd.addEasyPayDirectElementsPaymentMethod(
        env,
        {
          customerId,
          cardToken: input.paymentToken,
          idempotencyKey: execution.payment_method_idempotency_key,
          billingDetails,
        },
        fetcher,
      )
    ).id;
    await checkpointExecution(env.BILLING_DB, execution.id, "provider_payment_method", {
      providerPaymentMethodId: paymentMethodId,
    });
  }
  await upsertProfile(env.BILLING_DB, checkout, {
    paymentBackend: "commerce_elements",
    providerCustomerId: customerId,
    providerPaymentMethodId: paymentMethodId,
    gatewayCustomerVaultId: null,
    gatewayBillingId: null,
  });
  let productId = execution.provider_product_id;
  if (!productId) {
    await requireEasyPayDirectReplayWindow(env.BILLING_DB, execution.id);
    productId = (
      await epd.createEasyPayDirectElementsProduct(
        env,
        {
          name: "SERP checkout",
          description: "SERP digital software purchase",
          metadata: { lago_payment_request_id: checkout.payment_request_id },
          amountMinor: checkout.amount_minor,
          currency: checkout.currency,
          idempotencyKey: execution.product_idempotency_key,
        },
        fetcher,
      )
    ).id;
    await checkpointExecution(env.BILLING_DB, execution.id, "provider_product", {
      providerProductId: productId,
    });
  }
  await epd.getEasyPayDirectElementsProduct(
    env,
    {
      productId,
      amountMinor: checkout.amount_minor,
      currency: checkout.currency,
    },
    fetcher,
  );
  const payable = await env.BILLING_DB.prepare(`SELECT id FROM easy_pay_direct_payment_executions
    WHERE id = ? AND status = 'processing' AND payment_backend = 'commerce_elements'
      AND ${EASY_PAY_DIRECT_PAYABLE_EXECUTION_SQL}`)
    .bind(execution.id)
    .first();
  if (!payable)
    throw new ApiError(
      409,
      "easy_pay_direct_checkout_state_changed",
      "Checkout is no longer available for payment.",
    );
  if (env.PAYMENT_MUTATIONS_ENABLED !== "1")
    throw new ApiError(
      503,
      "easy_pay_direct_elements_disabled",
      "Payments are temporarily unavailable.",
    );
  await requireEasyPayDirectReplayWindow(env.BILLING_DB, execution.id);
  const result = await epd.createEasyPayDirectElementsOrder(
    env,
    {
      customerId,
      paymentMethodId,
      productId,
      currency: checkout.currency,
      idempotencyKey: execution.order_idempotency_key,
      metadata: {
        lago_payment_request_id: checkout.payment_request_id,
        lago_checkout_intent_id: checkout.checkout_intent_id,
      },
    },
    fetcher,
  );
  // Save financial identity before validating the response. An invalid response
  // must leave an order for read-only reconciliation, not invite a second charge.
  await checkpointExecution(env.BILLING_DB, execution.id, "provider_order", {
    providerTransactionId: result.id,
  });
  return epd.validateEasyPayDirectElementsOrder(result.evidence, {
    orderId: result.id,
    customerId,
    paymentMethodId,
    amountMinor: checkout.amount_minor,
    currency: checkout.currency,
  });
}

export const EASY_PAY_DIRECT_SETUP_REVIEW_CODES: readonly string[] = [
  "easy_pay_direct_customer_vault_mismatch",
  "easy_pay_direct_customer_vault_unverified",
  "easy_pay_direct_customer_ambiguous",
  "easy_pay_direct_payment_method_rejected",
  "easy_pay_direct_checkout_state_changed",
  "easy_pay_direct_idempotency_window_expired",
];

function isPaymentSetupReviewCode(code: string | null): boolean {
  return code !== null && EASY_PAY_DIRECT_SETUP_REVIEW_CODES.includes(code);
}

// An old missing response is not proof that EPD did not accept its request.
// Once provider deduplication can expire, retain evidence for read-only/manual
// reconciliation instead of replaying any provider mutation with the old key.
export async function requireEasyPayDirectReplayWindow(
  database: D1Database,
  executionId: string,
): Promise<void> {
  const withinWindow = await database
    .prepare(
      `SELECT id FROM easy_pay_direct_payment_executions
     WHERE id = ? AND ${EASY_PAY_DIRECT_REPLAY_WINDOW_SQL}`,
    )
    .bind(executionId)
    .first();
  if (withinWindow) return;
  await database
    .prepare(
      `UPDATE easy_pay_direct_payment_executions
     SET status = 'unknown', failure_code = 'easy_pay_direct_idempotency_window_expired',
         failure_message = 'Payment setup needs review before another payment can be submitted',
         completed_at = NULL, updated_at = ?
     WHERE id = ? AND provider_transaction_id IS NULL
       AND status IN ('pending', 'processing', 'unknown')`,
    )
    .bind(new Date().toISOString(), executionId)
    .run();
  throw new ApiError(
    409,
    "easy_pay_direct_idempotency_window_expired",
    "Payment setup needs review. Please contact support before trying again.",
  );
}

function verifiedCustomerVault(customer: CommerceCustomer, email: string): string {
  const vaultId = customer.epd_gateway_customer_vault_id;
  if (typeof vaultId !== "string" || !vaultId.trim() || typeof customer.email !== "string") {
    throw new ApiError(
      409,
      "easy_pay_direct_customer_vault_unverified",
      "Payment setup could not be verified. Please contact support before trying again.",
    );
  }
  if (customer.email.trim().toLowerCase() !== email.trim().toLowerCase()) {
    throw new ApiError(
      409,
      "easy_pay_direct_customer_vault_mismatch",
      "Payment setup needs review. Please contact support before trying again.",
    );
  }
  return vaultId.trim();
}

async function advanceEasyPayDirectOrder(
  env: Env,
  checkout: CheckoutRow,
  initialExecution: ExecutionRow,
  input: EasyPayDirectAdvanceInput,
  fetcher: typeof fetch,
): Promise<CommerceOrder> {
  if (initialExecution.payment_backend === "commerce_elements") {
    return advanceElementsOrder(env, checkout, initialExecution, input, fetcher);
  }
  let execution = initialExecution;
  const customerEmail = checkout.customer_email;
  if (!customerEmail) throw new Error("easy_pay_direct_customer_email_missing");
  const profile = await loadProfile(env.BILLING_DB, checkout);
  if (profile?.payment_backend === "commerce_elements") {
    throw new ApiError(
      409,
      "easy_pay_direct_checkout_backend_changed",
      "Saved payment setup needs review.",
    );
  }
  let customerVaultId = execution.customer_vault_id ?? profile?.gateway_customer_vault_id ?? null;
  let providerCustomerId = execution.provider_customer_id ?? profile?.provider_customer_id ?? null;
  const production = env.EASY_PAY_DIRECT_NETWORK_MODE === "production";
  // Resolve the Commerce customer's authoritative vault BEFORE consuming a
  // Collect.js token. An interrupted prior checkout may have created the
  // customer without ever reaching the local reusable-profile checkpoint.
  if (production) {
    try {
      const candidate = providerCustomerId
        ? { id: providerCustomerId }
        : await findEasyPayDirectCustomerByEmail(env, customerEmail, fetcher);
      if (candidate) {
        const customer = await retrieveEasyPayDirectCustomer(env, candidate.id, fetcher);
        const linkedVaultId = verifiedCustomerVault(customer, customerEmail);
        if (customerVaultId && customerVaultId !== linkedVaultId) {
          throw new ApiError(
            409,
            "easy_pay_direct_customer_vault_mismatch",
            "Payment setup needs review. Please contact support before trying again.",
          );
        }
        providerCustomerId = customer.id;
        customerVaultId = linkedVaultId;
      }
    } catch (error) {
      if (!(error instanceof ApiError) || error.status === 429 || error.status >= 500) {
        throw new ApiError(
          503,
          "easy_pay_direct_customer_lookup_retryable",
          "Payment setup is temporarily unavailable. Please try again shortly.",
        );
      }
      throw error;
    }
  }
  // A saved customer profile is not authorization to ignore the card submitted
  // for this checkout. Only this execution's durable checkpoint may be replayed.
  let gatewayBillingId = execution.gateway_billing_id ?? null;
  const hasCommerceCompatibleBillingId =
    env.EASY_PAY_DIRECT_NETWORK_MODE !== "production" ||
    (gatewayBillingId !== null && /^\d{1,32}$/u.test(gatewayBillingId));

  if (!customerVaultId || !gatewayBillingId || !hasCommerceCompatibleBillingId) {
    if (!input.paymentToken) throw new Error("easy_pay_direct_vault_checkpoint_missing");
    await requireEasyPayDirectReplayWindow(env.BILLING_DB, execution.id);
    const vault =
      input.surface === "synthetic_qa" || env.EASY_PAY_DIRECT_NETWORK_MODE === "test"
        ? { customerVaultId: input.paymentToken, billingId: input.paymentToken }
        : await vaultEasyPayDirectCard(
            env,
            {
              paymentToken: input.paymentToken,
              billingId: execution.payment_method_idempotency_key,
              existingCustomerVaultId: customerVaultId,
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
  let providerPaymentMethodId = execution.provider_payment_method_id ?? null;
  if (!providerCustomerId) {
    // Production lookup already happened before vaulting. Never do a second
    // email lookup here and silently adopt a different customer after a race.
    const existingCustomer = production
      ? null
      : await findEasyPayDirectCustomerByEmail(env, customerEmail, fetcher);
    if (existingCustomer) {
      providerCustomerId = existingCustomer.id;
    } else {
      await requireEasyPayDirectReplayWindow(env.BILLING_DB, execution.id);
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
      if (production) {
        const createdCustomer = await retrieveEasyPayDirectCustomer(env, customer.id, fetcher);
        if (verifiedCustomerVault(createdCustomer, customerEmail) !== customerVaultId) {
          throw new ApiError(
            409,
            "easy_pay_direct_customer_vault_mismatch",
            "Payment setup needs review. Please contact support before trying again.",
          );
        }
      } else {
        providerPaymentMethodId = customer.default_payment_method ?? null;
      }
    }
  }
  await checkpointExecution(env.BILLING_DB, execution.id, "provider_customer", {
    providerCustomerId,
  });

  if (!providerPaymentMethodId) {
    await requireEasyPayDirectReplayWindow(env.BILLING_DB, execution.id);
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
    await requireEasyPayDirectReplayWindow(env.BILLING_DB, execution.id);
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

  // Provider setup involves network waits. Recheck authoritative payment/closure
  // state immediately before an order, not just the earlier claim snapshot.
  const payable = await env.BILLING_DB.prepare(
    `SELECT id FROM easy_pay_direct_payment_executions
     WHERE id = ? AND status = 'processing' AND ${EASY_PAY_DIRECT_PAYABLE_EXECUTION_SQL}`,
  )
    .bind(execution.id)
    .first<{ id: string }>();
  if (!payable) {
    throw new ApiError(
      409,
      "easy_pay_direct_checkout_state_changed",
      "Checkout is no longer available for payment. Please contact support before trying again.",
    );
  }
  await requireEasyPayDirectReplayWindow(env.BILLING_DB, execution.id);
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
  if (loaded.execution.charge_transport !== "commerce") return "deferred";
  // Never send an Elements token or saved UUID through the legacy vault bridge.
  if (loaded.execution.payment_backend === "commerce_elements") return "deferred";
  if (loaded.execution.provider_transaction_id) return "advanced";
  try {
    await requireEasyPayDirectReplayWindow(env.BILLING_DB, executionId);
  } catch (error) {
    if (error instanceof ApiError && error.code === "easy_pay_direct_idempotency_window_expired")
      return "deferred";
    throw error;
  }
  if (
    loaded.checkout.payment_status === "succeeded" ||
    loaded.checkout.ready_for_payment_processing !== 1
  )
    return "deferred";
  if (isPaymentSetupReviewCode(loaded.execution.failure_code)) return "deferred";
  if (!loaded.execution.customer_vault_id || !loaded.execution.gateway_billing_id)
    return "deferred";
  // Legacy billing checkpoints require a fresh customer token to re-vault.
  // Background recovery has no token: preserve the unresolved evidence instead
  // of claiming/retrying the execution and aborting unrelated reconciliation.
  if (
    env.EASY_PAY_DIRECT_NETWORK_MODE === "production" &&
    !/^\d{1,32}$/u.test(loaded.execution.gateway_billing_id)
  ) {
    return "deferred";
  }

  const claimed = await env.BILLING_DB.prepare(
    `UPDATE easy_pay_direct_payment_executions
     SET status = 'processing', completed_at = NULL, failure_code = NULL, failure_message = NULL,
         resume_count = resume_count + 1, updated_at = ?
     WHERE id = ? AND customer_vault_id IS NOT NULL AND gateway_billing_id IS NOT NULL
       AND COALESCE(failure_code, '') NOT IN (${EASY_PAY_DIRECT_SETUP_REVIEW_CODES.map(() => "?").join(", ")})
       AND ${EASY_PAY_DIRECT_PAYABLE_EXECUTION_SQL}
       AND (status = 'unknown' OR (status = 'processing' AND updated_at <= ?))`,
  )
    .bind(
      new Date().toISOString(),
      executionId,
      ...EASY_PAY_DIRECT_SETUP_REVIEW_CODES,
      new Date(Date.now() - 120_000).toISOString(),
    )
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
    if (
      error instanceof ApiError &&
      (isPaymentSetupReviewCode(error.code) ||
        error.code === "easy_pay_direct_customer_lookup_retryable")
    ) {
      await markExecution(env.BILLING_DB, executionId, "unknown", null, error.message, error.code);
      return "deferred";
    }
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

export async function reconcileEasyPayDirectGatewayExecution(
  env: Env,
  executionId: string,
  fetcher: typeof fetch,
): Promise<"processed" | "deferred"> {
  if (
    (env.EASY_PAY_DIRECT_NETWORK_MODE !== "gateway_test" &&
      env.EASY_PAY_DIRECT_NETWORK_MODE !== "production") ||
    (env.EASY_PAY_DIRECT_NETWORK_MODE === "gateway_test" &&
      env.EASY_PAY_DIRECT_LIVEMODE_ALLOWED !== "0") ||
    (env.EASY_PAY_DIRECT_NETWORK_MODE === "production" &&
      env.EASY_PAY_DIRECT_LIVEMODE_ALLOWED !== "1") ||
    String(env.PROVIDER_READS_ENABLED) !== "1"
  )
    return "deferred";
  const state = await loadExecutionAndCheckoutById(env.BILLING_DB, executionId);
  if (
    !state ||
    state.execution.charge_transport !== "gateway" ||
    !["processing", "unknown"].includes(state.execution.status) ||
    state.checkout.organization_id !== env.EASY_PAY_DIRECT_ORGANIZATION_ID ||
    state.checkout.provider_account_code !== env.EASY_PAY_DIRECT_ACCOUNT_CODE
  )
    return "deferred";
  const lease = new Date().toISOString();
  const claimed = await env.BILLING_DB.prepare(`UPDATE easy_pay_direct_payment_executions
    SET status='processing', updated_at=? WHERE id=?
      AND (status='unknown' OR (status='processing' AND julianday(updated_at)<=julianday(?, '-2 minutes')))
    RETURNING id`)
    .bind(lease, executionId, lease)
    .first<{ id: string }>();
  if (!claimed) return "deferred";
  try {
    const transaction = await findEasyPayDirectGatewayTransactionByOrderId(
      env,
      state.checkout.payment_request_id,
      fetcher,
    );
    if (!transaction?.id?.trim() || transaction.status === "unknown") return "deferred";
    await requireEasyPayDirectOrderEvidence(
      env.BILLING_DB,
      state.checkout.organization_id,
      state.checkout.payment_request_id,
      { id: transaction.id, total: transaction.amountMinor, currency: transaction.currency },
      state.execution.provider_transaction_id ?? transaction.id,
    );
    // The original sale may have succeeded without returning any checkpoint.
    // Record only the exact unique verified order read, fenced to this lease.
    const checkpoint = await env.BILLING_DB.prepare(`UPDATE easy_pay_direct_payment_executions
      SET provider_transaction_id=? WHERE id=? AND status='processing' AND updated_at=?
        AND (provider_transaction_id IS NULL OR provider_transaction_id=?)
        AND NOT EXISTS (SELECT 1 FROM easy_pay_direct_payment_executions other
          WHERE other.id<>easy_pay_direct_payment_executions.id
            AND other.provider_account_code=easy_pay_direct_payment_executions.provider_account_code
            AND other.provider_transaction_id=?) RETURNING id`)
      .bind(transaction.id, executionId, lease, transaction.id, transaction.id)
      .first<{ id: string }>();
    if (!checkpoint) return "deferred";
    const purchaseKind = await easyPayDirectPurchaseKind(
      env.BILLING_DB,
      state.checkout.organization_id,
      state.checkout.payment_request_id,
    );
    await finalizeGatewayOutcome(
      env,
      state.checkout,
      executionId,
      transaction,
      "gateway-reconciliation",
      null,
      fetcher,
      purchaseKind,
      transaction,
    );
    return "processed";
  } finally {
    // Empty, ambiguous and interrupted reads stay retryable and rotate fairly.
    // Never clear a later checkpoint or overwrite a completed execution.
    await env.BILLING_DB.prepare(`UPDATE easy_pay_direct_payment_executions
      SET status='unknown', updated_at=? WHERE id=? AND status='processing' AND updated_at=?`)
      .bind(new Date().toISOString(), executionId, lease)
      .run();
  }
}

async function finalizeGatewayOutcome(
  env: Env,
  checkout: CheckoutRow,
  executionId: string,
  transaction: GatewayTransactionResult,
  requestId: string,
  returnTo: string | null,
  fetcher: typeof fetch,
  purchaseKind: "one_time" | "recurring",
  readEvidence?: GatewayTransactionQueryResult,
): Promise<Response> {
  const timestamp = new Date().toISOString();
  const rawTransactionId = transaction.id?.trim();
  const providerTransactionId =
    rawTransactionId && rawTransactionId !== "0" ? rawTransactionId : null;
  const successfulHttp =
    transaction.httpStatus !== undefined &&
    transaction.httpStatus >= 200 &&
    transaction.httpStatus < 300;
  // NMI documents code300 as rejected by the Gateway, unlike communication
  // errors420/421 or duplicate430 (which may refer to an earlier charge).
  // Only a fresh unambiguous 2xx response3/code300 without approval/transaction
  // evidence can close this execution without inventing a financial ledger row.
  // https://docs.nmi.com/reference/transactions-processing
  if (
    !providerTransactionId &&
    transaction.status === "failed" &&
    successfulHttp &&
    transaction.rawStatus === "3" &&
    transaction.responseCode === "300" &&
    !transaction.authCode &&
    (!transaction.orderId || transaction.orderId === checkout.payment_request_id)
  ) {
    const rejected = await env.BILLING_DB.prepare(`UPDATE easy_pay_direct_payment_executions
      SET status='failed', provider_response_code=?, failure_code='300', failure_message=?,
          updated_at=?, completed_at=?, phone_ciphertext=NULL, phone_iv=NULL
      WHERE id=? AND charge_transport='gateway' AND status='processing' AND provider_transaction_id IS NULL
        AND NOT EXISTS (SELECT 1 FROM payment_request_payments paid
          WHERE paid.organization_id=easy_pay_direct_payment_executions.organization_id
            AND paid.payment_request_id=easy_pay_direct_payment_executions.payment_request_id
            AND paid.status='succeeded') RETURNING id`)
      .bind(
        transaction.responseCode,
        transaction.responseText.slice(0, 500),
        timestamp,
        timestamp,
        executionId,
      )
      .first();
    if (rejected)
      throw new ApiError(
        422,
        "easy_pay_direct_gateway_rejected",
        "The payment gateway rejected this payment. Please contact support.",
      );
  }
  if (
    !providerTransactionId ||
    transaction.status === "unknown" ||
    (transaction.httpStatus !== undefined && !successfulHttp) ||
    (transaction.rawStatus === "3" &&
      ["420", "421", "430"].includes(transaction.responseCode ?? ""))
  ) {
    await env.BILLING_DB.prepare(
      `UPDATE easy_pay_direct_payment_executions
       SET status = 'unknown', provider_transaction_id = COALESCE(provider_transaction_id, ?), provider_response_code = ?,
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
  const providerCustomerVaultId =
    normalizedStatus === "succeeded" && purchaseKind === "recurring"
      ? transaction.customerVaultId
      : null;
  const savedCheckpoint = await env.BILLING_DB.prepare(
    `UPDATE easy_pay_direct_payment_executions
     SET provider_transaction_id = ?, provider_response_code = ?,
         customer_vault_id = CASE WHEN ? = 1 THEN COALESCE(?, customer_vault_id) ELSE NULL END,
         failure_code = ?, failure_message = ?, updated_at = ?
     WHERE id = ? AND charge_transport = 'gateway' AND status IN ('processing', 'unknown')
       AND (provider_transaction_id IS NULL OR provider_transaction_id = ?)
       AND (? IS NULL OR customer_vault_id IS NULL OR customer_vault_id = ?)
     RETURNING customer_vault_id`,
  )
    .bind(
      providerTransactionId,
      transaction.responseCode,
      purchaseKind === "recurring" ? 1 : 0,
      providerCustomerVaultId,
      failureCode,
      failureMessage,
      timestamp,
      executionId,
      providerTransactionId,
      providerCustomerVaultId,
      providerCustomerVaultId,
    )
    .first<{ customer_vault_id: string | null }>();
  if (!savedCheckpoint) {
    throw new ApiError(
      409,
      "easy_pay_direct_gateway_payment_evidence_mismatch",
      "Payment confirmation needs review. Do not pay again.",
    );
  }
  // The approved direct-Gateway sale response binds its transaction to its
  // returned vault. Query may omit that optional field: retain the same-sale
  // checkpoint, never substitute a customer profile or clear it on recovery.
  const customerVaultId = savedCheckpoint.customer_vault_id;

  // Checkpoint the submitted transaction before any read can fail. A provider
  // approval alone does not prove the whole invoice was charged (partial auth).
  if (normalizedStatus === "succeeded") {
    if (env.PROVIDER_READS_ENABLED !== "1") {
      throw new ApiError(503, "provider_reads_disabled", "Payment confirmation is pending.");
    }
    const evidence =
      readEvidence ??
      (await findEasyPayDirectGatewayTransactionByOrderId(
        env,
        checkout.payment_request_id,
        fetcher,
      ));
    if (
      !evidence ||
      evidence.id !== providerTransactionId ||
      evidence.status !== "succeeded" ||
      evidence.amountMinor !== checkout.amount_minor ||
      evidence.currency !== checkout.currency ||
      (purchaseKind === "recurring" &&
        evidence.customerVaultId !== null &&
        evidence.customerVaultId !== customerVaultId)
    ) {
      throw new ApiError(
        409,
        "easy_pay_direct_gateway_payment_evidence_mismatch",
        "Payment confirmation needs review. Do not pay again.",
      );
    }
  }

  const gatewayEnvironment = env.EASY_PAY_DIRECT_NETWORK_MODE === "production" ? "live" : "test";
  const receiptId = await deterministicUuid(
    "easy-pay-direct-gateway-receipt",
    `${checkout.provider_account_code}:${providerTransactionId}:${normalizedStatus}`,
  );
  const providerEventId = `gateway-${gatewayEnvironment}:${providerTransactionId}:${normalizedStatus}`;
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
       VALUES (?, ?, ?, ?, 0, ?, ?, NULL, NULL)
       ON CONFLICT(provider, provider_account_code, provider_event_id) DO NOTHING`,
    ).bind(
      receiptId,
      `easy_pay_direct_gateway_${gatewayEnvironment}`,
      checkout.provider_account_code,
      providerEventId,
      payloadHash,
      timestamp,
    ),
    env.BILLING_DB.prepare(
      `INSERT INTO provider_webhook_events
       (receipt_id, organization_id, event_type, provider_transaction_id, invoice_id,
        normalized_status, normalized_at, payment_request_id)
       VALUES (?, ?, ?, ?, NULL, NULL, NULL, NULL)
       ON CONFLICT(receipt_id) DO NOTHING`,
    ).bind(
      receiptId,
      checkout.organization_id,
      `transaction.gateway.${gatewayEnvironment}.reconciled`,
      providerTransactionId,
    ),
  ]);

  const receipt: PendingReceipt = {
    receipt_id: receiptId,
    organization_id: checkout.organization_id,
    provider_account_code: checkout.provider_account_code,
    event_type: `transaction.gateway.${gatewayEnvironment}.reconciled`,
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
  if (normalizedStatus === "succeeded" && purchaseKind === "recurring" && customerVaultId) {
    const existingProfile = await loadProfile(env.BILLING_DB, checkout);
    await upsertProfile(env.BILLING_DB, checkout, {
      providerCustomerId:
        existingProfile?.provider_customer_id ?? `gateway:${checkout.customer_id}`,
      providerPaymentMethodId: null,
      gatewayCustomerVaultId: customerVaultId,
      gatewayBillingId: null,
      initialTransactionId: providerTransactionId,
    });
    await markCheckoutSubscriptionProvider(env.BILLING_DB, checkout);
  } else if (normalizedStatus === "succeeded" && purchaseKind === "recurring") {
    throw new ApiError(
      503,
      "easy_pay_direct_post_payment_pending",
      "Payment confirmed; post-payment setup is pending",
    );
  }
  await env.BILLING_DB.prepare(
    `UPDATE easy_pay_direct_payment_executions
     SET status = ?, updated_at = ?, completed_at = ?, phone_ciphertext = NULL, phone_iv = NULL
     WHERE id = ? AND status IN ('processing', 'unknown')`,
  )
    .bind(normalizedStatus, timestamp, timestamp, executionId)
    .run();

  if (normalizedStatus === "failed") {
    throw new ApiError(422, "easy_pay_direct_declined", failureMessage || "Payment was declined");
  }
  await commitAppliedCheckoutTaxQuote(env, executionId, providerTransactionId, fetcher);
  await publishPaymentRequestOutboxEvents(
    env.BILLING_DB,
    env.DOMAIN_EVENTS,
    checkout.organization_id,
    checkout.payment_request_id,
  );
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

    await finalizeEasyPayDirectPaidExecution(env, executionId, order, fetcher);
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
            intent.amount_minor, intent.currency, customer.currency AS customer_currency,
            customer.email AS customer_email,
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
      `SELECT id, charge_transport, payment_backend, contact_name_sha256, checkout_intent_id, status, payment_token_sha256, phone_sha256,
              phone_ciphertext, phone_iv, email_sha256, tax_quote_id, billing_address_sha256,
              terms_accepted_at, terms_version,
            customer_idempotency_key,
            payment_method_idempotency_key, product_idempotency_key, order_idempotency_key,
            provider_transaction_id, provider_customer_id, provider_payment_method_id,
            provider_product_id, customer_vault_id, gateway_billing_id,
            provider_response_code, failure_code, failure_message, last_checkpoint, resume_count, updated_at
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
      `SELECT id, charge_transport, payment_backend, contact_name_sha256, checkout_intent_id, status, payment_token_sha256, phone_sha256,
              phone_ciphertext, phone_iv, email_sha256, tax_quote_id, billing_address_sha256,
              terms_accepted_at, terms_version,
              customer_idempotency_key, payment_method_idempotency_key,
              product_idempotency_key, order_idempotency_key, provider_transaction_id,
              provider_customer_id, provider_payment_method_id, provider_product_id,
              customer_vault_id, gateway_billing_id, provider_response_code,
              failure_code, failure_message, last_checkpoint, resume_count, updated_at
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
              customer.currency AS customer_currency,
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
  checkoutOnly = false,
): Promise<ProviderProfile | null> {
  return database
    .prepare(
      `SELECT id, payment_backend, provider_customer_id, provider_payment_method_id, gateway_customer_vault_id,
              gateway_billing_id, initial_transaction_id
     FROM provider_customer_profiles
     WHERE customer_id = ? AND provider = 'easy_pay_direct' AND provider_account_code = ?
       AND status = 'active' AND (? = 0 OR checkout_intent_id = ?)
       ORDER BY created_at DESC, id LIMIT 1`,
    )
    .bind(
      checkout.customer_id,
      checkout.provider_account_code,
      checkoutOnly ? 1 : 0,
      checkout.checkout_intent_id,
    )
    .first<ProviderProfile>();
}

async function upsertProfile(
  database: D1Database,
  checkout: CheckoutRow,
  input: {
    paymentBackend?: "gateway_vault" | "commerce_elements";
    providerCustomerId: string;
    providerPaymentMethodId: string | null;
    gatewayCustomerVaultId: string | null;
    gatewayBillingId: string | null;
    initialTransactionId?: string | null;
  },
): Promise<void> {
  const timestamp = new Date().toISOString();
  const profileId = await deterministicUuid(
    "easy-pay-direct-customer-profile",
    `${checkout.provider_account_code}:${checkout.customer_id}:${checkout.checkout_intent_id}`,
  );
  await database
    .prepare(
      `INSERT INTO provider_customer_profiles
     (id, payment_backend, organization_id, customer_id, provider, provider_account_code,
      provider_customer_id, provider_payment_method_id, gateway_customer_vault_id,
      gateway_billing_id, initial_transaction_id, status, created_at, updated_at, checkout_intent_id)
     VALUES (?, ?, ?, ?, 'easy_pay_direct', ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?)
     ON CONFLICT(id) DO NOTHING`,
    )
    .bind(
      profileId,
      input.paymentBackend ?? "gateway_vault",
      checkout.organization_id,
      checkout.customer_id,
      checkout.provider_account_code,
      input.providerCustomerId,
      input.providerPaymentMethodId,
      input.gatewayCustomerVaultId,
      input.gatewayBillingId,
      input.initialTransactionId ?? null,
      timestamp,
      timestamp,
      checkout.checkout_intent_id,
    )
    .run();
  const profile = await loadProfile(database, checkout, true);
  if (
    !profile ||
    profile.provider_customer_id !== input.providerCustomerId ||
    profile.payment_backend !== (input.paymentBackend ?? "gateway_vault")
  ) {
    throw new Error("easy_pay_direct_customer_profile_identity_conflict");
  }
  if (
    profile.provider_payment_method_id !== input.providerPaymentMethodId ||
    profile.gateway_customer_vault_id !== input.gatewayCustomerVaultId ||
    profile.gateway_billing_id !== input.gatewayBillingId
  ) {
    throw new Error("easy_pay_direct_checkout_profile_conflict");
  }
}

async function recordProfileInitialTransaction(
  database: D1Database,
  checkout: CheckoutRow,
  initialTransactionId: string,
): Promise<void> {
  const updated = await database
    .prepare(
      `UPDATE provider_customer_profiles
       SET initial_transaction_id = COALESCE(initial_transaction_id, ?), updated_at = ?
       WHERE customer_id = ? AND organization_id = ? AND provider = 'easy_pay_direct'
         AND provider_account_code = ? AND status = 'active'
         AND checkout_intent_id = ?
         AND (initial_transaction_id IS NULL OR initial_transaction_id = ?)`,
    )
    .bind(
      initialTransactionId,
      new Date().toISOString(),
      checkout.customer_id,
      checkout.organization_id,
      checkout.provider_account_code,
      checkout.checkout_intent_id,
      initialTransactionId,
    )
    .run();
  if (updated.meta.changes !== 1) throw new Error("easy_pay_direct_initial_transaction_conflict");
}

function commerceInitialTransactionId(order: CommerceOrder): string | null {
  const transaction = [...(Array.isArray(order.transactions) ? order.transactions : [])]
    .reverse()
    .find(
      (candidate) =>
        candidate &&
        typeof candidate.status === "string" &&
        candidate.status.toLowerCase() === "succeeded" &&
        typeof candidate.type === "string" &&
        !candidate.type.toLowerCase().includes("refund"),
    );
  return (
    (typeof transaction?.processor_transaction_id === "string" &&
      transaction.processor_transaction_id.trim()) ||
    (typeof transaction?.id === "string" && transaction.id.trim()) ||
    null
  );
}

// Delayed approvals must bind the same immutable checkout card as synchronous
// approvals. Only a verified provider order with a successful transaction can
// authorize future merchant-initiated collection.
export async function bindEasyPayDirectRenewalProfile(
  database: D1Database,
  executionId: string,
  order: CommerceOrder,
): Promise<boolean> {
  if (order.status !== "succeeded") return true;
  const execution = await database
    .prepare(
      "SELECT checkout_intent_id, payment_backend, provider_customer_id, provider_payment_method_id FROM easy_pay_direct_payment_executions WHERE id = ? AND provider_transaction_id = ?",
    )
    .bind(executionId, order.id)
    .first<{
      checkout_intent_id: string;
      payment_backend: string;
      provider_customer_id: string;
      provider_payment_method_id: string;
    }>();
  if (!execution) return false;
  const checkout = await loadCheckoutByIntentId(database, execution.checkout_intent_id);
  if (!checkout) return false;
  const recurring = await database
    .prepare(
      `SELECT 1 AS required FROM invoices_payment_requests link
     JOIN invoices i ON i.id = link.invoice_id AND i.organization_id = link.organization_id
     JOIN subscriptions s ON s.id = i.subscription_id AND s.organization_id = i.organization_id
     JOIN plans p ON p.id = s.plan_id AND p.organization_id = s.organization_id
     WHERE link.payment_request_id = ? AND link.organization_id = ?
       AND s.status IN ('active', 'past_due') AND p.interval IN ('weekly', 'monthly', 'quarterly', 'yearly') LIMIT 1`,
    )
    .bind(checkout.payment_request_id, checkout.organization_id)
    .first();
  const initialTransactionId = commerceInitialTransactionId(order);
  if (execution.payment_backend === "commerce_elements") {
    const { validateEasyPayDirectElementsOrder } =
      await import("../providers/easy-pay-direct-elements");
    validateEasyPayDirectElementsOrder(order, {
      orderId: order.id,
      customerId: execution.provider_customer_id,
      paymentMethodId: execution.provider_payment_method_id,
      amountMinor: checkout.amount_minor,
      currency: checkout.currency,
    });
  }
  if (!initialTransactionId) return !recurring;
  if (!(await loadProfile(database, checkout, true))) return !recurring;
  await recordProfileInitialTransaction(database, checkout, initialTransactionId);
  await markCheckoutSubscriptionProvider(database, checkout);
  return true;
}

// Payment settlement is idempotent and independent of these follow-ups. Keep
// the existing order in the read-only queue until every follow-up is durable.
export async function finalizeEasyPayDirectPaidExecution(
  env: Env,
  executionId: string,
  order: CommerceOrder,
  fetcher: typeof fetch = fetch,
): Promise<boolean> {
  const renewalReady = await bindEasyPayDirectRenewalProfile(env.BILLING_DB, executionId, order);
  const tax = await commitAppliedCheckoutTaxQuote(env, executionId, order.id, fetcher);
  const complete = renewalReady && tax !== "retry";
  const timestamp = new Date().toISOString();
  await env.BILLING_DB.prepare(
    `UPDATE easy_pay_direct_payment_executions
     SET status = ?, failure_code = ?, failure_message = ?, updated_at = ?, completed_at = ?,
         phone_ciphertext = NULL, phone_iv = NULL
     WHERE id = ? AND provider_transaction_id = ? AND status IN ('processing', 'unknown')`,
  )
    .bind(
      complete ? "succeeded" : "unknown",
      complete ? null : "easy_pay_direct_post_payment_pending",
      complete ? null : "Payment confirmed; post-payment setup is pending",
      timestamp,
      complete ? timestamp : null,
      executionId,
      order.id,
    )
    .run();
  return complete;
}

async function markCheckoutSubscriptionProvider(
  database: D1Database,
  checkout: CheckoutRow,
): Promise<void> {
  const profile = await loadProfile(database, checkout, true);
  if (
    !profile?.initial_transaction_id ||
    (profile.payment_backend === "gateway_vault"
      ? !profile.gateway_customer_vault_id
      : !profile.provider_customer_id || !profile.provider_payment_method_id)
  ) {
    throw new Error("easy_pay_direct_automatic_profile_incomplete");
  }
  const timestamp = new Date().toISOString();
  await database
    .prepare(
      `UPDATE subscriptions
       SET payment_method_type = 'provider', payment_method_id = ?,
           version = version + 1, updated_at = ?
       WHERE organization_id = ?
         AND id IN (
           SELECT invoice.subscription_id
           FROM invoices_payment_requests link
           JOIN invoices invoice ON invoice.id = link.invoice_id
           JOIN subscriptions linked_subscription ON linked_subscription.id = invoice.subscription_id
           JOIN plans plan ON plan.id = linked_subscription.plan_id
           WHERE link.payment_request_id = ? AND invoice.subscription_id IS NOT NULL
             AND plan.interval IN ('weekly', 'monthly', 'quarterly', 'yearly')
         )
         AND NOT EXISTS (
           SELECT 1 FROM provider_customer_profiles current_profile
           LEFT JOIN payment_request_checkout_intents current_intent
             ON current_intent.id = current_profile.checkout_intent_id
            AND current_intent.organization_id = current_profile.organization_id
           WHERE current_profile.id = subscriptions.payment_method_id
             AND current_profile.organization_id = subscriptions.organization_id
             AND current_profile.customer_id = subscriptions.customer_id
             AND current_profile.id <> ?
             AND COALESCE(current_intent.created_at, current_profile.created_at) >= (
               SELECT created_at FROM payment_request_checkout_intents WHERE id = ?
             )
         )
         AND (payment_method_type IS NOT 'provider' OR payment_method_id IS NOT ?)`,
    )
    .bind(
      profile.id,
      timestamp,
      checkout.organization_id,
      checkout.payment_request_id,
      profile.id,
      checkout.checkout_intent_id,
      profile.id,
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
      // An early webhook can checkpoint the order while a resumed POST is still
      // awaiting its response. A subsequent transport error has no order ID; it
      // must not erase the durable reference needed for read-only finalization.
      `UPDATE easy_pay_direct_payment_executions SET status = ?,
       provider_transaction_id = COALESCE(?, provider_transaction_id),
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
