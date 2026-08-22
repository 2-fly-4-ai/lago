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

export type ProviderFinancialServiceBinding = {
  refundEasyPayDirect(input: EasyPayDirectRefundRpcInput): Promise<EasyPayDirectRefundRpcResult>;
};

export class ProviderFinancialService extends WorkerEntrypoint<Env> {
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
