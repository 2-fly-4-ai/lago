import { env, SELF } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { sha256Hex } from "../src/auth/api-key";

const apiKey = "credit-note-ledger-key";

beforeEach(async () => {
  const now = "2026-08-14T00:00:00.000Z";
  await env.BILLING_DB.batch([
    env.BILLING_DB.prepare(
      `INSERT OR IGNORE INTO organizations (id, external_id, name, created_at, updated_at)
       VALUES ('org-credit-note', 'credit-note-test', 'Credit Note Test', ?, ?)`,
    ).bind(now, now),
    env.BILLING_DB.prepare(
      `INSERT OR IGNORE INTO api_keys
       (id, organization_id, key_prefix, key_hash, created_at, revoked_at)
       VALUES ('key-credit-note', 'org-credit-note', 'credit-n', ?, ?, NULL)`,
    ).bind(await sha256Hex(apiKey), now),
    env.BILLING_DB.prepare(
      `INSERT OR IGNORE INTO customers
       (id, organization_id, external_id, currency, metadata_json, created_at, updated_at)
       VALUES ('customer-credit-note', 'org-credit-note', 'customer-credit-note-external',
               'USD', '{}', ?, ?)`,
    ).bind(now, now),
  ]);
});

describe("credit-note ledger", () => {
  it("issues credit-only notes, applies their balance, recredits void invoices, and voids safely", async () => {
    expect(
      (
        await request("/api/v1/plans", "POST", {
          plan: {
            code: "credit-note-plan",
            name: "Credit note plan",
            interval: "monthly",
            amount_cents: 1000,
            amount_currency: "USD",
            pay_in_advance: true,
          },
        })
      ).status,
    ).toBe(200);
    expect((await createSubscription("credit-note-source-subscription")).status).toBe(200);

    const source = await env.BILLING_DB.prepare(
      `SELECT i.id AS invoice_id, il.id AS line_id
       FROM subscriptions s JOIN invoices i ON i.subscription_id = s.id
       JOIN invoice_lines il ON il.invoice_id = i.id
       WHERE s.organization_id = 'org-credit-note'
         AND s.external_id = 'credit-note-source-subscription' LIMIT 1`,
    ).first<{ invoice_id: string; line_id: string }>();
    expect(source).not.toBeNull();
    const body = {
      credit_note: {
        invoice_id: source!.invoice_id,
        reason: "order_change",
        description: "Service credit",
        credit_amount_cents: 600,
        items: [{ fee_id: source!.line_id, amount_cents: 600 }],
      },
    };

    const missingKey = await request("/api/v1/credit_notes", "POST", body);
    expect(missingKey.status).toBe(422);
    await expect(missingKey.json()).resolves.toMatchObject({ code: "idempotency_key_required" });

    const created = await request("/api/v1/credit_notes", "POST", body, {
      "Idempotency-Key": "credit-note-600",
    });
    expect(created.status).toBe(200);
    const createdBody = await created.json<{
      credit_note: { lago_id: string; balance_amount_cents: number };
    }>();
    expect(createdBody.credit_note).toMatchObject({
      credit_status: "available",
      total_amount_cents: 600,
      balance_amount_cents: 600,
      reason: "order_change",
      items: [{ fee: { lago_id: source!.line_id }, amount_cents: 600 }],
    });
    const creditNoteId = createdBody.credit_note.lago_id;

    await expect(
      request("/api/v1/credit_notes", "POST", body, {
        "Idempotency-Key": "credit-note-600",
      }).then((response) => response.json()),
    ).resolves.toMatchObject({ credit_note: { lago_id: creditNoteId } });
    const conflict = await request(
      "/api/v1/credit_notes",
      "POST",
      {
        credit_note: {
          ...body.credit_note,
          credit_amount_cents: 500,
          items: [{ fee_id: source!.line_id, amount_cents: 500 }],
        },
      },
      { "Idempotency-Key": "credit-note-600" },
    );
    expect(conflict.status).toBe(409);
    await expect(conflict.json()).resolves.toMatchObject({ code: "idempotency_conflict" });

    const overCredit = await request(
      "/api/v1/credit_notes",
      "POST",
      {
        credit_note: {
          ...body.credit_note,
          credit_amount_cents: 401,
          items: [{ fee_id: source!.line_id, amount_cents: 401 }],
        },
      },
      { "Idempotency-Key": "credit-note-over-credit" },
    );
    expect(overCredit.status).toBe(422);
    await expect(overCredit.json()).resolves.toMatchObject({
      code: "higher_than_remaining_fee_amount",
    });

    expect((await createSubscription("credit-note-target-subscription")).status).toBe(200);
    const target = await env.BILLING_DB.prepare(
      `SELECT i.id FROM subscriptions s JOIN invoices i ON i.subscription_id = s.id
       WHERE s.organization_id = 'org-credit-note'
         AND s.external_id = 'credit-note-target-subscription' LIMIT 1`,
    ).first<{ id: string }>();
    expect(target).not.toBeNull();

    await expect(
      request(`/api/v1/invoices/${target!.id}`).then((response) => response.json()),
    ).resolves.toMatchObject({
      invoice: {
        fees_amount_cents: 1000,
        credit_notes_amount_cents: 600,
        prepaid_credit_amount_cents: 0,
        total_amount_cents: 400,
      },
    });
    await expect(
      request(`/api/v1/credit_notes/${creditNoteId}`).then((response) => response.json()),
    ).resolves.toMatchObject({
      credit_note: { credit_status: "consumed", balance_amount_cents: 0 },
    });
    expect((await request(`/api/v1/credit_notes/${creditNoteId}/void`, "PUT")).status).toBe(422);

    expect((await request(`/api/v1/invoices/${target!.id}/void`, "POST")).status).toBe(200);
    expect((await request(`/api/v1/invoices/${target!.id}/void`, "POST")).status).toBe(200);
    await expect(
      env.BILLING_DB.prepare(
        `SELECT cn.balance_amount_minor, cn.credit_status,
                (SELECT COUNT(*) FROM credit_note_recredits WHERE voided_invoice_id = ?) AS recredits
         FROM credit_notes cn WHERE cn.id = ?`,
      )
        .bind(target!.id, creditNoteId)
        .first(),
    ).resolves.toEqual({ balance_amount_minor: 600, credit_status: "available", recredits: 1 });

    const voided = await request(`/api/v1/credit_notes/${creditNoteId}/void`, "PUT");
    expect(voided.status).toBe(200);
    await expect(voided.json()).resolves.toMatchObject({
      credit_note: { credit_status: "voided", balance_amount_cents: 0 },
    });
    expect((await request(`/api/v1/credit_notes/${creditNoteId}/void`, "PUT")).status).toBe(200);
    await expect(
      request("/api/v1/credit_notes").then((response) => response.json()),
    ).resolves.toMatchObject({ credit_notes: [{ lago_id: creditNoteId }] });
  });

  it("rejects provider refunds and reports a missing document", async () => {
    const refund = await request(
      "/api/v1/credit_notes",
      "POST",
      { credit_note: { refund_amount_cents: 1 } },
      { "Idempotency-Key": "unsupported-refund" },
    );
    expect(refund.status).toBe(422);
    await expect(refund.json()).resolves.toMatchObject({
      code: "unsupported_credit_note_side_effect",
    });
    const document = await request("/api/v1/credit_notes/unknown/download", "POST");
    expect(document.status).toBe(404);
    await expect(document.json()).resolves.toMatchObject({
      code: "credit_note_not_found",
    });
  });
});

function createSubscription(externalId: string) {
  return request("/api/v1/subscriptions", "POST", {
    subscription: {
      external_customer_id: "customer-credit-note-external",
      external_id: externalId,
      plan_code: "credit-note-plan",
    },
  });
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
