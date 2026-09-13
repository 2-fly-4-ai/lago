// SQL expressions are supplied only by internal callers, never request input.
// Older Store checkouts predate product attribution: their initial invoice and
// immutable EPD checkout intent still establish checkout origin.
export function checkoutSubscriptionOrigin(subscriptionId: string, organizationId: string): string {
  return `(EXISTS (
    SELECT 1 FROM subscription_checkout_products attribution
    WHERE attribution.subscription_id = ${subscriptionId}
      AND attribution.organization_id = ${organizationId}
  ) OR EXISTS (
    SELECT 1 FROM subscription_invoice_contexts origin_context
    JOIN invoices origin_invoice ON origin_invoice.id = origin_context.invoice_id
      AND origin_invoice.organization_id = origin_context.organization_id
    JOIN invoices_payment_requests origin_link ON origin_link.invoice_id = origin_invoice.id
      AND origin_link.organization_id = origin_invoice.organization_id
    JOIN payment_requests origin_request ON origin_request.id = origin_link.payment_request_id
      AND origin_request.organization_id = origin_link.organization_id
      AND origin_request.customer_id = origin_invoice.customer_id
    JOIN payment_request_checkout_intents origin_intent ON origin_intent.payment_request_id = origin_request.id
      AND origin_intent.organization_id = origin_request.organization_id
      AND origin_intent.customer_id = origin_request.customer_id
    WHERE origin_context.subscription_id = ${subscriptionId}
      AND origin_context.organization_id = ${organizationId}
      AND origin_invoice.subscription_id = ${subscriptionId}
      AND origin_context.context_type = 'initial'
      AND origin_request.collection_mode = 'checkout'
      AND origin_intent.provider = 'easy_pay_direct'
  ))`;
}
