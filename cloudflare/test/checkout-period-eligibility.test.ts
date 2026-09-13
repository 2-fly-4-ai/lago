import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { closeBillingPeriod, dueBillingPeriodsForClosing } from "../src/billing/close-period";
import { handleOperatorAnalyticsRequest } from "../src/operator/analytics";

const start = "2026-07-31T00:00:00.000Z";
const end = "2026-08-31T00:00:00.000Z";

async function fixture(status = "pending", amount = 1000, kind = "prepaid") {
  const id = crypto.randomUUID();
  await env.BILLING_DB.batch([
    env.BILLING_DB.prepare(`INSERT INTO organizations (id,external_id,name,created_at,updated_at)
      VALUES (?,?,'Synthetic',?,?)`).bind(id, id, start, start),
    env.BILLING_DB.prepare(`INSERT INTO customers (id,organization_id,external_id,currency,created_at,updated_at)
      VALUES (?,?,?,'USD',?,?)`).bind(id, id, id, start, start),
    env.BILLING_DB.prepare(`INSERT INTO plans (id,organization_id,code,name,interval,amount_minor,currency,pay_in_advance,created_at,updated_at)
      VALUES (?,?,?,'Synthetic','monthly',1000,'USD',?,?,?)`).bind(
      id,
      id,
      id,
      kind === "postpaid" ? 0 : 1,
      start,
      start,
    ),
    env.BILLING_DB.prepare(`INSERT INTO subscriptions (id,organization_id,customer_id,plan_id,external_id,status,started_at,current_period_start,current_period_end,trial_started_at,trial_end_at,trial_ended_at,created_at,updated_at)
      VALUES (?,?,?,?,?,'active',?,?,?,?,?,?,?,?)`).bind(
      id,
      id,
      id,
      id,
      id,
      start,
      start,
      end,
      kind === "trial" ? start : null,
      kind === "trial" ? "2026-08-15T00:00:00.000Z" : null,
      kind === "trial" ? "2026-08-15T00:00:00.000Z" : null,
      start,
      start,
    ),
    env.BILLING_DB.prepare(`INSERT INTO subscription_checkout_products (subscription_id,organization_id,product_slug,created_at)
      VALUES (?,?,'synthetic',?)`).bind(id, id, start),
    env.BILLING_DB.prepare(`INSERT INTO invoices (id,organization_id,customer_id,subscription_id,number,status,payment_status,currency,subtotal_minor,total_due_minor,finalized_at,created_at,updated_at)
      VALUES (?,?,?,?,?,'finalized',?,'USD',?,?,?,?,?)`).bind(
      id,
      id,
      id,
      id,
      id,
      status,
      amount,
      amount,
      start,
      start,
      start,
    ),
    env.BILLING_DB.prepare(`INSERT INTO subscription_invoice_contexts (invoice_id,organization_id,subscription_id,context_type,period_start,period_end,created_at)
      VALUES (?,?,?,'initial',?,?,?)`).bind(id, id, id, start, end, start),
  ]);
  return id;
}

describe("Store initial payment billing gate", () => {
  it("blocks legacy EPD checkouts without product attribution and labels their unpaid invoice", async () => {
    const id = await fixture();
    await env.BILLING_DB.batch([
      env.BILLING_DB.prepare(
        "DELETE FROM subscription_checkout_products WHERE subscription_id = ?",
      ).bind(id),
      env.BILLING_DB.prepare(
        "UPDATE customers SET payment_provider = 'easy_pay_direct', payment_provider_code = 'synthetic' WHERE id = ?",
      ).bind(id),
      env.BILLING_DB.prepare(`INSERT INTO payment_requests
        (id,organization_id,customer_id,amount_minor,currency,collection_mode,created_at,updated_at)
        VALUES (?,?,?,1000,'USD','checkout',?,?)`).bind(id, id, id, start, start),
      env.BILLING_DB.prepare(`INSERT INTO invoices_payment_requests
        (id,organization_id,payment_request_id,invoice_id,invoice_version,created_at,updated_at)
        VALUES (?,?,?,?,1,?,?)`).bind(id, id, id, id, start, start),
      env.BILLING_DB.prepare(`INSERT INTO payment_request_checkout_intents
        (id,organization_id,payment_request_id,customer_id,provider,provider_account_code,
         idempotency_key,request_sha256,amount_minor,currency,payment_request_version,status,created_at,updated_at)
        VALUES (?,?,?,?,'easy_pay_direct','synthetic',?,'synthetic',1000,'USD',1,'pending',?,?)`).bind(
        id,
        id,
        id,
        id,
        id,
        start,
        start,
      ),
    ]);
    expect(
      await dueBillingPeriodsForClosing(env.BILLING_DB, "2026-09-01T00:00:00.000Z"),
    ).not.toContainEqual({ id, current_period_end: end });
    await expect(closeBillingPeriod(env, id, end, id)).rejects.toThrow(
      "billing_period_initial_payment_required",
    );
    const response = await handleOperatorAnalyticsRequest(
      new Request("https://operator.test/api/operator/v1/analytics?from=2026-07-01&to=2026-08-31"),
      env.BILLING_DB,
      id,
      "legacy-origin-test",
    );
    const body = (await response!.json()) as {
      analytics: { invoices: { collection_breakdown: unknown[] } };
    };
    expect(body.analytics.invoices.collection_breakdown).toEqual([
      { status: "unpaid_checkout", amount_minor: 1000, invoice_count: 1 },
    ]);
    // Without either origin proof, ordinary Lago subscriptions remain eligible.
    const ordinary = await fixture();
    await env.BILLING_DB.prepare(
      "DELETE FROM subscription_checkout_products WHERE subscription_id = ?",
    )
      .bind(ordinary)
      .run();
    expect(
      await dueBillingPeriodsForClosing(env.BILLING_DB, "2026-09-01T00:00:00.000Z"),
    ).toContainEqual({ id: ordinary, current_period_end: end });
  });
  it.each(["pending", "failed"])(
    "blocks %s initial invoices in selector and direct closer",
    async (status) => {
      const id = await fixture(status);
      expect(
        await dueBillingPeriodsForClosing(env.BILLING_DB, "2026-09-01T00:00:00.000Z"),
      ).not.toContainEqual({ id, current_period_end: end });
      await expect(closeBillingPeriod(env, id, end, id)).rejects.toThrow(
        "billing_period_initial_payment_required",
      );
      expect(
        await env.BILLING_DB.prepare("SELECT COUNT(*) AS n FROM invoices WHERE subscription_id = ?")
          .bind(id)
          .first("n"),
      ).toBe(1);
    },
  );
  it("requires exact ledger proof, allows paid renewal and exact replay", async () => {
    const id = await fixture("succeeded");
    await expect(closeBillingPeriod(env, id, end, id)).rejects.toThrow(
      "billing_period_initial_payment_required",
    );
    await env.BILLING_DB.prepare(`INSERT INTO payment_attempts
      (id,organization_id,invoice_id,provider,provider_account_code,provider_transaction_id,idempotency_key,amount_minor,currency,status,created_at,updated_at)
      VALUES (?,?,?,'easy_pay_direct','synthetic',?,?,1000,'USD','succeeded',?,?)`)
      .bind(id, id, id, id, id, start, start)
      .run();
    const result = await closeBillingPeriod(env, id, end, id);
    expect(result.replayed).toBe(false);
    expect(await closeBillingPeriod(env, id, end, id)).toMatchObject({
      invoiceId: result.invoiceId,
      replayed: true,
    });
  });
  it.each(["zero-invoice", "postpaid", "trial"])("preserves %s billing", async (kind) => {
    const id = await fixture("pending", kind === "zero-invoice" ? 0 : 1000, kind);
    expect((await closeBillingPeriod(env, id, end, id)).replayed).toBe(false);
  });
  it("rolls back the full close batch if cleanup terminates after the eligibility read", async () => {
    const id = await fixture("pending", 0);
    const database = env.BILLING_DB;
    const raced = new Proxy(database, {
      get(target, property) {
        if (property === "batch")
          return async (statements: D1PreparedStatement[]) => {
            await database
              .prepare("UPDATE subscriptions SET status = 'terminated' WHERE id = ?")
              .bind(id)
              .run();
            return database.batch(statements);
          };
        const value = Reflect.get(target, property);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    await expect(closeBillingPeriod({ ...env, BILLING_DB: raced }, id, end, id)).rejects.toThrow();
    expect(
      await database
        .prepare("SELECT COUNT(*) AS n FROM invoices WHERE subscription_id = ?")
        .bind(id)
        .first("n"),
    ).toBe(1);
    expect(
      await database
        .prepare("SELECT COUNT(*) AS n FROM outbox_events WHERE organization_id = ?")
        .bind(id)
        .first("n"),
    ).toBe(0);
    expect(
      await database.prepare("SELECT COUNT(*) AS n FROM billing_period_close_fences").first("n"),
    ).toBe(0);
    expect(
      await database
        .prepare("SELECT current_period_end FROM subscriptions WHERE id = ?")
        .bind(id)
        .first("current_period_end"),
    ).toBe(end);
  });
});
