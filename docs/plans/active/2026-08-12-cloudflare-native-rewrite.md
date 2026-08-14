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
- [x] Define money, time, identifier, pagination, error, and idempotency conventions in
      `docs/reference/cloudflare-native-conventions.md`.
- [x] Define aggregate boundaries and the D1, Durable Object, outbox, R2, concurrency, and replay
      evidence required to prove their transaction invariants in that conventions reference.
- [x] Record explicitly enabled SERP capabilities using code/config evidence only in
      `docs/reference/serp-enabled-lago-capabilities.md`; no secrets, customer data, or production
      runtime artifacts were inspected.

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
      invoice consumption, and auditable unpaid-void recredit. One fixed interval- or
      threshold-triggered recurring granted-credit rule per wallet now supports tenant-safe
      create/update/replace/termination, metadata, and resource custom-section selection. Interval
      rules retain customer-local clipped anniversaries, deterministic daily replay, and legacy
      `:50` expiration/`:55` top-up ownership. Wallet create/update now persists fee-type and
      billable-metric limitations with tenant-safe target replacement. Invoice allocation drains
      matching fee buckets across positive wallets in application order; the five-minute owner
      assigns each current-period or persisted-draft fee wholly to the first metric, fee-type, or
      unrestricted match, permits a negative ongoing balance, tracks depleted transitions, and
      atomically creates a threshold grant only when projected plus pending credits do not clear
      the border. Charges may opt into event `target_wallet_code` grouping; targeted and untargeted
      usage rate independently, explicit targets override normal limitations, and missing wallets
      emit replay-safe `event.error` evidence. Paid/target recurring rules, provider funding, and
      dedicated-organization cadence remain pending.
      Organization-default manual percentage taxes now support create/list/show/update/terminate,
      coupon-adjusted fee taxable bases, exact rounding, and immutable invoice/fee snapshots;
      customer/plan/charge targeting, external providers, exemptions, tax identifiers, and
      credit-note tax adjustments remain pending.
      Plan-level in-arrears minimum commitments now create only the rounded billing-period
      shortfall while retaining the precise fee value. Final termination invoices also prorate the
      target over the retained UTC unsplit window before subtracting precise and rounded fees;
      commitment-specific taxes, pay-in-advance reconciliation, split windows, tenant-local civil
      dates, and subscription overrides remain pending.
      Tenant-scoped add-ons now support idempotent create/list/show/update/terminate with versioned
      outbox events, and plans support standard/graduated/volume recurring pay-in-arrears fixed
      charges. Fixed fees enter the exact recurring invoice pipeline before minimum commitments,
      coupons, taxes, credit notes, and wallets. Pay-in-advance charges, proration, unit events,
      inherited/overridden fixed charges and targeted taxes remain pending and fail explicitly.
      Standalone fixed-charge list/show routes expose the same ledger; standalone create/update/
      delete remain guarded because they require per-subscription unit-event and rebilling flows.
      Plan creation now emits transactional versioned outbox events, and scalar plan updates
      support the Rails-safe mutable subset for attached plans with optimistic concurrency. The
      base plan’s `pay_in_advance` mode is accepted at creation and can change only before a
      subscription attaches to that plan.
      Positive plan trials, persisted customer timezones, and subscription calendar/anniversary
      billing are now supported by the dedicated trial-ending slice. Charge/fixed-charge/
      commitment/tax/threshold graph replacement, deletion, one-time plans, and monthly split
      billing remain explicit rejections.
- [ ] Implement invoice draft, finalization, void, retry, and payment-status state machines. A
      leased, idempotent recurring period-close path now produces finalized invoices at zero grace
      or non-consuming preview drafts at positive grace. Usage events flag the owning draft; manual
      `PUT /invoices/:id/refresh`, the five-minute legacy refresh owner, and finalization all rebuild
      the same plan/usage/fixed/commitment/coupon/tax/credit-note/wallet calculation. Coupon,
      credit-note, and wallet balances are consumed only by the final atomic transition. Triggered
      version guards abort a losing refresh/finalize batch before its line deletes can commit.
      Grace-period initial subscription invoices use a distinct immutable initial context, create
      the same non-consuming preview, refresh manually or on schedule, and allocate credits only
      while finalizing; they do not masquerade as renewal cycles. Explicit skip-invoice/
      skip-credit subscription termination flags an existing draft and keeps it refreshable from
      its immutable initial or renewal context. Supported final termination now covers prorated
      in-arrears bases/commitments and the ordered pay-in-advance unused-credit plus usage-invoice
      command. Positive-grace in-arrears termination now uses a distinct immutable termination
      context, creates a non-consuming draft for immediate or scheduled termination, refreshes from
      the original period after the subscription transition, and allocates balances only while
      finalizing. Positive-grace pay-in-advance termination now persists a non-allocatable draft
      unused-period note beside the termination draft, reprices it with its draft prepaid source,
      finalizes it only after that source, and applies it before wallets while finalizing the
      termination invoice. Adjusted draft sources, paid-invoice refund/offset voids, allocated-source
      adjustments, destructive plan/charge graph replacement, and broader retry transitions remain
      pending.
      Customer net-payment terms now snapshot onto finalized initial, recurring, and one-off
      invoices with deterministic due dates. The legacy hourly overdue transition is replay-safe,
      emits a transactional outbox event, and successful manual or Authorize.Net settlement clears
      overdue state. Lost-dispute exclusion remains pending until dispute state is ported.
      Immutable issuing dates and expected-finalization dates now support tenant-scoped manual
      refresh/finalization plus the legacy five-minute refresh and hourly `:20` finalization
      transitions with replay-safe version/outbox evidence. Customer grace changes reschedule and
      flag existing initial and renewal drafts without changing their issuing-date anchor. D1
      triggers also flag the affected drafts after supported subscription, plan/rating, applied
      coupon, tax, credit-note, wallet, and usage mutations.
      Immediate subscription creation atomically records `subscription.created`; pay-in-advance
      plans create the initial invoice event and monetary ledger in that same batch, while
      in-arrears plans correctly create no initial invoice. A normalized future UTC
      `subscription_at` instead persists a replay-safe pending subscription without an invoice; the
      five-minute activation owner atomically starts it, seeds its billing period, applies the same
      initial billing-mode rule, and emits `subscription.started`. Pending subscriptions can be
      renamed and rescheduled to another future instant with the same optimistic version/outbox
      guards, or canceled idempotently without creating an invoice; canceled rows cannot later be
      activated. Active/past-due name updates emit the same versioned `subscription.updated`.
      Recurring close snapshots the pay-in-advance base line against the next billing period while
      keeping in-arrears base, usage, fixed-charge, and commitment evidence on the closed period.
      Same-currency subscription plan changes now preserve immutable previous/next generations.
      Annualized upgrades transition immediately and reconcile the old partial service, the new
      prepaid base, and finalized unused prepaid credit in one multi-generation invoice. Downgrades
      transition at period close through the same replay-safe billing-cycle owner. Both paths retain
      immutable draft contexts, queued downgrades cancel with their current generation, and usage
      events resolve against half-open generation windows with external-chain transaction
      uniqueness. Prepaid grace upgrades retain non-allocatable source-credit contexts, finalize
      source-first manually or through the scheduler, and support repeated generation changes
      through the multi-subscription invoice graph.
      Backdated calendar/anniversary starts on an earlier customer-local day activate at the exact
      supplied instant without a retroactive invoice and resume in the period containing creation;
      Manual/provider-default payment policy persists across create, update, and plan generations.
      Tenant-scoped manual invoice custom-section catalog CRUD is available through a documented
      REST equivalent for the operator GraphQL workflow. Explicit subscription attach/skip/replace
      semantics, pending-row preservation, clean or explicitly supplied plan generations, draft
      refresh, immutable finalized snapshots, invoice serialization, and PDF projection are
      implemented. The retained single-billing-entity subset now maps organization defaults and
      customer replace/skip behavior into one tenant-safe invoice precedence projection shared by
      recurring and one-off snapshots. Multi-billing-entity routing, provider-created
      system-generated sections, provider-specific method IDs, backdated one-time plans, and
      target/provider-funded recurring inputs remain explicit gaps. Wallet and granted
      wallet-transaction resource selections are persisted and serialized for API compatibility;
      they deliberately do not enter invoice precedence because Lago's paid-credit invoice service
      does not pass those resources to section application.
      Calendar billing and trial dates use a snapshotted customer IANA
      timezone; the retained termination subset remains UTC-specific.
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
      All 27 legacy entries now have an exhaustive code-level ownership registry. A deterministic
      five-minute Cron dispatches a versioned Workflow instance and records due/unimplemented
      schedules in D1. The retained pending-subscription activation, recurring billing, draft
      refresh, Authorize.Net receipt retry, coupon expiry, wallet expiry, recurring-rule expiry,
      ongoing wallet-balance/threshold projection, provider-free interval granted-credit top-up,
      and invoice-overdue paths run on their legacy slots; the other entries remain explicitly
      `not_started` until their underlying feature
      families are ported. The two daily webhook-retention schedules now enforce Lago's 90-day
      boundary; inbound receipt deletion uses a transactional D1 cleanup queue so R2 failures remain
      replayable without orphaning payloads.
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
      reads, Queue/outbox emission, and immutable R2 archives. Batch ingestion validates all
      events before writing, caps requests at 100, rejects duplicate/existing transaction IDs,
      stores deterministic archives, and commits all event/outbox rows atomically.
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
      Worker API equivalent. Manual invoice custom-section catalog CRUD now uses the documented
      tenant-scoped REST equivalent; the remaining operator operations and screens are still
      inventoried/ported individually.
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

| Risk                 | Required evidence                                                   |
| -------------------- | ------------------------------------------------------------------- |
| Duplicate charge     | kill/retry and duplicate-command tests with provider fake           |
| Lost payment outcome | webhook plus provider-read reconciliation test                      |
| Incorrect invoice    | golden line-item, rounding, tax, coupon, credit, and total fixtures |
| Cross-tenant access  | organization-scope authorization tests on every repository method   |
| Queue reordering     | permuted domain-event and webhook suites                            |
| Workflow retry       | interruption after every external and durable boundary              |
| Schedule duplication | deterministic instance IDs and replay tests                         |
| Document drift       | visual render and embedded-data/checksum comparison                 |
| Migration loss       | row counts, aggregate totals, checksums, replay, reverse procedure  |
| Secret exposure      | redacted logs, secret scan, no credentials in fixtures/config       |
| Silent feature loss  | complete feature-disposition inventory and UI route audit           |

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
- 2026-08-14: Deployed the code-only fixed-charge route revision as isolated Worker version
  `fbf90a5e-4546-4c95-922d-a45321df716a`; no D1 migration was pending. Remote health/readiness
  returned `200`, unauthenticated fixed-charge list returned `401`, and the stack remains unseeded
  with no production route, provider secret, or enabled external-mutation flag.
- 2026-08-14: Added the missing transactional `subscription.created` and initial
  `invoice.finalized` events to checkout creation, name-only optimistic subscription updates with
  `subscription.updated`, and explicit guards for every unported subscription creation/update
  option. All 59 Workers-runtime tests pass across 18 files; the full local gate and 364.46 KiB
  dry-run bundle are green.
- 2026-08-14: Deployed the code-only subscription lifecycle revision as isolated Worker version
  `7bf943c2-663b-477e-85d2-549dd83bfdee`; no D1 migration was pending. Remote health/readiness
  returned `200`, unauthenticated subscription update returned `401`, and the stack remains
  unseeded with no production route, provider secret, or enabled external-mutation flag.
- 2026-08-14: Added a versioned customer aggregate, idempotent Lago-compatible POST upserts,
  transactional `customer.created` and `customer.updated` outbox events, strict customer metadata
  validation, an explicit guard for unsupported payment providers and unported customer fields,
  and a guarded deletion route. The verified `store-new` Authorize.Net payload remains unchanged;
  its synchronization flags are accepted as compatibility intent while provider mutations remain
  disabled. All 60 Workers-runtime tests pass across 18 files; the full local gate and 373.18 KiB
  dry-run bundle are green.
- 2026-08-14: Applied only migration `0016_customer_versions.sql` to the isolated development D1
  and deployed Worker version `2abf3cf9-e415-43a2-9931-0274313dbb94`. Follow-up migration inventory
  was empty; remote health/readiness returned `200`, unauthenticated customer creation returned
  `401`, and direct read-only counts confirmed zero organizations and zero customers. The stack has
  no production route or provider secret, and payment, provider-read, and outbound-webhook flags
  all remain disabled.
- 2026-08-14: Added Lago-shaped, tenant-scoped payment list/show/customer-list APIs; a kill-switched,
  idempotent manual-payment ledger with partial/final settlement and overpayment guards; exact
  invoice paid/outstanding projections; stale hosted-payment-link invalidation; and versioned
  `payment.recorded`, provider-outcome, and `invoice.payment_status_updated` events. Authorize.Net
  reconciliation now sums successful attempts, preserves terminal success against later decline
  notifications, and exposes provider attempts through the same payment ledger. All 63
  Workers-runtime tests pass across 19 files; formatting, lint, generated types, TypeScript, the
  cross-repository inventory check, and the 391.40 KiB dry-run bundle are green. Because the SMB
  worktree timed out while starting parallel Cloudflare test runners, the complete suite was also
  run against an exact disposable local-filesystem snapshot of `cloudflare/`.
- 2026-08-14: Applied only migration `0017_payment_ledger.sql` to the isolated development D1 and
  deployed Worker version `1be34a00-4e0c-45d4-8d9d-88706d7527e2`. Follow-up migration inventory was
  empty; remote health/readiness returned `200`, unauthenticated payment reads and writes returned
  `401`, and direct read-only counts confirmed zero organizations, customers, and payments. The
  stack remains without a production route or provider secret, with payment, provider-read, and
  outbound-webhook flags disabled.
- 2026-08-14: Added idempotent Lago-compatible one-off invoice creation over active add-ons with
  exact decimal units, per-request unit-price and display overrides, preserved fee order,
  immutable organization-default tax snapshots, zero-amount settlement, tenant-scoped replay, and
  transactional `invoice.one_off_created` events. Automatic provider charging must be explicitly
  skipped until that workflow is ported; targeted fee taxes, custom sections, alternate billing
  entities, payment methods, and unsupported fields fail explicitly. All 65 Workers-runtime tests
  pass across 20 files; formatting, lint, TypeScript, generated types, cross-repository inventory,
  and the 401.73 KiB dry-run bundle are green.
- 2026-08-14: Applied only migration `0018_one_off_invoices.sql` to the isolated development D1 and
  deployed Worker version `5b72fb2f-9a59-402e-ae39-dfe6385e3daf`. Follow-up migration inventory was
  empty; remote health/readiness returned `200`, unauthenticated one-off creation returned `401`,
  and direct read-only counts confirmed zero organizations, invoices, and invoice lines. No
  production route, provider secret, or external-mutation flag was changed.
- 2026-08-14: Added an exhaustive code-level ownership registry for all 27 legacy Clockwork
  schedules, deterministic five-minute Cron-to-Workflow instance IDs, D1 schedule-run audit state,
  legacy-slot dispatch for recurring billing and Authorize.Net receipt retries, and replay-safe
  coupon and wallet expiration with transactional outbox events. Due but unported schedules are
  recorded as partial runs instead of being silently skipped. All 68 Workers-runtime tests pass
  across 21 files; all 19 migrations replay from an empty D1 database, generated bindings and the
  cross-repository inventory are current, and the dry-run bundle is 415.26 KiB.
- 2026-08-14: Applied only migration `0019_schedule_runs.sql` to the isolated development D1 and
  deployed Worker version `495c9174-bc2f-47b7-a907-48c4a403927a` with the deterministic
  `*/5 * * * *` trigger. Follow-up migration inventory was empty; remote health/readiness returned
  `200`, unauthenticated invoice access returned `401`, and direct aggregate-only counts confirmed
  zero organizations and zero schedule runs before the first new trigger. The stack remains
  unseeded with no production route or provider secret, and payment, provider-read, and
  outbound-webhook flags remain disabled.
- 2026-08-14: Added customer/organization net-payment terms, immutable invoice due-date snapshots,
  replay-safe overdue marking on the legacy hourly `:25` slot, and automatic overdue clearing after
  successful manual or Authorize.Net settlement. All 70 Workers-runtime tests pass across 21 files;
  all 20 migrations replay from an empty D1 database, generated bindings and the cross-repository
  inventory are current, and the dry-run bundle is 420.49 KiB.
- 2026-08-14: Applied only migration `0020_payment_terms.sql` to the isolated development D1 and
  deployed Worker version `ab6d42d7-e2c7-4f25-87b5-ecb25c4851c4`. Follow-up migration inventory
  was empty; remote health/readiness returned `200`, unauthenticated invoice access returned `401`,
  and direct aggregate-only counts confirmed zero organizations and zero invoices. Three automatic
  Cron workflow audits now prove the five-minute dispatcher is firing; all are correctly `partial`
  because due unported schedules are explicitly reported. No route, provider secret, seeded billing
  row, or disabled mutation/delivery flag changed.
- 2026-08-14: Ported both daily 90-day webhook-retention schedules. Outbound delivery rows are
  deleted in bounded batches; inbound receipt deletion transactionally records R2 cleanup work and
  retries object deletion after synthetic storage failure. All 72 Workers-runtime tests pass across
  21 files; all 21 migrations replay from empty D1 state, generated bindings and the
  cross-repository inventory are current, and the dry-run bundle is 423.91 KiB.
- 2026-08-14: Applied only migration `0021_webhook_retention.sql` to isolated development D1 and
  deployed Worker version `c43221c5-a5ad-45e8-ad30-b068f493ddee`. Follow-up migration inventory was
  empty; remote health/readiness returned `200`, unauthenticated webhook-endpoint access returned
  `401`, and direct aggregate-only counts confirmed zero organizations, receipts, deliveries, and
  cleanup tasks. The stack remains unseeded with no route, provider secret, or enabled mutation,
  provider-read, or outbound-delivery flag.
- 2026-08-14: Added immutable invoice issuing/expected-finalization dates, tenant-scoped
  `PUT /api/v1/invoices/:id/finalize`, and the replay-safe legacy hourly finalization executor.
  Invoice due dates and PDFs retain the issuing date instead of substituting the later processing
  time. All 74 Workers-runtime tests pass across 22 files; all 22 migrations replay from empty D1
  state, generated bindings and cross-repository inventory are current, and the dry-run bundle is
  429.15 KiB.
- 2026-08-14: The first read-only D1 inventory call returned transient Cloudflare API code `7500`;
  a retry showed exactly `0022_invoice_finalization.sql`. Applied only that migration and deployed
  Worker version `d4ccd896-36fb-4a48-95ae-710b5ce5529e`. Follow-up migration inventory was empty;
  remote health/readiness returned `200`, unauthenticated finalization returned `401`, and direct
  aggregate-only counts confirmed zero organizations, invoices, and drafts. Eight Cron audits now
  exist; no route, secret, seeded billing row, or disabled mutation/delivery flag changed.
- 2026-08-14: Closed the remaining M0 contract gaps with normative money, decimal, time, identifier,
  pagination, error, idempotency, aggregate-boundary, and transaction-proof conventions. Recorded
  an evidence-only SERP capability map: checked-in configuration enables the Lago feature only for
  the safe store, while routing still defaults off unless explicitly selected; the frozen consumer
  surface remains customer upsert, subscription creation, invoice polling, and hosted payment URL.
  No secret value, customer row, deployed environment, production request, or runtime artifact was
  inspected, and `store-new` and `serp-auth` were not modified.
- 2026-08-14: Added positive-grace recurring draft creation, customer grace configuration,
  non-consuming coupon/credit-note/wallet previews, one shared subscription invoice calculator,
  manual and scheduled draft refresh, usage-event refresh flags, refresh-before-finalize, and
  idempotent finalized replay. Finalization alone commits credit allocations. A trigger-backed
  invoice mutation guard proves the losing concurrent batch aborts before destructive line
  replacement, while customer grace changes reschedule existing drafts. Initial grace-period
  subscription invoices fail explicitly until their distinct billing ownership is ported. All 77
  Workers-runtime tests pass across 22 files; all 23 migrations replay from empty D1 state,
  formatting, lint, generated bindings, TypeScript, and the cross-repository inventory are green,
  and the dry-run bundle is 449.44 KiB (81.94 KiB gzip).
- 2026-08-14: Applied only `0023_refreshable_drafts.sql` to the isolated development D1 and deployed
  Worker version `865e26c9-fea7-408a-93a6-4e6fdf12c7d2`. Follow-up migration inventory was empty;
  remote health/readiness returned `200`, unauthenticated draft refresh returned `401`, and direct
  aggregate-only counts confirmed zero organizations, invoices, drafts, and mutation guards. The
  five-minute dispatcher has 15 audit rows; all provider/payment/outbound flags remain disabled,
  with no production route, provider secret, or seeded billing data.
- 2026-08-14: Added immutable initial-subscription invoice contexts so positive-grace subscription
  creation now produces a non-consuming draft without fabricating a renewal cycle. Manual and
  scheduled refresh recalculate the plan, coupon, tax, credit-note, and wallet preview; finalization
  alone commits allocations. The existing zero-grace `store-new` checkout contract remains
  finalized and unchanged. All 77 Workers-runtime tests pass across 22 files; all 24 migrations
  replay from empty D1 state, formatting, lint, generated bindings, TypeScript, and the
  cross-repository inventory are green, and the dry-run bundle is 453.19 KiB (82.65 KiB gzip).
- 2026-08-14: Applied only `0024_initial_subscription_drafts.sql` to the isolated development D1
  and deployed Worker version `fe112738-18ba-41b5-a84f-9df1f0cabda9`. Follow-up migration inventory
  was empty; remote health/readiness returned `200`, unauthenticated draft refresh returned `401`,
  and aggregate-only counts confirmed zero organizations, invoices, initial contexts, and mutation
  guards. The five-minute dispatcher has 17 audit rows; all provider/payment/outbound flags remain
  disabled, with no production route, provider secret, or seeded billing data.
- 2026-08-14: Added trigger-backed draft dependency invalidation for supported subscription,
  plan/rating, applied-coupon, tax, credit-note, wallet, and usage mutations. Optimistic writers now
  distinguish at-least-one source change from trigger-touched rows while retaining exact one-row
  outbox/version guards; scheduled expiry reports source entities instead of trigger row counts.
  Integration evidence applies a coupon, renames a subscription, reprices its plan, refreshes the
  same initial draft after each dependency change, and proves credits remain unconsumed until final
  allocation. All 77 Workers-runtime tests pass across 22 files; all 25 migrations replay from
  empty D1 state, formatting, lint, generated bindings, TypeScript, and the cross-repository
  inventory are green, and the dry-run bundle is 453.27 KiB (82.71 KiB gzip).
- 2026-08-14: After one transient read-only Cloudflare API `7403`, `wrangler whoami` confirmed the
  intended SERP account and OAuth scopes and the retry showed exactly
  `0025_draft_dependency_invalidation.sql`. Applied only that migration and deployed isolated Worker
  version `ae1cc8b4-9fc2-4d5d-abb1-095338efd8e0`. Follow-up migration inventory was empty; remote
  health/readiness returned `200`, unauthenticated draft refresh returned `401`, and aggregate-only
  verification confirmed 22 invalidation triggers, zero organizations/invoices/initial contexts/
  mutation guards, and 20 Cron audits. No route, secret, seeded billing data, or disabled external
  flag changed.
- 2026-08-14: Preserved refresh/finalization for existing drafts after an explicit
  `on_termination_invoice=skip&on_termination_credit_note=skip` transition. Recurring close still
  selects only active/past-due subscriptions, while draft refresh may load a terminated historical
  subscription through its immutable invoice context. Termination now flags the draft, retains the
  exact one-row outbox guard, and remains replay-safe. Integration evidence terminates after coupon,
  rename, and reprice refreshes, then refreshes and finalizes the same initial draft without double
  allocation. All 77 Workers-runtime tests pass across 22 files; all 26 migrations replay from
  empty D1 state, formatting, lint, generated bindings, TypeScript, and the cross-repository
  inventory are green, and the dry-run bundle is 453.74 KiB (82.78 KiB gzip).
- 2026-08-14: Applied only `0026_terminated_draft_refresh.sql` to the isolated development D1 and
  deployed Worker version `8b98d25b-d945-44cb-8eab-70626a71c056`. Follow-up migration inventory was
  empty; remote health/readiness returned `200`, unauthenticated skip/skip termination returned
  `401`, and aggregate-only verification confirmed all 22 invalidation triggers, zero
  organizations/invoices/initial contexts/mutation guards, and 21 Cron audits. No route, secret,
  seeded billing data, or disabled external flag changed.
- 2026-08-14: Added Lago-compatible `POST /api/v1/events/batch` for 1-100 events with indexed
  validation errors, in-batch and persisted transaction-ID conflict detection, deterministic R2
  archives, one atomic D1 event/outbox batch, trigger-backed draft invalidation, and safe cleanup of
  archives that are not referenced by a concurrent committed event. The event-show route is now
  covered by executable evidence. All 78 Workers-runtime tests pass across 22 files; all 26
  migrations replay from empty D1 state, formatting, lint, generated bindings, TypeScript, and the
  cross-repository inventory are green, and the dry-run bundle is 461.65 KiB (84.09 KiB gzip).
- 2026-08-14: Confirmed no remote migration was pending and deployed the event-batch code as
  isolated Worker version `96a7f31c-ae48-4e6b-9e44-980095c15080`. Remote health/readiness returned
  `200`, unauthenticated batch ingestion returned `401`, and aggregate-only verification confirmed
  zero organizations, usage events, and invoices plus 23 Cron audits. No route, secret, seeded
  billing data, or disabled external flag changed.
- 2026-08-14: Added the retained future-start subset for subscriptions. A normalized future UTC
  `subscription_at` now creates a replay-safe pending subscription with no invoice; the original
  five-minute activation slot atomically starts due subscriptions, creates their initial invoice,
  and records `subscription.started` plus the invoice event. New backdated requests fail explicitly,
  while immediate checkout behavior and frozen `store-new` fixtures remain unchanged. All 80
  Workers-runtime tests pass across 22 files; all 27 migrations replay from empty D1 state,
  formatting, lint, generated bindings, TypeScript, and the cross-repository inventory are green,
  and the dry-run bundle is 474.90 KiB (86.26 KiB gzip).
- 2026-08-14: Applied only `0027_pending_subscription_activation.sql` to the isolated development
  D1 and deployed Worker version `3ae66da8-ca93-4f54-b521-a8fc95159831`. Follow-up migration
  inventory was empty; remote health/readiness returned `200`, unauthenticated future subscription
  creation returned `401`, and aggregate-only verification confirmed zero organizations,
  subscriptions, pending subscriptions, and invoices plus 27 Cron audits. No route, secret, seeded
  billing data, or disabled external flag changed.
- 2026-08-14: Extended the future-start state machine with optimistic pending rescheduling and
  idempotent pending cancellation. Rescheduling changes the activation owner’s due instant and
  rejects backdating; cancellation records `canceled_at` plus the legacy-compatible
  `subscription.terminated` event, creates no invoice, and makes later activation a no-op. Active
  termination still requires explicit skip/skip until final proration and termination-credit
  ownership is ported. All 81 Workers-runtime tests pass across 22 files; formatting, lint,
  generated bindings, TypeScript, inventory, and the dry-run bundle are green at 478.59 KiB
  (86.71 KiB gzip). No migration is required beyond `0027`.
- 2026-08-14: Confirmed no remote migration was pending and deployed pending management as isolated
  Worker version `10c3a8f0-efb9-42b1-b015-960827a3bf9a`. Remote health/readiness returned `200`,
  unauthenticated pending update returned `401`, and aggregate-only verification confirmed zero
  organizations, subscriptions, and invoices plus 28 Cron audits. No route, secret, seeded billing
  data, or disabled external flag changed.
- 2026-08-14: Corrected initial subscription billing ownership to honor the plan’s persisted
  `pay_in_advance` mode. Plan create/update now accepts the base-plan flag before attachment;
  immediate and scheduled in-arrears starts create no initial invoice, while pay-in-advance starts
  retain the atomic finalized/draft invoice, credit, tax, wallet, and frozen Store behavior. All 82
  Workers-runtime tests pass across 22 files; formatting, lint, generated bindings, TypeScript,
  inventory, and the dry-run bundle are green at 484.06 KiB (87.18 KiB gzip). No migration is
  required because `plans.pay_in_advance` already exists in the applied schema.
- 2026-08-14: Confirmed no remote migration was pending and deployed initial billing-mode ownership
  as isolated Worker version `b793bf99-d555-46a6-86ac-d01120d24ee1`. Remote health/readiness
  returned `200`, unauthenticated plan creation returned `401`, and aggregate-only verification
  confirmed zero organizations, plans, subscriptions, and invoices plus 30 Cron audits. No route,
  secret, seeded billing data, or disabled external flag changed.
- 2026-08-14: Added distinct recurring line-period evidence for the base subscription fee.
  Pay-in-advance renewals now snapshot the next period while usage and other in-arrears fees retain
  the just-closed period; in-arrears base fees also retain the closed period. The focused billing
  suites passed, an initial full-suite run exposed one existing credit-note timeout under parallel
  load, and the required isolated rerun plus complete rerun then passed all 82 Workers-runtime tests
  across 22 files. Formatting, lint, generated bindings, TypeScript, inventory, and the dry-run
  bundle are green at 484.50 KiB (87.28 KiB gzip). No migration is required.
- 2026-08-14: Confirmed no remote migration was pending and deployed recurring line-period
  ownership as isolated Worker version `bd36a099-39a5-445b-b07a-3fd60fed1e9e`. Remote
  health/readiness returned `200`, unauthenticated invoice access returned `401`, and aggregate-only
  verification confirmed zero organizations, subscriptions, invoices, and invoice lines plus 31
  Cron audits. No route, secret, seeded billing data, or disabled external flag changed.
- 2026-08-14: Completed immediate activation event parity. Both in-arrears and pay-in-advance
  same-day starts now record `subscription.started` transactionally alongside
  `subscription.created` and, when applicable, the initial invoice event; future activation already
  used the same event identity. The frozen Store fixture now proves all three immediate checkout
  events without changing its request. All 82 Workers-runtime tests pass across 22 files;
  formatting, lint, generated bindings, TypeScript, inventory, and the dry-run bundle are green at
  486.31 KiB (87.44 KiB gzip). No migration is required.
- 2026-08-14: Deployed immediate activation events as isolated Worker version
  `9e9dbdd0-23fd-4901-ae49-060db143ddff`. The first read-only migration inventory request returned
  transient Cloudflare authorization error `7403`; no migration command ran, although the shell
  continued to the code-only deploy. The immediate retry confirmed no pending migration. Remote
  health/readiness returned `200`, unauthenticated subscription creation returned `401`, and
  aggregate-only verification confirmed zero organizations, subscriptions, invoices, and outbox
  events plus 32 Cron audits. No route, secret, seeded billing data, or disabled external flag
  changed.
- 2026-08-14: Added the first final-termination invoice subset for zero-grace in-arrears plans
  without fixed charges or minimum commitments. Base fees use legacy-compatible inclusive UTC
  civil-day proration with exact decimal intermediates; usage remains half-open through the next
  UTC-day boundary, capped at the original period end. Invoice header, lines, coupons, taxes,
  credit-note/wallet allocations, subscription transition, and both outbox events commit in one
  guarded D1 batch. Pay-in-advance credits/final invoices, grace-period drafts, fixed-charge and
  commitment proration, tenant-local dates, and scheduled `ending_at` remain explicit guards. The
  exact legacy 1000-cent/2-of-30-day case produces a 67-cent base line, and boundary evidence
  excludes usage at the following midnight. A gate run caught a renewal deterministic-line-key
  regression and its downstream coupon assertion; restoring the frozen renewal key resolved both.
  Two subsequent parallel runs hit the existing credit-note test's five-second timeout, while its
  isolated retry passed. Consolidating the new termination evidence into the existing lifecycle
  suite retained 22 test files, after which the complete 84-test run passed. Formatting, lint,
  generated bindings, TypeScript, inventory, and the dry-run bundle are green at 500.39 KiB
  (89.71 KiB gzip). No migration is required.
- 2026-08-14: Confirmed no remote migration was pending and deployed in-arrears final termination
  invoices as isolated Worker version `616df085-3589-4f49-906e-34d3c4f66405`. Follow-up migration
  inventory remained empty; remote health/readiness returned `200`, unauthenticated termination
  returned `401`, and aggregate-only verification confirmed zero organizations, subscriptions,
  invoices, and invoice lines plus 37 Cron audits. No route, secret, seeded billing data, or
  disabled external flag changed.
- 2026-08-14: Added the constrained UTC `ending_at` lifecycle for the same zero-grace in-arrears
  plans supported by final termination invoicing. Subscription creation normalizes and validates a
  later UTC civil date, includes it in replay/conflict identity without changing legacy hashes when
  omitted, and rejects pay-in-advance, one-time, fixed-charge, commitment, and positive-grace
  variants. The legacy hourly `:05` registry slot now terminates due rows exactly once, while
  recurring close excludes due endings so an outage or overlap cannot advance their billing period
  first. Pending rescheduling cannot move a start on or after its ending date. All 85
  Workers-runtime tests pass across 22 files; all 28 migrations replay from empty D1 state, and
  formatting, lint, generated bindings, TypeScript, inventory, and the dry-run bundle are green at
  505.36 KiB (90.48 KiB gzip).
- 2026-08-14: Remote inventory showed exactly
  `0028_scheduled_subscription_termination.sql`; applied only that migration, confirmed the
  inventory was empty, and deployed isolated Worker version
  `bdd3b5db-bae8-4765-9482-1eeb01068ce3`. Remote health/readiness returned `200`, unauthenticated
  ending creation returned `401`, and aggregate-only verification confirmed the ending index, zero
  organizations, subscriptions, scheduled endings, and invoices plus 39 Cron audits. No route,
  secret, seeded billing data, or disabled external flag changed.
- 2026-08-14: Added credit-only unused-period handling for pay-in-advance termination when final
  invoicing is explicitly skipped. The service locates the immutable base line for the current
  initial or renewal period, computes unused UTC civil days with exact decimal arithmetic, caps the
  amount by the line's remaining creditable balance, and writes the credit note/item, subscription
  transition, and both outbox events in one version-guarded D1 batch. The initial safe subset
  requires a finalized source invoice with no coupon, tax, wallet, or prior credit-note allocation;
  refunds, offsets, source-allocation adjustments, and pay-in-advance final usage invoices remain
  explicit guards. The complete 85-test Workers suite passes across 22 files; formatting, lint,
  generated bindings, TypeScript, inventory, and the dry-run bundle are green at 515.29 KiB
  (91.94 KiB gzip). No migration is required.
- 2026-08-14: Confirmed no remote migration was pending and deployed unused advance-period credits
  as isolated Worker version `958a6269-1741-404d-b76c-0363a4f54e09`. Follow-up inventory remained
  empty; remote health/readiness returned `200`, unauthenticated termination returned `401`, and
  aggregate-only verification confirmed zero organizations, subscriptions, invoices, credit notes,
  and credit-note items plus 40 Cron audits. No route, secret, seeded billing data, or disabled
  external flag changed.
- 2026-08-14: Added the complementary pay-in-advance termination mode. With
  `on_termination_credit_note=skip`, the final calculator omits the already-paid base line and
  persists only bounded in-arrears usage, taxes, and supported invoice credits before transitioning
  the subscription. Executable evidence proves the subscription retains one initial base invoice
  and adds one 25-cent usage-only invoice for ten units at 2.5 cents. The combined final-invoice plus
  unused-period-credit command remains guarded until both ledgers can commit atomically. Two long
  integration tests crossed Vitest's default five-second timeout under parallel SMB/Miniflare load;
  the suite timeout is now 10 seconds, after which the full 85-test run passed across 22 files.
  Formatting, lint, generated bindings, TypeScript, inventory, and the dry-run bundle are green at
  515.47 KiB (91.96 KiB gzip). No migration is required.
- 2026-08-14: Confirmed no remote migration was pending and deployed pay-in-advance termination
  usage as isolated Worker version `b4be3c4d-1958-4c13-9a59-b875967b34e4`. Follow-up inventory
  remained empty; remote health/readiness returned `200`, unauthenticated termination returned
  `401`, and aggregate-only verification confirmed zero organizations, subscriptions, invoices,
  invoice lines, and credit notes plus 42 Cron audits. No route, secret, seeded billing data, or
  disabled external flag changed.
- 2026-08-14: Extended immediate and scheduled final termination invoices with the already-supported
  non-prorated, pay-in-arrears fixed-charge subset. Lago's upgrade scenarios prove those fees remain
  full on a partial final period, unlike explicitly prorated fixed charges; executable Worker
  evidence now retains a 250-cent fixed fee while prorating the base to two of 30 UTC service days,
  and proves a due `ending_at` emits that fixed line exactly once. Minimum commitments remain
  guarded because Lago prorates their threshold in the customer timezone and reconciles fees across
  the commitment window, which is broader than the current single-invoice implementation. The full
  85-test suite passes across 22 files; formatting, strict lint, inventory, generated bindings,
  TypeScript, and the dry-run bundle are green at 514.93 KiB (91.86 KiB gzip). No migration is
  required.
- 2026-08-14: Confirmed no remote migration was pending and deployed fixed-charge termination as
  isolated Worker version `8768d17b-b3f7-4ddd-9a70-ee6d0f4f2b9b`. Follow-up inventory remained
  empty; remote health/readiness returned `200`, unauthenticated termination returned `401`, and
  aggregate-only verification confirmed zero organizations, subscriptions, invoices, invoice
  lines, fixed charges, and minimum commitments plus 44 Cron audits. No route, secret, seeded
  billing data, or disabled external flag changed.
- 2026-08-14: Added in-arrears minimum-commitment reconciliation to immediate and scheduled final
  termination invoices. The catalog already rejects usage split billing and fixed-charge split
  billing for plans carrying fixed fees, so the supported commitment window has exactly one final
  invoice. The Worker applies the same inclusive UTC service-day coefficient as the base line,
  rounds the commitment target before subtracting rounded and precise subscription/usage/fixed
  fees, and records the target and coefficient in immutable line metadata. Exact evidence turns a
  6,000-cent threshold into 400 cents for two of 30 days and writes the remaining 53-cent rounded /
  53.333333333333333333-cent precise true-up after 346.666666666666666667 cents of fees. Scheduled
  execution writes one commitment line exactly once. Pay-in-advance commitments remain guarded
  before command reservation for every termination mode because their previous-invoice ownership
  differs. All 85 tests pass across 22 files; formatting, strict lint, inventory, generated
  bindings, TypeScript, and the dry-run bundle are green at 516.31 KiB (92.03 KiB gzip). No
  migration is required.
- 2026-08-14: The first read-only remote migration preflight returned Cloudflare authorization code
  `7403`, and the chained command correctly prevented deployment. `wrangler whoami` then confirmed
  the OAuth identity, SERP account, and D1 permission; a repeated preflight showed no pending
  migrations and deployed termination commitments as isolated Worker version
  `2e42da12-3232-45eb-a15a-2096f5baa26e`. Follow-up inventory remained empty; remote
  health/readiness returned `200`, unauthenticated termination returned `401`, and aggregate-only
  verification confirmed zero organizations, subscriptions, invoices, invoice lines, fixed
  charges, and minimum commitments plus 46 Cron audits. No route, secret, seeded billing data, or
  disabled external flag changed.
- 2026-08-14: Ported Lago's default pay-in-advance termination ordering. A reusable preparation
  phase derives the exact unused UTC-period credit without writing; the final command then creates
  the credit note/item and `credit_note.created` outbox row, finalizes bounded in-arrears usage,
  applies existing balances followed by the newly created note, considers wallet lots only for the
  remainder, terminates the subscription, and records invoice/subscription events in one ordered D1
  batch. Executable evidence applies 25 cents from the new note to a 25-cent usage invoice, leaves
  the unused remainder available, preserves an eligible 100-cent fallback wallet untouched, proves
  created-before-applied outbox order, replays without duplicate invoices/notes/applications, and
  injects a post-credit invoice failure to prove the entire ledger transition rolls back. The
  separate credit-only and usage-only modes remain intact. All 85 tests pass across 22 files;
  formatting, strict lint, generated inventory/types, TypeScript, and the dry-run bundle are green
  at 519.00 KiB (92.48 KiB gzip). No migration is required.
- 2026-08-14: Confirmed no remote migration was pending and deployed the combined pay-in-advance
  termination ledger as isolated Worker version `c80d6528-7953-4183-a52a-0f00863b5b81`.
  Follow-up inventory remained empty; remote health/readiness returned `200`, unauthenticated
  termination returned `401`, and aggregate-only verification confirmed zero organizations,
  subscriptions, invoices, invoice lines, credit notes, credit-note applications, wallets, and
  outbox events plus 49 Cron audits. No route, secret, seeded billing data, or disabled external
  flag changed.
- 2026-08-14: Added positive-grace in-arrears termination drafts for both immediate and scheduled
  lifecycle paths. Migration `0029_termination_invoice_drafts.sql` expands the immutable
  subscription invoice context with a distinct termination type, original period boundaries, and
  termination instant, so refresh/finalization never depend on the subscription's shortened current
  period. Draft creation previews coupons, finalized credit-note balances, and wallet lots without
  consuming them; manual refresh remains non-consuming and finalization alone commits allocations.
  Replay creates one draft/event/allocation, while an injected late subscription-transition abort
  proves the entire D1 batch rolls back. Pay-in-advance grace remains explicitly guarded because its
  source credit note is itself draft until the prepaid invoice finalizes in Lago. All 88 tests pass
  across 22 files; all 29 migrations replay from an empty local D1, and formatting, strict lint,
  generated inventory/types, TypeScript, and the dry-run bundle are green at 520.83 KiB (92.94 KiB
  gzip).
- 2026-08-14: Remote inventory showed exactly `0029_termination_invoice_drafts.sql`; applied only
  that migration, confirmed the follow-up inventory was empty, and deployed positive-grace
  termination drafts as isolated Worker version `68149384-b3cd-4cb4-8b25-de6f366e55e0`. Remote
  health/readiness returned `200`, unauthenticated termination returned `401`, and aggregate-only
  verification confirmed the new termination-context column, zero organizations, subscriptions,
  invoices, invoice lines, invoice contexts, and outbox events plus 53 Cron audits. No route,
  secret, seeded billing data, or disabled external flag changed.
- 2026-08-14: Ported Lago's positive-grace pay-in-advance termination coupling. Migration
  `0030_draft_termination_credit_notes.sql` adds a non-allocatable credit-note state and immutable
  source/ratio context without exposing draft balances to the general credit allocator. Termination
  creates the source-linked draft note and termination invoice atomically; source refresh preserves
  item identity and creation time while recomputing the exact unused/full-period ratio, and source
  finalization writes the invoice event before making the note allocatable and emitting
  `credit_note.created`. The termination draft rejects early finalization, then applies the note
  before any wallet lot. Hourly due-invoice ordering handles the same source-before-termination
  dependency. Evidence covers deliberate 422 guards, repricing, non-consuming refresh, injected
  late-batch rollback, event order, wallet precedence, replay, and scheduled finalization. All 90
  tests pass across 23 files; all 30 migrations replay from an empty local D1, and formatting,
  strict lint, generated inventory/types, TypeScript, and the dry-run bundle are green at 529.07 KiB
  (94.51 KiB gzip). The still-draft source remains guarded when its calculation contains coupon,
  tax, wallet, or finalized-credit adjustments.
- 2026-08-14: Remote inventory showed exactly
  `0030_draft_termination_credit_notes.sql`; applied only that migration and confirmed the follow-up
  inventory was empty before deploying isolated Worker version
  `f4fd52ff-083f-4e40-9240-ccec9b24091c`. Remote health/readiness returned `200`, unauthenticated
  termination returned `401`, and the deployed version retained the three disabled external-action
  flags and only the existing isolated bindings/triggers. Aggregate-only verification confirmed the
  allocation-state column, termination-credit context table, guarded application trigger, zero
  organizations, subscriptions, invoices, invoice lines, invoice contexts, credit notes,
  termination-credit contexts, credit-note applications, wallets, and outbox events plus 59 Cron
  audits. No route, secret, or billing data changed.
- 2026-08-14: Recovered Lago's persisted subscription termination-action and ending-update
  semantics. Migration `0031_subscription_termination_actions.sql` adds constrained nullable
  invoice and credit-note actions. Creation identity/replay includes supplied actions without
  changing legacy hashes when omitted; supported active and pending updates can set or clear a
  future UTC `ending_at`, and in-arrears credit-action updates retain Lago's ignored/null behavior.
  Manual termination honors stored actions unless a validated query override is supplied, and the
  hourly ending owner now uses the same stored defaults. The no-invoice transition and its outbox
  event share a guarded D1 batch. Evidence covers exact creation replay and divergent conflict,
  manual override persistence, safe scheduling and clearing, exactly-once scheduled skips,
  pay-in-advance credit/skip combinations, unsupported refund/offset and in-arrears creation guards,
  tenant isolation, injected batch rollback, and a stale-version orphan-event check. All 94 tests
  pass across 24 files; all 31 migrations replay from an empty local D1, and formatting, strict
  lint, generated inventory/types, TypeScript, and the dry-run bundle are green at 538.35 KiB
  (95.72 KiB gzip). At this pre-deployment checkpoint, the isolated remote stack remained at
  migration `0030` and Worker version `f4fd52ff-083f-4e40-9240-ccec9b24091c`.
- 2026-08-14: Remote preflight showed exactly `0031_subscription_termination_actions.sql`; applied
  only that migration and confirmed the follow-up inventory was empty before deploying isolated
  Worker version `f83c6e7a-0d6b-4e2b-a9b5-d987096cfab4`. Remote health/readiness returned `200`,
  unauthenticated termination returned `401`, and the deployed version retained the three disabled
  external-action flags and only the existing isolated bindings/triggers. Aggregate-only
  verification confirmed both new columns, zero organizations, subscriptions, stored subscription
  actions, invoices, credit notes, and outbox events plus 68 Cron audits. No route, secret, or
  billing data changed.
- 2026-08-14: Narrowed the scheduled pay-in-advance guard without exposing unattended source-credit
  ambiguity. Creation and update now admit a future `ending_at` for pay-in-advance subscriptions
  only when the effective persisted `on_termination_credit_note` action is `skip`; the hourly owner
  then honors stored `generate` or `skip` invoice behavior through the same atomic termination
  primitives as manual calls. Default/credit schedules remain rejected, changing an already
  scheduled subscription back to credit is rejected, and clearing the ending permits credit mode
  again. Evidence covers exact creation replay, pre-cutoff/no-op and due/exactly-once execution,
  skip-invoice and generate-invoice outcomes, update/clear invariants, and retained credit guards.
  All 95 tests pass across 24 files; formatting, strict lint, generated inventory/types, TypeScript,
  and the dry-run bundle are green at 538.58 KiB (95.76 KiB gzip). This slice is code-only; the
  remote stack remained on migration `0031` and Worker version
  `f83c6e7a-0d6b-4e2b-a9b5-d987096cfab4` at the pre-deployment checkpoint.
- 2026-08-14: Confirmed remote migration inventory was empty and the isolated database remained
  unseeded before deploying the code-only scheduled-advance slice as Worker version
  `fb10cb7a-a2e1-4dca-a097-3ce9f58de222`. Remote health/readiness returned `200`, unauthenticated
  termination returned `401`, and aggregate-only verification found zero organizations,
  subscriptions, invoices, credit notes, and outbox events plus 70 Cron audits. The deployed version
  retained the three disabled external-action flags and only the existing isolated
  bindings/triggers. No route, secret, migration, or billing data changed.
- 2026-08-14: Ported the coordinated calendar/timezone/free-trial lifecycle. Migration
  `0032_calendar_trial_billing.sql` adds organization/customer timezones, explicit subscription
  billing mode/timezone, immutable trial start/end/ended state, the due index, transition guards,
  and draft invalidation. Subscription creation now uses Lago's calendar default while retaining
  the verified full `store-new` initial checkout amount; anniversary remains explicit. Pending
  activation anchors periods and trials to the supplied start rather than scheduler latency.
  Calendar boundaries are half-open UTC instants derived from local civil dates, including DST.
  The hourly `:35` owner closes missed trial-covered periods, defers in-arrears base fees to period
  close, creates one locally prorated pay-in-advance base, coordinates with the `:10` owner at an
  exact boundary, recognizes a base already issued on day one, and persists the trial transition,
  invoice graph, immutable refresh context, and outbox evidence atomically. Evidence covers UTC,
  Europe/Paris DST, Asia/Tokyo grace refresh/finalization, long trials spanning periods, exact and
  missed boundary ordering, in-arrears proration, existing-base suppression, replay, invalid
  timezone/mode rejection, and D1 immutability rollback. All 107 tests pass across 26 files; all 32
  migrations replay from an empty local D1, and formatting, strict lint, generated inventory/types,
  TypeScript, and the dry-run bundle are green at 567.01 KiB (100.26 KiB gzip). At this
  pre-deployment checkpoint, the isolated remote stack remains on migration `0031` and Worker
  version `fb10cb7a-a2e1-4dca-a097-3ce9f58de222`.
- 2026-08-14: Remote preflight showed exactly `0032_calendar_trial_billing.sql` and zero
  organizations, customers, plans, subscriptions, invoices, credit notes, and outbox events plus
  77 Cron audits. Applied only that migration in 10.88 ms, confirmed the follow-up inventory was
  empty, and verified both timezone columns plus all five subscription billing/trial columns before
  deploying isolated Worker version `074a28d2-6d22-48e0-aad7-6c27a04e5b8c`. Remote
  health/readiness returned `200`/`200`, unauthenticated subscription access returned `401`, and
  the aggregate inventory remained empty. The deployed version retained the three disabled
  external-action flags and only the existing isolated bindings/triggers. No route, secret, or
  billing data changed.
- 2026-08-14: Ported immutable subscription plan generations and their monetary transition owner.
  Migration `0033_subscription_generations.sql` replaces the single-row external-ID constraint with
  one-active/one-pending partial uniqueness, previous/generation history, multi-subscription invoice
  ownership, immutable plan-change draft contexts, and external-chain usage-event deduplication.
  Same-currency annualized upgrades transition immediately; downgrades transition at the exact old
  period boundary. The invoice calculation now allocates coupons, taxes, credit-note balances, and
  wallets once across combined old/new fee lines. Finalized unused prepaid credit is created and
  applied before wallet credit in the same batch. Draft refresh/finalization reproduces both
  generation windows, termination cancels a queued downgrade atomically, and usage events resolve
  half-open generation timestamps. Prepaid upgrades backed by a still-draft source remain an
  explicit `422` guard. Evidence covers replay, concurrent convergence, late failure rollback,
  prepaid credit, grace refresh/finalization, downgrade rotation/replay, queued cancellation, and
  initial-future in-place plan replacement, and the unchanged `store-new` conflict contract. All
  117 tests pass across 27 files; formatting,
  strict lint, generated inventory/types, TypeScript, and a 614.98 KiB (108.37 KiB gzip) dry-run
  bundle are green. All 33 migrations replayed from empty D1 with no foreign-key violations. This
  is a local pre-deployment checkpoint: isolated remote D1 and Worker remain on migration `0032`
  and version `074a28d2-6d22-48e0-aad7-6c27a04e5b8c`.
- 2026-08-14: Remote preflight showed exactly `0033_subscription_generations.sql` pending and zero
  organizations, customers, plans, subscriptions, invoices, credit notes, and outbox events. Applied
  only that migration to isolated D1 `2f32f159-c269-46c6-a4dd-9e38477f5d25`; follow-up inventory
  was empty, `PRAGMA foreign_key_check` returned no rows, and verification found 33 migrations, all
  10 generation invalidation triggers, the transition-consistency trigger, and all three expected
  uniqueness indexes. Deployed isolated Worker version
  `6f198ceb-959d-486a-ba64-6b7ca88a6fa3` with the existing bindings and all three external-action
  flags still `0`. Remote health/readiness returned `200`/`200`, unauthenticated subscription access
  returned `401`, and aggregate-only verification remained empty for every billing entity. No
  production route, domain, secret, provider action, or billing record changed.
- 2026-08-14: Completed prepaid grace-period upgrade coordination without a schema change. Every
  initial, trial-end, recurring, termination, and plan-change subscription invoice now records its
  `invoice_subscriptions` ownership edge. Unused-period credit source lookup follows that graph and
  the exact plan line, so a later prepaid generation can be upgraded again even when the prior
  combined invoice header belongs to an older generation. Draft credit-note repricing preserves the
  source plan line across refresh, allows earlier finalized credit-note applications without
  treating them as line discounts, blocks premature dependent finalization, and lets the hourly
  owner defer/retry source chains in one run. Evidence covers manual source-first finalization,
  scheduled second-upgrade finalization, ownership, replay, and dependent application rollback. All
  119 tests pass across 27 files; formatting, strict lint, generated inventory/types, TypeScript,
  and a 618.32 KiB (108.87 KiB gzip) dry-run bundle are green. This is a code-only local checkpoint;
  isolated remote D1 remains on migration `0033` and Worker version
  `6f198ceb-959d-486a-ba64-6b7ca88a6fa3`.
- 2026-08-14: Code-only remote preflight found no pending migrations and zero organizations,
  customers, plans, subscriptions, invoices, credit notes, and outbox events. Deployed prepaid
  grace-upgrade coordination as isolated Worker version
  `52f2f3e2-d402-4c9c-bb04-be095fe5b7f8` with the existing bindings and all external-action flags
  still `0`. Remote health/readiness returned `200`/`200`, unauthenticated subscription access
  returned `401`, and post-deploy aggregate-only verification remained empty for every billing
  entity. No production route, domain, secret, provider action, migration, or billing record
  changed.
- 2026-08-14: Ported Lago's backdated subscription activation contract for supported recurring
  plans. A normalized start on an earlier customer-local day now persists as both the historical
  subscription/start instant, emits exactly one created/started event pair, generates no
  retroactive invoice (including pay-in-advance plans), and advances calendar or anniversary
  boundaries to the half-open period containing creation time. The normal close owner then bills
  that current period or next prepaid service period exactly once; replay reuses the same row and
  invoice. Backdated one-time plans remain guarded. Evidence covers month-end clamping, DST-aware
  calendar catch-up, zero-invoice creation, event and row idempotency, the next prepaid period, and
  close replay. All 122 tests pass across 27 files; formatting, strict lint, generated inventory/
  types, TypeScript, and a 619.97 KiB (109.20 KiB gzip) dry-run bundle are green. This is a code-only
  local checkpoint; isolated remote D1 remains on migration `0033` and Worker version
  `52f2f3e2-d402-4c9c-bb04-be095fe5b7f8`.
- 2026-08-14: Code-only remote preflight found no pending migrations and zero organizations,
  customers, plans, subscriptions, invoices, credit notes, and outbox events plus 96 Cron audits.
  Deployed backdated recurring activation as isolated Worker version
  `f88803aa-0b4c-4a9c-a707-fb153280d706` with the existing bindings and all external-action flags
  still `0`. Remote health/readiness returned `200`/`200`, unauthenticated subscription access
  returned `401`, and post-deploy aggregate-only verification remained empty for every billing
  entity. No production route, domain, secret, provider action, migration, or billing record
  changed.
- 2026-08-14: Ported the subscription-level payment-policy subset without conflating checkout
  labels with Lago provider method IDs. Migration `0034_subscription_payment_policy.sql` adds
  constrained policy/id columns and insert/update guards. Create and update now persist `manual`,
  provider-default, or a cleared override; pending replacement, upgrade, and downgrade generations
  inherit the current policy unless explicitly changed. Provider-specific IDs remain an explicit
  `422` until the tenant-scoped method registry exists. Evidence covers create serialization,
  pending plan replacement, provider-default update, clear, rejected ID non-mutation, existing plan
  transitions, and D1 guards. All 123 tests pass across 27 files; all 34 migrations replay from
  empty D1 with no foreign-key violations, and formatting, strict lint, generated inventory/types,
  TypeScript, and a 624.07 KiB (109.88 KiB gzip) dry-run bundle are green. At this local
  pre-deployment checkpoint, isolated remote D1 remained on migration `0033` and Worker version
  `f88803aa-0b4c-4a9c-a707-fb153280d706`.
- 2026-08-14: Remote preflight showed exactly `0034_subscription_payment_policy.sql` pending and
  zero organizations, customers, plans, subscriptions, invoices, credit notes, and outbox events
  plus 98 Cron audits. Applied only that migration, confirmed the follow-up inventory was empty,
  and verified 34 migrations, both policy columns and guards, and no foreign-key violations before
  deploying isolated Worker version `943b9159-4f62-4f52-9061-a3424f578e0c`. Remote
  health/readiness returned `200`/`200`, unauthenticated subscription access returned `401`, and
  aggregate-only verification remained empty. The deployed version retained all three disabled
  external-action flags and only the existing isolated bindings/triggers. No production route,
  domain, secret, provider action, or billing record changed.
- 2026-08-14: Ported the explicit subscription invoice custom-section slice and documented its
  tenant-scoped REST catalog as the Worker equivalent for the corresponding operator GraphQL
  workflow. Migration `0035_invoice_custom_sections.sql` adds the active manual-section catalog,
  subscription selection/skip state, tenant and immutability triggers, draft invalidation, and
  immutable invoice snapshots. Create/update follows Lago's explicit and implicit skip semantics,
  silently ignores unknown codes, preserves omitted selections during pending-row plan
  replacement, and starts upgrade/downgrade generations clean unless the replacement request
  supplies selections. Draft refresh recopies current catalog content; finalization freezes it for
  invoice API and escaped Browser Rendering/PDF output. Bulk list projection avoids per-row D1
  queries. Evidence covers catalog replay/conflict/termination/recreation, outbox rollback, tenant
  isolation and injected relationship/snapshot mutation, subscription replay divergence,
  attach/skip/restore, draft refresh/finalized immutability, every plan-generation transition, and
  rendered HTML/PDF content. All 128 tests pass across 28 files; all 35 migrations replay from an
  empty D1 with no foreign-key violations and 11 custom-section guards/triggers, while formatting,
  strict lint, generated inventory/types, TypeScript, and a 651.71 KiB (113.70 KiB gzip) dry-run
  bundle are green. Customer/billing-entity defaults, system-generated sections, wallet targets,
  and the remaining operator UI are still pending. This is a local pre-deployment checkpoint;
  isolated remote D1 remains on migration `0034` and Worker version
  `943b9159-4f62-4f52-9061-a3424f578e0c`.
- 2026-08-14: Remote preflight showed exactly `0035_invoice_custom_sections.sql` pending, no
  foreign-key violations, and zero organizations, customers, plans, subscriptions, invoices,
  catalog sections, snapshots, and outbox events plus 107 Cron audits. Applied only that migration
  in 6.87 ms, confirmed the follow-up inventory was empty, and verified 35 migrations, all three
  section tables, the subscription skip column, and 11 guards/triggers before deploying isolated
  Worker version `ce135113-31fc-4078-981f-d439a03db5ae`. Remote health/readiness returned
  `200`/`200`, unauthenticated catalog access returned `401`, and post-deploy aggregate-only
  verification remained empty with no FK violations. The deployed version retains all three
  external-action flags at `0` and only the existing isolated bindings/triggers. No production
  route, domain, secret, provider action, or billing/catalog record changed.
- 2026-08-14: Ported customer and retained single-billing-entity custom-section defaults.
  Migration `0036_customer_invoice_custom_sections.sql` adds customer skip state, versioned
  organization-default state, tenant-checked customer/default relationships, draft invalidation,
  and two read-only precedence views shared by recurring and one-off invoice snapshots. Customer
  upsert/update now supports Lago's top-level replace/skip inputs and returns bulk-loaded applicable
  sections. Authenticated `GET`/`PUT` on
  `/api/v1/billing_entities/default/invoice_custom_sections` is the documented equivalent for the
  current one-entity-per-organization subset; other billing-entity identifiers fail explicitly.
  Selection precedence is subscription override, subscription/customer skip, customer manual
  selection, then organization default. Provider-created system sections and multi-entity routing
  remain guarded rather than inferred. Evidence covers ignored/duplicate codes, idempotent
  defaults, transactional outbox rollback, customer replace/skip/fallback, resource override,
  draft invalidation/refresh, one-off finalized snapshots, and cross-tenant injection. All 130
  tests across 28 files pass in bounded Workers-runtime batches; all 36 migrations replay from an
  empty local D1 with no foreign-key violations, five section tables, 21 related triggers, and two
  precedence views. Formatting, strict lint, generated inventory/types, TypeScript, and a 669.37
  KiB (116.57 KiB gzip) dry-run bundle are green. This is a local pre-deployment checkpoint;
  isolated remote D1 remains on migration `0035` and Worker version
  `ce135113-31fc-4078-981f-d439a03db5ae`.
- 2026-08-14: Remote preflight showed exactly
  `0036_customer_invoice_custom_sections.sql` pending, no foreign-key violations, and zero
  organizations, customers, plans, subscriptions, invoices, catalog sections, snapshots, and
  outbox events plus 113 schedule audits. Applied only that migration in 10.78 ms, confirmed the
  follow-up inventory was empty, and verified 36 migrations, five section tables, 21 related
  triggers, two precedence views, and no foreign-key violations. Deployed isolated Worker version
  `fe2fb69c-b113-438f-884f-b6b5f367b87c`; health/readiness returned `200`/`200`, and
  unauthenticated catalog/default-selection access returned `401`/`401`. Post-deploy
  aggregate-only verification remained empty. The deployed version retains all three
  external-action flags at `0` and only the existing isolated bindings/triggers. No production
  route, domain, secret, provider action, or billing/catalog/default record changed.
- 2026-08-15: Ported wallet and granted wallet-transaction invoice custom-section selections as
  resource API compatibility, without adding them to invoice precedence. Legacy evidence shows
  that wallet create/update and transaction create use the shared attach/skip service, while the
  paid-credit invoice service applies customer configuration without passing either wallet
  resource. Migration `0037_wallet_invoice_custom_sections.sql` adds both skip fields, two
  tenant-checked relationship tables, and four tenant/immutability triggers. Wallet create/update,
  list/show, granted transaction create/replay/show/list, catalog termination cleanup, and bulk
  selection serialization are implemented. Recurring top-up-rule selections remain coupled to the
  unported recurring wallet engine. Evidence covers unknown-code normalization, create replay and
  divergence, implicit/explicit skip, restore, transaction idempotency conflict, catalog cleanup,
  cross-tenant rejection, and injected outbox rollback. All 132 tests across 28 files pass in
  bounded Workers-runtime batches; all 37 migrations replay from an empty local D1 with no
  foreign-key violations, two wallet-section tables, four related triggers, and both skip columns.
  Formatting, strict lint, generated inventory/types, TypeScript, and a 681.49 KiB (118.38 KiB
  gzip) dry-run bundle are green. This is a local pre-deployment checkpoint; isolated remote D1
  remains on migration `0036` and Worker version `fe2fb69c-b113-438f-884f-b6b5f367b87c`.
- 2026-08-15: Remote preflight on the explicit SERP account showed exactly
  `0037_wallet_invoice_custom_sections.sql` pending, no foreign-key violations, and zero
  organizations, customers, plans, subscriptions, invoices, catalog sections, wallets, wallet
  transactions, section links, snapshots, and outbox events plus 117 schedule audits. Applied only
  that migration, confirmed the follow-up inventory was empty, and verified 37 migrations, seven
  section tables, 25 related triggers including all four wallet guards, both skip columns, and no
  foreign-key violations. Deployed isolated Worker version
  `a0c0ab74-b4bc-4493-94af-b8128d0535f9`; health/readiness returned `200`/`200`, and
  unauthenticated catalog/wallet access returned `401`/`401`. Post-deploy aggregate-only
  verification remained empty apart from 118 schedule audits. The deployed version retains
  `PAYMENT_MUTATIONS_ENABLED`, `PROVIDER_READS_ENABLED`, and `OUTBOUND_WEBHOOKS_ENABLED` at `0`,
  uses the existing isolated D1/R2/Queue/Durable Object/Workflow/Browser/Cron bindings, and adds no
  production route, domain, secret, provider action, customer data, or billing/catalog/wallet
  record.
- 2026-08-15: Ported the provider-free recurring granted-credit wallet subset. Wallet create/update
  now supports one active fixed interval rule with Lago-compatible in-place update, replacement,
  empty-array termination, metadata, and attach/skip section serialization. The `:50` expiration
  and `:55` top-up schedule owners evaluate weekly/monthly/quarterly/semiannual/yearly anniversaries
  in the customer timezone, clip month-end and leap-day anchors, suppress creation-day top-ups, and
  use a deterministic wallet/local-date key. Interval transactions retain the originating rule ID;
  a D1 trigger requires that exact tenant/wallet rule to remain active and inside its time window.
  Paid credits, target and threshold rules, payment methods, and successful-payment requirements
  fail explicitly. Evidence covers canonical create replay, update/replacement/termination,
  catalog cleanup, cross-tenant injection, outbox rollback, timezone replay, creation-day
  suppression, expiration replay, and clipped anniversaries. All 138 tests across 28 files pass in
  bounded Workers-runtime batches. All 38 migrations replay from an empty local D1 with no
  foreign-key violations, one recurring-rule table, one rule-section table, six related guards,
  transaction metadata, and the originating-rule reference. Formatting, strict lint, generated
  inventory/types, TypeScript, and a 715.63 KiB (125.34 KiB gzip) dry-run bundle are green. This is
  a local pre-deployment checkpoint; isolated remote D1 remains on migration `0037` and Worker
  version `a0c0ab74-b4bc-4493-94af-b8128d0535f9`.
- 2026-08-15: Remote preflight on the explicit SERP account showed exactly
  `0038_recurring_granted_wallet_rules.sql` pending, no foreign-key violations, and zero
  organizations, customers, plans, subscriptions, invoices, catalog sections, wallets, wallet
  transactions, and outbox events plus 124 schedule audits. Applied only that migration in 7.93
  ms, confirmed the follow-up inventory was empty, and verified 38 migrations, both recurring-rule
  tables, all six related guards, transaction metadata and originating-rule columns, and no
  foreign-key violations. Deployed isolated Worker version
  `129d703b-e9c3-4eb1-8172-d33d97c97614`; health/readiness returned `200`/`200`, and
  unauthenticated catalog/wallet access returned `401`/`401`. Post-deploy aggregate-only
  verification found zero tenants, billing/catalog/wallet/rule/link/outbox rows and the same 124
  schedule audits. The deployed version retains all three external-action flags at `0`, uses only
  the existing isolated bindings and workers.dev URL, and adds no production route, domain,
  secret, provider action, customer data, or billing record.
- 2026-08-15: Ported ongoing wallet-balance projection and the provider-free fixed granted-credit
  threshold rule. The five-minute owner reuses the shared subscription invoice calculator, adds
  persisted draft liabilities, and assigns each fee to the first active unrestricted wallet in
  Lago application order; projected usage may exceed settled balance so the serialized ongoing
  balance can be negative. Per-customer D1 batches guard every wallet version, update all
  projections together, record the one-way depleted transition event, clear compatibility refresh
  state, and roll back completely on any stale or failed wallet. Threshold grants compare exact
  minor-unit projected and pending balances, settle one originating-rule-linked granted lot in the
  same batch, preserve metadata/name, and use a deterministic rule/projection-version key. Paid,
  target, successful-payment, provider-method, targeted-wallet, progressive-billing, and dedicated
  organization behavior remains guarded or unported. Evidence covers current calculator reuse,
  draft liability, negative balance, priority assignment, pending suppression, repeat projection,
  trigger-changing rule replacement, expiration, tenant/origin guards, and injected late-batch
  rollback. All 145 tests across 29 files pass in bounded Workers-runtime batches. All 39
  migrations replay from an empty local D1 with no foreign-key violations, five wallet projection
  columns, the threshold-rule table, and three core projection/threshold guards. Formatting,
  strict lint, generated inventory/types, TypeScript, and a 738.13 KiB (128.80 KiB gzip) dry-run
  bundle are green. Feature checkpoint: `7dd0b10`.
- 2026-08-15: Remote preflight on the explicit SERP account showed only
  `0039_wallet_ongoing_balances.sql` pending and zero organizations, customers, invoices, wallets,
  wallet transactions, recurring rules, and outbox events. Applied only that migration, then
  verified 39 migrations, zero foreign-key violations, all five projection columns, the threshold
  table, and all three queried tenant/origin/version guards. Deployed isolated Worker version
  `ad896271-925f-4723-9114-fd7917d9616c` with a 6 ms startup; health/readiness returned
  `200`/`200`, and unauthenticated plan/wallet access returned `401`/`401`. Post-deploy
  aggregate-only verification found zero tenants, invoices, wallets, transactions, interval or
  threshold rules, and outbox rows plus 130 schedule audits. All three external-action flags remain
  `0`; no production route, domain, secret, provider action, customer data, or billing row was
  added.
- 2026-08-15: Ported wallet fee-type and billable-metric limitations. Migration
  `0040_wallet_limitations.sql` adds checked fee-type JSON, the strict wallet-to-metric target
  table, and a cross-tenant insert guard. Create replay hashes resolved targets, unknown or
  cross-tenant metric codes fail before mutation, list/show serialize target codes in bulk, and
  update replaces limitations with the wallet optimistic version and outbox in one D1 batch.
  Invoice settlement builds tax-inclusive per-fee caps, preserves Lago's largest-bucket and wallet
  ordering, drains across applicable wallets subject to settled balances, and retains one outbound
  transaction per wallet. Ongoing projection shares the applicability rules but assigns each fee
  wholly to its first match without capping by settled balance; historical line-less drafts retain
  their aggregate fallback. Event-directed `target_wallet_code` grouping remains guarded until
  charge/event line identity is ported. Evidence covers matching, grouping, priority drain, API
  replay, tenant validation, exact replacement, late outbox rollback, and fee-specific draft
  projection. All 151 tests across 30 files pass in bounded Workers-runtime batches. All 40
  migrations replay from empty local D1 with no foreign-key violations. Formatting, strict lint,
  generated inventory/types, TypeScript, and a 754.08 KiB (132.28 KiB gzip) dry-run bundle are
  green. Feature checkpoint: `941ed72`.
- 2026-08-15: Remote preflight on the explicit SERP account showed only
  `0040_wallet_limitations.sql` pending and zero organizations, customers, invoices, wallets,
  wallet transactions, and outbox rows. Applied only that migration, then verified 40 migrations,
  zero foreign-key violations, zero wallet targets, and zero invalid wallet fee JSON rows. Deployed
  isolated Worker version `d2dffa91-f546-4220-a9df-c05fc5c76d57` with a 4 ms startup;
  health/readiness returned `200`/`200`, and unauthenticated plan/wallet access returned
  `401`/`401`. A first read-only audit query named the nonexistent `schedule_run_audits` table and
  failed without mutation; the corrected `schedule_runs` query found 135 audits. Post-deploy
  aggregate-only verification remained empty for every tenant/billing/wallet/target/outbox entity.
  All three external-action flags remain `0`; no production route, domain, secret, provider action,
  customer data, or billing row was added.
- 2026-08-15: Ported event-directed wallet targeting for supported in-arrears usage charges.
  Migration `0041_event_targeted_wallets.sql` adds the checked `accepts_target_wallet` charge flag
  and its active lookup index. Embedded and standalone charge creation, replay, list/show, and plan
  serialization retain the opt-in. Accepted events group targeted and untargeted usage separately;
  each group is rated independently and receives deterministic invoice-line and persistence IDs,
  while immutable metadata preserves the real charge/metric IDs and Lago invoice serialization.
  Explicit targets override fee/metric limitations in both ongoing projection and finalized wallet
  consumption. Opt-out charges ignore the property and retain their previous line identity and
  metadata. A missing active customer wallet does not reject usage; it adds one transactional,
  replay-safe `event.error` outbox event with `target_wallet_code_not_found`. Evidence covers
  grouped units and fees, exact ongoing balances, exact wallet lots, real charge serialization,
  missing-target replay, opt-out aggregation, malformed-code rejection, catalog replay, and all
  pre-existing billing snapshots. All 154 tests across 31 files pass in bounded Workers-runtime
  batches. All 41 migrations replay from empty local D1 with no foreign-key violations. Formatting,
  strict lint, generated inventory/types, TypeScript, and a 759.99 KiB (133.53 KiB gzip) dry-run
  bundle are green. Feature checkpoint: `a455fbc`.
- 2026-08-15: Remote preflight on the explicit SERP account showed only
  `0041_event_targeted_wallets.sql` pending and zero organizations, customers, invoices, usage
  events, wallets, targets, transactions, and outbox rows. Applied only that migration, then
  verified 41 migrations, zero foreign-key violations, and the new charge column/index. Deployed
  isolated Worker version `d08b6572-2af6-4b44-818e-a522d62b9864` with a 6 ms startup;
  health/readiness returned `200`/`200`, and unauthenticated event/wallet access returned
  `401`/`401`. Post-deploy aggregate-only verification remained empty apart from 140 schedule
  audits. All three external-action flags remain `0`; no production route, domain, secret, provider
  action, customer data, or billing row was added.
- 2026-08-15: Ported the provider-free standalone usage-charge lifecycle. Core updates use tenant
  scope, active metric validation, attached-plan restrictions, exact rating-property validation,
  optimistic versions, conditional transactional outbox rows, and no-op replay. Soft deletion
  removes a charge only from future catalog/rating reads; the existing dependency trigger flags
  affected drafts for refresh, while finalized invoice lines retain their persisted source ID and
  amount. Deterministic charge generations permit safe code reuse after deletion or rename without
  colliding with historical primary keys. Filter, tax, pricing-unit, and child-plan cascades remain
  explicit `422` guards. Evidence covers attached and unattached updates, immutable finalized
  lines, draft invalidation, replay, deletion, guarded cascade input, and code recreation. All 156
  tests across 31 files pass in bounded Workers-runtime batches. Formatting, strict lint, generated
  inventory/types, TypeScript, and a 768.14 KiB (134.49 KiB gzip) dry-run bundle are green. No D1
  migration was required. Feature checkpoint: `18a3332`.
- 2026-08-15: Code-only remote preflight on the explicit SERP account found no pending migrations,
  zero foreign-key violations, and zero organizations, customers, plans, subscriptions, invoices,
  charges, usage events, wallets, targets, transactions, and outbox rows. Deployed isolated Worker
  version `07c31a20-04ea-46ea-bb2e-e3662f032ff7` with a 5 ms startup; health/readiness returned
  `200`/`200`, and unauthenticated charge access returned `401`. Post-deploy aggregate-only
  verification remained empty apart from 143 schedule audits. All three external-action flags
  remain `0`; no production route, domain, secret, provider action, customer data, or billing row
  was added.
- 2026-08-15: Ported the provider-free standalone fixed-charge lifecycle for supported
  pay-in-arrears, non-prorated charges. Migration `0042_fixed_charge_lifecycle.sql` adds checked
  optimistic `version` and `active` state plus the active plan index. Create replay, partial update,
  and soft deletion emit transactional versioned outbox events; attached plans retain only the
  Lago-safe mutable display/units/properties subset. All catalog, invoice-calculation, add-on
  currency, and add-on termination readers exclude inactive rows. Existing mutation triggers flag
  affected drafts for refresh, while finalized invoice lines retain their persisted amounts and
  source IDs. The table's original hard `(plan_id, code)` uniqueness remains authoritative, so
  deleted-code reuse returns the explicit `fixed_charge_code_unavailable` guard rather than a
  database error. Evidence covers create/update replay, attached restrictions, draft invalidation,
  recurring billing, soft deletion, immutable finalized lines, add-on release, unsafe modes, and
  guarded code reuse. All 156 tests across 31 files pass in bounded Workers-runtime batches. All 42
  migrations replay from empty local D1 with no foreign-key violations. Formatting, strict lint,
  generated inventory/types, TypeScript, and a 780.70 KiB (135.97 KiB gzip) dry-run bundle are
  green. Feature checkpoint: `c5fc0eb`.
- 2026-08-15: Remote preflight on the explicit SERP account showed only
  `0042_fixed_charge_lifecycle.sql` pending and zero organizations, customers, plans,
  subscriptions, invoices, usage charges, fixed charges, usage events, wallets, targets,
  transactions, and outbox rows. Applied only that migration, then verified 42 migrations, zero
  foreign-key violations, both checked columns, and the active plan index. Deployed isolated Worker
  version `4bc789fe-9d60-4469-9187-56090ddab77e` with a 5 ms startup; health/readiness returned
  `200`/`200`, and unauthenticated fixed-charge access returned `401`. Post-deploy aggregate-only
  verification remained empty apart from 146 schedule audits. All three external-action flags
  remain `0`; no production route, domain, secret, provider action, customer data, or billing row
  was added.
- 2026-08-15: Ported the provider-free billable-metric lifecycle. Update and deletion use a
  transaction-local D1 mutation guard so a losing concurrent writer cannot emit a false outbox
  event. Deletion atomically soft-deletes the metric and every attached active charge, allowing the
  existing dependency triggers to invalidate affected drafts while finalized invoice lines retain
  their persisted source IDs and amounts. Retired events and wallet targets disappear from API,
  rating, allocation, and projection reads immediately. One durable cleanup task per metric lets
  the five-minute Workflow tombstone raw events and delete immutable R2 archives in bounded,
  retryable batches without making the API request scale with event history. Relational event rows
  remain for audit and idempotency, and deterministic metric generations allow safe same-code
  recreation without colliding with historical primary keys. Evidence covers attached-charge
  cascade, immediate read exclusion, draft invalidation, immutable finalized history, inactive
  wallet targeting, event tombstones, R2 cleanup, cleared mutation guards, repeated deletion, and
  code recreation. All 157 tests across 31 files pass in bounded Workers-runtime groups; the one
  unrelated termination-credit timeout under a fully parallel run passed immediately in isolation.
  All 43 migrations replay from empty local D1 with no foreign-key violations. Formatting, strict
  lint, generated inventory/types, TypeScript, and a 789.20 KiB (137.19 KiB gzip) dry-run bundle
  are green. Feature checkpoint: `5c8a9d5`.
- 2026-08-15: Remote preflight on the explicit SERP account showed only
  `0043_billable_metric_lifecycle.sql` pending and zero organizations, customers, plans,
  subscriptions, invoices, billable metrics, usage charges, fixed charges, usage events, wallets,
  targets, transactions, outbox rows, cleanup tasks, and mutation guards. Applied only that
  migration in 12.49 ms, then verified 43 migrations, zero foreign-key violations, the event
  tombstone column, all three partial active-event indexes, and both cleanup/guard tables. Deployed
  isolated Worker version `487d002b-4eb1-4332-a2a1-676f9211141a` with a 5 ms startup;
  health/readiness returned `200`/`200`, and unauthenticated metric deletion returned `401`.
  Post-deploy aggregate-only verification remained empty apart from 151 schedule audits. All three
  external-action flags remain `0`; no production route, domain, secret, provider action, customer
  data, or billing row was added.
- 2026-08-15: Ported the safe standalone subset of plan retirement. Plans with no subscription
  history now acquire a transaction-local D1 mutation guard, then atomically soft-delete the plan
  and its active usage/fixed charges with exactly one versioned outbox event. Minimum commitments
  and relational catalog rows remain historical, while inactive readers exclude the retired graph.
  Any active, pending, terminated, or canceled subscription edge returns `plan_in_use`; the legacy
  asynchronous terminate/cancel/finalize workflow remains explicit rather than being compressed
  into an unbounded API request. Plan and billable-metric recreation now combine a new deterministic
  ID generation with a monotonic code-scoped aggregate version, closing the repeated-retirement
  collision exposed by their historical unique constraints. Evidence covers scalar updates,
  mutation-guard cleanup, subscription guarding, usage/fixed-charge cascade, retained commitment,
  repeated deletion, and three same-code generations. All 158 tests across 31 files pass in bounded
  Workers-runtime groups. All 44 migrations replay from empty local D1 with no foreign-key
  violations. Formatting, strict lint, generated inventory/types, TypeScript, and a 794.38 KiB
  (138.01 KiB gzip) dry-run bundle are green. Feature checkpoint: `357fbc0`.
- 2026-08-15: Remote preflight on the explicit SERP account showed only
  `0044_standalone_plan_lifecycle.sql` pending. A first read-only aggregate query named the pending
  guard table before migration and failed with `no such table` without mutation; the corrected
  query verified zero organizations, customers, plans, subscriptions, invoices, billable metrics,
  charges, fixed charges, usage events, wallets, and outbox rows. Applied only that migration in
  0.41 ms, then verified 44 migrations, zero foreign-key violations, and an empty plan guard table.
  Deployed isolated Worker version `b0a3bd59-f583-4a8c-82dc-84f1119c8b5a` with a 7 ms startup;
  health/readiness returned `200`/`200`, and unauthenticated plan deletion returned `401`.
  Post-deploy aggregate-only verification remained empty apart from 154 schedule audits. All three
  external-action flags remain `0`; no production route, domain, secret, provider action, customer
  data, or billing row was added.
- 2026-08-15: Ported subscription-bearing plan retirement to a dedicated Cloudflare Workflow.
  Migration `0045_plan_deletion_workflow.sql` adds one durable plan task, a closed snapshot of its
  active/past-due/pending subscription generations, deterministic Workflow instance sequencing,
  and database guards that reject new subscription attachment or catalog mutation after
  preparation. The Lago-compatible DELETE remains bounded: it atomically marks the plan pending,
  persists the task/snapshot, and dispatches the Workflow; replay converges on the same task and a
  failed instance can be retried under the next deterministic sequence. Each instance processes
  20 subscriptions or 10 drafts per step for at most 100 rounds, then atomically hands off to a
  continuation; the five-minute reconciliation Workflow repairs any D1-to-Workflow dispatch gap.
  Active generations use their persisted invoice and prepaid-credit actions, pending generations
  are canceled idempotently, every plan-linked draft is recalculated and finalized, and only then
  does one guarded D1 batch retire the plan and active usage/fixed charges with one contiguous
  `plan.deleted` event. Historical subscriptions, invoices, commitments, and catalog rows remain.
  Pay-in-advance minimum-commitment termination and prepaid `refund`/`offset` actions retain their
  existing explicit unsupported failures rather than silently discarding billing obligations.
  Evidence injects a transient Workflow step failure, replays DELETE, verifies concurrent catalog
  and subscription rejection, terminates/cancels two generations, finalizes the termination draft,
  preserves history, and proves one final event. All 160 tests across 31 files pass in bounded
  Workers-runtime groups; all 45 migrations replay from an empty D1. Formatting, strict lint,
  generated inventory/types, TypeScript, and an 822.46 KiB (142.99 KiB gzip) dry-run bundle are
  green. Feature checkpoint: `ae5e7dd`.
- 2026-08-15: Remote preflight on the explicit SERP account showed exactly
  `0045_plan_deletion_workflow.sql` pending and zero organizations, customers, plans,
  subscriptions, invoices, and plan-deletion tasks. Applied only that migration in 1.95 ms,
  confirmed no migrations remained, and verified both task tables plus the catalog/subscription
  guards. Deployed isolated Worker version `46579fbe-39e3-4ccf-8a93-e8cc0a4e19bc` with the new
  `serp-dev-lago-plan-deletion` Workflow binding and an 8 ms startup. Health/readiness returned
  `200`/`200`, unauthenticated plan deletion returned `401`, and post-deploy aggregate-only
  verification remained empty apart from 160 schedule audits. `PAYMENT_MUTATIONS_ENABLED`,
  `PROVIDER_READS_ENABLED`, and `OUTBOUND_WEBHOOKS_ENABLED` remain `0`; no production route,
  domain, secret, provider action, customer data, or billing record changed.
