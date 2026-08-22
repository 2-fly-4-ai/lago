import { env } from "cloudflare:test";
import type { WorkflowStep } from "cloudflare:workers";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { handleEasyPayDirectCheckoutSubmission } from "../src/api/easy-pay-direct-checkout";
import { sha256Hex } from "../src/auth/api-key";
import { verifyEasyPayDirectCheckoutToken } from "../src/providers/easy-pay-direct";
import {
  reconcileEasyPayDirectExecution,
  reconcileEasyPayDirectReceipt,
} from "../src/reconciliation/easy-pay-direct";
import { runCheckoutWorkflow } from "../src/workflows/checkout";

const organizationId = "org-easy-pay-direct-checkout";
const customerId = "customer-easy-pay-direct-checkout";
const paymentRequestId = "payment-request-easy-pay-direct-checkout";

beforeEach(async () => {
  const now = new Date().toISOString();
  await env.BILLING_DB.batch([
    env.BILLING_DB.prepare(
      `INSERT OR IGNORE INTO organizations (id, external_id, name, created_at, updated_at)
       VALUES (?, 'easy-pay-direct-checkout', 'Easy Pay Direct Checkout', ?, ?)`,
    ).bind(organizationId, now, now),
    env.BILLING_DB.prepare(
      `INSERT OR IGNORE INTO customers
       (id, organization_id, external_id, email, name, currency, metadata_json,
        payment_provider, payment_provider_code, created_at, updated_at)
       VALUES (?, ?, 'easy-pay-direct-customer', 'synthetic@example.com', 'Synthetic Customer',
               'USD', '{}', 'easy_pay_direct', 'epd-synthetic', ?, ?)`,
    ).bind(customerId, organizationId, now, now),
    env.BILLING_DB.prepare(
      `INSERT OR IGNORE INTO invoices
       (id, organization_id, customer_id, number, status, payment_status, currency,
        subtotal_minor, tax_minor, credits_minor, total_due_minor, version, finalized_at,
        payment_overdue, ready_for_payment_processing, created_at, updated_at)
       VALUES ('invoice-easy-pay-direct-checkout', ?, ?, 'INV-EPD', 'finalized', 'pending',
               'USD', 1999, 0, 0, 1999, 1, ?, 1, 1, ?, ?)`,
    ).bind(organizationId, customerId, now, now, now),
    env.BILLING_DB.prepare(
      `INSERT OR IGNORE INTO payment_requests
       (id, organization_id, customer_id, amount_minor, currency, email, payment_attempts,
        payment_status, ready_for_payment_processing, version, created_at, updated_at)
       VALUES (?, ?, ?, 1999, 'USD', 'synthetic@example.com', 0, 'pending', 1, 1, ?, ?)`,
    ).bind(paymentRequestId, organizationId, customerId, now, now),
    env.BILLING_DB.prepare(
      `INSERT OR IGNORE INTO invoices_payment_requests
       (id, organization_id, payment_request_id, invoice_id, invoice_version, created_at, updated_at)
       VALUES ('link-easy-pay-direct-checkout', ?, ?, 'invoice-easy-pay-direct-checkout', 1, ?, ?)`,
    ).bind(organizationId, paymentRequestId, now, now),
  ]);
});

describe("Easy Pay Direct Commerce checkout execution", () => {
  it("creates a sandbox Commerce order once and waits for the signed webhook before reconciling", async () => {
    const runtimeEnv = enabledEnv();
    await runCheckoutWorkflow(runtimeEnv, checkoutParams(), immediateStep());
    const checkout = await env.BILLING_DB.prepare(
      `SELECT payment_url, provider_token_sha256, status FROM payment_request_checkout_intents
       WHERE payment_request_id = ? AND provider = 'easy_pay_direct'`,
    )
      .bind(paymentRequestId)
      .first<{ payment_url: string; provider_token_sha256: string; status: string }>();
    const checkoutToken = new URL(checkout!.payment_url).searchParams.get("checkout")!;
    expect(checkout!.provider_token_sha256).toBe(await sha256Hex(checkoutToken));
    await expect(
      verifyEasyPayDirectCheckoutToken(checkoutToken, "synthetic-checkout-signing-secret"),
    ).resolves.toMatchObject({ intent: expect.any(String) });

    const providerFetch = vi.fn<typeof fetch>(async (input, init) => {
      const url = String(input);
      if (url.includes("/customers?")) return Response.json({ data: [] });
      if (url.endsWith("/customers")) {
        expect(JSON.parse(String(init?.body))).toMatchObject({
          email: "synthetic@example.com",
          phone: "+15555550123",
          epd_gateway_customer_vault_id: "card_visa",
        });
        return Response.json(
          { id: "epd-customer-1", default_payment_method: "epd-pm-1" },
          { status: 201 },
        );
      }
      if (url.endsWith("/products")) {
        expect(JSON.parse(String(init?.body))).toMatchObject({
          pricing: { amount: 1999, currency: "usd" },
        });
        return Response.json(
          { id: "epd-product-1", pricing: { amount: 1999, currency: "usd" } },
          { status: 201 },
        );
      }
      expect(url.endsWith("/orders")).toBe(true);
      const orderBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      expect(orderBody).not.toHaveProperty("amount");
      return Response.json(
        { id: "epd-order-1", status: "succeeded", total: 1999, currency: "usd" },
        { status: 201 },
      );
    });
    const request = () =>
      new Request("https://lago.test/easy_pay_direct/payment_form", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          checkout: checkoutToken,
          payment_token: "card_visa",
          phone: "+15555550123",
        }),
      });
    const first = await handleEasyPayDirectCheckoutSubmission(
      request(),
      runtimeEnv,
      "request-epd-1",
      providerFetch,
    );
    await expect(first.json()).resolves.toMatchObject({
      status: "processing",
      provider: "easy_pay_direct",
      provider_order_id: "epd-order-1",
      replayed: false,
    });
    const replay = await handleEasyPayDirectCheckoutSubmission(
      request(),
      runtimeEnv,
      "request-epd-2",
      providerFetch,
    );
    await expect(replay.json()).resolves.toMatchObject({ status: "processing", replayed: true });
    expect(providerFetch).toHaveBeenCalledTimes(4);
    await expect(
      env.BILLING_DB.prepare("SELECT payment_status FROM payment_requests WHERE id = ?")
        .bind(paymentRequestId)
        .first(),
    ).resolves.toEqual({ payment_status: "pending" });
    await expect(
      env.BILLING_DB.prepare(
        `SELECT provider_customer_id, provider_payment_method_id, gateway_customer_vault_id
       FROM provider_customer_profiles WHERE customer_id = ? AND provider = 'easy_pay_direct'`,
      )
        .bind(customerId)
        .first(),
    ).resolves.toEqual({
      provider_customer_id: "epd-customer-1",
      provider_payment_method_id: "epd-pm-1",
      gateway_customer_vault_id: "card_visa",
    });

    const execution = await env.BILLING_DB.prepare(
      `SELECT id FROM easy_pay_direct_payment_executions WHERE payment_request_id = ?`,
    )
      .bind(paymentRequestId)
      .first<{ id: string }>();
    const orderRead = vi.fn<typeof fetch>(async (input, init) => {
      expect(String(input).endsWith("/orders/epd-order-1")).toBe(true);
      expect(init?.method).toBe("GET");
      return Response.json({
        id: "epd-order-1",
        status: "succeeded",
        total: 1999,
        currency: "usd",
      });
    });
    await expect(
      reconcileEasyPayDirectExecution(runtimeEnv, execution!.id, orderRead),
    ).resolves.toBe("processed");
    expect(orderRead).toHaveBeenCalledOnce();
    await expect(
      env.BILLING_DB.prepare(
        `SELECT provider, signature_valid, processed_at IS NOT NULL AS processed
         FROM webhook_receipts WHERE provider = 'easy_pay_direct_reconciliation'`,
      ).first(),
    ).resolves.toEqual({
      provider: "easy_pay_direct_reconciliation",
      signature_valid: 0,
      processed: 1,
    });

    const successPayload = JSON.stringify({
      id: "evt-order-succeeded-1",
      object: "event",
      type: "order.succeeded",
      livemode: false,
      data: {
        object: {
          id: "epd-order-1",
          object: "order",
          status: "succeeded",
          total: 1999,
          currency: "usd",
          metadata: { lago_payment_request_id: paymentRequestId },
        },
      },
    });
    await insertArchivedEvent(
      "epd_evt_order_success_1",
      "evt-order-succeeded-1",
      "order.succeeded",
      "epd-order-1",
      successPayload,
    );
    await expect(
      reconcileEasyPayDirectReceipt(runtimeEnv, "epd_evt_order_success_1"),
    ).resolves.toBe("processed");
    await expect(
      env.BILLING_DB.prepare(
        "SELECT payment_status, ready_for_payment_processing FROM payment_requests WHERE id = ?",
      )
        .bind(paymentRequestId)
        .first(),
    ).resolves.toEqual({ payment_status: "succeeded", ready_for_payment_processing: 0 });
    await expect(
      env.BILLING_DB.prepare(
        "SELECT status FROM easy_pay_direct_payment_executions WHERE payment_request_id = ?",
      )
        .bind(paymentRequestId)
        .first(),
    ).resolves.toEqual({ status: "succeeded" });

    const chargebackPayload = JSON.stringify({
      id: "evt-chargeback-1",
      object: "event",
      type: "order.chargeback.lost",
      livemode: false,
      data: {
        object: {
          id: "epd-order-1",
          object: "order",
          status: "lost",
          total: 1999,
          currency: "usd",
          metadata: { lago_payment_request_id: paymentRequestId },
        },
      },
    });
    await insertArchivedEvent(
      "epd_evt_chargeback_1",
      "evt-chargeback-1",
      "order.chargeback.lost",
      "epd-order-1",
      chargebackPayload,
    );
    await expect(reconcileEasyPayDirectReceipt(runtimeEnv, "epd_evt_chargeback_1")).resolves.toBe(
      "processed",
    );
    await expect(
      env.BILLING_DB.prepare(
        "SELECT provider, amount_minor, currency, status, livemode FROM payment_disputes WHERE provider_dispute_id = 'epd-order-1'",
      ).first(),
    ).resolves.toEqual({
      provider: "easy_pay_direct",
      amount_minor: 1999,
      currency: "USD",
      status: "lost",
      livemode: 0,
    });
  });
});

async function insertArchivedEvent(
  receiptId: string,
  eventId: string,
  eventType: string,
  orderId: string,
  payload: string,
) {
  const archiveKey = `webhooks/easy-pay-direct/${eventId}.json`;
  await env.BILLING_ARTIFACTS.put(archiveKey, payload);
  await env.BILLING_DB.batch([
    env.BILLING_DB.prepare(
      `INSERT INTO webhook_receipts
       (id, provider, provider_account_code, provider_event_id, signature_valid,
        payload_sha256, received_at, processed_at, processing_error_code, archive_key)
       VALUES (?, 'easy_pay_direct', 'epd-synthetic', ?, 1, ?, ?, NULL, NULL, ?)`,
    ).bind(receiptId, eventId, await sha256Hex(payload), new Date().toISOString(), archiveKey),
    env.BILLING_DB.prepare(
      `INSERT INTO provider_webhook_events
       (receipt_id, organization_id, event_type, provider_transaction_id,
        invoice_id, normalized_status, normalized_at)
       VALUES (?, ?, ?, ?, NULL, NULL, NULL)`,
    ).bind(receiptId, organizationId, eventType, orderId),
  ]);
}

function checkoutParams() {
  const id = `payment-request-checkout-${paymentRequestId}-v1`;
  return {
    organizationId,
    paymentRequestId,
    paymentRequestVersion: 1,
    idempotencyKey: id,
    correlationId: id,
  };
}

function enabledEnv(): Env {
  return new Proxy(env, {
    get(target, property, receiver) {
      if (property === "PAYMENT_MUTATIONS_ENABLED") return "1";
      if (property === "PUBLIC_BASE_URL") return "https://lago.test";
      if (property === "EASY_PAY_DIRECT_COMMERCE_API_KEY") {
        return "epd_synthetic_sk_test_secret";
      }
      if (property === "EASY_PAY_DIRECT_SECURITY_KEY") return "synthetic-security-key";
      if (property === "EASY_PAY_DIRECT_TOKENIZATION_KEY") return "synthetic-tokenization-key";
      if (property === "EASY_PAY_DIRECT_CHECKOUT_SIGNING_SECRET")
        return "synthetic-checkout-signing-secret";
      if (property === "EASY_PAY_DIRECT_NETWORK_MODE") return "test";
      if (property === "EASY_PAY_DIRECT_LIVEMODE_ALLOWED") return "0";
      if (property === "EASY_PAY_DIRECT_ACCOUNT_CODE") return "epd-synthetic";
      if (property === "EASY_PAY_DIRECT_ORGANIZATION_ID") return organizationId;
      if (property === "PROVIDER_READS_ENABLED") return "1";
      return Reflect.get(target, property, receiver) as unknown;
    },
  }) as Env;
}

function immediateStep(): WorkflowStep {
  return {
    async do(_name: string, ...args: unknown[]) {
      const callback = args.find((argument) => typeof argument === "function") as
        | (() => Promise<unknown>)
        | undefined;
      if (!callback) throw new Error("missing_workflow_callback");
      return callback();
    },
  } as unknown as WorkflowStep;
}
