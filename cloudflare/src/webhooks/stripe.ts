import { sha256Hex } from "../auth/api-key";
import { ApiError, json, readBoundedText } from "../http";
import { deterministicUuid } from "../identifiers";

const SIGNATURE_TOLERANCE_SECONDS = 300;
const DISPUTE_EVENT_TYPES = new Set([
  "charge.dispute.created",
  "charge.dispute.updated",
  "charge.dispute.closed",
]);
const REFUND_EVENT_TYPES = new Set([
  "refund.created",
  "refund.updated",
  "refund.failed",
  "refund.canceled",
]);
const WALLET_FUNDING_EVENT_TYPES = new Set([
  "payment_intent.succeeded",
  "payment_intent.processing",
  "payment_intent.payment_failed",
  "payment_intent.canceled",
]);
const DISPUTE_STATUSES = new Set([
  "warning_needs_response",
  "warning_under_review",
  "warning_closed",
  "needs_response",
  "under_review",
  "won",
  "lost",
  "prevented",
]);

type StripeWebhookEnv = Pick<Env, "BILLING_DB" | "BILLING_ARTIFACTS"> & {
  STRIPE_WEBHOOKS_ENABLED?: string;
  STRIPE_WEBHOOK_SIGNING_SECRET?: string;
  STRIPE_ACCOUNT_CODE?: string;
  STRIPE_ORGANIZATION_ID?: string;
  STRIPE_LIVEMODE_ALLOWED?: string;
};

type StripeEvent = {
  id: string;
  type: string;
  created: number;
  livemode: boolean;
  data: { object: Record<string, unknown> };
};

export async function handleStripeWebhook(
  request: Request,
  env: StripeWebhookEnv,
  organizationId: string,
  requestId: string,
): Promise<Response> {
  if (env.STRIPE_WEBHOOKS_ENABLED !== "1") {
    throw new ApiError(
      503,
      "stripe_webhooks_disabled",
      "Stripe webhook ingestion is disabled until the provider gate is approved",
    );
  }
  const signature = request.headers.get("Stripe-Signature")?.trim();
  if (!signature || signature.length > 4096) {
    throw new ApiError(401, "webhook_signature_missing", "Webhook signature is required");
  }
  const signingSecret = env.STRIPE_WEBHOOK_SIGNING_SECRET?.trim();
  const providerAccountCode = env.STRIPE_ACCOUNT_CODE?.trim();
  const configuredOrganizationId = env.STRIPE_ORGANIZATION_ID?.trim();
  if (!signingSecret || !providerAccountCode || !configuredOrganizationId) {
    throw new ApiError(503, "stripe_not_configured", "Stripe webhook configuration is incomplete");
  }
  if (organizationId !== configuredOrganizationId) {
    throw new ApiError(404, "organization_not_found", "Organization was not found");
  }
  const organization = await env.BILLING_DB.prepare(
    "SELECT id FROM organizations WHERE id = ? LIMIT 1",
  )
    .bind(organizationId)
    .first<{ id: string }>();
  if (!organization) {
    throw new ApiError(404, "organization_not_found", "Organization was not found");
  }

  const rawBody = await readBoundedText(request, 1024 * 1024);
  if (!rawBody) throw new ApiError(400, "webhook_body_missing", "Webhook body is required");
  if (!(await validStripeSignature(rawBody, signature, signingSecret))) {
    throw new ApiError(401, "webhook_signature_invalid", "Webhook signature is invalid");
  }
  const event = parseStripeEvent(rawBody);
  if (event.livemode && env.STRIPE_LIVEMODE_ALLOWED !== "1") {
    throw new ApiError(
      503,
      "stripe_livemode_disabled",
      "Live-mode Stripe events are disabled in this environment",
    );
  }

  const payloadHash = await sha256Hex(rawBody);
  const existing = await env.BILLING_DB.prepare(
    `SELECT id, payload_sha256 FROM webhook_receipts
     WHERE provider = 'stripe' AND provider_account_code = ? AND provider_event_id = ?`,
  )
    .bind(providerAccountCode, event.id)
    .first<{ id: string; payload_sha256: string }>();
  if (existing) {
    if (existing.payload_sha256 !== payloadHash) {
      throw new ApiError(
        409,
        "webhook_event_conflict",
        "Webhook event ID was reused with different content",
      );
    }
    return json({ received: true, replayed: true }, { requestId });
  }

  const now = new Date().toISOString();
  const eventCreatedAt = unixSecondsIso(event.created, "event.created");
  const receiptId = await deterministicUuid(
    "stripe-webhook-receipt",
    `${providerAccountCode}:${event.id}`,
  );
  const archiveKey = `webhooks/stripe/${organizationId}/${now.slice(0, 10)}/${encodeURIComponent(event.id)}-${payloadHash}.json`;
  await env.BILLING_ARTIFACTS.put(archiveKey, rawBody, {
    httpMetadata: { contentType: "application/json" },
    customMetadata: {
      provider: "stripe",
      organizationId,
      providerAccountCode,
      providerEventId: event.id,
      payloadSha256: payloadHash,
    },
  });

  const statements: D1PreparedStatement[] = [
    env.BILLING_DB.prepare(
      `INSERT INTO webhook_receipts
       (id, provider, provider_account_code, provider_event_id, signature_valid,
        payload_sha256, received_at, processed_at, processing_error_code, archive_key)
       VALUES (?, 'stripe', ?, ?, 1, ?, ?, ?, NULL, ?)`,
    ).bind(receiptId, providerAccountCode, event.id, payloadHash, now, now, archiveKey),
    env.BILLING_DB.prepare(
      `INSERT INTO provider_webhook_events
       (receipt_id, organization_id, event_type, provider_transaction_id,
        invoice_id, normalized_status, normalized_at)
       VALUES (?, ?, ?, ?, NULL, ?, ?)`,
    ).bind(
      receiptId,
      organizationId,
      event.type,
      providerObjectId(event.data.object),
      normalizedEventStatus(event),
      now,
    ),
  ];
  if (DISPUTE_EVENT_TYPES.has(event.type)) {
    statements.push(
      ...(await disputeStatements(
        env.BILLING_DB,
        organizationId,
        providerAccountCode,
        event,
        eventCreatedAt,
        now,
      )),
    );
  }
  if (REFUND_EVENT_TYPES.has(event.type)) {
    statements.push(
      ...refundUpdateStatements(env.BILLING_DB, organizationId, providerAccountCode, event, now),
    );
  }
  if (WALLET_FUNDING_EVENT_TYPES.has(event.type)) {
    statements.push(
      ...(await walletFundingStatements(
        env.BILLING_DB,
        organizationId,
        providerAccountCode,
        event,
        now,
      )),
    );
  }

  try {
    await env.BILLING_DB.batch(statements);
  } catch (error) {
    const concurrent = await env.BILLING_DB.prepare(
      `SELECT payload_sha256 FROM webhook_receipts
       WHERE provider = 'stripe' AND provider_account_code = ? AND provider_event_id = ?`,
    )
      .bind(providerAccountCode, event.id)
      .first<{ payload_sha256: string }>();
    if (concurrent?.payload_sha256 === payloadHash) {
      return json({ received: true, replayed: true }, { requestId });
    }
    await env.BILLING_ARTIFACTS.delete(archiveKey);
    if (concurrent) {
      throw new ApiError(
        409,
        "webhook_event_conflict",
        "Webhook event ID was reused with different content",
      );
    }
    throw error;
  }
  return json({ received: true, replayed: false }, { requestId });
}

async function walletFundingStatements(
  database: D1Database,
  organizationId: string,
  providerAccountCode: string,
  event: StripeEvent,
  now: string,
): Promise<D1PreparedStatement[]> {
  const intent = event.data.object;
  const providerPaymentIntentId = requiredText(intent.id, "payment_intent.id");
  const metadata = recordValue(intent.metadata);
  const walletTransactionId = optionalText(metadata.lago_wallet_transaction_id);
  const operation = await database
    .prepare(
      `SELECT id, wallet_id, wallet_transaction_id FROM provider_wallet_funding_operations
       WHERE organization_id = ? AND provider = 'stripe' AND provider_account_code = ?
         AND (provider_payment_intent_id = ? OR (? IS NOT NULL AND wallet_transaction_id = ?))
       LIMIT 1`,
    )
    .bind(
      organizationId,
      providerAccountCode,
      providerPaymentIntentId,
      walletTransactionId,
      walletTransactionId,
    )
    .first<{ id: string; wallet_id: string; wallet_transaction_id: string }>();
  if (!operation) return [];
  const status =
    event.type === "payment_intent.succeeded"
      ? "succeeded"
      : event.type === "payment_intent.processing"
        ? "processing"
        : event.type === "payment_intent.canceled"
          ? "canceled"
          : "failed";
  const failed = status === "failed" || status === "canceled";
  const lastError = recordValue(intent.last_payment_error);
  return [
    database
      .prepare(
        `UPDATE provider_wallet_funding_operations
         SET provider_payment_intent_id = COALESCE(provider_payment_intent_id, ?), status = ?,
             client_secret = COALESCE(?, client_secret), failure_code = ?, failure_message = ?,
             updated_at = ? WHERE id = ?`,
      )
      .bind(
        providerPaymentIntentId,
        status,
        optionalText(intent.client_secret),
        optionalText(lastError.code),
        optionalText(lastError.message),
        now,
        operation.id,
      ),
    database
      .prepare(
        `UPDATE wallets SET balance_minor = balance_minor + (
           SELECT amount_minor FROM provider_wallet_funding_operations WHERE id = ?
         ), ongoing_balance_minor = ongoing_balance_minor + (
           SELECT amount_minor FROM provider_wallet_funding_operations WHERE id = ?
         ), version = version + 1, updated_at = ?
         WHERE id = ? AND ? = 1 AND EXISTS (
           SELECT 1 FROM wallet_transactions WHERE id = ? AND status = 'pending'
         )`,
      )
      .bind(
        operation.id,
        operation.id,
        now,
        operation.wallet_id,
        status === "succeeded" ? 1 : 0,
        operation.wallet_transaction_id,
      ),
    database
      .prepare(
        `UPDATE wallet_transactions
         SET status = CASE WHEN ? = 1 THEN 'settled' WHEN ? = 1 THEN 'failed' ELSE status END,
             settled_at = CASE WHEN ? = 1 THEN ? ELSE settled_at END,
             failed_at = CASE WHEN ? = 1 THEN ? ELSE failed_at END,
             updated_at = ?
         WHERE id = ? AND status = 'pending'`,
      )
      .bind(
        status === "succeeded" ? 1 : 0,
        failed ? 1 : 0,
        status === "succeeded" ? 1 : 0,
        now,
        failed ? 1 : 0,
        now,
        now,
        operation.wallet_transaction_id,
      ),
  ];
}

export async function validStripeSignature(
  rawBody: string,
  header: string,
  signingSecret: string,
  nowMs: number = Date.now(),
): Promise<boolean> {
  const parts = header.split(",").map((part) => part.trim());
  const timestampText = parts.find((part) => part.startsWith("t="))?.slice(2);
  const signatures = parts
    .filter((part) => part.startsWith("v1="))
    .map((part) => part.slice(3).toLowerCase())
    .filter((value) => /^[0-9a-f]{64}$/.test(value));
  if (!timestampText || !/^\d+$/.test(timestampText)) return false;
  const timestamp = Number.parseInt(timestampText, 10);
  if (!Number.isSafeInteger(timestamp) || signatures.length === 0) return false;
  const nowSeconds = Math.floor(nowMs / 1000);
  if (Math.abs(nowSeconds - timestamp) > SIGNATURE_TOLERANCE_SECONDS) return false;
  const expected = await hmacSha256Hex(signingSecret, `${timestamp}.${rawBody}`);
  for (const candidate of signatures) {
    if (await constantTimeEqual(candidate, expected)) return true;
  }
  return false;
}

async function disputeStatements(
  database: D1Database,
  organizationId: string,
  providerAccountCode: string,
  event: StripeEvent,
  eventCreatedAt: string,
  now: string,
): Promise<D1PreparedStatement[]> {
  const dispute = event.data.object;
  const providerDisputeId = requiredText(dispute.id, "dispute.id");
  const amount = requiredNonNegativeInteger(dispute.amount, "dispute.amount");
  const currency = requiredText(dispute.currency, "dispute.currency").toUpperCase();
  const status = requiredText(dispute.status, "dispute.status");
  if (!DISPUTE_STATUSES.has(status)) {
    throw new ApiError(
      422,
      "unsupported_stripe_dispute_status",
      "Stripe dispute status is unknown",
    );
  }
  const paymentIntentId = optionalIdentifier(dispute.payment_intent);
  const chargeId = optionalIdentifier(dispute.charge);
  const payment = await findPaymentAttempt(
    database,
    organizationId,
    providerAccountCode,
    paymentIntentId,
    chargeId,
  );
  const evidenceDetails = recordValue(dispute.evidence_details);
  const evidenceDueBy = optionalUnixSecondsIso(evidenceDetails.due_by);
  const providerCreatedAt = optionalUnixSecondsIso(dispute.created) ?? eventCreatedAt;
  const disputeId = await deterministicUuid(
    "payment-dispute",
    `stripe:${providerAccountCode}:${providerDisputeId}`,
  );
  const statements = [
    database
      .prepare(
        `INSERT INTO payment_disputes
         (id, organization_id, provider, provider_account_code, provider_dispute_id,
          payment_attempt_id, invoice_id, provider_payment_intent_id, provider_charge_id,
          amount_minor, currency, reason, status, evidence_due_by, livemode,
          provider_created_at, last_provider_event_created_at, created_at, updated_at)
         VALUES (?, ?, 'stripe', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(provider, provider_account_code, provider_dispute_id) DO UPDATE SET
           payment_attempt_id = COALESCE(excluded.payment_attempt_id, payment_disputes.payment_attempt_id),
           invoice_id = COALESCE(excluded.invoice_id, payment_disputes.invoice_id),
           provider_payment_intent_id = COALESCE(excluded.provider_payment_intent_id,
             payment_disputes.provider_payment_intent_id),
           provider_charge_id = COALESCE(excluded.provider_charge_id,
             payment_disputes.provider_charge_id),
           amount_minor = excluded.amount_minor,
           currency = excluded.currency,
           reason = excluded.reason,
           status = excluded.status,
           evidence_due_by = excluded.evidence_due_by,
           last_provider_event_created_at = excluded.last_provider_event_created_at,
           updated_at = excluded.updated_at
         WHERE excluded.organization_id = payment_disputes.organization_id
           AND excluded.last_provider_event_created_at >=
             payment_disputes.last_provider_event_created_at`,
      )
      .bind(
        disputeId,
        organizationId,
        providerAccountCode,
        providerDisputeId,
        payment?.id ?? null,
        payment?.invoice_id ?? null,
        paymentIntentId,
        chargeId,
        amount,
        currency,
        optionalText(dispute.reason),
        status,
        evidenceDueBy,
        event.livemode ? 1 : 0,
        providerCreatedAt,
        eventCreatedAt,
        now,
        now,
      ),
  ];
  if (status === "lost" && payment?.invoice_id) {
    statements.push(
      database
        .prepare(
          `UPDATE invoices
           SET payment_dispute_lost_at = COALESCE(payment_dispute_lost_at, ?),
               version = version + CASE WHEN payment_dispute_lost_at IS NULL THEN 1 ELSE 0 END,
               updated_at = CASE WHEN payment_dispute_lost_at IS NULL THEN ? ELSE updated_at END
           WHERE id = ? AND organization_id = ?`,
        )
        .bind(eventCreatedAt, now, payment.invoice_id, organizationId),
    );
  }
  return statements;
}

function refundUpdateStatements(
  database: D1Database,
  organizationId: string,
  providerAccountCode: string,
  event: StripeEvent,
  now: string,
): D1PreparedStatement[] {
  const refund = event.data.object;
  const providerRefundId = requiredText(refund.id, "refund.id");
  const status = normalizeRefundStatus(optionalText(refund.status));
  const failureReason = optionalText(refund.failure_reason);
  const financialStatus =
    status === "succeeded"
      ? "succeeded"
      : status === "failed" || status === "canceled"
        ? "failed"
        : "pending";
  return [
    database
      .prepare(
        `UPDATE provider_refund_operations
       SET status = ?, failure_code = ?, failure_message = ?, updated_at = ?
       WHERE organization_id = ? AND provider = 'stripe' AND provider_account_code = ?
         AND provider_refund_id = ?`,
      )
      .bind(
        status,
        failureReason,
        failureReason,
        now,
        organizationId,
        providerAccountCode,
        providerRefundId,
      ),
    database
      .prepare(
        `UPDATE credit_note_refunds
         SET status = ?, failure_message = ?, updated_at = ?
         WHERE organization_id = ? AND credit_note_id = (
           SELECT credit_note_id FROM provider_refund_operations
           WHERE organization_id = ? AND provider = 'stripe' AND provider_account_code = ?
             AND provider_refund_id = ?
         )`,
      )
      .bind(
        status,
        failureReason,
        now,
        organizationId,
        organizationId,
        providerAccountCode,
        providerRefundId,
      ),
    database
      .prepare(
        `UPDATE credit_note_financials SET refund_status = ?
         WHERE organization_id = ? AND credit_note_id = (
           SELECT credit_note_id FROM provider_refund_operations
           WHERE organization_id = ? AND provider = 'stripe' AND provider_account_code = ?
             AND provider_refund_id = ?
         )`,
      )
      .bind(financialStatus, organizationId, organizationId, providerAccountCode, providerRefundId),
  ];
}

async function findPaymentAttempt(
  database: D1Database,
  organizationId: string,
  providerAccountCode: string,
  paymentIntentId: string | null,
  chargeId: string | null,
): Promise<{ id: string; invoice_id: string } | null> {
  const identifiers = [paymentIntentId, chargeId].filter((value): value is string => !!value);
  if (identifiers.length === 0) return null;
  const placeholders = identifiers.map(() => "?").join(", ");
  return database
    .prepare(
      `SELECT id, invoice_id FROM payment_attempts
       WHERE organization_id = ? AND provider = 'stripe' AND provider_account_code = ?
         AND provider_transaction_id IN (${placeholders})
       ORDER BY updated_at DESC LIMIT 1`,
    )
    .bind(organizationId, providerAccountCode, ...identifiers)
    .first<{ id: string; invoice_id: string }>();
}

function parseStripeEvent(rawBody: string): StripeEvent {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody) as unknown;
  } catch {
    throw new ApiError(400, "invalid_json", "Webhook body is not valid JSON");
  }
  const event = recordValue(parsed);
  const data = recordValue(event.data);
  const object = recordValue(data.object);
  const id = requiredText(event.id, "event.id");
  const type = requiredText(event.type, "event.type");
  const created = requiredNonNegativeInteger(event.created, "event.created");
  if (typeof event.livemode !== "boolean") {
    throw new ApiError(422, "invalid_stripe_event", "event.livemode must be boolean");
  }
  return { id, type, created, livemode: event.livemode, data: { object } };
}

function providerObjectId(object: Record<string, unknown>): string | null {
  return optionalIdentifier(object.payment_intent) ?? optionalIdentifier(object.id);
}

function normalizedEventStatus(event: StripeEvent): string | null {
  return optionalText(event.data.object.status);
}

function normalizeRefundStatus(value: string | null): string {
  if (
    value === "pending" ||
    value === "requires_action" ||
    value === "succeeded" ||
    value === "failed" ||
    value === "canceled"
  )
    return value;
  return "pending";
}

function recordValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function requiredText(value: unknown, name: string): string {
  const normalized = optionalText(value);
  if (!normalized || normalized.length > 255) {
    throw new ApiError(422, "invalid_stripe_event", `${name} is invalid`);
  }
  return normalized;
}

function optionalText(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function optionalIdentifier(value: unknown): string | null {
  const normalized = optionalText(value);
  return normalized && normalized.length <= 255 ? normalized : null;
}

function requiredNonNegativeInteger(value: unknown, name: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    throw new ApiError(422, "invalid_stripe_event", `${name} must be a non-negative integer`);
  }
  return Number(value);
}

function optionalUnixSecondsIso(value: unknown): string | null {
  return Number.isSafeInteger(value) && Number(value) >= 0
    ? unixSecondsIso(Number(value), "timestamp")
    : null;
}

function unixSecondsIso(value: number, name: string): string {
  const date = new Date(value * 1000);
  if (!Number.isFinite(date.getTime())) {
    throw new ApiError(422, "invalid_stripe_event", `${name} is invalid`);
  }
  return date.toISOString();
}

async function hmacSha256Hex(secret: string, signedPayload: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const digest = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(signedPayload));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function constantTimeEqual(left: string, right: string): Promise<boolean> {
  const [leftDigest, rightDigest] = await Promise.all([
    crypto.subtle.digest("SHA-256", new TextEncoder().encode(left)),
    crypto.subtle.digest("SHA-256", new TextEncoder().encode(right)),
  ]);
  return crypto.subtle.timingSafeEqual(leftDigest, rightDigest);
}
