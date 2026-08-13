# Container-Free Cloudflare-Native Lago Rewrite

Opened: 2026-08-12
Status: active
Branch: `codex/cloudflare-native-rewrite`
Worktree: `tmp/lago-cloudflare-native/`

## Objective

Replace the SERP Lago fork's Rails, Sidekiq, Clockwork, Redis, Gotenberg, PostgreSQL-specific,
Kafka/Redpanda, ClickHouse, and Go-container runtime paths with a container-free Cloudflare
implementation.

The rewrite must preserve the Lago contracts that SERP actually consumes, provide an explicit
disposition for every existing Lago capability, and make financial correctness, idempotency,
reconciliation, rollback, and operability first-class requirements.

The end state has no Cloudflare Containers, no continuously running server process, and no
production request or job path that depends on Ruby, Rails, Sidekiq, Clockwork, Redis, Gotenberg,
Kafka, ClickHouse, or the Go event processor.

## Scope Boundary

All implementation changes in this plan belong to the `lago` root repository and this worktree.

- `store-new` is a read-only contract consumer during the rewrite. Its current Lago requests and
  response expectations are compatibility evidence, not authorization to edit it.
- `serp-auth` remains the entitlement authority and is not modified by this plan.
- No other repository is changed by this branch.
- A future consumer cutover, endpoint simplification, or new entitlement event contract requires a
  separate plan and explicit scope expansion.

## Non-Goals

- No production deployment, domain route, DNS, payment endpoint, webhook registration, secret
  synchronization, customer-data access, production database migration, or entitlement mutation.
- No direct translation of the 125-table PostgreSQL schema into D1.
- No one-for-one translation of 242 Sidekiq jobs into 242 queue consumers.
- No compatibility container as a temporary runtime.
- No invention of production Cloudflare resource IDs, secret paths, provider credentials, or
  customer identifiers.
- No claim of feature parity based only on successful compilation or endpoint shape.

## Current Evidence

### Existing Lago surface

The current checkout contains approximately:

- 2,369 Ruby application files;
- 206 ActiveRecord models;
- 547 Rails database migrations;
- 98 controllers;
- 757 GraphQL files;
- 242 Active Job classes;
- 27 Clockwork schedules;
- 125 PostgreSQL tables and 29 PostgreSQL enum types;
- 156 application files containing transaction or locking behavior;
- a Go event processor linked to a Rust expression library;
- optional Kafka/Redpanda, ClickHouse, and Redis event-processing paths.

The PostgreSQL schema and Ruby services use PostgreSQL enums, JSONB, arrays, partitions,
`pg_partman`, a materialized view, triggers, advisory locks, row locks, and transaction-heavy
billing operations. This behavior must be redesigned around Cloudflare consistency boundaries;
it cannot be preserved by syntax conversion.

### Verified current `store-new` compatibility surface

Read-only inspection shows the current Authorize.Net checkout path calls:

1. `POST /api/v1/customers`;
2. `POST /api/v1/subscriptions`;
3. `GET /api/v1/invoices`;
4. `POST /api/v1/invoices/:id/payment_url`.

The compatibility suite will pin the used request fields, response fields, status codes, error
shapes, and idempotency behavior. The rewrite must satisfy this suite without changing
`store-new`.

### Repository state

The main Lago checkout contains local, untracked harness and architecture documents. They were
read as guidance but are not copied, modified, staged, or claimed by this branch. This plan is a
new tracked branch artifact.

## Target Architecture

```text
browser / SERP services
          |
          v
Cloudflare Worker API + static operator assets
          |
          +--> BillingAccount Durable Object
          |      serialized monetary commands
          |      idempotency and sequence allocation
          |
          +--> D1 domain databases
          |      relational records and reporting projections
          |
          +--> Workflows
          |      checkout, invoice, payment, document, retry, migration
          |
          +--> Queues + DLQs
          |      events, webhooks, documents, projections, reconciliation
          |
          +--> R2
          |      invoices, receipts, exports, immutable event archives
          |
          +--> Browser Rendering
          |      invoice and receipt PDFs
          |
          +--> third-party providers
                 Authorize.Net and other explicitly enabled integrations
```

### Compute ownership

- Request/response APIs run in TypeScript Workers.
- Long-running, retryable, or multi-stage work runs in Workflows.
- High-volume, independently retryable work runs through Queues.
- Aggregate-level serialization and strongly consistent coordination run in SQLite-backed Durable
  Objects.
- Cron Triggers only create deterministic Workflow instances or queue messages.
- There are no containers in local, staging, or production configuration.

### Data ownership

- D1 owns normalized durable billing records and cross-account query projections.
- A BillingAccount Durable Object owns serialized state transitions for one selected aggregate
  boundary. The boundary will be proved with invariants before implementation; the starting
  candidate is organization plus external customer.
- R2 owns immutable binary artifacts and optional raw event archives.
- KV may hold only stale-tolerant configuration or caches. It never owns monetary state,
  authentication authority, payment outcomes, or idempotency.
- External payment providers remain authoritative for their own transaction outcomes; local state
  is reconciled against signed webhooks and provider reads.

## Core Invariants

1. The same idempotency key cannot create two customers, subscriptions, invoices, charges, credit
   applications, refunds, webhook deliveries, or entitlement outcomes.
2. At-least-once message delivery and duplicate webhooks must be safe by construction.
3. A failed or retried Workflow cannot cause a second provider-side financial mutation.
4. Provider network calls never occur inside a local database transaction.
5. Every external mutation records intent before execution and records/reconciles the result after
   execution.
6. Invoice totals are reproducible from versioned inputs and rounding rules.
7. Money is stored as integer minor units unless a documented high-precision rating calculation
   requires a decimal representation.
8. Every authoritative state change emits a versioned outbox event after its durable commit.
9. Queue messages include stable IDs, aggregate keys, versions, causation IDs, and correlation IDs.
10. Entitlement authority remains outside Lago; Lago emits only documented payment/billing
    outcomes.
11. No feature is silently dropped. Each feature has a status of `port`, `retire`, `external`,
    `blocked`, or `not-used`, with evidence and approval where retirement is proposed.

## Proposed Package Layout

```text
cloudflare/
├── package.json
├── pnpm-lock.yaml
├── tsconfig.json
├── vitest.config.ts
├── wrangler.jsonc
├── migrations/
├── src/
│   ├── index.ts
│   ├── api/
│   ├── auth/
│   ├── billing/
│   ├── durable-objects/
│   ├── events/
│   ├── providers/
│   ├── queues/
│   ├── repositories/
│   ├── workflows/
│   └── observability/
├── test/
│   ├── compatibility/
│   ├── contracts/
│   ├── invariants/
│   └── integration/
└── fixtures/
```

The existing Rails API and Go processor remain unchanged as behavioral reference material during
the rewrite. New runtime code does not import or execute them.

## Cloudflare Resource Model

Names are provisional until confirmed against the account inventory. Development/staging names
must follow the existing `serp-dev-*` convention and remain isolated from production.

Required resource classes:

- one Worker deployment with separate development/staging and production environments;
- one or more D1 databases, divided only when size, throughput, lifecycle, or ownership evidence
  justifies it;
- a SQLite-backed Durable Object namespace for billing-account coordination;
- queues and dead-letter queues for domain events, webhooks, documents, and reconciliation;
- Workflow bindings for checkout/payment, invoicing, documents, retries, and migrations;
- an R2 bucket for generated billing artifacts;
- Browser Rendering for PDF generation;
- Cron Triggers for deterministic schedule dispatch;
- Worker observability with redaction-safe structured events.

Resource IDs are inserted into configuration only after `wrangler whoami`, account inventory, dry
run validation, and isolated-resource approval checks. Secrets are created or synchronized only
through a separately approved step and are never printed or committed.

## Feature Disposition Inventory

Before feature implementation, create a machine-readable inventory covering:

- public REST routes;
- GraphQL queries, mutations, and subscriptions;
- models and schema objects;
- background jobs and schedules;
- payment providers;
- tax, accounting, CRM, OAuth, email, and AI integrations;
- invoice, credit-note, receipt, quote, and export documents;
- usage aggregation and charge models;
- wallets, credits, coupons, commitments, and taxes;
- operator UI routes;
- webhooks and event schemas;
- analytics and reporting queries.

Each item must contain owner, consumers, current evidence, target disposition, target component,
test fixture, parity status, and migration/rollback notes.

## Milestones

### M0: Baseline, inventory, and contract freeze

- [x] Add a generated feature-disposition inventory with a checked-in generator.
- [x] Add non-secret fixtures for the four verified `store-new` REST interactions.
- [ ] Inventory Rails routes, GraphQL operations, jobs, schedules, models, integrations, and
      frontend screens.
- [ ] Define money, time, identifier, pagination, error, and idempotency conventions.
- [ ] Define aggregate boundaries and prove the required transaction invariants.
- [ ] Record explicitly enabled SERP capabilities using code/config evidence only; do not inspect
      secrets, customer data, or production runtime artifacts.

Acceptance:

- Every existing feature has a disposition and evidence state.
- The current store compatibility fixtures run without network access or private data.
- Unknown production usage remains marked unknown rather than assumed unused.

### M1: Local Cloudflare foundation

- [x] Create the TypeScript Worker package.
- [x] Add local D1 migrations, Durable Object migrations, queue/workflow bindings, R2 binding, and
      Cron configuration.
- [x] Add request IDs, structured errors, authentication boundary, redaction, health, and readiness.
- [x] Add Workers-native Vitest configuration and deterministic test clocks/IDs.
- [x] Add CI commands for formatting, linting, type checking, generated types, migrations, and
      tests.

Acceptance:

- `wrangler types`, configuration validation, dry-run deploy, type checking, and local tests pass.
- No container configuration is referenced by the new package.
- Local tests run without Cloudflare credentials or provider secrets.

### M2: Customer, plan, subscription, and compatibility APIs

- [x] Implement API-key authentication and organization scoping.
- [x] Implement tenant-scoped plan create/list/show and embedded core charge creation required to
      operate the metered path; plan update/deletion and advanced nested features remain pending.
- [x] Implement idempotent customer upsert.
- [ ] Implement subscription creation and lifecycle state machine.
- [x] Implement invoice listing required by the current store flow.
- [x] Implement the four verified Lago-compatible routes and error envelopes.

Acceptance:

- Read-only `store-new` compatibility fixtures pass unchanged.
- Duplicate and concurrent requests produce one logical resource.
- Authorization cannot cross organizations.

### M3: Invoice and rating engine

- [x] Implement exact-decimal standard, graduated, package, volume, percentage, and graduated
      percentage charge-model interfaces; dynamic/custom, filters, and advanced percentage
      adjustments remain pending.
- [ ] Port subscription, recurring, fixed, usage, minimum-commitment, coupon, credit, wallet, tax,
      and rounding behavior according to feature disposition.
- [ ] Implement invoice draft, finalization, void, retry, and payment-status state machines. A
      leased, idempotent recurring period-close finalization path now produces plan and usage lines;
      manual draft/finalize, void, and broader retry transitions remain pending.
- [ ] Add golden fixtures derived from existing tests, not customer data.
- [ ] Add deterministic replay and total reconciliation.

Acceptance:

- Golden invoice totals and line items match approved Rails fixtures.
- Duplicate, reordered, delayed, and concurrent commands preserve monetary invariants.
- Unsupported behavior fails explicitly; it never silently calculates a substitute.

### M4: Provider payments and inbound webhooks

- [x] Define a provider adapter contract.
- [x] Implement Authorize.Net first because it is the verified store dependency.
- [ ] Port other providers according to the feature inventory.
- [ ] Implement checkout/payment Workflows with intent, attempt, outcome, and reconciliation records.
- [x] Implement signed webhook verification, immutable receipt storage, deduplication, ordering,
      retries, and poison-message handling.
- [x] Implement `POST /invoices/:id/payment_url` compatibility behavior.

Acceptance:

- Provider adapters pass fake-server contract suites without live credentials.
- Kill/retry tests cannot produce a duplicate provider mutation.
- Webhook replay converges on the same payment and invoice state.

### M5: Jobs, schedules, outbound events, and reconciliation

- [ ] Replace enabled Active Jobs with domain commands, Queue consumers, or Workflow steps.
- [ ] Replace enabled Clockwork entries with deterministic Cron-to-Workflow dispatch.
- [x] Add outbox publication and dead-letter handling for the implemented payment events.
- [ ] Add outbound webhook signing, idempotency, retry, and delivery audit state.
- [x] Add Authorize.Net receipt-to-invoice reconciliation; broader subscription, queue, and
      entitlement reconciliation remains pending.

Acceptance:

- Every enabled Rails job and schedule has a tested Cloudflare owner.
- Replaying a schedule key is safe.
- Queue duplication and reordering suites pass.

### M6: Documents and object storage

- [ ] Port invoice, receipt, credit-note, quote, and export templates according to inventory.
- [ ] Generate PDFs using Browser Rendering.
- [ ] Replace `pdfcpu` attachment behavior with a Workers-compatible JavaScript or precompiled Wasm
      implementation.
- [ ] Store immutable artifacts in R2 with checksums and generation metadata.
- [ ] Add visual and structural golden-file verification.

Acceptance:

- Representative documents match approved content and layout fixtures.
- A retry does not create conflicting authoritative artifacts.
- No local filesystem or OS subprocess is required.

### M7: Usage metering and analytics

- [x] Implement single-event validation, semantic deduplication/conflict detection, tenant-scoped
      reads, Queue/outbox emission, and immutable R2 archives; batch ingestion remains pending.
- [x] Port count, sum, maximum, latest, and add/remove unique-count aggregations plus six core
      charge models; weighted/custom aggregation, expressions, filters, rounding configuration,
      and advanced adjustments remain pending.
- [ ] Replace the Ruby subprocess and Go/Rust native library with a restricted TypeScript parser or
      a supported precompiled Wasm module.
- [ ] Add usage projections and reconciliation against invoice lines. A synchronous
      Lago-compatible current-usage projection now covers bounded billing windows.
- [ ] Select D1, Durable Object SQL, R2/Pipelines, or Analytics Engine by verified query and volume
      requirements; do not recreate Kafka/ClickHouse by habit.

Acceptance:

- Duplicate and out-of-order event suites produce the same billed aggregates.
- Rating results match approved Lago fixtures.
- No Kafka, ClickHouse, Redis, Go process, or container is required.

### M8: Operator API and UI

- [ ] Inventory the Vite UI's GraphQL operations and screen-level feature dependencies.
- [ ] Implement the GraphQL compatibility surface or replace individual screens with a documented
      Worker API equivalent.
- [ ] Serve the operator application with Workers Static Assets.
- [ ] Replace ActionCable subscriptions with Durable Object WebSockets or SSE where retained.
- [ ] Mark retired screens explicitly with approved product rationale.

Acceptance:

- Every retained operator workflow has an end-to-end test.
- No screen appears functional while calling an unimplemented backend operation.
- Static UI delivery does not invoke compute unnecessarily.

### M9: Local parity and staging readiness

- [ ] Run full contract, invariant, integration, migration, replay, and document suites.
- [ ] Run the repository harness and secret scan.
- [x] Run Wrangler type generation, config validation, and deployment dry run.
- [ ] Produce a resource manifest with development/staging names, bindings, retention, and deletion
      procedures.
- [ ] Produce a staging test plan that uses synthetic customers and provider sandboxes only.

Acceptance:

- The branch is locally green with no secret or customer-data dependency.
- Every Cloudflare resource is reproducible from checked-in configuration or a reviewed command.
- Rollback and resource cleanup are documented before provisioning.

### M10: Isolated Cloudflare staging

- [x] Confirm Wrangler identity and account without printing credentials.
- [x] Inventory existing similarly named resources to avoid collision.
- [x] Create isolated `serp-dev-*` D1, R2, Queue/DLQ, Workflow, and Worker resources.
- [x] Apply only the new D1 migrations.
- [x] Deploy to a workers.dev staging hostname with no production routes.
- [ ] Configure only sandbox/test provider secrets through an approved secret mechanism.
- [ ] Run synthetic end-to-end, replay, restart, retry, and reconciliation tests.

Acceptance:

- Staging handles synthetic billing cycles and deliberate duplicate/failure scenarios.
- No production domain, database, provider registration, customer record, or entitlement is touched.
- All created resources are listed with recoverable deletion instructions.

### M11: Cutover proposal, separately approved

- [ ] Compare Rails and Worker results against non-private approved fixtures and, only with explicit
      approval, shadow production-like traffic without changing authority.
- [ ] Define data migration, checksums, dual-write or event-capture strategy, freeze window,
      reverse replication, and rollback thresholds.
- [ ] Define the consumer endpoint switch without requiring a `store-new` code change where
      possible.
- [ ] Require at least two complete reconciled billing cycles before legacy retirement.

Acceptance:

- A separate production plan is reviewed and explicitly approved.
- This branch alone cannot route production traffic or mutate production billing state.

## Verification Matrix

| Risk | Required evidence |
| --- | --- |
| Duplicate charge | kill/retry and duplicate-command tests with provider fake |
| Lost payment outcome | webhook plus provider-read reconciliation test |
| Incorrect invoice | golden line-item, rounding, tax, coupon, credit, and total fixtures |
| Cross-tenant access | organization-scope authorization tests on every repository method |
| Queue reordering | permuted domain-event and webhook suites |
| Workflow retry | interruption after every external and durable boundary |
| Schedule duplication | deterministic instance IDs and replay tests |
| Document drift | visual render and embedded-data/checksum comparison |
| Migration loss | row counts, aggregate totals, checksums, replay, reverse procedure |
| Secret exposure | redacted logs, secret scan, no credentials in fixtures/config |
| Silent feature loss | complete feature-disposition inventory and UI route audit |

## Rollout Order

1. Freeze compatibility fixtures and feature inventory.
2. Implement and verify locally with fake providers.
3. Provision isolated development/staging resources only.
4. Exercise synthetic complete billing cycles.
5. Complete retained API, job, schedule, document, metering, and operator parity.
6. Write a separate production cutover plan.
7. Shadow and reconcile only after explicit approval.
8. Switch consumer routing only after acceptance gates pass.
9. Keep the legacy deployment recoverable until reconciliation evidence is complete.
10. Retire legacy services and containers only in the separately approved cutover.

## Rollback

- Local changes are isolated on `codex/cloudflare-native-rewrite` in the required workspace
  worktree.
- Staging resources use distinct names and no production routes.
- D1 migrations are forward-only; each milestone includes compensating migration or restore
  instructions before remote application.
- Queue consumers and schedules can be disabled independently.
- Workflow versions and messages are versioned; incompatible consumers reject rather than guess.
- R2 artifacts are immutable and checksummed.
- No source artifact or legacy database is deleted during migration.
- Production rollback retains the legacy endpoint and requires reverse synchronization for writes
  accepted after cutover.

## Approval Gates

This request authorizes creation of isolated Cloudflare development/staging resources for this
rewrite after local dry-run validation. It does not authorize:

- production Worker deployment or production routes;
- DNS or custom-domain changes;
- production D1/R2/Queue/Workflow mutation;
- reading or copying production/customer data;
- live payment, refund, subscription, or webhook-provider mutations;
- provider webhook registration changes;
- production secret synchronization or rotation;
- live entitlement grants or revocations;
- modification of `store-new`, `serp-auth`, or any other repository.

If a command could cross one of these boundaries, stop and request explicit approval with the exact
resource and mutation described.

## Progress Log

- 2026-08-12: Confirmed the clean `codex/cloudflare-native-rewrite` branch and isolated
  `tmp/lago-cloudflare-native/` worktree.
- 2026-08-12: Confirmed that the initial branch scope is Lago-only; `store-new` is read-only
  compatibility evidence and `serp-auth` remains untouched.
- 2026-08-12: Recorded the container-free target, full feature-disposition requirement, milestones,
  safety gates, rollout, and rollback before implementation.
- 2026-08-13: Added the Cloudflare Worker package, generated legacy inventory, synthetic
  `store-new` fixtures, D1 schema, Durable Object command reservations, Queue/Workflow wiring,
  Authorize.Net adapter/webhooks/reconciliation, and 16 Workers-runtime tests.
- 2026-08-13: Verified formatting, linting, generated Wrangler bindings, TypeScript, local D1
  migration replay, runtime tests, and deployment dry run.
- 2026-08-13: Provisioned isolated non-production resources in the existing SERP Cloudflare
  account and deployed `serp-dev-lago-native` at
  `https://serp-dev-lago-native.serpcompany.workers.dev`; payment mutations and provider reads
  remain disabled, no provider secrets were configured, and no production route or data was used.
- 2026-08-13: Applied migrations `0001` through `0004` only and verified remote `/health`, D1-backed
  `/ready`, and the unauthenticated API boundary.
- 2026-08-13: Added migration `0005_metered_usage.sql`, billable-metric and plan-charge APIs,
  Lago-compatible event ingestion/list/show APIs, stable event request hashing, R2 event archives,
  D1 deduplication, outbox/Queue publication, exact-decimal usage aggregation and six core rating
  models, plus a bounded current-usage projection. All 29 Workers-runtime tests passed.
- 2026-08-13: Replayed all five migrations from an empty local D1 persistence directory, applied
  only migration `0005` to the isolated development D1 database, deployed Worker version
  `a45278d4-30e7-48fc-bc46-5175eec4ade6`, and reverified remote `/health`, `/ready`, and the
  unauthenticated `/api/v1/events` boundary. No remote tenant, API-key, plan, customer, event, or
  payment data was seeded.
- 2026-08-13: Added leased, Durable-Object-serialized recurring billing-period close, half-open
  usage windows, exact-to-integer minor-unit rounding, plan and usage invoice lines, deterministic
  invoices, one-time period advancement, and `invoice.finalized` outbox/Queue events. Replay tests
  prove one cycle, invoice, and event while month-end renewal clamps July 31 to September 30.
- 2026-08-13: Replayed all six migrations from an empty local D1 directory, passed 31
  Workers-runtime tests and the full local gate, applied only migration `0006` to isolated
  development D1, deployed version `f1dbf691-bce3-4e0f-80ca-cfc4d0ca954c`, and reverified health,
  readiness, and authentication. The remote database remains unseeded.
- 2026-08-13: Fixed the feature inventory generator to resolve the primary checkout from Git's
  common directory when the worktree's frontend submodule is uninitialized, restored all 1,792
  frontend entries, and removed the circular dependency on the root commit timestamp/revision.
- 2026-08-13: Added atomic, idempotent Lago-compatible plan create/list/show APIs with embedded
  supported charges, stable conflict detection, ISO currency and interval validation, and explicit
  rejection of unimplemented nested features. All 33 Workers-runtime tests pass, and all seven D1
  migrations replay successfully from an empty local database.
- 2026-08-13: Applied only migration `0007` to isolated development D1 and deployed Worker version
  `cc3bd495-bb81-4c6a-bc19-79e6bc0437d4`. A transient read-only D1 API query returned account
  authorization code 7403 immediately before the successful apply; follow-up verification showed
  no pending migrations, `/health` and `/ready` returned 200, and unauthenticated `/api/v1/plans`
  returned 401. No remote data was seeded.
