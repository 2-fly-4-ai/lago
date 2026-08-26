import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import { handleOperatorAdvancedBillingRequest } from "../src/operator/advanced-billing";

function jsonRequest(path: string, method: string, body: unknown): Request {
  return new Request(`https://operator.test${path}`, {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function createFixture(prefix: string) {
  const suffix = crypto.randomUUID();
  const organizationId = `${prefix}-org-${suffix}`;
  const customerId = `${prefix}-customer-${suffix}`;
  const customerExternalId = `${prefix}-external-${suffix}`;
  const taxId = `${prefix}-tax-${suffix}`;
  const campaignId = `${prefix}-campaign-${suffix}`;
  const invoiceId = `${prefix}-invoice-${suffix}`;
  const lineId = `${prefix}-line-${suffix}`;
  const now = new Date().toISOString();
  await env.BILLING_DB.batch([
    env.BILLING_DB.prepare(
      "INSERT INTO organizations (id, external_id, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
    ).bind(organizationId, `${prefix}-org-external-${suffix}`, `${prefix} org`, now, now),
    env.BILLING_DB.prepare(
      `INSERT INTO customers (id, organization_id, external_id, email, name, currency, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'USD', ?, ?)`,
    ).bind(
      customerId,
      organizationId,
      customerExternalId,
      `${prefix}@example.test`,
      `${prefix} customer`,
      now,
      now,
    ),
    env.BILLING_DB.prepare(
      `INSERT INTO taxes (id, organization_id, code, name, rate, applied_to_organization, status,
       request_sha256, created_at, updated_at) VALUES (?, ?, 'vat', 'VAT', '20', 0, 'active', ?, ?, ?)`,
    ).bind(taxId, organizationId, `tax-${suffix}`, now, now),
    env.BILLING_DB.prepare(
      `INSERT INTO dunning_campaigns (id, organization_id, code, name, days_between_attempts,
       max_attempts, request_sha256, created_at, updated_at)
       VALUES (?, ?, 'standard', 'Standard', 3, 4, ?, ?, ?)`,
    ).bind(campaignId, organizationId, `campaign-${suffix}`, now, now),
    env.BILLING_DB.prepare(
      `INSERT INTO invoices
       (id, organization_id, customer_id, number, status, payment_status, currency,
        subtotal_minor, tax_minor, credits_minor, total_due_minor, version, finalized_at,
        issuing_date, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'finalized', 'pending', 'USD', 1000, 0, 0, 1000, 1, ?, ?, ?, ?)`,
    ).bind(
      invoiceId,
      organizationId,
      customerId,
      `INV-${suffix.slice(0, 8)}`,
      now,
      now.slice(0, 10),
      now,
      now,
    ),
    env.BILLING_DB.prepare(
      `INSERT INTO invoice_lines
       (id, invoice_id, line_type, description, quantity_decimal, unit_amount_decimal,
        amount_minor, source_type, source_id, created_at)
       VALUES (?, ?, 'fee', 'Original fee', '1', '1000', 1000, 'add_on', ?, ?)`,
    ).bind(lineId, invoiceId, `source-${suffix}`, now),
  ]);
  return {
    campaignId,
    customerExternalId,
    customerId,
    invoiceId,
    lineId,
    organizationId,
    suffix,
    taxId,
  };
}

async function call(request: Request, organizationId: string, requestId = crypto.randomUUID()) {
  const response = await handleOperatorAdvancedBillingRequest(
    request,
    { BILLING_DB: env.BILLING_DB, BILLING_ARTIFACTS: env.BILLING_ARTIFACTS },
    organizationId,
    requestId,
  );
  if (!response) throw new Error("advanced handler did not match request");
  return response;
}

describe("operator advanced billing parity", () => {
  it("owns billing-entity taxes, dunning, logo, and customer configuration without crossing tenants", async () => {
    const fixture = await createFixture("advanced-config");
    const other = await createFixture("advanced-config-other");

    const taxes = await call(
      jsonRequest("/api/operator/v1/billing-entities/default/taxes", "PUT", {
        billing_entity: { tax_codes: ["vat"] },
      }),
      fixture.organizationId,
    );
    expect(await taxes.json()).toMatchObject({ taxes: [{ code: "vat" }] });

    const dunning = await call(
      jsonRequest("/api/operator/v1/billing-entities/default/dunning-campaign", "PUT", {
        billing_entity: { dunning_campaign_code: "standard" },
      }),
      fixture.organizationId,
    );
    expect(await dunning.json()).toMatchObject({ dunning_campaign: { code: "standard" } });

    const customerTaxes = await call(
      jsonRequest(`/api/operator/v1/customers/${fixture.customerExternalId}/taxes`, "POST", {
        applied_tax: { tax_code: "vat" },
      }),
      fixture.organizationId,
    );
    expect(await customerTaxes.json()).toMatchObject({ taxes: [{ code: "vat" }] });

    const settings = await call(
      jsonRequest(
        `/api/operator/v1/customers/${fixture.customerExternalId}/document-settings`,
        "PUT",
        {
          document_settings: {
            document_locale: "fr",
            subscription_invoice_issuing_date_adjustment: "keep_anchor",
            subscription_invoice_issuing_date_anchor: "current_period_end",
            finalize_zero_amount_invoice: true,
          },
        },
      ),
      fixture.organizationId,
    );
    expect(await settings.json()).toMatchObject({
      document_settings: {
        document_locale: "fr",
        subscription_invoice_issuing_date_adjustment: "keep_anchor",
        subscription_invoice_issuing_date_anchor: "current_period_end",
        finalize_zero_amount_invoice: true,
      },
    });

    const png = "iVBORw0KGgo=";
    const logo = await call(
      jsonRequest("/api/operator/v1/billing-entities/default/logo", "PUT", {
        logo: { filename: "logo.png", mime_type: "image/png", data_base64: png },
      }),
      fixture.organizationId,
    );
    expect(await logo.json()).toMatchObject({ logo: { mime_type: "image/png", version: 1 } });
    const logoRead = await call(
      new Request("https://operator.test/api/operator/v1/billing-entities/default/logo"),
      fixture.organizationId,
    );
    expect(logoRead.headers.get("Content-Type")).toBe("image/png");

    await expect(
      call(
        new Request(
          `https://operator.test/api/operator/v1/customers/${fixture.customerExternalId}/document-settings`,
        ),
        other.organizationId,
      ),
    ).rejects.toMatchObject({ code: "customer_not_found" });
  });

  it("edits invoice metadata and payment state and regenerates adjusted fees idempotently", async () => {
    const fixture = await createFixture("advanced-invoice");
    const metadata = await call(
      jsonRequest(`/api/operator/v1/invoices/${fixture.invoiceId}/metadata`, "PUT", {
        metadata: [
          { key: "purchase_order", value: "PO-42" },
          { key: "account_manager", value: "Taylor" },
        ],
      }),
      fixture.organizationId,
    );
    expect(await metadata.json()).toMatchObject({
      metadata: expect.arrayContaining([
        expect.objectContaining({ key: "purchase_order", value: "PO-42" }),
        expect.objectContaining({ key: "account_manager", value: "Taylor" }),
      ]),
    });

    const payment = await call(
      jsonRequest(`/api/operator/v1/invoices/${fixture.invoiceId}/payment-status`, "PUT", {
        invoice: { payment_status: "succeeded" },
      }),
      fixture.organizationId,
    );
    expect(await payment.json()).toMatchObject({ invoice: { payment_status: "succeeded" } });

    const preview = await call(
      jsonRequest(`/api/operator/v1/invoices/${fixture.invoiceId}/adjusted-fees/preview`, "POST", {
        adjusted_fee: {
          invoice_line_id: fixture.lineId,
          description: "Corrected fee",
          units: "2",
          unit_amount_cents: "600",
        },
      }),
      fixture.organizationId,
    );
    expect(await preview.json()).toMatchObject({ adjusted_fee: { amount_cents: 1200 } });

    await call(
      jsonRequest(`/api/operator/v1/invoices/${fixture.invoiceId}/adjusted-fees`, "POST", {
        adjusted_fee: {
          invoice_line_id: fixture.lineId,
          description: "Corrected fee",
          units: "2",
          unit_amount_cents: "600",
        },
      }),
      fixture.organizationId,
    );
    await env.BILLING_DB.prepare(
      "UPDATE invoices SET status = 'voided', voided_at = ? WHERE id = ?",
    )
      .bind(new Date().toISOString(), fixture.invoiceId)
      .run();
    const regenerated = await call(
      jsonRequest(`/api/operator/v1/invoices/${fixture.invoiceId}/regenerate`, "POST", {}),
      fixture.organizationId,
    );
    const first = (await regenerated.json()) as { invoice: { lago_id: string } };
    expect(first.invoice).toMatchObject({ status: "draft", total_amount_cents: 1200 });
    const replay = await call(
      jsonRequest(`/api/operator/v1/invoices/${fixture.invoiceId}/regenerate`, "POST", {}),
      fixture.organizationId,
    );
    expect(await replay.json()).toMatchObject({ invoice: { lago_id: first.invoice.lago_id } });
  });

  it("estimates and edits credit notes and only deletes dependency-free customers", async () => {
    const fixture = await createFixture("advanced-credit");
    const estimate = await call(
      jsonRequest("/api/operator/v1/credit-notes/estimate", "POST", {
        credit_note: {
          invoice_id: fixture.invoiceId,
          items: [{ fee_id: fixture.lineId, amount_cents: 250 }],
        },
      }),
      fixture.organizationId,
    );
    expect(await estimate.json()).toMatchObject({
      credit_note: { total_amount_cents: 250, balance_amount_cents: 250 },
    });

    const creditNoteId = `credit-note-${fixture.suffix}`;
    const now = new Date().toISOString();
    await env.BILLING_DB.prepare(
      `INSERT INTO credit_notes
       (id, organization_id, customer_id, invoice_id, sequential_id, number, status,
        credit_status, reason, currency, total_amount_minor, credit_amount_minor,
        balance_amount_minor, version, idempotency_key, request_sha256, issuing_date,
        created_at, updated_at)
       VALUES (?, ?, ?, ?, 1, ?, 'finalized', 'available', 'other', 'USD', 250, 250,
        250, 1, ?, ?, ?, ?, ?)`,
    )
      .bind(
        creditNoteId,
        fixture.organizationId,
        fixture.customerId,
        fixture.invoiceId,
        `CN-${fixture.suffix.slice(0, 8)}`,
        `idem-${fixture.suffix}`,
        `hash-${fixture.suffix}`,
        now.slice(0, 10),
        now,
        now,
      )
      .run();
    const edited = await call(
      jsonRequest(`/api/operator/v1/credit-notes/${creditNoteId}`, "PUT", {
        credit_note: { reason: "order_change", description: "Scope corrected" },
      }),
      fixture.organizationId,
    );
    expect(await edited.json()).toMatchObject({
      credit_note: { reason: "order_change", description: "Scope corrected", version: 2 },
    });

    await expect(
      call(
        new Request(
          `https://operator.test/api/operator/v1/customers/${fixture.customerExternalId}`,
          { method: "DELETE" },
        ),
        fixture.organizationId,
      ),
    ).rejects.toMatchObject({ code: "customer_has_dependencies" });

    const free = await createFixture("advanced-delete");
    await env.BILLING_DB.prepare("DELETE FROM invoice_lines WHERE invoice_id = ?")
      .bind(free.invoiceId)
      .run();
    await env.BILLING_DB.prepare("DELETE FROM invoices WHERE id = ?").bind(free.invoiceId).run();
    const deleted = await call(
      new Request(`https://operator.test/api/operator/v1/customers/${free.customerExternalId}`, {
        method: "DELETE",
      }),
      free.organizationId,
    );
    expect(deleted.status).toBe(204);
  });

  it("updates and resets subscription progressive billing without provider side effects", async () => {
    const fixture = await createFixture("advanced-progressive");
    const now = new Date().toISOString();
    const planId = `plan-${fixture.suffix}`;
    const subscriptionId = `subscription-${fixture.suffix}`;
    const externalId = `subscription-external-${fixture.suffix}`;
    await env.BILLING_DB.batch([
      env.BILLING_DB.prepare(
        `INSERT INTO plans
         (id, organization_id, code, name, interval, amount_minor, currency, created_at, updated_at)
         VALUES (?, ?, ?, 'Progressive plan', 'monthly', 1000, 'USD', ?, ?)`,
      ).bind(planId, fixture.organizationId, `progressive-${fixture.suffix}`, now, now),
      env.BILLING_DB.prepare(
        `INSERT INTO subscriptions
         (id, organization_id, customer_id, plan_id, external_id, status, started_at,
          current_period_start, current_period_end, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, ?)`,
      ).bind(
        subscriptionId,
        fixture.organizationId,
        fixture.customerId,
        planId,
        externalId,
        now,
        now,
        "2026-09-18T00:00:00.000Z",
        now,
        now,
      ),
    ]);
    const updated = await call(
      jsonRequest(`/api/operator/v1/subscriptions/${externalId}/progressive-billing`, "PUT", {
        progressive_billing: { disabled: true },
      }),
      fixture.organizationId,
    );
    expect(await updated.json()).toMatchObject({ progressive_billing: { disabled: true } });
    const reset = await call(
      new Request(
        `https://operator.test/api/operator/v1/subscriptions/${externalId}/progressive-billing`,
        { method: "DELETE" },
      ),
      fixture.organizationId,
    );
    expect(await reset.json()).toMatchObject({ progressive_billing: { disabled: false } });
  });
});
