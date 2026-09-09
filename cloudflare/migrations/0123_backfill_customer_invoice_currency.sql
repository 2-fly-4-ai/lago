-- Store-originated customers created before the checkout currency contract was
-- enforced can have a NULL currency even though their invoices are unambiguous.
-- Dunning is customer-currency scoped, so backfill only when every historical
-- invoice for that customer uses the same currency. Ambiguous customers remain
-- excluded from automated dunning until their currency is explicitly resolved.
UPDATE customers
SET currency = (
  SELECT MIN(invoice.currency)
  FROM invoices invoice
  WHERE invoice.organization_id = customers.organization_id
    AND invoice.customer_id = customers.id
), version = version + 1
WHERE currency IS NULL
  AND payment_provider = 'easy_pay_direct'
  AND 1 = (
    SELECT COUNT(DISTINCT invoice.currency)
    FROM invoices invoice
    WHERE invoice.organization_id = customers.organization_id
      AND invoice.customer_id = customers.id
  )
  AND NOT EXISTS (
    SELECT 1 FROM payment_requests request
    WHERE request.organization_id = customers.organization_id
      AND request.customer_id = customers.id
      AND request.currency <> (
        SELECT MIN(invoice.currency) FROM invoices invoice
        WHERE invoice.organization_id = customers.organization_id
          AND invoice.customer_id = customers.id
      )
  )
  AND NOT EXISTS (
    SELECT 1 FROM subscriptions subscription
    JOIN plans plan ON plan.id = subscription.plan_id
      AND plan.organization_id = subscription.organization_id
    WHERE subscription.organization_id = customers.organization_id
      AND subscription.customer_id = customers.id
      AND plan.currency <> (
        SELECT MIN(invoice.currency) FROM invoices invoice
        WHERE invoice.organization_id = customers.organization_id
          AND invoice.customer_id = customers.id
      )
  )
  AND NOT EXISTS (
    SELECT 1 FROM wallets wallet
    WHERE wallet.organization_id = customers.organization_id
      AND wallet.customer_id = customers.id
      AND wallet.currency <> (
        SELECT MIN(invoice.currency) FROM invoices invoice
        WHERE invoice.organization_id = customers.organization_id
          AND invoice.customer_id = customers.id
      )
  );
