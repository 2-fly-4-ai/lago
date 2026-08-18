import operatorScript from "../operator-app/assets/operator-app.js?raw";
import {
  originalRouteAlias,
  resolveOriginalRouteAlias,
} from "../operator-app/assets/operator-routes.js";
import operatorRoutes from "../operator-app/assets/operator-routes.js?raw";
import operatorHeaders from "../operator-app/_headers?raw";
import operatorIndex from "../operator-app/index.html?raw";
import operatorPreview from "../scripts/operator-preview-server.mjs?raw";
import apiConfig from "../wrangler.jsonc?raw";
import operatorConfig from "../wrangler.operator.jsonc?raw";
import { describe, expect, it } from "vitest";

describe("isolated operator app assets", () => {
  it("keeps the API shell separate from the Access-protected operator app", () => {
    expect(apiConfig).toContain('"directory": "operator-ui"');
    expect(apiConfig).not.toContain('"directory": "operator-app"');
    expect(operatorConfig).toContain('"directory": "operator-app"');
    expect(operatorConfig).not.toContain('"directory": "operator-ui"');
    expect(operatorConfig).toContain('"OPERATOR_ACCESS_ENABLED": "1"');
    expect(operatorConfig).toContain(
      '"ACCESS_TEAM_DOMAIN": "https://serpcompany.cloudflareaccess.com"',
    );
    expect(operatorConfig).toContain(
      '"ACCESS_AUD": "4e2aeb75eccbd0abda500c9318a371acbeab7a244f8727904358021daea5a951"',
    );
    expect(operatorConfig).toContain('"database_id": "2f32f159-c269-46c6-a4dd-9e38477f5d25"');
    expect(operatorConfig).toContain('"name": "BILLING_ACCOUNTS"');
    expect(operatorConfig).toContain('"script_name": "serp-dev-lago-native"');
    expect(operatorConfig).toContain('"binding": "AI"');
    expect(operatorConfig).toContain('"binding": "BILLING_ARTIFACTS"');
    expect(operatorConfig).toContain('"@cf/zai-org/glm-4.7-flash"');
  });

  it("loads only same-origin static code under a restrictive browser policy", () => {
    expect(operatorIndex).toContain('src="/assets/operator-app.js"');
    expect(operatorIndex).toContain('href="/assets/operator-app.css"');
    expect(operatorIndex).not.toMatch(/<script[^>]*>\s*[^<\s]/i);
    for (const directive of [
      "default-src 'self'",
      "script-src 'self'",
      "style-src 'self'",
      "connect-src 'self'",
      "object-src 'none'",
      "base-uri 'none'",
      "form-action 'self'",
      "frame-ancestors 'none'",
    ]) {
      expect(operatorIndex).toContain(directive);
      expect(operatorHeaders).toContain(directive);
    }
    expect(operatorHeaders).toContain("X-Robots-Tag: noindex, nofollow");
    expect(operatorHeaders).toContain("Permissions-Policy:");
  });

  it("uses the membership-scoped REST BFF without browser credential storage", () => {
    for (const endpoint of [
      "/api/operator/v1/session",
      "/api/operator/v1/organization",
      "/api/operator/v1/billing-entities/default",
      "/api/operator/v1/api-keys",
      "/api/operator/v1/invoice-custom-sections",
      "/api/operator/v1/payment-receipts",
      "/api/operator/v1/taxes",
      "/api/operator/v1/add-ons",
      "/api/operator/v1/customers",
      "/api/operator/v1/coupons",
      "/api/operator/v1/applied-coupons",
      "/api/operator/v1/plans",
      "/api/operator/v1/subscriptions",
      "/api/operator/v1/invoices",
      "/api/operator/v1/wallets",
      "/api/operator/v1/wallet-transactions",
      "/api/operator/v1/credit-notes",
      "/api/operator/v1/payments",
      "/api/operator/v1/quotes",
      "/api/operator/v1/quote-versions",
      "/api/operator/v1/data-exports",
      "/api/operator/v1/webhook-endpoints",
      "/api/operator/v1/dunning-campaigns",
      "/api/operator/v1/payment-requests",
      "/api/operator/v1/analytics",
      "/api/operator/v1/forecasts",
      "/api/operator/v1/billable-metrics",
      "/api/operator/v1/features",
      "/api/operator/v1/ai/conversations",
      "/api/operator/v1/observability/activity-logs",
      "/api/operator/v1/observability/api-logs",
      "/api/operator/v1/observability/events",
      "/api/operator/v1/integrations",
      "/api/operator/v1/billing-entities/default/taxes",
      "/api/operator/v1/billing-entities/default/dunning-campaign",
      "/api/operator/v1/billing-entities/default/logo",
    ]) {
      expect(operatorScript).toContain(endpoint);
    }
    expect(operatorScript).toContain('headers.set("X-Operator-Request", "1")');
    expect(operatorScript).toContain('headers.set("X-Operator-Organization"');
    expect(operatorScript).toContain('headers.set("Content-Type", "application/json")');
    expect(operatorScript).not.toMatch(
      /localStorage|sessionStorage|indexedDB|document\.cookie|Authorization|\/graphql\b|innerHTML/i,
    );
  });

  it("implements the original report and catalog surfaces plus the right-side assistant", () => {
    expect(operatorIndex).not.toContain('data-unavailable="true"');
    for (const identifier of [
      'id="analytics"',
      'id="forecasts"',
      'id="billable-metrics"',
      'id="features"',
      'id="ai-rail"',
      'id="ai-panel"',
      'id="activity-logs"',
      'id="api-logs"',
      'id="events"',
      'id="integrations"',
    ]) {
      expect(operatorIndex).toContain(identifier);
    }
    for (const tab of ["Revenue streams", "MRR", "Usage", "Prepaid credits", "Invoices"]) {
      expect(operatorIndex).toContain(tab);
    }
    expect(operatorIndex).toContain("Optimistic");
    expect(operatorIndex).toContain("Realistic");
    expect(operatorIndex).toContain("Conservative");
    expect(operatorScript).toContain("renderCustomerAnalytics");
    expect(operatorScript).toContain("readAiStream");
    expect(operatorScript).toContain("privilegeSummary");
    expect(operatorScript).toContain("openDuplicateMetricDialog");
    expect(operatorScript).toContain("catalogActivityEndpoint");
    expect(operatorScript).toContain("planEntitlementsEndpoint");
    expect(operatorScript).toContain("navigateToUsageMetric");
    expect(operatorScript).toContain("webhookLogsEndpoint");
    expect(operatorScript).toContain("renderObservability");
    expect(operatorIndex).toContain('id="plan-entitlements"');
    expect(operatorIndex).toContain('id="entity-advanced"');
    expect(operatorIndex).toContain('id="entity-download-document"');
    expect(operatorIndex).toContain('id="billing-advanced-form"');
    expect(operatorScript).toContain("renderCustomerSettingsTab");
    expect(operatorScript).toContain("renderInvoiceAdvanced");
    expect(operatorScript).toContain("renderCreditNoteAdvanced");
    expect(operatorScript).toContain("downloadSelectedDocument");
    expect(operatorScript).toContain("invoiceMetadataEndpoint");
    expect(operatorScript).toContain("invoiceAdjustedFeesEndpoint");
  });

  it("uses organization-slug routes, real history, and the retained Lago navigation hierarchy", () => {
    expect(operatorScript).toContain("window.history.pushState");
    expect(operatorScript).toContain('window.addEventListener("popstate"');
    expect(operatorScript).toContain("operator.organization_slug");
    expect(operatorScript).toContain("operator.memberships");
    expect(operatorIndex).toContain("Reports");
    expect(operatorIndex).toContain("Configuration");
    expect(operatorIndex).toContain("Billing &amp; operations");
    expect(operatorIndex).toContain("organization-switcher");
    expect(operatorIndex).toContain('data-route="customers"');
    expect(operatorIndex).not.toMatch(/href="#(?:overview|customers|plans|invoices)/);
    expect(operatorPreview).toContain('"serp-billing"');
    expect(operatorPreview).toContain('"serp-labs"');
    expect(operatorScript).toContain("resolveOriginalRouteAlias");
    expect(operatorRoutes).toContain('first === "customer"');
    expect(operatorRoutes).toContain('first === "settings"');
  });

  it("resolves original Lago routes both with and without an organization slug", () => {
    expect(originalRouteAlias(["customer", "tammy", "settings"])).toEqual({
      route: "customers",
      detailId: "tammy",
      detailTab: "settings",
    });
    expect(resolveOriginalRouteAlias(["serp-billing", "customer", "tammy"])).toEqual({
      organizationSlug: "serp-billing",
      route: "customers",
      detailId: "tammy",
      detailTab: "overview",
    });
    expect(resolveOriginalRouteAlias(["serp-billing", "settings", "billing-entity"])).toEqual({
      organizationSlug: "serp-billing",
      route: "billing-profile",
    });
    expect(resolveOriginalRouteAlias(["serp-billing", "invoices", "invoice-preview-001"])).toBe(
      null,
    );
  });

  it("keeps admitted REST families in focused Lago list and detail routes", () => {
    expect(operatorIndex).toContain('id="customer-detail"');
    expect(operatorIndex).toContain('id="entity-detail"');
    expect(operatorScript).toContain("entityDetailDefinitions");
    expect(operatorScript).toContain("decorateEntityRows");
    expect(operatorScript).toContain("findDetailEntity");
    expect(operatorScript).toContain("routePath(state.organizationSlug, route, identifier)");
    expect(operatorScript).toContain("No other tenant was queried");
    for (const route of [
      "api-keys",
      "invoice-sections",
      "payment-receipts",
      "taxes",
      "add-ons",
      "coupons",
      "plans",
      "subscriptions",
      "invoices",
      "wallets",
      "credit-notes",
      "payments",
      "quotes",
      "data-exports",
      "webhook-endpoints",
      "dunning-campaigns",
      "activity-logs",
      "api-logs",
      "events",
    ]) {
      expect(operatorIndex).toContain(`data-route="${route}"`);
    }
  });

  it("reuses original Lago icon assets instead of text-glyph UI icons", () => {
    expect(operatorIndex).toContain("/assets/icons/user-multiple.svg");
    expect(operatorIndex).toContain("/assets/icons/chart-bar.svg");
    expect(operatorIndex).toContain("/assets/icons/close.svg");
    expect(operatorIndex).toContain("/assets/lago-logo-grey.svg");
    expect(operatorIndex).not.toMatch(/aria-hidden="true">\s*[×+!$⌁⇩“”↩◉◇▧↻▤≡◎⌂¤＋%]\s*</);
  });

  it("renders explicit fail-closed and one-time secret states", () => {
    expect(operatorIndex).toContain("Operator Access not configured");
    expect(operatorIndex).toContain("No API-key login");
    expect(operatorIndex).toContain("This secret is shown once");
    expect(operatorIndex).toContain("Custom sections");
    expect(operatorIndex).toContain("Create section");
    expect(operatorIndex).toContain("Billing profile");
    expect(operatorIndex).toContain("Payment receipts");
    expect(operatorIndex).toContain("Manual taxes");
    expect(operatorIndex).toContain("Add-ons");
    expect(operatorIndex).toContain("Customers");
    expect(operatorIndex).toContain("Customer applications");
    expect(operatorIndex).toContain("Coupon definitions are immutable after creation");
    expect(operatorIndex).toContain("Usage charges, thresholds, commitments, taxes, and metadata");
    expect(operatorIndex).toContain("Provider");
    expect(operatorIndex).toContain("payment methods, custom sections, and usage thresholds");
    expect(operatorIndex).toContain("Provider collection and fee tax targeting are unavailable");
    expect(operatorIndex).toContain(
      "Recurring rules, fee targeting, custom sections, paid credits",
    );
    expect(operatorIndex).toContain("PDF generation and download are available");
    expect(operatorIndex).toContain("Settlement ledger");
    expect(operatorIndex).toContain("payment-link");
    expect(operatorIndex).toContain("Quotes have no PDF, template, generation, download, email");
    expect(operatorIndex).toContain("Artifact download and completion email remain unavailable");
    expect(operatorIndex).toContain("Outbound integrations");
    expect(operatorIndex).toContain("signing-secret");
    expect(operatorIndex).toContain("Configure internal overdue thresholds");
    expect(operatorIndex).toContain("Provider collection and email delivery remain disabled");
    expect(operatorIndex).toContain("Provider settings and custom sections");
    expect(operatorIndex).toContain("E-invoicing and additional billing entities");
    expect(operatorScript).toContain("state.oneTimeSecret = null");
    expect(operatorScript).toContain('elements.secretValue.textContent = "—"');
  });
});
