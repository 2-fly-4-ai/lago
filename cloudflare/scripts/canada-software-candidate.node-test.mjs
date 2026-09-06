import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { buildExpandedSoftwareCandidate } from "./expanded-software-tax-candidate.mjs";
import { addCanadianSoftwareRules, renderCanadianDraftSql } from "./canada-software-candidate.mjs";
import { contentChecksum, renderDraftSql } from "./indirect-tax-rule-set.mjs";
const read = (name) =>
  JSON.parse(readFileSync(new URL(`../fixtures/indirect-tax/${name}`, import.meta.url), "utf8"));
const evidence = read("canada-software-components-2026-09-06.json");
const base = buildExpandedSoftwareCandidate(
  read("eu-tedb-standard-rates-2026-08-31.json"),
  read("software-rate-expansion-2026-09-06.json"),
  "2026-09-06",
);
const build = (value = evidence, day = "2026-09-06") => addCanadianSoftwareRules(base, value, day);

test("61-country candidate includes 26 Canadian classification rules and only draft SQL", () => {
  const result = build();
  assert.equal(new Set(result.rules.map((r) => r.country)).size, 61);
  assert.equal(result.rules.length, 146);
  assert.equal(result.version, 19);
  assert.equal(result.status, "draft");
  assert.deepEqual(build(evidence, "2026-09-05"), result);
  assert.equal(result.refreshed_at, base.refreshed_at);
  assert.deepEqual(build(evidence, "2026-09-07"), result);
  const sql = renderCanadianDraftSql(result, "2026-09-06T01:00:00.000Z");
  assert.equal((sql.match(/INSERT INTO indirect_tax_rule_components\(/g) || []).length, 34);
  assert.doesNotMatch(sql, /UPDATE |INSERT INTO indirect_tax_registration_scopes/);
  assert.throws(() => renderDraftSql(result, "2026-09-06T01:00:00.000Z"), /renderCanadianDraftSql/);
});
test("components participate in the artifact checksum", () => {
  const changed = structuredClone(evidence);
  changed.regions[1].components[1].rate_ppm = 60000;
  assert.notEqual(build(changed).content_sha256, build().content_sha256);
});
test("rejects missing provinces, stale/future evidence, impossible dates and activation", () => {
  for (const patch of [
    { regions: evidence.regions.slice(1) },
    { activation_allowed: true },
    { observed_on: "2026-02-30" },
    { observed_on: "2026-09-07" },
  ])
    assert.throws(() => build({ ...evidence, ...patch }));
  assert.throws(() => build(evidence, "2026-02-30"));
  assert.throws(() => build(evidence, "2026-10-07"));
  assert.throws(() => addCanadianSoftwareRules(build(), evidence, "2026-09-06"));
});
test("rejects incomplete or spoofed authority sources", () => {
  for (const url of [
    "https://www.canada.ca.evil.example/tax",
    "http://www.canada.ca/tax",
    "https://user:secret@www.canada.ca/tax",
  ])
    assert.throws(() => build({ ...evidence, sources: { ...evidence.sources, federal: url } }));
  const bad = structuredClone(evidence);
  delete bad.sources.BC;
  assert.throws(() => build(bad));
});
test("rejects invalid, duplicate or mixed HST components even in checksummed imports", () => {
  for (const components of [
    [],
    [{ code: "GST", rate_ppm: 0 }],
    [
      { code: "GST", rate_ppm: 50000 },
      { code: "GST", rate_ppm: 50000 },
    ],
    [
      { code: "GST", rate_ppm: 50000 },
      { code: "HST", rate_ppm: 50000 },
    ],
  ]) {
    const bad = structuredClone(evidence);
    bad.regions[0].components = components;
    assert.throws(() => build(bad));
  }
  const bad = build();
  const rule = bad.rules.find((r) => r.country === "CA");
  rule.rate_ppm = 100000;
  rule.source_reference =
    "canada-components:" +
    JSON.stringify([
      { code: "GST", rate_ppm: 50000, source_component_id: "canada-federal" },
      { code: "HST", rate_ppm: 50000, source_component_id: "canada-federal" },
    ]);
  bad.content_sha256 = contentChecksum(bad);
  assert.throws(() => renderCanadianDraftSql(bad, "2026-09-06T01:00:00.000Z"));
});
