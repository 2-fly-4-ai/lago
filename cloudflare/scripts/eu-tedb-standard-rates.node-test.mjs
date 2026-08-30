import assert from "node:assert/strict";
import { test } from "node:test";

import {
  buildTedbRequest,
  parseTedbStandardRates,
  retrieveTedbStandardRates,
  validateTedbSnapshot,
} from "./eu-tedb-standard-rates.mjs";

const countries = [
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

function responseXml(selected = countries) {
  const results = selected
    .map(
      (country, index) => `<vatRateResults>
        <memberState>${country}</memberState>
        <type>STANDARD</type>
        <rate><type>DEFAULT</type><value>${index % 2 === 0 ? "20.0" : "21.5"}</value></rate>
        <situationOn>2026-01-01+01:00</situationOn>
      </vatRateResults>`,
    )
    .join("");
  const regional = `<vatRateResults>
    <memberState>DE</memberState>
    <type>STANDARD</type>
    <rate><type>DEFAULT</type><value>19.0</value></rate>
    <situationOn>2026-01-01+01:00</situationOn>
    <category><identifier>REGION</identifier><description>Special region</description></category>
  </vatRateResults>`;
  const importSpecific = `<vatRateResults>
    <memberState>DE</memberState>
    <type>STANDARD</type>
    <rate><type>DEFAULT</type><value>19.0</value></rate>
    <situationOn>2026-01-01+01:00</situationOn>
    <comment>VAT - Import -</comment>
  </vatRateResults>`;
  return `<env:Envelope xmlns:env="http://schemas.xmlsoap.org/soap/envelope/"><env:Body><retrieveVatRatesRespMsg>${results}${regional}${importSpecific}</retrieveVatRatesRespMsg></env:Body></env:Envelope>`;
}

test("builds a bounded request for every EU member state", () => {
  const xml = buildTedbRequest("2026-08-31");
  assert.equal([...xml.matchAll(/<types:isoCode>/g)].length, 27);
  assert.match(xml, /<types:isoCode>EL<\/types:isoCode>/);
  assert.match(xml, /<types:situationOn>2026-08-31<\/types:situationOn>/);
  assert.throws(() => buildTedbRequest("2026-02-30"), /invalid/);
});

test("parses exactly one standard rate per member state and maps EL to GR", () => {
  const snapshot = parseTedbStandardRates(responseXml(), "2026-08-31", "2026-08-31T02:00:00.000Z");
  assert.equal(snapshot.rates.length, 27);
  assert.equal(snapshot.rates.find((rate) => rate.country === "GR")?.source_member_state, "EL");
  assert.deepEqual(
    snapshot.rates.find((rate) => rate.country === "AT"),
    {
      country: "AT",
      source_member_state: "AT",
      rate_percent: "20",
      rate_ppm: 200000,
      effective_from: "2026-01-01",
    },
  );
  assert.match(snapshot.response_sha256, /^[a-f0-9]{64}$/);
});

test("fails closed on incomplete coverage, duplicates, faults, and invalid rates", () => {
  assert.throws(
    () =>
      parseTedbStandardRates(
        responseXml(countries.slice(1)),
        "2026-08-31",
        "2026-08-31T02:00:00.000Z",
      ),
    /coverage mismatch/,
  );
  assert.throws(
    () =>
      parseTedbStandardRates(
        responseXml([...countries, "AT"]),
        "2026-08-31",
        "2026-08-31T02:00:00.000Z",
      ),
    /ambiguous/,
  );
  assert.throws(
    () =>
      parseTedbStandardRates(
        "<faultstring>Unavailable</faultstring>",
        "2026-08-31",
        "2026-08-31T02:00:00.000Z",
      ),
    /SOAP fault/,
  );
  assert.throws(
    () =>
      parseTedbStandardRates(
        responseXml().replace("20.0", "20.12345"),
        "2026-08-31",
        "2026-08-31T02:00:00.000Z",
      ),
    /invalid rate/,
  );
});

test("uses only the fixed public endpoint and expected SOAP headers", async () => {
  const calls = [];
  const snapshot = await retrieveTedbStandardRates("2026-08-31", {
    retrievedAt: "2026-08-31T02:00:00.000Z",
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return new Response(responseXml(), {
        status: 200,
        headers: { "Content-Type": "text/xml" },
      });
    },
  });
  assert.equal(snapshot.rates.length, 27);
  assert.equal(calls[0].url, "https://ec.europa.eu/taxation_customs/tedb/ws/");
  assert.equal(calls[0].init.method, "POST");
  assert.equal(calls[0].init.redirect, "error");
  assert.match(calls[0].init.headers.SOAPAction, /RetrieveVatRates/);
});

test("validates the canonical offline snapshot contract and exact country order", () => {
  const snapshot = parseTedbStandardRates(responseXml(), "2026-08-31", "2026-08-31T02:00:00.000Z");
  assert.equal(validateTedbSnapshot(snapshot), snapshot);
  assert.throws(() => validateTedbSnapshot({ ...snapshot, extra: true }), /fields are invalid/);
  assert.throws(
    () => validateTedbSnapshot({ ...snapshot, rates: snapshot.rates.toReversed() }),
    /coverage\/order mismatch/,
  );
});
