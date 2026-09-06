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

The user explicitly approved the exact production operation on 2026-09-07:
apply `0113_product_scoped_renewals.sql` to `serp-prod-lago-native-d1`, then deploy
the reviewed Lago version with automatic collection enabled in `product_scoped`
mode. It creates two new tables and tenant/immutability guards, seeds Sprout only,
and does not attribute or enroll historical subscriptions.

Migration 0113 applied successfully after a fresh D1 recovery bookmark:
`000001d3-000018a8-000050de-c2a9a443f4dca5e52aadd9a91ad2f01b`.
No pending migrations, zero foreign-key violations, no historical attribution or
automatic scopes/executions. Only `org-serp-billing` / `sprout-video-downloader`
has an enabled product collection policy.

Initial production promotion deployed Lago `cd048e75-ed20-41bd-adb8-cb1751107e4b`
before Store `5cc60532-5f36-4379-b412-7f39c9046072`. Lago settings changed only
automatic collection to `1` and scope mode to `product_scoped`; Store settings
changed only build metadata. No bindings removed; tax remains disabled.
Both source trees match their merged main trees (Lago PR 7, Store PR 70).

Post-deploy verification found the 16:15 UTC reconciliation run failed on one
legacy alphanumeric billing checkpoint (`easy_pay_direct_vault_checkpoint_missing`).
New minute runs completed, but receipt reconciliation must not fail every 15 minutes.
Added a production recovery guard: defer an incompatible checkpoint before claiming
it, preserve its evidence, and make no provider request. Customer-initiated repair
with a fresh token remains supported. Regression checks repeat reconciliation twice,
assert no provider calls or execution changes, then prove fresh-token recovery.
This does not mark the unresolved historical payment successful or failed.

Emergency containment: disable automatic collection / Sprout product policy and
stop new Lago checkouts; retain schema and reconciliation evidence. Never retry an
uncertain charge through a second provider or blindly roll back the database.
