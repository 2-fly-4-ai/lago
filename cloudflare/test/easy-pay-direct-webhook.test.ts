import { env } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import {
  handleEasyPayDirectWebhook,
  validEasyPayDirectSignature,
  validEasyPayDirectSignatureForAnyKey,
} from "../src/webhooks/easy-pay-direct";

describe("Easy Pay Direct webhook signatures", () => {
  it("accepts signed Elements sandbox receipts after UI rollback and rejects unsafe modes", async () => {
    const organizationId = `elements-webhook-${crypto.randomUUID()}`;
    const now = new Date().toISOString();
    await env.BILLING_DB.prepare(
      "INSERT INTO organizations(id,external_id,name,created_at,updated_at) VALUES(?,?,'Fixture',?,?)",
    )
      .bind(organizationId, organizationId, now, now)
      .run();
    const signingKey = "fictional-elements-signing-key";
    const request = async (livemode = false) => {
      const timestamp = Math.floor(Date.now() / 1000);
      const body = JSON.stringify({
        id: crypto.randomUUID(),
        type: "order.succeeded",
        created: timestamp,
        livemode,
        data: { object: { id: crypto.randomUUID(), total: 900, currency: "usd" } },
      });
      const key = await crypto.subtle.importKey(
        "raw",
        new TextEncoder().encode(signingKey),
        { name: "HMAC", hash: "SHA-256" },
        false,
        ["sign"],
      );
      const digest = await crypto.subtle.sign(
        "HMAC",
        key,
        new TextEncoder().encode(`${timestamp}.${body}`),
      );
      const signature = [...new Uint8Array(digest)]
        .map((byte) => byte.toString(16).padStart(2, "0"))
        .join("");
      return new Request("https://lago.example.test/webhook", {
        method: "POST",
        headers: { "EPD-Signature": `t=${timestamp},v1=${signature}` },
        body,
      });
    };
    const runtime = {
      ...env,
      APP_ENV: "staging",
      EASY_PAY_DIRECT_CHECKOUT_BACKEND: "gateway_vault",
      EASY_PAY_DIRECT_NETWORK_MODE: "gateway_test",
      EASY_PAY_DIRECT_LIVEMODE_ALLOWED: "0",
      EASY_PAY_DIRECT_WEBHOOK_SIGNING_KEY: signingKey,
      EASY_PAY_DIRECT_ORGANIZATION_ID: organizationId,
      EASY_PAY_DIRECT_ACCOUNT_CODE: "fixture",
    } as unknown as Env;
    expect(
      (await handleEasyPayDirectWebhook(await request(), runtime, organizationId, "fixture"))
        .status,
    ).toBe(200);
    await expect(
      handleEasyPayDirectWebhook(await request(true), runtime, organizationId, "fixture"),
    ).rejects.toMatchObject({ code: "webhook_environment_mismatch" });
    await expect(
      handleEasyPayDirectWebhook(
        await request(),
        { ...runtime, APP_ENV: "production" } as unknown as Env,
        organizationId,
        "fixture",
      ),
    ).rejects.toMatchObject({ code: "easy_pay_direct_network_disabled" });
    await expect(
      handleEasyPayDirectWebhook(
        await request(),
        { ...runtime, EASY_PAY_DIRECT_LIVEMODE_ALLOWED: "1" },
        organizationId,
        "fixture",
      ),
    ).rejects.toMatchObject({ code: "easy_pay_direct_network_disabled" });
  });
  it("preserves the archive when D1 commits but its batch response is lost", async () => {
    const eventId = `fixture-lost-batch-${crypto.randomUUID()}`;
    const organizationId = `fixture-webhook-org-${eventId}`;
    const now = new Date().toISOString();
    await env.BILLING_DB.prepare(`INSERT INTO organizations
      (id, external_id, name, created_at, updated_at) VALUES (?, ?, 'Webhook QA', ?, ?)`)
      .bind(organizationId, organizationId, now, now)
      .run();
    const body = JSON.stringify({
      id: eventId,
      type: "order.succeeded",
      livemode: false,
      data: { object: { id: `fixture-order-${eventId}`, total: 900, currency: "usd" } },
    });
    const timestamp = Math.floor(Date.now() / 1000);
    const key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode("fixture-key"),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    const signed = await crypto.subtle.sign(
      "HMAC",
      key,
      new TextEncoder().encode(`${timestamp}.${body}`),
    );
    const signature = Array.from(new Uint8Array(signed), (value) =>
      value.toString(16).padStart(2, "0"),
    ).join("");
    const database = new Proxy(env.BILLING_DB, {
      get(target, property) {
        if (property === "batch")
          return async (statements: D1PreparedStatement[]) => {
            await target.batch(statements);
            throw new Error("fixture_batch_committed_response_lost");
          };
        const value = Reflect.get(target, property);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const send = vi.fn(async () => {});
    const events = new Proxy(env.DOMAIN_EVENTS, {
      get(target, property) {
        if (property === "send") return send;
        const value = Reflect.get(target, property);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const runtimeEnv: Env = {
      ...env,
      BILLING_DB: database,
      DOMAIN_EVENTS: events,
      EASY_PAY_DIRECT_WEBHOOK_SIGNING_KEY: "fixture-key",
      EASY_PAY_DIRECT_NETWORK_MODE: "test",
      EASY_PAY_DIRECT_ACCOUNT_CODE: "fixture-account",
      EASY_PAY_DIRECT_ORGANIZATION_ID: organizationId,
    };
    const response = await handleEasyPayDirectWebhook(
      new Request("https://example.com/webhook", {
        method: "POST",
        headers: { "EPD-Signature": `t=${timestamp},v1=${signature}` },
        body,
      }),
      runtimeEnv,
      organizationId,
      "fixture-lost-response",
    );
    expect(response.status).toBe(200);
    const receipt = await env.BILLING_DB.prepare(
      "SELECT archive_key FROM webhook_receipts WHERE id = ?",
    )
      .bind(`epd_${eventId}`)
      .first<{ archive_key: string }>();
    expect(await (await env.BILLING_ARTIFACTS.get(receipt!.archive_key))?.text()).toBe(body);
    expect(send).toHaveBeenCalledOnce();
  });

  it("preserves the winning archive when duplicate webhook ingests race", async () => {
    const eventId = `fixture-concurrent-${crypto.randomUUID()}`;
    const organizationId = `fixture-webhook-org-${eventId}`;
    const now = new Date().toISOString();
    await env.BILLING_DB.prepare(`INSERT INTO organizations
      (id, external_id, name, created_at, updated_at) VALUES (?, ?, 'Webhook QA', ?, ?)`)
      .bind(organizationId, organizationId, now, now)
      .run();
    const body = JSON.stringify({
      id: eventId,
      type: "order.succeeded",
      livemode: false,
      data: { object: { id: `fixture-order-${eventId}`, total: 900, currency: "usd" } },
    });
    const timestamp = Math.floor(Date.now() / 1000);
    const key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode("fixture-key"),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    const signed = await crypto.subtle.sign(
      "HMAC",
      key,
      new TextEncoder().encode(`${timestamp}.${body}`),
    );
    const signature = Array.from(new Uint8Array(signed), (value) =>
      value.toString(16).padStart(2, "0"),
    ).join("");
    const candidates: string[] = [];
    let release: () => void = () => {};
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    const artifacts = new Proxy(env.BILLING_ARTIFACTS, {
      get(target, property) {
        if (property === "put")
          return async (...args: Parameters<R2Bucket["put"]>) => {
            const result = await target.put(...args);
            candidates.push(args[0]);
            if (candidates.length === 2) release();
            await barrier;
            return result;
          };
        const value = Reflect.get(target, property);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const send = vi.fn(async () => {});
    const events = new Proxy(env.DOMAIN_EVENTS, {
      get(target, property) {
        if (property === "send") return send;
        const value = Reflect.get(target, property);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const runtimeEnv: Env = {
      ...env,
      BILLING_ARTIFACTS: artifacts,
      DOMAIN_EVENTS: events,
      EASY_PAY_DIRECT_WEBHOOK_SIGNING_KEY: "fixture-key",
      EASY_PAY_DIRECT_NETWORK_MODE: "test",
      EASY_PAY_DIRECT_ACCOUNT_CODE: "fixture-account",
      EASY_PAY_DIRECT_ORGANIZATION_ID: organizationId,
    };
    const request = () =>
      new Request("https://example.com/webhook", {
        method: "POST",
        headers: { "EPD-Signature": `t=${timestamp},v1=${signature}` },
        body,
      });
    const results = await Promise.all([
      handleEasyPayDirectWebhook(request(), runtimeEnv, organizationId, "fixture-request-a"),
      handleEasyPayDirectWebhook(request(), runtimeEnv, organizationId, "fixture-request-b"),
    ]);
    const payloads = await Promise.all(
      results.map((response) => response.json<{ replayed: boolean }>()),
    );
    expect(payloads.filter((payload) => payload.replayed)).toHaveLength(1);
    expect(new Set(candidates).size).toBe(2);
    const receipt = await env.BILLING_DB.prepare(
      "SELECT archive_key FROM webhook_receipts WHERE id = ?",
    )
      .bind(`epd_${eventId}`)
      .first<{ archive_key: string }>();
    expect(receipt).not.toBeNull();
    expect(await (await env.BILLING_ARTIFACTS.get(receipt!.archive_key))?.text()).toBe(body);
    const abandoned = candidates.find((candidate) => candidate !== receipt!.archive_key)!;
    expect(await env.BILLING_ARTIFACTS.get(abandoned)).toBeNull();
    expect(send).toHaveBeenCalledOnce();
  });

  it("verifies the documented timestamp.raw-body HMAC-SHA256 format", async () => {
    const body = JSON.stringify({
      id: "synthetic-event-1",
      type: "order.succeeded",
      livemode: false,
      data: { object: { id: "synthetic-order-1", object: "order" } },
    });
    const now = Date.parse("2026-08-22T00:00:00.000Z");
    const timestamp = Math.floor(now / 1000);
    const key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode("synthetic-signing-key"),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    const digest = await crypto.subtle.sign(
      "HMAC",
      key,
      new TextEncoder().encode(`${timestamp}.${body}`),
    );
    const signature = [...new Uint8Array(digest)]
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("");
    await expect(
      validEasyPayDirectSignature(
        body,
        `t=${timestamp},v1=${signature}`,
        "synthetic-signing-key",
        now,
      ),
    ).resolves.toBe(true);
    await expect(
      validEasyPayDirectSignature(
        `${body} `,
        `t=${timestamp},v1=${signature}`,
        "synthetic-signing-key",
        now,
      ),
    ).resolves.toBe(false);
    await expect(
      validEasyPayDirectSignature(
        body,
        `t=${timestamp},v1=${signature}`,
        "synthetic-signing-key",
        now + 301_000,
      ),
    ).resolves.toBe(false);
  });

  it("rejects malformed signature headers", async () => {
    await expect(
      validEasyPayDirectSignature("{}", "sha256=abc", "synthetic-signing-key"),
    ).resolves.toBe(false);
  });

  it("accepts the previous signing key during a provider rotation window", async () => {
    const body = '{"id":"synthetic-rotation-event"}';
    const now = Date.parse("2026-08-22T00:00:00.000Z");
    const timestamp = Math.floor(now / 1000);
    const key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode("previous-signing-key"),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    const digest = await crypto.subtle.sign(
      "HMAC",
      key,
      new TextEncoder().encode(`${timestamp}.${body}`),
    );
    const signature = [...new Uint8Array(digest)]
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("");

    await expect(
      validEasyPayDirectSignatureForAnyKey(
        body,
        `t=${timestamp},v1=${signature}`,
        ["current-signing-key", "previous-signing-key"],
        now,
      ),
    ).resolves.toBe(true);
  });
});
