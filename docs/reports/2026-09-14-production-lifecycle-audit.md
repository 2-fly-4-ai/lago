# EPD / Lago live-operation audit

Audit date: September 14, 2026 (Fiji); observations collected September 13,
approximately 12:00–12:25 UTC. This is a live snapshot, not continuous monitoring.

## Verdict

**Payment collection is functioning, and September Gateway sales/refund totals
reconcile with Lago. The entire lifecycle is not yet clean.** There are two
duplicate paid-subscription groups, nine held Dub conversions, one paid order
awaiting account verification, and one legacy paid monthly subscription without
a saved renewal method. Two software fixes are implemented and locally tested;
neither has been deployed by this audit.

Production was read-only: no new payment, refund, cancellation, retry, delivery
replay, reconciliation, migration, secret change or deployment was performed.

## Live financial evidence

| Check | Observed result | Interpretation |
| --- | --- | --- |
| EPD Gateway September 1–13 report | 30 approved card sales, **$659.20** | Actual approved Gateway sales, not checkout invoice value |
| Lago September successful payment ledger | 30 successful payments, **$659.20** | Aggregate matches Gateway exactly |
| Refund | One approved/successful **$4.50** refund in both systems | September gross less refund is **$654.70**, before fees; not a bank-settlement audit |
| September 12–13 Lago successes | 24 payments, **$586.20** | Calendar UTC window, not a precise rollout-only/customer-only cohort |
| Last 24-hour request snapshot at ~12:02 UTC | 13 succeeded / $287.90; 36 pending / $714.10; 2 failed / $31.80 | Requests are not unique customers, and pending does not establish a card decline |
| Successful payment allocations | Zero amount mismatches | Every successful payment equals its allocation sum |
| Receipt records | All 34 all-time successful payments have Lago payment receipts | A financial receipt row is not proof of email delivery |
| Database foreign keys | Zero violations in Lago | Structural integrity check, not exhaustive business correctness |

The September report includes three successful payments totaling **$17.50** linked
to the owner's email. The other 27 payments / $641.70 were not exhaustively
classified as external customers versus other internal proofs. Do not present
all $659.20 as organic sales. Earlier August payments explain the difference
between September and all-time Lago totals ($695.20).

Gateway also shows small authorization/void test activity, separate from approved
card-sale totals. It was not added to sales revenue.

### Declines and unresolved outcomes

- Six Gateway failed sales total **$135.40**: processor codes 05 (2), 51 (2),
  and 59 (2). These are actual submitted payment failures, unlike abandoned
  email-only checkouts.
- An additional Lago execution was rejected with code 300: **Maestro/USD is not
  accepted by the configured processor**. This is a supported-payment-method
  limitation, not proof that the checkout is globally broken.
- Eight execution outcomes remain `unknown`, totaling **$99**: seven older
  cases / $82, plus the $17 Kajabi attempt. Several predate the current direct
  Gateway integration. No matching Gateway result alone is insufficient to
  declare older Commerce attempts unpaid. Keep the no-blind-retry safeguard.
- No newer `unknown` execution was observed after September 12 04:36 UTC.

## Confirmed findings and repairs

### High: separate checkouts can create duplicate paid monthly subscriptions

Production contains two same-email/same-product duplicate groups: Kajabi and
Sprout, each with two paid active recurring subscriptions. The two Kajabi $17
sales were individually checked in Gateway. A third Kajabi checkout is unpaid
and held; its `active` subscription label is not evidence of a third charge.

Cause: existing execution idempotency protects the same request. A fresh checkout
has a different request and subscription, so it escapes that protection.

**Local fix:** a same-organization, normalized-email/customer, same-product
recurring-subscription exclusion is evaluated inside the atomic payment-execution
claim. A paid, processing or uncertain sibling blocks a second charge. A merely
unsubmitted/definitively failed sibling does not. Different products, one-time
repurchases and existing subscription generations remain separate. Fifteen real
local-D1 tests cover these cases, including concurrent claims.

This prevents new duplicates after deployment; it does **not** cancel, merge,
refund or disable renewal on existing customer subscriptions. Those exact
customer actions require a reviewed remediation decision. Legacy subscriptions
without product attribution are not automatically inferred into this guard.

### High: Dub delivery fails in the deployed Workers runtime

The Store delivery ledger has **nine held `dub_sale` records totaling $264.90**
of sale value, each exhausted at eight attempts. This is not $264.90 of partner
commission. No successful direct EPD Dub delivery receipt was found in this table.

The deployed Store source (`f6212cd7...`) uses `redirect: "error"` in the shared
Dub client. An isolated actual workerd/Miniflare reproduction throws:
`TypeError: Invalid redirect value` because Workers accepts `follow` or `manual`.
This occurs before a network request. The generic recovery error code discarded
the useful runtime explanation. This is a confirmed runtime defect, **not a
new claim about Dub account permissions or pricing**.

**Local fix:** use `manual`, reject non-success HTTP responses, and preserve the
no-redirect-following policy. Added Workers-runtime regression coverage and
301/302/307/308 rejection tests. The client is shared by sale/refund operations.

The held records were not reset or replayed. After approved deployment, reconcile
their stable invoice/payment identities with Dub, then replay only verified
missing deliveries. Do not send duplicate commissions or reset every hold.
The signed-in Dub dashboard contains historical/Stripe events; that alone does
not prove these nine EPD events were delivered.

### Medium: one $37 paid order is awaiting email verification

Invoice `cbdae5c8-e7ac-5f9d-af5b-057adec441be`, paid September 12, is associated
with `skool-downloader-tailsgate`. Its account is `pending`, while its product
binding exists and the source reservation matches the order identity.

The source-activation coordinator intentionally rejects activation until that
account is verified. This explains the pending fulfillment. It should **not**
be bypassed by marking the account verified or charging again.

However, the checkout session already says `completed`; no completed activation
or purchase-confirmation marker exists, and the associated outbound webhook has
exhausted retries with `fulfillment_pending`. These labels/retries make a
customer-action wait look like an unexplained payment failure. Customer-facing
verification and operator status need explicit treatment. No verification email
was resent and no account status was changed during this audit.

### High before October 1: one legacy monthly renewal is not configured

Subscription `f9c85a8c-a533-5a21-8d8c-dab5c13c1ef8`, created September 6, is paid,
active, $37/month, but has no saved payment method and no enabled renewal scope.
Its current period ends **October 1, 2026 UTC**. This predates current product
attribution and must not be silently linked to an arbitrary vault profile.

Recover verified provider/consent evidence or obtain a fresh authorized saved
method before its renewal. Current global settings do not repair this row.

## Lifecycle checks

| Area | Live evidence | Remaining limitation |
| --- | --- | --- |
| Automatic renewal | Deployed native flag is `1`, scope mode `product_scoped`; 23 paid monthly subscriptions have saved provider methods and enabled scopes | No natural automatic payment execution yet; earliest scoped renewal October 9, 12:20 UTC. Legacy exception above |
| Unpaid subscriptions | Actual billing eligibility SQL blocks 119 unpaid monthly and one unpaid yearly record | `active` is still a misleading compatibility label for unpaid checkouts |
| One-time purchases | No enabled renewal scopes; recurring dispatch explicitly filters intervals | Local regression evidence, not a year-long observation |
| Refunds | Deployed native refund mode is `easy_pay_direct_live`; one $4.50 refund reconciles | Does not prove every partial/refund/commission path in production; Dub client shares the runtime defect |
| Discounts | 27 paid Store orders have price snapshots; nine discounted orders total $104.80 discount; all 27 totals equal base minus discount | Does not prove regional eligibility for every visitor or future renewal amounts |
| Tax | Actual deployed checkout and external-tax modes are `disabled` | Zero tax is current configuration, not proof every region is exempt or worldwide tax data is production-ready |
| Inbound payment webhooks | Observed Gateway/inline/reconciliation receipts processed, no processing-error/unprocessed rows | Snapshot only |
| Refund event routing | Active Store endpoint subscribes to both `payment.succeeded` and `credit_note.created` | Correct subscription does not prove every downstream refund delivery |
| Outbox | No unpublished events | Outbox publication is not downstream success |
| Outbound success deliveries | 17 succeeded; 10 failed HTTP 503 (nine external-delivery pending, one fulfillment pending) | These ten need downstream remediation, not a payment retry |
| Auth/source delivery | 25 source projections; none have an unacknowledged delivery revision; 25 refreshes settled | Missing projections are not counted as acknowledged; the verification-held order has none |
| Fulfillment | 26 succeeded markers; one pending | Four earlier orders predate this fulfillment marker and cannot be certified by its absence/presence alone |
| Purchase emails | 23 `sent` confirmation markers; eight without markers (seven older, one verification-held) | Provider acceptance marker is not inbox delivery proof |
| Slack | 26 send records marked `sent`, no uncertain/sending backlog | Does not prove every human saw a channel message |
| Cha-Ching | 15 records marked `sent`, one attempt each | Historical pre-activation payments excluded; receiver business processing not independently audited |
| Dub | Flags enabled in deployed Store; nine held conversions | Not currently healthy end-to-end |

## Deployment and test evidence

- Native production version: `639eeb34-9da1-4ec2-802d-ac51a9ea5eb6`, deployed
  September 12 14:26 UTC, 100% traffic.
- Store production version: `eaa1a634-aca3-4d12-a1e4-bd7950512431`, deployed
  September 12 11:27 UTC, 100% traffic; deployed source `f6212cd7cc94...`.
  Current Store HEAD differs from it only in rollout documentation, before this
  audit's uncommitted repair.
- Lago full `pnpm run check`: exit 0, including formatting, lint, Access/UI/tax
  checks, typecheck, full regression tests and all configured dry-run builds.
- New duplicate guard: **15/15 local-D1 tests**. No provider request in those tests.
- Store full safe regression: **1,221 passed, two skipped**, 186 passed test files.
  Live Stripe mutation test and manual tests explicitly excluded; test subprocess
  received no inherited provider credentials. This is not full monorepo or E2E proof.
- Focused Dub/partner tests: **41 passed**. Workers-runtime policy tests: **2 passed**.
- Store typecheck: passed. Both changed worktrees: `git diff --check` passed.
- No fresh sandbox transaction, production charge, live refund, or live Dub sale
  was generated for this audit. Neither repair is yet staging/live verified.

## Required next sequence

1. Review/freeze the two software repairs; staging deployment and smoke tests.
2. Approve production deployment of the reviewed versions; verify the atomic
   guard and Dub request path after deployment without creating unwanted charges.
3. Decide which duplicate subscriptions should remain; separately authorize exact
   cancellation/refund/renewal-scope corrections. Preserve all financial evidence.
4. Reconcile and recover the nine held Dub deliveries using stable identities;
   verify each receiver event and commission, not just an HTTP status.
5. Resolve the $37 customer's verification wait and confirm activation/email.
6. Repair the older monthly subscription's verified renewal setup before October 1.
7. Resolve older uncertain provider outcomes from authoritative evidence, never
   by retrying an unknown payment. Observe the first scheduled renewals when due.

Bottom line: **real purchases are being collected correctly, but there are
specific operational defects and unverified lifecycle edges. Another blanket
“everything is working” sign-off would be inaccurate.**
