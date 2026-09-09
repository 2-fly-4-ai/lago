import { env } from "cloudflare:test";
import type { WorkflowStep } from "cloudflare:workers";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  handleEasyPayDirectCheckoutSubmission,
  reconcileEasyPayDirectGatewayTestExecution,
} from "../src/api/easy-pay-direct-checkout";
import {
  pendingEasyPayDirectExecutions,
  reconcileEasyPayDirectExecution,
} from "../src/reconciliation/easy-pay-direct";
import { runCheckoutWorkflow } from "../src/workflows/checkout";

// Actual local D1/migrations and lifecycle code; provider responses are fictional.
const organizationId = "org-gateway-timeout-fixture";
let paymentRequestId: string;
let runtime: Env;
let request: () => Request;
let executionId: string;
let charge: ReturnType<typeof vi.fn<typeof fetch>>;
beforeEach(async () => {
  const id = crypto.randomUUID();
  paymentRequestId = `gateway-timeout-request-${id}`;
  const customerId = `gateway-timeout-customer-${id}`;
  const invoiceId = `gateway-timeout-invoice-${id}`;
  const now = new Date().toISOString();
  await env.BILLING_DB.batch([
    env.BILLING_DB.prepare(
      `INSERT OR IGNORE INTO organizations (id,external_id,name,created_at,updated_at) VALUES (?,?,'Gateway fixture',?,?)`,
    ).bind(organizationId, organizationId, now, now),
    env.BILLING_DB.prepare(`INSERT INTO customers (id,organization_id,external_id,email,name,currency,metadata_json,payment_provider,payment_provider_code,created_at,updated_at)
      VALUES (?,?,?,'gateway@example.test','Fixture Customer','USD','{}','easy_pay_direct','epd-fixture',?,?)`).bind(
      customerId,
      organizationId,
      customerId,
      now,
      now,
    ),
    env.BILLING_DB.prepare(`INSERT INTO invoices (id,organization_id,customer_id,number,status,payment_status,currency,subtotal_minor,tax_minor,credits_minor,total_due_minor,version,finalized_at,payment_overdue,ready_for_payment_processing,created_at,updated_at)
      VALUES (?,?,?,?,'finalized','pending','USD',1999,0,0,1999,1,?,1,1,?,?)`).bind(
      invoiceId,
      organizationId,
      customerId,
      invoiceId,
      now,
      now,
      now,
    ),
    env.BILLING_DB.prepare(`INSERT INTO payment_requests (id,organization_id,customer_id,amount_minor,currency,email,payment_attempts,payment_status,ready_for_payment_processing,version,created_at,updated_at)
      VALUES (?,?,?,1999,'USD','gateway@example.test',0,'pending',1,1,?,?)`).bind(
      paymentRequestId,
      organizationId,
      customerId,
      now,
      now,
    ),
    env.BILLING_DB.prepare(`INSERT INTO invoices_payment_requests (id,organization_id,payment_request_id,invoice_id,invoice_version,created_at,updated_at)
      VALUES (?,?,?,?,1,?,?)`).bind(
      `link-${id}`,
      organizationId,
      paymentRequestId,
      invoiceId,
      now,
      now,
    ),
  ]);
  const values: Record<string, string> = {
    PAYMENT_MUTATIONS_ENABLED: "1",
    PROVIDER_READS_ENABLED: "1",
    PUBLIC_BASE_URL: "https://lago.test",
    EASY_PAY_DIRECT_COMMERCE_API_KEY: "epd_fixture_sk_test_secret",
    EASY_PAY_DIRECT_SECURITY_KEY: "fixture-security",
    EASY_PAY_DIRECT_TOKENIZATION_KEY: "fixture-tokenization",
    EASY_PAY_DIRECT_CHECKOUT_SIGNING_SECRET: "fixture-signing",
    EASY_PAY_DIRECT_NETWORK_MODE: "gateway_test",
    EASY_PAY_DIRECT_LIVEMODE_ALLOWED: "0",
    EASY_PAY_DIRECT_ACCOUNT_CODE: "epd-fixture",
    EASY_PAY_DIRECT_ORGANIZATION_ID: organizationId,
    EASY_PAY_DIRECT_SUCCESS_REDIRECT_URL: "https://store.test/checkout/success",
  };
  runtime = new Proxy(env, {
    get(target, key, receiver) {
      return typeof key === "string" && key in values
        ? values[key]
        : Reflect.get(target, key, receiver);
    },
  });
  const step = {
    async do(_name: string, ...args: unknown[]) {
      const callback = args.find((item) => typeof item === "function") as
        | (() => Promise<unknown>)
        | undefined;
      if (!callback) throw new Error("Missing fixture callback");
      return callback();
    },
  } as unknown as WorkflowStep;
  await runCheckoutWorkflow(
    runtime,
    {
      organizationId,
      paymentRequestId,
      paymentRequestVersion: 1,
      idempotencyKey: `checkout-${id}`,
      correlationId: `checkout-${id}`,
    },
    step,
  );
  const checkout = await env.BILLING_DB.prepare(
    "SELECT payment_url FROM payment_request_checkout_intents WHERE payment_request_id=?",
  )
    .bind(paymentRequestId)
    .first<{ payment_url: string }>();
  request = () =>
    new Request("https://lago.test/easy_pay_direct/payment_form", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        checkout: new URL(checkout!.payment_url).searchParams.get("checkout"),
        payment_token: "fixture-hosted-token",
        phone: "+15555550123",
        terms_accepted: true,
      }),
    });
  charge = vi.fn<typeof fetch>(async (url, init) => {
    expect(String(url)).toContain("/api/transact.php");
    expect(new URLSearchParams(String(init?.body)).get("type")).toBe("sale");
    expect(new URLSearchParams(String(init?.body)).get("orderid")).toBe(paymentRequestId);
    throw new Error("Fixture: provider accepted sale but response was lost");
  });
  await expect(
    handleEasyPayDirectCheckoutSubmission(request(), runtime, "gateway-timeout", charge),
  ).rejects.toThrow();
  const execution = await row();
  executionId = execution!.id;
  expect(execution).toMatchObject({
    status: "unknown",
    provider_transaction_id: null,
    customer_vault_id: null,
    gateway_billing_id: null,
  });
});
function row() {
  return env.BILLING_DB.prepare(`SELECT id,status,provider_transaction_id,customer_vault_id,gateway_billing_id,updated_at
    FROM easy_pay_direct_payment_executions WHERE payment_request_id=?`)
    .bind(paymentRequestId)
    .first<{
      id: string;
      status: string;
      provider_transaction_id: string | null;
      updated_at: string;
    }>();
}
function xml(
  options: {
    id?: string;
    order?: string;
    amount?: string;
    currency?: string;
    condition?: string;
    success?: string;
  } = {},
) {
  return `<transaction><transaction_id>${options.id ?? `fixture-transaction-${paymentRequestId}`}</transaction_id><order_id>${options.order ?? paymentRequestId}</order_id><condition>${options.condition ?? "complete"}</condition><currency>${options.currency ?? "USD"}</currency><customer_vault_id>fixture-vault</customer_vault_id><action><action_type>sale</action_type><success>${options.success ?? "1"}</success><amount>${options.amount ?? "19.99"}</amount></action></transaction>`;
}
function read(body = xml()) {
  return vi.fn<typeof fetch>(async (url, init) => {
    expect(String(url)).toContain("/api/query.php");
    const form = new URLSearchParams(String(init?.body));
    expect(form.get("order_id")).toBe(paymentRequestId);
    expect(form.has("type")).toBe(false);
    return new Response(`<nm_response>${body}</nm_response>`);
  });
}
describe("Gateway lost-response recovery without charge replay", () => {
  it("selects an uncertain no-checkpoint Gateway execution and finalizes its exact Query receipt once", async () => {
    expect(await pendingEasyPayDirectExecutions(env.BILLING_DB, "gateway_test")).toContain(
      executionId,
    );
    expect(await pendingEasyPayDirectExecutions(env.BILLING_DB, "production")).not.toContain(
      executionId,
    );
    const query = read();
    expect(await reconcileEasyPayDirectExecution(runtime, executionId, query)).toBe("processed");
    expect(await reconcileEasyPayDirectExecution(runtime, executionId, query)).toBe("processed");
    expect(query).toHaveBeenCalledTimes(1);
    expect(charge).toHaveBeenCalledTimes(1);
    expect(await row()).toMatchObject({
      status: "succeeded",
      provider_transaction_id: `fixture-transaction-${paymentRequestId}`,
    });
    expect(
      await env.BILLING_DB.prepare(
        "SELECT count(*) AS n FROM payment_request_payments WHERE payment_request_id=?",
      )
        .bind(paymentRequestId)
        .first(),
    ).toEqual({ n: 1 });
  });
  it.each([
    "empty",
    "unknown",
    "ambiguous",
    "wrong-order",
    "amount",
    "currency",
    "known-id",
    "read-error",
  ])("keeps %s evidence uncertain without another sale", async (fault) => {
    if (fault === "known-id")
      await env.BILLING_DB.prepare(
        "UPDATE easy_pay_direct_payment_executions SET provider_transaction_id='previous-id' WHERE id=?",
      )
        .bind(executionId)
        .run();
    const bodies: Record<string, string> = {
      empty: "",
      unknown: xml({ condition: "pending", success: "0" }),
      ambiguous: xml() + xml({ id: "second-transaction" }),
      "wrong-order": xml({ order: "other-request" }),
      amount: xml({ amount: "20.00" }),
      currency: xml({ currency: "EUR" }),
      "known-id": xml(),
    };
    const query =
      fault === "read-error"
        ? vi.fn<typeof fetch>(async () => {
            throw new Error("fixture read lost");
          })
        : read(bodies[fault]);
    expect(await reconcileEasyPayDirectExecution(runtime, executionId, query)).toBe("deferred");
    expect(query).toHaveBeenCalledTimes(1);
    expect(await row()).toMatchObject({
      status: "unknown",
      provider_transaction_id: fault === "known-id" ? "previous-id" : null,
    });
    expect(
      await env.BILLING_DB.prepare(
        "SELECT count(*) AS n FROM payment_request_payments WHERE payment_request_id=?",
      )
        .bind(paymentRequestId)
        .first(),
    ).toEqual({ n: 0 });
    if (fault === "known-id") {
      const response = await handleEasyPayDirectCheckoutSubmission(
        request(),
        runtime,
        "browser-retry",
        charge,
      );
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ status: "processing", replayed: true });
    } else
      await expect(
        handleEasyPayDirectCheckoutSubmission(request(), runtime, "browser-retry", charge),
      ).rejects.toThrow();
    expect(charge).toHaveBeenCalledTimes(1);
  });
  it("gates direct reads, rejects a live-network invocation and respects an active claim lease", async () => {
    const query = read();
    const disabled = new Proxy(runtime, {
      get(target, key, receiver) {
        return key === "PROVIDER_READS_ENABLED" ? "0" : Reflect.get(target, key, receiver);
      },
    });
    const production = new Proxy(runtime, {
      get(target, key, receiver) {
        return key === "EASY_PAY_DIRECT_NETWORK_MODE"
          ? "production"
          : Reflect.get(target, key, receiver);
      },
    });
    const wrongOrganization = new Proxy(runtime, {
      get(target, key, receiver) {
        return key === "EASY_PAY_DIRECT_ORGANIZATION_ID"
          ? "other-organization"
          : Reflect.get(target, key, receiver);
      },
    });
    const wrongAccount = new Proxy(runtime, {
      get(target, key, receiver) {
        return key === "EASY_PAY_DIRECT_ACCOUNT_CODE"
          ? "other-account"
          : Reflect.get(target, key, receiver);
      },
    });
    expect(await reconcileEasyPayDirectGatewayTestExecution(disabled, executionId, query)).toBe(
      "deferred",
    );
    expect(await reconcileEasyPayDirectGatewayTestExecution(production, executionId, query)).toBe(
      "deferred",
    );
    expect(
      await reconcileEasyPayDirectGatewayTestExecution(wrongOrganization, executionId, query),
    ).toBe("deferred");
    expect(await reconcileEasyPayDirectGatewayTestExecution(wrongAccount, executionId, query)).toBe(
      "deferred",
    );
    await env.BILLING_DB.prepare(
      "UPDATE easy_pay_direct_payment_executions SET status='processing',updated_at=? WHERE id=?",
    )
      .bind(new Date().toISOString(), executionId)
      .run();
    expect(await reconcileEasyPayDirectExecution(runtime, executionId, query)).toBe("deferred");
    expect(query).not.toHaveBeenCalled();
    await env.BILLING_DB.prepare(
      "UPDATE easy_pay_direct_payment_executions SET updated_at='2026-01-01T00:00:00.000Z' WHERE id=?",
    )
      .bind(executionId)
      .run();
    expect(await reconcileEasyPayDirectExecution(runtime, executionId, query)).toBe("processed");
  });
  it("allows only one concurrent Query claim and never replays a sale", async () => {
    const query = read();
    expect(
      await Promise.all([
        reconcileEasyPayDirectExecution(runtime, executionId, query),
        reconcileEasyPayDirectExecution(runtime, executionId, query),
      ]),
    ).toContain("processed");
    expect(query).toHaveBeenCalledTimes(1);
    expect(charge).toHaveBeenCalledTimes(1);
  });
  it("rotates empty reads fairly and permits later read-only recovery", async () => {
    await env.BILLING_DB.prepare(
      "UPDATE easy_pay_direct_payment_executions SET updated_at='2026-01-01T00:00:00.000Z' WHERE id=?",
    )
      .bind(executionId)
      .run();
    expect(await pendingEasyPayDirectExecutions(env.BILLING_DB, "gateway_test")).toContain(
      executionId,
    );
    expect(await reconcileEasyPayDirectExecution(runtime, executionId, read(""))).toBe("deferred");
    expect((await row())!.updated_at).not.toBe("2026-01-01T00:00:00.000Z");
    expect(await reconcileEasyPayDirectExecution(runtime, executionId, read())).toBe("processed");
    expect(charge).toHaveBeenCalledTimes(1);
  });
});
