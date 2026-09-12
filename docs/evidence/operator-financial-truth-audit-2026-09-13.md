# Operator financial truth audit — 2026-09-13

## Latest verified status

The correction audit finished locally. The subsequent isolated staging billing
deployment is recorded in [the staging receipt](operator-financial-truth-staging-2026-09-13.md).
Production is unchanged; paired operator verification is still pending.
Final `pnpm run check` passed: **106 test files / 1,220 tests**, including the
8 initial-payment eligibility cases and 3 period-close concurrency cases. The
gate also passed formatting, lint, Access, checkout UI, gateway contract fixtures,
inventory, tax checks, generated binding checks, TypeScript and all development/
production API, operator and portal dry-run builds. Root documentation harness
and `git diff --check` passed. Contract fixtures are not real provider transactions.

Validation log on the Mac mini: `/tmp/lago-financial-truth-release-gate.log`.
Source baseline was `0dbe70c` on `codex/dub-refund-summary`; the correction patch was
subsequently committed as `39e95d9`. A sorted path/content SHA-256 over the 26 changed/untracked
Cloudflare source files after the passing gate is
`9e79043718378fa4aec998ce544ec8caaef86fb36ddbabcdd0848e3628ee06e8`.
Documentation is excluded from that fingerprint.

Local browser preview verified the analytics labels/cards, held-execution panel
and read-only refresh using synthetic fixtures. Production reads were aggregate
SELECTs only. There was no deployment, D1 migration, charge, refund, retry, webhook
replay, test-data deletion or historical financial reclassification in the initial
audit pass. The later staging deployment is separately documented above.

### Remaining release and capability boundaries

- Apply additive migration 0127 before the native billing release, then deploy
  native and operator from the same reviewed revision. Record and verify both
  Worker version IDs; native deployment alone does not replace the old operator.
- Production verification of these new changes is still outstanding.
- Historical unknown provider outcomes remain unresolved; they require provider
  evidence, not expiry-based retries or fabricated failed/succeeded statuses.
- General multi-invoice provider refunds now fail explicitly before financial
  writes, but full allocation-aware refund execution is not implemented. This
  is separate from existing single-invoice Store refunds.
- Discount-adjusted historical MRR, processor/bank settlement accounting, and
  evidence-backed internal/test classification are not implemented by relabeling
  existing figures. The new report discloses those limits and keeps internal live
  purchases in recorded payment totals.

## Boundary

This is the SERP native Cloudflare operator implementation, not a claim about
upstream Lago. Source baseline: `0dbe70c`. No production mutation or deployment
was performed during this pass. Prior read-only observations are dated snapshots,
not a real-time settlement report. Synthetic tests do not prove live provider outcomes.

## Confirmed reporting defects and local corrections

1. `src/operator/analytics.ts` sums finalized invoice face value regardless of
   payment status. The operator called this Revenue. Labels now explicitly say
   invoiced value, including unpaid/failed checkouts and before refunds. This is
   containment, not implementation of a reconciled net-cash dashboard.
2. The stream query inferred recurring revenue from non-null subscription_id.
   One-time compatibility subscriptions therefore appeared recurring. It now
   checks the plan interval; only weekly/monthly/quarterly/yearly are recurring.
3. MRR amounts assigned zero to one-time plans, but counts still included them.
   Both headline and plan counts now restrict to recurring intervals.
4. Usage joined a daily snapshot to all its charges, then summed the snapshot's
   amount for every charge. A 300-minor-unit day split into 100 and 200 became
   600; a metric filter also returned the full snapshot rather than that metric.
   The query now sums charge deltas. Synthetic D1 tests verify 300 overall, 100
   and 200 by metric, zero for absent metrics and isolated organizations.
5. The current run-rate query does not use the report date range, discounts or
   paid-invoice evidence. UI/API now identify current list-price run rate with
   those limitations; it is not relabeled as verified MRR.
6. Forecast baseline previously used the last six non-empty monthly invoice
   buckets, potentially including an incomplete current month. It now uses six
   completed UTC months including zero-activity months, and displays twelve
   completed months. It remains an invoice-value illustration, not a cash forecast.

## Still requires implementation / verification

- Recorded payment/refund totals now use canonical succeeded ledger evidence.
  Processor settlement dates, fees and bank payouts are not represented; this is
  not a settlement-reconciled net-cash report.
- True MRR needs effective recurring prices/discounts and explicit paid/trial/
  past-due/cancel-at-period-end semantics. Historical MRR requires historical state.
- Internal verification should be explicitly tagged and filterable. Never infer
  an entire customer's financial history is synthetic from an email address alone.
- Unpaid initial checkouts and unknown provider outcomes now have distinct
  invoice breakdowns; a read-only execution panel exposes held failures. Expiration
  alone still does not establish a failed charge or authorize another attempt.
- Payment/refund currencies and UTC record-date basis are explicit and separate.
  Invoice and run-rate charts retain the selected organization currency.
- The previously observed eight unknown executions need provider read-only
  reconciliation, not a retry or deletion. A read-only source review cannot decide
  their actual financial outcomes.

## Independent lifecycle findings

- **Confirmed invoice-lifecycle defect:** checkout activates a pay-in-advance
  subscription while its initial invoice is pending. `dueBillingPeriodsForClosing`
  selects active/past-due recurring subscriptions by end date without initial
  payment gating. `closeBillingPeriod` then advances them and issues another
  invoice. Abandoned checkouts can therefore generate subsequent invoices.
  Remediation must target checkout-origin prepayment only, preserving ordinary
  postpaid billing, trials, free invoices and established paid subscriptions.
- **Charge/entitlement protections passed source review:** recurring selectors
  exclude one-time plans, automatic charging requires enrollment/profile evidence,
  and fulfillment requires current paid coverage. The unpaid-invoice defect is
  not evidence of unauthorized automatic charging or free entitlement grants.
- **Confirmed operator operability gap:** old unknown checkout executions can
  outlive the automatic recovery window without an operator execution-review
  screen. They can block account closure and invoice concurrency indefinitely.
  Add read-only evidence and explicit review outcomes; never resolve unknowns
  merely because their checkout URL expired.
- **Ledger mirror finding:** the independent production aggregate check found
  exact invoice-attempt/payment-request mirrors for 26 records, with no duplicate
  canonical provider/account/transaction groups in the current source query.
  Mirrors support invoice-anchored refunds and are intentional; do not delete them.
- **Confirmed release drift:** the production operator runs an August 21 build
  (active version prefix `e55e76c5`), whereas native runs September 12 version
  `6fc2f987-c1f3-4c3e-845c-1c0a905fef6e`. Mirror suppression landed August 26 in
  `8fa4db5`, after the operator build. The operator imports shared `listPayments`
  into its own bundle; deploying native does not update it. This explains the
  paired UI rows despite correct canonical source behavior. A reviewed operator
  release and cross-service revision evidence are required before trusting the UI.
- **Refund consistency:** the review found one succeeded provider refund ($4.50)
  with matching refund/financial evidence, no duplicate provider refund IDs or
  over-refunded charge. This is a dated aggregate observation, not blanket proof.
- **Unsupported general billing case:** a payment request spanning multiple
  invoices does not receive invoice-attempt mirrors, but provider-refund lookup
  requires those mirrors. Such a refund fails with payment-source-not-found.
  Current Store checkout is single-invoice; this is a separate Lago capability gap.

## Correction pass

The second independent review proved the invoice CSV also summed intentional
payment mirrors twice: a read-only production comparison found 22 affected paid
invoices and $444.30 of overstatement. This was reporting duplication, not proof
of duplicate charges. The CSV query now preserves provider/account/transaction
identity and only sums succeeded evidence. Distinct transactions arriving for an
already-succeeded payment request now raise an explicit reconciliation conflict
instead of being silently marked processed as a replay.

New local period-close tests cover pending/failed Store initial invoices, a paid
label without ledger evidence, exact paid proof and replay, zero invoices,
postpaid billing, trials, and cancellation between eligibility read and mutation.
The database assertion rolls the financial batch back on that race. No historical
invoices are removed and no payment is retried by this change.

The operator now separates recorded successful payment amounts, succeeded refunds,
and finalized invoice value. It also distinguishes initial unpaid checkouts and
unknown provider outcomes in invoice breakdowns. Payment dates are ledger record
creation dates and refund dates are succeeded-record update dates in UTC, not
processor settlement dates. Live internal/proof purchases remain in these totals.
No customer was automatically classified as a test customer from their email.

Held execution diagnostics show identifiers for the executions, age, checkpoint,
bounded diagnostic codes and review reasons without customer information or raw
provider payloads. Browser preview verification used synthetic data and exercised
the read-only refresh. Actual old unknown outcomes remain unresolved.

Historical discount-adjusted MRR, provider settlement accounting, and internal
purchase classification are not inferred from active subscription labels. The
current run-rate figure is explicitly list-price-only. General multi-invoice
refund support requires allocation-aware provider refund reservations; current
Store purchases use single-invoice requests.

The multi-invoice allocation path now counts succeeded allocated payment evidence
once for credit capacity and rechecks capacity inside the financial batch. A
requested provider refund without an invoice-anchored payment source returns
`payment_request_refund_unsupported` before creating a credit note or contacting
the provider. That is a guarded unsupported capability, not completed multi-invoice
refund support. Ordinary single-invoice Store refunds retain their existing path.

A final read-only production aggregate found 105 unpaid finalized initial invoices:
81 had product attribution but all 105 had EPD checkout-intent evidence. The guard
and reporting classification now recognize both origin proofs, covering the 24
legacy records without rewriting them. Synthetic regression verifies the legacy
case is excluded from period closing and shown as an unpaid checkout.

Independent final review found that cancellation-only fencing was insufficient:
scheduling or canceling a downgrade, or changing a plan price while period closing
was calculating, could otherwise commit an invoice for stale state. The close
assertion now checks current subscription/plan versions and the exact pending
downgrade state, with a guarded final subscription update. Three dedicated race
regressions verify no renewal invoice, closed cycle or financial outbox is committed
when that snapshot changes. The full financial batch rolls back.

The final diagnostics integration review also extended invoice classification to
unknown automatic-renewal executions, not only initial checkout executions. Both
now take `provider_review_required` precedence over overdue/outstanding/paid labels.
A migrated-D1 regression creates an automatic unknown execution linked to its
invoice and verifies that classification. Neither path retries or resolves it.

### Earlier verification baseline

Local full suite: 102 files / 1,192 tests passed after calculation and UI label
changes. Lint, TypeScript, formatting and root documentation harness passed.
Tests use synthetic Cloudflare D1 fixtures. No real charge, refund or webhook replay.
The subsequent forecast-methodology-only clarification is also covered by the
focused operator regression rerun. Production still has the old dashboard until a
separate reviewed deployment.

Independent lifecycle reviewer also passed 187 focused billing-cycle, automatic
collection, expired-cancellation, fulfillment-snapshot and invoice-fulfillment tests,
plus TypeScript. These tests do not cover the cross-service abandoned-checkout
first-boundary race described above. The audit is not complete and no blanket
production-readiness conclusion follows from the green suites.
