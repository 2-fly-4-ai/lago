# EPD Direct Gateway Production Repair

Status: active

Last verified: 2026-09-09

## Incident and root cause

The Sprout production canary stopped before creating an EPD transaction. The deployed checkout
tokenized the card with Gateway Collect.js, then attempted to create an order through EPD Commerce.
That mixed transport required the undocumented `epd_gateway_customer_vault_id` field on a Commerce
customer. The field was absent, so Lago correctly held the execution as unknown before charging.

Production read-only evidence shows no provider transaction, response, customer, payment method or
product checkpoint for the held execution. It must never be replayed; a fresh checkout is required.

## Contract owners

- EPD Gateway owns Collect.js tokenization, initial sales, Customer Vault records, processor
  transaction evidence, direct recurring charges, query reconciliation and refunds.
- Lago owns checkout signing, customer identity, idempotency, tax and discount amounts, provider
  evidence, subscription state, renewal scheduling, reconciliation, entitlements and notifications.
- Store owns product routing and the Sprout-only canary selection.
- EPD Commerce is not in the new-checkout or renewal payment path. It remains a separate product and
  historical integration surface only.

## Repair

1. Configure production as `EASY_PAY_DIRECT_CHECKOUT_BACKEND=gateway_direct`.
2. Keep browser card capture in EPD Gateway Collect.js. Send the resulting opaque token directly to
   the same Gateway's `transact.php` API; never attach it to a Commerce customer or order.
3. For recurring purchases, create a Gateway Customer Vault record during the customer-initiated
   first charge and save only the returned vault ID and original processor transaction ID.
4. For one-time purchases, omit Customer Vault, stored-credential and recurring fields and never
   bind a reusable payment profile, even if a provider response contains an unexpected vault field.
5. Send subsequent Lago-scheduled renewals to the same Gateway with `initiated_by=merchant`,
   `stored_credential_indicator=used`, `billing_method=recurring` and the saved original transaction.
6. Include `test_mode=enabled` only for `gateway_test`; omit it for live Gateway traffic.
7. Preserve the legacy Gateway-to-Commerce bridge only for historical test/reconciliation coverage.
   Production rejects it unless the test-only `EASY_PAY_DIRECT_LEGACY_BRIDGE_ALLOWED=1` override is
   explicitly present; the production config does not set that override.
8. Recover ambiguous transport failures only with the Gateway Query API and stable order reference.
   Never replay a sale to discover whether it succeeded.

## Verification and rollout

1. Focused direct-Gateway integration tests cover live/test mode, monthly and one-time purchase
   separation, duplicate submission, decline, interrupted response, query recovery, profile binding,
   renewal and legacy-bridge fail-closed behavior.
2. The complete quality gate passes: 100 Worker test files / 1,149 tests, 19 browser checkout tests,
   14 Gateway contract tests, 49 tax tests, formatting, lint, generated inventories and bindings,
   TypeScript, migration rehearsal, and every development/production dry-run build.
3. The provider-backed EPD full-test Gateway has already proven a real sandbox monthly purchase,
   Customer Vault creation, renewal, decline and query behavior. These are actual provider sandbox
   transactions, distinct from mocked Worker tests.
4. Deploy this revision to isolated staging and repeat the signed Store-to-Lago checkout journey.
   Do not count a rendered form or mocked response as payment proof.
5. Obtain explicit approval before deploying the production Worker. Store remains limited to the
   Sprout canary.
6. A human submits the fresh live canary payment. Verify the exact Gateway transaction, Lago payment,
   invoice/subscription, renewable profile, entitlement, receipt and Slack delivery before widening.

## Evidence and remaining verification

### Final isolated validation on the direct-Gateway candidate

- The currently deployed production Worker is version
  `908c019f-f2fa-478a-80ff-09fb90a189ef`, uploaded from commit `eb727bd`. That
  revision predates the production `gateway_direct` selection. The observed Sprout failure is
  therefore the known mixed-transport incident, not evidence against the repaired path.
- Candidate Lago commit `2b08265fea8bcd0729182349978c92fdd40abeac` keeps live mode disabled in
  isolated staging and enables only supervised sandbox payment mutations. It is deployed there as
  version `d4d21026-1679-4346-bd5a-58fc13035018`.
- A fresh Store-origin monthly checkout on that version completed through the real EPD full-test
  Gateway for USD 4.50 after the USD 4.50 regional discount. Durable readback found one successful
  Gateway execution, one active reusable vault profile, one paid Store order, one acknowledged
  source projection, active Auth access and exactly one sent Slack notification.
- The same browser harness demonstrated Gateway duplicate protection with a second test-card
  attempt; no provider transaction ID or charge was created for the rejected attempt.
- Store commit `540177fc78c491b19ac097a20091886c738563af` passes its frozen release gate:
  1,068 tests, the Store/Auth contract and typecheck. It also gives a newly paid, unverified buyer a
  typed “payment received — verify your email” state instead of silently polling. Lago passes 100
  Worker test files / 1,176
  tests plus formatting, lint, Access, checkout UI, Gateway contract, tax, generated inventory,
  typecheck and every development/production dry-run build.
- Production test cards are not valid canary instruments. After the repaired live Worker is
  approved and deployed, a human must use a real card for the narrowly scoped Sprout canary. EPD
  sandbox cards remain confined to the isolated full-test Gateway.

- The failed production checkout was a pre-charge integration failure, not a decline. Its generic
  status page is permanently closed by design and no provider transaction was created.
- EPD's authenticated Gateway developer documentation and full-test account establish the direct
  `Collect.js -> transact.php -> Customer Vault -> query.php` contract used by this repair.
- The focused repair suite passes 215/215 tests. The full gate passes 1,149/1,149 Worker tests and all
  separate UI, Gateway, tax and build gates.
- Production configuration dry-run selects `gateway_direct`, live network mode, explicit live-mode
  permission, product-scoped renewals, disabled tax collection and disabled app-initiated refunds.
- The corrected release was deployed to the isolated `serp-dev-lago-epd-serptest` Worker as version
  `8c85cf5a-3daf-4512-ac8e-834b72414a3a`; both `/health` and `/ready` pass. The isolated Worker is
  quiesced with payment mutations and automatic collection disabled. Its D1 state has zero enabled
  automatic-collection scopes, zero active dunning campaigns, zero pending/processing/unknown
  automatic executions and zero pending dunning payment requests.
- A real full-test Gateway purchase charged USD 4.50 for a USD 9 monthly plan after the 50% regional
  discount and created a reusable Gateway vault profile. A real stored-profile recovery charge also
  succeeded for USD 4.50. Replaying reconciliation produced zero new candidates, requests or provider
  transactions. These are provider sandbox transactions, not mocks.
- The successful recovery projects through Store and Auth: the billing source is revision 3, the
  unchanged entitlement payload is acknowledged at delivery revision 2, Auth holds one active
  entitlement through the paid-through date, and the corresponding Slack delivery is `sent` with no
  uncertain deliveries. The lower delivery revision is expected because the desired entitlement did
  not change on the payment-only billing revision.
- The isolated Store worker was restored to a fully disabled state as version
  `07c7bc62-24eb-4a5a-8e28-1f60e80ab6ef`. Its source-retry endpoint now accepts an externally empty
  streamed POST body; the regression is covered by 9/9 focused Store tests.
- Currency is now a financial invariant. A null customer currency can be adopted only when all
  invoice, payment-request, subscription-plan and wallet evidence is unambiguous. Conflicts fail
  before provider contact, the execution claim repeats the check atomically, customer currency
  updates are guarded by the same evidence predicate, and migration 0123 refuses ambiguous rows.
- A real live charge is intentionally unverified until the repaired Worker is explicitly approved
  for production and the human performs a new Sprout canary checkout.

## Exit criteria

- No new checkout or renewal depends on Commerce or an undocumented Gateway-to-Commerce field.
- Monthly purchases save a renewable Gateway profile; one-time purchases never do.
- Ambiguous responses reconcile by query without resubmission.
- Full regression and dry-run build gates pass.
- A provider-backed isolated-staging journey passes on the exact release revision.
- The held production execution is never retried.
- Production remains unchanged until explicit approval.

## Final production preflight — 2026-09-09

- Production remains on version `908c019f-f2fa-478a-80ff-09fb90a189ef` from `eb727bd`; the
  direct-Gateway candidate has not been deployed there.
- The current production D1 Time Travel bookmark is
  `000001e2-00000a87-000050e1-285f6294eeb3ad4f88b13c0a0e10790e`. It is recovery evidence,
  not authority to restore or discard later financial writes.
- Only migrations `0122_easy_pay_direct_live_refunds.sql` and
  `0123_backfill_customer_invoice_currency.sql` are pending. Production has zero refund rows, so
  0122 copies no financial records while adding the live-mode enum value; runtime refunds remain
  disabled. All 49 EPD customers with null currency satisfy 0123's unambiguous-evidence predicate;
  no conflicting customer is modified. Production reports zero foreign-key violations.
- A fresh production API dry-run succeeded and selects `gateway_direct`, live Gateway network mode,
  explicit live permission, product-scoped automatic collection, disabled tax collection, disabled
  refunds and disabled Stripe network access. The deployed Worker already has the required Gateway
  security and tokenization secrets; no secret change is part of promotion.
- Isolated Lago version `d4d21026-1679-4346-bd5a-58fc13035018` remains healthy and ready. The
  post-payment Store UX correction is separately deployed only to isolated Store version
  `020a7820-411f-439a-a795-6705a187e676`; production Store remains unchanged.
- The smallest production repair is therefore: apply 0122–0123, deploy only the native Lago API
  Worker from this candidate, verify version/health/schema/gates, then require a fresh Sprout
  checkout with a real card. Do not replay the closed intent and do not use a sandbox test card on
  the live Gateway.

## Approved production deployment — 2026-09-09

The user explicitly approved the production Lago-only migration and deployment after reviewing the
root cause and staging evidence. The Store production Worker and product routing were not deployed
or widened, and no payment or renewal was manually triggered.

- Recovery bookmark before mutation:
  `000001e2-00000a87-000050e1-285f6294eeb3ad4f88b13c0a0e10790e`.
- Migrations `0122_easy_pay_direct_live_refunds.sql` and
  `0123_backfill_customer_invoice_currency.sql` both applied successfully. Wrangler reports no
  pending migrations. All 49 unambiguous legacy EPD customer currencies were backfilled; zero
  remain null. The refund table remains empty, both refund guard triggers exist, and
  `PRAGMA foreign_key_check` remains empty.
- Production Lago version `a7056828-44eb-4d27-8e6b-5a5df6f62dcc` was deployed at 100% with
  message `Deploy c8188ea EPD direct Gateway repair`. Both `/health` and `/ready` returned success.
- Version inspection confirms `gateway_direct`, production network mode, explicit live-mode
  permission, product-scoped automatic collection, disabled tax collection, disabled refunds and
  disabled Stripe networking. No secrets were copied or changed.
- Post-deploy state has zero unresolved automatic-payment executions and zero foreign-key
  violations. The Sprout collection policy is enabled. A successful new paid Sprout subscription
  will enroll its own renewal scope from proven checkout consent; no unrelated product is enrolled.
- The failed pre-deploy checkout remains terminal and must not be replayed. The remaining live
  verification is a fresh human Sprout checkout with a real card, followed by read-only validation
  of Gateway, Lago, Store, Auth and Slack evidence.

## Live canary and refund-boundary follow-up — 2026-09-10

- The human completed a fresh live Sprout checkout. Read-only production evidence records one
  successful direct-Gateway payment request for USD 4.50 against the USD 9 monthly plan after a
  USD 4.50 regional coupon. The subscription is active through 2026-10-09, tax is zero, there is no
  duplicate payment and no production refund operation.
- The high-level credit-note boundary previously rejected every live Gateway refund even though the
  low-level Gateway adapter already required and supported the coherent production/live tuple. The
  boundary now accepts only the exact production + Gateway-production + live-allowed mapping, keeps
  Gateway test and legacy Commerce test isolated, and rejects mixed tuples.
- Dedicated SERP TEST version `fd6b8663-256b-4128-ae46-98db7e2b0d38` enabled refunds only for the
  isolated test Gateway. A real provider refund of USD 4.50 succeeded as Gateway transaction
  `12534234120`; credit note `a223ff48-9879-53d9-9563-03e81cde915c` records a 450-cent coupon
  adjustment and a 450-cent refund. Identical-key replay returned the same note and exactly one
  provider operation. The short-lived API key was revoked; zero matching active keys remain.
- Production refund configuration remains disabled. No live refund, cancellation, Auth deployment,
  Store deployment or source backfill was performed by this follow-up.
- After the refund-mode/environment coupling was tightened, the exact candidate was deployed to
  dedicated SERP TEST version `51fbeaf1-c38a-48d7-ade5-11d36dbc25f2` and independently exercised
  again. Credit note `114060be-b6fd-537e-93a0-de76efaf8a49` produced one successful 450-cent
  Gateway refund, preserved the 450-cent coupon adjustment, and returned the same credit note on
  identical-key replay. Its temporary API key was revoked and zero such keys remain active.
- The dedicated worker was then returned to refunds-disabled version
  `acf8c76f-350c-48d1-8a38-6b010e21678b`. The complete Lago gate passed 1,183 tests across 100
  files plus formatting, lint, generated bindings, type checking, access/UI/tax checks, and every
  development and production dry-run build. Production remained unchanged.
- The pinned cross-repository release gate passed with Store
  `9be01e3fcfe5fa95ef63043617397152d385db83` and Auth
  `4cca108f90767a8739c07f3e5a5d538b99605279`: 1,068 Store tests, 105 Auth tests, nine live-bundle
  Store-to-Auth source-contract tests, both type checks, and both builds. This proves the candidate
  contract locally; the corresponding production migrations and deployments remain pending.
- Existing provider-backed SERP TEST evidence also confirms the recurring path: subscription
  `46e2352c-a0e6-5129-9c90-d21545af6892` closed two monthly periods and produced two distinct,
  successful Gateway renewal transactions (`12533511387` and `12533616985`), each from a single
  one-attempt execution. A separate controlled declined renewal ended once with provider code 300,
  no provider transaction ID, and no duplicate execution. Its collection scope is disabled now.
