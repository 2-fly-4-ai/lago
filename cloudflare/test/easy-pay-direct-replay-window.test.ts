import { env } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import {
  requireEasyPayDirectReplayWindow,
  resumeEasyPayDirectExecution,
} from "../src/api/easy-pay-direct-checkout";
import { pendingEasyPayDirectExecutions } from "../src/reconciliation/easy-pay-direct";
import { EASY_PAY_DIRECT_PAYABLE_EXECUTION_SQL } from "../src/billing/easy-pay-direct-recovery-policy";
import { reconcilePaymentRequest } from "../src/reconciliation/authorize-net";

async function executionFixture(ageHours: number, knownOrder = false, sharedExecution?: string) {
  const id = crypto.randomUUID();
  const shared = sharedExecution
    ? await env.BILLING_DB.prepare(`SELECT e.organization_id, i.customer_id
    FROM easy_pay_direct_payment_executions e JOIN payment_request_checkout_intents i
    ON i.id = e.checkout_intent_id WHERE e.id = ?`)
        .bind(sharedExecution)
        .first<{ organization_id: string; customer_id: string }>()
    : null;
  const organization = shared?.organization_id ?? `replay-org-${id}`;
  const customer = shared?.customer_id ?? `replay-customer-${id}`;
  const request = `replay-request-${id}`;
  const intent = `replay-intent-${id}`;
  const now = new Date().toISOString();
  const created = new Date(Date.now() - ageHours * 3_600_000).toISOString();
  await env.BILLING_DB.batch([
    env.BILLING_DB.prepare(`INSERT OR IGNORE INTO organizations
      (id, external_id, name, created_at, updated_at) VALUES (?, ?, 'Replay QA', ?, ?)`).bind(
      organization,
      organization,
      now,
      now,
    ),
    env.BILLING_DB.prepare(`INSERT OR IGNORE INTO customers
      (id, organization_id, external_id, email, name, currency, metadata_json,
       payment_provider, payment_provider_code, created_at, updated_at)
      VALUES (?, ?, ?, 'fictional@example.com', 'Replay QA', 'USD', '{}', 'easy_pay_direct',
        'replay-test', ?, ?)`).bind(customer, organization, customer, now, now),
    env.BILLING_DB.prepare(`INSERT INTO payment_requests
      (id, organization_id, customer_id, amount_minor, currency, email, payment_attempts,
       payment_status, ready_for_payment_processing, version, created_at, updated_at)
      VALUES (?, ?, ?, 900, 'USD', 'fictional@example.com', 0, 'pending', 1, 1, ?, ?)`).bind(
      request,
      organization,
      customer,
      now,
      now,
    ),
    env.BILLING_DB.prepare(`INSERT INTO payment_request_checkout_intents
      (id, organization_id, payment_request_id, customer_id, provider, provider_account_code,
       idempotency_key, request_sha256, amount_minor, currency, payment_request_version,
       status, payment_url, provider_token_sha256, expires_at, created_at, updated_at)
      VALUES (?, ?, ?, ?, 'easy_pay_direct', 'replay-test', ?, 'fixture-hash', 900, 'USD', 1,
       'succeeded', 'https://checkout.example.com', 'fixture-token-hash', ?, ?, ?)`).bind(
      intent,
      organization,
      request,
      customer,
      id,
      now,
      created,
      now,
    ),
    env.BILLING_DB.prepare(`INSERT INTO easy_pay_direct_payment_executions
      (id, organization_id, checkout_intent_id, payment_request_id, provider_account_code,
       request_sha256, payment_token_sha256, phone_sha256, customer_idempotency_key,
       payment_method_idempotency_key, product_idempotency_key, order_idempotency_key,
       charge_transport, status, customer_vault_id, gateway_billing_id, provider_product_id,
       provider_transaction_id, phone_ciphertext, phone_iv, created_at, updated_at)
      VALUES (?, ?, ?, ?, 'replay-test', 'fixture-hash', 'fixture-token', 'fixture-phone',
       ?, ?, ?, ?, 'commerce', 'unknown', 'fixture-vault', '123456', 'fixture-product', ?, 'fixture-phone',
       'fixture-iv', ?, ?)`).bind(
      id,
      organization,
      intent,
      request,
      crypto.randomUUID(),
      crypto.randomUUID(),
      crypto.randomUUID(),
      crypto.randomUUID(),
      knownOrder ? `fixture-order-${id}` : null,
      created,
      now,
    ),
  ]);
  await shareInvoice(id, id);
  return id;
}

describe("EPD provider idempotency retention boundary", () => {
  it("blocks a paid stale request and counts mirrored ledger entries once for a remaining balance", async () => {
    const first = await executionFixture(1);
    const stale = await executionFixture(1, false, first);
    await shareInvoice(first, stale);
    const record = await env.BILLING_DB.prepare(`SELECT organization_id, payment_request_id
      FROM easy_pay_direct_payment_executions WHERE id = ?`)
      .bind(first)
      .first<{ organization_id: string; payment_request_id: string }>();
    const receiptId = `replay-paid-receipt-${first}`;
    const timestamp = new Date().toISOString();
    await env.BILLING_DB.batch([
      env.BILLING_DB.prepare(`INSERT INTO webhook_receipts
        (id, provider, provider_account_code, provider_event_id, signature_valid, payload_sha256,
         received_at, processed_at, processing_error_code)
        VALUES (?, 'easy_pay_direct', 'replay-test', ?, 1, 'fixture-hash', ?, NULL, NULL)`).bind(
        receiptId,
        receiptId,
        timestamp,
      ),
      env.BILLING_DB.prepare(`INSERT INTO provider_webhook_events
        (receipt_id, organization_id, event_type, provider_transaction_id, invoice_id, normalized_status, normalized_at)
        VALUES (?, ?, 'order.succeeded', ?, NULL, NULL, NULL)`).bind(
        receiptId,
        record!.organization_id,
        `replay-paid-order-${first}`,
      ),
    ]);
    await reconcilePaymentRequest(
      env.BILLING_DB,
      {
        receipt_id: receiptId,
        organization_id: record!.organization_id,
        provider_account_code: "replay-test",
        event_type: "order.succeeded",
        provider_transaction_id: `replay-paid-order-${first}`,
        archive_key: null,
        processed_at: null,
      },
      record!.payment_request_id,
      {
        id: `replay-paid-order-${first}`,
        amountMinor: 900,
        failureCode: null,
        failureMessage: null,
      },
      "succeeded",
      "easy_pay_direct",
    );
    await env.BILLING_DB.prepare(
      "UPDATE easy_pay_direct_payment_executions SET status = 'succeeded' WHERE id = ?",
    )
      .bind(first)
      .run();
    await env.BILLING_DB.prepare(
      "UPDATE easy_pay_direct_payment_executions SET status = 'pending' WHERE id = ?",
    )
      .bind(stale)
      .run();
    expect(
      (
        await env.BILLING_DB.prepare(`UPDATE easy_pay_direct_payment_executions
      SET status = 'processing' WHERE id = ? AND status = 'pending' AND ${EASY_PAY_DIRECT_PAYABLE_EXECUTION_SQL}`)
          .bind(stale)
          .run()
      ).meta.changes,
    ).toBe(0);
    expect(
      await env.BILLING_DB.prepare(`SELECT r.payment_status FROM payment_requests r
      JOIN easy_pay_direct_payment_executions e ON e.payment_request_id = r.id WHERE e.id = ?`)
        .bind(stale)
        .first(),
    ).toMatchObject({ payment_status: "pending" });

    // Fixture a subsequently adjusted outstanding balance. The prior $9 has a
    // compatibility payment_attempt AND a request allocation: it is $9, not $18.
    await env.BILLING_DB.prepare(`UPDATE invoices SET total_due_minor = 1800, subtotal_minor = 1800,
      payment_status = 'pending', ready_for_payment_processing = 1, version = version + 1
      WHERE id = (SELECT link.invoice_id FROM invoices_payment_requests link
        WHERE link.payment_request_id = ?)`)
      .bind(record!.payment_request_id)
      .run();
    expect(
      await env.BILLING_DB.prepare(`SELECT id FROM easy_pay_direct_payment_executions
      WHERE id = ? AND ${EASY_PAY_DIRECT_PAYABLE_EXECUTION_SQL}`)
        .bind(stale)
        .first(),
    ).toMatchObject({ id: stale });
    const nextReceipt = `${receiptId}-remaining`;
    const nextTransaction = `replay-paid-order-${stale}`;
    const nextRequest = await env.BILLING_DB.prepare(
      "SELECT payment_request_id FROM easy_pay_direct_payment_executions WHERE id = ?",
    )
      .bind(stale)
      .first<{ payment_request_id: string }>();
    await env.BILLING_DB.batch([
      env.BILLING_DB.prepare(`INSERT INTO webhook_receipts
        (id, provider, provider_account_code, provider_event_id, signature_valid, payload_sha256,
         received_at, processed_at, processing_error_code)
        VALUES (?, 'easy_pay_direct', 'replay-test', ?, 1, 'fixture-hash', ?, NULL, NULL)`).bind(
        nextReceipt,
        nextReceipt,
        timestamp,
      ),
      env.BILLING_DB.prepare(`INSERT INTO provider_webhook_events
        (receipt_id, organization_id, event_type, provider_transaction_id, invoice_id, normalized_status, normalized_at)
        VALUES (?, ?, 'order.succeeded', ?, NULL, NULL, NULL)`).bind(
        nextReceipt,
        record!.organization_id,
        nextTransaction,
      ),
    ]);
    await expect(
      reconcilePaymentRequest(
        env.BILLING_DB,
        {
          receipt_id: nextReceipt,
          organization_id: record!.organization_id,
          provider_account_code: "replay-test",
          event_type: "order.succeeded",
          provider_transaction_id: nextTransaction,
          archive_key: null,
          processed_at: null,
        },
        nextRequest!.payment_request_id,
        { id: nextTransaction, amountMinor: 900, failureCode: null, failureMessage: null },
        "succeeded",
        "easy_pay_direct",
      ),
    ).resolves.toBeUndefined();
    expect(
      await env.BILLING_DB.prepare("SELECT payment_status FROM payment_requests WHERE id = ?")
        .bind(nextRequest!.payment_request_id)
        .first(),
    ).toMatchObject({ payment_status: "succeeded" });
  });

  it("rejects an unpaid request whose linked invoice balance changed before its claim", async () => {
    const id = await executionFixture(1);
    await env.BILLING_DB.prepare(`UPDATE invoices SET total_due_minor = 450, credits_minor = 450
      WHERE id = (SELECT link.invoice_id FROM invoices_payment_requests link
        JOIN easy_pay_direct_payment_executions e ON e.payment_request_id = link.payment_request_id
        WHERE e.id = ?)`)
      .bind(id)
      .run();
    expect(
      await env.BILLING_DB.prepare(`SELECT id FROM easy_pay_direct_payment_executions
      WHERE id = ? AND ${EASY_PAY_DIRECT_PAYABLE_EXECUTION_SQL}`)
        .bind(id)
        .first(),
    ).toBeNull();
  });
  it.each(["same", "different"])(
    "blocks a checkout while an automatic execution on the %s request owns its invoice",
    async (requestKind) => {
      const checkout = await executionFixture(1);
      const automaticSource =
        requestKind === "same" ? checkout : await executionFixture(1, false, checkout);
      if (automaticSource !== checkout) await shareInvoice(checkout, automaticSource);
      else await shareInvoice(checkout, await executionFixture(1, false, checkout));
      await env.BILLING_DB.prepare(
        "UPDATE easy_pay_direct_payment_executions SET status = 'failed' WHERE organization_id = (SELECT organization_id FROM easy_pay_direct_payment_executions WHERE id = ?)",
      )
        .bind(checkout)
        .run();
      await env.BILLING_DB.prepare(
        "UPDATE easy_pay_direct_payment_executions SET status = 'pending' WHERE id = ?",
      )
        .bind(checkout)
        .run();
      const profileId = `replay-profile-${automaticSource}`;
      const now = new Date().toISOString();
      await env.BILLING_DB.prepare(`INSERT INTO provider_customer_profiles
      (id, organization_id, customer_id, provider, provider_account_code, provider_customer_id,
       gateway_customer_vault_id, initial_transaction_id, status, created_at, updated_at)
      SELECT ?, e.organization_id, i.customer_id, 'easy_pay_direct', 'replay-test', 'fixture-customer',
        'fixture-vault', 'fixture-initial', 'active', ?, ?
      FROM easy_pay_direct_payment_executions e JOIN payment_request_checkout_intents i
        ON i.id = e.checkout_intent_id WHERE e.id = ?`)
        .bind(profileId, now, now, automaticSource)
        .run();
      await env.BILLING_DB.prepare(`INSERT INTO easy_pay_direct_automatic_payment_executions
      (id, organization_id, payment_request_id, customer_id, provider_profile_id, provider_account_code,
       request_sha256, gateway_customer_vault_id, initial_transaction_id, order_reference, status,
       created_at, updated_at)
      SELECT ?, e.organization_id, e.payment_request_id, i.customer_id, ?, 'replay-test',
        'fixture-auto-hash', 'fixture-vault', 'fixture-initial', ?, 'processing', ?, ?
      FROM easy_pay_direct_payment_executions e JOIN payment_request_checkout_intents i
        ON i.id = e.checkout_intent_id WHERE e.id = ?`)
        .bind(
          `replay-auto-${automaticSource}`,
          profileId,
          automaticSource,
          now,
          now,
          automaticSource,
        )
        .run();
      for (const status of ["processing", "unknown"]) {
        await env.BILLING_DB.prepare(
          "UPDATE easy_pay_direct_automatic_payment_executions SET status = ? WHERE id = ?",
        )
          .bind(status, `replay-auto-${automaticSource}`)
          .run();
        expect(
          (
            await env.BILLING_DB.prepare(`UPDATE easy_pay_direct_payment_executions
        SET status = 'processing' WHERE id = ? AND status = 'pending' AND ${EASY_PAY_DIRECT_PAYABLE_EXECUTION_SQL}`)
              .bind(checkout)
              .run()
          ).meta.changes,
        ).toBe(0);
      }
    },
  );

  it.each(["processing", "unknown"])(
    "prevents a second checkout claim against an invoice with a %s execution",
    async (status) => {
      const first = await executionFixture(1);
      const second = await executionFixture(1, false, first);
      await shareInvoice(first, second);
      await env.BILLING_DB.prepare(
        "UPDATE easy_pay_direct_payment_executions SET status = ? WHERE id = ?",
      )
        .bind(status, first)
        .run();
      await env.BILLING_DB.prepare(
        "UPDATE easy_pay_direct_payment_executions SET status = 'pending' WHERE id = ?",
      )
        .bind(second)
        .run();
      const claim = await env.BILLING_DB.prepare(`UPDATE easy_pay_direct_payment_executions
      SET status = 'processing' WHERE id = ? AND status = 'pending' AND ${EASY_PAY_DIRECT_PAYABLE_EXECUTION_SQL}`)
        .bind(second)
        .run();
      expect(claim.meta.changes).toBe(0);
      await env.BILLING_DB.prepare(
        "UPDATE easy_pay_direct_payment_executions SET status = 'failed' WHERE id = ?",
      )
        .bind(first)
        .run();
      expect(
        (
          await env.BILLING_DB.prepare(`UPDATE easy_pay_direct_payment_executions
      SET status = 'processing' WHERE id = ? AND status = 'pending' AND ${EASY_PAY_DIRECT_PAYABLE_EXECUTION_SQL}`)
            .bind(second)
            .run()
        ).meta.changes,
      ).toBe(1);
    },
  );

  it("allows only one of two simultaneous pending checkout claims sharing an invoice", async () => {
    const first = await executionFixture(1);
    const second = await executionFixture(1, false, first);
    await shareInvoice(first, second);
    await env.BILLING_DB.prepare(
      "UPDATE easy_pay_direct_payment_executions SET status = 'pending' WHERE id IN (?, ?)",
    )
      .bind(first, second)
      .run();
    const claims = await Promise.all(
      [first, second].map((id) =>
        env.BILLING_DB.prepare(
          `UPDATE easy_pay_direct_payment_executions SET status = 'processing'
       WHERE id = ? AND status = 'pending' AND ${EASY_PAY_DIRECT_PAYABLE_EXECUTION_SQL}`,
        )
          .bind(id)
          .run(),
      ),
    );
    expect(claims.reduce((total, result) => total + result.meta.changes, 0)).toBe(1);
  });
  it("holds an old missing order response without a provider call even after a recent retry", async () => {
    const id = await executionFixture(25);
    const fetcher = vi.fn<typeof fetch>();
    expect(await resumeEasyPayDirectExecution(env, id, fetcher)).toBe("deferred");
    expect(fetcher).not.toHaveBeenCalled();
    expect(
      await env.BILLING_DB.prepare(`SELECT status, failure_code, provider_product_id,
      customer_vault_id FROM easy_pay_direct_payment_executions WHERE id = ?`)
        .bind(id)
        .first(),
    ).toMatchObject({
      status: "unknown",
      failure_code: "easy_pay_direct_idempotency_window_expired",
      provider_product_id: "fixture-product",
      customer_vault_id: "fixture-vault",
    });
  });

  it("stops mutating retries conservatively before the provider's 24-hour expiration", async () => {
    const id = await executionFixture(23.5);
    await expect(requireEasyPayDirectReplayWindow(env.BILLING_DB, id)).rejects.toMatchObject({
      code: "easy_pay_direct_idempotency_window_expired",
    });
  });

  it("permits in-window operations and excludes old pre-order rows from batch selection", async () => {
    const fresh = await executionFixture(22);
    const old = await executionFixture(25);
    await expect(requireEasyPayDirectReplayWindow(env.BILLING_DB, fresh)).resolves.toBeUndefined();
    const pending = await pendingEasyPayDirectExecutions(env.BILLING_DB, "production");
    expect(pending).toContain(fresh);
    expect(pending).not.toContain(old);
  });

  it("preserves read-only recovery of known orders beyond the retention window", async () => {
    const id = await executionFixture(72, true);
    const fetcher = vi.fn<typeof fetch>();
    expect(await resumeEasyPayDirectExecution(env, id, fetcher)).toBe("advanced");
    expect(fetcher).not.toHaveBeenCalled();
    expect(await pendingEasyPayDirectExecutions(env.BILLING_DB, "production")).toContain(id);
  });
});

async function shareInvoice(first: string, second: string) {
  const timestamp = new Date().toISOString();
  const invoiceId = `replay-invoice-${crypto.randomUUID()}`;
  await env.BILLING_DB.prepare(`INSERT INTO invoices
    (id, organization_id, customer_id, number, status, payment_status, currency,
     subtotal_minor, tax_minor, credits_minor, total_due_minor, version, finalized_at,
     payment_overdue, ready_for_payment_processing, created_at, updated_at)
    SELECT ?, e.organization_id, i.customer_id, ?, 'finalized', 'pending', 'USD',
      900, 0, 0, 900, 1, ?, 1, 1, ?, ?
    FROM easy_pay_direct_payment_executions e JOIN payment_request_checkout_intents i
      ON i.id = e.checkout_intent_id WHERE e.id = ?`)
    .bind(invoiceId, invoiceId, timestamp, timestamp, timestamp, first)
    .run();
  const ids = [...new Set([first, second])];
  await env.BILLING_DB.batch(
    ids.map((id) =>
      env.BILLING_DB.prepare("DELETE FROM invoices_payment_requests WHERE id = ?").bind(
        `replay-link-${id}`,
      ),
    ),
  );
  await env.BILLING_DB.batch(
    ids.map((id) =>
      env.BILLING_DB.prepare(
        `INSERT INTO invoices_payment_requests
     (id, organization_id, payment_request_id, invoice_id, invoice_version, created_at, updated_at)
     SELECT ?, organization_id, payment_request_id, ?, 1, ?, ?
     FROM easy_pay_direct_payment_executions WHERE id = ?`,
      ).bind(`replay-link-${id}`, invoiceId, timestamp, timestamp, id),
    ),
  );
}
