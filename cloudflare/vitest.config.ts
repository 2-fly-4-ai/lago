import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

const migrations = await readD1Migrations("./migrations");

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: {
        bindings: {
          TEST_MIGRATIONS: migrations,
          AUTHORIZE_NET_API_LOGIN_ID: "synthetic-login-id",
          AUTHORIZE_NET_TRANSACTION_KEY: "synthetic-transaction-key",
          AUTHORIZE_NET_SIGNATURE_KEY: "0123456789abcdef".repeat(8),
          EASY_PAY_DIRECT_TAX_MODE: "disabled",
          PROVIDER_READS_ENABLED: "1",
          OUTBOUND_WEBHOOKS_ENABLED: "1",
          OUTBOUND_WEBHOOK_HMAC_KEY: "synthetic-outbound-webhook-master-key",
        },
      },
    }),
  ],
  test: {
    setupFiles: ["./test/setup.ts"],
    testTimeout: 10_000,
  },
});
