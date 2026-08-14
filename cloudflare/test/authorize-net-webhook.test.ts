import {
  createExecutionContext,
  createMessageBatch,
  env,
  getQueueResult,
  SELF,
} from "cloudflare:test";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { validAuthorizeNetSignature } from "../src/webhooks/authorize-net";
import worker from "../src/index";
import { reconcileAuthorizeNetReceipt } from "../src/reconciliation/authorize-net";

const signatureKey = "0123456789abcdef".repeat(8);

beforeEach(async () => {
  const now = new Date().toISOString();
  await env.BILLING_DB.prepare(
    `INSERT OR IGNORE INTO organizations (id, external_id, name, created_at, updated_at)
     VALUES ('org-webhook', 'webhook-test', 'Webhook Test', ?, ?)`,
  )
    .bind(now, now)
    .run();
});

describe("Authorize.Net webhooks", () => {
  it("supports the hex signature-key behavior used by Lago", async () => {
    const body = JSON.stringify({
      notificationId: "notification-1",
      eventType: "net.authorize.payment.authcapture.created",
    });
    const signature = await signatureFor(hexToBytes(signatureKey), body);
    await expect(validAuthorizeNetSignature(body, signature, signatureKey)).resolves.toBe(true);
    await expect(validAuthorizeNetSignature(`${body} `, signature, signatureKey)).resolves.toBe(
      false,
    );
  });

  it("persists and safely replays a signed event without exposing its body", async () => {
    const body = JSON.stringify({
      notificationId: "notification-2",
      eventType: "net.authorize.payment.authcapture.created",
      eventDate: "2026-08-12T00:00:00Z",
      payload: { id: "synthetic-transaction", authAmount: 19.99 },
    });
    const signature = await signatureFor(hexToBytes(signatureKey), body);
    const headers = { "Content-Type": "application/json", "X-ANET-Signature": signature };

    const first = await SELF.fetch("https://lago.test/webhooks/authorize_net/org-webhook", {
      method: "POST",
      headers,
      body,
    });
    expect(first.status).toBe(200);
    await expect(first.json()).resolves.toEqual({ received: true, replayed: false });

    const replay = await SELF.fetch("https://lago.test/webhooks/authorize_net/org-webhook", {
      method: "POST",
      headers,
      body,
    });
    expect(replay.status).toBe(200);
    await expect(replay.json()).resolves.toEqual({ received: true, replayed: true });

    const receipt = await env.BILLING_DB.prepare(
      `SELECT signature_valid, payload_sha256, archive_key FROM webhook_receipts
       WHERE provider_event_id = 'notification-2'`,
    ).first<{ signature_valid: number; payload_sha256: string; archive_key: string }>();
    expect(receipt).toMatchObject({ signature_valid: 1 });
    expect(receipt?.payload_sha256).toMatch(/^[0-9a-f]{64}$/);
    const archived = receipt ? await env.BILLING_ARTIFACTS.get(receipt.archive_key) : null;
    expect(await archived?.text()).toBe(body);
  });

  it("rejects an invalid signature before persistence", async () => {
    const response = await SELF.fetch("https://lago.test/webhooks/authorize_net/org-webhook", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-ANET-Signature": `sha512=${"0".repeat(128)}`,
      },
      body: JSON.stringify({ notificationId: "notification-invalid" }),
    });
    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toMatchObject({ code: "webhook_signature_invalid" });
  });

  it("normalizes a provider transaction exactly once across queue replay", async () => {
    const now = new Date().toISOString();
    await env.BILLING_DB.batch([
      env.BILLING_DB.prepare(
        `INSERT INTO customers
         (id, organization_id, external_id, email, name, currency, metadata_json,
          payment_provider, payment_provider_code, created_at, updated_at)
         VALUES ('customer-webhook', 'org-webhook', 'customer-webhook', NULL, 'Synthetic', 'USD', '{}',
                 'authorize_net', 'org-webhook', ?, ?)`,
      ).bind(now, now),
      env.BILLING_DB.prepare(
        `INSERT INTO invoices
         (id, organization_id, customer_id, subscription_id, number, status, payment_status,
          currency, subtotal_minor, tax_minor, credits_minor, total_due_minor, version,
          finalized_at, created_at, updated_at)
         VALUES ('invoice-webhook', 'org-webhook', 'customer-webhook', NULL, 'INV-WEBHOOK',
                 'finalized', 'pending', 'USD', 1999, 0, 0, 1999, 1, ?, ?, ?)`,
      ).bind(now, now, now),
    ]);

    const body = JSON.stringify({
      notificationId: "notification-reconcile",
      eventType: "net.authorize.payment.authcapture.created",
      payload: { id: "transaction-reconcile", authAmount: 19.99 },
    });
    const signature = await signatureFor(hexToBytes(signatureKey), body);
    const receiptResponse = await SELF.fetch(
      "https://lago.test/webhooks/authorize_net/org-webhook",
      {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-ANET-Signature": signature },
        body,
      },
    );
    expect(receiptResponse.status).toBe(200);

    const providerFetch = vi.fn<typeof fetch>(async () =>
      Response.json({
        transaction: {
          transId: "transaction-reconcile",
          transactionStatus: "settledSuccessfully",
          authAmount: "19.99",
          order: { invoiceNumber: "INV-WEBHOOK" },
          userFields: {
            userField: [{ name: "lago_invoice_id", value: "invoice-webhook" }],
          },
        },
        messages: { resultCode: "Ok" },
      }),
    );

    const event = {
      id: "event_anet_notification-reconcile",
      type: "authorize_net.webhook.received",
      version: 1,
      aggregateType: "provider_webhook",
      aggregateId: "anet_notification-reconcile",
      aggregateVersion: 1,
      occurredAt: now,
      causationId: null,
      correlationId: "request-reconcile",
      payload: {},
    };
    await expect(
      reconcileAuthorizeNetReceipt(env, "anet_notification-reconcile", providerFetch),
    ).resolves.toBe("processed");
    expect(providerFetch).toHaveBeenCalledOnce();
    const firstResult = await dispatchQueue(event);
    expect(firstResult).toMatchObject({ ackAll: false, outcome: "ok" });
    expect(firstResult.retryMessages).toEqual([]);

    const invoice = await env.BILLING_DB.prepare(
      `SELECT payment_status, version FROM invoices WHERE id = 'invoice-webhook'`,
    ).first<{ payment_status: string; version: number }>();
    expect(invoice).toEqual({ payment_status: "succeeded", version: 2 });
    const attemptCount = await env.BILLING_DB.prepare(
      `SELECT COUNT(*) AS count FROM payment_attempts WHERE provider_transaction_id = 'transaction-reconcile'`,
    ).first<{ count: number }>();
    expect(attemptCount?.count).toBe(1);
    const payments = await SELF.fetch("https://lago.test/api/v1/payments", {
      headers: await authorization(),
    });
    expect(payments.status).toBe(200);
    const paymentsBody = await payments.json<{
      payments: Array<{ lago_id: string; provider_payment_id: string; payment_status: string }>;
    }>();
    expect(paymentsBody.payments).toEqual([
      expect.objectContaining({
        provider_payment_id: "transaction-reconcile",
        payment_status: "succeeded",
      }),
    ]);
    const shown = await SELF.fetch(
      `https://lago.test/api/v1/payments/${paymentsBody.payments[0]?.lago_id}`,
      { headers: await authorization() },
    );
    expect(shown.status).toBe(200);
    await expect(shown.json()).resolves.toMatchObject({
      payment: {
        external_customer_id: "customer-webhook",
        invoice_ids: ["invoice-webhook"],
        payment_provider_type: "PaymentProviders::AuthorizeNetProvider",
        type: "provider",
      },
    });
    const eventTypes = await env.BILLING_DB.prepare(
      `SELECT event_type FROM outbox_events
       WHERE aggregate_id IN ('invoice-webhook', ?) ORDER BY event_type`,
    )
      .bind(paymentsBody.payments[0]?.lago_id)
      .all<{ event_type: string }>();
    expect(eventTypes.results).toEqual([
      { event_type: "invoice.payment_status_updated" },
      { event_type: "payment.succeeded" },
    ]);

    const replayResult = await dispatchQueue(event);
    expect(replayResult.retryMessages).toEqual([]);
    const replayInvoice = await env.BILLING_DB.prepare(
      `SELECT payment_status, version FROM invoices WHERE id = 'invoice-webhook'`,
    ).first<{ payment_status: string; version: number }>();
    expect(replayInvoice).toEqual({ payment_status: "succeeded", version: 2 });

    const regressionBody = JSON.stringify({
      notificationId: "notification-reconcile-regression",
      eventType: "net.authorize.payment.fraud.declined",
      payload: { id: "transaction-reconcile", authAmount: 19.99 },
    });
    const regressionSignature = await signatureFor(hexToBytes(signatureKey), regressionBody);
    const regressionReceipt = await SELF.fetch(
      "https://lago.test/webhooks/authorize_net/org-webhook",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-ANET-Signature": regressionSignature,
        },
        body: regressionBody,
      },
    );
    expect(regressionReceipt.status).toBe(200);
    const declinedFetch = vi.fn<typeof fetch>(async () =>
      Response.json({
        transaction: {
          transId: "transaction-reconcile",
          transactionStatus: "declined",
          authAmount: "19.99",
          order: { invoiceNumber: "INV-WEBHOOK" },
          userFields: {
            userField: [{ name: "lago_invoice_id", value: "invoice-webhook" }],
          },
          responseReasonCode: "2",
          responseReasonDescription: "Synthetic decline after settlement",
        },
        messages: { resultCode: "Ok" },
      }),
    );
    await expect(
      reconcileAuthorizeNetReceipt(env, "anet_notification-reconcile-regression", declinedFetch),
    ).resolves.toBe("processed");
    await expect(
      env.BILLING_DB.prepare(
        `SELECT status, version FROM payment_attempts
         WHERE provider_transaction_id = 'transaction-reconcile'`,
      ).first(),
    ).resolves.toEqual({ status: "succeeded", version: 1 });
    await expect(
      env.BILLING_DB.prepare(
        `SELECT payment_status, version FROM invoices WHERE id = 'invoice-webhook'`,
      ).first(),
    ).resolves.toEqual({ payment_status: "succeeded", version: 2 });
  });
});

async function authorization(): Promise<Record<string, string>> {
  const apiKey = "webhook-test-api-key";
  const now = new Date().toISOString();
  const { sha256Hex } = await import("../src/auth/api-key");
  await env.BILLING_DB.prepare(
    `INSERT OR IGNORE INTO api_keys
     (id, organization_id, key_prefix, key_hash, created_at, revoked_at)
     VALUES ('key-webhook', 'org-webhook', 'webhook-test', ?, ?, NULL)`,
  )
    .bind(await sha256Hex(apiKey), now)
    .run();
  return { Authorization: `Bearer ${apiKey}` };
}

async function dispatchQueue(event: Record<string, unknown>) {
  const batch = createMessageBatch("serp-dev-lago-domain-events", [
    { id: "message-1", timestamp: new Date(), body: event, attempts: 1 },
  ]);
  const context = createExecutionContext();
  await worker.queue(batch, env);
  return getQueueResult(batch, context);
}

async function signatureFor(keyBytes: Uint8Array, body: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    keyBytes,
    { name: "HMAC", hash: "SHA-512" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body));
  const hex = [...new Uint8Array(signature)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  return `sha512=${hex}`;
}

function hexToBytes(value: string): Uint8Array {
  return Uint8Array.from(value.match(/.{2}/g)?.map((byte) => Number.parseInt(byte, 16)) ?? []);
}
