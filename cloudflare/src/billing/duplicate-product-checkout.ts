// Correlated against the payment request alias r. This predicate is evaluated
// inside the atomic execution UPDATE, not as a read-then-write preflight.
// Separate checkout IDs must not authorize two subscriptions to the same app.
// Unsubmitted/definitively declined attempts do not reserve a product. Unknown
// provider outcomes do: a timeout is not proof that no money moved.
export const noDuplicateProductCheckoutSql = `NOT EXISTS (
  SELECT 1 FROM invoices_payment_requests own_link
  JOIN invoices own_invoice ON own_invoice.id = own_link.invoice_id
    AND own_invoice.organization_id = own_link.organization_id
  JOIN subscriptions own_subscription ON own_subscription.id = own_invoice.subscription_id
    AND own_subscription.organization_id = own_invoice.organization_id
  JOIN plans own_plan ON own_plan.id = own_subscription.plan_id
    AND own_plan.organization_id = own_subscription.organization_id
  JOIN subscription_checkout_products own_product
    ON own_product.subscription_id = own_subscription.id
    AND own_product.organization_id = own_subscription.organization_id
  JOIN customers own_customer ON own_customer.id = own_subscription.customer_id
    AND own_customer.organization_id = own_subscription.organization_id
  JOIN subscription_checkout_products other_product
    ON other_product.organization_id = own_product.organization_id
    AND other_product.product_slug = own_product.product_slug
  JOIN subscriptions other_subscription ON other_subscription.id = other_product.subscription_id
    AND other_subscription.organization_id = other_product.organization_id
  JOIN plans other_plan ON other_plan.id = other_subscription.plan_id
    AND other_plan.organization_id = other_subscription.organization_id
  JOIN customers other_customer ON other_customer.id = other_subscription.customer_id
    AND other_customer.organization_id = other_subscription.organization_id
  JOIN invoices other_invoice ON other_invoice.subscription_id = other_subscription.id
    AND other_invoice.organization_id = other_subscription.organization_id
  WHERE own_link.payment_request_id = r.id AND own_link.organization_id = r.organization_id
    AND own_plan.interval IN ('weekly', 'monthly', 'quarterly', 'yearly')
    AND other_plan.interval IN ('weekly', 'monthly', 'quarterly', 'yearly')
    AND other_subscription.id <> own_subscription.id
    AND other_subscription.external_id <> own_subscription.external_id
    AND other_subscription.status IN ('pending', 'active', 'past_due')
    AND (other_customer.id = own_customer.id OR (
      length(trim(own_customer.email)) > 0
      AND lower(trim(other_customer.email)) = lower(trim(own_customer.email))
    ))
    AND (other_invoice.payment_status = 'succeeded' OR EXISTS (
      SELECT 1 FROM invoices_payment_requests other_link
      JOIN easy_pay_direct_payment_executions other_execution
        ON other_execution.payment_request_id = other_link.payment_request_id
        AND other_execution.organization_id = other_link.organization_id
      WHERE other_link.invoice_id = other_invoice.id
        AND other_link.organization_id = other_invoice.organization_id
        AND other_execution.payment_request_id <> r.id
        AND other_execution.status IN ('processing', 'unknown', 'succeeded')
    ))
)`;
