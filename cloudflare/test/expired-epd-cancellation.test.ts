import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { terminateSubscriptionWithoutInvoice } from "../src/billing/terminate-subscription";
import { handleSubscriptionLifecycleRequest } from "../src/api/subscription-lifecycle";
import { materializeFulfillmentSourceSnapshot } from "../src/billing/fulfillment-source-snapshot";

const now = "2026-09-08T00:00:00.000Z";
const start = "2026-07-01T00:00:00.000Z";
const end = "2026-08-01T00:00:00.000Z";
let id: string;
const db = env.BILLING_DB;
async function invoice(
  suffix = "invoice",
  periodEnd: unknown = end,
  metadata?: string,
  subscriptionId = id,
) {
  const invoiceId = `${id}-${suffix}`;
  await db.batch([
    db
      .prepare(`INSERT INTO invoices (id, organization_id, customer_id, subscription_id, status, payment_status,
      currency, subtotal_minor, total_due_minor, finalized_at, created_at, updated_at)
      VALUES (?, ?, ?, ?, 'finalized', 'succeeded', 'USD', 900, 900, ?, ?, ?)`)
      .bind(invoiceId, id, id, subscriptionId, now, now, now),
    db
      .prepare(`INSERT INTO invoice_lines (id, invoice_id, line_type, description, quantity_decimal, unit_amount_decimal,
      amount_minor, source_type, source_id, metadata_json, created_at)
      VALUES (?, ?, 'subscription', 'Monthly fixture', '1', '900', 900, 'plan', ?, ?, ?)`)
      .bind(
        `${invoiceId}-line`,
        invoiceId,
        id,
        metadata ?? JSON.stringify({ periodStart: start, periodEnd }),
        now,
      ),
    db
      .prepare(`INSERT INTO invoice_subscriptions (invoice_id, subscription_id, organization_id, invoicing_reason, period_start, period_end, created_at)
      VALUES (?, ?, ?, 'subscription_periodic', ?, ?, ?)`)
      .bind(
        invoiceId,
        subscriptionId,
        id,
        start,
        typeof periodEnd === "string" ? periodEnd : null,
        now,
      ),
    db
      .prepare(`INSERT INTO payment_attempts (id, organization_id, invoice_id, provider, provider_account_code,
      provider_transaction_id, idempotency_key, amount_minor, currency, status, created_at, updated_at)
      VALUES (?, ?, ?, 'easy_pay_direct', 'epd-test', ?, ?, 900, 'USD', 'succeeded', ?, ?)`)
      .bind(`${invoiceId}-paid`, id, invoiceId, `${invoiceId}-paid`, `${invoiceId}-paid`, now, now),
  ]);
  return invoiceId;
}
beforeEach(async () => {
  id = crypto.randomUUID();
  await db.batch([
    db
      .prepare(
        "INSERT INTO organizations (id, external_id, name, created_at, updated_at) VALUES (?, ?, 'Fixture', ?, ?)",
      )
      .bind(id, id, now, now),
    db
      .prepare(`INSERT INTO customers (id, organization_id, external_id, email, currency, payment_provider, payment_provider_code, created_at, updated_at)
      VALUES (?, ?, ?, 'qa@example.invalid', 'USD', 'easy_pay_direct', 'epd-test', ?, ?)`)
      .bind(id, id, id, now, now),
    db
      .prepare(`INSERT INTO plans (id, organization_id, code, name, interval, amount_minor, currency, active, created_at, updated_at)
      VALUES (?, ?, ?, 'Monthly', 'monthly', 900, 'USD', 1, ?, ?)`)
      .bind(id, id, id, now, now),
    db
      .prepare(`INSERT INTO subscriptions (id, organization_id, customer_id, plan_id, external_id, status, started_at,
      current_period_start, current_period_end, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, ?)`)
      .bind(id, id, id, id, id, start, start, end, now, now),
    db
      .prepare(`INSERT INTO subscriptions (id, organization_id, customer_id, plan_id, external_id, previous_subscription_id, generation, transition_kind, status,
      current_period_start, current_period_end, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, 2, 'downgrade', 'pending', ?, ?, ?, ?)`)
      .bind(`${id}-child`, id, id, id, `${id}-child`, id, start, end, now, now),
  ]);
  await invoice();
});
const guard = () => ({ subscriptionId: id, externalCustomerId: id, periodEnd: end });
const terminate = (database = db) =>
  terminateSubscriptionWithoutInvoice(
    { BILLING_DB: database, DOMAIN_EVENTS: env.DOMAIN_EVENTS },
    id,
    1,
    now,
    crypto.randomUUID(),
    false,
    { creditNote: "skip", invoice: "skip" },
    guard(),
  );
async function unchanged() {
  expect(
    await db.prepare("SELECT status, version FROM subscriptions WHERE id = ?").bind(id).first(),
  ).toEqual({ status: "active", version: 1 });
  expect(
    await db.prepare("SELECT status FROM subscriptions WHERE id = ?").bind(`${id}-child`).first(),
  ).toEqual({ status: "pending" });
  expect(
    await db
      .prepare("SELECT COUNT(*) AS count FROM outbox_events WHERE aggregate_id = ?")
      .bind(id)
      .first(),
  ).toEqual({ count: 0 });
  expect(
    await db.prepare("SELECT COUNT(*) AS count FROM expired_epd_cancellation_fences").first(),
  ).toEqual({ count: 0 });
}
describe("transaction-fenced expired EPD cancellation", () => {
  it.each(["active", "past_due"])(
    "terminates expired %s while preserving independent subscription coverage",
    async (status) => {
      await db.prepare("UPDATE subscriptions SET status = ? WHERE id = ?").bind(status, id).run();
      await db
        .prepare(`INSERT INTO subscriptions (id, organization_id, customer_id, plan_id, external_id, status, current_period_start, current_period_end, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, 'active', ?, '2099-01-01T00:00:00Z', ?, ?)`)
        .bind(`${id}-independent`, id, id, id, `${id}-independent`, start, now, now)
        .run();
      await invoice("independent-invoice", "2099-01-01T00:00:00Z", undefined, `${id}-independent`);
      const before = await materializeFulfillmentSourceSnapshot(
        db,
        id,
        `${id}-independent`,
        { providerCode: "epd-test", mode: "test" },
        new Date(now),
      );
      expect(before.eligible).toBe(true);
      await terminate();
      expect(
        await db
          .prepare(
            "SELECT status, on_termination_invoice, on_termination_credit_note FROM subscriptions WHERE id = ?",
          )
          .bind(id)
          .first(),
      ).toEqual({
        status: "terminated",
        on_termination_invoice: "skip",
        on_termination_credit_note: "skip",
      });
      expect(
        await db
          .prepare("SELECT status FROM subscriptions WHERE id = ?")
          .bind(`${id}-child`)
          .first(),
      ).toEqual({ status: "canceled" });
      expect(
        await db
          .prepare("SELECT status FROM subscriptions WHERE id = ?")
          .bind(`${id}-independent`)
          .first(),
      ).toEqual({ status: "active" });
      const after = await materializeFulfillmentSourceSnapshot(
        db,
        id,
        `${id}-independent`,
        { providerCode: "epd-test", mode: "test" },
        new Date(now),
      );
      expect(after.eligible).toBe(true);
      expect(after.paidThrough).toBe(before.paidThrough);
      expect(
        await db
          .prepare("SELECT COUNT(*) AS count FROM invoices WHERE subscription_id = ?")
          .bind(id)
          .first(),
      ).toEqual({ count: 1 });
      expect(
        await db.prepare("SELECT COUNT(*) AS count FROM expired_epd_cancellation_fences").first(),
      ).toEqual({ count: 0 });
    },
  );
  it.each(["2099-01-01T00:00:00Z", null, "not-a-date", start, 1])(
    "holds future or malformed plan coverage %s without child or outbox effects",
    async (date) => {
      await invoice("later", date);
      await expect(terminate()).rejects.toThrow("expired_epd_cancellation_current");
      await unchanged();
    },
  );
  it("holds malformed plan metadata", async () => {
    await invoice("bad", end, "{bad");
    await expect(terminate()).rejects.toThrow("expired_epd_cancellation_current");
    await unchanged();
  });
  it.each(["intent_recorded", "submitted", "requires_action", "unknown"])(
    "holds uncertain invoice payment %s",
    async (status) => {
      await db
        .prepare(`INSERT INTO payment_attempts (id, organization_id, invoice_id, provider, provider_account_code,
      idempotency_key, amount_minor, currency, status, created_at, updated_at)
      VALUES (?, ?, ?, 'easy_pay_direct', 'epd-test', ?, 900, 'USD', ?, ?, ?)`)
        .bind(`${id}-payment`, id, `${id}-invoice`, `${id}-payment`, status, now, now)
        .run();
      await expect(terminate()).rejects.toThrow("expired_epd_cancellation_current");
      await unchanged();
    },
  );
  it.each(["pending", "unknown"])("holds uncertain aggregate payment %s", async (status) => {
    await db.batch([
      db
        .prepare(
          "INSERT INTO payment_requests (id, organization_id, customer_id, amount_minor, currency, created_at, updated_at) VALUES (?, ?, ?, 900, 'USD', ?, ?)",
        )
        .bind(id, id, id, now, now),
      db
        .prepare(`INSERT INTO payment_request_payments (id, organization_id, payment_request_id, provider, provider_account_code,
        provider_transaction_id, idempotency_key, amount_minor, currency, status, created_at, updated_at)
        VALUES (?, ?, ?, 'easy_pay_direct', 'epd-test', ?, ?, 900, 'USD', ?, ?, ?)`)
        .bind(id, id, id, id, id, status, now, now),
    ]);
    await expect(terminate()).rejects.toThrow("expired_epd_cancellation_current");
    await unchanged();
  });
  it.each(["pending", "processing", "unknown"])(
    "holds EPD execution %s even without a recorded provider payment",
    async (status) => {
      await db.batch([
        db
          .prepare(
            "INSERT INTO payment_requests (id, organization_id, customer_id, amount_minor, currency, created_at, updated_at) VALUES (?, ?, ?, 900, 'USD', ?, ?)",
          )
          .bind(id, id, id, now, now),
        db
          .prepare(`INSERT INTO payment_request_checkout_intents (id, organization_id, payment_request_id, customer_id, provider, provider_account_code,
        idempotency_key, request_sha256, amount_minor, currency, payment_request_version, status, payment_url, provider_token_sha256, created_at, updated_at)
        VALUES (?, ?, ?, ?, 'easy_pay_direct', 'epd-test', ?, 'hash', 900, 'USD', 1, 'succeeded', 'https://fixture.invalid', 'token', ?, ?)`)
          .bind(id, id, id, id, id, now, now),
        db
          .prepare(`INSERT INTO easy_pay_direct_payment_executions (id, organization_id, checkout_intent_id, payment_request_id, provider_account_code,
        request_sha256, payment_token_sha256, phone_sha256, customer_idempotency_key, payment_method_idempotency_key,
        product_idempotency_key, order_idempotency_key, status, created_at, updated_at)
        VALUES (?, ?, ?, ?, 'epd-test', 'hash', 'token', 'phone', 'customer', 'method', 'product', 'order', ?, ?, ?)`)
          .bind(id, id, id, id, status, now, now),
      ]);
      await expect(terminate()).rejects.toThrow("expired_epd_cancellation_current");
      await unchanged();
    },
  );
  it("holds pending checkout creation instead of inferring no payment can occur", async () => {
    await db.batch([
      db
        .prepare(
          "INSERT INTO payment_requests (id, organization_id, customer_id, amount_minor, currency, created_at, updated_at) VALUES (?, ?, ?, 900, 'USD', ?, ?)",
        )
        .bind(id, id, id, now, now),
      db
        .prepare(`INSERT INTO payment_request_checkout_intents (id, organization_id, payment_request_id, customer_id, provider, provider_account_code,
        idempotency_key, request_sha256, amount_minor, currency, payment_request_version, status, created_at, updated_at)
        VALUES (?, ?, ?, ?, 'easy_pay_direct', 'epd-test', ?, 'hash', 900, 'USD', 1, 'pending', ?, ?)`)
        .bind(id, id, id, id, id, now, now),
    ]);
    await expect(terminate()).rejects.toThrow("expired_epd_cancellation_current");
    await unchanged();
  });
  it("rechecks a newly paid future invoice in the termination transaction after the initial read", async () => {
    const raced = {
      prepare: db.prepare.bind(db),
      batch: async (statements: D1PreparedStatement[]) => {
        await invoice("concurrent-paid", "2099-01-01T00:00:00Z");
        return db.batch(statements);
      },
    } as D1Database;
    await expect(terminate(raced)).rejects.toThrow("expired_epd_cancellation_current");
    await unchanged();
  });
  it("rechecks a provider switch before committing", async () => {
    const raced = {
      prepare: db.prepare.bind(db),
      batch: async (statements: D1PreparedStatement[]) => {
        await db
          .prepare("UPDATE customers SET payment_provider = 'stripe' WHERE id = ?")
          .bind(id)
          .run();
        return db.batch(statements);
      },
    } as D1Database;
    await expect(terminate(raced)).rejects.toThrow("expired_epd_cancellation_current");
    await unchanged();
  });
  it.each(["pending", "processing", "unknown"])(
    "holds automatic execution %s with no payment ledger row",
    async (status) => {
      await db.batch([
        db
          .prepare(
            "INSERT INTO payment_requests (id, organization_id, customer_id, amount_minor, currency, created_at, updated_at) VALUES (?, ?, ?, 900, 'USD', ?, ?)",
          )
          .bind(id, id, id, now, now),
        db
          .prepare(`INSERT INTO provider_customer_profiles (id, organization_id, customer_id, provider, provider_account_code,
        provider_customer_id, gateway_customer_vault_id, initial_transaction_id, status, created_at, updated_at)
        VALUES (?, ?, ?, 'easy_pay_direct', 'epd-test', ?, 'vault', 'initial', 'active', ?, ?)`)
          .bind(id, id, id, id, now, now),
        db
          .prepare(`INSERT INTO easy_pay_direct_automatic_payment_executions (id, organization_id, payment_request_id, customer_id,
        provider_profile_id, provider_account_code, request_sha256, gateway_customer_vault_id, initial_transaction_id,
        order_reference, status, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, 'epd-test', 'hash', 'vault', 'initial', ?, ?, ?, ?)`)
          .bind(id, id, id, id, id, id, status, now, now),
      ]);
      await expect(terminate()).rejects.toThrow("expired_epd_cancellation_current");
      await unchanged();
    },
  );
  it("does not cancel a pending successor that already has its own billed coverage", async () => {
    await invoice("successor-paid", "2099-01-01T00:00:00Z", undefined, `${id}-child`);
    await expect(terminate()).rejects.toThrow("expired_epd_cancellation_current");
    await unchanged();
  });
  it("advertises the guard and executes the explicit API contract idempotently", async () => {
    const auth = { organizationId: id, organizationExternalId: id, apiKeyId: "fixture" };
    const shown = await handleSubscriptionLifecycleRequest(
      new Request(`https://billing.invalid/api/v1/subscriptions/${id}`),
      env,
      auth,
      "show",
    );
    expect(await shown!.json()).toMatchObject({
      subscription: { expired_cancellation_guard_version: 1 },
    });
    const params = new URLSearchParams({
      only_if_expired: "true",
      expected_subscription_id: id,
      expected_customer_id: id,
      expected_period_end: end,
      on_termination_invoice: "skip",
      on_termination_credit_note: "skip",
    });
    for (let i = 0; i < 2; i++) {
      const response = await handleSubscriptionLifecycleRequest(
        new Request(`https://billing.invalid/api/v1/subscriptions/${id}?${params}`, {
          method: "DELETE",
        }),
        env,
        auth,
        `cancel-${i}`,
      );
      expect(response!.status).toBe(200);
      expect(await response!.json()).toMatchObject({ subscription: { status: "terminated" } });
    }
  });
  it("returns a review conflict from the real API when paid coverage is later than the stored period", async () => {
    await invoice("new-paid", "2099-01-01T00:00:00Z");
    const params = new URLSearchParams({
      only_if_expired: "true",
      expected_subscription_id: id,
      expected_customer_id: id,
      expected_period_end: end,
      on_termination_invoice: "skip",
      on_termination_credit_note: "skip",
    });
    await expect(
      handleSubscriptionLifecycleRequest(
        new Request(`https://billing.invalid/api/v1/subscriptions/${id}?${params}`, {
          method: "DELETE",
        }),
        env,
        { organizationId: id, organizationExternalId: id, apiKeyId: "fixture" },
        crypto.randomUUID(),
      ),
    ).rejects.toMatchObject({ status: 409, code: "expired_cancellation_requires_review" });
    await unchanged();
  });
});
