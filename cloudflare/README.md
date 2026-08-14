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
  overdue state, payment attempts, outbox state, and webhook receipt metadata;
  plan-level minimum commitments are reconciled as auditable period true-up lines after recurring
  subscription, usage, and fixed-charge fees.
- Plan catalog: idempotent creation and optimistic scalar updates with transactional versioned
  outbox events, including the base subscription’s pay-in-advance mode. Catalog graph replacement
  and destructive plan lifecycle remain guarded.
- Subscription lifecycle: pay-in-advance starts create their initial invoice atomically, while
  in-arrears starts create no initial invoice. A supported future UTC `subscription_at` creates a
  pending subscription with no invoice, and the five-minute activation owner applies the same
  billing-mode rule exactly once. Pending starts can be moved to another future instant or canceled
  without producing an invoice. Immediate and scheduled activation both emit a transactional
  `subscription.started` event. Zero-grace in-arrears subscriptions without fixed charges or a
  minimum commitment can terminate with an atomic final invoice: the base fee is prorated by
  inclusive UTC service days and usage is bounded to the following UTC-day boundary. The same
  constrained plans may persist a future UTC `ending_at`; the legacy hourly `:05` owner applies it
  exactly once and takes precedence over the recurring close. Explicit skip-invoice/skip-credit
  termination remains idempotent; any existing draft is invalidated and remains refreshable/
  finalizable from its immutable invoice context. At renewal, pay-in-advance base fees snapshot the
  next period while in-arrears base fees and usage snapshot the closed period. Backdating, calendar
  billing, tenant-local termination dates, positive-grace termination drafts, pay-in-advance
  termination credits, and termination with fixed charges or commitments remain guarded.
- Durable Objects: aggregate command reservations for idempotent customer, invoice, subscription,
  and provider operations; D1 versions, constraints, and triggers enforce monetary concurrency.
- Queues: at-least-once domain event delivery with idempotent consumers and a dead-letter queue.
- Metering: single-event replay/conflict handling and all-before-write batches of up to 100 events,
  with atomic D1 event/outbox rows and deterministic immutable R2 evidence.
- Workflows and Cron: a deterministic five-minute dispatcher preserves an exhaustive ownership map
  of all 27 legacy Clockwork schedules. It runs pending-subscription activation, billing-close,
  flagged-draft refresh, draft-finalization, invoice-overdue, Authorize.Net receipt retry,
  coupon-expiration, and wallet-expiration paths on their original slots, performs 90-day
  inbound/outbound webhook retention, records each run in D1, publishes the outbox, and reports due
  schedules whose behavior is not yet ported. Inbound retention records R2 deletion tasks
  transactionally before removing receipt rows, so storage outages remain retryable.
- R2: immutable provider webhook, usage-event, and invoice-document archives.
- Browser Rendering: deterministic invoice PDF generation through a retryable Document Workflow.

No Docker, Compose, local service daemon, Rails runtime, PostgreSQL, Redis, Go/Rust subprocess, or
OS command is required by this package.

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
