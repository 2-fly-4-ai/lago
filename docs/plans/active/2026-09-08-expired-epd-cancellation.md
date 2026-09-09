# Guarded expired EPD cancellation

Status: local implementation and regression verification; no deployment authorized here.

## Ownership and rollout

Lago Cloudflare owns the versioned cancellation capability, immutable billing evidence check and
atomic termination batch. Store owns self-service selection and must verify
`expired_cancellation_guard_version: 1` before sending `only_if_expired=true`, exact internal
subscription ID, external customer ID and observed period end. Both termination actions must be
`skip`. Deploy additive migration 0118 and Lago first, verify staging, then Store. Existing DELETE
requests without the new option retain their existing behavior. Root API/front submodules unchanged.

## Safety and acceptance

The new named-check assertion executes before any pending-child cancellation, subscription write
or outbox insertion, in the same D1 transaction. It requires exact version/identity, recurring EPD
ownership, a finite expired current period, no future or malformed linked plan-line coverage and
no uncertain customer invoice/payment-request/EPD/checkout execution. Any mismatch aborts the batch.
Future unpaid invoices also remain held: this is intentionally narrower than a complete
last-paid-through cancellation policy. Independent subscriptions are untouched.

Use fictional local D1 fixtures to test success, stale-read concurrent coverage/payment, malformed
dates, provider changes, unknown payments and zero child/outbox effects on failure. Store must not
retry a rejected guard as an unconditional DELETE or use the option against an old server. No
provider request, database mutation outside local fixtures, secret operation or deployment is part
of this work. Roll back callers first; retain additive schema for compatibility.

## Local evidence

2026-09-08: 26 real local D1 cancellation regressions pass, including manual and automatic
pending/processing/unknown executions without a payment ledger row, a concurrently added paid future
invoice, malformed/numeric plan dates, paid pending successors, provider changes and exact API
capability/409 behavior. The independent paid subscription is verified through the actual source
materializer before and after cancellation. Populated 0114–0118 migration rehearsal passes.
Full Lago `pnpm run check`: 806/806 tests in 90 files, formatting/lint, Access, checkout UI, tax,
inventory/types and seven dry-run Worker builds passed. Root harness and diff checks pass.

Remaining limitation: customer-wide uncertainty includes an unrelated abandoned checkout intent.
Such a row can keep cancellation held until safely reconciled; this implementation does not delete
it or infer that no charge is possible. Future unpaid invoices and billed pending successors also
remain review cases. No claim is made that every past-due account can self-cancel yet. There were no
real provider transactions, remote migrations, deployments or customer-message sends in these tests.
