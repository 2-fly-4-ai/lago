import { sha256Hex } from "../auth/api-key";
import { ApiError, json, readBoundedText } from "../http";

type AuthorizeNetEvent = {
  notificationId?: string;
  eventType?: string;
  eventDate?: string;
  payload?: {
    id?: string;
    responseCode?: number;
    authCode?: string;
    avsResponse?: string;
    authAmount?: number;
    entityName?: string;
  };
};

export async function handleAuthorizeNetWebhook(
  request: Request,
  env: Env,
  organizationId: string,
  requestId: string,
): Promise<Response> {
  const signature = request.headers.get("X-ANET-Signature")?.trim();
  if (!signature)
    throw new ApiError(401, "webhook_signature_missing", "Webhook signature is required");

  const organization = await env.BILLING_DB.prepare(
    "SELECT id FROM organizations WHERE id = ? LIMIT 1",
  )
    .bind(organizationId)
    .first<{ id: string }>();
  if (!organization)
    throw new ApiError(404, "organization_not_found", "Organization was not found");

  const rawBody = await readBoundedText(request, 1024 * 1024);
  if (!rawBody) throw new ApiError(400, "webhook_body_missing", "Webhook body is required");
  const signatureKey = env.AUTHORIZE_NET_SIGNATURE_KEY?.trim();
  if (!signatureKey)
    throw new ApiError(
      503,
      "provider_not_configured",
      "Authorize.Net signature key is not configured",
    );
  if (!(await validAuthorizeNetSignature(rawBody, signature, signatureKey))) {
    throw new ApiError(401, "webhook_signature_invalid", "Webhook signature is invalid");
  }

  let event: AuthorizeNetEvent;
  try {
    event = JSON.parse(rawBody) as AuthorizeNetEvent;
  } catch {
    throw new ApiError(400, "invalid_json", "Webhook body is not valid JSON");
  }

  const payloadHash = await sha256Hex(rawBody);
  const providerEventId = event.notificationId?.trim() || payloadHash;
  const eventType = event.eventType?.trim() || "unknown";
  const providerTransactionId = event.payload?.id?.trim() || null;
  const receiptId = `anet_${providerEventId}`;
  const receivedAt = new Date().toISOString();
  const archiveKey = `webhooks/authorize-net/${organizationId}/${receivedAt.slice(0, 10)}/${encodeURIComponent(providerEventId)}.json`;

  const existing = await env.BILLING_DB.prepare(
    `SELECT id, payload_sha256 FROM webhook_receipts
     WHERE provider = 'authorize_net' AND provider_account_code = ? AND provider_event_id = ?`,
  )
    .bind(organizationId, providerEventId)
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
      provider: "authorize_net",
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
         VALUES (?, 'authorize_net', ?, ?, 1, ?, ?, NULL, NULL, ?)`,
      ).bind(receiptId, organizationId, providerEventId, payloadHash, receivedAt, archiveKey),
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
    type: "authorize_net.webhook.received",
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

export async function validAuthorizeNetSignature(
  rawBody: string,
  providedSignature: string,
  signatureKey: string,
): Promise<boolean> {
  const normalized = providedSignature.trim().toLowerCase();
  if (!/^sha512=[0-9a-f]{128}$/.test(normalized)) return false;

  const expectedRaw = `sha512=${await hmacSha512Hex(new TextEncoder().encode(signatureKey), rawBody)}`;
  if (await constantTimeEqual(normalized, expectedRaw)) return true;

  const decoded = decodeHex(signatureKey);
  if (!decoded) return false;
  const expectedHex = `sha512=${await hmacSha512Hex(decoded, rawBody)}`;
  return constantTimeEqual(normalized, expectedHex);
}

async function hmacSha512Hex(keyBytes: Uint8Array, body: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    keyBytes,
    { name: "HMAC", hash: "SHA-512" },
    false,
    ["sign"],
  );
  const digest = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function decodeHex(value: string): Uint8Array | null {
  if (value.length % 2 !== 0 || !/^[0-9a-f]+$/i.test(value)) return null;
  const output = new Uint8Array(value.length / 2);
  for (let index = 0; index < value.length; index += 2)
    output[index / 2] = Number.parseInt(value.slice(index, index + 2), 16);
  return output;
}

async function constantTimeEqual(left: string, right: string): Promise<boolean> {
  const [leftDigest, rightDigest] = await Promise.all([
    crypto.subtle.digest("SHA-256", new TextEncoder().encode(left)),
    crypto.subtle.digest("SHA-256", new TextEncoder().encode(right)),
  ]);
  return crypto.subtle.timingSafeEqual(leftDigest, rightDigest);
}
