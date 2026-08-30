# EPD checkout tax staging upgrade

Date: 2026-08-30

## Scope

- Lago branch: `codex/production-epd-canary`
- Staging only. Production tax mode remains explicitly disabled.
- No production D1 migration, production Worker deployment, production route change, live card,
  live Stripe Tax request, or live EPD request was performed.
- `store-new` and `serp-auth` were not changed for this upgrade.

## Implemented behavior

- The EPD product checkout collects billing country, state/province, and postal code before payment.
- The Lago Worker creates a Stripe Tax test-mode calculation with an exclusive-tax line item and
  configured generic software tax code.
- The quoted subtotal, tax, total, destination, Stripe calculation reference, and expiry are stored
  in D1.
- Enforced staging mode atomically updates the finalized invoice, invoice/payment-request link,
  payment request, and immutable checkout intent before the payment button can be used.
- The original signed checkout is invalidated and replaced by a signed checkout bound to the exact
  tax-inclusive amount and address hash.
- EPD receives the exact repriced total. A missing, expired, mismatched, or replayed quote fails
  closed before a provider transaction is attempted.
- After a successful EPD transaction, Lago commits the Stripe Tax test calculation as an off-Stripe
  transaction. A temporary Stripe commit failure does not reverse a successful EPD payment; it is
  persisted for reconciliation retry.
- The existing internal EPD synthetic QA screen remains separate from the customer checkout.

## Configuration boundary

Staging:

- `EASY_PAY_DIRECT_TAX_MODE=enforced`
- `EASY_PAY_DIRECT_TAX_PROVIDER=stripe_test`
- `EASY_PAY_DIRECT_TAX_CODE=txcd_10103100`
- EPD network mode remains `gateway_test`; EPD live mode remains disallowed.
- The Stripe credential must be a test key. Live Stripe keys are rejected before any network call.

Production:

- `EASY_PAY_DIRECT_TAX_MODE=disabled`
- No production migration or Worker deployment was performed.

The current `txcd_10103100` classification is provisional. Confirm the final generic software tax
classification before any production activation.

## Deployed staging state

- Worker: `serp-dev-lago-native`
- Version: `2e20ec78-a038-404d-8929-676a5b161051`
- Migration `0100_easy_pay_direct_checkout_tax_quotes.sql` applied to staging only.
- Staging reports no pending migrations.
- Staging `PRAGMA foreign_key_check` returned no rows.
- `/health` and `/ready` returned healthy responses.

## Verification

- Focused tax tests: 2 passed.
- Combined EPD tax, checkout, and provider tests: 25 passed before deployment.
- TypeScript, lint, formatting, generated binding types, and dry-run Worker build passed.
- A fresh Pornhub Downloader staging route reached the deployed EPD test checkout and displayed the
  billing-location fields, tax line, `Update total`, and `EPD TEST MODE`.
- The first deployed US/California quote failed closed before payment because the existing Stripe
  test restricted key lacked Stripe Tax permission. Stripe returned HTTP 403 with
  `more_permissions_required`. No EPD transaction was attempted.
- Full suite: 418 of 421 tests passed. The three existing failures are outside this tax change:
  two subscription-termination cases collide on an invoice-number uniqueness constraint, and one
  plan-change case expects one credit application but receives zero.

## Remaining acceptance work

1. Grant the existing staging Stripe restricted key write access to Tax calculations and
   transactions in test mode only.
2. Re-run a fresh deployed destination-tax quote and verify the D1 invoice/payment-request amount
   changes exactly once.
3. Submit one EPD gateway-test payment, verify the provider amount matches the displayed
   tax-inclusive total, verify the Stripe Tax test transaction commit, and replay the callback.
4. Keep production disabled until recurring renewal calculations, refund/reversal handling, the
   final product tax classification, and production rollout controls are separately accepted.
