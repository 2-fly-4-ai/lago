import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import { handleOperatorAiRequest, type OperatorAiEnv } from "../src/operator/ai";
import { handleOperatorAnalyticsRequest } from "../src/operator/analytics";
import type { OperatorContext } from "../src/operator/access";
import { handleOperatorFeaturesRequest } from "../src/operator/features";
import { handleOperatorProductParityRequest } from "../src/operator/product-parity";

function jsonRequest(url: string, method: string, body: unknown): Request {
  return new Request(url, {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function createOrganization(prefix: string): Promise<{ id: string; externalId: string }> {
  const suffix = crypto.randomUUID();
  const id = `${prefix}-${suffix}`;
  const externalId = `${prefix}-external-${suffix}`;
  const now = new Date().toISOString();
  await env.BILLING_DB.prepare(
    `INSERT INTO organizations (id, external_id, name, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?)`,
  )
    .bind(id, externalId, `${prefix} organization`, now, now)
    .run();
  return { id, externalId };
}

describe("operator feature catalog", () => {
  it("implements nested privilege CRUD and refuses cross-tenant reads", async () => {
    const primary = await createOrganization("feature-primary");
    const secondary = await createOrganization("feature-secondary");
    const created = await handleOperatorFeaturesRequest(
      jsonRequest("https://operator.test/api/operator/v1/features", "POST", {
        feature: {
          name: "Exports",
          code: "exports",
          description: "Controls export access",
          privileges: [
            { name: "Enabled", code: "enabled", value_type: "boolean" },
            {
              name: "Format",
              code: "format",
              value_type: "select",
              config: { select_options: ["csv", "json"] },
            },
          ],
        },
      }),
      env.BILLING_DB,
      primary.id,
      "request-feature-create",
    );
    expect(created?.status).toBe(201);
    const createdBody = (await created?.json()) as {
      feature: { lago_id: string; privileges: Array<{ lago_id: string; code: string }> };
    };
    expect(createdBody.feature.privileges.map((privilege) => privilege.code).sort()).toEqual([
      "enabled",
      "format",
    ]);

    await expect(
      handleOperatorFeaturesRequest(
        new Request(
          `https://operator.test/api/operator/v1/features/${createdBody.feature.lago_id}`,
        ),
        env.BILLING_DB,
        secondary.id,
        "request-feature-cross-tenant",
      ),
    ).rejects.toMatchObject({ code: "feature_not_found" });

    const enabled = createdBody.feature.privileges.find(
      (privilege) => privilege.code === "enabled",
    );
    const updated = await handleOperatorFeaturesRequest(
      jsonRequest(
        `https://operator.test/api/operator/v1/features/${createdBody.feature.lago_id}`,
        "PUT",
        {
          feature: {
            name: "Data exports",
            code: "exports",
            privileges: [
              {
                id: enabled?.lago_id,
                name: "Export enabled",
                code: "enabled",
                value_type: "boolean",
              },
            ],
          },
        },
      ),
      env.BILLING_DB,
      primary.id,
      "request-feature-update",
    );
    const updatedBody = (await updated?.json()) as {
      feature: { name: string; privileges: Array<{ code: string }> };
    };
    expect(updatedBody.feature).toMatchObject({ name: "Data exports" });
    expect(updatedBody.feature.privileges).toEqual([expect.objectContaining({ code: "enabled" })]);

    const activity = await handleOperatorProductParityRequest(
      new Request(
        `https://operator.test/api/operator/v1/features/${createdBody.feature.lago_id}/activity`,
      ),
      env.BILLING_DB,
      primary.id,
      "request-feature-activity",
    );
    const activityBody = (await activity?.json()) as {
      activity_logs: Array<{ event_type: string }>;
    };
    expect(activityBody.activity_logs.map((entry) => entry.event_type)).toEqual([
      "feature.updated",
      "feature.created",
    ]);
  });

  it("replaces typed plan entitlements without crossing organization boundaries", async () => {
    const primary = await createOrganization("entitlement-primary");
    const secondary = await createOrganization("entitlement-secondary");
    const now = new Date().toISOString();
    const planId = crypto.randomUUID();
    await env.BILLING_DB.prepare(
      `INSERT INTO plans
       (id, organization_id, code, name, interval, amount_minor, currency, version, active,
        created_at, updated_at)
       VALUES (?, ?, 'pro', 'Pro', 'monthly', 5000, 'USD', 1, 1, ?, ?)`,
    )
      .bind(planId, primary.id, now, now)
      .run();
    const created = await handleOperatorFeaturesRequest(
      jsonRequest("https://operator.test/api/operator/v1/features", "POST", {
        feature: {
          name: "Exports",
          code: "exports",
          privileges: [
            { name: "Enabled", code: "enabled", value_type: "boolean" },
            {
              name: "Format",
              code: "format",
              value_type: "select",
              config: { select_options: ["csv", "json"] },
            },
          ],
        },
      }),
      env.BILLING_DB,
      primary.id,
      "request-entitlement-feature",
    );
    expect(created?.status).toBe(201);

    const updated = await handleOperatorProductParityRequest(
      jsonRequest("https://operator.test/api/operator/v1/plans/pro/entitlements", "PUT", {
        entitlements: [
          {
            feature_code: "exports",
            privileges: [
              { privilege_code: "enabled", value: true },
              { privilege_code: "format", value: "csv" },
            ],
          },
        ],
      }),
      env.BILLING_DB,
      primary.id,
      "request-entitlement-update",
    );
    const updatedBody = (await updated?.json()) as {
      entitlements: Array<{
        feature_code: string;
        privileges: Array<{ privilege_code: string; value: unknown }>;
      }>;
    };
    expect(updatedBody.entitlements).toEqual([
      expect.objectContaining({
        feature_code: "exports",
        privileges: expect.arrayContaining([
          expect.objectContaining({ privilege_code: "enabled", value: true }),
          expect.objectContaining({ privilege_code: "format", value: "csv" }),
        ]),
      }),
    ]);

    await expect(
      handleOperatorProductParityRequest(
        new Request("https://operator.test/api/operator/v1/plans/pro/entitlements"),
        env.BILLING_DB,
        secondary.id,
        "request-entitlement-cross-tenant",
      ),
    ).rejects.toMatchObject({ code: "plan_not_found" });
  });
});

describe("operator analytics and forecasts", () => {
  it("projects tenant and customer scoped revenue, MRR, and forecast scenarios", async () => {
    const organization = await createOrganization("analytics");
    const other = await createOrganization("analytics-other");
    const now = new Date().toISOString();
    const customerId = crypto.randomUUID();
    const planId = crypto.randomUUID();
    const subscriptionId = crypto.randomUUID();
    await env.BILLING_DB.batch([
      env.BILLING_DB.prepare(
        `INSERT INTO customers
           (id, organization_id, external_id, email, name, currency, metadata_json, created_at, updated_at)
           VALUES (?, ?, 'customer-a', NULL, 'Customer A', 'USD', '{}', ?, ?)`,
      ).bind(customerId, organization.id, now, now),
      env.BILLING_DB.prepare(
        `INSERT INTO plans
           (id, organization_id, code, name, interval, amount_minor, currency, version, active,
            created_at, updated_at)
           VALUES (?, ?, 'monthly-plan', 'Monthly plan', 'monthly', 5000, 'USD', 1, 1, ?, ?)`,
      ).bind(planId, organization.id, now, now),
      env.BILLING_DB.prepare(
        `INSERT INTO subscriptions
           (id, organization_id, customer_id, plan_id, external_id, status, started_at,
            current_period_start, current_period_end, version, created_at, updated_at)
           VALUES (?, ?, ?, ?, 'subscription-a', 'active', ?, ?, ?, 1, ?, ?)`,
      ).bind(
        subscriptionId,
        organization.id,
        customerId,
        planId,
        now,
        now,
        "2027-01-01T00:00:00.000Z",
        now,
        now,
      ),
      env.BILLING_DB.prepare(
        `INSERT INTO invoices
           (id, organization_id, customer_id, subscription_id, number, status, payment_status,
            currency, subtotal_minor, tax_minor, credits_minor, total_due_minor, version,
            finalized_at, created_at, updated_at)
           VALUES (?, ?, ?, ?, 'INV-TEST', 'finalized', 'succeeded', 'USD', 12000, 0, 0,
                   12000, 1, ?, ?, ?)`,
      ).bind(crypto.randomUUID(), organization.id, customerId, subscriptionId, now, now, now),
    ]);

    const response = await handleOperatorAnalyticsRequest(
      new Request(
        "https://operator.test/api/operator/v1/analytics?from=2026-01-01&to=2027-12-31&customer_external_id=customer-a",
      ),
      env.BILLING_DB,
      organization.id,
      "request-analytics",
    );
    const body = (await response?.json()) as {
      analytics: {
        revenue_streams: {
          total_amount_minor: number;
          plan_breakdown: Array<{ code: string; amount_minor: number }>;
        };
        mrr: {
          amount_minor: number;
          subscriptions_count: number;
          plan_breakdown: Array<{ code: string; amount_minor: number }>;
        };
      };
    };
    expect(body.analytics.revenue_streams.total_amount_minor).toBe(12_000);
    expect(body.analytics.mrr).toMatchObject({ amount_minor: 5_000, subscriptions_count: 1 });
    expect(body.analytics.mrr.plan_breakdown).toEqual([
      expect.objectContaining({ code: "monthly-plan", amount_minor: 5_000 }),
    ]);
    expect(body.analytics.revenue_streams.plan_breakdown).toEqual([
      expect.objectContaining({ code: "monthly-plan", amount_minor: 12_000 }),
    ]);

    await expect(
      handleOperatorAnalyticsRequest(
        new Request(
          "https://operator.test/api/operator/v1/analytics?customer_external_id=customer-a",
        ),
        env.BILLING_DB,
        other.id,
        "request-analytics-cross-tenant",
      ),
    ).rejects.toMatchObject({ code: "customer_not_found" });

    const forecastResponse = await handleOperatorAnalyticsRequest(
      new Request("https://operator.test/api/operator/v1/forecasts?months=3"),
      env.BILLING_DB,
      organization.id,
      "request-forecast",
    );
    const forecastBody = (await forecastResponse?.json()) as {
      forecast: { projected_months: Array<Record<string, number | string>> };
    };
    expect(forecastBody.forecast.projected_months).toHaveLength(3);
    expect(forecastBody.forecast.projected_months[0]).toEqual(
      expect.objectContaining({
        optimistic_amount_minor: expect.any(Number),
        realistic_amount_minor: expect.any(Number),
        conservative_amount_minor: expect.any(Number),
      }),
    );
  });
});

describe("operator AI assistant", () => {
  it("persists streamed history per Access membership and organization", async () => {
    const organization = await createOrganization("ai");
    const other = await createOrganization("ai-other");
    const now = new Date().toISOString();
    const membershipId = crypto.randomUUID();
    const otherMembershipId = crypto.randomUUID();
    await env.BILLING_DB.batch([
      membershipStatement(membershipId, organization.id, "a".repeat(64), now),
      membershipStatement(otherMembershipId, other.id, "b".repeat(64), now),
    ]);
    const operator = operatorContext(organization, membershipId);
    const otherOperator = operatorContext(other, otherMembershipId);
    const fakeAi: OperatorAiEnv["AI"] = {
      async run() {
        const encoder = new TextEncoder();
        return new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(encoder.encode('data: {"response":"Tenant billing looks "}\n\n'));
            controller.enqueue(encoder.encode('data: {"response":"healthy."}\n\n'));
            controller.enqueue(encoder.encode("data: [DONE]\n\n"));
            controller.close();
          },
        });
      },
    };
    const aiEnv = { BILLING_DB: env.BILLING_DB, AI: fakeAi };
    const created = await handleOperatorAiRequest(
      jsonRequest("https://operator.test/api/operator/v1/ai/conversations", "POST", {
        conversation: { title: "Billing health" },
      }),
      aiEnv,
      operator,
      "request-ai-create",
    );
    const createdBody = (await created?.json()) as { conversation: { lago_id: string } };
    const conversationId = createdBody.conversation.lago_id;
    const streamed = await handleOperatorAiRequest(
      jsonRequest(
        `https://operator.test/api/operator/v1/ai/conversations/${conversationId}/messages`,
        "POST",
        { message: { content: "How are we doing?" } },
      ),
      aiEnv,
      operator,
      "request-ai-message",
    );
    await expect(streamed?.text()).resolves.toContain("Tenant billing looks");

    const shown = await handleOperatorAiRequest(
      new Request(`https://operator.test/api/operator/v1/ai/conversations/${conversationId}`),
      aiEnv,
      operator,
      "request-ai-show",
    );
    const shownBody = (await shown?.json()) as {
      conversation: { messages: Array<{ role: string; content: string }> };
    };
    expect(shownBody.conversation.messages).toEqual([
      expect.objectContaining({ role: "user", content: "How are we doing?" }),
      expect.objectContaining({ role: "assistant", content: "Tenant billing looks healthy." }),
    ]);

    await expect(
      handleOperatorAiRequest(
        new Request(`https://operator.test/api/operator/v1/ai/conversations/${conversationId}`),
        aiEnv,
        otherOperator,
        "request-ai-cross-tenant",
      ),
    ).rejects.toMatchObject({ code: "ai_conversation_not_found" });
  });
});

function membershipStatement(
  id: string,
  organizationId: string,
  subjectHash: string,
  now: string,
): D1PreparedStatement {
  return env.BILLING_DB.prepare(
    `INSERT INTO operator_memberships
     (id, organization_id, access_issuer, access_subject_sha256, role, active, version,
      created_at, updated_at, revoked_at)
     VALUES (?, ?, 'https://serp-test.cloudflareaccess.com', ?, 'admin', 1, 1, ?, ?, NULL)`,
  ).bind(id, organizationId, subjectHash, now, now);
}

function operatorContext(
  organization: { id: string; externalId: string },
  membershipId: string,
): OperatorContext {
  return {
    membershipId,
    organizationId: organization.id,
    organizationExternalId: organization.externalId,
    organizationName: organization.externalId,
    organizationSlug: organization.externalId,
    role: "admin",
    memberships: [],
  };
}
