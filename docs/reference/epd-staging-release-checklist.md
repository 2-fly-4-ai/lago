# EPD lifecycle staging release checklist

Prepared: 2026-09-08. Status: preparation only; **not deployed and not a release approval**.
Current evidence: [lifecycle readiness report](../evidence/epd-lifecycle-readiness-2026-09-07.md).

## Dedicated test account verified on 2026-09-09

The separate `SerpTEST` Gateway displayed an explicit Test Account banner stating that no
transactions are sent to a processor. Browser access is verified. API credentials, Query reads,
Collect.js tokenization and the staged lifecycle are still unverified against this account.
Use a matched API security key and tokenization key from this account through approved secret
storage; never substitute the shared public demo key. Do not change production credentials.

Do **not** replace the existing staging keys in place while retaining its historical account
scope. The checked-in staging config enables payment mutations and automatic collection and
uses the existing logical account code. That logical scope does not independently prove which
physical Gateway a newly installed key belongs to. Old vault IDs and uncertain transaction IDs
must never be replayed against the new account.

Prefer an isolated staging Worker/database and fresh provider-account scope for SerpTEST. If
reusing existing staging, first quiesce all payment submission and recovery paths, verify no
in-flight operation, establish a distinct provider scope with matched consumer configuration,
and prove historical profiles/executions remain fenced before installing the new credentials.
Disabling automatic collection alone does not quiesce initial-payment or refund recovery.
Preserve all old evidence and credentials through the approved secret manager; do not rewrite
historical origin to make it match the new account.

## Gateway follow-up on 2026-09-08

The latest local work adds migrations 0119–0121 after the earlier checklist baseline:
Commerce renewal identity, immutable charge transport, and Gateway refund-attempt journaling.
The populated local rehearsal now covers 0114–0121. This does not establish the remote journal
or authorize applying those migrations remotely.

The proposed new route is coherent Gateway checkout/renewal/refund, not a presumed import of
Gateway vault IDs into Commerce. Its local initial-purchase/refund paths remain test-only.
Keep the historical Commerce route distinct. Historical initial `legacy_unknown` executions
are review-held rather than assigned a guessed transport. Successful historical local tax
follow-ups remain eligible. See the [Gateway completion plan](../plans/active/2026-09-08-epd-gateway-lifecycle-completion.md).

The dedicated-demo API harness is `cloudflare/scripts/epd-gateway-demo-contract.mjs`.
Its unit-test command `pnpm run gateway-demo:test` does not contact EPD. Actual execution requires
separate explicit approval and the sole `--approved-demo-test` flag. It only uses the public
provider demo account; no live key, real card or host override is accepted. Even a passed demo
run is not proof of Collect.js tokenization, the merchant's production processor, a complete
Lago/Store/Auth customer journey or real Slack delivery.

## Ownership and release order

The work spans three independent repositories. Auth owns effective access; Lago owns provider
requests and billing evidence; Store owns product selection, delivery revisions and Slack.
The release unit is the reviewed source from all three repositories, not Lago's branch name alone.
Freeze reviewed commits and record source/build hashes before requesting deployment approval.
The current audit worktrees still contain uncommitted work; their HEAD hashes alone are insufficient.

| Order | Owner and prerequisite | Staging acceptance before proceeding |
| --- | --- | --- |
| 1 | Auth: verify deployed baseline; `backend/drizzle/0009_entitlement_sources.sql` | Additive source tables; source/bootstrap APIs authenticated; explicit `ENTITLEMENT_SOURCE_MODE=test`; old grants remain readable |
| 2 | Lago: verify migration baseline; apply pending approved migrations 0114–0121 | Refund checkpoints, source snapshots, dispute receipt provenance, dunning, expired-cancellation guards, renewal backend identity, immutable charge transport and Gateway refund journal available; legacy rows preserved |
| 3 | Store: verify 0015 fulfillment foundation, then pending 0016 projections, 0017 activation reservations, 0018 refresh leases | Source-compatible consumer deployed without admitting new test purchases yet; explicit test environment, exact organization and staging Auth/Lago targets |
| 4 | Enable scoped staging source delivery and customer journey | Auth acknowledgement, periodic refresh and customer-visible access demonstrated; then bounded provider test purchases/renewals under separate approval |

The Store migration directory is `apps/serp-store/drizzle/migrations/`; Lago's is
`cloudflare/migrations/`. Only migrations missing from the actual target journal may be applied.
Do not assume staging is at 0113/0008/0014, renumber migrations to force them through, or execute
raw ALTER statements twice. An unexpected baseline is a stop-and-review condition.

## Before any remote mutation

- Confirm the exact Cloudflare account, Worker names, D1 bindings, queues, storage, service targets
  and environment mode. Record deployed versions and approved migration filenames/checksums.
  Never infer the destination from the browser's current tab or the active Git branch.
- Check the target journal and foreign-key state using approved read-only diagnostics. Arrange a
  recoverable database checkpoint with the operator; do not export customer data into this repo.
- Review the deployed Auth version against the chosen source baseline, including unrelated changes.
  Check actual JWT TTL/client enforcement before making claims about revocation timing.
- Inspect configuration **names and reviewed non-secret flags only**. Do not copy credentials,
  payment tokens, customer rows, cookies or private runtime bundles into this checklist or tests.
- Obtain explicit approval for the exact staging deploy/migration commands and test actions.
  This checklist does not grant it. No production deployment, routing change or live charge follows
  automatically from a successful staging step.

## Configuration traps to check explicitly

1. Lago's checked-in development config currently has payment mutations and automatic collection
   enabled. It is not an inert deployment configuration. Review pending work/scopes and the desired
   activation posture before deploying; do not execute a generic deploy command blindly.
2. EPD staging must remain test-only with `EASY_PAY_DIRECT_LIVEMODE_ALLOWED=0`. The configured
   organization/account must match every admitted profile and execution. Retain existing renewal
   scopes; do not bulk-authorize historical test debt merely to demonstrate a renewal.
3. `gateway_test` initial checkout bypasses Commerce attachment. A successful Gateway test must not
   be counted as proof of the production Commerce customer/vault/payment-method contract. A test
   environment capable of exercising that exact contract must be established, not assumed.
4. Auth's staging template does not presently set `ENTITLEMENT_SOURCE_MODE`. A generated deployment
   needs the explicit reviewed `test` binding or source APIs remain disabled. Never use `live` to
   make a staging mismatch disappear. The staging wrapper regenerates configuration: put the
   approved binding in its owning generation input/template, not a generated file it will overwrite.
5. Store's generated safe staging configuration uses `APP_ENV=preview`. The source-delivery parser
   must classify that trusted environment as **test**, not reject it or infer live mode. Test against
   the actual generator output, not only a hand-written `APP_ENV=staging` fixture.
6. Store source refresh requires `LAGO_SOURCE_DELIVERY_ENABLED=1`, the dedicated
   `LAGO_SOURCE_ORGANIZATION_ID`, staging `SERP_AUTH_BASE_URL`, authenticated Lago access and the
   existing internal Auth/monitoring credentials. Verify the generated scheduler and protected
   `/api/monitoring/lago-sources/reconcile` route together. Missing configuration is not a successful
   no-op acceptance result.
7. Tax mode, provider, rule freshness, applicable classification and collection policy must be
   explicit. Demonstrate both a supported taxable fixture and a supported zero-tax fixture;
   zero tax is not evidence of worldwide coverage. Do not change collection registrations here.
8. Slack's configured destination and an actual delivered test message require verification.
   An HTTP mock or queued event does not establish delivery to the user's channel. Get approval
   for a clearly labeled test message; never include card or vault details in it.

## Populated local migration rehearsal

Run from Lago's `cloudflare` directory on the Mini's local SSD:

```sh
pnpm exec vitest run test/epd-migration-upgrade.test.ts --maxWorkers=1
pnpm run check
```

The test-only `MIGRATION_REHEARSAL_DB` is separate from normal test `BILLING_DB`; it is declared
only in `vitest.config.ts`, never a deployed Worker config. The rehearsal applies through 0113,
seeds fictional paid-invoice/payment/refund/dispute/receipt records, then applies 0114–0121.
It checks row preservation, nullable legacy provenance, refund transaction uniqueness/immutability,
dispute foreign-key retention, immutable valid source history, dunning batch rollback and journaled
migration replay. Existing triggers are compared and new triggers must belong only to the expected
refund/source-history tables. Foreign-key checks pass before and after the constraint exercises.

This proves the tested local schema upgrade, not remote D1 capacity, lock timing, the actual
deployed baseline, every historical data shape or provider acceptance. It does not perform a
production-data restore rehearsal. The local D1 interface rejects `PRAGMA integrity_check`; this
test therefore does not claim that check passed.

## Required provider-backed staging evidence

Record each case as **local/mocked**, **actual sandbox**, **production read-only**, or **unverified**.
Record source/deployment versions, time, fixture label, expected outcome and safe aggregate evidence;
keep raw payment/customer/provider artifacts out of Git. A local replay is not a real webhook delivery.

| Scenario | Required observable outcome |
| --- | --- |
| New and returning customer monthly purchase | Correct account-scoped Gateway vault/transaction association on the direct Gateway route; one charge; matching invoice/order; successful return page, exact product access and Slack delivery. Historical Commerce association is a separate contract, not proved by this route. |
| Regional discount and tax | Displayed discounted subtotal, applicable tax and authorized total match provider settlement and ledger; no post-payment surprise repricing |
| Renewal | Exact approved recurring profile and period; one renewal despite repeated dispatch; correct price/discount/tax and paid-through access extension |
| One-time purchase | Correct catalog price and bounded/perpetual entitlement policy; no renewal request after advancing its due-date conditions |
| Decline, invalid profile and retry | No paid state/access for decline; definitive unusable vault held; only an authorized new attempt can charge |
| Duplicate/interrupted submission | Same attempt never creates a second charge; uncertain outcome read-reconciles, never automatically falls back to another provider |
| Webhooks before response, duplicate or reordered | Exact receipt/provider identity; monotonic settlement; reconciliation repeatedly converges without duplicate access or notification |
| Cancellation | No later automatic collection; remaining paid access follows the declared cancellation policy; independent purchases remain valid |
| Partial/full refund and lost refund response | Exact original settlement/amount; one provider refund; durable read checkpoint; correct affected-period access and independent-source preservation |
| Dispute | Real merchant payload contract, ordering and allocation confirmed; access outcome follows an explicitly approved policy, not an inferred one |
| Auth/Store outage and scheduler restart | Durable delivery resumes, stale acknowledgements cannot win, no product-wide fallback grant; existing sources refresh even when new checkout admission is disabled |
| Legacy Stripe control | Existing generic Stripe checkout, price selection and access still behave unchanged for an excluded product |

The dispute-access policy is still awaiting a choice. Multiple eligible profiles in a dunning
group are deliberately review-held; automatic grouping is not implemented. Combined-invoice
dispute allocation, manual-override precedence, historical source-v0 backfill and identity transfer
must not be silently included in a production readiness claim.

## Rollback is not a database reset

Stop new admission/charging at the smallest approved scope and preserve original attempts,
provider IDs, idempotency keys and uncertain outcomes. Reconcile uncertain charges before offering
a second checkout. Never delete financial evidence to make a test pass.

Once source-owned access exists, do not roll Auth back to a legacy-only resolver or disable its
source mode: that would hide valid purchases. Keep the compatible reader/schema. Likewise,
disabling new Store EPD checkout allocation must not stop refresh of already-created sources.
An explicit source-delivery shutdown is a separate operational decision with access consequences.
Retain additive tables and receipt archives; never downgrade the schema as a routine code rollback.
An older Store binary may also resume legacy product-wide EPD grants for source-owned purchases;
retain the source-aware delivery/admission safeguards rather than blindly rolling back the whole
application. After 0116, Lago must retain the compatible receipt-retention code: old cleanup tries
to delete protected receipts and fails the new provenance foreign key. Review binary/schema
compatibility explicitly before selecting a rollback version.

## Exit gate

All local checks plus the actual staged customer journey must be green for the frozen release.
Permissions alone do not close the merchant contract blocker. Review remaining unsupported cases,
scope the single production canary explicitly, and request approval with exact versions and flags.
The user—not an automated test—will make the eventual approved real purchase.
