import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { expireCoupons, expireWallets, markInvoicesOverdue } from "../src/schedules/maintenance";
import {
  dueLegacySchedules,
  LEGACY_SCHEDULES,
  scheduleInstanceId,
} from "../src/schedules/registry";

beforeEach(async () => {
  const now = "2026-08-14T00:00:00.000Z";
  await env.BILLING_DB.batch([
    env.BILLING_DB.prepare(
      `INSERT OR IGNORE INTO organizations (id, external_id, name, created_at, updated_at)
       VALUES ('org-schedule', 'schedule-test', 'Schedule Test', ?, ?)`,
    ).bind(now, now),
    env.BILLING_DB.prepare(
      `INSERT OR IGNORE INTO customers
       (id, organization_id, external_id, currency, metadata_json, created_at, updated_at)
       VALUES ('customer-schedule', 'org-schedule', 'schedule-customer', 'USD', '{}', ?, ?)`,
    ).bind(now, now),
    couponStatement("coupon-expired", "expired", "2026-08-14T00:29:59.000Z", now),
    couponStatement("coupon-future", "future", "2026-08-14T00:30:01.000Z", now),
    walletStatement("wallet-expired", "expired", "2026-08-14T00:44:59.000Z", now),
    walletStatement("wallet-future", "future", "2026-08-14T00:45:01.000Z", now),
    invoiceStatement("invoice-overdue", "INV-OVERDUE", "2026-08-13", now),
    invoiceStatement("invoice-future", "INV-FUTURE", "2026-08-15", now),
  ]);
});

describe("legacy schedule ownership", () => {
  it("maps all 27 Clockwork schedules exactly once", () => {
    expect(LEGACY_SCHEDULES).toHaveLength(27);
    expect(new Set(LEGACY_SCHEDULES.map((schedule) => schedule.key)).size).toBe(27);
    expect(
      LEGACY_SCHEDULES.filter((schedule) => schedule.executor).map((schedule) => schedule.key),
    ).toEqual([
      "schedule:bill_customers",
      "schedule:mark_invoices_as_payment_overdue",
      "schedule:terminate_coupons",
      "schedule:terminate_wallets",
      "schedule:retry_inbound_webhooks",
    ]);
  });

  it("selects deterministic UTC slots and workflow instance IDs", () => {
    const triggeredAt = Date.parse("2026-08-14T01:30:00.000Z");
    const due = dueLegacySchedules(triggeredAt).map((schedule) => schedule.key);
    expect(due).toEqual([
      "schedule:activate_subscriptions",
      "schedule:refresh_draft_invoices",
      "schedule:refresh_wallets_ongoing_balance",
      "schedule:retry_generating_subscription_invoices",
      "schedule:terminate_coupons",
      "schedule:retry_failed_invoices",
      "schedule:retry_inbound_webhooks",
    ]);
    expect(scheduleInstanceId(triggeredAt)).toBe("maintenance-202608140130");
    expect(scheduleInstanceId(triggeredAt + 30_000)).toBe("maintenance-202608140130");
  });
});

describe("scheduled ledger maintenance", () => {
  it("marks due invoices overdue exactly once with outbox evidence", async () => {
    const cutoff = "2026-08-14T00:25:00.000Z";
    await expect(markInvoicesOverdue(env, cutoff, "schedule-test")).resolves.toBe(1);
    await expect(markInvoicesOverdue(env, cutoff, "schedule-test-replay")).resolves.toBe(0);

    await expect(
      env.BILLING_DB.prepare(
        `SELECT
           (SELECT payment_overdue FROM invoices WHERE id = 'invoice-overdue') AS overdue_invoice,
           (SELECT version FROM invoices WHERE id = 'invoice-overdue') AS overdue_version,
           (SELECT payment_overdue FROM invoices WHERE id = 'invoice-future') AS future_invoice,
           (SELECT COUNT(*) FROM outbox_events
              WHERE event_type = 'invoice.payment_overdue'
                AND aggregate_id = 'invoice-overdue') AS events`,
      ).first(),
    ).resolves.toEqual({
      overdue_invoice: 1,
      overdue_version: 2,
      future_invoice: 0,
      events: 1,
    });
  });

  it("terminates expired coupons and wallets exactly once with outbox evidence", async () => {
    const couponCutoff = "2026-08-14T00:30:00.000Z";
    const walletCutoff = "2026-08-14T00:45:00.000Z";
    await expect(expireCoupons(env, couponCutoff, "schedule-test")).resolves.toBe(1);
    await expect(expireCoupons(env, couponCutoff, "schedule-test-replay")).resolves.toBe(0);
    await expect(expireWallets(env, walletCutoff, "schedule-test")).resolves.toBe(1);
    await expect(expireWallets(env, walletCutoff, "schedule-test-replay")).resolves.toBe(0);

    await expect(
      env.BILLING_DB.prepare(
        `SELECT
           (SELECT status FROM coupons WHERE id = 'coupon-expired') AS expired_coupon,
           (SELECT status FROM coupons WHERE id = 'coupon-future') AS future_coupon,
           (SELECT status FROM wallets WHERE id = 'wallet-expired') AS expired_wallet,
           (SELECT version FROM wallets WHERE id = 'wallet-expired') AS wallet_version,
           (SELECT status FROM wallets WHERE id = 'wallet-future') AS future_wallet,
           (SELECT COUNT(*) FROM outbox_events
              WHERE event_type IN ('coupon.terminated', 'wallet.terminated')
                AND aggregate_id IN ('coupon-expired', 'wallet-expired')) AS events`,
      ).first(),
    ).resolves.toEqual({
      expired_coupon: "terminated",
      future_coupon: "active",
      expired_wallet: "terminated",
      wallet_version: 2,
      future_wallet: "active",
      events: 2,
    });
  });
});

function couponStatement(
  id: string,
  code: string,
  expirationAt: string,
  now: string,
): D1PreparedStatement {
  return env.BILLING_DB.prepare(
    `INSERT OR IGNORE INTO coupons
     (id, organization_id, code, name, coupon_type, amount_minor, currency, percentage_rate,
      frequency, frequency_duration, expiration, expiration_at, reusable, status,
      request_sha256, created_at, updated_at)
     VALUES (?, 'org-schedule', ?, ?, 'fixed_amount', 100, 'USD', NULL, 'once', NULL,
             'time_limit', ?, 1, 'active', ?, ?, ?)`,
  ).bind(id, code, code, expirationAt, `hash-${id}`, now, now);
}

function invoiceStatement(
  id: string,
  number: string,
  paymentDueDate: string,
  now: string,
): D1PreparedStatement {
  return env.BILLING_DB.prepare(
    `INSERT OR IGNORE INTO invoices
     (id, organization_id, customer_id, number, status, payment_status, currency,
      subtotal_minor, tax_minor, credits_minor, total_due_minor, version, finalized_at,
      net_payment_term, payment_due_date, payment_overdue, created_at, updated_at)
     VALUES (?, 'org-schedule', 'customer-schedule', ?, 'finalized', 'pending', 'USD',
             100, 0, 0, 100, 1, ?, 0, ?, 0, ?, ?)`,
  ).bind(id, number, now, paymentDueDate, now, now);
}

function walletStatement(
  id: string,
  code: string,
  expirationAt: string,
  now: string,
): D1PreparedStatement {
  return env.BILLING_DB.prepare(
    `INSERT OR IGNORE INTO wallets
     (id, organization_id, customer_id, code, name, currency, currency_exponent, rate_amount,
      priority, balance_minor, consumed_minor, status, expiration_at, version, request_sha256,
      created_at, updated_at, terminated_at)
     VALUES (?, 'org-schedule', 'customer-schedule', ?, ?, 'USD', 2, '1', 50, 100, 0,
             'active', ?, 1, ?, ?, ?, NULL)`,
  ).bind(id, code, code, expirationAt, `hash-${id}`, now, now);
}
