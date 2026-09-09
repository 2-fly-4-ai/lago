# EPD consumer-chain staging verification — 2026-09-09

Status: **in progress; production canary not yet justified**.

This report distinguishes the dedicated Gateway financial proof from the remaining Store/Auth/Slack
customer journey. It does not authorize production deployment or a real purchase.

## Financial sandbox evidence already established

See `epd-serptest-browser-follow-up-2026-09-09.md` for transaction and workflow receipts.

- Real dedicated SerpTEST monthly purchase: 900 cents, paid, reusable provider profile recorded.
- Real one-time purchase: 956 cents, paid, no reusable profile.
- Real discounted monthly purchase: 478 cents (900 − 450 + 28 fictional tax).
- Real decline: 45-cent documented test scenario, failed execution, no fulfillment eligibility.
- Real stored-profile renewal: 900 cents, one execution, using an accelerated fictional due date.
  This is not natural-calendar scheduling proof.
- Real partial refund of 478 cents followed by the remaining 478 cents. Authoritative Gateway Query
  confirms the original 956-cent sale and cumulative 956-cent refund through linked child
  transactions. Same-key replay does not duplicate the operations; an extra cent is rejected.
- Refunds are sandbox pending-settlement evidence, not real bank settlement.
- Historical unknown attempts remain held. They were not resubmitted to obtain these results.
- All address/tax fixtures here are fictional tests, not worldwide tax coverage or registration proof.

Isolated Lago was quiesced afterward at version `ac4f05e2-d7df-4a74-8d78-daee2c92766c`:
payment mutations, provider reads, automatic collection and refund mode disabled; diagnostic pins
removed; the supervised automatic scope disabled and short-lived API credential revoked.
Production and the existing shared Lago staging deployment were unchanged.

## Independent review and local regression evidence

| Layer | Result | Boundary |
| --- | --- | --- |
| Auth backend | 105/105 tests, 20 files; build, typecheck, lint, harness and sensitive-filename check passed | Local fictional Miniflare/D1 fixtures |
| Store source delivery | 32/32 focused tests | Local transport failures and redirect rejection |
| Store → Auth contract | 9/9 | Actual local workerd Request construction and rebuilt Auth handlers, not remote delivery |
| Store full release suite | 1,037 passed, two skipped; typecheck passed | Includes 21 startup regressions. The skipped tests are opt-in live Stripe product-copy/cross-sell checks; they are not EPD proof |
| Shared store-core | 569/569, 90 files; typecheck passed | Local shared checkout/license-library tests |
| Isolated deployment profile | 23/23 | Includes actual installed OpenNext-to-Wrangler environment propagation, without remote bindings |
| Next/OpenNext | Fresh frozen-source builds passed | Compiled bytes are separate from successful deployment |

Independent reviewers examined Auth source ownership/mode/migration behavior, Store fulfillment,
source refresh, Slack receipts and isolated deployment changes. They found another concrete runtime
defect before release: Store's Auth delivery still used `redirect:"error"`, which workerd rejects
before HTTP. It now uses `manual` with fail-closed non-200 handling. The actual-runtime regression
has a negative control reproducing the old failure; it is not merely a mock assertion.

Reviewed source:

- Auth: `bc5fe0effd65d2fb73f5c8d69d6c6ce642673fd2`.
- Store audit: `4760a4fe92571e33e6e09e2e51f5be7abccb38d2`.
- Store deployment-selector correction: `2b82ee01524507fff87b0cdf02530ef90ae3d3b2`.
- Store isolated startup correction: `d7007930f3dcf2c6f7158b4468a55b10692c0b7c`.
- Auth documentation receipt commit: `1dcebae62f14d1bb60222f5bedb88437e03019d3`
  (executable source unchanged from deployed `bc5fe0e`).

No push, merge-to-main or production deployment is implied by these local commits.

## Auth staging deployed

- Worker: `serp-auth-backend-staging`.
- Version: `06d5ae32-f79a-4e0a-a6c9-3b661af002f5`.
- D1: `serp_auth_db_staging`, `3a1291fb-7eb9-4d2a-b84a-9041558f5b1f`.
- Verified 0000–0008 already applied; added only 0009 through the guarded staging wrapper.
- Migration journal readback passed; foreign-key check empty.
- Pre-operation Time Travel bookmark recorded in Store's isolated rollout plan; no customer export.
- Source mode explicitly `test`; existing signing and internal credentials were not rotated.
- Deployed anonymous POSTs to both new source endpoints return 401.
- Removed public `/auth/test` returns 404.

This proves schema, deployment and the unauthenticated boundary. Authenticated source delivery,
effective customer access and login/session behavior remain unverified remotely.

## Isolated Store deployment

- Intended Worker: `serp-dev-safe-store-serptest`.
- Fresh D1: `c0243249-7b72-417f-ab8d-71671da20798`.
- Fresh R2 cache: `serp-dev-safe-store-serptest-inc-cache`.
- All 18 Store migrations passed locally and remotely after an empty-schema check. Dedicated
  journal has 18 entries and foreign-key check is empty.
- Existing Store staging/prod resources are not reused.
- Checkout, source delivery, Slack, unrelated reconciliation and cron start disabled.

The first remote attempt uploaded isolated assets/cache but failed before Worker activation:
OpenNext copied a `CLOUDFLARE_ENV=dev` string binding into its own process, and Wrangler interpreted
it as a named environment, producing an unintended `-dev` suffix. The correction removes that
reserved selector only from the isolated profile. Actual installed-toolchain testing reproduces
both the failure and corrected name. An empty deployment list was observed for the unintended
placeholder. The corrected deployment activated the intended Worker at version
`3f7a8a63-cc04-43a8-81e3-0af3ddd8b0c5` (100% readback), from Store `2b82ee0` and Auth `bc5fe0e`.
The repeated frozen release gate passed 1,016 Store tests, two opt-in Stripe skips, nine local
runtime contracts and typecheck, followed by fresh Next/OpenNext builds and isolated cache upload.

**Remote smoke failed despite successful upload.** `/api/health`, the Lago receiver and source
reconciliation route all returned 500. A narrowly tagged health probe's sanitized Worker error
identified startup instrumentation requiring Stripe test credentials even for this intentionally
credential-free EPD-only profile. No fake keys or copied Stripe credentials were installed.
A narrow provider-profile validation correction passed 21 tests, including the actual startup hook,
and independently reviewed strict preview/site/Worker/D1/test-mode checks. Ordinary staging and
production Stripe requirements remain intact. Enabling isolated checkout now also requires
source activation and delivery together, explicit EPD and disabled Authorize.Net. The corrected
source's frozen gate passed 1,037 Store tests with two opt-in Stripe skips, nine local runtime
contracts and typecheck. Fresh Next/OpenNext builds and isolated cache/Worker deployment succeeded.

**Corrected deployed startup passed:** version `71e5d4ad-cdbd-4590-a748-d6634b37eb95`, from Store
`d7007930f3dcf2c6f7158b4468a55b10692c0b7c` with Auth companion `1dcebae6` (docs-only successor of
deployed Auth source). `/api/health` returns 200 with `ok:true`. Anonymous POSTs return the expected
paused configuration responses: Lago receiver 503 `not_configured`, source reconcile 503
`disabled`/`missing_monitoring_token`, and initial retry 503 `disabled`. These are deliberate
missing-credential boundaries, not the former instrumentation 500. They do not prove authenticated
webhook acceptance, fulfillment, repair or Slack. No checkout was admitted.
The unintended `serp-dev-safe-store-serptest-dev` placeholder was verified to have no deployments,
then deleted without force. Its deletion does not affect the intended Worker, D1 or cache.

## Remaining acceptance evidence

1. Completed: corrected isolated Store deployment, dedicated bindings and paused route smoke.
2. Install the exact existing staging Auth credential and approved test Slack destination through
   narrow single-secret operations. Infisical sign-in is now verified; see the follow-up below.
   Do not bulk-copy old
   environment files, recover Worker secrets through unsupported methods, or rotate shared Auth
   credentials merely to avoid this access requirement.
   The normal Store account sign-in journey also needs its staging email transport (SMTP plus
   sender or Resend), not merely `ACCOUNT_SESSION_SECRET`. Account creation without delivered
   verification email does not prove login. Auth's independent OTP transport already has its
   credential name present, but actual OTP delivery/session/token issuance still needs testing.
3. Configure the isolated Lago organization, matching webhook HMAC, Store success return and new
   Store intent/session credentials. Keep live charging impossible.
4. Begin through Store so the immutable version-1 reservation exists **before** payment. Complete
   a real sandbox payment without browser return; verify signed webhook, one paid order, intended
   product binding, deployed Auth source/effective access and one clearly labeled `#money` message.
5. Replay browser/event and exercise bounded interrupted-delivery repair. Confirm no duplicate
   order, payment, source or notification. Slack uncertainty must not block paid fulfillment.
6. Use those Store-origin sources for renewal extension, one-time non-renewal, scheduled
   cancellation boundary, refund-driven source retirement and independent-source preservation.
7. Verify customer login/session/product access. Already-issued JWT expiry is distinct from
   next-request source revocation; do not claim instant revocation.

Legacy-license-required offers remain outside this generic skip-license canary until their separate
order-receipt contract is verified. A direct Lago payment is not a substitute for steps 4–7.

## Readiness decision

The earlier Gateway/provider-access blocker is closed for the financial scenarios listed above.
The complete deployed consumer chain is not yet proven. Keep production unchanged and do not
ask the user to make another real purchase until that chain passes and rollout is approved.

## Handoff and workspace preservation

Infisical browser sign-in is now working. Do not request another Gateway sign-in. The current
remaining access/configuration questions are the matching staging Auth internal credential (or
approval to rotate shared staging Auth and its consumers) and a working staging SMTP/Resend secret
location. Do not ask the user to paste credential values into chat.

## Signed-in credential and email follow-up (2026-09-09)

- Both Infisical staging `/apps/serp-store` and `/apps/store-safe` contain the same Auth credential.
  A direct in-memory handoff to a local verifier confirmed staging Auth rejects it: POST
  `/internal/entitlements/by-email` with `{}` returned 401. This request never looked up a customer.
  The earlier clipboard-transfer probe was invalid and is not evidence. No shared Auth secret was
  rotated. A temporary copy on the isolated Store was removed after rejection; Infisical unchanged.
- Both folders have no SMTP settings and an empty `RESEND_API_KEY`. The extension project's staging
  root is empty. The Store staging folder also includes production destinations/provider settings,
  so it must not be bulk-synchronized into the isolated Worker.
- Exact isolated Store secret-name readback confirms fresh `ACCOUNT_SESSION_SECRET`,
  `GENERIC_PLAN_INTENT_SECRET`, `MONITORING_TOKEN`, and `SLACK_TEST_SALES_WEBHOOK_URL`. Values were
  transferred in memory and individual stdin operations, not logged, written to env files or
  exported in bulk. Shared Store staging and production were unchanged.
- Direct Slack check `EPD-STAGING-WIRING-20260909-535224de`, explicitly labeled
  `STAGING TEST — NO SALE`, returned HTTP 200 and `ok`. Native Slack independently displayed the
  exact marker in `money` as a `SERPCashMoney` message at 10:08 AM. This proves destination delivery,
  not the Store purchase-ledger notification lifecycle.
- Secret-only isolated Store version readback after removing the rejected Auth candidate:
  `0a887eaf-069a-4ae1-817b-971fbdee826b`. Store and Lago health checks both return 200. Store checkout,
  source activation/delivery and notifications remain disabled; Auth URL is explicitly staging.
- Independent review reproduced a Resend false-success bug against the installed SDK with mocked
  HTTP: the SDK resolves errors instead of always throwing. Store now requires an error-free,
  nonempty message-ID receipt. Fifteen focused tests, all 1,052 Store tests (two credential-gated
  skips), nine actual local workerd Store-to-Auth tests, typecheck and scoped lint passed. This
  is local provider-contract testing, not actual email acceptance or inbox delivery.
- Fix committed as Store `299c7d3eff33b3a55734ca63ed6d11402a7c147d`. Clean build-only passed, then
  the authorized staging wrapper repeated the full frozen gate (1,052 Store tests, two credential
  skips, nine workerd contracts, 23 profile tests and types), fresh Next/OpenNext builds and cache
  upload. Deployed isolated Store version `2dd428d5-e860-4e6b-8467-129872dc464c`; deployment-list
  readback confirms 100%. Four intended secret names remain installed. Health returns 200,
  unsigned Lago webhook returns 503/not_configured, source reconciliation returns 401 anonymously
  and 200/disabled/source_delivery_disabled with the installed monitoring token. No payment,
  source-delivery, email-delivery or renewal gate was enabled.

The clean, task-created `tmp/store-new-serptest-release` worktree was removed with Git and stale
worktree metadata pruned after deployment evidence was recorded. Active audit worktrees remain
intentionally preserved for the blocked cross-service continuation:

- `tmp/store-new-epd-durable-fulfillment`, branch `codex/epd-durable-fulfillment`, clean;
  docs receipt commit `dd59e5e8c62909008d6f3607bb15b48f6cb46cc1` follows deployed code
  `299c7d3eff33b3a55734ca63ed6d11402a7c147d`.
- `tmp/serp-auth-epd-sources`, branch `codex/epd-source-entitlements`, clean at `1dcebae6`.
- `tmp/lago-production-canary`, branch `codex/epd-vault-binding-repair`, contains the existing
  uncommitted audit/remediation changes and this evidence; preserve them, do not reset or remove.

No production deployment, main-branch merge, push, shared Store staging deployment, or additional
financial transaction was performed during this consumer-startup repair.
