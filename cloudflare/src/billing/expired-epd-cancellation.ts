export type ExpiredEpdCancellationGuard = {
  externalCustomerId: string;
  subscriptionId: string;
  periodEnd: string;
};

// Deliberately conservative: future UNPAID plan lines also require review. This
// is not the general "cancel at last paid-through date" algorithm. The assertion
// executes in the termination batch, before child cancellation and the outbox.
export function expiredEpdCancellationFence(
  database: D1Database,
  organizationId: string,
  subscriptionId: string,
  version: number,
  now: string,
  guardId: string,
  expected: ExpiredEpdCancellationGuard,
): D1PreparedStatement {
  return database
    .prepare(`INSERT INTO expired_epd_cancellation_fences (guard_id, eligible)
    SELECT ?, EXISTS (
      SELECT 1 FROM subscriptions s JOIN plans plan ON plan.id = s.plan_id AND plan.organization_id = s.organization_id
      JOIN customers c ON c.id = s.customer_id AND c.organization_id = s.organization_id
      WHERE s.organization_id = ? AND s.id = ? AND s.id = ? AND s.version = ?
        AND s.status IN ('active', 'past_due') AND c.external_id = ? AND c.payment_provider = 'easy_pay_direct'
        AND plan.interval IN ('weekly', 'monthly', 'quarterly', 'yearly')
        AND s.current_period_end = ? AND julianday(s.current_period_end) IS NOT NULL
        AND julianday(s.current_period_end) <= julianday(?)
        AND NOT EXISTS (SELECT 1 FROM subscriptions child JOIN invoices i
          ON i.organization_id = child.organization_id AND (i.subscription_id = child.id OR EXISTS (
            SELECT 1 FROM invoice_subscriptions link WHERE link.invoice_id = i.id
              AND link.subscription_id = child.id AND link.organization_id = child.organization_id))
          WHERE child.previous_subscription_id = s.id AND child.status = 'pending')
        AND NOT EXISTS (
          SELECT 1 FROM invoices i WHERE i.organization_id = s.organization_id
            AND (i.subscription_id = s.id OR EXISTS (SELECT 1 FROM invoice_subscriptions link
              WHERE link.invoice_id = i.id AND link.organization_id = s.organization_id AND link.subscription_id = s.id))
            AND (i.customer_id <> s.customer_id
              OR (SELECT COUNT(*) FROM invoice_lines l WHERE l.invoice_id = i.id
                AND l.line_type = 'subscription' AND l.source_type = 'plan' AND l.source_id = s.plan_id) <> 1
              OR EXISTS (SELECT 1 FROM invoice_lines l WHERE l.invoice_id = i.id
                AND l.line_type = 'subscription' AND l.source_type = 'plan' AND l.source_id = s.plan_id
                AND (NOT json_valid(l.metadata_json)
                  OR json_type(CASE WHEN json_valid(l.metadata_json) THEN l.metadata_json ELSE '{}' END, '$.periodStart') IS NOT 'text'
                  OR json_type(CASE WHEN json_valid(l.metadata_json) THEN l.metadata_json ELSE '{}' END, '$.periodEnd') IS NOT 'text'
                  OR julianday(json_extract(CASE WHEN json_valid(l.metadata_json) THEN l.metadata_json ELSE '{}' END, '$.periodStart')) IS NULL
                  OR julianday(json_extract(CASE WHEN json_valid(l.metadata_json) THEN l.metadata_json ELSE '{}' END, '$.periodEnd')) IS NULL
                  OR julianday(json_extract(CASE WHEN json_valid(l.metadata_json) THEN l.metadata_json ELSE '{}' END, '$.periodEnd')) <=
                     julianday(json_extract(CASE WHEN json_valid(l.metadata_json) THEN l.metadata_json ELSE '{}' END, '$.periodStart'))
                  OR julianday(json_extract(CASE WHEN json_valid(l.metadata_json) THEN l.metadata_json ELSE '{}' END, '$.periodEnd')) > julianday(?)))))
        AND NOT EXISTS (SELECT 1 FROM payment_attempts p JOIN invoices i ON i.id = p.invoice_id
          WHERE i.organization_id = s.organization_id AND i.customer_id = s.customer_id
            AND p.status NOT IN ('succeeded', 'failed'))
        AND NOT EXISTS (SELECT 1 FROM payment_request_payments p JOIN payment_requests r ON r.id = p.payment_request_id
          WHERE r.organization_id = s.organization_id AND r.customer_id = s.customer_id
            AND p.status NOT IN ('succeeded', 'failed'))
        AND NOT EXISTS (SELECT 1 FROM easy_pay_direct_payment_executions e JOIN payment_requests r ON r.id = e.payment_request_id
          WHERE r.organization_id = s.organization_id AND r.customer_id = s.customer_id
            AND e.status NOT IN ('succeeded', 'failed'))
        AND NOT EXISTS (SELECT 1 FROM easy_pay_direct_automatic_payment_executions e
          WHERE e.organization_id = s.organization_id AND e.customer_id = s.customer_id
            AND e.status NOT IN ('succeeded', 'failed'))
        AND NOT EXISTS (SELECT 1 FROM payment_request_checkout_intents intent
          WHERE intent.organization_id = s.organization_id AND intent.customer_id = s.customer_id
            AND intent.status NOT IN ('succeeded', 'failed'))
    )`)
    .bind(
      guardId,
      organizationId,
      subscriptionId,
      expected.subscriptionId,
      version,
      expected.externalCustomerId,
      expected.periodEnd,
      now,
      now,
    );
}
