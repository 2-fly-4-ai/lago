import { env } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import {
  easyPayDirectRefundBackend,
  assertEasyPayDirectRefundBoundary,
  readEasyPayDirectRefundByOrigin,
  refundEasyPayDirectByOrigin,
} from "../src/billing/easy-pay-direct-refund-backend";

async function fixture(backend = "commerce_elements", paid = true, transport = "commerce") {
  const suffix = crypto.randomUUID();
  const org = `refund-origin-${suffix}`;
  const customer = `customer-${suffix}`;
  const request = `request-${suffix}`;
  const intent = `intent-${suffix}`;
  const order = crypto.randomUUID();
  const now = new Date().toISOString();
  await env.BILLING_DB.batch([
    env.BILLING_DB.prepare(
      "INSERT INTO organizations(id,external_id,name,created_at,updated_at) VALUES(?,?,'Fixture',?,?)",
    ).bind(org, org, now, now),
    env.BILLING_DB.prepare(
      "INSERT INTO customers(id,organization_id,external_id,currency,payment_provider,payment_provider_code,created_at,updated_at) VALUES(?,?,?,'USD','easy_pay_direct','fixture',?,?)",
    ).bind(customer, org, customer, now, now),
    env.BILLING_DB.prepare(
      "INSERT INTO payment_requests(id,organization_id,customer_id,amount_minor,currency,created_at,updated_at) VALUES(?,?,?,900,'USD',?,?)",
    ).bind(request, org, customer, now, now),
    env.BILLING_DB.prepare(`INSERT INTO payment_request_checkout_intents(id,organization_id,payment_request_id,customer_id,provider,provider_account_code,idempotency_key,request_sha256,amount_minor,currency,payment_request_version,status,payment_url,provider_token_sha256,created_at,updated_at)
      VALUES(?,?,?,?,'easy_pay_direct','fixture',?,'fixture',900,'USD',1,'succeeded','https://fixture.test/checkout','fixture',?,?)`).bind(
      intent,
      org,
      request,
      customer,
      intent,
      now,
      now,
    ),
    env.BILLING_DB.prepare(`INSERT INTO easy_pay_direct_payment_executions(id,organization_id,checkout_intent_id,payment_request_id,provider_account_code,request_sha256,payment_token_sha256,phone_sha256,customer_idempotency_key,payment_method_idempotency_key,product_idempotency_key,order_idempotency_key,status,provider_transaction_id,payment_backend,charge_transport,created_at,updated_at)
      VALUES(?,?,?,?,'fixture','fixture','fixture','fixture',?,?,?,?,'succeeded',?,?,?,?,?)`).bind(
      `execution-${suffix}`,
      org,
      intent,
      request,
      crypto.randomUUID(),
      crypto.randomUUID(),
      crypto.randomUUID(),
      crypto.randomUUID(),
      order,
      backend,
      transport,
      now,
      now,
    ),
  ]);
  if (paid)
    await env.BILLING_DB.prepare(`INSERT INTO payment_request_payments(id,organization_id,payment_request_id,provider,provider_account_code,provider_transaction_id,idempotency_key,amount_minor,currency,status,created_at,updated_at)
    VALUES(?,?,?,'easy_pay_direct','fixture',?,?,900,'USD','succeeded',?,?)`)
      .bind(`paid-${suffix}`, org, request, order, suffix, now, now)
      .run();
  return { organizationId: org, providerAccountCode: "fixture", orderId: order };
}
describe("immutable Elements refund routing", () => {
  it("selects Elements only from an exact paid execution, independent of current UI selection", async () => {
    const origin = await fixture();
    expect(await easyPayDirectRefundBackend(env.BILLING_DB, origin)).toBe("commerce_elements");
    await expect(
      easyPayDirectRefundBackend(env.BILLING_DB, { ...origin, organizationId: "other" }),
    ).rejects.toMatchObject({ code: "easy_pay_direct_refund_origin_unverified" });
    await expect(
      easyPayDirectRefundBackend(env.BILLING_DB, { ...origin, providerAccountCode: "other" }),
    ).rejects.toMatchObject({ code: "easy_pay_direct_refund_origin_unverified" });
  });
  it("holds Elements execution with no successful exact payment evidence", async () => {
    await expect(
      easyPayDirectRefundBackend(env.BILLING_DB, await fixture("commerce_elements", false)),
    ).rejects.toMatchObject({ code: "easy_pay_direct_refund_origin_unverified" });
  });
  it("never upgrades a Gateway execution based on UUID-shaped order ID", async () => {
    const origin = await fixture("gateway_vault");
    expect(await easyPayDirectRefundBackend(env.BILLING_DB, origin)).toBe("commerce_legacy");
    expect(() =>
      assertEasyPayDirectRefundBoundary(
        {
          APP_ENV: "staging",
          EASY_PAY_DIRECT_NETWORK_MODE: "gateway_test",
          EASY_PAY_DIRECT_LIVEMODE_ALLOWED: "0",
          EASY_PAY_DIRECT_ORGANIZATION_ID: origin.organizationId,
          EASY_PAY_DIRECT_ACCOUNT_CODE: "fixture",
        },
        origin,
        "commerce_legacy",
      ),
    ).toThrow();
  });
  it("never sends a proven direct Gateway origin to Commerce", async () => {
    const origin = await fixture("gateway_vault", true, "gateway");
    expect(await easyPayDirectRefundBackend(env.BILLING_DB, origin)).toBe("gateway");
    const fetcher = vi.fn<typeof fetch>();
    await expect(
      refundEasyPayDirectByOrigin(
        env,
        { ...origin, amountMinor: 100, currency: "USD", idempotencyKey: crypto.randomUUID() },
        fetcher,
        async () => {},
      ),
    ).rejects.toMatchObject({ code: "easy_pay_direct_refund_boundary_mismatch" });
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("allows a proven Gateway origin in a coherent production environment", async () => {
    const origin = await fixture("gateway_vault", true, "gateway");
    expect(() =>
      assertEasyPayDirectRefundBoundary(
        {
          APP_ENV: "production",
          CREDIT_NOTE_REFUND_MODE: "easy_pay_direct_live",
          EASY_PAY_DIRECT_NETWORK_MODE: "production",
          EASY_PAY_DIRECT_LIVEMODE_ALLOWED: "1",
          EASY_PAY_DIRECT_ORGANIZATION_ID: origin.organizationId,
          EASY_PAY_DIRECT_ACCOUNT_CODE: origin.providerAccountCode,
        },
        origin,
        "gateway",
      ),
    ).not.toThrow();
  });
  it.each([
    {
      APP_ENV: "staging",
      CREDIT_NOTE_REFUND_MODE: "easy_pay_direct_live",
      EASY_PAY_DIRECT_NETWORK_MODE: "production",
      EASY_PAY_DIRECT_LIVEMODE_ALLOWED: "1",
    },
    {
      APP_ENV: "production",
      CREDIT_NOTE_REFUND_MODE: "easy_pay_direct_test",
      EASY_PAY_DIRECT_NETWORK_MODE: "gateway_test",
      EASY_PAY_DIRECT_LIVEMODE_ALLOWED: "0",
    },
    {
      APP_ENV: "production",
      CREDIT_NOTE_REFUND_MODE: "easy_pay_direct_test",
      EASY_PAY_DIRECT_NETWORK_MODE: "production",
      EASY_PAY_DIRECT_LIVEMODE_ALLOWED: "0",
    },
    {
      APP_ENV: "production",
      CREDIT_NOTE_REFUND_MODE: "easy_pay_direct_live",
      EASY_PAY_DIRECT_NETWORK_MODE: "production",
      EASY_PAY_DIRECT_LIVEMODE_ALLOWED: "1",
      EASY_PAY_DIRECT_ACCOUNT_CODE: "other",
    },
  ])("holds unsafe Gateway refund configuration %j", (overrides) => {
    const origin = {
      organizationId: "fixture",
      providerAccountCode: "fixture",
      orderId: "fixture",
    };
    expect(() =>
      assertEasyPayDirectRefundBoundary(
        Object.assign(
          {
            APP_ENV: "staging",
            CREDIT_NOTE_REFUND_MODE: "easy_pay_direct_test",
            EASY_PAY_DIRECT_NETWORK_MODE: "gateway_test",
            EASY_PAY_DIRECT_LIVEMODE_ALLOWED: "0",
            EASY_PAY_DIRECT_ORGANIZATION_ID: "fixture",
            EASY_PAY_DIRECT_ACCOUNT_CODE: "fixture",
          },
          overrides,
        ),
        origin,
        "gateway",
      ),
    ).toThrow();
  });
  it.each(["gateway", "commerce", "legacy_unknown"])(
    "requires successful ledger proof for %s",
    async (transport) => {
      await expect(
        easyPayDirectRefundBackend(
          env.BILLING_DB,
          await fixture("gateway_vault", false, transport),
        ),
      ).rejects.toMatchObject({ code: "easy_pay_direct_refund_origin_unverified" });
    },
  );
  it("holds historical transport uncertainty even with a paid ledger", async () => {
    await expect(
      easyPayDirectRefundBackend(
        env.BILLING_DB,
        await fixture("gateway_vault", true, "legacy_unknown"),
      ),
    ).rejects.toMatchObject({ code: "easy_pay_direct_refund_origin_unverified" });
  });
  it("reads confirmed Elements refund with an official test key and no Gateway credentials", async () => {
    const origin = await fixture();
    const transactionId = crypto.randomUUID();
    const fetcher = vi.fn<typeof fetch>(
      async () =>
        new Response(
          JSON.stringify({
            id: transactionId,
            type: "refund",
            status: "succeeded",
            order_id: origin.orderId,
            amount: 100,
            currency: "usd",
          }),
        ),
    );
    const runtime = {
      ...env,
      APP_ENV: "staging",
      CREDIT_NOTE_REFUND_MODE: "easy_pay_direct_test",
      PROVIDER_READS_ENABLED: "1",
      EASY_PAY_DIRECT_NETWORK_MODE: "gateway_test",
      EASY_PAY_DIRECT_LIVEMODE_ALLOWED: "0",
      EASY_PAY_DIRECT_COMMERCE_API_KEY: "epd_test_sk_fixture",
      EASY_PAY_DIRECT_ORGANIZATION_ID: origin.organizationId,
      EASY_PAY_DIRECT_ACCOUNT_CODE: "fixture",
    } as unknown as Env;
    await expect(
      readEasyPayDirectRefundByOrigin(
        runtime,
        {
          ...origin,
          transactionId,
          amountMinor: 100,
          currency: "USD",
          idempotencyKey: crypto.randomUUID(),
        },
        fetcher,
      ),
    ).resolves.toMatchObject({ status: "succeeded" });
    expect(fetcher).toHaveBeenCalledOnce();
    expect(fetcher.mock.calls[0]![0]).toBe(`https://api.epd.com/v1/transactions/${transactionId}`);
    fetcher.mockClear();
    await expect(
      readEasyPayDirectRefundByOrigin(
        { ...runtime, PROVIDER_READS_ENABLED: "0" },
        {
          ...origin,
          transactionId,
          amountMinor: 100,
          currency: "USD",
          idempotencyKey: crypto.randomUUID(),
        },
        fetcher,
      ),
    ).rejects.toMatchObject({ code: "provider_reads_disabled" });
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("routes Elements refund POST by paid origin and checkpoints before confirmation read", async () => {
    const origin = await fixture();
    const transactionId = crypto.randomUUID();
    const events: string[] = [];
    const runtime = {
      ...env,
      APP_ENV: "staging",
      CREDIT_NOTE_REFUND_MODE: "easy_pay_direct_test",
      PROVIDER_READS_ENABLED: "1",
      EASY_PAY_DIRECT_NETWORK_MODE: "gateway_test",
      EASY_PAY_DIRECT_LIVEMODE_ALLOWED: "0",
      EASY_PAY_DIRECT_COMMERCE_API_KEY: "epd_test_sk_fixture",
      EASY_PAY_DIRECT_ORGANIZATION_ID: origin.organizationId,
      EASY_PAY_DIRECT_ACCOUNT_CODE: "fixture",
    } as unknown as Env;
    const fetcher: typeof fetch = async (url, init) => {
      events.push(`${init?.method} ${String(url)}`);
      if (String(url).includes("/transactions/")) {
        expect(events.at(-2)).toBe(`checkpoint:${transactionId}`);
        return new Response(
          JSON.stringify({
            id: transactionId,
            type: "refund",
            status: "succeeded",
            order_id: origin.orderId,
            amount: 100,
            currency: "usd",
          }),
        );
      }
      return new Response(
        JSON.stringify({
          id: origin.orderId,
          total: 900,
          status: init?.method === "POST" ? "partially_refunded" : "succeeded",
          currency: "usd",
          transactions: init?.method === "POST" ? [{ id: transactionId, type: "refund" }] : [],
        }),
      );
    };
    await expect(
      refundEasyPayDirectByOrigin(
        runtime,
        { ...origin, amountMinor: 100, currency: "USD", idempotencyKey: crypto.randomUUID() },
        fetcher,
        async (id) => {
          events.push(`checkpoint:${id}`);
        },
      ),
    ).resolves.toMatchObject({ status: "succeeded" });
    expect(events.filter((event) => event.startsWith("POST"))).toEqual([
      `POST https://api.epd.com/v1/orders/${origin.orderId}/refund`,
    ]);
  });
  it("allows the same documented Elements refund contract in a coherent live environment", async () => {
    const origin = await fixture();
    const transactionId = crypto.randomUUID();
    const runtime = {
      ...env,
      APP_ENV: "production",
      CREDIT_NOTE_REFUND_MODE: "easy_pay_direct_live",
      PROVIDER_READS_ENABLED: "1",
      EASY_PAY_DIRECT_NETWORK_MODE: "production",
      EASY_PAY_DIRECT_LIVEMODE_ALLOWED: "1",
      EASY_PAY_DIRECT_COMMERCE_API_KEY: "epd_live_sk_fixtureonly",
      EASY_PAY_DIRECT_ORGANIZATION_ID: origin.organizationId,
      EASY_PAY_DIRECT_ACCOUNT_CODE: "fixture",
    } as unknown as Env;
    const fetcher = vi.fn<typeof fetch>(async (url, init) => {
      if (String(url).includes("/transactions/"))
        return Response.json({
          id: transactionId,
          type: "refund",
          status: "succeeded",
          order_id: origin.orderId,
          amount: 100,
          currency: "usd",
        });
      expect(init?.headers).toMatchObject({ Authorization: "Bearer epd_live_sk_fixtureonly" });
      return Response.json({
        id: origin.orderId,
        total: 900,
        status: init?.method === "POST" ? "partially_refunded" : "succeeded",
        currency: "usd",
        transactions: init?.method === "POST" ? [{ id: transactionId, type: "refund" }] : [],
      });
    });
    await expect(
      refundEasyPayDirectByOrigin(
        runtime,
        { ...origin, amountMinor: 100, currency: "USD", idempotencyKey: crypto.randomUUID() },
        fetcher,
        async () => {},
      ),
    ).resolves.toMatchObject({ status: "succeeded" });
    expect(fetcher.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);
  });
  it.each([
    { APP_ENV: "production" },
    { EASY_PAY_DIRECT_LIVEMODE_ALLOWED: "1" },
    { EASY_PAY_DIRECT_NETWORK_MODE: "production" },
    { APP_ENV: undefined },
  ])("holds unsafe Elements refund configuration %j", (overrides) => {
    const origin = {
      organizationId: "fixture",
      providerAccountCode: "fixture",
      orderId: "fixture",
    };
    expect(() =>
      assertEasyPayDirectRefundBoundary(
        {
          APP_ENV: "staging",
          CREDIT_NOTE_REFUND_MODE: "easy_pay_direct_test",
          EASY_PAY_DIRECT_NETWORK_MODE: "test",
          EASY_PAY_DIRECT_LIVEMODE_ALLOWED: "0",
          EASY_PAY_DIRECT_ORGANIZATION_ID: "fixture",
          EASY_PAY_DIRECT_ACCOUNT_CODE: "fixture",
          ...overrides,
        },
        origin,
        "commerce_elements",
      ),
    ).toThrow();
  });
});
