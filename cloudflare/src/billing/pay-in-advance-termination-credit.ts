import { sha256Hex } from "../auth/api-key";
import type { DomainEvent } from "../domain-events";

type PayInAdvanceTerminationEnv = Pick<Env, "BILLING_DB" | "DOMAIN_EVENTS">;
import { deterministicUuid } from "../identifiers";
import { stableJson } from "../json";
import { Decimal } from "../rating/decimal";
import { terminationBillingWindowUtc } from "./subscription-invoice-calculation";
import type {
  SubscriptionInvoiceCalculation,
  SubscriptionInvoiceLine,
} from "./subscription-invoice-calculation";
import type { TerminationActions } from "./terminate-subscription";

type CreditSource = {
  organization_id: string;
  customer_id: string;
  external_id: string;
  version: number;
  current_period_start: string;
  current_period_end: string;
  invoice_id: string;
  invoice_number: string | null;
  invoice_status: "draft" | "finalized";
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
  allocationState: "draft" | "finalized";
};

type DraftTerminationCreditRow = {
  id: string;
  organization_id: string;
  subscription_id: string;
  source_invoice_id: string;
  item_id: string;
  item_created_at: string;
  line_source_id: string;
  currency: string;
  version: number;
  unused_days: number;
  full_period_days: number;
  correlation_id: string;
  other_credited_minor: number;
};

export type DraftTerminationCreditChanges = {
  beforeLineReplacement: D1PreparedStatement[];
  afterLineReplacement: D1PreparedStatement[];
  eventStatements: D1PreparedStatement[];
  events: DomainEvent[];
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
  const allocationState = source.invoice_status === "draft" ? "draft" : "finalized";
  const creditNoteEvent: DomainEvent | null =
    creditNoteId && allocationState === "finalized"
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
            updated_at, allocation_state)
           SELECT ?, ?, ?, i.id, sequence.next_id,
                  COALESCE(i.number, i.id) || '-CN' || printf('%03d', sequence.next_id),
                  'finalized', 'available', 'order_cancellation', NULL, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?
           FROM invoices i
           CROSS JOIN (
             SELECT COALESCE(MAX(sequential_id), 0) + 1 AS next_id
             FROM credit_notes WHERE invoice_id = ?
           ) sequence
           JOIN subscriptions s ON s.id = ?
           WHERE i.id = ? AND i.status IN ('draft', 'finalized')
             AND (i.subscription_id = s.id OR EXISTS (
               SELECT 1 FROM invoice_subscriptions ins
               WHERE ins.invoice_id = i.id AND ins.subscription_id = s.id
             ))
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
          allocationState,
          source.invoice_id,
          subscriptionId,
          source.invoice_id,
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
    if (allocationState === "draft") {
      creationStatements.push(
        database
          .prepare(
            `INSERT INTO termination_credit_note_contexts
             (credit_note_id, organization_id, subscription_id, source_invoice_id,
              unused_days, full_period_days, correlation_id, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .bind(
            creditNoteId,
            source.organization_id,
            subscriptionId,
            source.invoice_id,
            unusedDays,
            window.fullPeriodDays,
            correlationId,
            terminatedAt,
          ),
      );
    }
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
    allocationState,
  };
}

export async function prepareDraftTerminationCreditChanges(
  database: D1Database,
  sourceInvoiceId: string,
  calculation: SubscriptionInvoiceCalculation,
  changedAt: string,
  causationId: string,
  finalize: boolean,
): Promise<DraftTerminationCreditChanges> {
  const rows = await database
    .prepare(
      `SELECT cn.id, cn.organization_id, tc.subscription_id, tc.source_invoice_id,
              cni.id AS item_id, cni.created_at AS item_created_at,
              source_line.source_id AS line_source_id, cn.currency, cn.version,
              tc.unused_days, tc.full_period_days, tc.correlation_id,
              COALESCE((
                SELECT SUM(other_item.amount_minor)
                FROM credit_note_items other_item
                JOIN credit_notes other_note ON other_note.id = other_item.credit_note_id
                WHERE other_item.invoice_line_id = cni.invoice_line_id
                  AND other_note.id <> cn.id AND other_note.credit_status <> 'voided'
              ), 0) AS other_credited_minor
       FROM termination_credit_note_contexts tc
       JOIN credit_notes cn ON cn.id = tc.credit_note_id
       JOIN credit_note_items cni ON cni.credit_note_id = cn.id
       JOIN invoice_lines source_line ON source_line.id = cni.invoice_line_id
       WHERE tc.source_invoice_id = ? AND cn.allocation_state = 'draft'
       ORDER BY cn.created_at, cn.id`,
    )
    .bind(sourceInvoiceId)
    .all<DraftTerminationCreditRow>();
  if (rows.results.length === 0) {
    return {
      beforeLineReplacement: [],
      afterLineReplacement: [],
      eventStatements: [],
      events: [],
    };
  }
  if (
    calculation.couponsMinor !== 0 ||
    calculation.taxMinor !== 0 ||
    calculation.prepaidCreditMinor !== 0
  ) {
    throw new Error("unsupported_draft_termination_credit_adjustment");
  }
  const beforeLineReplacement: D1PreparedStatement[] = [];
  const afterLineReplacement: D1PreparedStatement[] = [];
  const eventStatements: D1PreparedStatement[] = [];
  const events: DomainEvent[] = [];
  for (const row of rows.results) {
    const sourceLine = requireSubscriptionLine(calculation.lines, row.line_source_id);
    const precise = Decimal.parse(sourceLine.precise)
      .multiply(Decimal.parse(row.unused_days))
      .divideByInteger(BigInt(row.full_period_days));
    const availableMinor = sourceLine.rounded - row.other_credited_minor;
    const rounded = Math.min(Number(precise.round()), availableMinor);
    if (!Number.isSafeInteger(rounded) || rounded <= 0) {
      throw new Error("invalid_termination_credit_amount");
    }
    beforeLineReplacement.push(
      database
        .prepare("DELETE FROM credit_note_items WHERE id = ? AND credit_note_id = ?")
        .bind(row.item_id, row.id),
    );
    afterLineReplacement.push(
      database
        .prepare(
          `INSERT INTO credit_note_items
           (id, organization_id, credit_note_id, invoice_line_id, amount_minor,
            precise_amount_minor, currency, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          row.item_id,
          row.organization_id,
          row.id,
          sourceLine.id,
          rounded,
          precise.toString(),
          row.currency,
          row.item_created_at,
        ),
      database
        .prepare(
          `UPDATE credit_notes
           SET total_amount_minor = ?, credit_amount_minor = ?, balance_amount_minor = ?,
               allocation_state = ?, updated_at = ?
           WHERE id = ? AND organization_id = ? AND version = ? AND allocation_state = 'draft'`,
        )
        .bind(
          rounded,
          rounded,
          rounded,
          finalize ? "finalized" : "draft",
          changedAt,
          row.id,
          row.organization_id,
          row.version,
        ),
    );
    if (finalize) {
      const event = terminationCreditNoteEvent(
        row.id,
        row.organization_id,
        row.subscription_id,
        row.source_invoice_id,
        rounded,
        row.unused_days,
        row.full_period_days,
        changedAt,
        causationId,
        row.correlation_id,
      );
      events.push(event);
      eventStatements.push(outboxStatement(database, row.organization_id, event));
    }
  }
  return { beforeLineReplacement, afterLineReplacement, eventStatements, events };
}

export async function terminatePayInAdvanceWithCredit(
  env: PayInAdvanceTerminationEnv,
  subscriptionId: string,
  expectedVersion: number,
  terminatedAt: string,
  correlationId: string,
  actions: TerminationActions = { creditNote: "credit", invoice: "skip" },
  publishImmediately = true,
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
      onTerminationCreditNote: actions.creditNote,
      onTerminationInvoice: actions.invoice,
    },
  };
  const statements: D1PreparedStatement[] = [
    ...prepared.creationStatements,
    env.BILLING_DB.prepare(
      `UPDATE subscriptions
       SET status = 'canceled', canceled_at = ?, version = version + 1, updated_at = ?
       WHERE previous_subscription_id = ? AND status = 'pending'
         AND EXISTS (
           SELECT 1 FROM subscriptions current
           WHERE current.id = ? AND current.organization_id = ? AND current.version = ?
             AND current.status IN ('active', 'past_due')
         )`,
    ).bind(now, now, subscriptionId, subscriptionId, prepared.organizationId, expectedVersion),
    env.BILLING_DB.prepare(
      `UPDATE subscriptions
       SET status = 'terminated', terminated_at = ?, current_period_end = ?,
           on_termination_credit_note = ?, on_termination_invoice = ?,
           version = version + 1, updated_at = ?
       WHERE id = ? AND organization_id = ? AND version = ?
         AND status IN ('active', 'past_due')`,
    ).bind(
      terminatedAt,
      terminatedAt,
      actions.creditNote,
      actions.invoice,
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
  const subscriptionUpdateIndex = prepared.creationStatements.length + 1;
  if (results[subscriptionUpdateIndex]?.meta.changes !== 1) {
    throw new Error("subscription_version_conflict");
  }
  if (publishImmediately) {
    if (creditNoteEvent) await env.DOMAIN_EVENTS.send(creditNoteEvent);
    await env.DOMAIN_EVENTS.send(subscriptionEvent);
  }
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
              i.id AS invoice_id, i.number AS invoice_number, i.status AS invoice_status, i.currency,
              il.id AS line_id, il.amount_minor AS line_amount_minor,
              il.precise_amount_minor AS line_precise_amount_minor,
              COALESCE((SELECT SUM(cni.amount_minor) FROM credit_note_items cni
                        JOIN credit_notes cn ON cn.id = cni.credit_note_id
                        WHERE cni.invoice_line_id = il.id AND cn.credit_status <> 'voided'), 0)
                AS credited_minor
       FROM subscriptions s
       JOIN plans p ON p.id = s.plan_id
       JOIN invoices i ON (
         i.subscription_id = s.id OR EXISTS (
           SELECT 1 FROM invoice_subscriptions ins
           WHERE ins.invoice_id = i.id AND ins.subscription_id = s.id
         )
       )
       JOIN invoice_lines il ON il.invoice_id = i.id AND il.line_type = 'subscription'
         AND il.source_type = 'plan' AND il.source_id = s.plan_id
       LEFT JOIN subscription_invoice_contexts sic ON sic.invoice_id = i.id
       WHERE s.id = ? AND s.version = ? AND s.status IN ('active', 'past_due')
         AND p.pay_in_advance = 1 AND i.status IN ('draft', 'finalized')
         AND i.coupons_minor = 0 AND i.tax_minor = 0 AND i.prepaid_credit_minor = 0
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

function requireSubscriptionLine(
  lines: SubscriptionInvoiceLine[],
  sourceId: string,
): SubscriptionInvoiceLine {
  const line = lines.find(
    (candidate) => candidate.lineType === "subscription" && candidate.sourceId === sourceId,
  );
  if (!line) throw new Error("draft_termination_credit_source_line_not_found");
  return line;
}

function terminationCreditNoteEvent(
  creditNoteId: string,
  organizationId: string,
  subscriptionId: string,
  invoiceId: string,
  totalAmountMinor: number,
  unusedDays: number,
  fullPeriodDays: number,
  occurredAt: string,
  causationId: string,
  correlationId: string,
): DomainEvent {
  return {
    id: `credit-note-created:${creditNoteId}:v1`,
    type: "credit_note.created",
    version: 1,
    aggregateType: "credit_note",
    aggregateId: creditNoteId,
    aggregateVersion: 1,
    occurredAt,
    causationId,
    correlationId,
    payload: {
      organizationId,
      subscriptionId,
      invoiceId,
      creditNoteId,
      reason: "order_cancellation",
      totalAmountMinor,
      unusedDays,
      fullPeriodDays,
    },
  };
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
