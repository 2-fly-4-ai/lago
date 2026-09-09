import { closeBillingPeriod } from "../billing/close-period";
import { prepareEasyPayDirectAutomaticCollection } from "../billing/easy-pay-direct-automatic-collection";
import type { DomainEvent } from "../domain-events";

export type SandboxRenewalProof = {
  subscriptionId: string;
  expectedPeriodEnd: string;
  resumeInvoiceId?: string;
};
export type SandboxRenewalProofEnv = Env & {
  EASY_PAY_DIRECT_SANDBOX_RENEWAL_SUBSCRIPTION_ID?: string;
  EASY_PAY_DIRECT_SANDBOX_RENEWAL_PERIOD_END?: string;
};

// Privileged workflow-only test entry. This deliberately closes one real period
// early in a sandbox, without advancing the global scheduler clock or changing
// stored dates/payment evidence. Normal invoice events own all subsequent work.
export async function runSandboxRenewalProof(
  env: SandboxRenewalProofEnv,
  target: SandboxRenewalProof,
) {
  if (
    !target ||
    typeof target !== "object" ||
    env.APP_ENV !== "development" ||
    env.EASY_PAY_DIRECT_NETWORK_MODE !== "gateway_test" ||
    env.EASY_PAY_DIRECT_LIVEMODE_ALLOWED !== "0" ||
    env.PAYMENT_MUTATIONS_ENABLED !== "1" ||
    !env.EASY_PAY_DIRECT_ORGANIZATION_ID?.trim() ||
    !env.EASY_PAY_DIRECT_ACCOUNT_CODE?.trim() ||
    !env.EASY_PAY_DIRECT_SANDBOX_RENEWAL_SUBSCRIPTION_ID?.trim() ||
    target.subscriptionId !== env.EASY_PAY_DIRECT_SANDBOX_RENEWAL_SUBSCRIPTION_ID ||
    target.expectedPeriodEnd !== env.EASY_PAY_DIRECT_SANDBOX_RENEWAL_PERIOD_END ||
    !Number.isFinite(Date.parse(target.expectedPeriodEnd)) ||
    (target.resumeInvoiceId !== undefined &&
      (typeof target.resumeInvoiceId !== "string" || !target.resumeInvoiceId.trim()))
  )
    throw new Error("sandbox_renewal_proof_forbidden");
  const correlationId = `sandbox-renewal-proof:${target.subscriptionId}:${target.expectedPeriodEnd}`;
  // A workflow retry may occur after the period advanced but before Queue accepted
  // the event. Only this driver's exact closed cycle is resumable; never close a
  // second period or accept an unrelated invoice supplied by the caller.
  const completed = await env.BILLING_DB.prepare(`SELECT cycle.id AS billingCycleId,
      invoice.id AS invoiceId, invoice.total_due_minor AS totalDueMinor
    FROM billing_cycles cycle JOIN invoices invoice ON invoice.id=cycle.invoice_id
      AND invoice.organization_id=cycle.organization_id AND invoice.subscription_id=cycle.subscription_id
    JOIN outbox_events event ON event.event_id='invoice-finalized:'||invoice.id||':v1'
      AND event.organization_id=cycle.organization_id AND event.aggregate_id=invoice.id
      AND event.aggregate_type='invoice' AND event.event_type='invoice.finalized'
      AND event.causation_id=cycle.id AND event.correlation_id=?
    WHERE cycle.organization_id=? AND cycle.subscription_id=? AND cycle.period_end=?
      AND cycle.status='closed' AND invoice.status='finalized'
    LIMIT 1`)
    .bind(
      correlationId,
      env.EASY_PAY_DIRECT_ORGANIZATION_ID,
      target.subscriptionId,
      target.expectedPeriodEnd,
    )
    .first<{ billingCycleId: string; invoiceId: string; totalDueMinor: number }>();
  if (target.resumeInvoiceId !== undefined && completed?.invoiceId !== target.resumeInvoiceId)
    throw new Error("sandbox_renewal_proof_fixture_mismatch");
  const selected = await env.BILLING_DB.prepare(`SELECT s.id FROM subscriptions s
    JOIN plans p ON p.id=s.plan_id AND p.organization_id=s.organization_id
    JOIN customers c ON c.id=s.customer_id AND c.organization_id=s.organization_id
    JOIN provider_customer_profiles profile ON profile.id=s.payment_method_id
      AND profile.organization_id=s.organization_id AND profile.customer_id=s.customer_id
    JOIN payment_request_checkout_intents intent ON intent.id=profile.checkout_intent_id
      AND intent.organization_id=s.organization_id AND intent.customer_id=s.customer_id
    JOIN easy_pay_direct_payment_executions execution ON execution.checkout_intent_id=intent.id
      AND execution.organization_id=s.organization_id AND execution.payment_request_id=intent.payment_request_id
    JOIN payment_requests request ON request.id=intent.payment_request_id
      AND request.organization_id=s.organization_id AND request.customer_id=s.customer_id
    WHERE s.id=? AND s.organization_id=?
      AND ((? IS NULL AND s.current_period_end=?) OR (? IS NOT NULL AND s.current_period_start=?))
      AND s.status='active' AND s.ending_at IS NULL AND s.payment_method_type='provider'
      AND NOT EXISTS (SELECT 1 FROM subscriptions successor
        WHERE successor.previous_subscription_id=s.id AND successor.status='pending')
      AND p.active=1 AND p.interval IN ('weekly','monthly','quarterly','yearly')
      AND c.payment_provider='easy_pay_direct' AND c.payment_provider_code=?
      AND profile.provider='easy_pay_direct' AND profile.provider_account_code=c.payment_provider_code
      AND profile.status='active' AND profile.payment_backend='gateway_vault'
      AND length(trim(profile.gateway_customer_vault_id))>0 AND length(trim(profile.initial_transaction_id))>0
      AND execution.status='succeeded' AND execution.charge_transport='gateway'
      AND intent.provider='easy_pay_direct' AND intent.provider_account_code=profile.provider_account_code
      AND execution.provider_account_code=profile.provider_account_code AND execution.terms_accepted_at IS NOT NULL
      AND execution.provider_transaction_id IS NOT NULL AND request.payment_status='succeeded'
      AND profile.initial_transaction_id=execution.provider_transaction_id
      AND profile.gateway_customer_vault_id=execution.customer_vault_id
      AND EXISTS (SELECT 1 FROM invoices_payment_requests link JOIN invoices i ON i.id=link.invoice_id
        AND i.organization_id=link.organization_id
        JOIN subscription_invoice_contexts context ON context.invoice_id=i.id AND context.context_type='initial'
        WHERE link.payment_request_id=request.id AND link.organization_id=s.organization_id
          AND i.subscription_id=s.id AND i.customer_id=s.customer_id AND i.status='finalized' AND i.payment_status='succeeded')
      AND EXISTS (SELECT 1 FROM easy_pay_direct_automatic_collection_scopes scope
        WHERE scope.subscription_id=s.id AND scope.organization_id=s.organization_id AND scope.status='enabled')
      AND NOT EXISTS (SELECT 1 FROM customer_closure_holds hold WHERE hold.customer_id=c.id)
      AND NOT EXISTS (SELECT 1 FROM customer_closure_email_holds hold WHERE hold.organization_id=c.organization_id AND hold.email=lower(c.email))
    LIMIT 1`)
    .bind(
      target.subscriptionId,
      env.EASY_PAY_DIRECT_ORGANIZATION_ID,
      completed?.invoiceId ?? null,
      target.expectedPeriodEnd,
      completed?.invoiceId ?? null,
      target.expectedPeriodEnd,
      env.EASY_PAY_DIRECT_ACCOUNT_CODE,
    )
    .first<{ id: string }>();
  if (!selected) throw new Error("sandbox_renewal_proof_fixture_mismatch");
  const result = completed
    ? { ...completed, replayed: true }
    : await closeBillingPeriod(env, selected.id, target.expectedPeriodEnd, correlationId);
  // closeBillingPeriod already sends invoice.finalized. An early fixture can have
  // that event fully processed while collection correctly skips its future due
  // date. On an explicit exact-cycle resume, recheck standard eligibility without
  // deleting/replaying processed messages or bypassing any payment/date guards.
  const automaticPreparation = completed
    ? await prepareEasyPayDirectAutomaticCollection(env, result.invoiceId, correlationId)
    : null;
  const publishedEvents = await publishExactRenewalEvents(env, target, result, correlationId);
  return {
    sandboxRenewalProof: true,
    subscriptionId: selected.id,
    ...result,
    automaticPreparation,
    publishedEvents,
  };
}

async function publishExactRenewalEvents(
  env: SandboxRenewalProofEnv,
  target: SandboxRenewalProof,
  result: { invoiceId: string; billingCycleId: string },
  correlationId: string,
) {
  const rows = await env.BILLING_DB.prepare(`SELECT event.* FROM outbox_events event
    WHERE event.organization_id=? AND event.published_at IS NULL AND (
      (event.event_id=? AND event.event_type='invoice.finalized' AND event.aggregate_type='invoice'
        AND event.aggregate_id=? AND event.causation_id=? AND event.correlation_id=?)
      OR (event.event_type='payment_request.created' AND event.aggregate_type='payment_request'
        AND EXISTS (SELECT 1 FROM easy_pay_direct_automatic_payment_executions execution
          JOIN invoices_payment_requests link ON link.payment_request_id=execution.payment_request_id
            AND link.organization_id=execution.organization_id
          WHERE execution.organization_id=event.organization_id
            AND execution.provider_account_code=? AND execution.payment_request_id=event.aggregate_id
            AND execution.status='pending' AND link.invoice_id=?
            AND NOT EXISTS (SELECT 1 FROM invoices_payment_requests other
              WHERE other.payment_request_id=link.payment_request_id AND other.invoice_id<>link.invoice_id))))
    ORDER BY event.occurred_at,event.event_id LIMIT 10`)
    .bind(
      env.EASY_PAY_DIRECT_ORGANIZATION_ID,
      `invoice-finalized:${result.invoiceId}:v1`,
      result.invoiceId,
      result.billingCycleId,
      correlationId,
      env.EASY_PAY_DIRECT_ACCOUNT_CODE,
      result.invoiceId,
    )
    .all<{
      event_id: string;
      event_type: string;
      event_version: number;
      aggregate_type: string;
      aggregate_id: string;
      aggregate_version: number;
      occurred_at: string;
      causation_id: string | null;
      correlation_id: string;
      payload_json: string;
    }>();
  for (const row of rows.results) {
    const payload: unknown = JSON.parse(row.payload_json);
    if (!payload || typeof payload !== "object" || Array.isArray(payload))
      throw new Error("sandbox_renewal_proof_event_invalid");
    if (
      row.event_type === "invoice.finalized" &&
      (!("subscriptionId" in payload) ||
        payload.subscriptionId !== target.subscriptionId ||
        !("periodEnd" in payload) ||
        payload.periodEnd !== target.expectedPeriodEnd)
    )
      throw new Error("sandbox_renewal_proof_event_invalid");
    await env.DOMAIN_EVENTS.send({
      id: row.event_id,
      type: row.event_type,
      version: row.event_version,
      aggregateType: row.aggregate_type,
      aggregateId: row.aggregate_id,
      aggregateVersion: row.aggregate_version,
      occurredAt: row.occurred_at,
      causationId: row.causation_id,
      correlationId: row.correlation_id,
      payload: payload as Record<string, unknown>,
    } satisfies DomainEvent);
  }
  // Consumer completion owns published_at. A send timeout can be safely replayed
  // with the same event IDs; normal queue consumer/payment execution guards apply.
  return rows.results.length;
}
