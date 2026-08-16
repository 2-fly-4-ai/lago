import { env, SELF } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { sha256Hex } from "../src/auth/api-key";

const apiKey = "quotes-api-key";
const organizationId = "org-quotes-api";
const otherOrganizationId = "org-quotes-other";
const customerId = "customer-quotes-api";
const otherCustomerId = "customer-quotes-other";
const subscriptionId = "subscription-quotes-api";
const otherSubscriptionId = "subscription-quotes-other";
const ownerId = "11111111-1111-4111-8111-111111111111";
const secondOwnerId = "22222222-2222-4222-8222-222222222222";
const revokedOwnerId = "33333333-3333-4333-8333-333333333333";

beforeEach(async () => {
  const now = "2026-08-15T00:00:00.000Z";
  await env.BILLING_DB.batch([
    env.BILLING_DB.prepare(`DELETE FROM outbox_events WHERE organization_id IN (?, ?)`).bind(
      organizationId,
      otherOrganizationId,
    ),
    env.BILLING_DB.prepare(`DELETE FROM idempotency_records WHERE organization_id IN (?, ?)`).bind(
      organizationId,
      otherOrganizationId,
    ),
    env.BILLING_DB.prepare(`DELETE FROM quote_owners WHERE organization_id IN (?, ?)`).bind(
      organizationId,
      otherOrganizationId,
    ),
    env.BILLING_DB.prepare(`DELETE FROM quote_versions WHERE organization_id IN (?, ?)`).bind(
      organizationId,
      otherOrganizationId,
    ),
    env.BILLING_DB.prepare(`DELETE FROM quotes WHERE organization_id IN (?, ?)`).bind(
      organizationId,
      otherOrganizationId,
    ),
    env.BILLING_DB.prepare(
      `DELETE FROM organization_memberships WHERE organization_id IN (?, ?)`,
    ).bind(organizationId, otherOrganizationId),
    env.BILLING_DB.prepare(`DELETE FROM subscriptions WHERE organization_id IN (?, ?)`).bind(
      organizationId,
      otherOrganizationId,
    ),
    env.BILLING_DB.prepare(`DELETE FROM plans WHERE organization_id IN (?, ?)`).bind(
      organizationId,
      otherOrganizationId,
    ),
    env.BILLING_DB.prepare(`DELETE FROM customers WHERE organization_id IN (?, ?)`).bind(
      organizationId,
      otherOrganizationId,
    ),
    env.BILLING_DB.prepare(`DELETE FROM api_keys WHERE organization_id IN (?, ?)`).bind(
      organizationId,
      otherOrganizationId,
    ),
    env.BILLING_DB.prepare(`DELETE FROM organizations WHERE id IN (?, ?)`).bind(
      organizationId,
      otherOrganizationId,
    ),
    env.BILLING_DB.prepare(
      `INSERT INTO organizations (id, external_id, name, created_at, updated_at)
       VALUES (?, 'quotes-api', 'Quotes API', ?, ?)`,
    ).bind(organizationId, now, now),
    env.BILLING_DB.prepare(
      `INSERT INTO organizations (id, external_id, name, created_at, updated_at)
       VALUES (?, 'quotes-other', 'Quotes Other', ?, ?)`,
    ).bind(otherOrganizationId, now, now),
    env.BILLING_DB.prepare(
      `INSERT INTO api_keys
       (id, organization_id, key_prefix, key_hash, created_at, revoked_at)
       VALUES ('key-quotes-api', ?, 'quotes-a', ?, ?, NULL)`,
    ).bind(organizationId, await sha256Hex(apiKey), now),
    env.BILLING_DB.prepare(
      `INSERT INTO customers
       (id, organization_id, external_id, currency, metadata_json, created_at, updated_at)
       VALUES (?, ?, 'customer-quotes-external', 'USD', '{}', ?, ?)`,
    ).bind(customerId, organizationId, now, now),
    env.BILLING_DB.prepare(
      `INSERT INTO customers
       (id, organization_id, external_id, currency, metadata_json, created_at, updated_at)
       VALUES (?, ?, 'customer-quotes-other-external', 'USD', '{}', ?, ?)`,
    ).bind(otherCustomerId, otherOrganizationId, now, now),
    env.BILLING_DB.prepare(
      `INSERT INTO plans
       (id, organization_id, code, name, interval, amount_minor, currency, version, active,
        created_at, updated_at)
       VALUES ('plan-quotes-api', ?, 'quotes-api', 'Quotes API', 'monthly', 1000, 'USD', 1, 1, ?, ?)`,
    ).bind(organizationId, now, now),
    env.BILLING_DB.prepare(
      `INSERT INTO plans
       (id, organization_id, code, name, interval, amount_minor, currency, version, active,
        created_at, updated_at)
       VALUES ('plan-quotes-other', ?, 'quotes-other', 'Quotes Other', 'monthly', 1000, 'USD', 1, 1, ?, ?)`,
    ).bind(otherOrganizationId, now, now),
    env.BILLING_DB.prepare(
      `INSERT INTO subscriptions
       (id, organization_id, customer_id, plan_id, external_id, status, version,
        created_at, updated_at)
       VALUES (?, ?, ?, 'plan-quotes-api', 'subscription-quotes-external', 'active', 1, ?, ?)`,
    ).bind(subscriptionId, organizationId, customerId, now, now),
    env.BILLING_DB.prepare(
      `INSERT INTO subscriptions
       (id, organization_id, customer_id, plan_id, external_id, status, version,
        created_at, updated_at)
       VALUES (?, ?, ?, 'plan-quotes-other', 'subscription-quotes-other-external', 'active', 1, ?, ?)`,
    ).bind(otherSubscriptionId, otherOrganizationId, otherCustomerId, now, now),
    ...[
      ["membership-owner", ownerId, "active"],
      ["membership-second", secondOwnerId, "active"],
      ["membership-revoked", revokedOwnerId, "revoked"],
    ].map(([id, userId, status]) =>
      env.BILLING_DB.prepare(
        `INSERT INTO organization_memberships
         (id, organization_id, user_id, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ).bind(id, organizationId, userId, status, now, now),
    ),
  ]);
});

describe("quote REST replacement", () => {
  it("creates sequenced draft quotes and replays without leaking values to the outbox", async () => {
    const missingKey = await request("/api/v1/quotes", "POST", quoteBody());
    expect(missingKey.status).toBe(422);
    await expect(missingKey.json()).resolves.toMatchObject({ code: "idempotency_key_required" });

    const created = await createQuote("quote-create-one");
    expect(created.status).toBe(200);
    const body = await created.json<{
      quote: {
        lago_id: string;
        number: string;
        owner_ids: string[];
        current_version: { lago_id: string; share_token: string; lock_version: number };
      };
    }>();
    expect(body.quote).toMatchObject({
      number: "QT-2026-0001",
      order_type: "one_off",
      owner_ids: [ownerId],
      current_version: {
        status: "draft",
        version: 1,
        lock_version: 1,
        billing_items: [{ code: "setup", amount_cents: 5000 }],
        content: "Synthetic quote content",
      },
      versions: [{ status: "draft", version: 1 }],
      version: 1,
    });
    expect(body.quote.current_version.share_token).toMatch(/^[0-9a-f-]{36}$/);

    const replay = await createQuote("quote-create-one");
    await expect(replay.json()).resolves.toMatchObject({
      quote: { lago_id: body.quote.lago_id, number: "QT-2026-0001" },
    });
    const conflict = await createQuote("quote-create-one", {
      ...quoteBody().quote,
      content: "Different",
    });
    expect(conflict.status).toBe(409);
    await expect(conflict.json()).resolves.toMatchObject({ code: "idempotency_conflict" });

    const events = await env.BILLING_DB.prepare(
      `SELECT event_type, payload_json FROM outbox_events
       WHERE organization_id = ? ORDER BY event_type`,
    )
      .bind(organizationId)
      .all<{ event_type: string; payload_json: string }>();
    expect(events.results.map((event) => event.event_type)).toEqual([
      "quote.created",
      "quote_version.created",
    ]);
    const payloads = events.results.map((event) => event.payload_json).join("\n");
    expect(payloads).not.toContain("Synthetic quote content");
    expect(payloads).not.toContain("share_token");
    expect(payloads).not.toContain("amount_cents");
  });

  it("enforces amendment, customer, subscription, owner, and tenant scope", async () => {
    const amendment = await createQuote("amendment-missing", {
      ...quoteBody().quote,
      order_type: "subscription_amendment",
    });
    expect(amendment.status).toBe(422);
    await expect(amendment.json()).resolves.toMatchObject({ code: "subscription_required" });

    const otherCustomer = await createQuote("other-customer", {
      ...quoteBody().quote,
      customer_id: otherCustomerId,
    });
    expect(otherCustomer.status).toBe(404);
    await expect(otherCustomer.json()).resolves.toMatchObject({ code: "customer_not_found" });

    const otherSubscription = await createQuote("other-subscription", {
      ...quoteBody().quote,
      order_type: "subscription_amendment",
      subscription_id: otherSubscriptionId,
    });
    expect(otherSubscription.status).toBe(422);
    await expect(otherSubscription.json()).resolves.toMatchObject({
      code: "invalid_subscription_scope",
    });

    const revokedOwner = await createQuote("revoked-owner", {
      ...quoteBody().quote,
      owner_ids: [revokedOwnerId],
    });
    expect(revokedOwner.status).toBe(422);
    await expect(revokedOwner.json()).resolves.toMatchObject({ code: "invalid_quote_owner" });

    const invalidOwner = await createQuote("invalid-owner", {
      ...quoteBody().quote,
      owner_ids: ["not-a-uuid"],
    });
    expect(invalidOwner.status).toBe(422);
    await expect(invalidOwner.json()).resolves.toMatchObject({ code: "validation_error" });

    const valid = await createQuote("amendment-valid", {
      ...quoteBody().quote,
      order_type: "subscription_amendment",
      subscription_id: subscriptionId,
    });
    expect(valid.status).toBe(200);
    await expect(valid.json()).resolves.toMatchObject({
      quote: {
        lago_subscription_id: subscriptionId,
        external_subscription_id: "subscription-quotes-external",
      },
    });
  });

  it("lists with lifecycle filters and synchronizes active owners optimistically", async () => {
    const first = await quoteFrom(await createQuote("filters-one"));
    const createdDate = first.created_at.slice(0, 10);
    await createQuote("filters-two", {
      ...quoteBody().quote,
      order_type: "subscription_creation",
      owner_ids: [secondOwnerId],
    });

    const filtered = await request(
      `/api/v1/quotes?statuses[]=draft&order_types[]=one_off&owner_ids[]=${ownerId}&quote_number=0001&from_date=${createdDate}&to_date=${createdDate}`,
    );
    expect(filtered.status).toBe(200);
    await expect(filtered.json()).resolves.toMatchObject({
      quotes: [{ lago_id: first.lago_id }],
      meta: { total_count: 1, current_page: 1 },
    });
    const paged = await request("/api/v1/quotes?per_page=1&page=2");
    await expect(paged.json()).resolves.toMatchObject({
      quotes: [{ lago_id: first.lago_id }],
      meta: { total_count: 2, current_page: 2, prev_page: 1 },
    });
    const invalidFilter = await request("/api/v1/quotes?status=expired");
    expect(invalidFilter.status).toBe(422);

    const updated = await request(`/api/v1/quotes/${first.lago_id}`, "PUT", {
      quote: { version: 1, owner_ids: [secondOwnerId] },
    });
    expect(updated.status).toBe(200);
    await expect(updated.json()).resolves.toMatchObject({
      quote: { owner_ids: [secondOwnerId], version: 2 },
    });
    const stale = await request(`/api/v1/quotes/${first.lago_id}`, "PUT", {
      quote: { version: 1, owner_ids: [ownerId] },
    });
    expect(stale.status).toBe(409);
    await expect(stale.json()).resolves.toMatchObject({ code: "quote_version_conflict" });
    const noOp = await request(`/api/v1/quotes/${first.lago_id}`, "PUT", {
      quote: { version: 2, owner_ids: [secondOwnerId] },
    });
    await expect(noOp.json()).resolves.toMatchObject({ quote: { version: 2 } });
  });

  it("edits drafts, approves once, and locks approved content", async () => {
    const quote = await quoteFrom(await createQuote("approve-flow"));
    const versionId = quote.current_version.lago_id;
    const updated = await request(`/api/v1/quote_versions/${versionId}`, "PUT", {
      quote_version: {
        lock_version: 1,
        content: "Revised synthetic content",
        billing_items: [{ code: "setup", amount_cents: 6000 }],
      },
    });
    expect(updated.status).toBe(200);
    await expect(updated.json()).resolves.toMatchObject({
      quote_version: {
        content: "Revised synthetic content",
        billing_items: [{ amount_cents: 6000 }],
        lock_version: 2,
      },
    });
    const stale = await request(`/api/v1/quote_versions/${versionId}`, "PUT", {
      quote_version: { lock_version: 1, content: "Stale" },
    });
    expect(stale.status).toBe(409);

    const approved = await request(`/api/v1/quote_versions/${versionId}/approve`, "POST");
    expect(approved.status).toBe(200);
    await expect(approved.json()).resolves.toMatchObject({
      quote_version: { status: "approved", lock_version: 3 },
    });
    expect((await request(`/api/v1/quote_versions/${versionId}/approve`, "POST")).status).toBe(200);
    const locked = await request(`/api/v1/quote_versions/${versionId}`, "PUT", {
      quote_version: { lock_version: 3, content: "Forbidden" },
    });
    expect(locked.status).toBe(422);
    const voided = await request(`/api/v1/quote_versions/${versionId}/void`, "POST");
    expect(voided.status).toBe(422);
    const clone = await request(`/api/v1/quote_versions/${versionId}/clone`, "POST", undefined, {
      "Idempotency-Key": "approved-clone",
    });
    expect(clone.status).toBe(422);
    await expect(clone.json()).resolves.toMatchObject({ code: "approved_quote_not_cloneable" });
  });

  it("voids and clones drafts with one active version and replay safety", async () => {
    const quote = await quoteFrom(await createQuote("clone-flow"));
    const firstVersionId = quote.current_version.lago_id;
    const cloned = await request(
      `/api/v1/quote_versions/${firstVersionId}/clone`,
      "POST",
      undefined,
      { "Idempotency-Key": "clone-draft-once" },
    );
    expect(cloned.status).toBe(200);
    const cloneBody = await cloned.json<{
      quote_version: { lago_id: string; version: number; status: string; share_token: string };
    }>();
    expect(cloneBody.quote_version).toMatchObject({ version: 2, status: "draft" });
    expect(cloneBody.quote_version.share_token).toMatch(/^[0-9a-f-]{36}$/);
    await expect(
      request(`/api/v1/quote_versions/${firstVersionId}/clone`, "POST", undefined, {
        "Idempotency-Key": "clone-draft-once",
      }).then((response) => response.json()),
    ).resolves.toMatchObject({
      quote_version: { lago_id: cloneBody.quote_version.lago_id, version: 2 },
    });
    await expect(
      env.BILLING_DB.prepare(
        `SELECT status, void_reason, share_token FROM quote_versions WHERE id = ?`,
      )
        .bind(firstVersionId)
        .first(),
    ).resolves.toEqual({ status: "voided", void_reason: "superseded", share_token: null });

    const unrelated = await request(
      `/api/v1/quote_versions/${firstVersionId}/clone`,
      "POST",
      undefined,
      { "Idempotency-Key": "clone-voided-with-active" },
    );
    expect(unrelated.status).toBe(422);
    await expect(unrelated.json()).resolves.toMatchObject({ code: "active_quote_version_exists" });

    const manualVoid = await request(
      `/api/v1/quote_versions/${cloneBody.quote_version.lago_id}/void`,
      "POST",
    );
    expect(manualVoid.status).toBe(200);
    await expect(manualVoid.json()).resolves.toMatchObject({
      quote_version: { status: "voided", void_reason: "manual", share_token: null },
    });
    expect(
      (await request(`/api/v1/quote_versions/${cloneBody.quote_version.lago_id}/void`, "POST"))
        .status,
    ).toBe(200);

    const third = await request(
      `/api/v1/quote_versions/${cloneBody.quote_version.lago_id}/clone`,
      "POST",
      undefined,
      { "Idempotency-Key": "clone-voided" },
    );
    await expect(third.json()).resolves.toMatchObject({
      quote_version: { version: 3, status: "draft" },
    });
    await expect(
      env.BILLING_DB.prepare(
        `SELECT COUNT(*) AS total FROM quote_versions
         WHERE quote_id = ? AND status IN ('draft', 'approved')`,
      )
        .bind(quote.lago_id)
        .first(),
    ).resolves.toEqual({ total: 1 });
  });

  it("rolls back cross-tenant owners and stale outbox aggregate versions", async () => {
    const quote = await quoteFrom(await createQuote("trigger-guards"));
    await expect(
      env.BILLING_DB.prepare(
        `INSERT INTO quote_owners
         (organization_id, quote_id, user_id, created_at, updated_at)
         VALUES (?, ?, ?, '2026-08-15T01:00:00.000Z', '2026-08-15T01:00:00.000Z')`,
      )
        .bind(otherOrganizationId, quote.lago_id, ownerId)
        .run(),
    ).rejects.toThrow();
    await expect(
      env.BILLING_DB.prepare(
        `INSERT INTO outbox_events
         (event_id, organization_id, event_type, event_version, aggregate_type, aggregate_id,
          aggregate_version, correlation_id, payload_json, occurred_at, published_at)
         VALUES ('stale-quote-event', ?, 'quote.updated', 1, 'quote', ?, 99, 'stale', '{}',
                 '2026-08-15T01:00:00.000Z', NULL)`,
      )
        .bind(organizationId, quote.lago_id)
        .run(),
    ).rejects.toThrow();
    await expect(
      env.BILLING_DB.prepare(
        "SELECT COUNT(*) AS total FROM outbox_events WHERE event_id = 'stale-quote-event'",
      ).first(),
    ).resolves.toEqual({ total: 0 });
  });
});

function quoteBody() {
  return {
    quote: {
      customer_id: customerId,
      order_type: "one_off",
      owner_ids: [ownerId],
      billing_items: [{ code: "setup", amount_cents: 5000 }],
      content: "Synthetic quote content",
    },
  };
}

function createQuote(
  idempotencyKey: string,
  quote: Record<string, unknown> = quoteBody().quote,
): Promise<Response> {
  return request("/api/v1/quotes", "POST", { quote }, { "Idempotency-Key": idempotencyKey });
}

async function quoteFrom(response: Response): Promise<{
  lago_id: string;
  created_at: string;
  current_version: { lago_id: string; lock_version: number };
}> {
  expect(response.status).toBe(200);
  const body = await response.json<{
    quote: {
      lago_id: string;
      created_at: string;
      current_version: { lago_id: string; lock_version: number };
    };
  }>();
  return body.quote;
}

function request(
  path: string,
  method = "GET",
  body?: unknown,
  extraHeaders?: Record<string, string>,
): Promise<Response> {
  return SELF.fetch(`https://lago.test${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      ...(body ? { "Content-Type": "application/json" } : {}),
      ...extraHeaders,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
}
