import { describe, expect, it, vi } from "vitest";

import {
  createStripeRefund,
  createStripeWalletFunding,
  STRIPE_API_VERSION,
} from "../src/providers/stripe";

const refundInput = {
  organizationId: "org-synthetic",
  invoiceId: "invoice-synthetic",
  creditNoteId: "credit-note-synthetic",
  paymentIntentId: "pi_synthetic",
  amountMinor: 1250,
  currency: "USD",
  idempotencyKey: "refund-synthetic-001",
  reason: "requested_by_customer" as const,
};

describe("Stripe provider boundary", () => {
  it("fails before transport while network access is disabled", async () => {
    const fetcher = vi.fn<typeof fetch>();
    await expect(
      createStripeRefund(
        {
          STRIPE_NETWORK_MODE: "disabled",
          STRIPE_RESTRICTED_API_KEY: ["rk", "test", "synthetic"].join("_"),
        },
        refundInput,
        fetcher,
      ),
    ).rejects.toMatchObject({ code: "stripe_network_disabled" });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("builds the bounded refund contract against an in-memory transport only", async () => {
    const fetcher = vi.fn<typeof fetch>(async (input, init) => {
      expect(String(input)).toBe("https://api.stripe.com/v1/refunds");
      const headers = new Headers(init?.headers);
      expect(headers.get("Stripe-Version")).toBe(STRIPE_API_VERSION);
      expect(headers.get("Idempotency-Key")).toBe(refundInput.idempotencyKey);
      expect(headers.get("Authorization")).toBe(`Bearer ${["rk", "test", "synthetic"].join("_")}`);
      const body = new URLSearchParams(String(init?.body));
      expect(Object.fromEntries(body)).toMatchObject({
        payment_intent: "pi_synthetic",
        amount: "1250",
        reason: "requested_by_customer",
        "metadata[lago_organization_id]": "org-synthetic",
        "metadata[lago_invoice_id]": "invoice-synthetic",
        "metadata[lago_credit_note_id]": "credit-note-synthetic",
      });
      expect(body.has("payment_method_types")).toBe(false);
      return Response.json({
        id: "re_synthetic",
        payment_intent: "pi_synthetic",
        amount: 1250,
        currency: "usd",
        status: "succeeded",
        failure_reason: null,
      });
    });

    await expect(
      createStripeRefund(
        {
          STRIPE_NETWORK_MODE: "enabled",
          STRIPE_RESTRICTED_API_KEY: ["rk", "test", "synthetic"].join("_"),
        },
        refundInput,
        fetcher,
      ),
    ).resolves.toEqual({
      id: "re_synthetic",
      paymentIntentId: "pi_synthetic",
      amountMinor: 1250,
      currency: "USD",
      status: "succeeded",
      failureReason: null,
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("retains Stripe's requires-action refund state without external traffic", async () => {
    const fetcher = vi.fn<typeof fetch>(async () =>
      Response.json({
        id: "re_requires_action_synthetic",
        payment_intent: "pi_synthetic",
        amount: 1250,
        currency: "usd",
        status: "requires_action",
        failure_reason: null,
      }),
    );
    await expect(
      createStripeRefund(
        {
          STRIPE_NETWORK_MODE: "enabled",
          STRIPE_RESTRICTED_API_KEY: ["rk", "test", "synthetic"].join("_"),
        },
        refundInput,
        fetcher,
      ),
    ).resolves.toMatchObject({ status: "requires_action" });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("builds a test-only wallet PaymentIntent with deterministic metadata", async () => {
    const fetcher = vi.fn<typeof fetch>(async (input, init) => {
      expect(String(input)).toBe("https://api.stripe.com/v1/payment_intents");
      const body = new URLSearchParams(String(init?.body));
      expect(Object.fromEntries(body)).toMatchObject({
        amount: "2500",
        currency: "usd",
        payment_method: "pm_card_visa",
        confirm: "true",
        "metadata[lago_organization_id]": "org-synthetic",
        "metadata[lago_wallet_id]": "wallet-synthetic",
        "metadata[lago_wallet_transaction_id]": "transaction-synthetic",
      });
      return Response.json({
        id: "pi_wallet_synthetic",
        status: "succeeded",
        client_secret: "pi_wallet_synthetic_secret_synthetic",
      });
    });
    await expect(
      createStripeWalletFunding(
        {
          STRIPE_NETWORK_MODE: "enabled",
          STRIPE_RESTRICTED_API_KEY: ["rk", "test", "synthetic"].join("_"),
        },
        {
          organizationId: "org-synthetic",
          walletId: "wallet-synthetic",
          walletTransactionId: "transaction-synthetic",
          amountMinor: 2500,
          currency: "USD",
          paymentMethodId: "pm_card_visa",
          idempotencyKey: "wallet-funding-synthetic",
        },
        fetcher,
      ),
    ).resolves.toMatchObject({ id: "pi_wallet_synthetic", status: "succeeded" });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
