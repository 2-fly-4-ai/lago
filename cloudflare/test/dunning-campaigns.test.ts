import { env, SELF } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { sha256Hex } from "../src/auth/api-key";
import { processDunningCampaigns } from "../src/schedules/dunning";

const apiKey = "dunning-campaign-api-key";
const headers = { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" };
const organizationId = "org-dunning";
const customerId = "customer-dunning";

beforeEach(async () => {
  const now = "2026-08-15T00:00:00.000Z";
  await env.BILLING_DB.batch([
    env.BILLING_DB.prepare(
      `INSERT OR IGNORE INTO organizations (id, external_id, name, created_at, updated_at)
       VALUES (?, 'dunning', 'Dunning', ?, ?)`,
    ).bind(organizationId, now, now),
    env.BILLING_DB.prepare(
      `INSERT OR IGNORE INTO organizations (id, external_id, name, created_at, updated_at)
       VALUES ('org-dunning-other', 'dunning-other', 'Dunning Other', ?, ?)`,
    ).bind(now, now),
    env.BILLING_DB.prepare(
      `INSERT OR IGNORE INTO api_keys
       (id, organization_id, key_prefix, key_hash, created_at, revoked_at)
       VALUES ('key-dunning', ?, 'dunning', ?, ?, NULL)`,
    ).bind(organizationId, await sha256Hex(apiKey), now),
    env.BILLING_DB.prepare(
      `INSERT OR IGNORE INTO customers
       (id, organization_id, external_id, email, name, currency, metadata_json, version,
        created_at, updated_at)
       VALUES (?, ?, 'customer-dunning', 'billing@example.com', 'Dunning Customer', 'USD',
               '[]', 1, ?, ?)`,
    ).bind(customerId, organizationId, now, now),
    env.BILLING_DB.prepare(
      `INSERT OR IGNORE INTO invoices
       (id, organization_id, customer_id, number, status, payment_status, currency,
        subtotal_minor, tax_minor, credits_minor, total_due_minor, version, finalized_at,
        payment_overdue, created_at, updated_at)
       VALUES ('invoice-dunning', ?, ?, 'INV-DUNNING', 'finalized', 'pending', 'USD',
               1000, 0, 0, 1000, 1, ?, 1, ?, ?)`,
    ).bind(organizationId, customerId, now, now, now),
  ]);
  await env.BILLING_DB.batch([
    env.BILLING_DB.prepare(
      `DELETE FROM outbox_events WHERE organization_id = ?
       AND (aggregate_type = 'dunning_campaign' OR event_type = 'payment_request.created'
            OR event_type = 'dunning_campaign.finished' OR aggregate_id = ?)`,
    ).bind(organizationId, customerId),
    env.BILLING_DB.prepare(`DELETE FROM invoices_payment_requests WHERE organization_id = ?`).bind(
      organizationId,
    ),
    env.BILLING_DB.prepare(`DELETE FROM payment_requests WHERE organization_id = ?`).bind(
      organizationId,
    ),
    env.BILLING_DB.prepare(`DELETE FROM payment_attempts WHERE organization_id = ?`).bind(
      organizationId,
    ),
    env.BILLING_DB.prepare(`DELETE FROM dunning_attempt_guards WHERE organization_id = ?`).bind(
      organizationId,
    ),
    env.BILLING_DB.prepare(
      `UPDATE organizations SET applied_dunning_campaign_id = NULL WHERE id = ?`,
    ).bind(organizationId),
    env.BILLING_DB.prepare(
      `UPDATE customers
       SET applied_dunning_campaign_id = NULL, exclude_from_dunning_campaign = 0,
           last_dunning_campaign_attempt = 0, last_dunning_campaign_attempt_at = NULL,
           version = 1, currency = 'USD'
       WHERE id = ?`,
    ).bind(customerId),
    env.BILLING_DB.prepare(
      `UPDATE invoices SET payment_status = 'pending', payment_overdue = 1, currency = 'USD',
                           total_due_minor = 1000, version = 1
       WHERE id = 'invoice-dunning'`,
    ),
  ]);
  await env.BILLING_DB.prepare(`DELETE FROM dunning_campaign_thresholds WHERE organization_id = ?`)
    .bind(organizationId)
    .run();
  await env.BILLING_DB.prepare(`DELETE FROM dunning_campaigns WHERE organization_id = ?`)
    .bind(organizationId)
    .run();
});

describe("dunning campaigns", () => {
  it("creates, replays, lists, updates, assigns, and deletes a tenant campaign", async () => {
    const created = await createCampaign({ applied_to_organization: true });
    expect(created.status).toBe(200);
    const createdBody = await created.json<{
      dunning_campaign: { lago_id: string; code: string; customers_count: number };
    }>();
    expect(createdBody.dunning_campaign).toMatchObject({
      code: "standard",
      customers_count: 1,
    });

    const replay = await createCampaign({ applied_to_organization: true });
    await expect(replay.json()).resolves.toMatchObject({
      dunning_campaign: { lago_id: createdBody.dunning_campaign.lago_id },
    });
    const conflict = await createCampaign({
      applied_to_organization: true,
      days_between_attempts: 2,
    });
    expect(conflict.status).toBe(409);

    const assigned = await api("/api/v1/customers/customer-dunning", "PUT", {
      customer: { applied_dunning_campaign_id: createdBody.dunning_campaign.lago_id },
    });
    await expect(assigned.json()).resolves.toMatchObject({
      customer: {
        applied_dunning_campaign_id: createdBody.dunning_campaign.lago_id,
        exclude_from_dunning_campaign: false,
        last_dunning_campaign_attempt: 0,
      },
    });

    const updated = await api("/api/v1/dunning_campaigns/standard", "PUT", {
      dunning_campaign: { name: "Standard Updated", max_attempts: 3 },
    });
    await expect(updated.json()).resolves.toMatchObject({
      dunning_campaign: { name: "Standard Updated", max_attempts: 3 },
    });
    const listed = await api("/api/v1/dunning_campaigns?search_term=standard", "GET");
    await expect(listed.json()).resolves.toMatchObject({
      dunning_campaigns: [{ code: "standard" }],
      meta: { total_count: 1 },
    });

    const deleted = await api("/api/v1/dunning_campaigns/standard", "DELETE");
    expect(deleted.status).toBe(200);
    await expect(
      env.BILLING_DB.prepare(
        `SELECT applied_dunning_campaign_id, last_dunning_campaign_attempt
         FROM customers WHERE id = ?`,
      )
        .bind(customerId)
        .first(),
    ).resolves.toEqual({ applied_dunning_campaign_id: null, last_dunning_campaign_attempt: 0 });
  });

  it("creates one guarded request per due attempt without invoking a payment provider", async () => {
    expect((await createCampaign({ applied_to_organization: true })).status).toBe(200);

    await expect(
      processDunningCampaigns(env, "2026-08-15T01:45:00.000Z", "dunning-run-1"),
    ).resolves.toEqual({ candidates: 1, requestsCreated: 1, campaignsFinished: 0 });
    await expect(
      processDunningCampaigns(env, "2026-08-15T01:45:00.000Z", "dunning-run-replay"),
    ).resolves.toEqual({ candidates: 0, requestsCreated: 0, campaignsFinished: 0 });
    await expect(
      processDunningCampaigns(env, "2026-08-16T01:45:00.000Z", "dunning-run-2"),
    ).resolves.toEqual({ candidates: 1, requestsCreated: 1, campaignsFinished: 1 });
    await expect(
      processDunningCampaigns(env, "2026-08-17T01:45:00.000Z", "dunning-run-max"),
    ).resolves.toEqual({ candidates: 0, requestsCreated: 0, campaignsFinished: 0 });

    await expect(
      env.BILLING_DB.prepare(
        `SELECT
           (SELECT COUNT(*) FROM payment_requests WHERE organization_id = ?) AS requests,
           (SELECT COUNT(*) FROM payment_requests
              WHERE organization_id = ? AND source = 'dunning') AS dunning_requests,
           (SELECT COUNT(*) FROM invoices_payment_requests WHERE organization_id = ?) AS links,
           (SELECT COUNT(*) FROM payment_attempts WHERE organization_id = ?) AS provider_attempts,
           (SELECT COUNT(*) FROM outbox_events
              WHERE organization_id = ? AND event_type = 'dunning_campaign.finished') AS finished`,
      )
        .bind(organizationId, organizationId, organizationId, organizationId, organizationId)
        .first(),
    ).resolves.toEqual({
      requests: 2,
      dunning_requests: 2,
      links: 2,
      provider_attempts: 0,
      finished: 1,
    });
  });

  it("honors exclusions and rejects cross-tenant campaign assignments", async () => {
    const created = await createCampaign({ applied_to_organization: true });
    const body = await created.json<{ dunning_campaign: { lago_id: string } }>();
    const excluded = await api("/api/v1/customers/customer-dunning", "PUT", {
      customer: { exclude_from_dunning_campaign: true },
    });
    await expect(excluded.json()).resolves.toMatchObject({
      customer: { applied_dunning_campaign_id: null, exclude_from_dunning_campaign: true },
    });
    await expect(
      processDunningCampaigns(env, "2026-08-15T01:45:00.000Z", "dunning-excluded"),
    ).resolves.toEqual({ candidates: 0, requestsCreated: 0, campaignsFinished: 0 });

    const invalid = await api("/api/v1/customers/customer-dunning", "PUT", {
      customer: { applied_dunning_campaign_id: "campaign-from-another-tenant" },
    });
    expect(invalid.status).toBe(422);
    await expect(invalid.json()).resolves.toMatchObject({ code: "invalid_dunning_campaign" });
    expect(body.dunning_campaign.lago_id).toBeTruthy();
  });

  it("uses the outstanding balance and rolls back a stale guarded attempt", async () => {
    const created = await createCampaign({ applied_to_organization: true });
    const campaign = await created.json<{ dunning_campaign: { lago_id: string } }>();
    const now = "2026-08-15T01:00:00.000Z";
    await env.BILLING_DB.prepare(
      `INSERT INTO payment_attempts
       (id, organization_id, invoice_id, provider, provider_account_code,
        provider_transaction_id, idempotency_key, amount_minor, currency, status,
        created_at, updated_at)
       VALUES ('payment-dunning-partial', ?, 'invoice-dunning', 'authorize_net', 'default',
               'dunning-partial', 'dunning-partial', 600, 'USD', 'succeeded', ?, ?)`,
    )
      .bind(organizationId, now, now)
      .run();
    await expect(
      processDunningCampaigns(env, "2026-08-15T01:45:00.000Z", "dunning-partial"),
    ).resolves.toEqual({ candidates: 0, requestsCreated: 0, campaignsFinished: 0 });

    const threshold = await env.BILLING_DB.prepare(
      `SELECT id FROM dunning_campaign_thresholds WHERE dunning_campaign_id = ?`,
    )
      .bind(campaign.dunning_campaign.lago_id)
      .first<{ id: string }>();
    expect(threshold).not.toBeNull();
    await expect(
      env.BILLING_DB.batch([
        env.BILLING_DB.prepare(
          `INSERT INTO dunning_attempt_guards
           (run_id, organization_id, customer_id, dunning_campaign_id,
            dunning_campaign_threshold_id, expected_customer_version, expected_attempt,
            expected_last_attempt_at, created_at)
           VALUES ('stale-dunning-attempt', ?, ?, ?, ?, 999, 0, NULL, ?)`,
        ).bind(organizationId, customerId, campaign.dunning_campaign.lago_id, threshold!.id, now),
        env.BILLING_DB.prepare(
          `INSERT INTO payment_requests
           (id, organization_id, customer_id, amount_minor, currency, payment_status,
            ready_for_payment_processing, version, created_at, updated_at, source,
            dunning_campaign_id, dunning_campaign_threshold_id, dunning_attempt)
           VALUES ('stale-dunning-request', ?, ?, 400, 'USD', 'pending', 1, 1, ?, ?,
                   'dunning', ?, ?, 1)`,
        ).bind(
          organizationId,
          customerId,
          now,
          now,
          campaign.dunning_campaign.lago_id,
          threshold!.id,
        ),
      ]),
    ).rejects.toThrow();
    await expect(
      env.BILLING_DB.prepare(
        `SELECT
           (SELECT COUNT(*) FROM dunning_attempt_guards
              WHERE run_id = 'stale-dunning-attempt') AS guards,
           (SELECT COUNT(*) FROM payment_requests
              WHERE id = 'stale-dunning-request') AS requests`,
      ).first(),
    ).resolves.toEqual({ guards: 0, requests: 0 });
  });
});

function createCampaign(overrides: Record<string, unknown> = {}) {
  return api("/api/v1/dunning_campaigns", "POST", {
    dunning_campaign: {
      code: "standard",
      name: "Standard",
      days_between_attempts: 1,
      max_attempts: 2,
      thresholds: [{ amount_cents: 500, currency: "USD" }],
      ...overrides,
    },
  });
}

function api(path: string, method: string, body?: Record<string, unknown>) {
  return SELF.fetch(`https://lago.test${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
}
