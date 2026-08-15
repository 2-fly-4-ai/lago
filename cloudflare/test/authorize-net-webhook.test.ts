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
          finalized_at, payment_overdue, created_at, updated_at)
         VALUES ('invoice-webhook', 'org-webhook', 'customer-webhook', NULL, 'INV-WEBHOOK',
                 'finalized', 'pending', 'USD', 1999, 0, 0, 1999, 1, ?, 1, ?, ?)`,
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
      `SELECT payment_status, payment_overdue, version FROM invoices WHERE id = 'invoice-webhook'`,
    ).first<{ payment_status: string; payment_overdue: number; version: number }>();
    expect(invoice).toEqual({ payment_status: "succeeded", payment_overdue: 0, version: 2 });
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
      `SELECT payment_status, payment_overdue, version FROM invoices WHERE id = 'invoice-webhook'`,
    ).first<{ payment_status: string; payment_overdue: number; version: number }>();
    expect(replayInvoice).toEqual({
      payment_status: "succeeded",
      payment_overdue: 0,
      version: 2,
    });

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

  it("settles a multi-invoice payment request with auditable allocations", async () => {
    const now = new Date().toISOString();
    await env.BILLING_DB.batch([
      env.BILLING_DB.prepare(
        `INSERT INTO dunning_campaigns
         (id, organization_id, code, name, days_between_attempts, max_attempts, active,
          version, request_sha256, created_at, updated_at)
         VALUES ('campaign-webhook', 'org-webhook', 'webhook', 'Webhook campaign', 2, 4, 1,
                 1, 'synthetic', ?, ?)`,
      ).bind(now, now),
      env.BILLING_DB.prepare(
        `INSERT INTO dunning_campaign_thresholds
         (id, organization_id, dunning_campaign_id, amount_minor, currency, created_at, updated_at)
         VALUES ('threshold-webhook', 'org-webhook', 'campaign-webhook', 1, 'USD', ?, ?)`,
      ).bind(now, now),
      env.BILLING_DB.prepare(
        `INSERT INTO customers
         (id, organization_id, external_id, email, name, currency, metadata_json,
          payment_provider, payment_provider_code, last_dunning_campaign_attempt,
          last_dunning_campaign_attempt_at, created_at, updated_at)
         VALUES ('customer-payment-request-webhook', 'org-webhook',
                 'customer-payment-request-webhook', 'billing@example.com', 'Synthetic', 'USD',
                 '{}', 'authorize_net', 'org-webhook', 3, ?, ?, ?)`,
      ).bind(now, now, now),
      paymentRequestInvoiceStatement(
        "invoice-payment-request-webhook-one",
        "customer-payment-request-webhook",
        "INV-PR-ONE",
        1000,
        now,
      ),
      paymentRequestInvoiceStatement(
        "invoice-payment-request-webhook-two",
        "customer-payment-request-webhook",
        "INV-PR-TWO",
        700,
        now,
      ),
      env.BILLING_DB.prepare(
        `INSERT INTO payment_requests
         (id, organization_id, customer_id, amount_minor, currency, email, payment_attempts,
          payment_status, ready_for_payment_processing, version, created_at, updated_at,
          source, dunning_campaign_id, dunning_campaign_threshold_id, dunning_attempt)
         VALUES ('payment-request-webhook', 'org-webhook', 'customer-payment-request-webhook',
                 1700, 'USD', 'billing@example.com', 0, 'pending', 1, 1, ?, ?, 'dunning',
                 'campaign-webhook', 'threshold-webhook', 3)`,
      ).bind(now, now),
      paymentRequestLinkStatement(
        "link-payment-request-webhook-one",
        "payment-request-webhook",
        "invoice-payment-request-webhook-one",
        now,
      ),
      paymentRequestLinkStatement(
        "link-payment-request-webhook-two",
        "payment-request-webhook",
        "invoice-payment-request-webhook-two",
        now,
      ),
    ]);

    const body = JSON.stringify({
      notificationId: "notification-payment-request",
      eventType: "net.authorize.payment.authcapture.created",
      payload: { id: "transaction-payment-request", authAmount: 17 },
    });
    const response = await SELF.fetch("https://lago.test/webhooks/authorize_net/org-webhook", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-ANET-Signature": await signatureFor(hexToBytes(signatureKey), body),
      },
      body,
    });
    expect(response.status).toBe(200);
    const providerFetch = vi.fn<typeof fetch>(async () =>
      Response.json({
        transaction: {
          transId: "transaction-payment-request",
          transactionStatus: "settledSuccessfully",
          authAmount: "17.00",
          userFields: {
            userField: [
              { name: "lago_payment_request_id", value: "payment-request-webhook" },
              { name: "lago_payable_id", value: "payment-request-webhook" },
              { name: "lago_payable_type", value: "PaymentRequest" },
            ],
          },
        },
        messages: { resultCode: "Ok" },
      }),
    );

    await expect(
      reconcileAuthorizeNetReceipt(env, "anet_notification-payment-request", providerFetch),
    ).resolves.toBe("processed");
    expect(providerFetch).toHaveBeenCalledOnce();
    await expect(
      env.BILLING_DB.prepare(
        `SELECT payment_attempts, payment_status, ready_for_payment_processing, version
         FROM payment_requests WHERE id = 'payment-request-webhook'`,
      ).first(),
    ).resolves.toEqual({
      payment_attempts: 1,
      payment_status: "succeeded",
      ready_for_payment_processing: 0,
      version: 2,
    });
    await expect(
      env.BILLING_DB.prepare(
        `SELECT invoice_id, amount_minor FROM payment_request_payment_allocations
         WHERE payment_request_id = 'payment-request-webhook' ORDER BY invoice_id`,
      ).all(),
    ).resolves.toMatchObject({
      results: [
        { invoice_id: "invoice-payment-request-webhook-one", amount_minor: 1000 },
        { invoice_id: "invoice-payment-request-webhook-two", amount_minor: 700 },
      ],
    });
    await expect(
      env.BILLING_DB.prepare(
        `SELECT payment_status, payment_overdue, ready_for_payment_processing, version
         FROM invoices WHERE id LIKE 'invoice-payment-request-webhook-%' ORDER BY id`,
      ).all(),
    ).resolves.toMatchObject({
      results: [
        {
          payment_status: "succeeded",
          payment_overdue: 0,
          ready_for_payment_processing: 0,
          version: 2,
        },
        {
          payment_status: "succeeded",
          payment_overdue: 0,
          ready_for_payment_processing: 0,
          version: 2,
        },
      ],
    });
    await expect(
      env.BILLING_DB.prepare(
        `SELECT last_dunning_campaign_attempt, last_dunning_campaign_attempt_at
         FROM customers WHERE id = 'customer-payment-request-webhook'`,
      ).first(),
    ).resolves.toEqual({
      last_dunning_campaign_attempt: 0,
      last_dunning_campaign_attempt_at: null,
    });
    await expect(
      env.BILLING_DB.prepare(
        `SELECT invoice_id, payment_request_id, normalized_status
         FROM provider_webhook_events WHERE receipt_id = 'anet_notification-payment-request'`,
      ).first(),
    ).resolves.toEqual({
      invoice_id: null,
      payment_request_id: "payment-request-webhook",
      normalized_status: "succeeded",
    });
    const invoiceResponse = await SELF.fetch(
      "https://lago.test/api/v1/invoices/invoice-payment-request-webhook-one",
      { headers: await authorization() },
    );
    await expect(invoiceResponse.json()).resolves.toMatchObject({
      invoice: { total_paid_amount_cents: 1000, total_due_amount_cents: 0 },
    });
    const paymentsResponse = await SELF.fetch(
      "https://lago.test/api/v1/payments?invoice_id=invoice-payment-request-webhook-two",
      { headers: await authorization() },
    );
    expect(paymentsResponse.status).toBe(200);
    const paymentsBody = await paymentsResponse.json<{
      payments: Array<{ lago_id: string }>;
    }>();
    expect(paymentsBody.payments).toHaveLength(1);
    const paymentId = paymentsBody.payments[0]?.lago_id;
    const paymentResponse = await SELF.fetch(`https://lago.test/api/v1/payments/${paymentId}`, {
      headers: await authorization(),
    });
    await expect(paymentResponse.json()).resolves.toMatchObject({
      payment: {
        lago_payable_id: "payment-request-webhook",
        payable_type: "PaymentRequest",
        invoice_ids: ["invoice-payment-request-webhook-one", "invoice-payment-request-webhook-two"],
        invoice_numbers: ["INV-PR-ONE", "INV-PR-TWO"],
        amount_cents: 1700,
        payment_status: "succeeded",
        provider_payment_id: "transaction-payment-request",
      },
    });

    await expect(
      reconcileAuthorizeNetReceipt(env, "anet_notification-payment-request", providerFetch),
    ).resolves.toBe("processed");
    expect(providerFetch).toHaveBeenCalledOnce();
    await expect(
      env.BILLING_DB.prepare(
        `SELECT COUNT(*) AS total FROM payment_request_payments
         WHERE provider_transaction_id = 'transaction-payment-request'`,
      ).first(),
    ).resolves.toEqual({ total: 1 });

    await insertSyntheticReceipt(
      "notification-payment-request-regression",
      "transaction-payment-request",
      now,
      "net.authorize.payment.fraud.declined",
    );
    const regressionFetch = vi.fn<typeof fetch>(async () =>
      Response.json({
        transaction: {
          transId: "transaction-payment-request",
          transactionStatus: "declined",
          authAmount: "17.00",
          userFields: {
            userField: [
              { name: "lago_payment_request_id", value: "payment-request-webhook" },
              { name: "lago_payable_type", value: "PaymentRequest" },
            ],
          },
          responseReasonCode: "2",
          responseReasonDescription: "Synthetic decline after settlement",
        },
        messages: { resultCode: "Ok" },
      }),
    );
    await expect(
      reconcileAuthorizeNetReceipt(
        env,
        "anet_notification-payment-request-regression",
        regressionFetch,
      ),
    ).resolves.toBe("processed");
    await expect(
      env.BILLING_DB.prepare(
        `SELECT status, version FROM payment_request_payments
         WHERE provider_transaction_id = 'transaction-payment-request'`,
      ).first(),
    ).resolves.toEqual({ status: "succeeded", version: 1 });
    await expect(
      env.BILLING_DB.prepare(
        `SELECT payment_status, version FROM payment_requests WHERE id = 'payment-request-webhook'`,
      ).first(),
    ).resolves.toEqual({ payment_status: "succeeded", version: 2 });
    await expect(
      env.BILLING_DB.prepare(
        `SELECT normalized_status FROM provider_webhook_events
         WHERE receipt_id = 'anet_notification-payment-request-regression'`,
      ).first(),
    ).resolves.toEqual({ normalized_status: "succeeded" });
  });

  it("refuses to settle a payment request after its invoice balance changes", async () => {
    const now = new Date().toISOString();
    await env.BILLING_DB.batch([
      env.BILLING_DB.prepare(
        `INSERT INTO customers
         (id, organization_id, external_id, name, currency, metadata_json, created_at, updated_at)
         VALUES ('customer-payment-request-changed', 'org-webhook',
                 'customer-payment-request-changed', 'Changed', 'USD', '{}', ?, ?)`,
      ).bind(now, now),
      paymentRequestInvoiceStatement(
        "invoice-payment-request-changed",
        "customer-payment-request-changed",
        "INV-PR-CHANGED",
        1000,
        now,
      ),
      env.BILLING_DB.prepare(
        `INSERT INTO payment_requests
         (id, organization_id, customer_id, amount_minor, currency, payment_attempts,
          payment_status, ready_for_payment_processing, version, created_at, updated_at)
         VALUES ('payment-request-changed', 'org-webhook', 'customer-payment-request-changed',
                 1000, 'USD', 0, 'pending', 1, 1, ?, ?)`,
      ).bind(now, now),
      paymentRequestLinkStatement(
        "link-payment-request-changed",
        "payment-request-changed",
        "invoice-payment-request-changed",
        now,
      ),
      env.BILLING_DB.prepare(
        `INSERT INTO payment_attempts
         (id, organization_id, invoice_id, provider, provider_account_code,
          provider_transaction_id, idempotency_key, amount_minor, currency, status,
          created_at, updated_at)
         VALUES ('partial-payment-changed', 'org-webhook', 'invoice-payment-request-changed',
                 'manual', 'manual', NULL, 'partial-payment-changed', 200, 'USD', 'succeeded', ?, ?)`,
      ).bind(now, now),
    ]);
    await insertSyntheticReceipt(
      "notification-payment-request-changed",
      "transaction-payment-request-changed",
      now,
    );
    const providerFetch = vi.fn<typeof fetch>(async () =>
      Response.json({
        transaction: {
          transId: "transaction-payment-request-changed",
          transactionStatus: "settledSuccessfully",
          authAmount: "10.00",
          userFields: {
            userField: [
              { name: "lago_payment_request_id", value: "payment-request-changed" },
              { name: "lago_payable_type", value: "PaymentRequest" },
            ],
          },
        },
        messages: { resultCode: "Ok" },
      }),
    );
    await expect(
      reconcileAuthorizeNetReceipt(env, "anet_notification-payment-request-changed", providerFetch),
    ).rejects.toThrow("payment_request_balance_changed");
    await expect(
      env.BILLING_DB.prepare(
        `SELECT processed_at, processing_error_code FROM webhook_receipts
         WHERE id = 'anet_notification-payment-request-changed'`,
      ).first(),
    ).resolves.toEqual({
      processed_at: null,
      processing_error_code: "payment_request_balance_changed",
    });
    await expect(
      env.BILLING_DB.prepare(
        `SELECT payment_status, version FROM payment_requests WHERE id = 'payment-request-changed'`,
      ).first(),
    ).resolves.toEqual({ payment_status: "pending", version: 1 });
  });
});

function paymentRequestInvoiceStatement(
  id: string,
  customerId: string,
  number: string,
  amountMinor: number,
  now: string,
): D1PreparedStatement {
  return env.BILLING_DB.prepare(
    `INSERT INTO invoices
     (id, organization_id, customer_id, subscription_id, number, status, payment_status,
      currency, subtotal_minor, tax_minor, credits_minor, total_due_minor, version,
      finalized_at, payment_overdue, ready_for_payment_processing, created_at, updated_at)
     VALUES (?, 'org-webhook', ?, NULL, ?, 'finalized', 'pending', 'USD', ?, 0, 0, ?, 1,
             ?, 1, 1, ?, ?)`,
  ).bind(id, customerId, number, amountMinor, amountMinor, now, now, now);
}

function paymentRequestLinkStatement(
  id: string,
  paymentRequestId: string,
  invoiceId: string,
  now: string,
): D1PreparedStatement {
  return env.BILLING_DB.prepare(
    `INSERT INTO invoices_payment_requests
     (id, organization_id, payment_request_id, invoice_id, invoice_version, created_at, updated_at)
     VALUES (?, 'org-webhook', ?, ?, 1, ?, ?)`,
  ).bind(id, paymentRequestId, invoiceId, now, now);
}

async function insertSyntheticReceipt(
  notificationId: string,
  transactionId: string,
  now: string,
  eventType = "net.authorize.payment.authcapture.created",
): Promise<void> {
  const receiptId = `anet_${notificationId}`;
  await env.BILLING_DB.batch([
    env.BILLING_DB.prepare(
      `INSERT INTO webhook_receipts
       (id, provider, provider_account_code, provider_event_id, signature_valid,
        payload_sha256, received_at)
       VALUES (?, 'authorize_net', 'org-webhook', ?, 1, ?, ?)`,
    ).bind(receiptId, notificationId, "0".repeat(64), now),
    env.BILLING_DB.prepare(
      `INSERT INTO provider_webhook_events
       (receipt_id, organization_id, event_type, provider_transaction_id)
       VALUES (?, 'org-webhook', ?, ?)`,
    ).bind(receiptId, eventType, transactionId),
  ]);
}

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
