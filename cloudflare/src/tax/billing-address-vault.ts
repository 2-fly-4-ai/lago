import { ApiError } from "../http";
import { stableJson } from "../json";

const LABEL = "lago-epd-tax-address-v1";

export async function encryptBillingAddress(
  address: Record<string, string | null>,
  secret: string,
  quoteId: string,
): Promise<{ ciphertext: string; iv: string }> {
  try {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const plaintext = new TextEncoder().encode(stableJson(address));
    const ciphertext = await crypto.subtle.encrypt(
      { name: "AES-GCM", iv, additionalData: context(quoteId) },
      await addressKey(secret, quoteId, ["encrypt"]),
      plaintext,
    );
    return { ciphertext: encode(new Uint8Array(ciphertext)), iv: encode(iv) };
  } catch {
    throw new ApiError(
      503,
      "checkout_tax_address_encryption_unavailable",
      "Destination tax address protection is unavailable",
    );
  }
}

export async function decryptBillingAddress(
  ciphertext: string,
  iv: string,
  secret: string,
  quoteId: string,
): Promise<Record<string, unknown>> {
  try {
    const clear = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: decode(iv), additionalData: context(quoteId) },
      await addressKey(secret, quoteId, ["decrypt"]),
      decode(ciphertext),
    );
    const value = JSON.parse(new TextDecoder().decode(clear)) as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("shape");
    return value as Record<string, unknown>;
  } catch {
    throw new ApiError(
      503,
      "checkout_tax_address_unavailable",
      "Stored billing address cannot be used for destination tax",
    );
  }
}

async function addressKey(
  secret: string,
  quoteId: string,
  usages: Array<"encrypt" | "decrypt">,
): Promise<CryptoKey> {
  if (!secret.trim() || !quoteId.trim()) throw new Error("Missing address encryption context");
  const material = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(`${LABEL}:${quoteId}:${secret}`),
  );
  return crypto.subtle.importKey("raw", material, { name: "AES-GCM" }, false, usages);
}

function context(quoteId: string): Uint8Array {
  return new TextEncoder().encode(`${LABEL}:${quoteId}`);
}

function encode(value: Uint8Array): string {
  let binary = "";
  for (const byte of value) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function decode(value: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error("Invalid base64url");
  const padded = value
    .replaceAll("-", "+")
    .replaceAll("_", "/")
    .padEnd(Math.ceil(value.length / 4) * 4, "=");
  const binary = atob(padded);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}
