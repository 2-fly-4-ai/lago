import { env, SELF } from "cloudflare:test";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { sha256Hex } from "../src/auth/api-key";
import type { DomainEvent } from "../src/domain-events";
import { deliverOutboundWebhooks } from "../src/webhooks/outbound";

const apiKey = "outbound-webhook-key";

beforeEach(async () => {
  const now = "2026-08-14T00:00:00.000Z";
  await env.BILLING_DB.batch([
    env.BILLING_DB.prepare(
      `DELETE FROM outbound_webhook_deliveries WHERE organization_id = 'org-outbound'`,
    ),
    env.BILLING_DB.prepare(`DELETE FROM webhook_endpoints WHERE organization_id = 'org-outbound'`),
    env.BILLING_DB.prepare(
      `INSERT OR IGNORE INTO organizations (id, external_id, name, created_at, updated_at)
       VALUES ('org-outbound', 'outbound-test', 'Outbound Test', ?, ?)`,
    ).bind(now, now),
    env.BILLING_DB.prepare(
      `INSERT OR IGNORE INTO api_keys
       (id, organization_id, key_prefix, key_hash, created_at, revoked_at)
       VALUES ('key-outbound', 'org-outbound', 'outbound', ?, ?, NULL)`,
    ).bind(await sha256Hex(apiKey), now),
  ]);
});

describe("outbound webhook delivery", () => {
  it("manages filtered endpoints and delivers an event exactly once with stable HMAC headers", async () => {
    const created = await request("/api/v1/webhook_endpoints", "POST", {
      webhook_endpoint: {
        webhook_url: "https://hooks.example.test/lago",
        signature_algo: "hmac",
        name: "Synthetic sink",
        event_types: ["invoice.finalized", "invoice.finalized"],
      },
    });
    expect(created.status).toBe(200);
    const body = await created.json<{ webhook_endpoint: { lago_id: string } }>();
    expect(body.webhook_endpoint).toMatchObject({
      webhook_url: "https://hooks.example.test/lago",
      signature_algo: "hmac",
      event_types: ["invoice.finalized"],
    });
    const endpointId = body.webhook_endpoint.lago_id;
    await expect(
      request("/api/v1/webhook_endpoints").then((response) => response.json()),
    ).resolves.toMatchObject({ webhook_endpoints: [{ lago_id: endpointId }] });

    const requests: Array<{ body: string; headers: Headers }> = [];
    const fetcher = vi.fn<typeof fetch>(async (_input, init) => {
      requests.push({ body: String(init?.body), headers: new Headers(init?.headers) });
      return new Response("accepted", { status: 202 });
    });
    expect(await deliverOutboundWebhooks(testEnv(), invoiceEvent(), fetcher)).toBe("complete");
    expect(await deliverOutboundWebhooks(testEnv(), invoiceEvent(), fetcher)).toBe("complete");
    expect(requests).toHaveLength(1);
    expect(requests[0]?.headers.get("X-Lago-Signature-Algorithm")).toBe("hmac");
    expect(requests[0]?.headers.get("X-Lago-Signature")).toMatch(/^[A-Za-z0-9+/]+=*$/);
    expect(JSON.parse(requests[0]!.body)).toMatchObject({
      webhook_type: "invoice.finalized",
      event_id: "invoice-finalized:test:v1",
      data: { organizationId: "org-outbound" },
    });
    await expect(
      env.BILLING_DB.prepare(
        `SELECT status, attempts, http_status, response_excerpt
         FROM outbound_webhook_deliveries WHERE event_id = 'invoice-finalized:test:v1'`,
      ).first(),
    ).resolves.toEqual({
      status: "succeeded",
      attempts: 1,
      http_status: 202,
      response_excerpt: "accepted",
    });

    const updated = await request(`/api/v1/webhook_endpoints/${endpointId}`, "PUT", {
      webhook_endpoint: { event_types: ["customer.created"] },
    });
    expect(updated.status).toBe(200);
    expect(
      await deliverOutboundWebhooks(
        testEnv(),
        { ...invoiceEvent(), id: "invoice-finalized:filtered:v1" },
        fetcher,
      ),
    ).toBe("complete");
    expect(requests).toHaveLength(1);
    expect((await request(`/api/v1/webhook_endpoints/${endpointId}`, "DELETE")).status).toBe(200);
    expect((await request(`/api/v1/webhook_endpoints/${endpointId}`)).status).toBe(404);
  });

  it("records retryable and permanent outcomes and rejects unsafe endpoints", async () => {
    const unsafe = await request("/api/v1/webhook_endpoints", "POST", {
      webhook_endpoint: { webhook_url: "http://127.0.0.1:8787/webhook", signature_algo: "hmac" },
    });
    expect(unsafe.status).toBe(422);
    await expect(unsafe.json()).resolves.toMatchObject({ code: "unsafe_webhook_url" });

    const endpoint = await request("/api/v1/webhook_endpoints", "POST", {
      webhook_endpoint: { webhook_url: "https://hooks.example.test/retry", event_types: ["*"] },
    }).then((response) => response.json<{ webhook_endpoint: { lago_id: string } }>());
    expect(
      await deliverOutboundWebhooks(
        testEnv(),
        invoiceEvent(),
        vi.fn<typeof fetch>(async () => new Response("later", { status: 503 })),
      ),
    ).toBe("retry");
    expect(
      await deliverOutboundWebhooks(
        testEnv(),
        invoiceEvent(),
        vi.fn<typeof fetch>(async () => new Response("bad", { status: 400 })),
      ),
    ).toBe("complete");
    await expect(
      env.BILLING_DB.prepare(
        `SELECT status, attempts, http_status FROM outbound_webhook_deliveries
         WHERE webhook_endpoint_id = ?`,
      )
        .bind(endpoint.webhook_endpoint.lago_id)
        .first(),
    ).resolves.toEqual({ status: "failed", attempts: 2, http_status: 400 });
  });

  it("streams only a bounded response excerpt and cancels the remaining body", async () => {
    const endpoint = await request("/api/v1/webhook_endpoints", "POST", {
      webhook_endpoint: { webhook_url: "https://hooks.example.test/large", event_types: ["*"] },
    }).then((response) => response.json<{ webhook_endpoint: { lago_id: string } }>());
    let cancelled = false;
    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode("a".repeat(1500)));
        controller.enqueue(encoder.encode("b".repeat(1500)));
        controller.enqueue(encoder.encode("c".repeat(1500)));
      },
      cancel() {
        cancelled = true;
      },
    });
    expect(
      await deliverOutboundWebhooks(
        testEnv(),
        invoiceEvent(),
        vi.fn<typeof fetch>(async () => new Response(body, { status: 202 })),
      ),
    ).toBe("complete");
    const delivery = await env.BILLING_DB.prepare(
      `SELECT response_excerpt FROM outbound_webhook_deliveries
       WHERE webhook_endpoint_id = ?`,
    )
      .bind(endpoint.webhook_endpoint.lago_id)
      .first<{ response_excerpt: string }>();
    expect(delivery?.response_excerpt).toBe(`${"a".repeat(1500)}${"b".repeat(548)}`);
    expect(cancelled).toBe(true);
  });
});

function invoiceEvent(): DomainEvent {
  return {
    id: "invoice-finalized:test:v1",
    type: "invoice.finalized",
    version: 1,
    aggregateType: "invoice",
    aggregateId: "invoice-test",
    aggregateVersion: 1,
    occurredAt: "2026-08-14T00:00:00.000Z",
    causationId: "test",
    correlationId: "test",
    payload: { organizationId: "org-outbound", invoiceId: "invoice-test" },
  };
}

function testEnv() {
  return env as Env & { OUTBOUND_WEBHOOK_HMAC_KEY: string };
}

function request(path: string, method = "GET", body?: unknown) {
  return SELF.fetch(`https://lago.test${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
}
