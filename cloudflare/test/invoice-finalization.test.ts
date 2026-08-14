import { env, SELF } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { sha256Hex } from "../src/auth/api-key";

const apiKey = "invoice-finalization-key";
const headers = { Authorization: `Bearer ${apiKey}` };

beforeEach(async () => {
  const now = "2026-08-14T00:00:00.000Z";
  await env.BILLING_DB.batch([
    env.BILLING_DB.prepare(
      `INSERT OR IGNORE INTO organizations
       (id, external_id, name, net_payment_term, created_at, updated_at)
       VALUES ('org-finalization', 'finalization', 'Finalization Test', 0, ?, ?)`,
    ).bind(now, now),
    env.BILLING_DB.prepare(
      `INSERT OR IGNORE INTO api_keys
       (id, organization_id, key_prefix, key_hash, created_at, revoked_at)
       VALUES ('key-finalization', 'org-finalization', 'finalization', ?, ?, NULL)`,
    ).bind(await sha256Hex(apiKey), now),
    env.BILLING_DB.prepare(
      `INSERT OR IGNORE INTO customers
       (id, organization_id, external_id, currency, metadata_json, net_payment_term,
        created_at, updated_at)
       VALUES ('customer-finalization', 'org-finalization', 'customer-finalization', 'USD',
               '{}', 14, ?, ?)`,
    ).bind(now, now),
    env.BILLING_DB.prepare(
      `INSERT OR IGNORE INTO invoices
       (id, organization_id, customer_id, number, status, payment_status, currency,
        subtotal_minor, tax_minor, credits_minor, total_due_minor, version, finalized_at,
        net_payment_term, payment_due_date, payment_overdue, issuing_date,
        expected_finalization_date, created_at, updated_at)
       VALUES ('invoice-finalization', 'org-finalization', 'customer-finalization',
               'INV-FINALIZATION', 'draft', 'pending', 'USD', 1000, 0, 0, 1000, 1, NULL,
               14, NULL, 0, '2026-08-10', '2026-08-14', ?, ?)`,
    ).bind(now, now),
  ]);
});

describe("invoice finalization", () => {
  it("finalizes a tenant-owned draft and snapshots its due date", async () => {
    const response = await SELF.fetch(
      "https://lago.test/api/v1/invoices/invoice-finalization/finalize",
      { method: "PUT", headers },
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      invoice: {
        lago_id: "invoice-finalization",
        issuing_date: "2026-08-10",
        payment_due_date: "2026-08-24",
        status: "finalized",
      },
    });
    await expect(
      env.BILLING_DB.prepare(
        `SELECT status, version,
                (SELECT COUNT(*) FROM outbox_events
                 WHERE aggregate_id = 'invoice-finalization'
                   AND event_type = 'invoice.finalized') AS events
         FROM invoices WHERE id = 'invoice-finalization'`,
      ).first(),
    ).resolves.toEqual({ events: 1, status: "finalized", version: 2 });

    const replay = await SELF.fetch(
      "https://lago.test/api/v1/invoices/invoice-finalization/finalize",
      { method: "PUT", headers },
    );
    expect(replay.status).toBe(200);
    await expect(replay.json()).resolves.toMatchObject({
      invoice: { status: "finalized", version_number: 2 },
    });
  });

  it("aborts the losing draft mutation batch before later statements can commit", async () => {
    const now = "2026-08-14T01:00:00.000Z";
    await env.BILLING_DB.prepare(
      `INSERT INTO invoices
       (id, organization_id, customer_id, number, status, payment_status, currency,
        subtotal_minor, tax_minor, credits_minor, total_due_minor, version, net_payment_term,
        payment_overdue, issuing_date, expected_finalization_date, created_at, updated_at)
       VALUES ('invoice-guard', 'org-finalization', 'customer-finalization', 'INV-GUARD',
               'draft', 'pending', 'USD', 100, 0, 0, 100, 1, 0, 0,
               '2026-08-14', '2026-08-15', ?, ?)`,
    )
      .bind(now, now)
      .run();

    const mutate = (commandId: string, total: number) =>
      env.BILLING_DB.batch([
        env.BILLING_DB.prepare(
          `INSERT INTO invoice_mutation_guards
           (command_id, organization_id, invoice_id, operation, expected_version,
            resulting_version, created_at)
           VALUES (?, 'org-finalization', 'invoice-guard', 'refresh', 1, 2, ?)`,
        ).bind(commandId, now),
        env.BILLING_DB.prepare(
          `UPDATE invoices SET subtotal_minor = ?, total_due_minor = ?, version = 2
           WHERE id = 'invoice-guard' AND status = 'draft' AND version = 1`,
        ).bind(total, total),
      ]);
    const outcomes = await Promise.allSettled([
      mutate("guard-command-a", 110),
      mutate("guard-command-b", 120),
    ]);
    expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome.status === "rejected")).toHaveLength(1);
    await expect(
      env.BILLING_DB.prepare(
        `SELECT version, subtotal_minor,
                (SELECT COUNT(*) FROM invoice_mutation_guards
                 WHERE invoice_id = 'invoice-guard') AS guards
         FROM invoices WHERE id = 'invoice-guard'`,
      ).first(),
    ).resolves.toMatchObject({ guards: 1, version: 2 });
  });
});
