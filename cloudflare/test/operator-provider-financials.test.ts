import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

import { handleOperatorProviderFinancialsRequest } from "../src/operator/provider-financials";

const organizationId = "org-provider-financials";

beforeEach(async () => {
  const now = "2026-08-18T00:00:00.000Z";
  await env.BILLING_DB.batch([
    env.BILLING_DB.prepare(
      `INSERT OR IGNORE INTO organizations (id, external_id, name, created_at, updated_at)
       VALUES (?, 'provider-financials', 'Provider Financials', ?, ?)`,
    ).bind(organizationId, now, now),
    env.BILLING_DB.prepare(
      `INSERT OR IGNORE INTO customers
       (id, organization_id, external_id, currency, metadata_json, created_at, updated_at)
       VALUES ('customer-provider-financials', ?, 'customer-provider-financials', 'USD', '{}', ?, ?)`,
    ).bind(organizationId, now, now),
    env.BILLING_DB.prepare(
      `INSERT OR IGNORE INTO invoices
       (id, organization_id, customer_id, number, status, payment_status, currency,
        subtotal_minor, tax_minor, credits_minor, total_due_minor, finalized_at, created_at, updated_at)
       VALUES ('invoice-provider-financials', ?, 'customer-provider-financials', 'INV-PROVIDER-001',
               'finalized', 'succeeded', 'USD', 3000, 0, 0, 3000, ?, ?, ?)`,
    ).bind(organizationId, now, now, now),
    env.BILLING_DB.prepare(
      `INSERT OR IGNORE INTO payment_attempts
       (id, organization_id, invoice_id, provider, provider_account_code,
        provider_transaction_id, idempotency_key, amount_minor, currency, status,
        created_at, updated_at)
       VALUES ('payment-provider-financials', ?, 'invoice-provider-financials', 'stripe',
               'stripe-synthetic', 'pi_provider_financials', 'payment-provider-financials-key',
               3000, 'USD', 'succeeded', ?, ?)`,
    ).bind(organizationId, now, now),
    env.BILLING_DB.prepare(
      `INSERT OR IGNORE INTO payment_disputes
       (id, organization_id, provider, provider_account_code, provider_dispute_id,
        payment_attempt_id, invoice_id, provider_payment_intent_id, amount_minor, currency,
        reason, status, livemode, provider_created_at, last_provider_event_created_at,
        created_at, updated_at)
       VALUES ('dispute-provider-financials', ?, 'stripe', 'stripe-synthetic', 'dp_synthetic',
               'payment-provider-financials', 'invoice-provider-financials',
               'pi_provider_financials', 750, 'USD', 'duplicate', 'needs_response', 0,
               ?, ?, ?, ?)`,
    ).bind(organizationId, now, now, now, now),
    env.BILLING_DB.prepare(
      `INSERT OR IGNORE INTO provider_refund_operations
       (id, organization_id, invoice_id, payment_attempt_id, provider, provider_account_code,
        provider_payment_id, provider_refund_id, idempotency_key, request_sha256, amount_minor,
        currency, status, created_at, updated_at)
       VALUES ('refund-provider-financials', ?, 'invoice-provider-financials',
               'payment-provider-financials', 'stripe', 'stripe-synthetic',
               'pi_provider_financials', NULL, 'refund-provider-financials-key', ?, 500,
               'USD', 'pending', ?, ?)`,
    ).bind(organizationId, "b".repeat(64), now, now),
  ]);
});

describe("operator provider financials", () => {
  it("lists tenant-scoped disputes and refunds without enabling mutations", async () => {
    const disputeResponse = await handleOperatorProviderFinancialsRequest(
      new Request("https://operator.test/api/operator/v1/payment-disputes"),
      env.BILLING_DB,
      organizationId,
      "request-disputes",
    );
    expect(disputeResponse?.status).toBe(200);
    await expect(disputeResponse?.json()).resolves.toMatchObject({
      payment_disputes: [
        {
          lago_id: "dispute-provider-financials",
          invoice_number: "INV-PROVIDER-001",
          amount_cents: 750,
          status: "needs_response",
          livemode: false,
        },
      ],
    });

    const refundResponse = await handleOperatorProviderFinancialsRequest(
      new Request("https://operator.test/api/operator/v1/provider-refunds"),
      env.BILLING_DB,
      organizationId,
      "request-refunds",
    );
    expect(refundResponse?.status).toBe(200);
    await expect(refundResponse?.json()).resolves.toMatchObject({
      provider_refunds: [
        {
          lago_id: "refund-provider-financials",
          invoice_number: "INV-PROVIDER-001",
          amount_cents: 500,
          status: "pending",
        },
      ],
    });

    await expect(
      handleOperatorProviderFinancialsRequest(
        new Request("https://operator.test/api/operator/v1/provider-refunds", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: "{}",
        }),
        env.BILLING_DB,
        organizationId,
        "request-mutation",
      ),
    ).rejects.toMatchObject({ code: "operator_provider_financials_read_only" });
  });

  it("does not expose another tenant's provider state", async () => {
    const response = await handleOperatorProviderFinancialsRequest(
      new Request("https://operator.test/api/operator/v1/payment-disputes"),
      env.BILLING_DB,
      "org-unrelated",
      "request-unrelated",
    );
    await expect(response?.json()).resolves.toMatchObject({ payment_disputes: [] });
  });
});
