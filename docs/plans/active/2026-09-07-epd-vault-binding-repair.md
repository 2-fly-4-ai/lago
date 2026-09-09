# EPD customer/vault binding repair

Opened: 2026-09-07
Status: active; not deployed

## Access-independent preparation — 2026-09-08

The populated local 0113 → 0117 migration rehearsal now passes and is included in the full
Lago gate: **768/768 Worker tests, 89 files**, all formatting/lint/types and seven dry-run builds.
No remote migration, provider call or deployment occurred. See the
[staging release checklist](../../reference/epd-staging-release-checklist.md) for Auth → Lago →
Store order, source-preserving rollback, explicit staging bindings and provider-backed acceptance.
Independent review also found the generated Store `preview` environment was not recognized by
source delivery; the narrow owning-repository correction now passes its 27 focused tests, full
Store app suite (928 passed, four credential-dependent skips), typecheck and scoped lint. Commerce
mapping, policy decisions and actual staged lifecycle evidence still prevent closing this plan.

## Full-lifecycle independent audit (2026-09-07)

The user requested independent reviewers, complete lifecycle tests, staging demonstration,
and a readiness report distinguishing mocked/local, real sandbox, and production evidence.
Production canary approval is conditional on readiness; unresolved material findings prevent
deployment. No live purchase is authorized for the agent; the user will make it after release.

Review ownership:

- Checkout reviewer: token/vault/order contract, duplicate submissions, interruption and event order.
- Billing reviewer: recurring vs one-time, cancellation, refund, retry and dunning.
- Store reviewer: pricing, grants/revocations, success return, Slack, latest Store source alignment.
- Main: official provider contract, fix integration, full regression gate, staging/release evidence.

Cross-repository ownership and rollout: Lago owns billing ledger, signed payment/lifecycle events,
and provider requests. Store owns checkout-session binding, orders, fulfillment and Slack; Auth
remains entitlement authority. Preserve existing Stripe behavior. Any new producer/consumer
contract must be documented and covered on both sides before deploying Lago then Store staging.
Do not deploy a consumer requiring an absent producer, or broaden production product routing.

Continuation contracts (local implementation, not deployed): Lago owns the authenticated
`GET /api/v1/invoices/:id/fulfillment` version-1 current-ledger snapshot. Store must withhold a
new EPD grant if that response is missing, mismatched, refunded, terminated, or ineligible.
This snapshot does not serialize a later Auth mutation; that race remains a release blocker.
Auth owns a separate additive `/internal/entitlements/source` revisioned source contract,
implemented from clean pinned main in `tmp/serp-auth-epd-sources`. It preserves legacy grants,
requires an explicit test/live environment binding, and rejects ambiguous/disabled identities.
The authoritative Lago source-revision producer and lifecycle delivery are not yet connected.
Rollout requires reviewing the deployed Auth baseline, deploying compatible Auth and Lago
producers to staging before enabling Store consumers, then exercising reordered lifecycle
events there. Do not backfill or revoke existing product-wide grants automatically.

Acceptance requires evidence for initial purchase, renewal, no one-time renewal, regional
discount, tax quote/commit, decline, duplicate and interrupted submission, reordered webhooks,
cancellation, refunds, entitlement grant/revocation and Slack. Local mocks do not satisfy a
provider-backed acceptance cell. Existing provider/customer records remain untouched unless
the exact read-only operation is approved. Staging deploy/test commands must be identified
before execution; public documentation and local fictional test work can continue meanwhile.

Fresh official EPD documentation retrieved on 2026-09-07 confirms card capture via Elements
`card_token`, and order/refund idempotency keys expiring after 24 hours. It does not document
the legacy customer-vault response field used by this repair. The bridge contract remains a
release blocker, not an assumed capability. Independent review has also identified failed-then-
successful event recovery, over-age order replay, webhook archive races, refund-key concurrency,
and Store fulfillment/lifecycle gaps. Track fixes and verification in the readiness evidence.

## Incident

A production Sprout checkout reused an EPD Commerce customer with a different Gateway vault.
The card was vaulted before Commerce customer resolution. The local reusable profile is saved
only after payment-method attachment, so a prior interrupted checkout can leave an existing
Commerce customer without a local profile. Email lookup then joins incompatible references.
Aggregate-only production inspection confirmed one recent incomplete execution with a reused
Commerce customer and a different vault; no provider order is recorded for that execution.

Staging's `gateway_test` initial purchase bypasses Commerce attachment. Its success did not prove
the production bridge. The previous readiness claim was unsupported for this boundary.

## Owner, scope, and rollout

Lago owns customer resolution, vault attachment, checkpoints, error handling, and tests. EPD is
the authority for the customer's linked vault and payment outcome. Store routing, prices,
discounts, tax configuration, renewal scope, and existing subscription profiles stay unchanged.

1. Resolve and validate Commerce customer identity before consuming a card token.
2. Require positive evidence of the matching vault; never replace an existing customer's vault,
   use another customer's payment method, or infer a binding from email alone.
3. Quarantine mismatched interrupted checkpoints without replaying their attachment or order.
4. Keep provider diagnostics out of customer-visible errors; distinguish a definitive pre-order
   rejection from an uncertain payment outcome.
5. Test the production Commerce branch with stateful synthetic provider fixtures, including
   returning customers without a local profile, mismatches, interrupted operations, and replay.
6. Validate the actual provider contract separately. Current public EPD docs describe `card_token`
   through EPD Elements, not the legacy `billing_id`/Gateway-vault customer binding. Do not invent
   support for a response field or call mocked coverage provider-backed acceptance.
7. Full Lago gate, review, then separately approved staging and production deployments. No live
   payment, provider replay, D1 repair, routing change, or secret action is authorized by this plan.

## Acceptance and safety

No card data or customer records in evidence. Retain interrupted records and idempotency keys.
Never automatically resume a mismatched vault into a charge. No production readiness claim until
the actual Commerce attachment contract is verified and the matching sandbox path succeeds.

## Local verification

The repair includes 12 additional regressions (538 Worker tests total): stateful returning-customer
and new-customer attachment, missing/incorrect binding, existing interrupted mismatch, repeat
reconciliation and browser replay, provider error redaction, ambiguous/malformed customer lookup,
incorrect customer/payment-method identities, and inconsistent Gateway vault responses.
The focused suite is 41/41; the full Lago gate (538/538) passed, including formatting, lint,
typecheck, Access checks, tax checks, generated binding checks, inventory, and all seven
development/production dry-run builds. Root harness and diff whitespace checks also passed.

These are local contract tests with fictional data, not a successful live provider test. Public
customer documentation and public Commerce client assets did not establish the legacy vault
response contract. A narrowly scoped read-only EPD binding inspection was requested; no card
details, customer edits, provider payments, replays, secrets, D1 writes, or deployments were made.
Production remains at the pre-repair version. Do not widen the canary or ask for another real
purchase based on these local results.

## Follow-up recovery repair

The second review identified safe preflight outages being stranded as unknown and permanent
setup-review holds occupying the reconciliation batch. Both code paths are repaired:

- A transient read-only lookup failure resets only a fresh execution with no provider checkpoints.
  It allows a new hosted token while retaining all non-card identity/terms/tax checks and the
  immutable initial fingerprint. Concurrent retry claims remain exclusive.
- A lookup failure during recovery preserves the vault and defers without aborting the batch.
- Setup-review holds without an order are filtered before the oldest-100 limit. A held execution
  with an existing provider order stays eligible for outcome reconciliation.
- Malformed customer lookup entries cannot be mistaken for a missing customer.

Thirteen more regressions cover lookup/read 503, 429 and network failures; fresh-token and
concurrent retry; gateway timeout safety; recovery read outage; 101 held records plus actionable
records; and malformed provider entries. Focused tests pass 54/54. The final full gate passes
551/551 Worker tests, formatting, lint, typecheck, generated bindings, Access/UI/tax checks, and
all seven dev/production dry-run builds. Root harness and diff whitespace checks pass.
No migration, deployment, provider/customer mutation,
payment retry, or production configuration change is part of this follow-up. The actual EPD
vault-link contract remains unverified; read-only account verification has been requested.

## Payable-state and batch-starvation repair

A deeper review reproduced four failures in additional diagnostic tests: recovery could create
an order for a request already paid or disabled, and 101 legacy-billing or missing-phone records
could prevent newer actionable records from reaching the recovery batch. Those diagnostic cases
are now permanent regressions and pass.

- Browser claims, recovery claims, batch selection, and the final pre-order check share a single
  authoritative payable-state predicate, including organization/request identity, intent state,
  payment status, processing readiness, and closure holds.
- Payment state is checked again after provider setup. A paid/disabled request at that boundary
  becomes a review-held execution without submitting an order. Provider checkpoints are retained.
- Pre-order legacy production billing IDs and missing/unrecoverable phone checkpoints are excluded
  before the selection limit. Existing orders remain eligible for read-only outcome checks even
  when new payment eligibility or recovery checkpoints are absent.

Seven new tests cover the four reproduced failures, paid/disabled changes during provider setup,
and read-only reconciliation of an existing order with disabled payment and missing checkpoints.
Focused tests pass 61/61; the full gate passes 558/558 Worker tests, formatting, lint, typecheck,
generated bindings, Access/UI/tax checks, inventory, and all seven dev/production dry-run builds.
The root harness and diff whitespace checks also pass. These remain fictional local tests,
not provider-backed proof. The final pre-order check is not a distributed lock against a separate
payment occurring afterward. The live EPD vault-link contract is still an explicit deployment
blocker. No provider request, payment retry, remote database mutation, or deployment was performed.

## Post-payment and adjacent recovery sweep

The review reproduced premature terminal success before renewal binding, interrupted profile
writes becoming unrecoverable, and provider reads settling missing or mismatched money evidence.
The fixes keep the original order recoverable until post-payment work is durable and require the
same exact money/identity evidence on inline, provider-read, and webhook paths.

The adjacent sweep also covers early webhooks before order checkpoint persistence, local tax
commit interruptions (including legacy terminal-success tax-only recovery), one-time purchases,
101 pending orders rotating through the reconciliation limit, and Gateway test profile recovery.
Gateway test recovery now uses the read-only Gateway query endpoint, verifies transaction and
money, and never falls through to a Commerce read or a second charge. A missing recurring vault
keeps finalization pending. Delayed initial checkout recovery preserves a newer saved card.

Fifteen new permanent regressions use fictional local fixtures and injected fetch/DB failures.
No live customer data or provider calls are involved. The sweep does not prove the live Commerce
vault-link contract or repair historical production rows. Those remain explicit rollout checks:

- Verify the pinned live customer/vault attachment contract before deployment.
- Inspect historical successful monthly executions for missing renewal bindings with separately
  approved read-only access; do not broadly reopen successes or overwrite newer card selections.
- Verify deployed behavior in the matching provider environment before expanding the canary.

Final verification: 117/117 focused EPD tests and 573/573 full Worker tests pass. The complete
gate passes formatting, lint (zero warnings/errors), typecheck, generated binding checks,
inventory, 5 Access tests, 4 checkout UI tests, 49 tax-tooling tests, and all seven development/
production dry-run builds. The repository harness and diff whitespace checks pass. No schema
migration, remote database write, provider request, charge, deployment, push, or routing change
was performed. The retained worktree remains the local repair branch, not deployed production.

## Renewal and event-order review

A subsequent full-file review of automatic collection, its eligibility queries, and checkout
reconciliation added twelve regressions. The review follows the Cloudflare Workers guidance on
durable recovery and checks database predicates as well as application-level status checks.

- Automatic renewal reads now require exact amount/currency and the recorded transaction identity
  when available. Missing money fields cannot silently substitute invoice values.
- Provider read failures advance last-attempt ordering and defer with a safe diagnostic instead
  of aborting the reconciliation batch. Database/programming errors are not silently swallowed.
- Stale failure events/reads cannot terminate unfinished recovery for the exact already-paid
  checkout or renewal, or disable its saved profile. Conditional SQL repeats the paid-ledger
  guard at the write boundary, not only in an earlier application read.
- Past-due recurring subscriptions retain processor/vault recovery requirements.
- Renewal selection rejects wrong-account and empty vault/initial-transaction profiles before
  its 100-row limit; preparation and dunning apply the same nonempty-reference rules.

Coverage includes one-time exclusions, canceled/held/disabled/unscoped renewals, mixed dunning
requests, unknown-charge no-resubmission, tax destination isolation, newer card preservation,
post-payment write interruption, and out-of-order failure followed by verified success. The
new tests use fictional local data only. No provider-backed checkout, historical production
record audit, or deployment is implied. The existing live-contract rollout hold remains.

Final gate: 585/585 Worker tests pass across 81 files, plus all Access/UI/tax-tooling tests,
formatting, lint, typecheck, generated bindings, inventory and seven dev/production dry-run
builds. Harness and diff whitespace checks pass. The final review also checked that the new
failure guards operate at the SQL write boundary and do not broaden charge eligibility.
This is a local source/test/documentation repair only: no production deployment, push, provider
call, customer-data read, remote D1 mutation, payment retry, or change to Store was made.

## Full-lifecycle audit result

The newer [readiness report](../../evidence/epd-lifecycle-readiness-2026-09-07.md) records the
independent reviews, official provider contracts, repaired races/recovery/refund issues,
634/634 current Worker tests, complete Lago check gate and seven dry-run builds. Store now has
a separate local durable-fulfillment patch with 681/681 app and 561/561 shared-core tests.
Those results are local, not a provider-backed demonstration. Earlier no-Store-change statements
above describe earlier repair rounds; this audit adds the isolated Store patch without deploying it.

Release remains blocked by the actual Commerce vault/processor-reference contract, source-owned
entitlement lifecycle, and matching refund recovery. Staging migration/deploy/provider QA are not
complete and are not reported as passes. The requested production canary must not be launched on
this evidence alone. Exact read-only production inspection approval was requested; no such read,
remote migration, provider transaction, deployment, or push was performed in this audit.
## Cross-service source-delivery continuation

Local-only work on 2026-09-07; no publisher, source cutover or deployment is enabled by this section.

Contract owners and rollout order:

1. Lago owns current billing evidence and a dedicated per-subscription monotonic cursor. Aggregate
   invoice/payment/subscription versions are not one comparable sequence. Transactional cursor
   triggers were prototyped for billing/refund/closure changes, but integration testing showed they
   alter D1 `meta.changes` and break existing exact-row guards. That prototype is quarantined outside
   release migrations. Do not weaken billing guards or deploy it; revision architecture remains open.
2. Lago must materialize immutable source snapshots and durable delivery evidence. Time expiry is
   represented by explicit validity boundaries; the same revision cannot change payload merely
   because the clock advances. Qualifying paid plan invoices, not the newest invoice, determine
   paid coverage. Publisher and delivery repair remain unimplemented.
3. Store owns immutable purchase/customer/product association plus its own Auth delivery revision.
   Accepting a newer Lago revision or binding a product can both change the full Auth snapshot.
   An old billing response or old delivery acknowledgement cannot overwrite newer state.
4. Auth owns the source-scoped resolver and safe unverified customer provisioning. Existing legacy
   grants remain untouched. No customer is verified or reactivated merely because a payment arrived.
5. Switch all EPD grant paths together only after these contracts pass integration tests: checkout
   success, automatic plan binding and manual binding. Also replace/suppress EPD's legacy trial
   conversion side effect, which currently can verify/reactivate Auth customers. Do not change
   existing Stripe behavior in this cutover.
6. Review legacy EPD grant attribution and the deployed Auth baseline, migrate/deploy staging in
   Auth/Lago/Store dependency order, then demonstrate provider-backed lifecycle scenarios before
   deciding on the approved Sprout-only production canary. Retain additive tables on rollback.

Existing Stripe partial-refund handling retains entitlements; EPD must not silently introduce full
revocation for a partial refund. How an older fully refunded billing period interacts with later
paid periods still needs explicit source-coverage implementation/testing. No historical grant
backfill, production migration or customer-account change is included in these local foundations.

## 2026-09-07 continuation update

The historical local gaps above are superseded by the current section of
`docs/evidence/epd-lifecycle-readiness-2026-09-07.md`: transactional source materialization,
coordinated Store activation and bounded repair transport are implemented locally and gated.
Lago full gate now passes 689/689, all seven Worker dry builds, format/lint/types/Access/tax checks.
Store 927 tests and its Next/OpenNext build pass; Auth 101 tests and the actual Store-to-Auth local
contract (8 tests) pass. These are not provider-backed or deployment results.

Commerce is now signed in, but its Workspace Admin role explicitly excludes the customer/order/
transaction/processor/Gateway-sync read permissions needed for the vault-mapping check. Permission
approval was requested; no account role was changed. Production remains blocked pending actual
provider contract verification and approved staging migration/deployment plus lifecycle demonstration.

## 2026-09-08 main recovery and migration integration review

The resumed-order error path now preserves an order reference recorded by an early success
webhook. A local regression failed before the change (the reference became null) and passed
afterward, including one order creation and a later read-only finalization. An independent
review confirmed that the existing processing-state guard remains in place.

Migration 0116's receipt provenance also required retention integration. The existing cleanup
attempted to delete referenced receipts and failed its foreign key. The new regression reproduced
that failure before the repair. Referenced receipts are now excluded before the 100-row limit and
rechecked in the same transaction as artifact cleanup queuing and receipt deletion. All 19 local
maintenance tests pass, including 100 protected heads without starvation and a deterministic
dispute arriving after initial retention selection. No remote evidence or database was deleted.

These changes remain local. The updated readiness report distinguishes the combined regression
gate from actual provider evidence, staging migration/deployment and the held production canary.

Final combined check after the configured-provider fence: **767/767 Worker tests**, 88 files,
format/lint/types/generated bindings/Access/UI/inventory/tax checks and all seven Worker dry-run
builds passed. Focused counts are subsets, not additional coverage totals. The source changes and
migrations 0116/0117 are not remotely applied or deployed. The active plan remains open for actual
Commerce/Gateway mapping, the dispute-access policy, supported staging rollout and provider-backed
lifecycle evidence; production canary approval is not exercised by these local results.

## 2026-09-08 dispute event ordering review

Independent local reproduction delivered a newer `won` event before an older `lost` event.
The existing reconciler regressed the dispute to lost, recorded local processing time as provider
time, and set the invoice's historical lost-dispute refund latch. The regression failed against
the actual reconciler with local D1/R2 before the fix.

The EPD [webhook event reference](https://docs.api.epd.com/api-reference/webhooks) uses numeric
`event.created` seconds; delivery/signature time is separate and replayable according to the
[webhook guide](https://docs.api.epd.com/guides/webhooks). The reconciler now uses valid provider
creation time, accepts strictly newer scoped evidence atomically, and preserves equivalent
same-time replays without inventing a tie-break order. Missing/invalid clocks, conflicting ties,
scope conflicts and legacy heads without provenance remain archived and review-held. Stale lost
events cannot set the invoice latch. A genuinely accepted historical loss still retains the
existing refund-safety latch; this patch does not invent an automatic reversal policy.

Additive migration `0116_epd_dispute_event_provenance.sql` records the exact accepted local
webhook receipt. Existing rows are not backfilled because their old timestamps may be local
processing clocks. Existing Stripe/other inserts remain compatible with the nullable field.
The new 38 dispute regressions plus 7 receipt-safety regressions pass using actual local D1/R2,
fictional archived payloads and no provider calls. This is not evidence of an actual EPD dispute
delivery, nor a deployed migration.

Dispute invoice linkage now requires the exact succeeded EPD transaction in the scoped direct
payment ledger or request allocations. Provider request metadata is not an invoice authority.
Missing settlement leaves the receipt pending for automatic retry, preserving its archive; multiple
invoice allocations are review-held instead of selecting the first invoice. Single-invoice request
allocations work with or without mirrored direct attempts. Automated combined-invoice dispute
allocation remains unsupported pending an explicit policy; no money or entitlement action is guessed.

Financial evidence is also fail-closed: the supported payload must explicitly be the matching
`order` object, with a positive safe-integer `total` and an explicit three-letter currency matching
the exact settled transaction. Direct attempts and request allocations must agree, without summing
mirrored records. Missing/malformed/mismatched money or a different dispute-object shape remains
archived and review-held. The [order API reference](https://docs.api.epd.com/api-reference/orders)
defines `total` as the order's total in cents net of discounts, not a partial disputed amount.
The exact merchant/version dispute payload still needs real provider verification; no partial
dispute amount is inferred or silently treated as an order total.

Separate unresolved policy gap: `showInvoiceFulfillment` and source snapshot materialization do
not consult disputes or `payment_dispute_lost_at`, so a lost dispute currently does not withdraw
source coverage. This ordering patch deliberately does not change entitlement policy. The actual
account's dispute event catalog/payload and any historical falsely set loss latch still require
verification/reconciliation before treating dispute lifecycle coverage as complete.
The operator's manual lost-dispute action does not establish a provider-event clock; a later
verified provider event can supersede the displayed dispute status while the historical refund
latch stays set. Manual override precedence and reversal remain policy limits, not changed here.
## Gateway sandbox lost-response recovery — 2026-09-08 local follow-up

A lost Gateway sale response could leave an `unknown` execution without transaction/vault/billing
checkpoints. The pending selector excluded it, and both the common reconciliation dispatcher and
Gateway helper required a checkpoint before performing the existing stable-order-ID Query lookup.
Existing recovery fixtures covered post-response profile failures, not this missing-response case.

The local repair admits uncertain Gateway executions for read-only reconciliation, dispatches
Gateway reads before Commerce resume, and claims a bounded two-minute read lease. It queries only
the original payment-request order ID, requires an exact unique transaction and amount/currency,
preserves a known transaction ID, and conditionally checkpoints a previously missing ID without
overwriting another execution's ownership. Reads require the explicit read flag, Gateway-test
network and matching organization/account. Empty/unknown/ambiguous/mismatched/failed reads remain
uncertain and rotate their attempt timestamp; none authorizes a new charge. Expired mutation
idempotency windows do not prevent a read-only outcome lookup. Ledger/profile/tax finalization
continues through the existing idempotent path after verified evidence.

Evidence is local actual D1/migrations with fictional provider responses, not live EPD acceptance.
No provider request, remote database change, secret operation or deployment was made for this fix.

Focused verification: `pnpm exec vitest run test/easy-pay-direct-gateway-timeout.test.ts
test/easy-pay-direct-checkout.test.ts --maxWorkers=1` passed 66/66 (12 new timeout/recovery
scenarios and 54 existing checkout scenarios). `pnpm run typecheck`, scoped Oxlint/Oxfmt and
`git diff --check` passed. Gateway local-finalization exceptions with a known sale ID become
`unknown` for immediate read-only retry; active `processing` claims retain the two-minute fence.

## 2026-09-08 follow-up remediation batch

User authorized safe local remediation of the follow-up review. Production remains untouched.
Independent owners are reviewing and implementing bounded changes:

- Lago billing: reproduce tax-quote validity-boundary and per-payment refund-allocation risks,
  then add regression coverage for demonstrated defects.
- Store fulfillment: verified-expired-period cancellation and authoritative multi-invoice
  renewal notification handling. Ambiguous payment evidence must remain held, not retried as
  a new charge or used for guessed entitlement grants.
- Store/Auth release tooling: compatible SQLite test runtime, explicit companion-source gate,
  and staging source-mode configuration in its owning template.

Contract ownership and eventual rollout order remain Auth source authority, Lago billing
producer, then Store delivery. No remote migration, provider request, permission change, or
deployment is authorized by these local test results. Provider vault association, live refund
contract, dispute-access policy, and source freeze remain explicit release gates.
