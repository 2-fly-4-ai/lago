import { paymentRows } from "../api/payment-ledger";

// This is a ledger report, not processor settlement or bank-payout accounting.
// Never infer collection from an invoice status/value or mix currencies.
export async function recordedPayments(
  database: D1Database,
  organizationId: string,
  from: string,
  to: string,
  customerId: string | null,
) {
  const result = await database
    .prepare(`WITH payments AS (${paymentRows()}),
    entries AS (
      SELECT currency, amount_minor AS paid_minor, 0 AS refunded_minor, 1 AS payment_count,
        0 AS refund_count FROM payments
      WHERE organization_id = ? AND status = 'succeeded'
        AND date(created_at) BETWEEN date(?) AND date(?)
        AND (? IS NULL OR customer_id = ?)
      UNION ALL
      SELECT refund.currency, 0, refund.amount_minor, 0, 1
      FROM credit_note_refunds refund JOIN invoices invoice ON invoice.id = refund.invoice_id
        AND invoice.organization_id = refund.organization_id
      WHERE refund.organization_id = ? AND refund.status = 'succeeded'
        AND date(refund.updated_at) BETWEEN date(?) AND date(?)
        AND (? IS NULL OR invoice.customer_id = ?)
      UNION ALL
      SELECT operation.currency, 0, operation.amount_minor, 0, 1
      FROM provider_refund_operations operation JOIN invoices invoice ON invoice.id = operation.invoice_id
        AND invoice.organization_id = operation.organization_id
      WHERE operation.organization_id = ? AND operation.status = 'succeeded'
        AND date(operation.updated_at) BETWEEN date(?) AND date(?)
        AND (? IS NULL OR invoice.customer_id = ?)
        AND NOT EXISTS (SELECT 1 FROM credit_note_refunds refund
          WHERE refund.organization_id = operation.organization_id
            AND refund.credit_note_id = operation.credit_note_id
            AND refund.status = 'succeeded')
    ) SELECT currency, SUM(paid_minor) AS paid_minor, SUM(refunded_minor) AS refunded_minor,
      SUM(paid_minor) - SUM(refunded_minor) AS net_minor,
      SUM(payment_count) AS payment_count, SUM(refund_count) AS refund_count
    FROM entries GROUP BY currency ORDER BY currency`)
    .bind(
      organizationId,
      from,
      to,
      customerId,
      customerId,
      organizationId,
      from,
      to,
      customerId,
      customerId,
      organizationId,
      from,
      to,
      customerId,
      customerId,
    )
    .all<{
      currency: string;
      paid_minor: number;
      refunded_minor: number;
      net_minor: number;
      payment_count: number;
      refund_count: number;
    }>();
  return {
    basis: "succeeded_payment_ledger",
    timezone: "UTC",
    payment_date_basis: "payment_record_created_at",
    refund_date_basis: "succeeded_refund_record_updated_at",
    settlement_verified: false,
    includes_internal_purchases: true,
    currencies: result.results,
  };
}
