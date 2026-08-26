import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { handleExternalTaxApi } from "../src/api/external-tax";

const organizationId = "org-external-tax";
const auth = {
  organizationId,
  organizationExternalId: "external-tax",
  apiKeyId: "key-external-tax",
};

beforeEach(async () => {
  const now = new Date().toISOString();
  await env.BILLING_DB.batch([
    env.BILLING_DB.prepare("DELETE FROM external_tax_estimates WHERE organization_id = ?").bind(
      organizationId,
    ),
    env.BILLING_DB.prepare(
      `INSERT OR IGNORE INTO organizations (id, external_id, name, created_at, updated_at)
       VALUES (?, 'external-tax', 'External Tax', ?, ?)`,
    ).bind(organizationId, now, now),
  ]);
});

describe("external tax service-binding adapter", () => {
  it("fails closed without a configured service binding", async () => {
    await expect(
      handleExternalTaxApi(request(), { BILLING_DB: env.BILLING_DB }, auth, "request-disabled"),
    ).rejects.toMatchObject({ code: "external_tax_disabled" });
  });

  it("persists, calls, validates, and replays a synthetic estimate", async () => {
    const fetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      expect(headers.get("X-Adapter-Contract")).toBe("lago-tax-v1");
      expect(headers.get("Idempotency-Key")).toMatch(/^lago-tax:/);
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      expect(body).toMatchObject({ organization_id: organizationId, provider_code: "anrok" });
      return Response.json({ currency: "USD", tax_cents: 175 });
    });
    const adapter = { fetch } as unknown as Fetcher;
    const first = await handleExternalTaxApi(
      request(),
      {
        BILLING_DB: env.BILLING_DB,
        EXTERNAL_TAX_MODE: "service_binding",
        EXTERNAL_TAX_ADAPTER: adapter,
      },
      auth,
      "request-first",
    );
    await expect(first?.json()).resolves.toMatchObject({
      external_tax: { currency: "USD", subtotal_cents: 1000, tax_cents: 175, status: "succeeded" },
    });
    const replay = await handleExternalTaxApi(
      request(),
      {
        BILLING_DB: env.BILLING_DB,
        EXTERNAL_TAX_MODE: "service_binding",
        EXTERNAL_TAX_ADAPTER: adapter,
      },
      auth,
      "request-replay",
    );
    expect(replay?.status).toBe(200);
    expect(fetch).toHaveBeenCalledTimes(1);
    await expect(
      env.BILLING_DB.prepare(
        "SELECT status, tax_minor FROM external_tax_estimates WHERE organization_id = ?",
      )
        .bind(organizationId)
        .first(),
    ).resolves.toEqual({ status: "succeeded", tax_minor: 175 });
  });
});

function request() {
  return new Request("https://lago.test/api/v1/external_tax/estimate", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Idempotency-Key": "tax-estimate-001" },
    body: JSON.stringify({
      external_tax: {
        provider_code: "anrok",
        currency: "USD",
        lines: [{ id: "line-1", amount_cents: 1000, tax_code: "digital_services" }],
      },
    }),
  });
}
