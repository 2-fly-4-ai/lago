# Local Indirect Tax Engine

Opened: 2026-08-30
Status: active

## Objective

Replace paid per-checkout Stripe Tax calculations for Lago/EPD with a versioned, auditable D1
calculator while retaining Stripe sandbox as an optional QA benchmark. The customer must see and
authorize the tax-inclusive total before EPD receives a payment request.

## Ownership and consumers

- Lago owns the rule-set schema, registration scopes, deterministic calculation, quote persistence,
  invoice/payment-request repricing, and reconciliation state.
- `store-new` remains the checkout router and does not own tax rates or tax arithmetic.
- `serp-auth` remains the entitlement authority and is not changed by this plan.
- The future tax-data publisher owns source licensing, provenance, refresh cadence, review, and
  activation of each immutable rule-set version. That publisher is not yet selected.
- EPD consumes only the final authorized amount. It does not determine tax.
- Stripe test mode may be used for bounded comparisons, but Stripe outputs are not the production
  rule source and no production checkout depends on Stripe Tax.

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
- Only billing country, region, postal code, hashes, opaque identifiers, and the applied rule IDs are
  persisted by the checkout tax path. Card data remains in EPD-hosted fields.
- Rule records contain public source references, never tax IDs or credentials.
- Remote migrations, deployments, provider calls, and payment tests require a separate action-time
  approval under repository safety policy.

## Rollout order

1. Implement and test the local calculator and schema using synthetic fixtures.
2. Select a lawful, maintainable source for every intended jurisdiction and define its importer.
3. Build a versioned candidate dataset and review provenance, classification, and registrations.
4. Compare a bounded address matrix against authoritative examples and Stripe sandbox.
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
- [x] Split recurring and one-time software product codes by Lago plan interval and fail closed when
      plan classification is unavailable.
- [x] Generate an untargeted registration review with all six market groups unconfirmed and
      collection disabled.
- [ ] Expand the review candidate to every intended jurisdiction and complete classification,
      boundary, registration, and refresh-owner review.
- [ ] Select the long-term publisher/signing authority and add artifact signature verification.
- [ ] Run the bounded Stripe sandbox/authoritative-source comparison matrix.
- [ ] Obtain explicit approval for staging migration, data load, shadow deployment, and QA.
- [ ] Obtain separate explicit approval for any production rollout.
