import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { addCanadianSoftwareRules } from "./canada-software-candidate.mjs";
import { buildExpandedSoftwareCandidate } from "./expanded-software-tax-candidate.mjs";
import { addNoSalesTaxSoftwareRules } from "./no-sales-tax-software-candidate.mjs";
import { buildPriorityMarketCandidate } from "./priority-market-tax-candidate.mjs";
import {
  addUSUniformSoftwareRules,
  addUSUniformSoftwareRulesV21,
} from "./us-uniform-software-candidate.mjs";
const read = async (name) =>
  JSON.parse(await readFile(new URL(`../fixtures/indirect-tax/${name}`, import.meta.url), "utf8"));
const fixture = await read("eu-tedb-standard-rates-2026-08-31.json");
const base = buildPriorityMarketCandidate(fixture);

test("adds only supported state and delivery combinations, not a national fallback", () => {
  const result = addUSUniformSoftwareRules(base, "2026-09-05");
  assert.equal(result.version, 22);
  assert.match(result.id, /-v22$/);
  assert.equal(result.effective_from, result.rules.map((rule) => rule.effective_from).sort()[0]);
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

test("final v22 rule ids cannot collide with either deployed baseline", async () => {
  const expanded = buildExpandedSoftwareCandidate(
    fixture,
    await read("software-rate-expansion-2026-09-06.json"),
    "2026-09-06",
  );
  const canada = addCanadianSoftwareRules(
    expanded,
    await read("canada-software-components-2026-09-06.json"),
    "2026-09-06",
  );
  const noSalesTax = addNoSalesTaxSoftwareRules(
    canada,
    await read("no-sales-tax-software-2026-09-06.json"),
    "2026-09-06",
  );
  const final = addUSUniformSoftwareRules(noSalesTax, "2026-09-06");
  const deployedV21 = addUSUniformSoftwareRulesV21(noSalesTax, "2026-09-06");
  assert.equal(
    deployedV21.content_sha256,
    "c64a6f4207b9da659f43c06e575c08877bba788319ed796fcdea0e2b653eeb5c",
  );
  const deployedIds = new Set([...base.rules, ...deployedV21.rules].map((rule) => rule.id));
  assert.equal(final.rules.length, 157);
  assert.ok(final.rules.every((rule) => /^tax-rule-v22-[a-f0-9]{16}$/.test(rule.id)));
  assert.ok(final.rules.every((rule) => !deployedIds.has(rule.id)));
});
