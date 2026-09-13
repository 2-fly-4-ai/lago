# Production lifecycle audit and duplicate-purchase protection

## Scope and ownership

Audit the live EPD Gateway/Lago lifecycle after rollout and verify duplicate-charge
protection without prohibiting independent purchases. Root Cloudflare code owns payment
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
- Prevent duplicate claims of the same execution and concurrent/uncertain charges
  against the same invoice; preserve independent invoices, even for the same plan,
  email and checkout-origin product. Origin is not authoritative app assignment.
- Add regression tests and run the full Cloudflare gate.
- Separate production evidence, local simulated tests and remaining unknowns.
- Report deployment status and exact required customer remediation.

## Rollback

No live state is changed by this audit. Proposed software changes must be tested
and reviewed before an explicitly approved deployment. Preserve the current
production versions and customer financial history.

## Progress

### Approved remediation and staging — September 14, 04:20 Fiji

- Re-ran the complete gate at `ac249002482d196e34048533cd79e0dcd0320dd4`:
  107 Vitest files / 1,248 tests passed, including all 28 purchase-scope cases;
  formatting, lint, Access, checkout/provider, tax, types and all dry-run builds passed.
- Compared against the prior isolated staging source `39e95d9`: native payment
  runtime changes are comments/braces only. The rejected product-origin guard
  was never deployed; separate generic-plan purchases remain supported.
- Staging D1 reports no pending migrations. Deployed only
  `serp-dev-lago-epd-serptest`, version `1ec27b5b-3993-490f-91f3-18b6468a35a2`,
  retaining runtime vars, isolated D1/R2/queues/workflows, Gateway test mode,
  live-mode prohibition and no scheduled cron. Rollback version:
  `1aca0b81-8fc5-4b8f-82b2-b1b285323c1e`.
- Remote smoke checks: health/readiness 200; unauthenticated customer API and
  invalid signed-checkout token 401. These are deployed smoke checks, not a new
  sandbox purchase or proof of a future monthly renewal.
- Approved Store-owned held Dub sale recovery completed separately: exactly one
  conversion, matching amount/currency/invoice/pinned historical customer. Its
  click/link match all 25 previous Stripe sales on that customer, rather than
  the checkout's newer click. No payment request or customer refund was made.
- Eight historical uncertain payment outcomes still require provider evidence.
  A fresh Gateway request redirects to login; cached signed-in pages are not
  accepted as evidence. No uncertain execution was retried or reclassified.
- No production Worker deployment, production payment configuration change,
  subscription cancellation or mutation to either Kajabi subscription in this step.

### Current correction — September 14

- Removed the unshipped checkout-origin uniqueness predicate and its customer-facing
  duplicate-subscription rejection. The preceding historical implementation notes
  below are superseded: same email/plan/origin does not prove a duplicate purchase.
- Retained the existing atomic execution claim, same-invoice in-flight/unknown
  exclusions, outstanding-balance checks and provider idempotency safeguards.
- All 28 local-D1 purchase-scope cases pass, including concurrent claims for one
  execution, two requests for one invoice, paid invoices, and independent purchases
  sharing the exact customer, plan and origin. Updated fixtures construct immutable
  checkout identities correctly rather than attempting to mutate signed identities.
- Full `pnpm run check` passed after the correction: formatting, lint, Access,
  checkout/provider contracts, inventory, tax checks, binding types, TypeScript,
  full regression suite and every development/production dry-run build.
- No Lago deployment or production financial mutation was performed for this
  correction. A Store-owned optional already-owned-app warning would be a separate
  UX rule, not a payment-layer prohibition inferred from checkout origin.

### Historical checkpoints

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
