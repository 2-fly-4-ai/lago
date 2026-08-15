import indexHtml from "../operator-ui/index.html?raw";
import staticHeaders from "../operator-ui/_headers?raw";
import wranglerConfig from "../wrangler.jsonc?raw";
import { describe, expect, it } from "vitest";

describe("operator static assets", () => {
  it("ships an explicit non-interactive migration shell", () => {
    expect(indexHtml).toContain("Migration in progress");
    expect(indexHtml).toContain("Operator access is not enabled");
    expect(indexHtml).toContain("no customer data");
    expect(indexHtml).not.toMatch(/<script\b/i);
    expect(indexHtml).not.toMatch(/\/graphql\b|fetch\(|XMLHttpRequest|api[_-]?key/i);
    expect(indexHtml).toContain("script-src 'none'");
    expect(indexHtml).toContain('href="/assets/operator.css"');
    expect(staticHeaders).toContain("Content-Security-Policy:");
    expect(staticHeaders).toContain("frame-ancestors 'none'");
    expect(staticHeaders).toContain("X-Robots-Tag: noindex, nofollow");
  });

  it("serves assets directly while keeping every dynamic boundary Worker-first", () => {
    expect(wranglerConfig).toContain('"directory": "operator-ui"');
    expect(wranglerConfig).toContain('"not_found_handling": "single-page-application"');
    for (const route of ["/api/*", "/health", "/ready", "/authorize_net/*", "/webhooks/*"]) {
      expect(wranglerConfig).toContain(`"${route}"`);
    }
    expect(wranglerConfig).not.toContain('"run_worker_first": true');
  });
});
