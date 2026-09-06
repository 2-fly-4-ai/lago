# Local Indirect Tax Engine

Opened: 2026-08-30
Status: active

## Objective

Replace paid per-checkout Stripe Tax calculations for Lago/EPD with a versioned, auditable D1
calculator using official tax-authority sources. The customer must see and
authorize the tax-inclusive total before EPD receives a payment request.

## Ownership and consumers

- Lago owns the rule-set schema, registration scopes, deterministic calculation, quote persistence,
  invoice/payment-request repricing, and reconciliation state.
- `store-new` remains the checkout router and does not own tax rates or tax arithmetic.
- `serp-auth` remains the entitlement authority and is not changed by this plan.
- The future tax-data publisher owns source licensing, provenance, refresh cadence, review, and
  activation of each immutable rule-set version. That publisher is not yet selected.
- EPD consumes only the final authorized amount. It does not determine tax.
- User decision on 2026-09-05: no further Stripe tax requests, including sandbox benchmarking.
  Use official authorities for rates, software taxability, boundaries and evidence. Existing Stripe
  checkout/payment functionality is not part of this tax-source change.

## Scope

- Add immutable, versioned D1 tax rule sets with source and freshness metadata.
- Keep explicit organization registration/collection scopes separate from rate availability.
- Support country, region, and postal-prefix specificity for a configured generic product tax code.
- Use integer parts-per-million rates and deterministic nearest-minor-unit rounding.
- Persist the exact rule-set and rule used for each EPD tax quote.
- Reuse the existing signed-checkout replacement and atomic invoice/payment-request repricing flow.
- Mark local quotes committed after EPD success without an external tax-provider transaction call.
- Fail closed on missing, stale, ambiguous, unregistered, or invalid data.
- Validate representative sandbox results without live cards or production data.

## Non-goals

- No production D1 migration, production Worker deployment, tax registration, tax collection,
  filing, remittance, live EPD payment, or production Stripe Tax request is authorized here.
- No rate scraping or bulk copying from Stripe is authorized or treated as a licensed source.
- No attempt is made to infer a registration obligation from the existence of a tax rate.
- No production tax rule set is seeded until source authority and update ownership are approved.

## Safety and privacy

- Production keeps `EASY_PAY_DIRECT_TAX_MODE=disabled` throughout this plan.
- A missing registration scope is an error, not a zero-tax result.
- A missing rule is an error; zero tax requires an explicit `exempt` rule.
- An active rule set older than the configured freshness limit is rejected.
- Billing country, region and postal code remain queryable for reporting. Address-resolved rules
  persist street and city only as AES-GCM ciphertext under a dedicated versioned encryption key,
  plus a hash and the authority resolution snapshot needed for audit and recurring recalculation.
  Card data remains in EPD-hosted fields.
- Rule records contain public source references, never tax IDs or credentials.
- Remote migrations, deployments, provider calls, and payment tests require a separate action-time
  approval under repository safety policy.

## Rollout order

1. Implement and test the local calculator and schema using synthetic fixtures.
2. Select a lawful, maintainable source for every intended jurisdiction and define its importer.
3. Build a versioned candidate dataset and review provenance, classification, and registrations.
4. Compare a bounded address matrix against authoritative examples, without Stripe requests.
5. With explicit approval, apply the migration and candidate dataset to staging in shadow mode.
6. Review discrepancies and freshness behavior; then explicitly approve staging enforcement.
7. Treat any production migration, data load, or activation as a new approval-gated rollout.

## Rollback

- Set `EASY_PAY_DIRECT_TAX_MODE=disabled` to prevent new tax quotes.
- Do not delete historical rule sets or quote references; retire a bad rule set and activate a new
  reviewed version.
- Existing direct Stripe checkout remains unchanged and is not routed through this engine.
- If a quote has already repriced a pending checkout, invalidate that checkout and issue a fresh
  signed checkout rather than mutating the historical quote.

## Acceptance criteria

- Local calculations make no Stripe request and produce the exact EPD amount shown to the customer.
- 6.625% of USD 9.00 rounds deterministically to USD 0.60.
- More-specific postal rules override region rules.
- Explicit exemptions produce zero; missing scopes/rules, stale sets, and conflicts fail closed.
- The applied quote records the immutable rule-set and rule IDs.
- EPD success commits the local quote without a Stripe Tax transaction.
- Migration tests, focused tests, typecheck, lint, formatting, binding generation, and dry-run builds
  pass before any staging action.
- A reviewed source/update owner and a bounded benchmark report exist before staging activation.

## Progress

### Coverage repair opened — 2026-09-06

Superseded first expansion checkpoint: see
[software expansion evidence](../../evidence/software-tax-expansion-2026-09-06.md).
Eleven new authority-backed standard-rate candidates bring the draft to 43 countries/86 rules.
The report retains all 108 observed countries plus unknown locations. All 27 tax-script tests
and the complete Lago gate (466 Worker tests) passed. No staging/production import or activation
was performed. The plan remains open: regional composition, classification, non-collection
semantics, remaining coverage, refresh/signing and actual collection scopes are not yet complete.

User requested the remaining tax gaps be fixed before continuing rollout. Work stays local until
the exact staging deployment/data operation is approved; no production changes or Stripe calls.
Lago owns the source dataset and candidate validation; Store routing is unchanged.

Execution order:

1. Recheck official rate and software-scope evidence, prioritizing US, AU and CA by observed sales.
2. Separate national-rate evidence from complete destination tax: US needs state/local coverage;
   Canada needs province and separate provincial-tax treatment. Do not invent a national fallback.
3. Add independently testable, dated expansion evidence and draft generation with explicit
   classification, freshness and geographic exclusions. Preserve prior immutable snapshots.
4. Run tax script tests, checkout-error regression and the full local Lago gate. Record exact
   unresolved collection-registration and classification decisions rather than activate guesses.
5. Prepare, but do not silently perform, staging promotion of the checkout error fix and reviewed
   data. Production canary expansion remains a separate rollout.

Billing frequency is not software delivery classification. The existing cadence-based tax-code
selection is a compatibility limitation, not evidence that a monthly downloadable app is SaaS.
Any runtime classification change must cover both initial checkout and renewal quoting together.

### Canadian components and generic-plan backfill — 2026-09-06

Local continuation completed: a guarded metadata-only backfill for the 13 reviewed generic-price
variants; a 46-country/116-rule combined draft with all 13 Canadian provinces/territories;
migration 0108 for immutable levy evidence; per-component rounding; missing-component rejection;
and reproducible offline coverage output (`--canada`). No remote deployment or database change.
See [classification evidence](../../evidence/generic-plan-tax-classification-2026-09-06.md) and
[Canadian component evidence](../../evidence/canadian-tax-components-2026-09-06.md).

Full gate passed: **495 Worker tests / 79 files**, 32 tax-script tests, Access and checkout-message
tests, inventory, formatting, lint, generated types, typecheck and all seven dry-run builds.
The Canadian tests apply the complete generated draft to migrated local D1, then check both
software classifications in every province, independent rounding, collect/off, missing evidence,
immutable component records and foreign keys. No provider payment request was made by this work.

The full plan stays open. US destination resolution, remaining countries, publisher signing,
refresh ownership, per-levy collection selection/reporting and actual staging QA remain.

Additional local progress, 2026-09-06 Fiji: US coverage reporting now distinguishes partial state
candidates from countrywide coverage; verified CT personal-software and CA downloaded-software
rules are draft-only. The public SST acquisition tool successfully retrieved 24 state matrices
(624 software rows), preserving citations and exceptions without interpreting answer codes as
rates. Ed25519 publication verification and guarded signed draft rendering are implemented locally;
real publisher selection and deployment enforcement are not complete. See
[US evidence and remaining boundaries](../../evidence/us-software-source-review-2026-09-06.md).
Do not replace an active ruleset with this candidate if doing so drops currently supported
destinations. Do not deploy strict plan-classification enforcement before the target plans have
their reviewed metadata. Do not activate taxable Canadian rules without their component rows.

### Washington address-rate completion — 2026-09-06

Migration 0109 and the local runtime now support authority-resolved Washington destination rates.
The EPD checkout collects a complete US address, uses the Washington Department of Revenue's fixed
public XML endpoint, reconciles the 6.5% state component against the reviewed rule, and records the
location code, jurisdiction, quarter and state/local components. Authority result code 2 is not
silently accepted: the normalized address is shown back to the customer and must be submitted
unchanged on a second **Update total** action. Result 4 and all ambiguous/stale/mismatched responses
fail closed.

Street and city are encrypted with AES-GCM under the dedicated
`INDIRECT_TAX_ADDRESS_ENCRYPTION_SECRET`; each quote records
`INDIRECT_TAX_ADDRESS_ENCRYPTION_KEY_ID`. Renewal calculation decrypts and hash-checks the last
committed address, resolves the current authority rate, and stores a new immutable resolution
snapshot. It cannot fall back to ZIP-only or an old local rate. The focused Washington, checkout,
provider, vault and renewal matrix is **80/80**. This patch is local and undeployed; a real secret,
migration 0109, candidate activation and deployment still require the staged rollout operation.

### Current local candidate baseline — 2026-09-06

The immutable draft chain now ends at version 21: expanded software version 18, Canadian components
version 19, explicit no-sales-tax version 20, and partial US version 21. Indonesia, Serbia,
Kazakhstan, Peru, Nigeria, Morocco, Egypt and Ecuador were added only where current government sources support both
the rate and the nonresident digital/software collection model; Qatar and Vietnam were added as
explicit no-VAT software candidates from their authorities. The combined review reports 64
countrywide candidate markets covering 2,015 retained paid events, partial US support covering
1,861 events, 201 known-country events still outside a candidate, and 99 events with unresolved country. The
aggregate remains 4,176 events; these buckets are mutually exclusive.

This is a coverage and calculation baseline, not permission to collect. Candidate data remains
inactive, actual registrations remain separate, the real artifact-publisher key is unresolved,
and no Worker, D1 database, provider or Store production configuration was changed.

Final local verification for this baseline: **513/513 Worker tests across 81 files**, **45/45 tax
script tests**, formatting, lint, Access fail-closed checks, checkout UI checks, generated binding
checks, TypeScript typecheck, inventory checks and all seven development/production dry-run builds
passed. A fresh temporary D1 replay applied all 109 migrations, reported no pending migrations and
returned zero `PRAGMA foreign_key_check` rows. `git diff --check` and the changed-file credential
scan passed. The production dry-run still has local tax and automatic EPD renewal collection
disabled.

### Official-source expansion — 2026-09-05

The user rejected further Stripe tax requests. New research/refreshes use official authorities
only; historical Stripe benchmark evidence below remains a record, not a next action.
The [coverage review](../../evidence/official-tax-coverage-review-2026-09-05.md) tracks all 108
known countries/territories in retained paid-event geography plus unknown locations. It records
32 existing candidate countries, 16 additional authority-research entries and 60 remaining
source-research gaps. This is not complete lifetime or worldwide coverage.
No new tax rules, scopes or production activations were applied. Billing interval alone is not
sufficient software classification; no-VAT regimes also need explicit non-collection semantics.
Twenty-one tax script tests, formatting and lint passed. The official EU refresh failed twice;
the previous checked snapshot remains unchanged and has not been stamped fresh.

- [x] D1 rule-set, rule, registration-scope, and quote-provenance schema implemented.
- [x] Local deterministic calculation and fail-closed matching implemented.
- [x] Local quote integrated with atomic checkout repricing and EPD-success commit.
- [x] Synthetic rounding, specificity, exemption, missing-scope, stale-data, conflict, and end-to-end
      checkout tests added.
- [ ] Select and document the authoritative production data source and refresh owner.
- [x] Implement the guarded draft-only importer and checksummed review candidate artifact.
- [x] Implement and snapshot the official EU TEDB standard-rate feed with exact 27-country,
      checksum, ambiguity, and offline-contract validation.
- [x] Generate a validated 32-country draft for the six likely first-wave market groups from the
      checked EU snapshot and official non-EU authority references.
- [x] Implement the initial recurring/one-time software-code selection by Lago plan interval.
- [x] Replace cadence-only runtime selection with explicit plan metadata and subscription-scoped
      renewal quote classification (local patch; migration 0107 and plan metadata provisioning
      required before deployment). Add explicit collect/off quote provenance without activation.
- [ ] Populate and validate reviewed software-delivery classification for deployed generic plans
      before expanding production coverage. Billing frequency alone does not establish SaaS versus
      downloaded software or its jurisdiction-specific taxability.
- [x] Generate an untargeted registration review with all six market groups unconfirmed and
      collection disabled.
- [ ] Expand the review candidate to every intended jurisdiction and complete classification,
      boundary, registration, and refresh-owner review.
- [ ] Select the long-term publisher/signing authority and distribute the trusted production key;
      local Ed25519 envelope verification and rollback protection are implemented.
- [x] Run the bounded Stripe sandbox/authoritative-source comparison matrix; Stripe returned zero
      outside its sole California sandbox registration, while the local matrix matched reviewed
      authority rates and deterministic rounding.
- [x] Obtain explicit approval for staging migration, data load, shadow deployment, and QA.
- [x] Apply migration `0101` to staging and load the checksummed 64-rule candidate as a draft
      with zero active rule sets and zero registration scopes.
- [x] Deploy staging Worker version `0b31a222-1ed1-4724-82a9-078ec67430d7` with Stripe test tax
      calculations in shadow mode and EPD live mode disabled.
- [x] Complete end-to-end shadow and enforced quote evidence after the staging Store router sent
      Pornhub Downloader to Lago/EPD, without contact/card data or payment submission.
- [x] Add normalized-null uniqueness guards in migration `0102`, activate immutable candidate v2
      for the synthetic staging organization only, and retire the future-effective v1 candidate.
- [x] Deploy staging Worker version `2ca86009-37b8-480f-bcbf-f27b07d0f6ca` with local D1 tax
      enforcement and EPD live mode disabled.
- [x] Verify UK, DE, FR, IN, KR, MX, and CH tax-inclusive totals and unsupported-destination
      fail-closed behavior on the real staged checkout.
- [ ] Obtain separate explicit approval for any production rollout.
