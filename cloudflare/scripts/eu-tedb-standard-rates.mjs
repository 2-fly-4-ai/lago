import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

const ENDPOINT = "https://ec.europa.eu/taxation_customs/tedb/ws/";
const WSDL = "https://ec.europa.eu/taxation_customs/tedb/ws/VatRetrievalService.wsdl";
const SOAP_ACTION = "urn:ec.europa.eu:taxud:tedb:services:v1:VatRetrievalService/RetrieveVatRates";
const MEMBER_STATES = [
  "AT",
  "BE",
  "BG",
  "CY",
  "CZ",
  "DE",
  "DK",
  "EE",
  "EL",
  "ES",
  "FI",
  "FR",
  "HR",
  "HU",
  "IE",
  "IT",
  "LT",
  "LU",
  "LV",
  "MT",
  "NL",
  "PL",
  "PT",
  "RO",
  "SE",
  "SI",
  "SK",
];

export function buildTedbRequest(situationOn) {
  dateOnly(situationOn);
  const memberStates = MEMBER_STATES.map(
    (country) => `<types:isoCode>${country}</types:isoCode>`,
  ).join("");
  return `<?xml version="1.0" encoding="UTF-8"?>
<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:service="urn:ec.europa.eu:taxud:tedb:services:v1:IVatRetrievalService" xmlns:types="urn:ec.europa.eu:taxud:tedb:services:v1:IVatRetrievalService:types">
  <soapenv:Header/>
  <soapenv:Body>
    <service:retrieveVatRatesReqMsg>
      <types:memberStates>${memberStates}</types:memberStates>
      <types:situationOn>${situationOn}</types:situationOn>
    </service:retrieveVatRatesReqMsg>
  </soapenv:Body>
</soapenv:Envelope>`;
}

export function parseTedbStandardRates(xml, situationOn, retrievedAt) {
  dateOnly(situationOn);
  canonicalTimestamp(retrievedAt);
  if (typeof xml !== "string" || xml.length === 0 || xml.length > 5 * 1024 * 1024) {
    throw new Error("TEDB response size is invalid");
  }
  const fault = firstTag(xml, "faultstring");
  if (fault) throw new Error(`TEDB SOAP fault: ${fault}`);
  const blocks = elements(xml, "vatRateResults");
  const rates = [];
  for (const block of blocks) {
    if (firstTag(block, "type") !== "STANDARD") continue;
    const rateBlock = elements(block, "rate")[0];
    if (!rateBlock || firstTag(rateBlock, "type") !== "DEFAULT") continue;
    const categoryBlock = elements(block, "category")[0];
    const categoryIdentifier = categoryBlock ? firstTag(categoryBlock, "identifier") : null;
    const hasProductCodes =
      elements(block, "cnCodes").length > 0 || elements(block, "cpaCodes").length > 0;
    const comment = firstTag(block, "comment");
    if (categoryIdentifier || hasProductCodes) continue;
    const sourceMemberState = firstTag(block, "memberState");
    const effectiveFromValue = firstTag(block, "situationOn");
    const ratePercent = firstTag(rateBlock, "value");
    if (!sourceMemberState || !effectiveFromValue || !ratePercent) {
      throw new Error("TEDB standard-rate record is incomplete");
    }
    if (!MEMBER_STATES.includes(sourceMemberState)) {
      throw new Error(`TEDB returned unexpected member state ${sourceMemberState}`);
    }
    const effectiveFrom = normalizeXsdDate(effectiveFromValue);
    rates.push({
      country: sourceMemberState === "EL" ? "GR" : sourceMemberState,
      source_member_state: sourceMemberState,
      rate_percent: canonicalPercent(ratePercent),
      rate_ppm: percentToPpm(ratePercent),
      effective_from: effectiveFrom,
      comment,
    });
  }
  const expectedCountries = MEMBER_STATES.map((country) =>
    country === "EL" ? "GR" : country,
  ).sort();
  const selectedRates = [];
  for (const country of expectedCountries) {
    const candidates = rates.filter((rate) => rate.country === country);
    if (candidates.length === 1) {
      selectedRates.push(candidates[0]);
      continue;
    }
    if (candidates.length > 1) {
      const unqualified = candidates.filter((rate) => rate.comment === null);
      if (unqualified.length === 1) {
        selectedRates.push(unqualified[0]);
        continue;
      }
      throw new Error(
        `TEDB national standard rate is ambiguous for ${country}: ${JSON.stringify(candidates)}`,
      );
    }
  }
  selectedRates.sort((left, right) => left.country.localeCompare(right.country));
  const actualCountries = selectedRates.map((rate) => rate.country);
  if (JSON.stringify(actualCountries) !== JSON.stringify(expectedCountries)) {
    throw new Error(
      `TEDB standard-rate coverage mismatch: expected ${expectedCountries.join(",")}; received ${actualCountries.join(",")}`,
    );
  }
  return validateTedbSnapshot({
    format: "eu-tedb-standard-rates/v1",
    source_url: WSDL,
    situation_on: situationOn,
    retrieved_at: retrievedAt,
    response_sha256: createHash("sha256").update(xml).digest("hex"),
    rates: selectedRates.map(({ comment: _comment, ...rate }) => rate),
  });
}

export function validateTedbSnapshot(snapshot) {
  if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) {
    throw new Error("TEDB snapshot must be an object");
  }
  exactKeys(snapshot, [
    "format",
    "rates",
    "response_sha256",
    "retrieved_at",
    "situation_on",
    "source_url",
  ]);
  if (snapshot.format !== "eu-tedb-standard-rates/v1") {
    throw new Error("TEDB snapshot format is unsupported");
  }
  if (snapshot.source_url !== WSDL) throw new Error("TEDB snapshot source URL is invalid");
  dateOnly(snapshot.situation_on);
  canonicalTimestamp(snapshot.retrieved_at);
  if (!/^[a-f0-9]{64}$/.test(snapshot.response_sha256)) {
    throw new Error("TEDB snapshot response checksum is invalid");
  }
  if (!Array.isArray(snapshot.rates)) throw new Error("TEDB snapshot rates must be an array");
  const expectedCountries = MEMBER_STATES.map((country) =>
    country === "EL" ? "GR" : country,
  ).sort();
  const actualCountries = [];
  for (const rate of snapshot.rates) {
    if (!rate || typeof rate !== "object" || Array.isArray(rate)) {
      throw new Error("TEDB snapshot rate must be an object");
    }
    exactKeys(rate, [
      "country",
      "effective_from",
      "rate_percent",
      "rate_ppm",
      "source_member_state",
    ]);
    if (!MEMBER_STATES.includes(rate.source_member_state)) {
      throw new Error(
        `TEDB snapshot has unexpected member state ${String(rate.source_member_state)}`,
      );
    }
    const expectedCountry = rate.source_member_state === "EL" ? "GR" : rate.source_member_state;
    if (rate.country !== expectedCountry) {
      throw new Error(`TEDB snapshot country mapping is invalid for ${rate.source_member_state}`);
    }
    const percent = canonicalPercent(rate.rate_percent);
    if (rate.rate_percent !== percent || rate.rate_ppm !== percentToPpm(percent)) {
      throw new Error(`TEDB snapshot rate is inconsistent for ${rate.country}`);
    }
    dateOnly(rate.effective_from);
    actualCountries.push(rate.country);
  }
  if (JSON.stringify(actualCountries) !== JSON.stringify(expectedCountries)) {
    throw new Error(
      `TEDB snapshot coverage/order mismatch: expected ${expectedCountries.join(",")}; received ${actualCountries.join(",")}`,
    );
  }
  return snapshot;
}

export async function retrieveTedbStandardRates(
  situationOn,
  { fetchImpl = fetch, retrievedAt = new Date().toISOString() } = {},
) {
  const response = await fetchImpl(ENDPOINT, {
    method: "POST",
    redirect: "error",
    signal: AbortSignal.timeout(20_000),
    headers: {
      Accept: "text/xml",
      "Content-Type": "text/xml; charset=utf-8",
      SOAPAction: `"${SOAP_ACTION}"`,
      "User-Agent": "serp-lago-tax-data/1.0",
    },
    body: buildTedbRequest(situationOn),
  });
  if (!response.ok) throw new Error(`TEDB request failed with HTTP ${response.status}`);
  const contentLength = Number(response.headers.get("content-length") ?? 0);
  if (contentLength > 5 * 1024 * 1024) throw new Error("TEDB response is too large");
  const xml = await response.text();
  return parseTedbStandardRates(xml, situationOn, retrievedAt);
}

function elements(xml, localName) {
  const escaped = localName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const expression = new RegExp(
    `<(?:[A-Za-z_][\\w.-]*:)?${escaped}(?:\\s[^>]*)?>([\\s\\S]*?)</(?:[A-Za-z_][\\w.-]*:)?${escaped}\\s*>`,
    "gi",
  );
  return [...xml.matchAll(expression)].map((match) => match[1]);
}

function firstTag(xml, localName) {
  const value = elements(xml, localName)[0];
  return value === undefined ? null : decodeXml(value.replace(/<[^>]+>/g, "").trim());
}

function decodeXml(value) {
  return value
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&apos;", "'")
    .replaceAll("&amp;", "&");
}

function canonicalPercent(value) {
  if (!/^(?:0|[1-9]\d?)(?:\.\d{1,4})?$/.test(value)) {
    throw new Error(`TEDB returned invalid rate ${value}`);
  }
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric < 0 || numeric > 100) {
    throw new Error(`TEDB returned out-of-range rate ${value}`);
  }
  return numeric.toString();
}

function percentToPpm(value) {
  const [whole, fraction = ""] = value.split(".");
  const basis = Number(whole) * 10_000 + Number(fraction.padEnd(4, "0"));
  if (!Number.isSafeInteger(basis) || basis < 0 || basis > 1_000_000) {
    throw new Error(`TEDB returned invalid rate ${value}`);
  }
  return basis;
}

function dateOnly(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new Error("TEDB situation date must use YYYY-MM-DD");
  }
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
    throw new Error("TEDB situation date is invalid");
  }
}

function normalizeXsdDate(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}(?:Z|[+-]\d{2}:\d{2})?$/.test(value)) {
    throw new Error(`TEDB returned invalid effective date ${String(value)}`);
  }
  const date = value.slice(0, 10);
  dateOnly(date);
  return date;
}

function canonicalTimestamp(value) {
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== value) {
    throw new Error("retrievedAt must be a canonical UTC ISO timestamp");
  }
}

function exactKeys(value, expected) {
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  if (JSON.stringify(actual) !== JSON.stringify(sortedExpected)) {
    throw new Error(`TEDB snapshot fields are invalid: ${actual.join(",")}`);
  }
}

async function main() {
  if (process.argv[2] === "validate") {
    const input = process.argv[3];
    if (!input) throw new Error("Usage: eu-tedb-standard-rates.mjs validate SNAPSHOT.json");
    validateTedbSnapshot(JSON.parse(await readFile(input, "utf8")));
    process.stdout.write(`${input}: valid\n`);
    return;
  }
  const dateIndex = process.argv.indexOf("--date");
  const situationOn = dateIndex >= 0 ? process.argv[dateIndex + 1] : undefined;
  if (!situationOn) throw new Error("Usage: eu-tedb-standard-rates.mjs --date YYYY-MM-DD");
  const snapshot = await retrieveTedbStandardRates(situationOn);
  process.stdout.write(`${JSON.stringify(snapshot, null, 2)}\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
