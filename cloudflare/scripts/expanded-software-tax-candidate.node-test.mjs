import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import {
  buildExpandedSoftwareCandidate,
  validateExpansion,
} from "./expanded-software-tax-candidate.mjs";
import { renderDraftSql } from "./indirect-tax-rule-set.mjs";
const read = async (name) =>
  JSON.parse(await readFile(new URL(`../fixtures/indirect-tax/${name}`, import.meta.url), "utf8"));
const evidence = await read("software-rate-expansion-2026-09-06.json");
const tedb = await read("eu-tedb-standard-rates-2026-08-31.json");
const AUDIT_DATE = "2026-09-06";
const build = (value = evidence) => buildExpandedSoftwareCandidate(tedb, value, AUDIT_DATE);

test("60-country, 120-rule expansion stays a checksummed draft with original freshness", () => {
  const artifact = build();
  assert.equal(new Set(artifact.rules.map((rule) => rule.country)).size, 60);
  assert.equal(artifact.rules.length, 120);
  assert.equal(artifact.version, 18);
  assert.equal(artifact.status, "draft");
  assert.equal(
    artifact.refreshed_at,
    tedb.retrieved_at < "2026-08-30T12:50:51.354Z" ? tedb.retrieved_at : "2026-08-30T12:50:51.354Z",
  );
  assert.equal(build().content_sha256, artifact.content_sha256);
  const sql = renderDraftSql(artifact, "2026-09-06T13:00:00.000Z");
  assert.doesNotMatch(sql, /UPDATE |INSERT INTO indirect_tax_registration_scopes/);
});

test("software classifications share verified rates, not assumptions about billing cadence", () => {
  const artifact = build();
  const expected = {
    AU: 100000,
    NZ: 150000,
    NO: 250000,
    SG: 90000,
    AE: 50000,
    MY: 80000,
    PH: 120000,
    ZA: 150000,
    CL: 190000,
    IS: 240000,
    KE: 160000,
    JP: 100000,
    AR: 210000,
    CO: 190000,
    TH: 70000,
    TW: 50000,
    TR: 200000,
    SA: 150000,
    UA: 200000,
    CR: 130000,
    ID: 110000,
    RS: 200000,
    KZ: 160000,
    PE: 180000,
    NG: 75000,
    MA: 200000,
    EG: 140000,
    EC: 150000,
  };
  for (const [country, rate] of Object.entries(expected)) {
    const rules = artifact.rules.filter((rule) => rule.country === country);
    assert.deepEqual(rules.map((rule) => rule.product_tax_code).sort(), [
      "txcd_10103100",
      "txcd_10202000",
    ]);
    assert.ok(
      rules.every((rule) => rule.rate_ppm === rate && rule.source_reference.includes("DRAFT ONLY")),
    );
    assert.ok(rules.every((rule) => !/monthly|one.time|recurring/i.test(rule.id)));
  }
});

test("rechecking does not redate evidence or change immutable artifact content", () => {
  assert.throws(
    () =>
      buildExpandedSoftwareCandidate(
        { ...tedb, retrieved_at: "2026-09-07T12:00:00.000Z" },
        evidence,
        "2026-09-06",
      ),
    /Future/,
  );
  assert.deepEqual(buildExpandedSoftwareCandidate(tedb, evidence, "2026-09-06"), build());
  assert.throws(
    () => buildExpandedSoftwareCandidate(tedb, evidence, "2026-10-01"),
    /stale retained/,
  );
});

test("US partial rates, Canadian components and no-tax/general-rate evidence never become rules", () => {
  const artifact = build();
  for (const country of ["US", "CA", "HK", "FJ"])
    assert.ok(!artifact.rules.some((rule) => rule.country === country));
  const canada = evidence.held_regions.find((row) => row.country === "CA");
  assert.equal(Object.keys(canada.federal_rates_ppm).length, 13);
  assert.equal(canada.federal_rates_ppm.NS, 140000);
  assert.equal(canada.federal_rates_ppm.BC, 50000); // Not GST + PST.
  const bad = structuredClone(evidence);
  bad.markets[0].country = "US";
  assert.throws(() => build(bad), /Unsupported/);
});

test("rejects future/stale evidence, zero rates, invalid dates, duplicates and activation", () => {
  assert.throws(() => validateExpansion(evidence, "2026-09-04"), /Future/);
  assert.throws(() => validateExpansion(evidence, "2026-10-06"), /stale/);
  assert.throws(() => validateExpansion(evidence, "2026-02-30"), /date/);
  for (const patch of [{ rate_ppm: 0 }, { rate_ppm: 0.5 }, { observed_on: "2026-02-30" }]) {
    const bad = structuredClone(evidence);
    Object.assign(bad.markets[0], patch);
    assert.throws(() => build(bad));
  }
  const duplicate = structuredClone(evidence);
  duplicate.markets.push(duplicate.markets[0]);
  assert.throws(() => build(duplicate), /duplicate/);
  assert.throws(() => build({ ...evidence, activation_allowed: true }), /review-only/);
});

test("rejects spoofed authority domains, Stripe, credentials and insecure source URLs", () => {
  for (const url of [
    "https://ato.gov.au.evil.example/tax",
    "https://stripe.com/tax",
    "https://user:secret@ato.gov.au/tax",
    "http://ato.gov.au/tax",
  ]) {
    const bad = structuredClone(evidence);
    bad.markets[0].rate_url = url;
    assert.throws(() => build(bad), /authority host/);
  }
});
