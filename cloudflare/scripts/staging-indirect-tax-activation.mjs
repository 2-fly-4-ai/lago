import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

import { validateTedbSnapshot } from "./eu-tedb-standard-rates.mjs";
import { validateRuleSetArtifact } from "./indirect-tax-rule-set.mjs";
import { buildPriorityMarketCandidate } from "./priority-market-tax-candidate.mjs";

const ACKNOWLEDGEMENT = "STAGING_SYNTHETIC_ONLY";
const SYNTHETIC_ORGANIZATION = /^org-synthetic-e2e-[0-9]{8}-[0-9]+$/;
const REGISTRATION_REFERENCE =
  "staging-synthetic-qa-only:not-a-legal-registration:priority-market-review-2026-08-31";
const PREVIOUS_CANDIDATE = {
  checksum: "1786f62cffe7f301d8f994dc9d4a5cc353a84229cba6d3986fdde41a98522605",
  id: "priority-market-candidate-2026-08-31",
  version: 1,
};

export function renderStagingActivationSql(candidateValue, options) {
  const candidate = validateRuleSetArtifact(candidateValue);
  if (options?.acknowledgement !== ACKNOWLEDGEMENT) {
    throw new Error("staging activation requires the explicit staging-only acknowledgement");
  }
  if (!SYNTHETIC_ORGANIZATION.test(options.organizationId ?? "")) {
    throw new Error("staging activation requires a synthetic E2E organization");
  }
  canonicalIso(options.activatedAt, "activatedAt");
  const countries = [...new Set(candidate.rules.map((rule) => rule.country))].sort();
  if (
    candidate.id !== "priority-market-candidate-2026-08-31-v2" ||
    candidate.version !== 2 ||
    countries.length !== 32 ||
    candidate.rules.length !== 64
  ) {
    throw new Error("staging activation requires the reviewed 32-country priority candidate");
  }

  const statements = [
    "-- STAGING SYNTHETIC QA ONLY. This is not evidence of a legal tax registration.",
    "-- Apply only to serp-dev-lago-native-d1 after the documented remote preflight.",
    `UPDATE indirect_tax_registration_scopes
SET status = 'disabled', updated_at = ${sql(options.activatedAt)}
WHERE organization_id = ${sql(options.organizationId)}
  AND rule_set_id = ${sql(PREVIOUS_CANDIDATE.id)}
  AND registration_reference = ${sql(REGISTRATION_REFERENCE)} AND status = 'enabled';`,
    `UPDATE indirect_tax_rule_sets
SET status = 'retired'
WHERE id = ${sql(PREVIOUS_CANDIDATE.id)} AND version = ${PREVIOUS_CANDIDATE.version}
  AND status = 'active' AND content_sha256 = ${sql(PREVIOUS_CANDIDATE.checksum)};`,
    `UPDATE indirect_tax_rule_sets
SET status = 'active', activated_at = ${sql(options.activatedAt)}
WHERE id = ${sql(candidate.id)} AND version = ${candidate.version} AND status = 'draft'
  AND content_sha256 = ${sql(candidate.content_sha256)}
  AND EXISTS (
    SELECT 1 FROM organizations WHERE id = ${sql(options.organizationId)}
  );`,
  ];

  for (const country of countries) {
    const scopeId = `staging-synthetic-${country.toLowerCase()}-${candidate.version}`;
    statements.push(
      `INSERT INTO indirect_tax_registration_scopes
  (id, organization_id, rule_set_id, country, region, status, registration_reference,
   effective_from, effective_to, created_at, updated_at)
SELECT
  ${sql(scopeId)}, ${sql(options.organizationId)}, ${sql(candidate.id)}, ${sql(country)}, NULL,
  'enabled', ${sql(REGISTRATION_REFERENCE)}, ${sql(options.activatedAt)}, NULL,
  ${sql(options.activatedAt)}, ${sql(options.activatedAt)}
FROM indirect_tax_rule_sets rule_set
WHERE rule_set.id = ${sql(candidate.id)} AND rule_set.status = 'active'
  AND rule_set.content_sha256 = ${sql(candidate.content_sha256)}
  AND EXISTS (SELECT 1 FROM organizations WHERE id = ${sql(options.organizationId)})
  AND NOT EXISTS (
    SELECT 1 FROM indirect_tax_registration_scopes scope
    WHERE scope.organization_id = ${sql(options.organizationId)}
      AND scope.rule_set_id = ${sql(candidate.id)} AND scope.country = ${sql(country)}
      AND scope.region IS NULL
  );`,
    );
  }

  statements.push(
    `UPDATE indirect_tax_registration_scopes
SET status = 'enabled', updated_at = ${sql(options.activatedAt)}
WHERE organization_id = ${sql(options.organizationId)} AND rule_set_id = ${sql(candidate.id)}
  AND region IS NULL AND registration_reference = ${sql(REGISTRATION_REFERENCE)};`,
    "-- Required postflight: exactly one active rule set, 64 rules, 32 enabled synthetic scopes,",
    "-- zero foreign-key violations, and no pending staging migrations.",
  );
  return `${statements.join("\n\n")}\n`;
}

function canonicalIso(value, name) {
  if (typeof value !== "string" || new Date(value).toISOString() !== value) {
    throw new Error(`${name} must be a canonical UTC ISO timestamp`);
  }
}

function sql(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

async function main() {
  const args = process.argv.slice(2);
  const organizationId = valueAfter(args, "--organization-id");
  const activatedAt = valueAfter(args, "--activated-at");
  const acknowledgement = args.includes("--acknowledge-staging-only") ? ACKNOWLEDGEMENT : null;
  const snapshot = validateTedbSnapshot(
    JSON.parse(
      await readFile(
        new URL("../fixtures/indirect-tax/eu-tedb-standard-rates-2026-08-31.json", import.meta.url),
        "utf8",
      ),
    ),
  );
  process.stdout.write(
    renderStagingActivationSql(buildPriorityMarketCandidate(snapshot), {
      acknowledgement,
      activatedAt,
      organizationId,
    }),
  );
}

function valueAfter(args, flag) {
  const index = args.indexOf(flag);
  if (index < 0 || !args[index + 1]) throw new Error(`missing ${flag}`);
  return args[index + 1];
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
