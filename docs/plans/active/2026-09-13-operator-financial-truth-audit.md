# Operator financial truth and lifecycle audit

## Scope and safety

User requested a deeper review and correction of confirmed Lago defects after
production analytics counted unpaid checkout invoices as revenue. Root owns the
Cloudflare native API and operator app. Do not change api/front gitlinks, payment
credentials, production data, enabled collection settings, or deployments here.
Use synthetic local regressions. Independent reviewers inspect ledger identity
and renewal/reconciliation boundaries. No charge, refund, or webhook replay.

## Acceptance and work queue

- Trace payment identity across checkout, request settlements and provider events.
- Review initial-payment eligibility, one-time exclusion, cancellation and unknowns.
- Correct invoice versus collected-payment semantics and one-time classification.
- Prevent multi-charge usage rollups multiplying snapshot totals.
- Separate current list-price run rate from historical/discount-adjusted MRR.
- Define paid/refund/credit, timezone, internal verification and currency semantics
  before introducing a replacement cash dashboard; do not guess or delete records.
- Reproduce fixes in D1-backed tests and run the regression suite.
- Record confirmed findings separately from provider outcomes needing read-only
  reconciliation. Eight previously observed unknown outcomes are not permission
  to reissue any charge.

## First-pass results

Local calculation fixes: one-time stream/count classification and multi-charge
usage summation. UI/API disclose invoice-value and list-price run-rate limitations.
Full 1,192-test suite passed; final focused 24-test operator suite passed.

Independent review confirms the production operator is stale (August 21), predating
the August 26 ledger mirror suppression. Native-only rollout did not update that
separate bundle. Additional P1 work is required for unpaid Store-checkout first
billing-boundary eligibility and actionable review of expired unknown executions.
See `docs/evidence/operator-financial-truth-audit-2026-09-13.md` for boundaries,
verified protections and exact remaining work. Do not mark this plan complete.

## Implementation pass (September 13)

- Added checkout-origin prepayment eligibility in both period selection and a
  transaction-local close assertion. Migration 0127 creates only an assertion
  table; it does not alter historical invoices. The assertion is removed within
  the successful batch. Cancellation races roll back invoice/credit/outbox writes.
- Added recorded successful payments and confirmed refunds separately from invoice
  face value. The canonical payment listing removes intentional mirror rows.
  Currency totals are separate. UTC record dates are not bank settlement dates;
  internal live purchases remain included, never silently discarded by email.
- Added a redacted, read-only held-execution review endpoint and Payments panel.
  Refresh is read-only; unavailable diagnostics are not shown as zero issues.
- Export/retry/checkout/credit balance calculations now preserve shared ledger
  identity. A different transaction on an already paid request is quarantined.
- Legacy checkout-origin proof now includes initial invoice/request/EPD intent
  links, not only the newer product attribution table. Read-only production counts
  and synthetic regression established why both are necessary.
- Period-close assertions now also fence the current subscription and plan versions
  and the exact selected pending downgrade (or its absence). Tests inject schedule,
  cancellation and price-change races and verify no financial batch is committed.
- Forecasts now use complete UTC months and retain zero-activity months. They are
  explicitly invoice-value illustrations, not cash forecasts or historical MRR.
- Browser preview verified analytics cards, held-execution display and refresh
  with synthetic fixtures. This is not a staging or production verification.

### Release ordering still required

1. Full native/operator gate passed 1,220 tests in 106 files, plus all dry-run
   builds. Independent lifecycle, refund-allocation and diagnostics reviews were
   performed. Preserve the reviewed patch and evidence before release.
2. Review additive migration 0127 and apply it before the new native billing bundle.
3. Release native and operator from the same reviewed source revision. They are
   independent Workers; native deployment does not update operator SQL/assets.
4. Record both deployed version IDs. Read-only verify canonical payments, analytics
   and the review endpoint; compare aggregates, not customer-level exports.
5. Do not clear unknown outcomes, delete old invoices or backfill internal/test
   classifications during a software release. Those need specific evidence.

## Rollback and release

### Approved staging continuation

The user approved continuing to staging after the correction report. The reviewed
source was frozen at `39e95d9`. Only migration 0127 and the native billing Worker
were deployed to isolated SerpTEST; see
`docs/evidence/operator-financial-truth-staging-2026-09-13.md` for version IDs,
read-only verification. The user approved staging-admin alignment with SerpTEST
and the two admin invitations. Operator source `4126ca1` is deployed as
`3a184d9d-72f1-40d1-8955-ba913ef71470`; authenticated SerpTEST analytics and payment
review passed, and Farley's admin invitation was claimed. Devin's first sign-in
remains unverified; his admin invitation is pending. Shared
staging's additional policy/receipt migrations were deliberately not applied.
Production and all uncertain payment outcomes remain untouched.

Local changes can be reverted individually after review. Production remains at the
previously approved versions. A reviewed deployment is a separate action; preserve
historical financial evidence and established payment/renewal/refund controls.
