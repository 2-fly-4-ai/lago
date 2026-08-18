import { env, SELF } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { sha256Hex } from "../src/auth/api-key";
import { createCreditNote } from "../src/api/credit-note-ledger";

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

  it("snapshots proportional coupon and tax adjustments without rounding drift", async () => {
    expect(
      (
        await request("/api/v1/taxes", "POST", {
          tax: {
            code: "credit-note-tax",
            name: "Credit note tax",
            rate: 10,
            applied_to_organization: true,
          },
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await request("/api/v1/coupons", "POST", {
          coupon: {
            code: "CREDIT-NOTE-COUPON",
            name: "Credit note coupon",
            coupon_type: "percentage",
            percentage_rate: 10,
            frequency: "once",
          },
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await request(
          "/api/v1/applied_coupons",
          "POST",
          {
            applied_coupon: {
              external_customer_id: "customer-credit-note-external",
              coupon_code: "CREDIT-NOTE-COUPON",
            },
          },
          { "Idempotency-Key": "credit-note-coupon-application" },
        )
      ).status,
    ).toBe(200);
    expect(
      (
        await request("/api/v1/plans", "POST", {
          plan: {
            code: "credit-note-adjustment-plan",
            name: "Credit note adjustment plan",
            interval: "monthly",
            amount_cents: 1000,
            amount_currency: "USD",
            pay_in_advance: true,
          },
        })
      ).status,
    ).toBe(200);
    expect(
      (await createSubscription("credit-note-adjustment-source", "credit-note-adjustment-plan"))
        .status,
    ).toBe(200);
    const source = await sourceInvoice("credit-note-adjustment-source");

    const noteIds: string[] = [];
    for (const [index, amount] of [251, 749].entries()) {
      const coupon = index === 0 ? 25 : 75;
      const tax = index === 0 ? 23 : 67;
      const total = amount - coupon + tax;
      const response = await request(
        "/api/v1/credit_notes",
        "POST",
        {
          credit_note: {
            invoice_id: source.invoice_id,
            credit_amount_cents: total,
            items: [{ fee_id: source.line_id, amount_cents: amount }],
          },
        },
        { "Idempotency-Key": `adjusted-credit-note-${index}` },
      );
      expect(response.status).toBe(200);
      const body = await response.json<{ credit_note: { lago_id: string } }>();
      noteIds.push(body.credit_note.lago_id);
      expect(body).toMatchObject({
        credit_note: {
          total_amount_cents: total,
          taxes_amount_cents: tax,
          coupons_adjustment_amount_cents: coupon,
          sub_total_excluding_taxes_amount_cents: amount - coupon,
          applied_taxes: [
            {
              tax_code: "credit-note-tax",
              amount_cents: tax,
              taxable_base_amount_cents: amount - coupon,
            },
          ],
        },
      });
    }
    await expect(
      env.BILLING_DB.prepare(
        `SELECT SUM(financial.taxes_amount_minor) AS taxes,
                SUM(financial.coupons_adjustment_minor) AS coupons,
                SUM(financial.total_amount_minor) AS total
         FROM credit_note_financials financial
         JOIN credit_notes note ON note.id = financial.credit_note_id
         WHERE note.invoice_id = ?`,
      )
        .bind(source.invoice_id)
        .first(),
    ).resolves.toEqual({ coupons: 100, taxes: 90, total: 990 });
    for (const noteId of noteIds)
      expect((await request(`/api/v1/credit_notes/${noteId}/void`, "PUT")).status).toBe(200);
    expect((await request("/api/v1/taxes/credit-note-tax", "DELETE")).status).toBe(200);
  });

  it("applies internal offsets and keeps provider refunds fail-closed by default", async () => {
    expect(
      (
        await request("/api/v1/plans", "POST", {
          plan: {
            code: "credit-note-split-plan",
            name: "Credit note split plan",
            interval: "monthly",
            amount_cents: 1000,
            amount_currency: "USD",
            pay_in_advance: true,
            tax_codes: [],
          },
        })
      ).status,
    ).toBe(200);
    expect(
      (await createSubscription("credit-note-split-source", "credit-note-split-plan")).status,
    ).toBe(200);
    const source = await sourceInvoice("credit-note-split-source");
    const offset = await request(
      "/api/v1/credit_notes",
      "POST",
      {
        credit_note: {
          invoice_id: source.invoice_id,
          credit_amount_cents: 0,
          offset_amount_cents: 1000,
          items: [{ fee_id: source.line_id, amount_cents: 1000 }],
        },
      },
      { "Idempotency-Key": "credit-note-internal-offset" },
    );
    expect(offset.status).toBe(200);
    await expect(offset.json()).resolves.toMatchObject({
      credit_note: {
        total_amount_cents: 1000,
        credit_status: "consumed",
        credit_amount_cents: 0,
        balance_amount_cents: 0,
        offset_amount_cents: 1000,
      },
    });
    await expect(
      env.BILLING_DB.prepare(
        `SELECT total_due_minor, credit_notes_minor,
                (SELECT COUNT(*) FROM credit_note_offsets WHERE invoice_id = invoices.id) AS offsets
         FROM invoices WHERE id = ?`,
      )
        .bind(source.invoice_id)
        .first(),
    ).resolves.toEqual({ credit_notes_minor: 1000, offsets: 1, total_due_minor: 0 });

    expect(
      (await createSubscription("credit-note-refund-source", "credit-note-split-plan")).status,
    ).toBe(200);
    const refundSource = await sourceInvoice("credit-note-refund-source");
    const refund = await request(
      "/api/v1/credit_notes",
      "POST",
      {
        credit_note: {
          invoice_id: refundSource.invoice_id,
          refund_amount_cents: 1000,
          items: [{ fee_id: refundSource.line_id, amount_cents: 1000 }],
        },
      },
      { "Idempotency-Key": "disabled-refund" },
    );
    expect(refund.status).toBe(503);
    await expect(refund.json()).resolves.toMatchObject({
      code: "credit_note_refunds_disabled",
    });
    const document = await request("/api/v1/credit_notes/unknown/download", "POST");
    expect(document.status).toBe(404);
    await expect(document.json()).resolves.toMatchObject({
      code: "credit_note_not_found",
    });
  });

  it("records a sandbox refund without any external provider request", async () => {
    expect(
      (
        await request("/api/v1/plans", "POST", {
          plan: {
            code: "credit-note-refund-plan",
            name: "Credit note refund plan",
            interval: "monthly",
            amount_cents: 1000,
            amount_currency: "USD",
            pay_in_advance: true,
            tax_codes: [],
          },
        })
      ).status,
    ).toBe(200);
    expect(
      (await createSubscription("credit-note-sandbox-refund-source", "credit-note-refund-plan"))
        .status,
    ).toBe(200);
    const source = await sourceInvoice("credit-note-sandbox-refund-source");
    const now = new Date().toISOString();
    await env.BILLING_DB.prepare(
      `INSERT INTO payment_attempts
       (id, organization_id, invoice_id, provider, provider_account_code,
        provider_transaction_id, idempotency_key, amount_minor, currency, status,
        payment_type, version, created_at, updated_at)
       VALUES ('credit-note-paid-attempt', 'org-credit-note', ?, 'sandbox', 'sandbox',
               'sandbox-payment', 'credit-note-paid-attempt', 1000, 'USD', 'succeeded',
               'provider', 1, ?, ?)`,
    )
      .bind(source.invoice_id, now, now)
      .run();
    const response = await createCreditNote(
      new Request("https://lago.test/api/v1/credit_notes", {
        method: "POST",
        headers: { "Content-Type": "application/json", "Idempotency-Key": "sandbox-refund" },
        body: JSON.stringify({
          credit_note: {
            invoice_id: source.invoice_id,
            refund_amount_cents: 1000,
            items: [{ fee_id: source.line_id, amount_cents: 1000 }],
          },
        }),
      }),
      { ...env, CREDIT_NOTE_REFUND_MODE: "sandbox" },
      {
        organizationId: "org-credit-note",
        organizationExternalId: "credit-note-test",
        apiKeyId: "key-credit-note",
      },
      "sandbox-refund-request",
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      credit_note: {
        credit_status: "consumed",
        refund_status: "succeeded",
        credit_amount_cents: 0,
        refund_amount_cents: 1000,
      },
    });
    await expect(
      env.BILLING_DB.prepare(
        "SELECT provider_mode, status, amount_minor FROM credit_note_refunds WHERE invoice_id = ?",
      )
        .bind(source.invoice_id)
        .first(),
    ).resolves.toEqual({ amount_minor: 1000, provider_mode: "sandbox", status: "succeeded" });
  });
});

function createSubscription(externalId: string, planCode = "credit-note-plan") {
  return request("/api/v1/subscriptions", "POST", {
    subscription: {
      external_customer_id: "customer-credit-note-external",
      external_id: externalId,
      plan_code: planCode,
    },
  });
}

async function sourceInvoice(externalId: string) {
  const source = await env.BILLING_DB.prepare(
    `SELECT i.id AS invoice_id, il.id AS line_id
     FROM subscriptions subscription JOIN invoices i ON i.subscription_id = subscription.id
     JOIN invoice_lines il ON il.invoice_id = i.id
     WHERE subscription.organization_id = 'org-credit-note'
       AND subscription.external_id = ? LIMIT 1`,
  )
    .bind(externalId)
    .first<{ invoice_id: string; line_id: string }>();
  if (!source) throw new Error("source invoice was not created");
  return source;
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
