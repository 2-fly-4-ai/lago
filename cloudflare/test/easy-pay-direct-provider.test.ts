import { describe, expect, it, vi } from "vitest";
import type { EasyPayDirectEnv } from "../src/providers/easy-pay-direct";
import {
  addEasyPayDirectPaymentMethod,
  chargeEasyPayDirectGatewayToken,
  chargeEasyPayDirectStoredMethod,
  createEasyPayDirectCheckoutUrl,
  createEasyPayDirectCustomer,
  createEasyPayDirectOrder,
  createEasyPayDirectProduct,
  easyPayDirectPaymentForm,
  easyPayDirectSandboxTool,
  findEasyPayDirectCustomerByEmail,
  retrieveEasyPayDirectCustomer,
  getEasyPayDirectOrder,
  findEasyPayDirectGatewayTransactionByOrderId,
  refundEasyPayDirectOrder,
  readEasyPayDirectRefundTransaction,
  resolveEasyPayDirectSuccessRedirect,
  vaultEasyPayDirectCard,
  verifyEasyPayDirectCheckoutToken,
} from "../src/providers/easy-pay-direct";

const providerEnv = {
  APP_ENV: "development",
  EASY_PAY_DIRECT_COMMERCE_API_KEY: "epd_synthetic_sk_test_secret",
  EASY_PAY_DIRECT_SECURITY_KEY: "synthetic-security-key",
  EASY_PAY_DIRECT_TOKENIZATION_KEY: "test-tokenization-key",
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
  it.each(["response", "transactionid", "customer_vault_id", "orderid"])(
    "rejects ambiguous approved-sale binding field %s without retrying",
    async (field) => {
      const providerFetch = vi.fn<typeof fetch>(
        async () =>
          new Response(
            `response=1&transactionid=123&customer_vault_id=456&orderid=fixture-order&${field}=duplicate`,
          ),
      );
      await expect(
        chargeEasyPayDirectGatewayToken(
          gatewayTestEnv,
          {
            purchaseKind: "recurring",
            paymentToken: "fixture-token",
            amountMinor: 900,
            currency: "USD",
            orderId: "fixture-order",
            orderDescription: "Fixture",
            customerEmail: "fixture@example.test",
            firstName: "Fixture",
            lastName: "Customer",
            phone: "+15555550123",
            idempotencyKey: "fixture-key",
          },
          providerFetch,
        ),
      ).rejects.toMatchObject({ code: "easy_pay_direct_gateway_outcome_unknown" });
      expect(providerFetch).toHaveBeenCalledOnce();
    },
  );
  const querySale =
    "<transaction><transaction_id>fixture-txn</transaction_id><order_id>fixture-order</order_id><condition>complete</condition><currency>USD</currency><action><action_type>sale</action_type><success>1</success><amount>9.00</amount></action></transaction>";

  it.each([
    "",
    "<html>Unavailable</html>",
    `<nm_response>${querySale}`,
    `<nm_response>${querySale}<transaction><transaction_id>missing-order</transaction_id></transaction></nm_response>`,
    `<nm_response>${querySale}<transaction/></nm_response>`,
    `<nm_response>${querySale.replace("<condition>", "<transaction_id/><condition>")}</nm_response>`,
    `<nm_response>${querySale.replace("</transaction>", "<action/></transaction>")}</nm_response>`,
    `<nm_response>${querySale.replace("</transaction>", "<action><success>1</success></action></transaction>")}</nm_response>`,
    `<nm_response>${querySale}<transaction></nm_response>`,
    `<nm_response>${querySale.replace("fixture-order", "wrong-order")}</nm_response>`,
    `<nm_response>${querySale.replace("<condition>", "<transaction_id>duplicate</transaction_id><condition>")}</nm_response>`,
    `<nm_response>${querySale.replace("<success>1</success>", "<success>1</success><success>0</success>")}</nm_response>`,
    `<nm_response>${querySale.replace("<currency>USD</currency>", "<currency><value>USD</value></currency>")}</nm_response>`,
    `<nm_response>${querySale}<error>provider failure</error></nm_response>`,
    `<nm_response>${querySale.repeat(10)}</nm_response>`,
    `<nm_response>${querySale}</nm_response><nm_response/>`,
    `<!DOCTYPE nm_response><nm_response>${querySale}</nm_response>`,
  ])("rejects incomplete/malformed Gateway query evidence %#", async (raw) => {
    await expect(
      findEasyPayDirectGatewayTransactionByOrderId(
        gatewayTestEnv,
        "fixture-order",
        async () => new Response(raw),
      ),
    ).rejects.toMatchObject({ code: "easy_pay_direct_provider_read_invalid" });
  });

  it("rejects duplicate rows even when their transaction IDs match", async () => {
    await expect(
      findEasyPayDirectGatewayTransactionByOrderId(
        gatewayTestEnv,
        "fixture-order",
        async () => new Response(`<nm_response>${querySale}${querySale}</nm_response>`),
      ),
    ).rejects.toMatchObject({ code: "easy_pay_direct_provider_read_ambiguous" });
  });

  it("requests a bounded first page and accepts its single complete transaction", async () => {
    const fetcher = vi.fn<typeof fetch>(async (_url, init) => {
      const body = new URLSearchParams(String(init?.body));
      expect(body.get("result_limit")).toBe("10");
      expect(body.get("page_number")).toBe("0");
      return new Response(`<?xml version="1.0"?><nm_response>${querySale}</nm_response>`);
    });
    await expect(
      findEasyPayDirectGatewayTransactionByOrderId(gatewayTestEnv, "fixture-order", fetcher),
    ).resolves.toMatchObject({ id: "fixture-txn", status: "succeeded", amountMinor: 900 });
    expect(fetcher).toHaveBeenCalledOnce();
  });
  const storedCharge = {
    amountMinor: 900,
    currency: "USD",
    customerVaultId: "fixture-vault",
    billingId: "fixture-billing",
    initialTransactionId: "fixture-initial",
    orderId: "fixture-renewal",
    orderDescription: "Fixture renewal",
    idempotencyKey: "fixture-idempotency",
  };

  it.each(["gateway_test", "production"] as const)(
    "direct Gateway %s charge and query do not require Commerce credentials",
    async (mode) => {
      const env: EasyPayDirectEnv = {
        ...gatewayTestEnv,
        APP_ENV: mode === "production" ? "production" : "development",
        EASY_PAY_DIRECT_COMMERCE_API_KEY: undefined,
        EASY_PAY_DIRECT_NETWORK_MODE: mode,
        EASY_PAY_DIRECT_LIVEMODE_ALLOWED: mode === "production" ? "1" : "0",
      };
      const providerFetch = vi.fn<typeof fetch>(async (_url, init) => {
        const body = new URLSearchParams(String(init?.body));
        expect(body.get("security_key")).toBe("synthetic-security-key");
        expect(body.get("test_mode")).toBe(mode === "gateway_test" ? "enabled" : null);
        expect(body.has("dup_seconds")).toBe(false);
        expect(body.get("orderid")).toBe(storedCharge.orderId);
        expect(body.get("merchant_defined_field_1")).toBe(
          `lago_idempotency_key=${storedCharge.idempotencyKey}`,
        );
        return new Response("response=1&transactionid=fixture-renewal-txn");
      });
      await expect(
        chargeEasyPayDirectStoredMethod(env, storedCharge, providerFetch),
      ).resolves.toMatchObject({ status: "succeeded" });
      await expect(
        findEasyPayDirectGatewayTransactionByOrderId(
          env,
          "fixture-renewal",
          async () => new Response("<nm_response/>"),
        ),
      ).resolves.toBeNull();
      if (mode === "production") {
        await expect(
          vaultEasyPayDirectCard(
            env,
            { paymentToken: "fixture-token", billingId: "fixture-billing" },
            async () => new Response("response=1&customer_vault_id=fixture-vault"),
          ),
        ).resolves.toMatchObject({ customerVaultId: "fixture-vault" });
      }
    },
  );

  it.each([301, 302, 303, 307, 308])(
    "rejects Gateway transaction redirect %s without forwarding the signed POST",
    async (status) => {
      const providerFetch = vi.fn<typeof fetch>(async (_url, init) => {
        expect(init?.redirect).toBe("manual");
        return new Response("response=1&transactionid=redirect-approval", {
          status,
          headers: { Location: "https://redirect.example.test/capture" },
        });
      });
      await expect(
        chargeEasyPayDirectStoredMethod(gatewayTestEnv, storedCharge, providerFetch),
      ).rejects.toMatchObject({ code: "easy_pay_direct_gateway_outcome_unknown" });
      expect(providerFetch).toHaveBeenCalledOnce();
    },
  );

  it.each([301, 302, 303, 307, 308])(
    "rejects Gateway vault redirect %s without forwarding the signed POST",
    async (status) => {
      const providerFetch = vi.fn<typeof fetch>(async (_url, init) => {
        expect(init?.redirect).toBe("manual");
        return new Response("", {
          status,
          headers: { Location: "https://redirect.example.test/capture" },
        });
      });
      await expect(
        vaultEasyPayDirectCard(
          {
            ...gatewayTestEnv,
            APP_ENV: "production",
            EASY_PAY_DIRECT_NETWORK_MODE: "production",
            EASY_PAY_DIRECT_LIVEMODE_ALLOWED: "1",
          },
          { paymentToken: "fixture-token", billingId: "fixture-billing" },
          providerFetch,
        ),
      ).rejects.toMatchObject({ code: "easy_pay_direct_gateway_vault_failed" });
      expect(providerFetch).toHaveBeenCalledOnce();
    },
  );

  it.each([301, 302, 303, 307, 308])(
    "rejects Gateway Query redirect %s without forwarding the signed POST",
    async (status) => {
      const providerFetch = vi.fn<typeof fetch>(async (_url, init) => {
        expect(init?.redirect).toBe("manual");
        return new Response("", {
          status,
          headers: { Location: "https://redirect.example.test/capture" },
        });
      });
      await expect(
        findEasyPayDirectGatewayTransactionByOrderId(
          gatewayTestEnv,
          "fixture-order",
          providerFetch,
        ),
      ).rejects.toMatchObject({ code: "easy_pay_direct_provider_read_failed" });
      expect(providerFetch).toHaveBeenCalledOnce();
    },
  );

  it.each([
    { mode: "production", live: "0", appEnv: undefined },
    { mode: "production", live: undefined, appEnv: undefined },
    { mode: "production", live: "1", appEnv: "development" },
    { mode: "gateway_test", live: "1", appEnv: undefined },
    { mode: "gateway_test", live: undefined, appEnv: undefined },
    { mode: "gateway_test", live: "0", appEnv: "production" },
    { mode: "test", live: "0", appEnv: undefined },
    { mode: "disabled", live: "0", appEnv: undefined },
  ] as const)(
    "direct Gateway rejects unsafe network posture %j before fetch",
    async ({ mode, live, appEnv }) => {
      const providerFetch = vi.fn<typeof fetch>();
      const env = {
        ...gatewayTestEnv,
        ...(appEnv ? { APP_ENV: appEnv } : {}),
        EASY_PAY_DIRECT_COMMERCE_API_KEY: undefined,
        EASY_PAY_DIRECT_NETWORK_MODE: mode,
        EASY_PAY_DIRECT_LIVEMODE_ALLOWED: live,
      };
      await expect(
        chargeEasyPayDirectStoredMethod(env, storedCharge, providerFetch),
      ).rejects.toThrow();
      await expect(
        findEasyPayDirectGatewayTransactionByOrderId(env, "fixture-renewal", providerFetch),
      ).rejects.toThrow();
      expect(providerFetch).not.toHaveBeenCalled();
    },
  );

  it("direct Gateway still requires its own key and Commerce still requires its key", async () => {
    const providerFetch = vi.fn<typeof fetch>();
    await expect(
      chargeEasyPayDirectStoredMethod(
        { ...gatewayTestEnv, EASY_PAY_DIRECT_SECURITY_KEY: undefined },
        storedCharge,
        providerFetch,
      ),
    ).rejects.toThrow();
    await expect(
      getEasyPayDirectOrder(
        { ...gatewayTestEnv, EASY_PAY_DIRECT_COMMERCE_API_KEY: undefined },
        "fixture-order",
        providerFetch,
      ),
    ).rejects.toThrow();
    expect(providerFetch).not.toHaveBeenCalled();
  });
  it.each([
    { condition: "complete", actions: "sale:1:9.00", status: "succeeded", amount: 900 },
    { condition: "failed", actions: "sale:0:9.00", status: "failed", amount: 900 },
    { condition: "complete", actions: "sale:1:4.50", status: "succeeded", amount: 450 },
    { condition: "canceled", actions: "sale:1:9.00,void:1:9.00", status: "unknown", amount: 900 },
    { condition: "complete", actions: "sale:1:9.00,refund:1:1.00", status: "unknown", amount: 900 },
    { condition: "complete", actions: "sale:0:9.00,refund:1:9.00", status: "unknown", amount: 900 },
    { condition: "complete", actions: "auth:1:9.00", status: "unknown", amount: null },
    { condition: "complete", actions: "sale:1:9.00,sale:1:9.00", status: "unknown", amount: null },
    { condition: "complete", actions: "", status: "unknown", amount: null },
    { condition: "pending", actions: "sale:1:9.00", status: "unknown", amount: 900 },
  ])(
    "uses typed sale evidence for Gateway query %j",
    async ({ condition, actions, status, amount }) => {
      const actionXml = actions
        .split(",")
        .filter(Boolean)
        .map((entry) => {
          const [type, success, actual] = entry.split(":");
          return `<action><action_type>${type}</action_type><success>${success}</success><amount>${actual}</amount><requested_amount>9.00</requested_amount></action>`;
        })
        .join("");
      const result = await findEasyPayDirectGatewayTransactionByOrderId(
        gatewayTestEnv,
        "query-order",
        async () =>
          new Response(
            `<nm_response><transaction><transaction_id>query-transaction</transaction_id><order_id>query-order</order_id><condition>${condition}</condition><currency>USD</currency>${actionXml}</transaction></nm_response>`,
          ),
      );
      expect(result).toMatchObject({ status, amountMinor: amount, currency: "USD" });
    },
  );
  it.each([{ data: [{ id: "one" }, { id: "two" }] }, { data: [{ id: "one" }], has_more: true }])(
    "rejects ambiguous email lookup rather than selecting the first customer",
    async (body) => {
      const providerFetch = vi.fn<typeof fetch>(async (input) => {
        expect(new URL(String(input)).searchParams.get("limit")).toBe("2");
        return Response.json(body);
      });
      await expect(
        findEasyPayDirectCustomerByEmail(providerEnv, "fixture@example.test", providerFetch),
      ).rejects.toMatchObject({ code: "easy_pay_direct_customer_ambiguous" });
    },
  );

  it.each([{}, { data: [null] }, { data: [{}] }, { data: [{ id: " " }] }])(
    "does not turn malformed lookup %j into permission to create another customer",
    async (body) => {
      await expect(
        findEasyPayDirectCustomerByEmail(providerEnv, "fixture@example.test", async () =>
          Response.json(body),
        ),
      ).rejects.toMatchObject({ code: "easy_pay_direct_invalid_response" });
    },
  );

  it("rejects a customer read that returns a different identity", async () => {
    await expect(
      retrieveEasyPayDirectCustomer(providerEnv, "expected-customer", async () =>
        Response.json({ id: "wrong-customer" }),
      ),
    ).rejects.toMatchObject({ code: "easy_pay_direct_customer_vault_mismatch" });
  });

  it("rejects a payment method returned for another customer", async () => {
    await expect(
      addEasyPayDirectPaymentMethod(
        providerEnv,
        { customerId: "expected-customer", billingId: "1234", idempotencyKey: "fixture-key" },
        async () => Response.json({ id: "method-1", customer: "wrong-customer" }),
      ),
    ).rejects.toMatchObject({ code: "easy_pay_direct_customer_vault_mismatch" });
  });

  it("does not hide a gateway response that names a different vault", async () => {
    await expect(
      vaultEasyPayDirectCard(
        {
          ...providerEnv,
          APP_ENV: "production",
          EASY_PAY_DIRECT_NETWORK_MODE: "production",
          EASY_PAY_DIRECT_LIVEMODE_ALLOWED: "1",
          EASY_PAY_DIRECT_COMMERCE_API_KEY: "epd_synthetic_sk_live_secret",
        },
        {
          paymentToken: "fictional-token",
          billingId: "fixture-key",
          existingCustomerVaultId: "expected-vault",
        },
        async () => new Response("response=1&customer_vault_id=wrong-vault&billing_id=123"),
      ),
    ).rejects.toMatchObject({ code: "easy_pay_direct_customer_vault_mismatch" });
  });

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

  it("creates and renders Gateway test checkout without Commerce credentials", async () => {
    const env = { ...gatewayTestEnv, EASY_PAY_DIRECT_COMMERCE_API_KEY: undefined };
    const now = Date.parse("2026-09-08T00:00:00.000Z");
    const checkout = await createEasyPayDirectCheckoutUrl(
      env,
      { checkoutIntentId: "fixture-gateway-only" },
      now,
    );
    const response = await easyPayDirectPaymentForm(new URL(checkout.paymentUrl), env, now, {
      title: "Fixture plan",
      description: "Fixture",
      interval: "monthly",
      amountMinor: 900,
      subtotalMinor: 900,
      taxMinor: 0,
      creditsMinor: 0,
      currency: "USD",
      customerEmail: "fixture@example.test",
    });
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("Collect.js");
  });

  it.each([
    { EASY_PAY_DIRECT_NETWORK_MODE: "gateway_test", EASY_PAY_DIRECT_LIVEMODE_ALLOWED: "1" },
    { EASY_PAY_DIRECT_NETWORK_MODE: "gateway_test", EASY_PAY_DIRECT_LIVEMODE_ALLOWED: undefined },
    { EASY_PAY_DIRECT_NETWORK_MODE: "gateway_test", EASY_PAY_DIRECT_SECURITY_KEY: undefined },
    { EASY_PAY_DIRECT_NETWORK_MODE: "production", EASY_PAY_DIRECT_LIVEMODE_ALLOWED: "1" },
    { EASY_PAY_DIRECT_NETWORK_MODE: "disabled" },
  ] as const)(
    "Gateway checkout credential split does not relax other boundaries %#",
    async (override) => {
      const env = { ...gatewayTestEnv, EASY_PAY_DIRECT_COMMERCE_API_KEY: undefined, ...override };
      const now = Date.parse("2026-09-08T00:00:00.000Z");
      await expect(
        createEasyPayDirectCheckoutUrl(env, { checkoutIntentId: "fixture-boundary" }, now),
      ).rejects.toThrow();
      const valid = await createEasyPayDirectCheckoutUrl(
        gatewayTestEnv,
        { checkoutIntentId: "fixture-boundary" },
        now,
      );
      await expect(easyPayDirectPaymentForm(new URL(valid.paymentUrl), env, now)).rejects.toThrow();
    },
  );

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
    expect(body).toContain("Synthetic outcomes only");
    expect(body).not.toContain("test-tokenization-key");
    expect(body).not.toContain("Collect.js");
  });

  it("renders hosted EPD card fields without exposing internal routing or QA language", async () => {
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
        customerEmail: "customer@example.test",
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
    expect(body).toContain("test-tokenization-key");
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
    expect(body).toContain("customer@example.test");
    expect(body).toContain("https://apps.serp.co/legal/terms");
    expect(body).toContain("https://apps.serp.co/privacy");
    expect(body).toContain("terms_accepted");
    expect(body).toContain('src="https://apps.serp.co/logo.svg"');
    expect(body).toContain(".hosted-field iframe");
    expect(body).toContain('id="pay" class="pay-button" type="button" disabled');
    expect(body).not.toContain("card_visa");
    expect(body).not.toContain("Sandbox outcome");
    expect(body).not.toMatch(
      /Synthetic outcomes|Internal payment testing|Product canary|routed through Lago/iu,
    );
  });

  it("collects a complete US billing address before requesting a tax-inclusive total", async () => {
    const now = Date.parse("2026-08-22T00:00:00.000Z");
    const checkout = await createEasyPayDirectCheckoutUrl(
      gatewayTestEnv,
      { checkoutIntentId: "intent-gateway-tax-address" },
      now,
    );
    const taxEnv = {
      ...gatewayTestEnv,
      EASY_PAY_DIRECT_TAX_MODE: "enforced",
    } satisfies EasyPayDirectEnv;
    const response = await easyPayDirectPaymentForm(new URL(checkout.paymentUrl), taxEnv, now, {
      title: "SERP App Plan",
      description: "One SERP app.",
      interval: "monthly",
      amountMinor: 900,
      subtotalMinor: 900,
      taxMinor: 0,
      creditsMinor: 0,
      currency: "USD",
      customerEmail: null,
    });
    const body = await response.text();
    expect(response.headers.get("Content-Security-Policy")).toContain("'nonce-epd-address-script'");
    expect(body).toContain('id="address-line"');
    expect(body).toContain('id="city"');
    expect(body).toContain('id="state"');
    expect(body).toContain('id="postal-code"');
    expect(body).toContain("address_line:addressLine?.value.trim()||null");
    expect(body).toContain("confirmed:addressConfirmed");
    expect(body).toContain("checkout_tax_address_correction_required");
    expect(body).toContain("normalized_address");
    expect(body).toContain("Enter your street address and city");
    expect(body).toContain("document.getElementById('tax-amount').textContent='—'");
    expect(body).toContain("document.getElementById('total-due').textContent='—'");
    expect(body).toContain("document.getElementById('headline-total').textContent='—'");
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
        description: "Synthetic-only Store fixture.",
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
    expect(body).toContain("Buy SERP App Plan");
    expect(body).toContain("One-time payment");
    expect(body).not.toContain("Subscribe to SERP App Plan");
    expect(body).not.toMatch(
      /Synthetic|Sandbox outcome|Internal payment testing|Product canary|routed through Lago/iu,
    );
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

  it.each([
    ["gateway_test", "one_time"],
    ["gateway_test", "recurring"],
    ["production", "one_time"],
    ["production", "recurring"],
  ] as const)(
    "submits %s %s hosted tokens through the direct Gateway contract",
    async (mode, purchaseKind) => {
      const directEnv: EasyPayDirectEnv = {
        ...gatewayTestEnv,
        APP_ENV: mode === "production" ? "production" : "development",
        EASY_PAY_DIRECT_NETWORK_MODE: mode,
        EASY_PAY_DIRECT_LIVEMODE_ALLOWED: mode === "production" ? "1" : "0",
      };
      const providerFetch = vi.fn<typeof fetch>(async (input, init) => {
        expect(String(input)).toBe("https://secure.easypaydirectgateway.com/api/transact.php");
        const body = new URLSearchParams(String(init?.body));
        expect(body.get("type")).toBe("sale");
        expect(body.get("payment_token")).toBe("hosted-token-1");
        expect(body.get("amount")).toBe("19.99");
        expect(body.get("currency")).toBe("USD");
        expect(body.get("test_mode")).toBe(mode === "gateway_test" ? "enabled" : null);
        expect(body.get("security_key")).toBe("synthetic-security-key");
        expect(body.has("ccnumber")).toBe(false);
        expect(body.has("dup_seconds")).toBe(false);
        expect(body.has("ccexp")).toBe(false);
        expect(body.has("cvv")).toBe(false);
        for (const [key, value] of Object.entries({
          customer_vault: "add_customer",
          initiated_by: "customer",
          stored_credential_indicator: "stored",
          billing_method: "initial_recurring",
        })) {
          expect(body.get(key)).toBe(purchaseKind === "recurring" ? value : null);
        }
        return new Response(
          "response=1&responsetext=Approved&response_code=100&transactionid=txn-test-1&authcode=TEST&orderid=payment-request-1&customer_vault_id=vault-test-1",
        );
      });
      await expect(
        chargeEasyPayDirectGatewayToken(
          directEnv,
          {
            purchaseKind,
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
    },
  );

  it.each([undefined, "invalid", "monthly"])(
    "rejects missing or invalid purchase kind %s without contacting Gateway",
    async (purchaseKind) => {
      const providerFetch = vi.fn<typeof fetch>();
      await expect(
        chargeEasyPayDirectGatewayToken(
          gatewayTestEnv,
          {
            // @ts-expect-error Exercise untrusted runtime input, not the TypeScript contract.
            purchaseKind,
            paymentToken: "fixture-token",
            amountMinor: 900,
            currency: "USD",
            orderId: "fixture-order",
            orderDescription: "Fixture",
            customerEmail: "fixture@example.test",
            firstName: "Fixture",
            lastName: "Customer",
            phone: "+15555550123",
            idempotencyKey: "fixture-key",
          },
          providerFetch,
        ),
      ).rejects.toMatchObject({ code: "easy_pay_direct_purchase_kind_invalid" });
      expect(providerFetch).not.toHaveBeenCalled();
    },
  );

  it.each([301, 302, 303, 307, 308])(
    "rejects Commerce API redirect %s without forwarding its authenticated POST",
    async (status) => {
      const providerFetch = vi.fn<typeof fetch>(async (_url, init) => {
        expect(init?.redirect).toBe("manual");
        return Response.json(
          { id: "redirect-customer", default_payment_method: "redirect-method" },
          {
            status,
            headers: { Location: "https://redirect.example.test/capture" },
          },
        );
      });
      await expect(
        createEasyPayDirectCustomer(
          providerEnv,
          {
            email: "redirect@example.test",
            firstName: "Redirect",
            lastName: "Fixture",
            phone: "+15555550123",
            gatewayVaultId: "card_visa",
            idempotencyKey: "550e8400-e29b-41d4-a716-446655440099",
            metadata: { lago_customer_id: "redirect-fixture" },
          },
          providerFetch,
        ),
      ).rejects.toThrow();
      expect(providerFetch).toHaveBeenCalledOnce();
    },
  );

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

  it("uses a Collect.js token exactly once to create a live vault and billing id", async () => {
    const liveEnv = {
      ...providerEnv,
      APP_ENV: "production",
      EASY_PAY_DIRECT_COMMERCE_API_KEY: "epd_synthetic_sk_live_secret",
      EASY_PAY_DIRECT_NETWORK_MODE: "production",
      EASY_PAY_DIRECT_LIVEMODE_ALLOWED: "1",
    } satisfies EasyPayDirectEnv;
    let submittedBillingId = "";
    const providerFetch = vi.fn<typeof fetch>(async (_url, init) => {
      const body = new URLSearchParams(String(init?.body));
      expect(body.get("customer_vault")).toBe("add_customer");
      expect(body.get("customer_vault_id")).toBeNull();
      submittedBillingId = body.get("billing_id") ?? "";
      expect(submittedBillingId).toMatch(/^\d{32}$/u);
      expect(body.get("payment_token")).toBe("token-1");
      return new Response("response=1&responsetext=Approved&customer_vault_id=vault-1");
    });
    const result = await vaultEasyPayDirectCard(
      liveEnv,
      { paymentToken: "token-1", billingId: "billing-1" },
      providerFetch,
    );
    expect(result).toEqual({ customerVaultId: "vault-1", billingId: submittedBillingId });
    expect(providerFetch).toHaveBeenCalledOnce();
  });

  it("uses a Collect.js token exactly once when adding billing to an existing vault", async () => {
    const liveEnv = {
      ...providerEnv,
      APP_ENV: "production",
      EASY_PAY_DIRECT_COMMERCE_API_KEY: "epd_synthetic_sk_live_secret",
      EASY_PAY_DIRECT_NETWORK_MODE: "production",
      EASY_PAY_DIRECT_LIVEMODE_ALLOWED: "1",
    } satisfies EasyPayDirectEnv;
    let submittedBillingId = "";
    const providerFetch = vi.fn<typeof fetch>(async (_url, init) => {
      const body = new URLSearchParams(String(init?.body));
      expect(body.get("customer_vault")).toBe("add_billing");
      expect(body.get("customer_vault_id")).toBe("vault-1");
      submittedBillingId = body.get("billing_id") ?? "";
      expect(submittedBillingId).toMatch(/^\d{32}$/u);
      expect(body.get("payment_token")).toBe("token-2");
      return new Response(
        `response=1&responsetext=Approved&customer_vault_id=vault-1&billing_id=${submittedBillingId}`,
      );
    });
    const result = await vaultEasyPayDirectCard(
      liveEnv,
      {
        paymentToken: "token-2",
        billingId: "billing-2",
        existingCustomerVaultId: "vault-1",
      },
      providerFetch,
    );
    expect(result).toEqual({ customerVaultId: "vault-1", billingId: submittedBillingId });
    expect(providerFetch).toHaveBeenCalledOnce();
  });

  it("derives the same numeric live billing id for an idempotent retry", async () => {
    const liveEnv = {
      ...providerEnv,
      APP_ENV: "production",
      EASY_PAY_DIRECT_COMMERCE_API_KEY: "epd_synthetic_sk_live_secret",
      EASY_PAY_DIRECT_NETWORK_MODE: "production",
      EASY_PAY_DIRECT_LIVEMODE_ALLOWED: "1",
    } satisfies EasyPayDirectEnv;
    const submittedBillingIds: string[] = [];
    const providerFetch = vi.fn<typeof fetch>(async (_url, init) => {
      const body = new URLSearchParams(String(init?.body));
      submittedBillingIds.push(body.get("billing_id") ?? "");
      return new Response(
        `response=1&responsetext=Approved&customer_vault_id=vault-idempotent&billing_id=${body.get("billing_id")}`,
      );
    });

    await vaultEasyPayDirectCard(
      liveEnv,
      { paymentToken: "token-first", billingId: "stable-payment-method-key" },
      providerFetch,
    );
    await vaultEasyPayDirectCard(
      liveEnv,
      { paymentToken: "token-retry", billingId: "stable-payment-method-key" },
      providerFetch,
    );

    expect(submittedBillingIds).toHaveLength(2);
    expect(submittedBillingIds[0]).toMatch(/^\d{32}$/u);
    expect(submittedBillingIds[1]).toBe(submittedBillingIds[0]);
  });

  it("rejects a nonnumeric live gateway billing id before calling Commerce", async () => {
    const liveEnv = {
      ...providerEnv,
      APP_ENV: "production",
      EASY_PAY_DIRECT_COMMERCE_API_KEY: "epd_synthetic_sk_live_secret",
      EASY_PAY_DIRECT_NETWORK_MODE: "production",
      EASY_PAY_DIRECT_LIVEMODE_ALLOWED: "1",
    } satisfies EasyPayDirectEnv;
    const providerFetch = vi.fn<typeof fetch>();

    await expect(
      addEasyPayDirectPaymentMethod(
        liveEnv,
        {
          customerId: "customer-live",
          billingId: "legacy-alphanumeric-id",
          idempotencyKey: "550e8400-e29b-41d4-a716-446655440004",
        },
        providerFetch,
      ),
    ).rejects.toMatchObject({
      status: 422,
      code: "easy_pay_direct_gateway_billing_id_invalid",
      message: "Payment details need to be entered again. No charge was made.",
    });
    expect(providerFetch).not.toHaveBeenCalled();
  });

  it("preserves a definitive gateway vault rejection without exposing provider text", async () => {
    const liveEnv = {
      ...providerEnv,
      APP_ENV: "production",
      EASY_PAY_DIRECT_COMMERCE_API_KEY: "epd_synthetic_sk_live_secret",
      EASY_PAY_DIRECT_NETWORK_MODE: "production",
      EASY_PAY_DIRECT_LIVEMODE_ALLOWED: "1",
    } satisfies EasyPayDirectEnv;
    const providerFetch = vi.fn<typeof fetch>(
      async () =>
        new Response(
          "response=3&responsetext=Service+Unavailable&response_code=300&transactionid=0&refid=ref-123",
        ),
    );

    await expect(
      vaultEasyPayDirectCard(
        liveEnv,
        { paymentToken: "token-rejected", billingId: "billing-rejected" },
        providerFetch,
      ),
    ).rejects.toMatchObject({
      status: 422,
      code: "300",
      message:
        "Payment details could not be saved. No charge was made. Please start a new checkout and try again.",
      details: {
        provider: "easy_pay_direct_gateway",
        phase: "vault",
        definitive: true,
        providerResponseCode: "300",
        providerResponseText: "Service Unavailable",
        providerReferenceId: "ref-123",
      },
    });
    expect(providerFetch).toHaveBeenCalledOnce();
  });

  it.each(["checkpoint-write", "verification-read"])(
    "retains the refund identity across %s interruption without repeating POST",
    async (fault) => {
      let checkpoint: string | null = null;
      const providerFetch = vi.fn<typeof fetch>(async (url, init) => {
        if (String(url).endsWith("/orders/order-1"))
          return Response.json({
            id: "order-1",
            status: "succeeded",
            currency: "usd",
            transactions: [],
          });
        if (init?.method === "POST")
          return Response.json({
            id: "order-1",
            currency: "usd",
            status: "partially_refunded",
            transactions: [{ id: "refund-checkpoint", type: "refund" }],
          });
        expect(checkpoint).toBe("refund-checkpoint");
        throw new TypeError("verification read unavailable");
      });
      await expect(
        refundEasyPayDirectOrder(
          providerEnv,
          { orderId: "order-1", amountMinor: 500, currency: "USD" },
          providerFetch,
          async (id) => {
            if (fault === "checkpoint-write") throw new Error("checkpoint write unavailable");
            checkpoint = id;
          },
        ),
      ).rejects.toThrow();
      expect(providerFetch.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(
        1,
      );
      expect(providerFetch).toHaveBeenCalledTimes(fault === "checkpoint-write" ? 2 : 3);
      expect(checkpoint).toBe(fault === "checkpoint-write" ? null : "refund-checkpoint");
    },
  );

  it("reads the exact recorded Commerce refund without listing orders or submitting a mutation", async () => {
    const providerFetch = vi.fn<typeof fetch>(async (url, init) => {
      expect(String(url)).toBe("https://api.epd.com/v1/transactions/refund-recorded");
      expect(init?.method).toBe("GET");
      return Response.json({
        id: "refund-recorded",
        order_id: "order-1",
        type: "refund",
        status: "succeeded",
        amount: 500,
        currency: "usd",
      });
    });
    expect(
      await readEasyPayDirectRefundTransaction(
        providerEnv,
        { transactionId: "refund-recorded", orderId: "order-1", amountMinor: 500, currency: "USD" },
        providerFetch,
      ),
    ).toMatchObject({ id: "refund-recorded", status: "succeeded" });
    expect(providerFetch).toHaveBeenCalledOnce();
  });

  it("refunds by Commerce order id and returns the provider refund id", async () => {
    const providerFetch = vi.fn<typeof fetch>(async (input, init) => {
      if (String(input).endsWith("/orders/order-1"))
        return Response.json({
          id: "order-1",
          status: "succeeded",
          currency: "usd",
          transactions: [],
        });
      if (String(input).endsWith("/transactions/refund-1"))
        return Response.json({
          id: "refund-1",
          order_id: "order-1",
          type: "refund",
          status: "succeeded",
          amount: 500,
          currency: "usd",
          processor_response: { transaction_id: "gateway-refund-1" },
        });
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
      responseText: "Refund confirmed",
    });
  });

  it.each(["old-refund", "wrong-order", "wrong-amount", "wrong-currency", "pending", "wrong-type"])(
    "does not confirm this refund from %s evidence",
    async (fault) => {
      const refund = { id: "refund-1", type: "refund" };
      const providerFetch = vi.fn<typeof fetch>(async (input) => {
        if (String(input).endsWith("/orders/order-1"))
          return Response.json({
            id: "order-1",
            status: "partially_refunded",
            currency: "usd",
            transactions: fault === "old-refund" ? [refund] : [],
          });
        if (String(input).endsWith("/refund"))
          return Response.json({
            id: "order-1",
            status: "partially_refunded",
            currency: "usd",
            transactions: [refund],
          });
        return Response.json({
          id: "refund-1",
          order_id: fault === "wrong-order" ? "other" : "order-1",
          type: fault === "wrong-type" ? "sale" : "refund",
          status: fault === "pending" ? "pending" : "succeeded",
          amount: fault === "wrong-amount" ? 499 : 500,
          currency: fault === "wrong-currency" ? "eur" : "usd",
        });
      });
      await expect(
        refundEasyPayDirectOrder(
          providerEnv,
          {
            orderId: "order-1",
            amountMinor: 500,
            currency: "USD",
            idempotencyKey: "fixture-refund-key",
          },
          providerFetch,
        ),
      ).resolves.toMatchObject({ status: "unknown" });
      expect(
        providerFetch.mock.calls.filter(([input]) => String(input).endsWith("/refund")),
      ).toHaveLength(1);
    },
  );
});
