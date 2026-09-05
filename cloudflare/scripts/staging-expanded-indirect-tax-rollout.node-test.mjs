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

test("renders guarded synthetic-only v2-to-v21 staging activation", () => {
  const sql = renderExpandedStagingActivationSql(built.previous, built.candidate, options);
  assert.match(sql, /staging_activation_preflight/);
  assert.match(sql, /software-us-partial-candidate-2026-09-06-v21/);
  assert.match(sql, /priority-market-candidate-2026-08-31-v2/);
  assert.equal((sql.match(/INSERT INTO indirect_tax_registration_scopes/g) ?? []).length, 67);
  assert.equal((sql.match(/'off'\nWHERE/g) ?? []).length, 4);
  assert.match(sql, /staging-synthetic-us-wa-v21/);
  assert.doesNotMatch(sql, /staging-synthetic-us-all-v21/);
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
  assert.equal(result.candidate.version, 21);
  assert.equal(validateReviewDate("2026-09-06"), "2026-09-06");
  for (const value of ["2026-09-31", "2026-9-6", "bad"])
    assert.throws(() => validateReviewDate(value), /Fiji operating date/);
});
