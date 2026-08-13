# Cloudflare-Native Lago Resource Manifest

Last verified: 2026-08-13

This manifest covers the isolated, non-production stack created for the Cloudflare-native rewrite.
It is not a production inventory and contains no secrets or customer data.

## Account and endpoint

- Cloudflare account: `SERP`
- Worker: `serp-dev-lago-native`
- workers.dev URL: `https://serp-dev-lago-native.serpcompany.workers.dev`
- Initial deployed version: `c1b38acd-70bc-4997-862a-fde3761d2a2c`
- Latest verified version: `38220f20-14ff-49c5-95e5-4c1b1ec464e6`
- Custom domains/routes: none
- Payment provider secrets: none
- `PAYMENT_MUTATIONS_ENABLED`: `0`
- `PROVIDER_READS_ENABLED`: `0`

## Resources

| Kind | Name or ID | Binding | Purpose |
| --- | --- | --- | --- |
| D1 | `serp-dev-lago-native-d1` / `2f32f159-c269-46c6-a4dd-9e38477f5d25` | `BILLING_DB` | Synthetic billing state |
| R2 | `serp-dev-lago-native-billing-artifacts` | `BILLING_ARTIFACTS` | Immutable provider webhook, usage-event, and invoice PDF artifacts |
| Queue | `serp-dev-lago-domain-events` | `DOMAIN_EVENTS` | Domain events and reconciliation dispatch |
| DLQ | `serp-dev-lago-domain-events-dlq` | none | Poison/retry exhaustion |
| Durable Object | `BillingAccount` | `BILLING_ACCOUNTS` | Per-invoice command reservations |
| Workflow | `serp-dev-lago-checkout` | `CHECKOUT_WORKFLOW` | Checkout orchestration target |
| Workflow | `serp-dev-lago-reconciliation` | `RECONCILIATION_WORKFLOW` | Provider and outbox reconciliation |
| Workflow | `serp-dev-lago-documents` | `DOCUMENT_WORKFLOW` | Retryable invoice PDF generation and R2 archival |
| Cron | `17 * * * *` | Worker scheduled handler | Hourly reconciliation dispatch |
| Browser Rendering | account binding | `BROWSER` | Invoice HTML-to-PDF rendering |

Applied D1 migrations: `0001_foundation.sql` through `0011_credit_notes.sql`.

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
