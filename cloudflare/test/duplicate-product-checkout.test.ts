import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { EASY_PAY_DIRECT_PAYABLE_EXECUTION_SQL } from "../src/billing/easy-pay-direct-recovery-policy";

const now = new Date().toISOString();
async function fixture() {
  const org = crypto.randomUUID();
  await env.BILLING_DB.prepare(
    "INSERT INTO organizations (id,external_id,name,created_at,updated_at) VALUES (?,?,'Fixture',?,?)",
  )
    .bind(org, org, now, now)
    .run();
  return org;
}
async function checkout(
  org: string,
  options: {
    product?: string;
    email?: string;
    interval?: string;
    paid?: boolean;
    status?: string;
    customerAndPlan?: string;
    invoiceId?: string;
  } = {},
) {
  const id = crypto.randomUUID();
  const customer = options.customerAndPlan ?? id;
  await env.BILLING_DB.batch([
    env.BILLING_DB.prepare(`INSERT INTO customers
      (id,organization_id,external_id,email,currency,payment_provider,payment_provider_code,created_at,updated_at)
      VALUES (?,?,?,?,'USD','easy_pay_direct','fixture',?,?)`).bind(
      id,
      org,
      id,
      options.email ?? "buyer@example.test",
      now,
      now,
    ),
    env.BILLING_DB.prepare(`INSERT INTO plans
      (id,organization_id,code,name,interval,amount_minor,currency,created_at,updated_at)
      VALUES (?,?,?,'Fixture',?,1700,'USD',?,?)`).bind(
      id,
      org,
      id,
      options.interval ?? "monthly",
      now,
      now,
    ),
    env.BILLING_DB.prepare(`INSERT INTO subscriptions
      (id,organization_id,customer_id,plan_id,external_id,status,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?)`).bind(
      id,
      org,
      customer,
      customer,
      id,
      options.status ?? "active",
      now,
      now,
    ),
    env.BILLING_DB.prepare(`INSERT INTO subscription_checkout_products
      (subscription_id,organization_id,product_slug,created_at) VALUES (?,?,?,?)`).bind(
      id,
      org,
      options.product ?? "fixture-app",
      now,
    ),
    env.BILLING_DB.prepare(`INSERT INTO invoices
      (id,organization_id,customer_id,subscription_id,number,status,payment_status,
       currency,subtotal_minor,total_due_minor,ready_for_payment_processing,created_at,updated_at)
      VALUES (?,?,?,?,?,'finalized',?,'USD',1700,1700,1,?,?)`).bind(
      id,
      org,
      customer,
      id,
      id,
      "pending",
      now,
      now,
    ),
    env.BILLING_DB.prepare(`INSERT INTO payment_requests
      (id,organization_id,customer_id,amount_minor,currency,collection_mode,created_at,updated_at)
      VALUES (?,?,?,1700,'USD','checkout',?,?)`).bind(id, org, customer, now, now),
    env.BILLING_DB.prepare(`INSERT INTO invoices_payment_requests
      (id,organization_id,payment_request_id,invoice_id,invoice_version,created_at,updated_at)
      VALUES (?,?,?,?,1,?,?)`).bind(id, org, id, options.invoiceId ?? id, now, now),
    env.BILLING_DB.prepare(`INSERT INTO payment_request_checkout_intents
      (id,organization_id,payment_request_id,customer_id,provider,provider_account_code,
       idempotency_key,request_sha256,amount_minor,currency,payment_request_version,status,
       payment_url,provider_token_sha256,created_at,updated_at)
      VALUES (?,?,?,?,'easy_pay_direct','fixture',?,'fixture',1700,'USD',1,'succeeded',
       'https://fixture.test','fixture',?,?)`).bind(id, org, id, customer, id, now, now),
    env.BILLING_DB.prepare(`INSERT INTO easy_pay_direct_payment_executions
      (id,organization_id,checkout_intent_id,payment_request_id,provider_account_code,
       request_sha256,payment_token_sha256,phone_sha256,customer_idempotency_key,
       payment_method_idempotency_key,product_idempotency_key,order_idempotency_key,
       status,created_at,updated_at)
      VALUES (?,?,?,?,'fixture','fixture','fixture','fixture',?,?,?,?,'pending',?,?)`).bind(
      id,
      org,
      id,
      id,
      id,
      id,
      id,
      id,
      now,
      now,
    ),
  ]);
  if (options.paid) {
    await env.BILLING_DB.prepare("UPDATE invoices SET payment_status='succeeded' WHERE id=?")
      .bind(id)
      .run();
  }
  return id;
}
async function claim(id: string) {
  return (
    await env.BILLING_DB.prepare(`UPDATE easy_pay_direct_payment_executions
    SET status='processing' WHERE id=? AND status='pending'
      AND ${EASY_PAY_DIRECT_PAYABLE_EXECUTION_SQL}`)
      .bind(id)
      .run()
  ).meta.changes;
}

// Checkout origin is not Store's final app assignment. Only the same financial
// obligation/execution is deduplicated here, never email + generic plan/product.
describe("independent purchases and same-invoice protection (real local D1)", () => {
  it.each([
    "serp-1-app-plan",
    "serp-app-plus-plan",
    "serp-1-app-plus-plan",
    "serp-1-app-premium-plan",
    "serp-1-app-lifetime-plan",
  ])("allows a repeated unassigned price-bucket checkout: %s", async (product) => {
    const org = await fixture();
    const first = await checkout(org, { paid: true, product });
    const second = await checkout(org, { product });
    await env.BILLING_DB.prepare("UPDATE subscriptions SET plan_id=? WHERE id=?")
      .bind(first, second)
      .run();
    expect(await claim(second)).toBe(1);
  });
  it("allows a separate purchase despite a paid subscription and normalized email match", async () => {
    const org = await fixture();
    await checkout(org, { paid: true, email: " Buyer@Example.Test " });
    const second = await checkout(org);
    expect(await claim(second)).toBe(1);
  });
  it.each(["processing", "unknown", "succeeded"])(
    "does not block a separate invoice with another %s outcome",
    async (status) => {
      const org = await fixture();
      const first = await checkout(org);
      const second = await checkout(org);
      await env.BILLING_DB.prepare(
        "UPDATE easy_pay_direct_payment_executions SET status=? WHERE id=?",
      )
        .bind(status, first)
        .run();
      expect(await claim(second)).toBe(1);
    },
  );
  it.each(["pending", "failed"])("allows another %s uncharged/declined attempt", async (status) => {
    const org = await fixture();
    const first = await checkout(org);
    const second = await checkout(org);
    await env.BILLING_DB.prepare(
      "UPDATE easy_pay_direct_payment_executions SET status=? WHERE id=?",
    )
      .bind(status, first)
      .run();
    expect(await claim(second)).toBe(1);
  });
  it("allows concurrent independent purchases, even from the same product page", async () => {
    const org = await fixture();
    const first = await checkout(org);
    const second = await checkout(org);
    const results = await Promise.all([claim(first), claim(second)]);
    expect(results).toEqual([1, 1]);
  });
  it("only claims a single execution once under concurrent submissions", async () => {
    const org = await fixture();
    const id = await checkout(org);
    expect((await Promise.all([claim(id), claim(id)])).sort()).toEqual([0, 1]);
  });
  it("claims only one of two concurrent payment requests for the same invoice", async () => {
    const org = await fixture();
    const first = await checkout(org);
    const second = await checkout(org, { customerAndPlan: first, invoiceId: first });
    expect((await Promise.all([claim(first), claim(second)])).sort()).toEqual([0, 1]);
  });
  it.each(["processing", "unknown"])(
    "blocks a second request for the same invoice with a %s outcome",
    async (status) => {
      const org = await fixture();
      const first = await checkout(org);
      const second = await checkout(org, { customerAndPlan: first, invoiceId: first });
      await env.BILLING_DB.prepare(
        "UPDATE easy_pay_direct_payment_executions SET status=? WHERE id=?",
      )
        .bind(status, first)
        .run();
      expect(await claim(second)).toBe(0);
    },
  );
  it("blocks a stale request after its shared invoice has been paid", async () => {
    const org = await fixture();
    const first = await checkout(org);
    const second = await checkout(org, { customerAndPlan: first, invoiceId: first });
    await env.BILLING_DB.prepare("UPDATE invoices SET payment_status='succeeded' WHERE id=?")
      .bind(first)
      .run();
    expect(await claim(second)).toBe(0);
  });
  it("allows separate invoices for the exact same customer, plan and checkout origin", async () => {
    const org = await fixture();
    const first = await checkout(org, { paid: true });
    const second = await checkout(org, { customerAndPlan: first });
    expect(await claim(second)).toBe(1);
  });
  it.each([
    { product: "other-app" },
    { email: "different@example.test" },
    { interval: "one_time" },
    { status: "terminated" },
    { status: "canceled" },
  ])("preserves different scope or ended subscription: %j", async (options) => {
    const org = await fixture();
    await checkout(org, { paid: true, ...options });
    expect(await claim(await checkout(org))).toBe(1);
  });
  it("does not cross organizations", async () => {
    await checkout(await fixture(), { paid: true });
    expect(await claim(await checkout(await fixture()))).toBe(1);
  });
  it("does not impose a recurring guard on one-time repurchases", async () => {
    const org = await fixture();
    await checkout(org, { paid: true });
    expect(await claim(await checkout(org, { interval: "one_time" }))).toBe(1);
  });
  it("allows the same customer to buy the exact same generic plan for another app", async () => {
    const org = await fixture();
    const first = await checkout(org, { paid: true, product: "first-app" });
    const second = await checkout(org, { product: "second-app", customerAndPlan: first });
    expect(await claim(second)).toBe(1);
  });
  it("allows multiple unassigned purchases of the exact same generic plan", async () => {
    const org = await fixture();
    const first = await checkout(org, { paid: true });
    const second = await checkout(org);
    await env.BILLING_DB.prepare("UPDATE subscriptions SET plan_id=? WHERE id=?")
      .bind(first, second)
      .run();
    await env.BILLING_DB.prepare(
      "DELETE FROM subscription_checkout_products WHERE subscription_id IN (?,?)",
    )
      .bind(first, second)
      .run();
    expect(await claim(second)).toBe(1);
  });
  it("does not mistake an unassigned generic-plan purchase for an assigned app purchase", async () => {
    const org = await fixture();
    const first = await checkout(org, { paid: true });
    const second = await checkout(org);
    await env.BILLING_DB.prepare("UPDATE subscriptions SET plan_id=? WHERE id=?")
      .bind(first, second)
      .run();
    await env.BILLING_DB.prepare(
      "DELETE FROM subscription_checkout_products WHERE subscription_id=?",
    )
      .bind(first)
      .run();
    expect(await claim(second)).toBe(1);
  });
});
