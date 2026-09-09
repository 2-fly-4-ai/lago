# Easy Pay Direct operations

Use this page as the operator starting point for the SERP Easy Pay Direct (EPD) integration. It
records public destinations and configuration names only. Never add merchant credentials, card
data, webhook payloads, customer records, or signed checkout links to this repository.

## Operator destinations

- SERP Lago staging dashboard: <https://serp-dev-lago-operator.serpcompany.workers.dev/>
- SERP Lago production dashboard: <https://serp-prod-lago-operator.serpcompany.workers.dev/>
- EPD Gateway merchant login: <https://secure.easypaydirectgateway.com/merchants/login.php>
- EPD Commerce dashboard: <https://commerce.epd.com/>
- EPD Commerce team roles: <https://commerce.epd.com/user-management>
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

### Do not conflate the two EPD dashboards or their credentials

- **Gateway** is the merchant portal on `secure.easypaydirectgateway.com`. It owns Gateway
  Customer Vault and processor transaction evidence. Collect.js, `transact.php` and `query.php`
  belong to this surface.
- **Commerce** is the separate dashboard on `commerce.epd.com`, backed by `api.epd.com/v1`.
  It is not part of the current direct-Gateway checkout or renewal path. Historical execution rows
  and test fixtures may still refer to Commerce; do not use those references to route a new charge.
- A **Commerce dashboard role** is not evidence of **Gateway portal permission** or of the
  permissions/validity of the **deployed API credentials**. A browser session expiring also does
  not prove a provider API key expired. Check each boundary independently.
- In Commerce User Management, inspect the teammate's **More actions** menu rather than
  assuming the displayed permission count is an editor. The inspected Workspace Admin role
  has 9/51 permissions; Owner has 51/51. These names/counts are observations, not proof that
  Owner is assignable to another teammate. If the Owner session exposes no role-change or
  full-access choice, obtain the exact menu/role-selector evidence before requesting a
  provider-side role change. Do not promise granular permission checkboxes or transfer
  ownership as a workaround. No role was changed during this local audit.
- Before requesting a role expansion, check the existing Gateway session and approved read-only
  API path. On 2026-09-07 the inspected Commerce Workspace Admin role excluded business-data reads,
  while the Gateway session separately redirected to merchant login. The execution shell had no
  provider key bindings; this says nothing about the Worker secret values and does not justify
  extracting, printing, rotating or replacing them.
- Reauthenticate through the existing Gateway login when needed; never paste credentials into
  chat or reset passwords just because a session expired. Do not use payment, vault-creation,
  Gateway sync or reconciliation mutations as an authentication probe.

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

- `EASY_PAY_DIRECT_CHECKOUT_BACKEND` (`gateway_direct` for new live checkouts)
- `EASY_PAY_DIRECT_NETWORK_MODE`
- `EASY_PAY_DIRECT_LIVEMODE_ALLOWED`
- `EASY_PAY_DIRECT_ACCOUNT_CODE`
- `EASY_PAY_DIRECT_ORGANIZATION_ID`
- `EASY_PAY_DIRECT_AUTOMATIC_COLLECTION_ENABLED`
- `EASY_PAY_DIRECT_AUTOMATIC_COLLECTION_SCOPE_MODE`
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
- `INDIRECT_TAX_ADDRESS_ENCRYPTION_SECRET` for address-resolved jurisdictions; use a dedicated
  random secret of at least 32 characters, never the checkout-signing secret
- `INDIRECT_TAX_ADDRESS_ENCRYPTION_KEY_ID` identifying the active address-encryption key
- `STRIPE_RESTRICTED_API_KEY` for staging Stripe Tax calculations and transaction commits

`EASY_PAY_DIRECT_COMMERCE_API_KEY` is retained only for historical Commerce execution reads and
tests. New direct-Gateway checkout does not require it. The test-only
`EASY_PAY_DIRECT_LEGACY_BRIDGE_ALLOWED` override must never be set in production.

The Store uses `LAGO_CHECKOUT_ENABLED`, `LAGO_EASY_PAY_DIRECT_PROVIDER_CODE`, and
`LAGO_EASY_PAY_DIRECT_CHECKOUT_MODE`. Secret values belong only in the approved secret manager and
Cloudflare Worker secret storage.

The current local patch resolves the tax product code from explicit, tenant-scoped
`plans.metadata_json.tax_code`. It does not infer delivery from the billing interval or product
slug. Missing or mixed classifications fail closed. Monthly downloaded software may use the same
classification as a one-time download. The old interval-based environment defaults are not a
substitute for the [reviewed generic-plan metadata](../evidence/generic-plan-tax-classification-2026-09-06.md).
That metadata must be backfilled before deploying this patch; it has not been applied remotely.

## Current staging posture

- `EASY_PAY_DIRECT_NETWORK_MODE=gateway_test`
- `EASY_PAY_DIRECT_LIVEMODE_ALLOWED=0`
- `EASY_PAY_DIRECT_TAX_MODE=enforced`
- `EASY_PAY_DIRECT_TAX_PROVIDER=local_d1`
- Hosted card fields use EPD Collect.js; card number, expiry, and CVV do not pass through the Worker.
- Billing destination is collected before payment. Lago calculates from the reviewed, versioned D1
  rule set, atomically replaces the invoice/payment-request total, and binds the payment to the
  replacement signed checkout and address hash. No Stripe request is made.
- Staging routes the 123Movies monthly canary and the existing Pornhub one-time canary to
  Lago/EPD. Products without an explicit route remain on direct Stripe.
- The synthetic outcome selector remains available only at `/easy_pay_direct/sandbox_tool`; it is
  not the customer checkout.
- Staging keeps `EASY_PAY_DIRECT_AUTOMATIC_COLLECTION_ENABLED=1` with scoped rollout after the
  reviewed recurring proof. Only subscriptions with an enabled scope row can create a new
  automatic execution. Production uses its independently approved product-scoped gate.
- `EASY_PAY_DIRECT_AUTOMATIC_COLLECTION_SCOPE_MODE=product_scoped` is the current production
  rollout posture. In subscription-scoped mode,
  only subscriptions with an enabled row in `easy_pay_direct_automatic_collection_scopes` may
  create a new automatic payment execution. Moving to `all` is a separate rollout decision.

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
tax using that subscription's committed checkout destination and software classification with the
current active D1 rule set. The current local patch explicitly rejects a quote belonging to another
subscription of the same customer; rollout status is tracked in the active tax plan.
Missing, stale, ambiguous, or unregistered tax coverage fails closed without contacting EPD.

The local Washington patch uses the Washington Department of Revenue's fixed HTTPS address-rate
endpoint. It sends street, city, ZIP and ZIP+4 (when present) to that public authority and sends no
email, product name, card data, Lago ID or EPD ID. If the authority standardizes the address, the
checkout fills the normalized address and requires the customer to review it and press **Update
total** again. The exact authority location code, jurisdiction, rate period and state/local rate
components are stored with the immutable quote. Street and city are stored only as AES-GCM
ciphertext under the dedicated key above so recurring invoices can resolve the then-current local
rate. A renewal refuses to proceed if the key ID, ciphertext, address hash, current authority
response or reviewed 6.5% Washington state-rate baseline does not match.

Rotate address encryption by retaining the prior secret until every recurring subscription whose
latest committed quote uses the prior key ID has either been re-encrypted through a reviewed
migration or completed a new customer checkout. Changing the key ID without that process makes
those renewals fail closed, by design.

The rollout scope is checked when Lago creates the automatic payment execution, including dunning
executions. Removing or disabling a scope stops new executions for that subscription; executions
already created remain preserved for idempotent completion or provider-read reconciliation.

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

## Gateway and Commerce billing-ID contract

### Current resolution

New production checkouts no longer cross this boundary. `gateway_direct` sends the opaque Collect.js
token to the same Gateway, requests a Customer Vault record only for a recurring purchase, and saves
the returned Gateway references for later direct-Gateway renewals. One-time purchases omit those
fields and never create a renewable profile. The historical incident and recovery rules below are
kept for audit and old execution reconciliation only.

### 2026-09-07 incident: deployment hold

The Sprout production checkout failed at Commerce payment-method attachment. A numeric billing ID
is **not sufficient evidence for recovery**: it belongs to a specific Gateway vault, and that vault
must be the one linked to the Commerce customer. The original implementation vaulted first and
then reused a customer by email, without verifying that relationship. An incomplete earlier
checkout can create a Commerce customer before a reusable local profile exists.

The repair on `codex/epd-vault-binding-repair` resolves and verifies the customer before vaulting,
rejects mismatched or unverified bindings, explicitly attaches the submitted card, and prevents
review-required executions from being re-claimed by a browser replay or background reconciliation.
It preserves the existing evidence and does not change a customer's linked vault. It is not
deployed and does not establish live checkout readiness.

Read-only customer lookup timeouts, 429s, and service failures now return a fresh, unvaulted
execution to `pending`. The customer may submit a fresh hosted token on that same checkout;
email, phone, terms, and tax identity checks remain enforced, and the atomic claim prevents
overlapping retries. The original token fingerprint remains immutable audit evidence. Only the
specific read-only failure code permits this exception. Vault timeouts never get this reset.
Already-vaulted executions retain their checkpoints and defer on a lookup outage without aborting
the rest of reconciliation. Pre-order setup-review holds are excluded **before** the 100-row
selection limit; executions with a provider order still undergo outcome reconciliation.

Recovery now shares the same payable-state predicate as browser claims and the final pre-order
check: the checkout intent must remain successful and belong to the same organization/request,
the request must remain unpaid and enabled for processing, and customer closure holds must be
absent. Provider setup involves network waits, so the check is repeated immediately before order
creation. A state change at that boundary preserves checkpoints in a setup-review hold; it does
not submit an order or automatically clear the hold. This is not a distributed lock against an
independent payment occurring after that final check.

Pre-order batch selection also excludes legacy nonnumeric production billing IDs, absent phone
checkpoints, and recorded unrecoverable-phone failures before the 100-row limit. Invalid encrypted
phone data is deferred and marked on its first recovery attempt. Existing provider orders bypass
these pre-order filters so their outcomes can still be checked without creating another order.
Do not delete held executions or clear their evidence to force them back into the batch.

Payment success and post-payment setup are separate recovery milestones. Commerce executions
remain eligible for read-only reconciliation until recurring-card binding and tax commitment are
durable. A late processor transaction or interrupted D1 write must not cause a second charge.
If an early success webhook records the order while a resumed POST loses its response, the
transport-error handler must preserve that order reference. A null response is not evidence that
the provider order disappeared. Recovery reads the checkpointed order rather than creating another.
One-time plans do not wait for renewal setup. A delayed initial checkout must not replace a newer
saved subscription card. Existing successful executions with an unfinished tax quote are eligible
for tax-only replay only when an exact successful payment ledger entry proves the request,
provider account, transaction, amount, and currency.

Inline responses, provider reads, and success/failure webhooks must all carry the exact request
amount, currency, and order identity before settlement. Missing totals are not inferred. An early
webhook may attach an order to an interrupted execution only through the exact local checkout
intent and organization/account/request identity. Pending and temporarily inconsistent provider
reads rotate by last-attempt time, so the oldest 100 pending orders cannot indefinitely starve
newer orders. Gateway test executions recover through the Gateway query API, not Commerce, and
verify the original transaction and money before finishing local profile setup.

The same money-evidence requirement applies to automatic-renewal Gateway reads. Unavailable or
inconsistent reads defer and advance last-attempt ordering without resubmitting the charge.
Wrong-account or empty-reference profiles are rejected before renewal candidate selection limits.
Past-due monthly/other recurring subscriptions still require completed processor/vault binding.
An exact successful payment ledger entry prevents a later failure from discarding unfinished
recovery or disabling the paid renewal's profile; conditional SQL rechecks this at the write.

These changes do not automatically reopen every historical successful execution with incomplete
renewal setup. Before rollout, separately inspect affected historical records with approved
read-only access; preserve newer card selections and never replay payment creation as a repair.

Current public [EPD customer docs](https://docs.api.epd.com/api-reference/customers) and the
[card-vaulting guide](https://docs.api.epd.com/api-reference/card-vaulting) describe an Elements
`card_token` flow. They do not promise the legacy `epd_gateway_customer_vault_id` response field.
The repair deliberately fails closed when that field is absent. Verify the actual pinned API
contract before deployment; do not assume the field exists because a mock supplies it.

`gateway_test` checkout skips Commerce attachment. Its provider-backed purchase/renewal proof
does not validate the live Gateway-to-Commerce bridge. Keep both test results explicitly separate.
The incident's owner, outstanding provider verification, and rollout gates are tracked in
[the repair plan](../plans/active/2026-09-07-epd-vault-binding-repair.md).

The current live checkout stays on one EPD surface: Gateway Collect.js produces a single-use browser
token and Gateway `transact.php` processes the sale. A recurring customer-initiated sale also asks
Gateway to create the Customer Vault record. Lago does not invent that vault ID; it stores only the
provider-returned ID and original transaction reference after verified success.

A numeric checkpoint can resume without vaulting again only after the customer/vault relationship
is verified and no review-required failure is present. A legacy alphanumeric checkpoint
cannot be sent to Commerce. It may be replaced only during a fresh customer-initiated checkout:
use the newly produced Collect.js token to add a billing record to the existing Gateway vault, then
checkpoint the replacement numeric ID before continuing. Automated reconciliation without a fresh
token must remain deferred and must not make a second vault request.

## Production credential checklist

Before promotion, verify names only:

- `EASY_PAY_DIRECT_SECURITY_KEY`
- `EASY_PAY_DIRECT_TOKENIZATION_KEY`
- `EASY_PAY_DIRECT_WEBHOOK_SIGNING_KEY`
- `EASY_PAY_DIRECT_CHECKOUT_SIGNING_SECRET`
- `INDIRECT_TAX_ADDRESS_ENCRYPTION_SECRET` when any address-resolved rule is enabled

Never paste their values into tickets, docs, terminal output, screenshots, or browser snapshots.

The Commerce key is not required for `gateway_direct`. If retained for historical reads, verify it
separately and never treat its presence as proof that the live Gateway credentials are valid.

The current canary keeps `EASY_PAY_DIRECT_TAX_MODE=disabled`. Automatic collection is enabled only
under `product_scoped`; it must not widen to `all` without separate approval. App-initiated refunds
remain disabled until a live refund rollout is separately approved; provider-side operator refunds
remain available.

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
3. Provision or verify production Cloudflare resources and EPD live Gateway credentials while
   Store keeps every product on its prior route. Verify `gateway_direct`, production network mode
   and the explicit live gate in a dry run before enabling a canary.
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
