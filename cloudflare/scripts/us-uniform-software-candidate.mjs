import {
  assignVersionedRuleIds,
  contentChecksum,
  validateRuleSetArtifact,
} from "./indirect-tax-rule-set.mjs";

const REVIEWED = [
  {
    region: "CT",
    codes: ["txcd_10103100", "txcd_10202000"],
    rate: 63500,
    url: "https://portal.ct.gov/drs/sales-tax/tax-information",
    authority: "Connecticut Department of Revenue Services",
    scope:
      "Personal-use canned software, electronically accessed or transferred; no additional local sales taxes. Business-use classification is excluded.",
  },
  {
    region: "CA",
    codes: ["txcd_10202000"],
    rate: 0,
    url: "https://cdtfa.ca.gov/formspubs/pub109/nontaxable-sales.htm",
    authority: "California Department of Tax and Fee Administration",
    scope:
      "Software delivered exclusively electronically, with no printed or physical backup copy. Does not classify hosted services or physical bundles.",
  },
];

// No US wildcard, no local-rate estimate, no production activation or registration.
export function addUSUniformSoftwareRules(base, asOf) {
  const reviewed = "2026-09-05";
  const age = (Date.parse(asOf) - Date.parse(reviewed)) / 86400000;
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(asOf) ||
    !Number.isFinite(age) ||
    age < 0 ||
    age > 30 ||
    new Date(asOf).toISOString().slice(0, 10) !== asOf
  )
    throw new Error("US evidence requires fresh review");
  const artifact = structuredClone(validateRuleSetArtifact(base));
  if (artifact.rules.some((r) => r.country === "US"))
    throw new Error("US rules already present; explicit reconciliation required");
  for (const review of REVIEWED) {
    const component = `us-${review.region.toLowerCase()}-software-20260905`;
    artifact.source.components.push({
      id: component,
      authority: review.authority,
      url: review.url,
      retrieved_at: `${reviewed}T00:00:00.000Z`,
    });
    for (const code of review.codes)
      artifact.rules.push({
        id: `${component}-${code}`,
        country: "US",
        region: review.region,
        postal_prefix: null,
        product_tax_code: code,
        taxability: review.rate === 0 ? "exempt" : "taxable",
        rate_ppm: review.rate,
        priority: 0,
        calculation_method: "static",
        source_component_id: component,
        source_url: review.url,
        source_reference: review.scope,
        effective_from: `${reviewed}T00:00:00.000Z`,
        effective_to: null,
      });
  }
  const washingtonComponent = "us-wa-address-rate-20260905";
  const washingtonSource = "https://dor.wa.gov/wa-sales-tax-rate-lookup-url-interface";
  artifact.source.components.push({
    id: washingtonComponent,
    authority: "Washington State Department of Revenue",
    url: washingtonSource,
    retrieved_at: `${reviewed}T00:00:00.000Z`,
  });
  for (const code of ["txcd_10103100", "txcd_10202000"])
    artifact.rules.push({
      id: `${washingtonComponent}-${code}`,
      country: "US",
      region: "WA",
      postal_prefix: null,
      product_tax_code: code,
      taxability: "taxable",
      rate_ppm: 65000,
      priority: 0,
      calculation_method: "wa_dor_address",
      source_component_id: washingtonComponent,
      source_url: washingtonSource,
      source_reference:
        "DRAFT ONLY. The stored 6.5% value is the state component; checkout must resolve and reconcile the full destination rate through Washington DOR's address interface. ZIP-only and unconfirmed corrected matches are prohibited.",
      effective_from: `${reviewed}T00:00:00.000Z`,
      effective_to: null,
    });
  artifact.id = "software-us-partial-candidate-2026-09-06-v21";
  artifact.version = 21;
  artifact.source.name = "Official software rules with partial US state coverage";
  artifact.source.url = "docs/evidence/us-software-source-review-2026-09-06.md";
  artifact.rules = assignVersionedRuleIds(artifact.rules, artifact.version);
  artifact.content_sha256 = contentChecksum(artifact);
  return validateRuleSetArtifact(artifact);
}
