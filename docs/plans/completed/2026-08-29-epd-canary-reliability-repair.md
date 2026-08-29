# EPD canary reliability repair

Opened: 2026-08-29

## Objective

Make the bounded `pornhub-video-downloader` Store -> Lago -> Easy Pay Direct canary safe to retry:
checkout creation must be idempotent, every provider-side checkpoint must be durable and resumable,
payment reconciliation must have both queue and scheduled execution paths, and Store completion must
tolerate normal asynchronous webhook delay.

## Ownership and external contracts

- `store-new/apps/serp-store` owns product routing, the stable checkout-attempt key, checkout reuse,
  customer completion polling, fulfillment, and the direct-Stripe fallback.
- This `lago` repository owns billing records, EPD Gateway vault state, EPD Commerce resources,
  webhook receipt processing, queue consumption, scheduled reconciliation, and D1 repair tooling.
- EPD owns provider outcomes. `serp-auth` remains the entitlement authority and is unchanged.

Rollout order is Lago additive schema and resumable implementation, Lago staging, Store staging,
production Lago, production Store, then one human-submitted canary. Rollback disables new Store Lago
checkouts first and preserves all billing/provider evidence.

## Current evidence

- Production queue configuration has a producer but no consumer and no cron trigger.
- Repeated Store checkout opens created 11 separate one-time subscriptions, invoices, payment
  requests, and checkout intents without a provider charge.
- Two EPD executions are `unknown` without provider transaction IDs and cannot be selected by the
  current reconciler.
- Gateway vault identifiers are persisted only after later Commerce calls, so a partial failure can
  consume a one-time card token without leaving resumable state.
- Store verifies the Lago invoice once after redirect and can race webhook reconciliation.

## Milestones and acceptance criteria

1. Add additive D1 checkpoint columns and deterministic uniqueness constraints. Migration tests,
   foreign-key checks, and rollback evidence must pass.
2. Persist gateway vault, provider customer, payment method, product, and order identifiers after
   each successful external step. Replays must resume without reusing a consumed card token or
   creating a second provider object.
3. Reconcile `processing` and `unknown` executions with any durable checkpoint, including executions
   without an order ID. Definitive declines remain failed; ambiguous outcomes remain fail-closed.
4. Configure the production queue consumer, bounded retries, DLQ, and one-minute scheduled fallback.
   Configuration tests must assert all four.
5. Prove approve, decline, replay, post-vault failure, delayed webhook, duplicate submission, void,
   and refund/test cases using synthetic or provider test-mode data only.
6. Deploy staging and verify repeated reconciliation converges. No live card is submitted by the
   agent.
7. After clean gates, deploy the approved production code/config, verify the active consumer/cron,
   and close only the specifically audited orphan records with a reversible evidence record.

## Safety gates

- Never print or commit credentials, card data, customer records, signed checkout URLs, or raw
  webhook payloads.
- Provider and D1 mutations remain blocked until local and staging gates are green.
- Production cleanup is limited to the two audited no-transaction executions and 11 unpaid canary
  artifacts. Re-query exact IDs and relationships immediately before any mutation.
- A real card submission remains a human action after handoff.

## Verification

- Lago full check, migrations, D1 foreign-key check, config assertions, and dry-run builds.
- Store focused tests plus full lint, typecheck, tests, and OpenNext Worker build.
- Staging browser/API validation for duplicate checkout reuse and delayed reconciliation.
- Production `/health`, `/ready`, queue consumer, cron trigger, pending migration, and D1 integrity
  evidence without exposing private data.

## Rollback

Disable `LAGO_CHECKOUT_ENABLED` and the Store EPD explicit mode before restoring recorded Worker
versions. Do not delete D1/provider evidence during rollback. Additive checkpoint columns remain
backward compatible; cleanup operations must have an inverse record or deterministic restoration
statement before execution.
