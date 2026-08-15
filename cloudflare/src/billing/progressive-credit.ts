import { sha256Hex } from "../auth/api-key";
import type { DomainEvent } from "../domain-events";
import { deterministicUuid } from "../identifiers";
import { stableJson } from "../json";
import type { SubscriptionInvoiceLine } from "./subscription-invoice-calculation";

export type ProgressiveCredit = {
  invoiceId: string;
  grossUsageMinor: number;
  availableCreditMinor: number;
  appliedCreditMinor: number;
  excessCreditMinor: number;
};

export type PreparedProgressiveCreditNote = {
  creditNoteId: string;
  amountMinor: number;
  event: DomainEvent;
  statements: D1PreparedStatement[];
};

export async function progressiveCreditForLines(
  database: D1Database,
  subscriptionId: string,
  periodStart: string,
  periodEnd: string,
  lines: SubscriptionInvoiceLine[],
): Promise<ProgressiveCredit | null> {
  const latest = await database
    .prepare(
      `SELECT marker.invoice_id, marker.gross_usage_amount_minor,
              invoice.coupons_minor, invoice.credit_notes_minor
       FROM progressive_billing_invoices marker
       JOIN invoices invoice ON invoice.id = marker.invoice_id
       WHERE marker.subscription_id = ? AND marker.period_start = ? AND marker.period_end = ?
         AND invoice.status IN ('finalized', 'failed')
       ORDER BY marker.created_at DESC, marker.invoice_id DESC LIMIT 1`,
    )
    .bind(subscriptionId, periodStart, periodEnd)
    .first<{
      invoice_id: string;
      gross_usage_amount_minor: number;
      coupons_minor: number;
      credit_notes_minor: number;
    }>();
  if (!latest) return null;

  const priorSources = await database
    .prepare(
      `SELECT source_id FROM invoice_lines
       WHERE invoice_id = ? AND line_type = 'usage' ORDER BY source_id`,
    )
    .bind(latest.invoice_id)
    .all<{ source_id: string }>();
  const sourceIds = new Set(priorSources.results.map((row) => row.source_id));
  const eligibleGrossMinor = lines
    .filter((line) => sourceIds.has(line.persistenceSourceId ?? line.sourceId))
    .reduce((sum, line) => safeAdd(sum, line.rounded), 0);
  const availableCreditMinor = Math.max(
    latest.gross_usage_amount_minor - latest.coupons_minor - latest.credit_notes_minor,
    0,
  );
  const appliedCreditMinor = Math.min(availableCreditMinor, eligibleGrossMinor);
  return {
    invoiceId: latest.invoice_id,
    grossUsageMinor: latest.gross_usage_amount_minor,
    availableCreditMinor,
    appliedCreditMinor,
    excessCreditMinor: availableCreditMinor - appliedCreditMinor,
  };
}

export async function prepareProgressiveCreditNote(
  database: D1Database,
  input: {
    organizationId: string;
    sourceInvoiceId: string;
    amountMinor: number;
    correctionInvoiceId: string;
    createdAt: string;
    correlationId: string;
    targetInvoiceGuard?: { version: number; status: "finalized" };
  },
): Promise<PreparedProgressiveCreditNote | null> {
  if (input.amountMinor === 0) return null;
  if (!Number.isSafeInteger(input.amountMinor) || input.amountMinor < 0) {
    throw new Error("invalid_progressive_credit_note_amount");
  }
  const source = await database
    .prepare(
      `SELECT id, organization_id, customer_id, number, currency
       FROM invoices WHERE id = ? AND organization_id = ? AND status IN ('finalized', 'failed')`,
    )
    .bind(input.sourceInvoiceId, input.organizationId)
    .first<{
      id: string;
      organization_id: string;
      customer_id: string;
      number: string;
      currency: string;
    }>();
  if (!source) throw new Error("progressive_credit_invoice_not_found");
  const sourceLines = await database
    .prepare(
      `SELECT line.id, line.amount_minor - COALESCE(SUM(
                CASE WHEN note.credit_status <> 'voided' THEN item.amount_minor ELSE 0 END
              ), 0) AS remaining_minor
       FROM invoice_lines line
       LEFT JOIN credit_note_items item ON item.invoice_line_id = line.id
       LEFT JOIN credit_notes note ON note.id = item.credit_note_id
       WHERE line.invoice_id = ? AND line.line_type = 'usage'
       GROUP BY line.id, line.amount_minor
       HAVING remaining_minor > 0
       ORDER BY line.id`,
    )
    .bind(source.id)
    .all<{ id: string; remaining_minor: number }>();
  let remaining = input.amountMinor;
  const itemAmounts: Array<{ lineId: string; amountMinor: number }> = [];
  for (const line of sourceLines.results) {
    if (remaining === 0) break;
    const amountMinor = Math.min(remaining, line.remaining_minor);
    if (amountMinor > 0) itemAmounts.push({ lineId: line.id, amountMinor });
    remaining -= amountMinor;
  }
  if (remaining !== 0) throw new Error("progressive_credit_note_line_amount_exceeded");

  const creditNoteId = await deterministicUuid(
    "progressive-billing-credit-note",
    input.correctionInvoiceId,
  );
  const idempotencyKey = `progressive-correction:${input.correctionInvoiceId}`;
  const requestHash = await sha256Hex(
    stableJson({
      amountMinor: input.amountMinor,
      correctionInvoiceId: input.correctionInvoiceId,
      sourceInvoiceId: source.id,
    }),
  );
  const event: DomainEvent = {
    id: `credit-note-created:${creditNoteId}:v1`,
    type: "credit_note.created",
    version: 1,
    aggregateType: "credit_note",
    aggregateId: creditNoteId,
    aggregateVersion: 1,
    occurredAt: input.createdAt,
    causationId: input.correctionInvoiceId,
    correlationId: input.correlationId,
    payload: {
      organizationId: source.organization_id,
      invoiceId: source.id,
      correctionInvoiceId: input.correctionInvoiceId,
      creditNoteId,
      reason: "other",
      totalAmountMinor: input.amountMinor,
      progressiveBillingCorrection: true,
    },
  };
  const statements: D1PreparedStatement[] = [
    database
      .prepare(
        `INSERT INTO credit_notes
         (id, organization_id, customer_id, invoice_id, sequential_id, number, status,
          credit_status, reason, description, currency, total_amount_minor, credit_amount_minor,
          balance_amount_minor, version, idempotency_key, request_sha256, issuing_date, created_at,
          updated_at, allocation_state)
         SELECT ?, ?, ?, source.id, sequence.next_id,
                COALESCE(source.number, source.id) || '-CN' || printf('%03d', sequence.next_id),
                'finalized', 'available', 'other', 'Progressive billing usage correction', ?,
                ?, ?, ?, 1, ?, ?, ?, ?, ?, 'finalized'
         FROM invoices source
         CROSS JOIN (
           SELECT COALESCE(MAX(sequential_id), 0) + 1 AS next_id
           FROM credit_notes WHERE invoice_id = ?
         ) sequence
         WHERE source.id = ? AND source.organization_id = ?
           AND source.status IN ('finalized', 'failed')
           AND (? IS NULL OR EXISTS (
             SELECT 1 FROM invoices target
             WHERE target.id = ? AND target.organization_id = ?
               AND target.version = ? AND target.status = ?
           ))`,
      )
      .bind(
        creditNoteId,
        source.organization_id,
        source.customer_id,
        source.currency,
        input.amountMinor,
        input.amountMinor,
        input.amountMinor,
        idempotencyKey,
        requestHash,
        input.createdAt.slice(0, 10),
        input.createdAt,
        input.createdAt,
        source.id,
        source.id,
        source.organization_id,
        input.targetInvoiceGuard ? input.correctionInvoiceId : null,
        input.correctionInvoiceId,
        source.organization_id,
        input.targetInvoiceGuard?.version ?? null,
        input.targetInvoiceGuard?.status ?? null,
      ),
    ...(await Promise.all(
      itemAmounts.map(async (item) =>
        database
          .prepare(
            `INSERT INTO credit_note_items
             (id, organization_id, credit_note_id, invoice_line_id, amount_minor,
              precise_amount_minor, currency, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .bind(
            await deterministicUuid(
              "progressive-billing-credit-note-item",
              `${creditNoteId}:${item.lineId}`,
            ),
            source.organization_id,
            creditNoteId,
            item.lineId,
            item.amountMinor,
            String(item.amountMinor),
            source.currency,
            input.createdAt,
          ),
      ),
    )),
  ];
  return { creditNoteId, amountMinor: input.amountMinor, event, statements };
}

function safeAdd(left: number, right: number): number {
  const total = left + right;
  if (!Number.isSafeInteger(total) || total < 0) throw new Error("invalid_progressive_credit");
  return total;
}
