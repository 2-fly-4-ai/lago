# Easy Pay Direct hosted Gateway test canary — 2026-08-25

## Outcome

The Pornhub Video Downloader staging canary now opens an Easy Pay Direct Collect.js card form instead of the internal EPD Commerce synthetic-outcome selector.

- Product checkout: `/easy_pay_direct/payment_form`
- Internal synthetic QA tool: `/easy_pay_direct/sandbox_tool`
- Worker: `serp-dev-lago-native`
- Deployed version: `3070483d-c741-4bbb-a831-70ba0b8d8a55`
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

## Safety invariants

- Gateway submission always sends `test_mode=enabled` in `gateway_test` mode.
- `gateway_test` refuses to initialize unless `EASY_PAY_DIRECT_LIVEMODE_ALLOWED` is exactly `0`.
- Raw card number, expiry, and CVV never pass through the Worker; Collect.js supplies a one-use payment token.
- The synthetic Commerce selector cannot render on the product checkout route.
- The synthetic QA route is unavailable in production mode.
- Google Pay is not exposed against the current EPD Gateway demo processor because EPD limits it to eligible processors.
- Apple Pay is not exposed for this recurring checkout because EPD documents its tokens as one-time and not suitable for Customer Vault storage.
- Amazon Pay remains a Stripe-only method for this checkout.
- Stripe production behavior, production Lago data/routes, `store-new`, and `serp-auth` were not changed by this patch.

## Primary references

- [EPD Gateway testing and dedicated demo account](https://secure.easypaydirectgateway.com/merchants/resources/integration/integration_portal.php#testing)
- [EPD Gateway Collect.js](https://secure.easypaydirectgateway.com/merchants/resources/integration/integration_portal.php#collect_js)
