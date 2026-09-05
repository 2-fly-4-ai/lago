import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { buildPriorityMarketCandidate } from "./priority-market-tax-candidate.mjs";
import { contentChecksum, validateRuleSetArtifact } from "./indirect-tax-rule-set.mjs";

// Reviewed authority hosts are code-owned, never supplied by the evidence file itself.
const AUTHORITIES = {
  AU: ["ato.gov.au"],
  NZ: ["ird.govt.nz"],
  NO: ["skatteetaten.no"],
  SG: ["iras.gov.sg"],
  AE: ["tax.gov.ae"],
  MY: ["customs.gov.my"],
  PH: ["bir.gov.ph"],
  ZA: ["sars.gov.za"],
  CL: ["sii.cl"],
  IS: ["skatturinn.is"],
  KE: ["kra.go.ke"],
  JP: ["nta.go.jp"],
  AR: ["afip.gov.ar", "afip.gob.ar"],
  CO: ["dian.gov.co"],
  TH: ["rd.go.th"],
  TW: ["etax.nat.gov.tw"],
  TR: ["gib.gov.tr"],
  SA: ["zatca.gov.sa"],
  UA: ["tax.gov.ua"],
  CR: ["hacienda.go.cr"],
  ID: ["pajak.go.id"],
  RS: ["purs.gov.rs"],
  KZ: ["gov.kz"],
  PE: ["gob.pe", "sunat.gob.pe"],
  NG: ["nass.gov.ng", "nrs.gov.ng"],
  MA: ["finances.gov.ma"],
  EG: ["eta.gov.eg"],
  EC: ["sri.gob.ec"],
};
const CLASSIFICATIONS = [
  { id: "remote-software", code: "txcd_10103100" },
  { id: "downloaded-software", code: "txcd_10202000" },
];

export function validateExpansion(evidence, asOf) {
  dateOnly(asOf);
  if (
    evidence?.format !== "serp-official-software-rate-expansion/v1" ||
    evidence.activation_allowed !== false ||
    evidence.customer_type !== "consumer" ||
    evidence.classification_basis !== "delivery-not-billing-frequency" ||
    !Array.isArray(evidence.markets) ||
    !evidence.markets.length ||
    !Array.isArray(evidence.held_regions)
  )
    throw new Error("Invalid review-only expansion");
  const seen = new Set();
  for (const market of evidence.markets) {
    const hosts = AUTHORITIES[market.country];
    if (!hosts || seen.has(market.country)) throw new Error("Unsupported or duplicate country");
    seen.add(market.country);
    for (const value of [market.rate_url, market.scope_url]) {
      const url = new URL(value);
      if (
        url.protocol !== "https:" ||
        url.username ||
        url.password ||
        !hosts.some((host) => url.hostname === host || url.hostname.endsWith(`.${host}`))
      ) {
        throw new Error("Unreviewed authority host");
      }
    }
    dateOnly(market.observed_on);
    const age = (Date.parse(asOf) - Date.parse(market.observed_on)) / 86400000;
    if (age < 0 || age > 30) throw new Error("Future or stale rate evidence");
    if (!Number.isSafeInteger(market.rate_ppm) || market.rate_ppm <= 0 || market.rate_ppm > 1000000)
      throw new Error("Invalid standard rate; zero needs separate exemption review");
    for (const key of ["authority", "review"]) {
      if (typeof market[key] !== "string" || !market[key].trim() || market[key].length > 600)
        throw new Error("Missing or oversized review evidence");
    }
  }
  return evidence;
}

export function buildExpandedSoftwareCandidate(tedb, evidence, asOf) {
  validateExpansion(evidence, asOf);
  const artifact = structuredClone(buildPriorityMarketCandidate(tedb));
  artifact.id = "software-expansion-candidate-2026-09-06-v18";
  artifact.version = 18;
  artifact.source.name = "SERP official-source software expansion review candidate";
  artifact.source.url = "docs/evidence/software-tax-expansion-2026-09-06.md";
  const newestObservation = evidence.markets
    .map((market) => market.observed_on)
    .sort()
    .at(-1);
  artifact.effective_from = `${newestObservation}T00:00:00.000Z`;
  artifact.source.published_at = artifact.effective_from;
  for (const market of evidence.markets) {
    if (artifact.rules.some((rule) => rule.country === market.country))
      throw new Error("Expansion cannot overwrite an existing country");
    const component = `authority-${market.country.toLowerCase()}-software`;
    const observed = `${market.observed_on}T00:00:00.000Z`;
    artifact.source.components.push({
      id: component,
      authority: market.authority,
      url: market.rate_url,
      retrieved_at: observed,
    });
    for (const classification of CLASSIFICATIONS) {
      artifact.rules.push({
        id: `${market.country.toLowerCase()}-${classification.id}-expansion-v3`,
        country: market.country,
        region: null,
        postal_prefix: null,
        product_tax_code: classification.code,
        taxability: "taxable",
        rate_ppm: market.rate_ppm,
        priority: 0,
        calculation_method: "static",
        source_component_id: component,
        source_url: market.rate_url,
        source_reference: `B2C DRAFT ONLY. Observed ${market.observed_on}, not a historical legal start date. ${market.review} Classification/registration approval required. Scope: ${market.scope_url}`,
        effective_from: observed,
        effective_to: null,
      });
    }
  }
  // Never make the retained EU/non-EU source snapshot look freshly retrieved.
  artifact.refreshed_at = artifact.source.components.map((source) => source.retrieved_at).sort()[0];
  const retainedAge = (Date.parse(asOf) - Date.parse(artifact.refreshed_at)) / 86400000;
  if (
    retainedAge > 30 ||
    artifact.source.components.some((source) => source.retrieved_at.slice(0, 10) > asOf)
  )
    throw new Error("Future or stale retained source evidence");
  artifact.content_sha256 = contentChecksum(artifact);
  return validateRuleSetArtifact(artifact);
}

function dateOnly(value) {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}$/.test(value) ||
    !Number.isFinite(Date.parse(value)) ||
    new Date(value).toISOString().slice(0, 10) !== value
  )
    throw new Error("Invalid evidence date");
}

async function main() {
  const read = async (name) =>
    JSON.parse(
      await readFile(new URL(`../fixtures/indirect-tax/${name}`, import.meta.url), "utf8"),
    );
  const artifact = buildExpandedSoftwareCandidate(
    await read("eu-tedb-standard-rates-2026-08-31.json"),
    await read("software-rate-expansion-2026-09-06.json"),
    new Date().toISOString().slice(0, 10),
  );
  process.stdout.write(`${JSON.stringify(artifact, null, 2)}\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
