import { applyD1Migrations, env } from "cloudflare:test";
import { beforeAll } from "vitest";

beforeAll(async () => {
  if (env.TEST_MIGRATIONS) await applyD1Migrations(env.BILLING_DB, env.TEST_MIGRATIONS);
});
