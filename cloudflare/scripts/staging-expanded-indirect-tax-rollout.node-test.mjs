import assert from "node:assert/strict";
import { test } from "node:test";

import {
  buildStagingExpandedCandidate,
  renderExpandedStagingActivationSql,
  validateReviewDate,
} from "./staging-expanded-indirect-tax-rollout.mjs";

const built = await buildStagingExpandedCandidate("2026-09-06");
const options = {
  acknowledgement: "STAGING_SYNTHETIC_ONLY",
  activatedAt: "2026-09-06T12:00:00.000Z",
  organizationId: "org-synthetic-e2e-20260815-001",
};

test("renders guarded synthetic-only v21-to-v22 staging activation", () => {
  const sql = renderExpandedStagingActivationSql(built.previous, built.candidate, options);
  assert.match(sql, /staging_activation_preflight/);
  assert.match(sql, /software-us-partial-candidate-2026-09-06-v22/);
  assert.match(sql, /software-us-partial-candidate-2026-09-06-v21/);
  assert.match(sql, /c64a6f4207b9da659f43c06e575c08877bba788319ed796fcdea0e2b653eeb5c/);
  assert.equal((sql.match(/INSERT INTO indirect_tax_registration_scopes/g) ?? []).length, 67);
  assert.equal((sql.match(/'off'\nWHERE/g) ?? []).length, 4);
  assert.match(sql, /staging-synthetic-us-wa-v22/);
  assert.doesNotMatch(sql, /staging-synthetic-us-all-v22/);
});

test("rejects missing acknowledgement, production tenants and changed candidates", () => {
  assert.throws(
    () => renderExpandedStagingActivationSql(built.previous, built.candidate, {}),
    /acknowledgement/,
  );
  assert.throws(
    () =>
      renderExpandedStagingActivationSql(built.previous, built.candidate, {
        ...options,
        organizationId: "org-production",
      }),
    /synthetic/,
  );
  assert.throws(
    () =>
      renderExpandedStagingActivationSql(
        built.previous,
        { ...built.candidate, rules: built.candidate.rules.slice(1) },
        options,
      ),
    /candidate chain/,
  );
});

test("CLI review date is independent from the UTC deployment timestamp", async () => {
  const result = await buildStagingExpandedCandidate("2026-09-06");
  assert.equal(result.previous.version, 21);
  assert.equal(result.candidate.version, 22);
  assert.ok(Date.parse(result.candidate.effective_from) <= Date.now());
  assert.equal(validateReviewDate("2026-09-06"), "2026-09-06");
  for (const value of ["2026-09-31", "2026-9-6", "bad"])
    assert.throws(() => validateReviewDate(value), /Fiji operating date/);
});
