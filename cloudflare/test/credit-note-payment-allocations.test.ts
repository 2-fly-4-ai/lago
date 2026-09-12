import { env } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import { createCreditNote } from "../src/api/credit-note-ledger";

async function fixture(total = 600, mirror = false) {
  const org = crypto.randomUUID();
  const customer = crypto.randomUUID();
  const invoices = [crypto.randomUUID(), crypto.randomUUID()];
  const lines = [crypto.randomUUID(), crypto.randomUUID()];
  const request = crypto.randomUUID();
  const payment = crypto.randomUUID();
  const now = "2026-09-13T00:00:00.000Z";
  await env.BILLING_DB.batch([
    env.BILLING_DB.prepare(`INSERT INTO organizations (id, external_id, name, created_at, updated_at)
      VALUES (?, ?, 'Synthetic allocation test', ?, ?)`).bind(org, org, now, now),
    env.BILLING_DB.prepare(`INSERT INTO customers (id, organization_id, external_id, currency, created_at, updated_at)
      VALUES (?, ?, ?, 'USD', ?, ?)`).bind(customer, org, customer, now, now),
    ...invoices.flatMap((invoice, index) => [
      env.BILLING_DB.prepare(`INSERT INTO invoices
        (id, organization_id, customer_id, number, status, payment_status, currency, subtotal_minor, total_due_minor, finalized_at, created_at, updated_at)
        VALUES (?, ?, ?, ?, 'finalized', 'pending', 'USD', ?, ?, ?, ?, ?)`).bind(
        invoice,
        org,
        customer,
        invoice,
        index === 0 ? total : 400,
        index === 0 ? total : 400,
        now,
        now,
        now,
      ),
      env.BILLING_DB.prepare(`INSERT INTO invoice_lines
        (id, invoice_id, line_type, description, quantity_decimal, unit_amount_decimal, amount_minor, source_type, source_id, created_at)
        VALUES (?, ?, 'subscription', 'Synthetic fee', '1', ?, ?, 'subscription', ?, ?)`).bind(
        lines[index],
        invoice,
        String(index === 0 ? total : 400),
        index === 0 ? total : 400,
        invoice,
        now,
      ),
    ]),
    env.BILLING_DB.prepare(`INSERT INTO payment_requests
      (id, organization_id, customer_id, amount_minor, currency, payment_status, collection_mode, created_at, updated_at)
      VALUES (?, ?, ?, 1000, 'USD', 'succeeded', 'checkout', ?, ?)`).bind(
      request,
      org,
      customer,
      now,
      now,
    ),
    ...invoices.map((invoice) =>
      env.BILLING_DB.prepare(`INSERT INTO invoices_payment_requests
      (id, organization_id, payment_request_id, invoice_id, invoice_version, created_at, updated_at)
      VALUES (?, ?, ?, ?, 1, ?, ?)`).bind(crypto.randomUUID(), org, request, invoice, now, now),
    ),
    env.BILLING_DB.prepare(`INSERT INTO payment_request_payments
      (id, organization_id, payment_request_id, provider, provider_account_code, provider_transaction_id, idempotency_key, amount_minor, currency, status, created_at, updated_at)
      VALUES (?, ?, ?, 'easy_pay_direct', 'synthetic', ?, ?, 1000, 'USD', 'succeeded', ?, ?)`).bind(
      payment,
      org,
      request,
      payment,
      payment,
      now,
      now,
    ),
    ...invoices.map((invoice, index) =>
      env.BILLING_DB.prepare(`INSERT INTO payment_request_payment_allocations
      (id, organization_id, payment_request_payment_id, payment_request_id, invoice_id, amount_minor, currency, created_at)
      VALUES (?, ?, ?, ?, ?, ?, 'USD', ?)`).bind(
        crypto.randomUUID(),
        org,
        payment,
        request,
        invoice,
        index === 0 ? 600 : 400,
        now,
      ),
    ),
  ]);
  if (mirror)
    await env.BILLING_DB.prepare(`INSERT INTO payment_attempts
    (id, organization_id, invoice_id, provider, provider_account_code, provider_transaction_id, idempotency_key, amount_minor, currency, status, created_at, updated_at)
    VALUES (?, ?, ?, 'easy_pay_direct', 'synthetic', ?, ?, 600, 'USD', 'succeeded', ?, ?)`)
      .bind(crypto.randomUUID(), org, invoices[0], payment, crypto.randomUUID(), now, now)
      .run();
  const provider = vi.fn<typeof fetch>();
  return {
    org,
    invoices,
    provider,
    submit: (
      kind: "refund" | "offset" | "credit",
      amount: number,
      index = 0,
      database = env.BILLING_DB,
    ) =>
      createCreditNote(
        new Request("https://synthetic.test/api/v1/credit_notes", {
          method: "POST",
          headers: { "Content-Type": "application/json", "Idempotency-Key": crypto.randomUUID() },
          body: JSON.stringify({
            credit_note: {
              invoice_id: invoices[index],
              [`${kind}_amount_cents`]: amount,
              items: [{ fee_id: lines[index], amount_cents: amount }],
            },
          }),
        }),
        { ...env, BILLING_DB: database, CREDIT_NOTE_REFUND_MODE: "sandbox" },
        { organizationId: org, organizationExternalId: org, apiKeyId: "synthetic" },
        "synthetic-allocation-test",
        provider,
      ),
  };
}

describe("credit notes funded by request allocations", () => {
  it("explicitly rejects shared-payment refunds on both invoices before any side effect", async () => {
    const f = await fixture();
    for (const index of [0, 1])
      await expect(f.submit("refund", 100, index)).rejects.toMatchObject({
        status: 422,
        code: "payment_request_refund_unsupported",
      });
    expect(f.provider).not.toHaveBeenCalled();
    for (const table of ["credit_notes", "credit_note_refunds", "provider_refund_operations"])
      expect(
        await env.BILLING_DB.prepare(
          `SELECT COUNT(*) AS count FROM ${table} WHERE organization_id = ?`,
        )
          .bind(f.org)
          .first<number>("count"),
      ).toBe(0);
    expect(
      await env.BILLING_DB.prepare(
        "SELECT amount_minor FROM payment_request_payments WHERE organization_id = ?",
      )
        .bind(f.org)
        .first<number>("amount_minor"),
    ).toBe(1000);
  });

  it("prevents an offset against an invoice already paid by a shared request", async () => {
    const f = await fixture();
    await expect(f.submit("offset", 100)).rejects.toMatchObject({
      status: 422,
      code: "offset_amount_exceeds_due_amount",
    });
  });

  it.each([false, true])(
    "applies the exact remaining balance with mirror=%s and closes the invoice",
    async (mirror) => {
      const f = await fixture(1000, mirror);
      expect((await f.submit("offset", 400)).status).toBe(200);
      expect(
        await env.BILLING_DB.prepare(
          "SELECT total_due_minor, payment_status, ready_for_payment_processing FROM invoices WHERE id = ?",
        )
          .bind(f.invoices[0])
          .first(),
      ).toMatchObject({
        total_due_minor: 600,
        payment_status: "succeeded",
        ready_for_payment_processing: 0,
      });
    },
  );

  it("continues to allow credit-only notes on shared-payment invoices", async () => {
    const f = await fixture();
    expect((await f.submit("credit", 100)).status).toBe(200);
    expect(f.provider).not.toHaveBeenCalled();
  });

  it("rolls back the entire offset note when collection consumes the balance after preflight", async () => {
    const f = await fixture(1000);
    let raced = false;
    const database = new Proxy(env.BILLING_DB, {
      get(target, property) {
        if (property === "batch")
          return async (statements: D1PreparedStatement[]) => {
            if (!raced) {
              raced = true;
              await target
                .prepare(`INSERT INTO payment_attempts
              (id, organization_id, invoice_id, provider, provider_account_code, provider_transaction_id,
               idempotency_key, amount_minor, currency, status, created_at, updated_at)
              VALUES (?, ?, ?, 'easy_pay_direct', 'synthetic', ?, ?, 400, 'USD', 'succeeded', '2026-09-13', '2026-09-13')`)
                .bind(
                  crypto.randomUUID(),
                  f.org,
                  f.invoices[0],
                  crypto.randomUUID(),
                  crypto.randomUUID(),
                )
                .run();
            }
            return target.batch(statements);
          };
        const value = Reflect.get(target, property);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    await expect(f.submit("offset", 400, 0, database)).rejects.toMatchObject({
      code: "credit_note_sequence_conflict",
    });
    expect(raced).toBe(true);
    for (const table of ["credit_notes", "credit_note_offsets"])
      expect(
        await env.BILLING_DB.prepare(
          `SELECT COUNT(*) AS count FROM ${table} WHERE organization_id = ?`,
        )
          .bind(f.org)
          .first<number>("count"),
      ).toBe(0);
    expect(
      await env.BILLING_DB.prepare(
        "SELECT COUNT(*) AS count FROM outbox_events WHERE organization_id = ? AND event_type = 'credit_note.created'",
      )
        .bind(f.org)
        .first<number>("count"),
    ).toBe(0);
    expect(
      await env.BILLING_DB.prepare("SELECT total_due_minor FROM invoices WHERE id = ?")
        .bind(f.invoices[0])
        .first<number>("total_due_minor"),
    ).toBe(1000);
  });
});
