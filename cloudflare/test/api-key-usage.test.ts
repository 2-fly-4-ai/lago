import { env, SELF } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { sha256Hex } from "../src/auth/api-key";

const apiKey = "api-key-usage-test-key";

beforeAll(async () => {
  const createdAt = "2026-08-01T00:00:00.000Z";
  await env.BILLING_DB.batch([
    env.BILLING_DB.prepare(
      `INSERT INTO organizations (id, external_id, name, created_at, updated_at)
       VALUES ('org-api-key-usage', 'org-api-key-usage', 'API Key Usage', ?, ?)`,
    ).bind(createdAt, createdAt),
    env.BILLING_DB.prepare(
      `INSERT INTO api_keys
       (id, organization_id, key_prefix, key_hash, created_at, revoked_at)
       VALUES ('key-api-key-usage', 'org-api-key-usage', 'api-key', ?, ?, NULL)`,
    ).bind(await sha256Hex(apiKey), createdAt),
  ]);
});

describe("API key usage tracking", () => {
  it("persists successful authentication and never advances a revoked key", async () => {
    const response = await SELF.fetch("https://lago.test/api/v1/plans", {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    expect(response.status).toBe(200);
    const tracked = await env.BILLING_DB.prepare(
      "SELECT last_used_at FROM api_keys WHERE id = 'key-api-key-usage'",
    ).first<{ last_used_at: string }>();
    expect(tracked?.last_used_at).toBeTruthy();

    await env.BILLING_DB.prepare(
      `UPDATE api_keys SET revoked_at = '2026-08-15T00:00:00.000Z'
       WHERE id = 'key-api-key-usage'`,
    ).run();
    const rejected = await SELF.fetch("https://lago.test/api/v1/plans", {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    expect(rejected.status).toBe(401);
    await expect(
      env.BILLING_DB.prepare(
        "SELECT last_used_at FROM api_keys WHERE id = 'key-api-key-usage'",
      ).first(),
    ).resolves.toEqual({ last_used_at: tracked!.last_used_at });
  });
});
