import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { reconcileEasyPayDirectReceipt } from "../src/reconciliation/easy-pay-direct";

async function fixture() {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  await env.BILLING_DB.batch([
    env.BILLING_DB.prepare(`INSERT INTO organizations (id, external_id, name, created_at, updated_at)
      VALUES (?, ?, 'Dispute QA', ?, ?)`).bind(id, id, now, now),
    env.BILLING_DB.prepare(`INSERT INTO customers (id, organization_id, external_id, email, created_at, updated_at)
      VALUES (?, ?, ?, 'fictional@example.invalid', ?, ?)`).bind(id, id, id, now, now),
    env.BILLING_DB.prepare(`INSERT INTO invoices (id, organization_id, customer_id, status, payment_status,
      currency, subtotal_minor, total_due_minor, created_at, updated_at)
      VALUES (?, ?, ?, 'finalized', 'succeeded', 'USD', 900, 900, ?, ?)`).bind(
      id,
      id,
      id,
      now,
      now,
    ),
    env.BILLING_DB.prepare(`INSERT INTO payment_attempts (id, organization_id, invoice_id, provider,
      provider_account_code, provider_transaction_id, idempotency_key, amount_minor, currency, status, created_at, updated_at)
      VALUES (?, ?, ?, 'easy_pay_direct', ?, ?, ?, 900, 'USD', 'succeeded', ?, ?)`).bind(
      id,
      id,
      id,
      id,
      id,
      id,
      now,
      now,
    ),
  ]);
  async function receipt(
    status: string,
    created: unknown,
    amount = 900,
    livemode = false,
    metadata: Record<string, string> = {},
  ) {
    const receiptId = crypto.randomUUID();
    const archiveKey = `fictional-disputes/${receiptId}.json`;
    await env.BILLING_ARTIFACTS.put(
      archiveKey,
      JSON.stringify({
        id: receiptId,
        type: `order.chargeback.${status}`,
        created,
        livemode,
        data: { object: { id, object: "order", status, total: amount, currency: "usd", metadata } },
      }),
    );
    await env.BILLING_DB.batch([
      env.BILLING_DB.prepare(`INSERT INTO webhook_receipts (id, provider, provider_account_code,
        provider_event_id, signature_valid, payload_sha256, received_at, archive_key)
        VALUES (?, 'easy_pay_direct', ?, ?, 1, 'fictional-hash', ?, ?)`).bind(
        receiptId,
        id,
        receiptId,
        now,
        archiveKey,
      ),
      env.BILLING_DB.prepare(`INSERT INTO provider_webhook_events (receipt_id, organization_id, event_type,
        provider_transaction_id) VALUES (?, ?, ?, ?)`).bind(
        receiptId,
        id,
        `order.chargeback.${status}`,
        id,
      ),
    ]);
    return {
      id: receiptId,
      archiveKey,
      run: () => reconcileEasyPayDirectReceipt(env, receiptId),
      read: () =>
        env.BILLING_DB.prepare(
          `SELECT processed_at, processing_error_code FROM webhook_receipts WHERE id=?`,
        )
          .bind(receiptId)
          .first<{ processed_at: string | null; processing_error_code: string | null }>(),
    };
  }
  async function allocations(count: 1 | 2) {
    const requestId = `request-${id}`;
    const invoiceIds = count === 1 ? [id] : [id, `second-${id}`];
    const statements = [
      env.BILLING_DB.prepare(`INSERT INTO payment_requests
      (id, organization_id, customer_id, amount_minor, currency, payment_status, created_at, updated_at)
      VALUES (?, ?, ?, ?, 'USD', 'succeeded', ?, ?)`).bind(
        requestId,
        id,
        id,
        900 * count,
        now,
        now,
      ),
    ];
    if (count === 2)
      statements.push(
        env.BILLING_DB.prepare(`INSERT INTO invoices
      (id, organization_id, customer_id, status, payment_status, currency, subtotal_minor, total_due_minor, created_at, updated_at)
      VALUES (?, ?, ?, 'finalized', 'succeeded', 'USD', 900, 900, ?, ?)`).bind(
          invoiceIds[1],
          id,
          id,
          now,
          now,
        ),
      );
    statements.push(
      env.BILLING_DB.prepare(`INSERT INTO payment_request_payments
      (id, organization_id, payment_request_id, provider, provider_account_code, provider_transaction_id,
       idempotency_key, amount_minor, currency, status, created_at, updated_at)
      VALUES (?, ?, ?, 'easy_pay_direct', ?, ?, ?, ?, 'USD', 'succeeded', ?, ?)`).bind(
        requestId,
        id,
        requestId,
        id,
        id,
        requestId,
        900 * count,
        now,
        now,
      ),
    );
    for (const invoice of invoiceIds) {
      statements.push(
        env.BILLING_DB.prepare(`UPDATE invoices SET payment_status='pending',
        payment_overdue=1, ready_for_payment_processing=1 WHERE id=?`).bind(invoice),
      );
      statements.push(
        env.BILLING_DB.prepare(`INSERT INTO invoices_payment_requests
        (id, organization_id, payment_request_id, invoice_id, invoice_version, created_at, updated_at)
        VALUES (?, ?, ?, ?, 1, ?, ?)`).bind(`link-${invoice}`, id, requestId, invoice, now, now),
      );
      statements.push(
        env.BILLING_DB.prepare(`INSERT INTO payment_request_payment_allocations
        (id, organization_id, payment_request_payment_id, payment_request_id, invoice_id, amount_minor, currency, created_at)
        VALUES (?, ?, ?, ?, ?, 900, 'USD', ?)`).bind(
          `allocation-${invoice}`,
          id,
          requestId,
          requestId,
          invoice,
          now,
        ),
      );
      statements.push(
        env.BILLING_DB.prepare(`UPDATE invoices SET payment_status='succeeded' WHERE id=?`).bind(
          invoice,
        ),
      );
    }
    await env.BILLING_DB.batch(statements);
    return { requestId, invoiceIds };
  }
  return {
    id,
    receipt,
    allocations,
    read: () =>
      env.BILLING_DB.prepare(`SELECT status, last_provider_event_created_at
      FROM payment_disputes WHERE provider='easy_pay_direct' AND provider_account_code=?`)
        .bind(id)
        .first<{ status: string; last_provider_event_created_at: string }>(),
    invoice: () =>
      env.BILLING_DB.prepare(`SELECT payment_dispute_lost_at FROM invoices WHERE id=?`)
        .bind(id)
        .first<{ payment_dispute_lost_at: string | null }>(),
  };
}

describe("EPD dispute provider event ordering", () => {
  it.each([
    { total: undefined },
    { total: null },
    { total: 0 },
    { total: -900 },
    { total: 900.5 },
    { total: Number.MAX_SAFE_INTEGER + 1 },
    { total: "900" },
    { total: 899 },
    { currency: undefined },
    { currency: null },
    { currency: 123 },
    { currency: "JPY" },
    { currency: "US" },
    { currency: " USD " },
    { object: "dispute" },
    { id: "different-order" },
  ])(
    "preserves financial state and archived evidence for malformed order data %j",
    async (changes) => {
      const f = await fixture();
      await (await f.receipt("won", 1700000100)).run();
      const malformed = await f.receipt("lost", 1700000200);
      const archive = await env.BILLING_ARTIFACTS.get(malformed.archiveKey);
      const payload = JSON.parse(await archive!.text());
      Object.assign(payload.data.object, changes);
      await env.BILLING_ARTIFACTS.put(malformed.archiveKey, JSON.stringify(payload));
      expect(await malformed.run()).toBe("deferred");
      expect(await malformed.read()).toEqual({
        processed_at: null,
        processing_error_code: "epd_receipt_review:dispute_money_unverified",
      });
      expect((await f.read())?.status).toBe("won");
      expect(await f.invoice()).toEqual({ payment_dispute_lost_at: null });
      expect(await env.BILLING_ARTIFACTS.get(malformed.archiveKey)).not.toBeNull();
    },
  );

  it.each(["amount", "currency"])("holds conflicting mirrored settled ledger %s", async (kind) => {
    const f = await fixture();
    await f.allocations(1);
    await env.BILLING_DB.prepare(
      kind === "amount"
        ? `UPDATE payment_attempts SET amount_minor=899 WHERE id=?`
        : `UPDATE payment_attempts SET currency='JPY' WHERE id=?`,
    )
      .bind(f.id)
      .run();
    const incoming = await f.receipt("lost", 1700000200);
    expect(await incoming.run()).toBe("deferred");
    expect((await incoming.read())?.processing_error_code).toBe(
      "epd_receipt_review:dispute_money_unverified",
    );
    expect(await f.read()).toBeNull();
    expect(await f.invoice()).toEqual({ payment_dispute_lost_at: null });
  });

  it("waits for actual settlement and retries the same receipt without losing invoice linkage", async () => {
    const f = await fixture();
    await env.BILLING_DB.prepare(`UPDATE payment_attempts SET status='submitted' WHERE id=?`)
      .bind(f.id)
      .run();
    const early = await f.receipt("lost", 1700000200);
    expect(await early.run()).toBe("deferred");
    expect(await early.read()).toEqual({
      processed_at: null,
      processing_error_code: "epd_dispute_payment_link_pending",
    });
    expect(await f.read()).toBeNull();
    await env.BILLING_DB.prepare(`UPDATE payment_attempts SET status='succeeded' WHERE id=?`)
      .bind(f.id)
      .run();
    expect(await early.run()).toBe("processed");
    expect((await f.read())?.status).toBe("lost");
    expect((await f.invoice())?.payment_dispute_lost_at).not.toBeNull();
  });

  it("does not infer an invoice from arbitrary payment request metadata", async () => {
    const f = await fixture();
    const linked = await f.allocations(1);
    // The real paid request is for another provider transaction, not this event.
    await env.BILLING_DB.batch([
      env.BILLING_DB.prepare(
        `UPDATE payment_attempts SET provider_transaction_id=? WHERE id=?`,
      ).bind(`other-${f.id}`, f.id),
      env.BILLING_DB.prepare(
        `UPDATE payment_request_payments SET provider_transaction_id=? WHERE id=?`,
      ).bind(`other-${f.id}`, linked.requestId),
    ]);
    const misleading = await f.receipt("lost", 1700000200, 900, false, {
      lago_payment_request_id: linked.requestId,
    });
    expect(await misleading.run()).toBe("deferred");
    expect(await f.read()).toBeNull();
    expect(await f.invoice()).toEqual({ payment_dispute_lost_at: null });
  });

  it("review-holds a transaction allocated to multiple invoices rather than choosing the first", async () => {
    const f = await fixture();
    await f.allocations(2);
    const combined = await f.receipt("lost", 1700000200, 1800);
    expect(await combined.run()).toBe("deferred");
    expect((await combined.read())?.processing_error_code).toBe(
      "epd_receipt_review:dispute_invoice_link_ambiguous",
    );
    expect(await f.read()).toBeNull();
    expect(
      await env.BILLING_DB.prepare(`SELECT COUNT(*) AS count FROM invoices WHERE organization_id=?
      AND payment_dispute_lost_at IS NOT NULL`)
        .bind(f.id)
        .first(),
    ).toEqual({ count: 0 });
  });

  it.each([true, false])(
    "resolves single-invoice allocations with mirrored attempt present=%s",
    async (mirror) => {
      const f = await fixture();
      await f.allocations(1);
      if (!mirror)
        await env.BILLING_DB.prepare(`DELETE FROM payment_attempts WHERE id=?`).bind(f.id).run();
      expect(await (await f.receipt("lost", 1700000200)).run()).toBe("processed");
      expect((await f.read())?.status).toBe("lost");
      expect((await f.invoice())?.payment_dispute_lost_at).not.toBeNull();
    },
  );

  it("does not replace a won head or mark an invoice lost for an older lost event", async () => {
    const f = await fixture();
    await (await f.receipt("won", 1700000200)).run();
    const old = await f.receipt("lost", 1700000100);
    expect(await old.run()).toBe("processed");
    expect(await f.read()).toMatchObject({
      status: "won",
      last_provider_event_created_at: "2023-11-14T22:16:40.000Z",
    });
    expect(await f.invoice()).toEqual({ payment_dispute_lost_at: null });
    expect((await old.read())?.processed_at).not.toBeNull();
    expect(await env.BILLING_ARTIFACTS.get(old.archiveKey)).not.toBeNull();
  });

  it("accepts a strictly newer lost event and keeps the historical refund safety latch", async () => {
    const f = await fixture();
    await (await f.receipt("won", 1700000100)).run();
    await (await f.receipt("lost", 1700000200)).run();
    expect((await f.read())?.status).toBe("lost");
    expect((await f.invoice())?.payment_dispute_lost_at).not.toBeNull();
    await (await f.receipt("won", 1700000300)).run();
    expect((await f.read())?.status).toBe("won");
    expect((await f.invoice())?.payment_dispute_lost_at).not.toBeNull();
  });

  it.each([undefined, null, "1700000200", 1.5, -1, Number.MAX_SAFE_INTEGER])(
    "holds an event with no usable provider creation clock: %s",
    async (created) => {
      const f = await fixture();
      const receipt = await f.receipt("lost", created);
      expect(await receipt.run()).toBe("deferred");
      expect(await f.read()).toBeNull();
      expect(await f.invoice()).toEqual({ payment_dispute_lost_at: null });
      expect(await receipt.read()).toMatchObject({
        processed_at: null,
        processing_error_code: expect.stringContaining("epd_receipt_review:"),
      });
      expect(await env.BILLING_ARTIFACTS.get(receipt.archiveKey)).not.toBeNull();
    },
  );

  it.each([
    ["lost", 900],
    ["won", 901],
  ] as const)("holds tied conflicting evidence (%s, %s)", async (status, amount) => {
    const f = await fixture();
    await (await f.receipt("won", 1700000200)).run();
    const conflict = await f.receipt(status, 1700000200, amount);
    expect(await conflict.run()).toBe("deferred");
    expect((await f.read())?.status).toBe("won");
    expect(await f.invoice()).toEqual({ payment_dispute_lost_at: null });
    expect((await conflict.read())?.processing_error_code).toContain("epd_receipt_review:");
  });

  it("accepts equivalent same-time replays without inventing an ordering", async () => {
    const f = await fixture();
    await (await f.receipt("won", 1700000200)).run();
    const duplicate = await f.receipt("won", 1700000200);
    expect(await duplicate.run()).toBe("processed");
    expect(await duplicate.read()).toMatchObject({ processing_error_code: null });
    expect((await f.read())?.status).toBe("won");
  });

  it("converges concurrent out-of-order receipts to the newest head", async () => {
    const f = await fixture();
    // Older under-review, not lost: a genuinely accepted historical loss is
    // intentionally a separate permanent refund-safety latch.
    const old = await f.receipt("under_review", 1700000100);
    const newest = await f.receipt("won", 1700000200);
    await Promise.all([newest.run(), old.run()]);
    expect((await f.read())?.status).toBe("won");
    expect(await f.invoice()).toEqual({ payment_dispute_lost_at: null });
  });

  it("keeps pre-migration inserts compatible and holds an EPD head without provider-clock provenance", async () => {
    const f = await fixture();
    const now = new Date().toISOString();
    await env.BILLING_DB.prepare(`INSERT INTO payment_disputes (id, organization_id, provider,
      provider_account_code, provider_dispute_id, invoice_id, amount_minor, currency, status,
      livemode, provider_created_at, last_provider_event_created_at, created_at, updated_at)
      VALUES (?, ?, 'easy_pay_direct', ?, ?, ?, 900, 'USD', 'won', 0, ?, ?, ?, ?)`)
      .bind(f.id, f.id, f.id, f.id, f.id, now, now, now, now)
      .run();
    const incoming = await f.receipt("lost", 1700000200);
    expect(await incoming.run()).toBe("deferred");
    expect(await f.read()).toEqual({ status: "won", last_provider_event_created_at: now });
    expect(await f.invoice()).toEqual({ payment_dispute_lost_at: null });
    expect((await incoming.read())?.processing_error_code).toContain("epd_receipt_review:");
  });

  it.each(["organization", "mode"])(
    "does not overwrite a newer event in a different %s scope",
    async (scope) => {
      const f = await fixture();
      await (await f.receipt("won", 1700000100)).run();
      const incoming = await f.receipt("lost", 1700000200, 900, scope === "mode");
      if (scope === "organization") {
        const other = await fixture();
        await env.BILLING_DB.prepare(
          `UPDATE provider_webhook_events SET organization_id=? WHERE receipt_id=?`,
        )
          .bind(other.id, incoming.id)
          .run();
      }
      expect(await incoming.run()).toBe("deferred");
      expect((await f.read())?.status).toBe("won");
      expect(await f.invoice()).toEqual({ payment_dispute_lost_at: null });
      expect((await incoming.read())?.processing_error_code).toContain(
        scope === "organization" ? "epd_dispute_payment_link_pending" : "epd_receipt_review:",
      );
    },
  );
});
