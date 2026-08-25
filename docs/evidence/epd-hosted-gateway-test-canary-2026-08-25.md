# Easy Pay Direct hosted Gateway test canary — 2026-08-25

## Outcome

The Pornhub Video Downloader staging canary now opens an Easy Pay Direct Collect.js card form instead of the internal EPD Commerce synthetic-outcome selector.

- Product checkout: `/easy_pay_direct/payment_form`
- Internal synthetic QA tool: `/easy_pay_direct/sandbox_tool`
- Worker: `serp-dev-lago-native`
- Deployed version: `2f53e9cf-db6f-4c8f-8244-4aa2265bfe76`
- `EASY_PAY_DIRECT_NETWORK_MODE`: `gateway_test`
- `EASY_PAY_DIRECT_LIVEMODE_ALLOWED`: `0`
- `PAYMENT_MUTATIONS_ENABLED`: `1`

The Gateway security and Collect.js tokenization values are encrypted Worker secrets. Staging uses Easy Pay Direct's documented dedicated Gateway demo account and example Collect.js tokenization key. No live merchant key, live card, production customer, production product, or production route was used.

## Verification

- Product form returned HTTP 200.
- Product form loaded `Collect.js` and rendered the `ccnumber`, `ccexp`, and `cvv` hosted-field containers.
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
- Format, lint, generated Worker types, TypeScript, dry-run bundle, and the full 405-test suite passed.

## Safety invariants

- Gateway submission always sends `test_mode=enabled` in `gateway_test` mode.
- `gateway_test` refuses to initialize unless `EASY_PAY_DIRECT_LIVEMODE_ALLOWED` is exactly `0`.
- Raw card number, expiry, and CVV never pass through the Worker; Collect.js supplies a one-use payment token.
- The synthetic Commerce selector cannot render on the product checkout route.
- The synthetic QA route is unavailable in production mode.
- Stripe production behavior, production Lago data/routes, `store-new`, and `serp-auth` were not changed by this patch.

## Primary references

- [EPD Gateway testing and dedicated demo account](https://secure.easypaydirectgateway.com/merchants/resources/integration/integration_portal.php#testing)
- [EPD Gateway Collect.js](https://secure.easypaydirectgateway.com/merchants/resources/integration/integration_portal.php#collect_js)
