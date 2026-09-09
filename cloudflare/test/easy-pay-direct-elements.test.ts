import { afterEach, describe, expect, it, vi } from "vitest";
import {
  addEasyPayDirectElementsPaymentMethod,
  createEasyPayDirectElementsCustomer,
  findEasyPayDirectElementsCustomerByEmail,
  retrieveEasyPayDirectElementsCustomer,
  createEasyPayDirectElementsProduct,
  getEasyPayDirectElementsProduct,
  createEasyPayDirectElementsOrder,
  getEasyPayDirectElementsOrder,
  validateEasyPayDirectElementsOrder,
} from "../src/providers/easy-pay-direct-elements";

const env = {
  APP_ENV: "test",
  EASY_PAY_DIRECT_COMMERCE_API_KEY: "epd_test_sk_fixture",
  EASY_PAY_DIRECT_NETWORK_MODE: "test" as const,
  EASY_PAY_DIRECT_LIVEMODE_ALLOWED: "0" as const,
};
const customerId = "550e8400-e29b-41d4-a716-446655440000";
const methodId = "6ba7b815-9dad-11d1-80b4-00c04fd430c8";
const idempotencyKey = "550e8400-e29b-41d4-a716-446655440001";
const contact = {
  email: "fixture@example.test",
  firstName: "Fixture",
  lastName: "Customer",
  phone: "+14155551234",
  idempotencyKey,
  metadata: { fixture: "only" },
};
const method = { id: methodId, customer: customerId, type: "card", is_default: true };
const attach = { customerId, cardToken: "cct_fixturetoken", idempotencyKey };
const productId = "6ba7b810-9dad-11d1-80b4-00c04fd430d1";
const orderId = "6ba7b811-9dad-11d1-80b4-00c04fd430c8";
const expectedOrder = {
  orderId,
  customerId,
  paymentMethodId: methodId,
  amountMinor: 450,
  currency: "USD",
};
const orderEvidence = {
  id: orderId,
  customer_id: customerId,
  payment_method: { id: methodId },
  status: "succeeded",
  total: 450,
  currency: "usd",
};
afterEach(() => vi.useRealTimers());

describe("documented Elements Commerce adapter (mocked provider only)", () => {
  it.each([300, 301, 302, 303, 304, 305, 307, 308])(
    "never follows Elements redirect %s",
    async (status) => {
      const provider = vi.fn<typeof fetch>(async (url, options) => {
        expect(new Request(url, options).redirect).toBe("manual");
        return new Response(status === 304 ? null : "{}", {
          status,
          headers: { Location: "https://unexpected.invalid" },
        });
      });
      await expect(
        createEasyPayDirectElementsCustomer(env, contact, provider),
      ).rejects.toMatchObject({ status: 503 });
      expect(provider).toHaveBeenCalledTimes(1);
    },
  );
  it("creates and re-reads the exact final-price digital product", async () => {
    const input = {
      name: "SERP App Plan",
      description: "SERP digital software purchase",
      amountMinor: 450,
      currency: "USD",
      metadata: { fixture: "true" },
      idempotencyKey,
    };
    const response = {
      id: productId,
      pricing: { amount: 450, currency: "usd" },
      requires_shipping: false,
    };
    const provider = vi.fn<typeof fetch>(async (url, options) => {
      expect(String(url)).toBe("https://api.epd.com/v1/products");
      expect(JSON.parse(String(options?.body))).toEqual({
        name: input.name,
        description: input.description,
        sku: `serp-${idempotencyKey}`,
        pricing: { amount: 450, currency: "usd" },
        requires_shipping: false,
        metadata: input.metadata,
      });
      return Response.json(response);
    });
    expect((await createEasyPayDirectElementsProduct(env, input, provider)).id).toBe(productId);
    expect(
      (
        await getEasyPayDirectElementsProduct(
          env,
          { productId, amountMinor: 450, currency: "USD" },
          async () => Response.json(response),
        )
      ).pricing.amount,
    ).toBe(450);
    for (const bad of [
      { ...response, requires_shipping: true },
      { ...response, id: customerId },
      { ...response, pricing: { amount: 900, currency: "usd" } },
      { ...response, pricing: { amount: 450, currency: "eur" } },
    ])
      await expect(
        getEasyPayDirectElementsProduct(
          env,
          { productId, amountMinor: 450, currency: "USD" },
          async () => Response.json(bad),
        ),
      ).rejects.toMatchObject({ status: 503 });
  });

  it("returns the order checkpoint BEFORE economic validation, without a second charge", async () => {
    const badEvidence = { ...orderEvidence, total: 900 };
    const provider = vi.fn<typeof fetch>(async (url, options) => {
      expect(String(url)).toBe("https://api.epd.com/v1/orders");
      expect(JSON.parse(String(options?.body))).toEqual({
        customer_id: customerId,
        payment_method_id: methodId,
        items: [{ product_id: productId, quantity: 1 }],
        currency: "usd",
        metadata: { fixture: "true" },
      });
      return Response.json(badEvidence);
    });
    const checkpoint = await createEasyPayDirectElementsOrder(
      env,
      {
        customerId,
        paymentMethodId: methodId,
        productId,
        currency: "USD",
        metadata: { fixture: "true" },
        idempotencyKey,
      },
      provider,
    );
    expect(checkpoint.id).toBe(orderId);
    expect(() => validateEasyPayDirectElementsOrder(checkpoint.evidence, expectedOrder)).toThrow();
    expect(provider).toHaveBeenCalledTimes(1);
    const recovered = await getEasyPayDirectElementsOrder(env, orderId, async (_url, options) => {
      expect(options?.method).toBe("GET");
      return Response.json(orderEvidence);
    });
    expect(validateEasyPayDirectElementsOrder(recovered.evidence, expectedOrder)).toMatchObject({
      id: orderId,
      total: 450,
      status: "succeeded",
    });
  });

  it.each([
    { ...orderEvidence, id: customerId },
    { ...orderEvidence, customer_id: methodId },
    { ...orderEvidence, payment_method: null },
    { ...orderEvidence, payment_method: { id: customerId } },
    { ...orderEvidence, total: "450" },
    { ...orderEvidence, total: 450.1 },
    { ...orderEvidence, currency: "eur" },
    { ...orderEvidence, status: "complete" },
    { ...orderEvidence, transactions: [null] },
  ])("holds unverified order evidence %j", (evidence) => {
    expect(() => validateEasyPayDirectElementsOrder(evidence, expectedOrder)).toThrow();
  });

  it("retains only typed transaction evidence and sanitized decline text", () => {
    expect(
      validateEasyPayDirectElementsOrder(
        {
          ...orderEvidence,
          status: "failed",
          failure_reason: "private provider diagnostics",
          transactions: [
            {
              id: methodId,
              type: "sale",
              status: "failed",
              processor_transaction_id: "fixture-transaction",
              private: "discard",
            },
          ],
        },
        expectedOrder,
      ),
    ).toEqual({
      id: orderId,
      customer_id: customerId,
      payment_method: { id: methodId },
      status: "failed",
      total: 450,
      currency: "usd",
      failure_reason: "Payment was declined",
      transactions: [
        {
          id: methodId,
          type: "sale",
          status: "failed",
          processor_transaction_id: "fixture-transaction",
        },
      ],
    });
  });
  it("creates a customer without undocumented Gateway association or Gateway credentials", async () => {
    const provider = vi.fn<typeof fetch>(async (url, options) => {
      expect(String(url)).toBe("https://api.epd.com/v1/customers");
      expect(options?.redirect).toBe("manual");
      expect(new Headers(options?.headers).get("EPD-Version")).toBe("2026-02-11");
      expect(new Headers(options?.headers).get("X-EPD-Idempotency-Key")).toBe(idempotencyKey);
      expect(JSON.parse(String(options?.body))).toEqual({
        email: contact.email,
        first_name: "Fixture",
        last_name: "Customer",
        phone: contact.phone,
        metadata: contact.metadata,
      });
      return Response.json({ id: customerId, email: contact.email });
    });
    expect(await createEasyPayDirectElementsCustomer(env, contact, provider)).toEqual({
      id: customerId,
      email: contact.email,
    });
  });

  it("attaches only card_token and allowlisted billing details, keeping subscription updates off", async () => {
    const provider = vi.fn<typeof fetch>(async (url, options) => {
      expect(String(url)).toBe(`https://api.epd.com/v1/customers/${customerId}/payment_methods`);
      expect(JSON.parse(String(options?.body))).toEqual({
        card_token: attach.cardToken,
        set_as_default: true,
        update_subscriptions: false,
        billing_details: { country: "US", zip: "94103" },
      });
      return Response.json({
        ...method,
        card: { brand: "visa", last4: "1111" },
        private_field: "discard",
      });
    });
    expect(
      await addEasyPayDirectElementsPaymentMethod(
        env,
        { ...attach, billingDetails: { country: "US", zip: "94103" } },
        provider,
      ),
    ).toEqual(method);
  });

  it.each([
    {},
    { ...method, customer: methodId },
    { ...method, customer: undefined },
    { ...method, id: "pm_prefixed" },
    { ...method, type: "bank" },
    { ...method, is_default: false },
  ])("rejects unverified payment method ownership/shape %j", async (response) => {
    await expect(
      addEasyPayDirectElementsPaymentMethod(env, attach, async () => Response.json(response)),
    ).rejects.toMatchObject({ status: 503 });
  });

  it.each([
    { id: methodId, email: contact.email },
    { id: customerId, email: "other@example.test" },
    { id: customerId, email: null },
  ])("rejects customer read identity mismatch %j", async (response) => {
    await expect(
      retrieveEasyPayDirectElementsCustomer(env, { customerId, email: contact.email }, async () =>
        Response.json(response),
      ),
    ).rejects.toMatchObject({ status: 503 });
  });

  it("requires exact unique customer lookup evidence and encodes the email filter", async () => {
    const provider = vi.fn<typeof fetch>(async (url) => {
      const parsed = new URL(String(url));
      expect(parsed.searchParams.get("email")).toBe("fixture+tag@example.test");
      expect(parsed.searchParams.get("limit")).toBe("2");
      return Response.json({
        data: [{ id: customerId, email: "fixture+tag@example.test" }],
        has_more: false,
      });
    });
    expect(
      (await findEasyPayDirectElementsCustomerByEmail(env, "fixture+tag@example.test", provider))
        ?.id,
    ).toBe(customerId);
    expect(
      await findEasyPayDirectElementsCustomerByEmail(env, contact.email, async () =>
        Response.json({ data: [], has_more: false }),
      ),
    ).toBeNull();
    for (const response of [
      { data: [] },
      { data: [], has_more: true },
      {
        data: [
          { id: customerId, email: contact.email },
          { id: methodId, email: contact.email },
        ],
        has_more: false,
      },
    ])
      await expect(
        findEasyPayDirectElementsCustomerByEmail(env, contact.email, async () =>
          Response.json(response),
        ),
      ).rejects.toMatchObject({ code: "easy_pay_direct_customer_ambiguous" });
  });

  it.each([
    { EASY_PAY_DIRECT_NETWORK_MODE: "production", EASY_PAY_DIRECT_LIVEMODE_ALLOWED: "1" },
    { EASY_PAY_DIRECT_NETWORK_MODE: "disabled" },
    { EASY_PAY_DIRECT_LIVEMODE_ALLOWED: "1" },
    { APP_ENV: "production" },
    { APP_ENV: "" },
    { EASY_PAY_DIRECT_COMMERCE_API_KEY: "epd_live_sk_fixture" },
    { EASY_PAY_DIRECT_COMMERCE_API_KEY: "" },
  ] as const)("rejects unsafe environment before any network call %j", async (override) => {
    const provider = vi.fn<typeof fetch>();
    await expect(
      addEasyPayDirectElementsPaymentMethod({ ...env, ...override }, attach, provider),
    ).rejects.toMatchObject({ status: 503 });
    expect(provider).not.toHaveBeenCalled();
  });

  it("accepts a coherent live environment with a live Commerce key", async () => {
    const provider = vi.fn<typeof fetch>(async () =>
      Response.json({ id: customerId, email: contact.email }),
    );
    await expect(
      retrieveEasyPayDirectElementsCustomer(
        {
          APP_ENV: "production",
          EASY_PAY_DIRECT_COMMERCE_API_KEY: "epd_live_sk_fixture",
          EASY_PAY_DIRECT_NETWORK_MODE: "production",
          EASY_PAY_DIRECT_LIVEMODE_ALLOWED: "1",
        },
        { customerId, email: contact.email },
        provider,
      ),
    ).resolves.toEqual({ id: customerId, email: contact.email });
    expect(provider).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["sandbox", "epd_restricted_sk_test_fixture"],
    ["live", "epd_restricted_sk_live_fixture"],
  ] as const)("accepts a documented %s restricted Commerce key", async (mode, key) => {
    const provider = vi.fn<typeof fetch>(async () =>
      Response.json({ id: customerId, email: contact.email }),
    );
    const runtime =
      mode === "sandbox"
        ? { ...env, EASY_PAY_DIRECT_COMMERCE_API_KEY: key }
        : {
            APP_ENV: "production",
            EASY_PAY_DIRECT_COMMERCE_API_KEY: key,
            EASY_PAY_DIRECT_NETWORK_MODE: "production" as const,
            EASY_PAY_DIRECT_LIVEMODE_ALLOWED: "1" as const,
          };
    await expect(
      retrieveEasyPayDirectElementsCustomer(
        runtime,
        { customerId, email: contact.email },
        provider,
      ),
    ).resolves.toMatchObject({ id: customerId });
    expect(provider).toHaveBeenCalledTimes(1);
  });

  it("rejects legacy tokens, invalid addresses and non-v4 request keys before network", async () => {
    const provider = vi.fn<typeof fetch>();
    for (const input of [
      { ...attach, cardToken: "123456789" },
      { ...attach, idempotencyKey: methodId },
      { ...attach, billingDetails: { country: "usa" } },
    ])
      await expect(
        addEasyPayDirectElementsPaymentMethod(env, input, provider),
      ).rejects.toMatchObject({ status: 422 });
    expect(provider).not.toHaveBeenCalled();
  });

  it("sanitizes provider diagnostics and never retries an attachment internally", async () => {
    const provider = vi.fn<typeof fetch>(async () =>
      Response.json(
        { error: { message: "private vault token", code: "private-id" } },
        { status: 422 },
      ),
    );
    await expect(
      addEasyPayDirectElementsPaymentMethod(env, attach, provider),
    ).rejects.toMatchObject({ status: 422, code: "easy_pay_direct_elements_rejected" });
    expect(provider).toHaveBeenCalledTimes(1);
  });

  it("rejects malformed UTF8 and bounds response bytes without trusting Content-Length", async () => {
    await expect(
      addEasyPayDirectElementsPaymentMethod(
        env,
        attach,
        async () => new Response(new Uint8Array([0xff])),
      ),
    ).rejects.toMatchObject({ status: 503 });
    await expect(
      addEasyPayDirectElementsPaymentMethod(
        env,
        attach,
        async () => new Response(" ".repeat(256 * 1024 + 1)),
      ),
    ).rejects.toMatchObject({ status: 503 });
  });

  it("bounds a stalled body even if stream cancellation does not settle", async () => {
    vi.useFakeTimers();
    const provider = vi.fn<typeof fetch>(
      async () =>
        new Response(new ReadableStream({ start() {}, cancel: () => new Promise(() => {}) })),
    );
    const result = addEasyPayDirectElementsPaymentMethod(env, attach, provider);
    const assertion = expect(result).rejects.toMatchObject({
      status: 503,
      code: "easy_pay_direct_outcome_unknown",
    });
    await vi.advanceTimersByTimeAsync(15_001);
    await assertion;
    expect(provider).toHaveBeenCalledTimes(1);
  });
});
