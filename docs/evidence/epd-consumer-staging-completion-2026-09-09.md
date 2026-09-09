# EPD consumer-chain isolated staging completion — 2026-09-09

Status: **passed for a narrowly scoped production canary; production remains unchanged**.

This receipt supersedes the incomplete consumer-chain conclusion in
`epd-consumer-staging-2026-09-09.md`. It records the subsequent Store-origin purchase, payment,
fulfillment, entitlement and notification proof. It does not authorize or describe a production
deployment.

## Frozen source and deployed isolation

- Lago source: `26bc04910572943285057bb9a7277e0a617cd192`, branch
  `codex/epd-vault-binding-repair`.
- Isolated Lago Worker: `serp-dev-lago-epd-serptest`, version
  `a200be88-c414-4933-89ec-9193e6175adf`, dedicated D1
  `a88dfe97-3ea1-4b35-baf8-3690e1c4633f`.
- Store source: `dcac7c12af07ed7762efc02831bff77bfafdbe6b`, branch
  `codex/epd-durable-fulfillment`.
- Isolated Store Worker: `serp-dev-safe-store-serptest`, version
  `8515c03e-925c-46f6-b036-8a9942eead68`, dedicated D1
  `c0243249-7b72-417f-ab8d-71671da20798`.
- Auth source receipt: `1dcebae62f14d1bb60222f5bedb88437e03019d3`, branch
  `codex/epd-source-entitlements`; executable staging source remains the previously recorded
  deployed source-aware Auth build.
- Health and the completed Store success route returned HTTP 200 after the final deployments.
- Shared staging and all production Workers, databases, secrets and routing remained unchanged.

## Real EPD sandbox customer journey

The user explicitly authorized one fictional test checkout through the dedicated EPD test gateway.
No real money moved.

- Store created the immutable version-1 checkout reservation before payment.
- Monthly generic plan: 900 cents.
- Regional discount: -450 cents.
- Fictional staging tax: 28 cents.
- Final EPD sandbox charge: 478 cents, response code 100, provider transaction `12532946385`.
- Lago recorded one succeeded payment attempt and one succeeded payment for the invoice.
- Store recorded one paid order and one product binding for Sprout Video Downloader.
- Auth recorded one active, test-mode source for the matching Lago subscription and exactly the
  intended `sprout-downloader` entitlement.
- The success page rendered the ready product and linked account state.

## Exactly-once and interrupted-delivery proof

- Browser success replay did not create a second order, binding, payment, Auth source, verification
  email or Slack delivery.
- The first outbound webhook delivery timed out because Lago's ten-second transport timeout was
  shorter than Store's bounded fulfillment work. Lago now allows 30 seconds, with regression
  coverage.
- The isolated Slack profile initially selected the production-sales variable while only the test
  destination was installed. The isolated deployment profile now explicitly selects the test
  destination, with a guard test.
- The exact existing event was redriven without creating a provider payment request. Lago received
  HTTP 200; Store recorded one `sent` delivery; Slack accepted the message with HTTP 200.
- Final cardinalities after replay/redrive remained one provider transaction, one Lago payment
  attempt, one Store order, one binding, one Auth source and one Slack delivery.

## Regression evidence and boundaries

- Lago full gate: 100 test files, 1,128/1,128 tests; format, lint, typecheck, Access, tax and all
  development/production dry-run builds passed. Dry-run builds did not deploy production.
- Store full gate: 1,054 tests passed with two opt-in Stripe live checks skipped; typecheck,
  23 isolated-profile guards, 9 actual local Store-to-Auth workerd contracts, fresh Next/OpenNext
  build, cache upload and isolated deployment passed.
- Local and mocked suites cover initial purchases, monthly renewals, one-time non-renewal,
  discounts, tax, declines, retries, duplicate submission, out-of-order webhooks, interrupted
  delivery, cancellation, refunds, entitlement transitions and Slack idempotency.
- Separate real EPD sandbox receipts already prove monthly and one-time initial payments, a decline,
  a stored-profile renewal, partial/full refunds and Gateway Query readback. Those financial tests
  are provider-backed but use fictional data and pending-settlement sandbox behavior.
- This final Store-origin proof did not run another renewal, refund or cancellation against its new
  subscription. Those paths retain the provider-backed and local regression evidence above; they
  are not relabeled as a second end-to-end Store-origin run.

## Quiescence and production decision

- Isolated automatic collection and refund processing remain disabled.
- No product collection policy is active. The prior supervised renewal scope is disabled, and the
  new Store-origin subscription has no automatic scope. One-time purchases cannot enter recurring
  dispatch because both billing-period processing and the EPD dispatcher require a recurring plan
  interval.
- The isolated Workers remain available for inspection, but cannot perform unattended renewal or
  refund mutations.
- A second production-wide rollout is not justified. A **single-product Sprout canary is
  justified** only after explicit production approval. The rollout must deploy the reviewed code,
  route only Sprout to EPD, verify one live initial purchase, and then separately enable renewal
  scope only for that verified subscription. Expansion to other products remains a later decision.

## Still unverified by design

- A live-money production EPD purchase and settlement.
- A natural-calendar production renewal of a canary subscription.
- Production cancellation/refund and customer entitlement transitions.
- Production Slack receipt for the EPD canary.

These items require the explicitly approved production canary and cannot be truthfully proven in
isolated sandbox staging.
