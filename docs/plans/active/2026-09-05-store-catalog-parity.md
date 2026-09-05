# Store catalog parity and bounded EPD rollout

Status: active. Owner: Lago for billing catalog; Store for offer selection and product routing.

## Approved scope

Populate missing production Lago plans from the existing Store price catalog, including the
$17 tier, and audit all product mappings. Prepare for eventual EPD coverage across products,
but do not deploy Store to production or expand live routing in this operation. Existing Stripe
subscriptions/prices, automatic collection gates, provider secrets, and tax settings stay unchanged.

## Sources

- Store working branch `codex/epd-recurring-staging`, commit d01233ffdc9718ee7e89fe6250c6e163d4e41172.
- Store `origin/main` 6c44b2a18dca65ab1afe009158764ef4bad2c564.
- Store owns `packages/store-core/src/generic-plans.ts`, the commerce price manifest,
  product purchase models, and product billing routes. Marketing sites do not own routing.
- Lago branch `codex/production-epd-canary`; starting commit a892064.

## Findings before changes

Production org `org-serp-billing` contains only three standard-tier plans ($9 monthly,
$79 yearly, $9 one-time). Staging already contains all 13 generic variants, including
$17/$149, $27/$239, $37/$329 and $99 lifetime. Production import was incomplete.
Store branch and main differ in manifest formatting/legacy lifetime fallback and staging route
configuration, but generic base amounts match. Do not replace current branch routing with main's
older broad staging cohort.

The public Lago plan CRUD API still rejects one-time plans. The existing audited Store checkout
lifecycle and seeded one-time records are separate from this API capability. Record this honestly;
do not remove the rejection without testing the full supported one-time feature boundary.

## Execution and gates

1. Generate desired generic catalog deterministically from Store's manifests and shared definitions.
2. Audit all bundled products with Store's actual pricing/purchase-model functions; identify
   dedicated-price products and unsupported variants separately, including bundles/campaigns.
3. Test additive, idempotent catalog repair against migrated SQLite. Reject existing conflicting
   prices/cadences or inactive plans; never overwrite existing subscribed plan rows.
4. Capture D1 restore bookmark. Apply only the reviewed catalog insert to production; verify
   exact amounts/intervals in D1 and the production operator dashboard.
5. Run relevant Store contract tests and Lago checks; record evidence and remaining blockers.
6. Separate later rollout: verify the exact Skool/OnlyFans products and recurring lifecycle in
   staging, obtain user acceptance, then approve Store canary deployment and narrowly scoped
   renewal activation. Do not represent catalog parity as complete payment-lifecycle readiness.

## Rollback

Keep live product routes unchanged. Newly unused catalog entries may be retired through Lago
after reference checks; do not delete or reprice plans referenced by subscriptions/invoices.
Database restore is incident-only because it would affect unrelated subsequent writes.

## Verification / remaining work

Catalog repair and product-mapping audit completed on 2026-09-05; wider rollout remains active.

Production now has all 13 generic variants plus two separate bundle base-price plans ($79/month,
$879/year). Staging has the same base catalog. Production received 12 new plan rows, staging two
bundle rows. Existing plan IDs, versions, amounts, metadata and subscriptions were not changed.
The bundle campaign ($49/$549) is not substituted for base prices or existing subscription terms.

Artifacts in `cloudflare/fixtures/store-*-catalog-*-2026-09-05.sql` record the exact additive
operations. `scripts/store-plan-catalog.mjs` generates insert-only statements with an all-catalog
preflight that aborts on missing tenant or conflicting latest-root price/cadence/currency/status.
It is an explicit operational bootstrap, not an automatic migration or checkout fallback. It does
not emit provider commands or alter taxes, scope gates or subscription records.

Pre-repair production Time Travel bookmark:
`000001d1-00000890-000050dd-2c600b52099095dae1d6946635503589`.
Final production catalog import bookmark:
`000001d1-000008f8-000050dd-d7517e8b228d39a7e48afc949c6d57fd`.
Staging full base-catalog import bookmark:
`000001ec-000009ea-000050dd-3e3f47d0d83938fdc3c5a2335213d076`.

Store audit covered 1,024 published catalog entries, both environments and both requested billing
intervals, using actual Store helpers. Skool Bulk, Skool Video and OnlyFans resolve to premium
$37/$329 subscriptions. Standard adult entries remain one-time; Instagram/LinkedIn are $9
one-time and Vimeo is $17 one-time. JustForFans is Pro $27/$239. The regression audit asserts
that merely provisioning plans never widens the live route beyond Pornhub.

Verification: Lago full check passed (455 tests, format, lint, typecheck, Access/tax checks and all
dry-run builds). Store unit tests passed (524 tests across 118 files) and final typecheck passed. The
bootstrap tests exercise the fully migrated D1 schema, idempotent replay, atomic conflict failure,
missing tenant and invalid input. Production dashboard inspection confirms the imported entries.
Foreign-key check is clear; no enabled production automatic collection scopes.

Remaining genuine gaps (not claimed complete):

- Public one-time plan create/edit remains rejected by Lago's catalog API. Seeded flat one-time
  checkout works separately. Support that administrative API only with explicit flat-plan feature
  constraints and lifecycle regression coverage, not by removing guards indiscriminately.
- Bundle base plans are prepared, but Store deliberately keeps non-generic offers on direct Stripe;
  promotions/add-ons/dedicated-offer behavior need their own EPD acceptance before all-product routing.
- Choose the exact Skool product; prove the two requested recurring canaries end to end in sandbox.
- Production automatic collection is disabled and has zero enabled subscription scopes. The
  production tax gate was disabled before this task and was not changed. Resolve those policies
  before claiming recurring production readiness or enabling Skool/OnlyFans routing.
- No Store production deployment, provider charge, secret change or existing subscription migration
  occurred in this repair. Lago Worker version remains 7ac94d25-e0c8-4731-8b20-e9ef92bd13f0;
  this was catalog data repair, not another Worker deployment.
