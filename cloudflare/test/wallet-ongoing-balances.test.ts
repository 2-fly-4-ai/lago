import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import {
  projectedCustomerLiabilityMinor,
  refreshWalletOngoingBalances,
} from "../src/schedules/wallet-balances";
import { expireRecurringWalletRules } from "../src/schedules/recurring-wallets";

const now = "2026-08-15T01:30:00.000Z";

beforeEach(async () => {
  await env.BILLING_DB.batch([
    env.BILLING_DB.prepare(
      "DELETE FROM outbox_events WHERE organization_id IN ('org-projection', 'org-projection-other')",
    ),
    env.BILLING_DB.prepare(
      `DELETE FROM wallet_projection_guards WHERE wallet_id IN
       ('wallet-projection-first', 'wallet-projection-second')`,
    ),
    env.BILLING_DB.prepare(
      `DELETE FROM wallet_transactions WHERE wallet_id IN
       ('wallet-projection-first', 'wallet-projection-second')`,
    ),
    env.BILLING_DB.prepare(
      `DELETE FROM wallet_threshold_rules WHERE wallet_id IN
       ('wallet-projection-first', 'wallet-projection-second')`,
    ),
    env.BILLING_DB.prepare(`DELETE FROM invoices WHERE customer_id = 'customer-projection'`),
    env.BILLING_DB.prepare(`DELETE FROM usage_events WHERE customer_id = 'customer-projection'`),
    env.BILLING_DB.prepare(`DELETE FROM subscriptions WHERE customer_id = 'customer-projection'`),
    env.BILLING_DB.prepare(`DELETE FROM charges WHERE organization_id = 'org-projection'`),
    env.BILLING_DB.prepare(`DELETE FROM billable_metrics WHERE organization_id = 'org-projection'`),
    env.BILLING_DB.prepare("DELETE FROM plans WHERE organization_id = 'org-projection'"),
    env.BILLING_DB.prepare(
      `DELETE FROM wallets WHERE id IN ('wallet-projection-first', 'wallet-projection-second')`,
    ),
    env.BILLING_DB.prepare(`DELETE FROM customers WHERE id = 'customer-projection'`),
    env.BILLING_DB.prepare(
      `DELETE FROM organizations WHERE id IN ('org-projection', 'org-projection-other')`,
    ),
    env.BILLING_DB.prepare(
      `INSERT INTO organizations (id, external_id, name, created_at, updated_at)
       VALUES ('org-projection', 'projection', 'Projection', ?, ?)`,
    ).bind(now, now),
    env.BILLING_DB.prepare(
      `INSERT INTO organizations (id, external_id, name, created_at, updated_at)
       VALUES ('org-projection-other', 'projection-other', 'Projection Other', ?, ?)`,
    ).bind(now, now),
    env.BILLING_DB.prepare(
      `INSERT INTO customers
       (id, organization_id, external_id, currency, metadata_json, created_at, updated_at,
        awaiting_wallet_refresh)
       VALUES ('customer-projection', 'org-projection', 'projection-customer', 'USD', '{}',
               ?, ?, 1)`,
    ).bind(now, now),
    walletStatement("wallet-projection-first", 10, 1000),
    walletStatement("wallet-projection-second", 20, 500),
    initialLotStatement("wallet-projection-first", 10, 1000),
    initialLotStatement("wallet-projection-second", 20, 500),
    env.BILLING_DB.prepare(
      `INSERT INTO invoices
       (id, organization_id, customer_id, number, status, payment_status, currency,
        subtotal_minor, tax_minor, credits_minor, total_due_minor, version, finalized_at,
        net_payment_term, payment_overdue, issuing_date, created_at, updated_at)
       VALUES ('invoice-projection-draft', 'org-projection', 'customer-projection',
               'PROJECTION-DRAFT', 'draft', 'pending', 'USD', 1200, 0, 0, 1200, 1,
               NULL, 0, 0, '2026-08-15', ?, ?)`,
    ).bind(now, now),
    thresholdRuleStatement(),
  ]);
});

describe("ongoing wallet balance projection", () => {
  it("projects draft liability by wallet priority and grants a threshold top-up exactly once", async () => {
    await expect(refreshWalletOngoingBalances(env, now, "projection-run-1")).resolves.toEqual({
      customers: 1,
      wallets: 2,
      thresholdTopUps: 1,
    });
    await expect(walletState()).resolves.toEqual([
      {
        balance_minor: 1300,
        depleted_ongoing_balance: 1,
        id: "wallet-projection-first",
        ongoing_balance_minor: 100,
        ongoing_balance_version: 1,
        ongoing_usage_balance_minor: 1200,
        version: 2,
      },
      {
        balance_minor: 500,
        depleted_ongoing_balance: 0,
        id: "wallet-projection-second",
        ongoing_balance_minor: 500,
        ongoing_balance_version: 1,
        ongoing_usage_balance_minor: 0,
        version: 1,
      },
    ]);
    await expect(
      env.BILLING_DB.prepare(
        `SELECT
           (SELECT COUNT(*) FROM wallet_transactions
            WHERE source = 'threshold' AND wallet_id = 'wallet-projection-first') AS top_ups,
           (SELECT COUNT(*) FROM outbox_events
            WHERE event_type = 'wallet.depleted_ongoing_balance'
              AND aggregate_id = 'wallet-projection-first') AS depleted_events,
           (SELECT awaiting_wallet_refresh FROM customers
            WHERE id = 'customer-projection') AS awaiting_refresh,
           (SELECT COUNT(*) FROM wallet_projection_guards) AS guards`,
      ).first(),
    ).resolves.toEqual({ awaiting_refresh: 0, depleted_events: 1, guards: 0, top_ups: 1 });

    await expect(
      refreshWalletOngoingBalances(env, "2026-08-15T01:35:00.000Z", "projection-run-2"),
    ).resolves.toEqual({ customers: 1, wallets: 2, thresholdTopUps: 0 });
    await expect(
      env.BILLING_DB.prepare(
        `SELECT ongoing_balance_minor, ongoing_balance_version, depleted_ongoing_balance,
                (SELECT COUNT(*) FROM wallet_transactions
                 WHERE source = 'threshold' AND wallet_id = wallets.id) AS top_ups
         FROM wallets WHERE id = 'wallet-projection-first'`,
      ).first(),
    ).resolves.toEqual({
      depleted_ongoing_balance: 0,
      ongoing_balance_minor: 100,
      ongoing_balance_version: 2,
      top_ups: 1,
    });
  });

  it("uses the shared subscription calculator for current-period liability", async () => {
    await env.BILLING_DB.batch([
      env.BILLING_DB.prepare("DELETE FROM invoices WHERE id = 'invoice-projection-draft'"),
      env.BILLING_DB.prepare(
        `INSERT INTO plans
         (id, organization_id, code, name, interval, amount_minor, currency, pay_in_advance,
          version, active, created_at, updated_at)
         VALUES ('plan-projection', 'org-projection', 'projection-plan', 'Projection Plan',
                 'monthly', 700, 'USD', 0, 1, 1, ?, ?)`,
      ).bind(now, now),
      env.BILLING_DB.prepare(
        `INSERT INTO subscriptions
         (id, organization_id, customer_id, plan_id, external_id, status, started_at,
          current_period_start, current_period_end, version, created_at, updated_at)
         VALUES ('subscription-projection', 'org-projection', 'customer-projection',
                 'plan-projection', 'projection-subscription', 'active',
                 '2026-08-01T00:00:00.000Z', '2026-08-01T00:00:00.000Z',
                 '2026-09-01T00:00:00.000Z', 1, ?, ?)`,
      ).bind(now, now),
    ]);
    await expect(
      projectedCustomerLiabilityMinor(env.BILLING_DB, "customer-projection"),
    ).resolves.toBe(700);
    await expect(
      refreshWalletOngoingBalances(env, now, "projection-current-usage"),
    ).resolves.toMatchObject({ customers: 1, wallets: 2 });
    await expect(
      env.BILLING_DB.prepare(
        `SELECT ongoing_usage_balance_minor, ongoing_balance_minor
         FROM wallets WHERE id = 'wallet-projection-first'`,
      ).first(),
    ).resolves.toEqual({ ongoing_balance_minor: 300, ongoing_usage_balance_minor: 700 });
  });

  it("projects each draft fee onto the first wallet matching its fee limitation", async () => {
    await env.BILLING_DB.batch([
      env.BILLING_DB.prepare(
        `UPDATE wallets SET allowed_fee_types_json = '["charge"]'
         WHERE id = 'wallet-projection-first'`,
      ),
      env.BILLING_DB.prepare(
        `UPDATE wallets SET allowed_fee_types_json = '["subscription"]'
         WHERE id = 'wallet-projection-second'`,
      ),
      env.BILLING_DB.prepare(
        `INSERT INTO invoice_lines
         (id, invoice_id, line_type, description, quantity_decimal, unit_amount_decimal,
          amount_minor, source_type, source_id, metadata_json, created_at)
         VALUES ('projection-usage-line', 'invoice-projection-draft', 'usage', 'Usage', '1',
                 '700', 700, 'charge', 'projection-charge', '{}', ?)`,
      ).bind(now),
      env.BILLING_DB.prepare(
        `INSERT INTO invoice_lines
         (id, invoice_id, line_type, description, quantity_decimal, unit_amount_decimal,
          amount_minor, source_type, source_id, metadata_json, created_at)
         VALUES ('projection-subscription-line', 'invoice-projection-draft', 'subscription',
                 'Subscription', '1', '500', 500, 'plan', 'projection-plan', '{}', ?)`,
      ).bind(now),
    ]);
    await expect(
      refreshWalletOngoingBalances(env, now, "projection-fee-limitations"),
    ).resolves.toMatchObject({ customers: 1, wallets: 2, thresholdTopUps: 0 });
    await expect(walletState()).resolves.toEqual([
      expect.objectContaining({
        id: "wallet-projection-first",
        ongoing_balance_minor: 300,
        ongoing_usage_balance_minor: 700,
      }),
      expect.objectContaining({
        id: "wallet-projection-second",
        ongoing_balance_minor: 0,
        ongoing_usage_balance_minor: 500,
      }),
    ]);
  });

  it("suppresses a threshold grant while pending credits carry the balance above the threshold", async () => {
    await env.BILLING_DB.prepare(
      `INSERT INTO wallet_transactions
       (id, organization_id, wallet_id, transaction_type, transaction_status, status, source,
        amount_minor, credit_amount, remaining_minor, priority, wallet_version, request_sha256,
        created_at, updated_at)
       VALUES ('wallet-projection-pending', 'org-projection', 'wallet-projection-first',
               'inbound', 'granted', 'pending', 'manual', 300, '3', 300, 10, 1,
               'pending-hash', ?, ?)`,
    )
      .bind(now, now)
      .run();
    await expect(
      refreshWalletOngoingBalances(env, now, "projection-pending"),
    ).resolves.toMatchObject({ thresholdTopUps: 0 });
    await expect(
      env.BILLING_DB.prepare(
        `SELECT balance_minor, ongoing_balance_minor,
                (SELECT COUNT(*) FROM wallet_transactions
                 WHERE source = 'threshold' AND wallet_id = wallets.id) AS top_ups
         FROM wallets WHERE id = 'wallet-projection-first'`,
      ).first(),
    ).resolves.toEqual({ balance_minor: 1000, ongoing_balance_minor: -200, top_ups: 0 });
  });

  it("rolls every wallet and event back when a guarded projection fails", async () => {
    await env.BILLING_DB.prepare(
      `CREATE TRIGGER fail_second_wallet_projection
       BEFORE UPDATE OF ongoing_balance_minor ON wallets
       WHEN NEW.id = 'wallet-projection-second'
       BEGIN
         SELECT RAISE(ABORT, 'injected_wallet_projection_failure');
       END`,
    ).run();
    try {
      await expect(refreshWalletOngoingBalances(env, now, "projection-rollback")).rejects.toThrow(
        "injected_wallet_projection_failure",
      );
    } finally {
      await env.BILLING_DB.prepare("DROP TRIGGER fail_second_wallet_projection").run();
    }
    await expect(walletState()).resolves.toEqual([
      expect.objectContaining({
        balance_minor: 1000,
        id: "wallet-projection-first",
        ongoing_balance_minor: 1000,
        ongoing_balance_version: 0,
        version: 1,
      }),
      expect.objectContaining({
        balance_minor: 500,
        id: "wallet-projection-second",
        ongoing_balance_minor: 500,
        ongoing_balance_version: 0,
        version: 1,
      }),
    ]);
    await expect(
      env.BILLING_DB.prepare(
        `SELECT
           (SELECT COUNT(*) FROM wallet_transactions WHERE source = 'threshold') AS top_ups,
           (SELECT COUNT(*) FROM wallet_projection_guards) AS guards,
           (SELECT COUNT(*) FROM outbox_events
            WHERE organization_id = 'org-projection') AS events`,
      ).first(),
    ).resolves.toEqual({ events: 0, guards: 0, top_ups: 0 });
  });

  it("rejects cross-tenant threshold rules and mismatched transaction origins", async () => {
    await expect(
      env.BILLING_DB.prepare(
        `INSERT INTO wallet_threshold_rules
         (id, organization_id, wallet_id, granted_credits, threshold_credits,
          created_at, updated_at)
         VALUES ('threshold-cross-tenant', 'org-projection-other',
                 'wallet-projection-second', '1', '1', ?, ?)`,
      )
        .bind(now, now)
        .run(),
    ).rejects.toThrow("invalid_wallet_threshold_rule_tenant");
    await expect(
      env.BILLING_DB.prepare(
        `INSERT INTO wallet_transactions
         (id, organization_id, wallet_id, transaction_type, transaction_status, status, source,
          amount_minor, credit_amount, remaining_minor, priority, wallet_version, request_sha256,
          created_at, updated_at, wallet_threshold_rule_id)
         VALUES ('threshold-wrong-wallet', 'org-projection', 'wallet-projection-second',
                 'inbound', 'granted', 'settled', 'threshold', 100, '1', 100, 20, 1,
                 'wrong-wallet-hash', ?, ?, 'threshold-projection')`,
      )
        .bind(now, now)
        .run(),
    ).rejects.toThrow("invalid_threshold_wallet_transaction_rule");
  });

  it("terminates an expired threshold rule once and excludes it from projection", async () => {
    await env.BILLING_DB.prepare(
      `UPDATE wallet_threshold_rules SET expiration_at = '2026-08-15T01:29:59.000Z'
       WHERE id = 'threshold-projection'`,
    ).run();
    await expect(expireRecurringWalletRules(env, now, "threshold-expiration")).resolves.toBe(1);
    await expect(expireRecurringWalletRules(env, now, "threshold-expiration-replay")).resolves.toBe(
      0,
    );
    await expect(
      refreshWalletOngoingBalances(env, now, "projection-expired-rule"),
    ).resolves.toMatchObject({ thresholdTopUps: 0 });
    await expect(
      env.BILLING_DB.prepare(
        `SELECT status, version,
                (SELECT COUNT(*) FROM outbox_events
                 WHERE aggregate_id = wallet_threshold_rules.id
                   AND event_type = 'wallet.recurring_transaction_rule.terminated') AS events
         FROM wallet_threshold_rules WHERE id = 'threshold-projection'`,
      ).first(),
    ).resolves.toEqual({ events: 1, status: "terminated", version: 2 });
  });
});

function walletStatement(id: string, priority: number, balanceMinor: number) {
  return env.BILLING_DB.prepare(
    `INSERT INTO wallets
     (id, organization_id, customer_id, code, currency, currency_exponent, rate_amount,
      priority, balance_minor, ongoing_balance_minor, ongoing_usage_balance_minor,
      consumed_minor, status, version, request_sha256, created_at, updated_at)
     VALUES (?, 'org-projection', 'customer-projection', ?, 'USD', 2, '1', ?, ?, ?, 0,
             0, 'active', 1, ?, ?, ?)`,
  ).bind(id, id, priority, balanceMinor, balanceMinor, `${id}-hash`, now, now);
}

function thresholdRuleStatement() {
  return env.BILLING_DB.prepare(
    `INSERT INTO wallet_threshold_rules
     (id, organization_id, wallet_id, interval, method, trigger, paid_credits,
      granted_credits, threshold_credits, status, transaction_metadata_json, transaction_name,
      version, created_at, updated_at)
     VALUES ('threshold-projection', 'org-projection', 'wallet-projection-first', 'weekly',
             'fixed', 'threshold', '0', '3', '0', 'active',
             '[{"key":"origin","value":"projection"}]', 'Threshold grant', 1, ?, ?)`,
  ).bind(now, now);
}

function initialLotStatement(walletId: string, priority: number, amountMinor: number) {
  return env.BILLING_DB.prepare(
    `INSERT INTO wallet_transactions
     (id, organization_id, wallet_id, transaction_type, transaction_status, status, source,
      amount_minor, credit_amount, remaining_minor, priority, wallet_version, request_sha256,
      settled_at, created_at, updated_at)
     VALUES (?, 'org-projection', ?, 'inbound', 'granted', 'settled', 'manual', ?, ?, ?, ?, 1,
             ?, ?, ?, ?)`,
  ).bind(
    `${walletId}-initial`,
    walletId,
    amountMinor,
    String(amountMinor / 100),
    amountMinor,
    priority,
    `${walletId}-initial-hash`,
    now,
    now,
    now,
  );
}

async function walletState() {
  const rows = await env.BILLING_DB.prepare(
    `SELECT id, balance_minor, ongoing_balance_minor, ongoing_usage_balance_minor,
            depleted_ongoing_balance, ongoing_balance_version, version
     FROM wallets WHERE id IN ('wallet-projection-first', 'wallet-projection-second')
     ORDER BY priority`,
  ).all();
  return rows.results;
}
