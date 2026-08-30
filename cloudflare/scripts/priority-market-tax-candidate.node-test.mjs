import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

import { buildPriorityMarketCandidate } from "./priority-market-tax-candidate.mjs";

const snapshot = JSON.parse(
  await readFile(
    new URL("../fixtures/indirect-tax/eu-tedb-standard-rates-2026-08-31.json", import.meta.url),
    "utf8",
  ),
);

test("builds a validated draft for the six priority market groups", () => {
  const artifact = buildPriorityMarketCandidate(snapshot);
  assert.equal(artifact.status, "draft");
  assert.equal(artifact.version, 2);
  assert.ok(Date.parse(artifact.effective_from) <= Date.parse(snapshot.retrieved_at));
  assert.ok(Date.parse(artifact.refreshed_at) <= Date.parse(snapshot.retrieved_at));
  assert.equal(artifact.rules.length, 64);
  assert.deepEqual(
    [...new Set(artifact.rules.map((rule) => rule.country))],
    [
      "AT",
      "BE",
      "BG",
      "CH",
      "CY",
      "CZ",
      "DE",
      "DK",
      "EE",
      "ES",
      "FI",
      "FR",
      "GB",
      "GR",
      "HR",
      "HU",
      "IE",
      "IN",
      "IT",
      "KR",
      "LT",
      "LU",
      "LV",
      "MT",
      "MX",
      "NL",
      "PL",
      "PT",
      "RO",
      "SE",
      "SI",
      "SK",
    ],
  );
  assert.match(artifact.content_sha256, /^[a-f0-9]{64}$/);
  assert.deepEqual([...new Set(artifact.rules.map((rule) => rule.product_tax_code))].sort(), [
    "txcd_10103100",
    "txcd_10202000",
  ]);
  assert.ok(artifact.rules.every((rule) => !Object.hasOwn(rule, "registration_scope")));
});

test("uses the checked TEDB snapshot and the expected non-EU authority rates", () => {
  const artifact = buildPriorityMarketCandidate(snapshot);
  const rates = Object.fromEntries(
    artifact.rules
      .filter((rule) => rule.product_tax_code === "txcd_10103100")
      .map((rule) => [rule.country, rule.rate_ppm]),
  );
  assert.equal(rates.DE, 190_000);
  assert.equal(rates.GB, 200_000);
  assert.equal(rates.IN, 180_000);
  assert.equal(rates.KR, 100_000);
  assert.equal(rates.MX, 160_000);
  assert.equal(rates.CH, 81_000);
});
