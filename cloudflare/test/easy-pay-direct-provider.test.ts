import { describe, expect, it, vi } from "vitest";
import type { EasyPayDirectEnv } from "../src/providers/easy-pay-direct";
import {
  addEasyPayDirectPaymentMethod,
  createEasyPayDirectCheckoutUrl,
  createEasyPayDirectCustomer,
  createEasyPayDirectOrder,
  createEasyPayDirectProduct,
  easyPayDirectPaymentForm,
  getEasyPayDirectOrder,
  refundEasyPayDirectOrder,
  vaultEasyPayDirectCard,
  verifyEasyPayDirectCheckoutToken,
} from "../src/providers/easy-pay-direct";

const providerEnv = {
  EASY_PAY_DIRECT_COMMERCE_API_KEY: "epd_synthetic_sk_test_secret",
  EASY_PAY_DIRECT_SECURITY_KEY: "synthetic-security-key",
  EASY_PAY_DIRECT_TOKENIZATION_KEY: "synthetic-tokenization-key",
  EASY_PAY_DIRECT_CHECKOUT_SIGNING_SECRET: "synthetic-signing-secret-with-enough-entropy",
  EASY_PAY_DIRECT_NETWORK_MODE: "test",
  EASY_PAY_DIRECT_LIVEMODE_ALLOWED: "0",
  PUBLIC_BASE_URL: "https://lago.test",
} satisfies EasyPayDirectEnv;

describe("Easy Pay Direct provider", () => {
  it("creates and verifies an expiring signed checkout URL", async () => {
    const now = Date.parse("2026-08-22T00:00:00.000Z");
    const checkout = await createEasyPayDirectCheckoutUrl(
      providerEnv,
      { checkoutIntentId: "intent-synthetic-1" },
      now,
    );
    const token = new URL(checkout.paymentUrl).searchParams.get("checkout")!;
    await expect(
      verifyEasyPayDirectCheckoutToken(
        token,
        providerEnv.EASY_PAY_DIRECT_CHECKOUT_SIGNING_SECRET,
        now,
      ),
    ).resolves.toEqual({ intent: "intent-synthetic-1", expires: Math.floor(now / 1000) + 1200 });
    await expect(
      verifyEasyPayDirectCheckoutToken(
        `${token}tampered`,
        providerEnv.EASY_PAY_DIRECT_CHECKOUT_SIGNING_SECRET,
        now,
      ),
    ).rejects.toMatchObject({ code: "easy_pay_direct_checkout_invalid" });
  });

  it("renders a no-store synthetic sandbox form without loading Collect.js", async () => {
    const now = Date.parse("2026-08-22T00:00:00.000Z");
    const checkout = await createEasyPayDirectCheckoutUrl(
      providerEnv,
      { checkoutIntentId: "intent-synthetic-2" },
      now,
    );
    const response = await easyPayDirectPaymentForm(new URL(checkout.paymentUrl), providerEnv, now);
    const body = await response.text();
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(body).toContain("card_visa");
    expect(body).toContain("No real money is moved");
    expect(body).not.toContain("synthetic-tokenization-key");
    expect(body).not.toContain("Collect.js");
  });

  it("uses the versioned Commerce API for customer, payment method, product, and order", async () => {
    const calls: Array<{ url: string; body: Record<string, unknown>; headers: Headers }> = [];
    const providerFetch = vi.fn<typeof fetch>(async (input, init) => {
      const url = String(input);
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      calls.push({ url, body, headers: new Headers(init?.headers) });
      if (url.endsWith("/customers"))
        return Response.json({ id: "customer-1", default_payment_method: "pm-1" }, { status: 201 });
      if (url.includes("/payment_methods"))
        return Response.json({ id: "pm-2", customer: "customer-1" }, { status: 201 });
      if (url.endsWith("/products"))
        return Response.json(
          { id: "product-1", pricing: { amount: 1999, currency: "usd" } },
          { status: 201 },
        );
      return Response.json(
        { id: "order-1", status: "succeeded", total: 1999, currency: "usd" },
        { status: 201 },
      );
    });
    const customer = await createEasyPayDirectCustomer(
      providerEnv,
      {
        email: "synthetic@example.test",
        firstName: "Synthetic",
        lastName: "Customer",
        phone: "+15555550123",
        gatewayVaultId: "card_visa",
        idempotencyKey: "550e8400-e29b-41d4-a716-446655440000",
        metadata: { lago_customer_id: "customer-local" },
      },
      providerFetch,
    );
    const paymentMethod = await addEasyPayDirectPaymentMethod(
      providerEnv,
      {
        customerId: customer.id,
        billingId: "card_visa",
        idempotencyKey: "550e8400-e29b-41d4-a716-446655440001",
      },
      providerFetch,
    );
    const product = await createEasyPayDirectProduct(
      providerEnv,
      {
        paymentRequestId: "payment-request-1",
        amountMinor: 1999,
        currency: "USD",
        idempotencyKey: "550e8400-e29b-41d4-a716-446655440002",
      },
      providerFetch,
    );
    const order = await createEasyPayDirectOrder(
      providerEnv,
      {
        customerId: customer.id,
        paymentMethodId: paymentMethod.id,
        productId: product.id,
        paymentRequestId: "payment-request-1",
        checkoutIntentId: "checkout-1",
        currency: "USD",
        idempotencyKey: "550e8400-e29b-41d4-a716-446655440003",
      },
      providerFetch,
    );
    expect(order).toMatchObject({ id: "order-1", status: "succeeded", total: 1999 });
    expect(calls).toHaveLength(4);
    expect(
      calls.every(
        (call) => call.headers.get("Authorization") === "Bearer epd_synthetic_sk_test_secret",
      ),
    ).toBe(true);
    expect(calls.every((call) => call.headers.get("EPD-Version") === "2026-02-11")).toBe(true);
    expect(calls[3]?.body).not.toHaveProperty("amount");
  });

  it("reads an order from the versioned Commerce API for reconciliation", async () => {
    const providerFetch = vi.fn<typeof fetch>(async (input, init) => {
      expect(String(input).endsWith("/orders/order-1")).toBe(true);
      expect(init?.method).toBe("GET");
      expect(init?.body).toBeUndefined();
      expect(new Headers(init?.headers).get("EPD-Version")).toBe("2026-02-11");
      return Response.json({
        id: "order-1",
        status: "succeeded",
        total: 1999,
        currency: "usd",
      });
    });
    await expect(getEasyPayDirectOrder(providerEnv, "order-1", providerFetch)).resolves.toEqual({
      id: "order-1",
      status: "succeeded",
      total: 1999,
      currency: "usd",
    });
  });

  it("fails closed for disabled networking and key-environment mismatch", async () => {
    await expect(
      createEasyPayDirectCheckoutUrl(
        { ...providerEnv, EASY_PAY_DIRECT_NETWORK_MODE: "disabled" },
        { checkoutIntentId: "intent-1" },
      ),
    ).rejects.toMatchObject({ code: "easy_pay_direct_network_disabled" });
    await expect(
      createEasyPayDirectCheckoutUrl(
        { ...providerEnv, EASY_PAY_DIRECT_COMMERCE_API_KEY: "epd_synthetic_sk_live_wrong" },
        { checkoutIntentId: "intent-1" },
      ),
    ).rejects.toMatchObject({ code: "easy_pay_direct_key_environment_mismatch" });
  });

  it("uses Gateway only to create a live vault and billing id", async () => {
    const liveEnv = {
      ...providerEnv,
      EASY_PAY_DIRECT_COMMERCE_API_KEY: "epd_synthetic_sk_live_secret",
      EASY_PAY_DIRECT_NETWORK_MODE: "production",
      EASY_PAY_DIRECT_LIVEMODE_ALLOWED: "1",
    } satisfies EasyPayDirectEnv;
    const providerFetch = vi.fn<typeof fetch>(async (_url, init) => {
      const body = new URLSearchParams(String(init?.body));
      if (body.get("customer_vault") === "add_customer") {
        return new Response("response=1&responsetext=Approved&customer_vault_id=vault-1");
      }
      expect(body.get("customer_vault_id")).toBe("vault-1");
      return new Response(
        "response=1&responsetext=Approved&customer_vault_id=vault-1&billing_id=billing-1",
      );
    });
    await expect(
      vaultEasyPayDirectCard(liveEnv, { paymentToken: "token-1" }, providerFetch),
    ).resolves.toEqual({ customerVaultId: "vault-1", billingId: "billing-1" });
  });

  it("refunds by Commerce order id and returns the provider refund id", async () => {
    const providerFetch = vi.fn<typeof fetch>(async (input, init) => {
      expect(String(input).endsWith("/orders/order-1/refund")).toBe(true);
      expect(JSON.parse(String(init?.body))).toEqual({ amount: 500 });
      return Response.json({
        id: "order-1",
        status: "partially_refunded",
        total: 1999,
        currency: "usd",
        transactions: [
          { id: "refund-1", type: "refund", processor_transaction_id: "gateway-refund-1" },
        ],
      });
    });
    await expect(
      refundEasyPayDirectOrder(
        providerEnv,
        {
          orderId: "order-1",
          amountMinor: 500,
          currency: "USD",
          idempotencyKey: "550e8400-e29b-41d4-a716-446655440004",
        },
        providerFetch,
      ),
    ).resolves.toEqual({
      id: "gateway-refund-1",
      status: "succeeded",
      responseText: "partially_refunded",
    });
  });
});
