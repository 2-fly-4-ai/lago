import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { buildPriorityMarketCandidate } from "./priority-market-tax-candidate.mjs";
import { buildCoverageReview, renderCoverageReview } from "./tax-coverage-review.mjs";

const read = async (name) =>
  JSON.parse(await readFile(new URL(`../fixtures/indirect-tax/${name}`, import.meta.url), "utf8"));
const geography = await read("sales-geography-2026-09-05.json");
const sources = await read("authority-review-2026-09-05.json");
const candidate = buildPriorityMarketCandidate(
  await read("eu-tedb-standard-rates-2026-08-31.json"),
);
const build = (geo = geography, authority = sources) =>
  buildCoverageReview(geo, candidate, authority);

test("keeps all observed countries and reconciles payment counts", () => {
  const review = build();
  assert.equal(review.known_countries, 108);
  assert.equal(review.rows.length, 109);
  assert.equal(review.paid_events, 4176);
  assert.equal(review.countries_with_both_candidate_codes, 32);
  assert.equal(review.rows.find((row) => row.country === "UNKNOWN").paid_events, 99);
  assert.equal(review.rows.find((row) => row.country === "US").paid_events, 1861);
  assert.equal(
    renderCoverageReview(review)
      .split("\n")
      .filter((line) => /^\| [A-Z]{2} \|/.test(line)).length,
    108,
  );
});

test("never confuses a source, candidate, or unknown location with activation", () => {
  const review = build();
  assert.equal(review.activation_allowed, false);
  assert.equal(review.history_complete, false);
  for (const row of review.rows) {
    assert.equal(row.classifications.length, 2);
    assert.equal(row.collection_registration, "not_assessed");
    for (const item of row.classifications) assert.equal(item.production_ready, false);
  }
  assert.equal(
    review.rows.find((row) => row.country === "US").classifications[0].status,
    "authority_review_incomplete",
  );
  assert.equal(
    review.rows.find((row) => row.country === "GB").classifications[0].status,
    "existing_candidate_unapproved",
  );
  assert.equal(
    review.rows.find((row) => row.country === "UNKNOWN").classifications[0].status,
    "location_missing",
  );
  assert.equal(
    review.rows.find((row) => row.country === "AR").classifications[0].status,
    "source_research_required",
  );
});

test("rejects duplicate countries and unreconciled or invalid counts", () => {
  const duplicate = structuredClone(geography);
  duplicate.countries.push(duplicate.countries[0]);
  assert.throws(() => build(duplicate), /duplicate/);
  const mismatch = structuredClone(geography);
  mismatch.countries[0].paid_events++;
  assert.throws(() => build(mismatch), /reconcile/);
  mismatch.countries[0].paid_events = -1;
  assert.throws(() => build(mismatch), /Invalid aggregate count/);
});

test("rejects Stripe references, credentials, invalid rates and activation", () => {
  for (const url of [
    "https://api.stripe.com/v1/tax/calculations",
    "https://user:secret@example.com/rates",
    "http://example.com/rates",
  ]) {
    const bad = structuredClone(sources);
    bad.sources[0].urls = [url];
    assert.throws(() => build(geography, bad), /public HTTPS/);
  }
  const active = structuredClone(sources);
  active.activation_allowed = true;
  assert.throws(() => build(geography, active), /review-only/);
  const invalid = structuredClone(sources);
  invalid.sources[0].rate_ppm = -1;
  assert.throws(() => build(geography, invalid), /Invalid candidate rate/);
});
