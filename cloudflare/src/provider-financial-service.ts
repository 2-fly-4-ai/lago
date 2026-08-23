import { WorkerEntrypoint } from "cloudflare:workers";

import { refundEasyPayDirectOrder } from "./providers/easy-pay-direct";

export type EasyPayDirectRefundRpcInput = {
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
      this.env.EASY_PAY_DIRECT_NETWORK_MODE !== "test" ||
      this.env.EASY_PAY_DIRECT_LIVEMODE_ALLOWED !== "0" ||
      input.organizationId !== this.env.EASY_PAY_DIRECT_ORGANIZATION_ID?.trim() ||
      input.providerAccountCode !== this.env.EASY_PAY_DIRECT_ACCOUNT_CODE?.trim()
    ) {
      throw new Error("easy_pay_direct_refund_rpc_boundary_mismatch");
    }
    return refundEasyPayDirectOrder(this.env, {
      orderId: input.orderId,
      amountMinor: input.amountMinor,
      currency: input.currency,
      idempotencyKey: input.idempotencyKey,
    });
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
    env.EASY_PAY_DIRECT_NETWORK_MODE === "test" && env.EASY_PAY_DIRECT_LIVEMODE_ALLOWED === "0";

  return [
    runtimeStatus("stripe", stripeSecretReady, stripeNetworkReady, paymentWritesEnabled),
    runtimeStatus(
      "easy_pay_direct",
      easyPayDirectSecretReady,
      easyPayDirectNetworkReady,
      paymentWritesEnabled,
    ),
  ];
}

function runtimeStatus(
  providerCode: ProviderRuntimeStatus["providerCode"],
  secretReady: boolean,
  networkReady: boolean,
  paymentWritesEnabled: boolean,
): ProviderRuntimeStatus {
  if (!secretReady || !networkReady) {
    return {
      providerCode,
      connectionState: "disconnected",
      secretReady,
      externalActionsEnabled: false,
      environment: networkReady ? "sandbox" : null,
      message: secretReady ? "Provider network access is disabled" : "Credentials are not ready",
    };
  }
  if (!paymentWritesEnabled) {
    return {
      providerCode,
      connectionState: "connected",
      secretReady: true,
      externalActionsEnabled: false,
      environment: "sandbox",
      message: "Sandbox connected; payment writes are paused",
    };
  }
  return {
    providerCode,
    connectionState: "connected",
    secretReady: true,
    externalActionsEnabled: true,
    environment: "sandbox",
    message: "Sandbox connected; payment writes are enabled",
  };
}

function assertRefundInput(input: EasyPayDirectRefundRpcInput): void {
  if (
    !input ||
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
