import { deterministicUuid } from "../identifiers";
import {
  getAuthorizeNetTransaction,
  normalizeAuthorizeNetPaymentStatus,
} from "../providers/authorize-net";

const SUPPORTED_PAYMENT_EVENTS = new Set([
  "net.authorize.payment.authcapture.created",
  "net.authorize.payment.capture.created",
  "net.authorize.payment.fraud.held",
  "net.authorize.payment.fraud.declined",
  "net.authorize.payment.void.created",
]);

type PendingReceipt = {
  receipt_id: string;
  organization_id: string;
  provider_account_code: string;
  event_type: string;
  provider_transaction_id: string | null;
  archive_key: string | null;
  processed_at: string | null;
};

export async function reconcileAuthorizeNetReceipt(
  env: Env,
  receiptId: string,
  fetcher: typeof fetch = fetch,
): Promise<"processed" | "deferred"> {
  const receipt = await env.BILLING_DB.prepare(
    `SELECT e.receipt_id, e.organization_id, r.provider_account_code, e.event_type,
            e.provider_transaction_id, r.archive_key, r.processed_at
     FROM provider_webhook_events e
     JOIN webhook_receipts r ON r.id = e.receipt_id
     WHERE e.receipt_id = ? AND r.provider = 'authorize_net' LIMIT 1`,
  )
    .bind(receiptId)
    .first<PendingReceipt>();
  if (!receipt || receipt.processed_at) return "processed";

  if (!SUPPORTED_PAYMENT_EVENTS.has(receipt.event_type) || !receipt.provider_transaction_id) {
    await markIgnored(env.BILLING_DB, receiptId);
    return "processed";
  }
  if (String(env.PROVIDER_READS_ENABLED) !== "1") return "deferred";

  try {
    const transaction = await getAuthorizeNetTransaction(
      env,
      receipt.provider_transaction_id,
      fetcher,
    );
    const normalizedStatus = normalizeAuthorizeNetPaymentStatus(transaction.status);
    const invoice = await findInvoice(
      env.BILLING_DB,
      receipt.organization_id,
      transaction.metadata.lago_invoice_id ?? transaction.metadata.lago_payable_id ?? null,
      transaction.invoiceNumber,
    );
    if (!invoice) throw new Error("invoice_not_found");

    const timestamp = new Date().toISOString();
    const paymentAttemptId = await deterministicUuid(
      "authorize-net-payment",
      `${receipt.provider_account_code}:${transaction.id}`,
    );
    const failureCode =
      normalizedStatus === "failed" ? (transaction.failureCode ?? transaction.status) : null;
    const failureMessage = normalizedStatus === "failed" ? transaction.failureMessage : null;
    const amountMinor = transaction.amountMinor ?? invoice.total_due_minor;
    const nextInvoiceStatus =
      normalizedStatus === "succeeded"
        ? "succeeded"
        : normalizedStatus === "failed"
          ? "failed"
          : null;

    const statements: D1PreparedStatement[] = [
      env.BILLING_DB.prepare(
        `INSERT INTO payment_attempts
         (id, organization_id, invoice_id, provider, provider_account_code,
          provider_transaction_id, idempotency_key, amount_minor, currency, status,
          failure_code, failure_message, created_at, updated_at)
         VALUES (?, ?, ?, 'authorize_net', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(provider, provider_account_code, provider_transaction_id) DO UPDATE SET
           status = excluded.status,
           failure_code = excluded.failure_code,
           failure_message = excluded.failure_message,
           updated_at = excluded.updated_at`,
      ).bind(
        paymentAttemptId,
        receipt.organization_id,
        invoice.id,
        receipt.provider_account_code,
        transaction.id,
        `authorize-net:${receipt.provider_account_code}:${transaction.id}`,
        amountMinor,
        invoice.currency,
        normalizedStatus,
        failureCode,
        failureMessage,
        timestamp,
        timestamp,
      ),
      env.BILLING_DB.prepare(
        `UPDATE provider_webhook_events
         SET invoice_id = ?, normalized_status = ?, normalized_at = ?
         WHERE receipt_id = ?`,
      ).bind(invoice.id, normalizedStatus, timestamp, receiptId),
      env.BILLING_DB.prepare(
        `UPDATE webhook_receipts
         SET processed_at = ?, processing_error_code = NULL
         WHERE id = ?`,
      ).bind(timestamp, receiptId),
    ];

    if (nextInvoiceStatus) {
      statements.push(
        env.BILLING_DB.prepare(
          `UPDATE invoices
           SET payment_status = ?, version = version + 1, updated_at = ?
           WHERE id = ? AND organization_id = ? AND payment_status <> 'succeeded'`,
        ).bind(nextInvoiceStatus, timestamp, invoice.id, receipt.organization_id),
      );
    }
    if (normalizedStatus === "succeeded") {
      const eventId = `event_${paymentAttemptId}_succeeded`;
      statements.push(
        env.BILLING_DB.prepare(
          `INSERT INTO outbox_events
           (event_id, organization_id, event_type, event_version, aggregate_type,
            aggregate_id, aggregate_version, causation_id, correlation_id, payload_json,
            occurred_at, published_at)
           VALUES (?, ?, 'payment.succeeded', 1, 'invoice', ?, ?, ?, ?, ?, ?, NULL)
           ON CONFLICT(event_id) DO NOTHING`,
        ).bind(
          eventId,
          receipt.organization_id,
          invoice.id,
          invoice.version + 1,
          `event_${receiptId}`,
          receiptId,
          JSON.stringify({
            invoiceId: invoice.id,
            paymentAttemptId,
            providerTransactionId: transaction.id,
          }),
          timestamp,
        ),
      );
    }

    await env.BILLING_DB.batch(statements);
    return "processed";
  } catch (error) {
    const code =
      error instanceof Error && error.message === "invoice_not_found"
        ? "invoice_not_found"
        : "provider_reconciliation_failed";
    await env.BILLING_DB.prepare(
      `UPDATE webhook_receipts SET processing_error_code = ? WHERE id = ? AND processed_at IS NULL`,
    )
      .bind(code, receiptId)
      .run();
    throw error;
  }
}

async function findInvoice(
  database: D1Database,
  organizationId: string,
  invoiceId: string | null,
  invoiceNumber: string | null,
): Promise<{ id: string; currency: string; total_due_minor: number; version: number } | null> {
  if (invoiceId) {
    const invoice = await database
      .prepare(
        `SELECT id, currency, total_due_minor, version FROM invoices
         WHERE id = ? AND organization_id = ? LIMIT 1`,
      )
      .bind(invoiceId, organizationId)
      .first<{ id: string; currency: string; total_due_minor: number; version: number }>();
    if (invoice) return invoice;
  }
  if (!invoiceNumber) return null;
  return database
    .prepare(
      `SELECT id, currency, total_due_minor, version FROM invoices
       WHERE number = ? AND organization_id = ? LIMIT 1`,
    )
    .bind(invoiceNumber, organizationId)
    .first<{ id: string; currency: string; total_due_minor: number; version: number }>();
}

async function markIgnored(database: D1Database, receiptId: string): Promise<void> {
  const timestamp = new Date().toISOString();
  await database.batch([
    database
      .prepare(
        `UPDATE provider_webhook_events
         SET normalized_status = 'ignored', normalized_at = ? WHERE receipt_id = ?`,
      )
      .bind(timestamp, receiptId),
    database
      .prepare(
        `UPDATE webhook_receipts SET processed_at = ?, processing_error_code = NULL WHERE id = ?`,
      )
      .bind(timestamp, receiptId),
  ]);
}
