import type { DomainEvent } from "../domain-events";
import { deterministicUuid } from "../identifiers";
import { stableJson } from "../json";

type EndpointRow = {
  id: string;
  organization_id: string;
  webhook_url: string;
  event_types_json: string | null;
};

type DeliveryRow = EndpointRow & {
  delivery_id: string;
  payload_json: string;
  status: string;
  attempts: number;
};
const MAX_ATTEMPTS = 5;
const MAX_RESPONSE_EXCERPT_BYTES = 2048;

export type OutboundWebhookOutcome = "disabled" | "complete" | "retry";

export async function deliverOutboundWebhooks(
  env: Env,
  event: DomainEvent,
  fetcher: typeof fetch = fetch,
): Promise<OutboundWebhookOutcome> {
  const outboundEnv = env as Omit<Env, "OUTBOUND_WEBHOOKS_ENABLED"> & {
    OUTBOUND_WEBHOOKS_ENABLED: string;
    OUTBOUND_WEBHOOK_HMAC_KEY?: string;
  };
  if (outboundEnv.OUTBOUND_WEBHOOKS_ENABLED !== "1") return "disabled";
  if (!outboundEnv.OUTBOUND_WEBHOOK_HMAC_KEY) throw new Error("outbound_webhook_hmac_key_missing");
  const organizationId = organizationIdFor(event);
  if (!organizationId) return "complete";
  const endpoints = await env.BILLING_DB.prepare(
    `SELECT id, organization_id, webhook_url, event_types_json
     FROM webhook_endpoints WHERE organization_id = ? AND status = 'active'
     ORDER BY created_at, id`,
  )
    .bind(organizationId)
    .all<EndpointRow>();
  const matching = endpoints.results.filter((endpoint) => matchesEvent(endpoint, event.type));
  if (matching.length === 0) return "complete";
  const now = new Date().toISOString();
  const payloadJson = stableJson({
    webhook_type: event.type,
    object_type: event.aggregateType,
    object_id: event.aggregateId,
    event_id: event.id,
    occurred_at: event.occurredAt,
    data: event.payload,
  });
  for (const endpoint of matching) {
    await env.BILLING_DB.prepare(
      `INSERT INTO outbound_webhook_deliveries
       (id, organization_id, webhook_endpoint_id, event_id, event_type, payload_json,
        status, attempts, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?)
       ON CONFLICT(webhook_endpoint_id, event_id) DO NOTHING`,
    )
      .bind(
        await deterministicUuid("outbound-webhook", `${endpoint.id}:${event.id}`),
        organizationId,
        endpoint.id,
        event.id,
        event.type,
        payloadJson,
        now,
        now,
      )
      .run();
  }
  const deliveries = await env.BILLING_DB.prepare(
    `SELECT d.id AS delivery_id, d.payload_json, d.status, d.attempts,
            we.id, we.organization_id, we.webhook_url, we.event_types_json
     FROM outbound_webhook_deliveries d
     JOIN webhook_endpoints we ON we.id = d.webhook_endpoint_id
     WHERE d.organization_id = ? AND d.event_id = ?
       AND d.status IN ('pending', 'retrying')
     ORDER BY d.created_at, d.id`,
  )
    .bind(organizationId, event.id)
    .all<DeliveryRow>();
  let shouldRetry = false;
  for (const delivery of deliveries.results) {
    const outcome = await deliverOne(
      env.BILLING_DB,
      delivery,
      outboundEnv.OUTBOUND_WEBHOOK_HMAC_KEY,
      fetcher,
    );
    if (outcome === "retry") shouldRetry = true;
  }
  return shouldRetry ? "retry" : "complete";
}

async function deliverOne(
  database: D1Database,
  delivery: DeliveryRow,
  masterKey: string,
  fetcher: typeof fetch,
): Promise<"complete" | "retry"> {
  const attemptedAt = new Date().toISOString();
  const attempt = delivery.attempts + 1;
  try {
    const signature = await signatureFor(
      masterKey,
      delivery.organization_id,
      delivery.payload_json,
    );
    const response = await fetcher(delivery.webhook_url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "User-Agent": "serp-lago-native-webhooks/1",
        "X-Lago-Signature": signature,
        "X-Lago-Signature-Algorithm": "hmac",
        "X-Lago-Unique-Key": delivery.delivery_id,
      },
      body: delivery.payload_json,
      redirect: "manual",
      signal: AbortSignal.timeout(10_000),
    });
    const excerpt = await readResponseExcerpt(response);
    const retryable = isRetryableStatus(response.status) && attempt < MAX_ATTEMPTS;
    const status = response.ok ? "succeeded" : retryable ? "retrying" : "failed";
    await updateDelivery(
      database,
      delivery.delivery_id,
      status,
      attempt,
      response.status,
      excerpt,
      response.ok ? null : `http_${response.status}`,
      attemptedAt,
    );
    return retryable ? "retry" : "complete";
  } catch (error) {
    const code = error instanceof Error ? error.name.slice(0, 100) : "network_error";
    const retryable = attempt < MAX_ATTEMPTS;
    await updateDelivery(
      database,
      delivery.delivery_id,
      retryable ? "retrying" : "failed",
      attempt,
      null,
      null,
      code,
      attemptedAt,
    );
    return retryable ? "retry" : "complete";
  }
}

async function readResponseExcerpt(response: Response): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let byteLength = 0;
  let ended = false;
  try {
    while (byteLength < MAX_RESPONSE_EXCERPT_BYTES) {
      const result = await reader.read();
      if (result.done) {
        ended = true;
        break;
      }
      const remaining = MAX_RESPONSE_EXCERPT_BYTES - byteLength;
      const chunk = result.value.subarray(0, remaining);
      chunks.push(chunk);
      byteLength += chunk.byteLength;
      if (result.value.byteLength > remaining) break;
    }
    if (!ended) {
      try {
        await reader.cancel("response_excerpt_complete");
      } catch {
        // The bounded excerpt is still valid if the remote stream rejects cancellation.
      }
    }
  } finally {
    reader.releaseLock();
  }
  const excerpt = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) {
    excerpt.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(excerpt);
}

function updateDelivery(
  database: D1Database,
  id: string,
  status: string,
  attempts: number,
  httpStatus: number | null,
  responseExcerpt: string | null,
  lastError: string | null,
  attemptedAt: string,
) {
  return database
    .prepare(
      `UPDATE outbound_webhook_deliveries
       SET status = ?, attempts = ?, http_status = ?, response_excerpt = ?, last_error = ?,
           last_attempted_at = ?, updated_at = ? WHERE id = ?`,
    )
    .bind(status, attempts, httpStatus, responseExcerpt, lastError, attemptedAt, attemptedAt, id)
    .run();
}

function organizationIdFor(event: DomainEvent) {
  return typeof event.payload.organizationId === "string" ? event.payload.organizationId : null;
}

function matchesEvent(endpoint: EndpointRow, eventType: string) {
  if (!endpoint.event_types_json) return true;
  try {
    const values = JSON.parse(endpoint.event_types_json) as unknown;
    return Array.isArray(values) && values.includes(eventType);
  } catch {
    return false;
  }
}

function isRetryableStatus(status: number) {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

async function signatureFor(masterKey: string, organizationId: string, payload: string) {
  const encoder = new TextEncoder();
  const imported = await crypto.subtle.importKey(
    "raw",
    encoder.encode(masterKey),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const organizationKey = await crypto.subtle.sign(
    "HMAC",
    imported,
    encoder.encode(organizationId),
  );
  const derived = await crypto.subtle.importKey(
    "raw",
    organizationKey,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", derived, encoder.encode(payload));
  let binary = "";
  for (const byte of new Uint8Array(signature)) binary += String.fromCharCode(byte);
  return btoa(binary);
}
