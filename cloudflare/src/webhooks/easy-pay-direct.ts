import { sha256Hex } from "../auth/api-key";
import { ApiError, json, readBoundedText } from "../http";

type EasyPayDirectWebhook = {
  id?: string;
  object?: string;
  type?: string;
  created?: number;
  livemode?: boolean;
  data?: {
    object?: {
      id?: string;
      object?: string;
      status?: string;
      metadata?: Record<string, string>;
      total?: number;
      currency?: string;
      failure_reason?: string | null;
    };
  };
};

export async function handleEasyPayDirectWebhook(
  request: Request,
  env: Env,
  organizationId: string,
  requestId: string,
): Promise<Response> {
  const signature = request.headers.get("EPD-Signature")?.trim();
  if (!signature) {
    throw new ApiError(401, "webhook_signature_missing", "Webhook signature is required");
  }
  const signingKey = env.EASY_PAY_DIRECT_WEBHOOK_SIGNING_KEY?.trim();
  const previousSigningKey = env.EASY_PAY_DIRECT_WEBHOOK_SIGNING_KEY_PREVIOUS?.trim();
  if (!signingKey) {
    throw new ApiError(
      503,
      "provider_not_configured",
      "Easy Pay Direct webhook signing key is not configured",
    );
  }
  const providerAccountCode = env.EASY_PAY_DIRECT_ACCOUNT_CODE?.trim();
  const mappedOrganizationId = env.EASY_PAY_DIRECT_ORGANIZATION_ID?.trim();
  if (!providerAccountCode || !mappedOrganizationId || mappedOrganizationId !== organizationId) {
    throw new ApiError(
      503,
      "provider_mapping_invalid",
      "Easy Pay Direct account and organization mapping is not configured",
    );
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
  if (
    !(await validEasyPayDirectSignatureForAnyKey(
      rawBody,
      signature,
      previousSigningKey ? [signingKey, previousSigningKey] : [signingKey],
    ))
  ) {
    throw new ApiError(401, "webhook_signature_invalid", "Webhook signature is invalid");
  }

  let event: EasyPayDirectWebhook;
  try {
    event = JSON.parse(rawBody) as EasyPayDirectWebhook;
  } catch {
    throw new ApiError(400, "invalid_json", "Webhook body is not valid JSON");
  }
  if (typeof event.livemode !== "boolean") {
    throw new ApiError(400, "webhook_livemode_missing", "Webhook livemode is required");
  }
  const expectsLive = env.EASY_PAY_DIRECT_NETWORK_MODE === "production";
  if (
    env.EASY_PAY_DIRECT_NETWORK_MODE !== "test" &&
    env.EASY_PAY_DIRECT_NETWORK_MODE !== "production"
  ) {
    throw new ApiError(
      503,
      "easy_pay_direct_network_disabled",
      "Easy Pay Direct network access is disabled",
    );
  }
  if (event.livemode !== expectsLive) {
    throw new ApiError(
      409,
      "webhook_environment_mismatch",
      "Webhook environment does not match the configured Easy Pay Direct mode",
    );
  }
  if (expectsLive && env.EASY_PAY_DIRECT_LIVEMODE_ALLOWED !== "1") {
    throw new ApiError(
      503,
      "easy_pay_direct_livemode_forbidden",
      "Easy Pay Direct live mode is disabled",
    );
  }
  const payloadHash = await sha256Hex(rawBody);
  const providerEventId = event.id?.trim() || payloadHash;
  const eventType = event.type?.trim() || "unknown";
  const providerTransactionId = event.data?.object?.id?.trim() || null;
  const receiptId = `epd_${providerEventId}`;
  const receivedAt = new Date().toISOString();
  const archiveKey = `webhooks/easy-pay-direct/${organizationId}/${receivedAt.slice(0, 10)}/${encodeURIComponent(providerEventId)}.json`;

  const existing = await env.BILLING_DB.prepare(
    `SELECT id, payload_sha256 FROM webhook_receipts
     WHERE provider = 'easy_pay_direct' AND provider_account_code = ? AND provider_event_id = ?`,
  )
    .bind(providerAccountCode, providerEventId)
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

  await env.BILLING_ARTIFACTS.put(archiveKey, rawBody, {
    httpMetadata: { contentType: "application/json" },
    customMetadata: {
      provider: "easy_pay_direct",
      organizationId,
      providerEventId,
      payloadSha256: payloadHash,
    },
  });
  try {
    await env.BILLING_DB.batch([
      env.BILLING_DB.prepare(
        `INSERT INTO webhook_receipts
         (id, provider, provider_account_code, provider_event_id, signature_valid,
          payload_sha256, received_at, processed_at, processing_error_code, archive_key)
         VALUES (?, 'easy_pay_direct', ?, ?, 1, ?, ?, NULL, NULL, ?)`,
      ).bind(receiptId, providerAccountCode, providerEventId, payloadHash, receivedAt, archiveKey),
      env.BILLING_DB.prepare(
        `INSERT INTO provider_webhook_events
         (receipt_id, organization_id, event_type, provider_transaction_id,
          invoice_id, normalized_status, normalized_at)
         VALUES (?, ?, ?, ?, NULL, NULL, NULL)`,
      ).bind(receiptId, organizationId, eventType, providerTransactionId),
    ]);
  } catch (error) {
    await env.BILLING_ARTIFACTS.delete(archiveKey);
    throw error;
  }

  await env.DOMAIN_EVENTS.send({
    id: `event_${receiptId}`,
    type: "easy_pay_direct.webhook.received",
    version: 1,
    aggregateType: "provider_webhook",
    aggregateId: receiptId,
    aggregateVersion: 1,
    occurredAt: receivedAt,
    causationId: null,
    correlationId: requestId,
    payload: { receiptId, organizationId, eventType, providerTransactionId },
  });
  return json({ received: true, replayed: false }, { requestId });
}

export async function validEasyPayDirectSignature(
  rawBody: string,
  providedSignature: string,
  signingKey: string,
  now = Date.now(),
): Promise<boolean> {
  const match = providedSignature.match(/^t=(\d{1,12}),v1=([0-9a-f]{64})$/i);
  if (!match?.[1] || !match[2]) return false;
  const timestamp = Number.parseInt(match[1], 10);
  if (!Number.isSafeInteger(timestamp) || Math.abs(Math.floor(now / 1000) - timestamp) > 300) {
    return false;
  }
  const expected = await hmacSha256Hex(signingKey, `${timestamp}.${rawBody}`);
  return constantTimeEqual(match[2].toLowerCase(), expected);
}

export async function validEasyPayDirectSignatureForAnyKey(
  rawBody: string,
  providedSignature: string,
  signingKeys: string[],
  now = Date.now(),
): Promise<boolean> {
  for (const signingKey of signingKeys) {
    if (
      signingKey &&
      (await validEasyPayDirectSignature(rawBody, providedSignature, signingKey, now))
    ) {
      return true;
    }
  }
  return false;
}

async function hmacSha256Hex(secret: string, value: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(value));
  return [...new Uint8Array(signature)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function constantTimeEqual(left: string, right: string): Promise<boolean> {
  const [leftDigest, rightDigest] = await Promise.all([
    crypto.subtle.digest("SHA-256", new TextEncoder().encode(left)),
    crypto.subtle.digest("SHA-256", new TextEncoder().encode(right)),
  ]);
  return crypto.subtle.timingSafeEqual(leftDigest, rightDigest);
}
