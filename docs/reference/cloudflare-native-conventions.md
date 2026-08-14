# Cloudflare-Native Billing Conventions and Invariants

Last verified: 2026-08-14

This document is normative for new code under `cloudflare/`. It freezes the representation,
concurrency, and replay rules that later Lago parity work must preserve. Where a legacy Rails
behavior has not yet been dispositioned, the feature inventory and executable parity evidence win;
this document does not silently redefine that behavior.

## Data conventions

### Money and decimal arithmetic

- Persist money as a signed SQLite `INTEGER` in the currency's minor unit. Public Lago-compatible
  fields use the `_amount_cents` shape even though the internal name is `_minor`.
- Accept only JavaScript safe integers at API boundaries. Amounts constrained to be non-negative
  must also have a D1 `CHECK` constraint; credits or adjustments that may be signed must say so in
  their schema and tests.
- Store currency as an uppercase ISO 4217 code and compare currency before combining amounts.
- Use `Decimal` for quantities, rates, proration, aggregation, and other intermediate arithmetic.
  It uses a `bigint` coefficient, a maximum scale of 100, and rounds exact halves away from zero.
  Do not use binary floating point for a monetary calculation.
- Snapshot quantity, unit amount, taxable base, tax rate, and computed amount on invoice lines or
  tax rows. Re-reading a mutable plan, charge, tax, coupon, or wallet must not change an issued
  invoice.
- Enforce the invoice identity in D1:
  `total_due_minor = subtotal_minor + tax_minor - credits_minor`. Coupon, credit-note, and prepaid
  wallet components are non-negative explanations of `credits_minor`, not independent additions
  to the total.

### Time

- Store instants as UTC RFC 3339 strings produced by `Date#toISOString()`. Store event and Workflow
  trigger instants as integer Unix milliseconds only at the Cloudflare boundary, converting to UTC
  strings before persistence.
- Store calendar dates as `YYYY-MM-DD`. An invoice's `issuing_date` is an immutable commercial date;
  `finalized_at` is the later processing instant. Payment due date is issuing date plus the invoice's
  snapshotted non-negative net-payment term.
- Calculate billing periods using UTC calendar arithmetic. The five-minute Worker Cron is UTC and
  dispatches deterministic legacy schedule slots from its supplied scheduled time, not wall-clock
  invocation time.
- The retained future-start subset accepts an explicit instant, persists its normalized UTC value
  as `subscription_at`, creates no invoice while pending, and uses the supplied Workflow trigger
  instant for both activation and the initial billing-period anchor. Backdated starts and
  tenant-local civil-date interpretation remain unsupported.
- The retained termination-invoice subset uses UTC civil dates. Its in-arrears base line includes
  both the period-start date and termination date, caps the result at the full period, and uses
  exact `Decimal` division before minor-unit rounding. Usage remains half-open and is bounded by the
  start of the next UTC day, capped at the original period end. This is not tenant-local timezone
  parity. Supported non-prorated, pay-in-arrears fixed charges remain full on both immediate and
  scheduled termination, matching Lago's explicit non-prorated contract. In-arrears minimum-
  commitment targets use the same inclusive UTC coefficient, round to minor units before fee
  subtraction, and cover only the unsplit single-invoice window admitted by the catalog. A
  persisted `ending_at` uses this exact UTC subset and is executed by the hourly `:05` owner;
  customer-local dates require separate timezone evidence.
- Tenant-local time zones, daylight-saving behavior, and Rails time-zone parity are not implemented
  unless a feature's executable evidence says otherwise. A port that depends on local civil time
  must add the time-zone field, transition tests, and migration notes before it can be called parity.

### Identifiers

- Treat public IDs and external IDs as opaque strings. Every lookup supplied by a tenant must also
  be constrained by `organization_id`; authenticate before testing whether a resource exists.
- Preserve provider account, transaction, and event IDs exactly as received after bounded validation.
- Use random UUIDs for independent new resources. Use `deterministicUuid(namespace, canonicalInput)`
  only for replay-derived records whose logical identity is already fixed, such as an invoice line,
  billing cycle, outbox event, or idempotent mutation result. The namespace and complete canonical
  input are part of that contract and must have replay tests.
- Never derive an identifier from a secret, raw personal data, or an unordered JSON serialization.

### Pagination

- Page numbering is one-based. An omitted, invalid, zero, or negative `page` falls back to `1`.
- The general default `per_page` is `20`; a compatibility route may retain a fixture-proven default
  such as invoices' `100`. The maximum is always `100`.
- Return Lago-shaped metadata: `current_page`, `next_page`, `prev_page`, `total_pages`, and
  `total_count`. An empty result has `current_page = 0` and `total_pages = 0`.
- Count and page queries must share the same tenant-scoped predicate. Sort by a stable domain key
  and an ID tie-breaker, normally `created_at DESC, id DESC`.

### Errors and requests

- Every JSON response is `Cache-Control: no-store` and returns `X-Request-Id`. Errors have exactly
  `status`, `error`, `code`, `message`, and `request_id`.
- Use `400` for malformed JSON or request syntax, `401` for missing/invalid authentication, `403`
  for a known but forbidden operation, `404` for a tenant-scoped missing resource, `409` for replay
  hash or optimistic-version conflicts, `415` for non-JSON request bodies, `422` for semantically
  invalid or explicitly unsupported input, and `503` for a required dependency disabled by a
  safety gate or temporarily unavailable.
- Parse JSON only from `application/json`, bound request bodies to 256 KiB by default, validate
  nested object shape, and reject unsupported behavior explicitly rather than accepting inert data.
- Do not reveal cross-organization existence through status codes, messages, timing-sensitive
  follow-up reads, or provider errors.

### Idempotency and events

- Normalize a command, serialize it with recursively key-sorted `stableJson`, then hash it with
  SHA-256. Arrays retain order. The same logical identity and hash replays the stored result; the
  same identity with a different hash returns a conflict.
- Back every replay identity with a D1 primary key or unique index. A preflight lookup is an
  optimization, not the correctness mechanism; code must handle the concurrent unique conflict.
- Serialize customer-scoped commands that span multiple ledgers through the `BillingAccount`
  Durable Object. Its SQLite command reservation records command kind, request hash, status, and
  response. A reservation is not a substitute for D1 constraints or transactions.
- Mutate the aggregate, its immutable ledger rows, and its outbox event in one `D1Database.batch`.
  Updates use `WHERE version = ?` and increment version. A zero-row update is a conflict, not success.
- Outbox IDs are deterministic from event type, aggregate identity/version, and causation. Consumers
  deduplicate by `event_id`; provider calls and webhook delivery remain behind explicit kill switches.
- Any R2 operation that cannot share a D1 transaction uses a durable intent row. For deletion, write
  the cleanup task transactionally before deleting the object, then retry until both are absent.

## Aggregate boundaries and transaction proof

The following table defines the write owner. “Proof” names the mechanism that makes a crash,
concurrent request, or replay converge on one valid result.

| Aggregate                 | Write owner                                                          | Atomic D1 unit                                                                                  | Concurrency and replay proof                                                                              |
| ------------------------- | -------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| Organization and API keys | authenticated admin/bootstrap boundary                               | organization and key rows                                                                       | unique external ID/key hash; all child reads require organization scope                                   |
| Customer billing account  | `BillingAccount` Durable Object plus customer API                    | customer version and outbox                                                                     | per-customer command reservation; unique external ID; optimistic version; replay hash                     |
| Plan catalog              | plan, charge, fixed-charge, add-on, metric, and tax APIs             | one catalog mutation and outbox                                                                 | tenant/code/version uniqueness; attached-plan restrictions; optimistic version                            |
| Subscription              | compatibility API and lifecycle API                                  | subscription state transition, billing-cycle seed, initial/final invoice event rows, and outbox | unique tenant external ID; request hash; customer DO reservation; transition/version guards               |
| Usage event               | metered-usage API                                                    | one event/outbox or an atomic batch; R2 archives are content-addressed                          | tenant transaction ID uniqueness; canonical request hash; replay/conflict and batch rollback tests        |
| Billing cycle             | `closeBillingPeriod`                                                 | cycle lease/result, invoice graph, credits, next period, and outbox                             | deterministic cycle key; cycle request hash; customer DO reservation; D1 batch; version predicates        |
| Invoice                   | one-off, billing-cycle, refresh/finalize, void, and payment services | invoice header/version, lines/taxes/credits, linked ledgers, and outbox                         | immutable source IDs; line uniqueness; total `CHECK`; optimistic version; deterministic event IDs         |
| Coupon application        | coupon ledger and invoice credit service                             | coupon/application version, credit row, invoice credit total, and outbox                        | unique application/reuse slot; request hash; DO reservation; optimistic version                           |
| Wallet                    | wallet ledger and invoice wallet-credit service                      | wallet version/balance, transaction lots/consumption, invoice credit, and outbox                | current-version and available-lot triggers; unique idempotency and invoice-wallet rows; D1 batch          |
| Credit note               | credit-note ledger and credit consumption service                    | note balance/version, consumption, invoice credit, and outbox                                   | required idempotency key/hash; balance/version predicate; unique consumption source                       |
| Payment                   | payment ledger and provider reconciliation                           | attempt/version, invoice payment projection/link invalidation, and outbox                       | tenant idempotency uniqueness; provider transaction uniqueness; terminal-state/version guards             |
| Webhook receipt           | provider webhook handler and reconciliation Workflow                 | receipt/process state; archive/cleanup intent where applicable                                  | provider event uniqueness plus payload hash; R2 object key; processed-message and cleanup replay guards   |
| Outbound webhook          | endpoint API and reconciliation Workflow                             | endpoint/delivery state and attempt projection                                                  | endpoint/event uniqueness; deterministic payload/event; versioned endpoint; kill switch and bounded retry |
| Schedule run              | five-minute dispatcher and reconciliation Workflow                   | slot audit and each executor's own aggregate batch                                              | deterministic slot/instance ID; unique run ID; due-but-unported work recorded as partial                  |
| Document artifact         | document Workflow                                                    | artifact status keyed by aggregate version                                                      | unique resource/type/version; immutable R2 key/hash; retries reuse ready artifact                         |

Required evidence for a new aggregate or a boundary change:

1. A D1 primary key, foreign key, `CHECK`, unique index, trigger, or version predicate that rejects
   the invalid state under concurrency.
2. A single D1 batch containing the state transition and outbox event, with a test proving failure
   leaves neither committed.
3. A duplicate replay test and a same-key/different-body conflict test for externally retried writes.
4. A tenant-isolation test and, for R2/provider/Queue/Workflow work, a crash or retry test.
5. A migration and rollback/cutover note when persisted identity or accounting semantics change.

## Known gaps that constrain later work

- Refreshable initial and renewal drafts rebuild non-consuming previews and allocate coupons,
  credit notes, and wallet lots only while finalizing. Supported subscription, plan/rating, coupon,
  tax, credit-note, wallet, and usage mutations flag affected drafts through D1 triggers.
  Explicit skip-invoice/skip-credit termination keeps an existing draft refreshable from its
  immutable context. Final termination invoices currently cover zero-grace in-arrears plans using
  explicit UTC civil-day semantics, full supported non-prorated fixed charges, and a prorated
  minimum-commitment target for the catalog's unsplit billing window. Those plans may also persist a
  future UTC `ending_at`, which the hourly owner executes before billing close.
  Credit-only pay-in-advance termination may issue an unused-period balance against a finalized base
  line only when the source invoice has no coupon, tax, wallet, or prior credit-note allocation.
  The default combined mode creates that unused-period note before finalizing bounded in-arrears
  usage, applies the new credit before wallet lots, never repeats the prepaid base line, and commits
  both ledgers plus the subscription transition and ordered outbox evidence in one D1 batch. A
  separate mode may skip credit creation. Positive-grace termination drafts, tenant-local
  termination dates, prorated or pay-in-advance fixed charges, split-window or pay-in-advance
  commitment reconciliation, allocated-source adjustments, refunds, and offsets still need
  explicit lifecycle rules.
- A base subscription creates an initial invoice only when its plan snapshots
  `pay_in_advance = 1`; in-arrears starts seed the billing period without an invoice. Recurring
  pay-in-advance base lines snapshot the next period, while in-arrears base lines, usage, fixed
  charges, and commitments snapshot the period being closed.
- Tenant-local billing time zones and daylight-saving transitions are not yet parity-proven.
- Provider reads, payment mutations, and outbound webhook delivery are implemented only behind
  disabled safety gates in the isolated stack.
- Advanced tax providers, multi-provider payment behavior, refunds, and several document families
  remain explicitly unsupported or incomplete in the generated feature inventory.
