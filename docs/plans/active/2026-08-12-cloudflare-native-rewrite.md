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
- [x] Inventory Rails controllers, GraphQL files, jobs, schedules, models, services, migrations,
      and frontend source files. Route/operation/screen semantic extraction remains pending.
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
- [x] Implement customer upsert/list/show for the retained core fields; destructive customer
      lifecycle and advanced address/tax/provider projections remain pending.
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
      Billable-metric create/list/show and Rails-safe scalar update now emit transactional,
      versioned outbox events; attached metrics allow only name/description mutation. Recurring,
      rounding, weighted, expression, filters, and deletion inputs fail explicitly until their
      aggregation and cleanup workflows are ported.
      Standalone plan charge create/list/show now supports idempotent, transactional creation and
      `charge.created` events for the exact in-arrears rating models. Pay-in-advance, proration,
      filters, targeted taxes, pricing units, wallet targeting, update, deletion, and cascades fail
      explicitly until their billing and cleanup workflows are ported.
- [ ] Port subscription, recurring, fixed, usage, minimum-commitment, coupon, credit, wallet, tax,
      and rounding behavior according to feature disposition. Unrestricted fixed/percentage
      coupons now support once/recurring/forever application, initial and renewal invoice
      consumption, exact rounding, replay, and unpaid-void recredit; targeted coupons, credit
      note refunds/offsets/taxes, commitments, and taxes remain pending. Credit-only finalized
      notes now support fee-bounded issuance, idempotent replay, customer balance application to
      later invoices, and auditable unpaid-void recredit; provider refunds, invoice offsets,
      tax-adjusted notes, documents, email, and external reporting remain pending. Granted-credit wallets now support
      create/list/show/terminate, idempotent top-up, priority/lot-ordered initial and renewal
      invoice consumption, and auditable unpaid-void recredit; paid/recurring/threshold top-ups and
      targeted allocation remain pending.
      Organization-default manual percentage taxes now support create/list/show/update/terminate,
      coupon-adjusted fee taxable bases, exact rounding, and immutable invoice/fee snapshots;
      customer/plan/charge targeting, external providers, exemptions, tax identifiers, and
      credit-note tax adjustments remain pending.
      Plan-level in-arrears minimum commitments now create only the rounded billing-period
      shortfall while retaining the precise fee value; commitment-specific taxes, pay-in-advance
      reconciliation, partial-period proration, and subscription overrides remain pending.
      Tenant-scoped add-ons now support idempotent create/list/show/update/terminate with versioned
      outbox events, and plans support standard/graduated/volume recurring pay-in-arrears fixed
      charges. Fixed fees enter the exact recurring invoice pipeline before minimum commitments,
      coupons, taxes, credit notes, and wallets. Pay-in-advance charges, proration, unit events,
      inherited/overridden fixed charges and targeted taxes remain pending and fail explicitly.
      Standalone fixed-charge list/show routes expose the same ledger; standalone create/update/
      delete remain guarded because they require per-subscription unit-event and rebilling flows.
      Plan creation now emits transactional versioned outbox events, and scalar plan updates
      support the Rails-safe mutable subset for attached plans with optimistic concurrency.
      Charge/fixed-charge/commitment/tax/threshold graph replacement, deletion, one-time plans,
      trials, pay-in-advance, and monthly split billing remain explicit rejections.
- [ ] Implement invoice draft, finalization, void, retry, and payment-status state machines. A
      leased, idempotent recurring period-close finalization path now produces plan and usage lines,
      and unpaid finalized invoices can be shown with lines and voided idempotently; manual
      draft/finalize, paid-invoice credit/refund voids, and broader retry transitions remain pending.
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
- [x] Add outbound HMAC webhook signing, endpoint filters, idempotency, bounded retry, URL safety,
      and delivery audit state. Deployment remains disabled until a signing secret is separately
      approved; legacy JWT signing remains pending.
- [x] Add Authorize.Net receipt-to-invoice reconciliation; broader subscription, queue, and
      entitlement reconciliation remains pending.

Acceptance:

- Every enabled Rails job and schedule has a tested Cloudflare owner.
- Replaying a schedule key is safe.
- Queue duplication and reordering suites pass.

### M6: Documents and object storage

- [ ] Port invoice, receipt, credit-note, quote, and export templates according to inventory. The
      invoice template and authenticated generation/download boundary are implemented; all other
      document types remain pending.
- [x] Generate invoice PDFs using Browser Rendering through a retryable, ownership-checked
      Document Workflow.
- [ ] Replace `pdfcpu` attachment behavior with a Workers-compatible JavaScript or precompiled Wasm
      implementation.
- [x] Store immutable, version-addressed invoice artifacts in R2 with checksums, byte length, and
      generation metadata; equivalent handling for other document types remains pending.
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
- 2026-08-13: Added subscription list/show and guarded idempotent termination, with versioned
  Durable Object coordination and `subscription.terminated` outbox/Queue emission. Termination
  requires explicit invoice/credit-note skipping until those financial paths are ported. The
  inventory now attaches owner, consumers, target, evidence, test fixture, parity status, and
  migration/rollback notes to all 3,972 entries.
- 2026-08-13: Deployed the guarded lifecycle and enhanced inventory as Worker version
  `08b8ddb7-bfc4-4765-8b24-8e05c0be978d`; remote health/readiness returned 200 and the
  unauthenticated subscriptions collection returned 401. The remote D1 database remains unseeded.
- 2026-08-13: Added tenant-scoped invoice show with line-level precise amounts and idempotent unpaid
  invoice void guarded by Durable Object reservations and versioned outbox/Queue events. Paid or
  refund/credit-note-bearing voids fail explicitly until those ledgers are ported. All 34 tests pass.
- 2026-08-13: Deployed invoice authority as Worker version
  `b29a6b1b-c39a-434c-b029-fd14f91d8121`; remote health returned 200 and unauthenticated invoice
  show returned 401. No provider mutation or remote billing data was introduced.
- 2026-08-13: Added tenant-scoped customer list/show with pagination and escaped case-insensitive
  search across external ID, name, and email; the existing store compatibility suite now exercises
  these reads. Destructive customer deletion remains deferred until dependent ledgers are ported.
- 2026-08-13: Replaced the invoice PDF container path with deterministic escaped HTML, Browser
  Rendering, a retryable ownership-checked Document Workflow, bounded PDF streaming, immutable
  versioned R2 artifacts, SHA-256 metadata, and replay-safe D1 state. All 38 Workers-runtime tests
  pass, including invalid-output and oversized-stream failure cases.
- 2026-08-13: Applied only migration `0008` to the isolated development D1 database and deployed
  Worker version `cb34a618-ce8b-4bdc-9829-9c7eefd3368a` with workflow
  `serp-dev-lago-documents`. Remote migration inventory is empty; health/readiness returned 200 and
  an unauthenticated customer API read returned 401. No remote billing or artifact data was seeded.
- 2026-08-13: Added tenant-scoped coupon create/list/show and applied-coupon
  create/list/customer-list/terminate APIs, immutable coupon-credit records, exact fixed and
  percentage calculations, once/recurring/forever lifecycle, database-enforced non-reuse and
  version-checked consumption, versioned outbox events, initial and renewal invoice integration,
  invoice credit evidence, and unpaid-void recredit. Plan/billable-metric targets are rejected
  explicitly until line-allocation parity is proven. All 42 Workers-runtime tests pass across 13
  files with all nine migrations replayed from empty D1 state.
- 2026-08-13: Applied only migration `0009` to isolated development D1 and deployed Worker version
  `de441997-65d7-4a27-9ae1-a0eeec17d75b`. Follow-up migration inventory was empty; remote
  health/readiness returned 200 and the unauthenticated coupon collection returned 401. No remote
  tenant, coupon, credit, invoice, provider, secret, or customer data was introduced.
- 2026-08-14: Added granted-credit wallet create/list/show/terminate and transaction
  create/list/show APIs, exact rate/exponent conversion, database-enforced optimistic balance and
  lot consumption, invoice priority allocation after coupons, distinct prepaid-credit invoice
  totals, immutable funding evidence, void recredit, and versioned outbox events. Paid credits,
  provider-funded top-ups, recurring/threshold rules, fee/metric targets, and wallet payment methods
  fail explicitly. All 44 Workers-runtime tests pass across 14 files with all ten migrations
  replayed from empty D1 state.
- 2026-08-14: Applied only migration `0010` to isolated development D1 and deployed Worker version
  `45797343-c902-492d-b0e8-e9e8b9f6e60f`. The first read-only inventory attempt returned transient
  Cloudflare code 7403; Wrangler identity still showed D1 write access to the SERP account, the
  retry reported exactly `0010`, apply/deploy succeeded, and follow-up inventory was empty.
  Health/readiness returned 200 and unauthenticated wallet access returned 401. No remote billing
  data or payment mutation was introduced.
- 2026-08-14: Added tenant-scoped credit-note create/list/show/void APIs for credit-only finalized
  notes; explicit idempotency keys and request hashes; invoice- and fee-bounded issuance; immutable
  application and recredit records; version-checked D1 triggers; application after coupons and
  before wallets on initial and renewal invoices; invoice credit-note totals; and exactly-once
  unpaid-void recredit. Refunds, offsets, taxes, metadata, documents, email, and provider reporting
  fail explicitly. All 46 Workers-runtime tests pass across 15 files, generated inventory and
  Worker bindings are current, and the dry-run bundle is 265.86 KiB.
- 2026-08-14: Applied only migration `0011` to isolated development D1 and deployed Worker version
  `38220f20-14ff-49c5-95e5-4c1b1ec464e6`. Follow-up migration inventory was empty; remote
  health/readiness returned `200` and unauthenticated credit-note access returned `401`. The stack
  remains unseeded, no provider secrets were added, and payment/provider mutation flags remain off.
- 2026-08-14: Added manual tax create/list/show/update/terminate APIs, active-code reuse after
  termination, organization-default invoice application, exact coupon-adjusted taxable-base
  allocation, Rails-compatible per-fee rounding, immutable invoice/fee tax snapshots, and
  versioned outbox events. Customer/plan/charge targeting and provider tax modes fail explicitly.
  All 48 Workers-runtime tests pass across 16 files; formatting, strict lint, inventory, generated
  bindings, TypeScript, and the 288.08 KiB dry-run bundle are green.
- 2026-08-14: Applied only migration `0012` to isolated development D1 and deployed Worker version
  `751ef348-beca-4228-bd3c-90d08fb32940`. Follow-up migration inventory was empty; remote
  health/readiness returned `200` and unauthenticated tax access returned `401`. The stack remains
  unseeded, has no provider secrets or production routes, and all provider mutation flags remain off.
- 2026-08-14: Added plan-level minimum commitment persistence and serialization plus recurring
  in-arrears true-up lines covering subscription and invoiceable usage fees. Tests preserve both
  rounded and precise shortfalls and verify coupon application occurs after the threshold is met.
  Commitment-specific tax targeting fails explicitly. All 50 Workers-runtime tests pass; the full
  local gate and 291.85 KiB deployment dry run are green.
- 2026-08-14: Applied only migration `0013` to isolated development D1 and deployed Worker version
  `ba847804-a588-4cbd-a411-ad8fe2686a34`. Follow-up migration inventory was empty; remote
  health/readiness returned `200` and unauthenticated plan access returned `401`. The stack remains
  unseeded with no production route, provider secret, or enabled provider mutation.
- 2026-08-14: Removed the inventory's ambiguous default-unknown state. All 3,972 legacy artifacts
  now have an explicit `port` disposition and a Cloudflare component assignment based on runtime
  ownership; 1,653 entries map to partially implemented families with executable evidence and
  2,319 remain explicitly `not-started`. Consolidation is allowed, but retirement still requires
  approval and no artifact is considered complete without a contract fixture and parity evidence.
- 2026-08-14: Added HMAC-only webhook endpoint create/list/show/update/delete APIs, HTTPS/private-
  target validation, event filtering, deterministic endpoint/event delivery IDs, stable signed
  payloads, no-redirect delivery, bounded response capture, 2xx/terminal-4xx/retryable outcome
  handling, a five-attempt cap, and D1 delivery audit records. The deployed configuration keeps
  `OUTBOUND_WEBHOOKS_ENABLED=0` and has no signing secret; tests use only a synthetic binding.
  All 52 Workers-runtime tests pass across 17 files.
- 2026-08-14: Applied only migration `0014` to isolated development D1 and deployed Worker version
  `887c749b-09d3-4143-932a-a41cd0fdbbd6`. Follow-up migration inventory was empty; remote
  health/readiness returned `200` and unauthenticated endpoint access returned `401`. Outbound
  delivery remains disabled, no signing secret was configured, and the stack remains unseeded.
- 2026-08-14: Added tenant-scoped, idempotent add-on create/list/show/update/terminate APIs with
  optimistic concurrency and transactional outbox events; embedded plan fixed charges for the
  standard, graduated, and volume models; exact decimal units; recurring pay-in-arrears invoice
  lines; and minimum-commitment ordering over subscription, usage, and fixed fees. Initial invoices
  do not include in-arrears fixed charges. Pay-in-advance, proration, unit-event mutation,
  inheritance/overrides, targeted taxes, and plan mutation fail explicitly. All 54 Workers-runtime
  tests pass across 18 files; the full local gate and 330.49 KiB dry-run bundle are green.
- 2026-08-14: Applied only migration `0015` to isolated development D1 and deployed Worker version
  `0224f1a8-9af9-4424-a39a-efef5c9bd808`. Follow-up migration inventory was empty; remote
  health/readiness returned `200` and unauthenticated add-on access returned `401`. The isolated
  stack remains unseeded, has no production route or provider secret, and payment, provider-read,
  and outbound-webhook flags all remain disabled.
- 2026-08-14: Added transactional `plan.created` and versioned `plan.updated` outbox events plus
  optimistic scalar plan updates. Attached plans allow only the Rails-safe mutable subset: name,
  invoice display name, description, amount, and metadata. Catalog graph replacement, deletion,
  one-time lifecycle, trials, pay-in-advance, and monthly split billing fail explicitly. All 56
  Workers-runtime tests pass across 18 files; the full local gate and 340.06 KiB dry-run bundle are
  green.
- 2026-08-14: Deployed the code-only plan-catalog revision as isolated Worker version
  `317c844a-836d-457b-81da-6b072bf0a190`; no D1 migration was pending. Remote health/readiness
  returned `200`, unauthenticated plan update returned `401`, and all payment, provider-read, and
  outbound-webhook flags remain disabled with no production route or secret.
- 2026-08-14: Made billable-metric creation idempotent, added optimistic scalar updates with the
  Rails-safe attached-plan restriction, and added transactional `billable_metric.created` and
  `billable_metric.updated` outbox events. Recurring, rounding, weighted, expression, filters, and
  destructive deletion now fail explicitly instead of being stored without effect. All 57
  Workers-runtime tests pass across 18 files; the full local gate and 348.51 KiB dry-run bundle are
  green.
- 2026-08-14: Deployed the code-only billable-metric revision as isolated Worker version
  `4e2162a2-c51e-4d9d-91d1-89b3c42502bc`; no D1 migration was pending. Remote health/readiness
  returned `200`, unauthenticated metric update returned `401`, and the stack remains unseeded with
  no production route, provider secret, or enabled external-mutation flag.
- 2026-08-14: Added Lago-compatible standalone plan-charge list/show, idempotent transactional
  creation, and `charge.created` outbox events. Both embedded and standalone charge creation now
  reject pay-in-advance, proration, filters, targeted taxes, pricing units, wallet targeting, and
  cascade behavior rather than storing semantics the invoice engine cannot honor; update and
  deletion remain guarded. All 58 Workers-runtime tests pass across 18 files; the full local gate
  and 355.70 KiB dry-run bundle are green.
- 2026-08-14: Deployed the code-only plan-charge revision as isolated Worker version
  `2dfd5a73-70d2-49ef-a16a-5c89fa995fea`; no D1 migration was pending. Remote health/readiness
  returned `200`, unauthenticated charge list returned `401`, and the stack remains unseeded with
  no production route, provider secret, or enabled external-mutation flag.
- 2026-08-14: Added Lago-compatible standalone fixed-charge list/show routes over the embedded plan
  ledger. Standalone create/update/delete now return explicit unsupported errors rather than
  bypassing required subscription unit-event and immediate-rebilling behavior. All 58
  Workers-runtime tests pass across 18 files; the full local gate and 358.54 KiB dry-run bundle are
  green.
