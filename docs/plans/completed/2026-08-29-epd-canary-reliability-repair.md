# EPD canary reliability repair

Opened: 2026-08-29
Completed: 2026-08-29

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

## Initial evidence

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

## Completion evidence

- Lago commit `9fecc12` and Store commit `f44c7201b` implement durable EPD checkpoints,
  resumable reconciliation, stable Store checkout-attempt identity, exact invoice filtering, and
  bounded Store completion polling.
- Lago's full clean gate passed: formatting, lint, Access tests, inventory checks, generated types,
  TypeScript, 73 test files with 419 tests, and every development and production dry-run build.
  Store lint, typecheck, all application tests, and its production-safe OpenNext build also passed.
- Staging Lago version `9b77db17-15cd-4b57-baee-8b8aae17d555` and Store version
  `cc175e75-8774-4bcc-bea4-290e05dd9e1c` returned healthy responses. Browser replay of the canary
  retained exactly one subscription, finalized invoice, payment request, and checkout intent.
  The control product continued to Stripe Sandbox.
- The corrected staging resilience run passed replay-safe setup and event ingestion, converged
  out-of-order usage to 30 cents, and rejected an invalid Stripe webhook with HTTP 401. Its
  invoice/PDF phase remains a post-billing-cycle assertion and was not misreported as an immediate
  result.
- Production migration `0099_easy_pay_direct_recovery_checkpoints.sql` applied cleanly. Lago
  version `9dcde101-e8f4-417f-9b32-432b5c994ce1` is healthy and ready with one queue consumer, a
  DLQ, and a one-minute scheduled reconciliation fallback.
- The audited debris cleanup closed two pre-checkpoint, no-provider executions and 11 unpaid
  canary attempts as failed/voided/terminated. It deleted no ledger evidence, and zero payment
  attempts, payment-request payments, receipts, or provider profiles existed.
- Production Store version `aabfd996-7647-4d79-900d-82ded9052ada` renders the live EPD form for
  Pornhub Downloader while the LinkedIn control still renders the existing Stripe Checkout. The
  EPD form was reloaded without creating a second billing attempt; no card or customer data was
  submitted by the agent.
- Production Lago and Store D1 foreign-key checks are empty, Lago has no pending migration, Store
  has 12 local and 12 applied Drizzle migrations, the operator fails closed through Cloudflare
  Access, and invalid Lago API and checkout credentials return HTTP 401.

## Rollback

Disable `LAGO_CHECKOUT_ENABLED` and the Store EPD explicit mode before restoring recorded Worker
versions. Do not delete D1/provider evidence during rollback. Additive checkpoint columns remain
backward compatible; cleanup operations must have an inverse record or deterministic restoration
statement before execution.
