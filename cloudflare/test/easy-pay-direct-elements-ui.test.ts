import { describe, expect, it } from "vitest";
import {
  createEasyPayDirectCheckoutUrl,
  easyPayDirectPaymentForm,
  type EasyPayDirectEnv,
} from "../src/providers/easy-pay-direct";

const runtime: EasyPayDirectEnv = {
  APP_ENV: "staging",
  EASY_PAY_DIRECT_CHECKOUT_BACKEND: "commerce_elements",
  EASY_PAY_DIRECT_PUBLISHABLE_KEY: "epd_test_pk_fictionalPublic",
  EASY_PAY_DIRECT_CHECKOUT_SIGNING_SECRET: "fictional-signing-secret-for-local-ui-tests",
  EASY_PAY_DIRECT_NETWORK_MODE: "test",
  EASY_PAY_DIRECT_LIVEMODE_ALLOWED: "0",
  EASY_PAY_DIRECT_TAX_MODE: "enforced",
  PUBLIC_BASE_URL: "https://lago.example.test",
};
const now = Date.parse("2026-09-08T00:00:00Z");
async function render(overrides: Partial<EasyPayDirectEnv> = {}) {
  const env = { ...runtime, ...overrides };
  const checkout = await createEasyPayDirectCheckoutUrl(
    env,
    { checkoutIntentId: "fictional-elements-ui" },
    now,
  );
  return easyPayDirectPaymentForm(new URL(checkout.paymentUrl), env, now, {
    title: "SERP App Plan",
    description: "One eligible app.",
    interval: "monthly",
    amountMinor: 495,
    subtotalMinor: 900,
    creditsMinor: 450,
    taxMinor: 45,
    currency: "USD",
    customerEmail: "fictional@example.test",
  });
}
describe("Elements payment surface", () => {
  it("keeps pricing, tax and consent while using only Commerce hosted capture", async () => {
    const response = await render();
    const html = await response.text();
    expect(html).toContain('src="https://js.epd.com/element/v1/epd.js"');
    expect(html).toContain('EPD("epd_test_pk_fictionalPublic",{disableTelemetry:true})');
    for (const text of [
      "$4.95",
      "$9.00",
      "−$4.50",
      "$0.45",
      "Discounts &amp; credits",
      "Billed monthly",
      'id="country"',
      'id="address-line"',
      'id="city"',
      'id="phone"',
      'id="terms"',
      "terms_accepted",
      "tax_quote_id",
      "billing_address",
      "payment_token:paymentToken",
      'id="payment-recovery"',
      "/easy_pay_direct/payment_status",
      "submissionRetired=true",
      "Test cards only. No real money will move.",
    ])
      expect(html).toContain(text);
    for (const text of [
      "CollectJS",
      "Collect.js",
      "billing_id",
      "data-tokenization-key",
      "card_visa",
      'name="ccnumber"',
      'name="cvv"',
    ])
      expect(html).not.toContain(text);
    const csp = response.headers.get("Content-Security-Policy")!;
    expect(csp).toContain("https://js.basistheory.com");
    expect(csp).toContain("https://api.epd.com");
    expect(csp).not.toMatch(/unsafe-inline|unsafe-eval|easypaydirectgateway|\*/u);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
  });

  it("renders live Elements only for a coherent production tuple", async () => {
    const response = await render({
      APP_ENV: "production",
      EASY_PAY_DIRECT_NETWORK_MODE: "production",
      EASY_PAY_DIRECT_LIVEMODE_ALLOWED: "1",
      EASY_PAY_DIRECT_PUBLISHABLE_KEY: "epd_live_pk_fictionalPublic",
    });
    const html = await response.text();
    expect(html).toContain('EPD("epd_live_pk_fictionalPublic",{disableTelemetry:true})');
    expect(html).toContain("epd.sandbox!==false");
    expect(html).not.toContain("Test cards only. No real money will move.");
    expect(html).not.toContain('<span class="test-chip">TEST</span>');
  });
  it.each([
    { APP_ENV: "production" },
    { APP_ENV: undefined },
    { EASY_PAY_DIRECT_NETWORK_MODE: "production" as const },
    { EASY_PAY_DIRECT_NETWORK_MODE: "disabled" as const },
    { EASY_PAY_DIRECT_LIVEMODE_ALLOWED: "1" as const },
    { EASY_PAY_DIRECT_LIVEMODE_ALLOWED: undefined },
  ])("rejects unsafe Elements environment %j", async (overrides) => {
    await expect(render(overrides)).rejects.toMatchObject({
      code: "easy_pay_direct_elements_environment_mismatch",
    });
  });
  it.each([
    undefined,
    "epd_live_pk_wrongmode",
    "epd_test_sk_notpublic",
    "epd_test_pk_bad</script>",
  ])("rejects missing/live/secret/malformed publishable key %s", async (key) => {
    await expect(render({ EASY_PAY_DIRECT_PUBLISHABLE_KEY: key })).rejects.toMatchObject({
      code: "easy_pay_direct_elements_publishable_key_required",
    });
  });
});
