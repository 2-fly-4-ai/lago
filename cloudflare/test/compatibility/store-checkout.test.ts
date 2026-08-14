import { env, SELF } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { sha256Hex } from "../../src/auth/api-key";
import customerRequest from "../../fixtures/store-new/customer-upsert.json";
import subscriptionRequest from "../../fixtures/store-new/subscription-create.json";
import invoiceListQuery from "../../fixtures/store-new/invoice-list-query.json";
import paymentUrlRequest from "../../fixtures/store-new/payment-url-request.json";

const apiKey = "test-lago-api-key";
const authorization = { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" };

beforeEach(async () => {
  const now = "2026-08-12T00:00:00.000Z";
  await env.BILLING_DB.batch([
    env.BILLING_DB.prepare(
      `INSERT OR IGNORE INTO organizations (id, external_id, name, created_at, updated_at)
       VALUES ('org-test', 'serp-store', 'SERP Store', ?, ?)`,
    ).bind(now, now),
    env.BILLING_DB.prepare(
      `INSERT OR IGNORE INTO api_keys
       (id, organization_id, key_prefix, key_hash, created_at, revoked_at)
       VALUES ('key-test', 'org-test', 'test-lago', ?, ?, NULL)`,
    ).bind(await sha256Hex(apiKey), now),
    env.BILLING_DB.prepare(
      `INSERT OR IGNORE INTO plans
       (id, organization_id, code, name, interval, amount_minor, currency, version, active, created_at, updated_at)
       VALUES ('plan-monthly', 'org-test', 'serp-1-app-plan-monthly', 'One App Monthly',
               'monthly', 1999, 'USD', 1, 1, ?, ?)`,
    ).bind(now, now),
  ]);
});

describe("store-new Lago checkout compatibility", () => {
  it("upserts a customer, creates one subscription/invoice, and returns Lago field names", async () => {
    const firstCustomer = await SELF.fetch("https://lago.test/api/v1/customers", {
      method: "POST",
      headers: authorization,
      body: JSON.stringify(customerRequest),
    });
    expect(firstCustomer.status).toBe(200);
    const firstCustomerBody = await firstCustomer.json<{
      customer: {
        lago_id: string;
        external_id: string;
        email: string;
        billing_configuration: { payment_provider: string };
      };
    }>();
    expect(firstCustomerBody.customer).toMatchObject({
      external_id: "store_safe_email_customer_example_com",
      email: "customer@example.com",
      billing_configuration: { payment_provider: "authorize_net" },
    });

    const shownCustomer = await SELF.fetch(
      "https://lago.test/api/v1/customers/store_safe_email_customer_example_com",
      { headers: authorization },
    );
    expect(shownCustomer.status).toBe(200);
    await expect(shownCustomer.json()).resolves.toMatchObject({
      customer: { lago_id: firstCustomerBody.customer.lago_id },
    });
    const listedCustomers = await SELF.fetch(
      "https://lago.test/api/v1/customers?search_term=customer%40example.com",
      { headers: authorization },
    );
    await expect(listedCustomers.json()).resolves.toMatchObject({
      customers: [{ lago_id: firstCustomerBody.customer.lago_id }],
      meta: { total_count: 1 },
    });

    const replayCustomer = await SELF.fetch("https://lago.test/api/v1/customers", {
      method: "POST",
      headers: authorization,
      body: JSON.stringify(customerRequest),
    });
    const replayCustomerBody = await replayCustomer.json<{ customer: { lago_id: string } }>();
    expect(replayCustomerBody.customer.lago_id).toBe(firstCustomerBody.customer.lago_id);
    const customerCreatedEvents = await env.BILLING_DB.prepare(
      `SELECT event_type, aggregate_type, aggregate_version FROM outbox_events
       WHERE event_type = 'customer.created' AND aggregate_id = ?`,
    )
      .bind(firstCustomerBody.customer.lago_id)
      .all();
    expect(customerCreatedEvents.results).toEqual([
      { event_type: "customer.created", aggregate_type: "customer", aggregate_version: 1 },
    ]);

    const firstSubscription = await SELF.fetch("https://lago.test/api/v1/subscriptions", {
      method: "POST",
      headers: authorization,
      body: JSON.stringify(subscriptionRequest),
    });
    expect(firstSubscription.status).toBe(200);
    const firstSubscriptionBody = await firstSubscription.json<{
      subscription: { lago_id: string; external_id: string; plan_code: string; status: string };
    }>();
    expect(firstSubscriptionBody.subscription).toMatchObject({
      external_id: "store_safe_serp_1_app_plan_monthly_1",
      plan_code: "serp-1-app-plan-monthly",
      status: "active",
    });
    const initialEvents = await env.BILLING_DB.prepare(
      `SELECT event_type, aggregate_type FROM outbox_events
       WHERE event_type IN ('subscription.created', 'invoice.finalized')
       ORDER BY event_type`,
    ).all<{ event_type: string; aggregate_type: string }>();
    expect(initialEvents.results).toEqual([
      { event_type: "invoice.finalized", aggregate_type: "invoice" },
      { event_type: "subscription.created", aggregate_type: "subscription" },
    ]);

    const replaySubscription = await SELF.fetch("https://lago.test/api/v1/subscriptions", {
      method: "POST",
      headers: authorization,
      body: JSON.stringify(subscriptionRequest),
    });
    const replaySubscriptionBody = await replaySubscription.json<{
      subscription: { lago_id: string };
    }>();
    expect(replaySubscriptionBody.subscription.lago_id).toBe(
      firstSubscriptionBody.subscription.lago_id,
    );

    const conflictingSubscription = await SELF.fetch("https://lago.test/api/v1/subscriptions", {
      method: "POST",
      headers: authorization,
      body: JSON.stringify({
        subscription: { ...subscriptionRequest.subscription, plan_code: "different-plan" },
      }),
    });
    expect(conflictingSubscription.status).toBe(409);
    await expect(conflictingSubscription.json()).resolves.toMatchObject({
      code: "subscription_idempotency_conflict",
    });

    const unsupportedSubscription = await SELF.fetch("https://lago.test/api/v1/subscriptions", {
      method: "POST",
      headers: authorization,
      body: JSON.stringify({
        subscription: {
          ...subscriptionRequest.subscription,
          external_id: "unsupported-subscription",
          billing_time: "calendar",
        },
      }),
    });
    expect(unsupportedSubscription.status).toBe(422);
    await expect(unsupportedSubscription.json()).resolves.toMatchObject({
      code: "unsupported_subscription_feature",
    });

    const invoiceQuery = new URLSearchParams(invoiceListQuery).toString();
    const invoices = await SELF.fetch(`https://lago.test/api/v1/invoices?${invoiceQuery}`, {
      headers: { Authorization: authorization.Authorization },
    });
    expect(invoices.status).toBe(200);
    const invoiceBody = await invoices.json<{
      invoices: Array<{
        lago_id: string;
        payment_status: string;
        status: string;
        total_due_amount_cents: number;
      }>;
      meta: { total_count: number };
    }>();
    expect(invoiceBody.meta.total_count).toBe(1);
    expect(invoiceBody.invoices[0]).toMatchObject({
      status: "finalized",
      payment_status: "pending",
      total_due_amount_cents: 1999,
    });

    const invoiceId = invoiceBody.invoices[0]?.lago_id;
    expect(invoiceId).toBeTruthy();
    await env.BILLING_DB.prepare(
      `INSERT INTO payment_links
       (invoice_id, provider, provider_account_code, payment_url, provider_token_sha256,
        expires_at, created_at, updated_at)
       VALUES (?, 'authorize_net', 'paymentcloud-authorize-net',
               'https://lago.test/authorize_net/payment_form?token=synthetic&environment=sandbox',
               'synthetic-hash', NULL, ?, ?)`,
    )
      .bind(invoiceId, nowIso(), nowIso())
      .run();

    const paymentUrl = await SELF.fetch(
      `https://lago.test/api/v1/invoices/${invoiceId}/payment_url`,
      {
        method: "POST",
        headers: authorization,
        body: JSON.stringify(paymentUrlRequest),
      },
    );
    expect(paymentUrl.status).toBe(200);
    await expect(paymentUrl.json()).resolves.toMatchObject({
      invoice_payment_details: {
        lago_invoice_id: invoiceId,
        external_customer_id: "store_safe_email_customer_example_com",
        payment_provider: "authorize_net",
        payment_url:
          "https://lago.test/authorize_net/payment_form?token=synthetic&environment=sandbox",
      },
    });

    const updatedCustomer = await SELF.fetch("https://lago.test/api/v1/customers", {
      method: "POST",
      headers: authorization,
      body: JSON.stringify({
        ...customerRequest,
        customer: { ...customerRequest.customer, name: "Updated Synthetic Customer" },
      }),
    });
    expect(updatedCustomer.status).toBe(200);
    await expect(updatedCustomer.json()).resolves.toMatchObject({
      customer: {
        lago_id: firstCustomerBody.customer.lago_id,
        name: "Updated Synthetic Customer",
        email: "customer@example.com",
        version_number: 2,
        billing_configuration: { payment_provider: "authorize_net" },
      },
    });
    const customerEvents = await env.BILLING_DB.prepare(
      `SELECT event_type, aggregate_version FROM outbox_events
       WHERE aggregate_type = 'customer' AND aggregate_id = ? ORDER BY aggregate_version`,
    )
      .bind(firstCustomerBody.customer.lago_id)
      .all();
    expect(customerEvents.results).toEqual([
      { event_type: "customer.created", aggregate_version: 1 },
      { event_type: "customer.updated", aggregate_version: 2 },
    ]);
  });

  it("rejects customer provider modes the Cloudflare checkout path cannot honor", async () => {
    const response = await SELF.fetch("https://lago.test/api/v1/customers", {
      method: "POST",
      headers: authorization,
      body: JSON.stringify({
        customer: {
          external_id: "unsupported-provider-customer",
          billing_configuration: {
            payment_provider: "stripe",
            payment_provider_code: "stripe-default",
          },
        },
      }),
    });
    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toMatchObject({ code: "unsupported_payment_provider" });
  });

  it("stores and returns a nullable customer net payment term", async () => {
    const response = await SELF.fetch("https://lago.test/api/v1/customers", {
      method: "POST",
      headers: authorization,
      body: JSON.stringify({
        customer: {
          external_id: "customer-with-payment-term",
          name: "Payment Terms Customer",
          net_payment_term: 30,
        },
      }),
    });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      customer: { external_id: "customer-with-payment-term", net_payment_term: 30 },
    });

    const invalid = await SELF.fetch("https://lago.test/api/v1/customers", {
      method: "POST",
      headers: authorization,
      body: JSON.stringify({
        customer: { external_id: "customer-with-invalid-term", net_payment_term: -1 },
      }),
    });
    expect(invalid.status).toBe(422);
    await expect(invalid.json()).resolves.toMatchObject({
      code: "validation_error",
      message: "net_payment_term must be a non-negative integer",
    });
  });

  it("rejects an invalid API key without revealing whether resources exist", async () => {
    const response = await SELF.fetch("https://lago.test/api/v1/invoices", {
      headers: { Authorization: "Bearer incorrect" },
    });
    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toMatchObject({ code: "unauthorized" });
  });

  it("keeps provider mutations disabled by default", async () => {
    const customerId = "customer-disabled-test";
    const invoiceId = "invoice-disabled-test";
    const now = nowIso();
    await env.BILLING_DB.batch([
      env.BILLING_DB.prepare(
        `INSERT INTO customers
         (id, organization_id, external_id, email, name, currency, metadata_json,
          payment_provider, payment_provider_code, created_at, updated_at)
         VALUES (?, 'org-test', 'disabled-test', NULL, NULL, 'USD', '{}',
                 'authorize_net', 'paymentcloud-authorize-net', ?, ?)`,
      ).bind(customerId, now, now),
      env.BILLING_DB.prepare(
        `INSERT INTO invoices
         (id, organization_id, customer_id, subscription_id, number, status, payment_status,
          currency, subtotal_minor, tax_minor, credits_minor, total_due_minor, version,
          finalized_at, created_at, updated_at)
         VALUES (?, 'org-test', ?, NULL, 'DISABLED-TEST', 'finalized', 'pending',
                 'USD', 1000, 0, 0, 1000, 1, ?, ?, ?)`,
      ).bind(invoiceId, customerId, now, now, now),
    ]);

    const response = await SELF.fetch(
      `https://lago.test/api/v1/invoices/${invoiceId}/payment_url`,
      {
        method: "POST",
        headers: authorization,
        body: "{}",
      },
    );
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({ code: "payment_mutations_disabled" });
  });

  it("does not expose invoices across organization boundaries", async () => {
    const now = nowIso();
    const otherApiKey = "other-org-api-key";
    await env.BILLING_DB.batch([
      env.BILLING_DB.prepare(
        `INSERT OR IGNORE INTO organizations (id, external_id, name, created_at, updated_at)
         VALUES ('org-other', 'other', 'Other Organization', ?, ?)`,
      ).bind(now, now),
      env.BILLING_DB.prepare(
        `INSERT OR IGNORE INTO api_keys
         (id, organization_id, key_prefix, key_hash, created_at, revoked_at)
         VALUES ('key-other', 'org-other', 'other', ?, ?, NULL)`,
      ).bind(await sha256Hex(otherApiKey), now),
    ]);

    const response = await SELF.fetch(
      "https://lago.test/api/v1/invoices/invoice-disabled-test/payment_url",
      {
        method: "POST",
        headers: { Authorization: `Bearer ${otherApiKey}`, "Content-Type": "application/json" },
        body: "{}",
      },
    );
    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({ code: "invoice_not_found" });
  });

  it("rejects oversized JSON before parsing it", async () => {
    const response = await SELF.fetch("https://lago.test/api/v1/customers", {
      method: "POST",
      headers: {
        ...authorization,
        "Content-Length": String(256 * 1024 + 1),
      },
      body: "{}",
    });
    expect(response.status).toBe(413);
    await expect(response.json()).resolves.toMatchObject({ code: "payload_too_large" });
  });
});

function nowIso(): string {
  return new Date().toISOString();
}
