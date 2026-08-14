import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { expireCoupons, expireWallets } from "../src/schedules/maintenance";
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
