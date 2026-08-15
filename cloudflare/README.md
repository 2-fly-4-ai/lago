# Lago Cloudflare Native

This package is the container-free Cloudflare replacement for Lago in the SERP platform. It is
currently isolated from production and preserves the verified `store-new` REST contract while the
remaining Lago feature inventory is dispositioned and ported.

## Architecture

- Worker: authenticated Lago-compatible HTTP API and signed provider webhooks.
- Fee API: tenant-scoped immutable invoice-fee list/show with pagination, customer/subscription/
  currency/type/date filters, tax snapshots, and explicit unsupported mutation errors.
- API-key control plane: tenant-scoped create/list/show/name-update/rotate/revoke routes return raw
  key material only from create/rotate, store only SHA-256 hashes and short endings, enforce expiry
  during authentication, protect the last non-expiring key, reject unenforced fine-grained
  permissions, and commit secret-free versioned audit evidence atomically.
- Organization API: Lago-compatible show/update for identity, address, currency, timezone, payment
  terms, document numbering, email settings, and invoice configuration, with default-tax and active
  webhook projections, global slug uniqueness, replay-safe versions, and secret/value-free audit
  evidence. Webhook mutation remains in the separately gated endpoint API.
- Billing-entity API: Lago-compatible list/show/update over the retained one-default-entity-per-
  organization architecture, including tax and custom-section projections, normalized shared
  invoice configuration, replay-safe versions, and value-free audit evidence. Creation, non-default
  entities, e-invoicing, EU tax automation, and compound side-effecting mutations fail explicitly.
- Payment-receipt API: tenant-scoped Lago-compatible list/show and invoice filtering over receipts
  created atomically when an invoice or payment request first settles. Customer-scoped numbering,
  payment serialization, payment-first/payable-first ordering, replay, and value-free outbox evidence
  are D1-owned. Receipt-created events idempotently dispatch Browser Rendering PDF generation through
  the shared Document Workflow, immutable checksummed artifacts live in R2, and authenticated private
  downloads are projected as `file_url` only after generation. UBL/XML e-invoicing and email resend
  remain explicitly disabled.
- Credit-note documents: finalized and voided credit notes use the shared ownership-checked Document
  Workflow, Browser Rendering, version-addressed R2 objects, checksums, value-free generated events,
  and authenticated private downloads. Voiding advances the credit-note version and produces a new
  immutable PDF without replacing the prior artifact. UBL/XML e-invoicing remains explicitly
  disabled.
- Quote API: the pinned Lago GraphQL-only quote domain is exposed as a documented REST replacement
  with tenant-scoped organization numbering, customer/subscription validation, active-member owners,
  one active version, draft edits, approval, voiding, superseding clones, optimistic revisions,
  idempotent creation/clone commands, and value-free outbox evidence. The pinned revision has no
  quote PDF, template, generation job, or download contract, so this surface does not invent one.
- Data exports: authenticated create/list/show/download routes replace the pinned GraphQL mutations
  and Rails job chain for invoice, invoice-fee, credit-note, and credit-note-item CSVs. D1 owns the
  replay-safe lifecycle; the shared Document Workflow pages a creation-time-bounded snapshot twice,
  measures it, then streams through `FixedLengthStream` directly to an immutable R2 key. This removes
  temporary files, export-part rows, local unlink/combine work, and Active Storage. CSV formula-like
  user strings are neutralized, downloads are private and expire after seven days, and completion
  email remains explicitly disabled.
- D1: organizations, customers, plans, subscriptions, invoices, coupon applications/credits,
  credit-note balances/applications/recredits, granted-credit wallets and consumption lots,
  manual tax definitions and immutable invoice tax snapshots, add-on catalog entries and recurring
  fixed charges with in-arrears or in-advance timing, local-day proration, effective-dated
  subscription units, immediate-billing evidence and durable repair state, customer payment terms,
  immutable invoice due-date snapshots,
  customer invoice-grace settings, distinct initial/renewal invoice contexts, refreshable draft
  state, dependency-invalidation triggers and mutation guards, immutable issuing/finalization dates,
  tenant-scoped invoice custom-section catalog records, subscription selections, and immutable
  invoice section snapshots, organization-level default selections for the retained single billing
  entity, customer overrides/skip state, wallet and wallet-transaction selections, one canonical
  invoice precedence projection, wallet ongoing-balance/depletion projections, and fixed granted
  threshold-rule state,
  customer time zones, subscription billing mode/timezone snapshots, immutable trial boundaries,
  overdue state, quote identities/versions/owners, data-export lifecycle metadata, payment attempts,
  outbox state, and webhook receipt metadata;
  plan-level minimum commitments are reconciled as auditable period true-up lines after recurring
  subscription, usage, and fixed-charge fees.
- Plan catalog: idempotent creation and optimistic scalar updates with transactional versioned
  outbox events, including the base subscription’s pay-in-advance mode and non-negative trial
  period. Standalone usage charges support create/list/show, optimistic core updates, soft deletion,
  deterministic code reuse, and the supported invoiceable, non-prorated pay-in-advance timing
  subset. Attached plans retain Lago's restricted mutable charge subset;
  every charge mutation invalidates affected drafts while finalized invoice lines remain immutable.
  Billable metrics expose the same active/version lifecycle: deletion atomically retires attached
  charges, invalidates drafts, hides retired usage and wallet targets immediately, and enqueues
  bounded event/R2 cleanup. Deterministic metric generations allow safe same-code recreation while
  finalized lines and relational event history remain auditable.
  Supported fixed charges also expose standalone create/list/show,
  optimistic core update, and soft-delete routes with the same draft/finalized invariants. Creates
  and inherited unit updates on attached plans are effective-dated per active subscription: the
  default takes effect at the next period boundary, while `apply_units_immediately: true` affects
  the open period. Standard fixed charges may bill in advance with optional proration; graduated
  advance charges are supported only without proration, and volume advance charges fail
  explicitly. Their retained hard uniqueness constraint means a deleted fixed-charge code cannot
  yet be reused.
  Unused plans can be retired atomically with their active usage/fixed charges. Plans with
  subscription history instead enter a durable deletion Workflow that closes the attachment
  snapshot, terminates active generations, cancels pending generations, recalculates/finalizes
  plan-linked drafts, and only then retires the catalog graph. The Workflow uses bounded batches,
  deterministic continuation instances, DELETE replay, and five-minute dispatch repair.
  Commitments and relational catalog/billing rows remain historical, and monotonic deterministic
  generations permit repeated same-code recreation. Filter/tax/pricing-unit/child-plan cascades
  and catalog graph replacement remain guarded.
- Subscription lifecycle: pay-in-advance starts create their initial invoice atomically, combining
  the base and advance fixed-charge lines. In-arrears starts create no base invoice but do create a
  fixed-charge-only invoice when their plan has advance fixed charges; those charges also bill at
  activation during a base-plan trial. A supported future UTC `subscription_at` creates a
  pending subscription with no invoice, and the five-minute activation owner applies the same
  billing-mode rule exactly once. A start on an earlier customer-local day activates at that
  historical instant without generating a retroactive invoice, then resumes from the billing
  period containing creation time. Pending starts can be moved to another future instant or
  canceled without producing an invoice. Immediate, historical, and scheduled activation emit a
  transactional `subscription.started` event. Subscription create, update, and plan replacement
  persist Lago's `manual` or provider-default payment policy; provider-specific method IDs remain
  guarded until the tenant-scoped registry is ported. Subscription create/update also accepts
  Lago's `invoice_custom_section` wrapper: explicit skip clears selections, explicit false can
  replace them, an omitted skip preserves a prior skip, and unknown codes are ignored as in the
  legacy service. Pending plan replacement preserves omitted selections; new upgrade/downgrade
  generations start without inherited selections unless explicitly supplied. Zero-grace
  in-arrears subscriptions can terminate
  with an atomic final invoice: the base fee and minimum-commitment target are prorated by inclusive
  UTC service days, usage is bounded to the following UTC-day boundary, non-prorated fixed charges
  retain their full amount, and prorated fixed charges use event-weighted customer-local calendar
  days through termination. The same constrained plans may persist a
  future UTC `ending_at`; the legacy hourly `:05` owner applies it exactly once and takes precedence
  over the recurring close. Supported active and pending updates can set or clear that instant and
  persist Lago's `on_termination_invoice` action; pay-in-advance subscriptions can additionally
  persist the supported `credit` or `skip` credit-note action. Manual and scheduled termination use
  the stored actions unless a valid manual query override is supplied. Pay-in-advance subscriptions
  may schedule `ending_at` only with persisted skip-credit, so the unattended owner cannot enter an
  allocated-source credit path. Explicit
  skip-invoice/skip-credit termination remains idempotent; any existing draft is invalidated and remains refreshable/
  finalizable from its immutable invoice context. At renewal, pay-in-advance base and fixed-charge
  fees snapshot the next period while in-arrears base, usage, and fixed-charge fees snapshot the
  closed period. Immediate advance-unit increases bill only units not already paid in the open
  period; decreases create zero-amount evidence without a refund, and the five-minute owner repairs
  any committed event whose synchronous invoice step was interrupted. Credit-only
  pay-in-advance termination can return exact unused UTC service days when its source base invoice
  is finalized and has no discount, tax, or wallet allocation. Prior invoice-level credit-note
  applications do not reduce the creditable source line. The default combined
  command creates that credit, finalizes bounded in-arrears usage without rebilling the base, and
  applies the new balance before wallet credits in one ordered D1 batch. The usage invoice can also
  be generated while explicitly skipping unused-period crediting. A pay-in-advance minimum
  commitment uses the same prorated termination target, subtracting gross eligible plan, usage, and
  fixed fees already invoiced in the period plus the current termination fees. Credit notes do not
  reduce that gross fee history, and refresh excludes the current draft so its true-up is stable.
  Backdated one-time plans, tenant-local termination dates, refund/offset modes, allocated source
  invoices and unused-period credit/refund for pay-in-advance fixed-charge lines remain guarded.
  In-arrears termination with a positive grace period instead creates a non-consuming draft from an
  immutable termination context; manual or scheduled refresh uses the original period boundaries,
  and finalization alone allocates coupon, credit-note, and wallet balances. Pay-in-advance grace
  termination now couples two drafts: the unused-period note remains non-allocatable while its
  prepaid source invoice is draft, refreshes proportionally with that source, and becomes available
  only after the source finalizes. The termination draft cannot finalize early and then applies the
  new balance before wallet credits. Coupon, tax, or wallet adjustments on the still-draft source
  remain explicitly guarded; finalized credit-note balances can chain across successive drafts.
  Calendar and anniversary subscription billing are
  persisted explicitly; calendar boundaries and invoice dates use the snapshotted customer IANA
  timezone and remain half-open UTC instants in D1. Positive trials defer the initial base invoice.
  The hourly `:35` owner closes missed trial-covered periods, coordinates with the `:10` billing
  owner at exact boundaries, emits one trial-ended transition, and creates one locally prorated
  pay-in-advance base (or leaves in-arrears base proration to period close). Grace-period trial
  invoices refresh and finalize from the same immutable initial context without adding charges.
  Posting the same external subscription with a different same-currency plan now preserves Lago's
  immutable generation chain. Annualized price determines an immediate upgrade or boundary
  downgrade. An upgrade terminates the old generation, starts a distinct generation, reconciles
  old in-arrears fees, a new prepaid base, advance fixed charges, and any unused prepaid credit into
  one invoice, and links that invoice to both generations atomically. A prorated advance fixed
  charge with the same add-on deducts the overlapping amount already paid on the prior generation.
  A downgrade remains pending until the old period
  closes, when the same cycle command bills the old plan, starts the new generation, and records one
  replay-safe combined invoice. Grace drafts retain both immutable period snapshots; termination
  cancels a queued downgrade in the same D1 batch. Usage-event ownership uses half-open generation
  timestamps, while transaction IDs remain unique across the shared external subscription. Prepaid
  upgrades can also chain while source invoices remain in grace: each unused-period note stays
  non-allocatable until its exact source draft finalizes, dependent drafts refuse premature manual
  finalization, and the scheduler resolves source-first chains before applying each balance.
- Durable Objects: aggregate command reservations for idempotent customer, invoice, subscription,
  and provider operations; D1 versions, constraints, and triggers enforce monetary concurrency.
- Queues: at-least-once domain event delivery with idempotent consumers and a dead-letter queue.
- Metering: single-event replay/conflict handling and all-before-write batches of up to 100 events,
  with atomic D1 event/outbox rows and deterministic immutable R2 evidence. Billable metrics may
  derive their aggregation field through the pinned Lago expression grammar. A bounded TypeScript
  parser/evaluator supports exact decimals, event attributes, arithmetic, and the six legacy
  functions without `eval`, Wasm, a Rust extension, or a subprocess; the derived property is part
  of replay hashing, D1 state, and R2 evidence. Optional metric `round`, `ceil`, or `floor`
  configuration is applied to the aggregate before current-usage and recurring-invoice rating,
  including zero-default and negative precision. Weighted-sum metrics integrate cumulative deltas
  over the full civil-day charge period at exact 20-place Lago ceiling precision. Recurring
  weighted state is reconstructed from retained events across subscription generations and is
  recorded separately from billed weighted units. Target-wallet-enabled weighted charges
  reconstruct and retain that state independently for each normalized wallet-code group, including
  groups with a carried balance but no current-period events.
  Billable metrics and charges also support bounded nested filters. Metric filter catalogs and
  charge-specific price overrides are validated and stored atomically in D1; each event is assigned
  to the first most-specific matching filter or the unmatched base charge, with wildcard values
  still requiring the event property to exist. Current usage and invoice lines preserve the same
  exact partition, and filter invoice lines use deterministic source identities. Current usage
  reports actual rated usage without applying charge minimums; invoices add one charge-wide,
  termination-prorated true-up line across all filter/base fees. Target-wallet-enabled charges
  partition each filter/base fee again by wallet code, preserving deterministic line identities,
  combined filter/wallet metadata, exact current-usage totals, and exact wallet allocations.
  Recurring weighted-sum filters reconstruct an independent historical cumulative baseline for
  every filter/base partition across subscription generations. The same baseline map composes with
  target-wallet grouping, so weighted filter × wallet cells rate and allocate independently.
  Invoiceable, non-prorated pay-in-advance charges create one finalized invoice per usage event and
  charge for count, sum, or unique-count metrics. The event-triggered marginal calculation supports
  standard, graduated, package, percentage, and graduated-percentage pricing; preserves filter and
  target-wallet partitions; and uses the normal coupon, manual-tax, credit-note, wallet, invoice-
  ownership, custom-section, and outbox paths. A D1 event/charge ledger makes Queue replay
  idempotent, and the five-minute reconciliation owner repairs persisted events whose delivery was
  missed. Non-invoiceable or prorated advance usage, volume pricing, custom aggregation, positive
  minimums, and grouped pricing remain explicit unsupported boundaries.
  Each persisted event also coalesces one D1 subscription-activity row and advances the
  subscription's last-received event date in the same transaction. Queue delivery refreshes a
  lineage-scoped lifetime-usage projection from current rated usage plus draft/finalized usage
  invoice lines; a guarded activity version preserves arrivals concurrent with calculation.
  `GET` and `PUT /api/v1/subscriptions/:external_id/lifetime_usage` expose the Lago-compatible
  projection and external historical amount. The Cron Workflow drains missed activity every minute
  and rotates through retained lifetime projections every five minutes, replacing the legacy
  Clockwork and Sidekiq fanout without Redis or a dedicated queue process. Plan and subscription
  APIs now own fixed and recurring usage thresholds in D1, including subscription override/fallback
  semantics and threshold replacement across plan changes. The reconciliation Workflow checks
  refreshed lifetime usage and creates cumulative usage-only progressive invoices with exact
  threshold-crossing evidence. Each later progressive or final invoice credits the latest
  cumulative invoice; a downward/source correction atomically creates a deterministic credit note
  for the excess. Dedicated usage-monitoring alerts remain a separate, unported contract.
  The retained hourly `:15` revenue-analytics owner now writes customer-local daily snapshots to
  D1. It preserves Lago's cumulative usage and `usage_diff` JSON while also materializing exact
  per-charge cumulative and delta units, event counts, and amounts for indexed rollups. Scheduled
  snapshots stop at the customer's local midnight and skip the billing boundary; a second
  idempotent projection repairs that boundary from versioned draft/finalized invoice lines. The
  invoice reader excludes event-triggered pay-in-advance usage invoices, which are marginal
  billing evidence rather than period-close analytics. This removes the daily usage dependency on
  PostgreSQL, Sidekiq, Redis, and ClickHouse. The operator analytics API/GraphQL adapter remains a
  separate consumer of this D1 projection.
- Workflows and Cron: a deterministic one-minute dispatcher preserves an exhaustive ownership map
  of all 27 legacy Clockwork schedules. It runs pending-subscription activation, billing-close,
  flagged-draft refresh, draft-finalization, trial-ending, invoice-overdue, Authorize.Net receipt retry,
  coupon-expiration, wallet-expiration, ongoing wallet projection/threshold-grant, and interval
  wallet top-up paths on their original slots, drains subscription activity every minute, refreshes
  lifetime usage every five minutes, projects daily revenue usage at the retained hourly `:15`
  slot, and records the legacy hourly post-validation owner as a synchronous-precommit boundary.
  The latter no longer scans a materialized view: invalid metric
  codes, missing/non-numeric aggregation fields, and invalid filter values are rejected before the
  event, R2 archive, or outbox entry commits. The old Redis/ClickHouse refreshed-subscription loop
  is likewise consolidated into the D1 activity and wallet projection owners. Cron also performs 90-day
  inbound/outbound webhook retention, records each run in D1, publishes the outbox, and reports due
  schedules whose behavior is not yet ported. Each run also drains retired billable-metric events
  in bounded D1/R2 batches, repairs pending pay-in-advance fixed and usage invoices, and repairs
  pending plan-deletion Workflow dispatches. Subscription-
  bearing plan deletion has its own Workflow, durable D1 task/snapshot, bounded subscription and
  draft batches, and deterministic continuation handoff. Inbound and usage-event retention records
  R2 deletion tasks transactionally before removing or tombstoning source rows, so storage outages
  remain retryable.
  The hourly `:50` owner selects active subscriptions ending on the exact UTC 15/45-day windows and
  inserts one deterministic termination-alert outbox event per subscription/day. Delivery remains
  subject to the existing outbound-webhook safety gate.
  The legacy hourly `:30` stuck-generating-invoice retry reuses the normal billing-close executor.
  Invoice rows are never exposed in a generating state: D1 commits the complete invoice graph
  atomically, while the leased billing-cycle record reclaims failed or stale attempts. The extra
  slot therefore provides a real recovery pass without a Sidekiq invoice job.
  Successful bearer authentication also advances the API key's D1 last-use timestamp under the
  active-key predicate; the legacy Rails-cache write and hourly flush no longer need a runtime
  owner.
  The dedicated-organization wallet refresher is also retired as a separate runtime owner. The
  global D1 wallet-projection scan includes every tenant, while Workers supplies horizontal
  isolation without a dedicated Sidekiq process or tenant-ID environment list.
  The legacy failed-invoice retry is retained as an audited no-work boundary: it only retried
  persisted external-tax API-limit failures, while external tax-provider configuration is rejected
  before this Worker's atomic invoice write and no tax-error-detail ledger exists.
- R2: immutable provider webhook, usage-event, invoice-document, payment-receipt, and credit-note
  archives.
- Browser Rendering: deterministic invoice, payment-receipt, and credit-note PDF generation through
  a retryable Document Workflow.
- Operator catalog compatibility: authenticated REST create/list/show/update/delete endpoints at
  `/api/v1/invoice_custom_sections` replace the retained operator GraphQL workflow for this
  feature. Draft invoices refresh their snapshots; finalized invoice API/PDF output uses only the
  immutable copy. Lago-compatible plan charge-filter list/show/create/update/delete endpoints live
  under `/api/v1/plans/:plan_code/charges/:charge_code/filters`; mutations use optimistic charge
  versions and transactional `charge.updated` outbox events. Subscription fixed-charge list/show/
  update endpoints live under `/api/v1/subscriptions/:external_id/fixed_charges`; the first update
  clones the complete active pricing graph into a hidden child plan, while later updates mutate the
  same child fixed charge with optimistic versions and transactional outbox events. Immediate unit
  application writes an effective-dated event for the open period; the default schedules the new
  units at the next boundary. Catalog fixed-charge create/update and their inherited child-plan
  cascades use the same timing contract. In-arrears prorated charges rate the event-weighted units
  across customer-local calendar days. Advance increases use the same local-day window, charge only
  a positive delta against all current-period advance lines, and retain deterministic invoice IDs
  for replay and repair; fixed-charge-specific tax targeting remains an explicit unsupported
  boundary.
- Payment requests: authenticated create/list/show and customer-nested list routes persist one
  tenant-scoped request plus its overdue finalized invoices and `payment_request.created` outbox
  event in a guarded D1 batch. The amount is the exact remaining balance across one currency.
  Signed Authorize.Net callbacks carrying `PaymentRequest` metadata reconcile to one request-level
  provider payment and immutable per-invoice allocations. Settlement requires the provider amount,
  request amount, and current linked-invoice balances to agree; version guards, status monotonicity,
  dunning-counter reset, invoice/request status changes, and outbox evidence share one atomic D1
  batch. Those payments are visible through the retained `/api/v1/payments` list/show contract,
  including invoice filters and multi-invoice payable metadata. A D1-backed Checkout Workflow can
  create the matching hosted link once per request version, persist processing/success/failure
  outcomes, and emit token-free outbox evidence. Its dispatcher and provider call both require
  `PAYMENT_MUTATIONS_ENABLED=1`; creating the request itself never calls a provider or sends email.
- Dunning campaigns: authenticated tenant-scoped create/list/show/update/delete routes own campaign
  thresholds, organization defaults, customer overrides, and exclusions in D1. The hourly `:45`
  Workflow executor creates at most one deterministic payment request per eligible customer and
  attempt, observes full overdue-invoice totals for campaign thresholds, uses remaining balances
  for request amounts, and respects currency, payment-processing readiness, elapsed-day spacing,
  exclusions, and maximum attempts. It emits `dunning_campaign.finished` at the terminal attempt.
  Each request, version-pinned invoice link, customer attempt advance, and outbox event commits in
  one guarded D1 batch.
  Provider checkout handoff is implemented behind the disabled mutation gate. Email/link delivery
  remains intentionally absent, so schedule parity stays partial and all external-action gates
  remain authoritative.

No Docker, Compose, local service daemon, Rails runtime, PostgreSQL, Redis, Go/Rust subprocess, or
OS command is required by this package.

## Invoice custom-section compatibility

The retained operator catalog uses authenticated tenant-scoped REST endpoints in place of its
legacy GraphQL operations:

- `POST` and `GET /api/v1/invoice_custom_sections` create and list manual sections.
- `GET`, `PUT`, and `DELETE /api/v1/invoice_custom_sections/:code` show, update, and terminate a
  section. Termination is a soft delete; its code may be reused by a later section.

Create and update bodies use the Lago-shaped `invoice_custom_section` wrapper with `code`, `name`,
`description`, `details`, and `display_name`. Subscription create/update and plan-replacement
requests use the same wrapper name with selection fields:

```json
{
  "subscription": {
    "invoice_custom_section": {
      "skip_invoice_custom_sections": false,
      "invoice_custom_section_codes": ["payment-terms", "legal"]
    }
  }
}
```

Unknown codes are ignored, repeated/reordered codes describe the same selection, explicit
`skip_invoice_custom_sections: true` removes selections, and explicit false with codes replaces
them. A codes-only subscription selection update does nothing while skip is already true; false
re-enables selection.
Draft invoice snapshots change only after refresh/finalization, and finalized API/PDF content does
not follow later catalog edits.

Customer create/update accepts top-level `invoice_custom_section_codes` and
`skip_invoice_custom_sections`. An explicit code list replaces manual customer selections and
re-enables sections; an empty list falls back to the organization's defaults. Explicit skip clears
the customer selection and cannot be combined with a code list. Customer reads expose the resolved
`applicable_invoice_custom_sections` without per-customer D1 queries.

Because the retained Cloudflare subset currently has one billing entity per organization, its
default selections use `GET` and `PUT` on
`/api/v1/billing_entities/default/invoice_custom_sections` with a `billing_entity` wrapper and
`invoice_custom_section_codes`. The invoice precedence is: an explicit subscription selection,
then subscription skip, then customer skip, then a manual customer selection, then the organization
default. The same projection drives recurring drafts, finalized snapshots, and one-off invoices.
Multi-billing-entity routing and provider-created system sections remain explicitly unported.

Wallet create/update and granted wallet-transaction create accept the same
`invoice_custom_section` attach/skip wrapper. Wallet list/show and wallet-transaction reads expose
the persisted `applied_invoice_custom_sections` without per-row queries. These are resource API
selections only: Lago's current paid-credit invoice service does not pass wallet resources into
invoice section application, so this port deliberately does not add them to invoice precedence.

Wallet create/update also supports one active fixed recurring granted-credit rule with either an
interval or threshold trigger. Weekly, monthly, quarterly, semiannual, and yearly anniversaries use
the customer's timezone, clip month-end/leap-day anchors like Lago, skip the wallet's creation day,
and create at most one top-up per wallet/local date. Rule expiration and interval top-up retain
Lago's hourly `:50` and `:55` schedule slots.

Wallet create/update accepts `applies_to.fee_types` and tenant-local
`applies_to.billable_metric_codes`. Invoice allocation groups tax-inclusive fee caps, drains only
matching positive wallets in application priority order, and treats a wallet with no limitations as
unrestricted. Charges can opt into `accepts_target_wallet`; those charges group and rate events by
`properties.target_wallet_code`, while untargeted events remain a separate group. Explicit targets
override normal wallet limitations, and a missing active wallet records one replay-safe
`event.error` without rejecting the usage event. Opt-out charges ignore the property. The
five-minute owner uses the same matcher for current-period calculator output and persisted draft
lines, but assigns each fee wholly to its first match without capping by settled balance. Ongoing
balance may therefore be negative; only a non-depleted to depleted transition emits
`wallet.depleted_ongoing_balance`. A fixed threshold rule compares that projection plus
pending credits, then atomically settles the granted lot with a rule/projection-version idempotency
key. Per-customer batches use wallet-version guards and roll back every projection, grant, and event
together. Rule-level custom sections remain resource-only and metadata/name are copied to generated
transactions. Paid credits, target recurring rules, payment methods, successful-payment
requirements, progressive billing, and dedicated-organization cadence remain explicitly
unsupported.

## Safety defaults

- `PUBLIC_BASE_URL` is the isolated workers.dev hostname used to construct hosted-payment form
  redirects; it is not a provider endpoint, credential, custom domain, or production route.
- `PAYMENT_MUTATIONS_ENABLED=0` prevents hosted-payment token creation.
- `PROVIDER_READS_ENABLED=0` defers provider reconciliation.
- `OUTBOUND_WEBHOOKS_ENABLED=0` prevents endpoint creation/update and outbound delivery until an
  approved HMAC signing secret is configured. No signing key is committed or deployed.
- Provider credentials are secrets and are never stored in `wrangler.jsonc`.
- The checked-in config has no production route or custom domain.
- All fixtures are synthetic and contain no customer or production data.

## Local verification

Use Node 22 or newer and pnpm 11:

```sh
pnpm install --frozen-lockfile
pnpm run inventory
pnpm run check
```

`pnpm run check` validates formatting, lint rules including floating promises, the generated feature
inventory, Wrangler-generated bindings, TypeScript, Workers-runtime tests, and a dry-run bundle.

To apply migrations to a fresh local D1 directory:

```sh
wrangler d1 migrations apply serp-dev-lago-native-d1 --local --persist-to /tmp/lago-cloudflare-d1
```

The `/tmp` location is only local Wrangler emulator state; repository worktrees remain under the
umbrella workspace's required `tmp/` directory.

## Non-production provisioning

Wrangler automatic provisioning is intentionally configured for the isolated `serp-dev-*`
resources. A deploy may create or bind D1, R2, Queue/DLQ, Workflows, the Worker, and the Durable
Object namespace. Do not deploy until Wrangler identity and resource names have been reviewed.

Do not add production routes, production provider credentials, production data, or enable payment
mutations without the separate approval gates in the active rewrite plan.

## Contract fixtures

The four synthetic fixtures under `fixtures/store-new/` represent the currently verified consumer
surface:

1. `POST /api/v1/customers`
2. `POST /api/v1/subscriptions`
3. `GET /api/v1/invoices`
4. `POST /api/v1/invoices/:id/payment_url`

The normative money, time, pagination, error, idempotency, and aggregate-boundary rules are in
`../docs/reference/cloudflare-native-conventions.md`. The code/config-only record of which SERP
consumer capabilities are explicitly selected is in
`../docs/reference/serp-enabled-lago-capabilities.md`; it deliberately does not infer production
runtime state.

`store-new` and `serp-auth` are not modified by this branch.
