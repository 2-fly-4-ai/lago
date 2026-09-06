import {
  assignVersionedRuleIds,
  contentChecksum,
  validateRuleSetArtifact,
} from "./indirect-tax-rule-set.mjs";

const HOSTS = {
  HK: "www.fstb.gov.hk",
  QA: "www.gta.gov.qa",
  VN: "vanban.chinhphu.vn",
};
const CODES = ["txcd_10103100", "txcd_10202000"];
const dateOnly = (value) =>
  typeof value === "string" &&
  /^\d{4}-\d{2}-\d{2}$/.test(value) &&
  Number.isFinite(Date.parse(value)) &&
  new Date(value).toISOString().slice(0, 10) === value;

export function addNoSalesTaxSoftwareRules(base, evidence, asOf) {
  const artifact = structuredClone(validateRuleSetArtifact(base));
  if (
    evidence?.format !== "serp-no-sales-tax-software-review/v1" ||
    evidence.activation_allowed !== false ||
    !Array.isArray(evidence.markets) ||
    !evidence.markets.length ||
    !dateOnly(asOf)
  )
    throw new Error("Invalid no-sales-tax review");
  const seen = new Set();
  for (const market of evidence.markets) {
    const url = new URL(market.url);
    const age = (Date.parse(asOf) - Date.parse(market.observed_on)) / 86400000;
    if (
      !HOSTS[market.country] ||
      seen.has(market.country) ||
      artifact.rules.some((r) => r.country === market.country) ||
      url.protocol !== "https:" ||
      url.hostname !== HOSTS[market.country] ||
      url.username ||
      url.password ||
      !dateOnly(market.observed_on) ||
      age < 0 ||
      age > 30 ||
      typeof market.authority !== "string" ||
      typeof market.review !== "string" ||
      !market.review.trim()
    )
      throw new Error("Invalid no-sales-tax authority evidence");
    seen.add(market.country);
    const component = `authority-${market.country.toLowerCase()}-no-sales-tax`;
    artifact.source.components.push({
      id: component,
      authority: market.authority,
      url: market.url,
      retrieved_at: `${market.observed_on}T00:00:00.000Z`,
    });
    for (const code of CODES)
      artifact.rules.push({
        id: `${market.country.toLowerCase()}-${code}-no-sales-tax`,
        country: market.country,
        region: null,
        postal_prefix: null,
        product_tax_code: code,
        taxability: "exempt",
        rate_ppm: 0,
        priority: 0,
        calculation_method: "static",
        source_component_id: component,
        source_url: market.url,
        source_reference: `DRAFT ONLY. ${market.review}`,
        effective_from: `${market.observed_on}T00:00:00.000Z`,
        effective_to: null,
      });
  }
  artifact.id = "software-no-sales-tax-candidate-2026-09-06-v20";
  artifact.version = 20;
  artifact.source.name = "Official software rules including explicit no-sales-tax regimes";
  artifact.source.url = "docs/evidence/software-tax-expansion-2026-09-06.md";
  artifact.rules = assignVersionedRuleIds(artifact.rules, artifact.version);
  artifact.content_sha256 = contentChecksum(artifact);
  return validateRuleSetArtifact(artifact);
}
