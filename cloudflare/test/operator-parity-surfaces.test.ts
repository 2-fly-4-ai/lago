import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import { handleOperatorAiRequest, type OperatorAiEnv } from "../src/operator/ai";
import { handleOperatorAnalyticsRequest } from "../src/operator/analytics";
import type { OperatorContext } from "../src/operator/access";
import { handleOperatorConfigurationRequest } from "../src/operator/configuration";
import { handleOperatorFeaturesRequest } from "../src/operator/features";
import { handleOperatorIntegrationsRequest } from "../src/operator/integrations";
import { integrationRuntimeStatuses } from "../src/provider-financial-service";
import { handleOperatorObservabilityRequest } from "../src/operator/observability";
import { handleOperatorProductParityRequest } from "../src/operator/product-parity";
import { handlePortalAdminRequest } from "../src/operator/portal-admin";
import { handleOperatorTeamRequest } from "../src/operator/team";

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

describe("operator developer observability", () => {
  it("returns redacted tenant activity and API logs without cross-tenant leakage", async () => {
    const primary = await createOrganization("observability-primary");
    const secondary = await createOrganization("observability-secondary");
    const now = new Date().toISOString();
    const eventId = crypto.randomUUID();
    const membershipId = crypto.randomUUID();
    await env.BILLING_DB.batch([
      env.BILLING_DB.prepare(
        `INSERT INTO operator_memberships
         (id, organization_id, access_issuer, access_subject_sha256, role, active, created_at, updated_at)
         VALUES (?, ?, 'https://example.cloudflareaccess.com', ?, 'admin', 1, ?, ?)`,
      ).bind(membershipId, primary.id, "a".repeat(64), now, now),
      env.BILLING_DB.prepare(
        `INSERT INTO outbox_events
         (event_id, organization_id, event_type, event_version, aggregate_type, aggregate_id,
          aggregate_version, correlation_id, payload_json, occurred_at)
         VALUES (?, ?, 'customer.updated', 1, 'customer', 'customer-a', 1, ?, ?, ?)`,
      ).bind(
        eventId,
        primary.id,
        crypto.randomUUID(),
        JSON.stringify({
          customer_id: "customer-a",
          email: "hidden@example.com",
          status: "active",
        }),
        now,
      ),
      env.BILLING_DB.prepare(
        `INSERT INTO operator_api_logs
         (id, organization_id, membership_id, request_id, method, route_template,
          response_status, duration_ms, occurred_at, expires_at)
         VALUES ('api-log-a', ?, ?, 'request-a', 'GET', '/api/operator/v1/customers', 200, 12, ?, ?)`,
      ).bind(primary.id, membershipId, now, "2099-01-01T00:00:00.000Z"),
    ]);

    const activity = await handleOperatorObservabilityRequest(
      new Request("https://operator.test/api/operator/v1/observability/activity-logs"),
      env.BILLING_DB,
      primary.id,
      "request-activity",
    );
    const activityBody = (await activity?.json()) as {
      activity_logs: Array<{ lago_id: string; changes: Record<string, unknown> }>;
    };
    expect(activityBody.activity_logs).toEqual([
      expect.objectContaining({
        lago_id: eventId,
        changes: expect.objectContaining({
          customer_id: "customer-a",
          email: "[redacted]",
          status: "active",
        }),
      }),
    ]);

    const apiLogs = await handleOperatorObservabilityRequest(
      new Request("https://operator.test/api/operator/v1/observability/api-logs"),
      env.BILLING_DB,
      primary.id,
      "request-api-logs",
    );
    const apiBody = (await apiLogs?.json()) as {
      api_logs: Array<{ request_body: string; path: string }>;
    };
    expect(apiBody.api_logs).toEqual([
      expect.objectContaining({
        path: "/api/operator/v1/customers",
        request_body: "Not retained",
      }),
    ]);

    const secondaryActivity = await handleOperatorObservabilityRequest(
      new Request("https://operator.test/api/operator/v1/observability/activity-logs"),
      env.BILLING_DB,
      secondary.id,
      "request-secondary-activity",
    );
    expect(await secondaryActivity?.json()).toMatchObject({ activity_logs: [] });
  });
});

describe("operator Access team administration", () => {
  it("stores invitation identity only as a hash and scopes membership reads", async () => {
    const primary = await createOrganization("team-primary");
    const secondary = await createOrganization("team-secondary");
    const now = new Date().toISOString();
    const adminMembership = crypto.randomUUID();
    await env.BILLING_DB.prepare(
      `INSERT INTO operator_memberships
       (id, organization_id, access_issuer, access_subject_sha256, role, active, version,
        created_at, updated_at)
       VALUES (?, ?, 'https://serp-test.cloudflareaccess.com', ?, 'admin', 1, 1, ?, ?)`,
    )
      .bind(adminMembership, primary.id, "b".repeat(64), now, now)
      .run();
    const operator = operatorContext(primary, adminMembership);
    const invite = await handleOperatorTeamRequest(
      new Request("https://operator.test/api/operator/v1/team/invitations", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: "https://operator.test",
          "X-Operator-Request": "1",
        },
        body: JSON.stringify({ email: "new-admin@example.invalid", role: "admin" }),
      }),
      {
        APP_ENV: "test",
        BILLING_ACCOUNTS: env.BILLING_ACCOUNTS,
        BILLING_DB: env.BILLING_DB,
        DOMAIN_EVENTS: env.DOMAIN_EVENTS,
        DOCUMENT_WORKFLOW: env.DOCUMENT_WORKFLOW,
        PLAN_DELETION_WORKFLOW: env.PLAN_DELETION_WORKFLOW,
        OPERATOR_ACCESS_ENABLED: "1",
      },
      operator,
      "request-team-invite",
    );
    const inviteBody = (await invite?.json()) as {
      invitations: Array<{ identity: string; role: string }>;
    };
    expect(inviteBody.invitations).toEqual([
      expect.objectContaining({
        identity: expect.stringContaining("Invited email …"),
        role: "admin",
      }),
    ]);
    expect(JSON.stringify(inviteBody)).not.toContain("new-admin@example.invalid");

    const otherMembers = await handleOperatorTeamRequest(
      new Request("https://operator.test/api/operator/v1/team/members"),
      {
        APP_ENV: "test",
        BILLING_ACCOUNTS: env.BILLING_ACCOUNTS,
        BILLING_DB: env.BILLING_DB,
        DOMAIN_EVENTS: env.DOMAIN_EVENTS,
        DOCUMENT_WORKFLOW: env.DOCUMENT_WORKFLOW,
        PLAN_DELETION_WORKFLOW: env.PLAN_DELETION_WORKFLOW,
        OPERATOR_ACCESS_ENABLED: "1",
      },
      operatorContext(secondary, crypto.randomUUID()),
      "request-team-secondary",
    );
    expect(await otherMembers?.json()).toMatchObject({ members: [] });
  });
});

describe("operator integration registry", () => {
  it("keeps provider configuration tenant scoped and rejects credential-shaped fields", async () => {
    const primary = await createOrganization("integration-primary");
    const secondary = await createOrganization("integration-secondary");
    const configured = await handleOperatorIntegrationsRequest(
      jsonRequest("https://operator.test/api/operator/v1/integrations/stripe", "PUT", {
        display_name: "Primary Stripe",
        settings: { success_redirect_host: "billing.example.invalid" },
      }),
      env.BILLING_DB,
      primary.id,
      "request-integration-configure",
    );
    expect(await configured?.json()).toMatchObject({
      integration: {
        provider_code: "stripe",
        status: "configuration_required",
        secret_ready: false,
        external_actions_enabled: false,
      },
    });
    const other = await handleOperatorIntegrationsRequest(
      new Request("https://operator.test/api/operator/v1/integrations/stripe"),
      env.BILLING_DB,
      secondary.id,
      "request-integration-other",
    );
    expect(await other?.json()).toMatchObject({
      integration: { status: "disabled", display_name: null },
    });
    await expect(
      handleOperatorIntegrationsRequest(
        jsonRequest("https://operator.test/api/operator/v1/integrations/stripe", "PUT", {
          settings: { api_key: "must-not-store" },
        }),
        env.BILLING_DB,
        primary.id,
        "request-integration-secret",
      ),
    ).rejects.toMatchObject({ code: "secret_not_admitted" });
  });

  it("reports configured sandbox adapters without exposing provider credentials", async () => {
    const organization = await createOrganization("integration-runtime");
    const runtimeStatuses = integrationRuntimeStatuses(
      {
        STRIPE_NETWORK_MODE: "enabled",
        STRIPE_RESTRICTED_API_KEY: "synthetic-stripe-key",
        STRIPE_ACCOUNT_CODE: "synthetic-stripe-account",
        STRIPE_ORGANIZATION_ID: organization.id,
        STRIPE_LIVEMODE_ALLOWED: "0",
        EASY_PAY_DIRECT_NETWORK_MODE: "test",
        EASY_PAY_DIRECT_LIVEMODE_ALLOWED: "0",
        EASY_PAY_DIRECT_COMMERCE_API_KEY: "synthetic-epd-key",
        EASY_PAY_DIRECT_CHECKOUT_SIGNING_SECRET: "synthetic-checkout-secret",
        EASY_PAY_DIRECT_WEBHOOK_SIGNING_KEY: "synthetic-webhook-key",
        EASY_PAY_DIRECT_ACCOUNT_CODE: "synthetic-epd-account",
        EASY_PAY_DIRECT_ORGANIZATION_ID: organization.id,
        PAYMENT_MUTATIONS_ENABLED: "0",
      } as Env,
      organization.id,
    );
    const response = await handleOperatorIntegrationsRequest(
      new Request("https://operator.test/api/operator/v1/integrations"),
      env.BILLING_DB,
      organization.id,
      "request-integration-runtime",
      runtimeStatuses,
    );
    const payload = (await response?.json()) as {
      integrations: Array<Record<string, unknown>>;
    };
    expect(payload.integrations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          provider_code: "stripe",
          status: "connected",
          secret_ready: true,
          external_actions_enabled: false,
          environment: "sandbox",
          status_message: "Sandbox connected; payment writes are paused",
        }),
        expect.objectContaining({
          provider_code: "easy_pay_direct",
          status: "connected",
          secret_ready: true,
          external_actions_enabled: false,
          environment: "sandbox",
          status_message: "Sandbox connected; payment writes are paused",
        }),
        expect.objectContaining({
          provider_code: "adyen",
          status: "disabled",
          secret_ready: false,
          status_message: "Not configured",
        }),
      ]),
    );
    expect(JSON.stringify(payload)).not.toContain("synthetic-stripe-key");
    expect(JSON.stringify(payload)).not.toContain("synthetic-epd-key");
  });

  it("reports a live EPD adapter as production without exposing credentials", async () => {
    const organization = await createOrganization("integration-runtime-production");
    const runtimeStatuses = integrationRuntimeStatuses(
      {
        EASY_PAY_DIRECT_NETWORK_MODE: "production",
        EASY_PAY_DIRECT_LIVEMODE_ALLOWED: "1",
        EASY_PAY_DIRECT_COMMERCE_API_KEY: "synthetic-epd-live-key",
        EASY_PAY_DIRECT_CHECKOUT_SIGNING_SECRET: "synthetic-checkout-secret",
        EASY_PAY_DIRECT_WEBHOOK_SIGNING_KEY: "synthetic-webhook-key",
        EASY_PAY_DIRECT_ACCOUNT_CODE: "easy-pay-direct",
        EASY_PAY_DIRECT_ORGANIZATION_ID: organization.id,
        PAYMENT_MUTATIONS_ENABLED: "1",
      } as Env,
      organization.id,
    );
    const response = await handleOperatorIntegrationsRequest(
      new Request("https://operator.test/api/operator/v1/integrations"),
      env.BILLING_DB,
      organization.id,
      "request-integration-runtime-production",
      runtimeStatuses,
    );
    const payload = (await response?.json()) as {
      integrations: Array<Record<string, unknown>>;
    };
    expect(payload.integrations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          provider_code: "easy_pay_direct",
          status: "connected",
          secret_ready: true,
          external_actions_enabled: true,
          environment: "production",
          status_message: "Production connected; payment writes are enabled",
        }),
      ]),
    );
    expect(JSON.stringify(payload)).not.toContain("synthetic-epd-live-key");
  });
});

describe("operator pricing units and alerts", () => {
  it("keeps pricing units and resource alerts executable and tenant scoped", async () => {
    const primary = await createOrganization("configuration-primary");
    const secondary = await createOrganization("configuration-secondary");
    const now = new Date().toISOString();
    const customerId = crypto.randomUUID();
    const planId = crypto.randomUUID();
    const subscriptionId = crypto.randomUUID();
    const walletId = crypto.randomUUID();
    const metricId = crypto.randomUUID();
    await env.BILLING_DB.batch([
      env.BILLING_DB.prepare(
        `INSERT INTO customers
         (id, organization_id, external_id, name, currency, metadata_json, created_at, updated_at)
         VALUES (?, ?, 'configuration-customer', 'Configuration customer', 'USD', '{}', ?, ?)`,
      ).bind(customerId, primary.id, now, now),
      env.BILLING_DB.prepare(
        `INSERT INTO plans
         (id, organization_id, code, name, interval, amount_minor, currency, version, active,
          created_at, updated_at)
         VALUES (?, ?, 'configuration-plan', 'Configuration plan', 'monthly', 0, 'USD', 1, 1, ?, ?)`,
      ).bind(planId, primary.id, now, now),
      env.BILLING_DB.prepare(
        `INSERT INTO subscriptions
         (id, organization_id, customer_id, plan_id, external_id, status, started_at,
          current_period_start, current_period_end, version, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'configuration-subscription', 'active', ?, ?, ?, 1, ?, ?)`,
      ).bind(
        subscriptionId,
        primary.id,
        customerId,
        planId,
        now,
        now,
        "2026-09-18T00:00:00.000Z",
        now,
        now,
      ),
      env.BILLING_DB.prepare(
        `INSERT INTO wallets
         (id, organization_id, customer_id, code, name, currency, currency_exponent, rate_amount,
          priority, balance_minor, consumed_minor, status, version, request_sha256, created_at, updated_at)
         VALUES (?, ?, ?, 'configuration-wallet', 'Configuration wallet', 'USD', 2, '1',
          1, 1000, 0, 'active', 1, ?, ?, ?)`,
      ).bind(walletId, primary.id, customerId, "d".repeat(64), now, now),
      env.BILLING_DB.prepare(
        `INSERT INTO billable_metrics
         (id, organization_id, code, name, aggregation_type, field_name, version, active,
          created_at, updated_at)
         VALUES (?, ?, 'configuration-units', 'Configuration units', 'sum_agg', 'units', 1, 1, ?, ?)`,
      ).bind(metricId, primary.id, now, now),
    ]);

    const pricingUnit = await handleOperatorConfigurationRequest(
      jsonRequest("https://operator.test/api/operator/v1/pricing-units", "POST", {
        pricing_unit: {
          code: "credits",
          name: "Credits",
          short_name: "cr",
          description: "Customer-visible credits",
        },
      }),
      env.BILLING_DB,
      primary.id,
      "request-pricing-unit-create",
    );
    expect(pricingUnit?.status).toBe(201);
    expect(await pricingUnit?.json()).toMatchObject({
      pricing_unit: { code: "credits", short_name: "cr", version: 1 },
    });

    const subscriptionAlert = await handleOperatorConfigurationRequest(
      jsonRequest("https://operator.test/api/operator/v1/alerts", "POST", {
        alert: {
          resource_type: "subscription",
          resource_id: "configuration-subscription",
          alert_type: "billable_metric_current_usage_units",
          billable_metric_id: metricId,
          code: "units-warning",
          name: "Units warning",
          thresholds: [{ value: "500", recurring: true }],
        },
      }),
      env.BILLING_DB,
      primary.id,
      "request-subscription-alert-create",
    );
    expect(subscriptionAlert?.status).toBe(201);
    expect(await subscriptionAlert?.json()).toMatchObject({
      alert: {
        resource_type: "subscription",
        resource_id: subscriptionId,
        billable_metric_id: metricId,
      },
    });

    const walletAlert = await handleOperatorConfigurationRequest(
      jsonRequest("https://operator.test/api/operator/v1/alerts", "POST", {
        alert: {
          resource_type: "wallet",
          resource_id: walletId,
          alert_type: "wallet_balance_amount",
          code: "wallet-low",
          thresholds: [{ value: "10", recurring: false }],
        },
      }),
      env.BILLING_DB,
      primary.id,
      "request-wallet-alert-create",
    );
    const walletAlertBody = (await walletAlert?.json()) as { alert: { lago_id: string } };
    expect(walletAlertBody.alert.lago_id).toBeTruthy();

    const walletAlerts = await handleOperatorConfigurationRequest(
      new Request(
        `https://operator.test/api/operator/v1/alerts?resource_type=wallet&resource_id=${walletId}`,
      ),
      env.BILLING_DB,
      primary.id,
      "request-wallet-alert-list",
    );
    expect(await walletAlerts?.json()).toMatchObject({
      alerts: [expect.objectContaining({ code: "wallet-low" })],
    });

    await expect(
      handleOperatorConfigurationRequest(
        new Request(
          `https://operator.test/api/operator/v1/alerts?resource_type=wallet&resource_id=${walletId}`,
        ),
        env.BILLING_DB,
        secondary.id,
        "request-wallet-alert-cross-tenant",
      ),
    ).rejects.toMatchObject({ code: "wallet_not_found" });
  });
});

describe("operator customer portal administration", () => {
  it("creates a one-time opaque portal token for only the selected tenant customer", async () => {
    const primary = await createOrganization("portal-admin-primary");
    const secondary = await createOrganization("portal-admin-secondary");
    const now = new Date().toISOString();
    const membershipId = crypto.randomUUID();
    await env.BILLING_DB.batch([
      env.BILLING_DB.prepare(
        `INSERT INTO operator_memberships
         (id, organization_id, access_issuer, access_subject_sha256, role, active, version, created_at, updated_at)
         VALUES (?, ?, 'https://serp-test.cloudflareaccess.com', ?, 'admin', 1, 1, ?, ?)`,
      ).bind(membershipId, primary.id, "c".repeat(64), now, now),
      env.BILLING_DB.prepare(
        `INSERT INTO customers
         (id, organization_id, external_id, name, currency, metadata_json, created_at, updated_at)
         VALUES (?, ?, 'portal-customer', 'Portal customer', 'USD', '{}', ?, ?)`,
      ).bind(crypto.randomUUID(), primary.id, now, now),
    ]);
    const created = await handlePortalAdminRequest(
      new Request("https://operator.test/api/operator/v1/customers/portal-customer/portal-token", {
        method: "POST",
      }),
      env.BILLING_DB,
      operatorContext(primary, membershipId),
      "request-portal-admin",
    );
    const body = (await created?.json()) as { portal_token: string; shown_once: boolean };
    expect(body.portal_token).toMatch(/^[a-f0-9]{64}$/);
    expect(body.shown_once).toBe(true);
    await expect(
      handlePortalAdminRequest(
        new Request(
          "https://operator.test/api/operator/v1/customers/portal-customer/portal-token",
          { method: "POST" },
        ),
        env.BILLING_DB,
        operatorContext(secondary, crypto.randomUUID()),
        "request-portal-admin-other",
      ),
    ).rejects.toMatchObject({ code: "customer_not_found" });
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
    accessIssuer: "https://serp-test.cloudflareaccess.com",
    membershipId,
    organizationId: organization.id,
    organizationExternalId: organization.externalId,
    organizationName: organization.externalId,
    organizationSlug: organization.externalId,
    role: "admin",
    memberships: [],
  };
}
