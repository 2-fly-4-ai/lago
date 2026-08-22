import { describe, expect, it } from "vitest";
import { validEasyPayDirectSignature } from "../src/webhooks/easy-pay-direct";

describe("Easy Pay Direct webhook signatures", () => {
  it("verifies the documented timestamp.raw-body HMAC-SHA256 format", async () => {
    const body = JSON.stringify({
      id: "synthetic-event-1",
      type: "order.succeeded",
      livemode: false,
      data: { object: { id: "synthetic-order-1", object: "order" } },
    });
    const now = Date.parse("2026-08-22T00:00:00.000Z");
    const timestamp = Math.floor(now / 1000);
    const key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode("synthetic-signing-key"),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    const digest = await crypto.subtle.sign(
      "HMAC",
      key,
      new TextEncoder().encode(`${timestamp}.${body}`),
    );
    const signature = [...new Uint8Array(digest)]
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("");
    await expect(
      validEasyPayDirectSignature(
        body,
        `t=${timestamp},v1=${signature}`,
        "synthetic-signing-key",
        now,
      ),
    ).resolves.toBe(true);
    await expect(
      validEasyPayDirectSignature(
        `${body} `,
        `t=${timestamp},v1=${signature}`,
        "synthetic-signing-key",
        now,
      ),
    ).resolves.toBe(false);
    await expect(
      validEasyPayDirectSignature(
        body,
        `t=${timestamp},v1=${signature}`,
        "synthetic-signing-key",
        now + 301_000,
      ),
    ).resolves.toBe(false);
  });

  it("rejects malformed signature headers", async () => {
    await expect(
      validEasyPayDirectSignature("{}", "sha256=abc", "synthetic-signing-key"),
    ).resolves.toBe(false);
  });
});
