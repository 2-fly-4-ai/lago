import { env, SELF } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { handleInvoicePaymentRetryRequest } from "../src/api/invoice-payment-retries";
import { sha256Hex } from "../src/auth/api-key";
import { deterministicUuid } from "../src/identifiers";

const apiKey = "invoice-payment-retry-key";
const organizationId = "org-invoice-payment-retry";
const invoiceId = "invoice-payment-retry";
const headers = {
  Authorization: `Bearer ${apiKey}`,
  "Content-Type": "application/json",
  "Idempotency-Key": "retry-command",
};
const auth = {
  organizationId,
  organizationExternalId: "invoice-payment-retry",
  apiKeyId: "key-invoice-payment-retry",
};

beforeEach(async () => {
  const now = "2026-08-15T12:00:00.000Z";
  await env.BILLING_DB.batch([
    env.BILLING_DB.prepare(
      `INSERT OR IGNORE INTO organizations (id, external_id, name, created_at, updated_at)
       VALUES (?, 'invoice-payment-retry', 'Invoice Payment Retry', ?, ?)`,
    ).bind(organizationId, now, now),
    env.BILLING_DB.prepare(
      `INSERT OR IGNORE INTO api_keys
       (id, organization_id, key_prefix, key_hash, created_at, revoked_at)
       VALUES ('key-invoice-payment-retry', ?, 'invoice-', ?, ?, NULL)`,
    ).bind(organizationId, await sha256Hex(apiKey), now),
    env.BILLING_DB.prepare(
      `INSERT OR IGNORE INTO customers
       (id, organization_id, external_id, email, currency, metadata_json,
        payment_provider, payment_provider_code, created_at, updated_at)
       VALUES ('customer-invoice-payment-retry', ?, 'customer-invoice-payment-retry',
               'billing@example.test', 'USD', '{}', 'authorize_net', 'retry-provider', ?, ?)`,
    ).bind(organizationId, now, now),
    env.BILLING_DB.prepare(
      `INSERT OR IGNORE INTO invoices
       (id, organization_id, customer_id, number, status, payment_status, currency,
        subtotal_minor, tax_minor, credits_minor, total_due_minor,
        ready_for_payment_processing, version, finalized_at, created_at, updated_at)
       VALUES (?, ?, 'customer-invoice-payment-retry', 'INV-RETRY', 'finalized', 'failed',
               'USD', 1000, 0, 0, 1000, 1, 1, ?, ?, ?)`,
    ).bind(invoiceId, organizationId, now, now, now),
    env.BILLING_DB.prepare(
      `INSERT OR IGNORE INTO invoices
       (id, organization_id, customer_id, number, status, payment_status, currency,
        subtotal_minor, tax_minor, credits_minor, total_due_minor,
        ready_for_payment_processing, version, finalized_at, created_at, updated_at)
       VALUES ('invoice-payment-retry-other', ?, 'customer-invoice-payment-retry',
               'INV-RETRY-OTHER', 'finalized', 'failed', 'USD', 500, 0, 0, 500, 1, 1, ?, ?, ?)`,
    ).bind(organizationId, now, now, now),
    env.BILLING_DB.prepare(`DELETE FROM payment_attempts WHERE organization_id = ?`).bind(
      organizationId,
    ),
    env.BILLING_DB.prepare(
      `DELETE FROM outbox_events WHERE organization_id = ?
       AND event_type = 'invoice.payment_retry_requested'`,
    ).bind(organizationId),
    env.BILLING_DB.prepare(
      `DELETE FROM payment_links WHERE invoice_id IN (?, 'invoice-payment-retry-other')`,
    ).bind(invoiceId),
    env.BILLING_DB.prepare(
      `UPDATE invoices
       SET status = 'finalized', payment_status = 'failed', ready_for_payment_processing = 1,
           version = 1, updated_at = ?
       WHERE id IN (?, 'invoice-payment-retry-other') AND organization_id = ?`,
    ).bind(now, invoiceId, organizationId),
    stalePaymentLink(now),
  ]);
});

describe("invoice payment retry", () => {
  it("keeps retry behind the payment mutation gate and requires an idempotency key", async () => {
    const disabled = await SELF.fetch(
      `https://lago.test/api/v1/invoices/${invoiceId}/retry_payment`,
      { method: "POST", headers, body: "{}" },
    );
    expect(disabled.status).toBe(503);
    await expect(disabled.json()).resolves.toMatchObject({ code: "payment_mutations_disabled" });

    await expect(retry("", {})).rejects.toMatchObject({ code: "idempotency_key_required" });
    await expect(
      retry("method-override", { payment_method: { id: "card" } }),
    ).rejects.toMatchObject({ code: "unsupported_payment_method_override" });
    await expect(
      env.BILLING_DB.prepare(`SELECT version, payment_status FROM invoices WHERE id = ?`)
        .bind(invoiceId)
        .first(),
    ).resolves.toEqual({ version: 1, payment_status: "failed" });
  });

  it("records one pending intent, invalidates the stale link, and replays without another mutation", async () => {
    const first = await retry("accepted-retry", {});
    expect(first?.status).toBe(200);
    expect(first?.headers.get("X-Idempotent-Replay")).toBe("false");

    const attempt = await env.BILLING_DB.prepare(
      `SELECT id, invoice_id, provider, provider_account_code, provider_transaction_id,
              idempotency_key, amount_minor, currency, status, payment_type, reference
       FROM payment_attempts WHERE organization_id = ?`,
    )
      .bind(organizationId)
      .first<{
        id: string;
        invoice_id: string;
        provider: string;
        provider_account_code: string;
        provider_transaction_id: string | null;
        idempotency_key: string;
        amount_minor: number;
        currency: string;
        status: string;
        payment_type: string;
        reference: string;
      }>();
    expect(attempt).toMatchObject({
      invoice_id: invoiceId,
      provider: "authorize_net",
      provider_account_code: "retry-provider",
      provider_transaction_id: null,
      amount_minor: 1000,
      currency: "USD",
      status: "intent_recorded",
      payment_type: "provider",
      reference: "INV-RETRY",
    });
    expect(attempt?.idempotency_key).toMatch(/^invoice-retry:[0-9a-f]{64}$/);
    expect(attempt?.idempotency_key).not.toContain("accepted-retry");
    await expect(
      env.BILLING_DB.prepare(
        `SELECT payment_status, ready_for_payment_processing, version FROM invoices WHERE id = ?`,
      )
        .bind(invoiceId)
        .first(),
    ).resolves.toEqual({ payment_status: "pending", ready_for_payment_processing: 1, version: 2 });
    await expect(
      env.BILLING_DB.prepare(`SELECT COUNT(*) AS total FROM payment_links WHERE invoice_id = ?`)
        .bind(invoiceId)
        .first(),
    ).resolves.toEqual({ total: 0 });
    const event = await env.BILLING_DB.prepare(
      `SELECT payload_json FROM outbox_events
       WHERE event_type = 'invoice.payment_retry_requested' AND aggregate_id = ?`,
    )
      .bind(attempt!.id)
      .first<{ payload_json: string }>();
    expect(event?.payload_json).not.toContain("accepted-retry");
    expect(event?.payload_json).not.toContain("amount");

    const replay = await retry("accepted-retry", {});
    expect(replay?.status).toBe(200);
    expect(replay?.headers.get("X-Idempotent-Replay")).toBe("true");
    await expect(countState()).resolves.toEqual({ attempts: 1, events: 1, version: 2 });

    const payments = await SELF.fetch(
      "https://lago.test/api/v1/customers/customer-invoice-payment-retry/payments",
      { headers: { Authorization: `Bearer ${apiKey}` } },
    );
    expect(payments.status).toBe(200);
    await expect(payments.json()).resolves.toMatchObject({
      payments: [{ lago_id: attempt?.id, payment_status: "pending", provider_payment_id: null }],
    });
  });

  it("converges concurrent replay and rejects reuse for another invoice", async () => {
    const [left, right] = await Promise.all([
      retry("concurrent-retry", {}),
      retry("concurrent-retry", {}),
    ]);
    expect([left?.status, right?.status]).toEqual([200, 200]);
    expect([
      left?.headers.get("X-Idempotent-Replay"),
      right?.headers.get("X-Idempotent-Replay"),
    ]).toContain("true");
    await expect(countState()).resolves.toEqual({ attempts: 1, events: 1, version: 2 });

    await expect(
      retry("concurrent-retry", {}, "invoice-payment-retry-other"),
    ).rejects.toMatchObject({ code: "idempotency_conflict" });
  });

  it("allows only one winner when different retry commands race the same invoice version", async () => {
    const settled = await Promise.allSettled([
      retry("concurrent-left", {}),
      retry("concurrent-right", {}),
    ]);
    expect(settled.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(settled.filter((result) => result.status === "rejected")).toHaveLength(1);
    expect(settled.find((result) => result.status === "rejected")?.reason).toMatchObject({
      code: "invoice_version_conflict",
    });
    await expect(countState()).resolves.toEqual({ attempts: 1, events: 1, version: 2 });
  });

  it("isolates tenants and rejects invoices that are not ready for retained-provider retry", async () => {
    await expect(
      handleInvoicePaymentRetryRequest(
        retryRequest("other-tenant", {}, invoiceId),
        enabledEnv(),
        { ...auth, organizationId: "another-organization" },
        "request-other-tenant",
      ),
    ).rejects.toMatchObject({ code: "invoice_not_found" });

    await env.BILLING_DB.prepare(
      `UPDATE invoices SET ready_for_payment_processing = 0 WHERE id = ?`,
    )
      .bind(invoiceId)
      .run();
    await expect(retry("not-ready", {})).rejects.toMatchObject({
      code: "payment_processor_is_currently_handling_payment",
    });

    await env.BILLING_DB.prepare(
      `UPDATE invoices SET ready_for_payment_processing = 1, status = 'draft' WHERE id = ?`,
    )
      .bind(invoiceId)
      .run();
    await expect(retry("draft", {})).rejects.toMatchObject({ code: "invalid_status" });

    await env.BILLING_DB.batch([
      env.BILLING_DB.prepare(`UPDATE invoices SET status = 'finalized' WHERE id = ?`).bind(
        invoiceId,
      ),
      env.BILLING_DB.prepare(
        `UPDATE customers SET payment_provider = 'stripe'
         WHERE id = 'customer-invoice-payment-retry'`,
      ),
    ]);
    await expect(retry("wrong-provider", {})).rejects.toMatchObject({
      code: "invalid_payment_provider",
    });
  });

  it("rolls the complete mutation back when the final outbox insert fails", async () => {
    const idempotencyKey = "rollback-retry";
    const keyHash = await sha256Hex(`${organizationId}:${idempotencyKey}`);
    const attemptId = await deterministicUuid(
      "invoice-payment-retry",
      `${organizationId}:${keyHash}`,
    );
    const eventId = `invoice-payment-retry-requested:${attemptId}:v1`;
    const now = "2026-08-15T12:05:00.000Z";
    await env.BILLING_DB.prepare(
      `INSERT INTO outbox_events
       (event_id, organization_id, event_type, event_version, aggregate_type,
        aggregate_id, aggregate_version, causation_id, correlation_id, payload_json,
        occurred_at, published_at)
       VALUES (?, ?, 'synthetic.conflict', 1, 'synthetic', 'synthetic', 1,
               'synthetic', 'synthetic', '{}', ?, NULL)`,
    )
      .bind(eventId, organizationId, now)
      .run();

    await expect(retry(idempotencyKey, {})).rejects.toBeTruthy();
    await expect(
      env.BILLING_DB.prepare(`SELECT payment_status, version FROM invoices WHERE id = ?`)
        .bind(invoiceId)
        .first(),
    ).resolves.toEqual({ payment_status: "failed", version: 1 });
    await expect(
      env.BILLING_DB.prepare(
        `SELECT
           (SELECT COUNT(*) FROM payment_attempts WHERE id = ?) AS attempts,
           (SELECT COUNT(*) FROM payment_links WHERE invoice_id = ?) AS links`,
      )
        .bind(attemptId, invoiceId)
        .first(),
    ).resolves.toEqual({ attempts: 0, links: 1 });
  });
});

function retry(idempotencyKey: string, body: unknown, targetInvoiceId = invoiceId) {
  return handleInvoicePaymentRetryRequest(
    retryRequest(idempotencyKey, body, targetInvoiceId),
    enabledEnv(),
    auth,
    `request-${idempotencyKey || "missing"}`,
  );
}

function retryRequest(idempotencyKey: string, body: unknown, targetInvoiceId: string) {
  return new Request(`https://lago.test/api/v1/invoices/${targetInvoiceId}/retry_payment`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(idempotencyKey ? { "Idempotency-Key": idempotencyKey } : {}),
    },
    body: JSON.stringify(body),
  });
}

function enabledEnv(): Env {
  return new Proxy(env, {
    get(target, property, receiver) {
      if (property === "PAYMENT_MUTATIONS_ENABLED") return "1";
      return Reflect.get(target, property, receiver) as unknown;
    },
  }) as Env;
}

function stalePaymentLink(now: string): D1PreparedStatement {
  return env.BILLING_DB.prepare(
    `INSERT INTO payment_links
     (invoice_id, provider, provider_account_code, payment_url, provider_token_sha256,
      expires_at, created_at, updated_at)
     VALUES (?, 'authorize_net', 'retry-provider', 'https://lago.test/stale-retry-link',
             'stale-retry-token-hash', NULL, ?, ?)`,
  ).bind(invoiceId, now, now);
}

async function countState() {
  return env.BILLING_DB.prepare(
    `SELECT
       (SELECT COUNT(*) FROM payment_attempts WHERE organization_id = ?) AS attempts,
       (SELECT COUNT(*) FROM outbox_events WHERE organization_id = ?
        AND event_type = 'invoice.payment_retry_requested') AS events,
       (SELECT version FROM invoices WHERE id = ?) AS version`,
  )
    .bind(organizationId, organizationId, invoiceId)
    .first();
}
