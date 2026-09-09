import {
  createEasyPayDirectElementsOrder,
  createEasyPayDirectElementsProduct,
  getEasyPayDirectElementsOrder,
  getEasyPayDirectElementsProduct,
  validateEasyPayDirectElementsOrder,
} from "../providers/easy-pay-direct-elements";
import type { GatewayTransactionResult } from "../providers/easy-pay-direct";

export type CommerceRenewalExecution = {
  id: string;
  organization_id: string;
  payment_request_id: string;
  order_reference: string;
  commerce_customer_id: string | null;
  commerce_payment_method_id: string | null;
  product_idempotency_key: string | null;
  order_idempotency_key: string | null;
  commerce_product_id: string | null;
  commerce_order_id: string | null;
  order_submit_started_at: string | null;
  amount_minor: number;
  currency: string;
};

export function commerceRenewalSandboxAllowed(env: Env): boolean {
  return (
    ["development", "staging", "test"].includes(env.APP_ENV) &&
    ["test", "gateway_test"].includes(env.EASY_PAY_DIRECT_NETWORK_MODE ?? "") &&
    env.EASY_PAY_DIRECT_LIVEMODE_ALLOWED === "0"
  );
}

// Called only after authenticated receipt verification. A signed response may
// recover a lost POST handle, but never authorize a new submission or settlement.
export async function reconcileElementsAutomaticWebhook(
  database: D1Database,
  input: {
    organizationId: string;
    accountCode: string;
    paymentRequestId: string;
    executionId: string;
    order: unknown;
  },
): Promise<boolean> {
  const row = await database
    .prepare(`SELECT execution.*, request.amount_minor, request.currency
    FROM easy_pay_direct_automatic_payment_executions execution
    JOIN payment_requests request ON request.id = execution.payment_request_id
      AND request.organization_id = execution.organization_id
    WHERE execution.id = ? AND execution.organization_id = ? AND execution.provider_account_code = ?
      AND execution.payment_request_id = ? AND execution.payment_backend = 'commerce_elements'
      AND execution.order_submit_started_at IS NOT NULL`)
    .bind(input.executionId, input.organizationId, input.accountCode, input.paymentRequestId)
    .first<CommerceRenewalExecution & { status: string; provider_transaction_id: string | null }>();
  if (
    !row ||
    !row.commerce_customer_id ||
    !row.commerce_payment_method_id ||
    !input.order ||
    typeof input.order !== "object"
  )
    return false;
  const evidence = input.order as { id?: unknown; metadata?: Record<string, unknown> };
  if (
    typeof evidence.id !== "string" ||
    evidence.metadata?.lago_automatic_execution_id !== row.id ||
    evidence.metadata?.lago_payment_request_id !== row.payment_request_id ||
    (row.commerce_order_id !== null && row.commerce_order_id !== evidence.id) ||
    (row.provider_transaction_id !== null && row.provider_transaction_id !== evidence.id)
  )
    return false;
  const order = validateEasyPayDirectElementsOrder(input.order, {
    orderId: evidence.id,
    customerId: row.commerce_customer_id,
    paymentMethodId: row.commerce_payment_method_id,
    amountMinor: row.amount_minor,
    currency: row.currency,
  });
  if (row.status === "succeeded") return row.commerce_order_id === evidence.id;
  if (row.status === "failed") {
    if (row.commerce_order_id !== evidence.id) return false;
    if (order.status !== "succeeded") return true;
    // A later exact authenticated success can contradict a previous failed read.
    // Reopen only read-only reconciliation; the immutable submission checkpoint
    // and unknown status make another order POST impossible.
    const reopened = await database
      .prepare(`UPDATE easy_pay_direct_automatic_payment_executions
      SET status = 'unknown', completed_at = NULL, updated_at = ?
      WHERE id = ? AND organization_id = ? AND provider_account_code = ? AND payment_request_id = ?
        AND payment_backend = 'commerce_elements' AND status = 'failed'
        AND commerce_order_id = ? AND provider_transaction_id = ?
        AND order_submit_started_at IS NOT NULL RETURNING id`)
      .bind(
        new Date().toISOString(),
        row.id,
        input.organizationId,
        input.accountCode,
        input.paymentRequestId,
        evidence.id,
        evidence.id,
      )
      .first();
    return Boolean(reopened);
  }
  if (row.status !== "processing" && row.status !== "unknown") return false;
  const saved = await database
    .prepare(`UPDATE easy_pay_direct_automatic_payment_executions
    SET commerce_order_id = COALESCE(commerce_order_id, ?), provider_transaction_id = COALESCE(provider_transaction_id, ?)
    WHERE id = ? AND organization_id = ? AND provider_account_code = ? AND payment_request_id = ?
      AND payment_backend = 'commerce_elements' AND status IN ('processing', 'unknown')
      AND order_submit_started_at IS NOT NULL
      AND (commerce_order_id IS NULL OR commerce_order_id = ?)
      AND (provider_transaction_id IS NULL OR provider_transaction_id = ?) RETURNING id`)
    .bind(
      evidence.id,
      evidence.id,
      row.id,
      input.organizationId,
      input.accountCode,
      input.paymentRequestId,
      evidence.id,
      evidence.id,
    )
    .first();
  return Boolean(saved);
}

// Lago owns periods and dunning. Each renewal is one Commerce order, never a
// second Commerce subscription/scheduler. POST /orders IS the financial action.
export async function chargeCommerceRenewal(
  env: Env,
  execution: CommerceRenewalExecution,
  fetcher: typeof fetch,
): Promise<GatewayTransactionResult> {
  if (
    !commerceRenewalSandboxAllowed(env) ||
    !execution.commerce_customer_id ||
    !execution.commerce_payment_method_id ||
    !execution.product_idempotency_key ||
    !execution.order_idempotency_key ||
    execution.order_submit_started_at ||
    execution.commerce_order_id
  )
    throw new Error("commerce_renewal_submission_not_allowed");
  let productId = execution.commerce_product_id;
  if (!productId) {
    const product = await createEasyPayDirectElementsProduct(
      env,
      {
        name: "SERP subscription renewal",
        amountMinor: execution.amount_minor,
        currency: execution.currency,
        metadata: {
          lago_payment_request_id: execution.payment_request_id,
          lago_automatic_execution_id: execution.id,
        },
        idempotencyKey: execution.product_idempotency_key,
      },
      fetcher,
    );
    const saved = await env.BILLING_DB.prepare(
      `UPDATE easy_pay_direct_automatic_payment_executions SET commerce_product_id = ?, updated_at = ?
       WHERE id = ? AND organization_id = ? AND payment_backend = 'commerce_elements'
         AND status = 'processing' AND commerce_product_id IS NULL AND order_submit_started_at IS NULL RETURNING id`,
    )
      .bind(product.id, new Date().toISOString(), execution.id, execution.organization_id)
      .first();
    if (!saved) throw new Error("commerce_renewal_product_checkpoint_failed");
    productId = product.id;
  }
  // A separately priced product avoids shared-plan changes applying tax/discount twice.
  await getEasyPayDirectElementsProduct(
    env,
    { productId, amountMinor: execution.amount_minor, currency: execution.currency },
    fetcher,
  );
  const started = await env.BILLING_DB.prepare(
    `UPDATE easy_pay_direct_automatic_payment_executions SET order_submit_started_at = ?, updated_at = ?
     WHERE id = ? AND organization_id = ? AND payment_backend = 'commerce_elements'
       AND status = 'processing' AND commerce_product_id = ? AND order_submit_started_at IS NULL
       AND commerce_order_id IS NULL RETURNING id`,
  )
    .bind(
      new Date().toISOString(),
      new Date().toISOString(),
      execution.id,
      execution.organization_id,
      productId,
    )
    .first();
  if (!started) throw new Error("commerce_renewal_order_already_started");
  const checkpoint = await createEasyPayDirectElementsOrder(
    env,
    {
      customerId: execution.commerce_customer_id,
      paymentMethodId: execution.commerce_payment_method_id,
      productId,
      currency: execution.currency,
      description: "SERP subscription renewal",
      metadata: {
        lago_payment_request_id: execution.payment_request_id,
        lago_automatic_execution_id: execution.id,
      },
      idempotencyKey: execution.order_idempotency_key,
    },
    fetcher,
  );
  // Save the recovery handle even if the returned amount/customer/status is wrong.
  const saved = await env.BILLING_DB.prepare(
    `UPDATE easy_pay_direct_automatic_payment_executions SET commerce_order_id = ?, updated_at = ?
     WHERE id = ? AND organization_id = ? AND payment_backend = 'commerce_elements'
       AND status IN ('processing', 'unknown') AND commerce_order_id IS NULL RETURNING id`,
  )
    .bind(checkpoint.id, new Date().toISOString(), execution.id, execution.organization_id)
    .first();
  if (!saved) throw new Error("commerce_renewal_order_checkpoint_failed");
  return outcome(execution, checkpoint.id, checkpoint.evidence);
}

export async function readCommerceRenewal(
  env: Env,
  execution: CommerceRenewalExecution,
  fetcher: typeof fetch,
): Promise<GatewayTransactionResult | null> {
  if (!commerceRenewalSandboxAllowed(env) || !execution.commerce_order_id) return null;
  const checkpoint = await getEasyPayDirectElementsOrder(env, execution.commerce_order_id, fetcher);
  return outcome(execution, checkpoint.id, checkpoint.evidence);
}

function outcome(
  execution: CommerceRenewalExecution,
  orderId: string,
  evidence: unknown,
): GatewayTransactionResult {
  if (!execution.commerce_customer_id || !execution.commerce_payment_method_id)
    throw new Error("commerce_renewal_identity_missing");
  const order = validateEasyPayDirectElementsOrder(evidence, {
    orderId,
    customerId: execution.commerce_customer_id,
    paymentMethodId: execution.commerce_payment_method_id,
    amountMinor: execution.amount_minor,
    currency: execution.currency,
  });
  return {
    id: order.id,
    status:
      order.status === "succeeded" ? "succeeded" : order.status === "failed" ? "failed" : "unknown",
    responseCode: order.status === "failed" ? "commerce_declined" : null,
    responseText: order.failure_reason ?? "",
    authCode: null,
    orderId: execution.order_reference,
    customerVaultId: null,
    rawStatus: order.status,
  };
}
