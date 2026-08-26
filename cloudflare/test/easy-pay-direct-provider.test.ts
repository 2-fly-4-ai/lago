import { describe, expect, it, vi } from "vitest";
import type { EasyPayDirectEnv } from "../src/providers/easy-pay-direct";
import {
  addEasyPayDirectPaymentMethod,
  chargeEasyPayDirectGatewayTestToken,
  createEasyPayDirectCheckoutUrl,
  createEasyPayDirectCustomer,
  createEasyPayDirectOrder,
  createEasyPayDirectProduct,
  easyPayDirectPaymentForm,
  easyPayDirectSandboxTool,
  getEasyPayDirectOrder,
  refundEasyPayDirectOrder,
  resolveEasyPayDirectSuccessRedirect,
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

const gatewayTestEnv = {
  ...providerEnv,
  EASY_PAY_DIRECT_NETWORK_MODE: "gateway_test",
} satisfies EasyPayDirectEnv;

describe("Easy Pay Direct provider", () => {
  it("allows only the configured Store success route and preserves its checkout state", () => {
    const configured = "https://store.test/checkout/success";
    expect(
      resolveEasyPayDirectSuccessRedirect(
        "https://store.test/checkout/success?session_id=lago%3Ainvoice-1&provider=easy_pay_direct",
        configured,
      ),
    ).toBe(
      "https://store.test/checkout/success?session_id=lago%3Ainvoice-1&provider=easy_pay_direct",
    );
    expect(() =>
      resolveEasyPayDirectSuccessRedirect(
        "https://attacker.test/checkout/success?session_id=lago%3Ainvoice-1",
        configured,
      ),
    ).toThrowError(expect.objectContaining({ code: "easy_pay_direct_redirect_invalid" }));
    expect(() =>
      resolveEasyPayDirectSuccessRedirect(
        "https://store.test/other-path?session_id=lago%3Ainvoice-1",
        configured,
      ),
    ).toThrowError(expect.objectContaining({ code: "easy_pay_direct_redirect_invalid" }));
  });

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

  it("keeps synthetic outcomes on a separate no-store internal QA surface", async () => {
    const now = Date.parse("2026-08-22T00:00:00.000Z");
    const checkout = await createEasyPayDirectCheckoutUrl(
      providerEnv,
      { checkoutIntentId: "intent-synthetic-2" },
      now,
    );
    const sandboxUrl = new URL(checkout.paymentUrl);
    sandboxUrl.pathname = "/easy_pay_direct/sandbox_tool";
    const response = await easyPayDirectSandboxTool(sandboxUrl, providerEnv, now);
    const body = await response.text();
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(body).toContain("card_visa");
    expect(body).toContain("Internal payment testing");
    expect(body).not.toContain("synthetic-tokenization-key");
    expect(body).not.toContain("Collect.js");
  });

  it("renders hosted EPD card fields for the product canary and never exposes synthetic outcomes", async () => {
    const now = Date.parse("2026-08-22T00:00:00.000Z");
    const checkout = await createEasyPayDirectCheckoutUrl(
      gatewayTestEnv,
      { checkoutIntentId: "intent-gateway-test-1" },
      now,
    );
    const response = await easyPayDirectPaymentForm(
      new URL(checkout.paymentUrl),
      gatewayTestEnv,
      now,
      {
        title: "SERP 1-App Premium Plan",
        description: "One premium SERP app subscription.",
        interval: "monthly",
        amountMinor: 1850,
        subtotalMinor: 3700,
        taxMinor: 0,
        creditsMinor: 1850,
        currency: "USD",
        customerEmail: "synthetic@example.test",
      },
    );
    const body = await response.text();
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(response.headers.get("Content-Security-Policy")).toContain(
      "https://secure.easypaydirectgateway.com",
    );
    expect(response.headers.get("Content-Security-Policy")).toContain(
      "https://applepay.cdn-apple.com",
    );
    expect(body).toContain("Collect.js");
    expect(body).toContain("synthetic-tokenization-key");
    expect(body).toContain('id="ccnumber"');
    expect(body).toContain('id="ccexp"');
    expect(body).toContain('id="cvv"');
    expect(body).toContain("Card number");
    expect(body).toContain("Expiration");
    expect(body).toContain("Security code");
    expect(body).toContain("1234 1234 1234 1234");
    expect(body).toContain("MM / YY");
    expect(body).toContain("styleSniffer:false");
    expect(body).toContain("fieldsAvailableCallback");
    expect(body).toContain("Card details are securely tokenized by Easy Pay Direct");
    expect(body).toContain("Test cards only. No real money will move.");
    expect(body).toContain("SERP 1-App Premium Plan");
    expect(body).toContain("Subscribe to SERP 1-App Premium Plan");
    expect(body).toContain("$18.50");
    expect(body).toContain("$37.00");
    expect(body).toContain("Discounts &amp; credits");
    expect(body).toContain("synthetic@example.test");
    expect(body).toContain("https://apps.serp.co/legal/terms");
    expect(body).toContain("https://apps.serp.co/privacy");
    expect(body).toContain("terms_accepted");
    expect(body).toContain("Other SERP products continue using the existing Stripe checkout");
    expect(body).toContain('src="https://apps.serp.co/logo.svg"');
    expect(body).toContain(".hosted-field iframe");
    expect(body).toContain('id="pay" class="pay-button" type="button" disabled');
    expect(body).not.toContain("card_visa");
    expect(body).not.toContain("Sandbox outcome");
  });

  it("labels one-time product checkouts as purchases instead of subscriptions", async () => {
    const now = Date.parse("2026-08-22T00:00:00.000Z");
    const checkout = await createEasyPayDirectCheckoutUrl(
      gatewayTestEnv,
      { checkoutIntentId: "intent-gateway-test-one-time" },
      now,
    );
    const response = await easyPayDirectPaymentForm(
      new URL(checkout.paymentUrl),
      gatewayTestEnv,
      now,
      {
        title: "Synthetic Store App Plan",
        description: "One SERP app.",
        interval: "one_time",
        amountMinor: 900,
        subtotalMinor: 900,
        taxMinor: 0,
        creditsMinor: 0,
        currency: "USD",
        customerEmail: null,
      },
    );
    const body = await response.text();
    expect(body).toContain("Buy Synthetic Store App Plan");
    expect(body).toContain("One-time payment");
    expect(body).not.toContain("Subscribe to Synthetic Store App Plan");
  });

  it("collects an email on the provider checkout when the Store customer is anonymous", async () => {
    const now = Date.parse("2026-08-22T00:00:00.000Z");
    const checkout = await createEasyPayDirectCheckoutUrl(
      gatewayTestEnv,
      { checkoutIntentId: "intent-gateway-test-guest" },
      now,
    );
    const response = await easyPayDirectPaymentForm(
      new URL(checkout.paymentUrl),
      gatewayTestEnv,
      now,
      {
        title: "SERP App Plan",
        description: "One SERP app.",
        interval: "monthly",
        amountMinor: 900,
        subtotalMinor: 900,
        taxMinor: 0,
        creditsMinor: 0,
        currency: "USD",
        customerEmail: null,
      },
    );
    const body = await response.text();
    expect(body).toContain('id="email" class="input" type="email" placeholder="you@example.com"');
    expect(body).toContain("Your receipt and product access will be linked to this email.");
    expect(body).toContain("...(emailInput?{email}:{})");
  });

  it("fails closed instead of showing the synthetic picker as a product checkout", async () => {
    const now = Date.parse("2026-08-22T00:00:00.000Z");
    const checkout = await createEasyPayDirectCheckoutUrl(
      providerEnv,
      { checkoutIntentId: "intent-commerce-test-only" },
      now,
    );
    await expect(
      easyPayDirectPaymentForm(new URL(checkout.paymentUrl), providerEnv, now),
    ).rejects.toMatchObject({ code: "easy_pay_direct_gateway_test_not_configured" });
  });

  it("submits hosted tokens only as forced Gateway test transactions", async () => {
    const providerFetch = vi.fn<typeof fetch>(async (input, init) => {
      expect(String(input)).toBe("https://secure.easypaydirectgateway.com/api/transact.php");
      const body = new URLSearchParams(String(init?.body));
      expect(body.get("type")).toBe("sale");
      expect(body.get("payment_token")).toBe("hosted-token-1");
      expect(body.get("amount")).toBe("19.99");
      expect(body.get("currency")).toBe("USD");
      expect(body.get("test_mode")).toBe("enabled");
      expect(body.get("security_key")).toBe("synthetic-security-key");
      expect(body.has("ccnumber")).toBe(false);
      expect(body.has("ccexp")).toBe(false);
      expect(body.has("cvv")).toBe(false);
      return new Response(
        "response=1&responsetext=Approved&response_code=100&transactionid=txn-test-1&authcode=TEST&orderid=payment-request-1&customer_vault_id=vault-test-1",
      );
    });
    await expect(
      chargeEasyPayDirectGatewayTestToken(
        gatewayTestEnv,
        {
          paymentToken: "hosted-token-1",
          amountMinor: 1999,
          currency: "USD",
          orderId: "payment-request-1",
          orderDescription: "SERP1F test checkout",
          customerEmail: "synthetic@example.test",
          firstName: "Synthetic",
          lastName: "Customer",
          phone: "+15555550123",
          idempotencyKey: "550e8400-e29b-41d4-a716-446655440005",
        },
        providerFetch,
      ),
    ).resolves.toMatchObject({
      id: "txn-test-1",
      status: "succeeded",
      responseCode: "100",
      customerVaultId: "vault-test-1",
    });
    expect(providerFetch).toHaveBeenCalledOnce();
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
    await expect(
      createEasyPayDirectCheckoutUrl(
        { ...gatewayTestEnv, EASY_PAY_DIRECT_LIVEMODE_ALLOWED: "1" },
        { checkoutIntentId: "intent-1" },
      ),
    ).rejects.toMatchObject({
      code: "easy_pay_direct_gateway_test_requires_livemode_disabled",
    });
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
