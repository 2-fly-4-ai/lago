import { WorkerEntrypoint } from "cloudflare:workers";

import {
  refundEasyPayDirectByOrigin,
  readEasyPayDirectRefundByOrigin,
} from "./billing/easy-pay-direct-refund-backend";
import { checkpointEasyPayDirectRefund } from "./billing/easy-pay-direct-refund-reconciliation";

export type EasyPayDirectRefundRpcInput = {
  operationId: string;
  organizationId: string;
  providerAccountCode: string;
  orderId: string;
  amountMinor: number;
  currency: string;
  idempotencyKey: string;
};

export type EasyPayDirectRefundRpcResult = {
  id: string | null;
  status: "succeeded" | "failed" | "unknown";
  responseText: string;
};

export type ProviderRuntimeStatus = {
  providerCode: "stripe" | "easy_pay_direct";
  connectionState: "connected" | "disconnected";
  secretReady: boolean;
  externalActionsEnabled: boolean;
  environment: "sandbox" | "production" | null;
  message: string;
};

export type ProviderFinancialServiceBinding = {
  refundEasyPayDirect(input: EasyPayDirectRefundRpcInput): Promise<EasyPayDirectRefundRpcResult>;
  readEasyPayDirectRefund(
    input: EasyPayDirectRefundRpcInput & { transactionId: string },
  ): Promise<EasyPayDirectRefundRpcResult>;
  getIntegrationRuntimeStatuses(organizationId: string): Promise<ProviderRuntimeStatus[]>;
};

export class ProviderFinancialService extends WorkerEntrypoint<Env> {
  async getIntegrationRuntimeStatuses(organizationId: string): Promise<ProviderRuntimeStatus[]> {
    if (!organizationId?.trim()) throw new Error("invalid_provider_status_organization");
    return integrationRuntimeStatuses(this.env, organizationId.trim());
  }

  async refundEasyPayDirect(
    input: EasyPayDirectRefundRpcInput,
  ): Promise<EasyPayDirectRefundRpcResult> {
    assertRefundInput(input);
    if (
      input.organizationId !== this.env.EASY_PAY_DIRECT_ORGANIZATION_ID?.trim() ||
      input.providerAccountCode !== this.env.EASY_PAY_DIRECT_ACCOUNT_CODE?.trim()
    ) {
      throw new Error("easy_pay_direct_refund_rpc_boundary_mismatch");
    }
    await this.requireRefundOperation(input);
    return refundEasyPayDirectByOrigin(
      this.env,
      {
        organizationId: input.organizationId,
        providerAccountCode: input.providerAccountCode,
        orderId: input.orderId,
        amountMinor: input.amountMinor,
        currency: input.currency,
        idempotencyKey: input.idempotencyKey,
      },
      fetch,
      (transactionId) => checkpointEasyPayDirectRefund(this.env.BILLING_DB, input, transactionId),
    );
  }

  async readEasyPayDirectRefund(
    input: EasyPayDirectRefundRpcInput & { transactionId: string },
  ): Promise<EasyPayDirectRefundRpcResult> {
    assertRefundInput(input);
    if (
      this.env.PROVIDER_READS_ENABLED !== "1" ||
      input.organizationId !== this.env.EASY_PAY_DIRECT_ORGANIZATION_ID?.trim() ||
      input.providerAccountCode !== this.env.EASY_PAY_DIRECT_ACCOUNT_CODE?.trim()
    )
      throw new Error("easy_pay_direct_refund_read_boundary_mismatch");
    await this.requireRefundOperation(input, input.transactionId);
    return readEasyPayDirectRefundByOrigin(this.env, input, fetch);
  }

  private async requireRefundOperation(
    input: EasyPayDirectRefundRpcInput,
    transactionId?: string,
  ): Promise<void> {
    const operation = await this.env.BILLING_DB.prepare(`SELECT provider_refund_transaction_id
      FROM provider_refund_operations WHERE id = ? AND organization_id = ?
        AND provider = 'easy_pay_direct' AND provider_account_code = ? AND provider_payment_id = ?
        AND amount_minor = ? AND currency = ? AND provider_idempotency_key = ? AND status = 'submitted'`)
      .bind(
        input.operationId,
        input.organizationId,
        input.providerAccountCode,
        input.orderId,
        input.amountMinor,
        input.currency,
        input.idempotencyKey,
      )
      .first<{ provider_refund_transaction_id: string | null }>();
    if (
      !operation ||
      (transactionId !== undefined && operation.provider_refund_transaction_id !== transactionId)
    )
      throw new Error("easy_pay_direct_refund_operation_mismatch");
  }
}

export function integrationRuntimeStatuses(
  env: Env,
  organizationId: string,
): ProviderRuntimeStatus[] {
  const paymentWritesEnabled = String(env.PAYMENT_MUTATIONS_ENABLED) === "1";
  const stripeSecretReady = Boolean(
    env.STRIPE_RESTRICTED_API_KEY?.trim() &&
    env.STRIPE_ACCOUNT_CODE?.trim() &&
    env.STRIPE_ORGANIZATION_ID?.trim() === organizationId,
  );
  const stripeNetworkReady =
    env.STRIPE_NETWORK_MODE === "enabled" && env.STRIPE_LIVEMODE_ALLOWED !== "1";
  const easyPayDirectSecretReady = Boolean(
    env.EASY_PAY_DIRECT_COMMERCE_API_KEY?.trim() &&
    env.EASY_PAY_DIRECT_CHECKOUT_SIGNING_SECRET?.trim() &&
    env.EASY_PAY_DIRECT_WEBHOOK_SIGNING_KEY?.trim() &&
    env.EASY_PAY_DIRECT_ACCOUNT_CODE?.trim() &&
    env.EASY_PAY_DIRECT_ORGANIZATION_ID?.trim() === organizationId,
  );
  const easyPayDirectNetworkReady =
    ((env.EASY_PAY_DIRECT_NETWORK_MODE === "test" ||
      env.EASY_PAY_DIRECT_NETWORK_MODE === "gateway_test") &&
      env.EASY_PAY_DIRECT_LIVEMODE_ALLOWED === "0") ||
    (env.EASY_PAY_DIRECT_NETWORK_MODE === "production" &&
      env.EASY_PAY_DIRECT_LIVEMODE_ALLOWED === "1");
  const easyPayDirectEnvironment =
    env.EASY_PAY_DIRECT_NETWORK_MODE === "production" ? "production" : "sandbox";

  return [
    runtimeStatus("stripe", stripeSecretReady, stripeNetworkReady, paymentWritesEnabled, "sandbox"),
    runtimeStatus(
      "easy_pay_direct",
      easyPayDirectSecretReady,
      easyPayDirectNetworkReady,
      paymentWritesEnabled,
      easyPayDirectEnvironment,
    ),
  ];
}

function runtimeStatus(
  providerCode: ProviderRuntimeStatus["providerCode"],
  secretReady: boolean,
  networkReady: boolean,
  paymentWritesEnabled: boolean,
  environment: Exclude<ProviderRuntimeStatus["environment"], null>,
): ProviderRuntimeStatus {
  if (!secretReady || !networkReady) {
    return {
      providerCode,
      connectionState: "disconnected",
      secretReady,
      externalActionsEnabled: false,
      environment: networkReady ? environment : null,
      message: secretReady ? "Provider network access is disabled" : "Credentials are not ready",
    };
  }
  if (!paymentWritesEnabled) {
    return {
      providerCode,
      connectionState: "connected",
      secretReady: true,
      externalActionsEnabled: false,
      environment,
      message: `${environment === "production" ? "Production" : "Sandbox"} connected; payment writes are paused`,
    };
  }
  return {
    providerCode,
    connectionState: "connected",
    secretReady: true,
    externalActionsEnabled: true,
    environment,
    message: `${environment === "production" ? "Production" : "Sandbox"} connected; payment writes are enabled`,
  };
}

function assertRefundInput(input: EasyPayDirectRefundRpcInput): void {
  if (
    !input ||
    typeof input.operationId !== "string" ||
    !input.operationId.trim() ||
    typeof input.organizationId !== "string" ||
    typeof input.providerAccountCode !== "string" ||
    typeof input.orderId !== "string" ||
    typeof input.currency !== "string" ||
    typeof input.idempotencyKey !== "string" ||
    !Number.isSafeInteger(input.amountMinor) ||
    input.amountMinor <= 0
  ) {
    throw new Error("invalid_easy_pay_direct_refund_rpc_input");
  }
}
