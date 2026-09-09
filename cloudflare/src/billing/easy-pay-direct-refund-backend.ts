import { ApiError } from "../http";
import {
  submitGatewayRefundOperation,
  readGatewayRefundOperation,
} from "./easy-pay-direct-gateway-refund-operation";
import {
  refundEasyPayDirectOrder,
  readEasyPayDirectRefundTransaction,
} from "../providers/easy-pay-direct";
import {
  refundEasyPayDirectElementsOrder,
  readEasyPayDirectElementsRefundTransaction,
} from "../providers/easy-pay-direct-elements";

type Origin = { organizationId: string; providerAccountCode: string; orderId: string };
type RefundInput = Origin & { amountMinor: number; currency: string; idempotencyKey: string };
export type RefundBackend = "commerce_legacy" | "commerce_elements" | "gateway";

// Select by immutable payment execution, never by an identifier's appearance or
// the currently selected checkout UI. Historical unknown origins stay held;
// every transport requires exact successful execution and paid ledger proof.
export async function easyPayDirectRefundBackend(
  database: D1Database,
  input: Origin,
): Promise<RefundBackend> {
  const result = await database
    .prepare(`WITH origins AS (
    SELECT payment_backend, charge_transport, status, payment_request_id FROM easy_pay_direct_payment_executions
    WHERE organization_id = ?1 AND provider_account_code = ?2 AND provider_transaction_id = ?3
    UNION ALL
    SELECT payment_backend, charge_transport, status, payment_request_id FROM easy_pay_direct_automatic_payment_executions
    WHERE organization_id = ?1 AND provider_account_code = ?2 AND provider_transaction_id = ?3
  ) SELECT payment_backend, charge_transport, status, EXISTS (
    SELECT 1 FROM payment_request_payments paid
    WHERE paid.organization_id = ?1 AND paid.payment_request_id = origins.payment_request_id
      AND paid.provider = 'easy_pay_direct' AND paid.provider_account_code = ?2
      AND paid.provider_transaction_id = ?3 AND paid.status = 'succeeded'
  ) AS verified_paid FROM origins`)
    .bind(input.organizationId, input.providerAccountCode, input.orderId)
    .all<{
      payment_backend: string;
      charge_transport: string;
      status: string;
      verified_paid: number;
    }>();
  if (
    result.results.length !== 1 ||
    result.results.some(
      (row) =>
        !["gateway_vault", "commerce_elements"].includes(row.payment_backend) ||
        !["gateway", "commerce"].includes(row.charge_transport) ||
        (row.payment_backend === "commerce_elements" && row.charge_transport !== "commerce") ||
        row.status !== "succeeded" ||
        row.verified_paid !== 1,
    )
  ) {
    throw new ApiError(
      409,
      "easy_pay_direct_refund_origin_unverified",
      "Refund payment origin requires review.",
    );
  }
  if (result.results[0]!.charge_transport === "gateway") return "gateway";
  return result.results[0]?.payment_backend === "commerce_elements"
    ? "commerce_elements"
    : "commerce_legacy";
}

export function assertEasyPayDirectRefundBoundary(
  env: {
    APP_ENV?: string;
    EASY_PAY_DIRECT_NETWORK_MODE?: string;
    EASY_PAY_DIRECT_LIVEMODE_ALLOWED?: string;
    EASY_PAY_DIRECT_ORGANIZATION_ID?: string;
    EASY_PAY_DIRECT_ACCOUNT_CODE?: string;
  },
  input: Origin,
  backend: RefundBackend,
): void {
  if (
    input.organizationId !== env.EASY_PAY_DIRECT_ORGANIZATION_ID?.trim() ||
    input.providerAccountCode !== env.EASY_PAY_DIRECT_ACCOUNT_CODE?.trim() ||
    env.EASY_PAY_DIRECT_LIVEMODE_ALLOWED !== "0" ||
    (backend === "gateway"
      ? !["development", "staging", "test"].includes(env.APP_ENV ?? "") ||
        env.EASY_PAY_DIRECT_NETWORK_MODE !== "gateway_test"
      : backend === "commerce_elements"
        ? !["development", "staging", "test"].includes(env.APP_ENV ?? "") ||
          !["test", "gateway_test"].includes(env.EASY_PAY_DIRECT_NETWORK_MODE ?? "")
        : env.EASY_PAY_DIRECT_NETWORK_MODE !== "test")
  ) {
    throw new ApiError(
      503,
      "easy_pay_direct_refund_boundary_mismatch",
      "Refund is not enabled for this payment environment.",
    );
  }
}

export async function refundEasyPayDirectByOrigin(
  env: Env,
  input: RefundInput,
  fetcher: typeof fetch,
  checkpoint: (transactionId: string) => Promise<void>,
) {
  const backend = await easyPayDirectRefundBackend(env.BILLING_DB, input);
  assertEasyPayDirectRefundBoundary(env, input, backend);
  if (backend === "gateway") return submitGatewayRefundOperation(env, input, fetcher, checkpoint);
  const refund =
    backend === "commerce_elements" ? refundEasyPayDirectElementsOrder : refundEasyPayDirectOrder;
  return refund(env, input, fetcher, checkpoint);
}

export async function readEasyPayDirectRefundByOrigin(
  env: Env,
  input: RefundInput & { transactionId: string },
  fetcher: typeof fetch,
) {
  const backend = await easyPayDirectRefundBackend(env.BILLING_DB, input);
  assertEasyPayDirectRefundBoundary(env, input, backend);
  if (backend === "gateway") return readGatewayRefundOperation(env, input);
  if (env.PROVIDER_READS_ENABLED !== "1")
    throw new ApiError(503, "provider_reads_disabled", "Provider reads are disabled.");
  const read =
    backend === "commerce_elements"
      ? readEasyPayDirectElementsRefundTransaction
      : readEasyPayDirectRefundTransaction;
  return read(env, input, fetcher);
}
