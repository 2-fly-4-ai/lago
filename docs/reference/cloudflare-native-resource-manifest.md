# Cloudflare-Native Lago Resource Manifest

Last verified: 2026-08-15

This manifest covers the isolated, non-production stack created for the Cloudflare-native rewrite.
It is not a production inventory and contains no secrets or customer data.

## Account and endpoint

- Cloudflare account: `SERP`
- Worker: `serp-dev-lago-native`
- workers.dev URL: `https://serp-dev-lago-native.serpcompany.workers.dev`
- Initial deployed version: `c1b38acd-70bc-4997-862a-fde3761d2a2c`
- Latest verified version: `a0c0ab74-b4bc-4493-94af-b8128d0535f9`
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

Applied D1 migrations: `0001_foundation.sql` through
`0037_wallet_invoice_custom_sections.sql`.

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
- The terminated-draft deployment extended the subscription invalidation trigger to termination and
  kept existing immutable-context drafts refreshable after explicit skip-invoice/skip-credit
  termination. Remote health/readiness returned `200`/`200`, unauthenticated termination returned
  `401`, and no migration remained pending. Aggregate-only verification found all 22 invalidation
  triggers, zero organizations/invoices/initial contexts/mutation guards, and 21 Cron audits. All
  external-action flags remain disabled, with no route, secret, or billing data added.
- The code-only event-batch deployment added all-before-write validation, atomic D1 event/outbox
  insertion, deterministic R2 evidence, and indexed batch errors without changing schema or
  resources. Remote health/readiness returned `200`/`200`, unauthenticated batch ingestion returned
  `401`, and no migration was pending. Aggregate-only verification found zero organizations, usage
  events, and invoices plus 23 Cron audits. All external-action flags remain disabled, with no
  route, secret, or billing data added.
- The pending-activation deployment added the normalized future-start field and index, pending
  creation without an invoice, and the replay-safe five-minute activation owner. Remote
  health/readiness returned `200`/`200`, unauthenticated future subscription creation returned
  `401`, and no migration remained pending. Aggregate-only verification found zero organizations,
  subscriptions, pending subscriptions, and invoices plus 27 Cron audits. All external-action
  flags remain disabled, with no route, secret, or billing data added.
- The code-only pending-management deployment added future rescheduling and invoice-free pending
  cancellation without changing schema or resources. Remote health/readiness returned `200`/`200`,
  unauthenticated pending update returned `401`, and no migration was pending. Aggregate-only
  verification found zero organizations, subscriptions, and invoices plus 28 Cron audits. All
  external-action flags remain disabled, with no route, secret, or billing data added.
- The code-only initial-billing-mode deployment made base subscription invoice creation honor the
  existing plan `pay_in_advance` flag without changing schema or resources. Remote health/readiness
  returned `200`/`200`, unauthenticated plan creation returned `401`, and no migration was pending.
  Aggregate-only verification found zero organizations, plans, subscriptions, and invoices plus 30
  Cron audits. All external-action flags remain disabled, with no route, secret, or billing data
  added.
- The code-only renewal-period deployment made pay-in-advance base lines snapshot the next period
  while retaining closed-period evidence for in-arrears fees. Remote health/readiness returned
  `200`/`200`, unauthenticated invoice access returned `401`, and no migration was pending.
  Aggregate-only verification found zero organizations, subscriptions, invoices, and invoice lines
  plus 31 Cron audits. All external-action flags remain disabled, with no route, secret, or billing
  data added.
- The code-only immediate-start-event deployment added transactional `subscription.started`
  evidence for same-day activation. The first D1 inventory request returned transient Cloudflare
  authorization error `7403`; no migration command ran, but the shell continued to the code-only
  Worker deploy. An immediate inventory retry then reported no pending migrations. Remote
  health/readiness returned `200`/`200`, unauthenticated subscription creation returned `401`, and
  aggregate-only verification found zero organizations, subscriptions, invoices, and outbox events
  plus 32 Cron audits. All external-action flags remain disabled, with no route, secret, or billing
  data added.
- The code-only in-arrears termination deployment added atomic final-invoice persistence with exact
  inclusive UTC-day base proration, partial-window usage, immutable line metadata, credit/tax/wallet
  allocation, and invoice/subscription outbox events. Remote health/readiness returned `200`/`200`,
  unauthenticated termination returned `401`, and no migration was pending. Aggregate-only
  verification found zero organizations, subscriptions, invoices, and invoice lines plus 37 Cron
  audits. Pay-in-advance termination credits, positive-grace drafts, fixed charges, commitments,
  and tenant-local scheduling remain guarded; all external-action flags remain disabled, with no
  route, secret, or billing data added.
- The scheduled-termination deployment applied only
  `0028_scheduled_subscription_termination.sql`, adding the nullable UTC `ending_at` field and its
  active-subscription index, then registered the legacy hourly `:05` executor. Creation replay and
  conflict identity now include a supplied ending instant without changing hashes for requests that
  omit it; billing close excludes due endings so it cannot advance ahead of termination. Remote
  health/readiness returned `200`/`200`, unauthenticated ending creation returned `401`, and no
  migration remained pending. Aggregate-only verification found the expected index, zero
  organizations, subscriptions, scheduled endings, and invoices plus 39 Cron audits. The stack
  remains unseeded and all external-action flags remain disabled, with no route or secret added.
- The code-only unused-advance-credit deployment reuses the credit-note aggregate to atomically
  terminate a pay-in-advance subscription and issue a credit-only balance for exact unused UTC
  service days. It is intentionally limited to finalized base invoices without coupon, tax, wallet,
  or prior credit-note allocations; final usage invoicing, refunds, offsets, and allocated-source
  adjustments remain guarded. Remote health/readiness returned `200`/`200`, unauthenticated
  termination returned `401`, and no migration was pending. Aggregate-only verification found zero
  organizations, subscriptions, invoices, credit notes, and credit-note items plus 40 Cron audits.
  All external-action flags remain disabled, with no route, secret, or billing data added.
- The code-only advance-plan termination-usage deployment added the complementary mode: when
  unused-period crediting is explicitly skipped, termination finalizes only bounded in-arrears
  usage and does not repeat the already-paid base line. The combined usage-invoice plus unused-credit
  command remains guarded until both ledger mutations share one proof. Remote health/readiness
  returned `200`/`200`, unauthenticated termination returned `401`, and no migration was pending.
  Aggregate-only verification found zero organizations, subscriptions, invoices, invoice lines, and
  credit notes plus 42 Cron audits. All external-action flags remain disabled, with no route,
  secret, or billing data added.
- The code-only fixed-charge termination deployment added full supported non-prorated,
  pay-in-arrears fixed fees to immediate and scheduled final invoices while retaining the minimum-
  commitment guard. Remote health/readiness returned `200`/`200`, unauthenticated termination
  returned `401`, and no migration was pending. Aggregate-only verification found zero
  organizations, subscriptions, invoices, invoice lines, fixed charges, and minimum commitments
  plus 44 Cron audits. All external-action flags remain disabled, with no route, secret, or billing
  data added.
- The code-only in-arrears commitment termination deployment added an inclusive UTC-prorated
  threshold for the catalog's unsplit final-invoice window, while pay-in-advance commitments remain
  guarded before reservation. The first read-only migration preflight returned transient Cloudflare
  authorization code `7403`, so the chained deployment did not run; `wrangler whoami` confirmed the
  OAuth identity and SERP account, and the repeated preflight succeeded before deployment. Remote
  health/readiness returned `200`/`200`, unauthenticated termination returned `401`, and no migration
  was pending. Aggregate-only verification found zero organizations, subscriptions, invoices,
  invoice lines, fixed charges, and minimum commitments plus 46 Cron audits. All external-action
  flags remain disabled, with no route, secret, or billing data added.
- The code-only combined pay-in-advance termination deployment now creates an eligible unused-
  period credit, finalizes bounded usage, applies the new note before wallet lots, and transitions
  the subscription in one ordered D1 batch. Executable failure injection proves all earlier credit
  writes roll back if final-invoice persistence fails. Remote health/readiness returned `200`/`200`,
  unauthenticated termination returned `401`, and no migration was pending. Aggregate-only
  verification found zero organizations, subscriptions, invoices, invoice lines, credit notes,
  credit-note applications, wallets, and outbox events plus 49 Cron audits. All external-action
  flags remain disabled, with no route, secret, or billing data added.
- The positive-grace pay-in-advance deployment applied only
  `0030_draft_termination_credit_notes.sql`, adding the non-allocatable draft-note state, immutable
  source/ratio context, and application guard. Follow-up migration inventory was empty. Isolated
  Worker version `f4fd52ff-083f-4e40-9240-ccec9b24091c` retained only the existing workers.dev URL,
  `*/5` Cron, D1, R2, Queue/DLQ, Durable Object, Browser, and three Workflow bindings. Remote
  health/readiness returned `200`/`200`, unauthenticated termination returned `401`, and
  aggregate-only verification found zero organizations, subscriptions, invoices, invoice lines,
  invoice contexts, credit notes, termination-credit contexts, credit-note applications, wallets,
  and outbox events plus 59 Cron audits. All external-action flags remain disabled, with no route,
  secret, or billing data added.
- The persisted-termination-action deployment applied only
  `0031_subscription_termination_actions.sql`, adding constrained nullable invoice and credit-note
  actions to subscriptions; follow-up inventory reported no pending migrations. Isolated Worker
  version `f83c6e7a-0d6b-4e2b-a9b5-d987096cfab4` retained only the existing workers.dev URL, `*/5`
  Cron, D1, R2, Queue/DLQ, Durable Object, Browser, and three Workflow bindings. Remote
  health/readiness returned `200`/`200`, unauthenticated termination returned `401`, and
  aggregate-only verification found both new columns, zero organizations, subscriptions, stored
  subscription actions, invoices, credit notes, and outbox events plus 68 Cron audits. All three
  external-action flags remain disabled, with no route, secret, or billing data added.
- The code-only safe scheduled-advance deployment admits pay-in-advance `ending_at` only with a
  persisted skip-credit action, then reuses the stored generate/skip invoice behavior in the hourly
  owner. Default or credit-mode schedules remain guarded. Worker version
  `fb10cb7a-a2e1-4dca-a097-3ce9f58de222` required no D1 migration and retained only the existing
  isolated bindings, workers.dev URL, and `*/5` Cron. Remote health/readiness returned `200`/`200`,
  unauthenticated termination returned `401`, migration inventory remained empty, and
  aggregate-only verification found zero organizations, subscriptions, invoices, credit notes, and
  outbox events plus 70 Cron audits. All external-action flags remain disabled, with no route,
  secret, or billing data added.
- The calendar/timezone/free-trial deployment applied only
  `0032_calendar_trial_billing.sql`; follow-up inventory reported no pending migrations. Schema
  verification found both timezone columns and all five subscription billing/trial columns.
  Isolated Worker version `074a28d2-6d22-48e0-aad7-6c27a04e5b8c` retained only the existing
  workers.dev URL, `*/5` Cron, D1, R2, Queue/DLQ, Durable Object, Browser, and three Workflow
  bindings. Remote health/readiness returned `200`/`200`, unauthenticated subscription access
  returned `401`, and aggregate-only verification found zero organizations, customers, plans,
  subscriptions, invoices, credit notes, and outbox events plus 77 Cron audits. All three
  external-action flags remain disabled, with no route, secret, or billing data added.
- The subscription-generation deployment applied only
  `0033_subscription_generations.sql`; follow-up inventory reported no pending migrations and the
  remote foreign-key check returned no rows. Schema verification found all 10 multi-generation
  draft invalidation triggers, the atomic transition guard, and the three expected generation and
  external-event uniqueness indexes. Isolated Worker version
  `6f198ceb-959d-486a-ba64-6b7ca88a6fa3` retained only the existing workers.dev URL, `*/5` Cron,
  D1, R2, Queue/DLQ, Durable Object, Browser, and three Workflow bindings. Remote
  health/readiness returned `200`/`200`, unauthenticated subscription access returned `401`, and
  aggregate-only verification found zero organizations, customers, plans, subscriptions, invoices,
  credit notes, and outbox events plus 88 Cron audits. All three external-action flags remain
  disabled, with no route, secret, or billing data added.
- The code-only prepaid-grace upgrade deployment completed cross-draft source-credit coordination
  and multi-generation invoice ownership without a D1 migration. Worker version
  `52f2f3e2-d402-4c9c-bb04-be095fe5b7f8` retained only the existing workers.dev URL, `*/5` Cron,
  D1, R2, Queue/DLQ, Durable Object, Browser, and three Workflow bindings. Remote migration
  inventory remained empty; health/readiness returned `200`/`200`; unauthenticated subscription
  access returned `401`; aggregate-only verification found zero organizations, customers, plans,
  subscriptions, invoices, credit notes, and outbox events plus 93 Cron audits. All three
  external-action flags remain disabled, with no route, secret, or billing data added.
- The code-only backdated-start deployment added historical recurring activation and period
  catch-up without a D1 migration. Worker version `f88803aa-0b4c-4a9c-a707-fb153280d706`
  retained only the existing workers.dev URL, `*/5` Cron, D1, R2, Queue/DLQ, Durable Object,
  Browser, and three Workflow bindings. Remote migration inventory remained empty;
  health/readiness returned `200`/`200`; unauthenticated subscription access returned `401`;
  aggregate-only verification found zero organizations, customers, plans, subscriptions, invoices,
  credit notes, and outbox events plus 96 Cron audits. All three external-action flags remain
  disabled, with no route, secret, or billing data added.
- The subscription payment-policy deployment applied only
  `0034_subscription_payment_policy.sql`, then verified an empty pending inventory, 34 migrations,
  both new columns and guards, and no foreign-key violations. Worker version
  `943b9159-4f62-4f52-9061-a3424f578e0c` retained only the existing workers.dev URL, `*/5` Cron,
  D1, R2, Queue/DLQ, Durable Object, Browser, and three Workflow bindings. Health/readiness returned
  `200`/`200`; unauthenticated subscription access returned `401`; aggregate-only verification
  found zero organizations, customers, plans, subscriptions, invoices, credit notes, and outbox
  events plus 98 Cron audits. All three external-action flags remain disabled, with no route,
  secret, provider action, or billing data added.
- The customer/default invoice custom-section deployment applied only
  `0036_customer_invoice_custom_sections.sql` in 10.78 ms; follow-up inventory reported no pending
  migrations. Schema verification found 36 migrations, five section tables, 21 related triggers,
  two read-only precedence views, and no foreign-key violations. Isolated Worker version
  `fe2fb69c-b113-438f-884f-b6b5f367b87c` retained only the existing workers.dev URL, `*/5` Cron,
  D1, R2, Queue/DLQ, Durable Object, Browser, and three Workflow bindings. Health/readiness returned
  `200`/`200`; unauthenticated section-catalog and default-selection access both returned `401`;
  aggregate-only verification found zero organizations, customers, plans, subscriptions, invoices,
  catalog sections, customer/default links, snapshots, and outbox events plus 113 schedule audits.
  All three external-action flags remain disabled, with no route, secret, provider action, or
  billing/catalog/default data added.
- The wallet invoice custom-section deployment applied only
  `0037_wallet_invoice_custom_sections.sql`; follow-up inventory reported no pending migrations.
  Schema verification found 37 migrations, seven section tables, 25 related triggers including
  all four wallet guards, both wallet skip columns, and no foreign-key violations. Isolated Worker
  version `a0c0ab74-b4bc-4493-94af-b8128d0535f9` retained only the existing workers.dev URL,
  `*/5` Cron, D1, R2, Queue/DLQ, Durable Object, Browser, and three Workflow bindings.
  Health/readiness returned `200`/`200`; unauthenticated section-catalog and wallet access both
  returned `401`; aggregate-only verification found zero organizations, customers, invoices,
  catalog sections, wallets, wallet transactions, either wallet-section relationship, and outbox
  events plus 118 schedule audits. All three external-action flags remain disabled, with no route,
  secret, provider action, customer data, or billing/catalog/wallet data added.
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
