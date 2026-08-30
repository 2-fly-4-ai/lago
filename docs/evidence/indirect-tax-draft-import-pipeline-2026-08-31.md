# Indirect Tax Draft Import Pipeline Evidence

Date: 2026-08-31

## Outcome

The local tax engine now has a deterministic, guarded ingestion boundary for rate data. The
pipeline accepts only `serp-indirect-tax-rule-set/v1` JSON artifacts with exact fields, canonical
timestamps, official HTTPS rule references, unique match keys, and a valid SHA-256 content digest.

The renderer can produce inserts only for a `draft` rule set and its immutable rules. The artifact
format rejects registration scopes, and the renderer contains no activation operation. This keeps
rate availability separate from both organization registration and collection enablement.

## Review candidate

The first candidate contains three country-level standard-rate examples for the provisional generic
software tax code:

| Country       | Candidate rate | Official source            |
| ------------- | -------------: | -------------------------- |
| Australia     |            10% | Australian Taxation Office |
| Great Britain |            20% | HM Revenue & Customs       |
| New Zealand   |            15% | New Zealand Inland Revenue |

Artifact checksum:
`490a3c3d23ac5a06d6f8a7407ca432871da614c61ea95ceeccc0f78465f287b8`

The candidate is intentionally incomplete and unapproved. It is not a production dataset and has
not been imported into a remote database.

## Verification

- Candidate validation passed.
- Five Node tests passed, including checksum stability, mutation detection, activation rejection,
  registration-scope rejection, and SQL escaping.
- `oxlint` returned zero warnings and zero errors for the importer and its tests.
- The generated SQL was applied to a completely fresh temporary local D1 state after migrations
  `0001` through `0101`.
- The local query returned one rule set with `status = draft` and the expected checksum.
- The local query returned exactly AU `100000` ppm, GB `200000` ppm, and NZ `150000` ppm rules.
- The local registration-scope count remained zero.
- `PRAGMA foreign_key_check` returned no rows.
- The two focused local-tax/EPD suites passed 8/8 tests.
- Binding checks and API, operator, and portal dry-run builds passed.
- The complete application suite remains 424/427: the same two invoice-number uniqueness failures
  in `subscription-lifecycle.test.ts` and the same missing credit application in
  `subscription-plan-change.test.ts` that predate this importer phase. No new failure appeared.

## Safety boundary

No remote D1 database, Worker, Cloudflare resource, Stripe object, EPD transaction, tax
registration, production route, `store-new`, or `serp-auth` state was changed.
