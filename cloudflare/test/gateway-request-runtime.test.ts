import { describe, expect, it } from "vitest";

describe("Gateway request runtime compatibility, no external network", () => {
  it("documents unsupported error redirect and validates manual detached fetch", async () => {
    const controller = new AbortController();
    const url = "https://gateway-runtime.invalid/api/query.php";
    const options = {
      method: "POST",
      redirect: "manual" as const,
      signal: controller.signal,
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ security_key: "public-dummy", transaction_id: "12345" }),
    };
    expect(() => new Request(url, { ...options, redirect: "error" })).toThrow(TypeError);
    const request = new Request(url, options);
    expect(request.redirect).toBe("manual");
    expect(new TextDecoder().decode(await request.arrayBuffer())).toBe(
      "security_key=public-dummy&transaction_id=12345",
    );
    // Already-aborted request exercises native fetch binding without network.
    controller.abort();
    const fetcher = fetch;
    await expect(fetcher(url, options)).rejects.toMatchObject({ name: "AbortError" });
  });
});
