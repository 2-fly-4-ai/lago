import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

import { buildPriorityMarketCandidate } from "./priority-market-tax-candidate.mjs";
import {
  buildPriorityRegistrationReview,
  validateRegistrationReview,
} from "./priority-market-registration-review.mjs";

const snapshot = JSON.parse(
  await readFile(
    new URL("../fixtures/indirect-tax/eu-tedb-standard-rates-2026-08-31.json", import.meta.url),
    "utf8",
  ),
);
const candidate = buildPriorityMarketCandidate(snapshot);

test("keeps every priority market disabled, unconfirmed, and untargeted", () => {
  const review = buildPriorityRegistrationReview(candidate);
  assert.equal(review.market_groups.length, 6);
  assert.equal(review.market_groups.flatMap((group) => group.countries).length, 32);
  assert.equal(review.organization_external_id, null);
  assert.equal(review.reviewed_at, null);
  assert.ok(review.market_groups.every((group) => group.collection_status === "disabled"));
  assert.ok(review.market_groups.every((group) => group.registration_state === "unconfirmed"));
  assert.ok(review.market_groups.every((group) => group.registration_reference === null));
  assert.ok(review.market_groups.every((group) => group.effective_from === null));
});

test("rejects enabling collection, targeting an organization, and stale checksums", () => {
  const review = buildPriorityRegistrationReview(candidate);
  assert.throws(
    () =>
      validateRegistrationReview({
        ...review,
        market_groups: [
          { ...review.market_groups[0], collection_status: "enabled" },
          ...review.market_groups.slice(1),
        ],
      }),
    /disabled and unconfirmed/,
  );
  assert.throws(
    () => validateRegistrationReview({ ...review, organization_external_id: "serp-billing" }),
    /cannot target an organization/,
  );
  assert.throws(
    () => validateRegistrationReview({ ...review, rule_set_sha256: "0".repeat(64) }),
    /checksum does not match/,
  );
});
