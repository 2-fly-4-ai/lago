# Easy Pay Direct operations

Use this page as the operator starting point for the SERP Easy Pay Direct (EPD) integration. It
records public destinations and configuration names only. Never add merchant credentials, card
data, webhook payloads, customer records, or signed checkout links to this repository.

## Operator destinations

- SERP Lago staging dashboard: <https://serp-dev-lago-operator.serpcompany.workers.dev/>
- SERP Lago production dashboard: <https://serp-prod-lago-operator.serpcompany.workers.dev/>
- EPD Gateway merchant login: <https://secure.easypaydirectgateway.com/merchants/login.php>
- Production webhook destination:
  <https://serp-prod-lago-native.serpcompany.workers.dev/webhooks/easy_pay_direct/org-serp-billing>
- EPD Gateway testing reference:
  <https://secure.easypaydirectgateway.com/merchants/resources/integration/integration_portal.php#testing>
- EPD Commerce API base (reference only): <https://api.epd.com/v1>
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
- `EASY_PAY_DIRECT_AUTOMATIC_COLLECTION_ENABLED`
- `EASY_PAY_DIRECT_COMMERCE_API_KEY`
- `EASY_PAY_DIRECT_SECURITY_KEY`
- `EASY_PAY_DIRECT_TOKENIZATION_KEY`
- `EASY_PAY_DIRECT_CHECKOUT_SIGNING_SECRET`
- `EASY_PAY_DIRECT_WEBHOOK_SIGNING_KEY`
- `EASY_PAY_DIRECT_WEBHOOK_SIGNING_KEY_PREVIOUS` during a bounded rotation
- `EASY_PAY_DIRECT_SUCCESS_REDIRECT_URL`
- `EASY_PAY_DIRECT_TAX_MODE`
- `EASY_PAY_DIRECT_TAX_PROVIDER`
- `EASY_PAY_DIRECT_TAX_CODE`
- `EASY_PAY_DIRECT_ONE_TIME_TAX_CODE`
- `EASY_PAY_DIRECT_TAX_MAX_DATA_AGE_DAYS` when the local D1 provider is selected
- `STRIPE_RESTRICTED_API_KEY` for staging Stripe Tax calculations and transaction commits

The Store uses `LAGO_CHECKOUT_ENABLED`, `LAGO_EASY_PAY_DIRECT_PROVIDER_CODE`, and
`LAGO_EASY_PAY_DIRECT_CHECKOUT_MODE`. Secret values belong only in the approved secret manager and
Cloudflare Worker secret storage.

The tax path resolves its product code from the Lago plan interval. Weekly, monthly, quarterly, and
yearly plans use `EASY_PAY_DIRECT_TAX_CODE` (`txcd_10103100`, SaaS electronic download for personal
use). A `one_time` plan uses `EASY_PAY_DIRECT_ONE_TIME_TAX_CODE` (`txcd_10202000`, downloadable
software for personal use). A missing or unsupported interval fails closed; the checkout does not
guess a classification from customer-facing copy or the routed product slug.

## Current staging posture

- `EASY_PAY_DIRECT_NETWORK_MODE=gateway_test`
- `EASY_PAY_DIRECT_LIVEMODE_ALLOWED=0`
- `EASY_PAY_DIRECT_TAX_MODE=enforced`
- `EASY_PAY_DIRECT_TAX_PROVIDER=local_d1`
- Hosted card fields use EPD Collect.js; card number, expiry, and CVV do not pass through the Worker.
- Billing destination is collected before payment. Lago calculates from the reviewed, versioned D1
  rule set, atomically replaces the invoice/payment-request total, and binds the payment to the
  replacement signed checkout and address hash. No Stripe request is made.
- The adult standard-plan staging cohort routes to Lago/EPD. Safe products and adult Plus/Premium
  controls remain on direct Stripe.
- The synthetic outcome selector remains available only at `/easy_pay_direct/sandbox_tool`; it is
  not the customer checkout.
- `EASY_PAY_DIRECT_AUTOMATIC_COLLECTION_ENABLED=0` remains the deployment default. Enable it only
  after the renewal candidate query has been reviewed for the intended environment.

## Automatic subscription collection

The first successful recurring checkout stores only provider-safe references: the EPD customer
vault ID and the original processor transaction ID. Lago then binds that provider profile to the
recurring subscription. It never stores or reuses a card number, CVV, Collect.js token, or signed
checkout link.

Historical profiles are not upgraded by inference. Checkouts created before the explicit
credential-on-file fields and original-transaction capture must complete one fresh
customer-initiated checkout through the current implementation before the subscription is eligible
for automatic collection. Obvious fixture vault references are quarantined by migration and
rejected again at runtime.

When the independent automatic-collection gate is enabled, a finalized renewal invoice creates one
deterministic payment request and one deterministic execution. Before charging, Lago recalculates
tax using the customer's last committed billing destination and the current active D1 rule set.
Missing, stale, ambiguous, or unregistered tax coverage fails closed without contacting EPD.

The EPD Gateway request uses the Customer Vault and credential-on-file fields required for a
merchant-initiated recurring charge: `billing_method=recurring`, `initiated_by=merchant`,
`stored_credential_indicator=used`, and `initial_transaction_id` from the customer-initiated first
charge. The payment-request ID is the stable gateway order reference.

An approval settles the Lago payment request and invoice. A definitive decline records failure and
leaves the invoice available to the existing dunning schedule. A timeout or ambiguous provider
response is never blindly submitted again: the execution becomes `unknown`, and reconciliation
queries the EPD Gateway by the stable order reference until it finds a definitive result. Dunning
requests use the same saved profile and execution safeguards.

To stop new renewals immediately, set `EASY_PAY_DIRECT_AUTOMATIC_COLLECTION_ENABLED=0`. Preserve
all pending and unknown executions for provider-read reconciliation; do not delete or recreate
them.

## Production credential checklist

Keep the production Worker disabled while provisioning. Before promotion, verify names only:

- `EASY_PAY_DIRECT_COMMERCE_API_KEY`
- `EASY_PAY_DIRECT_SECURITY_KEY`
- `EASY_PAY_DIRECT_TOKENIZATION_KEY`
- `EASY_PAY_DIRECT_WEBHOOK_SIGNING_KEY`
- `EASY_PAY_DIRECT_CHECKOUT_SIGNING_SECRET`

Never paste their values into tickets, docs, terminal output, screenshots, or browser snapshots.

Keep `EASY_PAY_DIRECT_TAX_MODE=disabled` and
`EASY_PAY_DIRECT_AUTOMATIC_COLLECTION_ENABLED=0` in production until the product tax
classification, actual production registrations, refund/reversal handling, and the automatic
renewal acceptance check have each been approved.

The alternative `EASY_PAY_DIRECT_TAX_PROVIDER=local_d1` path uses versioned D1 rule sets and
explicit organization registration scopes. It performs no Stripe request and commits its quote
locally after EPD success. Missing scopes/rules, stale data, and conflicting rules fail closed. This
provider is enabled in staging and covered by tests. Production remains disabled until the actual
registration scopes and reviewed production rule set are approved.

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
