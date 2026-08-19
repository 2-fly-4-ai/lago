import { env, SELF } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { sha256Hex } from "../src/auth/api-key";
import { handleWalletLedgerRequest } from "../src/api/wallet-ledger";
import { calculateWalletAllocations } from "../src/billing/wallet-credits";
import { topUpDueRecurringWallets } from "../src/schedules/recurring-wallets";
import { refreshWalletOngoingBalances } from "../src/schedules/wallet-balances";

const apiKey = "wallet-ledger-key";

beforeEach(async () => {
  const now = "2026-08-13T00:00:00.000Z";
  await env.BILLING_DB.batch([
    env.BILLING_DB.prepare(
      `INSERT OR IGNORE INTO organizations (id, external_id, name, created_at, updated_at)
       VALUES ('org-wallet', 'wallet-test', 'Wallet Test', ?, ?)`,
    ).bind(now, now),
    env.BILLING_DB.prepare(
      `INSERT OR IGNORE INTO api_keys
       (id, organization_id, key_prefix, key_hash, created_at, revoked_at)
       VALUES ('key-wallet', 'org-wallet', 'wallet-l', ?, ?, NULL)`,
    ).bind(await sha256Hex(apiKey), now),
    env.BILLING_DB.prepare(
      `INSERT OR IGNORE INTO customers
       (id, organization_id, external_id, currency, metadata_json, created_at, updated_at)
       VALUES ('customer-wallet', 'org-wallet', 'customer-wallet-external', 'USD', '{}', ?, ?)`,
    ).bind(now, now),
  ]);
});

describe("granted wallet ledger", () => {
  it("tops up, consumes by lot, and recredits an initial invoice exactly once", async () => {
    const created = await request("/api/v1/wallets", "POST", {
      wallet: {
        external_customer_id: "customer-wallet-external",
        name: "Primary Wallet",
        code: "primary",
        currency: "USD",
        rate_amount: "2.5",
        granted_credits: "4",
        priority: 10,
      },
    });
    expect(created.status).toBe(200);
    const createdBody = await created.json<{ wallet: { lago_id: string } }>();
    expect(createdBody.wallet).toMatchObject({
      code: "primary",
      rate_amount: "2.5",
      credits_balance: "4",
      balance_cents: 1000,
    });
    const walletId = createdBody.wallet.lago_id;
    const createReplay = await request("/api/v1/wallets", "POST", {
      wallet: {
        external_customer_id: "customer-wallet-external",
        name: "Primary Wallet",
        code: "primary",
        currency: "USD",
        rate_amount: "2.5",
        granted_credits: "4",
        priority: 10,
      },
    });
    await expect(createReplay.json()).resolves.toMatchObject({
      wallet: { lago_id: walletId, balance_cents: 1000 },
    });

    const topUpBody = {
      wallet_transaction: { wallet_id: walletId, granted_credits: "2", name: "Bonus" },
    };
    const topUp = await request("/api/v1/wallet_transactions", "POST", topUpBody, {
      "Idempotency-Key": "wallet-bonus",
    });
    expect(topUp.status).toBe(200);
    await expect(topUp.json()).resolves.toMatchObject({
      wallet_transactions: [
        {
          transaction_type: "inbound",
          transaction_status: "granted",
          amount: "5",
          credit_amount: "2",
          remaining_amount_cents: 500,
          remaining_credit_amount: "2",
        },
      ],
    });
    expect(
      (
        await request("/api/v1/wallet_transactions", "POST", topUpBody, {
          "Idempotency-Key": "wallet-bonus",
        })
      ).status,
    ).toBe(200);
    await expect(
      request(`/api/v1/wallets/${walletId}`).then((response) => response.json()),
    ).resolves.toMatchObject({
      wallet: { balance_cents: 1500, credits_balance: "6" },
    });

    expect(
      (
        await request("/api/v1/plans", "POST", {
          plan: {
            code: "wallet-plan",
            name: "Wallet plan",
            interval: "monthly",
            amount_cents: 1200,
            amount_currency: "USD",
            pay_in_advance: true,
          },
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await request("/api/v1/subscriptions", "POST", {
          subscription: {
            external_customer_id: "customer-wallet-external",
            external_id: "wallet-subscription",
            plan_code: "wallet-plan",
          },
        })
      ).status,
    ).toBe(200);
    const invoiceList = await request(
      "/api/v1/invoices?external_customer_id=customer-wallet-external",
    ).then((response) =>
      response.json<{ invoices: Array<{ lago_id: string; total_amount_cents: number }> }>(),
    );
    const invoiceId = invoiceList.invoices[0]?.lago_id;
    expect(invoiceList.invoices[0]).toMatchObject({ total_amount_cents: 0 });

    const shown = await request(`/api/v1/invoices/${invoiceId}`);
    await expect(shown.json()).resolves.toMatchObject({
      invoice: {
        coupons_amount_cents: 0,
        prepaid_credit_amount_cents: 1200,
        prepaid_granted_credit_amount_cents: 1200,
        total_amount_cents: 0,
        wallet_transactions: [
          { lago_wallet_id: walletId, amount_cents: 1200, credit_amount: "4.8" },
        ],
      },
    });
    await expect(
      env.BILLING_DB.prepare(
        `SELECT w.balance_minor, w.consumed_minor,
                (SELECT COUNT(*) FROM wallet_transaction_consumptions c
                 JOIN wallet_transactions out ON out.id = c.outbound_transaction_id
                 WHERE out.invoice_id = ?) AS lots,
                (SELECT SUM(remaining_minor) FROM wallet_transactions
                 WHERE wallet_id = w.id AND transaction_type = 'inbound') AS remaining
         FROM wallets w WHERE w.id = ?`,
      )
        .bind(invoiceId, walletId)
        .first(),
    ).resolves.toEqual({ balance_minor: 300, consumed_minor: 1200, lots: 2, remaining: 300 });

    expect((await request(`/api/v1/invoices/${invoiceId}/void`, "POST")).status).toBe(200);
    expect((await request(`/api/v1/invoices/${invoiceId}/void`, "POST")).status).toBe(200);
    await expect(
      env.BILLING_DB.prepare(
        `SELECT w.balance_minor, w.consumed_minor,
                (SELECT SUM(remaining_minor) FROM wallet_transactions
                 WHERE wallet_id = w.id AND transaction_type = 'inbound') AS remaining,
                (SELECT COUNT(*) FROM wallet_transactions WHERE wallet_id = w.id
                   AND voided_invoice_id = ?) AS recredits
         FROM wallets w WHERE w.id = ?`,
      )
        .bind(invoiceId, walletId)
        .first(),
    ).resolves.toEqual({
      balance_minor: 1500,
      consumed_minor: 0,
      remaining: 1500,
      recredits: 1,
    });
    await expect(
      env.BILLING_DB.prepare(
        `SELECT event_type, COUNT(*) AS total FROM outbox_events
         WHERE organization_id = 'org-wallet' AND event_type LIKE 'wallet.%'
         GROUP BY event_type ORDER BY event_type`,
      ).all(),
    ).resolves.toMatchObject({
      results: [
        { event_type: "wallet.created", total: 1 },
        { event_type: "wallet.credits_consumed", total: 1 },
        { event_type: "wallet.credits_recredited", total: 1 },
      ],
    });
    await expect(
      env.BILLING_DB.prepare(
        `SELECT COUNT(*) AS total FROM outbox_events
         WHERE organization_id = 'org-wallet' AND event_type = 'wallet_transaction.created'`,
      ).first(),
    ).resolves.toEqual({ total: 2 });
  });

  it("persists replay-safe wallet and wallet-transaction custom-section selections", async () => {
    await createSection("wallet-terms", "Wallet terms");
    await createSection("top-up-terms", "Top-up terms");
    const walletPayload = {
      wallet: {
        external_customer_id: "customer-wallet-external",
        name: "Section Wallet",
        code: "section-wallet",
        currency: "USD",
        rate_amount: "1",
        invoice_custom_section: {
          skip_invoice_custom_sections: false,
          invoice_custom_section_codes: ["unknown-is-ignored", "wallet-terms"],
        },
      },
    };
    const created = await request("/api/v1/wallets", "POST", walletPayload);
    expect(created.status).toBe(200);
    const createdBody = await created.json<{
      wallet: {
        lago_id: string;
        applied_invoice_custom_sections: Array<{
          invoice_custom_section: { code: string };
        }>;
      };
    }>();
    const walletId = createdBody.wallet.lago_id;
    expect(createdBody.wallet.applied_invoice_custom_sections).toEqual([
      expect.objectContaining({
        invoice_custom_section: expect.objectContaining({ code: "wallet-terms" }),
      }),
    ]);
    const replay = await request("/api/v1/wallets", "POST", {
      wallet: {
        ...walletPayload.wallet,
        invoice_custom_section: {
          skip_invoice_custom_sections: false,
          invoice_custom_section_codes: ["wallet-terms"],
        },
      },
    });
    expect(replay.status).toBe(200);
    await expect(replay.json()).resolves.toMatchObject({ wallet: { lago_id: walletId } });
    await expect(
      request(`/api/v1/wallets/${walletId}`).then((response) => response.json()),
    ).resolves.toMatchObject({
      wallet: {
        applied_invoice_custom_sections: [{ invoice_custom_section: { code: "wallet-terms" } }],
      },
    });

    const skipped = await request(`/api/v1/wallets/${walletId}`, "PUT", {
      wallet: { invoice_custom_section: { skip_invoice_custom_sections: true } },
    });
    expect(skipped.status).toBe(200);
    await expect(skipped.json()).resolves.toMatchObject({
      wallet: { applied_invoice_custom_sections: [] },
    });
    const implicitWhileSkipped = await request(`/api/v1/wallets/${walletId}`, "PUT", {
      wallet: {
        invoice_custom_section: { invoice_custom_section_codes: ["wallet-terms"] },
      },
    });
    await expect(implicitWhileSkipped.json()).resolves.toMatchObject({
      wallet: { applied_invoice_custom_sections: [] },
    });
    const restored = await request(`/api/v1/wallets/${walletId}`, "PUT", {
      wallet: {
        invoice_custom_section: {
          skip_invoice_custom_sections: false,
          invoice_custom_section_codes: ["wallet-terms"],
        },
      },
    });
    await expect(restored.json()).resolves.toMatchObject({
      wallet: {
        applied_invoice_custom_sections: [{ invoice_custom_section: { code: "wallet-terms" } }],
      },
    });

    const transactionPayload = {
      wallet_transaction: {
        wallet_id: walletId,
        granted_credits: "3",
        invoice_custom_section: {
          invoice_custom_section_codes: ["top-up-terms", "unknown-is-ignored"],
        },
      },
    };
    const transaction = await request("/api/v1/wallet_transactions", "POST", transactionPayload, {
      "Idempotency-Key": "section-top-up",
    });
    expect(transaction.status).toBe(200);
    const transactionBody = await transaction.json<{
      wallet_transactions: Array<{
        lago_id: string;
        applied_invoice_custom_sections: Array<{
          invoice_custom_section: { code: string };
        }>;
      }>;
    }>();
    const transactionId = transactionBody.wallet_transactions[0]!.lago_id;
    expect(transactionBody.wallet_transactions[0]!.applied_invoice_custom_sections).toEqual([
      expect.objectContaining({
        invoice_custom_section: expect.objectContaining({ code: "top-up-terms" }),
      }),
    ]);
    expect(
      (
        await request("/api/v1/wallet_transactions", "POST", transactionPayload, {
          "Idempotency-Key": "section-top-up",
        })
      ).status,
    ).toBe(200);
    const divergent = await request(
      "/api/v1/wallet_transactions",
      "POST",
      {
        wallet_transaction: {
          wallet_id: walletId,
          granted_credits: "3",
          invoice_custom_section: { skip_invoice_custom_sections: true },
        },
      },
      { "Idempotency-Key": "section-top-up" },
    );
    expect(divergent.status).toBe(409);
    await expect(divergent.json()).resolves.toMatchObject({ code: "idempotency_conflict" });
    await expect(
      request(`/api/v1/wallet_transactions/${transactionId}`).then((response) => response.json()),
    ).resolves.toMatchObject({
      wallet_transaction: {
        applied_invoice_custom_sections: [{ invoice_custom_section: { code: "top-up-terms" } }],
      },
    });

    expect((await request("/api/v1/invoice_custom_sections/top-up-terms", "DELETE")).status).toBe(
      200,
    );
    await expect(
      request(`/api/v1/wallet_transactions/${transactionId}`).then((response) => response.json()),
    ).resolves.toMatchObject({
      wallet_transaction: { applied_invoice_custom_sections: [] },
    });
  });

  it("creates, replaces, serializes, and terminates a recurring granted-credit rule", async () => {
    await createSection("recurring-terms", "Recurring terms");
    const payload = {
      wallet: {
        external_customer_id: "customer-wallet-external",
        code: "recurring-wallet",
        currency: "USD",
        rate_amount: "1",
        recurring_transaction_rules: [
          {
            trigger: "interval",
            interval: "monthly",
            method: "fixed",
            paid_credits: "0",
            granted_credits: "2",
            started_at: "2026-07-31T00:00:00.000Z",
            expiration_at: "2027-07-31T00:00:00.000Z",
            transaction_name: "Monthly grant",
            transaction_metadata: [{ key: "origin", value: "recurring" }],
            invoice_custom_section: {
              invoice_custom_section_codes: ["unknown-is-ignored", "recurring-terms"],
            },
          },
        ],
      },
    };
    const created = await request("/api/v1/wallets", "POST", payload);
    expect(created.status).toBe(200);
    const createdBody = await created.json<{
      wallet: {
        lago_id: string;
        recurring_transaction_rules: Array<{
          lago_id: string;
          applied_invoice_custom_sections: Array<{
            invoice_custom_section: { code: string };
          }>;
        }>;
      };
    }>();
    const walletId = createdBody.wallet.lago_id;
    const ruleId = createdBody.wallet.recurring_transaction_rules[0]!.lago_id;
    expect(createdBody.wallet.recurring_transaction_rules).toEqual([
      expect.objectContaining({
        lago_id: ruleId,
        paid_credits: "0",
        granted_credits: "2",
        interval: "monthly",
        method: "fixed",
        trigger: "interval",
        transaction_name: "Monthly grant",
        transaction_metadata: [{ key: "origin", value: "recurring" }],
        applied_invoice_custom_sections: [
          expect.objectContaining({
            invoice_custom_section: expect.objectContaining({ code: "recurring-terms" }),
          }),
        ],
      }),
    ]);
    const replay = await request("/api/v1/wallets", "POST", {
      wallet: {
        ...payload.wallet,
        recurring_transaction_rules: [
          {
            ...payload.wallet.recurring_transaction_rules[0],
            invoice_custom_section: {
              invoice_custom_section_codes: ["recurring-terms"],
            },
          },
        ],
      },
    });
    expect(replay.status).toBe(200);
    await expect(replay.json()).resolves.toMatchObject({ wallet: { lago_id: walletId } });

    const updated = await request(`/api/v1/wallets/${walletId}`, "PUT", {
      wallet: {
        recurring_transaction_rules: [
          {
            lago_id: ruleId,
            interval: "quarterly",
            granted_credits: "3",
            invoice_custom_section: { skip_invoice_custom_sections: true },
          },
        ],
      },
    });
    expect(updated.status).toBe(200);
    await expect(updated.json()).resolves.toMatchObject({
      wallet: {
        recurring_transaction_rules: [
          {
            lago_id: ruleId,
            granted_credits: "3",
            interval: "quarterly",
            applied_invoice_custom_sections: [],
          },
        ],
      },
    });

    const replaced = await request(`/api/v1/wallets/${walletId}`, "PUT", {
      wallet: {
        recurring_transaction_rules: [
          {
            trigger: "interval",
            interval: "weekly",
            granted_credits: "4",
            invoice_custom_section: {
              invoice_custom_section_codes: ["recurring-terms"],
            },
          },
        ],
      },
    });
    expect(replaced.status).toBe(200);
    const replacedBody = await replaced.json<{
      wallet: { recurring_transaction_rules: Array<{ lago_id: string }> };
    }>();
    const replacementId = replacedBody.wallet.recurring_transaction_rules[0]!.lago_id;
    expect(replacementId).not.toBe(ruleId);
    await expect(
      env.BILLING_DB.prepare(
        `SELECT
           (SELECT status FROM recurring_transaction_rules WHERE id = ?) AS prior_status,
           (SELECT status FROM recurring_transaction_rules WHERE id = ?) AS replacement_status,
           (SELECT COUNT(*) FROM recurring_transaction_rules
              WHERE wallet_id = ? AND status = 'active') AS active_rules`,
      )
        .bind(ruleId, replacementId, walletId)
        .first(),
    ).resolves.toEqual({
      active_rules: 1,
      prior_status: "terminated",
      replacement_status: "active",
    });

    expect(
      (await request("/api/v1/invoice_custom_sections/recurring-terms", "DELETE")).status,
    ).toBe(200);
    await expect(
      request(`/api/v1/wallets/${walletId}`).then((response) => response.json()),
    ).resolves.toMatchObject({
      wallet: { recurring_transaction_rules: [{ applied_invoice_custom_sections: [] }] },
    });

    const terminated = await request(`/api/v1/wallets/${walletId}`, "PUT", {
      wallet: { recurring_transaction_rules: [] },
    });
    expect(terminated.status).toBe(200);
    await expect(terminated.json()).resolves.toMatchObject({
      wallet: { recurring_transaction_rules: [] },
    });
  });

  it("requires a payment method for provider-funded recurring rules", async () => {
    const response = await request("/api/v1/wallets", "POST", {
      wallet: {
        external_customer_id: "customer-wallet-external",
        code: "recurring-paid",
        currency: "USD",
        rate_amount: "1",
        recurring_transaction_rules: [
          { trigger: "interval", interval: "monthly", paid_credits: "1", granted_credits: "0" },
        ],
      },
    });
    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toMatchObject({
      code: "payment_method_required",
    });
    await expect(
      env.BILLING_DB.prepare(
        "SELECT COUNT(*) AS total FROM wallets WHERE code = 'recurring-paid'",
      ).first(),
    ).resolves.toEqual({ total: 0 });
  });

  it("funds interval and threshold recurring rules through Stripe test mode exactly once", async () => {
    const interval = await fundedWalletRequest("recurring-paid-interval", {
      trigger: "interval",
      interval: "monthly",
      paid_credits: "2",
      granted_credits: "1",
      payment_method: { payment_method_id: "pm_card_visa" },
    });
    expect(interval.status).toBe(200);
    const intervalBody = await interval.json<{
      wallet: {
        lago_id: string;
        recurring_transaction_rules: Array<Record<string, unknown>>;
      };
    }>();
    expect(intervalBody.wallet.recurring_transaction_rules).toMatchObject([
      {
        paid_credits: "2",
        granted_credits: "1",
        payment_method: { payment_method_id: "pm_card_visa" },
      },
    ]);
    await env.BILLING_DB.prepare(
      `UPDATE wallets SET created_at = '2026-07-19T00:00:00.000Z'
       WHERE id = ?`,
    )
      .bind(intervalBody.wallet.lago_id)
      .run();
    const stripeCalls: string[] = [];
    const fetcher = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      stripeCalls.push(String(init?.body));
      return new Response(
        JSON.stringify({ id: `pi_test_${stripeCalls.length}`, status: "succeeded" }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }) as typeof fetch;
    const fundingEnv = fundedEnv();
    await expect(
      topUpDueRecurringWallets(fundingEnv, "2026-08-19T12:00:00.000Z", "interval-funded", fetcher),
    ).resolves.toBe(1);
    await expect(
      topUpDueRecurringWallets(
        fundingEnv,
        "2026-08-19T12:05:00.000Z",
        "interval-funded-replay",
        fetcher,
      ),
    ).resolves.toBe(0);

    const threshold = await fundedWalletRequest("recurring-paid-threshold", {
      trigger: "threshold",
      threshold_credits: "10",
      paid_credits: "2",
      granted_credits: "1",
      payment_method: { payment_method_id: "pm_card_visa" },
    });
    expect(threshold.status).toBe(200);
    const thresholdId = (await threshold.json<{ wallet: { lago_id: string } }>()).wallet.lago_id;
    await expect(
      refreshWalletOngoingBalances(
        fundingEnv,
        "2026-08-19T12:10:00.000Z",
        "threshold-funded",
        fetcher,
      ),
    ).resolves.toMatchObject({ thresholdTopUps: 1 });
    const balances = await env.BILLING_DB.prepare(
      `SELECT id, balance_minor FROM wallets WHERE id IN (?, ?) ORDER BY id`,
    )
      .bind(intervalBody.wallet.lago_id, thresholdId)
      .all<{ id: string; balance_minor: number }>();
    expect(balances.results.map((row) => row.balance_minor)).toEqual([300, 300]);
    expect(stripeCalls).toHaveLength(2);
    expect(stripeCalls.every((body) => !body.includes("payment_method_types"))).toBe(true);
  });

  it("creates, updates, and changes a fixed granted threshold rule", async () => {
    const created = await request("/api/v1/wallets", "POST", {
      wallet: {
        external_customer_id: "customer-wallet-external",
        code: "recurring-threshold",
        currency: "USD",
        rate_amount: "1",
        granted_credits: "5",
        recurring_transaction_rules: [
          {
            trigger: "threshold",
            threshold_credits: "2.5",
            granted_credits: "4",
            transaction_name: "Low balance grant",
            transaction_metadata: [{ key: "source", value: "threshold" }],
          },
        ],
      },
    });
    expect(created.status).toBe(200);
    const body = await created.json<{
      wallet: { lago_id: string; recurring_transaction_rules: Array<{ lago_id: string }> };
    }>();
    const walletId = body.wallet.lago_id;
    const ruleId = body.wallet.recurring_transaction_rules[0]!.lago_id;
    await expect(
      request(`/api/v1/wallets/${walletId}`).then((response) => response.json()),
    ).resolves.toMatchObject({
      wallet: {
        ongoing_balance_cents: 500,
        recurring_transaction_rules: [
          {
            lago_id: ruleId,
            trigger: "threshold",
            interval: "weekly",
            threshold_credits: "2.5",
            granted_credits: "4",
            transaction_name: "Low balance grant",
            transaction_metadata: [{ key: "source", value: "threshold" }],
          },
        ],
      },
    });

    const updated = await request(`/api/v1/wallets/${walletId}`, "PUT", {
      wallet: {
        recurring_transaction_rules: [
          { lago_id: ruleId, trigger: "threshold", threshold_credits: "3", granted_credits: "5" },
        ],
      },
    });
    expect(updated.status).toBe(200);
    await expect(updated.json()).resolves.toMatchObject({
      wallet: {
        recurring_transaction_rules: [
          { lago_id: ruleId, trigger: "threshold", threshold_credits: "3", granted_credits: "5" },
        ],
      },
    });

    const changed = await request(`/api/v1/wallets/${walletId}`, "PUT", {
      wallet: {
        recurring_transaction_rules: [
          { lago_id: ruleId, trigger: "interval", interval: "monthly", granted_credits: "1" },
        ],
      },
    });
    expect(changed.status).toBe(200);
    const changedBody = await changed.json<{
      wallet: { recurring_transaction_rules: Array<{ lago_id: string; trigger: string }> };
    }>();
    const intervalRuleId = changedBody.wallet.recurring_transaction_rules[0]!.lago_id;
    expect(intervalRuleId).not.toBe(ruleId);
    expect(changedBody.wallet.recurring_transaction_rules[0]!.trigger).toBe("interval");
    await expect(
      env.BILLING_DB.prepare(
        `SELECT
           (SELECT status FROM wallet_threshold_rules WHERE id = ?) AS threshold_status,
           (SELECT status FROM recurring_transaction_rules WHERE id = ?) AS interval_status`,
      )
        .bind(ruleId, intervalRuleId)
        .first(),
    ).resolves.toEqual({ interval_status: "active", threshold_status: "terminated" });
  });

  it("replaces an elapsed rule and terminates its replacement with the wallet", async () => {
    const created = await request("/api/v1/wallets", "POST", {
      wallet: {
        external_customer_id: "customer-wallet-external",
        code: "elapsed-recurring-wallet",
        currency: "USD",
        rate_amount: "1",
        recurring_transaction_rules: [
          {
            trigger: "interval",
            interval: "monthly",
            granted_credits: "1",
            expiration_at: "2027-08-15T00:00:00.000Z",
          },
        ],
      },
    });
    const createdBody = await created.json<{
      wallet: { lago_id: string; recurring_transaction_rules: Array<{ lago_id: string }> };
    }>();
    const walletId = createdBody.wallet.lago_id;
    const elapsedRuleId = createdBody.wallet.recurring_transaction_rules[0]!.lago_id;
    await env.BILLING_DB.prepare(
      `UPDATE recurring_transaction_rules SET expiration_at = '2026-01-01T00:00:00.000Z'
       WHERE id = ?`,
    )
      .bind(elapsedRuleId)
      .run();

    const replaced = await request(`/api/v1/wallets/${walletId}`, "PUT", {
      wallet: {
        recurring_transaction_rules: [
          {
            lago_id: elapsedRuleId,
            trigger: "interval",
            interval: "weekly",
            granted_credits: "2",
            expiration_at: "2027-09-15T00:00:00.000Z",
          },
        ],
      },
    });
    expect(replaced.status).toBe(200);
    const replacementId = (
      await replaced.json<{
        wallet: { recurring_transaction_rules: Array<{ lago_id: string }> };
      }>()
    ).wallet.recurring_transaction_rules[0]!.lago_id;
    expect(replacementId).not.toBe(elapsedRuleId);
    expect((await request(`/api/v1/wallets/${walletId}`, "DELETE")).status).toBe(200);
    await expect(
      env.BILLING_DB.prepare(
        `SELECT
           (SELECT status FROM recurring_transaction_rules WHERE id = ?) AS elapsed_status,
           (SELECT status FROM recurring_transaction_rules WHERE id = ?) AS replacement_status,
           (SELECT COUNT(*) FROM recurring_transaction_rules
              WHERE wallet_id = ? AND status = 'active') AS active_rules`,
      )
        .bind(elapsedRuleId, replacementId, walletId)
        .first(),
    ).resolves.toEqual({
      active_rules: 0,
      elapsed_status: "terminated",
      replacement_status: "terminated",
    });
  });

  it("rolls wallet selection updates back when their outbox write fails", async () => {
    await createSection("wallet-rollback", "Wallet rollback");
    const created = await request("/api/v1/wallets", "POST", {
      wallet: {
        external_customer_id: "customer-wallet-external",
        code: "wallet-rollback",
        currency: "USD",
        rate_amount: "1",
        invoice_custom_section: {
          invoice_custom_section_codes: ["wallet-rollback"],
        },
        recurring_transaction_rules: [
          {
            trigger: "interval",
            interval: "monthly",
            granted_credits: "1",
            expiration_at: "2027-08-15T00:00:00.000Z",
          },
        ],
      },
    });
    const createdBody = await created.json<{
      wallet: { lago_id: string; recurring_transaction_rules: Array<{ lago_id: string }> };
    }>();
    const walletId = createdBody.wallet.lago_id;
    const ruleId = createdBody.wallet.recurring_transaction_rules[0]!.lago_id;
    await env.BILLING_DB.prepare(
      `CREATE TRIGGER fail_wallet_selection_outbox
       BEFORE INSERT ON outbox_events
       WHEN NEW.event_type = 'wallet.updated'
       BEGIN
         SELECT RAISE(ABORT, 'injected_wallet_selection_outbox_failure');
       END`,
    ).run();
    try {
      const failed = await request(`/api/v1/wallets/${walletId}`, "PUT", {
        wallet: {
          invoice_custom_section: { skip_invoice_custom_sections: true },
          recurring_transaction_rules: [{ lago_id: ruleId, granted_credits: "2" }],
        },
      });
      expect(failed.status).toBe(500);
    } finally {
      await env.BILLING_DB.prepare("DROP TRIGGER fail_wallet_selection_outbox").run();
    }
    await expect(
      request(`/api/v1/wallets/${walletId}`).then((response) => response.json()),
    ).resolves.toMatchObject({
      wallet: {
        applied_invoice_custom_sections: [{ invoice_custom_section: { code: "wallet-rollback" } }],
      },
    });
    await expect(
      env.BILLING_DB.prepare(
        `SELECT version, skip_invoice_custom_sections,
                (SELECT COUNT(*) FROM outbox_events
                 WHERE aggregate_id = wallets.id AND event_type = 'wallet.updated') AS updates,
                (SELECT granted_credits FROM recurring_transaction_rules
                 WHERE id = ?) AS recurring_granted_credits,
                (SELECT version FROM recurring_transaction_rules
                 WHERE id = ?) AS recurring_version
         FROM wallets WHERE id = ?`,
      )
        .bind(ruleId, ruleId, walletId)
        .first(),
    ).resolves.toEqual({
      recurring_granted_credits: "1",
      recurring_version: 1,
      skip_invoice_custom_sections: 0,
      updates: 0,
      version: 1,
    });
  });

  it("creates, serializes, replaces, and validates wallet limitations atomically", async () => {
    await env.BILLING_DB.batch([
      env.BILLING_DB.prepare(
        `INSERT INTO billable_metrics
         (id, organization_id, code, name, aggregation_type, properties_json,
          version, active, created_at, updated_at)
         VALUES ('metric-wallet-events', 'org-wallet', 'events', 'Events', 'count_agg', '{}',
                 1, 1, '2026-08-13T00:00:00.000Z', '2026-08-13T00:00:00.000Z')`,
      ),
      env.BILLING_DB.prepare(
        `INSERT OR IGNORE INTO organizations (id, external_id, name, created_at, updated_at)
         VALUES ('org-wallet-other', 'wallet-other', 'Wallet Other',
                 '2026-08-13T00:00:00.000Z', '2026-08-13T00:00:00.000Z')`,
      ),
      env.BILLING_DB.prepare(
        `INSERT INTO billable_metrics
         (id, organization_id, code, name, aggregation_type, properties_json,
          version, active, created_at, updated_at)
         VALUES ('metric-wallet-other', 'org-wallet-other', 'other-only', 'Other', 'count_agg',
                 '{}', 1, 1, '2026-08-13T00:00:00.000Z', '2026-08-13T00:00:00.000Z')`,
      ),
    ]);
    const payload = {
      wallet: {
        external_customer_id: "customer-wallet-external",
        code: "limited",
        currency: "USD",
        rate_amount: "1",
        applies_to: {
          fee_types: ["subscription", "subscription", "fixed_charge"],
          billable_metric_codes: ["events", "events"],
        },
      },
    };
    const created = await request("/api/v1/wallets", "POST", payload);
    expect(created.status).toBe(200);
    const createdBody = await created.json<{ wallet: { lago_id: string } }>();
    const walletId = createdBody.wallet.lago_id;
    await expect(
      request(`/api/v1/wallets/${walletId}`).then((response) => response.json()),
    ).resolves.toMatchObject({
      wallet: {
        applies_to: {
          fee_types: ["subscription", "fixed_charge"],
          billable_metric_codes: ["events"],
        },
      },
    });
    expect((await request("/api/v1/wallets", "POST", payload)).status).toBe(200);

    const updated = await request(`/api/v1/wallets/${walletId}`, "PUT", {
      wallet: { applies_to: { fee_types: ["charge"] } },
    });
    expect(updated.status).toBe(200);
    await expect(updated.json()).resolves.toMatchObject({
      wallet: {
        applies_to: { fee_types: ["charge"], billable_metric_codes: [] },
      },
    });

    const missing = await request(`/api/v1/wallets/${walletId}`, "PUT", {
      wallet: { applies_to: { billable_metric_codes: ["other-only"] } },
    });
    expect(missing.status).toBe(422);
    await expect(missing.json()).resolves.toMatchObject({ code: "invalid_identifier" });
    await expect(
      env.BILLING_DB.prepare(
        `SELECT allowed_fee_types_json,
                (SELECT COUNT(*) FROM wallet_targets WHERE wallet_id = wallets.id) AS targets
         FROM wallets WHERE id = ?`,
      )
        .bind(walletId)
        .first(),
    ).resolves.toEqual({ allowed_fee_types_json: '["charge"]', targets: 0 });

    await env.BILLING_DB.prepare(
      `CREATE TRIGGER fail_wallet_limitation_outbox
       BEFORE INSERT ON outbox_events
       WHEN NEW.event_type = 'wallet.updated' AND NEW.aggregate_id = '${walletId}'
       BEGIN
         SELECT RAISE(ABORT, 'injected_wallet_limitation_outbox_failure');
       END`,
    ).run();
    try {
      const failed = await request(`/api/v1/wallets/${walletId}`, "PUT", {
        wallet: {
          applies_to: {
            fee_types: ["subscription"],
            billable_metric_codes: ["events"],
          },
        },
      });
      expect(failed.status).toBe(500);
    } finally {
      await env.BILLING_DB.prepare("DROP TRIGGER fail_wallet_limitation_outbox").run();
    }
    await expect(
      env.BILLING_DB.prepare(
        `SELECT allowed_fee_types_json,
                (SELECT COUNT(*) FROM wallet_targets WHERE wallet_id = wallets.id) AS targets
         FROM wallets WHERE id = ?`,
      )
        .bind(walletId)
        .first(),
    ).resolves.toEqual({ allowed_fee_types_json: '["charge"]', targets: 0 });
  });

  it("drains applicable fee buckets across wallets in application order", async () => {
    await env.BILLING_DB.batch([
      env.BILLING_DB.prepare(
        `INSERT INTO customers
         (id, organization_id, external_id, currency, metadata_json, created_at, updated_at)
         VALUES ('customer-wallet-allocation', 'org-wallet', 'customer-wallet-allocation-external',
                 'USD', '{}', '2026-08-13T00:00:00.000Z', '2026-08-13T00:00:00.000Z')`,
      ),
      env.BILLING_DB.prepare(
        `INSERT INTO billable_metrics
         (id, organization_id, code, name, aggregation_type, properties_json,
          version, active, created_at, updated_at)
         VALUES ('metric-wallet-allocation', 'org-wallet', 'allocation-events',
                 'Allocation events', 'count_agg', '{}', 1, 1,
                 '2026-08-13T00:00:00.000Z', '2026-08-13T00:00:00.000Z')`,
      ),
    ]);
    const subscriptionWallet = await createLimitedWallet(
      "allocation-subscription",
      "3",
      10,
      { fee_types: ["subscription"] },
      "customer-wallet-allocation-external",
    );
    const metricWallet = await createLimitedWallet(
      "allocation-metric",
      "7",
      20,
      { billable_metric_codes: ["allocation-events"] },
      "customer-wallet-allocation-external",
    );
    const unrestrictedWallet = await createLimitedWallet(
      "allocation-unrestricted",
      "10",
      30,
      undefined,
      "customer-wallet-allocation-external",
    );

    const allocations = await calculateWalletAllocations(
      env.BILLING_DB,
      "org-wallet",
      "customer-wallet-allocation",
      "allocation-invoice",
      "USD",
      1300,
      [
        { feeType: "charge", billableMetricId: "metric-wallet-allocation", amountMinor: 600 },
        { feeType: "subscription", billableMetricId: null, amountMinor: 500 },
        { feeType: "fixed_charge", billableMetricId: null, amountMinor: 200 },
      ],
    );
    expect(allocations.map(({ walletId, amountMinor }) => ({ walletId, amountMinor }))).toEqual([
      { walletId: subscriptionWallet, amountMinor: 300 },
      { walletId: metricWallet, amountMinor: 600 },
      { walletId: unrestrictedWallet, amountMinor: 400 },
    ]);
    expect(
      allocations.flatMap((allocation) => allocation.lots).map((lot) => lot.amountMinor),
    ).toEqual([300, 600, 400]);
  });

  it("rejects paid wallet features explicitly", async () => {
    const response = await request("/api/v1/wallets", "POST", {
      wallet: {
        external_customer_id: "customer-wallet-external",
        code: "paid",
        currency: "USD",
        rate_amount: "1",
        paid_credits: "10",
      },
    });
    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toMatchObject({ code: "unsupported_wallet_feature" });
  });
});

async function createSection(code: string, name: string) {
  const response = await request("/api/v1/invoice_custom_sections", "POST", {
    invoice_custom_section: { code, name, details: `${name} details` },
  });
  expect(response.status).toBe(200);
}

async function createLimitedWallet(
  code: string,
  grantedCredits: string,
  priority: number,
  appliesTo?: { fee_types?: string[]; billable_metric_codes?: string[] },
  externalCustomerId = "customer-wallet-external",
): Promise<string> {
  const response = await request("/api/v1/wallets", "POST", {
    wallet: {
      external_customer_id: externalCustomerId,
      code,
      currency: "USD",
      rate_amount: "1",
      granted_credits: grantedCredits,
      priority,
      ...(appliesTo ? { applies_to: appliesTo } : {}),
    },
  });
  expect(response.status).toBe(200);
  return (await response.json<{ wallet: { lago_id: string } }>()).wallet.lago_id;
}

function fundedEnv() {
  return {
    BILLING_DB: env.BILLING_DB,
    DOMAIN_EVENTS: env.DOMAIN_EVENTS,
    WALLET_FUNDING_MODE: "stripe_test",
    STRIPE_NETWORK_MODE: "enabled",
    STRIPE_RESTRICTED_API_KEY: ["rk", "test", "synthetic_wallet_rules"].join("_"),
    STRIPE_ACCOUNT_CODE: "synthetic-stripe-test",
    STRIPE_ORGANIZATION_ID: "org-wallet",
    STRIPE_LIVEMODE_ALLOWED: "0",
  } as const;
}

async function fundedWalletRequest(code: string, rule: Record<string, unknown>): Promise<Response> {
  const response = await handleWalletLedgerRequest(
    new Request("https://lago.test/api/v1/wallets", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        wallet: {
          external_customer_id: "customer-wallet-external",
          code,
          currency: "USD",
          rate_amount: "1",
          recurring_transaction_rules: [rule],
        },
      }),
    }),
    fundedEnv(),
    {
      organizationId: "org-wallet",
      organizationExternalId: "wallet-test",
      apiKeyId: "key-wallet",
    },
    `request-${code}`,
  );
  if (!response) throw new Error("wallet_request_not_handled");
  return response;
}

function request(
  path: string,
  method = "GET",
  body?: unknown,
  headers?: Record<string, string>,
): Promise<Response> {
  return SELF.fetch(`https://lago.test${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      ...(body ? { "Content-Type": "application/json" } : {}),
      ...headers,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
}
