import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { closeBillingPeriod } from "../src/billing/close-period";

const start = "2026-07-31T00:00:00.000Z";
const end = "2026-08-31T00:00:00.000Z";

type Fixture = {
  id: string;
  organizationId: string;
  basePlanId: string;
  targetPlanId: string;
  pendingId: string;
};

async function fixture(withPendingDowngrade: boolean): Promise<Fixture> {
  const id = crypto.randomUUID();
  const organizationId = crypto.randomUUID();
  const basePlanId = crypto.randomUUID();
  const targetPlanId = crypto.randomUUID();
  const pendingId = crypto.randomUUID();
  const invoiceId = crypto.randomUUID();
  await env.BILLING_DB.batch([
    env.BILLING_DB.prepare(
      `INSERT INTO organizations (id, external_id, name, created_at, updated_at)
       VALUES (?, ?, 'Close race', ?, ?)`,
    ).bind(organizationId, organizationId, start, start),
    env.BILLING_DB.prepare(
      `INSERT INTO customers
       (id, organization_id, external_id, currency, created_at, updated_at)
       VALUES (?, ?, ?, 'USD', ?, ?)`,
    ).bind(id, organizationId, id, start, start),
    env.BILLING_DB.prepare(
      `INSERT INTO plans
       (id, organization_id, code, name, interval, amount_minor, currency,
        pay_in_advance, created_at, updated_at)
       VALUES (?, ?, ?, 'Base', 'monthly', 1000, 'USD', 1, ?, ?),
              (?, ?, ?, 'Target', 'monthly', 500, 'USD', 1, ?, ?)`,
    ).bind(
      basePlanId,
      organizationId,
      basePlanId,
      start,
      start,
      targetPlanId,
      organizationId,
      targetPlanId,
      start,
      start,
    ),
    env.BILLING_DB.prepare(
      `INSERT INTO subscriptions
       (id, organization_id, customer_id, plan_id, external_id, status, started_at,
        current_period_start, current_period_end, version, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, ?, ?)`,
    ).bind(
      id,
      organizationId,
      id,
      basePlanId,
      `${id}-external`,
      start,
      start,
      end,
      withPendingDowngrade ? 2 : 1,
      start,
      start,
    ),
    env.BILLING_DB.prepare(
      `INSERT INTO subscription_checkout_products
       (subscription_id, organization_id, product_slug, created_at)
       VALUES (?, ?, 'close-race', ?)`,
    ).bind(id, organizationId, start),
    env.BILLING_DB.prepare(
      `INSERT INTO invoices
       (id, organization_id, customer_id, subscription_id, number, status,
        payment_status, currency, subtotal_minor, total_due_minor, finalized_at,
        created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'finalized', 'succeeded', 'USD', 1000, 1000, ?, ?, ?)`,
    ).bind(invoiceId, organizationId, id, id, invoiceId, start, start, start),
    env.BILLING_DB.prepare(
      `INSERT INTO subscription_invoice_contexts
       (invoice_id, organization_id, subscription_id, context_type, period_start,
        period_end, created_at)
       VALUES (?, ?, ?, 'initial', ?, ?, ?)`,
    ).bind(invoiceId, organizationId, id, start, end, start),
    env.BILLING_DB.prepare(
      `INSERT INTO payment_attempts
       (id, organization_id, invoice_id, provider, provider_account_code,
        provider_transaction_id, idempotency_key, amount_minor, currency, status,
        created_at, updated_at)
       VALUES (?, ?, ?, 'easy_pay_direct', 'race', ?, ?, 1000, 'USD', 'succeeded', ?, ?)`,
    ).bind(crypto.randomUUID(), organizationId, invoiceId, invoiceId, invoiceId, start, start),
  ]);
  if (withPendingDowngrade) {
    await insertPendingDowngrade({
      id,
      organizationId,
      basePlanId,
      targetPlanId,
      pendingId,
    });
  }
  return { id, organizationId, basePlanId, targetPlanId, pendingId };
}

async function insertPendingDowngrade(value: Fixture): Promise<void> {
  await env.BILLING_DB.prepare(
    `INSERT INTO subscriptions
     (id, organization_id, customer_id, plan_id, external_id, status, version,
      created_at, updated_at, previous_subscription_id, transition_kind,
      transition_at, generation)
     VALUES (?, ?, ?, ?, ?, 'pending', 1, ?, ?, ?, 'downgrade', ?, 2)`,
  )
    .bind(
      value.pendingId,
      value.organizationId,
      value.id,
      value.targetPlanId,
      `${value.id}-external`,
      start,
      start,
      value.id,
      end,
    )
    .run();
}

function racingDatabase(mutate: () => Promise<void>): D1Database {
  const database = env.BILLING_DB;
  let raced = false;
  return new Proxy(database, {
    get(target, property) {
      if (property === "batch")
        return async (statements: D1PreparedStatement[]) => {
          if (!raced) {
            raced = true;
            await mutate();
          }
          return database.batch(statements);
        };
      const value = Reflect.get(target, property);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

async function expectNoClosedRenewal(value: Fixture): Promise<void> {
  expect(
    await env.BILLING_DB.prepare("SELECT COUNT(*) AS n FROM invoices WHERE subscription_id = ?")
      .bind(value.id)
      .first("n"),
  ).toBe(1);
  await expect(
    env.BILLING_DB.prepare("SELECT status, current_period_end FROM subscriptions WHERE id = ?")
      .bind(value.id)
      .first(),
  ).resolves.toEqual({ status: "active", current_period_end: end });
  expect(
    await env.BILLING_DB.prepare(
      "SELECT COUNT(*) AS n FROM billing_cycles WHERE subscription_id = ? AND status = 'closed'",
    )
      .bind(value.id)
      .first("n"),
  ).toBe(0);
}

describe("billing-period close generation races", () => {
  it("does not invoice a stale plan snapshot when the plan changes before close", async () => {
    const value = await fixture(false);
    const database = racingDatabase(async () => {
      await env.BILLING_DB.prepare(
        `UPDATE plans
         SET amount_minor = 2000, version = version + 1, updated_at = ?
         WHERE id = ?`,
      )
        .bind(new Date().toISOString(), value.basePlanId)
        .run();
    });

    await expect(
      closeBillingPeriod({ ...env, BILLING_DB: database }, value.id, end, value.id),
    ).rejects.toThrow();
    await expectNoClosedRenewal(value);
  });

  it("does not advance the old generation when a downgrade is scheduled after the read", async () => {
    const value = await fixture(false);
    const database = racingDatabase(async () => {
      await env.BILLING_DB.prepare(
        "UPDATE subscriptions SET version = version + 1, updated_at = ? WHERE id = ?",
      )
        .bind(new Date().toISOString(), value.id)
        .run();
      await insertPendingDowngrade(value);
    });

    await expect(
      closeBillingPeriod({ ...env, BILLING_DB: database }, value.id, end, value.id),
    ).rejects.toThrow();
    await expectNoClosedRenewal(value);
    expect(
      await env.BILLING_DB.prepare("SELECT status FROM subscriptions WHERE id = ?")
        .bind(value.pendingId)
        .first("status"),
    ).toBe("pending");
  });

  it("does not commit an invoice when the selected pending downgrade changes before close", async () => {
    const value = await fixture(true);
    const database = racingDatabase(async () => {
      await env.BILLING_DB.prepare(
        `UPDATE subscriptions
         SET status = 'canceled', canceled_at = ?, version = version + 1, updated_at = ?
         WHERE id = ? AND status = 'pending'`,
      )
        .bind(new Date().toISOString(), new Date().toISOString(), value.pendingId)
        .run();
    });

    await expect(
      closeBillingPeriod({ ...env, BILLING_DB: database }, value.id, end, value.id),
    ).rejects.toThrow();
    await expectNoClosedRenewal(value);
    expect(
      await env.BILLING_DB.prepare("SELECT status FROM subscriptions WHERE id = ?")
        .bind(value.pendingId)
        .first("status"),
    ).toBe("canceled");
  });
});
