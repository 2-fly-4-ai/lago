import { sha256Hex } from "../auth/api-key";
import type { DomainEvent } from "../domain-events";
import { stableJson } from "../json";
import { couponCreditStatements } from "./coupon-credits";
import { creditNoteAllocationStatements } from "./credit-note-credits";
import { manualTaxStatements } from "./manual-taxes";
import { paymentDueDate } from "./payment-terms";
import {
  calculateInitialSubscriptionInvoice,
  calculateSubscriptionInvoice,
  findRefreshableSubscription,
  subscriptionInvoiceLineStatements,
} from "./subscription-invoice-calculation";
import { walletAllocationStatements } from "./wallet-credits";

type DraftInvoiceRow = {
  id: string;
  organization_id: string;
  customer_id: string;
  subscription_id: string;
  status: string;
  currency: string;
  issuing_date: string;
  net_payment_term: number;
  version: number;
  billing_cycle_id: string | null;
  context_type: "initial" | "renewal";
  period_start: string;
  period_end: string;
};

export type RefreshDraftResult = {
  changed: boolean;
  finalized: boolean;
  invoiceId: string;
  version: number;
  totalDueMinor: number;
  lineCount: number;
};

type DraftEnv = Pick<Env, "BILLING_DB" | "BILLING_ACCOUNTS" | "DOMAIN_EVENTS">;

export async function refreshSubscriptionDraft(
  env: DraftEnv,
  invoiceId: string,
  organizationId: string | null,
  refreshedAt: string,
  correlationId: string,
  finalize: boolean,
): Promise<RefreshDraftResult> {
  const invoice = await findDraftInvoice(env.BILLING_DB, invoiceId, organizationId);
  if (!invoice) throw new Error("invoice_not_found");
  if (invoice.status === "finalized" && finalize) {
    return currentResult(env.BILLING_DB, invoice.id, invoice.version, true, false);
  }
  if (invoice.status !== "draft") throw new Error("invoice_not_draft");
  if (!invoice.issuing_date) throw new Error("invoice_issuing_date_missing");
  await assertDraftHasNoCommittedAllocations(env.BILLING_DB, invoice.id);

  const subscription = await findRefreshableSubscription(env.BILLING_DB, invoice.subscription_id);
  if (!subscription || subscription.organization_id !== invoice.organization_id) {
    throw new Error("draft_subscription_not_found");
  }
  const requestHash = await sha256Hex(
    stableJson({
      invoiceId,
      version: invoice.version,
      operation: finalize ? "finalize" : "refresh",
    }),
  );
  const commandKey = `invoice-${finalize ? "finalize" : "refresh"}:${invoice.id}:v${invoice.version}`;
  const account = env.BILLING_ACCOUNTS.getByName(`customer:${invoice.customer_id}`);
  const reservation = await account.reserveCommand({
    idempotencyKey: commandKey,
    commandType: finalize ? "invoice.refresh_and_finalize" : "invoice.refresh",
    requestHash,
  });
  if (!reservation.ok) throw new Error(reservation.error);
  if (reservation.replayed && reservation.reservation.status === "completed") {
    const replay = parseReservation(reservation.reservation.responseJson);
    if (replay) return { ...replay, changed: false };
  }
  if (reservation.replayed) throw new Error("invoice_refresh_in_progress");

  try {
    const calculation =
      invoice.context_type === "initial"
        ? await calculateInitialSubscriptionInvoice(
            env.BILLING_DB,
            subscription,
            invoice.id,
            invoice.period_start,
            invoice.period_end,
          )
        : await calculateSubscriptionInvoice(
            env.BILLING_DB,
            subscription,
            invoice.id,
            requireBillingCycleId(invoice.billing_cycle_id),
            invoice.period_start,
            invoice.period_end,
          );
    const nextVersion = invoice.version + 1;
    const paymentDue = paymentDueDate(invoice.issuing_date, invoice.net_payment_term);
    const eventType = finalize ? "invoice.finalized" : "invoice.refreshed";
    const event: DomainEvent = {
      id: `${finalize ? "invoice-finalized" : "invoice-refreshed"}:${invoice.id}:v${nextVersion}`,
      type: eventType,
      version: 1,
      aggregateType: "invoice",
      aggregateId: invoice.id,
      aggregateVersion: nextVersion,
      occurredAt: refreshedAt,
      causationId: correlationId,
      correlationId,
      payload: {
        organizationId: invoice.organization_id,
        invoiceId: invoice.id,
        customerId: invoice.customer_id,
        subscriptionId: invoice.subscription_id,
        billingCycleId: invoice.billing_cycle_id,
        subtotalMinor: calculation.subtotalMinor,
        taxMinor: calculation.taxMinor,
        couponsMinor: calculation.couponsMinor,
        creditNotesMinor: calculation.creditNotesMinor,
        prepaidCreditMinor: calculation.prepaidCreditMinor,
        totalDueMinor: calculation.totalDueMinor,
        currency: invoice.currency,
        issuingDate: invoice.issuing_date,
        paymentDueDate: paymentDue,
      },
    };
    const couponStatements = finalize
      ? couponCreditStatements(
          env.BILLING_DB,
          invoice.organization_id,
          invoice.id,
          invoice.currency,
          calculation.couponCredits,
          refreshedAt,
          correlationId,
        )
      : [];
    const creditNoteStatements = finalize
      ? calculation.creditNoteAllocations.flatMap((allocation) =>
          creditNoteAllocationStatements(
            env.BILLING_DB,
            invoice.organization_id,
            invoice.id,
            allocation,
            refreshedAt,
            correlationId,
          ),
        )
      : [];
    const walletStatements = finalize
      ? calculation.walletAllocations.flatMap((allocation) =>
          walletAllocationStatements(
            env.BILLING_DB,
            invoice.organization_id,
            invoice.id,
            allocation,
            refreshedAt,
            correlationId,
          ),
        )
      : [];
    const update = env.BILLING_DB.prepare(
      `UPDATE invoices
       SET status = ?, subtotal_minor = ?, tax_minor = ?, credits_minor = ?,
           total_due_minor = ?, coupons_minor = ?, credit_notes_minor = ?,
           prepaid_credit_minor = ?, payment_due_date = ?, finalized_at = ?,
           ready_to_be_refreshed = 0, last_refreshed_at = ?, version = version + 1,
           updated_at = ?
       WHERE id = ? AND organization_id = ? AND status = 'draft' AND version = ?`,
    ).bind(
      finalize ? "finalized" : "draft",
      calculation.subtotalMinor,
      calculation.taxMinor,
      calculation.creditsMinor,
      calculation.totalDueMinor,
      calculation.couponsMinor,
      calculation.creditNotesMinor,
      calculation.prepaidCreditMinor,
      paymentDue,
      finalize ? refreshedAt : null,
      refreshedAt,
      refreshedAt,
      invoice.id,
      invoice.organization_id,
      invoice.version,
    );
    const statements: D1PreparedStatement[] = [
      env.BILLING_DB.prepare(
        `INSERT INTO invoice_mutation_guards
         (command_id, organization_id, invoice_id, operation, expected_version,
          resulting_version, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).bind(
        event.id,
        invoice.organization_id,
        invoice.id,
        finalize ? "finalize" : "refresh",
        invoice.version,
        nextVersion,
        refreshedAt,
      ),
      update,
      env.BILLING_DB.prepare("DELETE FROM invoice_line_taxes WHERE invoice_id = ?").bind(
        invoice.id,
      ),
      env.BILLING_DB.prepare("DELETE FROM invoice_taxes WHERE invoice_id = ?").bind(invoice.id),
      env.BILLING_DB.prepare("DELETE FROM invoice_lines WHERE invoice_id = ?").bind(invoice.id),
      ...subscriptionInvoiceLineStatements(
        env.BILLING_DB,
        invoice.id,
        invoice.billing_cycle_id,
        calculation.lines,
        refreshedAt,
      ),
      ...couponStatements,
      ...manualTaxStatements(
        env.BILLING_DB,
        invoice.organization_id,
        invoice.id,
        invoice.currency,
        calculation.invoiceTaxes,
        refreshedAt,
      ),
      ...creditNoteStatements,
      ...walletStatements,
      env.BILLING_DB.prepare(
        `INSERT INTO outbox_events
         (event_id, organization_id, event_type, event_version, aggregate_type,
          aggregate_id, aggregate_version, causation_id, correlation_id, payload_json,
          occurred_at, published_at)
         SELECT ?, ?, ?, 1, 'invoice', ?, ?, ?, ?, ?, ?, NULL FROM invoices
         WHERE id = ? AND organization_id = ? AND version = ? AND status = ?`,
      ).bind(
        event.id,
        invoice.organization_id,
        event.type,
        invoice.id,
        nextVersion,
        correlationId,
        correlationId,
        stableJson(event.payload),
        refreshedAt,
        invoice.id,
        invoice.organization_id,
        nextVersion,
        finalize ? "finalized" : "draft",
      ),
    ];
    const results = await env.BILLING_DB.batch(statements);
    if (results[0]?.meta.changes !== 1 || results[1]?.meta.changes !== 1) {
      throw new Error("invoice_version_conflict");
    }
    const outbox = results.at(-1);
    if (outbox?.meta.changes !== 1) throw new Error("invoice_outbox_conflict");
    if (finalize) {
      const firstCouponUpdate = 6 + calculation.lines.length;
      for (let offset = 0; offset < calculation.couponCredits.length; offset += 1) {
        const couponUpdate = results[firstCouponUpdate + offset * 3];
        if (!couponUpdate || couponUpdate.meta.changes < 1) {
          throw new Error("coupon_version_conflict");
        }
      }
    }
    await env.DOMAIN_EVENTS.send(event);
    const result: RefreshDraftResult = {
      changed: true,
      finalized: finalize,
      invoiceId: invoice.id,
      version: nextVersion,
      totalDueMinor: calculation.totalDueMinor,
      lineCount: calculation.lines.length,
    };
    await account.completeCommand(commandKey, result);
    return result;
  } catch (error) {
    await account.releaseCommand(commandKey, requestHash);
    if (error instanceof Error && error.message.includes("invoice_version_conflict")) {
      throw new Error("invoice_version_conflict");
    }
    throw error;
  }
}

async function findDraftInvoice(
  database: D1Database,
  invoiceId: string,
  organizationId: string | null,
): Promise<DraftInvoiceRow | null> {
  const organizationFilter = organizationId ? " AND i.organization_id = ?" : "";
  return database
    .prepare(
      `SELECT i.id, i.organization_id, i.customer_id, i.subscription_id, i.status,
              i.currency, i.issuing_date, i.net_payment_term, i.version,
              bc.id AS billing_cycle_id,
              CASE WHEN bc.id IS NOT NULL THEN 'renewal' ELSE sic.context_type END AS context_type,
              COALESCE(bc.period_start, sic.period_start) AS period_start,
              COALESCE(bc.period_end, sic.period_end) AS period_end
       FROM invoices i
       LEFT JOIN billing_cycles bc ON bc.invoice_id = i.id
       LEFT JOIN subscription_invoice_contexts sic ON sic.invoice_id = i.id
       WHERE i.id = ?${organizationFilter} AND i.subscription_id IS NOT NULL
         AND (bc.id IS NOT NULL OR sic.invoice_id IS NOT NULL)
       LIMIT 1`,
    )
    .bind(...(organizationId ? [invoiceId, organizationId] : [invoiceId]))
    .first<DraftInvoiceRow>();
}

function requireBillingCycleId(value: string | null): string {
  if (!value) throw new Error("draft_billing_cycle_not_found");
  return value;
}

async function assertDraftHasNoCommittedAllocations(
  database: D1Database,
  invoiceId: string,
): Promise<void> {
  const counts = await database
    .prepare(
      `SELECT
         (SELECT COUNT(*) FROM coupon_credits WHERE invoice_id = ?) AS coupons,
         (SELECT COUNT(*) FROM credit_note_applications WHERE invoice_id = ?) AS credit_notes,
         (SELECT COUNT(*) FROM wallet_transactions WHERE invoice_id = ?) AS wallets`,
    )
    .bind(invoiceId, invoiceId, invoiceId)
    .first<{ coupons: number; credit_notes: number; wallets: number }>();
  if ((counts?.coupons ?? 0) + (counts?.credit_notes ?? 0) + (counts?.wallets ?? 0) !== 0) {
    throw new Error("draft_has_committed_allocations");
  }
}

async function currentResult(
  database: D1Database,
  invoiceId: string,
  version: number,
  finalized: boolean,
  changed: boolean,
): Promise<RefreshDraftResult> {
  const invoice = await database
    .prepare("SELECT total_due_minor FROM invoices WHERE id = ?")
    .bind(invoiceId)
    .first<{ total_due_minor: number }>();
  const lines = await database
    .prepare("SELECT COUNT(*) AS total FROM invoice_lines WHERE invoice_id = ?")
    .bind(invoiceId)
    .first<{ total: number }>();
  if (!invoice) throw new Error("invoice_not_found");
  return {
    changed,
    finalized,
    invoiceId,
    version,
    totalDueMinor: invoice.total_due_minor,
    lineCount: lines?.total ?? 0,
  };
}

function parseReservation(value: string | null): RefreshDraftResult | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as Partial<RefreshDraftResult>;
    return typeof parsed.invoiceId === "string" &&
      typeof parsed.version === "number" &&
      typeof parsed.totalDueMinor === "number" &&
      typeof parsed.lineCount === "number" &&
      typeof parsed.finalized === "boolean"
      ? ({ ...parsed, changed: false } as RefreshDraftResult)
      : null;
  } catch {
    return null;
  }
}
