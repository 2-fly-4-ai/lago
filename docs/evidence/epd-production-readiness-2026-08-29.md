# EPD production readiness evidence — 2026-08-29

Status: ready and fail-closed; production payment activation remains separately approval-gated.

This record contains identifiers and pass/fail results only. It intentionally excludes credential
values, customer data, transaction data, signed checkout URLs, Access identities, and session data.

## Provider preparation

- Active restricted EPD Commerce key: `serp-lago-production-20260829`.
- Scope: customer, order, transaction, subscription, product, and webhook read/write only.
- Excluded: delete, administrator, API-key-management, plan, and coupon permissions.
- The first generated key was revoked immediately after accidental task-output exposure and is not
  used anywhere.
- Enabled webhook: `serp-lago-production-orders`.
- Destination: the production Lago `easy_pay_direct` webhook for `org-serp-billing`.
- Events: `order.*` only.
- Provider-selected API version: `2026-02-10` (`Latest` in the provider UI).
- No provider customer, order, payment, refund, void, card, or live transaction was created.

## Cloudflare state

Prepared encrypted secret names:

- `EASY_PAY_DIRECT_COMMERCE_API_KEY`
- `EASY_PAY_DIRECT_WEBHOOK_SIGNING_KEY`
- `EASY_PAY_DIRECT_CHECKOUT_SIGNING_SECRET`
- `EASY_PAY_DIRECT_SECURITY_KEY`
- `EASY_PAY_DIRECT_TOKENIZATION_KEY`

Secret-only Worker version prefix `368faac1` is active. All five secret names were verified after
promotion, and their values were neither displayed nor persisted in repository output.

Verified disabled gates:

- `PAYMENT_MUTATIONS_ENABLED=0`
- `EASY_PAY_DIRECT_NETWORK_MODE=disabled`
- `EASY_PAY_DIRECT_LIVEMODE_ALLOWED=0`
- `PROVIDER_READS_ENABLED=0`
- `OUTBOUND_WEBHOOKS_ENABLED=0`

No Store deployment, Store routing change, checkout enablement, or payment submission occurred.

## Remote read-only verification

- `GET /health`: `200`, production service healthy.
- `GET /ready`: `200`, D1 query ready.
- Unauthenticated API request: `401`.
- EPD payment form without signed token: `400`.
- EPD sandbox tool without signed token: `400`.
- EPD webhook without a signature: `401`.
- D1 applied migrations: `98`.
- Latest D1 migration: `0098_production_store_one_time_plan.sql`.
- Pending D1 migrations: `0` (local and remote migration inventories match).
- D1 foreign-key violations: `0`.

## Clean gates

Lago `pnpm check` passed completely: formatting, lint, Access tests, inventories, generated types,
TypeScript, all 73 Vitest files, and development/production dry bundles.

Store validation passed:

- monorepo typecheck;
- main Store suite (`592` tests, `4` skipped);
- three sibling marketing suites in isolation;
- complete monorepo test run with `--concurrency=1` (`10/10` tasks);
- `build:main` with `1,651` static pages.

The first parallel monorepo test attempt exposed a shared fixture/resource ordering race in three
sibling marketing packages. Each package passed in isolation and the complete deterministic serial
run passed, so this is recorded as an existing parallel-run reliability issue rather than an EPD
canary regression.

## Next approval gate

The infrastructure and credentials are ready but intentionally inert. Keep Store checkout and every
production payment gate disabled until a separately approved one-product live canary action. That
action must define the exact product, amount, test identity, rollback version, and reconciliation
checklist before enabling any Store or Lago gate or submitting a payment.
