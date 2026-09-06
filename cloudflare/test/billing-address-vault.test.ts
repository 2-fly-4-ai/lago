import { describe, expect, it } from "vitest";
import { decryptBillingAddress, encryptBillingAddress } from "../src/tax/billing-address-vault";

describe("billing address vault", () => {
  it("round-trips an address without returning plaintext storage", async () => {
    const address = {
      country: "US",
      state: "WA",
      postalCode: "98501-8500",
      addressLine: "6300 Linderson Way SW",
      city: "Tumwater",
    };
    const encrypted = await encryptBillingAddress(address, "test-secret", "quote-1");
    expect(encrypted.ciphertext).not.toContain("Linderson");
    expect(
      await decryptBillingAddress(encrypted.ciphertext, encrypted.iv, "test-secret", "quote-1"),
    ).toEqual(address);
  });

  it("rejects tampering and the wrong quote or secret", async () => {
    const encrypted = await encryptBillingAddress({ country: "US" }, "test-secret", "quote-1");
    const tamperedCiphertext = `${encrypted.ciphertext[0] === "A" ? "B" : "A"}${encrypted.ciphertext.slice(1)}`;
    for (const [ciphertext, secret, quote] of [
      [tamperedCiphertext, "test-secret", "quote-1"],
      [encrypted.ciphertext, "wrong-secret", "quote-1"],
      [encrypted.ciphertext, "test-secret", "quote-2"],
    ] as const) {
      await expect(
        decryptBillingAddress(ciphertext, encrypted.iv, secret, quote),
      ).rejects.toMatchObject({
        code: "checkout_tax_address_unavailable",
      });
    }
  });

  it("fails closed with an API error when encryption context is invalid", async () => {
    await expect(encryptBillingAddress({ country: "US" }, "", "quote-1")).rejects.toMatchObject({
      status: 503,
      code: "checkout_tax_address_encryption_unavailable",
    });
  });
});
