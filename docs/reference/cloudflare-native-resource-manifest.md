# Cloudflare-Native Lago Resource Manifest

Last verified: 2026-08-16

This manifest covers the isolated, non-production stack created for the Cloudflare-native rewrite.
It is not a production inventory and contains no secrets or customer data.

## Account and endpoint

- Cloudflare account: `SERP`
- Worker: `serp-dev-lago-native`
- workers.dev URL: `https://serp-dev-lago-native.serpcompany.workers.dev`
- Initial deployed version: `c1b38acd-70bc-4997-862a-fde3761d2a2c`
- Latest verified version: `a2ed2b7b-93e3-4b3e-9337-01e5bad159e0`
- Custom domains/routes: none
- Payment provider secrets: none
- `PUBLIC_BASE_URL`: `https://serp-dev-lago-native.serpcompany.workers.dev`
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
| Workflow          | `serp-dev-lago-plan-deletion`                                      | `PLAN_DELETION_WORKFLOW`  | Durable subscription-bearing plan retirement                       |
| Cron              | `* * * * *`                                                        | Worker scheduled handler  | Deterministic legacy-schedule dispatch and activity fanout         |
| Browser Rendering | account binding                                                    | `BROWSER`                 | Invoice HTML-to-PDF rendering                                      |

Applied D1 migrations: `0001_foundation.sql` through
`0069_data_exports.sql`.

## Verified behavior

- Version `a2ed2b7b-93e3-4b3e-9337-01e5bad159e0` deployed the M6 document-golden runtime
  hardening without a migration or resource change. Invoice, payment-receipt, and credit-note HTML
  now selects a portable Arial/CID TrueType print path instead of macOS variable `system-ui` Type 3
  subsets; checked-in synthetic PDFs and four visually inspected 300-DPI pages remain the local
  rendering evidence. Remote preflight and final audit found no pending migration, zero active or
  malformed key hashes, zero payment/retry/receipt/credit-note/export/document-artifact state, and
  no foreign-key violations. Health/readiness returned `200`/`200`; unauthenticated invoice,
  payment-receipt, and credit-note PDF downloads each returned `401`. No remote document was
  generated because the isolated database contains no eligible billing state and no active key was
  created. The deployed bundle was 1406.76 KiB (245.92 KiB gzip) with a 6 ms startup; version
  inspection confirmed only fetch/scheduled/queue handlers and all external-action flags at `0`.
  No production route/domain, provider action, customer message, payment action, secret, or
  customer data changed.
- Version `da276f6c-30d8-4458-81f0-263dbdd47888` deployed the code-only, kill-switched
  Authorize.Net invoice-payment retry boundary with no migration or resource change. Remote
  preflight and final audit both found no pending migration, zero active or malformed key hashes,
  zero payment attempts/request payments/receipts/retry events/credit notes/exports, and no foreign-
  key violations. A disposable hashed key proved health/readiness `200`/`200`, unauthenticated retry
  `401`, and authenticated retry `503 payment_mutations_disabled`, then was revoked. No invoice was
  selected or mutated and no provider call, payment intent, retry event, hosted link, message, or
  artifact was created. The deployed bundle was 1406.01 KiB (245.80 KiB gzip) with a 5 ms startup;
  version inspection confirmed only fetch/scheduled/queue handlers and all external-action flags at
  `0`. No production route/domain, provider action, customer message, payment action, secret, or
  customer data changed.
- Version `2d8cb873-d28b-481f-8eff-3b7155e36fe5` deployed the container-free data-export pipeline
  after applying only migration `0069`. Remote verification found the 21-column lifecycle ledger,
  all four requester/identity/artifact/outbox guards, no pending migration, empty export state, and
  no foreign-key violations. A disposable hashed key exercised empty list, not-found show/download/
  resend, health/readiness, and authentication, then was revoked. No remote export was created, so
  D1 paging, two-pass fixed-length R2 streaming, CSV generation, expiry, and artifact replay remain
  proven by the full local Workers suite rather than a remote billing-data read/artifact mutation.
  The final audit found zero active or malformed key hashes, export/quote/payment/receipt/credit-note
  state, and 798 schedule audits. The deployed bundle was 1396.05 KiB (243.58 KiB gzip) with a 5 ms
  startup; version inspection confirmed only fetch/scheduled/queue handlers and all external-action
  flags at `0`. No production route/domain, provider action, customer message, payment action,
  secret, or customer data changed.
- Version `d161a781-a856-44c7-8438-94b5a832ca44` deployed the quote lifecycle REST replacement
  after applying only migration `0068`. Remote verification found the 12-column quote ledger,
  14-column version ledger, owner and active-membership projections, all seven tenant/identity/
  outbox guards, no pending migration, empty quote state, an unchanged zero organization counter,
  and no foreign-key violations. A disposable hashed key exercised empty list, not-found quote and
  version actions, health/readiness, and authentication, then was revoked. No remote quote was
  created, so numbering, owner synchronization, and version lifecycle mutations remain proven by
  the full local Workers suite rather than a remote billing-state mutation. The final audit found
  zero active or malformed key hashes, quote/payment/receipt/credit-note state, and 769 schedule
  audits. The deployed bundle was 1353.17 KiB (235.19 KiB gzip) with a 5 ms startup; version
  inspection confirmed only fetch/scheduled/queue handlers and all external-action flags at `0`.
  No production route/domain, provider action, customer message, payment action, secret, or customer
  data changed.
- Version `be0a0056-2a14-4f33-8633-172fea750fd5` deployed finalized/voided credit-note PDFs after
  applying only migration `0067`. Remote verification found the 12-column artifact ledger, all
  three tenant/version/identity/generated-event guards, no pending migration, zero credit notes/
  artifacts/events/payments, and no foreign-key violations. A disposable hashed key exercised the
  empty credit-note list, not-found show/PDF download, explicit XML-disabled boundary,
  health/readiness, and authentication, then was revoked. No synthetic credit note was created, so
  Browser Rendering, versioned void regeneration, and R2 archival remain proven by the full local
  Workers suite rather than a remote billing mutation. The final audit found zero active or
  malformed key hashes, zero billing/document state, and 737 schedule audits. The deployed bundle
  was 1314.55 KiB (228.43 KiB gzip) with a 6 ms startup; version inspection confirmed only fetch/
  scheduled/queue handlers and all external-action flags at `0`. No production route/domain,
  provider action, customer message, payment action, secret, or customer data changed.
- Version `f5e9777d-c4b7-4ece-9667-0fc61dfe1d10` deployed the payment-receipt PDF pipeline after
  applying only migration `0066`. Remote verification found the 12-column artifact ledger, both
  tenant/version and immutable-identity triggers, no pending migration, zero artifacts/receipts/
  payments/receipt events, and no foreign-key violations. A disposable hashed key exercised the
  empty receipt list, not-found show/download/resend, health/readiness, and authentication paths,
  then was revoked. No remote payment was manufactured, so Browser Rendering and R2 generation
  remain proven by the full local Workers suite rather than a remote billing mutation. The final
  audit found zero active or malformed key hashes, zero payment/receipt/artifact state, and 718
  schedule audits. The deployed bundle was 1300.73 KiB (226.38 KiB gzip) with a 6 ms startup;
  version inspection confirmed only fetch/scheduled/queue handlers and all external-action flags at
  `0`. No production route/domain, provider action, customer message, payment action, secret, or
  customer data changed.
- Version `04561b02-dbe9-4a8b-a71b-aa2a127a87f5` deployed the tenant-scoped payment-receipt
  list/show/filter API and atomic settlement ledger after applying only migration `0065`. Remote
  verification found 65 migrations, 12 receipt columns, the customer counter, nine state/tenant/
  version triggers, no pending migration, and no foreign-key violations. Because a remote payment
  action was outside the approved smoke boundary, a disposable hashed key exercised only the empty
  list/filter, not-found show/resend, health/readiness, and authentication paths, then was revoked;
  the full manual/provider/payment-request settlement and rollback behavior is proven locally. The
  final audit found nine hashed/revoked synthetic key records, zero active or malformed hashes,
  zero receipts/payment state, and the unchanged one-tenant billing graph. Health/readiness returned
  `200`/`200`, unauthenticated receipt access returned `401`, startup was 5 ms, and every external-
  action flag remained `0`.
- Version `252479ec-4581-4c72-bf84-32e439ed1b5a` deployed the retained single billing-entity
  list/show/update API after applying only migration `0064`. Remote verification found 64
  migrations, one 33-field default-entity view, one update-event guard, one projected entity, no
  pending migration, and no foreign-key violations. A disposable hashed key exercised list/show,
  the existing nested custom-section route, normalized update, stable no-op replay, second-entity
  creation/lookup refusal, and e-invoicing refusal, then was revoked. The final audit found eight
  hashed/revoked synthetic key records, zero active or malformed hashes, one value-free billing-
  entity event, zero payment state, and the unchanged one-tenant billing graph. Health/readiness
  returned `200`/`200`, unauthenticated entity access returned `401`, startup was 6 ms, and every
  external-action flag remained `0`.
- Version `99ef39b9-71ca-4d49-9e08-fa2a9c0e6ca8` deployed the tenant-scoped organization
  show/update API after applying only migration `0063`. Remote verification found 63 migrations,
  29 organization columns, one slug index, all three configuration/outbox guards, no pending
  migration, and no foreign-key violations. A disposable hashed key exercised show, normalized
  update, stable no-op replay, webhook-mutation refusal, and unsupported-currency refusal, then was
  revoked. The final audit found one value-free organization event, seven hashed/revoked synthetic
  key records, zero active or malformed hashes, zero payment state, and the retained one-tenant
  synthetic billing graph. Health/readiness returned `200`/`200`, unauthenticated organization
  access returned `401`, startup was 7 ms, and every external-action flag remained `0`.
- Version `987740af-530f-4dea-a609-f2c6ecb71f95` deployed the API-key lifecycle after applying
  only migration `0062`. A disposable bootstrap key exercised create, sanitized update, rotation,
  old-key invalidation, replacement authentication, replacement revocation, fine-grained permission
  refusal, and last-key protection. Every run key was revoked. The final audit found five hashed/
  revoked synthetic key records, zero active or malformed hashes, four secret-free API-key outbox
  events, zero payment state, and no foreign-key violations; all external-action flags remained `0`.
- Version `1371f1ee-0afa-4bbe-a4cd-46e7645def2e` deployed the tenant-scoped fee API without a
  migration. A run-scoped key proved authenticated list/show against the retained synthetic invoice
  and the explicit mutation guard, then was revoked. Health/readiness returned `200`/`200`,
  unauthenticated fee access returned `401`, all external-action flags stayed `0`, and the audit
  found one expected synthetic fee, zero payment state, zero active keys, and no foreign-key
  violations.
- Version `80fee6c9-5be3-481e-898e-26013daa14ea` binds the non-secret
  `PUBLIC_BASE_URL` to the isolated workers.dev hostname. Health/readiness returned `200`/`200`,
  unauthenticated hosted-payment access returned `401`, all three external-action flags remained
  `0`, and the post-deploy aggregate audit found no business/payment rows or foreign-key violations.
- Provider-free staging run `synthetic-e2e-20260815-001` created one synthetic tenant, plan,
  customer, subscription, finalized invoice, and invoice line. Exact create replays preserved
  identity, divergent subscription replay returned `subscription_idempotency_conflict`, invoice
  discovery returned one pending 1,999-cent invoice, and hosted-payment creation returned
  `payment_mutations_disabled`. No payment link or provider action occurred. The run-scoped API key
  plaintext existed only in the runner and its stored hash was revoked after the assertions; the
  synthetic ledger and five outbox records remain for inspection under the documented cleanup rule.
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
- The recurring granted-credit wallet deployment applied only
  `0038_recurring_granted_wallet_rules.sql` in 7.93 ms; follow-up inventory reported no pending
  migrations. Schema verification found 38 migrations, both recurring-rule tables, all six related
  guards, wallet-transaction metadata and originating-rule columns, and no foreign-key violations.
  Isolated Worker version `129d703b-e9c3-4eb1-8172-d33d97c97614` retained only the existing
  workers.dev URL, `*/5` Cron, D1, R2, Queue/DLQ, Durable Object, Browser, and three Workflow
  bindings. Health/readiness returned `200`/`200`; unauthenticated section-catalog and wallet access
  both returned `401`; aggregate-only verification found zero organizations, customers, invoices,
  catalog sections, wallets, wallet transactions, recurring rules, rule-section links, and outbox
  events plus 124 schedule audits. All three external-action flags remain disabled, with no route,
  secret, provider action, customer data, or billing/catalog/wallet data added.
- The ongoing wallet-balance deployment applied only `0039_wallet_ongoing_balances.sql`; remote
  schema verification found 39 migrations, zero foreign-key violations, five projection columns,
  the fixed granted threshold-rule table, and all three queried tenant/origin/version guards.
  Isolated Worker version `ad896271-925f-4723-9114-fd7917d9616c` retained only the existing
  workers.dev URL, `*/5` Cron, D1, R2, Queue/DLQ, Durable Object, Browser, and three Workflow
  bindings. The deployed bundle was 738.13 KiB (128.80 KiB gzip) with a 6 ms startup.
  Health/readiness returned `200`/`200`; unauthenticated plan/wallet access returned `401`/`401`;
  aggregate-only verification found zero organizations, customers, invoices, wallets, wallet
  transactions, interval rules, threshold rules, and outbox events plus 130 schedule audits. All
  three external-action flags remain disabled, with no route, secret, provider action, customer
  data, or billing/wallet data added.
- The wallet-limitation deployment applied only `0040_wallet_limitations.sql`; remote schema
  verification found 40 migrations, zero foreign-key violations, the strict wallet-target table
  and tenant guard, zero target rows, and zero invalid fee-type JSON rows. Isolated Worker version
  `d2dffa91-f546-4220-a9df-c05fc5c76d57` retained only the existing workers.dev URL, `*/5` Cron,
  D1, R2, Queue/DLQ, Durable Object, Browser, and three Workflow bindings. The deployed bundle was
  754.08 KiB (132.28 KiB gzip) with a 4 ms startup. Health/readiness returned `200`/`200`;
  unauthenticated plan/wallet access returned `401`/`401`; aggregate-only verification found zero
  organizations, customers, invoices, wallets, wallet transactions, wallet targets, and outbox
  events plus 135 schedule audits. All three external-action flags remain disabled, with no route,
  secret, provider action, customer data, or billing/wallet data added.
- The event-targeted-wallet deployment applied only `0041_event_targeted_wallets.sql`; remote
  schema verification found 41 migrations, zero foreign-key violations, and the checked charge
  opt-in column plus partial active lookup index. Isolated Worker version
  `d08b6572-2af6-4b44-818e-a522d62b9864` retained only the existing workers.dev URL, `*/5` Cron,
  D1, R2, Queue/DLQ, Durable Object, Browser, and three Workflow bindings. The deployed bundle was
  759.99 KiB (133.53 KiB gzip) with a 6 ms startup. Health/readiness returned `200`/`200`;
  unauthenticated event/wallet access returned `401`/`401`; aggregate-only verification found zero
  organizations, customers, invoices, usage events, wallets, wallet targets, wallet transactions,
  and outbox events plus 140 schedule audits. All three external-action flags remain disabled, with
  no route, secret, provider action, customer data, or billing/wallet data added.
- The code-only standalone-charge lifecycle deployment required no D1 migration. It added
  optimistic core charge updates, no-op replay, trigger-backed draft invalidation, soft deletion,
  immutable finalized-line retention, and deterministic code generations after rename/deletion;
  filter, tax, pricing-unit, and child-plan cascades remain explicit guards. Isolated Worker version
  `07c31a20-04ea-46ea-bb2e-e3662f032ff7` retained only the existing workers.dev URL, `*/5` Cron,
  D1, R2, Queue/DLQ, Durable Object, Browser, and three Workflow bindings. The deployed bundle was
  768.14 KiB (134.49 KiB gzip) with a 5 ms startup. Health/readiness returned `200`/`200`, and
  unauthenticated charge access returned `401`. Remote verification found no pending migrations,
  zero foreign-key violations, and zero organizations, customers, plans, subscriptions, invoices,
  charges, usage events, wallets, wallet targets, wallet transactions, and outbox events plus 143
  schedule audits. All three external-action flags remain disabled, with no route, secret,
  provider action, customer data, or billing data added.
- The fixed-charge lifecycle deployment applied only `0042_fixed_charge_lifecycle.sql`; remote
  schema verification found 42 migrations, zero foreign-key violations, the checked `version` and
  `active` columns, and the active plan index. Standalone supported fixed charges now create,
  replay, update, and soft-delete with transactional versioned outbox events; attached plans retain
  the Lago-safe mutable subset, affected drafts invalidate, finalized lines remain immutable, and
  inactive rows no longer block add-on termination or enter future rating. The retained hard code
  uniqueness constraint returns an explicit guard for deleted-code reuse. Isolated Worker version
  `4bc789fe-9d60-4469-9187-56090ddab77e` retained only the existing workers.dev URL, `*/5` Cron,
  D1, R2, Queue/DLQ, Durable Object, Browser, and three Workflow bindings. The deployed bundle was
  780.89 KiB (136.02 KiB gzip) with a 5 ms startup. Health/readiness returned `200`/`200`, and
  unauthenticated fixed-charge access returned `401`. Aggregate-only verification found zero
  organizations, customers, plans, subscriptions, invoices, usage charges, fixed charges, usage
  events, wallets, wallet targets, wallet transactions, and outbox events plus 146 schedule audits.
  All three external-action flags remain disabled, with no route, secret, provider action, customer
  data, or billing data added.
- The billable-metric lifecycle deployment applied only `0043_billable_metric_lifecycle.sql`;
  remote schema verification found 43 migrations, zero foreign-key violations, the event tombstone
  column and three partial active-event indexes, plus durable cleanup and transaction-local mutation
  guard tables. Metric deletion atomically retires attached charges, invalidates drafts, hides
  retired events and wallet targets, and enqueues bounded five-minute D1/R2 cleanup. Finalized lines
  remain immutable, relational event history is retained, and deterministic generations permit
  same-code recreation without primary-key collisions. Isolated Worker version
  `487d002b-4eb1-4332-a2a1-676f9211141a` retained only the existing workers.dev URL, `*/5` Cron,
  D1, R2, Queue/DLQ, Durable Object, Browser, and three Workflow bindings. The deployed bundle was
  789.20 KiB (137.19 KiB gzip) with a 5 ms startup. Health/readiness returned `200`/`200`, and
  unauthenticated metric deletion returned `401`. Aggregate-only verification found zero
  organizations, customers, plans, subscriptions, invoices, billable metrics, usage charges, fixed
  charges, usage events, wallets, wallet targets, wallet transactions, outbox events, cleanup tasks,
  and mutation guards plus 151 schedule audits. All three external-action flags remain disabled,
  with no route, secret, provider action, customer data, or billing data added.
- The standalone-plan lifecycle deployment applied only `0044_standalone_plan_lifecycle.sql`;
  remote schema verification found 44 migrations, zero foreign-key violations, and the empty
  transaction-local plan mutation-guard table. Unused plan deletion atomically retires active
  usage/fixed charges, retains commitments and relational catalog history, and writes exactly one
  versioned outbox event. Plan and metric recreation now allocate monotonic code-scoped versions as
  well as new deterministic IDs, so repeated delete/recreate cycles cannot collide with historical
  unique constraints. Plans with any subscription history remain explicitly `plan_in_use` pending
  asynchronous termination/cancellation/draft-finalization parity. Isolated Worker version
  `b0a3bd59-f583-4a8c-82dc-84f1119c8b5a` retained only the existing workers.dev URL, `*/5` Cron,
  D1, R2, Queue/DLQ, Durable Object, Browser, and three Workflow bindings. The deployed bundle was
  794.38 KiB (138.01 KiB gzip) with a 7 ms startup. Health/readiness returned `200`/`200`, and
  unauthenticated plan deletion returned `401`. Aggregate-only verification found zero
  organizations, customers, plans, subscriptions, invoices, billable metrics, usage charges, fixed
  charges, usage events, wallets, outbox events, and plan guards plus 154 schedule audits. All three
  external-action flags remain disabled, with no route, secret, provider action, customer data, or
  billing data added.
- The code-only pay-in-advance commitment-termination deployment required no D1 migration. The
  prorated termination target now subtracts gross eligible plan, usage, and fixed-charge fees
  already invoiced in the same subscription period plus current termination fees; credit-note
  balances do not reduce that history, and exclusion of the current invoice keeps draft refresh
  stable. Direct termination evidence covers draft refresh/finalization, while the plan-deletion
  Workflow test terminates and retires a pay-in-advance committed plan. Isolated Worker version
  `927f7fb4-86f4-4803-8350-88f308d8fe8c` retained only the existing workers.dev URL, `*/5` Cron,
  D1, R2, Queue/DLQ, Durable Object, Browser, and four Workflow bindings. The deployed bundle was
  824.06 KiB (143.24 KiB gzip) with a 5 ms startup. Health/readiness returned `200`/`200`, and
  unauthenticated subscription deletion returned `401`. Remote verification found no pending
  migrations and zero organizations, customers, plans, subscriptions, invoices, and plan-deletion
  tasks plus 163 schedule audits. All three external-action flags remain disabled, with no route,
  secret, provider action, customer data, or billing data added.
- The code-only usage-expression deployment required no D1 migration. It replaces the pinned
  `lago-expression` Rust extension with a bounded TypeScript parser/evaluator for exact decimals,
  arithmetic precedence, event attributes, and the six legacy functions. It uses no dynamic
  evaluation, Wasm, native extension, or subprocess; derived properties enter replay hashing, D1,
  and immutable R2 evidence before aggregation. Isolated Worker version
  `3b8d7c0d-c893-4cec-b3a2-4c9c1594697a` retained only the existing workers.dev URL, `*/5` Cron,
  D1, R2, Queue/DLQ, Durable Object, Browser, and four Workflow bindings. The deployed bundle was
  838.46 KiB (146.34 KiB gzip) with a 6 ms startup. Health/readiness returned `200`/`200`, and
  unauthenticated expression evaluation returned `401`. Remote verification found no pending
  migrations and zero organizations, customers, plans, subscriptions, invoices, and usage events
  plus 169 schedule audits. All three external-action flags remain disabled, with no route, secret,
  provider action, customer data, or billing data added.
- The code-only billable-metric rounding deployment required no D1 migration. Optional
  `round`/`ceil`/`floor` configuration now transforms aggregate units before both current-usage and
  recurring-invoice rating, with zero-default and negative precision. Isolated Worker version
  `fad8d3ba-963a-4281-ba4c-aa146590a591` retained only the existing workers.dev URL, `*/5` Cron,
  D1, R2, Queue/DLQ, Durable Object, Browser, and four Workflow bindings. The deployed bundle was
  840.81 KiB (146.78 KiB gzip) with a 5 ms startup. Health/readiness returned `200`/`200`, and
  unauthenticated metric creation returned `401`. Remote verification found no pending migrations
  and zero organizations, customers, plans, subscriptions, invoices, and usage events plus 171
  schedule audits. All three external-action flags remain disabled, with no route, secret,
  provider action, customer data, or billing data added.
- The pay-in-advance fixed-charge deployment applied only
  `0051_pay_in_advance_fixed_charges.sql`. Remote schema verification found the widened checked
  timing field, all three immediate-billing/repair columns, the pending-repair index, all eight
  restored fixed-charge triggers, zero foreign-key violations, and no remaining migration. Worker
  version `58bf3a55-d194-4762-a390-a6794c360194` retained only the existing workers.dev URL,
  `*/5` Cron, D1, R2, Queue/DLQ, Durable Object, Browser, and four Workflow bindings. The deployed
  bundle was 1015.84 KiB (175.71 KiB gzip) with a 5 ms startup. Health/readiness returned
  `200`/`200`, and unauthenticated fixed-charge access returned `401`. Aggregate-only verification
  found zero organizations, customers, plans, subscriptions, invoices, fixed charges,
  fixed-charge unit events, usage events, wallets, outbox rows, and plan-deletion tasks plus 246
  schedule audits. All three external-action flags remain `0`; no resource provisioning,
  production route/domain, secret, provider action, customer data, or billing row changed.
- The pay-in-advance usage deployment applied only
  `0052_pay_in_advance_usage_charges.sql`. Remote schema verification found the 15-column strict
  event/charge billing ledger, four indexes, 52 total migrations, zero foreign-key violations, and
  no remaining migration. Worker version `b201ce1f-43dd-4097-bfbf-491e448b8fb3` retained only the
  existing workers.dev URL, `*/5` Cron, D1, R2, Queue/DLQ, Durable Object, Browser, and four
  Workflow bindings. The deployed bundle was 1036.03 KiB (179.42 KiB gzip) with a 6 ms startup.
  Health/readiness returned `200`/`200`, and unauthenticated charge access returned `401`.
  Aggregate-only verification found zero organizations, customers, plans, subscriptions, invoices,
  billable metrics, usage charges, fixed charges, usage events, advance-usage billings, wallets,
  outbox rows, and plan-deletion tasks plus 254 schedule audits. All three external-action flags
  remain `0`; no resource provisioning, production route/domain, secret, provider action, customer
  data, or billing row changed.
- The lifetime-usage deployment applied only `0053_lifetime_usage_projection.sql`. Remote schema
  verification found 53 migrations, 13 lifetime columns, 10 subscription-activity columns, four
  lifetime indexes, the subscription event-date column, zero projection rows, zero foreign-key
  violations, and no remaining migration. Worker version
  `93d81d34-d6b3-4c1e-99d0-33d7d11cfa4a` retained the existing workers.dev URL, D1, R2,
  Queue/DLQ, Durable Object, Browser, and four Workflow bindings while changing Cron from `*/5` to
  `* * * * *`. The deployed bundle was 1053.62 KiB (182.24 KiB gzip) with a 5 ms startup.
  Health/readiness returned `200`/`200`, and unauthenticated lifetime-usage access returned `401`.
  Aggregate-only verification found zero organizations, customers, subscriptions, invoices, usage
  events, lifetime usages, subscription activities, and outbox rows plus 270 schedule audits. All
  three external-action flags remain `0`; no resource provisioning, production route/domain,
  secret, provider action, customer data, or billing row changed.
- The usage-loop disposition was code-only. Worker version
  `e954f939-9d91-4459-b71f-df3a5dd2aa75` retained the existing workers.dev URL, one-minute Cron,
  D1, R2, Queue/DLQ, Durable Object, Browser, and four Workflow bindings. The deployed bundle was
  1053.82 KiB (182.27 KiB gzip) with a 5 ms startup. Health/readiness returned `200`/`200`.
  Aggregate-only verification found zero organizations, subscriptions, usage events, lifetime
  usages, subscription activities, and outbox rows plus 277 schedule audits, with zero foreign-key
  violations and no pending migration. All three external-action flags remain `0`; no resource
  provisioning, production route/domain, secret, provider action, customer data, or billing row
  changed.
- The progressive-usage deployment applied only `0055_progressive_usage_thresholds.sql`. Remote
  schema verification found 55 migrations, 11 threshold columns, 10 progressive-marker columns,
  seven applied-threshold columns, 16 relevant indexes, zero foreign-key violations, and no
  remaining migration. Worker version `281964e8-37a4-4e11-b555-91f941a797cd` retained the existing
  workers.dev URL, one-minute Cron, D1, R2, Queue/DLQ, Durable Object, Browser, and four Workflow
  bindings. The deployed bundle was 1130.41 KiB (196.38 KiB gzip) with a 5 ms startup.
  Health/readiness returned `200`/`200`, and unauthenticated plan access returned `401`.
  Aggregate-only verification found zero organizations, customers, plans, subscriptions, invoices,
  usage thresholds, progressive invoices/credits, applied thresholds, credit notes, and outbox rows
  plus 374 schedule runs. All three external-action flags remain `0`; no production route/domain,
  secret, provider action, customer data, payment action, or billing ledger row changed.
- The API-key usage deployment applied only `0056_api_key_usage_tracking.sql`. Remote schema
  verification found 56 migrations, seven API-key columns, the last-use index, zero foreign-key
  violations, and no remaining migration. Worker version
  `693a3713-3878-488a-ae1e-da5865c02f10` retained the existing workers.dev URL, one-minute Cron,
  D1, R2, Queue/DLQ, Durable Object, Browser, and four Workflow bindings. The deployed bundle was
  1131.03 KiB (196.54 KiB gzip) with a 5 ms startup. Health/readiness returned `200`/`200`, and
  unauthenticated plan access returned `401`. Aggregate-only verification found zero organizations,
  API keys, customers, subscriptions, invoices, usage thresholds, and outbox rows plus 385 schedule
  runs. All three external-action flags remain `0`; no production route/domain, secret, provider
  action, customer data, payment action, or billing ledger row changed.
- The termination-alert deployment was code-only with no pending migration. Worker version
  `37eda23e-2150-44be-874c-aca20ddee58e` retained the existing workers.dev URL, one-minute Cron,
  D1, R2, Queue/DLQ, Durable Object, Browser, and four Workflow bindings. The deployed bundle was
  1133.38 KiB (196.95 KiB gzip) with a 6 ms startup. Health/readiness returned `200`/`200`, and
  unauthenticated plan access returned `401`. Aggregate-only verification found zero organizations,
  subscriptions, invoices, and outbox rows plus 396 schedule runs, with zero foreign-key
  violations. All three external-action flags remain `0`; no customer message, production
  route/domain, secret, provider action, customer data, payment action, or billing row changed.
- The stuck-generating-invoice recovery consolidation was code-only with no pending migration.
  Worker version `6ef7eaf2-897a-4e7c-a5b5-ababc064d0a7` retained the existing workers.dev URL,
  one-minute Cron, D1, R2, Queue/DLQ, Durable Object, Browser, and four Workflow bindings. The dry-
  run bundle was 1133.43 KiB (196.96 KiB gzip). Version inspection found the expected fetch,
  scheduled, and queue handlers, and confirmed all three external-action flags remain `0`.
  Health/readiness returned `200`/`200`, unauthenticated plan access returned `401`, and aggregate-
  only verification found zero organizations, subscriptions, invoices, billing cycles, and outbox
  rows plus 405 schedule runs, with zero foreign-key violations. No production route/domain,
  secret, provider action, customer data, payment action, or billing row changed.
- The payment-request deployment applied only `0057_payment_requests.sql`. Its first remote attempt
  failed atomically with Cloudflare error `7500`; the migration remained pending and created no
  table. After converting the equivalent guards to the repository's remote-proven trigger-level
  `WHEN NOT EXISTS` form, verification found 57 migrations, two request tables, nine relevant
  indexes, two triggers, empty request/link ledgers, zero foreign-key violations, and no remaining
  migration. Worker version `95137700-dbf8-4f20-98cb-c7a399ca9cd2` retained the existing workers.dev
  URL, one-minute Cron, D1, R2, Queue/DLQ, Durable Object, Browser, and four Workflow bindings. The
  deployed bundle was 1147.23 KiB (200.28 KiB gzip) with a 6 ms startup. Health/readiness returned
  `200`/`200`, unauthenticated payment-request access returned `401`, and aggregate-only
  verification found zero organizations, customers, subscriptions, invoices, payment attempts,
  payment requests, invoice links, and outbox rows plus 436 schedule runs. All three external-
  action flags remain `0`; no production route/domain, secret, provider action, customer data,
  payment action, or billing row changed.
- The dunning-foundation deployment applied only `0058_dunning_campaigns.sql`. Remote verification
  found 58 migrations, three dunning tables, ten related indexes, seven triggers, all expected
  organization/customer/payment-request columns, empty dunning ledgers, zero foreign-key
  violations, and no remaining migration. Worker version
  `04e1efea-8ca6-4b7b-b8a9-cfa72816326d` retained the existing workers.dev URL, one-minute Cron,
  D1, R2, Queue/DLQ, Durable Object, Browser, and four Workflow bindings. The deployed bundle was
  1186.95 KiB (206.42 KiB gzip) with a 6 ms startup. Health/readiness returned `200`/`200`,
  unauthenticated dunning access returned `401`, and aggregate-only verification found zero
  organizations, customers, subscriptions, invoices, payment attempts, payment requests, invoice
  links, dunning campaigns/thresholds/guards, and outbox rows plus 469 schedule audits. Version
  inspection confirmed only the expected fetch, scheduled, and queue handlers and all three
  external-action flags at `0`; no production route/domain, secret, customer message, provider
  action, customer data, payment action, or billing row changed.
- The dunning-eligibility correction applied only forward migration
  `0059_invoice_payment_processing_state.sql`. Remote verification found 59 migrations, the invoice
  readiness column and eligible-invoice index, both replacement late-write guards, zero foreign-key
  violations, and no remaining migration. Worker version
  `6fa02bbf-9342-4908-8268-6b8c02a7a9d7` retained the existing workers.dev URL, one-minute Cron,
  D1, R2, Queue/DLQ, Durable Object, Browser, and four Workflow bindings. The deployed bundle was
  1187.41 KiB (206.51 KiB gzip) with a 5 ms startup. Health/readiness returned `200`/`200`,
  unauthenticated dunning access returned `401`, and aggregate-only verification found zero
  organizations, customers, invoices, payment attempts, payment requests, dunning campaigns/
  guards, and outbox rows plus 484 schedule audits. Version inspection confirmed only the expected
  fetch, scheduled, and queue handlers and all three external-action flags at `0`; no production
  route/domain, secret, customer message, provider action, customer data, payment action, or
  billing row changed.
- The failed-tax-invoice schedule consolidation was code-only with no pending migration. The first
  read-only migration-list preflight received transient OAuth error `10000`; the D1 audit succeeded
  and an immediate list retry confirmed no pending migration. Worker version
  `07654b79-8774-4de2-988b-b7323f86ebba` retained the existing workers.dev URL, one-minute Cron,
  D1, R2, Queue/DLQ, Durable Object, Browser, and four Workflow bindings. The deployed bundle was
  1187.64 KiB (206.59 KiB gzip) with a 5 ms startup. Health/readiness returned `200`/`200`, and
  aggregate-only verification found zero organizations, customers, invoices, payment requests,
  dunning campaigns, and outbox rows plus 494 schedule audits. Version inspection confirmed only
  the expected fetch, scheduled, and queue handlers and all three external-action flags at `0`; no
  production route/domain, secret, customer message, provider action, customer data, payment
  action, or billing row changed.
- The payment-request reconciliation deployment applied only
  `0060_payment_request_payments.sql`. Remote verification found 60 migrations, all four request-
  payment/allocation/reconciliation-guard tables, the provider-webhook payable column, expected
  indexes/triggers, zero rows in every new ledger, zero foreign-key violations, and no remaining
  migration. Worker version `0601e495-d49b-4e9d-a118-0d36836f1cd4` retained the existing
  workers.dev URL, one-minute Cron, D1, R2, Queue/DLQ, Durable Object, Browser, and four Workflow
  bindings. The deployed bundle was 1206.42 KiB (209.38 KiB gzip) with a 5 ms startup.
  Health/readiness returned `200`/`200`, unauthenticated payment access returned `401`, and
  aggregate-only verification found zero organizations, customers, invoices, payment requests,
  request payments, allocations, reconciliation guards, and outbox rows plus 533 schedule audits.
  Version inspection confirmed only the expected fetch, scheduled, and queue handlers and all three
  external-action flags at `0`; no production route/domain, secret, customer message, provider
  action, customer data, or payment action occurred.
- The payment-request Checkout Workflow deployment applied only
  `0061_payment_request_checkout_intents.sql`. Remote verification found 61 migrations, the intent
  table, both indexes and both state/tenant guards, zero checkout intents, zero foreign-key
  violations, and no remaining migration. Worker version
  `2961998a-0351-4620-ab58-d2d8ffa786d1` retained the existing workers.dev URL, one-minute Cron,
  D1, R2, Queue/DLQ, Durable Object, Browser, and four Workflow bindings. The deployed bundle was
  1221.38 KiB (211.80 KiB gzip) with a 5 ms startup. Health/readiness returned `200`/`200`,
  unauthenticated payment-request access returned `401`, and aggregate-only verification found zero
  organizations, customers, invoices, payment requests, request payments, checkout intents, and
  outbox rows plus 558 schedule audits. Version inspection confirmed only the expected fetch,
  scheduled, and queue handlers and all three external-action flags at `0`; the checkout dispatcher
  therefore performed no provider call. No production route/domain, secret, customer message,
  provider action, customer data, or payment action occurred.
- Remote business state is limited to the documented `synthetic-e2e-20260815-001` tenant graph and
  revoked smoke-key/audit evidence. No production/customer data, active key, payment state,
  document artifact, provider secret, or customer message is present.

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
