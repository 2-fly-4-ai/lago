# Lago Cloudflare Native

This package is the container-free Cloudflare replacement for Lago in the SERP platform. It is
currently isolated from production and preserves the verified `store-new` REST contract while the
remaining Lago feature inventory is dispositioned and ported.

## Architecture

- Worker: authenticated Lago-compatible HTTP API and signed provider webhooks.
- D1: organizations, customers, plans, subscriptions, invoices, payment attempts, outbox state,
  and webhook receipt metadata.
- Durable Objects: per-invoice command reservations for strong idempotency around external payment
  mutations.
- Queues: at-least-once domain event delivery with idempotent consumers and a dead-letter queue.
- Workflows and Cron: provider reconciliation and outbox publication.
- R2: immutable raw provider webhook archives.
- Browser Rendering: reserved for the document-generation milestone.

No Docker, Compose, local service daemon, Rails runtime, PostgreSQL, Redis, Go/Rust subprocess, or
OS command is required by this package.

## Safety defaults

- `PAYMENT_MUTATIONS_ENABLED=0` prevents hosted-payment token creation.
- `PROVIDER_READS_ENABLED=0` defers provider reconciliation.
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

`store-new` and `serp-auth` are not modified by this branch.
