import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import { sha256Hex } from "../src/auth/api-key";
import portalWorker from "../src/portal/index";

async function fixture(prefix: string) {
  const suffix = crypto.randomUUID();
  const organizationId = `${prefix}-org-${suffix}`;
  const customerId = `${prefix}-customer-${suffix}`;
  const token = crypto.randomUUID().replaceAll("-", "").repeat(2);
  const now = new Date().toISOString();
  await env.BILLING_DB.batch([
    env.BILLING_DB.prepare(
      "INSERT INTO organizations (id, external_id, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
    ).bind(organizationId, organizationId, `${prefix} organization`, now, now),
    env.BILLING_DB.prepare(
      `INSERT INTO customers
       (id, organization_id, external_id, email, name, currency, metadata_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'USD', '{}', ?, ?)`,
    ).bind(
      customerId,
      organizationId,
      `${prefix}-external`,
      `${prefix}@example.invalid`,
      `${prefix} customer`,
      now,
      now,
    ),
    env.BILLING_DB.prepare(
      `INSERT INTO customer_portal_tokens
       (id, organization_id, customer_id, token_sha256, active, created_at, updated_at)
       VALUES (?, ?, ?, ?, 1, ?, ?)`,
    ).bind(crypto.randomUUID(), organizationId, customerId, await sha256Hex(token), now, now),
  ]);
  return { organizationId, customerId, token };
}

function request(token: string, path: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers);
  headers.set("X-Customer-Portal-Token", token);
  return new Request(`https://portal.test${path}`, { ...init, headers });
}

async function fetchPortal(portalRequest: Request) {
  const context = createExecutionContext();
  const response = await portalWorker.fetch(
    portalRequest,
    {
      APP_ENV: "development",
      BILLING_DB: env.BILLING_DB,
      BILLING_ARTIFACTS: env.BILLING_ARTIFACTS,
    },
    context,
  );
  await waitOnExecutionContext(context);
  return response;
}

describe("customer portal Worker", () => {
  it("fails closed and returns only the customer bound to the opaque token", async () => {
    const primary = await fixture("portal-primary");
    const secondary = await fixture("portal-secondary");
    const unauthorized = await fetchPortal(
      new Request("https://portal.test/api/portal/v1/session"),
    );
    expect(unauthorized.status).toBe(401);
    expect(unauthorized.headers.get("Cache-Control")).toBe("no-store");

    const response = await fetchPortal(request(primary.token, "/api/portal/v1/session"));
    const body = (await response.json()) as { customer: { external_id: string } };
    expect(body.customer.external_id).toBe("portal-primary-external");
    expect(JSON.stringify(body)).not.toContain(secondary.customerId);
  });

  it("allows same-origin profile edits while keeping paid wallet top-up disabled", async () => {
    const portal = await fixture("portal-edit");
    const updated = await fetchPortal(
      request(portal.token, "/api/portal/v1/session", {
        method: "PATCH",
        headers: {
          Origin: "https://portal.test",
          "Content-Type": "application/json",
          "X-Portal-Request": "1",
        },
        body: JSON.stringify({ customer: { name: "Updated portal customer" } }),
      }),
    );
    expect(await updated.json()).toMatchObject({ customer: { name: "Updated portal customer" } });

    const topUp = await fetchPortal(
      request(portal.token, "/api/portal/v1/wallets/unknown/top-up", {
        method: "POST",
        headers: { Origin: "https://portal.test", "X-Portal-Request": "1" },
      }),
    );
    expect(topUp.status).toBe(422);
    expect(await topUp.json()).toMatchObject({ code: "external_action_disabled" });
  });
});
