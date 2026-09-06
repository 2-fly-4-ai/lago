import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { buildPriorityMarketCandidate } from "./priority-market-tax-candidate.mjs";
import { buildExpandedSoftwareCandidate } from "./expanded-software-tax-candidate.mjs";
import { addCanadianSoftwareRules } from "./canada-software-candidate.mjs";
import { addUSUniformSoftwareRules } from "./us-uniform-software-candidate.mjs";
import { addNoSalesTaxSoftwareRules } from "./no-sales-tax-software-candidate.mjs";

const CANADIAN_REGIONS = "AB BC MB NB NL NS NT NU ON PE QC SK YT".split(" ");
const REVIEW_TIME_ZONE = "Pacific/Fiji";

// These dated review artifacts are produced in SERP's operating timezone. Using UTC here made a
// newly reviewed source appear to be from the future for part of the Fiji calendar day.
export function currentReviewDate(now = new Date()) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone: REVIEW_TIME_ZONE,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    })
      .formatToParts(now)
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, part.value]),
  );
  return `${parts.year}-${parts.month}-${parts.day}`;
}

// Country aggregates cannot establish which state, city or address was served.
// Regional rule presence must never imply that every payment in a country is covered.
function candidateCoverage(country, rules) {
  if (!rules.length) return "none";
  const unrestricted = rules.filter((rule) => !rule.postal_prefix);
  if (country === "US") return "regional_partial";
  if (unrestricted.some((rule) => !rule.region)) return "country_candidate";
  if (
    country === "CA" &&
    CANADIAN_REGIONS.every((region) => unrestricted.some((rule) => rule.region === region))
  )
    return "country_candidate";
  return "regional_partial";
}

// Offline review only: no provider client, network calls, SQL or activation output.
export function buildCoverageReview(geography, candidate, authorityReview) {
  if (
    geography.format !== "serp-sales-geography-aggregate/v1" ||
    !Array.isArray(geography.countries)
  ) {
    throw new Error("Invalid aggregate geography");
  }
  if (
    authorityReview.format !== "serp-tax-authority-review/v1" ||
    authorityReview.activation_allowed !== false
  ) {
    throw new Error("Authority evidence must be review-only");
  }
  const sources = new Map();
  for (const source of authorityReview.sources) {
    if (!/^[A-Z]{2}$/.test(source.country) || sources.has(source.country) || !source.urls?.length) {
      throw new Error("Invalid or duplicate authority country");
    }
    for (const value of source.urls) {
      const url = new URL(value);
      if (
        url.protocol !== "https:" ||
        url.username ||
        url.password ||
        /(^|\.)stripe\.com$/.test(url.hostname)
      ) {
        throw new Error("Only non-Stripe public HTTPS authority references are allowed");
      }
    }
    if (
      source.rate_ppm !== null &&
      (!Number.isSafeInteger(source.rate_ppm) || source.rate_ppm < 0 || source.rate_ppm > 1000000)
    ) {
      throw new Error("Invalid candidate rate");
    }
    sources.set(source.country, source);
  }
  const seen = new Set();
  const rows = geography.countries.map((row) => {
    if ((!/^[A-Z]{2}$/.test(row.country) && row.country !== "UNKNOWN") || seen.has(row.country)) {
      throw new Error("Invalid or duplicate sales country");
    }
    seen.add(row.country);
    for (const key of ["paid_events", "invoice_events", "one_time_checkouts"]) {
      if (!Number.isSafeInteger(row[key]) || row[key] < 0)
        throw new Error("Invalid aggregate count");
    }
    if (row.paid_events !== row.invoice_events + row.one_time_checkouts)
      throw new Error("Aggregate counts do not reconcile");
    const evidence = sources.get(row.country);
    const classifications = ["txcd_10103100", "txcd_10202000"].map((code) => {
      const rules = candidate.rules.filter(
        (rule) => rule.country === row.country && rule.product_tax_code === code,
      );
      const coverage = candidateCoverage(row.country, rules);
      return {
        code,
        geographic_coverage: coverage,
        candidate_regions: [...new Set(rules.map((rule) => rule.region).filter(Boolean))].sort(),
        status:
          row.country === "UNKNOWN"
            ? "location_missing"
            : rules.length
              ? coverage === "regional_partial"
                ? "partial_regional_candidate_unapproved"
                : "existing_candidate_unapproved"
              : evidence
                ? "authority_review_incomplete"
                : "source_research_required",
        candidate_rule_ids: rules.map((rule) => rule.id),
        source_urls: [
          ...new Set([...rules.map((rule) => rule.source_url), ...(evidence?.urls ?? [])]),
        ],
        production_ready: false,
      };
    });
    return {
      ...row,
      classifications,
      collection_registration: "not_assessed",
      review:
        evidence?.review ??
        "Classification, regional exceptions, registration and source freshness require review.",
    };
  });
  return {
    format: "serp-tax-coverage-review/v1",
    activation_allowed: false,
    source_policy: "official-authorities-only",
    history_complete: geography.history_complete,
    known_countries: rows.filter((row) => row.country !== "UNKNOWN").length,
    paid_events: rows.reduce((total, row) => total + row.paid_events, 0),
    countries_with_both_candidate_codes: rows.filter((row) =>
      row.classifications.every((item) => item.candidate_rule_ids.length > 0),
    ).length,
    countries_with_countrywide_candidates: rows.filter((row) =>
      row.classifications.every((item) => item.geographic_coverage === "country_candidate"),
    ).length,
    rows,
  };
}

export function renderCoverageReview(review) {
  const lines = [
    "# Official-source tax coverage review",
    "",
    `Known countries/territories: ${review.known_countries}; retained successful payment events: ${review.paid_events}.`,
    `Countries with both existing candidate classifications: ${review.countries_with_both_candidate_codes}. Candidate presence does not mean production ready.`,
    `Countries with countrywide candidates for both classifications: ${review.countries_with_countrywide_candidates}. Regional candidates do not establish coverage of country-level payment counts.`,
    "",
    "This is an offline gap report, not an importable rate set, registration, or collection instruction. No Stripe API calls. Lifetime history is incomplete. Unknown locations remain explicit.",
    "",
    "| Country | Paid events | Invoice events | One-time checkouts | Remote-software candidate | Downloaded-software candidate |",
    "| --- | ---: | ---: | ---: | --- | --- |",
    ...review.rows.map(
      (row) =>
        `| ${row.country} | ${row.paid_events} | ${row.invoice_events} | ${row.one_time_checkouts} | ${row.classifications[0].status} | ${row.classifications[1].status} |`,
    ),
    "",
  ];
  return lines.join("\n");
}

async function main() {
  const read = async (name) =>
    JSON.parse(
      await readFile(new URL(`../fixtures/indirect-tax/${name}`, import.meta.url), "utf8"),
    );
  const [geography, tedb, sources] = await Promise.all([
    read("sales-geography-2026-09-05.json"),
    read("eu-tedb-standard-rates-2026-08-31.json"),
    read("authority-review-2026-09-05.json"),
  ]);
  const expansion =
    process.argv.includes("--expanded") ||
    process.argv.includes("--canada") ||
    process.argv.includes("--us")
      ? await read("software-rate-expansion-2026-09-06.json")
      : null;
  const asOf = currentReviewDate();
  let candidate = expansion
    ? buildExpandedSoftwareCandidate(tedb, expansion, asOf)
    : buildPriorityMarketCandidate(tedb);
  if (process.argv.includes("--canada") || process.argv.includes("--us")) {
    candidate = addCanadianSoftwareRules(
      candidate,
      await read("canada-software-components-2026-09-06.json"),
      asOf,
    );
  }
  if (process.argv.includes("--us")) {
    candidate = addNoSalesTaxSoftwareRules(
      candidate,
      await read("no-sales-tax-software-2026-09-06.json"),
      asOf,
    );
    candidate = addUSUniformSoftwareRules(candidate, asOf);
  }
  for (const held of expansion?.held_regions ?? []) {
    if (!sources.sources.some((source) => source.country === held.country)) {
      sources.sources.push({
        country: held.country,
        rate_ppm: null,
        urls: [held.url],
        review: held.reason,
      });
    }
  }
  const review = buildCoverageReview(geography, candidate, sources);
  process.stdout.write(
    process.argv.includes("--json")
      ? `${JSON.stringify(review, null, 2)}\n`
      : renderCoverageReview(review),
  );
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
