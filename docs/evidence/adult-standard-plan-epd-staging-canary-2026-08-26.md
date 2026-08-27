# Adult standard-plan EPD staging canary

Date: 2026-08-26
Final routing-integrity verification: 2026-08-28

## Scope

- Store branch: `main` (final routing-integrity work prepared on `codex/lago-routing-integrity`)
- Lago branch: `codex/cloudflare-native-rewrite`
- Staging only; no live cards, production data, production routes, or production provider calls.
- The Store catalog selects the 986 currently classified adult products in the standard $9
  one-time plan cohort.
- Safe products and adult Plus/Premium products remain on the existing Stripe path.

## Deployed versions

- `serp-dev-main-store`: `a55e1e1a-f6f9-49c4-aea5-40991e49ffa7`
- `serp-dev-safe-store`: `b32cfb54-38a5-40f5-b959-8d9ece53b420`
- `serp-dev-lago-native`: `9dc31222-5f13-460f-a93f-e8cd534d09ae`
- `serp-dev-lago-operator`: `b3d1ac8c-9a9d-4dc0-be32-accbd9dddce1`
- `serp-dev-lago-portal`: `b6c3e2a2-4ca4-44dc-8a55-5309d3d3e839`

## Browser verification

The following staging marketing-site checkouts minted staging-signed intents and reached the Lago EPD
hosted test card form as a one-time `$9.00` purchase:

- `pornhub-video-downloader`
- `eporner-video-downloader`
- `rule34-video-downloader`
- `zzcartoon-downloader`

Each page displayed `EPD TEST MODE`, real hosted card fields, and `One-time payment`. The final
customer-facing copy closeout replaced the fixture-derived heading with `Buy SERP App Plan`. No
card was submitted.

Control checks stayed on Stripe Sandbox:

- `pinterest-downloader` on the safe standard plan
- `justforfans-downloader` on the adult Plus plan
- `onlyfans-downloader` on the adult Premium plan

The safe control initially exposed an adult-classification bug. Store commit `8976de4fa` fixed the
route to require both a valid signed standard intent and an adult catalog classification before the
cohort route can select Lago/EPD. Final routing-integrity commit
`c39a710eb5c0e20bdec03a9d3563d91906cad1eb` corrected the source classifications for Instagram and
LinkedIn, regenerated both catalogs, and added a generator guard that rejects any future explicit
safe-shared product classified as Adult.

## Automated gates

- Store checkout, billing-route, and migration-journal tests: 34 passed.
- Lago test suite: 72 files and 410 tests passed.
- Lago formatting, lint, generated inventory, Access provisioning tests, generated binding checks,
  TypeScript checks, and development/production dry-run Worker builds passed.
- Unauthenticated operator request redirected to Cloudflare Access (`302`).
- Unauthenticated Lago API request failed closed (`401 unauthorized`).
- Store and Lago health endpoints returned healthy responses.
- Store and Lago D1 `PRAGMA foreign_key_check` returned no rows.
- Lago reported no pending migrations.
- Store migration hashes now match the journal. The previously orphaned row-read index migration was
  moved to journaled migration `0010`, applied to staging, and guarded by a regression test.

## Remote build execution

Builds and deploys ran directly on the Mac mini over the existing `ssh macmini` configuration, using
the mini's local SSD rather than compiling across the SMB-mounted `/Volumes/brianfarley` worktree.
The corrected Store Next build completed in about 35 seconds, and the Lago deploy completed in about
15 seconds. The absolute worktree Git metadata was supplied explicitly where Git-aware commands
needed it.

## Commits

Store:

- `df87d7a53` — route the adult standard-plan staging cohort to EPD
- `8976de4fa` — require adult catalog classification for the cohort
- `0f7f15a03` — repair Store migration journal coverage

Lago:

- `e802ac2` — label one-time EPD purchases truthfully
- `f87f2a5` — scope the upgrade credit ownership assertion
- `4882267` — remove internal routing and QA language from customer checkouts

Production routing remains unchanged. Moving any product cohort beyond staging remains a separate
canary decision.

## Final end-to-end acceptance

The final deployed build completed a real EPD test-mode purchase from the staged Pornhub Downloader
product route. The checkout displayed the hosted EPD card fields, `EPD TEST MODE`, a one-time
`$9.00` total, and the generic `SERP App Plan` payment description. No live card or production data
was used.

- Synthetic customer: `epd-final-1787739733331@example.invalid`
- Lago invoice: `386da1ec-e98b-5663-8a7d-83aa5c1957d2`
- EPD test transaction: `12475753463`
- EPD response: `100`, succeeded
- Store result: one completed session and exactly one paid order for 900 USD minor units
- Store provider and source: `easy_pay_direct`
- Bound product: `pornhub-video-downloader`
- Staging SerpAuth result: active `pornhub-downloader` entitlement for the synthetic customer

Reloading the same completion callback twice continued to show the completed purchase while Store
retained one order and Lago retained one EPD execution, one payment-request payment, and one invoice
allocation. No replay created a second provider transaction or entitlement.

An unpaid checkout was also sent directly to its completion callback. It displayed the blocking
`Lago payment is not verified yet` state, retained a pending Store session, created no Store order,
and retained zero EPD executions, payment attempts, or allocations. An unknown `lago:` callback
displayed `Checkout could not be verified` and did not fall through to Stripe.

The live pass exposed two legacy staging D1 constraints that allowed only Stripe/PayPal/GHL source
values. Journaled Store migrations `0011` and `0012` rebuilt `checkout_sessions` and `orders`
without the obsolete provider-specific constraint. They preserved 298 checkout sessions and 219
orders at migration time; post-migration foreign-key checks returned no rows. The reconciled EPD
order now records truthful provider/source attribution.

The Lago payment projection was also corrected so the one provider transaction is not counted twice
through both invoice-attempt and payment-request-allocation representations. A regression test pins
the canonical API result at 900 paid and zero due.

## Final gates

- Lago `pnpm check`: passed formatting, lint, Access tests, generated inventories, binding types,
  TypeScript, 72 files / 412 tests, and all development and production dry-run builds.
- Store core: 90 files / 561 tests passed.
- Store checkout/billing-route/fulfillment focused suites passed; Store typecheck and lint passed.
- The broad Store app suite passed all 591 runnable tests after the sparse worktree materialized the
  tracked `serp-apps` and `pornodownloaders` product JSON source directories. Four live/manual tests
  remained intentionally skipped. No validator was weakened and no catalog data was fabricated.
- The adult-standard dry-run resolved 986 current live products with zero pending test selections;
  JustForFans Plus and OnlyFans Premium remained excluded.
- A safe `skool-video-downloader` control still reached Stripe test Checkout.
- Lago `/health` and `/ready`, and Store `/api/health`, returned 200.
- Unauthenticated Lago API returned 401; unauthenticated operator traffic redirected to Cloudflare
  Access with 302.
- Lago has no pending migrations. Lago and Store D1 foreign-key checks returned no rows. Store
  migration records include the exact hashes for `0011` and `0012`.

This closes the isolated staging implementation and acceptance work. Production data migration,
production provider secrets, production routing/DNS, and the product canary activation remain a
separate explicitly approved rollout.

## Final routing-integrity closeout

The corrected Store commit was merged and pushed to Store `main`, then both staging storefront
Workers were deployed from that exact revision. A fresh browser pass verified that LinkedIn
Downloader renders as `Social Media`, does not render an Adult classification, and opens Stripe
Sandbox with the existing payment-method choices. Pornhub Downloader renders as `Adult` and opens
the real EPD test hosted card form with `EPD TEST MODE`, a one-time $9 total, three Collect.js
iframes, and no synthetic-outcome control. No additional payment was submitted during this pass;
the successful EPD test transaction and replay evidence above remain the provider acceptance.

Post-deploy checks found healthy main Store, safe Store, Lago health, and Lago readiness responses.
Lago reported no pending migrations. `PRAGMA foreign_key_check` returned no rows for Lago, main
Store, or safe Store D1. Unauthenticated operator access redirected to Cloudflare Access (`302`),
and unauthenticated Lago API data remained denied (`401`). The Store full gate passed 133 files with
592 tests (four files/four manual tests skipped), plus typecheck, lint, formatting, builds, and the
focused checkout/webhook suites. Lago `pnpm check` passed 72 files and 412 tests with formatting,
lint, typecheck, generated inventories/bindings, Access tests, and all dry bundles.

## Customer-facing copy closeout

Lago staging API version `9dc31222-5f13-460f-a93f-e8cd534d09ae` removed the customer-visible
`Product canary` routing explanation and added a defensive checkout-copy filter for internal fixture
terms. A fresh Pornhub Downloader staging checkout displayed `Buy SERP App Plan`, `$9.00`,
`One-time payment`, the staging-only `EPD TEST MODE` warning, and three hosted EPD card-field
iframes. It contained none of `synthetic`, `Product canary`, `routed through Lago`, `Internal
payment testing`, or `Sandbox outcome`.

The separate internal EPD QA tool intentionally retains its synthetic-outcome wording. No payment
details were entered and no transaction was submitted during this verification. Production was not
deployed or changed.
