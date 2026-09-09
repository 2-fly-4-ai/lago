import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { sha256Hex } from "../src/auth/api-key";
import { showInvoiceFulfillment } from "../src/api/invoice-fulfillment";
import { createCreditNote } from "../src/api/credit-note-ledger";
import { closeBillingPeriod } from "../src/billing/close-period";
import { reconcilePaymentRequest } from "../src/reconciliation/authorize-net";
import { materializeFulfillmentSourceSnapshot } from "../src/billing/fulfillment-source-snapshot";

async function fixture(interval = "monthly") {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const end = new Date(Date.now() + 86400000).toISOString();
  await env.BILLING_DB.batch([
    env.BILLING_DB.prepare(
      `INSERT INTO organizations (id, external_id, name, created_at, updated_at) VALUES (?, ?, 'Fulfillment QA', ?, ?)`,
    ).bind(id, id, now, now),
    env.BILLING_DB.prepare(
      `INSERT INTO customers (id, organization_id, external_id, email, created_at, updated_at) VALUES (?, ?, ?, 'fictional@example.invalid', ?, ?)`,
    ).bind(id, id, id, now, now),
    env.BILLING_DB.prepare(
      `INSERT INTO plans (id, organization_id, code, name, interval, amount_minor, currency, created_at, updated_at) VALUES (?, ?, ?, 'QA', ?, 900, 'USD', ?, ?)`,
    ).bind(id, id, id, interval, now, now),
    env.BILLING_DB.prepare(
      `INSERT INTO subscriptions (id, organization_id, customer_id, plan_id, external_id, status, started_at, current_period_start, current_period_end, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, ?)`,
    ).bind(id, id, id, id, id, now, now, end, now, now),
    env.BILLING_DB.prepare(
      `INSERT INTO invoices (id, organization_id, customer_id, subscription_id, status, payment_status, currency, subtotal_minor, total_due_minor, created_at, updated_at) VALUES (?, ?, ?, ?, 'finalized', 'succeeded', 'USD', 900, 900, ?, ?)`,
    ).bind(id, id, id, id, now, now),
    env.BILLING_DB.prepare(
      `INSERT INTO invoice_subscriptions (invoice_id, subscription_id, organization_id, invoicing_reason, period_start, period_end, created_at) VALUES (?, ?, ?, 'subscription_starting', ?, ?, ?)`,
    ).bind(id, id, id, now, end, now),
    env.BILLING_DB.prepare(`INSERT INTO invoice_lines
      (id, invoice_id, line_type, description, quantity_decimal, unit_amount_decimal,
       amount_minor, source_type, source_id, metadata_json, created_at)
      VALUES (?, ?, 'subscription', 'QA plan', '1', '900', 900, 'plan', ?, ?, ?)`).bind(
      id,
      id,
      id,
      JSON.stringify({ contextType: "initial", periodStart: now, periodEnd: end }),
      now,
    ),
    env.BILLING_DB.prepare(
      `INSERT INTO payment_attempts (id, organization_id, invoice_id, provider, provider_account_code, provider_transaction_id, idempotency_key, amount_minor, currency, status, created_at, updated_at) VALUES (?, ?, ?, 'easy_pay_direct', 'epd-qa', ?, ?, 900, 'USD', 'succeeded', ?, ?)`,
    ).bind(id, id, id, id, id, now, now),
  ]);
  const auth = { organizationId: id, organizationExternalId: id, apiKeyId: id };
  return {
    id,
    now,
    auth,
    read: async (invoiceId = id) =>
      (
        await (
          await showInvoiceFulfillment(invoiceId, env.BILLING_DB, auth, id)
        ).json<{ fulfillment: Record<string, unknown> }>()
      ).fulfillment,
  };
}

describe("invoice fulfillment current-ledger snapshot", () => {
  it("uses the paid next-period plan line after an actual advance renewal and payment reconciliation", async () => {
    const f = await fixture();
    const current = new Date();
    const start = new Date(
      Date.UTC(current.getUTCFullYear(), current.getUTCMonth() - 1, 1),
    ).toISOString();
    const end = new Date(
      Date.UTC(current.getUTCFullYear(), current.getUTCMonth(), 1),
    ).toISOString();
    await env.BILLING_DB.batch([
      env.BILLING_DB.prepare("UPDATE plans SET pay_in_advance = 1 WHERE id = ?").bind(f.id),
      env.BILLING_DB.prepare(
        "UPDATE subscriptions SET started_at = ?, current_period_start = ?, current_period_end = ? WHERE id = ?",
      ).bind(start, start, end, f.id),
    ]);
    const closed = await closeBillingPeriod(env, f.id, end, `fulfillment-close-${f.id}`);
    const request = `renewal-request-${f.id}`;
    const transaction = `renewal-payment-${f.id}`;
    await env.BILLING_DB.batch([
      env.BILLING_DB.prepare(`INSERT INTO webhook_receipts
        (id, provider, provider_account_code, provider_event_id, signature_valid, payload_sha256, received_at)
        VALUES (?, 'easy_pay_direct', 'epd-qa', ?, 1, 'fixture', ?)`).bind(
        `receipt-${f.id}`,
        transaction,
        f.now,
      ),
      env.BILLING_DB.prepare(`INSERT INTO payment_requests
        (id, organization_id, customer_id, amount_minor, currency, payment_status, collection_mode, created_at, updated_at)
        VALUES (?, ?, ?, ?, 'USD', 'pending', 'checkout', ?, ?)`).bind(
        request,
        f.id,
        f.id,
        closed.totalDueMinor,
        f.now,
        f.now,
      ),
      env.BILLING_DB.prepare(`INSERT INTO invoices_payment_requests
        (id, organization_id, payment_request_id, invoice_id, invoice_version, created_at, updated_at)
        SELECT ?, organization_id, ?, id, version, ?, ? FROM invoices WHERE id = ?`).bind(
        request,
        request,
        f.now,
        f.now,
        closed.invoiceId,
      ),
    ]);
    await reconcilePaymentRequest(
      env.BILLING_DB,
      {
        receipt_id: `receipt-${f.id}`,
        organization_id: f.id,
        provider_account_code: "epd-qa",
        event_type: "payment.succeeded",
        provider_transaction_id: transaction,
        archive_key: null,
        processed_at: null,
      },
      request,
      {
        id: transaction,
        amountMinor: closed.totalDueMinor,
        failureCode: null,
        failureMessage: null,
      },
      "succeeded",
      "easy_pay_direct",
    );
    expect(
      await env.BILLING_DB.prepare(
        "SELECT period_end FROM invoice_subscriptions WHERE invoice_id = ?",
      )
        .bind(closed.invoiceId)
        .first(),
    ).toEqual({ period_end: end });
    expect(await f.read(closed.invoiceId)).toMatchObject({
      eligible: true,
      paidThrough: closed.nextPeriodEnd,
    });
    expect(
      await materializeFulfillmentSourceSnapshot(env.BILLING_DB, f.id, f.id, {
        providerCode: "epd-qa",
        mode: "test",
      }),
    ).toMatchObject({ eligible: true, paidThrough: closed.nextPeriodEnd });
    // Advancing the mutable subscription again cannot extend this invoice's grant.
    await env.BILLING_DB.prepare(
      "UPDATE subscriptions SET current_period_end = '2099-01-01T00:00:00Z' WHERE id = ?",
    )
      .bind(f.id)
      .run();
    expect((await f.read(closed.invoiceId)).paidThrough).toBe(closed.nextPeriodEnd);
    // Reconciliation projects both an attempt and a request allocation.
    expect((await f.read(closed.invoiceId)).eligible).toBe(true);
    await env.BILLING_DB.prepare(
      "UPDATE payment_attempts SET amount_minor = 1 WHERE invoice_id = ? AND provider_transaction_id = ?",
    )
      .bind(closed.invoiceId, transaction)
      .run();
    expect((await f.read(closed.invoiceId)).eligible).toBe(false);
  });

  it("does not treat usage-only payment as payment for the subscription plan", async () => {
    const f = await fixture();
    await env.BILLING_DB.prepare(
      "UPDATE invoice_lines SET line_type = 'usage', source_type = 'charge' WHERE invoice_id = ?",
    )
      .bind(f.id)
      .run();
    expect((await f.read()).eligible).toBe(false);
  });

  it("caps a paid entitlement at a scheduled future termination", async () => {
    const f = await fixture();
    const ending = new Date(Date.now() + 3600000).toISOString();
    await env.BILLING_DB.prepare("UPDATE subscriptions SET ending_at = ? WHERE id = ?")
      .bind(ending, f.id)
      .run();
    expect(await f.read()).toMatchObject({ eligible: true, paidThrough: ending });
  });

  it("returns paid recurring identity and authenticates the route", async () => {
    const f = await fixture();
    expect(await f.read()).toMatchObject({
      version: 1,
      invoiceId: f.id,
      externalCustomerId: f.id,
      externalSubscriptionId: f.id,
      provider: "easy_pay_direct",
      providerCode: "epd-qa",
      eligible: true,
      refundState: "none",
    });
    const key = `fulfillment-${f.id}`;
    await env.BILLING_DB.prepare(
      `INSERT INTO api_keys (id, organization_id, key_prefix, key_hash, created_at) VALUES (?, ?, ?, ?, ?)`,
    )
      .bind(f.id, f.id, key.slice(0, 8), await sha256Hex(key), f.now)
      .run();
    const url = `https://lago.test/api/v1/invoices/${f.id}/fulfillment`;
    expect((await SELF.fetch(url)).status).toBe(401);
    const response = await SELF.fetch(url, { headers: { Authorization: `Bearer ${key}` } });
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    await expect(
      showInvoiceFulfillment(
        f.id,
        env.BILLING_DB,
        { ...f.auth, organizationId: "other-tenant" },
        f.id,
      ),
    ).rejects.toMatchObject({ status: 404 });
  });

  it("allows paid one-time access without inventing a renewal period", async () => {
    const f = await fixture("one_time");
    await env.BILLING_DB.prepare(
      "UPDATE invoice_subscriptions SET period_end = NULL WHERE invoice_id = ?",
    )
      .bind(f.id)
      .run();
    expect(await f.read()).toMatchObject({
      eligible: true,
      planInterval: "one_time",
      paidThrough: null,
    });
  });

  it.each(["canceled", "terminated", "past_due", "pending"])(
    "withholds a new grant for %s subscriptions",
    async (status) => {
      const f = await fixture();
      await env.BILLING_DB.prepare("UPDATE subscriptions SET status = ? WHERE id = ?")
        .bind(status, f.id)
        .run();
      expect((await f.read()).eligible).toBe(false);
    },
  );

  it("rejects expired or malformed paid periods and elapsed scheduled termination", async () => {
    const f = await fixture();
    for (const date of [null, "not-a-date", "2000-01-01T00:00:00Z"]) {
      await env.BILLING_DB.prepare(
        "UPDATE invoice_lines SET metadata_json = json_set(metadata_json, '$.periodEnd', ?) WHERE invoice_id = ?",
      )
        .bind(date, f.id)
        .run();
      expect((await f.read()).eligible).toBe(false);
    }
    await env.BILLING_DB.prepare(
      "UPDATE invoice_lines SET metadata_json = json_set(metadata_json, '$.periodEnd', '2099-01-01T00:00:00Z') WHERE invoice_id = ?",
    )
      .bind(f.id)
      .run();
    await env.BILLING_DB.prepare(
      "UPDATE subscriptions SET ending_at = '2000-01-01T00:00:00Z' WHERE id = ?",
    )
      .bind(f.id)
      .run();
    expect((await f.read()).eligible).toBe(false);
  });

  it("blocks closure holds and absent subscription evidence", async () => {
    const f = await fixture();
    await env.BILLING_DB.prepare(
      "INSERT INTO customer_closure_email_holds (organization_id, email) VALUES (?, 'fictional@example.invalid')",
    )
      .bind(f.id)
      .run();
    expect((await f.read()).eligible).toBe(false);
    const other = await fixture();
    await env.BILLING_DB.prepare("DELETE FROM invoice_subscriptions WHERE invoice_id = ?")
      .bind(other.id)
      .run();
    expect((await other.read()).eligible).toBe(false);
  });

  it.each(["pending", "submitted", "succeeded", "failed"])(
    "handles %s refund evidence without provider calls",
    async (status) => {
      const f = await fixture();
      await env.BILLING_DB.prepare(`INSERT INTO provider_refund_operations
      (id, organization_id, invoice_id, payment_attempt_id, provider, provider_account_code, provider_payment_id, idempotency_key, request_sha256, amount_minor, currency, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, 'easy_pay_direct', 'epd-qa', ?, ?, 'fixture', 450, ?, ?, ?, ?)`)
        .bind(f.id, f.id, f.id, f.id, f.id, f.id, "USD", status, f.now, f.now)
        .run();
      expect(await f.read()).toMatchObject({
        eligible: status === "failed",
        refundState:
          status === "succeeded"
            ? "partial"
            : status === "failed"
              ? "none"
              : status === "submitted"
                ? "unknown"
                : "pending",
      });
    },
  );

  it.each([450, 900])(
    "deduplicates all three successful refund projections for %i cents",
    async (amount) => {
      const f = await fixture();
      const response = await createCreditNote(
        new Request("https://lago.test/api/v1/credit_notes", {
          method: "POST",
          headers: { "Content-Type": "application/json", "Idempotency-Key": f.id },
          body: JSON.stringify({
            credit_note: {
              invoice_id: f.id,
              refund_amount_cents: amount,
              items: [{ fee_id: f.id, amount_cents: amount }],
            },
          }),
        }),
        {
          ...env,
          CREDIT_NOTE_REFUND_MODE: "easy_pay_direct_test",
          PROVIDER_FINANCIALS: {
            refundEasyPayDirect: async () => ({
              id: `refund-${f.id}`,
              status: "succeeded" as const,
              responseText: "fixture",
            }),
            readEasyPayDirectRefund: async () => ({
              id: null,
              status: "unknown" as const,
              responseText: "unused",
            }),
            getIntegrationRuntimeStatuses: async () => [],
          },
        },
        f.auth,
        f.id,
      );
      expect(response.status).toBe(200);
      expect(await f.read()).toMatchObject({
        eligible: false,
        refundedAmountMinor: amount,
        refundState: amount === 900 ? "full" : "partial",
      });
      expect(
        await materializeFulfillmentSourceSnapshot(env.BILLING_DB, f.id, f.id, {
          providerCode: "epd-qa",
          mode: "test",
        }),
      ).toMatchObject({ eligible: amount < 900, held: false, refundedAmountMinor: amount });
      // A contradictory late operation cannot hide the successful financial projection.
      await env.BILLING_DB.prepare(
        "UPDATE provider_refund_operations SET status = 'failed' WHERE invoice_id = ?",
      )
        .bind(f.id)
        .run();
      expect(await f.read()).toMatchObject({ eligible: false, refundState: "unknown" });
      expect(
        await materializeFulfillmentSourceSnapshot(env.BILLING_DB, f.id, f.id, {
          providerCode: "epd-qa",
          mode: "test",
        }),
      ).toMatchObject({ eligible: false, held: true, holdReason: "refund_review" });
    },
  );

  it("blocks refund flags with missing refund evidence and underpayment", async () => {
    const f = await fixture();
    await env.BILLING_DB.prepare("UPDATE invoices SET payment_status = 'refunded' WHERE id = ?")
      .bind(f.id)
      .run();
    expect(await f.read()).toMatchObject({ eligible: false, refundState: "unknown" });
    const other = await fixture();
    await env.BILLING_DB.prepare("UPDATE payment_attempts SET amount_minor = 1 WHERE id = ?")
      .bind(other.id)
      .run();
    expect((await other.read()).eligible).toBe(false);
  });
});
