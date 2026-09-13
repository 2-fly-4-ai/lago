import { checkoutSubscriptionOrigin } from "./checkout-origin";

// Store creates an active subscription before the initial payment succeeds.
// That compatibility status must not turn an abandoned prepayment checkout into
// an ongoing invoice stream. Ordinary Lago postpaid/trial/free billing is unchanged.
// Aliases `subscription` and `plan` are supplied by each caller.
export const checkoutPeriodEligibility = `(
  NOT ${checkoutSubscriptionOrigin("subscription.id", "subscription.organization_id")}
  OR plan.pay_in_advance = 0
  OR plan.amount_minor = 0
  OR subscription.trial_started_at IS NOT NULL
  OR EXISTS (
    SELECT 1 FROM subscription_invoice_contexts context
    JOIN invoices initial ON initial.id = context.invoice_id
      AND initial.organization_id = context.organization_id
    WHERE context.subscription_id = subscription.id
      AND context.organization_id = subscription.organization_id
      AND context.context_type = 'initial'
      AND initial.subscription_id = subscription.id
      AND initial.customer_id = subscription.customer_id
      AND initial.currency = plan.currency AND initial.status = 'finalized'
      AND (initial.total_due_minor = 0 OR (
        initial.payment_status = 'succeeded'
        AND initial.total_due_minor = COALESCE((
          SELECT SUM(amount_minor) FROM (
            SELECT payment.provider, payment.provider_account_code,
              COALESCE(payment.provider_transaction_id, 'attempt:' || payment.id) AS transaction_key,
              payment.amount_minor
            FROM payment_attempts payment
            WHERE payment.invoice_id = initial.id AND payment.organization_id = initial.organization_id
              AND payment.currency = initial.currency AND payment.status = 'succeeded'
            UNION
            SELECT payment.provider, payment.provider_account_code,
              COALESCE(payment.provider_transaction_id, 'request:' || payment.id), allocation.amount_minor
            FROM payment_request_payment_allocations allocation
            JOIN payment_request_payments payment ON payment.id = allocation.payment_request_payment_id
            WHERE allocation.invoice_id = initial.id AND allocation.organization_id = initial.organization_id
              AND payment.organization_id = initial.organization_id
              AND payment.currency = initial.currency AND payment.status = 'succeeded'
          )
        ), 0)
      ))
  )
)`;
