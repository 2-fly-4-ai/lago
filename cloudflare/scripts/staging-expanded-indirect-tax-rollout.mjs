import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

import { addCanadianSoftwareRules, renderCanadianDraftSql } from "./canada-software-candidate.mjs";
import { buildExpandedSoftwareCandidate } from "./expanded-software-tax-candidate.mjs";
import { addNoSalesTaxSoftwareRules } from "./no-sales-tax-software-candidate.mjs";
import { buildPriorityMarketCandidate } from "./priority-market-tax-candidate.mjs";
import { addUSUniformSoftwareRules } from "./us-uniform-software-candidate.mjs";

const ACKNOWLEDGEMENT = "STAGING_SYNTHETIC_ONLY";
const SYNTHETIC_ORGANIZATION = /^org-synthetic-e2e-[0-9]{8}-[0-9]+$/;
const REGISTRATION_REFERENCE =
  "staging-synthetic-qa-only:not-a-legal-registration:expanded-review-2026-09-06";
// This is the immutable identity actually recorded in staging, documented in
// docs/evidence/local-d1-tax-staging-enforcement-2026-08-31.md. Do not
// regenerate its checksum from later source-review code.
const DEPLOYED_STAGING_BASELINE = {
  id: "priority-market-candidate-2026-08-31-v2",
  version: 2,
  contentSha256: "3ed5b218afe287548c7b44f88c76064805bf132da92338d3ecbd04784ab25d93",
};

export async function buildStagingExpandedCandidate(asOf) {
  const read = async (name) =>
    JSON.parse(
      await readFile(new URL(`../fixtures/indirect-tax/${name}`, import.meta.url), "utf8"),
    );
  const tedb = await read("eu-tedb-standard-rates-2026-08-31.json");
  const previous = buildPriorityMarketCandidate(tedb);
  const expanded = buildExpandedSoftwareCandidate(
    tedb,
    await read("software-rate-expansion-2026-09-06.json"),
    asOf,
  );
  const canada = addCanadianSoftwareRules(
    expanded,
    await read("canada-software-components-2026-09-06.json"),
    asOf,
  );
  const noSalesTax = addNoSalesTaxSoftwareRules(
    canada,
    await read("no-sales-tax-software-2026-09-06.json"),
    asOf,
  );
  return { previous, candidate: addUSUniformSoftwareRules(noSalesTax, asOf) };
}

export function renderExpandedStagingActivationSql(previous, candidate, options) {
  if (options?.acknowledgement !== ACKNOWLEDGEMENT)
    throw new Error("staging activation requires the explicit staging-only acknowledgement");
  if (!SYNTHETIC_ORGANIZATION.test(options.organizationId ?? ""))
    throw new Error("staging activation requires a synthetic E2E organization");
  canonicalIso(options.activatedAt, "activatedAt");
  if (
    previous.id !== DEPLOYED_STAGING_BASELINE.id ||
    previous.version !== DEPLOYED_STAGING_BASELINE.version ||
    previous.rules.length !== 64 ||
    candidate.id !== "software-us-partial-candidate-2026-09-06-v21" ||
    candidate.version !== 21 ||
    candidate.rules.length !== 157 ||
    new Set(candidate.rules.map((rule) => rule.country)).size !== 65
  )
    throw new Error("staging activation requires the reviewed v2-to-v21 candidate chain");

  const scopes = buildScopes(candidate);
  if (scopes.length !== 67) throw new Error("staging scope coverage is incomplete");
  const organizationId = sql(options.organizationId);
  const activatedAt = sql(options.activatedAt);
  const statements = [
    "-- STAGING SYNTHETIC QA ONLY. This is not evidence of a legal tax registration.",
    "-- Apply only to serp-dev-lago-native-d1 after importing v21 as a draft.",
    `SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM organizations WHERE id=${organizationId})
 OR NOT EXISTS(SELECT 1 FROM indirect_tax_rule_sets WHERE id=${sql(DEPLOYED_STAGING_BASELINE.id)}
   AND version=${DEPLOYED_STAGING_BASELINE.version} AND status='active'
   AND content_sha256=${sql(DEPLOYED_STAGING_BASELINE.contentSha256)})
 OR NOT EXISTS(SELECT 1 FROM indirect_tax_rule_sets WHERE id=${sql(candidate.id)}
   AND version=${candidate.version} AND status='draft' AND content_sha256=${sql(candidate.content_sha256)})
 OR EXISTS(SELECT 1 FROM indirect_tax_rule_sets WHERE status='active'
   AND id<>${sql(DEPLOYED_STAGING_BASELINE.id)})
 THEN abs(-9223372036854775808) ELSE 1 END AS staging_activation_preflight;`,
    `UPDATE indirect_tax_registration_scopes SET status='disabled', updated_at=${activatedAt}
WHERE organization_id=${organizationId} AND rule_set_id=${sql(DEPLOYED_STAGING_BASELINE.id)}
  AND status='enabled';`,
    `UPDATE indirect_tax_rule_sets SET status='retired'
WHERE id=${sql(DEPLOYED_STAGING_BASELINE.id)} AND version=${DEPLOYED_STAGING_BASELINE.version}
  AND status='active' AND content_sha256=${sql(DEPLOYED_STAGING_BASELINE.contentSha256)};`,
    `UPDATE indirect_tax_rule_sets SET status='active', activated_at=${activatedAt}
WHERE id=${sql(candidate.id)} AND version=${candidate.version} AND status='draft'
  AND content_sha256=${sql(candidate.content_sha256)}
  AND NOT EXISTS(SELECT 1 FROM indirect_tax_rule_sets WHERE status='active');`,
  ];

  for (const scope of scopes) {
    const id = `staging-synthetic-${scope.country.toLowerCase()}-${(scope.region ?? "all").toLowerCase()}-v21`;
    statements.push(`INSERT INTO indirect_tax_registration_scopes
  (id,organization_id,rule_set_id,country,region,status,registration_reference,
   effective_from,effective_to,created_at,updated_at,collection_mode)
SELECT ${sql(id)},${organizationId},${sql(candidate.id)},${sql(scope.country)},${sql(scope.region)},
  'enabled',${sql(REGISTRATION_REFERENCE)},${activatedAt},NULL,${activatedAt},${activatedAt},${sql(scope.collectionMode)}
WHERE EXISTS(SELECT 1 FROM indirect_tax_rule_sets WHERE id=${sql(candidate.id)} AND status='active')
  AND NOT EXISTS(SELECT 1 FROM indirect_tax_registration_scopes WHERE id=${sql(id)});`);
  }
  statements.push(
    "-- Required postflight: v21 active, v2 retired, 157 v21 rules, 67 enabled v21 scopes,",
    "-- four collection-off scopes, zero foreign-key violations, and no pending staging migrations.",
  );
  return `${statements.join("\n\n")}\n`;
}

function buildScopes(candidate) {
  const groups = new Map();
  for (const rule of candidate.rules) {
    const region = rule.country === "US" ? rule.region : null;
    if (rule.country === "US" && !region) throw new Error("US staging rules require a state");
    const key = `${rule.country}|${region ?? ""}`;
    const group = groups.get(key) ?? { country: rule.country, region, taxabilities: [] };
    group.taxabilities.push(rule.taxability);
    groups.set(key, group);
  }
  return [...groups.values()]
    .map(({ country, region, taxabilities }) => ({
      country,
      region,
      collectionMode: taxabilities.every((value) => value === "exempt") ? "off" : "collect",
    }))
    .sort((left, right) =>
      `${left.country}|${left.region ?? ""}`.localeCompare(
        `${right.country}|${right.region ?? ""}`,
      ),
    );
}

function canonicalIso(value, name) {
  if (typeof value !== "string" || new Date(value).toISOString() !== value)
    throw new Error(`${name} must be a canonical UTC ISO timestamp`);
}

export function validateReviewDate(value) {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}$/.test(value) ||
    new Date(`${value}T00:00:00.000Z`).toISOString().slice(0, 10) !== value
  )
    throw new Error("review-date must be a valid YYYY-MM-DD Fiji operating date");
  return value;
}

function sql(value) {
  if (value === null) return "NULL";
  return `'${String(value).replaceAll("'", "''")}'`;
}

function valueAfter(args, flag) {
  const index = args.indexOf(flag);
  if (index < 0 || !args[index + 1]) throw new Error(`missing ${flag}`);
  return args[index + 1];
}

async function main() {
  const args = process.argv.slice(2);
  const command = args[0];
  if (!new Set(["draft-sql", "activation-sql"]).has(command))
    throw new Error("Usage: staging-expanded-indirect-tax-rollout.mjs <draft-sql|activation-sql>");
  const timestamp = valueAfter(args, command === "draft-sql" ? "--created-at" : "--activated-at");
  const reviewDate = valueAfter(args, "--review-date");
  canonicalIso(timestamp, "timestamp");
  const { previous, candidate } = await buildStagingExpandedCandidate(
    validateReviewDate(reviewDate),
  );
  if (command === "draft-sql") {
    process.stdout.write(renderCanadianDraftSql(candidate, timestamp));
    return;
  }
  process.stdout.write(
    renderExpandedStagingActivationSql(previous, candidate, {
      acknowledgement: args.includes("--acknowledge-staging-only") ? ACKNOWLEDGEMENT : null,
      activatedAt: timestamp,
      organizationId: valueAfter(args, "--organization-id"),
    }),
  );
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
