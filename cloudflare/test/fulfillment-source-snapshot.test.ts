import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { handleFulfillmentSourceRequest } from "../src/api/fulfillment-source";
import {
  listFulfillmentSourcesForRefresh,
  materializeFulfillmentSourceSnapshot,
} from "../src/billing/fulfillment-source-snapshot";

const NOW = "2026-09-07T12:00:00.000Z";
const SCOPE = { providerCode: "epd-qa", mode: "test" as const };

async function fixture(interval = "monthly") {
  const id = crypto.randomUUID();
  const db = env.BILLING_DB;
  await db.batch([
    db
      .prepare(
        "INSERT INTO organizations (id, external_id, name, created_at, updated_at) VALUES (?, ?, 'Snapshot QA', ?, ?)",
      )
      .bind(id, id, NOW, NOW),
    db
      .prepare(
        "INSERT INTO customers (id, organization_id, external_id, email, created_at, updated_at) VALUES (?, ?, ?, 'fictional@example.invalid', ?, ?)",
      )
      .bind(id, id, id, NOW, NOW),
    db
      .prepare(
        "INSERT INTO plans (id, organization_id, code, name, interval, amount_minor, currency, created_at, updated_at) VALUES (?, ?, ?, 'QA', ?, 900, 'USD', ?, ?)",
      )
      .bind(id, id, id, interval, NOW, NOW),
    db
      .prepare(
        "INSERT INTO subscriptions (id, organization_id, customer_id, plan_id, external_id, status, started_at, current_period_start, current_period_end, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'active', ?, ?, '2026-10-01T00:00:00.000Z', ?, ?)",
      )
      .bind(id, id, id, id, id, NOW, NOW, NOW, NOW),
  ]);
  const invoice = async (start = "2026-09-01T00:00:00.000Z", end = "2026-10-01T00:00:00.000Z") => {
    const invoiceId = crypto.randomUUID();
    await db.batch([
      db
        .prepare(
          "INSERT INTO invoices (id, organization_id, customer_id, subscription_id, status, payment_status, currency, subtotal_minor, total_due_minor, created_at, updated_at) VALUES (?, ?, ?, ?, 'finalized', 'succeeded', 'USD', 900, 900, ?, ?)",
        )
        .bind(invoiceId, id, id, id, NOW, NOW),
      db
        .prepare(
          "INSERT INTO invoice_subscriptions (invoice_id, subscription_id, organization_id, invoicing_reason, period_start, period_end, created_at) VALUES (?, ?, ?, 'subscription_starting', ?, ?, ?)",
        )
        .bind(invoiceId, id, id, start, end, NOW),
      db
        .prepare(
          "INSERT INTO invoice_lines (id, invoice_id, line_type, description, quantity_decimal, unit_amount_decimal, amount_minor, source_type, source_id, metadata_json, created_at) VALUES (?, ?, 'subscription', 'QA', '1', '900', 900, 'plan', ?, ?, ?)",
        )
        .bind(
          invoiceId,
          invoiceId,
          id,
          JSON.stringify({ periodStart: start, periodEnd: end }),
          NOW,
        ),
      db
        .prepare(
          "INSERT INTO payment_attempts (id, organization_id, invoice_id, provider, provider_account_code, provider_transaction_id, idempotency_key, amount_minor, currency, status, created_at, updated_at) VALUES (?, ?, ?, 'easy_pay_direct', 'epd-qa', ?, ?, 900, 'USD', 'succeeded', ?, ?)",
        )
        .bind(invoiceId, id, invoiceId, invoiceId, invoiceId, NOW, NOW),
    ]);
    return invoiceId;
  };
  const refund = async (invoiceId: string, amount: number, status: string) => {
    const refundId = crypto.randomUUID();
    await db
      .prepare(`INSERT INTO provider_refund_operations
      (id, organization_id, invoice_id, payment_attempt_id, provider, provider_account_code,
       provider_payment_id, idempotency_key, request_sha256, amount_minor, currency, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, 'easy_pay_direct', 'epd-qa', ?, ?, 'fixture', ?, 'USD', ?, ?, ?)`)
      .bind(refundId, id, invoiceId, invoiceId, invoiceId, refundId, amount, status, NOW, NOW)
      .run();
    return refundId;
  };
  return {
    id,
    invoice,
    refund,
    read: (date = NOW) => materializeFulfillmentSourceSnapshot(db, id, id, SCOPE, new Date(date)),
  };
}

describe("atomic subscription source snapshot materialization", () => {
  it("finds due boundaries by their instant rather than timezone text order", async () => {
    const f = await fixture();
    await f.invoice("2026-09-08T00:00:00+14:00");
    await f.read("2026-09-07T08:00:00.000Z");
    expect(
      await listFulfillmentSourcesForRefresh(
        env.BILLING_DB,
        f.id,
        "2020-01-01T00:00:00Z",
        new Date(NOW),
      ),
    ).toEqual([f.id]);
  });
  it("never converts existing paid monthly coverage into permanent access when the plan is edited", async () => {
    const f = await fixture();
    await f.invoice();
    expect(await f.read()).toMatchObject({ eligible: true, planInterval: "monthly" });
    await env.BILLING_DB.prepare("UPDATE plans SET interval = 'one_time' WHERE id = ?")
      .bind(f.id)
      .run();
    expect(await f.read()).toMatchObject({
      eligible: false,
      held: true,
      holdReason: "source_identity_changed",
      planInterval: "monthly",
      paidThrough: "2026-10-01T00:00:00.000Z",
    });
    await env.BILLING_DB.prepare("UPDATE plans SET interval = 'monthly' WHERE id = ?")
      .bind(f.id)
      .run();
    const nextPlan = crypto.randomUUID();
    await env.BILLING_DB.prepare(
      "INSERT INTO plans (id,organization_id,code,name,interval,amount_minor,currency,created_at,updated_at) VALUES (?, ?, ?, 'Other QA', 'monthly', 900, 'USD', ?, ?)",
    )
      .bind(nextPlan, f.id, nextPlan, NOW, NOW)
      .run();
    await env.BILLING_DB.prepare("UPDATE subscriptions SET plan_id = ? WHERE id = ?")
      .bind(nextPlan, f.id)
      .run();
    expect(await f.read()).toMatchObject({
      eligible: false,
      held: true,
      holdReason: "source_identity_changed",
      planInterval: "monthly",
    });
  });
  it("preserves a one-time expiry and refuses future one-time coverage", async () => {
    const f = await fixture("one_time");
    await f.invoice("2026-09-09T00:00:00.000Z");
    await env.BILLING_DB.prepare("UPDATE subscriptions SET ending_at = ? WHERE id = ?")
      .bind("2026-09-12T00:00:00.000Z", f.id)
      .run();
    expect(await f.read()).toMatchObject({
      eligible: false,
      paidThrough: "2026-09-12T00:00:00.000Z",
    });
    expect(await f.read("2026-09-10T00:00:00.000Z")).toMatchObject({
      eligible: true,
      validFrom: "2026-09-09T00:00:00.000Z",
      paidThrough: "2026-09-12T00:00:00.000Z",
    });
    expect(await f.read("2026-09-12T00:00:00.000Z")).toMatchObject({ eligible: false });
  });

  it("holds conflicting account, overpayment and refund amount evidence", async () => {
    const f = await fixture();
    const id = await f.invoice();
    await env.BILLING_DB.prepare(
      "UPDATE payment_attempts SET provider_account_code = 'wrong' WHERE id = ?",
    )
      .bind(id)
      .run();
    expect(await f.read()).toMatchObject({
      eligible: false,
      held: true,
      holdReason: "ambiguous_evidence",
    });
    await env.BILLING_DB.prepare(
      "UPDATE payment_attempts SET provider_account_code = 'epd-qa', amount_minor = 1000 WHERE id = ?",
    )
      .bind(id)
      .run();
    expect(await f.read()).toMatchObject({ eligible: false, held: true });
    await env.BILLING_DB.prepare("UPDATE payment_attempts SET amount_minor = 900 WHERE id = ?")
      .bind(id)
      .run();
    await f.refund(id, 1000, "succeeded");
    expect(await f.read()).toMatchObject({ eligible: false, held: true });
  });

  it("pins mode, provider and customer identity across later edits", async () => {
    const f = await fixture();
    await f.invoice();
    await f.read();
    expect(
      await materializeFulfillmentSourceSnapshot(
        env.BILLING_DB,
        f.id,
        f.id,
        { providerCode: "other", mode: "live" },
        new Date(NOW),
      ),
    ).toMatchObject({
      eligible: false,
      held: true,
      holdReason: "source_identity_changed",
      providerCode: "epd-qa",
      mode: "test",
    });
    await env.BILLING_DB.prepare(
      "UPDATE customers SET email = 'changed@example.invalid' WHERE id = ?",
    )
      .bind(f.id)
      .run();
    expect(await f.read()).toMatchObject({
      eligible: false,
      held: true,
      customerEmail: "fictional@example.invalid",
    });
  });

  it("checks an immutable invoice pin inside materialization and survives source deletion", async () => {
    const f = await fixture();
    const invoiceId = await f.invoice();
    const scope = {
      ...SCOPE,
      pin: { invoiceId, externalCustomerId: f.id, externalSubscriptionId: f.id },
    };
    const read = () =>
      materializeFulfillmentSourceSnapshot(env.BILLING_DB, f.id, f.id, scope, new Date(NOW));
    expect(await read()).toMatchObject({ eligible: true });
    await expect(
      materializeFulfillmentSourceSnapshot(
        env.BILLING_DB,
        f.id,
        f.id,
        { ...scope, pin: { ...scope.pin, externalCustomerId: "wrong" } },
        new Date(NOW),
      ),
    ).rejects.toMatchObject({ status: 404 });
    expect(await read()).toMatchObject({ revision: 1 });
    await env.BILLING_DB.prepare("DELETE FROM invoice_subscriptions WHERE subscription_id = ?")
      .bind(f.id)
      .run();
    await env.BILLING_DB.prepare("UPDATE invoices SET subscription_id = NULL WHERE id = ?")
      .bind(invoiceId)
      .run();
    await env.BILLING_DB.prepare("DELETE FROM subscriptions WHERE id = ?").bind(f.id).run();
    expect(await read()).toMatchObject({
      eligible: false,
      subscriptionStatus: "deleted",
      customerId: f.id,
      customerEmail: "fictional@example.invalid",
      currency: "USD",
      providerCode: "epd-qa",
      mode: "test",
    });
  });

  it("exposes only the authenticated configured tenant and rejects caller mode overrides", async () => {
    const f = await fixture();
    const invoiceId = await f.invoice("2020-01-01T00:00:00.000Z", "2099-01-01T00:00:00.000Z");
    const configured = {
      ...env,
      EASY_PAY_DIRECT_ACCOUNT_CODE: "epd-qa",
      EASY_PAY_DIRECT_NETWORK_MODE: "gateway_test",
      EASY_PAY_DIRECT_ORGANIZATION_ID: f.id,
    } as unknown as Env;
    const auth = { organizationId: f.id, organizationExternalId: f.id, apiKeyId: "qa" };
    const request = (body: unknown) =>
      new Request(`https://qa.invalid/api/v1/subscriptions/${f.id}/fulfillment-source`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
    const body = { invoiceId, externalCustomerId: f.id };
    const response = await handleFulfillmentSourceRequest(request(body), configured, auth, "qa");
    expect(await response!.json()).toMatchObject({
      fulfillmentSource: {
        eligible: true,
        mode: "test",
        providerCode: "epd-qa",
        customerEmail: "fictional@example.invalid",
        currency: "USD",
      },
    });
    await expect(
      handleFulfillmentSourceRequest(request({ ...body, mode: "live" }), configured, auth, "qa"),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      handleFulfillmentSourceRequest(
        request({ ...body, externalCustomerId: "wrong" }),
        configured,
        auth,
        "qa",
      ),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      handleFulfillmentSourceRequest(
        request(body),
        configured,
        { ...auth, organizationId: "other" },
        "qa",
      ),
    ).rejects.toMatchObject({ status: 503 });
  });
  it("creates immutable revision one and reuses it for unchanged reads", async () => {
    const f = await fixture();
    const invoice = await f.invoice();
    const first = await f.read();
    expect(first).toMatchObject({
      revision: 1,
      sourceId: f.id,
      eligible: true,
      held: false,
      holdReason: null,
      paidThrough: "2026-10-01T00:00:00.000Z",
      evidenceInvoiceIds: [invoice],
      paidAmountMinor: 900,
    });
    expect(await f.read("2026-09-08T12:00:00.000Z")).toEqual(first);
    expect(
      await env.BILLING_DB.prepare(
        "SELECT COUNT(*) AS count FROM fulfillment_source_snapshot_history WHERE organization_id = ?",
      )
        .bind(f.id)
        .first(),
    ).toEqual({ count: 1 });
    await expect(
      env.BILLING_DB.prepare(
        "UPDATE fulfillment_source_snapshot_history SET payload_json = '{}' WHERE organization_id = ?",
      )
        .bind(f.id)
        .run(),
    ).rejects.toThrow("immutable_fulfillment_source_snapshot");
  });

  it("serializes duplicate concurrent materializers without inventing revisions", async () => {
    const f = await fixture();
    await f.invoice();
    const results = await Promise.all(Array.from({ length: 8 }, () => f.read()));
    expect(results.every((result) => result.revision === 1 && result.eligible)).toBe(true);
    await env.BILLING_DB.prepare("UPDATE subscriptions SET status = 'canceled' WHERE id = ?")
      .bind(f.id)
      .run();
    const canceled = await f.read();
    expect(canceled).toMatchObject({
      revision: 2,
      eligible: false,
      inactiveReason: "subscription_inactive",
    });
    expect(await f.read()).toEqual(canceled);
  });

  it("preserves partial-refund access and removes only fully refunded invoice coverage", async () => {
    const f = await fixture();
    const invoice = await f.invoice();
    await f.refund(invoice, 450, "succeeded");
    expect(await f.read()).toMatchObject({ eligible: true, held: false, refundedAmountMinor: 450 });
    await f.refund(invoice, 450, "succeeded");
    expect(await f.read()).toMatchObject({
      eligible: false,
      held: false,
      refundedAmountMinor: 900,
      evidenceInvoiceIds: [],
    });
  });

  it.each(["succeeded", "submitted", "pending"])(
    "does not let an older %s refund erase independent newer coverage",
    async (status) => {
      const f = await fixture();
      const old = await f.invoice("2026-08-01T00:00:00.000Z", "2026-09-01T00:00:00.000Z");
      const current = await f.invoice();
      await f.refund(old, 900, status);
      expect(await f.read()).toMatchObject({
        eligible: true,
        held: false,
        holdReason: null,
        evidenceInvoiceIds: [current],
        paidAmountMinor: 1800,
        refundedAmountMinor: status === "succeeded" ? 900 : 0,
      });
    },
  );

  it.each(["pending", "submitted"])(
    "holds uncertain current %s refund coverage, then recovers after definitive failure",
    async (status) => {
      const f = await fixture();
      const invoice = await f.invoice();
      const refund = await f.refund(invoice, 450, status);
      expect(await f.read()).toMatchObject({
        revision: 1,
        eligible: false,
        held: true,
        holdReason: "refund_review",
        refundedAmountMinor: 0,
        pendingRefundAmountMinor: 450,
      });
      await env.BILLING_DB.prepare(
        "UPDATE provider_refund_operations SET status = 'failed' WHERE id = ?",
      )
        .bind(refund)
        .run();
      expect(await f.read()).toMatchObject({ revision: 2, eligible: true, held: false });
    },
  );

  it("joins contiguous paid intervals, but never bridges an unpaid gap", async () => {
    const f = await fixture();
    const first = await f.invoice();
    const next = await f.invoice("2026-10-01T00:00:00.000Z", "2026-11-01T00:00:00.000Z");
    await f.invoice("2026-12-01T00:00:00.000Z", "2027-01-01T00:00:00.000Z");
    expect(await f.read()).toMatchObject({
      eligible: true,
      paidThrough: "2026-11-01T00:00:00.000Z",
      evidenceInvoiceIds: [first, next].sort(),
    });
  });

  it("revises at start/expiry boundaries and fences an older concurrent evaluation clock", async () => {
    const f = await fixture();
    await f.invoice("2026-10-01T00:00:00.000Z", "2026-11-01T00:00:00.000Z");
    expect(await f.read()).toMatchObject({
      revision: 1,
      eligible: false,
      nextBoundaryAt: "2026-10-01T00:00:00.000Z",
    });
    expect(await f.read("2026-10-01T00:00:00.000Z")).toMatchObject({ revision: 2, eligible: true });
    const expired = await f.read("2026-11-01T00:00:00.000Z");
    expect(expired).toMatchObject({ revision: 3, eligible: false });
    expect(await f.read("2026-10-15T00:00:00.000Z")).toEqual(expired);
  });

  it("caps scheduled cancellation and honors immediate closure holds", async () => {
    const f = await fixture();
    await f.invoice();
    await env.BILLING_DB.prepare(
      "UPDATE subscriptions SET ending_at = '2026-09-15T00:00:00.000Z' WHERE id = ?",
    )
      .bind(f.id)
      .run();
    expect(await f.read()).toMatchObject({
      eligible: true,
      paidThrough: "2026-09-15T00:00:00.000Z",
    });
    await env.BILLING_DB.prepare(
      "INSERT INTO customer_closure_holds (customer_id, organization_id) VALUES (?, ?)",
    )
      .bind(f.id, f.id)
      .run();
    expect(await f.read()).toMatchObject({ eligible: false, held: true, holdReason: "closure" });
  });

  it("allows one-time paid access without a renewable expiry", async () => {
    const f = await fixture("one_time");
    await f.invoice();
    expect(await f.read()).toMatchObject({
      eligible: true,
      paidThrough: null,
      planInterval: "one_time",
    });
  });

  it("isolates source tenants and lists only due known sources for polling", async () => {
    const f = await fixture();
    await f.invoice();
    await f.read();
    const other = await fixture();
    await other.invoice();
    await other.read();
    await expect(
      materializeFulfillmentSourceSnapshot(env.BILLING_DB, other.id, f.id, SCOPE, new Date(NOW)),
    ).rejects.toMatchObject({ status: 404 });
    expect(
      await listFulfillmentSourcesForRefresh(env.BILLING_DB, f.id, NOW, new Date(NOW)),
    ).toEqual([f.id]);
    expect(
      await listFulfillmentSourcesForRefresh(
        env.BILLING_DB,
        f.id,
        "2026-09-01T00:00:00.000Z",
        new Date(NOW),
      ),
    ).toEqual([]);
  });

  it("denies insufficient money evidence and never grants a usage-only invoice", async () => {
    const f = await fixture();
    const invoice = await f.invoice();
    await env.BILLING_DB.prepare("UPDATE payment_attempts SET amount_minor = 1 WHERE id = ?")
      .bind(invoice)
      .run();
    expect(await f.read()).toMatchObject({
      eligible: false,
      held: true,
      holdReason: "ambiguous_evidence",
    });
    await env.BILLING_DB.prepare("UPDATE payment_attempts SET amount_minor = 900 WHERE id = ?")
      .bind(invoice)
      .run();
    await env.BILLING_DB.prepare(
      "UPDATE invoice_lines SET line_type = 'usage', source_type = 'charge' WHERE id = ?",
    )
      .bind(invoice)
      .run();
    expect(await f.read()).toMatchObject({ eligible: false, evidenceInvoiceIds: [] });
  });
});
