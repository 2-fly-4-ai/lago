# Lago Cloudflare Native

This package is the container-free Cloudflare replacement for Lago in the SERP platform. It is
currently isolated from production and preserves the verified `store-new` REST contract while the
remaining Lago feature inventory is dispositioned and ported.

## Architecture

- Worker: authenticated Lago-compatible HTTP API and signed provider webhooks.
- D1: organizations, customers, plans, subscriptions, invoices, coupon applications/credits,
  credit-note balances/applications/recredits, granted-credit wallets and consumption lots,
  manual tax definitions and immutable invoice tax snapshots, add-on catalog entries and recurring
  pay-in-arrears fixed charges, customer payment terms, immutable invoice due-date snapshots,
  customer invoice-grace settings, distinct initial/renewal invoice contexts, refreshable draft
  state, dependency-invalidation triggers and mutation guards, immutable issuing/finalization dates,
  tenant-scoped invoice custom-section catalog records, subscription selections, and immutable
  invoice section snapshots, organization-level default selections for the retained single billing
  entity, customer overrides/skip state, wallet and wallet-transaction selections, one canonical
  invoice precedence projection, wallet ongoing-balance/depletion projections, and fixed granted
  threshold-rule state,
  customer time zones, subscription billing mode/timezone snapshots, immutable trial boundaries,
  overdue state, payment attempts, outbox state, and webhook receipt metadata;
  plan-level minimum commitments are reconciled as auditable period true-up lines after recurring
  subscription, usage, and fixed-charge fees.
- Plan catalog: idempotent creation and optimistic scalar updates with transactional versioned
  outbox events, including the base subscription’s pay-in-advance mode and non-negative trial
  period. Standalone usage charges support create/list/show, optimistic core updates, soft deletion,
  and deterministic code reuse. Attached plans retain Lago's restricted mutable charge subset;
  every charge mutation invalidates affected drafts while finalized invoice lines remain immutable.
  Billable metrics expose the same active/version lifecycle: deletion atomically retires attached
  charges, invalidates drafts, hides retired usage and wallet targets immediately, and enqueues
  bounded event/R2 cleanup. Deterministic metric generations allow safe same-code recreation while
  finalized lines and relational event history remain auditable.
  Supported pay-in-arrears, non-prorated fixed charges also expose standalone create/list/show,
  optimistic core update, and soft-delete routes with the same draft/finalized invariants. Their
  retained hard uniqueness constraint means a deleted fixed-charge code cannot yet be reused.
  Unused plans can be retired atomically with their active usage/fixed charges. Plans with
  subscription history instead enter a durable deletion Workflow that closes the attachment
  snapshot, terminates active generations, cancels pending generations, recalculates/finalizes
  plan-linked drafts, and only then retires the catalog graph. The Workflow uses bounded batches,
  deterministic continuation instances, DELETE replay, and five-minute dispatch repair.
  Commitments and relational catalog/billing rows remain historical, and monotonic deterministic
  generations permit repeated same-code recreation. Filter/tax/pricing-unit/child-plan cascades
  and catalog graph replacement remain guarded.
- Subscription lifecycle: pay-in-advance starts create their initial invoice atomically, while
  in-arrears starts create no initial invoice. A supported future UTC `subscription_at` creates a
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
  UTC service days, usage is bounded to the following UTC-day boundary, and supported
  non-prorated pay-in-arrears fixed charges retain their full amount. The same constrained plans may persist a
  future UTC `ending_at`; the legacy hourly `:05` owner applies it exactly once and takes precedence
  over the recurring close. Supported active and pending updates can set or clear that instant and
  persist Lago's `on_termination_invoice` action; pay-in-advance subscriptions can additionally
  persist the supported `credit` or `skip` credit-note action. Manual and scheduled termination use
  the stored actions unless a valid manual query override is supplied. Pay-in-advance subscriptions
  may schedule `ending_at` only with persisted skip-credit, so the unattended owner cannot enter an
  allocated-source credit path. Explicit
  skip-invoice/skip-credit termination remains idempotent; any existing draft is invalidated and remains refreshable/
  finalizable from its immutable invoice context. At renewal, pay-in-advance base fees snapshot the
  next period while in-arrears base fees and usage snapshot the closed period. Credit-only
  pay-in-advance termination can return exact unused UTC service days when its source base invoice
  is finalized and has no discount, tax, or wallet allocation. Prior invoice-level credit-note
  applications do not reduce the creditable source line. The default combined
  command creates that credit, finalizes bounded in-arrears usage without rebilling the base, and
  applies the new balance before wallet credits in one ordered D1 batch. The usage invoice can also
  be generated while explicitly skipping unused-period crediting. Backdated one-time plans,
  tenant-local termination dates, refund/offset modes, allocated source invoices,
  prorated/pay-in-advance fixed charges, and pay-in-advance commitment termination remain guarded.
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
  old in-arrears fees, a new prepaid base, and any unused prepaid credit into one invoice, and links
  that invoice to both generations atomically. A downgrade remains pending until the old period
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
  with atomic D1 event/outbox rows and deterministic immutable R2 evidence.
- Workflows and Cron: a deterministic five-minute dispatcher preserves an exhaustive ownership map
  of all 27 legacy Clockwork schedules. It runs pending-subscription activation, billing-close,
  flagged-draft refresh, draft-finalization, trial-ending, invoice-overdue, Authorize.Net receipt retry,
  coupon-expiration, wallet-expiration, ongoing wallet projection/threshold-grant, and interval
  wallet top-up paths on their original slots, performs 90-day
  inbound/outbound webhook retention, records each run in D1, publishes the outbox, and reports due
  schedules whose behavior is not yet ported. Each run also drains retired billable-metric events
  in bounded D1/R2 batches and repairs pending plan-deletion Workflow dispatches. Subscription-
  bearing plan deletion has its own Workflow, durable D1 task/snapshot, bounded subscription and
  draft batches, and deterministic continuation handoff. Inbound and usage-event retention records
  R2 deletion tasks transactionally before removing or tombstoning source rows, so storage outages
  remain retryable.
- R2: immutable provider webhook, usage-event, and invoice-document archives.
- Browser Rendering: deterministic invoice PDF generation through a retryable Document Workflow.
- Operator catalog compatibility: authenticated REST create/list/show/update/delete endpoints at
  `/api/v1/invoice_custom_sections` replace the retained operator GraphQL workflow for this
  feature. Draft invoices refresh their snapshots; finalized invoice API/PDF output uses only the
  immutable copy.

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
