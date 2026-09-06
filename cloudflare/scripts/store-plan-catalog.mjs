import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const quote = (value) => `'${String(value).replaceAll("'", "''")}'`;

// Explicit operator bootstrap, not an automatic migration or checkout-time import.
// Output contains only public catalog data and never overwrites an existing plan.
export function buildCatalogSql(catalog, organizationId) {
  if (!/^[a-z0-9-]+$/.test(organizationId)) throw new Error("Invalid organization ID");
  if (!/^[a-f0-9]{40}$/.test(catalog.source_commit)) throw new Error("Missing source commit");
  if (!Array.isArray(catalog.plans) || !catalog.plans.length) throw new Error("Empty catalog");
  const codes = new Set();
  for (const plan of catalog.plans) {
    if (!/^[a-z0-9-]+$/.test(plan.code) || codes.has(plan.code))
      throw new Error("Invalid/duplicate code");
    codes.add(plan.code);
    if (
      !Number.isSafeInteger(plan.amount_minor) ||
      plan.amount_minor < 0 ||
      plan.currency !== "USD" ||
      !["monthly", "yearly", "one_time"].includes(plan.interval) ||
      plan.pay_in_advance !== 1 ||
      !plan.name
    )
      throw new Error(`Invalid flat plan: ${plan.code}`);
  }
  const organization = quote(organizationId);
  const values = catalog.plans
    .map(
      (plan) =>
        `(${[plan.code, plan.name, plan.interval, plan.amount_minor, plan.currency]
          .map(quote)
          .join(", ")})`,
    )
    .join(",\n");
  const desired = `WITH desired(code, name, interval, amount_minor, currency) AS (VALUES\n${values}\n)`;
  const conflict = `SELECT 1 FROM desired d JOIN plans p ON p.organization_id = ${organization}
    AND p.code = d.code AND p.parent_id IS NULL
    AND p.version = (SELECT MAX(v.version) FROM plans v WHERE v.organization_id=p.organization_id AND v.code=p.code AND v.parent_id IS NULL)
    WHERE p.interval != d.interval OR p.amount_minor != CAST(d.amount_minor AS INTEGER)
      OR p.currency != d.currency OR p.active != 1 OR p.pending_deletion != 0 OR p.pay_in_advance != 1`;
  const guards = `${desired}
SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM organizations WHERE id=${organization})
  OR EXISTS(${conflict}) THEN abs(-9223372036854775808) ELSE 1 END AS catalog_preflight;
`;
  const inserts = catalog.plans
    .map((plan) => {
      const id =
        "catalog-" +
        createHash("sha256").update(`${organizationId}:${plan.code}`).digest("hex").slice(0, 32);
      const metadata = JSON.stringify({
        source: "store-new",
        source_commit: catalog.source_commit,
        catalog_repair: "2026-09-05",
      });
      return `INSERT INTO plans (id,organization_id,code,name,interval,amount_minor,currency,version,active,created_at,updated_at,pay_in_advance,metadata_json,pending_deletion)
SELECT ${[id, organizationId, plan.code, plan.name, plan.interval].map(quote).join(",")},${plan.amount_minor},${quote(plan.currency)},1,1,strftime('%Y-%m-%dT%H:%M:%fZ','now'),strftime('%Y-%m-%dT%H:%M:%fZ','now'),1,${quote(metadata)},0
WHERE NOT EXISTS (SELECT 1 FROM plans WHERE organization_id=${organization} AND code=${quote(plan.code)} AND parent_id IS NULL);`;
    })
    .join("\n");
  return `-- Additive flat catalog bootstrap; source ${catalog.source_commit}.\n-- Preflight deliberately fails with integer overflow on missing tenant or conflicting catalog.\n${guards}${inserts}\n`;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [input, organizationId, output] = process.argv.slice(2);
  if (!input || !organizationId || !output)
    throw new Error("Usage: store-plan-catalog.mjs CATALOG_JSON ORGANIZATION_ID OUTPUT_SQL");
  const sql = buildCatalogSql(JSON.parse(readFileSync(input, "utf8")), organizationId);
  writeFileSync(output, sql, { flag: "wx" });
  console.log(`Generated insert-only catalog SQL: ${output}`);
}
