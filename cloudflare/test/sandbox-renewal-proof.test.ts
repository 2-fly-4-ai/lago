import { env } from "cloudflare:test";
import { beforeEach, expect, it, vi } from "vitest";
import type { DomainEvent } from "../src/domain-events";
import { prepareEasyPayDirectAutomaticCollection } from "../src/billing/easy-pay-direct-automatic-collection";
import { runSandboxRefundReadback } from "../src/workflows/sandbox-refund-readback";
import {
  runSandboxRenewalProof,
  type SandboxRenewalProofEnv,
} from "../src/workflows/sandbox-renewal-proof";

let prefix: string;
const send = vi.fn(async (_event: DomainEvent) => {});
const end = "2026-10-01T00:00:00.000Z";
beforeEach(async () => {
  send.mockReset();
  prefix = crypto.randomUUID();
  const id = (suffix: string) => `${prefix}-${suffix}`;
  const now = "2026-09-09T00:00:00.000Z";
  const times = `'${now}','${now}'`;
  await env.BILLING_DB.batch(
    [
      `INSERT INTO organizations(id,external_id,name,created_at,updated_at) VALUES('${id("org")}','${id("org")}','Fixture',${times})`,
      `INSERT INTO customers(id,organization_id,external_id,email,payment_provider,payment_provider_code,created_at,updated_at) VALUES('${id("customer")}','${id("org")}','${id("customer")}','fictional@example.test','easy_pay_direct','fixture-account',${times})`,
      `INSERT INTO plans(id,organization_id,code,name,interval,amount_minor,currency,pay_in_advance,version,active,created_at,updated_at) VALUES('${id("plan")}','${id("org")}','fixture','Fixture','monthly',900,'USD',1,1,1,${times})`,
      `INSERT INTO subscriptions(id,organization_id,customer_id,plan_id,external_id,status,current_period_start,current_period_end,created_at,updated_at) VALUES('${id("sub")}','${id("org")}','${id("customer")}','${id("plan")}','${id("sub")}','active','2026-09-01T00:00:00.000Z','${end}',${times})`,
      `INSERT INTO invoices(id,organization_id,customer_id,subscription_id,status,payment_status,currency,subtotal_minor,total_due_minor,version,payment_overdue,ready_for_payment_processing,created_at,updated_at) VALUES('${id("invoice")}','${id("org")}','${id("customer")}','${id("sub")}','finalized','pending','USD',900,900,1,1,1,${times})`,
      `INSERT INTO payment_requests(id,organization_id,customer_id,amount_minor,currency,payment_status,ready_for_payment_processing,created_at,updated_at) VALUES('${id("request")}','${id("org")}','${id("customer")}',900,'USD','pending',1,${times})`,
    ].map((sql) => env.BILLING_DB.prepare(sql)),
  );
  await env.BILLING_DB.batch(
    [
      `INSERT INTO invoices_payment_requests(id,organization_id,payment_request_id,invoice_id,invoice_version,created_at,updated_at) VALUES('${id("link")}','${id("org")}','${id("request")}','${id("invoice")}',1,${times})`,
      `INSERT INTO payment_request_checkout_intents(id,organization_id,payment_request_id,customer_id,provider,provider_account_code,idempotency_key,request_sha256,amount_minor,currency,payment_request_version,status,payment_url,provider_token_sha256,created_at,updated_at) VALUES('${id("intent")}','${id("org")}','${id("request")}','${id("customer")}','easy_pay_direct','fixture-account','${id("key")}','fixturehash',900,'USD',1,'succeeded','https://fixture.invalid','fixture-token',${times})`,
      `INSERT INTO easy_pay_direct_payment_executions(id,organization_id,checkout_intent_id,payment_request_id,provider_account_code,request_sha256,payment_token_sha256,phone_sha256,customer_idempotency_key,payment_method_idempotency_key,product_idempotency_key,order_idempotency_key,status,provider_transaction_id,customer_vault_id,terms_accepted_at,charge_transport,created_at,updated_at) VALUES('${id("execution")}','${id("org")}','${id("intent")}','${id("request")}','fixture-account','fixturehash','token','phone','customerkey','methodkey','productkey','orderkey','succeeded','${id("transaction")}','1234','${now}','gateway',${times})`,
      `INSERT INTO provider_customer_profiles(id,organization_id,customer_id,provider,provider_account_code,provider_customer_id,gateway_customer_vault_id,initial_transaction_id,status,checkout_intent_id,created_at,updated_at) VALUES('${id("profile")}','${id("org")}','${id("customer")}','easy_pay_direct','fixture-account','fictional-customer','1234','${id("transaction")}','active','${id("intent")}',${times})`,
      `UPDATE subscriptions SET payment_method_type='provider',payment_method_id='${id("profile")}' WHERE id='${id("sub")}'`,
      `UPDATE invoices SET payment_status='succeeded' WHERE id='${id("invoice")}'`,
      `UPDATE payment_requests SET payment_status='succeeded' WHERE id='${id("request")}'`,
      `INSERT INTO subscription_invoice_contexts(invoice_id,organization_id,subscription_id,context_type,period_start,period_end,created_at) VALUES('${id("invoice")}','${id("org")}','${id("sub")}','initial','2026-09-01T00:00:00.000Z','${end}','${now}')`,
      `INSERT INTO easy_pay_direct_automatic_collection_scopes(subscription_id,organization_id,status,reason,created_at,updated_at) VALUES('${id("sub")}','${id("org")}','enabled','fictional local test',${times})`,
    ].map((sql) => env.BILLING_DB.prepare(sql)),
  );
});
function runtime(overrides: Record<string, string> = {}): SandboxRenewalProofEnv {
  const config = {
    APP_ENV: "development",
    EASY_PAY_DIRECT_NETWORK_MODE: "gateway_test",
    EASY_PAY_DIRECT_LIVEMODE_ALLOWED: "0",
    PAYMENT_MUTATIONS_ENABLED: "1",
    EASY_PAY_DIRECT_ORGANIZATION_ID: `${prefix}-org`,
    EASY_PAY_DIRECT_ACCOUNT_CODE: "fixture-account",
    EASY_PAY_DIRECT_SANDBOX_RENEWAL_SUBSCRIPTION_ID: `${prefix}-sub`,
    EASY_PAY_DIRECT_SANDBOX_RENEWAL_PERIOD_END: end,
    ...overrides,
  };
  return new Proxy(env, {
    get(target, key, receiver) {
      if (key === "DOMAIN_EVENTS")
        return new Proxy(env.DOMAIN_EVENTS, {
          get(queue, method, queueReceiver) {
            return method === "send" ? send : Reflect.get(queue, method, queueReceiver);
          },
        });
      return typeof key === "string" && key in config
        ? config[key as keyof typeof config]
        : Reflect.get(target, key, receiver);
    },
  }) as SandboxRenewalProofEnv;
}
it.each([
  "production",
  "wrong-org",
  "wrong-account",
  "unallowlisted",
  "stale-end",
  "one-time",
  "unpaid",
  "disabled-scope",
  "pending-successor",
  "wrong-initial-transaction",
  "wrong-vault",
])("rejects %s without closing any period", async (kind) => {
  const overrides: Record<string, string> =
    kind === "production"
      ? { APP_ENV: "production" }
      : kind === "wrong-org"
        ? { EASY_PAY_DIRECT_ORGANIZATION_ID: "foreign" }
        : kind === "wrong-account"
          ? { EASY_PAY_DIRECT_ACCOUNT_CODE: "foreign" }
          : kind === "unallowlisted"
            ? { EASY_PAY_DIRECT_SANDBOX_RENEWAL_SUBSCRIPTION_ID: "" }
            : {};
  if (kind === "one-time")
    await env.BILLING_DB.prepare("UPDATE plans SET interval='one_time' WHERE id=?")
      .bind(`${prefix}-plan`)
      .run();
  if (kind === "wrong-initial-transaction")
    await env.BILLING_DB.prepare(
      "UPDATE provider_customer_profiles SET initial_transaction_id='mismatch' WHERE id=?",
    )
      .bind(`${prefix}-profile`)
      .run();
  if (kind === "wrong-vault")
    await env.BILLING_DB.prepare(
      "UPDATE easy_pay_direct_payment_executions SET customer_vault_id='mismatch' WHERE id=?",
    )
      .bind(`${prefix}-execution`)
      .run();
  if (kind === "unpaid")
    await env.BILLING_DB.prepare("UPDATE payment_requests SET payment_status='pending' WHERE id=?")
      .bind(`${prefix}-request`)
      .run();
  if (kind === "disabled-scope")
    await env.BILLING_DB.prepare(
      "UPDATE easy_pay_direct_automatic_collection_scopes SET status='disabled' WHERE subscription_id=?",
    )
      .bind(`${prefix}-sub`)
      .run();
  if (kind === "pending-successor")
    await env.BILLING_DB.prepare(`INSERT INTO subscriptions
      (id,organization_id,customer_id,plan_id,external_id,status,previous_subscription_id,
       transition_kind,generation,current_period_start,current_period_end,created_at,updated_at)
      SELECT ?,organization_id,customer_id,plan_id,?,'pending',id,'downgrade',2,current_period_end,
        '2026-11-01T00:00:00.000Z',created_at,updated_at FROM subscriptions WHERE id=?`)
      .bind(`${prefix}-successor`, `${prefix}-successor`, `${prefix}-sub`)
      .run();
  await expect(
    runSandboxRenewalProof(runtime(overrides), {
      subscriptionId: `${prefix}-sub`,
      expectedPeriodEnd: kind === "stale-end" ? "2026-11-01T00:00:00.000Z" : end,
    }),
  ).rejects.toThrow(/sandbox_renewal_proof/);
  expect(
    await env.BILLING_DB.prepare(
      "SELECT COUNT(*) AS count FROM billing_cycles WHERE organization_id=?",
    )
      .bind(`${prefix}-org`)
      .first(),
  ).toEqual({ count: 0 });
  if (kind === "pending-successor") {
    expect(
      await env.BILLING_DB.prepare("SELECT status FROM subscriptions WHERE id=?")
        .bind(`${prefix}-successor`)
        .first(),
    ).toEqual({ status: "pending" });
    expect(
      await env.BILLING_DB.prepare("SELECT status,current_period_end FROM subscriptions WHERE id=?")
        .bind(`${prefix}-sub`)
        .first(),
    ).toEqual({ status: "active", current_period_end: end });
  }
});
it("closes only the allowlisted real fixture period through the normal billing engine", async () => {
  const result = await runSandboxRenewalProof(runtime(), {
    subscriptionId: `${prefix}-sub`,
    expectedPeriodEnd: end,
  });
  expect(result).toMatchObject({
    sandboxRenewalProof: true,
    subscriptionId: `${prefix}-sub`,
    totalDueMinor: 900,
  });
  expect(
    await env.BILLING_DB.prepare(
      "SELECT status,payment_status,total_due_minor FROM invoices WHERE id=?",
    )
      .bind(result.invoiceId)
      .first(),
  ).toEqual({ status: "finalized", payment_status: "pending", total_due_minor: 900 });
  expect(
    await env.BILLING_DB.prepare(
      "SELECT current_period_start,current_period_end FROM subscriptions WHERE id=?",
    )
      .bind(`${prefix}-sub`)
      .first(),
  ).toEqual({ current_period_start: end, current_period_end: "2026-11-01T00:00:00.000Z" });
  expect(
    await env.BILLING_DB.prepare("SELECT COUNT(*) AS count FROM schedule_runs").first(),
  ).toEqual({ count: 0 });
  expect(
    await env.BILLING_DB.prepare("SELECT COUNT(*) AS count FROM billing_cycles").first(),
  ).toEqual({ count: 1 });
  expect(send).toHaveBeenCalledWith(
    expect.objectContaining({
      id: `invoice-finalized:${result.invoiceId}:v1`,
      aggregateId: result.invoiceId,
      type: "invoice.finalized",
    }),
  );
  const replay = await runSandboxRenewalProof(runtime(), {
    subscriptionId: `${prefix}-sub`,
    expectedPeriodEnd: end,
    resumeInvoiceId: result.invoiceId,
  });
  expect(replay).toMatchObject({ invoiceId: result.invoiceId, replayed: true });
  expect(
    await env.BILLING_DB.prepare("SELECT COUNT(*) AS count FROM billing_cycles").first(),
  ).toEqual({ count: 1 });
});

it("resumes only the existing exact cycle after queue failure without advancing another period", async () => {
  send.mockRejectedValueOnce(new Error("queue_unavailable"));
  await expect(
    runSandboxRenewalProof(runtime(), {
      subscriptionId: `${prefix}-sub`,
      expectedPeriodEnd: end,
    }),
  ).rejects.toThrow("queue_unavailable");
  const invoice = await env.BILLING_DB.prepare(
    "SELECT invoice_id FROM billing_cycles WHERE subscription_id=? AND status='closed'",
  )
    .bind(`${prefix}-sub`)
    .first<{ invoice_id: string }>();
  expect(invoice).not.toBeNull();
  await expect(
    runSandboxRenewalProof(runtime(), {
      subscriptionId: `${prefix}-sub`,
      expectedPeriodEnd: end,
      resumeInvoiceId: `${prefix}-invoice`,
    }),
  ).rejects.toThrow("sandbox_renewal_proof_fixture_mismatch");
  const result = await runSandboxRenewalProof(runtime(), {
    subscriptionId: `${prefix}-sub`,
    expectedPeriodEnd: end,
    resumeInvoiceId: invoice!.invoice_id,
  });
  expect(result).toMatchObject({
    invoiceId: invoice!.invoice_id,
    replayed: true,
    publishedEvents: 1,
  });
  expect(
    await env.BILLING_DB.prepare(
      "SELECT COUNT(*) AS count FROM billing_cycles WHERE subscription_id=?",
    )
      .bind(`${prefix}-sub`)
      .first(),
  ).toEqual({ count: 1 });
  expect(
    await env.BILLING_DB.prepare("SELECT current_period_end FROM subscriptions WHERE id=?")
      .bind(`${prefix}-sub`)
      .first(),
  ).toEqual({ current_period_end: "2026-11-01T00:00:00.000Z" });
  expect(send.mock.calls.every(([event]) => event.aggregateId === invoice!.invoice_id)).toBe(true);
});

it("publishes only the linked renewal request when its downstream queue send was lost", async () => {
  const configured = runtime({
    EASY_PAY_DIRECT_AUTOMATIC_COLLECTION_ENABLED: "1",
    EASY_PAY_DIRECT_AUTOMATIC_COLLECTION_SCOPE_MODE: "scoped",
    EASY_PAY_DIRECT_TAX_MODE: "disabled",
  });
  const result = await runSandboxRenewalProof(configured, {
    subscriptionId: `${prefix}-sub`,
    expectedPeriodEnd: end,
  });
  // Fictional local fixture only. The workflow never changes due dates.
  await env.BILLING_DB.prepare("UPDATE invoices SET payment_due_date=NULL WHERE id=?")
    .bind(result.invoiceId)
    .run();
  send.mockRejectedValueOnce(new Error("request_queue_unavailable"));
  await expect(
    prepareEasyPayDirectAutomaticCollection(
      configured,
      result.invoiceId,
      `sandbox-renewal-proof:${prefix}-sub:${end}`,
    ),
  ).rejects.toThrow("request_queue_unavailable");
  send.mockClear();
  await runSandboxRenewalProof(configured, {
    subscriptionId: `${prefix}-sub`,
    expectedPeriodEnd: end,
    resumeInvoiceId: result.invoiceId,
  });
  expect(send.mock.calls.map(([event]) => event.type).sort()).toEqual([
    "invoice.finalized",
    "payment_request.created",
  ]);
  expect(
    await env.BILLING_DB.prepare(
      "SELECT COUNT(*) AS count FROM easy_pay_direct_automatic_payment_executions WHERE organization_id=?",
    )
      .bind(`${prefix}-org`)
      .first(),
  ).toEqual({ count: 1 });
});

it("rechecks a processed future-due invoice on exact resume without replaying its event", async () => {
  const configured = runtime({
    EASY_PAY_DIRECT_AUTOMATIC_COLLECTION_ENABLED: "1",
    EASY_PAY_DIRECT_AUTOMATIC_COLLECTION_SCOPE_MODE: "scoped",
    EASY_PAY_DIRECT_TAX_MODE: "disabled",
  });
  const target = { subscriptionId: `${prefix}-sub`, expectedPeriodEnd: end };
  const result = await runSandboxRenewalProof(configured, target);
  expect(
    await prepareEasyPayDirectAutomaticCollection(
      configured,
      result.invoiceId,
      "original-consumer",
    ),
  ).toBe("not_applicable");
  const eventId = `invoice-finalized:${result.invoiceId}:v1`;
  const now = new Date().toISOString();
  await env.BILLING_DB.batch([
    env.BILLING_DB.prepare("UPDATE outbox_events SET published_at=? WHERE event_id=?").bind(
      now,
      eventId,
    ),
    env.BILLING_DB.prepare(
      "INSERT INTO processed_messages(event_id,event_type,processed_at) VALUES(?,'invoice.finalized',?)",
    ).bind(eventId, now),
    // Synthetic local fixture adjustment; runtime keeps ordinary due-date guards.
    env.BILLING_DB.prepare("UPDATE invoices SET payment_due_date=date('now') WHERE id=?").bind(
      result.invoiceId,
    ),
  ]);
  send.mockClear();
  const resumed = await runSandboxRenewalProof(configured, {
    ...target,
    resumeInvoiceId: result.invoiceId,
  });
  expect(resumed).toMatchObject({
    invoiceId: result.invoiceId,
    replayed: true,
    automaticPreparation: "processed",
  });
  expect(send.mock.calls.length).toBeGreaterThan(0);
  expect(send.mock.calls.every(([event]) => event.type === "payment_request.created")).toBe(true);
  expect(
    await env.BILLING_DB.prepare(
      "SELECT COUNT(*) AS count FROM easy_pay_direct_automatic_payment_executions WHERE organization_id=?",
    )
      .bind(`${prefix}-org`)
      .first(),
  ).toEqual({ count: 1 });
  expect(
    await env.BILLING_DB.prepare(
      "SELECT COUNT(*) AS count FROM billing_cycles WHERE subscription_id=?",
    )
      .bind(`${prefix}-sub`)
      .first(),
  ).toEqual({ count: 1 });
  expect(
    await env.BILLING_DB.prepare("SELECT processed_at FROM processed_messages WHERE event_id=?")
      .bind(eventId)
      .first(),
  ).toEqual({ processed_at: now });
  await runSandboxRenewalProof(configured, { ...target, resumeInvoiceId: result.invoiceId });
  expect(
    await env.BILLING_DB.prepare(
      "SELECT COUNT(*) AS count FROM easy_pay_direct_automatic_payment_executions WHERE organization_id=?",
    )
      .bind(`${prefix}-org`)
      .first(),
  ).toEqual({ count: 1 });
});

async function refundReadbackFixture() {
  const transactionId = BigInt(`0x${prefix.replaceAll("-", "")}`).toString();
  await env.BILLING_DB.batch([
    env.BILLING_DB.prepare(
      "UPDATE easy_pay_direct_payment_executions SET provider_transaction_id=? WHERE id=?",
    ).bind(transactionId, `${prefix}-execution`),
    env.BILLING_DB.prepare(`INSERT INTO payment_request_payments
      (id,organization_id,payment_request_id,provider,provider_account_code,provider_transaction_id,
       idempotency_key,amount_minor,currency,status,created_at,updated_at)
      SELECT ?,organization_id,id,'easy_pay_direct','fixture-account',?,?,amount_minor,currency,'succeeded',created_at,updated_at
      FROM payment_requests WHERE id=?`).bind(
      `${prefix}-paid`,
      transactionId,
      `${prefix}-paid`,
      `${prefix}-request`,
    ),
  ]);
  return {
    transactionId,
    configured: runtime({
      PROVIDER_READS_ENABLED: "1",
      EASY_PAY_DIRECT_SECURITY_KEY: "synthetic-readback-key",
      EASY_PAY_DIRECT_SANDBOX_REFUND_INVOICE_ID: `${prefix}-invoice`,
    }),
  };
}

it.each([
  "production",
  "live",
  "reads-off",
  "wrong-org",
  "wrong-account",
  "wrong-invoice",
  "missing-paid",
])("refuses sandbox refund readback %s before any provider read", async (kind) => {
  const { configured } = await refundReadbackFixture();
  const overrides: Record<string, string> =
    kind === "production"
      ? { APP_ENV: "production" }
      : kind === "live"
        ? { EASY_PAY_DIRECT_LIVEMODE_ALLOWED: "1" }
        : kind === "reads-off"
          ? { PROVIDER_READS_ENABLED: "0" }
          : kind === "wrong-org"
            ? { EASY_PAY_DIRECT_ORGANIZATION_ID: "foreign" }
            : kind === "wrong-account"
              ? { EASY_PAY_DIRECT_ACCOUNT_CODE: "foreign" }
              : {};
  if (kind === "missing-paid")
    await env.BILLING_DB.prepare("UPDATE payment_request_payments SET status='unknown' WHERE id=?")
      .bind(`${prefix}-paid`)
      .run();
  const blocked = new Proxy(configured, {
    get(target, key, receiver) {
      return typeof key === "string" && key in overrides
        ? overrides[key]
        : Reflect.get(target, key, receiver);
    },
  });
  const fetcher = vi.fn<typeof fetch>();
  await expect(
    runSandboxRefundReadback(
      blocked,
      { invoiceId: kind === "wrong-invoice" ? "foreign" : `${prefix}-invoice` },
      fetcher,
    ),
  ).rejects.toThrow(/sandbox_refund_readback/);
  expect(fetcher).not.toHaveBeenCalled();
});

it("returns normalized refund readback through Query only without altering refund/payment state", async () => {
  const { configured, transactionId } = await refundReadbackFixture();
  const fetcher = vi.fn<typeof fetch>(async (url, options) => {
    expect(String(url)).toBe("https://secure.easypaydirectgateway.com/api/query.php");
    expect(new URLSearchParams(String(options!.body)).get("transaction_id")).toBe(transactionId);
    return new Response(
      `<nm_response><transaction><transaction_id>${transactionId}</transaction_id><currency>USD</currency><condition>complete</condition><action><action_type>sale</action_type><success>1</success><amount>9.00</amount></action><action><action_type>refund</action_type><success>1</success><amount>4.50</amount></action></transaction></nm_response>`,
    );
  });
  expect(
    await runSandboxRefundReadback(configured, { invoiceId: `${prefix}-invoice` }, fetcher),
  ).toEqual({
    sandboxRefundReadback: true,
    invoiceId: `${prefix}-invoice`,
    status: "verified",
    currency: "USD",
    saleAmountMinor: 900,
    refundedAmountMinor: 450,
  });
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(
    await env.BILLING_DB.prepare(
      "SELECT COUNT(*) AS count FROM provider_refund_operations WHERE organization_id=?",
    )
      .bind(`${prefix}-org`)
      .first(),
  ).toEqual({ count: 0 });
});

it("returns only a safe diagnostic when Gateway readback cannot be verified", async () => {
  const { configured } = await refundReadbackFixture();
  const fetcher = vi.fn<typeof fetch>(
    async () => new Response("private-provider-body", { status: 503 }),
  );
  const result = await runSandboxRefundReadback(
    configured,
    { invoiceId: `${prefix}-invoice` },
    fetcher,
  );
  expect(result).toMatchObject({ status: "unverified" });
  expect(JSON.stringify(result)).not.toContain("private-provider-body");
  expect(JSON.stringify(result)).not.toContain("synthetic-readback-key");
});
