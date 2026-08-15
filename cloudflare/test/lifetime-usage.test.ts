import {
  createExecutionContext,
  createMessageBatch,
  env,
  getQueueResult,
  SELF,
} from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import worker from "../src/index";
import { sha256Hex } from "../src/auth/api-key";
import { refreshLifetimeUsage } from "../src/usage/lifetime-usage";

const apiKey = "lifetime-usage-test-key";
const headers = { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" };

beforeAll(async () => {
  const now = "2026-08-15T00:00:00.000Z";
  await env.BILLING_DB.batch([
    env.BILLING_DB.prepare(
      `INSERT OR IGNORE INTO organizations (id, external_id, name, created_at, updated_at)
       VALUES ('org-lifetime', 'lifetime-test', 'Lifetime Test', ?, ?)`,
    ).bind(now, now),
    env.BILLING_DB.prepare(
      `INSERT OR IGNORE INTO api_keys
       (id, organization_id, key_prefix, key_hash, created_at, revoked_at)
       VALUES ('key-lifetime', 'org-lifetime', 'lifetime-', ?, ?, NULL)`,
    ).bind(await sha256Hex(apiKey), now),
    env.BILLING_DB.prepare(
      `INSERT OR IGNORE INTO customers
       (id, organization_id, external_id, email, name, currency, metadata_json, created_at,
        updated_at)
       VALUES ('customer-lifetime', 'org-lifetime', 'lifetime-customer',
               'lifetime@example.test', 'Lifetime Customer', 'USD', '{}', ?, ?)`,
    ).bind(now, now),
  ]);
});

describe("Cloudflare lifetime usage projection", () => {
  it("coalesces event activity, refreshes it from Queue, and exposes Lago-compatible GET/PUT", async () => {
    await createPlanAndSubscription("activity");
    const metricResponse = await api("/api/v1/billable_metrics", "POST", {
      billable_metric: {
        name: "Lifetime units",
        code: "lifetime_units_activity",
        aggregation_type: "sum_agg",
        field_name: "units",
      },
    });
    expect(metricResponse.status, await metricResponse.clone().text()).toBe(200);
    const metricId = (await metricResponse.json<{ billable_metric: { lago_id: string } }>())
      .billable_metric.lago_id;
    const chargeResponse = await api("/api/v1/plans/lifetime-plan-activity/charges", "POST", {
      charge: {
        billable_metric_id: metricId,
        code: "lifetime-charge-activity",
        charge_model: "standard",
        properties: { amount: "10" },
      },
    });
    expect(chargeResponse.status, await chargeResponse.clone().text()).toBe(200);

    const firstEventId = await createEvent("activity-one", "1");
    await createEvent("activity-two", "2");
    await expect(
      env.BILLING_DB.prepare(
        `SELECT version, latest_event_on FROM usage_subscription_activities
         WHERE organization_id = 'org-lifetime'
           AND external_subscription_id = 'lifetime-subscription-activity'`,
      ).first(),
    ).resolves.toEqual({ version: 2, latest_event_on: "2026-08-15" });
    await expect(
      env.BILLING_DB.prepare(
        `SELECT last_received_event_on FROM subscriptions
         WHERE id = 'subscription-lifetime-activity'`,
      ).first(),
    ).resolves.toEqual({ last_received_event_on: "2026-08-15" });

    await dispatchUsageEvent(firstEventId);
    await expect(
      env.BILLING_DB.prepare(
        `SELECT COUNT(*) AS total FROM usage_subscription_activities
         WHERE organization_id = 'org-lifetime'
           AND external_subscription_id = 'lifetime-subscription-activity'`,
      ).first(),
    ).resolves.toEqual({ total: 0 });

    const shown = await api("/api/v1/subscriptions/lifetime-subscription-activity/lifetime_usage");
    expect(shown.status, await shown.clone().text()).toBe(200);
    await expect(shown.json()).resolves.toMatchObject({
      lifetime_usage: {
        lago_subscription_id: "subscription-lifetime-activity",
        external_subscription_id: "lifetime-subscription-activity",
        external_historical_usage_amount_cents: 0,
        invoiced_usage_amount_cents: 0,
        current_usage_amount_cents: 30,
        from_datetime: "2026-08-01T00:00:00.000Z",
      },
    });

    const updated = await api(
      "/api/v1/subscriptions/lifetime-subscription-activity/lifetime_usage",
      "PUT",
      { lifetime_usage: { external_historical_usage_amount_cents: 20 } },
    );
    expect(updated.status, await updated.clone().text()).toBe(200);
    await expect(updated.json()).resolves.toMatchObject({
      lifetime_usage: {
        external_historical_usage_amount_cents: 20,
        current_usage_amount_cents: 30,
      },
    });
  });

  it("follows subscription generations and sums draft/finalized usage invoice lines", async () => {
    const now = "2026-08-15T01:00:00.000Z";
    await env.BILLING_DB.batch([
      planStatement("lineage-old", now),
      planStatement("lineage-new", now),
      env.BILLING_DB.prepare(
        `INSERT INTO subscriptions
         (id, organization_id, customer_id, plan_id, external_id, status, subscription_at,
          started_at, current_period_start, current_period_end, terminated_at, generation,
          version, created_at, updated_at)
         VALUES ('subscription-lineage-old', 'org-lifetime', 'customer-lifetime',
                 'plan-lifetime-lineage-old', 'lifetime-subscription-lineage', 'terminated',
                 '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z',
                 '2026-07-01T00:00:00.000Z', '2026-08-01T00:00:00.000Z',
                 '2026-08-01T00:00:00.000Z', 1, 1, ?, ?)`,
      ).bind(now, now),
      env.BILLING_DB.prepare(
        `INSERT INTO subscriptions
         (id, organization_id, customer_id, plan_id, external_id, status, subscription_at,
          started_at, current_period_start, current_period_end, previous_subscription_id,
          transition_kind, transition_at, generation, version, created_at, updated_at)
         VALUES ('subscription-lineage-current', 'org-lifetime', 'customer-lifetime',
                 'plan-lifetime-lineage-new', 'lifetime-subscription-lineage', 'active',
                 '2026-01-01T00:00:00.000Z', '2026-08-01T00:00:00.000Z',
                 '2026-08-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z',
                 'subscription-lineage-old', 'upgrade', '2026-08-01T00:00:00.000Z',
                 2, 1, ?, ?)`,
      ).bind(now, now),
      invoiceStatement("lineage-draft", "draft", 125, now),
      invoiceStatement("lineage-finalized", "finalized", 75, now),
      invoiceStatement("lineage-voided", "voided", 999, now),
      invoiceSubscriptionStatement("lineage-draft", now),
      invoiceSubscriptionStatement("lineage-finalized", now),
      invoiceSubscriptionStatement("lineage-voided", now),
      invoiceLineStatement("lineage-draft", 125, now),
      invoiceLineStatement("lineage-finalized", 75, now),
      invoiceLineStatement("lineage-voided", 999, now),
    ]);

    const projection = await refreshLifetimeUsage(
      env.BILLING_DB,
      "org-lifetime",
      "lifetime-subscription-lineage",
      now,
    );
    expect(projection).toMatchObject({
      subscription_id: "subscription-lineage-current",
      invoiced_usage_amount_minor: 200,
      current_usage_amount_minor: 0,
    });
    const shown = await api("/api/v1/subscriptions/lifetime-subscription-lineage/lifetime_usage");
    expect(shown.status, await shown.clone().text()).toBe(200);
    await expect(shown.json()).resolves.toMatchObject({
      lifetime_usage: {
        lago_subscription_id: "subscription-lineage-current",
        invoiced_usage_amount_cents: 200,
        from_datetime: "2026-01-01T00:00:00.000Z",
      },
    });

    const invalid = await api(
      "/api/v1/subscriptions/lifetime-subscription-lineage/lifetime_usage",
      "PUT",
      { lifetime_usage: { external_historical_usage_amount_cents: -1 } },
    );
    expect(invalid.status).toBe(422);
  });

  it("does not clear newer activity with an older projection version", async () => {
    await createPlanAndSubscription("guard");
    const now = "2026-08-15T02:00:00.000Z";
    await env.BILLING_DB.prepare(
      `INSERT INTO usage_subscription_activities
       (organization_id, external_subscription_id, subscription_id, latest_event_at,
        latest_event_on, version, attempts, inserted_at, updated_at)
       VALUES ('org-lifetime', 'lifetime-subscription-guard',
               'subscription-lifetime-guard', ?, '2026-08-15', 2, 0, ?, ?)`,
    )
      .bind(now, now, now)
      .run();
    await refreshLifetimeUsage(
      env.BILLING_DB,
      "org-lifetime",
      "lifetime-subscription-guard",
      now,
      1,
    );
    await expect(
      env.BILLING_DB.prepare(
        `SELECT version FROM usage_subscription_activities
         WHERE organization_id = 'org-lifetime'
           AND external_subscription_id = 'lifetime-subscription-guard'`,
      ).first(),
    ).resolves.toEqual({ version: 2 });
  });
});

async function createPlanAndSubscription(suffix: string): Promise<void> {
  const now = "2026-08-15T00:00:00.000Z";
  await env.BILLING_DB.batch([
    planStatement(suffix, now),
    env.BILLING_DB.prepare(
      `INSERT INTO subscriptions
       (id, organization_id, customer_id, plan_id, external_id, status, subscription_at,
        started_at, current_period_start, current_period_end, generation, version,
        created_at, updated_at)
       VALUES (?, 'org-lifetime', 'customer-lifetime', ?, ?, 'active',
               '2026-08-01T00:00:00.000Z', '2026-08-01T00:00:00.000Z',
               '2026-08-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z', 1, 1, ?, ?)`,
    ).bind(
      `subscription-lifetime-${suffix}`,
      `plan-lifetime-${suffix}`,
      `lifetime-subscription-${suffix}`,
      now,
      now,
    ),
  ]);
}

function planStatement(suffix: string, now: string): D1PreparedStatement {
  return env.BILLING_DB.prepare(
    `INSERT INTO plans
     (id, organization_id, code, name, interval, amount_minor, currency, version, active,
      created_at, updated_at)
     VALUES (?, 'org-lifetime', ?, ?, 'monthly', 0, 'USD', 1, 1, ?, ?)`,
  ).bind(`plan-lifetime-${suffix}`, `lifetime-plan-${suffix}`, `Lifetime Plan ${suffix}`, now, now);
}

function invoiceStatement(
  suffix: string,
  status: "draft" | "finalized" | "voided",
  amount: number,
  now: string,
): D1PreparedStatement {
  return env.BILLING_DB.prepare(
    `INSERT INTO invoices
     (id, organization_id, customer_id, subscription_id, number, status, payment_status,
      currency, subtotal_minor, tax_minor, credits_minor, total_due_minor, version,
      finalized_at, voided_at, created_at, updated_at)
     VALUES (?, 'org-lifetime', 'customer-lifetime', 'subscription-lineage-old', ?, ?,
             'pending', 'USD', ?, 0, 0, ?, 1, ?, ?, ?, ?)`,
  ).bind(
    `invoice-${suffix}`,
    status === "draft" ? null : `INV-${suffix.toUpperCase()}`,
    status,
    amount,
    amount,
    status === "finalized" ? now : null,
    status === "voided" ? now : null,
    now,
    now,
  );
}

function invoiceSubscriptionStatement(suffix: string, now: string): D1PreparedStatement {
  return env.BILLING_DB.prepare(
    `INSERT INTO invoice_subscriptions
     (invoice_id, subscription_id, organization_id, invoicing_reason, period_start,
      period_end, created_at)
     VALUES (?, 'subscription-lineage-old', 'org-lifetime', 'subscription_periodic',
             '2026-07-01T00:00:00.000Z', '2026-08-01T00:00:00.000Z', ?)`,
  ).bind(`invoice-${suffix}`, now);
}

function invoiceLineStatement(suffix: string, amount: number, now: string): D1PreparedStatement {
  return env.BILLING_DB.prepare(
    `INSERT INTO invoice_lines
     (id, invoice_id, line_type, description, quantity_decimal, unit_amount_decimal,
      amount_minor, source_type, source_id, metadata_json, created_at)
     VALUES (?, ?, 'usage', 'Historical usage', '1', ?, ?, 'charge', ?, '{}', ?)`,
  ).bind(`line-${suffix}`, `invoice-${suffix}`, String(amount), amount, `charge-${suffix}`, now);
}

async function createEvent(transactionId: string, units: string): Promise<string> {
  const response = await api("/api/v1/events", "POST", {
    event: {
      transaction_id: transactionId,
      code: "lifetime_units_activity",
      external_subscription_id: "lifetime-subscription-activity",
      timestamp: 1_786_752_000,
      properties: { units },
    },
  });
  expect(response.status, await response.clone().text()).toBe(200);
  return (await response.json<{ event: { lago_id: string } }>()).event.lago_id;
}

async function dispatchUsageEvent(eventId: string): Promise<void> {
  const row = await env.BILLING_DB.prepare(
    `SELECT event_id, event_type, event_version, aggregate_type, aggregate_id,
            aggregate_version, occurred_at, causation_id, correlation_id, payload_json
     FROM outbox_events WHERE event_id = ? LIMIT 1`,
  )
    .bind(`usage-event-ingested:${eventId}`)
    .first<{
      event_id: string;
      event_type: string;
      event_version: number;
      aggregate_type: string;
      aggregate_id: string;
      aggregate_version: number;
      occurred_at: string;
      causation_id: string | null;
      correlation_id: string;
      payload_json: string;
    }>();
  expect(row).not.toBeNull();
  const batch = createMessageBatch("serp-dev-lago-domain-events", [
    {
      id: `message-${eventId}`,
      timestamp: new Date(),
      attempts: 1,
      body: {
        id: row!.event_id,
        type: row!.event_type,
        version: row!.event_version,
        aggregateType: row!.aggregate_type,
        aggregateId: row!.aggregate_id,
        aggregateVersion: row!.aggregate_version,
        occurredAt: row!.occurred_at,
        causationId: row!.causation_id,
        correlationId: row!.correlation_id,
        payload: JSON.parse(row!.payload_json) as Record<string, unknown>,
      },
    },
  ]);
  const context = createExecutionContext();
  await worker.queue(batch, env);
  const result = await getQueueResult(batch, context);
  expect(result.explicitAcks).toContain(`message-${eventId}`);
  expect(result.retryMessages).toHaveLength(0);
}

function api(path: string, method = "GET", body?: Record<string, unknown>): Promise<Response> {
  return SELF.fetch(`https://lago.test${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
}
