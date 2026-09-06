import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { buildExpandedSoftwareCandidate } from "./expanded-software-tax-candidate.mjs";
import { addNoSalesTaxSoftwareRules } from "./no-sales-tax-software-candidate.mjs";
const read = async (name) =>
  JSON.parse(await readFile(new URL(`../fixtures/indirect-tax/${name}`, import.meta.url), "utf8"));
const AUDIT_DATE = "2026-09-06";
const base = buildExpandedSoftwareCandidate(
  await read("eu-tedb-standard-rates-2026-08-31.json"),
  await read("software-rate-expansion-2026-09-06.json"),
  AUDIT_DATE,
);
const evidence = await read("no-sales-tax-software-2026-09-06.json");

test("adds explicit exemptions for both software delivery codes", () => {
  const result = addNoSalesTaxSoftwareRules(base, evidence, AUDIT_DATE);
  assert.equal(result.version, 20);
  for (const country of ["HK", "QA", "VN"]) {
    const rules = result.rules.filter((r) => r.country === country);
    assert.equal(rules.length, 2);
    assert.ok(
      rules.every((r) => r.taxability === "exempt" && r.rate_ppm === 0 && r.region === null),
    );
    assert.ok(rules.every((r) => /not a missing-rate fallback/.test(r.source_reference)));
  }
});

test("rejects stale, activated, duplicate, spoofed and overlapping evidence", () => {
  for (const bad of [
    { ...evidence, activation_allowed: true },
    { ...evidence, markets: [...evidence.markets, evidence.markets[0]] },
    {
      ...evidence,
      markets: [{ ...evidence.markets[0], url: "https://www.fstb.gov.hk.evil.example/" }],
    },
  ])
    assert.throws(() => addNoSalesTaxSoftwareRules(base, bad, AUDIT_DATE));
  assert.throws(() => addNoSalesTaxSoftwareRules(base, evidence, "2026-10-06"));
  const once = addNoSalesTaxSoftwareRules(base, evidence, AUDIT_DATE);
  assert.throws(() => addNoSalesTaxSoftwareRules(once, evidence, AUDIT_DATE));
});
