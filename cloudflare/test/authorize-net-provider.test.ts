import { describe, expect, it, vi } from "vitest";
import type { AuthorizeNetEnv } from "../src/providers/authorize-net";
import {
  createAuthorizeNetPaymentUrl,
  createAuthorizeNetPaymentRequestUrl,
  getAuthorizeNetTransaction,
  normalizeAuthorizeNetPaymentStatus,
} from "../src/providers/authorize-net";

const providerEnv = {
  AUTHORIZE_NET_API_LOGIN_ID: "synthetic-login",
  AUTHORIZE_NET_TRANSACTION_KEY: "synthetic-key",
  AUTHORIZE_NET_ENVIRONMENT: "sandbox",
  PUBLIC_BASE_URL: "https://lago.test",
} satisfies AuthorizeNetEnv;

describe("Authorize.Net provider adapter", () => {
  it("creates a bounded, short-lived hosted payment link with Lago metadata", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-13T00:00:00.000Z"));
    const providerFetch = vi.fn<typeof fetch>(async (_input, init) => {
      const request = JSON.parse(String(init?.body)) as Record<string, unknown>;
      expect(request).toMatchObject({
        getHostedPaymentPageRequest: {
          transactionRequest: {
            amount: "19.99",
            customer: { id: "synthetic-customer", email: "synthetic@example.com" },
          },
        },
      });
      return Response.json({ token: "synthetic-hosted-token", messages: { resultCode: "Ok" } });
    });

    const result = await createAuthorizeNetPaymentUrl(
      providerEnv,
      {
        invoiceId: "invoice-1",
        invoiceNumber: "INV-1",
        customerId: "customer-1",
        externalCustomerId: "synthetic-customer",
        customerEmail: "synthetic@example.com",
        organizationId: "org-1",
        amountMinor: 1999,
        currency: "USD",
      },
      providerFetch,
    );
    expect(result).toEqual({
      paymentUrl:
        "https://lago.test/authorize_net/payment_form?token=synthetic-hosted-token&environment=sandbox",
      token: "synthetic-hosted-token",
      expiresAt: "2026-08-13T00:14:00.000Z",
    });
    vi.useRealTimers();
  });

  it("normalizes transaction details and rejects oversized responses", async () => {
    const details = await getAuthorizeNetTransaction(
      providerEnv,
      "transaction-1",
      vi.fn<typeof fetch>(async () =>
        Response.json({
          transaction: {
            transId: "transaction-1",
            transactionStatus: "settledSuccessfully",
            authAmount: "19.99",
            order: { invoiceNumber: "INV-1" },
            userFields: { userField: [{ name: "lago_invoice_id", value: "invoice-1" }] },
          },
        }),
      ),
    );
    expect(details).toMatchObject({
      id: "transaction-1",
      status: "settledSuccessfully",
      amountMinor: 1999,
      invoiceNumber: "INV-1",
      metadata: { lago_invoice_id: "invoice-1" },
    });

    await expect(
      getAuthorizeNetTransaction(
        providerEnv,
        "transaction-large",
        vi.fn<typeof fetch>(
          async () => new Response("{}", { headers: { "Content-Length": String(256 * 1024 + 1) } }),
        ),
      ),
    ).rejects.toMatchObject({ code: "authorize_net_response_too_large" });
  });

  it("creates hosted payment-request metadata compatible with Lago webhooks", async () => {
    const providerFetch = vi.fn<typeof fetch>(async (_input, init) => {
      const request = JSON.parse(String(init?.body)) as {
        getHostedPaymentPageRequest: {
          transactionRequest: {
            amount: string;
            order: { invoiceNumber: string; description: string };
            userFields: { userField: Array<{ name: string; value: string }> };
          };
        };
      };
      const transaction = request.getHostedPaymentPageRequest.transactionRequest;
      expect(transaction.amount).toBe("17.00");
      expect(transaction.order).toEqual({
        invoiceNumber: "payment-request-1234",
        description: "Lago payment request",
      });
      expect(
        Object.fromEntries(
          transaction.userFields.userField.map((field) => [field.name, field.value]),
        ),
      ).toMatchObject({
        lago_payment_request_id: "payment-request-123456789",
        lago_customer_id: "customer-1",
        lago_organization_id: "org-1",
        lago_payable_id: "payment-request-123456789",
        lago_payable_type: "PaymentRequest",
        payment_type: "one-time",
        currency: "USD",
      });
      return Response.json({ token: "payment-request-token" });
    });

    await expect(
      createAuthorizeNetPaymentRequestUrl(
        providerEnv,
        {
          paymentRequestId: "payment-request-123456789",
          customerId: "customer-1",
          externalCustomerId: "external-customer-1",
          organizationId: "org-1",
          amountMinor: 1700,
          currency: "USD",
          customerEmail: "billing@example.com",
        },
        providerFetch,
      ),
    ).resolves.toMatchObject({
      paymentUrl: expect.stringContaining("token=payment-request-token"),
      token: "payment-request-token",
    });
  });

  it("maps provider states without treating unknown outcomes as success", () => {
    expect(normalizeAuthorizeNetPaymentStatus("capturedPendingSettlement")).toBe("succeeded");
    expect(normalizeAuthorizeNetPaymentStatus("authorizedHeldForReview")).toBe("pending");
    expect(normalizeAuthorizeNetPaymentStatus("declined")).toBe("failed");
    expect(normalizeAuthorizeNetPaymentStatus("brandNewProviderState")).toBe("unknown");
  });
});
