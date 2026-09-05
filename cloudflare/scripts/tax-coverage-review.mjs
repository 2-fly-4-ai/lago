import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { buildPriorityMarketCandidate } from "./priority-market-tax-candidate.mjs";

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
      return {
        code,
        status:
          row.country === "UNKNOWN"
            ? "location_missing"
            : rules.length
              ? "existing_candidate_unapproved"
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
    rows,
  };
}

export function renderCoverageReview(review) {
  const lines = [
    "# Official-source tax coverage review",
    "",
    `Known countries/territories: ${review.known_countries}; retained successful payment events: ${review.paid_events}.`,
    `Countries with both existing candidate classifications: ${review.countries_with_both_candidate_codes}. Candidate presence does not mean production ready.`,
    "",
    "This is an offline gap report, not an importable rate set, registration, or collection instruction. No Stripe API calls. Lifetime history is incomplete. Unknown locations remain explicit.",
    "",
    "| Country | Paid events | Invoice events | One-time checkouts | Recurring candidate | One-time candidate |",
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
  const review = buildCoverageReview(geography, buildPriorityMarketCandidate(tedb), sources);
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
