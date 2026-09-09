import { ApiError } from "../http";
import {
  refundEasyPayDirectGatewayTransaction,
  gatewayRefundErrorDiagnostic,
} from "../providers/easy-pay-direct-gateway-refunds";

type Input = {
  organizationId: string;
  providerAccountCode: string;
  orderId: string;
  amountMinor: number;
  currency: string;
  idempotencyKey: string;
};
// Caller has already verified original execution transport and environment.
async function operation(env: Env, input: Input) {
  const rows = await env.BILLING_DB.prepare(`SELECT id FROM provider_refund_operations
    WHERE organization_id = ? AND provider = 'easy_pay_direct' AND provider_account_code = ?
      AND provider_payment_id = ? AND amount_minor = ? AND currency = ?
      AND provider_idempotency_key = ? AND status = 'submitted'`)
    .bind(
      input.organizationId,
      input.providerAccountCode,
      input.orderId,
      input.amountMinor,
      input.currency,
      input.idempotencyKey,
    )
    .all<{ id: string }>();
  if (rows.results.length !== 1)
    throw new ApiError(
      409,
      "gateway_refund_operation_unclaimed",
      "Refund requires a uniquely claimed operation.",
    );
  return rows.results[0]!.id;
}
export async function readGatewayRefundOperation(env: Env, input: Input) {
  const id = await operation(env, input);
  const row = await env.BILLING_DB.prepare(
    "SELECT status FROM gateway_refund_attempts WHERE operation_id = ?",
  )
    .bind(id)
    .first<{ status: string }>();
  const status =
    row?.status === "succeeded"
      ? ("succeeded" as const)
      : row?.status === "failed"
        ? ("failed" as const)
        : ("unknown" as const);
  const details = await env.BILLING_DB.prepare(
    "SELECT failure_message FROM provider_refund_operations WHERE id = ?",
  )
    .bind(id)
    .first<{ failure_message: string | null }>();
  const diagnostic = details?.failure_message?.replace(
    /^Gateway refund needs review; do not resubmit\. /u,
    "",
  );
  const safeDiagnostic =
    diagnostic && /^gateway_refund_diagnostic:[a-z0-9_:]{1,180}$/u.test(diagnostic)
      ? diagnostic
      : null;
  return {
    id: status === "unknown" ? null : `gateway-operation:${id}`,
    status,
    responseText:
      status === "succeeded"
        ? "Gateway refund approval recorded."
        : `Gateway refund needs review; do not resubmit.${safeDiagnostic ? ` ${safeDiagnostic}` : ""}`,
  };
}
export async function submitGatewayRefundOperation(
  env: Env,
  input: Input,
  fetcher: typeof fetch,
  checkpoint: (id: string) => Promise<void>,
) {
  const id = await operation(env, input);
  const now = new Date().toISOString();
  const claimed =
    await env.BILLING_DB.prepare(`INSERT INTO gateway_refund_attempts(operation_id,status,created_at,updated_at)
    VALUES (?,'submitted',?,?) ON CONFLICT(operation_id) DO NOTHING RETURNING operation_id`)
      .bind(id, now, now)
      .first();
  if (!claimed) return readGatewayRefundOperation(env, input);
  try {
    // The read checkpoint is our operation, not the original sale. Establish it
    // before transport so every later crash can recover only durable approval.
    await checkpoint(`gateway-operation:${id}`);
    const result = await refundEasyPayDirectGatewayTransaction(
      env,
      { transactionId: input.orderId, amountMinor: input.amountMinor, currency: input.currency },
      fetcher,
      async (providerId) => {
        await env.BILLING_DB.prepare(
          "UPDATE gateway_refund_attempts SET response_transaction_id = ?, updated_at = ? WHERE operation_id = ? AND status = 'submitted'",
        )
          .bind(providerId, new Date().toISOString(), id)
          .run();
      },
    );
    await env.BILLING_DB.prepare(
      "UPDATE gateway_refund_attempts SET status = ?, updated_at = ? WHERE operation_id = ? AND status = 'submitted'",
    )
      .bind(result.status, new Date().toISOString(), id)
      .run();
    if (result.diagnostic)
      await env.BILLING_DB.prepare(
        "UPDATE provider_refund_operations SET failure_message = ? WHERE id = ? AND status = 'submitted'",
      )
        .bind(result.diagnostic, id)
        .run();
  } catch (error) {
    await env.BILLING_DB.prepare(
      "UPDATE gateway_refund_attempts SET status = 'unknown', updated_at = ? WHERE operation_id = ? AND status = 'submitted'",
    )
      .bind(new Date().toISOString(), id)
      .run();
    await env.BILLING_DB.prepare(
      "UPDATE provider_refund_operations SET failure_message = ? WHERE id = ? AND status = 'submitted'",
    )
      .bind(gatewayRefundErrorDiagnostic(error), id)
      .run();
  }
  return readGatewayRefundOperation(env, input);
}
