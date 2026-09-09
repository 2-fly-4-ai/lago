import { env, SELF } from "cloudflare:test";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { sha256Hex } from "../src/auth/api-key";
import { createCreditNote } from "../src/api/credit-note-ledger";
import type { EasyPayDirectRefundRpcInput } from "../src/provider-financial-service";
import {
  checkpointEasyPayDirectRefund,
  reconcileEasyPayDirectRefundOperation,
} from "../src/billing/easy-pay-direct-refund-reconciliation";

const apiKey = "credit-note-ledger-key";

function refundReadEnv() {
  return {
    ...env,
    CREDIT_NOTE_REFUND_MODE: "easy_pay_direct_test",
    PROVIDER_READS_ENABLED: "1",
    EASY_PAY_DIRECT_NETWORK_MODE: "test",
    EASY_PAY_DIRECT_LIVEMODE_ALLOWED: "0",
    EASY_PAY_DIRECT_COMMERCE_API_KEY: "epd_synthetic_sk_test_secret",
    EASY_PAY_DIRECT_ACCOUNT_CODE: "easy-pay-direct",
    EASY_PAY_DIRECT_ORGANIZATION_ID: "org-credit-note",
  };
}

async function epdRefundFixture(
  suffix: string,
  amountMinor = 1000,
  totalMinor = 1000,
  origin: "commerce" | "legacy_unknown" | "missing_paid" | "missing" = "commerce",
) {
  const prefix = `epd-refund-${suffix}`;
  expect(
    (
      await request("/api/v1/plans", "POST", {
        plan: {
          code: prefix,
          name: "EPD refund fixture",
          interval: "monthly",
          amount_cents: totalMinor,
          amount_currency: "USD",
          pay_in_advance: true,
          tax_codes: [],
        },
      })
    ).status,
  ).toBe(200);
  expect((await createSubscription(prefix, prefix)).status).toBe(200);
  const source = await sourceInvoice(prefix);
  const now = new Date().toISOString();
  await env.BILLING_DB.prepare(`INSERT INTO payment_attempts
    (id, organization_id, invoice_id, provider, provider_account_code, provider_transaction_id,
     idempotency_key, amount_minor, currency, status, payment_type, version, created_at, updated_at)
    VALUES (?, 'org-credit-note', ?, 'easy_pay_direct', 'easy-pay-direct', ?, ?,
      ?, 'USD', 'succeeded', 'provider', 1, ?, ?)`)
    .bind(`${prefix}-payment`, source.invoice_id, `${prefix}-order`, prefix, totalMinor, now, now)
    .run();
  // The private refund RPC mock below bypasses provider-origin selection. Seed
  // genuine local origin evidence so reconciliation exercises that boundary,
  // rather than relying on the old missing-origin => Commerce fallback.
  if (origin !== "missing") {
    await env.BILLING_DB.batch([
      env.BILLING_DB.prepare(
        "UPDATE customers SET payment_provider='easy_pay_direct',payment_provider_code='easy-pay-direct' WHERE id='customer-credit-note'",
      ),
      env.BILLING_DB.prepare(`INSERT INTO payment_requests
        (id,organization_id,customer_id,amount_minor,currency,created_at,updated_at)
        VALUES (?,'org-credit-note','customer-credit-note',?,'USD',?,?)`).bind(
        `${prefix}-request`,
        totalMinor,
        now,
        now,
      ),
      env.BILLING_DB.prepare(`INSERT INTO payment_request_checkout_intents
        (id,organization_id,payment_request_id,customer_id,provider,provider_account_code,idempotency_key,request_sha256,amount_minor,currency,payment_request_version,status,payment_url,provider_token_sha256,created_at,updated_at)
        VALUES (?,'org-credit-note',?,'customer-credit-note','easy_pay_direct','easy-pay-direct',?,'fixture',?,'USD',1,'succeeded','https://fixture.test/checkout','fixture',?,?)`).bind(
        `${prefix}-intent`,
        `${prefix}-request`,
        `${prefix}-intent`,
        totalMinor,
        now,
        now,
      ),
      env.BILLING_DB.prepare(`INSERT INTO easy_pay_direct_payment_executions
        (id,organization_id,checkout_intent_id,payment_request_id,provider_account_code,request_sha256,payment_token_sha256,phone_sha256,customer_idempotency_key,payment_method_idempotency_key,product_idempotency_key,order_idempotency_key,status,provider_transaction_id,payment_backend,charge_transport,created_at,updated_at)
        VALUES (?,'org-credit-note',?,?,'easy-pay-direct','fixture','fixture','fixture',?,?,?,?,'succeeded',?,'gateway_vault',?,?,?)`).bind(
        `${prefix}-execution`,
        `${prefix}-intent`,
        `${prefix}-request`,
        crypto.randomUUID(),
        crypto.randomUUID(),
        crypto.randomUUID(),
        crypto.randomUUID(),
        `${prefix}-order`,
        origin === "legacy_unknown" ? "legacy_unknown" : "commerce",
        now,
        now,
      ),
    ]);
    if (origin !== "missing_paid")
      await env.BILLING_DB.prepare(`INSERT INTO payment_request_payments
        (id,organization_id,payment_request_id,provider,provider_account_code,provider_transaction_id,idempotency_key,amount_minor,currency,status,created_at,updated_at)
        VALUES (?,'org-credit-note',?,'easy_pay_direct','easy-pay-direct',?,?,?,'USD','succeeded',?,?)`)
        .bind(
          `${prefix}-request-paid`,
          `${prefix}-request`,
          `${prefix}-order`,
          `${prefix}-request-paid`,
          totalMinor,
          now,
          now,
        )
        .run();
  }
  return {
    invoiceId: source.invoice_id,
    submit: (
      refund: (input: EasyPayDirectRefundRpcInput) => Promise<{
        id: string | null;
        status: "succeeded" | "failed" | "unknown";
        responseText: string;
      }>,
      keySuffix = "",
      database = env.BILLING_DB,
    ) =>
      createCreditNote(
        new Request("https://lago.test/api/v1/credit_notes", {
          method: "POST",
          headers: { "Content-Type": "application/json", "Idempotency-Key": prefix + keySuffix },
          body: JSON.stringify({
            credit_note: {
              invoice_id: source.invoice_id,
              refund_amount_cents: amountMinor,
              items: [{ fee_id: source.line_id, amount_cents: amountMinor }],
            },
          }),
        }),
        {
          ...env,
          BILLING_DB: database,
          CREDIT_NOTE_REFUND_MODE: "easy_pay_direct_test",
          PROVIDER_FINANCIALS: {
            refundEasyPayDirect: refund,
            readEasyPayDirectRefund: async () => ({
              id: null,
              status: "unknown",
              responseText: "not read in this fixture",
            }),
            getIntegrationRuntimeStatuses: async () => [],
          },
        },
        {
          organizationId: "org-credit-note",
          organizationExternalId: "credit-note-test",
          apiKeyId: "key-credit-note",
        },
        prefix,
      ),
  };
}

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
    await expect(
      env.BILLING_DB.prepare(
        `SELECT provider, provider_account_code, provider_payment_id, status, amount_minor
         FROM provider_refund_operations WHERE invoice_id = ?`,
      )
        .bind(source.invoice_id)
        .first(),
    ).resolves.toEqual({
      provider: "sandbox",
      provider_account_code: "sandbox",
      provider_payment_id: "sandbox-payment",
      status: "succeeded",
      amount_minor: 1000,
    });
  });

  it("persists a Stripe test refund intent before transport and reconciles idempotently", async () => {
    expect(
      (
        await request("/api/v1/plans", "POST", {
          plan: {
            code: "credit-note-stripe-refund-plan",
            name: "Stripe test refund plan",
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
      (
        await createSubscription(
          "credit-note-stripe-refund-source",
          "credit-note-stripe-refund-plan",
        )
      ).status,
    ).toBe(200);
    const source = await sourceInvoice("credit-note-stripe-refund-source");
    const now = new Date().toISOString();
    await env.BILLING_DB.prepare(
      `INSERT INTO payment_attempts
       (id, organization_id, invoice_id, provider, provider_account_code,
        provider_transaction_id, idempotency_key, amount_minor, currency, status,
        payment_type, version, created_at, updated_at)
       VALUES ('credit-note-stripe-paid-attempt', 'org-credit-note', ?, 'stripe',
               'stripe-test-account', 'pi_synthetic_refund', 'stripe-paid-attempt',
               1000, 'USD', 'succeeded', 'provider', 1, ?, ?)`,
    )
      .bind(source.invoice_id, now, now)
      .run();

    const fetcher = vi.fn<typeof fetch>(async (_input, init) => {
      await expect(
        env.BILLING_DB.prepare(
          `SELECT operation.status AS operation_status, refund.status AS refund_status,
                  financial.refund_status AS financial_status
           FROM provider_refund_operations operation
           JOIN credit_note_refunds refund ON refund.credit_note_id = operation.credit_note_id
           JOIN credit_note_financials financial
             ON financial.credit_note_id = operation.credit_note_id
           WHERE operation.invoice_id = ?`,
        )
          .bind(source.invoice_id)
          .first(),
      ).resolves.toEqual({
        financial_status: "pending",
        operation_status: "pending",
        refund_status: "pending",
      });
      const headers = new Headers(init?.headers);
      expect(headers.get("Idempotency-Key")).toMatch(/^stripe-refund:/);
      return Response.json({
        id: "re_synthetic_refund",
        payment_intent: "pi_synthetic_refund",
        amount: 1000,
        currency: "usd",
        status: "succeeded",
        failure_reason: null,
      });
    });
    const stripeEnv = {
      ...env,
      CREDIT_NOTE_REFUND_MODE: "stripe_test",
      STRIPE_NETWORK_MODE: "enabled",
      STRIPE_RESTRICTED_API_KEY: ["rk", "test", "synthetic"].join("_"),
      STRIPE_ACCOUNT_CODE: "stripe-test-account",
      STRIPE_ORGANIZATION_ID: "org-credit-note",
      STRIPE_LIVEMODE_ALLOWED: "0",
    };
    const stripeRequest = () =>
      new Request("https://lago.test/api/v1/credit_notes", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": "stripe-test-refund",
        },
        body: JSON.stringify({
          credit_note: {
            invoice_id: source.invoice_id,
            refund_amount_cents: 1000,
            items: [{ fee_id: source.line_id, amount_cents: 1000 }],
          },
        }),
      });
    const auth = {
      organizationId: "org-credit-note",
      organizationExternalId: "credit-note-test",
      apiKeyId: "key-credit-note",
    };

    const response = await createCreditNote(
      stripeRequest(),
      stripeEnv,
      auth,
      "stripe-test-refund-request",
      fetcher,
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      credit_note: { refund_status: "succeeded", refund_amount_cents: 1000 },
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
    await expect(
      env.BILLING_DB.prepare(
        `SELECT operation.provider_refund_id, operation.status,
                refund.provider_mode, refund.provider_refund_id AS projected_refund_id,
                refund.status AS projected_status
         FROM provider_refund_operations operation
         JOIN credit_note_refunds refund ON refund.credit_note_id = operation.credit_note_id
         WHERE operation.invoice_id = ?`,
      )
        .bind(source.invoice_id)
        .first(),
    ).resolves.toEqual({
      provider_mode: "stripe_test",
      provider_refund_id: "re_synthetic_refund",
      projected_refund_id: "re_synthetic_refund",
      projected_status: "succeeded",
      status: "succeeded",
    });

    expect(
      (
        await createCreditNote(
          stripeRequest(),
          stripeEnv,
          auth,
          "stripe-test-refund-replay",
          fetcher,
        )
      ).status,
    ).toBe(200);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("executes an Easy Pay Direct test refund through the private provider service binding", async () => {
    expect(
      (
        await request("/api/v1/plans", "POST", {
          plan: {
            code: "credit-note-epd-refund-plan",
            name: "EPD test refund plan",
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
      (await createSubscription("credit-note-epd-refund-source", "credit-note-epd-refund-plan"))
        .status,
    ).toBe(200);
    const source = await sourceInvoice("credit-note-epd-refund-source");
    const now = new Date().toISOString();
    await env.BILLING_DB.prepare(
      `INSERT INTO payment_attempts
       (id, organization_id, invoice_id, provider, provider_account_code,
        provider_transaction_id, idempotency_key, amount_minor, currency, status,
        payment_type, version, created_at, updated_at)
       VALUES ('credit-note-epd-paid-attempt', 'org-credit-note', ?, 'easy_pay_direct',
               'easy-pay-direct', 'epd-order-synthetic-refund', 'epd-paid-attempt',
               1000, 'USD', 'succeeded', 'provider', 1, ?, ?)`,
    )
      .bind(source.invoice_id, now, now)
      .run();

    const providerFinancials = {
      readEasyPayDirectRefund: vi.fn(async () => ({
        id: null,
        status: "unknown" as const,
        responseText: "unused",
      })),
      getIntegrationRuntimeStatuses: vi.fn(async () => []),
      refundEasyPayDirect: vi.fn(async (input: EasyPayDirectRefundRpcInput) => {
        expect(input).toMatchObject({
          organizationId: "org-credit-note",
          providerAccountCode: "easy-pay-direct",
          orderId: "epd-order-synthetic-refund",
          amountMinor: 1000,
          currency: "USD",
          idempotencyKey: expect.any(String),
        });
        return {
          id: "epd-refund-synthetic",
          status: "succeeded" as const,
          responseText: "partially_refunded",
        };
      }),
    };
    const response = await createCreditNote(
      new Request("https://lago.test/api/v1/credit_notes", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": "epd-service-binding-refund",
        },
        body: JSON.stringify({
          credit_note: {
            invoice_id: source.invoice_id,
            refund_amount_cents: 1000,
            items: [{ fee_id: source.line_id, amount_cents: 1000 }],
          },
        }),
      }),
      {
        ...env,
        CREDIT_NOTE_REFUND_MODE: "easy_pay_direct_test",
        PROVIDER_FINANCIALS: providerFinancials,
      },
      {
        organizationId: "org-credit-note",
        organizationExternalId: "credit-note-test",
        apiKeyId: "key-credit-note",
      },
      "epd-service-binding-refund-request",
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      credit_note: { refund_status: "succeeded", refund_amount_cents: 1000 },
    });
    expect(providerFinancials.refundEasyPayDirect).toHaveBeenCalledOnce();
    await expect(
      env.BILLING_DB.prepare(
        `SELECT operation.provider_refund_id, operation.status,
                refund.provider_mode, refund.status AS projected_status
         FROM provider_refund_operations operation
         JOIN credit_note_refunds refund ON refund.credit_note_id = operation.credit_note_id
         WHERE operation.invoice_id = ?`,
      )
        .bind(source.invoice_id)
        .first(),
    ).resolves.toEqual({
      provider_mode: "easy_pay_direct_test",
      provider_refund_id: "epd-refund-synthetic",
      projected_status: "succeeded",
      status: "succeeded",
    });
  });

  it("claims an EPD refund once before concurrent replays reach the provider", async () => {
    const fixture = await epdRefundFixture("concurrent");
    let release!: () => void;
    let entered!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const called = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const refund = vi.fn(async (input: EasyPayDirectRefundRpcInput) => {
      const operation = await env.BILLING_DB.prepare(
        "SELECT status, provider_idempotency_key FROM provider_refund_operations WHERE invoice_id = ?",
      )
        .bind(fixture.invoiceId)
        .first();
      expect(operation).toEqual({
        status: "submitted",
        provider_idempotency_key: input.idempotencyKey,
      });
      entered();
      await blocked;
      return {
        id: "epd-refund-concurrent",
        status: "succeeded" as const,
        responseText: "refunded",
      };
    });
    const first = fixture.submit(refund);
    await called;
    try {
      const replay = await fixture.submit(refund);
      await expect(replay.json()).resolves.toMatchObject({
        credit_note: { refund_status: "pending" },
      });
      expect(refund).toHaveBeenCalledOnce();
    } finally {
      release();
    }
    await expect((await first).json()).resolves.toMatchObject({
      credit_note: { refund_status: "succeeded" },
    });
  });

  it.each(["timeout", "unknown"])(
    "keeps an EPD %s refund uncertain and never resubmits it",
    async (outcome) => {
      const fixture = await epdRefundFixture(outcome);
      const refund = vi.fn(async () => {
        if (outcome === "timeout") throw new Error("fictional transport timeout");
        return { id: null, status: "unknown" as const, responseText: "pending" };
      });
      if (outcome === "timeout") await expect(fixture.submit(refund)).rejects.toThrow();
      else await fixture.submit(refund);
      const initial = await env.BILLING_DB.prepare(
        "SELECT status, provider_idempotency_key FROM provider_refund_operations WHERE invoice_id = ?",
      )
        .bind(fixture.invoiceId)
        .first<{ status: string; provider_idempotency_key: string }>();
      expect(initial?.status).toBe("submitted");
      expect(initial?.provider_idempotency_key).toMatch(
        /^[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/i,
      );
      // Even beyond the provider's finite idempotency window, replay is read-only locally.
      await env.BILLING_DB.prepare(
        "UPDATE provider_refund_operations SET updated_at = '2020-01-01T00:00:00.000Z' WHERE invoice_id = ?",
      )
        .bind(fixture.invoiceId)
        .run();
      const replay = await fixture.submit(refund);
      await expect(replay.json()).resolves.toMatchObject({
        credit_note: { refund_status: "pending" },
      });
      expect(refund).toHaveBeenCalledOnce();
    },
  );

  it.each([400, 1000])(
    "recovers a checkpointed %s-cent refund with GET only and consistent ledger projections",
    async (amountMinor) => {
      const fixture = await epdRefundFixture(`recover-${amountMinor}`, amountMinor);
      let identity!: EasyPayDirectRefundRpcInput;
      const transactionId = `commerce-refund-${amountMinor}`;
      const post = vi.fn(async (input: EasyPayDirectRefundRpcInput) => {
        identity = input;
        await checkpointEasyPayDirectRefund(env.BILLING_DB, input, transactionId);
        throw new TypeError("lost verification GET");
      });
      await expect(fixture.submit(post)).rejects.toThrow("lost verification GET");
      const runtime = refundReadEnv();
      let outcome = "pending";
      const read = vi.fn<typeof fetch>(async (url, init) => {
        expect(init?.method).toBe("GET");
        expect(String(url)).toBe(`https://api.epd.com/v1/transactions/${transactionId}`);
        return Response.json({
          id: transactionId,
          type: "refund",
          status: outcome,
          order_id: identity.orderId,
          amount: amountMinor,
          currency: "usd",
        });
      });
      expect(await reconcileEasyPayDirectRefundOperation(runtime, identity.operationId, read)).toBe(
        "deferred",
      );
      outcome = "succeeded";
      expect(await reconcileEasyPayDirectRefundOperation(runtime, identity.operationId, read)).toBe(
        "processed",
      );
      expect(await reconcileEasyPayDirectRefundOperation(runtime, identity.operationId, read)).toBe(
        "processed",
      );
      expect(read).toHaveBeenCalledTimes(2);
      expect(post).toHaveBeenCalledOnce();
      expect(
        await env.BILLING_DB.prepare(`SELECT op.status, op.provider_idempotency_key,
      refund.status AS refund_status, financial.refund_status AS financial_status,
      financial.refund_amount_minor, financial.precise_taxes_amount_minor
      FROM provider_refund_operations op JOIN credit_note_refunds refund ON refund.credit_note_id = op.credit_note_id
      JOIN credit_note_financials financial ON financial.credit_note_id = op.credit_note_id WHERE op.id = ?`)
          .bind(identity.operationId)
          .first(),
      ).toMatchObject({
        status: "succeeded",
        refund_status: "succeeded",
        financial_status: "succeeded",
        refund_amount_minor: amountMinor,
        provider_idempotency_key: identity.idempotencyKey,
      });
      await expect(
        checkpointEasyPayDirectRefund(env.BILLING_DB, identity, "different-refund"),
      ).rejects.toThrow();
    },
  );

  it.each(["wrong-order", "wrong-amount", "wrong-currency", "failed", "unavailable"])(
    "handles checkpointed refund %s evidence without another mutation",
    async (fault) => {
      const fixture = await epdRefundFixture(`read-${fault}`);
      let identity!: EasyPayDirectRefundRpcInput;
      const transactionId = `read-refund-${fault}`;
      const post = vi.fn(async (input: EasyPayDirectRefundRpcInput) => {
        identity = input;
        await checkpointEasyPayDirectRefund(env.BILLING_DB, input, transactionId);
        return { id: null, status: "unknown" as const, responseText: "uncertain" };
      });
      await fixture.submit(post);
      const read = vi.fn<typeof fetch>(async (_url, init) => {
        expect(init?.method).toBe("GET");
        if (fault === "unavailable") throw new TypeError("read unavailable");
        return Response.json({
          id: transactionId,
          type: "refund",
          status: fault === "failed" ? "failed" : "succeeded",
          order_id: fault === "wrong-order" ? "unrelated-order" : identity.orderId,
          amount: fault === "wrong-amount" ? 999 : 1000,
          currency: fault === "wrong-currency" ? "EUR" : "USD",
        });
      });
      expect(
        await reconcileEasyPayDirectRefundOperation(refundReadEnv(), identity.operationId, read),
      ).toBe(fault === "failed" ? "processed" : "deferred");
      const status = fault === "failed" ? "failed" : "submitted";
      expect(
        await env.BILLING_DB.prepare("SELECT status FROM provider_refund_operations WHERE id = ?")
          .bind(identity.operationId)
          .first(),
      ).toEqual({ status });
      expect(post).toHaveBeenCalledOnce();
    },
  );

  it("preserves confirmed refund success when a concurrent older failure read arrives afterward", async () => {
    const fixture = await epdRefundFixture("reordered-refund-read");
    let identity!: EasyPayDirectRefundRpcInput;
    const transactionId = "refund-read-reordered";
    await fixture.submit(async (input) => {
      identity = input;
      await checkpointEasyPayDirectRefund(env.BILLING_DB, input, transactionId);
      return { id: null, status: "unknown", responseText: "pending" };
    });
    let entered!: () => void;
    let release!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const transaction = (status: string) =>
      Response.json({
        id: transactionId,
        type: "refund",
        status,
        order_id: identity.orderId,
        amount: 1000,
        currency: "USD",
      });
    const stale = reconcileEasyPayDirectRefundOperation(
      refundReadEnv(),
      identity.operationId,
      async () => {
        entered();
        await held;
        return transaction("failed");
      },
    );
    await started;
    try {
      await reconcileEasyPayDirectRefundOperation(refundReadEnv(), identity.operationId, async () =>
        transaction("succeeded"),
      );
    } finally {
      release();
    }
    await stale;
    expect(
      await env.BILLING_DB.prepare(`SELECT op.status, r.status AS refund_status,
      f.refund_status AS financial_status FROM provider_refund_operations op
      JOIN credit_note_refunds r ON r.credit_note_id = op.credit_note_id
      JOIN credit_note_financials f ON f.credit_note_id = op.credit_note_id WHERE op.id = ?`)
        .bind(identity.operationId)
        .first(),
    ).toEqual({ status: "succeeded", refund_status: "succeeded", financial_status: "succeeded" });
  });

  it("does not read refund transactions outside the configured test account or disabled read gate", async () => {
    const fixture = await epdRefundFixture("refund-read-boundary");
    let identity!: EasyPayDirectRefundRpcInput;
    await fixture.submit(async (input) => {
      identity = input;
      await checkpointEasyPayDirectRefund(env.BILLING_DB, input, "refund-read-boundary");
      return { id: null, status: "unknown", responseText: "pending" };
    });
    const read = vi.fn<typeof fetch>();
    for (const override of [
      { PROVIDER_READS_ENABLED: "0" },
      { EASY_PAY_DIRECT_NETWORK_MODE: "production" },
      { EASY_PAY_DIRECT_ORGANIZATION_ID: "another-org" },
      { EASY_PAY_DIRECT_ACCOUNT_CODE: "another-account" },
    ]) {
      expect(
        await reconcileEasyPayDirectRefundOperation(
          { ...refundReadEnv(), ...override },
          identity.operationId,
          read,
        ),
      ).toBe("deferred");
    }
    expect(read).not.toHaveBeenCalled();
  });

  it.each(["legacy_unknown", "missing_paid", "missing"] as const)(
    "holds checkpointed refunds with %s origin without a provider read",
    async (origin) => {
      const fixture = await epdRefundFixture(`origin-${origin}`, 1000, 1000, origin);
      let identity!: EasyPayDirectRefundRpcInput;
      await fixture.submit(async (input) => {
        identity = input;
        await checkpointEasyPayDirectRefund(
          env.BILLING_DB,
          input,
          `fixture-refund-checkpoint-${origin}`,
        );
        return { id: null, status: "unknown", responseText: "pending" };
      });
      const read = vi.fn<typeof fetch>();
      expect(
        await reconcileEasyPayDirectRefundOperation(refundReadEnv(), identity.operationId, read),
      ).toBe("deferred");
      expect(read).not.toHaveBeenCalled();
      expect(
        await env.BILLING_DB.prepare("SELECT status FROM provider_refund_operations WHERE id=?")
          .bind(identity.operationId)
          .first(),
      ).toEqual({ status: "submitted" });
    },
  );

  it("leaves a lost POST response without a transaction checkpoint unresolved without GET or POST", async () => {
    const fixture = await epdRefundFixture("lost-post-response");
    let identity!: EasyPayDirectRefundRpcInput;
    const post = vi.fn(async (input: EasyPayDirectRefundRpcInput) => {
      identity = input;
      throw new TypeError("lost POST");
    });
    await expect(fixture.submit(post)).rejects.toThrow();
    const read = vi.fn<typeof fetch>();
    expect(
      await reconcileEasyPayDirectRefundOperation(refundReadEnv(), identity.operationId, read),
    ).toBe("deferred");
    expect(read).not.toHaveBeenCalled();
    await fixture.submit(post);
    expect(post).toHaveBeenCalledOnce();
  });

  it("does not retry a legacy failed EPD refund with a previously used key", async () => {
    const fixture = await epdRefundFixture("legacy-failed");
    const refund = vi.fn(async () => ({
      id: null,
      status: "unknown" as const,
      responseText: "pending",
    }));
    await fixture.submit(refund);
    await env.BILLING_DB.prepare(
      "UPDATE provider_refund_operations SET status = 'failed' WHERE invoice_id = ?",
    )
      .bind(fixture.invoiceId)
      .run();
    await fixture.submit(refund);
    expect(refund).toHaveBeenCalledOnce();
  });

  it.each(["payment_changed", "refund_reserved"])(
    "rolls back the entire refund note after a %s race before the atomic insert",
    async (race) => {
      const fixture = await epdRefundFixture(`capacity-race-${race}`, 5000, 10000);
      const refund = vi.fn(async () => ({
        id: "should-not-refund",
        status: "succeeded" as const,
        responseText: "test",
      }));
      let raced = false;
      const database = new Proxy(env.BILLING_DB, {
        get(target, property) {
          if (property === "batch")
            return async (statements: D1PreparedStatement[]) => {
              if (!raced) {
                raced = true;
                if (race === "payment_changed")
                  await target
                    .prepare("UPDATE payment_attempts SET amount_minor = 4000 WHERE invoice_id = ?")
                    .bind(fixture.invoiceId)
                    .run();
                else
                  await target
                    .prepare(`INSERT INTO provider_refund_operations
                (id, organization_id, invoice_id, payment_attempt_id, provider, provider_account_code,
                 provider_payment_id, idempotency_key, request_sha256, amount_minor, currency, status, created_at, updated_at)
                SELECT ?, organization_id, invoice_id, id, provider, provider_account_code,
                  provider_transaction_id, ?, ?, 6000, currency, 'submitted', created_at, updated_at
                FROM payment_attempts WHERE invoice_id = ?`)
                    .bind(
                      `competing-${fixture.invoiceId}`,
                      `competing-${fixture.invoiceId}`,
                      "a".repeat(64),
                      fixture.invoiceId,
                    )
                    .run();
              }
              return target.batch(statements);
            };
          const value = Reflect.get(target, property);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
      await expect(fixture.submit(refund, "", database)).rejects.toMatchObject({
        code: "credit_note_sequence_conflict",
      });
      expect(raced).toBe(true);
      expect(refund).not.toHaveBeenCalled();
      expect(
        await env.BILLING_DB.prepare(
          "SELECT COUNT(*) AS count FROM credit_notes WHERE invoice_id = ?",
        )
          .bind(fixture.invoiceId)
          .first(),
      ).toEqual({ count: 0 });
      expect(
        await env.BILLING_DB.prepare(
          "SELECT COUNT(*) AS count FROM provider_refund_operations WHERE invoice_id = ? AND credit_note_id IS NOT NULL",
        )
          .bind(fixture.invoiceId)
          .first(),
      ).toEqual({ count: 0 });
    },
  );

  it.each(["succeeded", "unknown"] as const)(
    "allocates successive 50-dollar refunds to different 50-dollar payments when the first is %s",
    async (status) => {
      const suffix = `split-${status}`;
      const prefix = `epd-refund-${suffix}`;
      const fixture = await epdRefundFixture(suffix, 5000, 10000);
      await env.BILLING_DB.prepare("UPDATE payment_attempts SET amount_minor = 5000 WHERE id = ?")
        .bind(`${prefix}-payment`)
        .run();
      await env.BILLING_DB.prepare(`INSERT INTO payment_attempts
        (id,organization_id,invoice_id,provider,provider_account_code,provider_transaction_id,
         idempotency_key,amount_minor,currency,status,payment_type,version,created_at,updated_at)
        VALUES (?,'org-credit-note',?,'easy_pay_direct','easy-pay-direct',?,?,5000,'USD',
          'succeeded','provider',1,'2020-01-01T00:00:00.000Z','2020-01-01T00:00:00.000Z')`)
        .bind(
          `${prefix}-older-payment`,
          fixture.invoiceId,
          `${prefix}-older-order`,
          `${prefix}-older`,
        )
        .run();
      const refund = vi.fn(async (input: EasyPayDirectRefundRpcInput) => ({
        id: status === "succeeded" ? `refund-${input.operationId}` : null,
        status,
        responseText: "fictional refund response",
      }));
      expect((await fixture.submit(refund)).status).toBe(200);
      expect((await fixture.submit(refund, "-second")).status).toBe(200);
      expect(refund.mock.calls.map(([input]) => input.orderId)).toEqual([
        `${prefix}-order`,
        `${prefix}-older-order`,
      ]);
    },
  );

  it("refuses a provider refund after the invoice dispute was lost", async () => {
    expect(
      (
        await request("/api/v1/plans", "POST", {
          plan: {
            code: "credit-note-lost-dispute-plan",
            name: "Lost dispute refund guard",
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
      (await createSubscription("credit-note-lost-dispute-source", "credit-note-lost-dispute-plan"))
        .status,
    ).toBe(200);
    const source = await sourceInvoice("credit-note-lost-dispute-source");
    await env.BILLING_DB.prepare("UPDATE invoices SET payment_dispute_lost_at = ? WHERE id = ?")
      .bind("2026-08-18T01:00:00.000Z", source.invoice_id)
      .run();

    await expect(
      createCreditNote(
        new Request("https://lago.test/api/v1/credit_notes", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Idempotency-Key": "lost-dispute-refund",
          },
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
        "lost-dispute-refund-request",
      ),
    ).rejects.toMatchObject({
      status: 422,
      code: "refund_unavailable_after_lost_dispute",
    });
    await expect(
      env.BILLING_DB.prepare(
        "SELECT COUNT(*) AS count FROM provider_refund_operations WHERE invoice_id = ?",
      )
        .bind(source.invoice_id)
        .first(),
    ).resolves.toEqual({ count: 0 });
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
