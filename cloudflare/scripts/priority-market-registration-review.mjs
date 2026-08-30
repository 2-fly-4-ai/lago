import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

import { contentChecksum, validateRuleSetArtifact } from "./indirect-tax-rule-set.mjs";
import { validateTedbSnapshot } from "./eu-tedb-standard-rates.mjs";
import { buildPriorityMarketCandidate } from "./priority-market-tax-candidate.mjs";

const NON_EU_GROUPS = [
  ["great-britain", "GB"],
  ["india", "IN"],
  ["south-korea", "KR"],
  ["mexico", "MX"],
  ["switzerland", "CH"],
];

export function buildPriorityRegistrationReview(candidateValue) {
  const candidate = validateRuleSetArtifact(candidateValue);
  const allCountries = [...new Set(candidate.rules.map((rule) => rule.country))].sort();
  const nonEuCountries = new Set(NON_EU_GROUPS.map(([, country]) => country));
  const euCountries = allCountries.filter((country) => !nonEuCountries.has(country));
  if (euCountries.length !== 27 || allCountries.length !== 32) {
    throw new Error("priority registration review requires exact 27-EU and 32-country coverage");
  }
  const marketGroups = [
    group("eu-oss", euCountries),
    ...NON_EU_GROUPS.map(([id, country]) => group(id, [country])),
  ];
  const review = {
    format: "serp-indirect-tax-registration-review/v1",
    id: "priority-market-registration-review-2026-08-31",
    status: "draft",
    rule_set_id: candidate.id,
    rule_set_sha256: candidate.content_sha256,
    organization_external_id: null,
    reviewed_at: null,
    content_sha256: "",
    market_groups: marketGroups,
  };
  review.content_sha256 = contentChecksum(review);
  return validateRegistrationReview(review);
}

export function validateRegistrationReview(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("registration review must be an object");
  }
  exactKeys(value, [
    "content_sha256",
    "format",
    "id",
    "market_groups",
    "organization_external_id",
    "reviewed_at",
    "rule_set_id",
    "rule_set_sha256",
    "status",
  ]);
  if (value.format !== "serp-indirect-tax-registration-review/v1" || value.status !== "draft") {
    throw new Error("registration review must remain a supported draft");
  }
  if (value.organization_external_id !== null || value.reviewed_at !== null) {
    throw new Error("registration review cannot target an organization before approval");
  }
  if (
    !/^[a-z0-9][a-z0-9._-]+$/.test(value.id) ||
    !/^[a-z0-9][a-z0-9._-]+$/.test(value.rule_set_id)
  ) {
    throw new Error("registration review identifiers are invalid");
  }
  if (!/^[a-f0-9]{64}$/.test(value.rule_set_sha256)) {
    throw new Error("registration review rule-set checksum is invalid");
  }
  if (!Array.isArray(value.market_groups) || value.market_groups.length !== 6) {
    throw new Error("registration review must contain six market groups");
  }
  const countries = [];
  for (const marketGroup of value.market_groups) {
    exactKeys(marketGroup, [
      "collection_status",
      "countries",
      "effective_from",
      "id",
      "registration_reference",
      "registration_state",
    ]);
    if (
      marketGroup.collection_status !== "disabled" ||
      marketGroup.registration_state !== "unconfirmed" ||
      marketGroup.registration_reference !== null ||
      marketGroup.effective_from !== null
    ) {
      throw new Error("registration review market groups must remain disabled and unconfirmed");
    }
    if (!Array.isArray(marketGroup.countries) || marketGroup.countries.length === 0) {
      throw new Error("registration review country coverage is invalid");
    }
    for (const country of marketGroup.countries) {
      if (!/^[A-Z]{2}$/.test(country) || countries.includes(country)) {
        throw new Error("registration review countries must be unique ISO codes");
      }
      countries.push(country);
    }
  }
  if (countries.length !== 32)
    throw new Error("registration review country coverage is incomplete");
  if (!/^[a-f0-9]{64}$/.test(value.content_sha256)) {
    throw new Error("registration review checksum is invalid");
  }
  const expectedChecksum = contentChecksum(value);
  if (value.content_sha256 !== expectedChecksum) {
    throw new Error("registration review checksum does not match its content");
  }
  return value;
}

function group(id, countries) {
  return {
    id,
    countries,
    registration_state: "unconfirmed",
    collection_status: "disabled",
    registration_reference: null,
    effective_from: null,
  };
}

function exactKeys(value, expected) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("registration review member must be an object");
  }
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  if (JSON.stringify(actual) !== JSON.stringify(sortedExpected)) {
    throw new Error(`registration review fields are invalid: ${actual.join(",")}`);
  }
}

async function main() {
  const snapshot = validateTedbSnapshot(
    JSON.parse(
      await readFile(
        new URL("../fixtures/indirect-tax/eu-tedb-standard-rates-2026-08-31.json", import.meta.url),
        "utf8",
      ),
    ),
  );
  const review = buildPriorityRegistrationReview(buildPriorityMarketCandidate(snapshot));
  process.stdout.write(`${JSON.stringify(review, null, 2)}\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
