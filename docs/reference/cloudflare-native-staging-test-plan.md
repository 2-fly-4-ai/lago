# Cloudflare-Native Lago Staging Test Plan

Last reviewed: 2026-08-15

This plan applies only to the isolated `serp-dev-lago-native` stack documented in
`cloudflare-native-resource-manifest.md`. It does not authorize production traffic, customer data,
provider credentials, payment mutations, outbound messages, DNS changes, or entitlement writes.

## Safety prerequisites

1. Confirm the Cloudflare account ID and exact `serp-dev-lago-*` resource names.
2. Confirm no D1 migration is pending unexpectedly and `PRAGMA foreign_key_check` is empty.
3. Confirm `PAYMENT_MUTATIONS_ENABLED`, `PROVIDER_READS_ENABLED`, and
   `OUTBOUND_WEBHOOKS_ENABLED` are all `0` for provider-free phases.
4. Use only a run-scoped prefix such as `synthetic-e2e-YYYYMMDD-NNNN`, reserved documentation
   domains such as `example.invalid`, and non-personal names. Never copy a production identifier,
   payload, credential, cookie, or email address.
5. Record pre-run aggregate row counts. Stop if any pre-existing non-audit business row is present
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

## Cleanup and rollback

Prefer a disposable D1 database for destructive scenarios. Deleting synthetic rows from the shared
isolated D1, deleting any Cloudflare resource, or removing sandbox provider objects requires an
explicit human approval naming the exact targets. A failed run leaves its prefixed records and
audit evidence intact for inspection; do not issue broad or wildcard deletion commands.
