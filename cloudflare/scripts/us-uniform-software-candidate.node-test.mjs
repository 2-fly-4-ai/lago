import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { buildPriorityMarketCandidate } from "./priority-market-tax-candidate.mjs";
import { addUSUniformSoftwareRules } from "./us-uniform-software-candidate.mjs";
const fixture = JSON.parse(
  await readFile(
    new URL("../fixtures/indirect-tax/eu-tedb-standard-rates-2026-08-31.json", import.meta.url),
    "utf8",
  ),
);
const base = buildPriorityMarketCandidate(fixture);

test("adds only supported state and delivery combinations, not a national fallback", () => {
  const result = addUSUniformSoftwareRules(base, "2026-09-05");
  assert.equal(result.version, 21);
  assert.match(result.id, /-v21$/);
  const rules = result.rules.filter((r) => r.country === "US");
  assert.equal(rules.length, 5);
  assert.ok(rules.every((r) => r.region && r.postal_prefix === null));
  assert.ok(rules.filter((r) => r.region === "CT").every((r) => r.rate_ppm === 63500));
  const california = rules.find((r) => r.region === "CA");
  assert.equal(california.product_tax_code, "txcd_10202000");
  assert.equal(california.taxability, "exempt");
  assert.equal(california.rate_ppm, 0);
  const washington = rules.filter((r) => r.region === "WA");
  assert.equal(washington.length, 2);
  assert.ok(
    washington.every((r) => r.rate_ppm === 65000 && r.calculation_method === "wa_dor_address"),
  );
  assert.equal(
    base.rules.some((r) => r.country === "US"),
    false,
  );
});

test("rejects stale or future evidence and merging over existing US rules", () => {
  for (const date of ["2026-09-04", "2026-10-06", "2026-09-31", "bad"])
    assert.throws(() => addUSUniformSoftwareRules(base, date), /fresh review/);
  assert.throws(
    () => addUSUniformSoftwareRules(addUSUniformSoftwareRules(base, "2026-09-05"), "2026-09-05"),
    /already present/,
  );
});
