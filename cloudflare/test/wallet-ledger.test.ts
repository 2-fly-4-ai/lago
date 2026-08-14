import { env, SELF } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { sha256Hex } from "../src/auth/api-key";

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

  it("rejects provider-funded and threshold recurring rules without creating a wallet", async () => {
    for (const [code, recurringRule] of [
      [
        "recurring-paid",
        { trigger: "interval", interval: "monthly", paid_credits: "1", granted_credits: "0" },
      ],
      [
        "recurring-threshold",
        { trigger: "threshold", threshold_credits: "1", granted_credits: "2" },
      ],
    ] as const) {
      const response = await request("/api/v1/wallets", "POST", {
        wallet: {
          external_customer_id: "customer-wallet-external",
          code,
          currency: "USD",
          rate_amount: "1",
          recurring_transaction_rules: [recurringRule],
        },
      });
      expect(response.status).toBe(422);
      await expect(response.json()).resolves.toMatchObject({
        code: "unsupported_recurring_wallet_feature",
      });
    }
    await expect(
      env.BILLING_DB.prepare(
        `SELECT COUNT(*) AS total FROM wallets
         WHERE code IN ('recurring-paid', 'recurring-threshold')`,
      ).first(),
    ).resolves.toEqual({ total: 0 });
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

  it("rejects paid and targeted wallet features explicitly", async () => {
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
