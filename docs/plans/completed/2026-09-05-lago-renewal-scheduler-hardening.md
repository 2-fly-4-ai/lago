# Lago renewal scheduler hardening

Opened: 2026-09-05
Completed: 2026-09-05

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
7. An expired processing lease never permits a second gateway submission; uncertain attempts
   remain in provider-read reconciliation.
8. Dunning requires every linked invoice to be recurring and in scope. Eligibility, saved-profile
   identity, and cancellation/scope state are checked again atomically when claiming a submission.
9. An old invalid-vault failure cannot disable a subsequently refreshed saved profile.

## Final-review findings

The second review found that the dunning path lacked the recurring-plan exclusion and that an
expired processing lease could be reclaimed for submission. Both are covered by added regression
tests. The legacy invalid-vault recovery is restricted to executions without a provider transaction
ID. No-ID definitive failures use a namespaced internal ledger reference, not a claimed gateway
transaction ID; the execution and provider event preserve their null transaction ID.
Finalization also resumes safely if the ledger committed before a crash. Successful scheduler
completion clears a prior error code when the same scheduled minute is replayed.

The user approved staging deployment and scheduled verification on 2026-09-05. This approval does
not enable production automatic renewals or broaden staging collection scopes.

## Rollback and safety

- Disable `EASY_PAY_DIRECT_AUTOMATIC_COLLECTION_ENABLED` to stop new automatic collections.
- The changes do not alter Store routes, card data, provider credentials, tax rules, or production
  state.
- Preserve all payment evidence. Resolve the known staging unknown execution through the hardened
  reconciliation path; do not delete it or submit another charge.

## Verification evidence — 2026-09-05

- Code commits: `36d3f78` (candidate selection), `96b472a` (dunning and atomic submission guard),
  `f270ada` (ledger-finalization crash recovery), `02a259f` (clear recovered scheduler error).
- Final staging API Worker: `baf75f95-b992-4fd2-a71e-d7e58b9ce7e5`, deployed from `02a259f`.
  No schema, credentials, Store deployment, or production changes were made in this hardening pass.
- Final `pnpm run check`: all 76 Vitest files / 452 tests passed; 5 Access tests and 17 tax-rule
  script tests passed; format, lint, generated types, TypeScript, inventories, tax fixtures, and all
  seven development/production dry-run builds passed. Root harness check passed.
- Staging D1 migrations: no pending migrations. Foreign-key violations: zero.
- Staging API and Store health: HTTP 200. Unauthenticated operator redirected to the expected
  Cloudflare Access hostname (HTTP 302).
- `qa-renewal-hardening-20260905-0530` completed, closing all 45 overdue monthly fixture periods
  that had been blocked by the one-time rows. Monthly billing-cycle count rose from 2 to 47;
  one-time billing cycles and one-time automatic executions remained zero.
- `qa-renewal-hardening-20260905-final-replay` completed with zero due/closed billing periods.
  It exposed the stale error-code label fixed in `02a259f`; the final clean replay verifies that fix.
- `qa-renewal-hardening-20260905-clean-replay` completed on Workflow version
  `ac9ddae4-2f35-41a7-857b-912adf5fc337`. The schedule row had zero due/closed periods, zero
  deferred automatic executions, and a null error code. All final aggregate counts below remained
  unchanged on that deployed version.
- Payment execution counts stayed at two total: one earlier successful test renewal with one
  submission and one earlier invalid-vault test failure with one submission. The latter moved
  from unknown to failed without a new gateway submission. No duplicate provider transaction
  references, unknown invalid-vault executions, or matching still-active invalid profiles remained.
- The single approved test subscription remains the only enabled automatic-collection scope.
  There was no new purchase or renewal charge during these verification runs.
- Store worktree remained clean at `d01233ffd`; its prior acceptance checks were not represented
  as new tests in this pass. Existing production checkout and Stripe behavior were not changed.

## Scope of completion

This plan covers recurring scheduler and collection hardening, not approval to enable all products
or production renewals. A genuinely ambiguous provider outcome remains deferred for provider-read
reconciliation/manual review; it is not interpreted as a failed charge and never blindly resubmitted.
Keep the active Lago and Store worktrees for the user's staging review; neither is disposable while
the broader rollout remains in progress.
