import { ApiError } from "../http";

const ENDPOINT = "https://webgis.dor.wa.gov/webapi/AddressRates.aspx";
const MAX_BYTES = 64 * 1024;

export type WashingtonAddress = {
  addressLine: string;
  city: string;
  zip: string;
  plus4?: string | null;
};

export type WashingtonRateResolution = {
  status: "resolved" | "correction_required";
  resultCode: 0 | 2 | 4;
  locationCode: string;
  jurisdiction: string;
  county: string;
  stateRatePpm: number;
  localRatePpm: number;
  totalRatePpm: number;
  period: string;
  validThrough: string;
  normalizedAddress: WashingtonAddress;
};

export async function resolveWashingtonRate(
  input: WashingtonAddress,
  fetcher: typeof fetch = fetch,
): Promise<WashingtonRateResolution> {
  const address = normalize(input);
  const url = new URL(ENDPOINT);
  for (const [key, value] of Object.entries({
    addr: address.addressLine,
    city: address.city,
    zip: address.zip,
    plus4: address.plus4 ?? "",
    output: "xml",
    ver: "3",
  }))
    url.searchParams.set(key, value);
  let response: Response;
  try {
    response = await fetcher(url, {
      method: "GET",
      headers: { Accept: "application/xml, text/xml" },
      redirect: "error",
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    throw unavailable("Washington tax service is unavailable");
  }
  const length = Number(response.headers.get("content-length"));
  const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
  if (
    !response.ok ||
    (Number.isFinite(length) && length > MAX_BYTES) ||
    !/^\s*(application|text)\/xml\b/.test(contentType)
  )
    throw unavailable("Washington tax service returned an invalid response");
  const xml = await response.text();
  if (xml.length > MAX_BYTES || /<!DOCTYPE|<!ENTITY/i.test(xml))
    throw unavailable("Washington tax service returned unsafe XML");
  return parseWashingtonRate(xml);
}

export function parseWashingtonRate(xml: string): WashingtonRateResolution {
  const roots = [...xml.matchAll(/<response\b([^>]*)>/gi)];
  const rates = [...xml.matchAll(/<rate\b([^>]*)\/?\s*>/gi)];
  const results = [...xml.matchAll(/<results\b([^>]*)\/?\s*>/gi)];
  if (
    roots.length !== 1 ||
    rates.length !== 1 ||
    results.length !== 1 ||
    /<!DOCTYPE|<!ENTITY/i.test(xml)
  )
    throw unavailable("Washington tax service returned ambiguous XML");
  const root = attributes(roots[0]![1]!);
  const rate = attributes(rates[0]![1]!);
  const located = attributes(results[0]![1]!);
  const result = integer(root.result);
  if (![0, 2, 4].includes(result))
    throw unavailable(`Washington address could not be resolved (status ${result})`);
  const total = decimalPpm(root.rate);
  const state = decimalPpm(rate.staterate);
  const local = decimalPpm(rate.localrate);
  if (state + local !== total) throw unavailable("Washington tax components do not reconcile");
  const period = required(rate.period, 16);
  const quarter = /^Q([1-4])(\d{4})$/.exec(period);
  if (!quarter) throw unavailable("Washington tax period is invalid");
  const endMonth = Number(quarter[1]) * 3;
  const validThrough = new Date(Date.UTC(Number(quarter[2]), endMonth, 1)).toISOString();
  return {
    status: result === 0 ? "resolved" : "correction_required",
    resultCode: result as 0 | 2 | 4,
    locationCode: required(root.loccode, 20),
    jurisdiction: required(rate.jurisdiction, 200),
    county: required(rate.county, 200),
    stateRatePpm: state,
    localRatePpm: local,
    totalRatePpm: total,
    period,
    validThrough,
    normalizedAddress: {
      addressLine: required(located.location, 255),
      city: required(located.city, 100),
      zip: zip(located.zip),
      plus4: plus4(located.plus4),
    },
  };
}

function normalize(input: WashingtonAddress): WashingtonAddress {
  return {
    addressLine: required(input.addressLine, 255),
    city: required(input.city, 100),
    zip: zip(input.zip),
    plus4: plus4(input.plus4 ?? ""),
  };
}
function attributes(source: string) {
  const result: Record<string, string> = {};
  for (const match of source.matchAll(/\b([a-z][a-z0-9]*)="([^"<>]*)"/gi)) {
    const key = match[1]!.toLowerCase();
    if (Object.hasOwn(result, key))
      throw unavailable("Washington tax response has duplicate attributes");
    result[key] = decode(match[2]!);
  }
  return result;
}
function decode(value: string) {
  const entities: Record<string, string> = {
    amp: "&",
    quot: '"',
    apos: "'",
    lt: "<",
    gt: ">",
  };
  return value
    .replace(/&(amp|quot|apos|lt|gt);/g, (_, name: string) => entities[name]!)
    .replace(/&#(\d+);/g, (_, value) => String.fromCodePoint(Number(value)));
}
function required(value: unknown, max: number) {
  if (typeof value !== "string") throw unavailable("Washington tax response is incomplete");
  const normalized = value.trim().replace(/\s+/g, " ");
  if (
    !normalized ||
    normalized.length > max ||
    [...normalized].some((character) => {
      const code = character.charCodeAt(0);
      return code < 32 || code === 127;
    })
  )
    throw unavailable("Washington tax response is invalid");
  return normalized;
}
function zip(value: unknown) {
  const result = required(value, 5);
  if (!/^\d{5}$/.test(result)) throw unavailable("Washington ZIP is invalid");
  return result;
}
function plus4(value: unknown) {
  if (value === "" || value === null || value === undefined) return null;
  const result = required(value, 4);
  if (!/^\d{4}$/.test(result)) throw unavailable("Washington ZIP+4 is invalid");
  return result;
}
function integer(value: unknown) {
  if (typeof value !== "string" || !/^\d$/.test(value))
    throw unavailable("Washington result code is invalid");
  return Number(value);
}
function decimalPpm(value: unknown) {
  if (typeof value !== "string" || !/^(?:0|1)?\.\d{1,6}$/.test(value))
    throw unavailable("Washington rate is invalid");
  const [whole = "0", fraction = ""] = value.split(".");
  const result = Number(whole || "0") * 1_000_000 + Number(fraction.padEnd(6, "0"));
  if (!Number.isSafeInteger(result) || result < 0 || result > 1_000_000)
    throw unavailable("Washington rate is invalid");
  return result;
}
function unavailable(message: string) {
  return new ApiError(503, "checkout_tax_address_rate_unavailable", message);
}
