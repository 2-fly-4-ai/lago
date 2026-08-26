import { sha256Hex } from "./auth/api-key";

export async function deterministicUuid(namespace: string, value: string): Promise<string> {
  const hash = await sha256Hex(`${namespace}\0${value}`);
  const bytes = hash.slice(0, 32).split("");
  bytes[12] = "5";
  bytes[16] = ((Number.parseInt(bytes[16] ?? "0", 16) & 0x3) | 0x8).toString(16);
  const compact = bytes.join("");
  return `${compact.slice(0, 8)}-${compact.slice(8, 12)}-${compact.slice(12, 16)}-${compact.slice(16, 20)}-${compact.slice(20)}`;
}
