# Easy Pay Direct hosted Gateway test canary — 2026-08-25

## Outcome

The Pornhub Video Downloader staging canary now opens an Easy Pay Direct Collect.js card form instead of the internal EPD Commerce synthetic-outcome selector.

- Product checkout: `/easy_pay_direct/payment_form`
- Internal synthetic QA tool: `/easy_pay_direct/sandbox_tool`
- Worker: `serp-dev-lago-native`
- Lago Worker version: `05530d05-b2cb-4afa-b062-2280799016b0`
- Safe Store Worker version: `2e2a548f-51e1-4150-99fd-80327e5d39b7`
- `EASY_PAY_DIRECT_NETWORK_MODE`: `gateway_test`
- `EASY_PAY_DIRECT_LIVEMODE_ALLOWED`: `0`
- `PAYMENT_MUTATIONS_ENABLED`: `1`

The Gateway security and Collect.js tokenization values are encrypted Worker secrets. Staging uses Easy Pay Direct's documented dedicated Gateway demo account and example Collect.js tokenization key. No live merchant key, live card, production customer, production product, or production route was used.

## Verification

- Product form returned HTTP 200.
- Product form loaded `Collect.js` and rendered the `ccnumber`, `ccexp`, and `cvv` hosted-field containers.
- Product form renders a Stripe-comparable two-column checkout with the official SERP mark, locked order summary, customer email, plan interval, subtotal, credits/discounts, tax, and authoritative total due.
- The terms checkbox is enforced by the Worker and acceptance time/version are stored as immutable execution identity fields by migration `0094_easy_pay_direct_checkout_consent.sql`.
- Collect.js received explicit field selectors, accessible titles, placeholders, embedded-field CSS, validation styles, a timeout, and a fields-ready callback.
- The checkout applies a responsive labeled layout and removes native iframe borders instead of exposing browser-default hosted inputs.
- Product form contained the explicit live-disabled notice.
- Product form did not contain `card_visa` or the synthetic outcome selector.
- Internal sandbox tool returned HTTP 200, contained the synthetic outcomes, and did not load Collect.js.
- A provider-side test transaction using EPD's documented test payment token returned HTTP 200 and `succeeded`.
- The corresponding D1 execution had provider response code `100`.
- The Lago payment request and linked invoice both converged to `succeeded` with `ready_for_payment_processing = 0`.
- Replaying the same checkout is covered as idempotent and does not issue a second provider request.
- Remote `PRAGMA foreign_key_check` returned no rows.
- Remote D1 migration check reported no pending migrations.
- Format, lint, generated Worker types, TypeScript, dry-run bundle, and the full 406-test suite passed.
- Desktop and 390px browser captures passed design QA with no horizontal overflow; hosted fields reported ready and the final browser console contained no errors.
- Remote D1 migration check reported no pending migrations after `0094`; remote `PRAGMA foreign_key_check` returned no rows.

## Store-originated purchase verification — 2026-08-26

An actual staging checkout started at the Pornhub Video Downloader product route, passed through the safe Store, rendered the EPD Collect.js hosted fields, and completed with EPD's Gateway test account.

- The Store-created anonymous Lago customer initially had no email. The hosted checkout now collects the buyer email and binds only its SHA-256 hash into the immutable payment execution identity through migration `0095_easy_pay_direct_checkout_email.sql`.
- Existing signed customer emails remain locked; a conflicting submitted email is rejected.
- The purchase used a synthetic `example.invalid` identity, EPD's documented test Visa, a future test expiry, and test CVV. No production customer or live card was used.
- EPD returned approved sandbox transaction `12472222192`; Lago returned HTTP 200 with `status = succeeded`, `replayed = false`, and the browser displayed `Payment received`.
- D1 recorded one execution and one invoice link. The checkout intent, payment request, execution, and invoice all converged to `succeeded`; `ready_for_payment_processing = 0`.
- D1 recorded the email binding and terms acceptance/version without storing card data in the Worker.
- Remote `PRAGMA foreign_key_check` returned no rows and the remote migration check reported no pending migrations after `0095`.
- Focused lint, TypeScript, Worker dry build, deployed health, and the Store-to-provider browser path passed against Worker version `3070483d-c741-4bbb-a831-70ba0b8d8a55`.
- The current machine's Cloudflare Vitest pool timed out while starting `cloudflare-pool` before loading any test file. This was a local runner-start failure, not a test assertion; the deployed staging path and D1 invariants above supplied the action-time verification for this patch.

## Store purchase-model verification — 2026-08-26

The staging Store now derives the Lago plan cadence from the Store's existing purchase model instead
of treating every generic plan checkout as a subscription. The Pornhub Video Downloader canary is
configured as `one_time`; other products retain their existing routing.

- A fresh browser checkout started at the staging Pornhub Video Downloader route, passed through the
  safe Store, and rendered the EPD Collect.js hosted fields as `$9.00` with `One-time payment`.
- Exactly one EPD Gateway test submission completed successfully as sandbox transaction
  `12474102559`; the browser displayed `Payment received`.
- D1 recorded plan `serp-1-app-plan-one-time` with interval `one_time`, a 900-cent invoice, one
  provider execution, one payment, one invoice link, and one payment allocation. The execution,
  payment request, invoice, and subscription all converged to `succeeded`/`active` as applicable.
- The previously completed recurring sandbox transaction `12472222192` remains attached to
  `serp-1-app-plan-monthly` with interval `monthly`, a 900-cent invoice, one provider execution,
  and one payment. This verifies that adding one-time routing did not collapse the recurring path.
- Active staging variants now include `serp-1-app-plan-monthly` (900 cents),
  `serp-1-app-plan-yearly` (7,900 cents), and `serp-1-app-plan-one-time` (900 cents).
- The non-canary EPorner Video Downloader staging checkout still redirected to Stripe Checkout; no
  payment was submitted on that control path.
- Migration `0096_store_staging_purchase_model_plans.sql` is synthetic-organization scoped and was
  applied only to the staging D1 database. The remote migration inventory reports no pending
  migrations, and `PRAGMA foreign_key_check` returns no rows.
- The changed billing-period suite passes 8/8, Store routing suites pass 34/34, and formatting,
  lint, Access tests, inventory, generated types, TypeScript, and every development/production dry
  bundle pass. The full isolated Cloudflare suite could not complete on this mounted worktree: four
  workers caused unrelated 10-second I/O timeouts, while one isolated worker restarted `workerd`
  per file and did not finish in a practical window. A `--no-isolate` diagnostic was stopped after
  it changed fixture semantics and produced an unrelated coupon failure; it is not treated as a
  product-test result.

## Safety invariants

- Gateway submission always sends `test_mode=enabled` in `gateway_test` mode.
- `gateway_test` refuses to initialize unless `EASY_PAY_DIRECT_LIVEMODE_ALLOWED` is exactly `0`.
- Raw card number, expiry, and CVV never pass through the Worker; Collect.js supplies a one-use payment token.
- The synthetic Commerce selector cannot render on the product checkout route.
- The synthetic QA route is unavailable in production mode.
- Google Pay is not exposed against the current EPD Gateway demo processor because EPD limits it to eligible processors.
- Apple Pay is not exposed for recurring EPD checkouts because EPD documents its tokens as one-time and not suitable for Customer Vault storage. A separate one-time wallet can be evaluated later without changing this canary's card-only contract.
- Amazon Pay remains a Stripe-only method for this checkout.
- Store staging code and the isolated development Workers were changed for this canary. Existing production Store/Stripe routing, production Lago data/routes, and `serp-auth` were not switched or deployed by this patch.

## Primary references

- [EPD Gateway testing and dedicated demo account](https://secure.easypaydirectgateway.com/merchants/resources/integration/integration_portal.php#testing)
- [EPD Gateway Collect.js](https://secure.easypaydirectgateway.com/merchants/resources/integration/integration_portal.php#collect_js)
