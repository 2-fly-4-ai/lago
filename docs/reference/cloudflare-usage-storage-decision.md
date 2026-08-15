# Cloudflare Usage Storage Decision

Status: accepted for the retained SERP scope
Decision date: 2026-08-16

## Decision

Keep D1 as the authoritative usage-event and billing-projection store, with immutable raw event
evidence in R2. Queue and Workflow consumers may derive repairable projections, but neither a
stream nor an analytics product becomes the billing authority.

Do not provision a separate Durable Object SQL event store, Cloudflare Pipeline, R2 Data Catalog,
or Workers Analytics Engine dataset for the current scope. Reconsider those products only after the
evidence gates below are met.

This decision replaces the legacy instinct to reproduce PostgreSQL partitions, Kafka, ClickHouse,
Redis, and dedicated event containers. It does not claim that one D1 database can serve an unknown
future event volume.

## Verified scope and evidence

- The checked-in SERP capability map identifies only the safe-store checkout's customer,
  subscription, invoice-discovery, and hosted-payment routes. No checked-in `store-new` usage-event
  caller or usage-volume requirement was found. Production traffic and external non-SERP consumers
  remain explicitly unknown.
- The isolated non-production database had zero usage events, daily snapshots, charge snapshots,
  lifetime projections, or pending subscription activities on 2026-08-16. Its total D1 size after
  the read-only audit was 4,677,632 bytes. This proves the test stack is empty; it is not a proxy for
  production volume.
- The retained billing contract needs exact transaction-ID replay/conflict detection, tenant and
  subscription ownership, time-bounded indexed scans, atomic event/outbox writes, and exact joins
  into invoice, wallet, threshold, daily, and lifetime projections.
- `usage_events` has uniqueness on organization/subscription/transaction ID and indexed billing,
  tenant-created, and tenant-code-time lookups. Each accepted event also has a deterministic R2
  archive key and request hash.
- Current event ingestion caps an atomic batch at 100 and validates the whole batch before commit.
  Derived projections are replayable from the D1 ledger and immutable R2 evidence.
- Legacy `enriched_events` PostgreSQL partitioning documented a 14-month operational retention, but
  no current SERP source establishes that as a legal, billing, or product retention requirement.
  No new time-based deletion policy is authorized by this decision.

## Platform fit

### D1: selected billing authority

D1 preserves the existing relational and transactional boundary. Cloudflare currently documents a
10 GB hard limit per paid database, 30-second query limit, 100 bound parameters per query, and a
single-threaded write owner per database. It is designed to scale horizontally through multiple
smaller databases when one database is no longer sufficient.

The current schema and request cap fit those constraints. The hard size and single-writer limits
mean the database must be measured and sharded before it becomes a hotspot; they are not reasons to
add an unmeasured event platform now.

Official limit reference: <https://developers.cloudflare.com/d1/platform/limits/>

### R2: selected immutable evidence store

R2 keeps the canonical request body independently of D1 projections and supports deterministic
replay, audit, and recovery. Cloudflare documents unlimited data and object counts per bucket. R2
objects are not queried synchronously to calculate an invoice; D1 remains the bounded query index.

Official limit reference: <https://developers.cloudflare.com/r2/platform/limits/>

### Durable Object SQL: not selected for event storage

SQLite-backed Durable Objects scale by creating many private, single-threaded objects, each with a
10 GB paid-plan limit. That is useful for per-aggregate command serialization, which this Worker
already uses. Moving usage rows into private per-tenant objects would split the event/invoice/wallet
transaction boundary and require a new cross-object projection protocol without verified hotspot
evidence.

Official limit reference: <https://developers.cloudflare.com/durable-objects/platform/limits/>

### Workers Analytics Engine: derived analytics only

Analytics Engine can support high-cardinality usage analysis, but its documented retention is three
months and its billing recipe describes a reliable approximation that accounts for sampling. Those
semantics cannot replace immutable transaction replay or exact invoice calculations. It may later
receive value-free or minimized derived telemetry, never the sole billing record.

Official references:

- <https://developers.cloudflare.com/analytics/analytics-engine/limits/>
- <https://developers.cloudflare.com/analytics/analytics-engine/recipes/usage-based-billing-for-your-saas-product/>

### Pipelines and R2 Data Catalog: deferred analytical mirror

Pipelines can buffer distributed ingress and write JSON, Parquet, or Iceberg to R2. It is currently
documented as open beta with a 5 MB request limit and 5 MB/s ingest limit per stream. It is a
reasonable future analytical/archive fanout, but it does not provide the transaction-ID uniqueness,
tenant ownership, or atomic invoice/outbox commit required by the billing write path.

Official references:

- <https://developers.cloudflare.com/pipelines/platform/limits/>
- <https://developers.cloudflare.com/pipelines/platform/pricing/>

## Required evidence before production usage is enabled

Collect the following non-secret, non-customer metrics from an approved staged or canary path. A
production evidence read requires separate human approval.

1. Accepted and rejected events per minute and per tenant, including peak and 30-day distributions.
2. Canonical request bytes and property-document bytes at p50, p95, and p99.
3. D1 SQL duration, rows read, and rows written for ingest, current usage, billing close, and repair.
4. End-to-end p50, p95, and p99 latency plus D1 overload/error counts.
5. Daily D1 size growth and the largest tenant's share of rows, writes, and scanned rows.
6. Queue age/retry/DLQ counts and projection repair lag.
7. R2 bytes, object writes, failures, and cleanup backlog for usage archives.

Do not infer these values from repository size, synthetic tests, storefront page views, or provider
transactions.

## Re-evaluation gates

Open a new architecture review before any of these conditions is reached:

- the 12-month D1 size projection exceeds 8 GB, reserving at least 20% below the non-increasable
  10 GB per-database cap;
- one tenant accounts for 25% or more of database bytes, write time, or billed-window scanned rows;
- D1 returns any overload error at the approved intended peak, or p95 write SQL duration remains at
  least 50 ms for three consecutive five-minute windows;
- p99 current-usage or billing-window SQL duration remains at least 5 seconds for three consecutive
  windows despite verified indexes and bounded periods;
- cross-tenant analytics requires raw-event scans beyond the relational billing windows or beyond
  Analytics Engine's three-month retention;
- R2 per-event object operations, archive cost, or cleanup backlog becomes a measured operational
  constraint; or
- a verified consumer requires sustained ingestion that cannot keep the D1 atomic write and Queue
  dispatch inside its agreed latency/error budget.

Crossing a gate does not automatically select a product. It authorizes a measured load test and one
of these changes:

1. shard D1 by tenant cohort while keeping one tenant's billing graph atomic;
2. add Pipelines to build a Parquet/Iceberg analytical mirror in R2 after the D1 commit;
3. add Analytics Engine for short-retention operational/customer analytics only; or
4. introduce a tenant Durable Object as an ingest sequencer while D1 remains the billing ledger.

## Migration and rollback rule

Any future fanout starts from a versioned D1 outbox event after the authoritative event commit.
Backfill from immutable R2 evidence, compare duplicate/out-of-order and invoice aggregates over an
approved time range, and keep D1 authoritative until exact reconciliation and rollback are proven.
No future analytical sink may be placed in the synchronous acceptance path or allowed to turn an
accepted billing event into a partial commit.
