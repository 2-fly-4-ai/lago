import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { buildCatalogSql } from "./store-plan-catalog.mjs";

const sql = (value) => `'${String(value).replaceAll("'", "''")}'`;

// Generates an atomic, guarded metadata-only backfill. Never connects to a database.
export function buildPlanTaxClassificationSql(catalog, review, organizationId) {
  buildCatalogSql(catalog, organizationId); // Reuse catalog input validation, not its inserts.
  if (
    review.format !== "serp-plan-tax-classifications/v1" ||
    review.source_commit !== catalog.source_commit ||
    review.classification !== "downloaded-prewritten-software-consumer" ||
    review.tax_code !== "txcd_10202000" ||
    !/^\d{4}-\d{2}-\d{2}$/.test(review.reviewed_on) ||
    !/^docs\/evidence\/[a-z0-9-]+\.md$/.test(review.evidence) ||
    !Array.isArray(review.plan_codes) ||
    review.plan_codes.length !== catalog.plans.length ||
    new Set(review.plan_codes).size !== review.plan_codes.length ||
    catalog.plans.some((plan) => !review.plan_codes.includes(plan.code))
  ) {
    throw new Error("Classification review does not exactly match the catalog");
  }
  const tenant = sql(organizationId);
  const desired = `WITH desired(code, amount, currency, interval) AS (VALUES ${catalog.plans
    .map(
      (plan) =>
        `(${sql(plan.code)},${plan.amount_minor},${sql(plan.currency)},${sql(plan.interval)})`,
    )
    .join(",")})`;
  const latest = `p.organization_id=${tenant} AND p.parent_id IS NULL
    AND p.version=(SELECT MAX(v.version) FROM plans v WHERE v.organization_id=p.organization_id
      AND v.code=p.code AND v.parent_id IS NULL)`;
  const guard = `${desired}
SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM organizations WHERE id=${tenant})
 OR EXISTS(SELECT 1 FROM desired d LEFT JOIN plans p ON p.code=d.code AND ${latest}
   WHERE p.id IS NULL OR p.amount_minor!=d.amount OR p.currency!=d.currency
     OR p.interval!=d.interval OR p.active!=1 OR p.pending_deletion!=0
     OR p.pay_in_advance!=1 OR NOT json_valid(p.metadata_json)
     OR (json_extract(p.metadata_json,'$.tax_code') IS NOT NULL
         AND json_extract(p.metadata_json,'$.tax_code')!=${sql(review.tax_code)}))
 THEN abs(-9223372036854775808) ELSE 1 END AS classification_preflight;`;
  const updates = catalog.plans
    .map(
      (plan) => `UPDATE plans AS p SET
 metadata_json=json_set(p.metadata_json,'$.tax_code',${sql(review.tax_code)},
   '$.tax_classification',${sql(review.classification)},'$.tax_classification_evidence',${sql(review.evidence)},
   '$.tax_classification_reviewed_on',${sql(review.reviewed_on)}),
 updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
 WHERE ${latest} AND p.code=${sql(plan.code)} AND json_extract(p.metadata_json,'$.tax_code') IS NULL;`,
    )
    .join("\n");
  return `-- Apply as one transactional D1 file/batch only after environment-specific approval.\n-- No prices, intervals, routing, registrations, or existing tax classifications change.\n${guard}\n${updates}\n`;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [catalogPath, reviewPath, organizationId] = process.argv.slice(2);
  if (!catalogPath || !reviewPath || !organizationId)
    throw new Error("Usage: plan-tax-classifications.mjs CATALOG REVIEW ORGANIZATION_ID");
  process.stdout.write(
    buildPlanTaxClassificationSql(
      JSON.parse(readFileSync(catalogPath, "utf8")),
      JSON.parse(readFileSync(reviewPath, "utf8")),
      organizationId,
    ),
  );
}
