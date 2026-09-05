# US software source review

Observed 2026-09-05 UTC (2026-09-06 Fiji). Local work, not deployed or activated.

## Verified uniform rules

- Connecticut: personal-use prewritten software, electronically accessed or transferred,
  6.35%; the state explicitly says there are no additional local sales taxes.
  [DRS source](https://portal.ct.gov/drs/sales-tax/tax-information).
- California: software delivered exclusively electronically, with no physical backup or printed
  copy, is generally nontaxable. The candidate covers downloaded software only, not an inferred
  hosted-service classification or physical bundle.
  [CDTFA source](https://cdtfa.ca.gov/formspubs/pub109/nontaxable-sales.htm).

`cloudflare/scripts/us-uniform-software-candidate.mjs` adds these three explicitly state-scoped
rules with source citations and a 30-day review boundary. It refuses pre-existing US rules rather
than overwriting them. Its version 21 follows the expanded version 18, Canadian version 19, and
explicit no-sales-tax version 20 candidates, so the
publication chain cannot move backward. No US country wildcard exists. These are candidates, not
collection scopes.

## Repeatable public matrix acquisition

`cloudflare/scripts/sst-software-review.mjs` reads the public interface used by the
[Streamlined Sales Tax matrix application](https://sst.streamlinedsalestax.org/otm):

- `/api/states`
- `/api/forms/State/{stateId}/FormType/1/Versions`
- `/api/forms/{formId}/rows`

The run at 2026-09-05T14:26:59Z retrieved 24 published state matrices and extracted 26 software
rows per state (624 rows total). It excludes test states and unpublished versions; it retains
statute references, exceptions and original answer codes. Matrix answer `1` is NOT a 1% rate.
The result is review evidence only, not an importable tax table. Current form versions were 2026
except KS and OK at 2026.1. No accounts, credentials, Stripe API or customer data were used.

Participating states: AR, GA, IA, IN, KS, KY, MI, MN, NC, ND, NE, NJ, NV, OH, OK, RI, SD, TN,
UT, VT, WA, WI, WV, WY. Local-rate boundaries and software exceptions still require review.

## Address-level rate source

Washington provides a [free public address-rate interface](https://webgis.dor.wa.gov/webapi/)
with [documented matching statuses](https://dor.wa.gov/wa-sales-tax-rate-lookup-url-interface).
The authority's own example office address returned HTTP 200, jurisdiction 3406, Q32026,
6.5% state plus 3.3% local, total 9.8%, and match status 2 (corrected address requiring validation).
This does not justify using that rate for the state or accepting a ZIP-only match. No customer
address was queried. A bounded, fixed-endpoint runtime client now parses the official response and
rejects ambiguous, unsafe, ZIP-only and unreconciled results. The local checkout integration now
collects the complete US billing address, returns result-code-2 normalization to the customer for
explicit review, and accepts it only when a second calculation submits the exact normalized
address. The immutable quote stores the authority resolution snapshot; street and city are
AES-GCM encrypted under a separately configured versioned key. Recurring invoices decrypt and
hash-check the confirmed address, query the current authority rate again, and preserve a new
resolution snapshot. Result 4, stale periods, state-rate disagreement, missing keys and altered
addresses all fail closed. This implementation and migration 0109 remain local and undeployed.

## Coverage reporting

`node scripts/tax-coverage-review.mjs --us` combines the existing expanded, Canadian and explicit
no-sales-tax drafts with these US rules. It reports 64 countrywide candidate classifications and
partial US coverage.
The current retained-sales weighting is explicit:

- 2,015 events are in the 64 countrywide candidate markets;
- 1,861 events are in the partially covered United States and are NOT labeled countrywide covered
  without state/address evidence;
- 201 events have a known country but no countrywide or partial candidate; and
- 99 events have no resolved country.

The retained aggregate has 4,176 total events INCLUDING 99 with unknown country; do not add the
99 a second time. Candidate presence never means production-ready or complete lifetime history.

### Remaining known-country ledger

The remaining 201 known-country events are not one homogeneous “missing rate” bucket. The
highest-volume unresolved destinations have different legal or geographic blockers:

- Brazil (45): the 2026 IBS/CBS transition and subnational destination rules are not safely
  represented by one static national checkout rate.
- China (32): current official material points to recipient withholding and platform reporting;
  it does not establish one foreign-supplier B2C checkout rule.
- Israel (16): the current recipient-liability boundary must not be replaced with a supplier
  collection rule inferred from proposed legislation.
- Fiji (10): FRCS material applies a reverse-charge rule to imported services; supplier collection
  is not established.
- Pakistan (10): the [FBR provisions](https://www.fbr.gov.pk/section-152/152725) describe bank
  withholding on offshore digital-service income, not a customer VAT amount for SERP to add.
- Macao (8) and Kuwait (7): available government pages did not establish a current, explicit
  foreign-software VAT/sales-tax rule or an authoritative zero-tax statement.
- Guatemala (6): SAT confirms the 12% general IVA rate, but the foreign digital-supplier collection
  mechanism and software classification were not established.
- Lebanon (6): the Ministry of Finance describes nonresident VAT registration, but the reviewed
  page did not tie a current rate and software classification to this B2C destination flow.
- The remaining 61 events are spread across 35 low-volume destinations. They remain visible in
  the generated report and fail closed until equally strong source and mechanism evidence exists.

These are deliberate safety boundaries, not silent zero rates. A rate alone is insufficient where
the buyer, card issuer, marketplace, or a subnational authority may be the party responsible.

## Signed publication validation

`scripts/signed-tax-artifact.mjs` verifies Ed25519 detached envelopes against an independently
supplied trusted public-key registry. The signature binds checksum, version, environment,
organization, issuer key and validity window. It rejects altered content, stale/future sources,
unknown/revoked/ambiguous keys, malformed signatures, target mismatch and rollback. Draft rendering
requires an explicit previous-artifact baseline and refuses dropped geographic matching keys.
The signed renderer includes Canadian component rows and still creates drafts only.

Tests use ephemeral in-memory keys. No production publisher key was created/read, and no deployed
activation path was changed to require this verifier yet. Selecting the real publisher and
trusted-key distribution remains an operational decision, not something inferred from a test key.
