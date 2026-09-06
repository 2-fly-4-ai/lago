# Sprout recurring canary launch

Status: active. User authorized deep verification and the Sprout production canary.

## Owners and rollout

- Store owns signed product selection, pricing, discounts, fulfillment, and the
  Sprout-only live checkout route. It will send immutable per-subscription product
  attribution to Lago, not mutable customer metadata.
- Lago owns saved payment profiles, recurring eligibility, collection, retries,
  cancellation holds, and product-scoped renewal authorization.
- Deploy additive Lago schema/code to staging before Store; test successful first
  payment, renewal, replay, cancellation, one-time exclusion and regional prices.
  Promote only verified source, Lago before Store, with Sprout-only policy.
- Preserve existing direct Stripe routes and production tax-disabled configuration.
  No real card submission or synthetic live charge is authorized for QA.

## Findings / required evidence

- Current scoped collection has no automatic enrollment from checkout. Turning on
  its global switch alone does not complete recurring checkout.
- Manual historical scopes must not authorize unrelated subscriptions on activation.
- Product attribution must be immutable, tenant-bound and authenticated; shared
  plans and customer metadata are not authorization sources.
- Enrollment requires a paid initial invoice, checkout-bound active profile and
  original transaction reference. Disabled scopes must not silently re-enable.
- Check existing production eligibility in aggregates before activation; preserve
  unresolved payment evidence without resubmission.
- Correct Sprout's misleading one-time/lifetime marketing copy.
- Record full gates, staging evidence, production versions and rollback procedure.

## Verification — 2026-09-07

- Lago code `178e977`: full check passed, 526 tests / 81 files, formatting,
  lint, typecheck, Access, checkout UI, inventory, tax and seven dry-run builds.
- Staging migration 0113 applied; native Worker version
  `8268fc0c-26db-4b20-82c8-f350cd8b1f0d`. Gateway test mode only, live disabled.
- Actual browser-hosted EPD test-card checkout completed: USD 9.00 monthly,
  50% regional discount, USD 4.50 paid; California test tax USD 0.00.
- Store success page completed; one paid test order and one Sprout monthly binding.
  Account page correctly required email verification; fictional inbox cannot verify.
- Minute cron automatically enrolled this paid, checkout-bound Sprout subscription.
- Advanced only the synthetic subscription period; confirmed it was the only due
  recurring subscription through the next billing run. Invoked staging workflow
  `sprout-renewal-20260907-proof` with the 2026-09-06T16:10Z schedule timestamp.
  Real gateway-test saved-method renewal succeeded for USD 4.50, one attempt,
  one automatic execution. Two finalized paid invoices (initial plus renewal),
  and next billing period in the future.
- Repeated workflow as `sprout-renewal-20260907-replay`: still one automatic
  execution / attempt and two invoices; no duplicate renewal.
- Synthetic scope disabled and subscription terminated by narrowly guarded staging
  fixture cleanup. This cleanup is not evidence of a browser cancellation test;
  cancellation/closure and one-time exclusion are covered by regression tests.
- Both staging databases: zero foreign-key violations.
- Slack receipts: two sent, one for initial purchase and one for renewal.
- PR: https://github.com/2-fly-4-ai/lago/pull/7 (harness passed;
  automated CodeRabbit review skipped by repository policy).

## Production hold and exact promotion

No production mutation or deployment performed in this verification run.
Repository safety requires explicit approval for the exact production operation:
apply `0113_product_scoped_renewals.sql` to `serp-prod-lago-native-d1`, then deploy
the reviewed Lago version with automatic collection enabled in `product_scoped`
mode. It creates two new tables and tenant/immutability guards, seeds Sprout only,
and does not attribute or enroll historical subscriptions.

After approval: fresh D1 recovery bookmark and aggregate preflight; apply only 0113;
deploy Lago before Store. Preserve tax disabled and all non-Sprout Stripe routes.
Capture production versions and verify no historical scopes become eligible.
Emergency containment: disable automatic collection / Sprout product policy and
stop new Lago checkouts; retain schema and reconciliation evidence. Never retry an
uncertain charge through a second provider or blindly roll back the database.
