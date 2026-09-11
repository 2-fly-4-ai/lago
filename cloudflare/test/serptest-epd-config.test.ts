import serptestConfig from "../wrangler.serptest.jsonc?raw";
import { describe, expect, it } from "vitest";

describe("isolated EPD SerpTEST configuration", () => {
  it("enables the dedicated Gateway test lifecycle without live-provider access", () => {
    expect(serptestConfig).toContain('"name": "serp-dev-lago-epd-serptest"');
    expect(serptestConfig).toContain('"APP_ENV": "development"');
    expect(serptestConfig).toContain('"EASY_PAY_DIRECT_NETWORK_MODE": "gateway_test"');
    expect(serptestConfig).toContain('"EASY_PAY_DIRECT_LIVEMODE_ALLOWED": "0"');
    expect(serptestConfig).toContain('"CREDIT_NOTE_REFUND_MODE": "easy_pay_direct_test"');
    expect(serptestConfig).toContain('"PAYMENT_MUTATIONS_ENABLED": "1"');
    expect(serptestConfig).toContain('"EASY_PAY_DIRECT_AUTOMATIC_COLLECTION_ENABLED": "1"');
    expect(serptestConfig).toContain(
      '"EASY_PAY_DIRECT_AUTOMATIC_COLLECTION_SCOPE_MODE": "product_scoped"',
    );
    expect(serptestConfig).toContain('"STRIPE_NETWORK_MODE": "disabled"');
    expect(serptestConfig).toContain('"STRIPE_WEBHOOKS_ENABLED": "0"');
    expect(serptestConfig).toContain('"STRIPE_LIVEMODE_ALLOWED": "0"');
    expect(serptestConfig).toContain('"crons": []');
    expect(serptestConfig).not.toContain('"EASY_PAY_DIRECT_NETWORK_MODE": "production"');
    expect(serptestConfig).not.toContain('"EASY_PAY_DIRECT_LIVEMODE_ALLOWED": "1"');
    expect(serptestConfig).not.toContain(
      '"EASY_PAY_DIRECT_AUTOMATIC_COLLECTION_SCOPE_MODE": "all"',
    );
  });
});
