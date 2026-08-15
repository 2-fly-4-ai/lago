import { deterministicUuid } from "../identifiers";
import type { DomainEvent } from "../domain-events";
import { stableJson } from "../json";
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
    const paymentRequestId = authorizeNetPaymentRequestId(transaction.metadata);
    if (paymentRequestId) {
      await reconcileAuthorizeNetPaymentRequest(
        env.BILLING_DB,
        receipt,
        paymentRequestId,
        transaction,
        normalizedStatus,
      );
      return "processed";
    }
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
    const existingPayment = await env.BILLING_DB.prepare(
      `SELECT status, version FROM payment_attempts
       WHERE provider = 'authorize_net' AND provider_account_code = ?
         AND provider_transaction_id = ? LIMIT 1`,
    )
      .bind(receipt.provider_account_code, transaction.id)
      .first<{ status: string; version: number }>();
    const effectiveStatus =
      existingPayment?.status === "succeeded" && normalizedStatus !== "succeeded"
        ? "succeeded"
        : normalizedStatus;
    const paymentVersion = existingPayment
      ? existingPayment.status === effectiveStatus
        ? existingPayment.version
        : existingPayment.version + 1
      : 1;
    const priorSucceeded = await successfulPaymentTotal(
      env.BILLING_DB,
      invoice.id,
      paymentAttemptId,
    );
    const nextInvoiceStatus =
      effectiveStatus === "succeeded" && priorSucceeded + amountMinor >= invoice.total_due_minor
        ? "succeeded"
        : effectiveStatus === "failed" && priorSucceeded === 0
          ? "failed"
          : null;
    const invoiceStatusChanges =
      nextInvoiceStatus !== null && nextInvoiceStatus !== invoice.payment_status;
    const paymentEvent: DomainEvent = {
      id: `payment-${effectiveStatus}:${paymentAttemptId}:v${paymentVersion}`,
      type: `payment.${effectiveStatus}`,
      version: 1,
      aggregateType: "payment",
      aggregateId: paymentAttemptId,
      aggregateVersion: paymentVersion,
      occurredAt: timestamp,
      causationId: `event_${receiptId}`,
      correlationId: receiptId,
      payload: {
        organizationId: receipt.organization_id,
        invoiceId: invoice.id,
        paymentId: paymentAttemptId,
        provider: "authorize_net",
        providerTransactionId: transaction.id,
        amountMinor,
        currency: invoice.currency,
      },
    };

    const statements: D1PreparedStatement[] = [
      env.BILLING_DB.prepare(
        `INSERT INTO payment_attempts
         (id, organization_id, invoice_id, provider, provider_account_code,
          provider_transaction_id, idempotency_key, amount_minor, currency, status,
          failure_code, failure_message, version, created_at, updated_at)
         VALUES (?, ?, ?, 'authorize_net', ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
         ON CONFLICT(provider, provider_account_code, provider_transaction_id) DO UPDATE SET
           status = CASE WHEN payment_attempts.status = 'succeeded' THEN 'succeeded' ELSE excluded.status END,
           failure_code = CASE WHEN payment_attempts.status = 'succeeded' THEN NULL ELSE excluded.failure_code END,
           failure_message = CASE WHEN payment_attempts.status = 'succeeded' THEN NULL ELSE excluded.failure_message END,
           version = CASE WHEN payment_attempts.status = excluded.status
                          OR payment_attempts.status = 'succeeded' THEN payment_attempts.version
                          ELSE payment_attempts.version + 1 END,
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
        effectiveStatus,
        failureCode,
        failureMessage,
        timestamp,
        timestamp,
      ),
      env.BILLING_DB.prepare(
        `UPDATE provider_webhook_events
         SET invoice_id = ?, normalized_status = ?, normalized_at = ?
         WHERE receipt_id = ?`,
      ).bind(invoice.id, effectiveStatus, timestamp, receiptId),
      env.BILLING_DB.prepare(
        `UPDATE webhook_receipts
         SET processed_at = ?, processing_error_code = NULL
         WHERE id = ?`,
      ).bind(timestamp, receiptId),
      env.BILLING_DB.prepare(
        `INSERT INTO outbox_events
         (event_id, organization_id, event_type, event_version, aggregate_type,
          aggregate_id, aggregate_version, causation_id, correlation_id, payload_json,
          occurred_at, published_at)
         VALUES (?, ?, ?, 1, 'payment', ?, ?, ?, ?, ?, ?, NULL)
         ON CONFLICT(event_id) DO NOTHING`,
      ).bind(
        paymentEvent.id,
        receipt.organization_id,
        paymentEvent.type,
        paymentAttemptId,
        paymentVersion,
        paymentEvent.causationId,
        paymentEvent.correlationId,
        stableJson(paymentEvent.payload),
        timestamp,
      ),
    ];

    if (effectiveStatus === "succeeded") {
      statements.push(
        env.BILLING_DB.prepare("DELETE FROM payment_links WHERE invoice_id = ?").bind(invoice.id),
      );
    }

    if (invoiceStatusChanges) {
      statements.push(
        env.BILLING_DB.prepare(
          `UPDATE invoices
           SET payment_status = ?,
               payment_overdue = CASE WHEN ? = 'succeeded' THEN 0 ELSE payment_overdue END,
               ready_for_payment_processing = CASE WHEN ? = 'succeeded' THEN 0 ELSE 1 END,
               version = version + 1, updated_at = ?
           WHERE id = ? AND organization_id = ? AND version = ?
             AND payment_status <> 'succeeded' AND payment_status <> ?`,
        ).bind(
          nextInvoiceStatus,
          nextInvoiceStatus,
          nextInvoiceStatus,
          timestamp,
          invoice.id,
          receipt.organization_id,
          invoice.version,
          nextInvoiceStatus,
        ),
      );
      const eventId = `invoice-payment-status:${invoice.id}:v${invoice.version + 1}`;
      statements.push(
        env.BILLING_DB.prepare(
          `INSERT INTO outbox_events
           (event_id, organization_id, event_type, event_version, aggregate_type,
            aggregate_id, aggregate_version, causation_id, correlation_id, payload_json,
            occurred_at, published_at)
           SELECT ?, ?, 'invoice.payment_status_updated', 1, 'invoice', ?, ?, ?, ?, ?, ?, NULL
           FROM invoices
           WHERE id = ? AND organization_id = ? AND version = ? AND updated_at = ?
           ON CONFLICT(event_id) DO NOTHING`,
        ).bind(
          eventId,
          receipt.organization_id,
          invoice.id,
          invoice.version + 1,
          `event_${receiptId}`,
          receiptId,
          stableJson({
            invoiceId: invoice.id,
            paymentAttemptId,
            providerTransactionId: transaction.id,
            paymentStatus: nextInvoiceStatus,
          }),
          timestamp,
          invoice.id,
          receipt.organization_id,
          invoice.version + 1,
          timestamp,
        ),
      );
    }

    await env.BILLING_DB.batch(statements);
    return "processed";
  } catch (error) {
    const code = reconciliationErrorCode(error);
    await env.BILLING_DB.prepare(
      `UPDATE webhook_receipts SET processing_error_code = ? WHERE id = ? AND processed_at IS NULL`,
    )
      .bind(code, receiptId)
      .run();
    throw error;
  }
}

type PaymentRequestRow = {
  id: string;
  organization_id: string;
  customer_id: string;
  amount_minor: number;
  currency: string;
  payment_status: "pending" | "succeeded" | "failed";
  version: number;
  dunning_campaign_id: string | null;
};

type PaymentRequestInvoiceRow = {
  id: string;
  currency: string;
  total_due_minor: number;
  total_paid_minor: number;
  payment_status: string;
  version: number;
};

type PaymentRequestPaymentRow = {
  status: "pending" | "succeeded" | "failed" | "unknown";
  version: number;
};

async function reconcileAuthorizeNetPaymentRequest(
  database: D1Database,
  receipt: PendingReceipt,
  paymentRequestId: string,
  transaction: Awaited<ReturnType<typeof getAuthorizeNetTransaction>>,
  normalizedStatus: ReturnType<typeof normalizeAuthorizeNetPaymentStatus>,
): Promise<void> {
  const paymentRequest = await database
    .prepare(
      `SELECT id, organization_id, customer_id, amount_minor, currency, payment_status,
              version, dunning_campaign_id
       FROM payment_requests
       WHERE id = ? AND organization_id = ? LIMIT 1`,
    )
    .bind(paymentRequestId, receipt.organization_id)
    .first<PaymentRequestRow>();
  if (!paymentRequest) throw new Error("payment_request_not_found");

  const existingPayment = await database
    .prepare(
      `SELECT status, version FROM payment_request_payments
       WHERE provider = 'authorize_net' AND provider_account_code = ?
         AND provider_transaction_id = ? LIMIT 1`,
    )
    .bind(receipt.provider_account_code, transaction.id)
    .first<PaymentRequestPaymentRow>();
  const effectiveStatus =
    existingPayment?.status === "succeeded" && normalizedStatus !== "succeeded"
      ? "succeeded"
      : normalizedStatus;
  const timestamp = new Date().toISOString();

  if (paymentRequest.payment_status === "succeeded") {
    await database.batch([
      database
        .prepare(
          `UPDATE provider_webhook_events
           SET invoice_id = NULL, payment_request_id = ?, normalized_status = ?, normalized_at = ?
           WHERE receipt_id = ?`,
        )
        .bind(
          paymentRequest.id,
          existingPayment?.status ?? "succeeded",
          timestamp,
          receipt.receipt_id,
        ),
      database
        .prepare(
          `UPDATE webhook_receipts
           SET processed_at = ?, processing_error_code = NULL WHERE id = ?`,
        )
        .bind(timestamp, receipt.receipt_id),
    ]);
    return;
  }

  if (transaction.amountMinor !== null && transaction.amountMinor !== paymentRequest.amount_minor) {
    throw new Error("payment_request_amount_mismatch");
  }

  const linked = await database
    .prepare(
      `SELECT invoice.id, invoice.currency, invoice.total_due_minor, invoice.payment_status,
              invoice.version,
              COALESCE((
                SELECT SUM(amount_minor) FROM (
                  SELECT payment.amount_minor
                  FROM payment_attempts payment
                  WHERE payment.invoice_id = invoice.id AND payment.status = 'succeeded'
                  UNION ALL
                  SELECT allocation.amount_minor
                  FROM payment_request_payment_allocations allocation
                  WHERE allocation.invoice_id = invoice.id
                )
              ), 0) AS total_paid_minor
       FROM invoices_payment_requests link
       JOIN invoices invoice ON invoice.id = link.invoice_id
       WHERE link.payment_request_id = ? AND link.organization_id = ?
       ORDER BY link.created_at, invoice.id`,
    )
    .bind(paymentRequest.id, receipt.organization_id)
    .all<PaymentRequestInvoiceRow>();
  if (linked.results.length === 0) throw new Error("payment_request_invoices_not_found");
  if (linked.results.some((invoice) => invoice.currency !== paymentRequest.currency)) {
    throw new Error("payment_request_currency_mismatch");
  }

  const allocations = linked.results.map((invoice) => ({
    invoice,
    amountMinor: Math.max(invoice.total_due_minor - invoice.total_paid_minor, 0),
  }));
  const allocationTotal = allocations.reduce((sum, allocation) => {
    const next = sum + allocation.amountMinor;
    if (!Number.isSafeInteger(next)) throw new Error("payment_request_amount_overflow");
    return next;
  }, 0);
  if (
    effectiveStatus === "succeeded" &&
    (allocations.some((allocation) => allocation.amountMinor <= 0) ||
      allocationTotal !== paymentRequest.amount_minor)
  ) {
    throw new Error("payment_request_balance_changed");
  }

  const paymentId = await deterministicUuid(
    "authorize-net-payment-request",
    `${receipt.provider_account_code}:${transaction.id}`,
  );
  const paymentVersion = existingPayment
    ? existingPayment.status === effectiveStatus
      ? existingPayment.version
      : existingPayment.version + 1
    : 1;
  const failureCode =
    effectiveStatus === "failed" ? (transaction.failureCode ?? transaction.status) : null;
  const failureMessage = effectiveStatus === "failed" ? transaction.failureMessage : null;
  const invoiceIds = linked.results.map((invoice) => invoice.id);
  const paymentEvent: DomainEvent = {
    id: `payment-${effectiveStatus}:${paymentId}:v${paymentVersion}`,
    type: `payment.${effectiveStatus}`,
    version: 1,
    aggregateType: "payment",
    aggregateId: paymentId,
    aggregateVersion: paymentVersion,
    occurredAt: timestamp,
    causationId: `event_${receipt.receipt_id}`,
    correlationId: receipt.receipt_id,
    payload: {
      organizationId: receipt.organization_id,
      paymentRequestId: paymentRequest.id,
      invoiceIds,
      paymentId,
      provider: "authorize_net",
      providerTransactionId: transaction.id,
      amountMinor: paymentRequest.amount_minor,
      currency: paymentRequest.currency,
    },
  };
  const requestStatus = effectiveStatus === "unknown" ? null : effectiveStatus;
  const requestStatusChanges =
    requestStatus !== null && requestStatus !== paymentRequest.payment_status;
  const statements: D1PreparedStatement[] = [
    database
      .prepare(
        `INSERT INTO payment_request_reconciliation_guards
         (receipt_id, organization_id, payment_request_id,
          expected_payment_request_version, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .bind(
        receipt.receipt_id,
        receipt.organization_id,
        paymentRequest.id,
        paymentRequest.version,
        timestamp,
      ),
  ];
  for (const invoice of linked.results) {
    statements.push(
      database
        .prepare(
          `INSERT INTO payment_request_reconciliation_invoice_guards
           (receipt_id, organization_id, payment_request_id, invoice_id,
            expected_invoice_version, created_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          receipt.receipt_id,
          receipt.organization_id,
          paymentRequest.id,
          invoice.id,
          invoice.version,
          timestamp,
        ),
    );
  }
  statements.push(
    database
      .prepare(
        `INSERT INTO payment_request_payments
         (id, organization_id, payment_request_id, provider, provider_account_code,
          provider_transaction_id, idempotency_key, amount_minor, currency, status,
          failure_code, failure_message, version, created_at, updated_at)
         VALUES (?, ?, ?, 'authorize_net', ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
         ON CONFLICT(provider, provider_account_code, provider_transaction_id) DO UPDATE SET
           status = CASE WHEN payment_request_payments.status = 'succeeded'
                         THEN 'succeeded' ELSE excluded.status END,
           failure_code = CASE WHEN payment_request_payments.status = 'succeeded'
                               THEN NULL ELSE excluded.failure_code END,
           failure_message = CASE WHEN payment_request_payments.status = 'succeeded'
                                  THEN NULL ELSE excluded.failure_message END,
           version = CASE WHEN payment_request_payments.status = excluded.status
                          OR payment_request_payments.status = 'succeeded'
                          THEN payment_request_payments.version
                          ELSE payment_request_payments.version + 1 END,
           updated_at = excluded.updated_at`,
      )
      .bind(
        paymentId,
        receipt.organization_id,
        paymentRequest.id,
        receipt.provider_account_code,
        transaction.id,
        `authorize-net:${receipt.provider_account_code}:${transaction.id}`,
        paymentRequest.amount_minor,
        paymentRequest.currency,
        effectiveStatus,
        failureCode,
        failureMessage,
        timestamp,
        timestamp,
      ),
  );

  if (effectiveStatus === "succeeded") {
    for (const allocation of allocations) {
      statements.push(
        database
          .prepare(
            `INSERT INTO payment_request_payment_allocations
             (id, organization_id, payment_request_payment_id, payment_request_id,
              invoice_id, amount_minor, currency, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(payment_request_payment_id, invoice_id) DO NOTHING`,
          )
          .bind(
            await deterministicUuid(
              "payment-request-allocation",
              `${paymentId}:${allocation.invoice.id}`,
            ),
            receipt.organization_id,
            paymentId,
            paymentRequest.id,
            allocation.invoice.id,
            allocation.amountMinor,
            paymentRequest.currency,
            timestamp,
          ),
      );
    }
  }

  statements.push(
    database
      .prepare(
        `UPDATE payment_requests
         SET payment_attempts = (
               SELECT COUNT(*) FROM payment_request_payments payment
               WHERE payment.payment_request_id = payment_requests.id
             ),
             payment_status = COALESCE(?, payment_status),
             ready_for_payment_processing = CASE WHEN ? = 'succeeded' THEN 0 ELSE 1 END,
             version = CASE WHEN ? IS NOT NULL AND payment_status <> ?
                            THEN version + 1 ELSE version END,
             updated_at = ?
         WHERE id = ? AND organization_id = ? AND version = ?
           AND payment_status <> 'succeeded'`,
      )
      .bind(
        requestStatus,
        requestStatus,
        requestStatus,
        requestStatus,
        timestamp,
        paymentRequest.id,
        receipt.organization_id,
        paymentRequest.version,
      ),
  );

  for (const invoice of linked.results) {
    const invoiceStatus = requestStatus;
    if (invoiceStatus === null || invoiceStatus === invoice.payment_status) continue;
    statements.push(
      database
        .prepare(
          `UPDATE invoices
           SET payment_status = ?,
               payment_overdue = CASE WHEN ? = 'succeeded' THEN 0 ELSE payment_overdue END,
               ready_for_payment_processing = CASE WHEN ? = 'succeeded' THEN 0 ELSE 1 END,
               version = version + 1, updated_at = ?
           WHERE id = ? AND organization_id = ? AND version = ?
             AND payment_status <> 'succeeded'`,
        )
        .bind(
          invoiceStatus,
          invoiceStatus,
          invoiceStatus,
          timestamp,
          invoice.id,
          receipt.organization_id,
          invoice.version,
        ),
    );
    statements.push(
      database
        .prepare(
          `INSERT INTO outbox_events
           (event_id, organization_id, event_type, event_version, aggregate_type,
            aggregate_id, aggregate_version, causation_id, correlation_id, payload_json,
            occurred_at, published_at)
           SELECT ?, ?, 'invoice.payment_status_updated', 1, 'invoice', ?, ?, ?, ?, ?, ?, NULL
           FROM invoices
           WHERE id = ? AND organization_id = ? AND version = ? AND updated_at = ?
           ON CONFLICT(event_id) DO NOTHING`,
        )
        .bind(
          `invoice-payment-status:${invoice.id}:v${invoice.version + 1}`,
          receipt.organization_id,
          invoice.id,
          invoice.version + 1,
          `event_${receipt.receipt_id}`,
          receipt.receipt_id,
          stableJson({
            invoiceId: invoice.id,
            paymentRequestId: paymentRequest.id,
            paymentId,
            providerTransactionId: transaction.id,
            paymentStatus: invoiceStatus,
          }),
          timestamp,
          invoice.id,
          receipt.organization_id,
          invoice.version + 1,
          timestamp,
        ),
    );
  }

  if (requestStatusChanges) {
    statements.push(
      database
        .prepare(
          `INSERT INTO outbox_events
           (event_id, organization_id, event_type, event_version, aggregate_type,
            aggregate_id, aggregate_version, causation_id, correlation_id, payload_json,
            occurred_at, published_at)
           SELECT ?, ?, 'payment_request.payment_status_updated', 1, 'payment_request',
                  ?, ?, ?, ?, ?, ?, NULL
           FROM payment_requests
           WHERE id = ? AND organization_id = ? AND version = ? AND updated_at = ?
           ON CONFLICT(event_id) DO NOTHING`,
        )
        .bind(
          `payment-request-status:${paymentRequest.id}:v${paymentRequest.version + 1}`,
          receipt.organization_id,
          paymentRequest.id,
          paymentRequest.version + 1,
          `event_${receipt.receipt_id}`,
          receipt.receipt_id,
          stableJson({
            paymentRequestId: paymentRequest.id,
            paymentId,
            providerTransactionId: transaction.id,
            paymentStatus: requestStatus,
          }),
          timestamp,
          paymentRequest.id,
          receipt.organization_id,
          paymentRequest.version + 1,
          timestamp,
        ),
    );
  }

  if (effectiveStatus === "succeeded" && paymentRequest.dunning_campaign_id) {
    statements.push(
      database
        .prepare(
          `UPDATE customers
           SET last_dunning_campaign_attempt = 0, last_dunning_campaign_attempt_at = NULL,
               version = version + 1, updated_at = ?
           WHERE id = ? AND organization_id = ?
             AND (last_dunning_campaign_attempt <> 0
                  OR last_dunning_campaign_attempt_at IS NOT NULL)`,
        )
        .bind(timestamp, paymentRequest.customer_id, receipt.organization_id),
    );
  }

  statements.push(
    database
      .prepare(
        `UPDATE provider_webhook_events
         SET invoice_id = NULL, payment_request_id = ?, normalized_status = ?, normalized_at = ?
         WHERE receipt_id = ?`,
      )
      .bind(paymentRequest.id, effectiveStatus, timestamp, receipt.receipt_id),
    database
      .prepare(
        `UPDATE webhook_receipts
         SET processed_at = ?, processing_error_code = NULL WHERE id = ?`,
      )
      .bind(timestamp, receipt.receipt_id),
    database
      .prepare(
        `INSERT INTO outbox_events
         (event_id, organization_id, event_type, event_version, aggregate_type,
          aggregate_id, aggregate_version, causation_id, correlation_id, payload_json,
          occurred_at, published_at)
         VALUES (?, ?, ?, 1, 'payment', ?, ?, ?, ?, ?, ?, NULL)
         ON CONFLICT(event_id) DO NOTHING`,
      )
      .bind(
        paymentEvent.id,
        receipt.organization_id,
        paymentEvent.type,
        paymentId,
        paymentVersion,
        paymentEvent.causationId,
        paymentEvent.correlationId,
        stableJson(paymentEvent.payload),
        timestamp,
      ),
  );

  await database.batch(statements);
}

function authorizeNetPaymentRequestId(metadata: Record<string, string>): string | null {
  const payableType = metadata.lago_payable_type?.trim();
  if (payableType === "PaymentRequest") {
    return metadata.lago_payment_request_id?.trim() || metadata.lago_payable_id?.trim() || null;
  }
  return metadata.lago_payment_request_id?.trim() || null;
}

function reconciliationErrorCode(error: unknown): string {
  if (!(error instanceof Error)) return "provider_reconciliation_failed";
  if (
    [
      "invoice_not_found",
      "payment_request_not_found",
      "payment_request_invoices_not_found",
      "payment_request_amount_mismatch",
      "payment_request_currency_mismatch",
      "payment_request_balance_changed",
      "payment_request_amount_overflow",
    ].includes(error.message)
  ) {
    return error.message;
  }
  return "provider_reconciliation_failed";
}

async function successfulPaymentTotal(
  database: D1Database,
  invoiceId: string,
  excludedPaymentId: string,
): Promise<number> {
  const value = await database
    .prepare(
      `SELECT COALESCE(SUM(amount_minor), 0) AS total FROM (
         SELECT amount_minor FROM payment_attempts
         WHERE invoice_id = ? AND status = 'succeeded' AND id <> ?
         UNION ALL
         SELECT amount_minor FROM payment_request_payment_allocations WHERE invoice_id = ?
       )`,
    )
    .bind(invoiceId, excludedPaymentId, invoiceId)
    .first<{ total: number }>();
  return value?.total ?? 0;
}

async function findInvoice(
  database: D1Database,
  organizationId: string,
  invoiceId: string | null,
  invoiceNumber: string | null,
): Promise<{
  id: string;
  currency: string;
  total_due_minor: number;
  payment_status: string;
  version: number;
} | null> {
  if (invoiceId) {
    const invoice = await database
      .prepare(
        `SELECT id, currency, total_due_minor, payment_status, version FROM invoices
         WHERE id = ? AND organization_id = ? LIMIT 1`,
      )
      .bind(invoiceId, organizationId)
      .first<{
        id: string;
        currency: string;
        total_due_minor: number;
        payment_status: string;
        version: number;
      }>();
    if (invoice) return invoice;
  }
  if (!invoiceNumber) return null;
  return database
    .prepare(
      `SELECT id, currency, total_due_minor, payment_status, version FROM invoices
       WHERE number = ? AND organization_id = ? LIMIT 1`,
    )
    .bind(invoiceNumber, organizationId)
    .first<{
      id: string;
      currency: string;
      total_due_minor: number;
      payment_status: string;
      version: number;
    }>();
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
