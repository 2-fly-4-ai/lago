import { env, SELF } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

import { handleStripeWebhook, validStripeSignature } from "../src/webhooks/stripe";

const organizationId = "org-stripe-webhook";
const accountCode = "stripe-synthetic";
const signingSecret = "synthetic-webhook-signing-secret";

beforeEach(async () => {
  const now = "2026-08-18T00:00:00.000Z";
  await env.BILLING_DB.batch([
    env.BILLING_DB.prepare("DELETE FROM provider_refund_operations WHERE organization_id = ?").bind(
      organizationId,
    ),
    env.BILLING_DB.prepare("DELETE FROM payment_disputes WHERE organization_id = ?").bind(
      organizationId,
    ),
    env.BILLING_DB.prepare(
      "UPDATE invoices SET payment_dispute_lost_at = NULL WHERE organization_id = ?",
    ).bind(organizationId),
    env.BILLING_DB.prepare(
      `INSERT OR IGNORE INTO organizations (id, external_id, name, created_at, updated_at)
       VALUES (?, 'stripe-webhook-test', 'Stripe Webhook Test', ?, ?)`,
    ).bind(organizationId, now, now),
    env.BILLING_DB.prepare(
      `INSERT OR IGNORE INTO customers
       (id, organization_id, external_id, currency, metadata_json, created_at, updated_at)
       VALUES ('customer-stripe-webhook', ?, 'customer-stripe-webhook', 'USD', '{}', ?, ?)`,
    ).bind(organizationId, now, now),
    env.BILLING_DB.prepare(
      `INSERT OR IGNORE INTO invoices
       (id, organization_id, customer_id, number, status, payment_status, currency,
        subtotal_minor, tax_minor, credits_minor, total_due_minor, finalized_at, created_at, updated_at)
       VALUES ('invoice-stripe-webhook', ?, 'customer-stripe-webhook', 'INV-STRIPE-001',
               'finalized', 'succeeded', 'USD', 2500, 0, 0, 2500, ?, ?, ?)`,
    ).bind(organizationId, now, now, now),
    env.BILLING_DB.prepare(
      `INSERT OR IGNORE INTO payment_attempts
       (id, organization_id, invoice_id, provider, provider_account_code,
        provider_transaction_id, idempotency_key, amount_minor, currency, status,
        failure_code, failure_message, created_at, updated_at)
       VALUES ('payment-stripe-webhook', ?, 'invoice-stripe-webhook', 'stripe', ?,
               'pi_stripe_synthetic', 'stripe-payment-synthetic', 2500, 'USD', 'succeeded',
               NULL, NULL, ?, ?)`,
    ).bind(organizationId, accountCode, now, now),
  ]);
});

describe("Stripe webhooks", () => {
  it("rejects disabled ingestion and never reads or persists the body", async () => {
    const routed = await SELF.fetch(`https://lago.test/webhooks/stripe/${organizationId}`, {
      method: "POST",
      headers: { "Stripe-Signature": "t=1,v1=invalid" },
      body: "not-forwarded",
    });
    expect(routed.status).toBe(503);
    await expect(routed.json()).resolves.toMatchObject({ code: "stripe_webhooks_disabled" });

    const responsePromise = handleStripeWebhook(
      new Request(`https://lago.test/webhooks/stripe/${organizationId}`, {
        method: "POST",
        headers: { "Stripe-Signature": "t=1,v1=invalid" },
        body: "not-forwarded",
      }),
      { ...env, STRIPE_WEBHOOKS_ENABLED: "0" },
      organizationId,
      "request-disabled",
    );
    await expect(responsePromise).rejects.toMatchObject({ code: "stripe_webhooks_disabled" });
    await expect(
      env.BILLING_DB.prepare(
        "SELECT COUNT(*) AS count FROM webhook_receipts WHERE provider = 'stripe'",
      ).first(),
    ).resolves.toEqual({ count: 0 });
  });

  it("verifies, archives, deduplicates, and orders synthetic dispute events locally", async () => {
    const timestamp = Math.floor(Date.now() / 1000);
    const lost = stripeEvent("evt_dispute_lost", timestamp, "lost", false);
    const first = await receive(lost, timestamp, "request-first");
    expect(first.status).toBe(200);
    await expect(first.json()).resolves.toEqual({ received: true, replayed: false });

    const replay = await receive(lost, timestamp, "request-replay");
    await expect(replay.json()).resolves.toEqual({ received: true, replayed: true });

    const older = stripeEvent("evt_dispute_older", timestamp - 60, "under_review", false);
    expect((await receive(older, timestamp, "request-older")).status).toBe(200);

    await expect(
      env.BILLING_DB.prepare(
        `SELECT provider_dispute_id, payment_attempt_id, invoice_id, amount_minor, currency,
                status, livemode FROM payment_disputes WHERE organization_id = ?`,
      )
        .bind(organizationId)
        .first(),
    ).resolves.toEqual({
      provider_dispute_id: "dp_synthetic",
      payment_attempt_id: "payment-stripe-webhook",
      invoice_id: "invoice-stripe-webhook",
      amount_minor: 1250,
      currency: "USD",
      status: "lost",
      livemode: 0,
    });
    await expect(
      env.BILLING_DB.prepare(
        "SELECT payment_dispute_lost_at FROM invoices WHERE id = 'invoice-stripe-webhook'",
      ).first(),
    ).resolves.toEqual({ payment_dispute_lost_at: new Date(timestamp * 1000).toISOString() });
    const receipt = await env.BILLING_DB.prepare(
      `SELECT archive_key FROM webhook_receipts
       WHERE provider = 'stripe' AND provider_event_id = 'evt_dispute_lost'`,
    ).first<{ archive_key: string }>();
    expect(receipt).not.toBeNull();
    const archive = receipt ? await env.BILLING_ARTIFACTS.get(receipt.archive_key) : null;
    expect(await archive?.text()).toBe(lost);
  });

  it("rejects invalid signatures and live-mode events before persistence", async () => {
    const timestamp = Math.floor(Date.now() / 1000);
    const body = stripeEvent("evt_invalid_signature", timestamp, "needs_response", false);
    await expect(
      handleStripeWebhook(
        new Request(`https://lago.test/webhooks/stripe/${organizationId}`, {
          method: "POST",
          headers: { "Stripe-Signature": `t=${timestamp},v1=${"0".repeat(64)}` },
          body,
        }),
        stripeEnv(),
        organizationId,
        "request-invalid",
      ),
    ).rejects.toMatchObject({ code: "webhook_signature_invalid" });

    const live = stripeEvent("evt_live", timestamp, "needs_response", true);
    await expect(receive(live, timestamp, "request-live")).rejects.toMatchObject({
      code: "stripe_livemode_disabled",
    });

    await expect(
      handleStripeWebhook(
        new Request("https://lago.test/webhooks/stripe/another-organization", {
          method: "POST",
          headers: { "Stripe-Signature": await stripeSignature(body, timestamp) },
          body,
        }),
        stripeEnv(),
        "another-organization",
        "request-wrong-organization",
      ),
    ).rejects.toMatchObject({ code: "organization_not_found" });
  });

  it("updates only an existing synthetic refund operation from a signed event", async () => {
    const now = new Date().toISOString();
    await env.BILLING_DB.prepare(
      `INSERT INTO provider_refund_operations
       (id, organization_id, credit_note_id, invoice_id, payment_attempt_id, provider,
        provider_account_code, provider_payment_id, provider_refund_id, idempotency_key,
        request_sha256, amount_minor, currency, status, created_at, updated_at)
       VALUES ('refund-operation-synthetic', ?, NULL, 'invoice-stripe-webhook',
               'payment-stripe-webhook', 'stripe', ?, 'pi_stripe_synthetic', 're_synthetic',
               'refund-operation-key', ?, 500, 'USD', 'submitted', ?, ?)`,
    )
      .bind(organizationId, accountCode, "a".repeat(64), now, now)
      .run();
    const timestamp = Math.floor(Date.now() / 1000);
    const body = JSON.stringify({
      id: "evt_refund_succeeded",
      type: "refund.updated",
      created: timestamp,
      livemode: false,
      data: {
        object: {
          object: "refund",
          id: "re_synthetic",
          payment_intent: "pi_stripe_synthetic",
          amount: 500,
          currency: "usd",
          status: "succeeded",
        },
      },
    });
    expect((await receive(body, timestamp, "request-refund")).status).toBe(200);
    await expect(
      env.BILLING_DB.prepare(
        "SELECT status, failure_code FROM provider_refund_operations WHERE id = 'refund-operation-synthetic'",
      ).first(),
    ).resolves.toEqual({ status: "succeeded", failure_code: null });
  });

  it("settles a pending purchased wallet lot exactly once from a signed PaymentIntent", async () => {
    const now = new Date().toISOString();
    await env.BILLING_DB.batch([
      env.BILLING_DB.prepare(
        `INSERT INTO wallets
         (id, organization_id, customer_id, code, currency, currency_exponent, rate_amount,
          priority, balance_minor, consumed_minor, status, version, request_sha256,
          created_at, updated_at)
         VALUES ('wallet-stripe-funding', ?, 'customer-stripe-webhook', 'stripe-funding',
                 'USD', 2, '1', 50, 0, 0, 'active', 1, ?, ?, ?)`,
      ).bind(organizationId, "d".repeat(64), now, now),
      env.BILLING_DB.prepare(
        `INSERT INTO wallet_transactions
         (id, organization_id, wallet_id, transaction_type, transaction_status, status, source,
          amount_minor, credit_amount, remaining_minor, priority, wallet_version,
          idempotency_key, request_sha256, created_at, updated_at)
         VALUES ('wallet-transaction-stripe-funding', ?, 'wallet-stripe-funding', 'inbound',
                 'purchased', 'pending', 'manual', 2500, '25', 2500, 50, 1,
                 'wallet-funding-request', ?, ?, ?)`,
      ).bind(organizationId, "e".repeat(64), now, now),
      env.BILLING_DB.prepare(
        `INSERT INTO provider_wallet_funding_operations
         (id, organization_id, wallet_id, wallet_transaction_id, provider,
          provider_account_code, payment_method_id, idempotency_key, request_sha256,
          amount_minor, credit_amount, currency, status, created_at, updated_at)
         VALUES ('wallet-funding-operation', ?, 'wallet-stripe-funding',
                 'wallet-transaction-stripe-funding', 'stripe', ?, 'pm_card_visa',
                 'wallet-funding-operation-key', ?, 2500, '25', 'USD', 'pending', ?, ?)`,
      ).bind(organizationId, accountCode, "f".repeat(64), now, now),
    ]);
    const timestamp = Math.floor(Date.now() / 1000);
    const body = JSON.stringify({
      id: "evt_wallet_funding_succeeded",
      type: "payment_intent.succeeded",
      created: timestamp,
      livemode: false,
      data: {
        object: {
          id: "pi_wallet_funding_synthetic",
          status: "succeeded",
          metadata: { lago_wallet_transaction_id: "wallet-transaction-stripe-funding" },
        },
      },
    });
    expect((await receive(body, timestamp, "request-wallet-funding")).status).toBe(200);
    expect((await receive(body, timestamp, "request-wallet-funding-replay")).status).toBe(200);
    await expect(
      env.BILLING_DB.prepare(
        `SELECT wallet.balance_minor, transaction_row.status AS transaction_status,
                operation.status AS operation_status
         FROM wallets wallet
         JOIN wallet_transactions transaction_row ON transaction_row.wallet_id = wallet.id
         JOIN provider_wallet_funding_operations operation
           ON operation.wallet_transaction_id = transaction_row.id
         WHERE wallet.id = 'wallet-stripe-funding'`,
      ).first(),
    ).resolves.toEqual({
      balance_minor: 2500,
      transaction_status: "settled",
      operation_status: "succeeded",
    });
  });

  it("enforces the five-minute signature tolerance", async () => {
    const timestamp = 1_787_040_000;
    const body = stripeEvent("evt_tolerance", timestamp, "needs_response", false);
    const signature = await stripeSignature(body, timestamp);
    await expect(
      validStripeSignature(body, signature, signingSecret, (timestamp + 300) * 1000),
    ).resolves.toBe(true);
    await expect(
      validStripeSignature(body, signature, signingSecret, (timestamp + 301) * 1000),
    ).resolves.toBe(false);
    await expect(
      validStripeSignature(
        body,
        signature.replace(`t=${timestamp}`, `t=${timestamp}suffix`),
        signingSecret,
        timestamp * 1000,
      ),
    ).resolves.toBe(false);
  });
});

async function receive(body: string, timestamp: number, requestId: string): Promise<Response> {
  return handleStripeWebhook(
    new Request(`https://lago.test/webhooks/stripe/${organizationId}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Stripe-Signature": await stripeSignature(body, timestamp),
      },
      body,
    }),
    stripeEnv(),
    organizationId,
    requestId,
  );
}

function stripeEnv() {
  return {
    ...env,
    STRIPE_WEBHOOKS_ENABLED: "1",
    STRIPE_WEBHOOK_SIGNING_SECRET: signingSecret,
    STRIPE_ACCOUNT_CODE: accountCode,
    STRIPE_ORGANIZATION_ID: organizationId,
    STRIPE_LIVEMODE_ALLOWED: "0",
  };
}

function stripeEvent(id: string, created: number, status: string, livemode: boolean): string {
  return JSON.stringify({
    id,
    type: "charge.dispute.closed",
    created,
    livemode,
    data: {
      object: {
        object: "dispute",
        id: "dp_synthetic",
        payment_intent: "pi_stripe_synthetic",
        charge: "ch_stripe_synthetic",
        amount: 1250,
        currency: "usd",
        reason: "product_not_received",
        status,
        evidence_details: { due_by: created + 86400 },
        created,
      },
    },
  });
}

async function stripeSignature(body: string, timestamp: number): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(signingSecret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(`${timestamp}.${body}`),
  );
  const digest = [...new Uint8Array(signature)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  return `t=${timestamp},v1=${digest}`;
}
