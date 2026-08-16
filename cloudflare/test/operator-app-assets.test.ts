import operatorScript from "../operator-app/assets/operator-app.js?raw";
import operatorHeaders from "../operator-app/_headers?raw";
import operatorIndex from "../operator-app/index.html?raw";
import apiConfig from "../wrangler.jsonc?raw";
import operatorConfig from "../wrangler.operator.jsonc?raw";
import { describe, expect, it } from "vitest";

describe("isolated operator app assets", () => {
  it("keeps the deployed API shell separate from the undeployed operator app", () => {
    expect(apiConfig).toContain('"directory": "operator-ui"');
    expect(apiConfig).not.toContain('"directory": "operator-app"');
    expect(operatorConfig).toContain('"directory": "operator-app"');
    expect(operatorConfig).not.toContain('"directory": "operator-ui"');
    expect(operatorConfig).toContain('"OPERATOR_ACCESS_ENABLED": "0"');
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
    expect(operatorIndex).toContain("E-invoicing, tax assignment, and additional billing entities");
    expect(operatorScript).toContain("state.oneTimeSecret = null");
    expect(operatorScript).toContain('elements.secretValue.textContent = "—"');
  });
});
