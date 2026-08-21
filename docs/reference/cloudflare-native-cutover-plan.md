# Cloudflare-Native Lago Production Cutover Plan

Status: design complete; production execution not authorized

Last reviewed: 2026-08-22

This document defines the future production migration and endpoint switch. It does not authorize
production data access, a production Cloudflare deployment, DNS or route changes, secret loading,
provider mutations, `store-new` or `serp-auth` changes, shadow traffic, or legacy retirement.

## Authority and contract owners

| Contract | Authority before cutover | Authority after approved cutover | Rollback owner |
| --- | --- | --- | --- |
| Customer, plan, subscription, usage, invoice, wallet, credit, and payment ledgers | Legacy Lago PostgreSQL/Rails | Production Cloudflare D1/Worker | Billing migration operator |
| Raw usage/provider/document evidence | Legacy stores | Production R2 plus D1 checksums/indexes | Billing migration operator |
| `LAGO_API_URL`, `LAGO_API_KEY`, routing mode, eligibility, and Stripe fallback | `store-new` deployment configuration | Unchanged owner; values point at the approved Worker | `store-new` deployment operator |
| Extension identity and entitlement | `serp-auth` | Unchanged | `serp-auth` owner |
| Provider credentials and registrations | Existing provider/secret owner | Approved Cloudflare secrets only | Provider/secret owner |

The legacy deployment remains authoritative until the final delta is reconciled and the endpoint
switch is explicitly approved. The Cloudflare Worker must not infer storefront eligibility or
replace the Stripe fallback.

## Required production resources

Provision a separate production Worker, D1 database, R2 bucket, Queue/DLQ, Durable Object namespace,
and Workflow set from the checked-in configuration. Never rename or reuse the existing `serp-dev-*`
resources. Use a dedicated production API hostname and Cloudflare Access application. Resource
names, account, jurisdiction, retention, routes, Access policy, and deletion protection require a
reviewed manifest before creation.

## Snapshot and transformation

1. Obtain action-time approval for a read-only legacy inventory. Record table row counts and schema
   versions without printing row contents.
2. Export a transactionally consistent PostgreSQL snapshot at source LSN `S0`. Encrypt it at rest;
   store it only in an approved migration location; never Git, logs, shell history, or the existing
   development R2 bucket.
3. Transform source rows into versioned canonical batches matching the D1 migration schema. The
   transformation manifest records source table, source schema version, target table, transform
   version, stable sort key, batch number, row count, and SHA-256.
4. Reject orphaned foreign keys, ambiguous tenant ownership, unsupported provider rows, invalid
   currency/decimal/time values, and duplicate natural keys. Do not silently drop or coerce them.
5. Import into a new empty production D1 database with external actions, Cron, Queue consumers, and
   provider reads disabled. Apply only the checked-in forward migrations before importing data.

## Checksums and reconciliation

For every authoritative table, compare source and target using a canonical representation:

- stable primary-key ordering;
- UTF-8 JSON with sorted object keys and normalized `null` handling;
- integer minor units for money and canonical decimal strings for quantities/rates;
- UTC ISO-8601 timestamps at millisecond precision;
- SHA-256 per batch plus a SHA-256 manifest root.

Acceptance requires matching row counts and hashes for identity/catalog/configuration tables. For
derived or structurally transformed tables, require documented source-to-target mappings plus:

- counts by tenant, status, currency, provider, and billing period;
- sums of invoice subtotal, taxes, coupons, wallet credits, credit notes, total due, paid, refunded,
  and remaining balances by tenant/currency;
- subscription period/version and invoice-line source cardinalities;
- usage transaction uniqueness and aggregate quantities by metric/period;
- payment/provider idempotency-key uniqueness and webhook receipt counts;
- R2 object count, byte length, SHA-256, and D1 reference equality;
- empty D1 `PRAGMA foreign_key_check` and no unresolved migration exceptions.

Any mismatch is blocking until explained by a reviewed transform rule and reverified from `S0`.

## Change capture instead of dual authority

Do not make Rails and the Worker independent write authorities. After `S0`, capture legacy changes
in an append-only, ordered journal keyed by source LSN and transaction identity. Import and replay
the journal idempotently into D1 while legacy remains authoritative. Each replay batch records its
source LSN range, count, manifest hash, target commit result, and reconciliation result.

Before any canary sends writes to the Worker, add and verify the reverse path: Worker transactional
outbox events must be archived immutably and applied idempotently to the legacy authority or held in
a reviewed rollback journal that can be replayed before traffic returns. A canary cannot advance
while reverse-journal lag or an unresolved DLQ item is nonzero.

## Freeze and endpoint switch

1. Reconfirm the checked-in Rails-source-to-Worker synthetic fixture comparison documented in
   `cloudflare-native-rails-worker-fixture-parity.md`. Run any read-only production-like shadow
   comparison only with separate action-time approval. No shadow request may call a provider or
   mutate either authority.
2. Demonstrate at least two complete reconciled billing cycles in the target environment and close
   every blocker in the feature/route inventory.
3. Announce a narrow billing-write freeze. Stop new checkout writes at the existing routing owner;
   do not disable unrelated storefront traffic.
4. Record final legacy LSN `S1`, replay `(S0, S1]`, and repeat all checksums, aggregates, foreign-key,
   Queue/DLQ, Workflow, R2, and provider-idempotency checks.
5. Create a tenant-scoped production Lago API key through the Worker control plane and load it into
   the approved `store-new` secret mechanism. Never print or persist plaintext outside that vault.
6. Change only deployment configuration: set `LAGO_API_URL` to the approved production Worker
   hostname and `LAGO_API_KEY` to the new secret. Preserve routing modes, provider query aliases,
   eligibility, quantity checks, and Stripe fallback. No `store-new` source change is required.
7. Start in explicit/canary mode. Exercise the frozen four-call contract: customer upsert,
   subscription create, invoice discovery, and hosted payment URL. Expand only after reconciliation.
8. End the freeze after the first canary writes are present in both the Worker journal and rollback
   path and every acceptance query is green.

`serp-auth` is not part of this endpoint switch and receives no change.

## Rollback thresholds

Immediately stop canary expansion and restore the previous `LAGO_API_URL`/`LAGO_API_KEY` when any of
the following occurs:

- duplicate or unaccounted provider mutation, invoice, credit, wallet transaction, or outbox event;
- any tenant-scope breach, authentication bypass, invalid signature acceptance, or secret exposure;
- any unexplained source/target count, checksum, money aggregate, usage, or period/version mismatch;
- nonzero foreign-key violations, reverse-journal lag beyond the approved bound, or an unresolved
  Queue DLQ/Workflow failure beyond its retry budget;
- document checksum/reference drift or a missing immutable R2 artifact;
- error/latency thresholds above the separately approved canary SLO for two consecutive windows.

Rollback order is: stop new Worker canary writes, drain or quarantine in-flight Queue/Workflow work,
replay the complete Worker rollback journal into legacy, reconcile through the final Worker event,
restore the prior consumer configuration, verify the Stripe fallback and legacy health, then revoke
the canary API key. Never delete production Worker/D1/R2 evidence during rollback.

## Retirement gate

Legacy Rails, PostgreSQL, Redis, Sidekiq, and containers remain recoverable until a separately
approved retirement review confirms: two production-authority cycles after full cutover, zero
reverse-journal lag, completed provider settlement/reconciliation, and an expired rollback window.
The approved product baseline retires no original Lago screen or workflow, so the Cloudflare-native
surface ledger must remain complete at retirement time. Any future screen exception requires a new
explicit product decision. Synthetic cycles prove staging readiness but do not by themselves
authorize legacy deletion.
