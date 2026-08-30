import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import {
  contentChecksum,
  parseRuleSetArtifact,
  renderDraftSql,
  validateRuleSetArtifact,
} from "./indirect-tax-rule-set.mjs";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const candidatePath = resolve(
  scriptDirectory,
  "../fixtures/indirect-tax/candidate-2026-08-31.json",
);

function candidate() {
  return JSON.parse(readFileSync(candidatePath, "utf8"));
}

function rehash(artifact) {
  artifact.content_sha256 = contentChecksum(artifact);
  return artifact;
}

test("the official-authority candidate is canonical and checksummed", () => {
  const artifact = parseRuleSetArtifact(readFileSync(candidatePath, "utf8"));
  assert.equal(artifact.status, "draft");
  assert.deepEqual(
    artifact.rules.map((rule) => rule.country),
    ["AU", "GB", "NZ"],
  );
});

test("checksum is independent of component and rule ordering", () => {
  const artifact = candidate();
  const expected = contentChecksum(artifact);
  artifact.source.components.reverse();
  artifact.rules.reverse();
  assert.equal(contentChecksum(artifact), expected);
});

test("validation rejects activation and registration data", () => {
  const artifact = rehash({ ...candidate(), status: "active" });
  assert.throws(() => validateRuleSetArtifact(artifact), /artifact.status must equal draft/);
  const extra = candidate();
  extra.registration_scopes = [];
  assert.throws(() => validateRuleSetArtifact(extra), /artifact keys must be exactly/);
});

test("validation rejects a changed payload with an old checksum", () => {
  const artifact = candidate();
  artifact.rules[0].rate_ppm += 1;
  assert.throws(() => validateRuleSetArtifact(artifact), /content_sha256 mismatch/);
});

test("SQL rendering creates only immutable draft rows and escapes source text", () => {
  const artifact = candidate();
  artifact.rules[0].source_reference = "Authority's published standard rate";
  rehash(artifact);
  const sql = renderDraftSql(artifact, "2026-08-31T01:00:00.000Z");
  assert.match(sql, /'draft'/);
  assert.match(sql, /Authority''s published standard rate/);
  assert.doesNotMatch(sql, /indirect_tax_registration_scopes/);
  assert.doesNotMatch(sql, /'active'/);
  assert.doesNotMatch(sql, /activated_at\)\s*VALUES[\s\S]*CURRENT_TIMESTAMP/);
});
