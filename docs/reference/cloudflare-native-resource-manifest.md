# Cloudflare-Native Lago Resource Manifest

Last verified: 2026-08-13

This manifest covers the isolated, non-production stack created for the Cloudflare-native rewrite.
It is not a production inventory and contains no secrets or customer data.

## Account and endpoint

- Cloudflare account: `SERP`
- Worker: `serp-dev-lago-native`
- workers.dev URL: `https://serp-dev-lago-native.serpcompany.workers.dev`
- Initial deployed version: `c1b38acd-70bc-4997-862a-fde3761d2a2c`
- Latest verified version: `f1dbf691-bce3-4e0f-80ca-cfc4d0ca954c`
- Custom domains/routes: none
- Payment provider secrets: none
- `PAYMENT_MUTATIONS_ENABLED`: `0`
- `PROVIDER_READS_ENABLED`: `0`

## Resources

| Kind | Name or ID | Binding | Purpose |
| --- | --- | --- | --- |
| D1 | `serp-dev-lago-native-d1` / `2f32f159-c269-46c6-a4dd-9e38477f5d25` | `BILLING_DB` | Synthetic billing state |
| R2 | `serp-dev-lago-native-billing-artifacts` | `BILLING_ARTIFACTS` | Immutable provider webhook and usage-event artifacts |
| Queue | `serp-dev-lago-domain-events` | `DOMAIN_EVENTS` | Domain events and reconciliation dispatch |
| DLQ | `serp-dev-lago-domain-events-dlq` | none | Poison/retry exhaustion |
| Durable Object | `BillingAccount` | `BILLING_ACCOUNTS` | Per-invoice command reservations |
| Workflow | `serp-dev-lago-checkout` | `CHECKOUT_WORKFLOW` | Checkout orchestration target |
| Workflow | `serp-dev-lago-reconciliation` | `RECONCILIATION_WORKFLOW` | Provider and outbox reconciliation |
| Cron | `17 * * * *` | Worker scheduled handler | Hourly reconciliation dispatch |
| Browser Rendering | account binding | `BROWSER` | Reserved for document milestone |

Applied D1 migrations: `0001_foundation.sql` through `0006_billing_cycles.sql`.

## Verified behavior

- `GET /health` returned `200` with environment `development`.
- `GET /ready` returned `200` after querying the remote D1 database.
- `GET /api/v1/invoices` without a bearer key returned the expected `401` envelope.
- `GET /api/v1/events` without a bearer key returned the expected `401` envelope after migration
  `0005` and the latest deployment.
- No organization, API key, plan, customer, subscription, invoice, usage event, payment attempt,
  provider secret, or customer data was seeded remotely.

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
