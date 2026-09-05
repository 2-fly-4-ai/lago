# Lago renewal scheduler hardening

Opened: 2026-09-05

## Objective

Close the two post-acceptance operational gaps found in the staging audit: one-time purchase rows
must never enter recurring billing-period or automatic-collection scanners, and definitive Easy Pay
Direct invalid-vault failures must terminate once instead of remaining in provider-read polling.

## Ownership and rollout

- `lago` owns the billing-period scanner, EPD automatic-collection candidate selection, provider
  outcome classification, reconciliation evidence, and saved-provider-profile state.
- `store-new` routing and checkout contracts do not change.
- Implement and test locally, pass the complete clean gate and dry-run builds, inspect staging D1
  candidates, then require an approved staging deploy before exercising the scheduled workflow.
- Production automatic collection remains disabled and no production database or provider action is
  part of this plan.

## Acceptance criteria

1. Billing-period closing selects only weekly, monthly, quarterly, and yearly plans.
2. EPD automatic renewal dispatch selects only recurring plans before applying its 100-row limit.
3. A definitive provider failure without a transaction ID records one failed attempt and never
   resubmits.
4. An invalid EPD customer-vault failure disables that saved provider profile and a legacy unknown
   copy converges without another provider read.
5. Unit, integration, format, lint, type, migration, access, and development/production dry-run
   checks pass.
6. Staging verification shows successful scheduled runs, zero one-time renewal candidates, no
   repeatedly-polled invalid-vault execution, and no duplicate charges.

## Rollback and safety

- Disable `EASY_PAY_DIRECT_AUTOMATIC_COLLECTION_ENABLED` to stop new automatic collections.
- The changes do not alter Store routes, card data, provider credentials, tax rules, or production
  state.
- Preserve all payment evidence. Resolve the known staging unknown execution through the hardened
  reconciliation path; do not delete it or submit another charge.
