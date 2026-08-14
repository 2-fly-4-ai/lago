import { sha256Hex } from "../auth/api-key";
import type { DomainEvent } from "../domain-events";
import { deterministicUuid } from "../identifiers";
import { stableJson } from "../json";
import { Decimal } from "../rating/decimal";
import { terminationBillingWindowUtc } from "./subscription-invoice-calculation";

type CreditSource = {
  organization_id: string;
  customer_id: string;
  external_id: string;
  version: number;
  current_period_start: string;
  current_period_end: string;
  invoice_id: string;
  invoice_number: string | null;
  currency: string;
  line_id: string;
  line_amount_minor: number;
  line_precise_amount_minor: string | null;
  credited_minor: number;
};

export type PayInAdvanceTerminationResult = {
  terminatedAt: string;
  creditNoteId: string | null;
  creditAmountMinor: number;
  subscriptionEvent: DomainEvent;
  creditNoteEvent: DomainEvent | null;
};

export type PreparedPayInAdvanceTerminationCredit = {
  organizationId: string;
  customerId: string;
  externalId: string;
  sourceInvoiceId: string;
  sourceLineId: string;
  currency: string;
  creditNoteId: string | null;
  creditAmountMinor: number;
  preciseCredit: string;
  unusedDays: number;
  fullPeriodDays: number;
  creditNoteEvent: DomainEvent | null;
  creationStatements: D1PreparedStatement[];
};

export async function preparePayInAdvanceTerminationCredit(
  database: D1Database,
  subscriptionId: string,
  expectedVersion: number,
  terminatedAt: string,
  correlationId: string,
): Promise<PreparedPayInAdvanceTerminationCredit> {
  const source = await findCreditSource(database, subscriptionId, expectedVersion);
  if (!source) throw new Error("unsupported_pay_in_advance_termination_credit");
  const window = terminationBillingWindowUtc(
    source.current_period_start,
    source.current_period_end,
    terminatedAt,
  );
  const unusedDays = window.fullPeriodDays - window.billableDays;
  const preciseCredit = Decimal.parse(source.line_precise_amount_minor ?? source.line_amount_minor)
    .multiply(Decimal.parse(unusedDays))
    .divideByInteger(BigInt(window.fullPeriodDays));
  const rounded = Number(preciseCredit.round());
  if (!Number.isSafeInteger(rounded) || rounded < 0) {
    throw new Error("invalid_termination_credit_amount");
  }
  const remainingLine = source.line_amount_minor - source.credited_minor;
  if (!Number.isSafeInteger(remainingLine) || remainingLine < 0) {
    throw new Error("credit_note_line_balance_corrupt");
  }
  const creditAmountMinor = Math.min(rounded, remainingLine);
  const aggregateVersion = expectedVersion + 1;
  const creditNoteId =
    creditAmountMinor > 0
      ? await deterministicUuid(
          "subscription-termination-credit-note",
          `${subscriptionId}:v${aggregateVersion}:${source.invoice_id}`,
        )
      : null;
  const itemId = creditNoteId
    ? await deterministicUuid("subscription-termination-credit-note-item", creditNoteId)
    : null;
  const idempotencyKey = `subscription-termination:${subscriptionId}:v${aggregateVersion}`;
  const requestHash = await sha256Hex(
    stableJson({
      creditAmountMinor,
      invoiceId: source.invoice_id,
      lineId: source.line_id,
      subscriptionId,
      terminatedAt,
    }),
  );
  const creditNoteEvent: DomainEvent | null = creditNoteId
    ? {
        id: `credit-note-created:${creditNoteId}:v1`,
        type: "credit_note.created",
        version: 1,
        aggregateType: "credit_note",
        aggregateId: creditNoteId,
        aggregateVersion: 1,
        occurredAt: terminatedAt,
        causationId: correlationId,
        correlationId,
        payload: {
          organizationId: source.organization_id,
          subscriptionId,
          invoiceId: source.invoice_id,
          creditNoteId,
          reason: "order_cancellation",
          totalAmountMinor: creditAmountMinor,
          unusedDays,
          fullPeriodDays: window.fullPeriodDays,
        },
      }
    : null;
  const creationStatements: D1PreparedStatement[] = [];
  if (creditNoteId && itemId) {
    creationStatements.push(
      database
        .prepare(
          `INSERT INTO credit_notes
           (id, organization_id, customer_id, invoice_id, sequential_id, number, status,
            credit_status, reason, description, currency, total_amount_minor, credit_amount_minor,
            balance_amount_minor, version, idempotency_key, request_sha256, issuing_date, created_at,
            updated_at)
           SELECT ?, ?, ?, i.id, sequence.next_id,
                  COALESCE(i.number, i.id) || '-CN' || printf('%03d', sequence.next_id),
                  'finalized', 'available', 'order_cancellation', NULL, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?
           FROM invoices i
           CROSS JOIN (
             SELECT COALESCE(MAX(sequential_id), 0) + 1 AS next_id
             FROM credit_notes WHERE invoice_id = ?
           ) sequence
           JOIN subscriptions s ON s.id = i.subscription_id
           WHERE i.id = ? AND i.status = 'finalized' AND s.id = ?
             AND s.organization_id = ? AND s.version = ? AND s.status IN ('active', 'past_due')`,
        )
        .bind(
          creditNoteId,
          source.organization_id,
          source.customer_id,
          source.currency,
          creditAmountMinor,
          creditAmountMinor,
          creditAmountMinor,
          idempotencyKey,
          requestHash,
          terminatedAt.slice(0, 10),
          terminatedAt,
          terminatedAt,
          source.invoice_id,
          source.invoice_id,
          subscriptionId,
          source.organization_id,
          expectedVersion,
        ),
      database
        .prepare(
          `INSERT INTO credit_note_items
           (id, organization_id, credit_note_id, invoice_line_id, amount_minor,
            precise_amount_minor, currency, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          itemId,
          source.organization_id,
          creditNoteId,
          source.line_id,
          creditAmountMinor,
          preciseCredit.toString(),
          source.currency,
          terminatedAt,
        ),
    );
  }
  return {
    organizationId: source.organization_id,
    customerId: source.customer_id,
    externalId: source.external_id,
    sourceInvoiceId: source.invoice_id,
    sourceLineId: source.line_id,
    currency: source.currency,
    creditNoteId,
    creditAmountMinor,
    preciseCredit: preciseCredit.toString(),
    unusedDays,
    fullPeriodDays: window.fullPeriodDays,
    creditNoteEvent,
    creationStatements,
  };
}

export async function terminatePayInAdvanceWithCredit(
  env: Env,
  subscriptionId: string,
  expectedVersion: number,
  terminatedAt: string,
  correlationId: string,
): Promise<PayInAdvanceTerminationResult> {
  const prepared = await preparePayInAdvanceTerminationCredit(
    env.BILLING_DB,
    subscriptionId,
    expectedVersion,
    terminatedAt,
    correlationId,
  );
  const now = terminatedAt;
  const aggregateVersion = expectedVersion + 1;
  const { creditNoteId, creditAmountMinor, creditNoteEvent } = prepared;
  const subscriptionEvent: DomainEvent = {
    id: `subscription-terminated:${subscriptionId}:v${aggregateVersion}`,
    type: "subscription.terminated",
    version: 1,
    aggregateType: "subscription",
    aggregateId: subscriptionId,
    aggregateVersion,
    occurredAt: now,
    causationId: correlationId,
    correlationId,
    payload: {
      organizationId: prepared.organizationId,
      subscriptionId,
      externalSubscriptionId: prepared.externalId,
      terminatedAt,
      finalInvoiceGenerated: false,
      creditNoteGenerated: creditNoteId !== null,
      creditNoteId,
      creditAmountMinor,
    },
  };
  const statements: D1PreparedStatement[] = [
    ...prepared.creationStatements,
    env.BILLING_DB.prepare(
      `UPDATE subscriptions
       SET status = 'terminated', terminated_at = ?, current_period_end = ?,
           version = version + 1, updated_at = ?
       WHERE id = ? AND organization_id = ? AND version = ?
         AND status IN ('active', 'past_due')`,
    ).bind(
      terminatedAt,
      terminatedAt,
      now,
      subscriptionId,
      prepared.organizationId,
      expectedVersion,
    ),
  ];
  if (creditNoteEvent) {
    statements.push(outboxStatement(env.BILLING_DB, prepared.organizationId, creditNoteEvent));
  }
  statements.push(outboxStatement(env.BILLING_DB, prepared.organizationId, subscriptionEvent));
  let results: D1Result<unknown>[];
  try {
    results = await env.BILLING_DB.batch(statements);
  } catch (error) {
    const current = await env.BILLING_DB.prepare(
      "SELECT version, status FROM subscriptions WHERE id = ? AND organization_id = ?",
    )
      .bind(subscriptionId, prepared.organizationId)
      .first<{ version: number; status: string }>();
    if (!current || current.version !== expectedVersion || current.status === "terminated") {
      throw new Error("subscription_version_conflict");
    }
    throw error;
  }
  const subscriptionUpdateIndex = prepared.creationStatements.length;
  if (results[subscriptionUpdateIndex]?.meta.changes !== 1) {
    throw new Error("subscription_version_conflict");
  }
  if (creditNoteEvent) await env.DOMAIN_EVENTS.send(creditNoteEvent);
  await env.DOMAIN_EVENTS.send(subscriptionEvent);
  return {
    terminatedAt,
    creditNoteId,
    creditAmountMinor,
    subscriptionEvent,
    creditNoteEvent,
  };
}

async function findCreditSource(
  database: D1Database,
  subscriptionId: string,
  expectedVersion: number,
): Promise<CreditSource | null> {
  return database
    .prepare(
      `SELECT s.organization_id, s.customer_id, s.external_id, s.version,
              s.current_period_start, s.current_period_end,
              i.id AS invoice_id, i.number AS invoice_number, i.currency,
              il.id AS line_id, il.amount_minor AS line_amount_minor,
              il.precise_amount_minor AS line_precise_amount_minor,
              COALESCE((SELECT SUM(cni.amount_minor) FROM credit_note_items cni
                        JOIN credit_notes cn ON cn.id = cni.credit_note_id
                        WHERE cni.invoice_line_id = il.id AND cn.credit_status <> 'voided'), 0)
                AS credited_minor
       FROM subscriptions s
       JOIN plans p ON p.id = s.plan_id
       JOIN invoices i ON i.subscription_id = s.id
       JOIN invoice_lines il ON il.invoice_id = i.id AND il.line_type = 'subscription'
       LEFT JOIN subscription_invoice_contexts sic ON sic.invoice_id = i.id
       WHERE s.id = ? AND s.version = ? AND s.status IN ('active', 'past_due')
         AND p.pay_in_advance = 1 AND i.status = 'finalized'
         AND i.coupons_minor = 0 AND i.tax_minor = 0 AND i.prepaid_credit_minor = 0
         AND i.credit_notes_minor = 0
         AND (
           (sic.context_type = 'initial' AND sic.period_start = s.current_period_start
             AND sic.period_end = s.current_period_end)
           OR
           (json_extract(il.metadata_json, '$.periodStart') = s.current_period_start
             AND json_extract(il.metadata_json, '$.periodEnd') = s.current_period_end)
         )
       ORDER BY i.created_at DESC, i.id DESC LIMIT 1`,
    )
    .bind(subscriptionId, expectedVersion)
    .first<CreditSource>();
}

function outboxStatement(
  database: D1Database,
  organizationId: string,
  event: DomainEvent,
): D1PreparedStatement {
  return database
    .prepare(
      `INSERT INTO outbox_events
       (event_id, organization_id, event_type, event_version, aggregate_type,
        aggregate_id, aggregate_version, causation_id, correlation_id, payload_json,
        occurred_at, published_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
    )
    .bind(
      event.id,
      organizationId,
      event.type,
      event.version,
      event.aggregateType,
      event.aggregateId,
      event.aggregateVersion,
      event.causationId,
      event.correlationId,
      stableJson(event.payload),
      event.occurredAt,
    );
}
