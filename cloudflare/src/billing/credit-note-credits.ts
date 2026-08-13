import { deterministicUuid } from "../identifiers";
import { stableJson } from "../json";

type CreditNoteBalanceRow = {
  id: string;
  balance_amount_minor: number;
  version: number;
};

export type CreditNoteAllocation = {
  creditNoteId: string;
  creditNoteVersion: number;
  amountMinor: number;
  applicationId: string;
  consumed: boolean;
};

export async function calculateCreditNoteAllocations(
  database: D1Database,
  organizationId: string,
  customerId: string,
  invoiceId: string,
  currency: string,
  amountDueMinor: number,
): Promise<CreditNoteAllocation[]> {
  const notes = await database
    .prepare(
      `SELECT id, balance_amount_minor, version FROM credit_notes
       WHERE organization_id = ? AND customer_id = ? AND currency = ?
         AND status = 'finalized' AND credit_status = 'available'
         AND balance_amount_minor > 0
       ORDER BY created_at, id`,
    )
    .bind(organizationId, customerId, currency)
    .all<CreditNoteBalanceRow>();
  const allocations: CreditNoteAllocation[] = [];
  let remaining = amountDueMinor;
  for (const note of notes.results) {
    if (remaining <= 0) break;
    const amountMinor = Math.min(remaining, note.balance_amount_minor);
    allocations.push({
      creditNoteId: note.id,
      creditNoteVersion: note.version,
      amountMinor,
      applicationId: await deterministicUuid("credit-note-application", `${invoiceId}:${note.id}`),
      consumed: amountMinor === note.balance_amount_minor,
    });
    remaining -= amountMinor;
  }
  return allocations;
}

export function creditNoteAllocationStatements(
  database: D1Database,
  organizationId: string,
  invoiceId: string,
  allocation: CreditNoteAllocation,
  now: string,
  correlationId: string,
): D1PreparedStatement[] {
  const nextVersion = allocation.creditNoteVersion + 1;
  const eventId = `credit-note-applied:${allocation.applicationId}:v1`;
  return [
    database
      .prepare(
        `INSERT INTO credit_note_applications
         (id, organization_id, credit_note_id, invoice_id, credit_note_version,
          amount_minor, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        allocation.applicationId,
        organizationId,
        allocation.creditNoteId,
        invoiceId,
        allocation.creditNoteVersion,
        allocation.amountMinor,
        now,
      ),
    database
      .prepare(
        `UPDATE credit_notes SET balance_amount_minor = balance_amount_minor - ?,
         credit_status = CASE WHEN balance_amount_minor - ? = 0 THEN 'consumed' ELSE 'available' END,
         version = version + 1, updated_at = ?
         WHERE id = ? AND organization_id = ? AND credit_status = 'available'
           AND version = ? AND balance_amount_minor >= ?`,
      )
      .bind(
        allocation.amountMinor,
        allocation.amountMinor,
        now,
        allocation.creditNoteId,
        organizationId,
        allocation.creditNoteVersion,
        allocation.amountMinor,
      ),
    database
      .prepare(
        `INSERT INTO outbox_events
         (event_id, organization_id, event_type, event_version, aggregate_type,
          aggregate_id, aggregate_version, causation_id, correlation_id, payload_json,
          occurred_at, published_at)
         VALUES (?, ?, 'credit_note.applied', 1, 'credit_note', ?, ?, ?, ?, ?, ?, NULL)`,
      )
      .bind(
        eventId,
        organizationId,
        allocation.creditNoteId,
        nextVersion,
        invoiceId,
        correlationId,
        stableJson({
          organizationId,
          creditNoteId: allocation.creditNoteId,
          invoiceId,
          applicationId: allocation.applicationId,
          amountMinor: allocation.amountMinor,
        }),
        now,
      ),
  ];
}

export async function creditNoteRecreditStatements(
  database: D1Database,
  organizationId: string,
  invoiceId: string,
  now: string,
  correlationId: string,
): Promise<D1PreparedStatement[]> {
  const applications = await database
    .prepare(
      `SELECT cna.id, cna.credit_note_id, cna.amount_minor, cn.version
       FROM credit_note_applications cna JOIN credit_notes cn ON cn.id = cna.credit_note_id
       WHERE cna.organization_id = ? AND cna.invoice_id = ?
         AND NOT EXISTS (SELECT 1 FROM credit_note_recredits cnr WHERE cnr.application_id = cna.id)
       ORDER BY cna.created_at, cna.id`,
    )
    .bind(organizationId, invoiceId)
    .all<{ id: string; credit_note_id: string; amount_minor: number; version: number }>();
  const statements: D1PreparedStatement[] = [];
  for (const application of applications.results) {
    const nextVersion = application.version + 1;
    statements.push(
      database
        .prepare(
          `INSERT INTO credit_note_recredits
           (id, organization_id, application_id, credit_note_id, voided_invoice_id,
            credit_note_version, amount_minor, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          await deterministicUuid("credit-note-recredit", application.id),
          organizationId,
          application.id,
          application.credit_note_id,
          invoiceId,
          application.version,
          application.amount_minor,
          now,
        ),
      database
        .prepare(
          `UPDATE credit_notes SET balance_amount_minor = balance_amount_minor + ?,
           credit_status = 'available', version = version + 1, updated_at = ?
           WHERE id = ? AND organization_id = ? AND version = ? AND credit_status <> 'voided'`,
        )
        .bind(
          application.amount_minor,
          now,
          application.credit_note_id,
          organizationId,
          application.version,
        ),
      database
        .prepare(
          `INSERT INTO outbox_events
           (event_id, organization_id, event_type, event_version, aggregate_type,
            aggregate_id, aggregate_version, causation_id, correlation_id, payload_json,
            occurred_at, published_at)
           VALUES (?, ?, 'credit_note.recredited', 1, 'credit_note', ?, ?, ?, ?, ?, ?, NULL)`,
        )
        .bind(
          `credit-note-recredited:${application.id}:v1`,
          organizationId,
          application.credit_note_id,
          nextVersion,
          invoiceId,
          correlationId,
          stableJson({
            organizationId,
            creditNoteId: application.credit_note_id,
            voidedInvoiceId: invoiceId,
            applicationId: application.id,
            amountMinor: application.amount_minor,
          }),
          now,
        ),
    );
  }
  return statements;
}
