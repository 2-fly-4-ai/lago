import { diagnoseEasyPayDirectGatewayRefundEvidence } from "../providers/easy-pay-direct-gateway-refunds";

export type SandboxRefundReadback = { invoiceId: string };
type ReadbackEnv = Env & { EASY_PAY_DIRECT_SANDBOX_REFUND_INVOICE_ID?: string };

// Privileged Workflow-only diagnostic. Does not submit a refund, mutate an
// operation, or treat a cumulative provider refund total as operation attribution.
export async function runSandboxRefundReadback(
  env: ReadbackEnv,
  input: SandboxRefundReadback,
  fetcher: typeof fetch = fetch,
) {
  if (
    !input ||
    typeof input !== "object" ||
    env.APP_ENV !== "development" ||
    env.EASY_PAY_DIRECT_NETWORK_MODE !== "gateway_test" ||
    env.EASY_PAY_DIRECT_LIVEMODE_ALLOWED !== "0" ||
    env.PROVIDER_READS_ENABLED !== "1" ||
    !env.EASY_PAY_DIRECT_ORGANIZATION_ID?.trim() ||
    !env.EASY_PAY_DIRECT_ACCOUNT_CODE?.trim() ||
    !env.EASY_PAY_DIRECT_SANDBOX_REFUND_INVOICE_ID?.trim() ||
    input.invoiceId !== env.EASY_PAY_DIRECT_SANDBOX_REFUND_INVOICE_ID
  )
    throw new Error("sandbox_refund_readback_forbidden");
  const rows =
    await env.BILLING_DB.prepare(`SELECT execution.provider_transaction_id AS transactionId,
      invoice.total_due_minor AS amountMinor,invoice.currency
    FROM invoices invoice
    JOIN invoices_payment_requests link ON link.invoice_id=invoice.id AND link.organization_id=invoice.organization_id
    JOIN payment_requests request ON request.id=link.payment_request_id AND request.organization_id=invoice.organization_id
      AND request.customer_id=invoice.customer_id AND request.payment_status='succeeded'
      AND request.amount_minor=invoice.total_due_minor AND request.currency=invoice.currency
    JOIN payment_request_checkout_intents intent ON intent.payment_request_id=request.id
      AND intent.organization_id=invoice.organization_id AND intent.customer_id=invoice.customer_id
      AND intent.provider='easy_pay_direct' AND intent.provider_account_code=?
      AND intent.status='succeeded' AND intent.amount_minor=request.amount_minor AND intent.currency=request.currency
    JOIN easy_pay_direct_payment_executions execution ON execution.checkout_intent_id=intent.id
      AND execution.payment_request_id=request.id AND execution.organization_id=invoice.organization_id
      AND execution.provider_account_code=intent.provider_account_code AND execution.status='succeeded'
      AND execution.charge_transport='gateway' AND execution.payment_backend='gateway_vault'
    JOIN payment_request_payments paid ON paid.payment_request_id=request.id
      AND paid.organization_id=invoice.organization_id AND paid.provider='easy_pay_direct'
      AND paid.provider_account_code=execution.provider_account_code
      AND paid.provider_transaction_id=execution.provider_transaction_id AND paid.status='succeeded'
      AND paid.amount_minor=request.amount_minor AND paid.currency=request.currency
    WHERE invoice.id=? AND invoice.organization_id=? AND invoice.status='finalized'
      AND invoice.payment_status='succeeded' AND invoice.total_due_minor>0
      AND (SELECT COUNT(*) FROM invoices_payment_requests linked WHERE linked.payment_request_id=request.id)=1
    LIMIT 2`)
      .bind(env.EASY_PAY_DIRECT_ACCOUNT_CODE, input.invoiceId, env.EASY_PAY_DIRECT_ORGANIZATION_ID)
      .all<{ transactionId: string; amountMinor: number; currency: string }>();
  if (
    rows.results.length !== 1 ||
    !/^[0-9]{1,64}$/u.test(rows.results[0]!.transactionId) ||
    !Number.isSafeInteger(rows.results[0]!.amountMinor) ||
    !/^[A-Z]{3}$/u.test(rows.results[0]!.currency)
  )
    throw new Error("sandbox_refund_readback_provenance_mismatch");
  const original = rows.results[0]!;
  const result = await diagnoseEasyPayDirectGatewayRefundEvidence(
    env,
    {
      transactionId: original.transactionId,
      currency: original.currency,
    },
    fetcher,
  );
  if (result.status === "unverified")
    return { sandboxRefundReadback: true, invoiceId: input.invoiceId, ...result };
  if (result.evidence.saleAmountMinor !== original.amountMinor)
    return {
      sandboxRefundReadback: true,
      invoiceId: input.invoiceId,
      status: "unverified" as const,
      diagnostic: "sandbox_refund_readback_sale_amount_mismatch",
    };
  return {
    sandboxRefundReadback: true,
    invoiceId: input.invoiceId,
    status: "verified" as const,
    currency: original.currency,
    saleAmountMinor: result.evidence.saleAmountMinor,
    refundedAmountMinor: result.evidence.refundedAmountMinor,
  };
}
