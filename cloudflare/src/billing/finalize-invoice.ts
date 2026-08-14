import type { DomainEvent } from "../domain-events";
import { stableJson } from "../json";
import { paymentDueDate } from "./payment-terms";
import { refreshSubscriptionDraft } from "./refresh-draft-invoice";

type FinalizableInvoice = {
  id: string;
  organization_id: string;
  customer_id: string;
  subscription_id: string | null;
  status: string;
  currency: string;
  total_due_minor: number;
  net_payment_term: number;
  issuing_date: string;
  version: number;
  refreshable_draft: number;
};

export async function finalizeInvoice(
  env: Pick<Env, "BILLING_DB" | "BILLING_ACCOUNTS" | "DOMAIN_EVENTS">,
  invoiceId: string,
  organizationId: string | null,
  finalizedAt: string,
  correlationId: string,
): Promise<boolean> {
  const organizationFilter = organizationId ? " AND organization_id = ?" : "";
  const bindings = organizationId ? [invoiceId, organizationId] : [invoiceId];
  const invoice = await env.BILLING_DB.prepare(
    `SELECT id, organization_id, customer_id, subscription_id, status, currency,
            total_due_minor, net_payment_term, issuing_date, version,
            (EXISTS(SELECT 1 FROM billing_cycles WHERE invoice_id = invoices.id) OR
             EXISTS(SELECT 1 FROM subscription_invoice_contexts WHERE invoice_id = invoices.id))
              AS refreshable_draft
     FROM invoices WHERE id = ?${organizationFilter} LIMIT 1`,
  )
    .bind(...bindings)
    .first<FinalizableInvoice>();
  if (!invoice) throw new Error("invoice_not_found");
  if (invoice.status === "finalized") return false;
  if (invoice.status !== "draft") throw new Error("invoice_not_draft");
  if (!invoice.issuing_date) throw new Error("invoice_issuing_date_missing");
  if (invoice.subscription_id && invoice.refreshable_draft === 1) {
    const result = await refreshSubscriptionDraft(
      env,
      invoice.id,
      organizationId,
      finalizedAt,
      correlationId,
      true,
    );
    return result.changed;
  }

  const nextVersion = invoice.version + 1;
  const paymentDue = paymentDueDate(invoice.issuing_date, invoice.net_payment_term);
  const event: DomainEvent = {
    id: `invoice-finalized:${invoice.id}:v${nextVersion}`,
    type: "invoice.finalized",
    version: 1,
    aggregateType: "invoice",
    aggregateId: invoice.id,
    aggregateVersion: nextVersion,
    occurredAt: finalizedAt,
    causationId: correlationId,
    correlationId,
    payload: {
      organizationId: invoice.organization_id,
      invoiceId: invoice.id,
      customerId: invoice.customer_id,
      subscriptionId: invoice.subscription_id,
      totalDueMinor: invoice.total_due_minor,
      currency: invoice.currency,
      issuingDate: invoice.issuing_date,
      paymentDueDate: paymentDue,
    },
  };
  const results = await env.BILLING_DB.batch([
    env.BILLING_DB.prepare(
      `UPDATE invoices
       SET status = 'finalized', finalized_at = ?, payment_due_date = ?,
           version = version + 1, updated_at = ?
       WHERE id = ? AND organization_id = ? AND status = 'draft' AND version = ?`,
    ).bind(
      finalizedAt,
      paymentDue,
      finalizedAt,
      invoice.id,
      invoice.organization_id,
      invoice.version,
    ),
    env.BILLING_DB.prepare(
      `INSERT INTO outbox_events
       (event_id, organization_id, event_type, event_version, aggregate_type,
        aggregate_id, aggregate_version, causation_id, correlation_id, payload_json,
        occurred_at, published_at)
       SELECT ?, ?, ?, 1, 'invoice', ?, ?, ?, ?, ?, ?, NULL FROM invoices
       WHERE id = ? AND organization_id = ? AND status = 'finalized' AND version = ?`,
    ).bind(
      event.id,
      invoice.organization_id,
      event.type,
      invoice.id,
      nextVersion,
      correlationId,
      correlationId,
      stableJson(event.payload),
      finalizedAt,
      invoice.id,
      invoice.organization_id,
      nextVersion,
    ),
  ]);
  if (results[0]?.meta.changes !== 1 || results[1]?.meta.changes !== 1)
    throw new Error("invoice_version_conflict");
  await env.DOMAIN_EVENTS.send(event);
  return true;
}
