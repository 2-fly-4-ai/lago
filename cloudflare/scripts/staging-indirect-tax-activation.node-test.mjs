import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

import { buildPriorityMarketCandidate } from "./priority-market-tax-candidate.mjs";
import { renderStagingActivationSql } from "./staging-indirect-tax-activation.mjs";

const snapshot = JSON.parse(
  await readFile(
    new URL("../fixtures/indirect-tax/eu-tedb-standard-rates-2026-08-31.json", import.meta.url),
    "utf8",
  ),
);
const candidate = buildPriorityMarketCandidate(snapshot);
const options = {
  acknowledgement: "STAGING_SYNTHETIC_ONLY",
  activatedAt: "2026-08-31T09:00:00.000Z",
  organizationId: "org-synthetic-e2e-20260815-001",
};

test("renders an idempotent staging-only activation for all reviewed countries", () => {
  const sql = renderStagingActivationSql(candidate, options);
  assert.match(sql, /STAGING SYNTHETIC QA ONLY/);
  assert.match(sql, new RegExp(candidate.content_sha256));
  assert.equal(sql.match(/INSERT INTO indirect_tax_registration_scopes/g)?.length, 32);
  assert.match(sql, /staging-synthetic-qa-only:not-a-legal-registration/);
  assert.match(sql, /priority-market-candidate-2026-08-31[^-]/);
  assert.match(sql, /SET status = 'retired'/);
  assert.doesNotMatch(sql, /serp-prod|production/i);
});

test("rejects missing acknowledgement and non-synthetic organizations", () => {
  assert.throws(
    () => renderStagingActivationSql(candidate, { ...options, acknowledgement: null }),
    /explicit staging-only acknowledgement/,
  );
  assert.throws(
    () =>
      renderStagingActivationSql(candidate, {
        ...options,
        organizationId: "org-serp-billing",
      }),
    /synthetic E2E organization/,
  );
});

test("rejects a candidate outside the reviewed staging boundary", () => {
  assert.throws(
    () => renderStagingActivationSql({ ...candidate, rules: candidate.rules.slice(1) }, options),
    /content_sha256|32-country/,
  );
});
