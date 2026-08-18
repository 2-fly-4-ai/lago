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
SERP services -----------------------> Cloudflare API Worker ----------------+
browser --> Cloudflare Access ------> Cloudflare operator Worker + assets ---+
                                                                              |
                                                                              v
                                                               shared billing domain bindings
                                                                              |
                                                                              +--> BillingAccount Durable Object
                                                                              |      serialized monetary commands
                                                                              |      idempotency and sequence allocation
                                                                              |
                                                                              +--> D1 domain databases
                                                                              |      relational records and reporting projections
                                                                              |
                                                                              +--> Workflows / Queues / DLQs
                                                                              |      retryable commands, events, projections
                                                                              |
                                                                              +--> R2 + Browser Rendering
                                                                              |      invoices, receipts, exports, archives
                                                                              |
                                                                              +--> third-party providers
                                                                                     explicitly enabled integrations only
```

### Compute ownership

- Service request/response APIs run in the TypeScript API Worker. Human browser traffic runs in a
  separate Access-protected operator Worker so identity policy cannot intercept provider webhooks
  or service API clients.
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

- one service API Worker and one separately Access-protected operator Worker, each with separate
  development/staging and production environments;
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
- [x] Implement subscription creation and lifecycle state machine. The retained REST contract now
      covers idempotent immediate, future, trial, and backdated creation; pending reschedule and
      cancellation; active scalar, payment-policy, custom-section, threshold, and scheduled-ending
      updates; activation; manual and scheduled termination; upgrade/downgrade generations; and
      exact replay/concurrency rollback. Unsupported one-time backdating and unsupported prepaid
      termination combinations fail explicitly.
- [x] Implement invoice listing required by the current store flow.
- [x] Implement the four verified Lago-compatible routes and error envelopes.

Acceptance:

- Read-only `store-new` compatibility fixtures pass unchanged.
- Duplicate and concurrent requests produce one logical resource.
- Authorization cannot cross organizations.

### M3: Invoice and rating engine

- [x] Implement exact-decimal standard, graduated, package, volume, percentage, and graduated
      percentage charge-model interfaces; dynamic/custom and advanced percentage adjustments
      remain pending.
      Billable-metric create/list/show and Rails-safe scalar update now emit transactional,
      versioned outbox events; attached metrics allow only name/description mutation. Expression,
      rounding, recurring weighted-sum, nested metric filters, deletion workflows, and
      subscription-level filter overrides are now ported. Generic recurring and custom aggregation
      remain explicit gaps. Standalone plan charge
      create/list/show/update/delete supports the exact in-arrears rating models, nested
      filter-specific price overrides, and standalone filter list/show/create/update/delete.
      Invoiceable, non-prorated pay-in-advance usage is ported for count, sum, and unique-count
      metrics using standard, graduated, package, percentage, and graduated-percentage pricing.
      Non-invoiceable or prorated advance usage, volume/custom aggregation, positive minimums,
      grouped pricing and pricing units fail explicitly. Charge- and filter-level
      cascades across subscription override graphs are ported. Weighted filters reconstruct independent
      recurring baselines per filter/base partition across periods and subscription generations.
      Filter/base partitions can also combine with target-wallet grouping as exact two-dimensional
      current-usage and invoice cells with deterministic identities and wallet allocations.
      Recurring weighted state is reconstructed per wallet group, including within each filter/base
      partition and for historical groups with no current event. Charge minimums create one
      charge-wide, termination-prorated true-up line after every cell is rated.
- [ ] Port subscription, recurring, fixed, usage, minimum-commitment, coupon, credit, wallet, tax,
      and rounding behavior according to feature disposition. Unrestricted fixed/percentage
      coupons now support once/recurring/forever application, initial and renewal invoice
      consumption, exact rounding, replay, and unpaid-void recredit. Plan- and billable-metric-
      targeted coupons now retain tenant-safe targets, sequential per-line allocation, immutable
      allocation snapshots, tax-base reduction, and subscription-override plan matching. Credit
      note refunds/offsets/taxes remain pending. Credit-only finalized
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
      Manual percentage taxes now support create/list/show/update/terminate; billing-entity,
      customer, plan, charge, fixed-charge, minimum-commitment, add-on, and explicit one-off-fee
      targeting; inherited subscription-override graphs; coupon-adjusted per-line taxable bases;
      exact rounding; draft invalidation; and immutable invoice/fee snapshots. External providers,
      exemptions, tax identifiers, and credit-note tax adjustments remain pending.
      Plan-level in-arrears minimum commitments now create only the rounded billing-period
      shortfall while retaining the precise fee value. Final termination invoices also prorate the
      target over the retained UTC unsplit window before subtracting precise and rounded fees;
      Commitment-specific taxes and subscription-override commitment cloning are now retained;
      pay-in-advance reconciliation, split windows, and tenant-local civil dates remain pending.
      Tenant-scoped add-ons now support idempotent create/list/show/update/terminate with versioned
      outbox events, and plans support standard/graduated/volume recurring pay-in-arrears fixed
      charges. Fixed fees enter the exact recurring invoice pipeline before minimum commitments,
      coupons, taxes, credit notes, and wallets. In-arrears standard, volume, and graduated charges
      support event-weighted customer-local calendar-day proration for renewal, current usage, and
      termination. Standard pay-in-advance fixed charges support optional local-day proration;
      graduated advance charges are non-prorated, while volume advance charges remain an explicit
      unsupported boundary.
      Subscription
      fixed-charge list/show/update is ported; override mutations clone the full active pricing
      graph and persist effective-dated units so the default applies at the next boundary while an
      explicit immediate update affects the open period.
      Standalone fixed-charge create/list/show/update/delete routes expose the same ledger. Catalog
      create/update and inherited child-plan cascades now persist per-subscription unit events: the
      default applies at the next boundary and `apply_units_immediately: true` affects the open
      period.
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
      adjustments and destructive plan/charge graph replacement remain pending. The pinned
      Authorize.Net `POST /api/v1/invoices/:id/retry_payment` transition is now retained as a
      provider-free, kill-switched D1 command: it accepts one idempotent winner per invoice version,
      records a pending payment intent, returns the invoice to pending, invalidates the stale hosted-
      payment link, and emits value-free outbox evidence. Generic provider retry, regeneration, and
      unsupported invoice-adjustment transitions remain pending.
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
- [x] Add golden fixtures derived from existing tests, not customer data. The synthetic month-end
      fixture records the approved period, advance base, usage price/quantities, coupon credit,
      precise/rounded lines, and invoice totals without any production identifiers or values.
- [x] Add deterministic replay and total reconciliation. The fixture-driven test proves one cycle,
      invoice, and finalization event; exact period advancement; precise/rounded line parity; line
      sum to subtotal; and `subtotal + tax - credits = total_due` across replay.

Acceptance:

- Golden invoice totals and line items match approved Rails fixtures.
- Duplicate, reordered, delayed, and concurrent commands preserve monetary invariants.
- Unsupported behavior fails explicitly; it never silently calculates a substitute.

### M4: Provider payments and inbound webhooks

- [x] Define a provider adapter contract.
- [x] Implement Authorize.Net first because it is the verified store dependency.
- [x] Disposition other providers according to the feature inventory. A read-only audit at
      `store-new@5f7781f678bb8263e83e67089f915109a5e7a025` and
      `serp-auth@bb037306a4eb0de660971dfb222db215fd93c233` found that both own their Stripe
      calls directly and neither consumes Lago APIs. Lago-managed Stripe, Adyen, GoCardless,
      Cashfree, Flutterwave, and MoneyHash therefore remain `not-used`; Authorize.Net is the only
      retained Lago provider adapter.
- [x] Implement checkout/payment Workflows with intent, attempt, outcome, and reconciliation records.
      Invoice hosted checkout retains the synchronous store contract with Durable Object command
      reservations; payment-request checkout uses a D1 intent/outcome ledger and a retryable
      Workflow, while provider transaction attempts and webhook reconciliation remain separate,
      auditable records.
- [x] Implement signed webhook verification, immutable receipt storage, deduplication, ordering,
      retries, and poison-message handling.
- [x] Implement `POST /invoices/:id/payment_url` compatibility behavior.

Acceptance:

- Provider adapters pass fake-server contract suites without live credentials.
- Kill/retry tests cannot produce a duplicate provider mutation.
- Webhook replay converges on the same payment and invoice state.

### M5: Jobs, schedules, outbound events, and reconciliation

- [x] Replace enabled Active Jobs with domain commands, Queue consumers, or Workflow steps. The
      generated pinned-source inventory now requires an explicit job-specific rule and aborts if a
      new Rails job lacks one. Of 242 job files, 95 retained commands consolidate into tested
      Worker/D1, Queue, Workflow, Cron, document, webhook, usage, wallet, and Authorize.Net owners;
      143 are explicitly `not-used` historical backfills, non-retained providers/integrations,
      external tax/VIES/e-invoicing/email/telemetry/alert paths, or unsupported provider-funded and
      bulk mutations; and four Rails/Active Job/Sidekiq/Clock/Sentry framework scaffolds are retired
      by Cloudflare's native runtime. No job retains the generic Workflow/Queue placeholder or
      self-referential source-only evidence.
- [x] Replace enabled Clockwork entries with deterministic Cron-to-Workflow dispatch.
      All 27 legacy entries now have an exhaustive code-level ownership registry. A deterministic
      one-minute Cron dispatches a versioned Workflow instance and records due/unimplemented
      schedules in D1. The retained pending-subscription activation, recurring billing, draft
      refresh, Authorize.Net receipt retry, coupon expiry, wallet expiry, recurring-rule expiry,
      ongoing wallet-balance/threshold projection, provider-free interval granted-credit top-up,
      invoice-overdue, subscription-activity, and lifetime-usage refresh paths run on their legacy
      slots. The post-validation entry is retained as an audited synchronous-precommit boundary
      because invalid code/property/filter events cannot commit, and the deprecated Redis/ClickHouse
      refreshed-subscription loop is consolidated into D1 activity plus wallet projection. Every
      dispatchable entry now has an executable or audited owner; entries marked `partial` retain
      that status until their broader feature families are ported. The two daily webhook-retention
      schedules now enforce Lago's 90-day
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

- [x] Port invoice, receipt, credit-note, and export templates according to inventory. Invoice,
      receipt, and credit-note templates use authenticated PDF generation/download boundaries. The
      four pinned invoice/credit-note CSV exports use an authenticated REST replacement and stream
      from bounded D1 pages through the shared Document Workflow directly into R2. The pinned Lago
      revision's quote domain is GraphQL-only and contains no quote template, PDF service/job, or
      download contract, so there is no authoritative quote document surface to port.
- [x] Generate invoice, receipt, and credit-note PDFs using Browser Rendering through a retryable,
      ownership-checked Document Workflow.
- [x] Remove `pdfcpu` from the retained runtime contract. Pinned-source verification shows it is
      used only to embed generated Factur-X XML in PDF/A-3 documents after e-invoicing is enabled for
      an eligible billing-entity country; it is not a page merger or general attachment dependency.
      The retained single billing entity rejects e-invoicing configuration, every document API keeps
      XML explicitly disabled, and no Cloudflare path invokes a subprocess. Factur-X generation and
      Workers-native XML embedding remain a separately approved future product slice rather than an
      unreachable compatibility shim.
- [x] Store immutable, version-addressed invoice, receipt, credit-note, and data-export artifacts in
      R2 with integrity metadata, byte length, and generation metadata.
- [x] Add visual and structural golden-file verification. Synthetic invoice, payment-receipt, and
      credit-note fixtures now retain inspected PDFs and 300-DPI PNG pages plus deterministic HTML,
      extracted-text, geometry, bounds, and image hashes. Regeneration rejects missing content,
      out-of-bounds glyphs, and non-portable Type 3 fonts.

Acceptance:

- Representative documents match approved content and layout fixtures.
- A retry does not create conflicting authoritative artifacts.
- No local filesystem or OS subprocess is required.

### M7: Usage metering and analytics

- [x] Implement single-event validation, semantic deduplication/conflict detection, tenant-scoped
      reads, Queue/outbox emission, and immutable R2 archives. Batch ingestion validates all
      events before writing, caps requests at 100, rejects duplicate/existing transaction IDs,
      stores deterministic archives, and commits all event/outbox rows atomically.
- [x] Port count, sum, maximum, latest, add/remove unique-count, and seconds-based weighted-sum
      aggregations plus six core charge models. Weighted sums use cumulative deltas, full civil-day
      charge-period normalization, exact 20-place Lago ceiling precision, and recurring baselines
      reconstructed across subscription generations. Nested metric/charge filters use bounded D1
      documents, strict allowed-value validation, wildcard key-presence semantics, and first
      most-specific event assignment for current usage and invoice lines. Custom aggregation and
      advanced adjustments remain pending. Recurring weighted filters reconstruct separate
      historical cumulative baselines for every filter/base partition and target-wallet group,
      including across subscription generations and for idle carried groups. Every event enters one
      filter/base and one wallet cell, and current usage, invoice lines, and wallet allocations
      reconcile exactly. Optional round/ceil/floor metric configuration applies to aggregate units
      before current-usage and recurring-invoice rating, including negative precision. Filtered and
      unfiltered charge minimums are excluded from current usage and emit a separate charge-wide
      invoice true-up, matching the legacy fee contract.
- [x] Replace the Ruby subprocess and Go/Rust native library with a restricted TypeScript parser or
      a supported precompiled Wasm module. The pinned `lago-expression` Rust extension is now
      replaced by a bounded TypeScript parser/evaluator with no dynamic evaluation; the separately
      configurable Ruby custom-aggregation program remains explicitly unsupported.
- [x] Add usage projections and reconciliation against invoice lines. A synchronous
      Lago-compatible current-usage projection now covers bounded billing windows. The retained
      lifetime-usage slice coalesces event activity transactionally, follows subscription
      generations, reconciles current rated usage with draft/finalized usage lines, exposes
      Lago-compatible GET/PUT routes, and has one-minute Queue/Workflow fanout plus five-minute
      projection repair. Voided lines are excluded and projection-version guards prevent older
      Queue work from clearing newer activity. Progressive thresholds, alerts, and broader analytics
      projections remain pending as separately inventoried breadth.
- [x] Select D1, Durable Object SQL, R2/Pipelines, or Analytics Engine by verified query and volume
      requirements; do not recreate Kafka/ClickHouse by habit. D1 remains the exact relational
      billing authority and R2 retains immutable raw evidence for the verified SERP scope. Durable
      Object SQL remains aggregate coordination, Analytics Engine is eligible only for derived
      three-month analytics, and open-beta Pipelines/R2 Data Catalog is deferred until measured
      scale or cross-tenant analytical demand crosses the documented re-evaluation gates in
      `docs/reference/cloudflare-usage-storage-decision.md`.

Acceptance:

- Duplicate and out-of-order event suites produce the same billed aggregates.
- Rating results match approved Lago fixtures.
- No Kafka, ClickHouse, Redis, Go process, or container is required.

### M8: Operator API and UI

- [x] Inventory the Vite UI's GraphQL operations and screen-level feature dependencies. The
      generated inventory now records 503 source operations (267 queries, 235 mutations, and one
      subscription), their owning screens/domains, 159 literal route constants, and mapping status.
      Of those operations, 496 have generated Apollo types; seven source-only operations belong to
      the pinned Authorize.Net integration UI and expose a code-generation drift that must be
      resolved before that screen can be retained. The generator refuses API or frontend sources
      whose revisions differ from this branch's submodule gitlinks. Every operation and route
      remains explicitly unmapped rather than making an unsupported screen appear functional. Two
      Material UI class-name constants previously counted as routes are now excluded because their
      values are neither URL paths nor composed route templates. The completed audit classifies all
      503 legacy operations by explicit boundary and separately inventories 22 tested REST
      replacement families; the legacy GraphQL bundle is never deployed.
- [x] Implement the GraphQL compatibility surface or replace individual screens with a documented
      Worker API equivalent. Manual invoice custom-section catalog CRUD now uses the documented
      tenant-scoped REST equivalent, and API-key create/list/show/name-update/rotate/revoke now uses
      a secret-safe tenant-scoped REST control plane. Organization show/update now uses a
      tenant-scoped REST equivalent for identity, billing, locale, and document configuration while
      webhook mutation stays behind its separately gated endpoint API. Billing-entity list/show/
      update now projects the retained one-default-entity architecture, with creation and non-default
      entities rejected explicitly. Payment-receipt list/show and invoice filtering now use a
      tenant-scoped REST equivalent while document generation and email resend remain explicit
      boundaries. The pinned quote create/read/filter/owner and version edit/approve/void/clone
      lifecycle now uses a tenant-scoped REST equivalent with D1-owned sequencing, active-version
      uniqueness, optimistic revisions, and idempotent creation/clone commands. Invoice and
      credit-note export mutations now use an authenticated REST create/status/download lifecycle;
      completion email is retained as an explicit disabled boundary. All remaining legacy
      operations are unreachable and have an explicit blocked, external-owner, not-used, retired,
      deferred, or disabled disposition in the generated inventory.
      A separate operator Worker foundation now validates Access RS256 issuer/audience/signature/
      expiry claims, resolves only a hashed Access subject through one immutable D1 tenant/role
      membership, and defines same-origin/CSRF mutation checks. Its configuration and readiness
      remain disabled without an approved Access application and allow policy; it has not been
      remotely provisioned or deployed. `GET /api/operator/v1/organization` is the first bounded
      BFF read contract: it authorizes through the membership tenant and reuses the canonical
      organization REST serializer, with no browser-specific duplicate projection. The API-key
      BFF now maps sanitized list/show for viewers and create/name-update/rotate/revoke for admins,
      reusing the canonical secret-safe control plane behind operator origin/CSRF checks. The first
      catalog BFF maps invoice custom-section list/show for viewers and create/edit/terminate for
      admins through the canonical handler and its transactional outbox/internal Queue publication.
      The first billing BFF maps the retained default billing entity's detailed read for viewers and
      supported updates for admins through the canonical D1 handler. Multi-entity creation,
      e-invoicing, tax assignment, and other explicit side-effecting boundaries remain unavailable.
      Payment-receipt list/show is the next read-only BFF: it reuses the canonical D1 projection but
      suppresses document URLs and rejects document generation/download, email, and all mutations.
      Manual-tax list/show plus admin create/edit/terminate is also implemented through the canonical
      D1 and internal domain-event Queue handler.
      Add-on list/show plus admin create/edit/terminate is implemented through the canonical handler
      with its currency, in-use, and unsupported tax-target boundaries unchanged.
      Core customer list/show plus admin create/edit is implemented through an extracted canonical
      D1 and Queue handler. The completed bounded app also includes coupons, plans, subscriptions,
      invoices, wallets, credit notes, read-only payments, quotes, data exports, read-only webhook
      endpoints, dunning campaigns, and read-only payment requests. Provider, email, document,
      public-portal, identity-lifecycle, analytics/logging, and other advanced actions retain their
      explicit disabled or deferred boundaries.
- [x] Serve the operator application with Workers Static Assets. The deployed API Worker retains
      its script-free `operator-ui` rollback shell. The separate, undeployed operator Worker now
      serves `operator-app`: a same-origin native-ES-module organization/API-key workspace with a
      restrictive `_headers` policy, SPA fallback, and Worker-first `/api/*`, health, and readiness
      paths. It validates the Access session before exposing controls, gives viewers sanitized
      metadata and admins create/rename/rotate/revoke actions, holds create/rotate secrets only in
      memory, and contains no GraphQL, bearer-login, browser credential storage, or auth bypass.
      Remote deployment remains gated on the approved Access policy and synthetic membership proof.
- [x] Replace ActionCable subscriptions with Durable Object WebSockets or SSE where retained. The
      only pinned frontend GraphQL subscription belongs to the non-retained AI-agent integration;
      no retained operator workflow requires ActionCable, WebSockets, or SSE.
- [ ] Mark retired screens explicitly with approved product rationale. The proposed retain,
      blocked, external-owner, not-used, and retirement policy plus screen admission/rollback rules
      is documented in `docs/reference/cloudflare-operator-surface-policy.md`; final legacy-screen
      retirement remains pending explicit product approval.

Acceptance:

- Every retained operator workflow has an end-to-end test.
- No screen appears functional while calling an unimplemented backend operation.
- Static UI delivery does not invoke compute unnecessarily.

### M9: Local parity and staging readiness

- [x] Run full contract, invariant, integration, migration, replay, and document suites.
- [x] Run the repository harness and secret scan.
- [x] Run Wrangler type generation, config validation, and deployment dry run.
- [x] Produce a resource manifest with development/staging names, bindings, retention, and deletion
      procedures.
- [x] Produce a staging test plan that uses synthetic customers and provider sandboxes only.

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

## Operator parity correction checkpoint — 2026-08-18

- [x] Replaced the custom giant anchor document with the original Lago grouped navigation, focused
      organization-slug routes, headers, breadcrumbs, tables, dialogs, responsive navigation,
      original SVG assets, and self-hosted Inter.
- [x] Added forward migration `0072_operator_multi_organization_memberships.sql`, membership-list
      session output, explicit organization selection, safe organization switching, admin/viewer
      enforcement, and cross-tenant missing-object behavior.
- [x] Added original-style customer detail routes and generic focused detail routes for every
      admitted operator list/show family. Retained-but-unavailable product areas remain in the
      original hierarchy with explicit bounded states.
- [x] Added a minimum empty `serp-labs` synthetic organization and viewer membership to the isolated
      development D1 database. No provider, payment, email, production, or customer-data action was
      enabled.
- [x] Compared original and ported desktop customer states at 1502 × 888 and checked responsive
      navigation, detail, and table overflow at 390 × 844. The evidence and final QA result live in
      `docs/evidence/cloudflare-operator-2026-08-18/` and `design-qa.md`.
- [x] Passed 337 tests across 61 files, five Access reconciler tests, formatting, lint, type checks,
      inventory verification, both Worker dry builds, authenticated remote browser QA, and
      unauthenticated Access fail-closed checks.
- [x] Applied only migration `0072`, confirmed no pending remote migration or foreign-key violation,
      and deployed operator Worker version `5666a5f4-4502-4d71-b2dc-0ac656048393`. Remote API Worker
      version inspection confirms all three external-action flags remain `0`.

## Final retained-surface repair checkpoint — 2026-08-18

- [x] Reconciled every original operator operation and route against an executable Cloudflare
      contract or an explicit user-directed safety-disabled external action. The generated ledger
      covers 503 operations and 159 routes without a partial status.
- [x] Added the customer portal, integration registry, pricing units, resource alerts, advanced
      customer/invoice/credit-note/subscription controls, billing-profile taxes/dunning/logo,
      retained PDF downloads, and the original right-side Lago Assistant behavior.
- [x] Replayed all 80 migrations against a fresh local D1 persistence directory.
- [x] Passed the complete local gate: 358 tests across 65 files, Access provisioning tests,
      formatting, lint, authoritative inventory checks, generated Worker bindings, TypeScript, and
      API/operator/portal deployment dry runs.
- [x] Audited all 29 visible primary-navigation destinations at 1280 × 720 and the customer and
      assistant experiences at 390 × 844. No retained navigation destination showed the former
      Cloudflare-boundary placeholder.
- [x] Fixed the organization-prefixed original-route resolver discovered by browser QA and added
      executable regression coverage without intercepting canonical organization/detail routes.
- [x] Applied only pending migrations `0074` through `0080`, deployed operator version
      `64287259-a894-4fcb-bdfd-274e3d01ae83` and customer-portal version
      `6bfeedea-636d-4af4-bcf0-3e20573ab3a0`, reverified Access fail-closed behavior, tokenless
      portal rejection, authenticated synthetic customer settings, the Lago Assistant, and legacy
      route canonicalization.

## Non-production semantic completion checkpoint — 2026-08-18

- [x] Added targeted manual taxes across billing entity, customer, plan, charge, fixed charge,
      minimum commitment, add-on, and explicit one-off fee scopes with deterministic precedence,
      draft invalidation, immutable invoice snapshots, and subscription-override graph cloning.
- [x] Fixed subscription override cloning so minimum commitments and every inherited tax target
      survive the hidden child-plan transition instead of silently changing the bill.
- [x] Added plan- and billable-metric-targeted coupons with tenant-safe target validation,
      sequential line-level allocation, persisted allocation evidence, subscription-override plan
      matching, and tax calculation on the discounted eligible base.
- [ ] Finish credit-note tax adjustment, internal offset, provider-fake refund, and remaining
      non-production rating/lifecycle gaps before the isolated-development deployment gate.

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
- 2026-08-15: Ported pay-in-advance minimum-commitment termination. The inclusive UTC-prorated
  target now reconciles against gross eligible plan, usage, and fixed-charge lines already billed
  for the same subscription period plus current termination fees. The query excludes the current
  invoice so positive-grace refresh/finalization cannot count its draft twice; credit-note balances
  intentionally do not reduce gross fee history. The explicit API guard and stale error mapping are
  removed. Evidence terminates a prepaid committed subscription into a draft, proves its line and
  metadata remain identical through refresh/finalization, and runs asynchronous plan deletion
  against a pay-in-advance committed plan to prove the Workflow no longer stalls. All 160 tests
  across 31 Worker-runtime files pass. Formatting, strict lint, generated inventory/types,
  TypeScript, and an 824.06 KiB (143.24 KiB gzip) dry-run bundle are green. Feature checkpoint:
  `6da8f8a`.
- 2026-08-15: The first read-only remote migration-list preflight returned transient Cloudflare
  error `7500`; the empty aggregate query still succeeded, and the retry confirmed no migrations
  pending before deployment. Deployed only the isolated Worker as version
  `927f7fb4-86f4-4803-8350-88f308d8fe8c` with a 5 ms startup. Health/readiness returned `200`/`200`
  and unauthenticated subscription deletion returned `401`. A first post-deploy aggregate query
  used the nonexistent `schedule_audits` table name and failed read-only; the corrected
  `schedule_runs` query verified zero organizations, customers, plans, subscriptions, invoices,
  and plan-deletion tasks plus 163 schedule audits. No migration, resource provisioning, route,
  domain, secret, provider action, customer data, or billing row changed.
  `PAYMENT_MUTATIONS_ENABLED`, `PROVIDER_READS_ENABLED`, and `OUTBOUND_WEBHOOKS_ENABLED` remain `0`.
- 2026-08-15: Replaced the pinned `getlago/lago-expression` Rust/Ruby native extension in the
  Cloudflare path with a bounded TypeScript Pratt parser and evaluator. It implements the pinned
  grammar's exact decimal literals, precedence, parentheses, unary minus, top-level event fields,
  own-property lookup, and `round`/`ceil`/`floor`/`concat`/`least`/`greatest` functions without
  `eval`, `Function`, Wasm, native code, or a subprocess. Length, token, nesting, and argument caps
  bound untrusted work. Metric create/replay validates and persists expressions; authenticated
  evaluation and single/batch ingestion apply Lago's whole-second timestamp and numeric-string
  conventions. The derived property is overwritten before aggregation validation, request hashing,
  D1 persistence, and immutable R2 archiving. Missing variables fail before any single write, and
  one failed batch item prevents all D1/R2 commits. Strict format/lint, inventory/types, TypeScript,
  and focused expression/metering tests pass. One fully parallel run passed 165/166 before the
  previously documented draft-termination-credit test exceeded its 10-second harness limit; that
  file passed 2/2 alone, and bounded groups passed all 166 tests as 43 + 64 + 59. The dry-run bundle
  is 838.46 KiB (146.34 KiB gzip). Feature checkpoint: `b464b03`.
- 2026-08-15: Remote preflight on the explicit SERP account found no pending migration and zero
  organizations, customers, plans, subscriptions, invoices, and usage events. Deployed only the
  isolated Worker as version `3b8d7c0d-c893-4cec-b3a2-4c9c1594697a` with a 6 ms startup.
  Health/readiness returned `200`/`200`, unauthenticated expression evaluation returned `401`, and
  post-deploy aggregate-only verification remained empty apart from 169 schedule audits.
  `PAYMENT_MUTATIONS_ENABLED`, `PROVIDER_READS_ENABLED`, and `OUTBOUND_WEBHOOKS_ENABLED` remain `0`;
  no migration, resource provisioning, production route/domain, secret, provider action, customer
  data, or billing row changed.
- 2026-08-15: Ported billable-metric rounding configuration. Metric create/replay now validates and
  persists `round`, `ceil`, or `floor` plus integer precision from -100 through 100; attached metrics
  retain their existing immutable-rating guard. One shared exact-decimal operation transforms the
  aggregate after event reduction and before charge-model rating in both current-usage projection
  and recurring/termination invoice calculation. Omitted precision defaults to zero and negative
  precision rounds to powers of ten. Evidence covers all three functions, positive/omitted/negative
  precision, API serialization and rejection, a 2.462-unit current projection ceiled to 2.5 before
  pricing, and the same 2.5-unit/25-cent persisted invoice line. Formatting, strict lint, inventory,
  generated types, and TypeScript are green; bounded Worker groups pass all 169 tests as
  44 + 65 + 60. The dry-run bundle is 840.81 KiB (146.78 KiB gzip). Feature checkpoint: `c57a033`.
- 2026-08-15: Remote preflight on the explicit SERP account found no pending migration and zero
  organizations, customers, plans, subscriptions, invoices, and usage events. Deployed only the
  isolated Worker as version `fad8d3ba-963a-4281-ba4c-aa146590a591` with a 5 ms startup.
  Health/readiness returned `200`/`200`, unauthenticated metric creation returned `401`, and
  post-deploy aggregate-only verification remained empty apart from 171 schedule audits.
  `PAYMENT_MUTATIONS_ENABLED`, `PROVIDER_READS_ENABLED`, and `OUTBOUND_WEBHOOKS_ENABLED` remain `0`;
  no migration, resource provisioning, production route/domain, secret, provider action, customer
  data, or billing row changed.
- 2026-08-15: Ported seconds-based weighted-sum aggregation for current usage and recurring,
  termination, and periodic invoice calculation. The exact-decimal reducer groups equal timestamps,
  integrates cumulative deltas over elapsed milliseconds, normalizes by the full civil-day charge
  period, and applies Lago's final 20-place ceiling without an intermediate floating-point value.
  Recurring baselines are reconstructed from immutable retained events by tenant, external
  subscription ID, and metric, preserving state across subscription generations without a mutable
  cache table or migration. Billed weighted units and end-of-period cumulative units remain
  separate. Metric create/replay/update validates `weighted_interval=seconds`; attached mutation
  remains guarded, and weighted target-wallet charges fail explicitly until per-group historical
  baselines are ported. Evidence covers legacy deltas, same-timestamp events, negative fractions,
  recurring carry-forward, cross-generation history, full-calendar normalization for a mid-month
  start, current usage, and persisted invoice lines. Formatting, strict lint, inventory, generated
  types, and TypeScript are green; bounded Worker groups pass all 175 tests as 46 + 66 + 63. The
  dry-run bundle is 851.07 KiB (148.58 KiB gzip). Feature checkpoint: `d8f23f1`.
- 2026-08-15: Remote preflight on the explicit SERP account found no pending migration and zero
  organizations, customers, plans, subscriptions, invoices, and usage events. Deployed only the
  isolated Worker as version `2e548908-e330-47c2-a252-a9e0bf295e55` with a 6 ms startup.
  Health/readiness returned `200`/`200`, unauthenticated billable-metric access returned `401`, and
  post-deploy aggregate-only verification remained empty apart from 175 schedule audits.
  `PAYMENT_MUTATIONS_ENABLED`, `PROVIDER_READS_ENABLED`, and `OUTBOUND_WEBHOOKS_ENABLED` remain `0`;
  no migration, resource provisioning, production route/domain, secret, provider action, customer
  data, or billing row changed.
- 2026-08-15: Ported bounded billable-metric and charge filters for nested metric, plan, and
  standalone-charge APIs, current usage, and persisted invoice calculation. D1 stores validated
  filter documents with deterministic charge-filter IDs. Rating assigns each event exactly once to
  the first most-specific matching filter or the base charge; wildcard values still require the
  property key, per-filter rating properties override the base charge, and filter invoice lines use
  distinct persistence identities while retaining the owning charge in metadata. Weighted-sum,
  target-wallet, and nonzero-minimum combinations fail explicitly pending per-filter baselines,
  multidimensional grouping, and charge-wide true-up allocation. Evidence covers overlap,
  wildcard/missing-key behavior, invalid values, embedded and standalone catalogs, live usage, and
  three persisted partition lines. All 46 migrations replay from empty local D1. Formatting,
  strict lint, inventory, generated types, and TypeScript are green; bounded Worker groups pass all
  180 tests as 49 + 68 + 63. The dry-run bundle is 866.72 KiB (151.52 KiB gzip). Feature checkpoint:
  `60b599b`.
- 2026-08-15: Remote preflight on the explicit SERP account found only migration
  `0046_charge_filters.sql` pending and zero organizations, customers, plans, subscriptions,
  invoices, and usage events. Applied that migration only to the isolated non-production D1 and
  deployed only the isolated Worker as version `69399fec-da3b-4fc5-aa64-212b5e99d8df` with a 4 ms
  startup. Health/readiness returned `200`/`200`, unauthenticated billable-metric access returned
  `401`, no migrations remain, and post-deploy aggregate-only verification remained empty apart
  from 180 schedule audits. `PAYMENT_MUTATIONS_ENABLED`, `PROVIDER_READS_ENABLED`, and
  `OUTBOUND_WEBHOOKS_ENABLED` remain `0`; no resource provisioning, production route/domain,
  secret, provider action, customer data, or billing row changed.
- 2026-08-15: Added Lago-compatible standalone plan charge-filter list/show/create/update/delete
  routes over the same bounded D1 filter documents. Mutations preserve immutable filter values on
  update, strip legacy presentation-group metadata, issue a new deterministic ID after
  delete/recreate, increment the owning charge version, refresh drafts through the existing charge
  trigger, and emit transactional `charge.updated` outbox events. Pagination and plan/charge/filter
  not-found behavior match the legacy route family; cascades fail explicitly until plan inheritance
  is ported. Formatting, strict lint, inventory, generated types, and TypeScript are green; bounded
  Worker groups pass all 181 tests as 49 + 69 + 63. The dry-run bundle is 875.50 KiB (152.50 KiB
  gzip). Feature checkpoint: `ae120ed`.
- 2026-08-15: Remote preflight on the explicit SERP account found no pending migration and zero
  organizations, customers, plans, subscriptions, invoices, and usage events. Deployed only the
  isolated Worker as version `7c1bf413-994b-46d5-a215-ececc802e28b` with a 5 ms startup.
  Health/readiness returned `200`/`200`, unauthenticated standalone filter access returned `401`,
  and post-deploy aggregate-only verification remained empty apart from 182 schedule audits.
  `PAYMENT_MUTATIONS_ENABLED`, `PROVIDER_READS_ENABLED`, and `OUTBOUND_WEBHOOKS_ENABLED` remain `0`;
  no migration, resource provisioning, production route/domain, secret, provider action, customer
  data, or billing row changed.
- 2026-08-15: Replaced per-partition minimum clamping with Lago-compatible charge-wide true-ups.
  Current usage now reports actual rated usage without a minimum. Renewal and termination invoices
  sum all filter/base (or target-wallet) fees, prorate the minimum for a termination window, and add
  one separate true-up line only for the remaining shortfall. The line has units `1`, zero events, a
  deterministic persistence identity, the owning charge and metric in metadata, and an auditable
  true-up-parent source. Evidence covers a 35-cent three-partition filtered charge becoming exactly
  100 cents through one 65-cent line and a same-metric current projection remaining at its actual
  30 cents. Formatting, strict lint, inventory, generated types, and TypeScript are green; bounded
  Worker groups pass all 181 tests as 49 + 69 + 63. The dry-run bundle is 876.77 KiB (152.61 KiB
  gzip). Feature checkpoint: `9263089`.
- 2026-08-15: Remote preflight on the explicit SERP account found no pending migration and zero
  organizations, customers, plans, subscriptions, invoices, and usage events. Deployed only the
  isolated Worker as version `7ba328a1-da36-4f72-b9e6-a6c96b0ad674` with a 5 ms startup.
  Health/readiness returned `200`/`200`, unauthenticated standalone filter access returned `401`,
  and post-deploy aggregate-only verification remained empty apart from 184 schedule audits.
  `PAYMENT_MUTATIONS_ENABLED`, `PROVIDER_READS_ENABLED`, and `OUTBOUND_WEBHOOKS_ENABLED` remain `0`;
  no migration, resource provisioning, production route/domain, secret, provider action, customer
  data, or billing row changed.
- 2026-08-15: Ported exact filter-by-target-wallet grouping. Every event first enters the legacy
  most-specific filter or base partition and then one normalized wallet-code group. Current usage
  rates every two-dimensional cell independently before reconciling charge/filter totals; recurring
  and termination invoices persist one deterministic line identity per cell with both dimensions
  in metadata, and wallet allocation consumes those distinct persistence sources without losing
  the owning charge. Evidence covers two wallet targets across a filtered and unmatched partition,
  exact 140-cent current usage, three distinct invoice lines, and exact 80/60-cent allocations.
  Formatting, strict lint, inventory, generated types, and TypeScript are green; bounded Worker
  groups pass all 182 tests as 50 + 69 + 63. The dry-run bundle is 878.24 KiB (153.04 KiB gzip).
  Feature checkpoint: `8aec08c`.
- 2026-08-15: Remote preflight on the explicit SERP account found no pending migration and zero
  organizations, customers, plans, subscriptions, invoices, billable metrics, charges, usage
  events, wallets, wallet targets, and outbox rows. Deployed only the isolated Worker as version
  `c3281312-ae2f-425f-bc3c-07ca186f3e8b` with a 6 ms startup. Health/readiness returned `200`/`200`,
  unauthenticated standalone filter access returned `401`, and post-deploy aggregate-only
  verification remained empty apart from 187 schedule audits. All three external-action flags
  remain `0`; no migration, resource provisioning, production route/domain, secret, provider
  action, customer data, or billing row changed.
- 2026-08-15: Ported recurring weighted-sum charge filters. One capped historical D1 read per
  charge replays retained events across subscription generations through the same most-specific
  filter partitioner used for current events, producing an independent cumulative starting value
  for every persisted filter and the unmatched base. Current usage and recurring/termination
  invoices then integrate and rate each partition separately while reconciling total units and
  end-of-period state. No mutable cache table or migration is required. Evidence carries prior
  generation EU/base values of 10/20 into current values of 12/23, verifies 35 aggregate units and
  47 cents of current usage, and persists exact 24/23-cent filter/base lines with distinct source
  identities. Formatting, strict lint, inventory, generated types, and TypeScript are green;
  bounded Worker groups pass all 183 tests as 51 + 69 + 63. The dry-run bundle is 879.15 KiB
  (153.22 KiB gzip). Feature checkpoint: `be68e09`.
- 2026-08-15: Remote preflight on the explicit SERP account found no pending migration and zero
  organizations, customers, plans, subscriptions, invoices, billable metrics, charges, usage
  events, wallets, wallet targets, and outbox rows. Deployed only the isolated Worker as version
  `d07da457-b615-4b65-afbd-b038cecc8382` with a 7 ms startup. Health/readiness returned `200`/`200`,
  unauthenticated billable-metric access returned `401`, and post-deploy aggregate-only
  verification remained empty apart from 190 schedule audits. All three external-action flags
  remain `0`; no migration, resource provisioning, production route/domain, secret, provider
  action, customer data, or billing row changed.
- 2026-08-15: Ported recurring weighted target-wallet grouping, including its composition with
  charge filters. The bounded historical replay now creates a cumulative baseline map per
  filter/base and normalized wallet-code cell. Invoice/current-usage grouping takes the union of
  historical and current group keys, so an idle wallet with a carried balance still receives a
  full-period line, while an empty history does not introduce a spurious untargeted cell. Existing
  deterministic multidimensional source identities feed exact wallet allocation unchanged.
  Evidence covers 10/20/30 historical units split across EU/base and two wallets, current deltas
  only for wallet one, a zero-event 20-unit wallet-two carry line, 66 reconciled units, 98 cents of
  usage, and exact 58/40-cent wallet allocations. Formatting, strict lint, inventory, generated
  types, and TypeScript are green; bounded Worker groups pass all 184 tests as 52 + 69 + 63. The
  dry-run bundle is 878.90 KiB (153.21 KiB gzip). Feature checkpoint: `f51c91e`.
- 2026-08-15: Remote preflight on the explicit SERP account found no pending migration and zero
  organizations, customers, plans, subscriptions, invoices, billable metrics, charges, usage
  events, wallets, wallet targets, and outbox rows. Deployed only the isolated Worker as version
  `8ddc797e-263d-4f37-a581-fddf4f62df8a` with a 5 ms startup. Health/readiness returned `200`/`200`,
  unauthenticated plan-charge access returned `401`, and post-deploy aggregate-only verification
  remained empty apart from 192 schedule audits. All three external-action flags remain `0`; no
  migration, resource provisioning, production route/domain, secret, provider action, customer
  data, or billing row changed.
- 2026-08-15: Ported Lago-compatible subscription charge-filter list/show/create/update/delete
  routes with real pricing-graph inheritance. The first mutation atomically creates a hidden child
  plan, clones every active usage and fixed charge with explicit parent links and fresh
  deterministic filter IDs, switches only the selected subscription generation, and applies the
  requested filter mutation. Later mutations reuse that graph. Root-only plan discovery prevents
  overrides from leaking into catalog creation, listing, subscription creation, or plan changes;
  root deletion fails safely while an active overridden subscription exists. Minimum commitments
  are intentionally not cloned, matching the legacy subscription-filter override service. Bounded
  graph counts and payload bytes keep the request finite, and transactional outbox events plus the
  existing draft invalidation trigger preserve mutation visibility. Evidence covers create,
  parent-ID update mapping, deletion, duplicate rejection without partial writes, full usage/fixed
  graph cloning, catalog isolation, later parent mutation isolation, current-usage billing from the
  child graph, and one-time graph creation. Formatting, strict lint, inventory, TypeScript, and the
  complete Worker suite are green at 187 tests across 35 files. All 47 migrations replayed in the
  isolated Worker harness; Wrangler's separate persisted local-state database reported
  `SQLITE_BUSY`, while remote preflight and application succeeded. The dry-run bundle is 901.76 KiB
  (157.35 KiB gzip). Feature checkpoint: `afc69ee`.
- 2026-08-15: Remote preflight on the explicit SERP account found only migration
  `0047_subscription_plan_overrides.sql` pending and zero organizations, customers, plans,
  subscriptions, invoices, billable metrics, charges, fixed charges, usage events, outbox rows, and
  plan-deletion tasks. Applied that migration only to the isolated non-production D1 and deployed
  only the isolated Worker as version `25aa2950-4fff-41a0-b33d-c93c9c56fa35` with a 5 ms startup.
  Health/readiness returned `200`/`200`, unauthenticated subscription-filter access returned `401`,
  no migrations remain, and post-deploy aggregate-only verification remained empty apart from 197
  schedule audits. All three external-action flags remain `0`; no resource provisioning,
  production route/domain, secret, provider action, customer data, or billing row changed.
- 2026-08-15: Ported standalone charge-filter `cascade_updates` across subscription override
  graphs. Create/update/delete resolve child filters by immutable values, assign independent IDs on
  creation, and touch only child charges with active or pending subscriptions. Update compares the
  child price with the parent's old normalized price: inherited children receive the new price and
  display name, while subscriber-customized prices remain unchanged. One bounded D1 batch guards
  the complete eligible child ID/version set, updates the parent and affected children, invalidates
  their drafts through existing triggers, and inserts one outbox event per changed charge. A child
  created, removed, or modified between preparation and commit forces a clean retry instead of a
  partial cascade. Evidence covers non-cascade isolation, inherited update, customized-price
  preservation, fresh-ID create, delete, and the standalone no-child path. Strict format/lint,
  inventory, and TypeScript checks pass. The fully parallel suite passed 187/188 before the known
  draft-termination-credit case exceeded its 10-second harness limit; that file passed 2/2 alone,
  and bounded groups passed all 188 tests as 45 + 69 + 67 + 7. The dry-run bundle is 910.74 KiB
  (159.23 KiB gzip). Feature checkpoint: `4edfebf`.
- 2026-08-15: Code-only remote preflight found no pending migration and zero organizations,
  customers, plans, subscriptions, invoices, billable metrics, charges, fixed charges, usage
  events, outbox rows, and plan-deletion tasks. Deployed only the isolated Worker as version
  `1cd16893-a578-43ab-9128-0040d7c5f861` with a 7 ms startup. Health/readiness returned `200`/`200`,
  unauthenticated standalone-filter access returned `401`, and post-deploy aggregate-only
  verification remained empty apart from 202 schedule audits. All three external-action flags
  remain `0`; no migration, resource provisioning, production route/domain, secret, provider
  action, customer data, or billing row changed.
- 2026-08-15: Ported standalone usage-charge `cascade_updates` across subscription override graphs.
  Create clones the complete charge and filters into every direct child plan with an active or
  pending subscription. Update always propagates the code to model-compatible children, propagates
  base properties only while they still match the parent's old model/properties, reconciles filters
  by immutable values, and preserves subscriber-customized filter prices and child-only filters;
  charge-level display names intentionally remain child-local. Delete retires the eligible child
  charges with the parent. Each operation guards the complete eligible child ID/version set and
  commits parent, children, and versioned outbox events in one transactional D1 batch, so a graph
  race forces retry without partial propagation. The synchronous Worker contract is explicitly
  bounded to 100 direct children and 512 KiB of prepared cascade JSON; larger legacy graphs fail
  before mutation rather than exceeding Worker limits. Evidence covers inherited and customized
  base pricing, inherited/customized/child-only filters, code and display-name behavior, full child
  creation with independent IDs, and parent/child retirement. Strict format/lint, inventory, and
  TypeScript checks pass. The fully parallel suite passed 189/190 before the known
  draft-termination-credit case exceeded its 10-second harness limit; that file passed 2/2 alone,
  and bounded groups passed all 190 tests as 45 + 69 + 69 + 7. The dry-run bundle is 930.13 KiB
  (161.37 KiB gzip). No migration is required. Feature checkpoint: `21ba179`.
- 2026-08-15: Code-only remote preflight found no pending migration and zero organizations,
  customers, plans, subscriptions, invoices, billable metrics, charges, fixed charges, usage
  events, outbox rows, and plan-deletion tasks. Deployed only the isolated Worker as version
  `5e109b75-a4aa-4074-97b7-f4c11516c4b3` with a 5 ms startup. Health/readiness returned `200`/`200`,
  unauthenticated standalone-charge access returned `401`, no migrations remain, and post-deploy
  aggregate-only verification stayed empty apart from 207 schedule audits. All three
  external-action flags remain `0`; no migration, resource provisioning, production route/domain,
  secret, provider action, customer data, or billing row changed.
- 2026-08-15: Ported standalone fixed-charge `cascade_updates` across subscription override graphs.
  Create clones the complete supported fixed charge into every direct child plan with an active or
  pending subscription and records independent child IDs plus parent links. Update propagates code
  only to model-compatible children and propagates units/properties only while the child still
  equals the parent's old model/properties/units; subscriber-customized pricing is preserved,
  model-mismatched children are skipped, and charge-level display names remain child-local. Delete
  retires eligible children with the parent. Parent, children, and versioned outbox events commit in
  one D1 batch guarded by the complete eligible child ID/version set. The synchronous path is
  bounded to 100 direct children and 512 KiB of prepared cascade JSON. Evidence covers inherited
  pricing, customized-price preservation, model mismatch, code/display behavior, no-child success,
  independent child creation, and parent/child retirement. Strict format/lint, inventory, and
  TypeScript checks pass. The fully parallel suite passed 191/192 before the known
  draft-termination-credit case exceeded its 10-second harness limit; that file passed 2/2 alone,
  and bounded groups passed all 192 tests as 45 + 69 + 71 + 7. The dry-run bundle is 947.30 KiB
  (163.83 KiB gzip). No migration is required. Feature checkpoint: `3b7fa34`.
- 2026-08-15: Code-only remote preflight found no pending migration and zero organizations,
  customers, plans, subscriptions, invoices, billable metrics, charges, fixed charges, usage
  events, outbox rows, and plan-deletion tasks. Deployed only the isolated Worker as version
  `163d0504-99f3-4424-aeb4-db12b0fc9e59` with an 8 ms startup. Health/readiness returned
  `200`/`200`, unauthenticated standalone fixed-charge access returned `401`, no migrations remain,
  and post-deploy aggregate-only verification stayed empty apart from 210 schedule audits. All
  three external-action flags remain `0`; no migration, resource provisioning, production
  route/domain, secret, provider action, customer data, or billing row changed.
- 2026-08-15: Ported scalar plan-amount `cascade_updates` for subscription override plans.
  Migration `0048_plan_override_version_scope.sql` corrects the discovered version-scope defect by
  applying `(organization, code, version)` uniqueness only to catalog roots; hidden child plans now
  retain the public code while versioning independently. The migration rebuilds the final plan
  schema, restores its indexes and draft/deletion/subscribability triggers, and passes an explicit
  foreign-key check. A bounded D1 transaction now updates only direct child plans whose amount still
  equals the parent's old amount, preserves subscriber-customized amounts, guards the complete
  eligible child ID/version set, and emits parent/child outbox events. Non-cascade updates remain
  root-only. The synchronous contract supports at most 100 unchanged children and 64 KiB of guard
  JSON. Strict format/lint, inventory, TypeScript, migration replay, plan/override/plan-change
  evidence, and foreign-key integrity checks pass. The fully parallel suite passed 192/193 before
  the known draft-termination-credit case exceeded its 10-second harness limit; that file passed
  2/2 alone, and bounded groups passed all 193 tests as 45 + 69 + 72 + 7. The dry-run bundle is
  952.92 KiB (164.26 KiB gzip). Feature checkpoint: `aa52ef6`.
- 2026-08-15: Remote preflight found only `0048_plan_override_version_scope.sql` pending and zero
  organizations, customers, plans, subscriptions, invoices, billable metrics, charges, fixed
  charges, usage events, outbox rows, and plan-deletion tasks. Applied only that migration to the
  isolated non-production D1, verified the root-only unique index and zero foreign-key violations,
  and deployed only the isolated Worker as version `689476ed-8c07-4500-91a0-b696c2e05045` with a
  9 ms startup. Health/readiness returned `200`/`200`, unauthenticated plan access returned `401`,
  no migrations remain, and post-deploy aggregate-only verification stayed empty apart from 214
  schedule audits. All three external-action flags remain `0`; no resource provisioning,
  production route/domain, secret, provider action, customer data, or billing row changed.
- 2026-08-15: Ported Lago-compatible subscription fixed-charge list/show/update routes. The first
  update now reuses the same bounded pricing-graph override preparer and transactional persister as
  subscription charge-filter mutations: it clones every active usage and fixed charge, assigns
  independent deterministic child identities and parent links, switches only the selected
  subscription generation, and applies the fixed-charge display name, properties, and units to the
  selected child. Later updates reuse that graph, guard the child version, refresh affected drafts
  through the existing trigger, and emit transactional `fixed_charge.updated` outbox events. The
  catalog root remains unchanged. Immediate unit-event application and fixed-charge-specific tax
  targeting fail explicitly because those subsystems are not yet ported. Evidence covers
  pagination, show, first and repeated update, complete graph cloning, filter preservation, parent
  isolation, parent IDs, outbox versions, unsupported-feature rejection before mutation, and
  precise not-found errors. Strict format/lint, inventory, generated types, TypeScript, and the
  complete Worker suite pass at 196 tests across 35 files. Wrangler's dry-run bundle is 967.78 KiB
  (166.75 KiB gzip). No migration is required. Feature checkpoint: `f5447c6`.
- 2026-08-15: Code-only remote preflight found no pending migration and zero organizations,
  customers, plans, subscriptions, invoices, billable metrics, charges, fixed charges, usage
  events, outbox rows, and plan-deletion tasks, with zero foreign-key violations. Deployed only the
  isolated Worker as version `bf78b018-adf9-4858-9613-45a4ce4873a8` with a 7 ms startup.
  Health/readiness returned `200`/`200`, unauthenticated subscription fixed-charge access returned
  `401`, no migrations remain, and post-deploy aggregate-only verification stayed empty apart from
  218 schedule audits. All three external-action flags remain `0`; no migration, resource
  provisioning, production route/domain, secret, provider action, customer data, or billing row
  changed.
- 2026-08-15: Closed the subscription fixed-charge unit-timing gap found during post-deployment
  review. Migration `0049_fixed_charge_unit_events.sql` adds a tenant- and subscription-scoped
  effective-dated unit ledger with deterministic version order. A first override records the
  inherited open-period baseline and the requested child value in the same D1 batch as the graph
  clone; later mutations append a versioned value in the same batch as the guarded fixed-charge
  update and outbox event. Default updates become effective at the next half-open period boundary,
  while `apply_units_immediately: true` becomes effective at mutation time. Invoice, draft,
  termination, and current projections select the newest created fixed-charge version that is
  effective before their calculation boundary, so a newer immediate change cannot be superseded by
  an older scheduled value. Pending subscriptions retain row fallback until activation. Evidence
  covers current/next-period pricing, repeated scheduled changes, immediate changes, mixed
  scheduled/immediate ordering, event rows, and graph/root isolation. All 49 migrations replay in
  fresh isolated D1 state with zero foreign-key violations. Strict format/lint, inventory,
  generated types, TypeScript, and Wrangler dry run pass; the fully parallel suite reached 197/198
  before the known draft-termination-credit 10-second timeout, that file passed 2/2 alone, and
  bounded groups pass all 198 tests as 36 + 43 + 70 + 42 + 7. The dry-run bundle is 971.99 KiB
  (167.61 KiB gzip). Feature checkpoint: `2217cc7`.
- 2026-08-15: Remote preflight found only `0049_fixed_charge_unit_events.sql` pending and zero
  organizations, customers, plans, subscriptions, invoices, billable metrics, charges, fixed
  charges, usage events, outbox rows, and plan-deletion tasks, with zero foreign-key violations.
  Applied only that migration to the isolated non-production D1, verified the unit-event lookup
  index, and deployed only the isolated Worker as version
  `c4fae6b3-1bd8-4931-b999-10b60edda727` with a 5 ms startup. Health/readiness returned
  `200`/`200`, unauthenticated subscription fixed-charge access returned `401`, no migrations
  remain, and post-deploy aggregate-only verification stayed empty apart from 222 schedule audits.
  All three external-action flags remain `0`; no resource provisioning, production route/domain,
  secret, provider action, customer data, or billing row changed.
- 2026-08-15: Extended the effective-dated fixed-charge unit ledger to catalog create/update and
  `cascade_updates`. New supported charges and inherited unit changes now emit one unit value per
  active or past-due subscription at the next period boundary by default, or at mutation time when
  `apply_units_immediately: true` is explicit. Updates preserve an open-period baseline, skip
  unit-event writes when units are unchanged, leave pending subscriptions on row fallback until
  activation, and propagate the same timing to eligible child-plan charges without modifying
  subscriber-customized pricing. The first catalog mutation is guarded by the exact prepared
  subscription ID, plan, version, status, and billing-period set, so a concurrent activation,
  period move, or graph change cannot commit catalog state without its ledger rows. The synchronous
  contract is bounded to 200 active subscription event targets and 512 KiB of prepared event JSON.
  Strict format/lint, inventory, generated types, TypeScript, and Wrangler dry run pass. The fully
  parallel suite reached 198/199 before the known `draft-termination-credit` 10-second timeout;
  bounded groups pass all 199 tests as 37 + 43 + 70 + 42 + 7, including Store checkout
  compatibility. The dry-run bundle is 981.94 KiB (169.22 KiB gzip). No migration is required;
  this reuses migration `0049_fixed_charge_unit_events.sql`. Feature checkpoint: `c964e7c`.
- 2026-08-15: Code-only remote preflight found no pending migration and zero organizations,
  customers, plans, subscriptions, invoices, billable metrics, charges, fixed charges,
  fixed-charge unit events, usage events, wallets, outbox rows, and plan-deletion tasks, with zero
  foreign-key violations. Deployed only the isolated Worker as version
  `2c67b47e-40f2-4562-ad97-11752f1bc1c0` with a 7 ms startup. Health/readiness returned `200`/`200`,
  unauthenticated catalog fixed-charge access returned `401`, no migrations remain, and
  post-deploy aggregate-only verification stayed empty apart from 228 schedule audits. All three
  external-action flags remain `0`; no migration, resource provisioning, production route/domain,
  secret, provider action, customer data, or billing row changed.
- 2026-08-15: Ported in-arrears fixed-charge proration for standard, volume, and graduated pricing.
  Migration `0050_prorated_fixed_charges.sql` admits `prorated` catalog rows while retaining the
  explicit pay-in-advance guard and restoring all eight fixed-charge draft/deletion triggers after
  the D1 table rebuild. Period calculation uses the effective-dated unit ledger, customer-local
  civil days, half-open billing boundaries, and six-decimal half-up segment weighting. Standard
  and volume models rate the weighted units; graduated pricing selects tiers from the final full
  units, prorates per-unit portions, and retains reached flat amounts. The bounded invoice read
  accepts at most 1,000 current-period events plus the latest prior state, and later-version
  immediate values supersede earlier scheduled values. Renewal, current-usage, cascade, DST, and
  immediate/scheduled termination evidence cover the retained contract. All 50 migrations replay
  in a fresh isolated D1 with zero foreign-key violations. A second actual-D1 preservation audit
  seeded a root/child plan graph, fixed charges, an active subscription, and a child unit event
  through migrations 1-49; applying migration 0050 preserved all rows and parent links, restored
  all eight triggers, and left zero foreign-key violations. Strict format/lint, inventory,
  generated types, TypeScript, and Wrangler dry run pass. The fully parallel suite reached 203/204
  before the known `draft-termination-credit` 10-second timeout; bounded groups pass all 204 tests
  as 37 + 35 + 71 + 54 + 7, including Store checkout compatibility. The dry-run bundle is 988.90
  KiB (170.59 KiB gzip). Feature checkpoint: `edd0ee0`.
- 2026-08-15: Remote preflight found only `0050_prorated_fixed_charges.sql` pending and zero
  organizations, customers, plans, subscriptions, invoices, billable metrics, charges, fixed
  charges, fixed-charge unit events, usage events, wallets, outbox rows, and plan-deletion tasks,
  with zero foreign-key violations. Applied only that migration to the isolated non-production D1,
  then verified the widened proration check, retained pay-in-advance guard, all three fixed-charge
  indexes, all eight restored triggers, and zero foreign-key violations. Deployed only the isolated
  Worker as version `1e09848e-4729-4154-9db5-f4e55ef82a6d` with a 5 ms startup. Health/readiness
  returned `200`/`200`, unauthenticated catalog fixed-charge access returned `401`, no migrations
  remain, and post-deploy aggregate-only verification stayed empty apart from 236 schedule audits.
  All three external-action flags remain `0`; no resource provisioning, production route/domain,
  secret, provider action, customer data, or billing row changed.
- 2026-08-15: Ported Lago's pay-in-advance fixed-charge contract. Migration
  `0051_pay_in_advance_fixed_charges.sql` admits checked advance catalog rows, adds immediate-event
  billing/repair evidence, and restores all eight fixed-charge draft/deletion triggers after the
  table rebuild. Standard advance charges support proration; graduated advance charges remain
  non-prorated and volume advance charges fail explicitly. Activation bills advance fixed charges
  even when the base is in arrears or trialing, while an advance base combines its base and fixed
  lines in one starting invoice. Renewal snapshots advance fixed charges against the upcoming
  period. Immediate increases charge only units not already paid in the open period, decreases
  persist a zero-amount invoice without refunding, and deterministic invoice IDs plus the
  five-minute reconciliation owner repair committed event/invoice gaps. Catalog, inherited-child,
  and subscription-override unit changes use the same bounded path. Upgrade invoices include target
  advance fixed charges even for an in-arrears target base and deduct the overlapping prepaid amount
  when a prorated prior-generation charge uses the same add-on. Coupons, manual taxes, credit-note
  balances, wallets, invoice ownership, custom-section triggers, and outbox delivery use the normal
  invoice allocation path. All 51 migrations replayed from zero in an actual isolated D1 state with
  zero foreign-key violations, the widened timing check, all three event columns, the repair index,
  and all eight restored triggers. Strict format/lint, inventory, generated types, TypeScript, and
  Wrangler dry run pass; the serial suite passes all 207 tests across 37 files in 114.79 seconds.
  The dry-run bundle is 1015.84 KiB (175.71 KiB gzip). Feature checkpoint: `c9642d7`.
- 2026-08-15: Remote preflight found only `0051_pay_in_advance_fixed_charges.sql` pending and zero
  organizations, customers, plans, subscriptions, invoices, fixed charges, fixed-charge unit
  events, usage events, wallets, outbox rows, and plan-deletion tasks, with zero foreign-key
  violations. Applied only that migration to the isolated non-production D1, then verified the
  widened timing check, all three event billing/repair columns, the repair index, all eight restored
  triggers, zero foreign-key violations, and no remaining migration. Deployed only the isolated
  Worker as version `58bf3a55-d194-4762-a390-a6794c360194` with a 5 ms startup. Health/readiness
  returned `200`/`200`, unauthenticated fixed-charge access returned `401`, and post-deploy
  aggregate-only verification stayed empty apart from 246 schedule audits. All three external-
  action flags remain `0`; no resource provisioning, production route/domain, secret, provider
  action, customer data, or billing row changed.
- 2026-08-15: Ported Lago's event-triggered, invoiceable pay-in-advance usage contract for count,
  sum, and unique-count metrics with standard, graduated, package, percentage, and graduated-
  percentage rating. Each usage event creates one marginal finalized invoice per matching charge;
  filter-specific pricing, target-wallet grouping, coupons, manual taxes, credit-note balances,
  wallets, invoice ownership, custom-section triggers, and outbox events use the existing invoice
  pipeline. Migration `0052_pay_in_advance_usage_charges.sql` adds an atomic event/charge billing
  ledger so Queue delivery is replay-safe, while the five-minute reconciliation owner repairs
  persisted events that missed Queue processing. Catalog validation keeps non-invoiceable or
  prorated advance usage, volume/custom aggregation, positive minimums, and grouped pricing as
  explicit unsupported boundaries. All 52 migrations replayed from zero in an isolated local D1
  state with 15 ledger columns, four indexes, and zero foreign-key violations. Strict format/lint,
  inventory, generated types, TypeScript, and Wrangler dry run pass. The parallel suite reached
  209/210 before the known `draft-termination-credit` 10-second load timeout; that file passed 2/2
  alone, and the serial suite passes all 210 tests across 38 files in 124.96 seconds. The dry-run
  bundle is 1036.03 KiB (179.42 KiB gzip). Feature checkpoint: `a6fb8a8`.
- 2026-08-15: Remote preflight found only `0052_pay_in_advance_usage_charges.sql` pending and zero
  organizations, customers, plans, subscriptions, invoices, billable metrics, charges, fixed
  charges, usage events, wallets, outbox rows, and plan-deletion tasks, with zero foreign-key
  violations. Applied only that migration to the isolated non-production D1, then verified the
  15-column strict event/charge ledger, four indexes, 52 total migrations, zero foreign-key
  violations, and no remaining migration. Deployed only the isolated Worker as version
  `b201ce1f-43dd-4097-bfbf-491e448b8fb3` with a 6 ms startup. Health/readiness returned
  `200`/`200`, unauthenticated charge access returned `401`, and post-deploy aggregate-only
  verification stayed empty apart from 254 schedule audits. All three external-action flags remain
  `0`; no resource provisioning, production route/domain, secret, provider action, customer data,
  or billing row changed.
- 2026-08-15: Replaced Lago's `ProcessAllSubscriptionActivities`, dedicated subscription-activity,
  and `RefreshLifetimeUsages` Clockwork/Sidekiq path with D1, Queue, and Workflows. Migration
  `0053_lifetime_usage_projection.sql` adds a coalesced activity record, guarded activity version,
  last-received event date, and lineage-scoped lifetime projection. Event and activity writes are
  atomic; Queue delivery refreshes immediately without blocking unrelated outbound delivery, the
  one-minute Workflow drains missed activity, and the five-minute owner rotates through retained
  projections. Current usage reuses the existing bounded rating pipeline, invoiced usage sums
  draft/finalized usage lines across non-canceled subscription generations, and
  `GET`/`PUT /api/v1/subscriptions/:external_id/lifetime_usage` preserve Lago's external historical
  amount contract. A poison projection exhausts only its own retries and remains pending for later
  repair. All 53 migrations apply in the official Workers test runtime; an independent SQLite
  replay found 13 lifetime columns, 10 activity columns, four lifetime indexes, and zero foreign-
  key violations. The standalone local-D1 launcher in Wrangler 4.122.0 and 4.123.0 crashed on this
  mounted workspace, so it was not treated as schema evidence. Strict format/lint, inventory,
  generated bindings, TypeScript, and Wrangler dry run pass; the complete serial suite passes all
  213 tests across 39 files. The dry-run bundle is 1053.25 KiB (182.18 KiB gzip). Progressive
  thresholds and usage-alert delivery remain explicit follow-up scope. Feature checkpoint:
  `85c6a0e`.
- 2026-08-15: Remote preflight found only `0053_lifetime_usage_projection.sql` pending and zero
  organizations, customers, plans, subscriptions, invoices, usage events, advance-usage billings,
  outbox rows, and plan-deletion tasks, with zero foreign-key violations. Applied only that
  migration to the isolated non-production D1, then verified 53 migrations, 13 lifetime columns,
  10 activity columns, four lifetime indexes, the subscription event-date column, zero projection
  rows, zero foreign-key violations, and no remaining migration. Deployed only the isolated Worker
  as version `93d81d34-d6b3-4c1e-99d0-33d7d11cfa4a` with a 5 ms startup and the retained resources;
  its Cron changed from five-minute to one-minute dispatch. Health/readiness returned `200`/`200`,
  unauthenticated lifetime-usage access returned `401`, and post-deploy aggregate-only verification
  stayed empty apart from 270 schedule audits. All three external-action flags remain `0`; no
  resource provisioning, production route/domain, secret, provider action, customer data, or
  billing row changed.
- 2026-08-15: Dispositioned two more analytics-container loops without inventing replacement
  infrastructure. `post_validate_events` is now an implemented, audited
  `synchronous_precommit` boundary because metric-code, aggregation-property, and filter-value
  errors are rejected before the Worker commits D1, R2, or outbox state. The deprecated
  `refresh_flagged_subscriptions` Redis/ClickHouse loop now shares the one-minute D1 subscription-
  activity executor and existing wallet projection; `compute_daily_usage` remains explicitly
  unported because it owns real revenue-analytics snapshots rather than transport compensation.
  Focused schedule, metering, lifetime, and wallet evidence passes all 34 tests, strict
  format/lint/TypeScript pass, and the dry-run bundle is 1053.82 KiB (182.27 KiB gzip). Code
  checkpoint: `cbc5553`. Code-only remote preflight found no pending migration, zero organizations,
  subscriptions, usage events, lifetime usages, subscription activities, and outbox rows, with
  zero foreign-key violations. Deployed only the isolated Worker as version
  `e954f939-9d91-4459-b71f-df3a5dd2aa75` with a 5 ms startup and unchanged resources/one-minute
  Cron. Health/readiness returned `200`/`200`; post-deploy aggregate-only verification stayed empty
  apart from 277 schedule audits. All three external-action flags remain `0`; no resource
  provisioning, production route/domain, secret, provider action, customer data, or billing row
  changed.
- 2026-08-15: Ported the retained `ComputeAllDailyUsages` revenue-analytics owner without Rails,
  Sidekiq, PostgreSQL, Redis, or ClickHouse. Migration `0054_daily_usage_projection.sql` adds a
  strict D1 cumulative snapshot plus normalized per-charge cumulative/delta rows. Customer-local
  runs at the legacy hourly `:15` slot select only the 00:00-02:59 repair window, stop rating at
  local midnight, require recent subscription activity, skip an already-advanced billing day, and
  use one deterministic retryable Workflow step per subscription/date. Versioned draft/finalized
  invoice lines repair the skipped billing boundary across periodic and single-subscription invoice
  paths; event-triggered pay-in-advance usage invoices are excluded because they are marginal
  billing evidence. Invoice versions can replace an older projection, scheduled replay cannot
  replace invoice authority, and one poison candidate does not block its peers. Lago's cumulative
  `usage` and `usage_diff` payloads remain durable while indexed exact-decimal delta rows prevent
  weekly/monthly rollups from summing cumulative values. The internal D1 rollup query is ready for
  the later operator analytics API/GraphQL adapter. The official Workers runtime applies all 54
  migrations; independent SQLite replay found 21 snapshot columns, 20 normalized-line columns, 11
  relevant indexes, an indexed organization/date query plan, and zero foreign-key violations.
  Strict format/lint, inventory, generated bindings, TypeScript, and Wrangler dry run pass; the
  complete serial suite passes all 217 tests across 40 files in 131.69 seconds. The dry-run bundle
  is 1077.87 KiB (187.19 KiB gzip).
- 2026-08-15: Remote preflight found only `0054_daily_usage_projection.sql` pending and zero
  organizations, customers, plans, subscriptions, invoices, billable metrics, charges, usage
  events, advance-usage billings, outbox rows, and foreign-key violations; the existing 307 rows
  were schedule audits only. Applied only migration 0054 to the isolated non-production D1, then
  verified 54 migrations, 21 snapshot columns, 20 normalized-line columns, 11 projection indexes,
  the indexed rollup query plan, zero projection rows, zero foreign-key violations, and no pending
  migration. Deployed only `serp-dev-lago-native` as version
  `e52643ed-8a2a-4614-9465-dcef63bd448f` with a 5 ms startup and the unchanged one-minute Cron.
  Health/readiness returned `200`/`200`, unauthenticated current usage returned `401`, and the
  post-deploy aggregate-only audit remained empty apart from 308 schedule runs. All three external-
  action flags remain `0`; no production route/domain, secret, provider action, customer data,
  payment action, or billing row changed.
- 2026-08-15: Ported Lago's plan/subscription usage-threshold and progressive-billing path to the
  existing Worker stack. Migration `0055_progressive_usage_thresholds.sql` adds strict D1 ownership,
  applied-threshold evidence, cumulative progressive-invoice markers, and explicit credit links.
  Plan and subscription create/update APIs validate fixed/recurring threshold sets, preserve
  omit-versus-clear behavior, expose subscription override/plan fallback, and carry supplied
  thresholds atomically through pending updates, upgrades, and queued downgrades. The existing
  lifetime projection drives exact legacy fixed/recurring crossing math in deterministic
  per-subscription Workflow steps. Progressive invoices contain cumulative usage only and skip
  charge minimums; each later progressive, periodic, termination, plan-change, or refreshed draft
  invoice credits the latest cumulative amount before coupon/tax allocation. A source or downward
  correction creates a deterministic finalized credit note against the latest progressive invoice
  in the same D1 batch, with item and outbox evidence. Independent SQLite replay found 72 tables,
  11 threshold columns, 10 progressive-marker columns, seven applied-threshold columns, 16 relevant
  indexes, and zero foreign-key violations. Strict format/lint, generated-inventory freshness,
  Wrangler bindings, TypeScript, and the dry build pass; all 228 tests across 42 files pass serially
  in 138.36 seconds. The dry-run bundle is 1130.41 KiB (196.38 KiB gzip). Dedicated
  usage-monitoring alerts and the operator progressive-billing UI remain later contracts.
- 2026-08-15: Remote preflight found only `0055_progressive_usage_thresholds.sql` pending and zero
  organizations, customers, plans, subscriptions, invoices, usage events, lifetime/daily-usage
  projections, and outbox rows, with zero foreign-key violations. Applied only migration 0055 to
  the isolated non-production D1 and verified 55 migrations, 11 threshold columns, 10 progressive-
  marker columns, seven applied-threshold columns, 16 relevant indexes, zero new ledger rows, zero
  foreign-key violations, and no remaining migration. Deployed only `serp-dev-lago-native` as
  version `281964e8-37a4-4e11-b555-91f941a797cd` with a 5 ms startup and unchanged resources/
  one-minute Cron. Health/readiness returned `200`/`200`, unauthenticated plan access returned
  `401`, and the aggregate-only audit remained empty apart from 374 schedule runs. All three
  external-action flags remain `0`; no production route/domain, secret, provider action, customer
  data, payment action, or billing ledger row changed.
- 2026-08-15: Consolidated Lago's cached API-key-use write and hourly
  `ApiKeys::TrackUsageService` flush into successful Worker authentication. Migration
  `0056_api_key_usage_tracking.sql` adds nullable D1 `last_used_at` plus its audit index; the
  authentication write shares the active-key predicate, advances monotonically, and rejects a key
  revoked between lookup and persistence. The retained hourly `:15` schedule is now an audited
  synchronous-authentication boundary rather than a Redis/cache consumer. All 56 migrations replay
  independently with seven API-key columns, the usage index, and zero foreign-key violations.
  Strict formatting, lint, inventory, bindings, TypeScript, and dry build pass; all 230 tests across
  43 files pass serially in 140.21 seconds. The dry-run bundle is 1131.03 KiB (196.54 KiB gzip).
- 2026-08-15: Remote preflight found only `0056_api_key_usage_tracking.sql` pending and zero
  organizations, API keys, customers, subscriptions, invoices, usage thresholds, and outbox rows,
  with zero foreign-key violations. Applied only migration 0056 and verified 56 migrations, seven
  API-key columns, the last-use index, zero API-key rows, zero foreign-key violations, and no
  remaining migration. Deployed only `serp-dev-lago-native` as version
  `693a3713-3878-488a-ae1e-da5865c02f10` with a 5 ms startup and unchanged resources/one-minute
  Cron. Health/readiness returned `200`/`200`, unauthenticated plan access returned `401`, and the
  aggregate-only audit remained empty apart from 385 schedule runs. All three external-action flags
  remain `0`; no production route/domain, secret, provider action, customer data, payment action,
  or billing ledger row changed.
- 2026-08-15: Ported the hourly subscription termination-alert owner as deterministic D1 outbox
  evidence. Active subscriptions ending on the exact UTC 15/45-day windows receive one event per
  subscription/trigger date; pending, terminated, canceled, and nonmatching endings are excluded,
  and Workflow replay is conflict-safe. Outbound delivery remains behind its disabled safety gate.
  Strict format/lint/inventory/bindings/TypeScript pass, all 231 tests across 44 files pass serially
  in 144.43 seconds, and the dry-run bundle is 1133.38 KiB (196.95 KiB gzip).
- 2026-08-15: Code-only remote preflight found no pending migration and zero organizations,
  subscriptions, invoices, and outbox rows, with zero foreign-key violations. Deployed only
  `serp-dev-lago-native` as version `37eda23e-2150-44be-874c-aca20ddee58e` with a 6 ms startup and
  unchanged resources/one-minute Cron. A fresh post-deploy audit found the same empty business
  state plus 396 schedule runs. Health/readiness returned `200`/`200`, unauthenticated plan access
  returned `401`, and all three external-action flags remain `0`; no customer message, production
  route/domain, secret, provider action, customer data, payment action, or billing row changed.
- 2026-08-15: Consolidated the legacy dedicated-organization wallet refresher into the global D1
  wallet-projection owner. Lago's two jobs invoke the same per-customer refresh service and differ
  only by Sidekiq tenant partition/cadence; the Worker already scans every active-wallet customer,
  while Workers supplies horizontal isolation without a tenant-ID environment list. The dynamic
  legacy cadence remains documented for source traceability but no longer requires its own process.
  Focused schedule and wallet-projection evidence passes all 22 tests, with strict formatting,
  lint, generated-inventory freshness, Wrangler binding types, and TypeScript also green.
- 2026-08-15: Added the container-free payment-request foundation required by dunning. Migration
  `0057_payment_requests.sql` owns the request and invoice-link ledgers in D1, with tenant/customer,
  finalized-overdue state, and optimistic invoice-version triggers. Authenticated create/list/show
  and customer-nested list routes calculate one-currency outstanding balances, persist all links
  and `payment_request.created` evidence atomically, and return Lago-shaped customer/invoice data.
  Creation is intentionally internal only: it does not call a payment provider or send email, and
  the existing external-action gates remain authoritative. Evidence covers multi-invoice totals,
  filters, tenant/customer isolation, invalid state, and late trigger
  rollback. All 57 migrations replay independently with two request tables, nine relevant indexes,
  two triggers, and zero foreign-key violations. Strict format/lint/inventory/bindings/TypeScript
  pass; all 236 tests across 45 files pass serially in 146.55 seconds. The dry-run bundle is
  1147.23 KiB (200.28 KiB gzip).
- 2026-08-15: Remote preflight found exactly `0057_payment_requests.sql` pending and zero
  organizations, customers, subscriptions, invoices, payment attempts, and outbox rows, with zero
  foreign-key violations and 433 schedule audits. The first apply attempt failed atomically with
  Cloudflare error `7500` because its SQL splitter rejected a `CASE` expression inside each trigger;
  the migration remained pending and neither table existed. Rewrote the equivalent guards using
  the repository's proven trigger-level `WHEN NOT EXISTS` form, replayed all 57 migrations and the
  focused tests locally, then applied only 0057 successfully. Remote verification found 57
  migrations, two request tables, nine relevant indexes, two triggers, empty request/link ledgers,
  zero foreign-key violations, and no pending migration. Deployed only `serp-dev-lago-native` as
  version `95137700-dbf8-4f20-98cb-c7a399ca9cd2` with a 6 ms startup and unchanged one-minute Cron/
  resource bindings. Health/readiness returned `200`/`200`, unauthenticated payment-request access
  returned `401`, and post-deploy aggregate verification remained empty apart from 436 schedule
  audits. Version inspection confirmed only fetch/scheduled/queue handlers and all three external-
  action flags at `0`; no production route/domain, secret, provider action, customer data, payment
  action, or billing row changed.
- 2026-08-15: Added the container-free dunning campaign and scheduled-request foundation.
  Migration `0058_dunning_campaigns.sql` owns tenant-scoped campaigns, currency thresholds,
  organization defaults, customer overrides/exclusions and attempt state, plus guarded dunning
  request provenance. Authenticated REST CRUD replaces the retained operator campaign mutations;
  customer upserts accept campaign overrides and exclusions and reset attempt state when assignment
  changes. The hourly `:45` Workflow executor selects ready overdue invoices, respects threshold
  currency, elapsed days, maximum attempts and exclusions, and atomically writes one
  deterministic payment request, version-pinned invoice links, the customer attempt advance, and
  outbox evidence. The terminal attempt emits `dunning_campaign.finished`. Provider submission and
  fallback email remain deliberately unported and externally gated, so the schedule is recorded as
  partial rather than implemented. All 58 migrations replay independently with three dunning
  tables, ten related indexes, seven triggers, and zero foreign-key violations. Strict formatting,
  lint, inventory, Wrangler binding types, and TypeScript pass; all 241 tests across 46 files pass
  serially in 155.72 seconds. The dry-run bundle is 1186.95 KiB (206.42 KiB gzip). This is a local
  pre-deployment checkpoint; no remote resource or data was changed by this entry.
- 2026-08-15: Remote preflight found exactly `0058_dunning_campaigns.sql` pending and zero
  organizations, customers, subscriptions, invoices, payment attempts, payment requests, invoice
  links, and outbox rows, with zero foreign-key violations and 468 schedule audits. Version
  inspection confirmed the previously deployed Worker still had all three external-action flags at
  `0`. Applied only migration 0058, then verified 58 migrations, three dunning tables, ten related
  indexes, seven triggers, all expected organization/customer/payment-request columns, empty
  dunning ledgers, zero foreign-key violations, and no pending migration. Deployed only
  `serp-dev-lago-native` as version `04e1efea-8ca6-4b7b-b8a9-cfa72816326d` with a 6 ms startup and
  unchanged one-minute Cron/resource bindings. Health/readiness returned `200`/`200`,
  unauthenticated dunning access returned `401`, and post-deploy aggregate verification remained
  empty apart from 469 schedule audits. The deployed version exposes only the expected fetch,
  scheduled, and queue handlers and all three external-action flags remain `0`; no production
  route/domain, secret, customer message, provider action, customer data, payment action, or
  billing row changed.
- 2026-08-15: Exact upstream review after the first dunning deployment identified two retained
  invoice semantics that needed an additive correction: campaign eligibility compares the full
  total of ready overdue invoices, while the resulting payment request charges only their remaining
  balance; invoices paused for payment processing are excluded. Added forward-only migration
  `0059_invoice_payment_processing_state.sql` rather than editing applied migration 0058. It adds
  invoice readiness state, an eligible-invoice index, and replaces the invoice-link/dunning guards
  with readiness-aware predicates and the exact full-total threshold. Manual and Authorize.Net
  reconciliation now close readiness on full success and reopen it for nonterminal provider
  outcomes. Evidence includes a 1,000-cent invoice with a 600-cent successful partial payment that
  remains threshold-eligible and produces a 400-cent request. All 59 migrations replay
  independently with the readiness column/index, both replacement guards, and zero foreign-key
  violations. Strict format/lint/inventory/bindings/TypeScript pass; all 241 tests across 46 files
  pass serially in 150.54 seconds. The dry-run bundle is 1187.41 KiB (206.51 KiB gzip). This is a
  local pre-deployment checkpoint; no remote resource or data was changed by this entry.
- 2026-08-15: Remote preflight found exactly `0059_invoice_payment_processing_state.sql` pending
  and zero organizations, customers, invoices, payment attempts, payment requests, dunning
  campaigns, and outbox rows, with zero foreign-key violations and 483 schedule audits. Applied
  only migration 0059, then verified 59 migrations, the one invoice-readiness column and eligibility
  index, both replacement guards, zero foreign-key violations, and no pending migration. Deployed
  only `serp-dev-lago-native` as version `6fa02bbf-9342-4908-8268-6b8c02a7a9d7` with a 5 ms startup
  and unchanged one-minute Cron/resource bindings. Health/readiness returned `200`/`200`,
  unauthenticated dunning access returned `401`, and post-deploy aggregate verification remained
  empty apart from 484 schedule audits. Version inspection confirmed only the expected fetch,
  scheduled, and queue handlers and all three external-action flags at `0`; no production
  route/domain, secret, customer message, provider action, customer data, payment action, or
  billing row changed.
- 2026-08-15: Closed the last `not_started` Clockwork entry by consolidating
  `RetryFailedInvoicesJob` into an audited atomic-invoice boundary. The legacy job only scans
  persisted failed invoices whose error details contain an external-tax API-limit message. The
  Worker rejects external tax-provider configuration before mutation, has no tax-error-detail
  ledger, and commits each invoice graph atomically; therefore that retry state cannot be created.
  The every-15-minute slot remains visible, executable, and tested in the registry without adding
  a fake retry loop or container process. All 17 schedule-maintenance tests pass; strict formatting,
  lint, generated-inventory freshness, and TypeScript pass. The dry-run bundle is 1187.64 KiB
  (206.59 KiB gzip). No migration or remote resource is required for this code-only boundary.
- 2026-08-15: The first code-only remote migration-list preflight received transient Cloudflare
  OAuth error `10000`; the following read-only D1 audit succeeded, and an immediate list retry
  confirmed no pending migration. The audit found zero organizations, customers, invoices,
  payment requests, dunning campaigns, and outbox rows, zero foreign-key violations, and 493
  schedule audits. Deployed only `serp-dev-lago-native` as version
  `07654b79-8774-4de2-988b-b7323f86ebba` with a 5 ms startup and unchanged one-minute Cron/resource
  bindings. Health/readiness returned `200`/`200`; post-deploy aggregate verification remained
  empty apart from 494 schedule audits. Version inspection confirmed only the expected fetch,
  scheduled, and queue handlers and all three external-action flags at `0`; no production
  route/domain, secret, customer message, provider action, customer data, payment action, or
  billing row changed.
- 2026-08-15: Completed the current staging-readiness documentation audit. The resource manifest
  now names the actual latest version and all 59 migrations; the generated inventory maps all 27
  Clockwork entries to executable evidence with none left `not-started`; and the synthetic-only
  staging test plan defines provider-free replay/failure phases plus a separately approved sandbox
  phase. The direct package harness remains green, and a filename-only secret-pattern scan found no
  private-key, live Stripe, AWS access-key, GitHub token, or Slack token signatures across 212
  tracked `cloudflare/` and `docs/` files.
- 2026-08-15: Added the Authorize.Net payment-request reconciliation foundation required to settle
  multi-invoice dunning requests without a container runtime. Migration
  `0060_payment_request_payments.sql` owns one provider transaction per payment request, immutable
  per-invoice allocations, request/invoice reconciliation guards, and webhook payable linkage.
  `PaymentRequest` metadata now routes signed provider callbacks to this ledger; amount/currency
  mismatch or changed invoice balances fail explicitly, while success atomically advances the
  request and every linked invoice, resets dunning counters, emits payment/request/invoice outbox
  evidence, and remains monotonic across duplicate or later-regressing callbacks. Invoice balances,
  dunning selection, manual-payment limits, and the retained `/api/v1/payments` list/show contract
  include these allocations and expose the multi-invoice payable. No provider call or email was
  added, and all external-action gates remain authoritative. All 60 migrations replay independently.
  Strict format/lint/inventory/bindings/TypeScript pass; all 244 tests across 46 files pass serially
  in 150.44 seconds. The dry-run bundle is 1206.42 KiB (209.38 KiB gzip). This is a local pre-
  deployment checkpoint; no remote resource or data was changed by this entry.
- 2026-08-15: Remote preflight found exactly `0060_payment_request_payments.sql` pending and zero
  organizations, customers, invoices, payment attempts, payment requests, invoice links, dunning
  campaigns, and outbox rows, with zero foreign-key violations and 531 schedule audits. Applied
  only migration 0060, then verified 60 migrations, all four request-payment/allocation/
  reconciliation-guard tables, the webhook payable column, expected indexes/triggers, empty new
  ledgers, zero foreign-key violations, and no pending migration. Deployed only
  `serp-dev-lago-native` as version `0601e495-d49b-4e9d-a118-0d36836f1cd4` with a 5 ms startup and
  unchanged one-minute Cron/resource bindings. Health/readiness returned `200`/`200`,
  unauthenticated payment access returned `401`, and post-deploy aggregate verification remained
  empty apart from 533 schedule audits. Version inspection confirmed only the expected fetch,
  scheduled, and queue handlers and all three external-action flags at `0`; no production
  route/domain, secret, customer message, provider action, customer data, or payment action
  occurred.
- 2026-08-15: Replaced the unused validation-only Checkout Workflow with durable Authorize.Net
  payment-request checkout orchestration. Migration
  `0061_payment_request_checkout_intents.sql` owns tenant/version/idempotency-guarded intent and
  outcome state. The minute reconciliation Workflow discovers pending requests only when
  `PAYMENT_MUTATIONS_ENABLED=1`, dispatches one deterministic checkout instance per request
  version, and records processing/success/failure transitions. Provider responses are sensitive
  Workflow outputs; D1 retains only the required hosted URL and token hash, while outbox events
  contain identifiers and expiry but no token or URL. The adapter emits Lago's exact
  `PaymentRequest` metadata so migration 0060 can reconcile the resulting webhook. Provider
  failures retain no URL/token and emit bounded failure evidence. No email or delivery channel was
  added, and the isolated deployment gate remains `0`. All 61 migrations replay independently.
  Strict format/lint/inventory/bindings/TypeScript pass; all 248 tests across 47 files pass serially
  in 152.79 seconds. The dry-run bundle is 1221.38 KiB (211.80 KiB gzip). This is a local pre-
  deployment checkpoint; no remote resource, provider, message, or data was changed by this entry.
- 2026-08-15: Remote preflight found exactly
  `0061_payment_request_checkout_intents.sql` pending and zero organizations, customers, invoices,
  payment requests, request payments/allocations/reconciliation guards, checkout prerequisites, and
  outbox rows, with zero foreign-key violations and 557 schedule audits. Applied only migration
  0061, then verified 61 migrations, the checkout-intent table, both indexes and both guards, empty
  checkout/business ledgers, zero foreign-key violations, and no pending migration. Deployed only
  `serp-dev-lago-native` as version `2961998a-0351-4620-ab58-d2d8ffa786d1` with a 5 ms startup and
  unchanged one-minute Cron/resource bindings. Health/readiness returned `200`/`200`,
  unauthenticated payment-request access returned `401`, and post-deploy aggregate verification
  remained empty apart from 558 schedule audits. Version inspection confirmed only the expected
  fetch, scheduled, and queue handlers and all three external-action flags at `0`; the new
  dispatcher created zero checkout intents and made no provider call. No production route/domain,
  secret, customer message, provider action, customer data, or payment action occurred.
- 2026-08-15: Consolidated the legacy hourly stuck-generating-invoice retry into the lease-aware
  billing-close executor. The Worker never persists a partially generated invoice: the complete
  graph and period transition share one D1 batch, while failed/stale `billing_cycles` are reclaimable.
  The retained `:30` slot now provides an additional real recovery pass without Sidekiq. Strict
  format/lint/inventory/bindings/TypeScript pass, all 232 tests across 44 files pass serially in
  144.19 seconds, and the dry-run bundle is 1133.43 KiB (196.96 KiB gzip).
- 2026-08-15: Code-only remote preflight found no pending migration and zero organizations,
  subscriptions, invoices, billing cycles, and outbox rows, with zero foreign-key violations.
  Deployed only `serp-dev-lago-native` as version `6ef7eaf2-897a-4e7c-a5b5-ababc064d0a7` with the
  unchanged one-minute Cron and resource bindings. Health/readiness returned `200`/`200`,
  unauthenticated plan access returned `401`, and the post-deploy aggregate-only audit remained
  empty apart from 405 schedule runs. The deployed version exposes only the expected fetch,
  scheduled, and queue handlers, and all three external-action flags remain `0`; no production
  route/domain, secret, provider action, customer data, payment action, or billing row changed.
- 2026-08-15: Closed the remaining local gap in the frozen four-call `store-new` checkout fixture.
  The compatibility suite now creates the customer/subscription/invoice, invokes the real invoice
  payment-URL route, intercepts a synthetic Authorize.Net response inside the Workers test runtime,
  verifies exact invoice metadata and amount, proves the Durable Object replay makes only one
  provider request, and verifies D1 retains the hosted URL plus a token hash rather than a plaintext
  token field. Added the previously missing non-secret `PUBLIC_BASE_URL` binding for the isolated
  workers.dev hostname; all three external-action gates remain `0`. Strict format, lint, inventory,
  generated bindings, and TypeScript checks pass; all 248 tests across 47 files pass serially in
  153.32 seconds, and the dry-run bundle remains 1221.38 KiB (211.80 KiB gzip). This is a local
  checkpoint only: no remote provider, secret, message, route, customer, or payment action occurred.
- 2026-08-15: Code-only remote preflight found no pending migration, no foreign-key violations,
  and zero organizations, customers, subscriptions, invoices, payment requests, checkout intents,
  and outbox rows. Deployed only the isolated Worker as version
  `80fee6c9-5be3-481e-898e-26013daa14ea` with a 5 ms startup, the existing one-minute Cron/resources,
  and the non-secret workers.dev `PUBLIC_BASE_URL`. Health/readiness returned `200`/`200` and an
  unauthenticated payment-URL request returned `401`. Version inspection confirmed only fetch,
  scheduled, and queue handlers and all three external-action flags at `0`. The post-deploy audit
  remained empty apart from 576 schedule runs, with no foreign-key violations; no production
  route/domain, secret, provider action, customer/message data, or payment action occurred.
- 2026-08-15: Ran the first provider-free isolated staging checkout as
  `synthetic-e2e-20260815-001`. A one-time random API key existed only inside the runner; D1 received
  its SHA-256 hash, and the exact key row was revoked after the run. The public API created one
  synthetic plan, customer, subscription, finalized 1,999-cent invoice, and invoice line. Exact
  plan/customer/subscription replay preserved identity, divergent subscription replay returned
  `subscription_idempotency_conflict`, and invoice discovery returned the expected finalized/
  pending invoice. The fourth frozen checkout call returned `payment_mutations_disabled`, proving
  the remote gate without contacting Authorize.Net. Aggregate verification found one expected
  synthetic graph, five outbox rows, zero payment links, zero active run keys, and no foreign-key
  violations. Records remain for inspection as required by the staging cleanup policy; provider
  sandbox, restart/failure injection, reconciliation, and complete billing-cycle phases remain open.
- 2026-08-15: Added the retained `/api/v1/fees` read surface over immutable D1 invoice-line
  evidence. Tenant-scoped list/show supports bounded pagination plus fee type, payment status,
  customer, subscription, currency, billable-metric, event-transaction, and creation-time filters;
  responses include Lago-shaped item, money, customer/subscription, and batched applied-tax
  snapshots. Cross-tenant show returns `fee_not_found`, invalid filters fail explicitly, and
  update/delete return `unsupported_fee_mutation` rather than mutating finalized billing evidence.
  The generated inventory now maps the upstream fee controller/model/query/serializer/services to
  this Worker API and focused evidence. Strict format/lint/inventory/bindings/TypeScript pass; all
  251 tests across 48 files pass serially in 155.47 seconds. The dry-run bundle is 1231.56 KiB
  (213.95 KiB gzip). This is a local pre-deployment checkpoint with no migration, provider, secret,
  message, payment, or remote-data action.
- 2026-08-15: Fee API remote preflight found no pending migration and exactly the retained
  `synthetic-e2e-20260815-001` graph: one tenant/plan/customer/subscription/invoice/fee, five outbox
  rows, zero active keys, zero payment links/attempts/requests/checkout intents, and no foreign-key
  violations. Deployed only the isolated Worker as version
  `1371f1ee-0afa-4bbe-a4cd-46e7645def2e` with a 5 ms startup and unchanged resources/flags. A
  run-scoped random key authenticated fee list/show, returned the expected single 1,999-cent fee,
  and proved `unsupported_fee_mutation`; the key was immediately revoked. Health/readiness returned
  `200`/`200`, unauthenticated fee access returned `401`, and version inspection confirmed only
  fetch/scheduled/queue handlers with all external-action flags at `0`. The post-deploy audit found
  zero active keys/payment state and no foreign-key violations; no production route/domain, secret,
  provider action, message, customer data, or payment action occurred.
- 2026-08-15: Replaced direct-D1-only API-key lifecycle with a tenant-scoped Worker control plane.
  Migration `0062_api_key_lifecycle.sql` adds name, empty-permission, short-ending, expiry, version,
  and update metadata plus expiry-order and outbox-version/rotation guards. Create and rotate return
  raw key material once; D1 stores only SHA-256 hashes and three-character endings, while list/show/
  update/revoke remain sanitized. Authentication now rejects expired keys atomically with usage
  tracking. Revocation protects the final non-expiring key, rotation creates the replacement and
  expires the old key in one batch, non-empty permissions fail until enforcement exists, and every
  mutation commits secret-free versioned outbox evidence or rolls back. The generated inventory
  maps the upstream model/services/GraphQL API-key surface to this REST equivalent. All 62 migrations
  replay from empty D1 with 13 key columns, four relevant indexes, four guards, and no foreign-key
  violations. Strict format/lint/inventory/bindings/TypeScript pass; all 257 tests across 49 files
  pass serially in 166.38 seconds, and the dry-run bundle is 1245.87 KiB (216.10 KiB gzip). This is a
  local pre-deployment checkpoint; no remote key, secret, provider, message, payment, or data changed.
- 2026-08-15: API-key remote preflight found exactly `0062_api_key_lifecycle.sql` pending, the
  retained synthetic tenant graph, two already-revoked smoke keys, zero active keys/payment state,
  and no foreign-key violations. Applied only migration 0062, then verified 62 migrations, 13 key
  columns, four relevant indexes, four expiry/outbox guards, no pending migration, and unchanged
  synthetic rows. Deployed only the isolated Worker as version
  `987740af-530f-4dea-a609-f2c6ecb71f95` with a 5 ms startup and unchanged resources/flags. A
  disposable bootstrap key exercised create, sanitized update, rotation, old-key `401`, replacement
  authentication, replacement revocation/`401`, non-empty-permission refusal, and last-key
  protection. Cleanup revoked every run key. Health/readiness returned `200`/`200`, unauthenticated
  key access returned `401`, and version inspection confirmed only fetch/scheduled/queue handlers
  with all external-action flags at `0`. The final audit found five hashed/revoked synthetic key
  records, zero active or malformed hashes, four API-key audit events with zero secret-like payloads,
  zero payment state, and no foreign-key violations. No production route/domain, provider action,
  message, customer data, payment action, or secret persistence occurred.
- 2026-08-15: Added a tenant-scoped Lago-compatible organization show/update REST equivalent.
  Migration `0063_organization_configuration.sql` adds normalized identity/address/currency,
  document numbering, email settings, invoice configuration, a globally unique slug, and optimistic
  version state. Reads project active webhook URLs and organization-default taxes without invoking
  either system. Updates reject implicit webhook changes, validate reserved slugs and billing
  values, preserve no-op versions, and atomically commit the configuration with an
  `organization.updated` outbox payload containing changed field names but no configuration values.
  D1 guards invalid lengths and stale outbox versions. The generated inventory maps only the
  upstream organization model, REST controller, update service, and update mutation to this partial
  port; unrelated authentication/feature-flag GraphQL types remain unclaimed. All 63 migrations
  replay from empty D1 with 29 organization columns, the slug index, three new guards, and no
  foreign-key violations. Strict format/lint/inventory/bindings/TypeScript pass; all 262 tests
  across 50 files pass serially in 163.42 seconds, and the dry-run bundle is 1263.97 KiB
  (220.68 KiB gzip). This is a local pre-deployment checkpoint; no remote configuration, provider,
  message, payment, route, secret, or customer data changed.
- 2026-08-15: Organization API remote preflight found exactly
  `0063_organization_configuration.sql` pending, the retained one-tenant synthetic graph, zero
  active keys/payment state, and no foreign-key violations. Applied only migration 0063, then
  verified 63 migrations, 29 organization columns, the slug index, all three configuration/outbox
  guards, no pending migration, and unchanged billing aggregates. Deployed only the isolated
  Worker as version `99ef39b9-71ca-4d49-9e08-fa2a9c0e6ca8` with a 7 ms startup and unchanged
  resources/flags. The first disposable-key attempt safely returned `401` because the local digest
  parser captured an empty OpenSSL field; its trap revoked the row before any organization update,
  and the revoked synthetic row was repaired with a random 64-character hash. A second disposable
  key exercised show, normalized update, stable version-2 replay, webhook-mutation refusal, and fake-
  currency refusal, then was revoked. Health/readiness returned `200`/`200`, unauthenticated
  organization access returned `401`, and version inspection confirmed only fetch/scheduled/queue
  handlers with all external-action flags at `0`. The final audit found seven hashed/revoked
  synthetic key records, zero active or malformed hashes, one organization event containing field
  names but no configuration values, zero payment state, 646 schedule audits, and no foreign-key
  violations. No production route/domain, provider action, message, customer data, payment action,
  or secret persistence occurred.
- 2026-08-15: Added the retained single billing entity as a Lago-compatible list/show/update REST
  equivalent. Migration `0064_single_billing_entity.sql` projects the organization-owned invoice
  configuration as a 33-field `billing_entities` D1 view and guards only scalar
  `billing_entity.updated` outbox versions, leaving the existing custom-section version stream
  independent. Detailed reads project the current default taxes and invoice custom sections.
  Scalar updates normalize the shared identity, address, currency, timezone, payment-term, email,
  numbering, and invoice settings, preserve no-op versions, and atomically emit audit evidence
  containing changed field names but no values. Creation, non-default entity codes, e-invoicing, EU
  tax automation, non-default issuing-date behavior, and compound tax/section mutation fail
  explicitly through documented dedicated boundaries. The generated inventory maps only the
  upstream controller/model/serializer/update service; the creation service remains unported. All
  64 migrations replay from empty D1 with the view, scoped guard, and no foreign-key violations.
  Strict format/lint/inventory/bindings/TypeScript pass; all 266 tests across 51 files pass serially
  in one clean 165.32-second invocation after a transient local pool-start/filesystem stall was
  discarded, and the dry-run bundle is 1278.41 KiB (222.38 KiB gzip). This is a local pre-
  deployment checkpoint; no remote schema, entity, provider, message, payment, route, secret, or
  customer data changed.
- 2026-08-15: Single billing-entity remote preflight found exactly
  `0064_single_billing_entity.sql` pending, organization version 2, the retained one-tenant billing
  graph, zero active keys/payment state, and no foreign-key violations. Applied only migration
  0064, then verified 64 migrations, the 33-field view, its scoped update-event guard, exactly one
  default entity, no pending migration, and unchanged billing aggregates. Deployed only the
  isolated Worker as version `252479ec-4581-4c72-bf84-32e439ed1b5a` with a 6 ms startup and
  unchanged resources/flags. A disposable hashed key exercised list/show, the existing nested
  custom-section route, normalized update from shared version 2 to 3, stable version-3 replay,
  second-entity creation/lookup refusal, and e-invoicing refusal, then was revoked. Health/readiness
  returned `200`/`200`, unauthenticated entity access returned `401`, and version inspection
  confirmed only fetch/scheduled/queue handlers with all external-action flags at `0`. The final
  audit found eight hashed/revoked synthetic key records, zero active or malformed hashes, one
  billing-entity event containing field names but no configuration values, zero payment state, 678
  schedule audits, and no foreign-key violations. No production route/domain, provider action,
  message, customer data, payment action, or secret persistence occurred.
- 2026-08-15: Added the tenant-scoped payment-receipt ledger and Lago-compatible list/show/invoice-
  filter REST surface. Migration `0065_payment_receipts.sql` adds customer-scoped counters, immutable
  receipt/payment ownership, versioned value-free outbox evidence, and guarded triggers covering
  both payment-first provider reconciliation and payable-first callers. The manual payment batch now
  inserts its optimistic-version-guarded payment before advancing the invoice, so a final settlement
  selects the actual final payment rather than an earlier partial payment. Partial payments remain
  receipt-free; the first invoice or payment-request settlement creates exactly one replay-safe
  receipt numbered from the customer identifier and counter. Reads embed the existing Lago-shaped
  payment serializer. PDF/XML URLs remain null until document generation is ported, and email resend
  returns an explicit disabled error without a message side effect. The generated inventory maps the
  upstream controller/model/query/serializer/create service; receipt documents, jobs, templates,
  downloads, mail, and webhook delivery remain separately unported. All 65 migrations replay from
  empty D1 with 12 receipt columns, the customer counter, nine state/tenant/version triggers, and no
  foreign-key violations. Strict format/lint/inventory/bindings/TypeScript pass; all 270 tests across
  52 files pass serially in 171.22 seconds, and the dry-run bundle is 1284.63 KiB (223.71 KiB gzip).
  This is a local pre-deployment checkpoint; no remote schema, receipt, provider, message, payment,
  route, secret, or customer data changed.
- 2026-08-15: Payment-receipt remote preflight found exactly `0065_payment_receipts.sql` pending,
  the retained one-tenant/customer/invoice graph, eight revoked keys, zero active keys/payment state,
  and no foreign-key violations. Applied only migration 0065, then verified 65 migrations, 12
  receipt columns, the customer counter, all nine state/tenant/version triggers, no pending
  migration, and empty receipt/payment ledgers. Deployed only the isolated Worker as version
  `04561b02-dbe9-4a8b-a71b-aa2a127a87f5` with a 5 ms startup and unchanged resources/flags. A
  disposable hashed key exercised empty receipt list/filter, missing show/resend, and authentication,
  then was revoked. No synthetic remote payment was created because payment mutation was outside the
  approved smoke boundary; manual/provider/payment-request settlement, replay, numbering, and
  rollback remain covered by the local Worker/D1 suite. Health/readiness returned `200`/`200`,
  unauthenticated receipt access returned `401`, and version inspection confirmed only fetch/
  scheduled/queue handlers with all external-action flags at `0`. The final audit found nine hashed/
  revoked synthetic key records, zero active or malformed hashes, zero receipts/events/payment
  state, 697 schedule audits, and no foreign-key violations. No production route/domain, provider
  action, message, customer data, payment action, or secret persistence occurred.
- 2026-08-15: Added the container-free payment-receipt PDF pipeline while preserving the explicit
  e-invoicing and email boundaries. Migration `0066_payment_receipt_documents.sql` adds a
  tenant/version-guarded immutable artifact ledger without weakening the existing invoice artifact
  table. `payment_receipt.created` outbox delivery now idempotently dispatches the shared Document
  Workflow; Browser Rendering produces escaped A4 HTML/PDF, R2 stores the bounded checksummed object
  under an immutable receipt/version key, and the D1 ready transition atomically emits one value-free
  `payment_receipt.generated` event. Authenticated list/show project `file_url` only after the object
  is ready, and the private no-store download route fails closed if R2 is missing. Failed rendering is
  recorded and safely retryable. UBL/XML remains null because the current billing-entity subset
  explicitly rejects the upstream e-invoicing country/configuration contract; resend remains a
  side-effect-free disabled error. The generated inventory maps the upstream PDF service and document/
  PDF jobs but intentionally leaves XML generation unclaimed. All 66 migrations replay through the
  fresh Workers test databases. Strict format/lint/inventory/bindings/TypeScript pass; the focused
  document/receipt suite passes 13 tests, all 275 tests across 53 files pass serially in 169.63
  seconds, and the dry-run bundle is 1300.73 KiB (226.38 KiB gzip). The default Wrangler local
  persistence cache returned `SQLITE_BUSY` twice with no owning process; this did not affect the
  isolated fresh-D1 Workers test replay. This is a local pre-deployment checkpoint; no remote schema,
  artifact, provider, message, payment, route, secret, or customer data changed.
- 2026-08-15: Payment-receipt-document remote preflight found exactly
  `0066_payment_receipt_documents.sql` pending, zero receipts/payments/receipt events, zero active or
  malformed key hashes, and no foreign-key violations. Applied only migration 0066, then verified
  the 12-column artifact ledger, both tenant/version and immutable-identity triggers, no pending
  migration, zero artifacts, and unchanged billing state. Deployed only the isolated Worker as
  version `f5e9777d-c4b7-4ece-9667-0fc61dfe1d10` with a 6 ms startup and unchanged resources/flags.
  A disposable hashed key exercised the empty receipt list, missing show/download/resend,
  authentication, and health/readiness, then was revoked. No synthetic payment was created because
  a remote payment mutation remained outside the approved smoke boundary; PDF rendering, R2
  archival, checksums, private download, failure/retry, and workflow replay are covered locally.
  Final audit found zero active/malformed keys, receipts, artifacts, receipt events, or payments,
  718 schedule audits, and no foreign-key violations. Version inspection confirmed only fetch/
  scheduled/queue handlers with all external-action flags at `0`. No production route/domain,
  provider action, customer message, payment action, secret, or customer data changed.
- 2026-08-15: Added container-free finalized/voided credit-note PDFs. Forward migration
  `0067_credit_note_documents.sql` adds a tenant/version/finalization-guarded immutable artifact
  ledger and a version guard for value-free `credit_note.generated` evidence. Credit-note creation
  and void events idempotently dispatch the shared ownership-checked Document Workflow; Browser
  Rendering produces bounded escaped PDF content, R2 stores checksummed version-addressed objects,
  and authenticated POST/GET download aliases return private no-store responses. Voiding advances
  the note version, makes the prior `file_url` inapplicable, and archives a distinct VOIDED PDF
  without replacing version 1. Missing R2 objects fail closed, invalid browser output is recorded,
  and UBL/XML remains an explicit e-invoicing-disabled boundary. The common PDF response validator
  is now shared by invoice, receipt, and credit-note generation. Test-only queue dispatch is skipped
  because Miniflare's Browser binding lacks `quickAction`; deterministic dispatch is separately
  exercised, while deployed environments retain event-driven generation. The feature-inventory
  matcher was narrowed so unrelated credit-note XML, provider refund, integration, export, metadata,
  and operator sources are no longer falsely marked partial. All 67 migrations replay through fresh
  Workers test databases. Strict format/lint/inventory/bindings/TypeScript pass; the focused document
  suite passes 15 tests, all 279 tests across 54 files pass serially in 169.83 seconds, and the dry-
  run bundle is 1314.55 KiB (228.43 KiB gzip). This is a local pre-deployment checkpoint; no remote
  schema, artifact, provider, message, payment, route, secret, or customer data changed.
- 2026-08-15: Credit-note-document remote preflight found exactly
  `0067_credit_note_documents.sql` pending, zero credit notes/items/payments, zero active or malformed
  key hashes, and no foreign-key violations. Applied only migration 0067, then verified the
  12-column artifact ledger, all three tenant/version/identity/generated-event guards, no pending
  migration, zero artifacts, and unchanged billing state. Deployed only the isolated Worker as
  version `be0a0056-2a14-4f33-8633-172fea750fd5` with a 6 ms startup and unchanged resources/flags.
  A disposable hashed key exercised the empty list, missing show/PDF download, explicit XML-disabled
  response, authentication, and health/readiness, then was revoked. No synthetic credit note was
  created because a remote billing mutation remained outside the approved smoke boundary; escaped
  rendering, R2 checksums, versioned void regeneration, private download, failure recording, and
  workflow replay remain locally proven. Final audit found zero active/malformed keys, credit notes,
  artifacts, credit-note events, or payments, 737 schedule audits, and no foreign-key violations.
  Version inspection confirmed only fetch/scheduled/queue handlers with all external-action flags at
  `0`. No production route/domain, provider action, customer message, payment action, secret, or
  customer data changed.
- 2026-08-15: Added the pinned Lago quote lifecycle as a documented tenant-scoped REST replacement
  for its GraphQL-only source contract. Forward migration `0068_quote_versioning.sql` adds
  organization numbering, a minimal active-membership projection for owner validation, immutable
  quote identities, versioned draft/approved/voided state, one-active-version and share-token
  uniqueness, tenant/identity guards, and quote/quote-version outbox revision guards. Create uses a
  required idempotency key and optimistic organization counter to produce `QT-YYYY-####` numbers;
  list/show support customer/status/number/date/owner/order filters and pagination; owner changes and
  draft content use optimistic revisions; approve/void are state-safe; and clone supersedes a source
  draft or copies a voided version with a replay-safe command record. Outbox payloads contain IDs,
  state, and changed field names only. The pinned revision contains no quote template, PDF service/
  job, or download contract, so no speculative document endpoint was added. All 68 migrations replay
  from empty D1. Strict format/lint/inventory/bindings/TypeScript pass; the focused quote suite passes
  6 tests, two pre-existing long billing scenarios pass 5/5 in isolated verification after a
  parallel-load timeout, and all 285 tests across 55 files pass serially in 181.66 seconds. The
  dry-run bundle is 1353.17 KiB (235.19 KiB gzip). This is a local pre-deployment checkpoint; no
  remote schema, quote, provider, message, payment, route, secret, or customer data changed.
- 2026-08-15: Quote-lifecycle remote preflight found exactly `0068_quote_versioning.sql` pending,
  the retained one-organization/customer/subscription/invoice graph, zero active or malformed key
  hashes, zero payment/receipt/credit-note state, and no foreign-key violations. Applied only
  migration 0068, then verified the 12-column quote ledger, 14-column version ledger, owner and
  active-membership projections, all seven tenant/identity/outbox guards, no pending migration,
  empty quote state, and an unchanged zero organization counter. Deployed only the isolated Worker
  as version `d161a781-a856-44c7-8438-94b5a832ca44` with a 5 ms startup and unchanged resources/
  flags. A disposable hashed key exercised the empty quote list, missing quote and version-action
  paths, authentication, and health/readiness, then was revoked. No synthetic remote quote was
  created because a billing-state mutation was unnecessary for smoke; numbering, owner changes,
  draft editing, approval, voiding, cloning, concurrency, and replay remain proven locally. Final
  audit found zero active/malformed keys, quotes, quote versions/owners/memberships, payment state,
  receipts, or credit notes, 769 schedule audits, and no foreign-key violations. Version inspection
  confirmed only fetch/scheduled/queue handlers with all external-action flags at `0`. No production
  route/domain, provider action, customer message, payment action, secret, or customer data changed.
- 2026-08-15: Replaced the pinned invoice/credit-note data-export container chain with a
  Cloudflare-native CSV pipeline. Forward migration `0069_data_exports.sql` adds a tenant/requester-
  guarded, idempotent, optimistic lifecycle ledger with pending/processing/completed/failed states,
  immutable completion metadata, seven-day expiry, and value-free outbox guards. Authenticated REST
  create/list/show/download routes replace the GraphQL mutations and expose the four retained
  `invoices`, `invoice_fees`, `credit_notes`, and `credit_note_items` contracts. The shared Document
  Workflow pages a creation-time-bounded D1 selection twice: the first pass measures exact UTF-8
  length and rows, and the second writes through `FixedLengthStream` directly to a deterministic R2
  key. A data change between passes fails closed and retries. This eliminates export-part rows,
  Active Jobs, Tempfile/File.unlink, Active Storage combination, and whole-export buffering. CSV
  user strings that could become spreadsheet formulas are neutralized; downloads are private; raw
  filters and exception messages never enter outbox evidence; completion email remains explicitly
  disabled. The feature inventory maps only the pinned data-export models/jobs/services/GraphQL
  surface, leaving mailer/UI dependencies unclaimed. All 69 migrations replay from empty D1. Strict
  format/lint/inventory/bindings/TypeScript pass; the focused export suite passes 6 tests, the final
  migration/failure regression passes in a 9-test focused run, and all 291 tests across 56 files pass
  serially in 180.29 seconds. The dry-run bundle is 1396.05 KiB (243.58 KiB gzip). This is a local
  pre-deployment checkpoint; no remote schema, artifact, export, provider, message, payment, route,
  secret, or customer data changed.
- 2026-08-15: Data-export remote preflight found exactly `0069_data_exports.sql` pending, the
  retained synthetic organization/customer/invoice graph, zero exports/quotes/payment/receipt/
  credit-note state, zero active or malformed key hashes, and no foreign-key violations. The first
  migration-list request returned a transient Cloudflare account authorization error while the
  immediately following read-only D1 audits succeeded; an independent retry confirmed only 0069
  pending before any mutation. Applied only migration 0069, then verified the 21-column lifecycle
  ledger, all four requester/identity/artifact/outbox guards, no pending migration, empty export
  state, and clean foreign keys. Deployed only the isolated Worker as version
  `2d8cb873-d28b-481f-8eff-3b7155e36fe5` with a 5 ms startup and unchanged resources/flags. A
  disposable hashed key exercised the empty export list, missing show/download/resend paths,
  authentication, and health/readiness, then was revoked. No synthetic remote export was created,
  so the smoke produced no billing-data read or R2 artifact; all four CSV contracts, streaming,
  replay, expiry, failure, and private download behavior remain locally proven. Final audit found
  zero active/malformed keys, exports, quotes, payment state, receipts, or credit notes, 798 schedule
  audits, and no foreign-key violations. Version inspection confirmed only fetch/scheduled/queue
  handlers with all external-action flags at `0`. No production route/domain, provider action,
  customer message, payment action, secret, or customer data changed.
- 2026-08-15: Closed the remaining `pdfcpu` container dependency by verifying its actual pinned
  call graph rather than porting the executable. `Utils::PdfAttachmentService` only runs from the
  invoice, credit-note, and payment-receipt Factur-X branches after e-invoicing is enabled for an
  eligible country; it embeds generated XML into PDF/A-3 and is neither a PDF page merger nor part
  of ordinary document generation. The retained single-billing-entity API rejects e-invoicing
  configuration, all three Cloudflare document surfaces keep XML explicitly disabled, and Browser
  Rendering/R2 PDF generation never reaches this path. The feature inventory now marks only this
  exact service `not-used`, with executable billing-entity and document-boundary evidence, while
  leaving the broader Factur-X/e-invoicing family unported for a separately approved product slice.
  This removes the subprocess requirement without adding an unreachable JavaScript/Wasm shim or
  falsely claiming e-invoicing parity. Formatting, lint, and generated-inventory checks pass. No
  runtime code, migration, Worker version, remote resource, artifact, provider action, customer
  message, payment action, secret, or customer data changed.
- 2026-08-15: Re-audited payment-provider ownership against committed `store-new` and `serp-auth`
  sources without modifying either repository. `store-new` owns checkout, subscriptions, billing,
  provider webhooks, reconciliation, and operator Stripe actions directly; `serp-auth` owns its
  direct Stripe receipt-recovery reads. Neither consumer references Lago APIs. The feature inventory
  now marks the upstream Lago Stripe, Adyen, GoCardless, Cashfree, Flutterwave, and MoneyHash model,
  service, job, GraphQL, and operator-UI surfaces `not-used`, while retaining the already isolated
  Authorize.Net adapter. Reintroduction requires a verified consumer contract and must start behind
  disabled provider flags with synthetic fixtures. No runtime code, migration, deployment, provider
  action, repository outside Lago, secret, customer data, or production resource changed.
- 2026-08-15: Reconciled the stale M2 subscription checkbox with the implemented Worker contract.
  Subscription creation already handles immediate, future, trial, and supported backdated starts;
  pending subscriptions can be rescheduled or canceled; active and pending resources expose guarded
  mutable fields; scheduled and manual termination share versioned state transitions; and plan
  changes preserve explicit pending, upgrade, and downgrade generations. Durable Object command
  reservations, D1 uniqueness/version guards, deterministic identities, transactional outbox rows,
  and failure-injection tests cover replay and rollback. The lifecycle deliberately rejects
  unsupported one-time backdating and unsafe prepaid termination combinations instead of silently
  substituting behavior. All 40 focused tests across the lifecycle, plan-change, termination-action,
  and billing-cycle suites pass. This plan-only reconciliation adds no runtime code, migration,
  deployment, provider action, secret, customer data, or production resource change.
- 2026-08-15: Added the first fixture-driven M3 billing golden from the existing synthetic
  month-end test. The checked-in JSON records only synthetic period, pricing, usage, coupon, line,
  and total values. Its test now proves precise `0.75` usage rounds to one minor unit, the two line
  amounts sum to the `1001` subtotal, `subtotal + tax - credits` reconciles to `901` due, the
  subscription advances from the July/August boundary to the August/September boundary, and replay
  leaves exactly one cycle, invoice, and finalization event. Formatting, lint, TypeScript, the
  11-test billing-cycle suite, and generated-inventory freshness pass. No runtime implementation,
  migration, deployment, provider action, secret, customer data, or production resource changed.
- 2026-08-15: Reconciled the M7 usage-projection checkbox with the existing D1/Queue/Workflow
  implementation. Current usage is bounded to the active billing window; lifetime usage follows
  subscription generations, sums draft and finalized usage lines while excluding voided lines,
  coalesces event activity, and uses projection versions so stale Queue work cannot clear newer
  activity. Lago-compatible GET/PUT routes expose the retained projection and its external
  historical adjustment. The storage-volume selection remains open pending approved volume
  evidence rather than inventing a Kafka/ClickHouse replacement. All three focused lifetime-usage
  tests pass. This plan-only reconciliation adds no runtime code, migration, deployment, provider
  action, secret, customer data, or production resource change.
- 2026-08-15: Completed the post-audit local checkpoint after provider disposition, subscription/
  usage milestone reconciliation, and the billing golden fixture. All 291 tests across 56 files
  pass serially in 197.30 seconds. The Wrangler 4.122.0 dry bundle remains 1396.05 KiB (243.58 KiB
  gzip) with the same Durable Object, four Workflows, Queue, D1, R2, and Browser bindings and all
  three external-action flags at `0`. No deployment was performed because this checkpoint changed
  no Worker runtime or schema; the isolated remote version and resources remain untouched.
- 2026-08-15: Retained the pinned Authorize.Net invoice-payment retry as a container-free Worker/D1
  command. `POST /api/v1/invoices/:id/retry_payment` requires the disabled-by-default payment
  mutation gate and an organization-scoped hashed idempotency key; it makes no provider call. One
  version-guarded D1 batch records the pending intent, returns an eligible finalized invoice to
  pending, removes its stale hosted-payment link, and stores value-free outbox evidence. Same-key
  retries replay, while different keys racing one invoice version produce exactly one winner. Empty
  payment-method input remains compatible and stored-method overrides fail explicitly because the
  retained provider uses Accept Hosted. The exact Rails retry service now maps to the dedicated
  Worker source and six focused tests cover the gate, replay, tenant/provider/status validation,
  same- and different-key races, stale-link invalidation, hashed evidence, payment projection, and
  late-statement rollback. Strict formatting, zero-warning lint, bindings, TypeScript, and generated-
  inventory freshness pass. All 297 tests across 57 files pass serially in 236.53 seconds, and the
  Wrangler 4.122.0 dry bundle is 1406.01 KiB (245.80 KiB gzip) with unchanged resources and all
  three external-action flags at `0`. No migration is required. This is a local pre-deployment
  checkpoint; no remote resource, provider action, customer message, payment action, secret, or
  customer data changed.
- 2026-08-15: Invoice-payment-retry remote preflight found no pending migration, zero active or
  malformed key hashes, zero payment attempts/request payments/receipts/credit notes/exports, and
  no foreign-key violations. Deployed only the isolated Worker as version
  `da276f6c-30d8-4458-81f0-263dbdd47888` with a 5 ms startup and unchanged resources/flags. A
  disposable hashed key proved health/readiness `200`/`200`, unauthenticated retry `401`, and
  authenticated retry `503 payment_mutations_disabled`, then was revoked. No invoice was selected
  or mutated, and no payment attempt, retry event, hosted link, provider call, message, or artifact
  was created. Final audit found zero active/malformed keys, zero payment/retry/document/export
  state, no pending migration, and clean foreign keys. Version inspection confirmed only fetch/
  scheduled/queue handlers with all external-action flags at `0`. No production route/domain,
  provider action, customer message, payment action, secret, or customer data changed.
- 2026-08-15: Closed the M5 Active Job ownership milestone by replacing broad filename guesses with
  an exhaustive pinned-source job rule set. Inventory generation now fails if any of the 242 Rails
  job files lacks an explicit disposition. Ninety-five retained commands map to tested Worker/D1,
  Queue, Workflow, Cron, document, webhook, usage, wallet, and Authorize.Net owners; 143 historical,
  provider/integration, external-tax/VIES/e-invoicing/email/telemetry/alert, provider-funded, or bulk-
  mutation jobs are explicitly `not-used`; and four Rails/Active Job/Sidekiq/Clock/Sentry framework
  files are retired by Cloudflare's native runtime. The generated summary records these counts, no
  job retains the generic Workflow/Queue placeholder or self-referential evidence, and every cited
  evidence path exists. Formatting, zero-warning lint, and inventory freshness pass; all 158 tests
  across the 27 distinct retained-job evidence files pass serially in 98.00 seconds. The earlier
  post-runtime full suite remains 297/297. This inventory/documentation slice requires no runtime,
  schema, resource, or deployment change and performed no provider action, customer message,
  payment action, secret access, customer-data access, or production operation.
- 2026-08-15: Closed the M6 visual/structural document-golden milestone with synthetic invoice,
  payment-receipt, and credit-note fixtures. Checked-in PDFs and four inspected 300-DPI PNG pages
  cover A4 geometry, a two-page 18-line invoice, party blocks, totals, custom sections, immutable-
  version footers, and the explicit XML-disabled boundary. The deterministic renderer compares
  HTML, extracted text, page geometry/count, out-of-bounds glyphs, and PNG hashes while tolerating
  Chrome PDF metadata changes. Visual inspection exposed macOS `system-ui` output as malformed Type
  3 font subsets; printable templates now select Arial and generated fixtures embed portable CID
  TrueType fonts, with an explicit Type 3 rejection gate. All four pages are legible and unclipped,
  the focused document suite passes 16/16, strict formatting/lint/inventory/TypeScript checks pass,
  and the authoritative no-file-parallelism suite passes all 300 tests across 58 files in 186.61
  seconds. Two preceding parallel attempts each had a different unrelated integration test exceed
  the 10-second harness limit; both runs passed 299/300 and the first timed-out file passed 2/2 in
  isolation, confirming load contention rather than a stable regression. The Wrangler 4.122.0 dry
  bundle is 1406.76 KiB (245.92 KiB gzip) with unchanged bindings and all three external-action
  flags at `0`. This local checkpoint performed no migration, deployment, provider action, customer
  message, payment action, secret access, customer-data access, or production operation.
- 2026-08-16: Document-golden remote preflight found no pending migration, zero active or malformed
  key hashes, zero payment/retry/receipt/credit-note/export/document-artifact state, and no foreign-
  key violations. Deployed only the isolated Worker as version
  `a2ed2b7b-93e3-4b3e-9337-01e5bad159e0`; the 1406.76 KiB (245.92 KiB gzip) bundle started in 6 ms
  with unchanged resources and all external-action flags at `0`. Health/readiness returned
  `200`/`200`, and unauthenticated invoice, payment-receipt, and credit-note PDF downloads each
  returned `401`. No active key or billing state was created, so no remote Browser Rendering job,
  R2 artifact, provider action, payment action, customer message, secret access, or customer-data
  access occurred. Final audit again found no pending migration, zero audited state, and clean
  foreign keys; version inspection confirmed only fetch/scheduled/queue handlers and no production
  route or domain.
- 2026-08-16: Closed the M7 storage-selection milestone with an evidence-bounded D1/R2 decision.
  Current SERP source explicitly selects only the safe-store checkout contract and contains no
  checked-in usage-event caller or volume requirement; production traffic and external consumers
  remain unknown rather than inferred. The isolated read-only audit found zero usage events, daily/
  charge snapshots, lifetime projections, or pending activities in a 4,677,632-byte D1 database.
  Exact replay uniqueness, tenant/subscription ownership, bounded time scans, and atomic event/
  invoice/wallet/outbox behavior keep D1 as billing authority, while R2 remains immutable raw
  evidence. Current official limits confirm the 10 GB D1 hard cap/single writer, three-month
  Analytics Engine retention, private 10 GB-per-object Durable Object SQL model, unlimited R2
  bucket data/object counts, and open-beta Pipelines 5 MB/s per-stream ceiling. The checked-in
  decision defines required canary telemetry, an 8 GB size trigger, tenant-skew/latency/overload/
  analytics gates, and an outbox/R2 backfill reconciliation protocol before sharding or analytical
  fanout. No runtime, migration, resource, deployment, provider action, payment action, customer
  message, secret access, customer-data access, or production operation changed.
- 2026-08-16: Added the M8 Workers Static Assets foundation without exposing the pinned legacy
  React/Apollo application or its 503 unmapped operations. Wrangler now directly serves a
  non-interactive, script-free migration shell, responsive stylesheet, navigation fallback, and
  restrictive security/no-index headers; dynamic `/api/*`, health/readiness, hosted-payment, and
  provider-webhook boundaries always execute the Worker first. Focused tests verify the shell and
  route configuration. A fresh, ephemeral local Wrangler state proved root/CSS/navigation
  `200` asset delivery, health `200` JSON, protected invoice `401`, incomplete hosted-payment `400`,
  and unknown provider-webhook `404`, with the expected CSP, framing, referrer, MIME, and robot
  headers. The interactive operator milestone remains open until retained screens have mapped,
  end-to-end-tested REST contracts and approved authentication. Strict formatting, lint, generated
  inventory/bindings, and TypeScript checks pass; the authoritative serial suite passes all 302
  tests across 59 files in 196.44 seconds, and the Wrangler 4.122.0 dry bundle remains 1406.76 KiB
  (245.92 KiB gzip) with all external-action flags at `0`. No migration, remote deployment,
  provider action, payment action, customer message, secret access, customer-data access, or
  production operation occurred in this local checkpoint.
- 2026-08-16: Static-asset remote preflight found no pending migration, zero active or malformed
  key hashes, zero payment/request/receipt/credit-note/export/document state, and no foreign-key
  violations. Deployed only the isolated Worker as version
  `75370a2a-ca89-4244-ad51-f514e1dece1d`; Cloudflare uploaded only `index.html` and the stylesheet,
  parsed both `_headers` rules, retained the existing Worker bundle size, and started in 5 ms with
  unchanged bindings and all external-action flags at `0`. Remote root, stylesheet, navigation
  fallback, health, and readiness returned `200`; protected invoice access returned `401`,
  incomplete hosted payment `400`, and the unknown provider webhook `404`. CSP, framing, referrer,
  MIME, and no-index headers were present. Final audit again found no pending migration, zero
  audited state, and clean foreign keys; version inspection confirmed only fetch/scheduled/queue
  handlers. No active key, billing mutation, production route/domain, provider action, customer
  message, payment action, secret access, or customer-data access occurred.
- 2026-08-16: Defined the M8 operator screen-admission and route-family policy before exposing any
  interactive asset. Current Cloudflare documentation confirms a self-hosted Access application
  can protect a Worker directly by name, covers every route on that Worker, and requires the Worker
  to still validate the injected JWT. The selected design therefore uses a separate
  `serp-dev-lago-operator` Worker so human login does not intercept service APIs or provider
  webhooks. It keeps service API keys out of browsers, maps a validated Access subject to an
  explicit D1 tenant/role membership, enforces same-origin/CSRF mutation checks, and fails closed
  while issuer, audience, membership, or policy configuration is absent. Provisioning remains
  pending an approved identity/group allow policy and Access configuration. The policy assigns
  retained, later, blocked, external-owner, not-used, and proposed-retirement route families, with
  the migration shell as asset-level rollback. The generator now excludes two Material UI CSS
  class constants whose values were neither URL paths nor composed route templates, correcting the
  literal route inventory from 161 to 159 while leaving all 503 GraphQL operations unchanged. No
  runtime, migration, resource, deployment, repository outside Lago, provider action, payment
  action, customer message, secret access, customer-data access, or production operation changed.
- 2026-08-16: Implemented the local, fail-closed M8 operator authentication foundation without
  provisioning an identity or exposing an interactive screen. A separate
  `serp-dev-lago-operator` dry-run config prevents human Access policy from intercepting the API
  Worker, service clients, or provider webhooks; preview URLs are disabled and
  `OPERATOR_ACCESS_ENABLED=0`. The operator Worker validates Access RS256 issuer, audience,
  signature, expiry, and subject with `jose` 6.2.9, then resolves only an issuer-scoped subject hash
  through one active D1 tenant/role membership. Migration `0070_operator_access.sql` enforces one
  organization per identity, viewer/admin roles, revocation consistency, and immutable tenant/
  identity fields. Mutation admission requires exact same-origin, valid fetch provenance when
  present, an operator CSRF header, and JSON for body-bearing methods. Six focused tests cover
  disabled/misconfigured state, claims/signature/expiry, membership/tenant isolation, schema
  uniqueness/immutability, and CSRF/origin behavior; the package dependency audit reports no known
  production vulnerabilities. A fresh ephemeral D1 replayed all 70 migrations with zero
  memberships and foreign-key violations. Local Wrangler served the shell/assets and health while
  readiness/session both returned `503 operator_access_disabled`. Strict formatting, lint,
  inventory, both generated binding checks, and TypeScript pass; the authoritative serial suite
  passes all 308 tests across 60 files in 197.52 seconds. The API dry bundle remains 1406.76 KiB
  (245.92 KiB gzip); the separate operator dry bundle is 46.03 KiB (11.67 KiB gzip) with only D1,
  environment, and disabled Access bindings. Migration 0070 was not applied remotely, the operator
  Worker/Access application/policy were not provisioned or deployed, and no provider action,
  payment action, customer message, secret access, customer-data access, or production operation
  occurred.
- 2026-08-16: Added the first bounded operator BFF read contract behind the disabled Access gate.
  `GET /api/operator/v1/organization` authenticates the Access JWT, derives the tenant only from
  its active membership, and reuses the canonical organization REST serializer for configuration,
  default-tax, and webhook projections rather than creating a browser-specific shape. The shared
  serializer extraction leaves `/api/v1/organizations` behavior unchanged. The operator/session
  and organization focused suites pass 12/12; strict formatting, lint, inventory, both binding
  checks, and TypeScript pass. The authoritative serial suite passes all 309 tests across 60 files
  in 220.26 seconds. The API dry bundle is 1406.92 KiB (245.95 KiB gzip), and the disabled operator
  dry bundle is 51.87 KiB (13.99 KiB gzip) with only D1 and non-secret environment bindings. The
  static migration shell remains non-interactive; migration 0070, the operator Worker, and Access
  application/policy remain unapplied or unprovisioned remotely. No provider action, payment
  action, customer message, secret access, customer-data access, or production operation occurred.
- 2026-08-16: Completed the local operator API-key BFF contract behind the disabled Access gate.
  Membership-scoped viewers can list/show only sanitized key metadata; same-origin/CSRF-checked
  admins can create, rename, rotate, and revoke through the existing tenant-safe API-key handler.
  Raw key material is returned only once from create/rotate and never appears in later list/show
  responses or stored audit payloads. Viewer mutation refusal, admin promotion, the complete
  mutation lifecycle, masking, role/origin/CSRF enforcement, and the canonical API-key invariants
  pass 15/15 focused tests. Strict formatting, lint, inventory, both binding checks, and TypeScript
  pass; the authoritative serial suite passes all 311 tests across 60 files in 202.15 seconds. The
  API dry bundle remains 1406.92 KiB (245.95 KiB gzip), and the disabled operator dry bundle is
  70.25 KiB (17.92 KiB gzip) with only D1 and non-secret environment bindings. The shell remains
  non-interactive; migration 0070, the operator Worker, and its Access application/policy remain
  unapplied or unprovisioned remotely. No provider action, payment action, customer message, secret
  access, customer-data access, or production operation occurred.
- 2026-08-16: Added the separate operator Static Assets application without altering or deploying
  the API Worker's live migration shell. `operator-app` uses same-origin native ES modules to load
  only the membership-scoped organization and API-key BFFs, renders viewers read-only, and exposes
  create/rename/rotate/revoke controls only to admins. Mutations send JSON plus the operator CSRF
  header; the bundle contains no GraphQL path, bearer authorization, browser storage/cookie write,
  or `innerHTML`. Raw create/rotate values exist only in memory in a one-time copy dialog and are
  cleared on close. Four static-contract tests preserve the two-bundle separation, CSP/header
  policy, BFF endpoints, CSRF request shape, forbidden browser primitives, fail-closed state, and
  secret clearing. The focused operator/static suite passes 15/15; the authoritative serial suite
  passes all 315 tests across 61 files in 275.01 seconds. Formatting, lint, generated inventory,
  both binding checks, and TypeScript pass. A fresh ephemeral local D1 applied all 70 migrations;
  desktop and 390-pixel mobile browser QA showed only `Operator Access not configured`, no operator
  controls or billing data, and no browser warnings/errors. Local smoke returned root/script/
  health `200` and session `503 operator_access_disabled` with the expected restrictive response
  headers. The API dry bundle remains 1406.92 KiB (245.95 KiB gzip); the separate disabled operator
  bundle remains 70.25 KiB (17.92 KiB gzip) and reads five operator assets. No remote migration,
  resource, Access application/policy, membership, deployment, provider action, payment action,
  customer message, secret access, customer-data access, or production operation occurred.
- 2026-08-16: Added the first bounded operator catalog family for manual invoice custom sections.
  `/api/operator/v1/invoice-custom-sections` validates the Access session and membership tenant,
  permits viewers to list/show active sections, and requires admin role plus same-origin/CSRF checks
  for create/edit/terminate. It reuses the canonical D1 handler after narrowing that handler's
  environment type to its actual D1 and Queue dependencies, preserving transactional outbox writes
  and producer-only publication to the existing internal domain-event Queue. The operator app adds
  read-only rows for viewers, admin create/edit/terminate dialogs, text-only DOM rendering, and the
  same fail-closed bootstrap; it still has no GraphQL client, bearer login, browser credential
  storage, cookie write, `innerHTML`, or auth bypass. Viewer refusal and the complete admin lifecycle
  pass alongside the canonical catalog suite; the focused operator/app/catalog run passes 21/21.
  The authoritative serial suite passes all 316 tests across 61 files in 263.08 seconds. Formatting,
  lint, generated inventory, both binding checks, and TypeScript pass. Local browser regression
  showed the updated navigation but only `Operator Access not configured`, with no controls, billing
  data, warnings, or errors. The API dry bundle remains 1406.92 KiB (245.95 KiB gzip); the disabled
  operator dry bundle is 94.81 KiB (21.63 KiB gzip) with D1, the producer-only domain-event Queue,
  and non-secret disabled Access bindings. No remote migration, resource, Access application/
  policy, membership, deployment, provider action, payment action, customer message, secret access,
  customer-data access, or production operation occurred.
- 2026-08-16: Added the first bounded operator billing family for the retained single default billing
  entity. `/api/operator/v1/billing-entities/default` validates the Access session and immutable
  membership tenant, permits viewers to read the canonical detailed profile, and requires admin role
  plus same-origin/CSRF checks for updates. The shared handler's environment type now reflects its
  actual D1-only dependency; its optimistic organization update and value-free transactional outbox
  evidence remain unchanged. The operator app adds a responsive billing-profile projection and an
  admin editor for supported identity, legal, address, payment-term, numbering, locale, and document
  defaults. It explicitly omits additional entities, e-invoicing, tax assignment, and external
  actions. Viewer refusal, admin normalization/update, and audit-redaction assertions pass alongside
  the canonical billing-entity and static-contract suites; the focused run passes 19/19. The
  authoritative serial suite passes all 317 tests across 61 files in 68.86 seconds. Lint, TypeScript,
  JavaScript syntax, and dry builds pass. The API dry bundle remains 1406.92 KiB (245.95 KiB gzip);
  the disabled operator bundle is 114.10 KiB (24.82 KiB gzip) with D1, producer-only domain-event
  Queue access, and non-secret disabled Access bindings. No remote migration, resource, Access
  application/policy, membership, deployment, provider action, payment action, customer message,
  secret access, customer-data access, or production operation occurred.
- 2026-08-16: Added the retained payment-receipt operator read family. The canonical D1 list/show
  projection is now independently reusable from document download and email handling.
  `/api/operator/v1/payment-receipts` authenticates the Access identity and membership tenant,
  permits GET list/show only, strips both stored and generated document URLs, and rejects every
  mutation with an explicit read-only boundary. The operator app renders receipt number, customer,
  invoice, amount, status, and creation metadata without document or email controls. Synthetic
  tenant data proves list/show behavior, URL suppression, and resend rejection while the canonical
  payment-receipt suite remains unchanged. The focused operator/receipt/static run passes 20/20;
  the authoritative serial suite passes all 318 tests across 61 files in 60.62 seconds. Lint,
  TypeScript, JavaScript syntax, and dry builds pass. The API dry bundle is 1407.36 KiB (246.05 KiB
  gzip); the disabled operator bundle is 125.33 KiB (26.94 KiB gzip) with no new binding. No remote
  migration, resource, Access application/policy, membership, deployment, document generation,
  email, provider action, payment action, customer message, secret access, customer-data access, or
  production operation occurred.
- 2026-08-16: Added the bounded manual-tax operator catalog. `/api/operator/v1/taxes` authenticates
  the Access identity and membership tenant, permits viewers to list/show active taxes, and requires
  admin role plus same-origin/CSRF checks for create/edit/terminate. It reuses the canonical handler
  after narrowing that handler's environment type to its actual D1 and producer-only Queue bindings;
  optimistic versions, transactional value-free outbox evidence, and awaited Queue publication are
  unchanged. The operator app adds viewer rows plus admin create/edit/terminate controls using
  text-only DOM construction and the existing mutation helper. Focused operator/tax/static and quote
  regression tests pass 25/25. A pre-existing quote filter test that hard-coded August 15 failed when
  UTC crossed midnight; it now derives the filter date from the created quote timestamp. The
  authoritative serial suite passes all 319 tests across 61 files in 63.12 seconds. Formatting,
  lint, TypeScript, JavaScript syntax, generated inventory, binding checks, and dry builds pass. The
  API dry bundle remains 1407.36 KiB (246.05 KiB gzip); the disabled operator bundle is 144.34 KiB
  (29.92 KiB gzip) with no new binding. No remote migration, resource, Access application/policy,
  membership, deployment, provider action, payment action, customer message, secret access,
  customer-data access, or production operation occurred.
- 2026-08-16: Added the bounded add-on operator catalog. `/api/operator/v1/add-ons` authenticates the
  Access identity and membership tenant, permits viewers to list/show active add-ons, and requires
  admin role plus same-origin/CSRF checks for create/edit/terminate. The canonical handler now
  declares only its actual D1 and producer-only Queue bindings; currency compatibility, in-use
  termination protection, tax-target rejection, optimistic versions, transactional outbox evidence,
  and awaited Queue publication remain unchanged. The operator app adds viewer rows plus admin
  lifecycle controls with text-only DOM construction and the existing mutation helper. Focused
  operator/add-on/static tests pass 21/21; the authoritative serial suite passes all 320 tests across
  61 files in 62.38 seconds. Formatting, lint, TypeScript, JavaScript syntax, generated inventory,
  binding checks, and dry builds pass. The API dry bundle remains 1407.36 KiB (246.05 KiB gzip); the
  disabled operator bundle is 158.20 KiB (32.03 KiB gzip) with no new binding. No remote migration,
  resource, Access application/policy, membership, deployment, provider action, payment action,
  customer message, secret access, customer-data access, or production operation occurred.
- 2026-08-16: Added the bounded core-customer operator workflow. Customer list/show/upsert routing is
  extracted from the compatibility router into a canonical D1 and Queue handler, leaving the service
  API behavior unchanged. `/api/operator/v1/customers` permits tenant-scoped viewer reads and
  same-origin/CSRF-checked admin create/edit. A BFF payload allowlist admits external identity, name,
  email, currency, timezone, net payment term, and invoice grace period only; provider, dunning,
  metadata, custom-section, tax-target, and deletion operations are rejected even if the browser
  calls the BFF directly. The operator app adds viewer rows and admin create/edit controls without a
  deletion action. Focused operator/static tests pass 19/19; the authoritative serial suite passes
  all 321 tests across 61 files in 62.79 seconds. Formatting, lint, TypeScript, JavaScript syntax,
  generated inventory, binding checks, and dry builds pass. Tree-shaking keeps the API dry bundle at
  1407.72 KiB (246.08 KiB gzip) and the disabled operator bundle at 194.14 KiB (38.16 KiB gzip) with
  no new binding. No remote migration, resource, Access application/policy, membership, deployment,
  provider action, payment action, customer message, secret access, live customer-data access, or
  production operation occurred.
- 2026-08-16: Created the isolated operator Worker ID without exposing the functional operator
  surface. `wrangler.operator-bootstrap.jsonc` deploys a 0.43 KiB binding-free Worker with preview
  URLs disabled; version `87907c2c-1ff2-4678-9f9c-832a64820f2f` returns JSON `503` and
  `Cache-Control: no-store` for every tested route and has no Static Assets, D1, Durable Object,
  Workflow, or Queue access. This resolves Cloudflare Access's requirement for an immutable Worker
  ID while keeping the real BFF and UI undeployed. Added an idempotent Access reconciler with five
  Node tests: it preflights all reads before its first write, creates only the exact Worker
  application and single-email 24-hour allow policy, refuses drift/additional policies, bounds API
  responses, and never prints its token. The complete package check still passes all 333 Workers
  tests across 61 files plus the five reconciler tests, generated types, inventory, lint,
  TypeScript, and both dry bundles. Remote migrations `0070` and `0071` remain pending. The current
  Wrangler OAuth token has Workers/D1 write but not Access Apps and Policies Write, and managed
  browser navigation to both Cloudflare dashboard domains remains blocked despite the connected
  Tailscale VPN, so no Access application/policy, migration, membership, functional operator
  deployment, provider action, payment action, customer message, secret, or customer-data access
  occurred.
- 2026-08-17: Completed the isolated M8 operator Access rollout. The self-hosted Access application
  targets only `serp-dev-lago-operator`, is hidden from the App Launcher, uses a 24-hour session,
  and has exactly one 24-hour Allow policy for the approved development email. A fresh public request
  returns an Access `302` without reaching the origin. Applied remote migrations `0070` and `0071`
  to only `serp-dev-lago-native-d1`, then inserted one issuer-and-subject-hash admin membership for
  only `synthetic-e2e-20260815-001`; no raw Access subject is stored. Enabled issuer/audience JWT
  validation and deployed functional operator version `2787e247-b3b9-4dc8-b91b-86b36bc44251` with
  Static Assets, D1, existing DO/Workflow, and producer-only Queue bindings. Authenticated browser
  verification loaded `SERP Billing Operator` as Administrator for only `Synthetic E2E 20260815
001`. The first live upload safely failed before version creation because the operator config had
  a pre-existing 35-character D1 UUID; correcting the verified resource ID and adding a regression
  assertion resolved it. The authoritative check passes all 333 tests across 61 files plus five
  Access reconciler tests, formatting, lint, generated types, inventory, TypeScript, and both dry
  deployments. The API Worker remains outside Access and all external-action flags remain `0`; no
  production route, provider/payment action, customer message, secret, or customer data changed.
- 2026-08-18: Corrected the M8 operator product-parity regression against the checked-in Lago
  frontend. Added an authoritative 503-operation/159-route ledger that no longer treats legacy
  classifications as approval. Analytics now retains five tabs, date/customer scope, plan/customer
  revenue and MRR breakdowns, collection/overdue views, and usage-metric deep links; Forecasts now
  provides bounded scenario projections. Billable metrics now has list/detail/create/edit/delete/
  duplicate and activity history. Lago-owned Features now has typed privileges, activity history,
  and plan entitlement values in D1. The original right-side Assistant rail/panel is restored with
  membership-and-organization-scoped history and read-only Workers AI streaming. Migration `0073`
  was replayed locally and applied as the only pending migration to isolated
  `serp-dev-lago-native-d1`; the post-audit found no pending migration, no feature/entitlement/AI
  rows, and no foreign-key errors. Deployed only `serp-dev-lago-operator` version
  `4090c15d-ad57-4dc8-9bf4-fd99b85b663d`. Fresh unauthenticated root/session requests returned
  Access `302`; authenticated browser QA loaded the corrected reports/catalogs and Assistant shell.
  The full gate passes 343 tests across 62 files, strict formatting/lint/types/generated checks,
  migration replay, and both dry bundles. No production route, API Worker, provider/payment action,
  customer message, secret, or customer data changed.
- 2026-08-18: Continued from the product-parity checkpoint into the authoritative backlog.
  Migration `0074` adds 30-day, tenant-scoped operator API metadata without request/response bodies;
  activity, usage-event, and webhook delivery list/detail reads redact payload fields and keep
  webhook retry disabled under the approved external-action boundary. Migration `0075` adds hashed
  Cloudflare Access invitations and first-login membership claiming. The Team & security surface
  now exposes tenant members, pending invitations, fixed admin/viewer roles, and the enforced Access
  authentication contract; membership and invitation mutation contracts enforce admin access,
  same-origin requests, tenant scope, and a last-admin invariant. Focused parity/access/asset tests
  pass 43 cases while this broader ledger reconciliation remains active.
