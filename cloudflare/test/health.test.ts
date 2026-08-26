import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";

describe("service health", () => {
  it("reports a redaction-safe health response", async () => {
    const response = await SELF.fetch("https://example.test/health");
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(response.headers.get("X-Request-Id")).toBeTruthy();
    await expect(response.json()).resolves.toEqual({
      status: "ok",
      service: "serp-lago-native",
      environment: "development",
    });
  });

  it("reports D1 readiness", async () => {
    const response = await SELF.fetch("https://example.test/ready");
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ status: "ready" });
  });

  it("returns a stable error envelope", async () => {
    const response = await SELF.fetch("https://example.test/missing", {
      headers: { "X-Request-Id": "request-test-1" },
    });
    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({
      error: "not_found",
      request_id: "request-test-1",
    });
  });
});
