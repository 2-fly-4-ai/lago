import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { buildExpandedSoftwareCandidate } from "./expanded-software-tax-candidate.mjs";
import {
  assignVersionedRuleIds,
  contentChecksum,
  validateRuleSetArtifact,
  renderDraftSql,
} from "./indirect-tax-rule-set.mjs";

const REGIONS = "AB BC MB NB NL NS NT NU ON PE QC SK YT".split(" ");
const HOSTS = {
  federal: "www.canada.ca",
  digital: "www.canada.ca",
  BC: "www2.gov.bc.ca",
  MB: "www.gov.mb.ca",
  SK: "www.saskatchewan.ca",
  QC: "www.revenuquebec.ca",
};
const PREFIX = "canada-components:";
const sql = (v) => `'${String(v).replaceAll("'", "''")}'`;
const validDate = (value) =>
  typeof value === "string" &&
  /^\d{4}-\d{2}-\d{2}$/.test(value) &&
  Number.isFinite(Date.parse(value)) &&
  new Date(value).toISOString().slice(0, 10) === value;
const validComponents = (components) => {
  if (!Array.isArray(components)) return false;
  const codes = components.map((c) => c?.code);
  return (
    ((codes.length === 1 && ["GST", "HST"].includes(codes[0])) ||
      (codes.length === 2 && codes[0] === "GST" && ["PST", "RST", "QST"].includes(codes[1]))) &&
    components.every(
      (c) => Number.isSafeInteger(c.rate_ppm) && c.rate_ppm > 0 && c.rate_ppm <= 1000000,
    )
  );
};

export function addCanadianSoftwareRules(base, evidence, asOf) {
  const artifact = structuredClone(validateRuleSetArtifact(base));
  const age = (Date.parse(asOf) - Date.parse(evidence.observed_on)) / 86400000;
  if (
    evidence.format !== "serp-canada-software-components/v1" ||
    evidence.activation_allowed !== false ||
    !validDate(asOf) ||
    !validDate(evidence.observed_on) ||
    !Number.isFinite(age) ||
    age < 0 ||
    age > 30 ||
    JSON.stringify(evidence.regions?.map((r) => r.region).sort()) !== JSON.stringify(REGIONS) ||
    artifact.rules.some((r) => r.country === "CA")
  )
    throw new Error("Invalid Canadian review boundary");
  if (Object.keys(evidence.sources).sort().join() !== Object.keys(HOSTS).sort().join())
    throw new Error("Missing authority sources");
  for (const [key, urlString] of Object.entries(evidence.sources)) {
    const url = new URL(urlString);
    if (url.protocol !== "https:" || url.hostname !== HOSTS[key] || url.username || url.password)
      throw new Error("Invalid authority source");
    artifact.source.components.push({
      id: `canada-${key.toLowerCase()}`,
      authority:
        key === "federal" || key === "digital"
          ? "Canada Revenue Agency"
          : `Canadian provincial authority ${key}`,
      url: urlString,
      retrieved_at: `${evidence.observed_on}T00:00:00.000Z`,
    });
  }
  for (const region of evidence.regions) {
    if (!validComponents(region.components)) throw new Error("Invalid levy components");
    const components = region.components.map((c) => ({
      ...c,
      source_component_id: ["GST", "HST"].includes(c.code)
        ? "canada-federal"
        : `canada-${region.region.toLowerCase()}`,
    }));
    if (
      components.some(
        (c) => !artifact.source.components.some((s) => s.id === c.source_component_id),
      )
    )
      throw new Error("Missing levy source");
    for (const taxCode of ["txcd_10103100", "txcd_10202000"])
      artifact.rules.push({
        id: `ca-${region.region.toLowerCase()}-${taxCode}-20260906`,
        country: "CA",
        region: region.region,
        postal_prefix: null,
        product_tax_code: taxCode,
        taxability: "taxable",
        rate_ppm: components.reduce((n, c) => n + c.rate_ppm, 0),
        priority: 0,
        calculation_method: "static",
        source_component_id: "canada-digital",
        source_url: evidence.sources.digital,
        source_reference: PREFIX + JSON.stringify(components),
        effective_from: `${evidence.observed_on}T00:00:00.000Z`,
        effective_to: null,
      });
  }
  artifact.id = "software-canada-candidate-2026-09-06-v19";
  artifact.version = 19;
  artifact.source.name = "Official software rate review with Canadian levy components";
  artifact.source.url = "docs/evidence/canadian-tax-components-2026-09-06.md";
  artifact.rules = assignVersionedRuleIds(artifact.rules, artifact.version);
  artifact.content_sha256 = contentChecksum(artifact);
  return validateRuleSetArtifact(artifact);
}

export function renderCanadianDraftSql(artifact, createdAt) {
  const checked = validateRuleSetArtifact(artifact);
  const statements = [renderDraftSql(checked, createdAt, { includeCanadianComponents: true })];
  for (const rule of checked.rules.filter((r) => r.country === "CA")) {
    if (!rule.source_reference.startsWith(PREFIX))
      throw new Error("Canadian rules require components");
    const components = JSON.parse(rule.source_reference.slice(PREFIX.length));
    if (
      !validComponents(components) ||
      components.reduce((sum, c) => sum + c.rate_ppm, 0) !== rule.rate_ppm
    )
      throw new Error("Invalid component checksum content");
    for (const c of components) {
      const source = checked.source.components.find((s) => s.id === c.source_component_id);
      if (
        !source ||
        !["GST", "HST", "PST", "RST", "QST"].includes(c.code) ||
        !Number.isSafeInteger(c.rate_ppm) ||
        c.rate_ppm <= 0 ||
        c.rate_ppm > 1000000
      )
        throw new Error("Invalid component");
      statements.push(
        `INSERT INTO indirect_tax_rule_components(rule_id,code,rate_ppm,source_url) VALUES(${sql(rule.id)},${sql(c.code)},${c.rate_ppm},${sql(source.url)});`,
      );
    }
  }
  return statements.join("\n") + "\n";
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const fixture = (file) =>
    JSON.parse(readFileSync(new URL(`../fixtures/indirect-tax/${file}`, import.meta.url), "utf8"));
  const today = new Date().toISOString().slice(0, 10);
  const base = buildExpandedSoftwareCandidate(
    fixture("eu-tedb-standard-rates-2026-08-31.json"),
    fixture("software-rate-expansion-2026-09-06.json"),
    today,
  );
  const candidate = addCanadianSoftwareRules(
    base,
    fixture("canada-software-components-2026-09-06.json"),
    today,
  );
  process.stdout.write(JSON.stringify(candidate, null, 2) + "\n");
}
