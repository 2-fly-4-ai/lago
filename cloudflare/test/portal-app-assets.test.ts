import portalHtml from "../portal-app/index.html?raw";
import portalScript from "../portal-app/portal.js?raw";
import portalConfig from "../wrangler.portal.jsonc?raw";
import { describe, expect, it } from "vitest";

describe("customer portal static app", () => {
  it("keeps the original Lago portal structure and token-only browser boundary", () => {
    expect(portalHtml).toContain("Wallets");
    expect(portalHtml).toContain("Usage");
    expect(portalHtml).toContain("Customer information");
    expect(portalHtml).toContain("Invoices");
    expect(portalHtml).toContain('class="portal-sidebar"');
    expect(portalHtml).toContain('src="/lago-logo-grey.svg"');
    expect(portalScript).toContain("X-Customer-Portal-Token");
    expect(portalScript).toContain("X-Portal-Request");
    expect(portalScript).not.toMatch(
      /localStorage|sessionStorage|document\.cookie|Authorization|innerHTML/i,
    );
  });

  it("uses a separate Worker with D1, R2, and static assets", () => {
    expect(portalConfig).toContain('"name": "serp-dev-lago-customer-portal"');
    expect(portalConfig).toContain('"binding": "BILLING_DB"');
    expect(portalConfig).toContain('"binding": "BILLING_ARTIFACTS"');
    expect(portalConfig).toContain('"directory": "portal-app"');
    expect(portalConfig).not.toContain("OPERATOR_ACCESS_ENABLED");
  });
});
