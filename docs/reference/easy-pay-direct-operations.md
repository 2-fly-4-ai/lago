# Easy Pay Direct operations

Use this page as the operator starting point for the SERP Easy Pay Direct (EPD) integration. It
records public destinations and configuration names only. Never add merchant credentials, card
data, webhook payloads, customer records, or signed checkout links to this repository.

## Operator destinations

- SERP Lago staging dashboard: <https://serp-dev-lago-operator.serpcompany.workers.dev/>
- EPD Gateway merchant login: <https://secure.easypaydirectgateway.com/merchants/login.php>
- EPD Gateway testing reference:
  <https://secure.easypaydirectgateway.com/merchants/resources/integration/integration_portal.php#testing>
- EPD Collect.js reference:
  <https://secure.easypaydirectgateway.com/merchants/resources/integration/integration_portal.php#collect_js>

Cloudflare Access protects the SERP dashboard. The EPD portal is the provider authority for its
transactions and merchant-side configuration; the Lago dashboard is the SERP authority for Lago
customers, invoices, payment requests, executions, allocations, reconciliation state, and provider
connection status.

## Ownership map

| Concern | Authority |
| --- | --- |
| Product-to-payment-pipeline selection | `store-new/apps/serp-store/data/prices/product-billing-routes.json` |
| New-checkout and provider rollout gates | Store Worker configuration |
| Lago billing, payment execution, and reconciliation state | Cloudflare-native Lago D1 and operator dashboard |
| EPD transaction and merchant configuration | EPD Gateway merchant portal |
| Provider credentials and signing keys | Cloudflare Worker secrets; values must never appear in Git |
| Entitlements | `serp-auth`; Store grants only after verified payment completion |

Marketing sites do not own payment-provider logic. They create a signed intended-product handoff;
the Store resolves the route and either retains direct Stripe or starts Lago with EPD/Stripe.

## Configuration names

Lago uses these EPD bindings:

- `EASY_PAY_DIRECT_NETWORK_MODE`
- `EASY_PAY_DIRECT_LIVEMODE_ALLOWED`
- `EASY_PAY_DIRECT_ACCOUNT_CODE`
- `EASY_PAY_DIRECT_ORGANIZATION_ID`
- `EASY_PAY_DIRECT_COMMERCE_API_KEY`
- `EASY_PAY_DIRECT_SECURITY_KEY`
- `EASY_PAY_DIRECT_TOKENIZATION_KEY`
- `EASY_PAY_DIRECT_CHECKOUT_SIGNING_SECRET`
- `EASY_PAY_DIRECT_WEBHOOK_SIGNING_KEY`
- `EASY_PAY_DIRECT_WEBHOOK_SIGNING_KEY_PREVIOUS` during a bounded rotation
- `EASY_PAY_DIRECT_SUCCESS_REDIRECT_URL`

The Store uses `LAGO_CHECKOUT_ENABLED`, `LAGO_EASY_PAY_DIRECT_PROVIDER_CODE`, and
`LAGO_EASY_PAY_DIRECT_CHECKOUT_MODE`. Secret values belong only in the approved secret manager and
Cloudflare Worker secret storage.

## Current staging posture

- `EASY_PAY_DIRECT_NETWORK_MODE=gateway_test`
- `EASY_PAY_DIRECT_LIVEMODE_ALLOWED=0`
- Hosted card fields use EPD Collect.js; card number, expiry, and CVV do not pass through the Worker.
- The adult standard-plan staging cohort routes to Lago/EPD. Safe products and adult Plus/Premium
  controls remain on direct Stripe.
- The synthetic outcome selector remains available only at `/easy_pay_direct/sandbox_tool`; it is
  not the customer checkout.

The full staged acceptance record is
[`adult-standard-plan-epd-staging-canary-2026-08-26.md`](../evidence/adult-standard-plan-epd-staging-canary-2026-08-26.md).

## Production rollout order

1. Push and review the merged Store and Lago `main` revisions.
2. Complete the approved read-only production shadow comparison and reconcile counts, amounts,
   identities, and billing cadence before any write authority moves.
3. Provision or verify production Cloudflare resources and EPD live credentials while
   `LAGO_CHECKOUT_ENABLED=0`, `LAGO_EASY_PAY_DIRECT_CHECKOUT_MODE=off`,
   `EASY_PAY_DIRECT_NETWORK_MODE=disabled`, and `EASY_PAY_DIRECT_LIVEMODE_ALLOWED=0`.
4. Deploy Store compatibility code with every production product still resolving to
   `direct-stripe`.
5. Assign one reviewed product to `lago-epd`, move only the EPD Store mode to `explicit`, and enable
   the required Lago live gates at the approved action time.
6. Complete one real low-risk canary purchase, then reconcile Store session/order, Lago
   customer/subscription/invoice/payment, EPD transaction, fulfillment, and SerpAuth entitlement.
7. Widen in bounded cohorts only after the prior cohort has no unexplained mismatch or duplicate.
8. Retain legacy Lago/containers through two production billing cycles and the rollback window.

Do not begin with the entire adult catalog in production. The 986-product assignment is staging
coverage; production should start with one product and widen deliberately.

## Immediate rollback

Set `LAGO_CHECKOUT_ENABLED=0` to stop new Lago attempts. Preserve and reconcile any attempt already
created; never start a second provider checkout for an unresolved attempt. If necessary, restore the
recorded prior Store Worker version. Do not delete Lago, EPD, D1, R2, webhook, or entitlement
evidence during incident handling.
