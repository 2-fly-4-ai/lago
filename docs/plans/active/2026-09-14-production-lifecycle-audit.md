# Production lifecycle audit and duplicate-purchase protection

## Scope and ownership

Audit the live EPD Gateway/Lago lifecycle after rollout and fix the confirmed
cross-checkout duplicate recurring-purchase gap. Root Cloudflare code owns payment
execution and billing; Store owns checkout initiation and customer access. No API
or frontend submodule pointer changes are planned.

## Safety

Production investigation is read-only. No customer refunds, cancellations, retries,
reconciliation runs, migrations, secrets changes, or production deployments.
Customer-specific remediation and deployment require separate approval. Use only
sanitized aggregates in the report. The provider contract is the EPD Gateway
contract, not the legacy Commerce API.

## Acceptance and evidence

- Fresh production payment, invoice, refund, renewal, outbox and delivery checks.
- Inspect duplicate paid subscriptions and unpaid subscriptions' actual renewal eligibility.
- Prevent a second same-product recurring charge across distinct checkout requests,
  including concurrent submissions; preserve distinct-product purchases.
- Add regression tests and run the full Cloudflare gate.
- Separate production evidence, local simulated tests and remaining unknowns.
- Report deployment status and exact required customer remediation.

## Rollback

No live state is changed by this audit. Proposed software changes must be tested
and reviewed before an explicitly approved deployment. Preserve the current
production versions and customer financial history.

## Progress

- Confirmed two distinct approved $17 monthly payments for the same product/customer
  in Gateway and Lago; a third unpaid attempt has an active subscription record.
- Atomic cross-checkout recurring guard implemented; 15 local-D1 cases passed.
- Full Lago check passed, including all deployment dry-run builds.
- Read-only live audit completed; report: `../../reports/2026-09-14-production-lifecycle-audit.md`.
- Store Dub request uses an unsupported Workers redirect mode. Corrected locally,
  with 41 focused tests, two runtime tests, 1,221 full Store tests and typecheck passing.
- Initial repairs were committed locally at Lago `bb6e8ec` and Store `77fc8ff`;
  neither was deployed. Existing duplicate subscriptions, legacy renewal setup,
  and held delivery remediation have not been silently modified.

## Generic-plan follow-up

- Store direct generic-plan purchases populate checkout origin with the generic
  offer slug, not an absent attribution row. Reproduced five failing cases for
  this actual path before fixing the guard to exclude the five one-app price
  buckets from product uniqueness. The downloaders bundle remains separate.
- Added coverage for the exact same plan ID bought for different apps, absent
  attribution, and unassigned/assigned coexistence. 23 focused cases and all
  1,243 Lago tests passed; the full `pnpm check` passed, including lint,
  TypeScript, Access, tax, checkout contracts and all deployment dry-run builds.
- Checkout origin is still not the final Store binding. Manual assignment can
  win over automatic intent binding. Do not claim this guard is authoritative
  for reassignment or deploy it as a substitute for Store binding reconciliation.
- Fresh Store assignment aggregate identifies one Kajabi pair (two paid orders,
  $34 total) and one Sprout pair (two paid orders, $9 total), both bound to the
  same app within each pair. This does not itself prove customer intent to cancel.
  Sprout belongs to the owner's proof purchases; Kajabi is a customer pair,
  purchased approximately 34 minutes apart. Treat these as separate decisions.
- Fresh ledger still has eight unknown executions: six legacy, one Commerce,
  one Gateway. No charge was retried and no outcome was guessed.
