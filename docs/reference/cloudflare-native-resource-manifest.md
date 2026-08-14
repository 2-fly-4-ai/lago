# Cloudflare-Native Lago Resource Manifest

Last verified: 2026-08-14

This manifest covers the isolated, non-production stack created for the Cloudflare-native rewrite.
It is not a production inventory and contains no secrets or customer data.

## Account and endpoint

- Cloudflare account: `SERP`
- Worker: `serp-dev-lago-native`
- workers.dev URL: `https://serp-dev-lago-native.serpcompany.workers.dev`
- Initial deployed version: `c1b38acd-70bc-4997-862a-fde3761d2a2c`
- Latest verified version: `ae1cc8b4-9fc2-4d5d-abb1-095338efd8e0`
- Custom domains/routes: none
- Payment provider secrets: none
- `PAYMENT_MUTATIONS_ENABLED`: `0`
- `PROVIDER_READS_ENABLED`: `0`
- `OUTBOUND_WEBHOOKS_ENABLED`: `0`

## Resources

| Kind              | Name or ID                                                         | Binding                   | Purpose                                                            |
| ----------------- | ------------------------------------------------------------------ | ------------------------- | ------------------------------------------------------------------ |
| D1                | `serp-dev-lago-native-d1` / `2f32f159-c269-46c6-a4dd-9e38477f5d25` | `BILLING_DB`              | Synthetic billing state                                            |
| R2                | `serp-dev-lago-native-billing-artifacts`                           | `BILLING_ARTIFACTS`       | Immutable provider webhook, usage-event, and invoice PDF artifacts |
| Queue             | `serp-dev-lago-domain-events`                                      | `DOMAIN_EVENTS`           | Domain events and reconciliation dispatch                          |
| DLQ               | `serp-dev-lago-domain-events-dlq`                                  | none                      | Poison/retry exhaustion                                            |
| Durable Object    | `BillingAccount`                                                   | `BILLING_ACCOUNTS`        | Per-invoice command reservations                                   |
| Workflow          | `serp-dev-lago-checkout`                                           | `CHECKOUT_WORKFLOW`       | Checkout orchestration target                                      |
| Workflow          | `serp-dev-lago-reconciliation`                                     | `RECONCILIATION_WORKFLOW` | Provider and outbox reconciliation                                 |
| Workflow          | `serp-dev-lago-documents`                                          | `DOCUMENT_WORKFLOW`       | Retryable invoice PDF generation and R2 archival                   |
| Cron              | `*/5 * * * *`                                                      | Worker scheduled handler  | Deterministic legacy-schedule dispatch                             |
| Browser Rendering | account binding                                                    | `BROWSER`                 | Invoice HTML-to-PDF rendering                                      |

Applied D1 migrations: `0001_foundation.sql` through `0025_draft_dependency_invalidation.sql`.

## Verified behavior

- `GET /health` returned `200` with environment `development`.
- `GET /ready` returned `200` after querying the remote D1 database.
- `GET /api/v1/invoices` without a bearer key returned the expected `401` envelope.
- `GET /api/v1/events` without a bearer key returned the expected `401` envelope after migration
  `0005` and the latest deployment.
- `GET /api/v1/plans` without a bearer key returned the expected `401` envelope after migration
  `0007`; a follow-up remote migration query reported no pending migrations.
- `GET /api/v1/subscriptions` without a bearer key returned the expected `401` envelope after the
  lifecycle deployment.
- `GET /api/v1/invoices/synthetic` without a bearer key returned the expected `401` envelope after
  the invoice-authority deployment.
- The document deployment registered `serp-dev-lago-documents`; a follow-up remote migration query
  reported no pending migrations, and health/readiness/authentication smoke checks returned
  `200`/`200`/`401` respectively.
- The coupon-ledger deployment added only schema and code to the unseeded isolated stack; no coupon,
  application, credit, customer, subscription, or invoice row was created remotely.
- The granted-wallet deployment added only schema and code. The isolated stack remains unseeded;
  paid top-ups and payment/provider mutation flags remain disabled.
- The credit-note deployment added only schema and code for provider-free credit balances. Remote
  health/readiness returned `200`/`200`, unauthenticated credit-note access returned `401`, and a
  follow-up migration inventory reported no pending migrations. Refund, offset, tax, document,
  email, and provider-reporting paths remain explicitly disabled.
- The manual-tax deployment added only schema and code for organization-default definitions and
  immutable invoice snapshots. Remote health/readiness returned `200`/`200`, unauthenticated tax
  access returned `401`, and no migrations remained pending. No remote tax, invoice, or tenant row
  was created; provider-tax modes remain explicitly disabled.
- The minimum-commitment deployment added only schema and code for plan-level in-arrears true-ups.
  Remote health/readiness returned `200`/`200`, unauthenticated plan access returned `401`, and no
  migrations remained pending. The remote database remains unseeded.
- The outbound-webhook deployment added endpoint/delivery schema and guarded code only. Remote
  health/readiness returned `200`/`200`, unauthenticated endpoint access returned `401`, and no
  migrations remained pending. Delivery is disabled, no HMAC signing secret exists remotely, and
  no endpoint or delivery row was created.
- The schedule-dispatch deployment registered the five-minute trigger and an exhaustive ownership
  registry for all 27 legacy schedules. Aggregate-only verification found three completed Workflow
  audits, all correctly marked `partial` because due unported schedules are reported explicitly.
- The payment-terms deployment added customer and organization defaults, immutable invoice due-date
  snapshots, replay-safe overdue state, and successful-payment clearing. Remote health/readiness
  returned `200`/`200`, unauthenticated invoice access returned `401`, and no migration remained
  pending. The remote database still contains zero organizations and zero invoices.
- The webhook-retention deployment registered both legacy daily 90-day cleanup jobs and a durable
  D1 queue for retrying archived-payload deletion after R2 failures. Remote health/readiness
  returned `200`/`200`, unauthenticated endpoint access returned `401`, and no migration remained
  pending. Aggregate-only verification found zero receipts, deliveries, and cleanup tasks.
- The invoice-finalization deployment added immutable issue/finalization dates, manual finalization,
  and the hourly finalization owner. Remote health/readiness returned `200`/`200`, unauthenticated
  finalize access returned `401`, and no migration remained pending. Aggregate-only verification
  found zero organizations, invoices, and draft invoices.
- The refreshable-draft deployment added customer grace settings, non-consuming recurring draft
  previews, manual and scheduled refresh, refresh-before-finalize allocation, and trigger-backed
  mutation guards. Remote health/readiness returned `200`/`200`, unauthenticated draft refresh
  returned `401`, and no migration remained pending. Aggregate-only verification found zero
  organizations, invoices, drafts, and mutation guards; 15 Cron audits prove the dispatcher remains
  active. No route, secret, billing row, or disabled external-mutation/delivery flag changed.
- The initial-subscription-draft deployment added immutable initial invoice contexts and the same
  non-consuming refresh/finalization path without creating synthetic renewal cycles. Remote
  health/readiness returned `200`/`200`, unauthenticated draft refresh returned `401`, and no
  migration remained pending. Aggregate-only verification found zero organizations, invoices,
  initial contexts, and mutation guards; 17 Cron audits prove the dispatcher remains active. All
  payment/provider/outbound flags remain disabled, with no route, secret, or billing data added.
- The draft-dependency deployment added 22 D1 triggers that flag affected drafts after supported
  subscription, plan/rating, applied-coupon, tax, credit-note, wallet, and usage mutations. Remote
  health/readiness returned `200`/`200`, unauthenticated draft refresh returned `401`, and no
  migration remained pending. Aggregate-only verification found zero organizations, invoices,
  initial contexts, and mutation guards; 20 Cron audits prove the dispatcher remains active. All
  external-action flags remain disabled, with no route, secret, or billing data added.
- No organization, API key, plan, customer, subscription, invoice, usage event, payment attempt,
  document artifact, provider secret, or customer data was seeded remotely.

## Cleanup procedure

Cleanup is destructive and requires explicit approval. Run from `cloudflare/`, in this order, after
confirming the exact names above:

```sh
pnpm exec wrangler delete --name serp-dev-lago-native
pnpm exec wrangler queues delete serp-dev-lago-domain-events
pnpm exec wrangler queues delete serp-dev-lago-domain-events-dlq
pnpm exec wrangler r2 bucket delete serp-dev-lago-native-billing-artifacts
pnpm exec wrangler d1 delete serp-dev-lago-native-d1
```

Deleting the Worker removes its Cron, Queue producer/consumer bindings, Workflow registrations,
and Durable Object code binding. Confirm the current Wrangler behavior and inspect the account
again before cleanup; never delete by prefix or wildcard.
