import operatorScript from "../operator-app/assets/operator-app.js?raw";
import operatorHeaders from "../operator-app/_headers?raw";
import operatorIndex from "../operator-app/index.html?raw";
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
    ]) {
      expect(operatorScript).toContain(endpoint);
    }
    expect(operatorScript).toContain('headers.set("X-Operator-Request", "1")');
    expect(operatorScript).toContain('headers.set("Content-Type", "application/json")');
    expect(operatorScript).not.toMatch(
      /localStorage|sessionStorage|indexedDB|document\.cookie|Authorization|\/graphql\b|innerHTML/i,
    );
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
    expect(operatorIndex).toContain("Refunds, offsets, provider actions, PDF");
    expect(operatorIndex).toContain("Settlement ledger");
    expect(operatorIndex).toContain("payment-link");
    expect(operatorIndex).toContain("Quotes have no PDF, template, generation, download, email");
    expect(operatorIndex).toContain("Artifact download and completion email remain unavailable");
    expect(operatorIndex).toContain("Outbound integrations");
    expect(operatorIndex).toContain("signing-secret");
    expect(operatorIndex).toContain("Configure internal overdue thresholds");
    expect(operatorIndex).toContain("Provider collection and email delivery remain disabled");
    expect(operatorIndex).toContain("Provider settings, dunning, metadata, custom sections");
    expect(operatorIndex).toContain("E-invoicing, tax assignment, and additional billing entities");
    expect(operatorScript).toContain("state.oneTimeSecret = null");
    expect(operatorScript).toContain('elements.secretValue.textContent = "—"');
  });
});
