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
          PROVIDER_READS_ENABLED: "1",
        },
      },
    }),
  ],
  test: { setupFiles: ["./test/setup.ts"] },
});
