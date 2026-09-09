import { describe, expect, it } from "vitest";
import { publicEasyPayDirectError } from "../src/api/easy-pay-direct-public-errors";
import { ApiError, apiErrorResponse } from "../src/http";
import worker from "../src/index";

describe("EPD public payment errors", () => {
  it("never returns arbitrary provider diagnostics, codes or details", async () => {
    const original = new ApiError(
      422,
      "fixture-vault-identifier",
      "Billing ID fixture-private-reference not found",
      {
        raw: "fixture-private-response",
      },
    );
    const response = apiErrorResponse(publicEasyPayDirectError(original), "fixture-request");
    expect(response.status).toBe(422);
    const body = await response.json();
    expect(body).toMatchObject({
      code: "checkout_payment_review_required",
      request_id: "fixture-request",
    });
    expect(JSON.stringify(body)).not.toContain("fixture-private");
    expect(JSON.stringify(body)).not.toContain("fixture-vault");
    expect(body).not.toHaveProperty("error_details");
    expect(original.message).toContain("fixture-private-reference");
  });

  it("uses fixed messages even when the provider returns a known or prototype code", () => {
    expect(
      publicEasyPayDirectError(new ApiError(422, "easy_pay_direct_declined", "private")).message,
    ).toBe("Your payment was declined. Contact your card issuer for help.");
    expect(publicEasyPayDirectError(new ApiError(422, "constructor", "private")).code).toBe(
      "checkout_payment_review_required",
    );
  });

  it("preserves validation guidance without exposing server configuration at the actual route", async () => {
    const response = await worker.fetch(
      new Request("https://billing.example.test/easy_pay_direct/payment_form", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          checkout: "fixture",
          payment_token: "fixture",
          phone: "+14155551234",
          terms_accepted: true,
        }),
      }),
      {} as Env,
    );
    expect(response.status).toBe(503);
    const body = await response.json();
    expect(body).toMatchObject({ code: "checkout_payment_review_required" });
    expect(JSON.stringify(body)).not.toContain("SIGNING_SECRET");
    const terms = publicEasyPayDirectError(
      new ApiError(422, "easy_pay_direct_terms_required", "private"),
    );
    expect(terms.message).toContain("Terms of Service");
  });
});
