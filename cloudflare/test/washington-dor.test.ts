import { describe, expect, it, vi } from "vitest";
import { parseWashingtonRate, resolveWashingtonRate } from "../src/tax/washington-dor";
const xml = (result = 0) => `<?xml version="1.0" encoding="utf-8"?>
<response loccode="3406" localrate=".033" rate=".098" conf="x" result="${result}" xmlns="">
<search location="6300 Linderson Way SW" city="Tumwater" state="WA" zip="98501" plus4="8500" />
<results location="6300 Linderson Way SW" city="Tumwater" state="WA" zip="98501" plus4="8500" latitude="0" longitude="0" />
<rate name="TUMWATER" jurisdiction="Tumwater" tribe="" county="Thurston" code="3406" staterate=".065" localrate=".033" period="Q32026" />
</response>`;

describe("Washington public address-rate resolver", () => {
  it("parses exact rates and quarter expiry without floating point arithmetic", () => {
    expect(parseWashingtonRate(xml())).toEqual({
      status: "resolved",
      resultCode: 0,
      locationCode: "3406",
      jurisdiction: "Tumwater",
      county: "Thurston",
      stateRatePpm: 65000,
      localRatePpm: 33000,
      totalRatePpm: 98000,
      period: "Q32026",
      validThrough: "2026-10-01T00:00:00.000Z",
      normalizedAddress: {
        addressLine: "6300 Linderson Way SW",
        city: "Tumwater",
        zip: "98501",
        plus4: "8500",
      },
    });
    expect(parseWashingtonRate(xml(2))).toMatchObject({
      status: "correction_required",
      resultCode: 2,
    });
    expect(parseWashingtonRate(xml(4))).toMatchObject({
      status: "correction_required",
      resultCode: 4,
    });
  });

  it("rejects ZIP-only, missing, inconsistent and unsafe responses", () => {
    for (const value of [
      xml(1),
      xml(3),
      xml(5),
      xml(6),
      xml(7),
      xml(9),
      xml().replace('rate=".098"', 'rate=".099"'),
      xml() + xml(),
      `<!DOCTYPE x [<!ENTITY e SYSTEM "file:///etc/passwd">]>${xml()}`,
    ])
      expect(() => parseWashingtonRate(value)).toThrow();
  });

  it("uses only the fixed HTTPS endpoint and does not log the address", async () => {
    const calls: string[] = [];
    const fetcher: typeof fetch = async (input) => {
      calls.push(String(input));
      return new Response(xml(), {
        status: 200,
        headers: { "content-type": "text/xml; charset=utf-8", "content-length": "601" },
      });
    };
    const logger = vi.spyOn(console, "log");
    await expect(
      resolveWashingtonRate(
        { addressLine: "6300 Linderson Way SW", city: "Tumwater", zip: "98501", plus4: "8500" },
        fetcher,
      ),
    ).resolves.toMatchObject({ totalRatePpm: 98000 });
    const url = new URL(calls[0]!);
    expect(url.origin + url.pathname).toBe("https://webgis.dor.wa.gov/webapi/AddressRates.aspx");
    expect(url.searchParams.get("ver")).toBe("3");
    expect(logger).not.toHaveBeenCalled();
    logger.mockRestore();
  });

  it("rejects bad input, media type, oversized response and network failure", async () => {
    const input = { addressLine: "1 Main St", city: "Seattle", zip: "98101" };
    await expect(resolveWashingtonRate({ ...input, zip: "981" })).rejects.toMatchObject({
      status: 503,
    });
    await expect(
      resolveWashingtonRate(
        input,
        async () => new Response(xml(), { headers: { "content-type": "text/html" } }),
      ),
    ).rejects.toMatchObject({ status: 503 });
    await expect(
      resolveWashingtonRate(
        input,
        async () =>
          new Response(xml(), {
            headers: { "content-type": "text/xml", "content-length": "999999" },
          }),
      ),
    ).rejects.toMatchObject({ status: 503 });
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    await expect(
      resolveWashingtonRate(input, async () => {
        throw new Error("secret network detail");
      }),
    ).rejects.toMatchObject({ status: 503 });
    expect(warning).toHaveBeenCalledWith(
      JSON.stringify({
        level: "warn",
        event: "washington_tax_rate_fetch_failed",
        error_name: "Error",
      }),
    );
    expect(warning.mock.calls.flat().join(" ")).not.toContain("1 Main St");
    expect(warning.mock.calls.flat().join(" ")).not.toContain("secret network detail");
    warning.mockRestore();
  });
});
