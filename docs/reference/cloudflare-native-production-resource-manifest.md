# Cloudflare-Native Lago Production Resource Manifest

Last verified: 2026-08-22

This is the production inventory for the Cloudflare-native Lago deployment. It records resource
identifiers and control state, but never credentials, raw Access identities, or customer data.

## Deployed resources

| Kind | Name or ID | Binding or purpose |
| --- | --- | --- |
| API Worker | `serp-prod-lago-native` / version `04e4a1dc-6264-45dc-aacf-7a3392b3cd75` | Production billing API |
| Operator Worker | `serp-prod-lago-operator` / version `e55e76c5-7e5f-4df9-b8e8-8681ee9d847d` | Access-protected operator application |
| Portal Worker | `serp-prod-lago-customer-portal` / version `0244e825-0660-4d4a-b874-4f16d70e3163` | Token-protected customer portal |
| D1 | `serp-prod-lago-native-d1` / `a0274eda-6f03-429a-896f-a1e0121a9f21` | `BILLING_DB` |
| R2 | `serp-prod-lago-native-billing-artifacts` | `BILLING_ARTIFACTS` |
| Queue | `serp-prod-lago-domain-events` | `DOMAIN_EVENTS` producer; no consumer enabled |
| DLQ | `serp-prod-lago-domain-events-dlq` | Retry exhaustion; no consumer enabled |
| Access application | `serp-prod-lago-operator` / `6696a2c2-f843-4ed5-8c1d-0ba89741c83a` | Exact production operator Worker |
| Access policy | `Allow Lago operator production` / `228ffba9-10b2-4c9b-a308-adbfeab92d34` | One exact-email Allow include, 24-hour session |

The Access audience is configured on the operator Worker. The operator has no public bypass: an
unauthenticated request redirects to Cloudflare Access, and an authenticated allowed identity loads
the retained Lago navigation and Assistant.

## Database and authority state

- Migrations `0001_foundation.sql` through `0090_provider_recurring_wallet_funding.sql` are applied.
- `PRAGMA foreign_key_check` returns no violations and there are no pending migrations.
- D1 Time Travel bookmark after the foundation/control-plane seed:
  `0000001a-00000000-000050ce-8a0cff906580cdd448760bed629c9b16`.
- D1 Time Travel bookmark after canary API-key and catalog preparation:
  `0000001c-0000000a-000050ce-a23cef90f5ccd212942e095749776277`.
- The database contains one control-plane organization (`serp-billing`) and one claimed admin
  operator membership. It contains no imported customer billing records.
- Read-only discovery found no active legacy Lago/PostgreSQL billing authority or reachable legacy
  ledger to shadow or import. This rollout is therefore a fresh billing authority deployment, not a
  migration of an active ledger. If another authority is discovered, stop cutover and reconcile it
  before enabling traffic.

## Fail-closed production state

The API has no Cron trigger and no Queue consumer. All external-action gates are disabled:

- `PAYMENT_MUTATIONS_ENABLED=0`
- `CREDIT_NOTE_REFUND_MODE=disabled`
- `WALLET_FUNDING_MODE=disabled`
- `EXTERNAL_TAX_MODE=disabled`
- `PROVIDER_READS_ENABLED=0`
- `STRIPE_NETWORK_MODE=disabled`
- `STRIPE_WEBHOOKS_ENABLED=0`
- `STRIPE_LIVEMODE_ALLOWED=0`
- `OUTBOUND_WEBHOOKS_ENABLED=0`

Verified responses are API `/health` `200`, API `/ready` `200`, unauthenticated API invoice access
`401`, disabled Stripe webhook `503`, and unauthenticated operator access `302` to Cloudflare Access.
No production provider credential is attached to the Lago API Worker.

## Cutover and rollback boundaries

- `serp-prod-safe-store` remains the existing production store authority until a separately verified
  explicit canary is configured. Its pre-secret Worker version is
  `9de6c5c0-c23e-4556-baf5-5894ecde775b`; adding the encrypted, currently unused `LAGO_API_KEY`
  secret produced version `5143b5ef-ade8-40e0-b891-6fab7f79136c`. Connecting the API URL,
  provider code, and fail-closed `off` mode produced version
  `34f0dbe6-5e9d-4e61-8077-02ed25b5e93c`; Store health remains `200`.
- A single tenant-scoped, non-expiring API key named `serp-prod-safe-store canary` is active. Only
  its hash and non-sensitive display fragments are stored in D1; its raw value exists only as the
  store Worker secret. Authenticated key creation is audit-recorded, unauthenticated plan access
  remains `401`, and the key value is not documented.
- The reviewed store registry seeded only `serp-1-app-plan-monthly` (USD 900 minor units) and
  `serp-1-app-plan-yearly` (USD 7,900 minor units), both active and pay-in-advance. Production D1
  still contains no customer, subscription, invoice, payment, or provider transaction rows.
- Canary mode must begin as `LAGO_AUTHORIZE_NET_CHECKOUT_MODE=explicit`; never begin with `on`.
- Do not enable the canary until the exact store plan catalog, tenant-scoped Lago API key, and
  production payment-provider credential mapping are verified. Missing credentials are a blocker,
  not a reason to copy an unrelated Stripe key.
- The store secret inventory currently has no `AUTHORIZE_NET_API_LOGIN_ID`,
  `AUTHORIZE_NET_TRANSACTION_KEY`, or `AUTHORIZE_NET_SIGNATURE_KEY`. Checkout mode therefore stays
  off and no provider-visible canary has run.
- Roll back store traffic by restoring the pre-cutover store version and disabling Lago selection.
  Roll back application code to the recorded Worker versions above. Restore D1 from the Time Travel
  bookmark only after preserving post-bookmark audit evidence and confirming the exact database.
- Provider-visible operations require a reverse journal keyed by Lago command/idempotency key.
  Never delete production D1/R2 evidence as part of an application rollback.
- Retirement remains blocked until two real production-authority billing cycles complete with zero
  unexplained reconciliation drift. All original Lago screens remain retained.
