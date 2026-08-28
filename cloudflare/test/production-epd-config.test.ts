import productionConfig from "../wrangler.production.jsonc?raw";
import productionPlanMigration from "../migrations/0098_production_store_one_time_plan.sql?raw";
import { describe, expect, it } from "vitest";

describe("production EPD canary configuration", () => {
  it("enables only the production EPD payment path for the Store canary", () => {
    expect(productionConfig).toContain('"EASY_PAY_DIRECT_ORGANIZATION_ID": "org-serp-billing"');
    expect(productionConfig).toContain(
      '"EASY_PAY_DIRECT_SUCCESS_REDIRECT_URL": "https://serp.store/checkout/success"',
    );
    expect(productionConfig).toContain('"PAYMENT_MUTATIONS_ENABLED": "1"');
    expect(productionConfig).toContain('"EASY_PAY_DIRECT_NETWORK_MODE": "production"');
    expect(productionConfig).toContain('"EASY_PAY_DIRECT_LIVEMODE_ALLOWED": "1"');
    expect(productionConfig).toContain('"PROVIDER_READS_ENABLED": "1"');
    expect(productionConfig).toContain('"CREDIT_NOTE_REFUND_MODE": "disabled"');
    expect(productionConfig).toContain('"WALLET_FUNDING_MODE": "disabled"');
    expect(productionConfig).toContain('"EXTERNAL_TAX_MODE": "disabled"');
    expect(productionConfig).toContain('"STRIPE_NETWORK_MODE": "disabled"');
    expect(productionConfig).toContain('"STRIPE_WEBHOOKS_ENABLED": "0"');
    expect(productionConfig).toContain('"STRIPE_LIVEMODE_ALLOWED": "0"');
    expect(productionConfig).toContain('"OUTBOUND_WEBHOOKS_ENABLED": "0"');
    expect(productionConfig).not.toContain("org-synthetic-e2e-20260815-001");
  });

  it("adds only the required production one-time Store plan", () => {
    expect(productionPlanMigration).toContain("'org-serp-billing'");
    expect(productionPlanMigration).toContain("'serp-1-app-plan-one-time'");
    expect(productionPlanMigration).toMatch(/'one_time',\s+900,\s+'USD'/u);
    expect(productionPlanMigration).not.toMatch(/synthetic/iu);
  });
});
