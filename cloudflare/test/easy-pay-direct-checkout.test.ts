import { env } from "cloudflare:test";
import type { WorkflowStep } from "cloudflare:workers";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  handleEasyPayDirectCheckoutStatus,
  handleEasyPayDirectCheckoutSubmission,
  resumeEasyPayDirectExecution,
  reconcileEasyPayDirectGatewayExecution,
  EASY_PAY_DIRECT_SETUP_REVIEW_CODES,
} from "../src/api/easy-pay-direct-checkout";
import { sha256Hex } from "../src/auth/api-key";
import { easyPayDirectPurchaseKind } from "../src/billing/easy-pay-direct-purchase-kind";
import { stableJson } from "../src/json";
import { holdCustomerForClosure } from "../src/api/customer-closure";
import {
  easyPayDirectPaymentForm,
  verifyEasyPayDirectCheckoutToken,
} from "../src/providers/easy-pay-direct";
import {
  reconcileEasyPayDirectExecution,
  reconcileEasyPayDirectReceipt,
  pendingEasyPayDirectExecutions,
} from "../src/reconciliation/easy-pay-direct";
import { runCheckoutWorkflow } from "../src/workflows/checkout";
import {
  enrollProductScopedAutomaticCollections,
  prepareEasyPayDirectAutomaticCollection,
  processEasyPayDirectAutomaticCollection,
} from "../src/billing/easy-pay-direct-automatic-collection";

const organizationId = "org-easy-pay-direct-checkout";
let customerId: string;
let invoiceId: string;
let paymentRequestId: string;

beforeEach(seedCheckoutFixture);

async function monthlyFixture(interval = "monthly") {
  const now = new Date().toISOString();
  const planId = "review-plan-" + paymentRequestId;
  const subscriptionId = "review-sub-" + paymentRequestId;
  await env.BILLING_DB.batch([
    env.BILLING_DB.prepare(
      `INSERT INTO plans (id, organization_id, code, name, interval, amount_minor, currency, version, active, created_at, updated_at) VALUES (?, ?, ?, 'Review monthly', ?, 1999, 'USD', 1, 1, ?, ?)`,
    ).bind(planId, organizationId, planId, interval, now, now),
    env.BILLING_DB.prepare(
      `INSERT INTO subscriptions (id, organization_id, customer_id, plan_id, external_id, status, started_at, current_period_start, current_period_end, version, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'active', ?, ?, '2026-10-01T00:00:00.000Z', 1, ?, ?)`,
    ).bind(subscriptionId, organizationId, customerId, planId, subscriptionId, now, now, now, now),
    env.BILLING_DB.prepare("UPDATE invoices SET subscription_id = ? WHERE id = ?").bind(
      subscriptionId,
      invoiceId,
    ),
  ]);
  return subscriptionId;
}

function gatewaySaleProof(
  id: string,
  vault: string | null,
  amount = "19.99",
  order = paymentRequestId,
) {
  return new Response(
    `<nm_response><transaction><transaction_id>${id}</transaction_id><order_id>${order}</order_id><condition>complete</condition><currency>USD</currency>${vault ? `<customer_vault_id>${vault}</customer_vault_id>` : ""}<action><action_type>sale</action_type><success>1</success><amount>${amount}</amount></action></transaction></nm_response>`,
  );
}

describe("Gateway approval evidence before fulfillment", () => {
  it.each([
    { body: "response=3&response_code=300", http: 200, expected: "failed" },
    { body: "response=3&response_code=300&transactionid=0", http: 200, expected: "failed" },
    { body: "response=3&response_code=300", http: 503, expected: "unknown" },
    { body: "response=3&response_code=420", http: 200, expected: "unknown" },
    { body: "response=3&response_code=421", http: 200, expected: "unknown" },
    {
      body: "response=3&response_code=430&transactionid=prior-transaction",
      http: 200,
      expected: "unknown",
    },
    { body: "response=2&response_code=200", http: 200, expected: "unknown" },
    { body: "response=1&response_code=100", http: 200, expected: "unknown" },
    { body: "response=3&response_code=300&authcode=approved", http: 200, expected: "unknown" },
    { body: "response=3&response_code=300&orderid=another-order", http: 200, expected: "unknown" },
    { body: "response=3&response_code=300&response_code=420", http: 200, expected: "unknown" },
    {
      body: "response=3&response_code=300&authcode=&authcode=approved",
      http: 200,
      expected: "unknown",
    },
  ])(
    "only closes a fresh exact Gateway300 rejection with no financial evidence %j",
    async ({ body, http, expected }) => {
      await monthlyFixture();
      const runtime = enabledEnv("gateway_test");
      await runCheckoutWorkflow(runtime, checkoutParams(), immediateStep());
      const intent = await env.BILLING_DB.prepare(
        "SELECT payment_url FROM payment_request_checkout_intents WHERE payment_request_id=?",
      )
        .bind(paymentRequestId)
        .first<{ payment_url: string }>();
      const request = () =>
        new Request("https://lago.test/easy_pay_direct/payment_form", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            checkout: new URL(intent!.payment_url).searchParams.get("checkout"),
            payment_token: "fixture-rejected-token",
            phone: "+15555550123",
            terms_accepted: true,
          }),
        });
      const provider = vi.fn<typeof fetch>(
        async () =>
          new Response(`${body}&responsetext=Fixture+gateway+rejection`, { status: http }),
      );
      await expect(
        handleEasyPayDirectCheckoutSubmission(request(), runtime, "gateway-rejection", provider),
      ).rejects.toMatchObject({ status: expected === "failed" ? 422 : 503 });
      expect(
        await env.BILLING_DB.prepare(
          "SELECT status, failure_code FROM easy_pay_direct_payment_executions WHERE payment_request_id=?",
        )
          .bind(paymentRequestId)
          .first(),
      ).toMatchObject({
        status: expected,
        ...(expected === "failed" ? { failure_code: "300" } : {}),
      });
      expect(
        await env.BILLING_DB.prepare("SELECT payment_status FROM payment_requests WHERE id=?")
          .bind(paymentRequestId)
          .first(),
      ).toEqual({ payment_status: "pending" });
      expect(
        await env.BILLING_DB.prepare(
          "SELECT COUNT(*) AS count FROM payment_request_payments WHERE payment_request_id=?",
        )
          .bind(paymentRequestId)
          .first(),
      ).toEqual({ count: 0 });
      const replay = handleEasyPayDirectCheckoutSubmission(
        request(),
        runtime,
        "gateway-rejection-replay",
        provider,
      );
      if (body.includes("transactionid=prior-transaction")) {
        expect(await (await replay).json()).toMatchObject({ status: "processing", replayed: true });
      } else {
        await expect(replay).rejects.toMatchObject({ status: 409 });
      }
      expect(provider).toHaveBeenCalledTimes(1);
    },
  );
  it("never erases an earlier financial checkpoint when a later no-ID rejection arrives", async () => {
    await monthlyFixture();
    const runtime = enabledEnv("gateway_test");
    await runCheckoutWorkflow(runtime, checkoutParams(), immediateStep());
    const intent = await env.BILLING_DB.prepare(
      "SELECT payment_url FROM payment_request_checkout_intents WHERE payment_request_id=?",
    )
      .bind(paymentRequestId)
      .first<{ payment_url: string }>();
    const provider = vi.fn<typeof fetch>(async () => {
      await env.BILLING_DB.prepare(
        "UPDATE easy_pay_direct_payment_executions SET provider_transaction_id='earlier-financial-evidence' WHERE payment_request_id=?",
      )
        .bind(paymentRequestId)
        .run();
      return new Response("response=3&response_code=300");
    });
    await expect(
      handleEasyPayDirectCheckoutSubmission(
        new Request("https://lago.test/easy_pay_direct/payment_form", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            checkout: new URL(intent!.payment_url).searchParams.get("checkout"),
            payment_token: "fixture-conflicting-token",
            phone: "+15555550123",
            terms_accepted: true,
          }),
        }),
        runtime,
        "gateway-conflicting-rejection",
        provider,
      ),
    ).rejects.toMatchObject({ status: 503 });
    expect(
      await env.BILLING_DB.prepare(
        "SELECT status, provider_transaction_id FROM easy_pay_direct_payment_executions WHERE payment_request_id=?",
      )
        .bind(paymentRequestId)
        .first(),
    ).toEqual({ status: "unknown", provider_transaction_id: "earlier-financial-evidence" });
  });
  it.each(["immediate", "recovery"])(
    "preserves the approved-sale vault when Query omits it during %s",
    async (path) => {
      const subscriptionId = await monthlyFixture();
      const runtime = enabledEnv("gateway_test");
      await runCheckoutWorkflow(runtime, checkoutParams(), immediateStep());
      const intent = await env.BILLING_DB.prepare(
        "SELECT payment_url FROM payment_request_checkout_intents WHERE payment_request_id = ?",
      )
        .bind(paymentRequestId)
        .first<{ payment_url: string }>();
      let readAvailable = path === "immediate";
      const saleId = `approved-vault-sale-${paymentRequestId}`;
      const provider = vi.fn<typeof fetch>(async (url) => {
        if (String(url).includes("/api/query.php")) {
          if (!readAvailable) throw new Error("fixture Query unavailable");
          return gatewaySaleProof(saleId, null);
        }
        return new Response(
          `response=1&response_code=100&transactionid=${saleId}&customer_vault_id=12345`,
        );
      });
      const request = () =>
        new Request("https://lago.test/easy_pay_direct/payment_form", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            checkout: new URL(intent!.payment_url).searchParams.get("checkout"),
            payment_token: "hosted-vault-proof",
            phone: "+15555550123",
            terms_accepted: true,
          }),
        });
      if (path === "recovery") {
        await expect(
          handleEasyPayDirectCheckoutSubmission(request(), runtime, "vault-proof", provider),
        ).rejects.toThrow();
        expect(await executionForTest()).toMatchObject({
          customer_vault_id: "12345",
          provider_transaction_id: saleId,
        });
        readAvailable = true;
        await reconcileEasyPayDirectExecution(runtime, (await executionForTest())!.id, provider);
      } else {
        await handleEasyPayDirectCheckoutSubmission(request(), runtime, "vault-proof", provider);
      }
      expect(await executionForTest()).toMatchObject({
        status: "succeeded",
        customer_vault_id: "12345",
      });
      expect(
        await env.BILLING_DB.prepare(`SELECT p.gateway_customer_vault_id, p.initial_transaction_id
        FROM subscriptions s JOIN provider_customer_profiles p ON p.id=s.payment_method_id
        WHERE s.id=?`)
          .bind(subscriptionId)
          .first(),
      ).toEqual({
        gateway_customer_vault_id: "12345",
        initial_transaction_id: saleId,
      });
      await handleEasyPayDirectCheckoutSubmission(
        request(),
        runtime,
        "vault-proof-replay",
        provider,
      );
      expect(
        provider.mock.calls.filter(([url]) => String(url).includes("/api/transact.php")),
      ).toHaveLength(1);
    },
  );

  it("keeps recurring saved-card setup pending when both sale and Query omit the vault", async () => {
    const subscriptionId = await monthlyFixture();
    const runtime = enabledEnv("gateway_test");
    await runCheckoutWorkflow(runtime, checkoutParams(), immediateStep());
    const intent = await env.BILLING_DB.prepare(
      "SELECT payment_url FROM payment_request_checkout_intents WHERE payment_request_id=?",
    )
      .bind(paymentRequestId)
      .first<{ payment_url: string }>();
    const provider = vi.fn<typeof fetch>(async (url) =>
      String(url).includes("/api/query.php")
        ? gatewaySaleProof("no-vault-sale", null)
        : new Response("response=1&response_code=100&transactionid=no-vault-sale"),
    );
    await expect(
      handleEasyPayDirectCheckoutSubmission(
        new Request("https://lago.test/easy_pay_direct/payment_form", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            checkout: new URL(intent!.payment_url).searchParams.get("checkout"),
            payment_token: "no-vault-token",
            phone: "+15555550123",
            terms_accepted: true,
          }),
        }),
        runtime,
        "missing-vault",
        provider,
      ),
    ).rejects.toThrow();
    await expect(
      reconcileEasyPayDirectExecution(runtime, (await executionForTest())!.id, provider),
    ).resolves.toBe("deferred");
    expect((await executionForTest())!.status).not.toBe("succeeded");
    expect(
      await env.BILLING_DB.prepare("SELECT payment_method_id FROM subscriptions WHERE id=?")
        .bind(subscriptionId)
        .first(),
    ).toEqual({ payment_method_id: null });
    expect(
      provider.mock.calls.filter(([url]) => String(url).includes("/api/transact.php")),
    ).toHaveLength(1);
  });

  it.each(["wrong_amount", "wrong_id", "wrong_vault", "read_unavailable"])(
    "holds %s without another sale",
    async (fault) => {
      const saleId = `proof-${fault}`;
      const runtime = enabledEnv("gateway_test");
      if (fault === "wrong_vault") await monthlyFixture();
      await runCheckoutWorkflow(runtime, checkoutParams(), immediateStep());
      const intent = await env.BILLING_DB.prepare(
        "SELECT payment_url FROM payment_request_checkout_intents WHERE payment_request_id = ?",
      )
        .bind(paymentRequestId)
        .first<{ payment_url: string }>();
      const checkout = new URL(intent!.payment_url).searchParams.get("checkout");
      let correct = false;
      const provider = vi.fn<typeof fetch>(async (input) => {
        if (String(input).includes("/api/query.php")) {
          if (!correct && fault === "read_unavailable") throw new Error("fixture unavailable");
          return gatewaySaleProof(
            !correct && fault === "wrong_id" ? "other-sale" : saleId,
            fault === "wrong_vault" ? (correct ? "12345" : "67890") : null,
            !correct && fault === "wrong_amount" ? "1.00" : "19.99",
          );
        }
        return new Response(
          `response=1&response_code=100&responsetext=Approved&transactionid=${saleId}${fault === "wrong_vault" ? "&customer_vault_id=12345" : ""}`,
        );
      });
      const request = () =>
        new Request("https://lago.test/easy_pay_direct/payment_form", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            checkout,
            payment_token: "hosted-proof-token",
            phone: "+15555550123",
            first_name: "Fictional",
            last_name: "Customer",
            terms_accepted: true,
          }),
        });
      await expect(
        handleEasyPayDirectCheckoutSubmission(request(), runtime, "proof-request", provider),
      ).rejects.toThrow();
      const execution = await env.BILLING_DB.prepare(
        "SELECT id, provider_transaction_id, status, charge_transport FROM easy_pay_direct_payment_executions WHERE payment_request_id = ?",
      )
        .bind(paymentRequestId)
        .first<{
          id: string;
          status: string;
          provider_transaction_id: string;
          charge_transport: string;
        }>();
      expect(execution).toMatchObject({
        provider_transaction_id: saleId,
        charge_transport: "gateway",
      });
      expect(execution!.status).not.toBe("succeeded");
      expect(
        await env.BILLING_DB.prepare("SELECT payment_status FROM payment_requests WHERE id = ?")
          .bind(paymentRequestId)
          .first(),
      ).toEqual({ payment_status: "pending" });
      if (fault === "wrong_vault") {
        await expect(
          reconcileEasyPayDirectGatewayExecution(runtime, execution!.id, provider),
        ).rejects.toThrow();
        expect(
          await env.BILLING_DB.prepare(
            "SELECT customer_vault_id FROM easy_pay_direct_payment_executions WHERE id = ?",
          )
            .bind(execution!.id)
            .first(),
        ).toEqual({ customer_vault_id: "12345" });
      }
      correct = true;
      await reconcileEasyPayDirectGatewayExecution(runtime, execution!.id, provider);
      expect(
        await env.BILLING_DB.prepare("SELECT payment_status FROM payment_requests WHERE id = ?")
          .bind(paymentRequestId)
          .first(),
      ).toEqual({ payment_status: "succeeded" });
      expect(
        provider.mock.calls.filter(([input]) => String(input).includes("/api/transact.php")),
      ).toHaveLength(1);
    },
  );
});

describe("Gateway purchase authorization classification (real local D1)", () => {
  it("treats a standalone invoice as one-time", async () => {
    expect(await easyPayDirectPurchaseKind(env.BILLING_DB, organizationId, paymentRequestId)).toBe(
      "one_time",
    );
  });
  it.each(["weekly", "monthly", "quarterly", "yearly", "one_time"])(
    "classifies %s from the attached plan",
    async (interval) => {
      const plan = crypto.randomUUID();
      const subscription = crypto.randomUUID();
      const now = new Date().toISOString();
      await env.BILLING_DB.batch([
        env.BILLING_DB.prepare(`INSERT INTO plans (id, organization_id, code, name, interval, amount_minor, currency, version, active, created_at, updated_at)
        VALUES (?, ?, ?, 'Fixture', ?, 1999, 'USD', 1, 1, ?, ?)`).bind(
          plan,
          organizationId,
          plan,
          interval,
          now,
          now,
        ),
        env.BILLING_DB.prepare(`INSERT INTO subscriptions (id, organization_id, customer_id, plan_id, external_id, status, started_at, current_period_start, current_period_end, version, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, 'active', ?, ?, '2027-01-01T00:00:00.000Z', 1, ?, ?)`).bind(
          subscription,
          organizationId,
          customerId,
          plan,
          subscription,
          now,
          now,
          now,
          now,
        ),
        env.BILLING_DB.prepare("UPDATE invoices SET subscription_id = ? WHERE id = ?").bind(
          subscription,
          invoiceId,
        ),
      ]);
      expect(
        await easyPayDirectPurchaseKind(env.BILLING_DB, organizationId, paymentRequestId),
      ).toBe(interval === "one_time" ? "one_time" : "recurring");
    },
  );
  it("rejects absent or cross-organization invoice evidence", async () => {
    await expect(
      easyPayDirectPurchaseKind(env.BILLING_DB, "other-org", paymentRequestId),
    ).rejects.toMatchObject({ code: "easy_pay_direct_purchase_kind_unverified" });
    await expect(
      easyPayDirectPurchaseKind(env.BILLING_DB, organizationId, "missing-request"),
    ).rejects.toMatchObject({ code: "easy_pay_direct_purchase_kind_unverified" });
  });
});

describe("Elements initial checkout (mocked provider contract)", () => {
  const ids = {
    customer: "11111111-1111-4111-8111-111111111111",
    method: "22222222-2222-4222-8222-222222222222",
    product: "33333333-3333-4333-8333-333333333333",
    order: "44444444-4444-4444-8444-444444444444",
  };
  async function fixture() {
    for (const key of Object.keys(ids) as (keyof typeof ids)[]) ids[key] = crypto.randomUUID();
    const setup = await productionSubmission();
    const overrides: Record<string, unknown> = {
      APP_ENV: "development",
      EASY_PAY_DIRECT_CHECKOUT_BACKEND: "commerce_elements",
      EASY_PAY_DIRECT_NETWORK_MODE: "gateway_test",
      EASY_PAY_DIRECT_LIVEMODE_ALLOWED: "0",
      EASY_PAY_DIRECT_COMMERCE_API_KEY: "epd_test_sk_fixtureonly",
      PROVIDER_READS_ENABLED: "1",
    };
    const runtimeEnv = new Proxy(setup.runtimeEnv, {
      get(target, key, receiver) {
        return typeof key === "string" && key in overrides
          ? overrides[key]
          : Reflect.get(target, key, receiver);
      },
    });
    const order = {
      id: ids.order,
      customer_id: ids.customer,
      payment_method: { id: ids.method },
      status: "succeeded",
      total: 1999,
      currency: "usd",
      transactions: [
        { id: "55555555-5555-4555-8555-555555555555", type: "sale", status: "succeeded" },
      ],
    };
    let requestedCardToken = "cct_fixturesecuretoken";
    const fetcher = vi.fn<typeof fetch>(async (url, init) => {
      const path = new URL(String(url)).pathname;
      expect(String(url)).toContain("https://api.epd.com/v1/");
      if (path.endsWith("/customers") && init?.method === "GET")
        return Response.json({ data: [], has_more: false });
      if (path.endsWith("/customers") || path.endsWith(ids.customer))
        return Response.json({ id: ids.customer, email: "synthetic@example.com" });
      if (path.endsWith("/payment_methods")) {
        expect(JSON.parse(String(init?.body))).toMatchObject({
          card_token: requestedCardToken,
        });
        expect(String(init?.body)).not.toContain("billing_id");
        return Response.json({
          id: ids.method,
          customer: ids.customer,
          type: "card",
          is_default: true,
        });
      }
      if (path.endsWith("/products") || path.endsWith(ids.product))
        return Response.json({
          id: ids.product,
          pricing: { amount: 1999, currency: "usd" },
          requires_shipping: false,
        });
      if (path.endsWith("/orders") || path.endsWith(ids.order)) return Response.json(order);
      throw new Error("Unexpected mocked provider path");
    });
    return {
      runtimeEnv,
      request: (token = "cct_fixturesecuretoken") => {
        requestedCardToken = token;
        return setup.request(token);
      },
      fetcher,
      order,
    };
  }
  it("uses Commerce token attachment, settles once and never creates Gateway identifiers", async () => {
    const f = await fixture();
    await handleEasyPayDirectCheckoutSubmission(
      f.request(),
      f.runtimeEnv,
      "elements-initial",
      f.fetcher,
    );
    await handleEasyPayDirectCheckoutSubmission(
      f.request(),
      f.runtimeEnv,
      "elements-duplicate",
      f.fetcher,
    );
    expect(
      f.fetcher.mock.calls.filter(
        ([url, init]) => String(url).endsWith("/orders") && init?.method === "POST",
      ),
    ).toHaveLength(1);
    expect(
      await env.BILLING_DB.prepare(
        "SELECT payment_backend, gateway_customer_vault_id, gateway_billing_id FROM provider_customer_profiles WHERE customer_id = ?",
      )
        .bind(customerId)
        .first(),
    ).toEqual({
      payment_backend: "commerce_elements",
      gateway_customer_vault_id: null,
      gateway_billing_id: null,
    });
    expect(await executionForTest()).toMatchObject({
      status: "succeeded",
      provider_transaction_id: ids.order,
    });
  });
  it("retries only a transient read-only customer lookup and accepts a fresh cct", async () => {
    const f = await fixture();
    let firstLookup = true;
    const fetcher = vi.fn<typeof fetch>(async (url, init) => {
      if (firstLookup && init?.method === "GET" && String(url).includes("/customers?")) {
        firstLookup = false;
        return Response.json({ error: "temporary" }, { status: 503 });
      }
      return f.fetcher(url, init);
    });
    await expect(
      handleEasyPayDirectCheckoutSubmission(
        f.request("cct_firstunconsumedtoken"),
        f.runtimeEnv,
        "elements-read-timeout",
        fetcher,
      ),
    ).rejects.toMatchObject({ code: "easy_pay_direct_customer_lookup_retryable" });
    expect(await executionForTest()).toMatchObject({
      status: "pending",
      failure_code: "easy_pay_direct_customer_lookup_retryable",
    });
    expect(fetcher.mock.calls.every(([, init]) => init?.method === "GET")).toBe(true);

    await expect(
      handleEasyPayDirectCheckoutSubmission(
        f.request("cct_freshretrytoken"),
        f.runtimeEnv,
        "elements-read-retry",
        fetcher,
      ),
    ).resolves.toBeInstanceOf(Response);
    expect(
      fetcher.mock.calls.filter(
        ([url, init]) => String(url).endsWith("/orders") && init?.method === "POST",
      ),
    ).toHaveLength(1);
  });
  it("checks a completed checkout without card data or another provider call", async () => {
    const f = await fixture();
    const submission = f.request();
    const checkout = (await submission.clone().json<{ checkout: string }>()).checkout;
    await handleEasyPayDirectCheckoutSubmission(
      submission,
      f.runtimeEnv,
      "elements-status-initial",
      f.fetcher,
    );
    const providerCalls = f.fetcher.mock.calls.length;
    const response = await handleEasyPayDirectCheckoutStatus(
      new Request("https://lago.test/easy_pay_direct/payment_status", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ checkout }),
      }),
      f.runtimeEnv,
      "elements-status-check",
    );
    expect(await response.json()).toMatchObject({ status: "succeeded", replayed: true });
    expect(f.fetcher.mock.calls).toHaveLength(providerCalls);
  });
  it("reports a definitive failed transaction as failed instead of processing", async () => {
    const f = await fixture();
    const submission = f.request();
    const checkout = (await submission.clone().json<{ checkout: string }>()).checkout;
    await env.BILLING_DB.prepare(
      `INSERT INTO easy_pay_direct_payment_executions
       (id, organization_id, checkout_intent_id, payment_request_id, provider_account_code,
        request_sha256, payment_token_sha256, phone_sha256, customer_idempotency_key,
        payment_method_idempotency_key, product_idempotency_key, order_idempotency_key,
        status, provider_transaction_id, failure_code, failure_message, created_at, updated_at)
       SELECT ?, organization_id, id, payment_request_id, provider_account_code, request_sha256,
        'token-hash', 'phone-hash', ?, ?, ?, ?, 'failed', 'declined-transaction',
        'card_declined', 'Payment declined', ?, ?
       FROM payment_request_checkout_intents WHERE payment_request_id = ?`,
    )
      .bind(
        crypto.randomUUID(),
        crypto.randomUUID(),
        crypto.randomUUID(),
        crypto.randomUUID(),
        crypto.randomUUID(),
        new Date().toISOString(),
        new Date().toISOString(),
        paymentRequestId,
      )
      .run();
    const response = await handleEasyPayDirectCheckoutStatus(
      new Request("https://lago.test/easy_pay_direct/payment_status", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ checkout }),
      }),
      f.runtimeEnv,
      "failed-status-check",
    );
    expect(await response.json()).toMatchObject({ status: "failed" });
    expect(f.fetcher).not.toHaveBeenCalled();
  });
  it("uses the documented Elements contract in a coherent production environment", async () => {
    const f = await fixture();
    const liveEnv = new Proxy(f.runtimeEnv, {
      get(target, key, receiver) {
        if (key === "APP_ENV") return "production";
        if (key === "EASY_PAY_DIRECT_NETWORK_MODE") return "production";
        if (key === "EASY_PAY_DIRECT_LIVEMODE_ALLOWED") return "1";
        if (key === "EASY_PAY_DIRECT_COMMERCE_API_KEY") return "epd_live_sk_fixtureonly";
        return Reflect.get(target, key, receiver);
      },
    });
    await expect(
      handleEasyPayDirectCheckoutSubmission(f.request(), liveEnv, "elements-live", f.fetcher),
    ).resolves.toBeInstanceOf(Response);
    expect(
      f.fetcher.mock.calls.filter(
        ([url, init]) => String(url).endsWith("/orders") && init?.method === "POST",
      ),
    ).toHaveLength(1);
  });
  it("binds a monthly subscription to the exact Commerce saved method", async () => {
    const now = new Date().toISOString();
    const planId = crypto.randomUUID();
    const subscriptionId = crypto.randomUUID();
    await env.BILLING_DB.batch([
      env.BILLING_DB.prepare(`INSERT INTO plans (id, organization_id, code, name, interval, amount_minor, currency, version, active, created_at, updated_at)
        VALUES (?, ?, ?, 'Elements monthly', 'monthly', 1999, 'USD', 1, 1, ?, ?)`).bind(
        planId,
        organizationId,
        planId,
        now,
        now,
      ),
      env.BILLING_DB.prepare(`INSERT INTO subscriptions (id, organization_id, customer_id, plan_id, external_id, status, started_at, current_period_start, current_period_end, version, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, 'active', ?, ?, '2026-10-01T00:00:00.000Z', 1, ?, ?)`).bind(
        subscriptionId,
        organizationId,
        customerId,
        planId,
        subscriptionId,
        now,
        now,
        now,
        now,
      ),
      env.BILLING_DB.prepare("UPDATE invoices SET subscription_id=? WHERE id=?").bind(
        subscriptionId,
        invoiceId,
      ),
    ]);
    const f = await fixture();
    await handleEasyPayDirectCheckoutSubmission(
      f.request(),
      f.runtimeEnv,
      "elements-monthly",
      f.fetcher,
    );
    expect(
      await env.BILLING_DB.prepare(`SELECT p.payment_backend, p.provider_payment_method_id FROM subscriptions s
      JOIN provider_customer_profiles p ON p.id=s.payment_method_id WHERE s.id=?`)
        .bind(subscriptionId)
        .first(),
    ).toEqual({ payment_backend: "commerce_elements", provider_payment_method_id: ids.method });
  });
  it("holds an early webhook with a different customer before settlement", async () => {
    const f = await fixture();
    f.order.status = "pending";
    await handleEasyPayDirectCheckoutSubmission(
      f.request(),
      f.runtimeEnv,
      "elements-pending",
      f.fetcher,
    );
    const receiptId = crypto.randomUUID();
    await insertArchivedEvent(
      receiptId,
      receiptId,
      "order.succeeded",
      ids.order,
      JSON.stringify({
        type: "order.succeeded",
        data: {
          object: {
            ...f.order,
            status: "succeeded",
            customer_id: crypto.randomUUID(),
            metadata: { lago_payment_request_id: paymentRequestId },
          },
        },
      }),
    );
    await expect(reconcileEasyPayDirectReceipt(f.runtimeEnv, receiptId)).rejects.toThrow();
    expect(
      await env.BILLING_DB.prepare("SELECT payment_status FROM payment_requests WHERE id=?")
        .bind(paymentRequestId)
        .first(),
    ).toEqual({ payment_status: "pending" });
  });
  it("records a decline without settling or resubmitting", async () => {
    const f = await fixture();
    f.order.status = "failed";
    f.order.transactions = [];
    await expect(
      handleEasyPayDirectCheckoutSubmission(
        f.request(),
        f.runtimeEnv,
        "elements-decline",
        f.fetcher,
      ),
    ).rejects.toMatchObject({ code: "easy_pay_direct_declined" });
    expect(await executionForTest()).toMatchObject({ status: "failed" });
    const calls = f.fetcher.mock.calls.length;
    await expect(
      handleEasyPayDirectCheckoutSubmission(
        f.request(),
        f.runtimeEnv,
        "elements-decline-again",
        f.fetcher,
      ),
    ).rejects.toThrow();
    expect(f.fetcher.mock.calls).toHaveLength(calls);
  });
  it("rejects a success envelope whose order evidence says failed", async () => {
    const f = await fixture();
    f.order.status = "pending";
    await handleEasyPayDirectCheckoutSubmission(
      f.request(),
      f.runtimeEnv,
      "elements-event-conflict",
      f.fetcher,
    );
    const receiptId = crypto.randomUUID();
    await insertArchivedEvent(
      receiptId,
      receiptId,
      "order.succeeded",
      ids.order,
      JSON.stringify({
        type: "order.succeeded",
        data: {
          object: {
            ...f.order,
            status: "failed",
            metadata: { lago_payment_request_id: paymentRequestId },
          },
        },
      }),
    );
    await expect(reconcileEasyPayDirectReceipt(f.runtimeEnv, receiptId)).rejects.toMatchObject({
      code: "easy_pay_direct_order_evidence_mismatch",
    });
    expect(
      await env.BILLING_DB.prepare("SELECT payment_status FROM payment_requests WHERE id=?")
        .bind(paymentRequestId)
        .first(),
    ).toEqual({ payment_status: "pending" });
  });
  it("preserves mismatched order evidence and only GETs it during reconciliation", async () => {
    const f = await fixture();
    f.order.total = 2000;
    await expect(
      handleEasyPayDirectCheckoutSubmission(
        f.request(),
        f.runtimeEnv,
        "elements-mismatch",
        f.fetcher,
      ),
    ).rejects.toThrow();
    const execution = await executionForTest();
    expect(execution).toMatchObject({ provider_transaction_id: ids.order });
    f.order.total = 1999;
    f.fetcher.mockClear();
    await reconcileEasyPayDirectExecution(f.runtimeEnv, execution!.id, f.fetcher);
    expect(f.fetcher.mock.calls.every(([, init]) => init?.method === "GET")).toBe(true);
    expect(await executionForTest()).toMatchObject({ status: "succeeded" });
  });
  it("never retries an uncertain Elements POST via the Gateway recovery path", async () => {
    const f = await fixture();
    const lost = vi.fn<typeof fetch>(async (url, init) => {
      if (String(url).endsWith("/orders")) throw new Error("fixture-response-lost");
      return f.fetcher(url, init);
    });
    await expect(
      handleEasyPayDirectCheckoutSubmission(f.request(), f.runtimeEnv, "elements-lost", lost),
    ).rejects.toThrow();
    const execution = await executionForTest();
    const noNetwork = vi.fn<typeof fetch>();
    expect(await resumeEasyPayDirectExecution(f.runtimeEnv, execution!.id, noNetwork)).toBe(
      "deferred",
    );
    expect(
      await reconcileEasyPayDirectGatewayExecution(f.runtimeEnv, execution!.id, noNetwork),
    ).toBe("deferred");
    expect(noNetwork).not.toHaveBeenCalled();
  });
});

async function seedCheckoutFixture() {
  const fixtureId = crypto.randomUUID();
  customerId = `customer-easy-pay-direct-checkout-${fixtureId}`;
  invoiceId = `invoice-easy-pay-direct-checkout-${fixtureId}`;
  paymentRequestId = `payment-request-easy-pay-direct-checkout-${fixtureId}`;
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
       VALUES (?, ?, ?, 'synthetic@example.com', 'Synthetic Customer',
               'USD', '{}', 'easy_pay_direct', 'epd-synthetic', ?, ?)`,
    ).bind(customerId, organizationId, `easy-pay-direct-customer-${fixtureId}`, now, now),
    env.BILLING_DB.prepare(
      `INSERT OR IGNORE INTO invoices
       (id, organization_id, customer_id, number, status, payment_status, currency,
        subtotal_minor, tax_minor, credits_minor, total_due_minor, version, finalized_at,
        payment_overdue, ready_for_payment_processing, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'finalized', 'pending',
               'USD', 1999, 0, 0, 1999, 1, ?, 1, 1, ?, ?)`,
    ).bind(invoiceId, organizationId, customerId, `INV-EPD-${fixtureId}`, now, now, now),
    env.BILLING_DB.prepare(
      `INSERT OR IGNORE INTO payment_requests
       (id, organization_id, customer_id, amount_minor, currency, email, payment_attempts,
        payment_status, ready_for_payment_processing, version, created_at, updated_at)
       VALUES (?, ?, ?, 1999, 'USD', 'synthetic@example.com', 0, 'pending', 1, 1, ?, ?)`,
    ).bind(paymentRequestId, organizationId, customerId, now, now),
    env.BILLING_DB.prepare(
      `INSERT OR IGNORE INTO invoices_payment_requests
       (id, organization_id, payment_request_id, invoice_id, invoice_version, created_at, updated_at)
       VALUES (?, ?, ?, ?, 1, ?, ?)`,
    ).bind(
      `link-easy-pay-direct-checkout-${fixtureId}`,
      organizationId,
      paymentRequestId,
      invoiceId,
      now,
      now,
    ),
  ]);
}

describe("EPD post-payment recovery and evidence", () => {
  it("preserves an early success webhook's order checkpoint when a resumed POST loses its response", async () => {
    await monthlyFixture();
    const { runtimeEnv, request } = await productionSubmission();
    const provider = commerceVaultFixture();
    await expect(
      handleEasyPayDirectCheckoutSubmission(
        request(),
        runtimeEnv,
        "interrupted-before-order",
        vi.fn<typeof fetch>(async (input, init) => {
          if (String(input).endsWith("/products")) throw new Error("fixture-product-timeout");
          return provider.fetcher(input, init);
        }),
      ),
    ).rejects.toThrow();
    const execution = await executionForTest();
    const intent = await env.BILLING_DB.prepare(
      "SELECT checkout_intent_id FROM easy_pay_direct_payment_executions WHERE id = ?",
    )
      .bind(execution!.id)
      .first<{ checkout_intent_id: string }>();
    await expect(
      resumeEasyPayDirectExecution(
        runtimeEnv,
        execution!.id,
        vi.fn<typeof fetch>(async (input, init) => {
          const response = await provider.fetcher(input, init);
          if (!String(input).endsWith("/orders")) return response;
          const order = approvedOrder(true);
          const receiptId = "early-success-before-timeout-" + paymentRequestId;
          await insertArchivedEvent(
            receiptId,
            receiptId,
            "order.succeeded",
            order.id,
            JSON.stringify({
              type: "order.succeeded",
              data: {
                object: {
                  ...order,
                  metadata: {
                    lago_payment_request_id: paymentRequestId,
                    lago_checkout_intent_id: intent!.checkout_intent_id,
                  },
                },
              },
            }),
          );
          await reconcileEasyPayDirectReceipt(runtimeEnv, receiptId);
          throw new Error("fixture-order-response-lost");
        }),
      ),
    ).rejects.toThrow();
    expect(await executionForTest()).toMatchObject({
      status: "unknown",
      provider_transaction_id: approvedOrder(true).id,
    });
    expect(await pendingEasyPayDirectExecutions(env.BILLING_DB, "production")).toContain(
      execution!.id,
    );
    const reader = vi.fn<typeof fetch>(async (input, init) => {
      expect(String(input)).toBe(`https://api.epd.com/v1/orders/${approvedOrder(true).id}`);
      expect(init?.method).toBe("GET");
      return Response.json(approvedOrder(true));
    });
    await reconcileEasyPayDirectExecution(runtimeEnv, execution!.id, reader);
    expect(await executionForTest()).toMatchObject({ status: "succeeded" });
    expect(provider.operations.filter((operation) => operation === "order")).toHaveLength(1);
    expect(reader).toHaveBeenCalledOnce();
  });

  it("recovers recurring setup when a verified success follows a failed webhook", async () => {
    const subscriptionId = await monthlyFixture();
    const { runtimeEnv, request } = await productionSubmission();
    const provider = commerceVaultFixture();
    await handleEasyPayDirectCheckoutSubmission(
      request(),
      runtimeEnv,
      "pending-before-events",
      vi.fn<typeof fetch>(async (input, init) => {
        const response = await provider.fetcher(input, init);
        return String(input).endsWith("/orders")
          ? Response.json({ ...approvedOrder(false), status: "pending" })
          : response;
      }),
    );
    const execution = await executionForTest();
    for (const status of ["failed", "succeeded"]) {
      const receiptId = status + "-then-success-" + paymentRequestId;
      const order = { ...approvedOrder(false), status };
      await insertArchivedEvent(
        receiptId,
        receiptId,
        "order." + status,
        order.id,
        JSON.stringify({
          type: "order." + status,
          data: {
            object: {
              ...order,
              metadata: { lago_payment_request_id: paymentRequestId },
            },
          },
        }),
      );
      await reconcileEasyPayDirectReceipt(runtimeEnv, receiptId);
    }
    expect(await pendingEasyPayDirectExecutions(env.BILLING_DB, "production")).toContain(
      execution!.id,
    );
    const reader = vi.fn<typeof fetch>(async (_input, init) => {
      expect(init?.method ?? "GET").toBe("GET");
      return Response.json(approvedOrder(true));
    });
    await reconcileEasyPayDirectExecution(runtimeEnv, execution!.id, reader);
    await reconcileEasyPayDirectExecution(runtimeEnv, execution!.id, reader);
    expect(await executionForTest()).toMatchObject({ status: "succeeded" });
    expect(
      await env.BILLING_DB.prepare(`SELECT profile.initial_transaction_id
      FROM subscriptions subscription JOIN provider_customer_profiles profile
      ON profile.id = subscription.payment_method_id AND profile.organization_id = subscription.organization_id
      WHERE subscription.id = ?`)
        .bind(subscriptionId)
        .first(),
    ).toMatchObject({
      initial_transaction_id: expect.any(String),
    });
    expect(reader).toHaveBeenCalledOnce();
    expect(provider.operations.filter((operation) => operation === "order")).toHaveLength(1);
  });

  it.each(["webhook", "provider-read"])(
    "does not discard paid-checkout recovery after a stale %s failure",
    async (path) => {
      await monthlyFixture();
      const { runtimeEnv, request } = await productionSubmission();
      const provider = commerceVaultFixture();
      await handleEasyPayDirectCheckoutSubmission(
        request(),
        runtimeEnv,
        "paid-before-failure",
        vi.fn<typeof fetch>(async (input, init) => {
          const response = await provider.fetcher(input, init);
          return String(input).endsWith("/orders") ? Response.json(approvedOrder(false)) : response;
        }),
      );
      const execution = await executionForTest();
      const failed = { ...approvedOrder(false), status: "failed" };
      if (path === "webhook") {
        const receiptId = "stale-failed-" + paymentRequestId;
        await insertArchivedEvent(
          receiptId,
          receiptId,
          "order.failed",
          failed.id,
          JSON.stringify({
            type: "order.failed",
            data: {
              object: { ...failed, metadata: { lago_payment_request_id: paymentRequestId } },
            },
          }),
        );
        await reconcileEasyPayDirectReceipt(runtimeEnv, receiptId);
      } else {
        await reconcileEasyPayDirectExecution(
          runtimeEnv,
          execution!.id,
          vi.fn<typeof fetch>(async () => Response.json(failed)),
        );
      }
      expect(await pendingEasyPayDirectExecutions(env.BILLING_DB, "production")).toContain(
        execution!.id,
      );
      expect(await executionForTest()).toMatchObject({ status: "unknown" });
      await reconcileEasyPayDirectExecution(
        runtimeEnv,
        execution!.id,
        vi.fn<typeof fetch>(async () => Response.json(approvedOrder(true))),
      );
      expect(await executionForTest()).toMatchObject({ status: "succeeded" });
      expect(provider.operations.filter((operation) => operation === "order")).toHaveLength(1);
    },
  );

  it("keeps a past-due monthly subscription recoverable while processor evidence is missing", async () => {
    const subscriptionId = await monthlyFixture();
    await env.BILLING_DB.prepare("UPDATE subscriptions SET status = 'past_due' WHERE id = ?")
      .bind(subscriptionId)
      .run();
    const { runtimeEnv, request } = await productionSubmission();
    const provider = commerceVaultFixture();
    await handleEasyPayDirectCheckoutSubmission(
      request(),
      runtimeEnv,
      "past-due-review",
      vi.fn<typeof fetch>(async (input, init) => {
        const response = await provider.fetcher(input, init);
        return String(input).endsWith("/orders") ? Response.json(approvedOrder(false)) : response;
      }),
    );
    expect(await executionForTest()).toMatchObject({ status: "unknown" });
  });

  it("does not replace a newer saved subscription card during delayed checkout recovery", async () => {
    const subscriptionId = await monthlyFixture();
    const { runtimeEnv, request } = await productionSubmission();
    const provider = commerceVaultFixture();
    await handleEasyPayDirectCheckoutSubmission(
      request(),
      runtimeEnv,
      "older-checkout",
      provider.fetcher,
    );
    const newerProfileId = `newer-card-${paymentRequestId}`;
    await env.BILLING_DB.prepare(
      `INSERT INTO provider_customer_profiles
       (id, organization_id, customer_id, provider, provider_account_code, provider_customer_id,
        provider_payment_method_id, gateway_customer_vault_id, gateway_billing_id,
        initial_transaction_id, status, created_at, updated_at)
       SELECT ?, organization_id, customer_id, provider, provider_account_code, provider_customer_id,
              'newer-card', gateway_customer_vault_id, '987654321', 'newer-transaction',
              'active', '2099-01-01T00:00:00.000Z', '2099-01-01T00:00:00.000Z'
       FROM provider_customer_profiles WHERE customer_id = ? LIMIT 1`,
    )
      .bind(newerProfileId, customerId)
      .run();
    await env.BILLING_DB.prepare(
      "UPDATE subscriptions SET payment_method_type = 'provider', payment_method_id = ? WHERE id = ?",
    )
      .bind(newerProfileId, subscriptionId)
      .run();
    const execution = await executionForTest();
    expect(
      await reconcileEasyPayDirectExecution(
        runtimeEnv,
        execution!.id,
        vi.fn<typeof fetch>(async () => Response.json(approvedOrder(true))),
      ),
    ).toBe("processed");
    expect(
      await env.BILLING_DB.prepare("SELECT payment_method_id FROM subscriptions WHERE id = ?")
        .bind(subscriptionId)
        .first(),
    ).toEqual({ payment_method_id: newerProfileId });
    expect(provider.operations.filter((operation) => operation === "order")).toHaveLength(1);
  });

  it.each(["profile-write", "missing-vault"])(
    "recovers Gateway test %s without a second charge or Commerce read",
    async (fault) => {
      const subscriptionId = await monthlyFixture();
      const runtimeEnv = enabledEnv("gateway_test");
      await runCheckoutWorkflow(runtimeEnv, checkoutParams(), immediateStep());
      const intent = await env.BILLING_DB.prepare(
        "SELECT payment_url FROM payment_request_checkout_intents WHERE payment_request_id = ?",
      )
        .bind(paymentRequestId)
        .first<{ payment_url: string }>();
      const failingDb = new Proxy(env.BILLING_DB, {
        get(target, property) {
          if (property === "prepare")
            return (sql: string) => {
              if (sql.includes("INSERT INTO provider_customer_profiles"))
                throw new Error("fixture profile write unavailable");
              return target.prepare(sql);
            };
          const value = Reflect.get(target, property);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
      const failingEnv = new Proxy(runtimeEnv, {
        get(target, property) {
          return property === "BILLING_DB" && fault === "profile-write"
            ? failingDb
            : Reflect.get(target, property);
        },
      });
      const charge = vi.fn<typeof fetch>(async (url) =>
        String(url).includes("/api/query.php")
          ? gatewaySaleProof(
              `gateway-review-${paymentRequestId}`,
              fault === "missing-vault" ? null : "gateway-review-vault",
            )
          : new Response(
              `response=1&responsetext=Approved&response_code=100&transactionid=gateway-review-${paymentRequestId}` +
                (fault === "missing-vault" ? "" : "&customer_vault_id=gateway-review-vault"),
            ),
      );
      await expect(
        handleEasyPayDirectCheckoutSubmission(
          new Request("https://lago.test/easy_pay_direct/payment_form", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              checkout: new URL(intent!.payment_url).searchParams.get("checkout"),
              payment_token: "hosted-fixture-token",
              phone: "+15555550123",
              terms_accepted: true,
            }),
          }),
          failingEnv,
          "gateway-recovery-fixture",
          charge,
        ),
      ).rejects.toThrow();
      const execution = await executionForTest();
      expect(execution!.status).not.toBe("succeeded");
      expect(
        await env.BILLING_DB.prepare("SELECT payment_status FROM payment_requests WHERE id = ?")
          .bind(paymentRequestId)
          .first(),
      ).toEqual({ payment_status: "succeeded" });
      const read = vi.fn<typeof fetch>(async (input, init) => {
        expect(String(input)).toContain("/api/query.php");
        expect(new URLSearchParams(String(init?.body)).get("order_id")).toBe(paymentRequestId);
        return new Response(
          `<nm_response><transaction><transaction_id>gateway-review-${paymentRequestId}</transaction_id><order_id>${paymentRequestId}</order_id><condition>complete</condition><currency>USD</currency><customer_vault_id>gateway-review-vault</customer_vault_id><action><action_type>sale</action_type><success>1</success><amount>19.99</amount></action></transaction></nm_response>`,
        );
      });
      expect(await reconcileEasyPayDirectExecution(runtimeEnv, execution!.id, read)).toBe(
        "processed",
      );
      expect(await reconcileEasyPayDirectExecution(runtimeEnv, execution!.id, read)).toBe(
        "processed",
      );
      expect(
        charge.mock.calls.filter(([url]) => String(url).includes("/api/transact.php")),
      ).toHaveLength(1);
      expect(read).toHaveBeenCalledOnce();
      expect(await executionForTest()).toMatchObject({ status: "succeeded" });
      const subscription = await env.BILLING_DB.prepare(
        "SELECT payment_method_type, payment_method_id FROM subscriptions WHERE id = ?",
      )
        .bind(subscriptionId)
        .first<{ payment_method_id: string; payment_method_type: string }>();
      expect(subscription?.payment_method_type).toBe("provider");
      expect(subscription?.payment_method_id).toBeTruthy();
    },
  );

  it("does not wait for or enable renewals on a one-time purchase", async () => {
    const subscriptionId = await monthlyFixture("one_time");
    const { runtimeEnv, request } = await productionSubmission();
    const provider = commerceVaultFixture();
    await handleEasyPayDirectCheckoutSubmission(
      request(),
      runtimeEnv,
      "one-time-review",
      vi.fn<typeof fetch>(async (input, init) => {
        const response = await provider.fetcher(input, init);
        return String(input).endsWith("/orders") ? Response.json(approvedOrder(false)) : response;
      }),
    );
    expect(await executionForTest()).toMatchObject({ status: "succeeded" });
    expect(
      await env.BILLING_DB.prepare("SELECT payment_method_id FROM subscriptions WHERE id = ?")
        .bind(subscriptionId)
        .first(),
    ).toEqual({ payment_method_id: null });
  });

  it("recovers the order ID from an early webhook without submitting another order", async () => {
    await monthlyFixture();
    const { runtimeEnv, request } = await productionSubmission();
    const provider = commerceVaultFixture();
    const fetcher = vi.fn<typeof fetch>(async (input, init) => {
      const response = await provider.fetcher(input, init);
      if (String(input).endsWith("/orders")) throw new TypeError("fixture lost response");
      return response;
    });
    await expect(
      handleEasyPayDirectCheckoutSubmission(request(), runtimeEnv, "early-hook", fetcher),
    ).rejects.toThrow();
    const execution = await executionForTest();
    const intent = await env.BILLING_DB.prepare(
      "SELECT checkout_intent_id FROM easy_pay_direct_payment_executions WHERE id = ?",
    )
      .bind(execution!.id)
      .first<{ checkout_intent_id: string }>();
    const order = approvedOrder(false);
    const receipt = "early-hook-" + paymentRequestId;
    await insertArchivedEvent(
      receipt,
      receipt,
      "order.succeeded",
      order.id,
      JSON.stringify({
        type: "order.succeeded",
        data: {
          object: {
            ...order,
            metadata: {
              lago_payment_request_id: paymentRequestId,
              lago_checkout_intent_id: intent!.checkout_intent_id,
            },
          },
        },
      }),
    );
    await reconcileEasyPayDirectReceipt(runtimeEnv, receipt);
    expect(await pendingEasyPayDirectExecutions(env.BILLING_DB, "production")).toContain(
      execution!.id,
    );
    const reader = vi.fn<typeof fetch>(async (_input, init) => {
      expect(init?.method).toBe("GET");
      return Response.json(approvedOrder(true));
    });
    await expect(reconcileEasyPayDirectExecution(runtimeEnv, execution!.id, reader)).resolves.toBe(
      "processed",
    );
    expect(provider.operations.filter((op) => op === "order")).toHaveLength(1);
    expect(reader).toHaveBeenCalledTimes(1);
    expect(await executionForTest()).toMatchObject({ status: "succeeded" });
  });

  it.each(["wrong-currency", "missing-total"])(
    "rejects %s webhook evidence before settling",
    async (fault) => {
      const { runtimeEnv, request } = await productionSubmission();
      const provider = commerceVaultFixture();
      await handleEasyPayDirectCheckoutSubmission(
        request(),
        runtimeEnv,
        "webhook-evidence",
        provider.fetcher,
      );
      const order: Record<string, unknown> = approvedOrder(false);
      if (fault === "wrong-currency") order.currency = "eur";
      else delete order.total;
      const receipt = "bad-hook-" + paymentRequestId;
      await insertArchivedEvent(
        receipt,
        receipt,
        "order.succeeded",
        String(order.id),
        JSON.stringify({
          type: "order.succeeded",
          data: { object: { ...order, metadata: { lago_payment_request_id: paymentRequestId } } },
        }),
      );
      await expect(reconcileEasyPayDirectReceipt(runtimeEnv, receipt)).rejects.toMatchObject({
        code: "easy_pay_direct_order_evidence_mismatch",
      });
      expect(
        await env.BILLING_DB.prepare("SELECT payment_status FROM payment_requests WHERE id = ?")
          .bind(paymentRequestId)
          .first(),
      ).toEqual({ payment_status: "pending" });
    },
  );

  it.each([false, true])(
    "retries a local tax commit without charging again (legacy success: %s)",
    async (legacySuccess) => {
      await env.BILLING_DB.prepare(
        "UPDATE payment_requests SET collection_mode = 'checkout' WHERE id = ?",
      )
        .bind(paymentRequestId)
        .run();
      const { runtimeEnv, request } = await productionSubmission();
      const intent = await env.BILLING_DB.prepare(
        "SELECT id FROM payment_request_checkout_intents WHERE payment_request_id = ?",
      )
        .bind(paymentRequestId)
        .first<{ id: string }>();
      const quoteId = "review-tax-" + paymentRequestId;
      const now = new Date().toISOString();
      const addressHash = await sha256Hex(
        stableJson({ country: "US", state: "CA", postalCode: "90001" }),
      );
      await env.BILLING_DB.prepare(`INSERT INTO easy_pay_direct_checkout_tax_quotes
      (id, organization_id, payment_request_id, invoice_id, source_checkout_intent_id, active_checkout_intent_id,
       provider_code, provider_calculation_id, request_sha256, billing_address_sha256, billing_country, billing_state, billing_postal_code,
       currency, subtotal_minor, tax_minor, total_minor, tax_code, status, expires_at, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, 'local_d1', ?, 'fixture-hash', ?, 'US', 'CA', '90001', 'USD', 1999, 0, 1999,
        'fixture-software', 'applied', ?, ?, ?)`)
        .bind(
          quoteId,
          organizationId,
          paymentRequestId,
          invoiceId,
          intent!.id,
          intent!.id,
          quoteId,
          addressHash,
          new Date(Date.now() + 3600000).toISOString(),
          now,
          now,
        )
        .run();
      let failCommit = true;
      const database = new Proxy(env.BILLING_DB, {
        get(target, key) {
          if (key === "prepare")
            return (sql: string) => {
              if (failCommit && sql.includes("SET status = 'committed'"))
                throw new Error("fixture tax write failure");
              return target.prepare(sql);
            };
          const value = Reflect.get(target, key);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
      const taxEnv = new Proxy(runtimeEnv, {
        get(target, key) {
          if (key === "BILLING_DB") return database;
          if (key === "EASY_PAY_DIRECT_TAX_MODE") return "enforced";
          return Reflect.get(target, key);
        },
      });
      const body = await request().json<Record<string, unknown>>();
      const pay = new Request(request().url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...body,
          tax_quote_id: quoteId,
          billing_address: { country: "US", state: "CA", postal_code: "90001" },
        }),
      });
      const provider = commerceVaultFixture();
      await handleEasyPayDirectCheckoutSubmission(
        pay,
        taxEnv,
        "tax-write-review",
        vi.fn<typeof fetch>(async (input, init) => {
          const response = await provider.fetcher(input, init);
          return String(input).endsWith("/orders") ? Response.json(approvedOrder(false)) : response;
        }),
      );
      const execution = await executionForTest();
      expect(execution!.status).not.toBe("succeeded");
      if (legacySuccess)
        await env.BILLING_DB.prepare(
          "UPDATE easy_pay_direct_payment_executions SET status = 'succeeded' WHERE id = ?",
        )
          .bind(execution!.id)
          .run();
      expect(await pendingEasyPayDirectExecutions(env.BILLING_DB, "production")).toContain(
        execution!.id,
      );
      failCommit = false;
      await expect(
        reconcileEasyPayDirectExecution(
          taxEnv,
          execution!.id,
          vi.fn<typeof fetch>(async (_input, init) => {
            expect(init?.method).toBe("GET");
            return Response.json(approvedOrder(false));
          }),
        ),
      ).resolves.toBe("processed");
      expect(
        await env.BILLING_DB.prepare(
          "SELECT status FROM easy_pay_direct_checkout_tax_quotes WHERE id = ?",
        )
          .bind(quoteId)
          .first(),
      ).toEqual({ status: "committed" });
      expect(provider.operations.filter((op) => op === "order")).toHaveLength(1);
    },
  );

  it("rotates pending provider orders beyond the oldest 100", async () => {
    const executions: string[] = [];
    let runtimeEnv = enabledEnv("production");
    for (let index = 0; index < 101; index++) {
      if (index) await seedCheckoutFixture();
      const fixture = await productionSubmission();
      runtimeEnv = fixture.runtimeEnv;
      await handleEasyPayDirectCheckoutSubmission(
        fixture.request(),
        runtimeEnv,
        "fair-batch",
        commerceVaultFixture().fetcher,
      );
      const execution = await executionForTest();
      executions.push(execution!.id);
      await env.BILLING_DB.prepare(
        "UPDATE easy_pay_direct_payment_executions SET updated_at = ? WHERE id = ?",
      )
        .bind(new Date(Date.UTC(2020, 0, 1, 0, 0, index)).toISOString(), execution!.id)
        .run();
    }
    const firstBatch = await pendingEasyPayDirectExecutions(env.BILLING_DB, "production");
    expect(firstBatch).toHaveLength(100);
    expect(firstBatch).not.toContain(executions[100]);
    for (const id of firstBatch) {
      await reconcileEasyPayDirectExecution(
        runtimeEnv,
        id,
        vi.fn<typeof fetch>(async (input) =>
          Response.json({ id: String(input).split("/").pop(), status: "pending" }),
        ),
      );
    }
    expect(await pendingEasyPayDirectExecutions(env.BILLING_DB, "production")).toContain(
      executions[100],
    );
    await env.BILLING_DB.batch(
      executions.map((id) =>
        env.BILLING_DB.prepare(
          "UPDATE easy_pay_direct_payment_executions SET status = 'failed' WHERE id = ?",
        ).bind(id),
      ),
    );
  });

  const approvedOrder = (withTransactions: boolean) => ({
    id: "fixture-order-" + paymentRequestId,
    status: "succeeded",
    total: 1999,
    currency: "usd",
    ...(withTransactions
      ? {
          transactions: [
            {
              id: "review-tx",
              processor_transaction_id: "review-processor",
              status: "succeeded",
              type: "sale",
            },
          ],
        }
      : {}),
  });

  it.each(["inline", "provider-read"])(
    "recovers late renewal details after %s success",
    async (path) => {
      const subscriptionId = await monthlyFixture();
      const { runtimeEnv, request } = await productionSubmission();
      const provider = commerceVaultFixture();
      const fetcher = vi.fn<typeof fetch>(async (input, init) => {
        const response = await provider.fetcher(input, init);
        return path === "inline" && String(input).endsWith("/orders")
          ? Response.json(approvedOrder(false))
          : response;
      });
      await handleEasyPayDirectCheckoutSubmission(
        request(),
        runtimeEnv,
        "review-late-renewal",
        fetcher,
      );
      const execution = await executionForTest();
      if (path === "provider-read") {
        await reconcileEasyPayDirectExecution(
          runtimeEnv,
          execution!.id,
          vi.fn<typeof fetch>(async () => Response.json(approvedOrder(false))),
        );
      }
      const laterRead = vi.fn<typeof fetch>(async () => Response.json(approvedOrder(true)));
      await reconcileEasyPayDirectExecution(runtimeEnv, execution!.id, laterRead);
      const profile = await env.BILLING_DB.prepare(
        "SELECT initial_transaction_id FROM provider_customer_profiles WHERE customer_id = ?",
      )
        .bind(customerId)
        .first();
      const subscription = await env.BILLING_DB.prepare(
        "SELECT payment_method_type FROM subscriptions WHERE id = ?",
      )
        .bind(subscriptionId)
        .first();
      expect({ profile, subscription }).toEqual({
        profile: { initial_transaction_id: "review-processor" },
        subscription: { payment_method_type: "provider" },
      });
    },
  );

  it("recovers an interrupted renewal-profile write after inline success", async () => {
    await monthlyFixture();
    const { runtimeEnv, request } = await productionSubmission();
    let failProfileWrite = true;
    const database = new Proxy(env.BILLING_DB, {
      get(target, key) {
        if (key === "prepare")
          return (sql: string) => {
            if (failProfileWrite && sql.includes("SET initial_transaction_id = COALESCE")) {
              throw new Error("review-injected-profile-write-failure");
            }
            return target.prepare(sql);
          };
        const value = Reflect.get(target, key);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const faultEnv = new Proxy(runtimeEnv, {
      get(target, key) {
        return key === "BILLING_DB" ? database : Reflect.get(target, key);
      },
    });
    const provider = commerceVaultFixture();
    await handleEasyPayDirectCheckoutSubmission(
      request(),
      faultEnv,
      "review-profile-write",
      vi.fn<typeof fetch>(async (input, init) => {
        const response = await provider.fetcher(input, init);
        return String(input).endsWith("/orders") ? Response.json(approvedOrder(true)) : response;
      }),
    );
    failProfileWrite = false;
    const execution = await executionForTest();
    await reconcileEasyPayDirectExecution(
      runtimeEnv,
      execution!.id,
      vi.fn<typeof fetch>(async () => Response.json(approvedOrder(true))),
    );
    expect(
      await env.BILLING_DB.prepare(
        "SELECT initial_transaction_id FROM provider_customer_profiles WHERE customer_id = ?",
      )
        .bind(customerId)
        .first(),
    ).toEqual({ initial_transaction_id: "review-processor" });
  });

  it.each(["wrong-currency", "missing-total"])(
    "rejects %s provider-read evidence before settling",
    async (fault) => {
      const { runtimeEnv, request } = await productionSubmission();
      const provider = commerceVaultFixture();
      await handleEasyPayDirectCheckoutSubmission(
        request(),
        runtimeEnv,
        "review-evidence",
        provider.fetcher,
      );
      const execution = await executionForTest();
      const order: Record<string, unknown> = approvedOrder(false);
      if (fault === "wrong-currency") order.currency = "eur";
      else delete order.total;
      await reconcileEasyPayDirectExecution(
        runtimeEnv,
        execution!.id,
        vi.fn<typeof fetch>(async () => Response.json(order)),
      ).catch(() => undefined);
      expect(
        await env.BILLING_DB.prepare("SELECT payment_status FROM payment_requests WHERE id = ?")
          .bind(paymentRequestId)
          .first(),
      ).toEqual({ payment_status: "pending" });
    },
  );
});

describe("Easy Pay Direct Commerce checkout execution", () => {
  it.each(["paid", "disabled"])(
    "rechecks %s state after provider setup and before ordering",
    async (state) => {
      const { runtimeEnv, request } = await productionSubmission();
      const provider = commerceVaultFixture();
      const fetcher = vi.fn<typeof fetch>(async (input, init) => {
        const result = await provider.fetcher(input, init);
        if (String(input).endsWith("/products")) {
          await env.BILLING_DB.prepare(
            "UPDATE payment_requests SET payment_status = ?, ready_for_payment_processing = 0 WHERE id = ?",
          )
            .bind(state === "paid" ? "succeeded" : "pending", paymentRequestId)
            .run();
        }
        return result;
      });
      await expect(
        handleEasyPayDirectCheckoutSubmission(request(), runtimeEnv, "late-state-change", fetcher),
      ).rejects.toMatchObject({ code: "easy_pay_direct_checkout_state_changed" });
      expect(provider.operations).toContain("product");
      expect(provider.operations).not.toContain("order");
      const execution = await executionForTest();
      expect(execution).toMatchObject({
        status: "unknown",
        failure_code: "easy_pay_direct_checkout_state_changed",
        provider_transaction_id: null,
      });
      const calls = fetcher.mock.calls.length;
      await expect(resumeEasyPayDirectExecution(runtimeEnv, execution!.id, fetcher)).resolves.toBe(
        "deferred",
      );
      expect(fetcher).toHaveBeenCalledTimes(calls);
    },
  );

  it("still reads an existing order when charging is disabled and recovery checkpoints are missing", async () => {
    const { runtimeEnv, request } = await productionSubmission();
    const provider = commerceVaultFixture();
    await handleEasyPayDirectCheckoutSubmission(
      request(),
      runtimeEnv,
      "existing-order",
      provider.fetcher,
    );
    const execution = await executionForTest();
    await env.BILLING_DB.batch([
      env.BILLING_DB.prepare(
        "UPDATE payment_requests SET payment_status = 'succeeded', ready_for_payment_processing = 0 WHERE id = ?",
      ).bind(paymentRequestId),
      env.BILLING_DB.prepare(
        "UPDATE easy_pay_direct_payment_executions SET status = 'unknown', failure_code = 'easy_pay_direct_recovery_checkpoint_missing', phone_ciphertext = NULL, phone_iv = NULL, gateway_billing_id = 'legacy-id' WHERE id = ?",
      ).bind(execution!.id),
    ]);
    expect(await pendingEasyPayDirectExecutions(env.BILLING_DB, "production")).toContain(
      execution!.id,
    );
    const fetcher = vi.fn<typeof fetch>(async (input, init) => {
      expect(String(input)).toBe(`https://api.epd.com/v1/orders/fixture-order-${paymentRequestId}`);
      expect(init?.method).toBe("GET");
      return Response.json({ id: `fixture-order-${paymentRequestId}`, status: "pending" });
    });
    await expect(reconcileEasyPayDirectExecution(runtimeEnv, execution!.id, fetcher)).resolves.toBe(
      "deferred",
    );
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it.each(["paid", "disabled"])("recovery must not order when request is %s", async (state) => {
    const { runtimeEnv, request } = await productionSubmission();
    const provider = commerceVaultFixture();
    let attachmentUnavailable = true;
    const fetcher = vi.fn<typeof fetch>(async (input, init) => {
      if (attachmentUnavailable && String(input).endsWith("/payment_methods"))
        return new Response("Unavailable", { status: 503 });
      return provider.fetcher(input, init);
    });
    await expect(
      handleEasyPayDirectCheckoutSubmission(request(), runtimeEnv, "review-seed", fetcher),
    ).rejects.toThrow();
    const execution = await executionForTest();
    await env.BILLING_DB.prepare(
      "UPDATE payment_requests SET payment_status = ?, ready_for_payment_processing = 0 WHERE id = ?",
    )
      .bind(state === "paid" ? "succeeded" : "pending", paymentRequestId)
      .run();
    attachmentUnavailable = false;
    await resumeEasyPayDirectExecution(runtimeEnv, execution!.id, fetcher);
    expect(provider.operations.filter((operation) => operation === "order")).toHaveLength(0);
  });

  it.each(["legacy-billing", "missing-phone"])(
    "%s records must not starve recovery",
    async (kind) => {
      for (let i = 0; i < 101; i += 1) {
        if (i > 0) await seedCheckoutFixture();
        const { runtimeEnv, request } = await productionSubmission();
        const provider = commerceVaultFixture({ exposeBinding: false });
        await expect(
          handleEasyPayDirectCheckoutSubmission(
            request(),
            runtimeEnv,
            "review-held",
            provider.fetcher,
          ),
        ).rejects.toThrow();
        const execution = await executionForTest();
        await env.BILLING_DB.prepare(
          "UPDATE easy_pay_direct_payment_executions SET customer_vault_id = 'fixture-vault', gateway_billing_id = ?, failure_code = ?, phone_ciphertext = CASE WHEN ? = 'missing-phone' THEN NULL ELSE phone_ciphertext END, phone_iv = CASE WHEN ? = 'missing-phone' THEN NULL ELSE phone_iv END WHERE id = ?",
        )
          .bind(
            kind === "legacy-billing" ? "legacy-id" : "123",
            kind === "missing-phone" ? "easy_pay_direct_recovery_checkpoint_missing" : null,
            kind,
            kind,
            execution!.id,
          )
          .run();
      }
      await seedCheckoutFixture();
      const { runtimeEnv, request } = await productionSubmission();
      const provider = commerceVaultFixture({ rejectAttach: true });
      await expect(
        handleEasyPayDirectCheckoutSubmission(
          request(),
          runtimeEnv,
          "review-actionable",
          provider.fetcher,
        ),
      ).rejects.toThrow();
      const actionable = await executionForTest();
      await env.BILLING_DB.prepare(
        "UPDATE easy_pay_direct_payment_executions SET failure_code = NULL WHERE id = ?",
      )
        .bind(actionable!.id)
        .run();
      expect(await pendingEasyPayDirectExecutions(env.BILLING_DB, "production")).toContain(
        actionable!.id,
      );
    },
  );
  it.each(
    ["lookup", "read_customer"].flatMap((operation) =>
      [503, 429, "network"].map((failure) => ({ operation, failure })),
    ),
  )(
    "allows a fresh submission after $operation $failure, without consuming the first token",
    async ({ operation, failure }) => {
      const { runtimeEnv, request } = await productionSubmission();
      const provider = commerceVaultFixture({ expectedToken: "fresh-fictional-hosted-token" });
      let unavailable = true;
      const fetcher = vi.fn<typeof fetch>(async (input, init) => {
        const isRead =
          operation === "lookup"
            ? String(input).includes("/customers?")
            : String(input).endsWith("/customers/fixture-customer");
        if (unavailable && isRead) {
          if (failure === "network") throw new TypeError("Network unavailable");
          return new Response("Temporary outage", { status: Number(failure) });
        }
        return provider.fetcher(input, init);
      });
      await expect(
        handleEasyPayDirectCheckoutSubmission(request(), runtimeEnv, "read-outage", fetcher),
      ).rejects.toMatchObject({ code: "easy_pay_direct_customer_lookup_retryable" });
      expect(provider.savedVaults).toEqual([]);
      const execution = await executionForTest();
      expect(execution).toMatchObject({
        status: "pending",
        customer_vault_id: null,
        gateway_billing_id: null,
      });
      await expect(resumeEasyPayDirectExecution(runtimeEnv, execution!.id, fetcher)).resolves.toBe(
        "deferred",
      );
      unavailable = false;
      const response = await handleEasyPayDirectCheckoutSubmission(
        request("fresh-fictional-hosted-token"),
        runtimeEnv,
        "read-recovered",
        fetcher,
      );
      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toMatchObject({ status: "processing" });
      expect(provider.operations.filter((item) => item === "add_billing")).toHaveLength(1);
      expect(provider.operations.filter((item) => item === "order")).toHaveLength(1);
    },
  );

  it("keeps a gateway timeout unknown and never makes its consumed token retryable", async () => {
    const { runtimeEnv, request } = await productionSubmission();
    const provider = commerceVaultFixture();
    const fetcher = vi.fn<typeof fetch>(async (input, init) => {
      if (String(input).includes("/api/transact.php")) throw new Error("gateway timeout");
      return provider.fetcher(input, init);
    });
    await expect(
      handleEasyPayDirectCheckoutSubmission(request(), runtimeEnv, "vault-timeout", fetcher),
    ).rejects.toThrow();
    expect(await executionForTest()).toMatchObject({ status: "unknown" });
    const count = fetcher.mock.calls.length;
    await expect(
      handleEasyPayDirectCheckoutSubmission(request(), runtimeEnv, "vault-timeout-retry", fetcher),
    ).rejects.toMatchObject({ status: 409 });
    expect(fetcher).toHaveBeenCalledTimes(count);
  });

  it("allows only one concurrent retry to claim a read-only failure", async () => {
    const { runtimeEnv, request } = await productionSubmission();
    await expect(
      handleEasyPayDirectCheckoutSubmission(
        request(),
        runtimeEnv,
        "seed-read-failure",
        async () => new Response("Unavailable", { status: 503 }),
      ),
    ).rejects.toThrow();
    const provider = commerceVaultFixture({ expectedToken: "fresh-fictional-hosted-token" });
    let releaseRead: () => void = () => {};
    let markEntered: () => void = () => {};
    const blockedRead = new Promise<void>((resolve) => {
      releaseRead = resolve;
    });
    const enteredRead = new Promise<void>((resolve) => {
      markEntered = resolve;
    });
    const fetcher = vi.fn<typeof fetch>(async (input, init) => {
      if (String(input).includes("/customers?")) {
        markEntered();
        await blockedRead;
      }
      return provider.fetcher(input, init);
    });
    const first = handleEasyPayDirectCheckoutSubmission(
      request("fresh-fictional-hosted-token"),
      runtimeEnv,
      "retry-first",
      fetcher,
    );
    await enteredRead;
    try {
      await expect(
        handleEasyPayDirectCheckoutSubmission(
          request("fresh-fictional-hosted-token"),
          runtimeEnv,
          "retry-overlap",
          fetcher,
        ),
      ).rejects.toMatchObject({ status: 409 });
    } finally {
      releaseRead();
      await first;
    }
    expect(provider.operations.filter((item) => item === "add_billing")).toHaveLength(1);
    expect(provider.operations.filter((item) => item === "order")).toHaveLength(1);
  });

  it("defers a recovery lookup outage without resetting a vaulted execution or aborting the batch", async () => {
    const { runtimeEnv, request } = await productionSubmission();
    const provider = commerceVaultFixture();
    let stage = "attachment-outage";
    const fetcher = vi.fn<typeof fetch>(async (input, init) => {
      if (
        (stage === "attachment-outage" && String(input).endsWith("/payment_methods")) ||
        (stage === "read-outage" && String(input).endsWith("/customers/fixture-customer"))
      ) {
        return new Response("Temporary outage", { status: 503 });
      }
      return provider.fetcher(input, init);
    });
    await expect(
      handleEasyPayDirectCheckoutSubmission(request(), runtimeEnv, "checkpoint-outage", fetcher),
    ).rejects.toThrow();
    const execution = await executionForTest();
    expect(execution).toMatchObject({
      status: "unknown",
      customer_vault_id: "fixture-existing-vault",
    });
    stage = "read-outage";
    await expect(resumeEasyPayDirectExecution(runtimeEnv, execution!.id, fetcher)).resolves.toBe(
      "deferred",
    );
    expect(await executionForTest()).toMatchObject({
      status: "unknown",
      failure_code: "easy_pay_direct_customer_lookup_retryable",
    });
    stage = "recovered";
    await expect(resumeEasyPayDirectExecution(runtimeEnv, execution!.id, fetcher)).resolves.toBe(
      "advanced",
    );
    expect(provider.operations.filter((item) => item === "add_billing")).toHaveLength(1);
    expect(provider.operations.filter((item) => item === "order")).toHaveLength(1);
  });

  it("selects actionable records beyond 100 held executions and retains existing orders", async () => {
    let orderedHeldId = "";
    const fixtureIds: string[] = [];
    for (let i = 0; i < 101; i += 1) {
      if (i > 0) await seedCheckoutFixture();
      const { runtimeEnv, request } = await productionSubmission();
      const provider = commerceVaultFixture({ exposeBinding: false });
      await expect(
        handleEasyPayDirectCheckoutSubmission(
          request(),
          runtimeEnv,
          "hold-fixture",
          provider.fetcher,
        ),
      ).rejects.toThrow();
      const execution = await executionForTest();
      fixtureIds.push(execution!.id);
      await env.BILLING_DB.prepare(
        `UPDATE easy_pay_direct_payment_executions SET customer_vault_id = 'fixture-vault', gateway_billing_id = '123', failure_code = ? WHERE id = ?`,
      )
        .bind(
          EASY_PAY_DIRECT_SETUP_REVIEW_CODES[i % EASY_PAY_DIRECT_SETUP_REVIEW_CODES.length],
          execution!.id,
        )
        .run();
      orderedHeldId = execution!.id;
    }
    await env.BILLING_DB.prepare(
      "UPDATE easy_pay_direct_payment_executions SET provider_transaction_id = 'fixture-held-order' WHERE id = ?",
    )
      .bind(orderedHeldId)
      .run();
    await seedCheckoutFixture();
    const { runtimeEnv, request } = await productionSubmission();
    const provider = commerceVaultFixture({ rejectAttach: true });
    await expect(
      handleEasyPayDirectCheckoutSubmission(
        request(),
        runtimeEnv,
        "actionable-fixture",
        provider.fetcher,
      ),
    ).rejects.toThrow();
    const actionable = await executionForTest();
    fixtureIds.push(actionable!.id);
    await env.BILLING_DB.prepare(
      "UPDATE easy_pay_direct_payment_executions SET failure_code = NULL WHERE id = ?",
    )
      .bind(actionable!.id)
      .run();
    expect(await pendingEasyPayDirectExecutions(env.BILLING_DB, "production")).toEqual(
      expect.arrayContaining([orderedHeldId, actionable!.id]),
    );
    expect(
      (await pendingEasyPayDirectExecutions(env.BILLING_DB, "production")).filter((id) =>
        fixtureIds.includes(id),
      ),
    ).toHaveLength(2);
  });

  it("looks up the existing Commerce vault before saving a card when no local profile exists", async () => {
    const { runtimeEnv, request } = await productionSubmission();
    const provider = commerceVaultFixture();
    const response = await handleEasyPayDirectCheckoutSubmission(
      request(),
      runtimeEnv,
      "vault-link",
      provider.fetcher,
    );
    await expect(response.json()).resolves.toMatchObject({
      status: "processing",
      provider_order_id: `fixture-order-${paymentRequestId}`,
    });
    expect(provider.operations).toEqual([
      "lookup",
      "read_customer",
      "add_billing",
      "attach",
      "product",
      "order",
    ]);
    expect(provider.savedVaults).toEqual(["fixture-existing-vault"]);
    await expect(
      env.BILLING_DB.prepare(
        "SELECT provider_customer_id, gateway_customer_vault_id, provider_payment_method_id FROM provider_customer_profiles WHERE customer_id = ?",
      )
        .bind(customerId)
        .first(),
    ).resolves.toEqual({
      provider_customer_id: "fixture-customer",
      gateway_customer_vault_id: "fixture-existing-vault",
      provider_payment_method_id: "fixture-new-method",
    });
    const calls = provider.fetcher.mock.calls.length;
    await handleEasyPayDirectCheckoutSubmission(
      request(),
      runtimeEnv,
      "vault-link-replay",
      provider.fetcher,
    );
    expect(provider.fetcher).toHaveBeenCalledTimes(calls);
  });

  it("attaches the submitted card explicitly even when new-customer creation returns a default", async () => {
    const { runtimeEnv, request } = await productionSubmission();
    const provider = commerceVaultFixture({ existing: false });
    await handleEasyPayDirectCheckoutSubmission(
      request(),
      runtimeEnv,
      "new-vault-link",
      provider.fetcher,
    );
    expect(provider.operations).toEqual([
      "lookup",
      "add_customer",
      "create_customer",
      "read_customer",
      "attach",
      "product",
      "order",
    ]);
    expect(provider.savedVaults).toEqual(["fixture-new-vault"]);
  });

  it("does not consume a card token when Commerce omits the legacy vault binding", async () => {
    const { runtimeEnv, request } = await productionSubmission();
    const provider = commerceVaultFixture({ exposeBinding: false });
    await expect(
      handleEasyPayDirectCheckoutSubmission(
        request(),
        runtimeEnv,
        "missing-vault",
        provider.fetcher,
      ),
    ).rejects.toMatchObject({ code: "easy_pay_direct_customer_vault_unverified" });
    expect(provider.operations).toEqual(["lookup", "read_customer"]);
    const execution = await executionForTest();
    expect(execution).toMatchObject({
      status: "unknown",
      failure_code: "easy_pay_direct_customer_vault_unverified",
      provider_transaction_id: null,
    });
    await expect(
      resumeEasyPayDirectExecution(runtimeEnv, execution!.id, provider.fetcher),
    ).resolves.toBe("deferred");
    await expect(
      handleEasyPayDirectCheckoutSubmission(
        request(),
        runtimeEnv,
        "missing-vault-again",
        provider.fetcher,
      ),
    ).rejects.toMatchObject({ status: 409 });
    expect(provider.operations).toEqual(["lookup", "read_customer"]);
  });

  it("quarantines an old wrong-vault checkpoint without another attachment, charge, or retry loop", async () => {
    const { runtimeEnv, request } = await productionSubmission();
    const provider = commerceVaultFixture({ exposeBinding: false });
    await expect(
      handleEasyPayDirectCheckoutSubmission(
        request(),
        runtimeEnv,
        "seed-execution",
        provider.fetcher,
      ),
    ).rejects.toMatchObject({ status: 409 });
    // Reproduce the persisted pre-fix state, using only synthetic local D1 rows.
    await env.BILLING_DB.prepare(
      `UPDATE easy_pay_direct_payment_executions SET customer_vault_id = 'wrong-vault', gateway_billing_id = '123456',
       provider_customer_id = 'fixture-customer', last_checkpoint = 'provider_customer', failure_code = NULL
       WHERE payment_request_id = ?`,
    )
      .bind(paymentRequestId)
      .run();
    const verifiedProvider = commerceVaultFixture();
    const execution = await executionForTest();
    await expect(
      resumeEasyPayDirectExecution(runtimeEnv, execution!.id, verifiedProvider.fetcher),
    ).resolves.toBe("deferred");
    expect(verifiedProvider.operations).toEqual(["read_customer"]);
    await expect(executionForTest()).resolves.toMatchObject({
      status: "unknown",
      failure_code: "easy_pay_direct_customer_vault_mismatch",
      customer_vault_id: "wrong-vault",
      gateway_billing_id: "123456",
      provider_transaction_id: null,
    });
    await expect(
      resumeEasyPayDirectExecution(runtimeEnv, execution!.id, verifiedProvider.fetcher),
    ).resolves.toBe("deferred");
    await expect(
      handleEasyPayDirectCheckoutSubmission(
        request(),
        runtimeEnv,
        "wrong-vault-again",
        verifiedProvider.fetcher,
      ),
    ).rejects.toMatchObject({ status: 409 });
    expect(verifiedProvider.operations).toEqual(["read_customer"]);
  });

  it("stops a definitive attachment rejection and hides the provider's vault identifiers", async () => {
    const { runtimeEnv, request } = await productionSubmission();
    const provider = commerceVaultFixture({ rejectAttach: true });
    await expect(
      handleEasyPayDirectCheckoutSubmission(
        request(),
        runtimeEnv,
        "attach-rejected",
        provider.fetcher,
      ),
    ).rejects.toMatchObject({
      code: "easy_pay_direct_payment_method_rejected",
      message: expect.not.stringContaining("private-vault"),
    });
    expect(provider.operations).toEqual(["lookup", "read_customer", "add_billing", "attach"]);
    const execution = await executionForTest();
    expect(execution).toMatchObject({
      status: "unknown",
      failure_code: "easy_pay_direct_payment_method_rejected",
      provider_transaction_id: null,
    });
    await expect(
      resumeEasyPayDirectExecution(runtimeEnv, execution!.id, provider.fetcher),
    ).resolves.toBe("deferred");
    expect(provider.operations).toEqual(["lookup", "read_customer", "add_billing", "attach"]);
  });

  it("stops before attachment when newly created Commerce customer is not linked to the requested vault", async () => {
    const { runtimeEnv, request } = await productionSubmission();
    const provider = commerceVaultFixture({ existing: false, ignoreRequestedBinding: true });
    await expect(
      handleEasyPayDirectCheckoutSubmission(
        request(),
        runtimeEnv,
        "create-binding-mismatch",
        provider.fetcher,
      ),
    ).rejects.toMatchObject({ code: "easy_pay_direct_customer_vault_mismatch" });
    expect(provider.operations).toEqual([
      "lookup",
      "add_customer",
      "create_customer",
      "read_customer",
    ]);
  });

  it("rejects a product checkout before provider or database work when terms are not accepted", async () => {
    const providerFetch = vi.fn<typeof fetch>();
    await expect(
      handleEasyPayDirectCheckoutSubmission(
        new Request("https://lago.test/easy_pay_direct/payment_form", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            checkout: "signed-checkout-token",
            payment_token: "hosted-payment-token",
            phone: "+15555550123",
            terms_accepted: false,
          }),
        }),
        enabledEnv("gateway_test"),
        "request-epd-terms",
        providerFetch,
      ),
    ).rejects.toMatchObject({ code: "easy_pay_direct_terms_required", status: 422 });
    expect(providerFetch).not.toHaveBeenCalled();
  });

  it("rejects an already-issued checkout after a customer closure hold without calling EPD", async () => {
    const runtimeEnv = enabledEnv("gateway_test");
    await runCheckoutWorkflow(runtimeEnv, checkoutParams(), immediateStep());
    const checkout = await env.BILLING_DB.prepare(
      "SELECT payment_url FROM payment_request_checkout_intents WHERE payment_request_id = ?",
    )
      .bind(paymentRequestId)
      .first<{ payment_url: string }>();
    const customer = await env.BILLING_DB.prepare("SELECT external_id FROM customers WHERE id = ?")
      .bind(customerId)
      .first<{ external_id: string }>();
    const response = await holdCustomerForClosure(
      env.BILLING_DB,
      { organizationId, organizationExternalId: organizationId, apiKeyId: "test" },
      customer!.external_id,
      "hold-test",
    );
    expect(response.status).toBe(200);
    const providerFetch = vi.fn<typeof fetch>();
    await expect(
      handleEasyPayDirectCheckoutSubmission(
        new Request("https://lago.test/easy_pay_direct/payment_form", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            checkout: new URL(checkout!.payment_url).searchParams.get("checkout"),
            payment_token: "hosted-token-closed",
            phone: "+15555550123",
            terms_accepted: true,
          }),
        }),
        runtimeEnv,
        "closed-test",
        providerFetch,
      ),
    ).rejects.toMatchObject({ status: 409 });
    expect(providerFetch).not.toHaveBeenCalled();
  });

  it("does not treat reusable provider payment tokens as global idempotency keys", async () => {
    const indexes = await env.BILLING_DB.prepare(
      "PRAGMA index_list('easy_pay_direct_payment_executions')",
    ).all<{ name: string; unique: number }>();
    const uniqueIndexColumns = await Promise.all(
      indexes.results
        .filter((index) => index.unique === 1)
        .map(async (index) => {
          const columns = await env.BILLING_DB.prepare(
            `PRAGMA index_info('${index.name.replaceAll("'", "''")}')`,
          ).all<{ name: string }>();
          return columns.results.map((column) => column.name);
        }),
    );

    expect(uniqueIndexColumns).not.toContainEqual(["payment_token_sha256"]);
  });

  it("charges the product canary through forced Gateway test mode and reconciles once", async () => {
    const sendBatch = vi.fn(async (_messages: MessageSendRequest<unknown>[]) => undefined);
    const runtimeEnv = new Proxy(enabledEnv("gateway_test"), {
      get(target, property, receiver) {
        if (property === "DOMAIN_EVENTS") {
          return new Proxy(env.DOMAIN_EVENTS, {
            get(queue, method) {
              if (method === "sendBatch") return sendBatch;
              const value = Reflect.get(queue, method, queue);
              return typeof value === "function" ? value.bind(queue) : value;
            },
          });
        }
        return Reflect.get(target, property, receiver) as unknown;
      },
    }) as Env;
    const recurringPlanId = `plan-${paymentRequestId}`;
    const recurringSubscriptionId = `subscription-${paymentRequestId}`;
    const now = new Date().toISOString();
    await env.BILLING_DB.batch([
      env.BILLING_DB.prepare(
        `INSERT INTO provider_customer_profiles
         (id, organization_id, customer_id, provider, provider_account_code,
          provider_customer_id, gateway_customer_vault_id, status, created_at, updated_at)
         VALUES (?, ?, ?, 'easy_pay_direct', 'epd-synthetic',
                 'gateway:legacy-placeholder', 'vault-test-legacy', 'active', ?, ?)`,
      ).bind(`legacy-profile-${paymentRequestId}`, organizationId, customerId, now, now),
      env.BILLING_DB.prepare(
        `INSERT INTO plans
         (id, organization_id, code, name, interval, amount_minor, currency,
          version, active, created_at, updated_at)
         VALUES (?, ?, ?, 'EPD checkout subscription', 'monthly', 1999, 'USD', 1, 1, ?, ?)`,
      ).bind(recurringPlanId, organizationId, recurringPlanId, now, now),
      env.BILLING_DB.prepare(
        `INSERT INTO subscriptions
         (id, organization_id, customer_id, plan_id, external_id, status, started_at,
          current_period_start, current_period_end, version, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 'active', ?, ?, '2026-10-01T00:00:00.000Z', 1, ?, ?)`,
      ).bind(
        recurringSubscriptionId,
        organizationId,
        customerId,
        recurringPlanId,
        recurringSubscriptionId,
        now,
        now,
        now,
        now,
      ),
      env.BILLING_DB.prepare(
        `UPDATE invoices
         SET subscription_id = ?, updated_at = ?
         WHERE id = ? AND organization_id = ?`,
      ).bind(recurringSubscriptionId, now, invoiceId, organizationId),
    ]);
    await runCheckoutWorkflow(runtimeEnv, checkoutParams(), immediateStep());
    const checkout = await env.BILLING_DB.prepare(
      `SELECT payment_url, status, provider_account_code FROM payment_request_checkout_intents
       WHERE payment_request_id = ? AND provider = 'easy_pay_direct'`,
    )
      .bind(paymentRequestId)
      .first<{ payment_url: string; status: string; provider_account_code: string }>();
    expect(checkout).toMatchObject({ status: "succeeded", provider_account_code: "epd-synthetic" });
    await expect(
      env.BILLING_DB.prepare(
        `SELECT intent.organization_id, intent.payment_request_id, intent.request_sha256,
                request.organization_id AS request_organization_id, request.payment_status
         FROM payment_request_checkout_intents intent
         JOIN payment_requests request ON request.id = intent.payment_request_id
         WHERE intent.payment_request_id = ?`,
      )
        .bind(paymentRequestId)
        .first(),
    ).resolves.toMatchObject({
      organization_id: organizationId,
      payment_request_id: paymentRequestId,
      request_organization_id: organizationId,
      payment_status: "pending",
    });
    const checkoutToken = new URL(checkout!.payment_url).searchParams.get("checkout")!;
    const checkoutForm = await easyPayDirectPaymentForm(new URL(checkout!.payment_url), runtimeEnv);
    const checkoutHtml = await checkoutForm.text();
    expect(checkoutHtml).toContain("SERP subscription");
    expect(checkoutHtml).toContain("$19.99");
    expect(checkoutHtml).toContain("synthetic@example.com");
    expect(checkoutHtml).toContain("Total due today");
    const providerFetch = vi.fn<typeof fetch>(async (_input, init) => {
      if (String(_input).includes("/api/query.php"))
        return gatewaySaleProof("epd-gateway-test-1", "87426631");
      const body = new URLSearchParams(String(init?.body));
      expect(body.get("payment_token")).toBe("hosted-token-canary-1");
      expect(body.get("amount")).toBe("19.99");
      expect(body.get("test_mode")).toBe("enabled");
      expect(body.get("security_key")).toBe("synthetic-security-key");
      expect(body.has("ccnumber")).toBe(false);
      return new Response(
        "response=1&responsetext=Approved&response_code=100&transactionid=epd-gateway-test-1&authcode=TEST&customer_vault_id=87426631",
      );
    });
    const request = () =>
      new Request("https://lago.test/easy_pay_direct/payment_form", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          checkout: checkoutToken,
          payment_token: "hosted-token-canary-1",
          phone: "+15555550123",
          first_name: "Fictional",
          last_name: "Customer",
          terms_accepted: true,
          return_to:
            "https://store.test/checkout/success?session_id=lago%3Ainvoice-1&provider=easy_pay_direct",
        }),
      });
    const first = await handleEasyPayDirectCheckoutSubmission(
      request(),
      runtimeEnv,
      "request-epd-gateway-test-1",
      providerFetch,
    );
    await expect(first.json()).resolves.toMatchObject({
      status: "succeeded",
      provider: "easy_pay_direct",
      provider_order_id: "epd-gateway-test-1",
      replayed: false,
      redirect_url:
        "https://store.test/checkout/success?session_id=lago%3Ainvoice-1&provider=easy_pay_direct",
    });
    expect(sendBatch).toHaveBeenCalledTimes(1);
    expect(
      sendBatch.mock.calls[0]?.[0].some(
        (message) =>
          typeof message.body === "object" &&
          message.body !== null &&
          "type" in message.body &&
          message.body.type === "payment.succeeded",
      ),
    ).toBe(true);
    const replay = await handleEasyPayDirectCheckoutSubmission(
      request(),
      runtimeEnv,
      "request-epd-gateway-test-2",
      providerFetch,
    );
    await expect(replay.json()).resolves.toMatchObject({ status: "succeeded", replayed: true });
    expect(sendBatch).toHaveBeenCalledTimes(2);
    expect(
      providerFetch.mock.calls.filter(([url]) => String(url).includes("/api/transact.php")),
    ).toHaveLength(1);
    await expect(
      env.BILLING_DB.prepare(
        `SELECT execution.status AS execution_status, execution.provider_transaction_id,
                execution.provider_response_code, request.payment_status,
                execution.terms_accepted_at IS NOT NULL AS terms_accepted,
                execution.terms_version, request.ready_for_payment_processing,
                invoice.payment_status AS invoice_status
         FROM easy_pay_direct_payment_executions execution
         JOIN payment_requests request ON request.id = execution.payment_request_id
         JOIN invoices_payment_requests link ON link.payment_request_id = request.id
         JOIN invoices invoice ON invoice.id = link.invoice_id
         WHERE execution.payment_request_id = ?`,
      )
        .bind(paymentRequestId)
        .first(),
    ).resolves.toEqual({
      execution_status: "succeeded",
      provider_transaction_id: "epd-gateway-test-1",
      provider_response_code: "100",
      terms_accepted: 1,
      terms_version: "apps-serp-terms-and-privacy-2026-08-25",
      payment_status: "succeeded",
      ready_for_payment_processing: 0,
      invoice_status: "succeeded",
    });
    await expect(
      env.BILLING_DB.prepare(
        `SELECT profile.gateway_customer_vault_id, profile.initial_transaction_id,
                profile.status, subscription.payment_method_type,
                subscription.payment_method_id = profile.id AS profile_bound
         FROM subscriptions subscription
         JOIN provider_customer_profiles profile
           ON profile.organization_id = subscription.organization_id
          AND profile.id = subscription.payment_method_id
         WHERE subscription.id = ? AND subscription.organization_id = ?`,
      )
        .bind(recurringSubscriptionId, organizationId)
        .first(),
    ).resolves.toEqual({
      gateway_customer_vault_id: "87426631",
      initial_transaction_id: "epd-gateway-test-1",
      status: "active",
      payment_method_type: "provider",
      profile_bound: 1,
    });
    // A paid checkout alone cannot authorize renewal of every generic-plan product.
    expect(
      await enrollProductScopedAutomaticCollections(env.BILLING_DB, {
        organizationId,
        accountCode: "epd-synthetic",
      }),
    ).toBe(0);
    await env.BILLING_DB.batch([
      env.BILLING_DB.prepare(`INSERT INTO subscription_checkout_products
        (subscription_id, organization_id, product_slug, created_at) VALUES (?, ?, 'sprout-video-downloader', ?)`).bind(
        recurringSubscriptionId,
        organizationId,
        now,
      ),
      env.BILLING_DB.prepare(`INSERT INTO subscription_invoice_contexts
        (invoice_id, organization_id, subscription_id, context_type, period_start, period_end, created_at)
        VALUES (?, ?, ?, 'initial', ?, '2026-10-01T00:00:00.000Z', ?)`).bind(
        invoiceId,
        organizationId,
        recurringSubscriptionId,
        now,
        now,
      ),
    ]);
    expect(
      await enrollProductScopedAutomaticCollections(env.BILLING_DB, {
        organizationId,
        accountCode: "epd-synthetic",
      }),
    ).toBe(0);
    await env.BILLING_DB.prepare(`INSERT INTO easy_pay_direct_product_collection_policies
      (organization_id, product_slug, status, created_at) VALUES (?, 'sprout-video-downloader', 'enabled', ?)`)
      .bind(organizationId, now)
      .run();
    expect(
      await enrollProductScopedAutomaticCollections(env.BILLING_DB, {
        organizationId,
        accountCode: "epd-synthetic",
      }),
    ).toBe(1);
    expect(
      await enrollProductScopedAutomaticCollections(env.BILLING_DB, {
        organizationId,
        accountCode: "epd-synthetic",
      }),
    ).toBe(0);

    const renewalInvoice = `renewal-${invoiceId}`;
    await env.BILLING_DB.prepare(`INSERT INTO invoices
      (id, organization_id, customer_id, subscription_id, number, status, payment_status, currency,
       subtotal_minor, tax_minor, credits_minor, total_due_minor, version, finalized_at,
       payment_overdue, ready_for_payment_processing, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, 'finalized', 'pending', 'USD', 1999, 0, 1000, 999, 1, ?, 1, 1, ?, ?)`)
      .bind(
        renewalInvoice,
        organizationId,
        customerId,
        recurringSubscriptionId,
        renewalInvoice,
        now,
        now,
        now,
      )
      .run();
    const renewalEnv = new Proxy(runtimeEnv, {
      get(target, property, receiver) {
        if (property === "EASY_PAY_DIRECT_AUTOMATIC_COLLECTION_ENABLED") return "1";
        if (property === "EASY_PAY_DIRECT_AUTOMATIC_COLLECTION_SCOPE_MODE") return "product_scoped";
        return Reflect.get(target, property, receiver) as unknown;
      },
    }) as Env;
    await expect(
      prepareEasyPayDirectAutomaticCollection(renewalEnv, renewalInvoice, "canary-renewal"),
    ).resolves.toBe("processed");
    const automatic = await env.BILLING_DB.prepare(`SELECT execution.payment_request_id
      FROM easy_pay_direct_automatic_payment_executions execution JOIN invoices_payment_requests link
      ON link.payment_request_id = execution.payment_request_id WHERE link.invoice_id = ?`)
      .bind(renewalInvoice)
      .first<{ payment_request_id: string }>();
    expect(automatic).not.toBeNull();
    const renewalFetch = vi.fn<typeof fetch>(async (_input, init) => {
      if (String(_input).includes("/api/query.php")) {
        return gatewaySaleProof(
          "canary-renewal",
          "87426631",
          "9.99",
          automatic!.payment_request_id,
        );
      }
      const body = new URLSearchParams(String(init?.body));
      expect(body.get("customer_vault_id")).toBe("87426631");
      expect(body.get("initial_transaction_id")).toBe("epd-gateway-test-1");
      expect(body.get("amount")).toBe("9.99");
      expect(body.get("initiated_by")).toBe("merchant");
      expect(body.get("test_mode")).toBe("enabled");
      expect(body.has("payment_token")).toBe(false);
      return new Response(
        `response=1&responsetext=Approved&response_code=100&transactionid=canary-renewal&orderid=${automatic!.payment_request_id}`,
      );
    });
    // Both product pause and subscription pause are checked immediately before charge.
    await env.BILLING_DB.prepare(
      "UPDATE easy_pay_direct_product_collection_policies SET status = 'disabled' WHERE organization_id = ?",
    )
      .bind(organizationId)
      .run();
    await expect(
      processEasyPayDirectAutomaticCollection(
        renewalEnv,
        automatic!.payment_request_id,
        renewalFetch,
      ),
    ).resolves.toBe("deferred");
    expect(renewalFetch).not.toHaveBeenCalled();
    await env.BILLING_DB.prepare(
      "UPDATE easy_pay_direct_product_collection_policies SET status = 'enabled' WHERE organization_id = ?",
    )
      .bind(organizationId)
      .run();
    await env.BILLING_DB.prepare(
      "UPDATE easy_pay_direct_automatic_collection_scopes SET status = 'disabled' WHERE subscription_id = ?",
    )
      .bind(recurringSubscriptionId)
      .run();
    expect(
      await enrollProductScopedAutomaticCollections(env.BILLING_DB, {
        organizationId,
        accountCode: "epd-synthetic",
      }),
    ).toBe(0);
    await expect(
      processEasyPayDirectAutomaticCollection(
        renewalEnv,
        automatic!.payment_request_id,
        renewalFetch,
      ),
    ).resolves.toBe("deferred");
    expect(renewalFetch).not.toHaveBeenCalled();
    await env.BILLING_DB.prepare(
      "UPDATE easy_pay_direct_automatic_collection_scopes SET status = 'enabled' WHERE subscription_id = ?",
    )
      .bind(recurringSubscriptionId)
      .run();
    await expect(
      processEasyPayDirectAutomaticCollection(
        renewalEnv,
        automatic!.payment_request_id,
        renewalFetch,
      ),
    ).resolves.toBe("processed");
    await expect(
      processEasyPayDirectAutomaticCollection(
        renewalEnv,
        automatic!.payment_request_id,
        renewalFetch,
      ),
    ).resolves.toBe("processed");
    expect(
      renewalFetch.mock.calls.filter(([input]) => String(input).includes("/api/transact.php")),
    ).toHaveLength(1);
    await expect(
      env.BILLING_DB.prepare(
        `SELECT provider, signature_valid, processed_at IS NOT NULL AS processed
         FROM webhook_receipts
         WHERE provider = 'easy_pay_direct_gateway_test' AND provider_event_id LIKE 'gateway-test:%'`,
      ).first(),
    ).resolves.toEqual({
      provider: "easy_pay_direct_gateway_test",
      signature_valid: 0,
      processed: 1,
    });
  });

  it("runs a production checkout coherently through Gateway without Commerce or test mode", async () => {
    await monthlyFixture();
    const originalCustomerVersion = await env.BILLING_DB.prepare(
      "SELECT version FROM customers WHERE id = ?",
    )
      .bind(customerId)
      .first<{ version: number }>();
    await env.BILLING_DB.prepare("UPDATE customers SET currency = NULL WHERE id = ?")
      .bind(customerId)
      .run();
    const legacyEnv = enabledEnv("production");
    const runtimeEnv = new Proxy(legacyEnv, {
      get(target, property, receiver) {
        if (property === "EASY_PAY_DIRECT_CHECKOUT_BACKEND") return "gateway_direct";
        return Reflect.get(target, property, receiver) as unknown;
      },
    }) as Env;
    await runCheckoutWorkflow(runtimeEnv, checkoutParams(), immediateStep());
    const intent = await env.BILLING_DB.prepare(
      "SELECT payment_url FROM payment_request_checkout_intents WHERE payment_request_id = ?",
    )
      .bind(paymentRequestId)
      .first<{ payment_url: string }>();
    const checkoutToken = new URL(intent!.payment_url).searchParams.get("checkout")!;
    const providerFetch = vi.fn<typeof fetch>(async (input, init) => {
      const url = String(input);
      expect(url).not.toContain("api.epd.com");
      if (url.endsWith("/api/query.php")) return gatewaySaleProof("epd-gateway-live-1", "87426632");
      expect(url).toBe("https://secure.easypaydirectgateway.com/api/transact.php");
      const providerBody = new URLSearchParams(String(init?.body));
      expect(providerBody.get("payment_token")).toBe("hosted-token-live-1");
      expect(providerBody.get("test_mode")).toBeNull();
      expect(providerBody.get("customer_vault")).toBe("add_customer");
      expect(providerBody.get("initiated_by")).toBe("customer");
      expect(providerBody.get("stored_credential_indicator")).toBe("stored");
      expect(providerBody.get("billing_method")).toBe("initial_recurring");
      return new Response(
        "response=1&responsetext=Approved&response_code=100&transactionid=epd-gateway-live-1&authcode=LIVE&customer_vault_id=87426632",
      );
    });
    const response = await handleEasyPayDirectCheckoutSubmission(
      new Request("https://lago.test/easy_pay_direct/payment_form", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          checkout: checkoutToken,
          payment_token: "hosted-token-live-1",
          phone: "+15555550123",
          terms_accepted: true,
        }),
      }),
      runtimeEnv,
      "request-epd-gateway-live-1",
      providerFetch,
    );
    await expect(response.json()).resolves.toMatchObject({
      status: "succeeded",
      provider_order_id: "epd-gateway-live-1",
    });
    expect(providerFetch).toHaveBeenCalledTimes(2);
    await expect(
      env.BILLING_DB.prepare(
        `SELECT status, charge_transport, payment_backend, provider_transaction_id,
                customer_vault_id, provider_customer_id, provider_payment_method_id,
                provider_product_id
         FROM easy_pay_direct_payment_executions WHERE payment_request_id = ?`,
      )
        .bind(paymentRequestId)
        .first(),
    ).resolves.toEqual({
      status: "succeeded",
      charge_transport: "gateway",
      payment_backend: "gateway_vault",
      provider_transaction_id: "epd-gateway-live-1",
      customer_vault_id: "87426632",
      provider_customer_id: null,
      provider_payment_method_id: null,
      provider_product_id: null,
    });
    await expect(
      env.BILLING_DB.prepare("SELECT currency, version FROM customers WHERE id = ?")
        .bind(customerId)
        .first(),
    ).resolves.toEqual({ currency: "USD", version: originalCustomerVersion!.version + 1 });
    const staleUpdate = await env.BILLING_DB.prepare(
      "UPDATE customers SET currency = 'EUR', version = version + 1 WHERE id = ? AND version = ?",
    )
      .bind(customerId, originalCustomerVersion!.version)
      .run();
    expect(staleUpdate.meta.changes).toBe(0);
    await expect(
      env.BILLING_DB.prepare(
        `SELECT provider, provider_event_id FROM webhook_receipts
         WHERE provider = 'easy_pay_direct_gateway_live'`,
      ).first(),
    ).resolves.toEqual({
      provider: "easy_pay_direct_gateway_live",
      provider_event_id: "gateway-live:epd-gateway-live-1:succeeded",
    });
  });

  it("holds a null-currency customer with conflicting historical currencies before provider submission", async () => {
    await monthlyFixture();
    const now = new Date().toISOString();
    await env.BILLING_DB.batch([
      env.BILLING_DB.prepare("UPDATE customers SET currency = NULL WHERE id = ?").bind(customerId),
      env.BILLING_DB.prepare(
        `INSERT INTO invoices
         (id, organization_id, customer_id, status, payment_status, currency,
          subtotal_minor, tax_minor, credits_minor, total_due_minor, version,
          payment_overdue, ready_for_payment_processing, created_at, updated_at)
         VALUES (?, ?, ?, 'finalized', 'succeeded', 'EUR', 100, 0, 0, 100, 1, 0, 0, ?, ?)`,
      ).bind(`conflicting-currency-${invoiceId}`, organizationId, customerId, now, now),
    ]);
    const baseEnv = enabledEnv("production");
    const runtimeEnv = new Proxy(baseEnv, {
      get(target, property, receiver) {
        if (property === "EASY_PAY_DIRECT_CHECKOUT_BACKEND") return "gateway_direct";
        return Reflect.get(target, property, receiver) as unknown;
      },
    }) as Env;
    await runCheckoutWorkflow(runtimeEnv, checkoutParams(), immediateStep());
    const intent = await env.BILLING_DB.prepare(
      "SELECT payment_url FROM payment_request_checkout_intents WHERE payment_request_id = ?",
    )
      .bind(paymentRequestId)
      .first<{ payment_url: string }>();
    const providerFetch = vi.fn<typeof fetch>();
    await expect(
      handleEasyPayDirectCheckoutSubmission(
        new Request("https://lago.test/easy_pay_direct/payment_form", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            checkout: new URL(intent!.payment_url).searchParams.get("checkout"),
            payment_token: "hosted-token-conflicting-currency",
            phone: "+15555550123",
            terms_accepted: true,
          }),
        }),
        runtimeEnv,
        "request-conflicting-customer-currency",
        providerFetch,
      ),
    ).rejects.toMatchObject({ code: "easy_pay_direct_checkout_currency_mismatch" });
    expect(providerFetch).not.toHaveBeenCalled();
    await expect(
      env.BILLING_DB.prepare("SELECT currency FROM customers WHERE id = ?")
        .bind(customerId)
        .first(),
    ).resolves.toEqual({ currency: null });
    await expect(
      env.BILLING_DB.prepare(
        "SELECT COUNT(*) AS count FROM easy_pay_direct_payment_executions WHERE payment_request_id = ?",
      )
        .bind(paymentRequestId)
        .first(),
    ).resolves.toEqual({ count: 0 });
  });

  it("rechecks customer currency atomically when it changes after adoption", async () => {
    await monthlyFixture();
    await env.BILLING_DB.prepare("UPDATE customers SET currency = NULL WHERE id = ?")
      .bind(customerId)
      .run();
    const baseEnv = enabledEnv("production");
    const originalDb = env.BILLING_DB;
    let interleaved = false;
    const wrapStatement = (statement: D1PreparedStatement): D1PreparedStatement =>
      new Proxy(statement, {
        get(target, property, receiver) {
          if (property === "bind") {
            return (...values: unknown[]) => wrapStatement(target.bind(...values));
          }
          if (property === "run") {
            return async () => {
              const result = await target.run();
              if (!interleaved) {
                interleaved = true;
                await originalDb
                  .prepare(
                    "UPDATE customers SET currency = 'EUR', version = version + 1 WHERE id = ?",
                  )
                  .bind(customerId)
                  .run();
              }
              return result;
            };
          }
          const value = Reflect.get(target, property, receiver) as unknown;
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
    const raceDb = new Proxy(originalDb, {
      get(target, property, receiver) {
        if (property === "prepare") {
          return (query: string) => {
            const statement = target.prepare(query);
            return query.includes("UPDATE customers SET currency = COALESCE")
              ? wrapStatement(statement)
              : statement;
          };
        }
        const value = Reflect.get(target, property, receiver) as unknown;
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as D1Database;
    const runtimeEnv = new Proxy(baseEnv, {
      get(target, property, receiver) {
        if (property === "EASY_PAY_DIRECT_CHECKOUT_BACKEND") return "gateway_direct";
        if (property === "BILLING_DB") return raceDb;
        return Reflect.get(target, property, receiver) as unknown;
      },
    }) as Env;
    await runCheckoutWorkflow(runtimeEnv, checkoutParams(), immediateStep());
    const intent = await originalDb
      .prepare(
        "SELECT payment_url FROM payment_request_checkout_intents WHERE payment_request_id = ?",
      )
      .bind(paymentRequestId)
      .first<{ payment_url: string }>();
    const providerFetch = vi.fn<typeof fetch>();
    await expect(
      handleEasyPayDirectCheckoutSubmission(
        new Request("https://lago.test/easy_pay_direct/payment_form", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            checkout: new URL(intent!.payment_url).searchParams.get("checkout"),
            payment_token: "hosted-token-currency-race",
            phone: "+15555550123",
            terms_accepted: true,
          }),
        }),
        runtimeEnv,
        "request-customer-currency-race",
        providerFetch,
      ),
    ).rejects.toMatchObject({ code: "easy_pay_direct_processing" });
    expect(interleaved).toBe(true);
    expect(providerFetch).not.toHaveBeenCalled();
  });

  it("fails closed before any provider call when production uses the legacy hybrid backend", async () => {
    const baseEnv = enabledEnv("production");
    const runtimeEnv = new Proxy(baseEnv, {
      get(target, property, receiver) {
        if (property === "APP_ENV") return "production";
        if (property === "EASY_PAY_DIRECT_LEGACY_BRIDGE_ALLOWED") return "0";
        return Reflect.get(target, property, receiver) as unknown;
      },
    }) as Env;
    await runCheckoutWorkflow(runtimeEnv, checkoutParams(), immediateStep());
    const intent = await env.BILLING_DB.prepare(
      "SELECT payment_url FROM payment_request_checkout_intents WHERE payment_request_id = ?",
    )
      .bind(paymentRequestId)
      .first<{ payment_url: string }>();
    const providerFetch = vi.fn<typeof fetch>();
    await expect(
      handleEasyPayDirectCheckoutSubmission(
        new Request("https://lago.test/easy_pay_direct/payment_form", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            checkout: new URL(intent!.payment_url).searchParams.get("checkout"),
            payment_token: "hosted-token-legacy",
            phone: "+15555550123",
            terms_accepted: true,
          }),
        }),
        runtimeEnv,
        "request-legacy-hybrid",
        providerFetch,
      ),
    ).rejects.toMatchObject({ code: "easy_pay_direct_checkout_backend_unsafe" });
    expect(providerFetch).not.toHaveBeenCalled();
  });

  it.each(["", "gateway_direct_typo"])(
    "fails closed before any provider call for unsupported backend %j",
    async (backend) => {
      await monthlyFixture();
      const baseEnv = enabledEnv("production");
      await runCheckoutWorkflow(baseEnv, checkoutParams(), immediateStep());
      const intent = await env.BILLING_DB.prepare(
        "SELECT payment_url FROM payment_request_checkout_intents WHERE payment_request_id = ?",
      )
        .bind(paymentRequestId)
        .first<{ payment_url: string }>();
      const runtimeEnv = new Proxy(baseEnv, {
        get(target, property, receiver) {
          if (property === "EASY_PAY_DIRECT_CHECKOUT_BACKEND") return backend;
          return Reflect.get(target, property, receiver) as unknown;
        },
      }) as Env;
      const providerFetch = vi.fn<typeof fetch>();
      await expect(
        handleEasyPayDirectCheckoutSubmission(
          new Request("https://lago.test/easy_pay_direct/payment_form", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              checkout: new URL(intent!.payment_url).searchParams.get("checkout"),
              payment_token: "hosted-token-unsupported-backend",
              phone: "+15555550123",
              terms_accepted: true,
            }),
          }),
          runtimeEnv,
          "request-unsupported-backend",
          providerFetch,
        ),
      ).rejects.toMatchObject({ code: "easy_pay_direct_checkout_backend_unsafe" });
      expect(providerFetch).not.toHaveBeenCalled();
    },
  );

  it("never stores or schedules a payment method for a production one-time Gateway purchase", async () => {
    const subscriptionId = await monthlyFixture("one_time");
    const baseEnv = enabledEnv("production");
    const runtimeEnv = new Proxy(baseEnv, {
      get(target, property, receiver) {
        if (property === "EASY_PAY_DIRECT_CHECKOUT_BACKEND") return "gateway_direct";
        return Reflect.get(target, property, receiver) as unknown;
      },
    }) as Env;
    await runCheckoutWorkflow(runtimeEnv, checkoutParams(), immediateStep());
    const intent = await env.BILLING_DB.prepare(
      "SELECT payment_url FROM payment_request_checkout_intents WHERE payment_request_id = ?",
    )
      .bind(paymentRequestId)
      .first<{ payment_url: string }>();
    const providerFetch = vi.fn<typeof fetch>(async (input, init) => {
      if (String(input).endsWith("/api/query.php"))
        return gatewaySaleProof("epd-gateway-live-one-time", "unexpected-vault");
      const providerBody = new URLSearchParams(String(init?.body));
      for (const field of [
        "customer_vault",
        "initiated_by",
        "stored_credential_indicator",
        "billing_method",
        "test_mode",
      ])
        expect(providerBody.get(field)).toBeNull();
      return new Response(
        "response=1&responsetext=Approved&response_code=100&transactionid=epd-gateway-live-one-time&customer_vault_id=unexpected-vault",
      );
    });
    const response = await handleEasyPayDirectCheckoutSubmission(
      new Request("https://lago.test/easy_pay_direct/payment_form", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          checkout: new URL(intent!.payment_url).searchParams.get("checkout"),
          payment_token: "hosted-token-live-one-time",
          phone: "+15555550123",
          terms_accepted: true,
        }),
      }),
      runtimeEnv,
      "request-epd-gateway-live-one-time",
      providerFetch,
    );
    await expect(response.json()).resolves.toMatchObject({ status: "succeeded" });
    await expect(
      env.BILLING_DB.prepare(
        "SELECT payment_method_id, payment_method_type FROM subscriptions WHERE id = ?",
      )
        .bind(subscriptionId)
        .first(),
    ).resolves.toEqual({ payment_method_id: null, payment_method_type: null });
    await expect(
      env.BILLING_DB.prepare(
        "SELECT COUNT(*) AS count FROM provider_customer_profiles WHERE customer_id = ? AND checkout_intent_id IS NOT NULL",
      )
        .bind(customerId)
        .first(),
    ).resolves.toEqual({ count: 0 });
    await expect(
      env.BILLING_DB.prepare(
        "SELECT customer_vault_id FROM easy_pay_direct_payment_executions WHERE payment_request_id = ?",
      )
        .bind(paymentRequestId)
        .first(),
    ).resolves.toEqual({ customer_vault_id: null });
  });

  it("binds an anonymous Store checkout to the submitted email before charging", async () => {
    const runtimeEnv = enabledEnv("gateway_test");
    await env.BILLING_DB.prepare(
      "UPDATE customers SET email = NULL WHERE id = ? AND organization_id = ?",
    )
      .bind(customerId, organizationId)
      .run();
    await env.BILLING_DB.prepare("UPDATE payment_requests SET email = NULL WHERE id = ?")
      .bind(paymentRequestId)
      .run();
    await runCheckoutWorkflow(runtimeEnv, checkoutParams(), immediateStep());
    const checkout = await env.BILLING_DB.prepare(
      `SELECT payment_url FROM payment_request_checkout_intents
       WHERE payment_request_id = ? AND provider = 'easy_pay_direct'`,
    )
      .bind(paymentRequestId)
      .first<{ payment_url: string }>();
    const checkoutForm = await easyPayDirectPaymentForm(new URL(checkout!.payment_url), runtimeEnv);
    expect(await checkoutForm.text()).toContain('placeholder="you@example.com"');
    const checkoutToken = new URL(checkout!.payment_url).searchParams.get("checkout")!;
    const providerFetch = vi.fn<typeof fetch>(async (_input, init) => {
      if (String(_input).includes("/api/query.php"))
        return gatewaySaleProof("epd-guest-test-1", "vault-guest-test-1");
      const body = new URLSearchParams(String(init?.body));
      expect(body.get("email")).toBe("guest@example.test");
      return new Response(
        "response=1&responsetext=Approved&response_code=100&transactionid=epd-guest-test-1&authcode=TEST&customer_vault_id=vault-guest-test-1",
      );
    });
    const response = await handleEasyPayDirectCheckoutSubmission(
      new Request("https://lago.test/easy_pay_direct/payment_form", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          checkout: checkoutToken,
          payment_token: "hosted-token-guest-1",
          phone: "+15555550125",
          email: "Guest@Example.Test",
          terms_accepted: true,
        }),
      }),
      runtimeEnv,
      "request-epd-guest-test",
      providerFetch,
    );
    await expect(response.json()).resolves.toMatchObject({ status: "succeeded" });
    await expect(
      env.BILLING_DB.prepare(
        `SELECT customer.email, execution.email_sha256 IS NOT NULL AS email_bound
         FROM easy_pay_direct_payment_executions execution
         JOIN payment_request_checkout_intents intent
           ON intent.id = execution.checkout_intent_id
         JOIN customers customer
           ON customer.id = intent.customer_id AND customer.organization_id = intent.organization_id
         WHERE execution.payment_request_id = ?`,
      )
        .bind(paymentRequestId)
        .first(),
    ).resolves.toEqual({ email: "guest@example.test", email_bound: 1 });
  });

  it("records a definitive live gateway vault rejection as failed with no transaction", async () => {
    const runtimeEnv = enabledEnv("production");
    await runCheckoutWorkflow(runtimeEnv, checkoutParams(), immediateStep());
    const checkout = await env.BILLING_DB.prepare(
      `SELECT payment_url FROM payment_request_checkout_intents
       WHERE payment_request_id = ? AND provider = 'easy_pay_direct'`,
    )
      .bind(paymentRequestId)
      .first<{ payment_url: string }>();
    const checkoutToken = new URL(checkout!.payment_url).searchParams.get("checkout")!;
    const providerFetch = vi.fn<typeof fetch>(async (input) =>
      String(input).includes("/customers?")
        ? Response.json({ data: [] })
        : new Response(
            "response=3&responsetext=Service+Unavailable&response_code=300&transactionid=0&refid=ref-123",
          ),
    );

    await expect(
      handleEasyPayDirectCheckoutSubmission(
        new Request("https://lago.test/easy_pay_direct/payment_form", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            checkout: checkoutToken,
            payment_token: "hosted-token-live-rejected",
            phone: "+15555550123",
            terms_accepted: true,
          }),
        }),
        runtimeEnv,
        "request-epd-live-rejected",
        providerFetch,
      ),
    ).rejects.toMatchObject({ status: 422, code: "300" });
    expect(providerFetch).toHaveBeenCalledTimes(2);
    await expect(
      env.BILLING_DB.prepare(
        `SELECT status, provider_transaction_id, provider_response_code, failure_code,
                failure_message
         FROM easy_pay_direct_payment_executions WHERE payment_request_id = ?`,
      )
        .bind(paymentRequestId)
        .first(),
    ).resolves.toEqual({
      status: "failed",
      provider_transaction_id: null,
      provider_response_code: "300",
      failure_code: "300",
      failure_message: "Service Unavailable",
    });
  });

  it("uses the newly submitted card instead of a returning customer's saved method", async () => {
    const runtimeEnv = enabledEnv("production");
    const now = new Date().toISOString();
    await env.BILLING_DB.prepare(
      `INSERT INTO provider_customer_profiles
       (id, organization_id, customer_id, provider, provider_account_code,
        provider_customer_id, provider_payment_method_id, gateway_customer_vault_id,
        gateway_billing_id, status, created_at, updated_at)
       VALUES (?, ?, ?, 'easy_pay_direct', 'epd-synthetic', 'returning-customer',
               'old-card-method', 'returning-vault', '111111', 'active', ?, ?)`,
    )
      .bind(`profile-${paymentRequestId}`, organizationId, customerId, now, now)
      .run();
    await runCheckoutWorkflow(runtimeEnv, checkoutParams(), immediateStep());
    const checkout = await env.BILLING_DB.prepare(
      `SELECT payment_url FROM payment_request_checkout_intents WHERE payment_request_id = ?`,
    )
      .bind(paymentRequestId)
      .first<{ payment_url: string }>();
    const providerFetch = vi.fn<typeof fetch>(async (input, init) => {
      const url = String(input);
      if (url.endsWith("/customers/returning-customer"))
        return Response.json({
          id: "returning-customer",
          email: "synthetic@example.com",
          epd_gateway_customer_vault_id: "returning-vault",
        });
      if (url.includes("/api/transact.php")) {
        const body = new URLSearchParams(String(init?.body));
        expect(body.get("payment_token")).toBe("new-card-token");
        expect(body.get("customer_vault_id")).toBe("returning-vault");
        expect(body.get("customer_vault")).toBe("add_billing");
        return new Response(
          `response=1&customer_vault_id=returning-vault&billing_id=${body.get("billing_id")}`,
        );
      }
      if (url.endsWith("/payment_methods")) {
        const body = JSON.parse(String(init?.body));
        expect(body.billing_id).not.toBe("111111");
        return Response.json({ id: "new-card-method" }, { status: 201 });
      }
      if (url.endsWith("/products"))
        return Response.json({
          id: "new-card-product",
          pricing: { amount: 1999, currency: "usd" },
        });
      if (url.endsWith("/orders")) {
        expect(JSON.parse(String(init?.body)).payment_method_id).toBe("new-card-method");
        return Response.json({
          id: "new-card-order",
          status: "pending",
          total: 1999,
          currency: "usd",
        });
      }
      throw new Error(`Unexpected EPD request: ${url}`);
    });
    const response = await handleEasyPayDirectCheckoutSubmission(
      new Request("https://lago.test/easy_pay_direct/payment_form", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          checkout: new URL(checkout!.payment_url).searchParams.get("checkout"),
          payment_token: "new-card-token",
          phone: "+15555550126",
          terms_accepted: true,
        }),
      }),
      runtimeEnv,
      "returning-card-regression",
      providerFetch,
    );
    expect(response.status).toBeLessThan(300);
    const profiles = await env.BILLING_DB.prepare(
      "SELECT provider_payment_method_id, checkout_intent_id FROM provider_customer_profiles WHERE customer_id = ?",
    )
      .bind(customerId)
      .all<{ provider_payment_method_id: string; checkout_intent_id: string | null }>();
    expect(profiles.results).toHaveLength(2);
    expect(
      profiles.results.find((profile) => profile.checkout_intent_id === null)
        ?.provider_payment_method_id,
    ).toBe("old-card-method");
    expect(
      profiles.results.find((profile) => profile.checkout_intent_id !== null)
        ?.provider_payment_method_id,
    ).toBe("new-card-method");
    const execution = await env.BILLING_DB.prepare(
      "SELECT id FROM easy_pay_direct_payment_executions WHERE payment_request_id = ?",
    )
      .bind(paymentRequestId)
      .first<{ id: string }>();
    await reconcileEasyPayDirectExecution(
      runtimeEnv,
      execution!.id,
      vi.fn<typeof fetch>(async () =>
        Response.json({
          id: "new-card-order",
          status: "succeeded",
          total: 1999,
          currency: "usd",
          transactions: [
            {
              id: "new-card-transaction",
              processor_transaction_id: "new-card-processor",
              status: "succeeded",
              type: "sale",
            },
          ],
        }),
      ),
    );
    const approvedProfiles = await env.BILLING_DB.prepare(
      "SELECT checkout_intent_id, initial_transaction_id FROM provider_customer_profiles WHERE customer_id = ?",
    )
      .bind(customerId)
      .all<{ checkout_intent_id: string | null; initial_transaction_id: string | null }>();
    expect(
      approvedProfiles.results.find((profile) => profile.checkout_intent_id !== null)
        ?.initial_transaction_id,
    ).toBe("new-card-processor");
    expect(
      approvedProfiles.results.find((profile) => profile.checkout_intent_id === null)
        ?.initial_transaction_id,
    ).toBeNull();
    expect(
      providerFetch.mock.calls.filter(([input]) => String(input).includes("/api/transact.php")),
    ).toHaveLength(1);
  });

  it("persists a live vault checkpoint and resumes Commerce without vaulting twice", async () => {
    const runtimeEnv = enabledEnv("production");
    await runCheckoutWorkflow(runtimeEnv, checkoutParams(), immediateStep());
    const checkout = await env.BILLING_DB.prepare(
      `SELECT payment_url FROM payment_request_checkout_intents
       WHERE payment_request_id = ? AND provider = 'easy_pay_direct'`,
    )
      .bind(paymentRequestId)
      .first<{ payment_url: string }>();
    const checkoutToken = new URL(checkout!.payment_url).searchParams.get("checkout")!;
    let commerceAvailable = false;
    const providerFetch = vi.fn<typeof fetch>(async (input) => {
      const url = String(input);
      if (url.includes("/api/transact.php")) {
        return new Response(
          "response=1&responsetext=Approved&response_code=100&customer_vault_id=vault-live-recovery&billing_id=12345678901234567890123456789012",
        );
      }
      if (url.includes("/customers?")) return Response.json({ data: [] });
      if (!commerceAvailable) {
        return Response.json(
          { error: { code: "commerce_unavailable", message: "Try again" } },
          { status: 503 },
        );
      }
      if (url.endsWith("/customers")) {
        return Response.json(
          { id: "epd-customer-recovered", default_payment_method: "epd-pm-recovered" },
          { status: 201 },
        );
      }
      if (url.endsWith("/customers/epd-customer-recovered"))
        return Response.json({
          id: "epd-customer-recovered",
          email: "synthetic@example.com",
          epd_gateway_customer_vault_id: "vault-live-recovery",
        });
      if (url.endsWith("/payment_methods")) return Response.json({ id: "epd-pm-recovered" });
      if (url.endsWith("/products")) {
        return Response.json(
          { id: "epd-product-recovered", pricing: { amount: 1999, currency: "usd" } },
          { status: 201 },
        );
      }
      if (url.endsWith("/orders")) {
        return Response.json(
          { id: "epd-order-recovered", status: "pending", total: 1999, currency: "usd" },
          { status: 201 },
        );
      }
      throw new Error(`Unexpected EPD request: ${url}`);
    });
    const submission = (paymentToken: string) =>
      new Request("https://lago.test/easy_pay_direct/payment_form", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          checkout: checkoutToken,
          payment_token: paymentToken,
          phone: "+15555550126",
          terms_accepted: true,
        }),
      });

    await expect(
      handleEasyPayDirectCheckoutSubmission(
        submission("one-time-token-before-outage"),
        runtimeEnv,
        "request-epd-recovery-1",
        providerFetch,
      ),
    ).rejects.toMatchObject({ status: 503, code: "commerce_unavailable" });
    await expect(
      env.BILLING_DB.prepare(
        `SELECT status, last_checkpoint, customer_vault_id, gateway_billing_id,
                provider_transaction_id, phone_ciphertext IS NOT NULL AS has_recovery_phone
         FROM easy_pay_direct_payment_executions WHERE payment_request_id = ?`,
      )
        .bind(paymentRequestId)
        .first(),
    ).resolves.toEqual({
      status: "unknown",
      last_checkpoint: "gateway_vaulted",
      customer_vault_id: "vault-live-recovery",
      gateway_billing_id: "12345678901234567890123456789012",
      provider_transaction_id: null,
      has_recovery_phone: 1,
    });

    commerceAvailable = true;
    const resumed = await handleEasyPayDirectCheckoutSubmission(
      submission("fresh-one-time-token-after-outage"),
      runtimeEnv,
      "request-epd-recovery-2",
      providerFetch,
    );
    await expect(resumed.json()).resolves.toMatchObject({
      status: "processing",
      provider_order_id: "epd-order-recovered",
    });
    expect(
      providerFetch.mock.calls.filter(([input]) => String(input).includes("/api/transact.php")),
    ).toHaveLength(1);
    await expect(
      env.BILLING_DB.prepare(
        `SELECT status, last_checkpoint, provider_customer_id, provider_payment_method_id,
                provider_product_id, provider_transaction_id, resume_count
         FROM easy_pay_direct_payment_executions WHERE payment_request_id = ?`,
      )
        .bind(paymentRequestId)
        .first(),
    ).resolves.toEqual({
      status: "processing",
      last_checkpoint: "provider_order",
      provider_customer_id: "epd-customer-recovered",
      provider_payment_method_id: "epd-pm-recovered",
      provider_product_id: "epd-product-recovered",
      provider_transaction_id: "epd-order-recovered",
      resume_count: 1,
    });
  });

  it("replaces a legacy alphanumeric billing checkpoint only after a fresh customer submission", async () => {
    const runtimeEnv = enabledEnv("production");
    await runCheckoutWorkflow(runtimeEnv, checkoutParams(), immediateStep());
    const checkout = await env.BILLING_DB.prepare(
      `SELECT payment_url FROM payment_request_checkout_intents
       WHERE payment_request_id = ? AND provider = 'easy_pay_direct'`,
    )
      .bind(paymentRequestId)
      .first<{ payment_url: string }>();
    const checkoutToken = new URL(checkout!.payment_url).searchParams.get("checkout")!;
    let gatewayCalls = 0;
    let paymentMethodCalls = 0;
    const providerFetch = vi.fn<typeof fetch>(async (input, init) => {
      const url = String(input);
      if (url.includes("/api/transact.php")) {
        gatewayCalls += 1;
        const body = new URLSearchParams(String(init?.body));
        if (gatewayCalls === 1) {
          expect(body.get("customer_vault")).toBe("add_customer");
          expect(body.get("payment_token")).toBe("token-before-commerce-rejection");
          return new Response(
            `response=1&responsetext=Approved&response_code=100&customer_vault_id=vault-legacy&billing_id=${body.get("billing_id")}`,
          );
        }
        expect(body.get("customer_vault")).toBe("add_billing");
        expect(body.get("customer_vault_id")).toBe("vault-legacy");
        expect(body.get("payment_token")).toBe("fresh-token-for-recovery");
        expect(body.get("billing_id")).toMatch(/^\d{32}$/u);
        return new Response(
          `response=1&responsetext=Approved&response_code=100&customer_vault_id=vault-legacy&billing_id=${body.get("billing_id")}`,
        );
      }
      if (url.includes("/customers?")) {
        return Response.json({ data: [] });
      }
      if (url.endsWith("/customers")) {
        if (gatewayCalls === 1) {
          return Response.json(
            { error: { code: "commerce_unavailable", message: "Try again" } },
            { status: 503 },
          );
        }
        return Response.json({ id: "epd-customer-legacy-recovery" }, { status: 201 });
      }
      if (url.endsWith("/customers/epd-customer-legacy-recovery"))
        return Response.json({
          id: "epd-customer-legacy-recovery",
          email: "synthetic@example.com",
          epd_gateway_customer_vault_id: "vault-legacy",
        });
      if (url.includes("/payment_methods")) {
        paymentMethodCalls += 1;
        const body = JSON.parse(String(init?.body)) as { billing_id?: string };
        expect(body.billing_id).toMatch(/^\d{32}$/u);
        return Response.json({ id: "epd-pm-legacy-recovery" }, { status: 201 });
      }
      if (url.endsWith("/products")) {
        return Response.json(
          { id: "epd-product-legacy-recovery", pricing: { amount: 1999, currency: "usd" } },
          { status: 201 },
        );
      }
      if (url.endsWith("/orders")) {
        return Response.json(
          { id: "epd-order-legacy-recovery", status: "pending", total: 1999, currency: "usd" },
          { status: 201 },
        );
      }
      throw new Error(`Unexpected EPD request: ${url}`);
    });
    const submission = (paymentToken: string) =>
      new Request("https://lago.test/easy_pay_direct/payment_form", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          checkout: checkoutToken,
          payment_token: paymentToken,
          phone: "+15555550127",
          terms_accepted: true,
        }),
      });

    await expect(
      handleEasyPayDirectCheckoutSubmission(
        submission("token-before-commerce-rejection"),
        runtimeEnv,
        "request-epd-legacy-billing-1",
        providerFetch,
      ),
    ).rejects.toMatchObject({ status: 503, code: "commerce_unavailable" });
    await env.BILLING_DB.prepare(
      `UPDATE easy_pay_direct_payment_executions
       SET gateway_billing_id = 'legacy-alphanumeric-id'
       WHERE payment_request_id = ?`,
    )
      .bind(paymentRequestId)
      .run();
    await expect(
      env.BILLING_DB.prepare(
        `SELECT status, last_checkpoint, customer_vault_id, gateway_billing_id,
                provider_customer_id, provider_payment_method_id
         FROM easy_pay_direct_payment_executions WHERE payment_request_id = ?`,
      )
        .bind(paymentRequestId)
        .first(),
    ).resolves.toEqual({
      status: "unknown",
      last_checkpoint: "gateway_vaulted",
      customer_vault_id: "vault-legacy",
      gateway_billing_id: "legacy-alphanumeric-id",
      provider_customer_id: null,
      provider_payment_method_id: null,
    });

    const execution = await env.BILLING_DB.prepare(
      `SELECT id, status, last_checkpoint, resume_count, failure_code, updated_at
       FROM easy_pay_direct_payment_executions WHERE payment_request_id = ?`,
    )
      .bind(paymentRequestId)
      .first<{ id: string }>();
    const callsBeforeRecovery = providerFetch.mock.calls.length;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      await expect(
        reconcileEasyPayDirectExecution(runtimeEnv, execution!.id, providerFetch),
      ).resolves.toBe("deferred");
    }
    expect(providerFetch).toHaveBeenCalledTimes(callsBeforeRecovery);
    await expect(
      env.BILLING_DB.prepare(
        `SELECT id, status, last_checkpoint, resume_count, failure_code, updated_at
         FROM easy_pay_direct_payment_executions WHERE payment_request_id = ?`,
      )
        .bind(paymentRequestId)
        .first(),
    ).resolves.toEqual(execution);

    const recovered = await handleEasyPayDirectCheckoutSubmission(
      submission("fresh-token-for-recovery"),
      runtimeEnv,
      "request-epd-legacy-billing-2",
      providerFetch,
    );
    await expect(recovered.json()).resolves.toMatchObject({
      status: "processing",
      provider_order_id: "epd-order-legacy-recovery",
    });
    expect(gatewayCalls).toBe(2);
    expect(paymentMethodCalls).toBe(1);
    await expect(
      env.BILLING_DB.prepare(
        `SELECT status, last_checkpoint, gateway_billing_id, provider_payment_method_id,
                provider_transaction_id, resume_count
         FROM easy_pay_direct_payment_executions WHERE payment_request_id = ?`,
      )
        .bind(paymentRequestId)
        .first(),
    ).resolves.toEqual({
      status: "processing",
      last_checkpoint: "provider_order",
      gateway_billing_id: expect.stringMatching(/^\d{32}$/u),
      provider_payment_method_id: "epd-pm-legacy-recovery",
      provider_transaction_id: "epd-order-legacy-recovery",
      resume_count: 1,
    });
  });

  it("reconciles a successful Commerce order before returning from checkout", async () => {
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
      "synthetic_qa",
    );
    await expect(first.json()).resolves.toMatchObject({
      status: "succeeded",
      provider: "easy_pay_direct",
      provider_order_id: "epd-order-1",
      replayed: false,
    });
    const replay = await handleEasyPayDirectCheckoutSubmission(
      request(),
      runtimeEnv,
      "request-epd-2",
      providerFetch,
      "synthetic_qa",
    );
    await expect(replay.json()).resolves.toMatchObject({ status: "succeeded", replayed: true });
    expect(providerFetch).toHaveBeenCalledTimes(4);
    await expect(
      env.BILLING_DB.prepare("SELECT payment_status FROM payment_requests WHERE id = ?")
        .bind(paymentRequestId)
        .first(),
    ).resolves.toEqual({ payment_status: "succeeded" });
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
    expect(orderRead).not.toHaveBeenCalled();
    await expect(
      env.BILLING_DB.prepare(
        `SELECT provider, signature_valid, processed_at IS NOT NULL AS processed
         FROM webhook_receipts WHERE provider = 'easy_pay_direct_inline_confirmation'`,
      ).first(),
    ).resolves.toEqual({
      provider: "easy_pay_direct_inline_confirmation",
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
      created: Math.floor(Date.now() / 1000),
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

  it("converges a provider-voided order to one failed payment outcome", async () => {
    const runtimeEnv = enabledEnv();
    await runCheckoutWorkflow(runtimeEnv, checkoutParams(), immediateStep());
    const checkout = await env.BILLING_DB.prepare(
      `SELECT payment_url FROM payment_request_checkout_intents
       WHERE payment_request_id = ? AND provider = 'easy_pay_direct'`,
    )
      .bind(paymentRequestId)
      .first<{ payment_url: string }>();
    const checkoutToken = new URL(checkout!.payment_url).searchParams.get("checkout")!;
    const providerFetch = vi.fn<typeof fetch>(async (input) => {
      const url = String(input);
      if (url.includes("/customers?")) return Response.json({ data: [] });
      if (url.endsWith("/customers")) {
        return Response.json(
          { id: "epd-customer-void", default_payment_method: "epd-pm-void" },
          { status: 201 },
        );
      }
      if (url.endsWith("/products")) {
        return Response.json(
          { id: "epd-product-void", pricing: { amount: 1999, currency: "usd" } },
          { status: 201 },
        );
      }
      return Response.json(
        { id: "epd-order-void", status: "pending", total: 1999, currency: "usd" },
        { status: 201 },
      );
    });
    const submitted = await handleEasyPayDirectCheckoutSubmission(
      new Request("https://lago.test/easy_pay_direct/payment_form", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          checkout: checkoutToken,
          payment_token: "card_visa",
          phone: "+15555550124",
        }),
      }),
      runtimeEnv,
      "request-epd-void",
      providerFetch,
      "synthetic_qa",
    );
    expect(submitted.status).toBe(200);
    const execution = await env.BILLING_DB.prepare(
      `SELECT id FROM easy_pay_direct_payment_executions WHERE payment_request_id = ?`,
    )
      .bind(paymentRequestId)
      .first<{ id: string }>();

    await expect(
      reconcileEasyPayDirectExecution(
        runtimeEnv,
        execution!.id,
        vi.fn<typeof fetch>(async () =>
          Response.json({
            id: "epd-order-void",
            status: "voided",
            total: 1999,
            currency: "usd",
          }),
        ),
      ),
    ).resolves.toBe("processed");
    await expect(
      env.BILLING_DB.prepare(
        `SELECT execution.status AS execution_status, request.payment_status,
                request.ready_for_payment_processing
         FROM easy_pay_direct_payment_executions execution
         JOIN payment_requests request ON request.id = execution.payment_request_id
         WHERE execution.id = ?`,
      )
        .bind(execution!.id)
        .first(),
    ).resolves.toEqual({
      execution_status: "failed",
      payment_status: "failed",
      ready_for_payment_processing: 1,
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

async function productionSubmission() {
  const runtimeEnv = enabledEnv("production");
  await runCheckoutWorkflow(runtimeEnv, checkoutParams(), immediateStep());
  const checkout = await env.BILLING_DB.prepare(
    "SELECT payment_url FROM payment_request_checkout_intents WHERE payment_request_id = ?",
  )
    .bind(paymentRequestId)
    .first<{ payment_url: string }>();
  return {
    runtimeEnv,
    request: (paymentToken = "fictional-hosted-token") =>
      new Request("https://lago.test/easy_pay_direct/payment_form", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          checkout: new URL(checkout!.payment_url).searchParams.get("checkout"),
          payment_token: paymentToken,
          phone: "+15555550123",
          first_name: "Fictional",
          last_name: "Customer",
          terms_accepted: true,
        }),
      }),
  };
}

function executionForTest() {
  return env.BILLING_DB.prepare(`SELECT id, status, failure_code, customer_vault_id, gateway_billing_id, provider_transaction_id
    FROM easy_pay_direct_payment_executions WHERE payment_request_id = ?`)
    .bind(paymentRequestId)
    .first<{ id: string; status: string; failure_code: string | null }>();
}

// Stateful contract fixture, NOT provider-backed acceptance. Billing IDs belong
// to one specific Gateway vault; a Commerce customer cannot see another vault.
function commerceVaultFixture(
  options: {
    existing?: boolean;
    exposeBinding?: boolean;
    rejectAttach?: boolean;
    ignoreRequestedBinding?: boolean;
    expectedToken?: string;
  } = {},
) {
  let exists = options.existing ?? true;
  let linkedVault = "fixture-existing-vault";
  const billings = new Map<string, Set<string>>();
  const operations: string[] = [];
  const savedVaults: string[] = [];
  const fetcher = vi.fn<typeof fetch>(async (input, init) => {
    const url = String(input);
    if (url.includes("/customers?")) {
      operations.push("lookup");
      return Response.json({
        data: exists ? [{ id: "fixture-customer", email: "synthetic@example.com" }] : [],
      });
    }
    if (url.endsWith("/customers/fixture-customer")) {
      operations.push("read_customer");
      expect(init?.method).toBe("GET");
      return Response.json({
        id: "fixture-customer",
        email: "synthetic@example.com",
        ...(options.exposeBinding === false ? {} : { epd_gateway_customer_vault_id: linkedVault }),
      });
    }
    if (url.includes("/api/transact.php")) {
      const body = new URLSearchParams(String(init?.body));
      operations.push(body.get("customer_vault")!);
      const vault = body.get("customer_vault_id") ?? "fixture-new-vault";
      const billing = body.get("billing_id")!;
      expect(body.get("payment_token")).toBe(options.expectedToken ?? "fictional-hosted-token");
      expect(body.has("type")).toBe(false); // Vault only, never charge.
      billings.set(vault, new Set([billing]));
      savedVaults.push(vault);
      return new Response(`response=1&customer_vault_id=${vault}&billing_id=${billing}`);
    }
    if (url.endsWith("/customers")) {
      operations.push("create_customer");
      expect(exists).toBe(false);
      exists = true;
      if (!options.ignoreRequestedBinding)
        linkedVault = JSON.parse(String(init?.body)).epd_gateway_customer_vault_id;
      return Response.json({
        id: "fixture-customer",
        default_payment_method: "not-the-submitted-card",
      });
    }
    if (url.endsWith("/payment_methods")) {
      operations.push("attach");
      expect(url.endsWith("/customers/fixture-customer/payment_methods")).toBe(true);
      const billing = JSON.parse(String(init?.body)).billing_id;
      if (!billings.get(linkedVault)?.has(billing) || options.rejectAttach)
        return Response.json(
          {
            error: {
              code: "validation_error",
              message: "Billing ID private-vault-reference not found",
            },
          },
          { status: 400 },
        );
      return Response.json({ id: "fixture-new-method", customer: "fixture-customer" });
    }
    if (url.endsWith("/products")) {
      operations.push("product");
      return Response.json({ id: "fixture-product", pricing: { amount: 1999, currency: "usd" } });
    }
    if (url.endsWith("/orders")) {
      operations.push("order");
      expect(JSON.parse(String(init?.body)).payment_method_id).toBe("fixture-new-method");
      return Response.json({
        id: `fixture-order-${paymentRequestId}`,
        status: "pending",
        total: 1999,
        currency: "usd",
      });
    }
    throw new Error(`Unexpected fixture endpoint: ${url}`);
  });
  return { fetcher, operations, savedVaults };
}

function enabledEnv(mode: "test" | "gateway_test" | "production" = "test"): Env {
  return new Proxy(env, {
    get(target, property, receiver) {
      if (property === "APP_ENV") return mode === "production" ? "production" : "development";
      if (property === "PAYMENT_MUTATIONS_ENABLED") return "1";
      if (property === "PUBLIC_BASE_URL") return "https://lago.test";
      if (property === "EASY_PAY_DIRECT_COMMERCE_API_KEY") {
        return mode === "production"
          ? "epd_synthetic_sk_live_secret"
          : "epd_synthetic_sk_test_secret";
      }
      if (property === "EASY_PAY_DIRECT_SECURITY_KEY") return "synthetic-security-key";
      if (property === "EASY_PAY_DIRECT_TOKENIZATION_KEY") return "synthetic-tokenization-key";
      if (property === "EASY_PAY_DIRECT_CHECKOUT_BACKEND")
        return mode === "production" ? "legacy_commerce_bridge" : "gateway_vault";
      if (property === "EASY_PAY_DIRECT_LEGACY_BRIDGE_ALLOWED")
        return mode === "production" ? "1" : "0";
      if (property === "EASY_PAY_DIRECT_CHECKOUT_SIGNING_SECRET")
        return "synthetic-checkout-signing-secret";
      if (property === "EASY_PAY_DIRECT_NETWORK_MODE") return mode;
      if (property === "EASY_PAY_DIRECT_LIVEMODE_ALLOWED") return mode === "production" ? "1" : "0";
      if (property === "EASY_PAY_DIRECT_ACCOUNT_CODE") return "epd-synthetic";
      if (property === "EASY_PAY_DIRECT_ORGANIZATION_ID") return organizationId;
      if (property === "EASY_PAY_DIRECT_SUCCESS_REDIRECT_URL")
        return "https://store.test/checkout/success";
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
