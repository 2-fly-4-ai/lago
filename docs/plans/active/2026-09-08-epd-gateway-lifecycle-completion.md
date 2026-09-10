# EPD Gateway lifecycle completion

Status: active; production not authorized by this plan.

## Objective and ownership

Implement a coherent Gateway lifecycle in Lago's Cloudflare runtime, preserving Store's existing
Stripe behavior and historical Commerce-bridge payments. Lago owns pricing, invoices, schedules,
execution journals and payment-provider adapters. Store owns customer checkout routing and
fulfillment consumption; serp-auth remains the entitlement authority. No Store or auth changes
are introduced by this follow-up. Earlier uncommitted Store/Auth lifecycle work remains part of
the staged release unit described in `docs/reference/epd-staging-release-checklist.md`; it must
not be silently omitted when verifying the complete customer journey. Any contract change
requires its own consumer verification before rollout.

## Evidence and decisions

See `docs/evidence/epd-api-contract-comparison-2026-09-08.md`. Commerce Demo Company is not a
prerequisite of direct Gateway calls. `gateway_vault` is historically ambiguous: initial orders
can be Commerce while renewals are direct Gateway. Do not relabel historical rows or dispatch
refunds using today's UI flag. A distinct immutable direct-Gateway origin is required before
enabling a new production route.

The uncommitted Elements work is preserved but is not the default release path. Existing
uncommitted fixes and migration files must not be overwritten or described as deployed.

## Work and acceptance checklist

- [x] Independently review Gateway and renewal/recovery code against primary provider docs.
- [x] Separate Gateway credential gate from Commerce credential gate (local provider tests).
- [x] Require explicit initial purchase kind; no vault/recurring flags for one-time requests.
- [x] Verify authoritative amount/currency before fulfillment in local provider-mocked scenarios.
- [x] Reject malformed/truncated/ambiguous Query results; uncertain charges never resubmit in local tests.
- [x] Implement staging-only direct Gateway refunds with exact origin, durable submission claim and safe unknown handling.
- [x] Add immutable direct-Gateway provenance and migrate locally with populated historical fixtures.
- [ ] Route new staging checkout, renewals, reads and refunds coherently; preserve old origins.
- [ ] Verify stored-card selection and original transaction ID, cancellation and payment-method changes.
- [x] Confirm full regression, formatting, lint, typecheck, Access and dry-run builds (local `pnpm run check` exit 0).
- [ ] Run dedicated provider sandbox initial purchase, renewal, decline, refund and ambiguity cases.
- [ ] Deploy staging only after local gates; verify product prices/discounts/tax and browser journey.
- [x] Verify entitlements and Slack delivery with sandbox labeling and no production side effects.
- [x] Independent final review and evidence-backed readiness report, then request Sprout-only production approval.

## Safety and rollout

No live charges, production deployment, global Gateway test toggle, credential changes or historical
data rewrites. Dedicated demo transactions require explicit approval. Before staging mutations,
identify exact Worker/config/database and migration state; do not synchronize live secrets.
Staging first, production Sprout canary only after a separate approval and user-run real purchase.
Keep unknown payment/refund outcomes held for provider reconciliation; never retry across APIs.

## Verification log

2026-09-09 supervised SerpTEST follow-up: actual initial monthly, one-time,
discount/tax fixtures, decline, accelerated stored-card renewal, partial refund
and full remainder now have provider-backed evidence. Fixed Workers-incompatible
redirect mode and actual Gateway linked-refund Query representation; independent
reviews and full Lago gate passed. See the browser follow-up evidence file for
exact invoices, workflows, versions and limitations. The two 478-cent refunds
have independent Query confirmation totaling 956; replays are idempotent and
over-refund is rejected. Old unknown attempts remain held without resubmission.
Isolated Worker quiesced at `ac4f05e2-d7df-4a74-8d78-daee2c92766c`, ephemeral API
key revoked, exact renewal scope disabled. Production/shared staging unchanged.
Next is deployed Store/Auth/Slack journey proof, not another Gateway login or
permission request. Separate Store resources are being prepared under the
approved staging workflow; resource IDs come from Cloudflare, not user guesses.

2026-09-09 continued browser verification: IAB control works on the isolated
Worker. See `docs/evidence/epd-serptest-browser-follow-up-2026-09-09.md` for
tax-link and Collect.js recovery regressions, passing full local gates and the
real Gateway rejection caused by an unsupported duplicate-threshold override.
The old execution remains held; no production rollout or successful customer
journey is claimed. Dedicated Store deployment targets are still unapproved;
local Store configuration preview guards pass 9/9 and real local Store→Auth
contracts pass 8/8, distinct from deployed fulfillment or Slack evidence.

2026-09-09 authorized credential setup: created an API-only private key and a Collect.js
tokenization public key, both assigned to SerpTEST, using the verified Test Account UI.
Transferred directly in memory over SSH/stdin into Cloudflare encrypted secrets on the new
isolated `serp-dev-lago-epd-serptest` Worker in the SERP Cloudflare account. Wrangler reported
both secrets created successfully. No key values were emitted or saved in source. Temporary
value bindings were cleared. Existing staging and production credentials were not changed.
The destination was confirmed absent before creation; Wrangler created only its minimal draft
Worker. No Lago code, D1 database, schedules, checkout routing or provider transaction was
deployed/executed by this step. This closes credential creation/transfer, not lifecycle proof.

2026-09-09 dedicated account access: the signed-in Gateway explicitly displayed `Test Account`
and stated that no transactions are ever sent to a payment processor. The user identified the
separate login as `SerpTEST`. This closes the browser account-access blocker, not API or customer
journey verification. Do not infer test status from the generic Test Mode toggle alone.

The existing `epd-gateway-demo-contract.mjs` remains pinned to the shared public demo account;
its Query restriction is not evidence that this dedicated account cannot use Query. Do not rerun
that harness as a purported test of the new account. Staging needs the dedicated account's matched
API security and Collect.js tokenization credentials, installed through the approved secret path
without exposing values. Neither credential installation nor a provider transaction was performed
during this access check. Production remains unchanged.

2026-09-09: user approved local vault-verification repair while dedicated Gateway test access is
pending. Preserve same-sale vault checkpoints when Query omits its optional vault field; reject
contradictory IDs and ambiguous response fields. Independent review completed. See
`docs/evidence/epd-vault-query-compatibility-2026-09-09.md`. No deployment or provider mutation.

2026-09-08: provider gate/purchase-kind suite passed 59/59 mocked-provider cases. Customer journey,
new refund adapter, direct-route provenance and actual sandbox outcomes are not yet verified.

2026-09-08 follow-up: Gateway approval/Query, one-time flags, immutable transport, refund-operation
journal and fairness repairs implemented. Full `pnpm run check` passed after regression repairs,
including populated migration rehearsal through 0121 and nine demo-harness unit tests. Actual
dedicated-demo transactions still await explicit approval; no deployment or provider mutation.
See `docs/evidence/epd-gateway-follow-up-readiness-2026-09-08.md` for limitations and remaining gates.
# 2026-09-09 isolated bootstrap deployment evidence

Follow-up API exercise and actual browser block are recorded in
`docs/evidence/epd-serptest-api-validation-2026-09-09.md`. Quote/discount/one-time API checks
passed; no provider payment was attempted. Temporary API key revoked and isolated mutation/read
gates returned to disabled. Dedicated Store consumer wiring remains implementation work, not
an EPD permission blocker.

Dedicated `wrangler.serptest.jsonc` was independently reviewed for storage/account isolation
and passed Wrangler dry-run. Created only new SERP TEST resources: D1
`a88dfe97-3ea1-4b35-baf8-3690e1c4633f`, artifact bucket, event queue and DLQ.
Applied all 121 migrations through `0121_gateway_refund_attempts.sql` to that fresh D1.
Aggregate verification confirmed zero organizations, customers and subscriptions before fixtures.

Deployed the audited working-tree application to `serp-dev-lago-epd-serptest` (initial
application version `ba128a8a-2709-418d-bb46-2ed2bde457ec`). Fresh checkout-signing and
address-encryption secrets were generated in memory and installed without printing values.
Existing dedicated Gateway keys were preserved. Health and readiness returned 200; anonymous
`/api/v1/customers` returned 401. Readiness only proves database connectivity, not payments.

Payment mutations, automatic collection, provider reads, Stripe, outbound webhooks and cron
remain disabled. No old staging or production resources were changed; no payment was submitted.
Fresh isolated organization and all 15 checked-in generic catalog plans were subsequently
bootstrapped using the existing insert-only catalog generator. These are catalog fixtures,
not proof of public one-time plan creation (that API rejects one_time; its supported public
purchase path uses add-ons/one-off invoices). No customers, subscriptions or charges were seeded.
Next: scoped fictional customer fixtures, tax data, authenticated customer journey and real SERP TEST
Gateway purchase/renewal/refund evidence. This bootstrap is not a passing lifecycle test or
production readiness sign-off.

## 2026-09-10 integrated Store refund completion

The isolated Lago profile now enables `easy_pay_direct_test` refunds while keeping live mode,
Stripe and automatic collection disabled. A config regression asserts those exact boundaries.
Commit `e207f20b711c4ea452c5ab470e8c280e32319e97` passed the complete Lago gate: formatting,
lint, access controls, checkout UI contracts, Gateway contracts, catalog and tax validations,
type checks, 1,184 tests, and all development/production dry-run builds. It was deployed only to
`serp-dev-lago-epd-serptest` as version `96521a3f-8575-40c0-ae61-6e0dcb54cf23`.

An authenticated Store support action refunded the fresh USD 4.50 monthly SerpTEST purchase. The
exact invoice has one finalized credit note, one succeeded `easy_pay_direct_test` refund ledger,
one succeeded provider refund operation and one succeeded Gateway attempt with a response
transaction ID. Replaying the same Store action twice reused the original Lago idempotency key;
the exact invoice still has one credit note, one provider operation and one Gateway attempt.
The subscription remains active, not canceled or terminated, with a current period and saved
provider payment method. Store and Auth independently record the matching source entitlement as
inactive and revision 2 fully acknowledged; Store's test Slack receipt is sent. This is complete
provider-backed sandbox lifecycle evidence. Production remains a separate controlled rollout.
