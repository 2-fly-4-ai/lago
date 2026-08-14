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
    expect(replay.status).toBe(422);
    await expect(replay.json()).resolves.toMatchObject({ code: "invoice_not_draft" });
  });
});
