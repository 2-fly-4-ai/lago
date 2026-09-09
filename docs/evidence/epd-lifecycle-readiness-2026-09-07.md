# EPD/Lago lifecycle readiness audit — 2026-09-07

Status: **release blocked**. This report supersedes any inference that local green tests alone
establish production readiness. The user's approval to redeploy the Sprout canary is conditional
on readiness; that condition has not been met. No production change or live purchase was made
during this audit.

## Access-independent release preparation — 2026-09-08

Added a populated local migration-upgrade rehearsal in
`cloudflare/test/epd-migration-upgrade.test.ts`, using a separate test-only D1 binding.
It upgrades fictional legacy financial evidence from 0113 through 0114–0117, verifies preserved
rows and nullable provenance, exercises refund identity and dispute foreign-key protections,
checks immutable source history and atomic dunning rollback, and reapplies the full migration
list through its journal without changing prior entries. No remote database or provider was used.
The D1 runtime rejects `PRAGMA integrity_check`; that unsupported assertion was removed, not
reported as passed. Actual foreign-key and behavioral constraint checks pass.

Full Lago `pnpm run check` exited 0, including format/lint/types/generated bindings, Access/UI/
inventory/tax gates and all seven dry-run builds. A separate compact full-suite confirmation
passed **768/768 tests across 89 files**, with no skipped Worker tests. The new rehearsal is one
multi-assertion test, not dozens of new provider scenarios. Harness and `git diff --check` pass.

The [staging release checklist](../reference/epd-staging-release-checklist.md) now records
Auth → Lago → Store prerequisites, exact migration names, environment/activation traps, rollback
requirements and the provider-backed evidence still needed. Independent rollout review found
Store's generated `APP_ENV=preview` was rejected by its new source-delivery parser. The narrow local
fix recognizes preview as test; a regression consumes the actual Wrangler generator output and
checks production remains live, missing/unknown modes fail closed and neither source flag is
implicitly enabled. The failing regression was reproduced before the fix. Store's focused source
delivery suite passes 27/27, typecheck and scoped ESLint pass, and the full app suite passes
928 tests with four existing credential-dependent skips (162 passing files, four skipped).
This is local SQLite/mocked HTTP evidence, not a deployed Store or real provider transaction.
Auth's missing staging source-mode binding remains an explicit deployment configuration prerequisite,
not a reason to turn on live mode. No flags, provider accounts, remote migrations or deployments
were changed during this preparation. The merchant contract and actual staged journey remain open.

## Current continuation — 2026-09-08 Fiji

While the owner handles Commerce access, three independent reviewers and the main reviewer
continued local lifecycle recovery work. No provider credential, customer record, remote database,
production setting or deployment was changed. The following are local source/test findings, not
observations of additional production charges.

- **Interrupted Commerce response:** reproduced an early success webhook checkpointing an order
  while the resumed order POST then loses its response. The catch path erased that reference.
  A null error response now preserves the durable order checkpoint. The regression failed before
  the repair and passes afterward, proving one order creation and subsequent read-only convergence.
- **Gateway sandbox timeout:** a sale could lose its response before any transaction/vault
  checkpoint, so neither batch selection nor the recovery helper queried it. Gateway recovery now
  queries the stable request order ID without issuing another sale. Exact identity/money checks,
  scope/read gates, a bounded lease and fair rotation cover missing and contradictory results.
  The new 12 tests plus existing checkout tests passed 66/66 with fictional provider responses,
  actual local D1 and the real Query XML parser. This does not prove Commerce/Gateway equivalence.
- **Pending renewal dispatch:** disabling the consumer could acknowledge an event without claiming
  its pending execution. Re-enabling now allows aged, never-submitted pending work to receive a
  fresh durable event identity; the existing atomic charge claim still rechecks eligibility.
  Processing/unknown work never becomes a fresh charge through this path.
- **Configured provider isolation:** an independent cross-review found that matching database
  customer/profile/execution accounts alone did not bind work to the Worker's configured Gateway
  credential. Preparation, charge/read recovery, enrollment, selectors, redispatch and EPD dunning
  now require the configured organization/account. Missing or foreign scope fails closed before
  provider calls; candidates are scoped before batch limits.
- **Dispute ordering/linkage:** older loss events could overwrite a newer win; processing time was
  incorrectly used as provider time. Migration 0116 adds explicit receipt provenance. Provider
  timestamps and exact settlement linkage are required; missing settlement remains retryable,
  conflicting clocks/legacy heads/multi-invoice associations are held rather than guessed.
  Matching order identity, explicit positive integer total/currency and exact agreement with the
  settled ledger are required before recording a financial outcome. All 45 dispute/receipt-safety
  regressions passed locally; actual merchant dispute payloads remain unverified.
- **Dunning eligibility:** one-time or unscoped debt no longer contaminates an EPD monthly retry.
  The filtered outstanding balance must meet the configured threshold. A same-transaction
  eligibility assertion prevents a scope/profile/balance change from consuming a rejected attempt.
  Migration 0117 adds bounded assertion/review state without ledger triggers. Multiple valid saved
  profiles are explicitly held for review, not silently charged through an arbitrary card.
- **Migration/retention integration:** the new provenance foreign key exposed an incompatibility
  with unconditional receipt cleanup. Cleanup now retains referenced receipts and their archives,
  filtering before the batch limit and rechecking atomically at deletion/task creation. The test
  failed with a foreign-key error before repair. All 19 maintenance tests now pass, including 100
  retained heads without starvation and a dispute inserted after cleanup selection.

### Final local verification

After the final configured-account fence and independent review, `pnpm run check` exited 0:

| Gate | Result |
| --- | --- |
| Complete Lago Worker regression suite | **767/767 passed**, 88 files; no skipped Worker tests |
| Formatting / lint / TypeScript / generated bindings | Passed; zero lint warnings/errors |
| Access / checkout UI / inventory / tax tooling | Passed through the complete check command |
| Worker packaging | All seven development/production-config **dry-run** builds passed; no upload |
| Focused renewal/dunning/checkout integration | 130/130 local tests passed |
| Focused dispute/receipt safety | 45/45 local tests passed |
| Scheduled maintenance / retention | 19/19 local tests passed |

The focused counts overlap the complete regression total and must not be added to it. Provider
responses are fictional mocks against actual local D1/R2 and provider parsers. No real sandbox
transaction, deployed staging journey or production verification occurred in this continuation.
The earlier Store/Auth gate results below are historical passes, not freshly executed provider QA.

### Remaining operational evidence and decisions

- Actual merchant-specific Commerce customer/Gateway vault association and recurring processor
  reference remain unverified. Owner-granted access is still awaited; Gateway login is not the
  missing action. No permission changes were made by this continuation.
- Dispute-based entitlement policy remains a separate decision. Current source eligibility does
  not consult disputes. The user was asked whether to suspend only the affected purchase while a
  dispute is open, restore on a win and remove on a loss, or retain access until a loss. No access
  policy was silently changed. Multi-invoice dispute allocation and manual/operator override
  precedence also remain outside the demonstrated automated path.
- Before staging, inspect its migration baseline and approve the pending additive migrations in
  Auth/Lago/Store dependency order. Lago now includes dispute provenance 0116 and dunning review
  protection 0117 in addition to the earlier refund/source foundations 0114/0115. None was remotely
  applied by this audit.
- Provider-backed staging purchase/renewal/decline/refund, deployed source refresh, browser delivery
  and an actual Slack notification still need demonstration. Mocked tests do not close those gates.

**Production canary remains blocked.** Local repairs do not establish the missing provider contract
or grant production deployment approval. The worktrees and active plan remain open.

## Earlier continuation result — 2026-09-07, 22:20 Fiji

This section supersedes the historical counts and unfinished-local-work descriptions below.
The source-owned lifecycle is now implemented locally across Lago, Store and Auth, but is not
deployed or proven through an EPD-backed staging purchase. Production readiness remains blocked.

| Current local gate | Result |
| --- | --- |
| Lago full `cloudflare` check | 689/689 Worker tests, 86 files; format, lint, types, bindings, inventory, Access 5/5, UI 4/4, tax tooling 49/49 and all seven Worker dry-run builds passed |
| Store complete `test:all` | 927 passed, four credential-dependent tests skipped; 162 passing files |
| Store TypeScript / scoped final checkout lint | Passed |
| Store staging Next build / OpenNext Worker packaging | Passed locally; no upload/deployment |
| Store-core | 569/569, 90 files |
| Store registry/generated scheduler / shell conformance | 5/5 using `tsx --test`; shell baseline passed, zero app-local junk |
| Auth | 101/101, 18 files; build, typecheck, scoped lint and harness passed |
| Store transport into actual Auth Worker | 8/8 with two local D1 databases; no provider or deployed endpoint |
| CRM boundary | 2/2 actual sanitizer/payload/custom-field/license-parser contracts; remote GHL and contact configuration mocked |

The local contract suite loads the reviewed Auth Worker bundle with SHA-256
`4af610937e02e447100469480ace72f706aecf41a19f0c1a4626f74b0301a552`.
Normal app tests do not substitute for this separately configured cross-service gate.

### What is now wired locally

- Lago migration 0115 materializes immutable, revisioned billing-source snapshots transactionally,
  without triggers that would alter existing exact-row billing guards. Initial invoice, customer,
  provider account/mode, currency and original plan identity/interval stay pinned. Unknown or
  contradictory evidence holds access; it does not manufacture a paid state. Paid coverage survives
  a partial refund; a full refund removes the affected coverage, not independent later paid periods.
- Store migrations 0016–0018 add source projection/delivery revisions, pre-payment checkout
  reservations and bounded refresh leases. Unreserved caller UUIDs and edited/missing metadata
  cannot manufacture a legacy checkout or downgrade a known source-owned purchase.
- All three EPD access paths now share the coordinator: initial success, automatic binding and
  manual binding. Exact current billing revision, immutable product binding and Auth acknowledgement
  are required. An acknowledgement arriving after paid-through expiry cannot report active access.
- Guest source checkout collects email before allocating a payment attempt, without mandatory
  sign-in or a provider call. Signed product intent is preserved; markup is escaped and protected
  with no-store/no-referrer/CSP headers. Unsupported legacy-license offers fail before payment.
- Auth migration 0009 and authenticated source endpoints preserve independent purchase grants.
  Source provisioning cannot verify/reactivate a customer. Email aliases can retire only the exact
  existing source; they cannot move active access or create an account under an old email. Existing
  legacy reactivation paths hold affected source grants first.
- A bounded authenticated POST refresh route and the generated Worker schedule refresh both pending
  and acknowledged sources. Lease/CAS guards prevent duplicate or stale completion. Uncertainty is
  retryable and reported through aggregate counts. Missing monitoring authentication fails closed.
- Legacy retry jobs cannot bypass source ownership with global grants. EPD trial conversion no
  longer silently reactivates Auth customers. Source CRM payloads omit legacy license/entitlement
  fields; actual payload/parser contracts confirm purchase facts alone do not import a license.
- Existing EPD binding/account transfers and admin merges are held before mutation. This is not a
  distributed source-transfer implementation; a merge racing a new purchase remains a separate
  limitation. Historical version-0 purchases are not silently migrated to source ownership.

### Build correction

The first split Next/OpenNext packaging attempt lacked `NEXT_PRIVATE_STANDALONE=true` and failed
on a missing standalone pages manifest. The repository's deployment script already supplies that
setting, normalizes external Next tracing and applies the external-runtime hook. Rebuilding with
those existing steps produced the Worker successfully. No deployment was run, no dependencies were
upgraded and no production configuration was changed to conceal the failure.
An empty build-created `apps/serp-store/tmp` directory was inspected and removed with `rmdir`;
no files were deleted. Shell conformance then passed. Registry/scheduler files use Node's test
runner; an initial Vitest invocation reported no Vitest suites, then the correct `tsx --test`
invocation passed all five tests. Store-core typecheck and all three diff checks also passed.

### Provider access: Gateway available; Commerce association not yet verified

On 2026-09-08 Fiji, the user signed into a new normal-Chrome Gateway merchant tab. Read-only
inspection confirmed that this session can open Customer Vault search and the matching vault's
billing-method records. Searching the exact billing reference from the user's failed Sprout
checkout returned one vault row. The billing-method record link itself (not merely the search
parameter) matched that reference. No customer record, card details, session URL or raw provider
response is copied here.

This establishes that the reported billing ID exists in the inspected Gateway account. It does
**not** establish that Commerce's customer points to that same vault, that the production API key
uses that Gateway account, or that the recurring processor reference is correct. The production
error is therefore not evidence that the ID is absent from Gateway altogether. The existing
customer-to-vault association remains the next verification target. Gateway login is no longer
a blocker; the earlier login observations below are historical. No vault was created or updated,
and no payment, sync, permission change or deployment was performed.

A further fresh Commerce navigation required reauthentication. The existing Google identity was
successfully reauthenticated without new scopes; Commerce again landed on User Management with
Workspace Admin 9/51 and no customer navigation. The member-role selector offers predefined roles,
not additive permission checkboxes. An unsaved preview of Read-only 11/51 showed customer/order/
transaction/subscription reads but no user-management rights, and its customer permission explicitly
also bundles email/call actions. The preview was cancelled and the list reconfirmed Workspace
Admin 9/51. Do not switch this account to Read-only as a temporary workaround: restoring its admin
role may require the owner. The missing action is owner-authorized customer evidence access that
preserves administration, or an authorized existing API execution path; no such API credential was
made available or extracted during this continuation. The public customer contract documents
read-only retrieval but does not itself reveal this merchant's vault association.

Read-only browser inspection confirmed EPD Commerce is signed in. Its user-management page shows
the current Workspace Admin role has 9/51 permissions. The expanded excluded-permissions list
explicitly includes customer profiles, orders, transactions, subscriptions, processor configuration,
and EPD Gateway sync viewing. This limits that dashboard session only; it does not establish
Gateway portal permissions or API-key permissions. No role was changed or saved.

**Follow-up correction after the user's challenge:** the original Gateway merchant tab was checked
separately. A fresh navigation to its merchant index redirected to login, proving that session
requires reauthentication, not that its role/API credentials are restricted. The remote execution
shell reported only credential-presence booleans: Commerce key, Gateway key and Lago API key were
not available in that shell. No key values were read and no authenticated provider request was
made, so deployed API access remains untested rather than failed. The correct Gateway login tab
was left available for the user. Prefer that existing session/API access before any role expansion.

The dashboard links to [EPD's current vaulting guide](https://docs.epd.com/api-reference/card-vaulting/).
It documents Elements capture, a short-lived `card_token`, server attachment, then a permanent
`payment_method_id`. It still does not establish the CollectJS/Gateway numeric-billing-ID-to-Commerce
bridge used by this implementation. This is an unresolved contract question, not proof that the
bridge is unsupported. No actual card attachment, charge, refund, Gateway sync or processor change
was attempted. No customer/payment response was exported into this report.

### Still required before a production canary

1. Verify the actual merchant-specific Commerce/Gateway vault association and recurring processor
   reference using approved read access. Do not infer it from synthetic adapter fixtures.
2. Approve the additive staging migration/deployment in dependency order: Auth 0009 plus reviewed
   handler, Lago 0115 plus producer, then Store 0016/0017/0018 plus disabled code. Verify the deployed
   Auth baseline and staging endpoints/secrets by allowed checks before enabling source flags.
3. Enable only the explicitly approved staging scope and demonstrate real EPD sandbox initial
   payment, renewal, decline/replay, cancellation/refund, access removal and Slack delivery. Confirm
   the source refresh job and browser journey against the deployed artifacts. None ran this turn.
4. Review historical EPD source-0 grants/backfill separately. The source implementation must not
   retroactively revoke unrelated legacy access. Existing JWTs remain valid until token expiry
   (source default is 60 seconds); deployed TTL and client enforcement are not yet verified.
5. Reassess the Sprout-only production canary after that evidence. The conditional production
   approval is not exercised while these gates remain open. The user performs the real purchase.

All three isolated worktrees retain uncommitted audit work and are preserved. They have not been
merged or pushed by this continuation. No remote database mutation, deployment, secret sync,
payment/refund or Slack/customer message was performed.

## Source identity and independent review

- Lago: retained `tmp/lago-production-canary`, branch `codex/epd-vault-binding-repair`,
  starting HEAD `e398634`; audit changes are additional to that commit.
- Store: isolated `tmp/store-new-epd-durable-fulfillment`, branch
  `codex/epd-durable-fulfillment`, based on `origin/main` at `c06e04663`.
  The older, dirty primary Store checkout was not used or reset.
- Independent reviewers covered checkout/provider recovery; renewal/dunning/refund billing;
  and Store fulfillment/entitlements/Slack. Main reviewed their changes, provider documentation,
  and the cross-repository contract. Reviewers were also used to reproduce and repair findings;
  their participation is not a third-party certification.
- All filesystem-heavy checks run on the Mac mini's local SSD through SSH, not over SMB.

## Provider contract evidence

Official documentation was retrieved on 2026-09-07. No authenticated provider/customer API was
called for this audit, and no private account response was copied into evidence.

1. EPD's [card vaulting](https://docs.api.epd.com/api-reference/card-vaulting/),
   [customers](https://docs.api.epd.com/api-reference/customers/) and
   [payment methods](https://docs.api.epd.com/api-reference/payment-methods/) documentation
   describes Elements `card_token` attachment. It does **not** establish the legacy
   `epd_gateway_customer_vault_id` response and `billing_id` bridge used by this implementation.
   Missing data is handled as a hold, not an inferred matching vault. This prevents unsafe
   attachment but can still block a legitimate production checkout.
2. EPD's [orders](https://docs.api.epd.com/api-reference/orders/) documentation says order/refund
   idempotency keys expire after 24 hours. Checkout mutation replay is now bounded to 23 hours
   from immutable execution creation. Known orders remain readable beyond that boundary.
   Uncertain refunds are held rather than automatically resubmitted with an expired/new key.
3. Refund confirmation now uses the specific new refund transaction and verifies its order,
   amount, currency, type and status against the [transaction API](https://docs.api.epd.com/api-reference/transactions/).
   A cumulative `partially_refunded` order is not proof that this refund succeeded.
4. The Gateway adapter uses the NMI-style Query API. The [official NMI contract](https://docs.nmi.com/reference/query)
   distinguishes sale, authorization, capture, void, refund and return actions. The parser now
   requires an unambiguous typed sale and its actual amount; it does not use the last action's
   success or requested amount. Reversed/ambiguous evidence is held. This is documentation-backed
   parser verification, not a captured response from this merchant's EPD gateway.

The production initial-sale-to-Gateway-recurring processor reference also remains unverified.
Staging `gateway_test` bypasses Commerce attachment, so its success cannot close this contract gap.

## Findings repaired locally

- Failed-then-successful webhook recovery now derives unfinished post-payment work from exact
  paid ledger evidence rather than leaving a terminal failed execution stranded.
- Order mutation replay cannot continue beyond the provider deduplication window.
- Manual and automatic EPD claims exclude another in-flight/unknown payment against the same
  invoice. Prepared renewals recheck current customer/provider-account/profile eligibility.
- Dunning cannot create another charge while an earlier invoice payment outcome is unknown.
- Payable-balance checks cover stale requests and deduplicate mirrored payment-attempt/allocation
  records so partial payments are not counted twice.
- Duplicate webhook ingestion uses independently owned archive candidates. Permanent, recognized
  receipt/evidence failures are quarantined while retaining their evidence; infrastructure errors
  are not silently acknowledged as successful processing.
- A tax/address prerequisite failure on one renewal is isolated and rotated so later eligible
  invoices can proceed. Unexpected database/programming failures still fail the job.
- Refund submission is atomically claimed with a persisted UUIDv4 key. Concurrent requests cannot
  submit twice. Unknown outcomes retain a pending financial obligation and require reconciliation.
- Gateway query parsing distinguishes a sale from later reversal actions and partial approvals.
- Store initial paid webhooks invoke the same verified fulfillment as the browser. A durable
  lease/receipt prevents concurrent completion; failures remain retryable. Required grants and
  activation precede the completion marker. Slack delivery/configuration is not the fulfillment gate.

## Initial lifecycle evidence matrix (historical; current continuation above supersedes local gaps)

“Local” means fictional data, local D1/R2 or SQLite, and injected/mocked provider responses.
Test titles containing “live” or “production” describe a configuration branch, not a real charge.

| Scenario | Local evidence | Provider/deployed evidence from this audit |
| --- | --- | --- |
| Initial/returning-customer purchase | Checkout/provider tests: identity, vault, explicit new card, money and payment finalization | Not verified against actual Commerce bridge |
| Monthly/other recurring renewal | Automatic-collection tests: MIT fields, scopes, account/profile, exact money, tax and recovery | No real sandbox renewal or production renewal performed |
| One-time never renews | Checkout, billing-period, renewal selection and mixed-request exclusions | No new deployed observation |
| Regional discount / tax | Price/checkout fixtures and full local tax-tooling gate | No new browser purchase; legal registrations and worldwide tax correctness are not established by fixtures |
| Declines / retry / interruption | Definite failure versus unknown, bounded replay, no unknown automatic resubmission, post-payment retry | No actual decline/timeout induced at EPD |
| Duplicate requests / reordered events | Atomic claim races, duplicate archives, stale failure and early success evidence | No actual webhook delivery race induced |
| Cancellation | Lago termination/idempotency and renewal-ineligibility tests | End-to-end access revocation not implemented safely |
| Refund / void | Atomic refund claim and exact transaction validation; reversal-aware Gateway query | Real sandbox refund/void not run; unknown refund recovery remains held; production refund adapter remains disabled |
| Entitlement delivery | Store browser + webhook durable initial fulfillment regression | No new deployed customer delivery verified |
| Entitlement removal | Independent source review found missing source ownership | Blocker: cancellation/refund/failed-renewal aggregate revocation needs a shared contract |
| Slack | Signed event, identity/money, mode, replay and delivery-state fixtures | No message sent or confirmed in `#money` this audit |

## Initial verification record (superseded below)

These are the earlier audit's historical counts, not the latest result. See **Completed continuation
gates** below for the current gate and subsequent changes. None is a provider-backed pass.

| Command / boundary | Result |
| --- | --- |
| Lago `cd cloudflare && pnpm run check` | Passed, exit 0 after final fairness change |
| Worker Vitest suite | 634/634 tests, 83 files |
| Access / checkout UI / tax-tooling | 5/5, 4/4, 49/49 |
| Formatting / lint / typecheck / generated bindings | Passed; lint 0 warnings/errors |
| Feature inventory / operator parity | Current |
| Development and production Worker dry-run builds | All seven passed; **not deployments** |
| Lago `node scripts/check-harness.mjs`; `git diff --check` | Passed |
| Store unit/component suite | 681/681 tests, 140 files |
| Shared Store-core suite | 561/561 tests, 90 files |
| Store and Store-core typecheck; Store ESLint | Passed |
| Store Cloudflare registry tests; shell; diff whitespace | 4/4; passed; passed |

Store results were run by the independent Store reviewer in its isolated worktree. The full
Store lint command passed its offline checks but **skipped the live entitlement validator**
without credential fixtures. `check:stores` was interrupted after it unexpectedly entered the
broader multi-store build/test sequence; it is not recorded as a complete pass. No tracked
generated source changes resulted. No complete Store production/deployment build is claimed.

Wrangler was verified as 4.123.0. Lago submodule revisions were unchanged: API
`e36ab5fec575bbba545a5d8078868d60a3010aaf`; frontend
`343281d103a0d103e34a7608bd03096d1d55acca`.

Both repair worktrees retain uncommitted audit changes and must be preserved. Nothing was pushed,
and neither deployment was altered. Only inspected empty, test-generated Store `tmp` directories
were removed; no customer evidence, credentials, or user changes were removed.

## Remaining release blockers and exact next actions

1. **Actual EPD bridge:** the user approved narrowly scoped read-only D1 and EPD customer checks.
   The D1 field-presence check completed (see continuation below); the existing Commerce browser
   session redirected to sign-in. Complete the provider-side check after sign-in, reporting only
   field presence and vault-match booleans; no card data, identifiers, edits or charges.
   If the API does not expose the required bridge,
   choose a supported adapter architecture/provider-confirmed contract rather than inventing fields.
2. **Source-owned entitlements:** Store owns purchase/source mapping; Lago owns current billing and
   refund truth; Auth must aggregate active sources with versioned updates. A direct product-wide
   revoke can remove another valid purchase, and a delayed old grant can undo a newer revocation.
   Current Stripe handlers are not a safe reusable aggregate solution. Preserve Stripe behavior
   while designing and testing the EPD path; do not silently change existing entitlements.
3. **Refund operations:** local checkpoint-based GET-only convergence is implemented; verify it
   against the actual sandbox provider and establish the matching Gateway/Commerce refund boundary.
   Lost responses without a durable transaction checkpoint remain held. Do not turn on production refunds as part of a canary
   until this lifecycle is tested, including full/partial refund access policy.
4. **Staging rollout:** review additive Store migration `0015_lago_checkout_fulfillments.sql`, apply
   only to staging, deploy the exact tested Lago/Store artifacts, and verify bindings/versions and
   live-mode-off flags. Then run a genuine test-card journey, renewal, refund/decline and interrupted
   browser fulfillment against the same provider contract intended for production. Capture only
   sanitized outcomes, not card data/session bundles. A Gateway-only pass is insufficient for Commerce.
5. **Canary decision:** after all release blockers and provider-backed tests pass, deploy only the
   approved Sprout canary, verify the deployed route and amount without submitting a live payment,
   and let the user purchase. Do not widen products or touch existing Stripe subscriptions.

Additional documented limits: legacy corrupted webhook receipts with a missing companion event
row need an approved data-integrity inspection; normal ingress writes both atomically. Non-generic
offers requiring the legacy license helper need an order-specific provisioning receipt rather than
an email-only fallback. Reversal of collected tax after refunds needs end-to-end evidence too.
The new receipt selection reserves 50 slots per provider, preventing disabled Authorize.Net reads
from occupying every EPD recovery slot.

**Current decision: another production canary is not justified.** No new staging deployment or
full customer-journey demonstration has been completed in this audit; these remain work, not passes.

## Continuation: refund recovery and current-state fulfillment

The earlier verification table is a historical local gate, not a claim that subsequent edits
have already passed it. The continuation adds:

- Migration `0114_epd_refund_read_checkpoint.sql`: immutable Commerce transaction identity,
  distinct from processor refund identity. Refund execution checkpoints before verification GET;
  recovery is GET-only and verifies exact order, amount, currency, type and status. Lost POST
  responses without a checkpoint remain unknown; never guess from equal amounts or submit again.
  Focused provider/ledger tests: 67/67; production/Gateway refunds still disabled/unsupported.
- Authenticated `GET /api/v1/invoices/:id/fulfillment`: one local-ledger snapshot used before new
  EPD grants, including manual app binding. Missing/terminal/refund/ambiguous evidence denies
  fulfillment. It is not provider reconciliation or a cross-service mutation lock.
- Strict EPD legacy-license fulfillment requires an exact order-specific receipt. Stripe's
  existing fallback remains unchanged. Required upstream receipt support is not yet established.
- A clean Auth worktree adds revisioned, environment-scoped entitlement sources while preserving
  legacy contributions. This is local, unconnected code; the authoritative Lago revision producer,
  Store source mapping/delivery, verified deployed Auth baseline and lifecycle integration remain.

Approved production D1 probe on 2026-09-07, using the existing Wrangler login, returned only
field-presence aggregates for the latest incomplete execution belonging to the user's account:
one execution, Commerce customer present, Gateway vault present, billing reference present,
payment method absent, provider order absent. D1 reported zero writes and `changed_db: false`.
This narrows the local checkpoint boundary but does not establish the provider-side outcome,
the vault match, or that no request reached EPD. No identifiers or raw customer rows were output.

The existing EPD Commerce tab was checked and redirected from `/customers` to `/auth`.
The user was asked to sign in; no password, cookie, API key, provider customer row, or card was
read or changed. No deployment, remote migration, provider mutation, refund, charge, or Slack
message was performed in this continuation.

### Earlier completed continuation gates (superseded by current result above)

These supersede the historical counts above, for the continuation source before the still-in-progress
source-delivery projection work. They remain local evidence, not provider or deployment evidence.

| Boundary | Verified result |
| --- | --- |
| Full Lago `cd cloudflare && pnpm run check` | Exit 0 after public error mapper and cursor quarantine; 668/668 Worker tests across 85 files |
| Lago Access / checkout UI / tax tooling | 5/5 / 4/4 / 49/49 |
| Lago format / lint / types / generated bindings / inventory | Passed |
| Lago Worker dry-run builds | All seven passed; no deployment |
| Lago harness / diff whitespace | Passed |
| Store `test:all` | Final combined binding/admin/projection suite: 776 passed, four existing credential-dependent tests skipped; 150 passed files, four skipped |
| Shared Store-core | 569/569 tests across 90 files; typecheck passed |
| Store types / ESLint / registry / shell | Passed; final nine-file binding/admin lint passed; earlier registry 4/4 |
| Auth backend tests / build / typecheck | 85/85 tests across 17 files after safe bootstrap/parser follow-up; passed |
| Auth scoped source/test ESLint / harness / diff whitespace | Passed |

Store's skipped tests cover live Stripe, product-copy/cross-sell credentials and manual GHL preview;
none is counted as provider verification. Auth's new request parser bounds actual UTF-8 body bytes to
64 KiB before JSON parsing. The invoice snapshot tests include an actual local `closeBillingPeriod`
and reconciliation sequence: advance-billed renewal entitlement dates come from the immutable
subscription plan line, not the already-closed period in the invoice/subscription link.

All three isolated worktrees retain scoped uncommitted changes. Auth starts from main
`dd3d91d1bb50a5b36dfba223698781f00670ae0f`. No secret values were read. A staging secret-name list
confirmed the configured names only; it does not establish credential validity. The existing
Commerce tab remains at sign-in. No production canary is authorized by these local results.

### Further local source-delivery safeguards

- Public `/easy_pay_direct/payment_form` errors now map to fixed customer-safe messages and strip
  arbitrary provider codes/details. Original exceptions remain available to existing reconciliation;
  other API/tax response contracts are unchanged. Three focused tests and typecheck passed,
  including a real Worker-route request proving missing configuration is not exposed to customers.
- Independent Store review identified three separate EPD grant paths and legacy trial conversion.
  Source integration must switch these together; legacy trial conversion can verify/reactivate
  Auth identities and cannot serve as safe customer provisioning.
- The local Store projection combines Lago billing revisions with immutable product binding using
  compare-and-swap, then generates its own Auth delivery revision. Billing versions alone cannot
  version a later product selection. Old acknowledgements cannot mark newer delivery complete.
  Explicit one-time access expiry must remain bounded, not become a perpetual entitlement.
- The proposed Lago trigger-based cursor journal is **not release-ready**: integration testing
  showed its trigger writes change D1 `meta.changes`, breaking an existing exact-row billing guard.
  It is quarantined under `docs/design/experimental-subscription-fulfillment-cursors*`, outside
  normal migrations and test discovery; no production/staging migration was applied.
  Existing payment guards must not be weakened to accommodate it. The immutable billing snapshot producer, repairable
  transport, coordinated call-site cutover and provider-backed journey still remain.
- Auth's local `POST /internal/customers/source-ensure` creates an unverified identity under a
  normalized-email atomic insert/read transaction. Concurrent requests converge without granting,
  verifying or reactivating existing customers. It requires internal authentication and the explicit
  matching test/live source mode. This supplies a safe bootstrap contract, not a complete Store cutover.
- The bounded JSON reader now distinguishes oversized input from malformed UTF-8/stream failures.
  A rejected or hanging cancellation cannot delay/replace the size rejection. All 85 backend tests
  passed after these additions; no real accounts were used.
- Store's EPD binding path now persists an immutable, owner/order/provider-matched product choice
  before granting. Competing product selections cannot both grant. A subsequent automatic retry
  follows the canonical saved choice rather than stale marketing intent, and retries failed grants
  instead of treating a saved binding as completed access delivery. Stripe's ordinary binding path
  is unchanged. The privileged admin rewrite path and its mutable SQL helper now reject EPD
  transfers before mutation/grant; a source-aware transfer contract is not implemented. Account
  merge/identity-transfer behavior remains separately unresolved and is not claimed safe for sources.
