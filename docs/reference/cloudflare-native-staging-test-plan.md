# Cloudflare-Native Lago Staging Test Plan

Last reviewed: 2026-08-22

This plan applies only to the isolated `serp-dev-lago-native` stack documented in
`cloudflare-native-resource-manifest.md`. It does not authorize production traffic, customer data,
provider credentials, payment mutations, outbound messages, DNS changes, or entitlement writes.

## Safety prerequisites

1. Confirm the Cloudflare account ID and exact `serp-dev-lago-*` resource names.
2. Confirm `PUBLIC_BASE_URL` is the isolated workers.dev hostname and there are no custom routes.
3. Confirm no D1 migration is pending unexpectedly and `PRAGMA foreign_key_check` is empty.
4. Confirm `PAYMENT_MUTATIONS_ENABLED`, `PROVIDER_READS_ENABLED`, and
   `OUTBOUND_WEBHOOKS_ENABLED` are all `0` for provider-free phases.
5. Use only a run-scoped prefix such as `synthetic-e2e-YYYYMMDD-NNNN`, reserved documentation
   domains such as `example.invalid`, and non-personal names. Never copy a production identifier,
   payload, credential, cookie, or email address.
6. Record pre-run aggregate row counts. Stop if any pre-existing non-audit business row is present
   unless a human explicitly approves that exact dataset.

## Provider-free phases

Run each phase with a fresh synthetic tenant and a test API key whose plaintext exists only in the
test runner. Persist no key material in Git or D1 beyond its one-way hash.

1. Create a customer, plan, subscription, usage events, coupon, wallet grant, and manual tax.
2. Close one in-arrears cycle and one pay-in-advance cycle; compare invoice headers, normalized
   lines, taxes, credits, totals, dates, and outbox versions with checked-in synthetic fixtures.
3. Replay every create and close command. Verify identical responses or explicit idempotency
   conflicts and exactly one authoritative aggregate transition.
4. Submit events out of order and with duplicate transaction IDs. Verify the final usage projection
   and invoice total are order-independent.
5. Exercise draft refresh/finalize, scheduled termination, trial ending, plan change, progressive
   threshold, recurring wallet, payment-overdue, dunning request, and document generation paths.
6. Inject Queue duplicates, a retained R2 deletion failure, a stale Workflow lease, a stale D1
   version, and a malformed provider receipt. Verify bounded retry, atomic rollback, and DLQ or
   audit evidence as applicable.
7. Render and inspect the synthetic invoice PDF; verify its stored checksum, byte length, immutable
   version key, and text/line-item fixture.

## Provider sandbox phase

This phase is skipped until a human separately approves the exact sandbox account, secret-loading
mechanism, callback URL, and temporary flag change.

1. Load sandbox-only credentials through an approved Cloudflare secret mechanism without printing
   or committing them.
2. Enable one external-action flag at a time for the shortest test window.
3. Create one hosted Authorize.Net payment intent for a synthetic invoice, replay the command, and
   verify the provider sees only one mutation.
4. Deliver signed success, failure, duplicate, delayed, and unknown-status callbacks using sandbox
   identifiers. Verify payment/invoice convergence and provider-read reconciliation.
5. If outbound webhook delivery is approved, send only to a controlled test receiver and verify
   signature, filtering, retry, and DLQ behavior. Do not send email or customer messages.
6. Return all external-action flags to `0` and verify the deployed version bindings.

## Acceptance evidence

- All local checks and the complete serial Workers suite pass at the tested commit.
- The deployed version ID, bindings, startup time, health/readiness/authentication responses,
  migration inventory, foreign-key check, and before/after row counts are recorded.
- Duplicate/failure scenarios produce no duplicate invoice, credit, payment, wallet, provider, or
  outbox mutation.
- Provider-free results reconcile exactly with approved synthetic fixtures.
- Any unsupported contract fails explicitly and is added to the active plan; it is never silently
  approximated.

## Executed runs

- `synthetic-e2e-20260815-001`: completed the provider-free SERP checkout prefix on Worker version
  `80fee6c9-5be3-481e-898e-26013daa14ea`. Plan, customer, and subscription replay preserved IDs;
  divergent subscription replay failed explicitly; invoice discovery returned the expected single
  finalized/pending invoice; and the hosted-payment call proved the disabled mutation gate. The
  run produced no payment link or provider request, passed the foreign-key check, and ended with its
  one-time API key revoked. Provider sandbox, Queue failure injection, restart, and full billing-
  cycle phases remain pending.
- `stripe-synthetic-20260821-001`: completed Stripe-test wallet funding on Worker version
  `785e0d67-e489-44aa-b2e1-5e296f58d848` for the existing synthetic organization only. The first
  non-charging failure identified the missing server-side redirect policy. After adding
  `automatic_payment_methods[enabled]=true` and `allow_redirects=never`, a 100-minor-unit
  `pm_card_visa` funding operation settled exactly once and command replay returned the same
  transaction. A signed `payment_intent.succeeded` event was accepted once and replayed once without
  a second credit. The run ended with its Lago API key revoked and no foreign-key violations. The
  user elected to retain the narrowly scoped Stripe test key, webhook secret, tenant mapping, and
  test-only network/webhook gates in the isolated development Worker for repeatable testing; live
  mode and all unrelated external-action gates remain disabled.
- `synthetic-resilience-20260822-001`: completed provider-free replay, restart, recovery,
  reconciliation, Queue, and document evidence on Worker version
  `5f8a09d6-c296-4256-b1fa-4b324966a35c`. The run created a fresh synthetic tenant plus one
  metric/plan/customer/in-arrears subscription/granted wallet and two out-of-order usage events.
  Exact replay before and after a real Worker redeploy preserved every ID and row cardinality;
  divergent plan, subscription, and event reuse failed explicitly. The actual UTC `:30` recovery
  schedule closed one overdue cycle into one 430-cent finalized invoice with two lines after a
  500-cent granted-wallet allocation. Document Workflow produced one immutable 37,415-byte PDF;
  replay retained SHA-256
  `2142f5f40a802cda420c16bcddd0476c0afb58a4dbd0639dd15979e37363c0fb`. An invalid Stripe
  signature returned `401` and left the receipt count unchanged. The focused failure suite passed
  59 tests across eight files, including Queue deduplication, stale/retry cycle recovery, retained
  R2 cleanup after injected deletion failure, Workflow idempotency, malformed receipts, and
  document replay. The run API key was revoked and its plaintext removed; zero active Lago API
  keys and zero foreign-key violations remain. The persistent restricted Stripe TEST connection
  was not removed.

The API portions of the resilience run are reproducible with `pnpm run staging:resilience --
<setup|events|verify>`. The runner requires `LAGO_SYNTHETIC_RUN_ID` and a run-scoped
`LAGO_SYNTHETIC_API_KEY` in the process environment, locks its target to the isolated workers.dev
hostname, and never prints the key.

## Cleanup and rollback

Prefer a disposable D1 database for destructive scenarios. The isolated Stripe test connection is
retained until the user explicitly requests teardown; future agents must not remove its Cloudflare
secrets or disable its test-only gates merely as routine test cleanup. Deleting synthetic rows from
the shared isolated D1, deleting any Cloudflare resource, or removing sandbox provider objects
requires an explicit human approval naming the exact targets. A failed run leaves its prefixed
records and audit evidence intact for inspection; do not issue broad or wildcard deletion commands.
