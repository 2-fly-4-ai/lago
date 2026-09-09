import { env } from "cloudflare:test";
import type { WorkflowStep } from "cloudflare:workers";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { handleEasyPayDirectCheckoutSubmission } from "../src/api/easy-pay-direct-checkout";
import {
  commitAppliedCheckoutTaxQuote,
  handleEasyPayDirectTaxQuote,
  resolveCheckoutTaxCode,
} from "../src/api/easy-pay-direct-tax";
import { runCheckoutWorkflow } from "../src/workflows/checkout";
import { handleLagoCompatibilityRequest, showInvoice } from "../src/api/lago-compatibility";
import { createCreditNote } from "../src/api/credit-note-ledger";
import { checkoutTaxSnapshotStatements } from "../src/tax/checkout-tax-snapshots";

const organizationId = "org-easy-pay-direct-tax";
let customerId: string;
let invoiceId: string;
let paymentRequestId: string;
let planId: string;
let subscriptionId: string;

beforeEach(async () => {
  const fixtureId = crypto.randomUUID();
  customerId = `customer-epd-tax-${fixtureId}`;
  invoiceId = `invoice-epd-tax-${fixtureId}`;
  paymentRequestId = `payment-request-epd-tax-${fixtureId}`;
  planId = `plan-epd-tax-${fixtureId}`;
  subscriptionId = `subscription-epd-tax-${fixtureId}`;
  const now = new Date().toISOString();
  await env.BILLING_DB.batch([
    env.BILLING_DB.prepare(
      `INSERT OR IGNORE INTO organizations (id, external_id, name, created_at, updated_at)
       VALUES (?, 'easy-pay-direct-tax', 'Easy Pay Direct Tax', ?, ?)`,
    ).bind(organizationId, now, now),
    env.BILLING_DB.prepare(
      `INSERT INTO customers
       (id, organization_id, external_id, email, name, currency, metadata_json,
        payment_provider, payment_provider_code, created_at, updated_at)
       VALUES (?, ?, ?, 'tax@example.com', 'Tax Customer', 'USD', '{}',
               'easy_pay_direct', 'epd-tax', ?, ?)`,
    ).bind(customerId, organizationId, `epd-tax-${fixtureId}`, now, now),
    env.BILLING_DB.prepare(
      `INSERT INTO plans
       (id, organization_id, code, name, interval, amount_minor, currency, version, active,
        metadata_json, created_at, updated_at)
       VALUES (?, ?, ?, 'Easy Pay Direct Tax Plan', 'monthly', 1999, 'USD', 1, 1,
               '{"tax_code":"txcd_10103100"}', ?, ?)`,
    ).bind(planId, organizationId, planId, now, now),
    env.BILLING_DB.prepare(
      `INSERT INTO subscriptions
       (id, organization_id, customer_id, plan_id, external_id, status, started_at,
        current_period_start, current_period_end, version, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'active', ?, ?, '2026-09-30T00:00:00.000Z', 1, ?, ?)`,
    ).bind(subscriptionId, organizationId, customerId, planId, subscriptionId, now, now, now, now),
    env.BILLING_DB.prepare(
      `INSERT INTO invoices
       (id, organization_id, customer_id, subscription_id, number, status, payment_status, currency,
        subtotal_minor, tax_minor, credits_minor, total_due_minor, version, finalized_at,
        payment_overdue, ready_for_payment_processing, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'finalized', 'pending', 'USD', 1999, 0, 0, 1999, 1, ?, 1, 1, ?, ?)`,
    ).bind(
      invoiceId,
      organizationId,
      customerId,
      subscriptionId,
      `INV-TAX-${fixtureId}`,
      now,
      now,
      now,
    ),
    env.BILLING_DB.prepare(
      `INSERT INTO invoice_subscriptions
       (invoice_id, subscription_id, organization_id, invoicing_reason,
        period_start, period_end, created_at)
       VALUES (?, ?, ?, 'subscription_starting', ?, '2026-09-30T00:00:00.000Z', ?)`,
    ).bind(invoiceId, subscriptionId, organizationId, now, now),
    env.BILLING_DB.prepare(
      `INSERT INTO payment_requests
       (id, organization_id, customer_id, amount_minor, currency, email, payment_attempts,
        payment_status, ready_for_payment_processing, version, collection_mode, created_at, updated_at)
       VALUES (?, ?, ?, 1999, 'USD', 'tax@example.com', 0, 'pending', 1, 1, 'checkout', ?, ?)`,
    ).bind(paymentRequestId, organizationId, customerId, now, now),
    env.BILLING_DB.prepare(
      `INSERT INTO invoices_payment_requests
       (id, organization_id, payment_request_id, invoice_id, invoice_version, created_at, updated_at)
       VALUES (?, ?, ?, ?, 1, ?, ?)`,
    ).bind(`link-${fixtureId}`, organizationId, paymentRequestId, invoiceId, now, now),
  ]);
  await env.BILLING_DB.prepare(`INSERT INTO invoice_lines(id,invoice_id,line_type,description,quantity_decimal,unit_amount_decimal,amount_minor,source_type,source_id,metadata_json,created_at)
    VALUES(?,?,'subscription','Fixture software','1','1999',1999,'plan',?,'{}',?)`)
    .bind(`line-${invoiceId}`, invoiceId, planId, now)
    .run();
});

describe("Easy Pay Direct destination tax checkout", () => {
  it.each(["full", "halves", "rounding", "multiline", "discount", "missing", "mismatched"])(
    "preserves collected local tax refund budgets and provenance: %s",
    async (scenario) => {
      await seedLocalTaxRule(62_500, "static", invoiceId);
      await env.BILLING_DB.batch([
        env.BILLING_DB.prepare(
          "UPDATE plans SET interval='one_time',amount_minor=900 WHERE id=?",
        ).bind(planId),
        env.BILLING_DB.prepare(
          "UPDATE invoices SET subtotal_minor=900,total_due_minor=900 WHERE id=?",
        ).bind(invoiceId),
        env.BILLING_DB.prepare("UPDATE payment_requests SET amount_minor=900 WHERE id=?").bind(
          paymentRequestId,
        ),
        env.BILLING_DB.prepare(
          "UPDATE invoice_lines SET amount_minor=900,unit_amount_decimal='900' WHERE invoice_id=?",
        ).bind(invoiceId),
      ]);
      if (scenario === "multiline")
        await env.BILLING_DB.batch([
          env.BILLING_DB.prepare(
            "UPDATE invoice_lines SET amount_minor=450,unit_amount_decimal='450' WHERE invoice_id=?",
          ).bind(invoiceId),
          env.BILLING_DB.prepare(`INSERT INTO invoice_lines(id,invoice_id,line_type,description,quantity_decimal,unit_amount_decimal,amount_minor,source_type,source_id,metadata_json,created_at)
          VALUES(?,?,'subscription','Second fixture fee','1','450',450,'plan',?,'{}',?)`).bind(
            `second-${invoiceId}`,
            invoiceId,
            `second-${planId}`,
            new Date().toISOString(),
          ),
        ]);
      if (scenario === "discount") {
        await env.BILLING_DB.batch([
          env.BILLING_DB.prepare(
            "UPDATE invoice_lines SET amount_minor=1800,unit_amount_decimal='1800' WHERE invoice_id=?",
          ).bind(invoiceId),
          env.BILLING_DB.prepare(
            "UPDATE invoices SET subtotal_minor=1800,credits_minor=900,coupons_minor=900 WHERE id=?",
          ).bind(invoiceId),
        ]);
        await seedCouponAllocation(900);
      }
      const runtime = localTaxEnv();
      await runCheckoutWorkflow(runtime, checkoutParams(), immediateStep());
      const intent = await env.BILLING_DB.prepare(
        "SELECT payment_url FROM payment_request_checkout_intents WHERE payment_request_id=?",
      )
        .bind(paymentRequestId)
        .first<{ payment_url: string }>();
      const quote = await (
        await handleEasyPayDirectTaxQuote(
          taxQuoteRequest(new URL(intent!.payment_url).searchParams.get("checkout")!),
          runtime,
          "refund-quote",
          vi.fn<typeof fetch>(),
        )
      ).json<{ tax_quote: { id: string; checkout: string; tax_cents: number } }>();
      expect(quote.tax_quote.tax_cents).toBe(56);
      const displayed = await (
        await showInvoice(
          invoiceId,
          env.BILLING_DB,
          { organizationId, organizationExternalId: "easy-pay-direct-tax", apiKeyId: "fixture" },
          "invoice-tax-display",
        )
      ).json<{
        invoice: {
          taxes_amount_cents: number;
          fees: { taxes_amount_cents: number; applied_taxes: unknown[] }[];
          applied_taxes: unknown[];
        };
      }>();
      expect(displayed.invoice.taxes_amount_cents).toBe(56);
      expect(displayed.invoice.fees.reduce((sum, fee) => sum + fee.taxes_amount_cents, 0)).toBe(56);
      expect(displayed.invoice.fees.every((fee) => fee.applied_taxes.length === 1)).toBe(true);
      expect(displayed.invoice.applied_taxes).toHaveLength(1);
      const gateway = vi.fn<typeof fetch>(async (input) =>
        String(input).endsWith("/api/query.php")
          ? new Response(
              `<nm_response><transaction><transaction_id>fixture-tax-paid-${invoiceId}</transaction_id><order_id>${paymentRequestId}</order_id><condition>complete</condition><currency>USD</currency><action><action_type>sale</action_type><success>1</success><amount>9.56</amount></action></transaction></nm_response>`,
            )
          : new Response(
              `response=1&response_code=100&transactionid=fixture-tax-paid-${invoiceId}&authcode=TEST`,
            ),
      );
      expect(
        await (
          await handleEasyPayDirectCheckoutSubmission(
            paymentRequest(quote.tax_quote.checkout, quote.tax_quote.id),
            runtime,
            "refund-paid",
            gateway,
          )
        ).json(),
      ).toMatchObject({ status: "succeeded" });
      if (scenario === "missing")
        await env.BILLING_DB.prepare("DELETE FROM invoice_line_taxes WHERE invoice_id=?")
          .bind(invoiceId)
          .run();
      if (scenario === "mismatched")
        await env.BILLING_DB.prepare(
          "UPDATE invoices SET tax_minor=57,total_due_minor=957 WHERE id=?",
        )
          .bind(invoiceId)
          .run();
      const portions =
        scenario === "halves"
          ? [
              { base: 450, tax: 28 },
              { base: 450, tax: 28 },
            ]
          : scenario === "rounding"
            ? [
                { base: 1, tax: 0 },
                { base: 899, tax: 56 },
              ]
            : [{ base: 900, tax: 56 }];
      for (let index = 0; index < portions.length; index++) {
        const portion = portions[index]!;
        const refund = portion.base + portion.tax;
        const responsePromise = createCreditNote(
          new Request("https://lago.test/api/v1/credit_notes", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "Idempotency-Key": `local-tax-refund-${invoiceId}-${index}`,
            },
            body: JSON.stringify({
              credit_note: {
                invoice_id: invoiceId,
                refund_amount_cents: refund,
                items:
                  scenario === "multiline"
                    ? [
                        { fee_id: `line-${invoiceId}`, amount_cents: 450 },
                        { fee_id: `second-${invoiceId}`, amount_cents: 450 },
                      ]
                    : [
                        {
                          fee_id: `line-${invoiceId}`,
                          amount_cents: scenario === "discount" ? 1800 : portion.base,
                        },
                      ],
              },
            }),
          }),
          {
            ...runtime,
            BILLING_DB: env.BILLING_DB,
            DOMAIN_EVENTS: env.DOMAIN_EVENTS,
            CREDIT_NOTE_REFUND_MODE: "sandbox",
          },
          { organizationId, organizationExternalId: "easy-pay-direct-tax", apiKeyId: "fixture" },
          "refund",
          vi.fn<typeof fetch>(),
        );
        if (scenario === "missing" || scenario === "mismatched") {
          await expect(responsePromise).rejects.toMatchObject({
            status: 409,
            code: "credit_note_tax_snapshot_missing",
          });
          expect(
            await env.BILLING_DB.prepare(
              "SELECT COUNT(*) AS count FROM credit_notes WHERE invoice_id=?",
            )
              .bind(invoiceId)
              .first(),
          ).toEqual({ count: 0 });
          return;
        }
        expect(await (await responsePromise).json()).toMatchObject({
          credit_note: { refund_amount_cents: refund, taxes_amount_cents: portion.tax },
        });
      }
      expect(
        await env.BILLING_DB.prepare(
          "SELECT SUM(t.amount_minor) AS total FROM credit_note_taxes t JOIN credit_notes n ON n.id=t.credit_note_id WHERE n.invoice_id=?",
        )
          .bind(invoiceId)
          .first(),
      ).toEqual({ total: 56 });
    },
  );
  it("rolls back tax snapshot replacement if a fee changes after allocation", async () => {
    await seedLocalTaxRule(62_500, "static", invoiceId);
    const input = {
      organizationId,
      invoiceId,
      quoteId: crypto.randomUUID(),
      ruleId: `local-tax-rule-wa-${invoiceId}`,
      country: "US",
      collectionMode: "collect" as const,
      rateResolution: null,
      subtotalMinor: 1999,
      taxMinor: 125,
      currency: "USD",
      now: new Date().toISOString(),
    };
    await env.BILLING_DB.batch(await checkoutTaxSnapshotStatements(env.BILLING_DB, input));
    const pending = await checkoutTaxSnapshotStatements(env.BILLING_DB, {
      ...input,
      quoteId: crypto.randomUUID(),
    });
    await env.BILLING_DB.prepare("UPDATE invoice_lines SET amount_minor=2000 WHERE invoice_id=?")
      .bind(invoiceId)
      .run();
    await expect(env.BILLING_DB.batch(pending)).rejects.toThrow();
    expect(
      await env.BILLING_DB.prepare(
        "SELECT COUNT(*) AS count,SUM(amount_minor) AS tax FROM invoice_line_taxes WHERE invoice_id=?",
      )
        .bind(invoiceId)
        .first(),
    ).toEqual({ count: 1, tax: 125 });
  });
  it("allocates a fully discounted zero base without dividing by zero and rejects nonzero tax", async () => {
    await seedLocalTaxRule(62_500, "static", invoiceId);
    await seedCouponAllocation(1999);
    const input = {
      organizationId,
      invoiceId,
      quoteId: crypto.randomUUID(),
      ruleId: `local-tax-rule-wa-${invoiceId}`,
      country: "US",
      collectionMode: "collect" as const,
      rateResolution: null,
      subtotalMinor: 0,
      taxMinor: 0,
      currency: "USD",
      now: new Date().toISOString(),
    };
    await env.BILLING_DB.batch(await checkoutTaxSnapshotStatements(env.BILLING_DB, input));
    expect(
      await env.BILLING_DB.prepare(
        "SELECT taxable_base_minor,amount_minor FROM invoice_line_taxes WHERE invoice_id=?",
      )
        .bind(invoiceId)
        .first(),
    ).toEqual({ taxable_base_minor: 0, amount_minor: 0 });
    await expect(
      checkoutTaxSnapshotStatements(env.BILLING_DB, { ...input, taxMinor: 1 }),
    ).rejects.toMatchObject({ code: "checkout_tax_fee_allocation_unavailable" });
  });
  it.each([
    { code: null, existing: false },
    { code: "foreign-account", existing: false },
    { code: null, existing: true },
    { code: "foreign-account", existing: true },
  ])(
    "rejects a mismatched invoice account before URL creation or reuse %j",
    async ({ code, existing }) => {
      const runtimeEnv = localTaxEnv();
      if (existing) await runCheckoutWorkflow(runtimeEnv, checkoutParams(), immediateStep());
      await env.BILLING_DB.prepare("UPDATE customers SET payment_provider_code=? WHERE id=?")
        .bind(code, customerId)
        .run();
      await expect(
        handleLagoCompatibilityRequest(
          new Request(`https://lago.test/api/v1/invoices/${invoiceId}/payment_url`, {
            method: "POST",
          }),
          runtimeEnv,
          { organizationId, organizationExternalId: "easy-pay-direct-tax", apiKeyId: "fixture" },
          "wrong-account-url",
        ),
      ).rejects.toMatchObject({ status: 409, code: "easy_pay_direct_checkout_scope_mismatch" });
      expect(
        await env.BILLING_DB.prepare(
          "SELECT COUNT(*) AS count FROM payment_request_checkout_intents WHERE payment_request_id=?",
        )
          .bind(paymentRequestId)
          .first(),
      ).toEqual({ count: existing ? 1 : 0 });
      expect(
        await env.BILLING_DB.prepare("SELECT payment_provider_code FROM customers WHERE id=?")
          .bind(customerId)
          .first(),
      ).toEqual({ payment_provider_code: code });
    },
  );
  it.each([
    { organization: "another-organization", account: "epd-tax", status: 409 },
    { organization: undefined, account: "epd-tax", status: 503 },
    { organization: organizationId, account: undefined, status: 503 },
  ])("rejects missing or foreign configured scope before creating an intent %j", async (config) => {
    const runtimeEnv = new Proxy(localTaxEnv(), {
      get(target, property, receiver) {
        if (property === "EASY_PAY_DIRECT_ORGANIZATION_ID") return config.organization;
        if (property === "EASY_PAY_DIRECT_ACCOUNT_CODE") return config.account;
        return Reflect.get(target, property, receiver) as unknown;
      },
    });
    await expect(
      handleLagoCompatibilityRequest(
        new Request(`https://lago.test/api/v1/invoices/${invoiceId}/payment_url`, {
          method: "POST",
        }),
        runtimeEnv,
        { organizationId, organizationExternalId: "easy-pay-direct-tax", apiKeyId: "fixture" },
        "wrong-scope-url",
      ),
    ).rejects.toMatchObject({ status: config.status });
    expect(
      await env.BILLING_DB.prepare(
        "SELECT COUNT(*) AS count FROM payment_request_checkout_intents WHERE payment_request_id=?",
      )
        .bind(paymentRequestId)
        .first(),
    ).toEqual({ count: 0 });
  });
  it.each([false, true])(
    "reuses only a current unexpired tax-repriced invoice checkout (expired=%s)",
    async (expired) => {
      const runtimeEnv = localTaxEnv();
      await seedLocalTaxRule(100_000, "static", crypto.randomUUID());
      await runCheckoutWorkflow(runtimeEnv, checkoutParams(), immediateStep());
      const original = await env.BILLING_DB.prepare(
        "SELECT payment_url FROM payment_request_checkout_intents WHERE payment_request_id=? AND status='succeeded'",
      )
        .bind(paymentRequestId)
        .first<{ payment_url: string }>();
      const network = vi.fn<typeof fetch>();
      await handleEasyPayDirectTaxQuote(
        taxQuoteRequest(new URL(original!.payment_url).searchParams.get("checkout")!),
        runtimeEnv,
        "reuse-tax-quote",
        network,
      );
      const replacement = await env.BILLING_DB.prepare(
        "SELECT id,payment_url FROM payment_request_checkout_intents WHERE payment_request_id=? AND status='succeeded'",
      )
        .bind(paymentRequestId)
        .first<{ id: string; payment_url: string }>();
      if (expired)
        await env.BILLING_DB.prepare(
          "UPDATE payment_request_checkout_intents SET expires_at='2020-01-01T00:00:00.000Z' WHERE id=?",
        )
          .bind(replacement!.id)
          .run();
      const generate = () =>
        handleLagoCompatibilityRequest(
          new Request(`https://lago.test/api/v1/invoices/${invoiceId}/payment_url`, {
            method: "POST",
          }),
          runtimeEnv,
          { organizationId, organizationExternalId: "easy-pay-direct-tax", apiKeyId: "fixture" },
          "reuse-tax-url",
        );
      if (expired) {
        await expect(generate()).rejects.toMatchObject({
          status: 410,
          code: "easy_pay_direct_checkout_expired",
        });
      } else {
        for (let index = 0; index < 2; index++) {
          const response = await generate();
          expect(response?.status).toBe(200);
          expect(await response!.json()).toMatchObject({
            invoice_payment_details: { payment_url: replacement!.payment_url },
          });
        }
      }
      expect(
        await env.BILLING_DB.prepare(
          "SELECT COUNT(*) AS count FROM payment_request_checkout_intents WHERE payment_request_id=?",
        )
          .bind(paymentRequestId)
          .first(),
      ).toEqual({ count: 2 });
      expect(network).not.toHaveBeenCalled();
    },
  );
  it("rejects submission after a local collection scope boundary without contacting the gateway", async () => {
    const runtimeEnv = localTaxEnv();
    await seedLocalTaxRule(100_000, "static", "expiry-boundary");
    await runCheckoutWorkflow(runtimeEnv, checkoutParams(), immediateStep());
    const original = await env.BILLING_DB.prepare(`SELECT payment_url
      FROM payment_request_checkout_intents WHERE payment_request_id = ? AND status = 'succeeded'`)
      .bind(paymentRequestId)
      .first<{ payment_url: string }>();
    const boundary = new Date(Math.ceil(Date.now() / 1000) * 1000 + 2000);
    await env.BILLING_DB.prepare(`UPDATE indirect_tax_registration_scopes SET effective_to = ?
      WHERE id = 'local-tax-scope-wa-expiry-boundary'`)
      .bind(boundary.toISOString())
      .run();
    const network = vi.fn<typeof fetch>();
    const response = await handleEasyPayDirectTaxQuote(
      taxQuoteRequest(new URL(original!.payment_url).searchParams.get("checkout")!),
      runtimeEnv,
      "expiry-quote",
      network,
    );
    const body = await response.json<{ tax_quote: { id: string; checkout: string } }>();
    expect(
      await env.BILLING_DB.prepare(
        "SELECT expires_at FROM easy_pay_direct_checkout_tax_quotes WHERE id = ?",
      )
        .bind(body.tax_quote.id)
        .first(),
    ).toEqual({ expires_at: boundary.toISOString() });
    // Use the actual local D1 clock; JavaScript fake timers do not advance SQL datetime('now').
    await new Promise((resolve) =>
      setTimeout(resolve, Math.max(boundary.getTime() - Date.now() + 25, 0)),
    );
    await expect(
      handleEasyPayDirectCheckoutSubmission(
        paymentRequest(body.tax_quote.checkout, body.tax_quote.id),
        runtimeEnv,
        "expired-local-quote",
        network,
      ),
    ).rejects.toMatchObject({ code: "checkout_tax_quote_required" });
    expect(network).not.toHaveBeenCalled();
  }, 10_000);

  it("requires explicit matching product codes, never inferring from billing cadence", () => {
    expect(resolveCheckoutTaxCode('["txcd_10103100"]')).toBe("txcd_10103100");
    expect(resolveCheckoutTaxCode('["txcd_10202000","txcd_10202000"]')).toBe("txcd_10202000");
    for (const input of [
      null,
      "monthly",
      "one_time",
      "[]",
      "[null]",
      '["txcd_10103100",null]',
      '["txcd_10103100","txcd_10202000"]',
    ]) {
      expect(() => resolveCheckoutTaxCode(input)).toThrowError(
        expect.objectContaining({ code: "checkout_tax_classification_missing" }),
      );
    }
  });

  it("reprices atomically and charges only the signed tax-inclusive total", async () => {
    const runtimeEnv = taxEnv();
    await runCheckoutWorkflow(runtimeEnv, checkoutParams(), immediateStep());
    const original = await env.BILLING_DB.prepare(
      `SELECT id, payment_url FROM payment_request_checkout_intents
       WHERE payment_request_id = ? AND status = 'succeeded'`,
    )
      .bind(paymentRequestId)
      .first<{ id: string; payment_url: string }>();
    const originalToken = new URL(original!.payment_url).searchParams.get("checkout")!;
    const stripeFetch = vi.fn<typeof fetch>(async (input, init) => {
      expect(String(input)).toBe("https://api.stripe.com/v1/tax/calculations");
      expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer rk_test_tax_synthetic");
      const form = new URLSearchParams(String(init?.body));
      expect(form.get("customer_details[address][country]")).toBe("US");
      expect(form.get("customer_details[address][state]")).toBe("WA");
      expect(form.get("customer_details[address][postal_code]")).toBe("98104");
      expect(form.get("customer_details[address_source]")).toBe("billing");
      expect(form.get("line_items[0][amount]")).toBe("1999");
      expect(form.get("line_items[0][tax_behavior]")).toBe("exclusive");
      expect(form.get("line_items[0][tax_code]")).toBe("txcd_10103100");
      return Response.json({
        id: `taxcalc_${crypto.randomUUID().replaceAll("-", "")}`,
        amount_total: 2199,
        currency: "usd",
        expires_at: Math.floor(Date.now() / 1000) + 3600,
        livemode: false,
      });
    });
    const quoteResponse = await handleEasyPayDirectTaxQuote(
      taxQuoteRequest(originalToken),
      runtimeEnv,
      "request-tax-quote",
      stripeFetch,
    );
    const quoteBody = await quoteResponse.json<{
      tax_quote: {
        id: string;
        checkout: string;
        subtotal_cents: number;
        tax_cents: number;
        total_cents: number;
        charged_total_cents: number;
      };
    }>();
    expect(quoteBody.tax_quote).toMatchObject({
      subtotal_cents: 1999,
      tax_cents: 200,
      total_cents: 2199,
      charged_total_cents: 2199,
    });
    expect(quoteBody.tax_quote.checkout).not.toBe(originalToken);
    await expect(
      env.BILLING_DB.prepare(
        `SELECT invoice.tax_minor, invoice.total_due_minor, invoice.version AS invoice_version,
                request.amount_minor, request.version AS request_version,
                link.invoice_version AS link_invoice_version,
                quote.status, quote.total_minor
         FROM invoices invoice
         JOIN invoices_payment_requests link ON link.invoice_id = invoice.id
         JOIN payment_requests request ON request.id = link.payment_request_id
         JOIN easy_pay_direct_checkout_tax_quotes quote ON quote.payment_request_id = request.id
         WHERE request.id = ?`,
      )
        .bind(paymentRequestId)
        .first(),
    ).resolves.toEqual({
      tax_minor: 200,
      total_due_minor: 2199,
      amount_minor: 2199,
      request_version: 2,
      invoice_version: 2,
      link_invoice_version: 2,
      status: "applied",
      total_minor: 2199,
    });
    await expect(
      handleEasyPayDirectCheckoutSubmission(
        paymentRequest(quoteBody.tax_quote.checkout),
        runtimeEnv,
        "request-missing-tax-quote",
        vi.fn<typeof fetch>(),
      ),
    ).rejects.toMatchObject({ code: "checkout_tax_quote_required" });

    const gatewayFetch = vi.fn<typeof fetch>(async (input, init) => {
      if (String(input).includes("/v1/tax/transactions/create_from_calculation")) {
        const form = new URLSearchParams(String(init?.body));
        expect(form.get("calculation")).toMatch(/^taxcalc_/);
        expect(form.get("reference")).toBe("epd-tax-test-1");
        return Response.json({ id: "tax_epd_test_1", livemode: false });
      }
      const form = new URLSearchParams(String(init?.body));
      if (String(input).endsWith("/api/query.php")) {
        expect(form.get("order_id")).toBe(paymentRequestId);
        return new Response(
          `<nm_response><transaction><transaction_id>epd-tax-test-1</transaction_id><order_id>${paymentRequestId}</order_id><condition>complete</condition><currency>USD</currency><customer_vault_id>vault-tax-1</customer_vault_id><action><action_type>sale</action_type><success>1</success><amount>21.99</amount></action></transaction></nm_response>`,
        );
      }
      expect(form.get("amount")).toBe("21.99");
      expect(form.get("billing_method")).toBe("initial_recurring");
      return new Response(
        "response=1&responsetext=Approved&response_code=100&transactionid=epd-tax-test-1&authcode=TEST&customer_vault_id=vault-tax-1",
      );
    });
    const paid = await handleEasyPayDirectCheckoutSubmission(
      paymentRequest(quoteBody.tax_quote.checkout, quoteBody.tax_quote.id),
      runtimeEnv,
      "request-tax-payment",
      gatewayFetch,
    );
    await expect(paid.json()).resolves.toMatchObject({ status: "succeeded" });
    expect(gatewayFetch).toHaveBeenCalledTimes(3);
    await expect(
      env.BILLING_DB.prepare(
        "SELECT status, committed_at IS NOT NULL AS committed FROM easy_pay_direct_checkout_tax_quotes WHERE id = ?",
      )
        .bind(quoteBody.tax_quote.id)
        .first(),
    ).resolves.toEqual({ status: "committed", committed: 1 });
    const execution = await env.BILLING_DB.prepare(
      `SELECT id, provider_transaction_id FROM easy_pay_direct_payment_executions
       WHERE tax_quote_id = ? LIMIT 1`,
    )
      .bind(quoteBody.tax_quote.id)
      .first<{ id: string; provider_transaction_id: string }>();
    const replayNetwork = vi.fn<typeof fetch>();
    await expect(
      commitAppliedCheckoutTaxQuote(
        runtimeEnv,
        execution!.id,
        execution!.provider_transaction_id,
        replayNetwork,
      ),
    ).resolves.toBe("committed");
    expect(replayNetwork).not.toHaveBeenCalled();
  });

  it("rejects live Stripe credentials before making a tax request", async () => {
    const runtimeEnv = taxEnv("sk_live_forbidden");
    await runCheckoutWorkflow(runtimeEnv, checkoutParams(), immediateStep());
    const checkout = await env.BILLING_DB.prepare(
      `SELECT payment_url FROM payment_request_checkout_intents
       WHERE payment_request_id = ? AND status = 'succeeded'`,
    )
      .bind(paymentRequestId)
      .first<{ payment_url: string }>();
    const token = new URL(checkout!.payment_url).searchParams.get("checkout")!;
    const stripeFetch = vi.fn<typeof fetch>();
    await expect(
      handleEasyPayDirectTaxQuote(
        taxQuoteRequest(token),
        runtimeEnv,
        "request-live-key",
        stripeFetch,
      ),
    ).rejects.toMatchObject({ code: "checkout_tax_test_key_required" });
    expect(stripeFetch).not.toHaveBeenCalled();
  });

  it("rejects an unclassified plan before any tax network request", async () => {
    await env.BILLING_DB.prepare("UPDATE plans SET metadata_json = '{}' WHERE id = ?")
      .bind(planId)
      .run();
    const runtimeEnv = localTaxEnv();
    await runCheckoutWorkflow(runtimeEnv, checkoutParams(), immediateStep());
    const intent = await env.BILLING_DB.prepare(
      "SELECT payment_url FROM payment_request_checkout_intents WHERE payment_request_id = ? AND status = 'succeeded'",
    )
      .bind(paymentRequestId)
      .first<{ payment_url: string }>();
    const network = vi.fn<typeof fetch>();
    await expect(
      handleEasyPayDirectTaxQuote(
        taxQuoteRequest(new URL(intent!.payment_url).searchParams.get("checkout")!),
        runtimeEnv,
        "missing-classification",
        network,
      ),
    ).rejects.toMatchObject({ code: "checkout_tax_classification_missing" });
    expect(network).not.toHaveBeenCalled();
  });

  it("uses the explicit local classification for a one-time purchase without calling Stripe", async () => {
    const runtimeEnv = localTaxEnv();
    await env.BILLING_DB.prepare("UPDATE plans SET interval = 'one_time' WHERE id = ?")
      .bind(planId)
      .run();
    await seedLocalTaxRule(100_000);
    await runCheckoutWorkflow(runtimeEnv, checkoutParams(), immediateStep());
    const original = await env.BILLING_DB.prepare(
      `SELECT payment_url FROM payment_request_checkout_intents
       WHERE payment_request_id = ? AND status = 'succeeded'`,
    )
      .bind(paymentRequestId)
      .first<{ payment_url: string }>();
    const originalToken = new URL(original!.payment_url).searchParams.get("checkout")!;
    const noTaxNetwork = vi.fn<typeof fetch>();
    const quoteResponse = await handleEasyPayDirectTaxQuote(
      taxQuoteRequest(originalToken),
      runtimeEnv,
      "request-local-tax-quote",
      noTaxNetwork,
    );
    const quoteBody = await quoteResponse.json<{
      tax_quote: {
        id: string;
        checkout: string;
        subtotal_cents: number;
        tax_cents: number;
        total_cents: number;
      };
    }>();
    expect(quoteBody.tax_quote).toMatchObject({
      subtotal_cents: 1999,
      tax_cents: 200,
      total_cents: 2199,
    });
    expect(noTaxNetwork).not.toHaveBeenCalled();
    await expect(
      env.BILLING_DB.prepare(
        `SELECT provider_code, local_rule_set_id, local_rule_id, local_collection_mode, tax_code
         FROM easy_pay_direct_checkout_tax_quotes WHERE id = ?`,
      )
        .bind(quoteBody.tax_quote.id)
        .first(),
    ).resolves.toEqual({
      provider_code: "local_d1",
      local_rule_set_id: "local-tax-rules-synthetic",
      local_rule_id: "local-tax-rule-wa-synthetic",
      local_collection_mode: "collect",
      tax_code: "txcd_10103100",
    });

    await expect(
      env.BILLING_DB.prepare(
        "UPDATE easy_pay_direct_checkout_tax_quotes SET local_collection_mode = 'off' WHERE id = ?",
      )
        .bind(quoteBody.tax_quote.id)
        .run(),
    ).rejects.toThrow("immutable_checkout_tax_collection_mode");
    await env.BILLING_DB.prepare(
      "UPDATE indirect_tax_registration_scopes SET collection_mode = 'off' WHERE organization_id = ?",
    )
      .bind(organizationId)
      .run();
    const offResponse = await handleEasyPayDirectTaxQuote(
      taxQuoteRequest(quoteBody.tax_quote.checkout),
      runtimeEnv,
      "collection-off",
      noTaxNetwork,
    );
    const offBody = await offResponse.json<{ tax_quote: { id: string; checkout: string } }>();
    expect(offBody.tax_quote).toMatchObject({
      subtotal_cents: 1999,
      tax_cents: 0,
      total_cents: 1999,
      collection_mode: "off",
    });
    expect(offBody.tax_quote.id).not.toBe(quoteBody.tax_quote.id);
    expect(noTaxNetwork).not.toHaveBeenCalled();

    const gatewayFetch = vi.fn<typeof fetch>(async (input, init) => {
      const form = new URLSearchParams(String(init?.body));
      if (String(input).endsWith("/api/query.php")) {
        expect(form.get("order_id")).toBe(paymentRequestId);
        return new Response(
          `<nm_response><transaction><transaction_id>epd-local-tax-test-1</transaction_id><order_id>${paymentRequestId}</order_id><condition>complete</condition><currency>USD</currency><action><action_type>sale</action_type><success>1</success><amount>19.99</amount></action></transaction></nm_response>`,
        );
      }
      expect(form.get("amount")).toBe("19.99");
      expect(form.has("billing_method")).toBe(false);
      expect(form.has("customer_vault")).toBe(false);
      expect(form.has("stored_credential_indicator")).toBe(false);
      return new Response(
        "response=1&responsetext=Approved&response_code=100&transactionid=epd-local-tax-test-1&authcode=TEST",
      );
    });
    const paid = await handleEasyPayDirectCheckoutSubmission(
      paymentRequest(offBody.tax_quote.checkout, offBody.tax_quote.id),
      runtimeEnv,
      "request-local-tax-payment",
      gatewayFetch,
    );
    await expect(paid.json()).resolves.toMatchObject({ status: "succeeded" });
    expect(gatewayFetch).toHaveBeenCalledTimes(2);
    await expect(
      env.BILLING_DB.prepare(
        "SELECT status, local_collection_mode, committed_at IS NOT NULL AS committed FROM easy_pay_direct_checkout_tax_quotes WHERE id = ?",
      )
        .bind(offBody.tax_quote.id)
        .first(),
    ).resolves.toEqual({ status: "committed", local_collection_mode: "off", committed: 1 });
  });

  it("persists an encrypted Washington address and the exact authority rate snapshot", async () => {
    const runtimeEnv = localTaxEnv();
    await seedLocalTaxRule(65_000, "wa_dor_address", `correction-${paymentRequestId}`);
    await runCheckoutWorkflow(runtimeEnv, checkoutParams(), immediateStep());
    const original = await env.BILLING_DB.prepare(
      `SELECT payment_url FROM payment_request_checkout_intents
       WHERE payment_request_id = ? AND status = 'succeeded'`,
    )
      .bind(paymentRequestId)
      .first<{ payment_url: string }>();
    const authority = vi.fn<typeof fetch>(
      async () =>
        new Response(
          `<response result="0" loccode="1726" rate="0.102500">
           <rate staterate="0.065000" localrate="0.037500" period="Q32026"
                 jurisdiction="SEATTLE" county="KING" />
           <results location="700 FIFTH AVE" city="SEATTLE" zip="98104" plus4="" />
         </response>`,
          { headers: { "content-type": "application/xml" } },
        ),
    );
    const response = await handleEasyPayDirectTaxQuote(
      taxQuoteRequest(new URL(original!.payment_url).searchParams.get("checkout")!, true),
      runtimeEnv,
      "request-washington-tax-quote",
      authority,
    );
    const body = await response.json<{ tax_quote: { id: string; tax_cents: number } }>();
    expect(body.tax_quote.tax_cents).toBe(205);
    expect(authority).toHaveBeenCalledTimes(1);
    const stored = await env.BILLING_DB.prepare(
      `SELECT local_calculation_method, billing_address_ciphertext, billing_address_iv,
              billing_address_key_id,
              rate_location_code, rate_jurisdiction, rate_period, rate_valid_through,
              state_rate_ppm, local_rate_ppm
       FROM easy_pay_direct_checkout_tax_quotes WHERE id = ?`,
    )
      .bind(body.tax_quote.id)
      .first<Record<string, unknown>>();
    expect(stored).toMatchObject({
      local_calculation_method: "wa_dor_address",
      billing_address_key_id: "test-v1",
      rate_location_code: "1726",
      rate_jurisdiction: "SEATTLE, KING",
      rate_period: "Q32026",
      rate_valid_through: "2026-10-01T00:00:00.000Z",
      state_rate_ppm: 65_000,
      local_rate_ppm: 37_500,
    });
    expect(String(stored!.billing_address_ciphertext)).not.toContain("FIFTH");
    expect(String(stored!.billing_address_ciphertext)).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(String(stored!.billing_address_iv)).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it("fails before the Washington authority request when address encryption is unavailable", async () => {
    await seedLocalTaxRule(65_000, "wa_dor_address", `missing-key-${paymentRequestId}`);
    await runCheckoutWorkflow(localTaxEnv(), checkoutParams(), immediateStep());
    const original = await env.BILLING_DB.prepare(
      `SELECT payment_url FROM payment_request_checkout_intents
       WHERE payment_request_id = ? AND status = 'succeeded'`,
    )
      .bind(paymentRequestId)
      .first<{ payment_url: string }>();
    const token = new URL(original!.payment_url).searchParams.get("checkout")!;
    const missingSecret = new Proxy(localTaxEnv(), {
      get(target, property, receiver) {
        if (property === "INDIRECT_TAX_ADDRESS_ENCRYPTION_SECRET") return undefined;
        return Reflect.get(target, property, receiver) as unknown;
      },
    }) as Env;
    const authority = vi.fn<typeof fetch>();
    await expect(
      handleEasyPayDirectTaxQuote(
        washingtonTaxQuoteRequest(token, {
          address_line: "700 FIFTH AVE",
          city: "SEATTLE",
          postal_code: "98104",
        }),
        missingSecret,
        "request-washington-missing-address-key",
        authority,
      ),
    ).rejects.toMatchObject({
      status: 503,
      code: "checkout_tax_address_encryption_unavailable",
    });
    expect(authority).not.toHaveBeenCalled();
  });

  it("requires the customer to review a Washington-standardized address before quoting", async () => {
    const runtimeEnv = localTaxEnv();
    await seedLocalTaxRule(65_000, "wa_dor_address");
    await runCheckoutWorkflow(runtimeEnv, checkoutParams(), immediateStep());
    const original = await env.BILLING_DB.prepare(
      `SELECT payment_url FROM payment_request_checkout_intents
       WHERE payment_request_id = ? AND status = 'succeeded'`,
    )
      .bind(paymentRequestId)
      .first<{ payment_url: string }>();
    const token = new URL(original!.payment_url).searchParams.get("checkout")!;
    const authority: typeof fetch = async () =>
      new Response(
        `<response result="2" loccode="1726" rate="0.102500">
           <rate staterate="0.065000" localrate="0.037500" period="Q32026"
                 jurisdiction="SEATTLE" county="KING" />
           <results location="700 FIFTH AVE" city="SEATTLE" zip="98104" plus4="5058" />
         </response>`,
        { headers: { "content-type": "application/xml" } },
      );
    await expect(
      handleEasyPayDirectTaxQuote(
        washingtonTaxQuoteRequest(token, {
          address_line: "700 Fifth Avenue",
          city: "Seattle",
          postal_code: "98104",
        }),
        runtimeEnv,
        "request-washington-correction",
        authority,
      ),
    ).rejects.toMatchObject({
      code: "checkout_tax_address_correction_required",
      details: {
        normalized_address: {
          address_line: "700 FIFTH AVE",
          city: "SEATTLE",
          state: "WA",
          postal_code: "98104-5058",
        },
      },
    });
    const confirmed = await handleEasyPayDirectTaxQuote(
      washingtonTaxQuoteRequest(token, {
        address_line: "700 FIFTH AVE",
        city: "SEATTLE",
        postal_code: "98104-5058",
        confirmed: true,
      }),
      runtimeEnv,
      "request-washington-confirmed",
      authority,
    );
    await expect(confirmed.json()).resolves.toMatchObject({
      tax_quote: { tax_cents: 205, total_cents: 2204 },
    });
  });
});

function washingtonTaxQuoteRequest(
  checkout: string,
  address: {
    address_line: string;
    city: string;
    postal_code: string;
    confirmed?: boolean;
  },
) {
  return new Request("https://lago.test/easy_pay_direct/tax_quote", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      checkout,
      billing_address: { country: "US", state: "WA", ...address },
    }),
  });
}

function taxQuoteRequest(checkout: string, fullWashingtonAddress = false) {
  return new Request("https://lago.test/easy_pay_direct/tax_quote", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      checkout,
      billing_address: {
        country: "US",
        state: "WA",
        postal_code: "98104",
        ...(fullWashingtonAddress ? { address_line: "700 Fifth Avenue", city: "Seattle" } : {}),
      },
    }),
  });
}

function paymentRequest(checkout: string, taxQuoteId?: string) {
  return new Request("https://lago.test/easy_pay_direct/payment_form", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      checkout,
      payment_token: "hosted-tax-token",
      phone: "+15555550123",
      terms_accepted: true,
      ...(taxQuoteId
        ? {
            tax_quote_id: taxQuoteId,
            billing_address: { country: "US", state: "WA", postal_code: "98104" },
          }
        : {}),
    }),
  });
}

function checkoutParams() {
  const id = `tax-checkout-${paymentRequestId}`;
  return {
    organizationId,
    paymentRequestId,
    paymentRequestVersion: 1,
    idempotencyKey: id,
    correlationId: id,
  };
}

function taxEnv(stripeKey = "rk_test_tax_synthetic"): Env {
  return new Proxy(env, {
    get(target, property, receiver) {
      if (property === "PAYMENT_MUTATIONS_ENABLED") return "1";
      if (property === "EASY_PAY_DIRECT_ORGANIZATION_ID") return organizationId;
      if (property === "EASY_PAY_DIRECT_ACCOUNT_CODE") return "epd-tax";
      if (property === "PUBLIC_BASE_URL") return "https://lago.test";
      if (property === "EASY_PAY_DIRECT_COMMERCE_API_KEY") {
        return "epd_synthetic_sk_test_tax";
      }
      if (property === "EASY_PAY_DIRECT_SECURITY_KEY") return "synthetic-security-key";
      if (property === "EASY_PAY_DIRECT_TOKENIZATION_KEY") return "synthetic-tokenization-key";
      if (property === "EASY_PAY_DIRECT_CHECKOUT_SIGNING_SECRET") {
        return "synthetic-checkout-signing-secret";
      }
      if (property === "EASY_PAY_DIRECT_NETWORK_MODE") return "gateway_test";
      if (property === "EASY_PAY_DIRECT_LIVEMODE_ALLOWED") return "0";
      if (property === "EASY_PAY_DIRECT_TAX_MODE") return "enforced";
      if (property === "INDIRECT_TAX_ADDRESS_ENCRYPTION_KEY_ID") return "test-v1";
      if (property === "INDIRECT_TAX_ADDRESS_ENCRYPTION_SECRET") {
        return "synthetic-address-encryption-secret-32-bytes";
      }
      if (property === "EASY_PAY_DIRECT_TAX_PROVIDER") return "stripe_test";
      if (property === "EASY_PAY_DIRECT_TAX_CODE") return "txcd_10103100";
      if (property === "EASY_PAY_DIRECT_ONE_TIME_TAX_CODE") return "txcd_10202000";
      if (property === "STRIPE_RESTRICTED_API_KEY") return stripeKey;
      return Reflect.get(target, property, receiver) as unknown;
    },
  }) as Env;
}

function localTaxEnv(): Env {
  const base = taxEnv("not-configured");
  return new Proxy(base, {
    get(target, property, receiver) {
      if (property === "EASY_PAY_DIRECT_TAX_PROVIDER") return "local_d1";
      if (property === "STRIPE_RESTRICTED_API_KEY") return undefined;
      return Reflect.get(target, property, receiver) as unknown;
    },
  }) as Env;
}

async function seedCouponAllocation(amount: number) {
  const now = new Date().toISOString();
  const id = `coupon-${invoiceId}`;
  await env.BILLING_DB.batch([
    env.BILLING_DB.prepare(`INSERT INTO coupons(id,organization_id,code,name,coupon_type,amount_minor,currency,frequency,expiration,reusable,status,request_sha256,created_at,updated_at)
      VALUES(?,?,?,'Fixture discount','fixed_amount',?,'USD','once','no_expiration',1,'active','fixture',?,?)`).bind(
      id,
      organizationId,
      id,
      amount,
      now,
      now,
    ),
    env.BILLING_DB.prepare(`INSERT INTO applied_coupons(id,organization_id,customer_id,coupon_id,amount_minor,currency,frequency,status,request_sha256,created_at,updated_at)
      VALUES(?,?,?,?,?,'USD','once','active','fixture',?,?)`).bind(
      id,
      organizationId,
      customerId,
      id,
      amount,
      now,
      now,
    ),
    env.BILLING_DB.prepare(`INSERT INTO coupon_credits(id,organization_id,invoice_id,applied_coupon_id,applied_coupon_version,amount_minor,currency,before_taxes,allocations_json,created_at)
      VALUES(?,?,?,?,1,?,'USD',1,?,?)`).bind(
      id,
      organizationId,
      invoiceId,
      id,
      amount,
      JSON.stringify([{ lineId: `line-${invoiceId}`, amountMinor: amount }]),
      now,
    ),
  ]);
}

async function seedLocalTaxRule(
  ratePpm: number,
  calculationMethod: "static" | "wa_dor_address" = "static",
  uniqueSuffix?: string,
) {
  const now = new Date().toISOString();
  const suffix =
    uniqueSuffix ?? (calculationMethod === "static" ? "synthetic" : "synthetic-address");
  const ruleSetId = `local-tax-rules-${suffix}`;
  const ruleId = `local-tax-rule-wa-${suffix}`;
  await env.BILLING_DB.batch([
    env.BILLING_DB.prepare(
      "UPDATE indirect_tax_rule_sets SET status = 'retired' WHERE status = 'active'",
    ),
    env.BILLING_DB.prepare(
      `INSERT INTO indirect_tax_rule_sets
       (id, version, status, source_name, source_url, source_published_at, effective_from,
        effective_to, content_sha256, refreshed_at, created_at, activated_at)
       VALUES (?, (SELECT COALESCE(MAX(version), 0) + 1 FROM indirect_tax_rule_sets),
               'active', 'Synthetic tax fixture',
               'https://example.invalid/tax-fixture', ?, '2020-01-01T00:00:00.000Z', NULL,
               ?, ?, ?, ?)`,
    ).bind(ruleSetId, now, "a".repeat(64), now, now, now),
    env.BILLING_DB.prepare(
      `INSERT INTO indirect_tax_rules
       (id, rule_set_id, country, region, postal_prefix, product_tax_code, taxability,
        rate_ppm, priority, source_url, source_reference, effective_from, effective_to, created_at,
        calculation_method)
       VALUES (?, ?, 'US', 'WA', NULL,
               'txcd_10103100', 'taxable', ?, 0, 'https://webgis.dor.wa.gov/webapi/',
               'synthetic-only', '2020-01-01T00:00:00.000Z', NULL, ?, ?)`,
    ).bind(ruleId, ruleSetId, ratePpm, now, calculationMethod),
    env.BILLING_DB.prepare(
      `INSERT INTO indirect_tax_registration_scopes
       (id, organization_id, rule_set_id, country, region, status, registration_reference,
        effective_from, effective_to, created_at, updated_at)
       VALUES (?, ?, ?, 'US', 'WA',
               'enabled', 'synthetic-only', '2020-01-01T00:00:00.000Z', NULL, ?, ?)`,
    ).bind(`local-tax-scope-wa-${suffix}`, organizationId, ruleSetId, now, now),
  ]);
}

function immediateStep(): WorkflowStep {
  return {
    async do(_name: string, ...args: unknown[]) {
      const callback = args.find((argument) => typeof argument === "function") as
        | (() => Promise<unknown>)
        | undefined;
      if (!callback) throw new Error("missing_workflow_callback");
      return callback();
    },
  } as unknown as WorkflowStep;
}
