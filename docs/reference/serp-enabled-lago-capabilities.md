# Evidence-Only SERP Lago Capability Map

Evidence date: 2026-08-14

This record answers a narrow question: which Lago capabilities are explicitly selected by current
SERP source code or checked-in configuration? It does not inspect or infer secret values, customer
data, deployed environment variables, production requests, or historical runtime artifacts.

“Implemented by the Cloudflare replacement” and “known to be enabled by a SERP consumer” are
different claims. The full implementation/disposition map lives in
`cloudflare-rewrite-feature-inventory.json`.

## Explicit consumer evidence

| Capability                 | Evidence                                                                                                                                                                                                                                        | Contract to preserve                                                                                                                                                    | Confidence                     |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------ |
| Store feature selection    | In `store-new/scripts/cloudflare/stores.config.json`, only the `safe` tenant (`@apps/serp-store`, `apps/serp-store`) has `features.lago: true`; the other checked-in store entries use `false`.                                                 | Lago integration belongs to the safe-store checkout surface, not every storefront.                                                                                      | explicit config                |
| Checkout backend selection | `payment-routing.ts` recognizes `stripe` and `lago_authorize_net`. Mode is read from `LAGO_AUTHORIZE_NET_CHECKOUT_MODE`, then legacy fallback names; unknown or absent values normalize to `off`. Explicit Stripe aliases always select Stripe. | Preserve `off`, `explicit`, and `on` behavior and the existing provider query aliases. Do not make Lago the default merely because a Worker exists.                     | explicit code                  |
| Default eligibility        | The safe-store checkout route passes `eligibleForDefaultLago: adultPlanOffer`; mode `on` selects Lago only for that eligible class when no provider override is present.                                                                        | Keep eligibility in `store-new`; the billing service must not infer storefront merchandising rules.                                                                     | explicit code                  |
| Lago API configuration     | The consumer requires `LAGO_API_URL` and `LAGO_API_KEY`; provider code defaults to `paymentcloud-authorize-net`.                                                                                                                                | Bearer authentication, URL normalization, and provider code must remain compatible. Actual deployed values are unknown.                                                 | explicit code; runtime unknown |
| Customer upsert            | Checkout calls `POST /api/v1/customers` with external ID, optional email/name, a small metadata set, and `billing_configuration` selecting `authorize_net`, provider code, and both synchronization flags.                                      | Accept the frozen synthetic fixture and preserve the response's `customer.external_id`. Provider synchronization remains safety-gated.                                  | executable fixture             |
| Subscription creation      | Checkout calls `POST /api/v1/subscriptions` with external customer ID, unique external subscription ID, a plan code ending in `-monthly` or `-yearly`, and display name.                                                                        | Create one logical subscription and expose its external ID; reject divergent replay.                                                                                    | executable fixture             |
| Invoice discovery          | Checkout polls `GET /api/v1/invoices?external_customer_id=...&per_page=10` up to five times, choosing the newest non-voided, unpaid invoice with positive total created near the checkout attempt.                                              | Return tenant-scoped invoices with Lago status, payment status, total due, ID, and creation time. Invoice creation may be asynchronous from the consumer's perspective. | executable fixture             |
| Hosted payment URL         | Checkout calls `POST /api/v1/invoices/:id/payment_url` and redirects to `invoice_payment_details.payment_url`.                                                                                                                                  | Keep invoice ID, customer identity, and URL response shape; never expose provider tokens. Provider mutations remain disabled until separately approved.                 | executable fixture             |
| Quantity restriction       | When Lago routing is selected, the checkout route returns `400` unless quantity equals one.                                                                                                                                                     | The billing service is not required to emulate Stripe cart quantity for this consumer contract.                                                                         | explicit code                  |
| Fallback behavior          | If mode is off, Stripe is requested, the offer is ineligible for default Lago, or Lago checkout throws, the route proceeds through or redirects back toward the established Stripe path.                                                        | A Lago failure must not be treated as authorization to remove the Stripe fallback during migration.                                                                     | explicit code                  |

The non-secret fixtures that freeze the four service interactions are:

- `cloudflare/fixtures/store-new/customer-upsert.json`
- `cloudflare/fixtures/store-new/subscription-create.json`
- `cloudflare/fixtures/store-new/invoice-list-query.json`
- `cloudflare/fixtures/store-new/payment-url-request.json`

## Ownership and rollout

| Contract                                                                                          | Owner                                   | Consumer                  | Rewrite responsibility                                                                                         |
| ------------------------------------------------------------------------------------------------- | --------------------------------------- | ------------------------- | -------------------------------------------------------------------------------------------------------------- |
| Backend mode, provider query aliases, eligibility, plan-code construction, quantity, and fallback | `store-new`                             | safe-store checkout route | Remains unchanged until a separately reviewed consumer rollout.                                                |
| Authenticated four-route REST shape and billing ledger                                            | Lago Cloudflare Worker                  | `store-new`               | Preserve fixtures, tenant isolation, idempotency, and explicit unsupported errors.                             |
| Authorize.Net credentials and provider effects                                                    | approved Cloudflare secret/config owner | Worker provider adapter   | No value is read or synchronized; all provider reads/mutations stay disabled in the isolated stack.            |
| Extension entitlement and identity                                                                | `serp-auth`                             | extensions and storefront | No current source evidence makes it part of these four Lago calls; no change is planned in this rewrite phase. |

Rollout order remains: finish and verify the isolated Worker, import only approved synthetic or
staged data, exercise the four consumer fixtures against a non-production endpoint, explicitly
approve secrets and provider flags, canary the `store-new` mode, and retain the Stripe fallback
through rollback verification. A production cutover is not authorized by this document.

## Deliberate unknowns

The following remain unknown rather than being treated as unused:

- which Lago mode, URL, key, and provider code are present in any deployed environment;
- whether any production checkout request currently selects Lago by query parameter or default;
- which product plan codes exist in a live Lago database or provider account;
- production traffic, customer, invoice, payment, webhook, or entitlement state;
- whether legacy Lago APIs have non-SERP consumers outside the repositories inventoried here;
- the current production authority for billing records and the human-approved cutover date.

Resolving any of these requires a separately approved, read-only production evidence exercise that
does not print secrets or customer data.
