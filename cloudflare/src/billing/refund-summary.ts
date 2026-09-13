import { sha256Hex } from "../auth/api-key";

type Row = {
  payment_id: string;
  invoice_id: string;
  provider: string;
  provider_code: string;
  provider_payment_id: string;
  currency: string;
  payment_amount: number;
  invoice_amount: number;
  invoice_tax: number;
  payment_status: string;
  operation_id: string;
  credit_note_id: string | null;
  operation_invoice_id: string;
  operation_payment_id: string;
  operation_amount: number;
  operation_currency: string;
  refund_id: string | null;
  operation_refund_id: string | null;
  recorded_refund_id: string | null;
  refund_invoice_id: string | null;
  note_invoice_id: string | null;
  refund_amount: number | null;
  refund_currency: string | null;
  refund_status: string | null;
  financial_status: string | null;
  note_total: number | null;
  note_refund: number | null;
  note_tax: number | null;
};

/** One database snapshot, scoped to the exact provider charge, not webhook order.
 * Unallocated or split refunds are explicitly incomplete, never treated as zero.
 */
export async function creditNoteRefundSummary(
  db: D1Database,
  organizationId: string,
  creditNoteId: string,
) {
  const result = await db
    .prepare(`
    SELECT p.id AS payment_id,p.invoice_id,p.provider,p.provider_account_code AS provider_code,
      p.provider_transaction_id AS provider_payment_id,p.currency,p.amount_minor AS payment_amount,
      p.status AS payment_status,i.total_due_minor AS invoice_amount,i.tax_minor AS invoice_tax,
      r.id AS operation_id,r.credit_note_id,r.invoice_id AS operation_invoice_id,
      r.payment_attempt_id AS operation_payment_id,r.amount_minor AS operation_amount,r.currency AS operation_currency,
      c.id AS refund_id,r.provider_refund_id AS operation_refund_id,c.provider_refund_id AS recorded_refund_id,
      c.invoice_id AS refund_invoice_id,n.invoice_id AS note_invoice_id,
      c.amount_minor AS refund_amount,c.currency AS refund_currency,c.status AS refund_status,
      f.refund_status AS financial_status,f.total_amount_minor AS note_total,
      f.refund_amount_minor AS note_refund,f.taxes_amount_minor AS note_tax
    FROM provider_refund_operations target
    JOIN payment_attempts p ON p.organization_id=target.organization_id AND p.id=target.payment_attempt_id
    JOIN invoices i ON i.organization_id=p.organization_id AND i.id=p.invoice_id
    JOIN provider_refund_operations r ON r.organization_id=target.organization_id
      AND r.provider=target.provider AND r.provider_account_code=target.provider_account_code
      AND r.provider_payment_id=target.provider_payment_id AND r.status='succeeded'
    LEFT JOIN credit_note_refunds c ON c.organization_id=r.organization_id AND c.credit_note_id=r.credit_note_id
    LEFT JOIN credit_note_financials f ON f.organization_id=r.organization_id AND f.credit_note_id=r.credit_note_id
    LEFT JOIN credit_notes n ON n.organization_id=r.organization_id AND n.id=r.credit_note_id
    WHERE target.organization_id=? AND target.credit_note_id=? AND target.status='succeeded'
      AND p.provider=target.provider AND p.provider_account_code=target.provider_account_code
      AND p.provider_transaction_id=target.provider_payment_id
    ORDER BY r.id LIMIT 1001`)
    .bind(organizationId, creditNoteId)
    .all<Row>();
  const rows = result.results;
  if (!rows.length) return null;
  const first = rows[0]!;
  const safe = (n: unknown): n is number =>
    typeof n === "number" && Number.isSafeInteger(n) && n >= 0;
  let complete =
    rows.length <= 1000 &&
    first.payment_status === "succeeded" &&
    safe(first.payment_amount) &&
    first.payment_amount > 0 &&
    first.payment_amount === first.invoice_amount &&
    safe(first.invoice_tax);
  let gross = 0,
    net = 0;
  const operations = new Set<string>();
  for (const row of rows) {
    complete =
      complete &&
      !operations.has(row.operation_id) &&
      row.payment_id === first.payment_id &&
      row.operation_payment_id === first.payment_id &&
      row.operation_invoice_id === first.invoice_id &&
      row.operation_currency === first.currency &&
      row.refund_currency === first.currency &&
      row.refund_status === "succeeded" &&
      row.financial_status === "succeeded" &&
      row.credit_note_id !== null &&
      row.refund_id !== null &&
      row.operation_refund_id !== null &&
      row.operation_refund_id === row.recorded_refund_id &&
      row.refund_invoice_id === first.invoice_id &&
      row.note_invoice_id === first.invoice_id &&
      safe(row.operation_amount) &&
      row.operation_amount > 0 &&
      row.operation_amount === row.refund_amount &&
      row.operation_amount === row.note_refund &&
      row.note_refund === row.note_total &&
      safe(row.note_tax) &&
      row.note_tax <= row.operation_amount;
    operations.add(row.operation_id);
    gross += row.operation_amount;
    net += row.operation_amount - (row.note_tax ?? 0);
  }
  const originalNet = first.invoice_amount - first.invoice_tax;
  complete =
    complete &&
    safe(originalNet) &&
    safe(gross) &&
    safe(net) &&
    gross <= first.payment_amount &&
    net <= originalNet;
  return {
    allocation_complete: complete,
    invoice_id: first.invoice_id,
    payment_id: first.payment_id,
    provider: first.provider,
    provider_code: first.provider_code,
    provider_payment_id: first.provider_payment_id,
    currency: first.currency,
    payment_amount_cents: first.payment_amount,
    original_net_amount_cents: originalNet,
    refunded_amount_cents: gross,
    refunded_net_amount_cents: net,
    successful_refund_count: operations.size,
    revision: await sha256Hex(JSON.stringify(rows)),
  };
}
