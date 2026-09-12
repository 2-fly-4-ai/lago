# Production financial-truth release — 2026-09-13

## Authorization and scope

The user approved the proposed paired production billing/operator release with
“let's do it”. This release changes reporting, ledger mirror handling and
period-close eligibility/concurrency guards. It does not change Store deployment
or routing, prices, provider credentials, collection scopes or payment switches.
It does not resolve unknown outcomes, delete historical records, initiate a
purchase/refund, replay a webhook or manually run reconciliation.

## Frozen source and preflight

- Root source: `dc2da8f`, branch `codex/dub-refund-summary`, clean before release.
- Reviewed implementation: `39e95d9`; staging operator alignment: `4126ca1`.
- No source changes since the passing staging release gate: 1,220 Vitest tests in
  106 files, plus the Access/resource-binding gate, lint, formatting, types,
  inventories, checkout/gateway fixtures, tax checks and all dry-run builds.
- Production dry-run builds rerun successfully immediately before release.
- API/front gitlinks unchanged; no submodule deployment.
- Wrangler 4.123.0 command help checked before execution.
- Production native/operator deployed versions and bindings read before release;
  all configured variables matched existing live values.
- Database: `serp-prod-lago-native-d1`,
  `a0274eda-6f03-429a-896f-a1e0121a9f21`.
- Only pending migration was `0127_billing_period_close_fences.sql`.
- Pre-migration Time Travel bookmark:
  `000001f4-00000446-000050e4-0a26d60704f3c7dfe44d9f7d20d8d669`.
  Capturing this bookmark did not restore or export customer data.

## Executed release

1. Applied pending migration 0127 using production config. It creates an empty
   transaction-local assertion table; no historical financial data is changed.
2. Deployed native with production config, `--keep-vars`, tag
   `financial-truth-dc2da8f`.
3. Deployed operator with production operator config and the same source/tag,
   also preserving variables.

| Worker | Previous version | New version | UTC deployment |
| --- | --- | --- | --- |
| Native | `6fc2f987-c1f3-4c3e-845c-1c0a905fef6e` | `639eeb34-9da1-4ec2-802d-ac51a9ea5eb6` | 2026-09-12 14:26:12 |
| Operator | `e55e76c5-7e5f-4df9-b8e8-8681ee9d847d` | `6996e85b-f995-4509-a83e-6f80aef992ab` | 2026-09-12 14:26:26 |

Both versions were verified at 100%. Remote binding metadata compared equal
before/after for each Worker, including existing variables and secret bindings.
No credentials were rotated or submitted by this release.

## Verified results

Native health returned HTTP 200, status ok, environment production. The migration
journal contains 0127 exactly once, with no pending migrations, zero residual
guard rows and zero foreign-key violations.

Read-only queries using the checked-in canonical payment/report SQL returned the
same aggregates before and after deployment. The authenticated production browser
displayed the matching corrected analytics and invoice classifications.

| USD ledger metric | 2025-09-01 through 2026-09-12 UTC |
| --- | ---: |
| Succeeded payments | 452.80 (23 records) |
| Confirmed refunds | 4.50 (1 record) |
| Payments less refunds | 448.30 |
| Finalized invoice face value | 1,778.50 (130 invoices) |

For 2026-09-12 UTC alone, succeeded payment records totaled USD 343.80 across 13
records, with no confirmed refunds that day. These figures include internal live
proof purchases; they are neither externally classified customer-only sales nor
processor settlement, bank payout or profit.

- Canonical succeeded provider/account/transaction duplicate groups: zero.
- Held checkout executions: eight before and after; held renewals: zero.
- Finalized invoice status totals: 23 succeeded / USD 452.80; 102 pending /
  USD 1,207.30; five failed / USD 118.40.
- Browser collection classifications: 23 paid invoices / USD 452.80; eight
  provider-review invoices / USD 99.00; 99 unpaid checkouts / USD 1,226.70.
- The invoice-document tab also includes 11 voided/failed documents / USD 99.00,
  making its broader document total USD 1,877.50, not collected revenue.
- One-time invoice value now appears separately from recurring invoice value.
- The existing production admin session continued to work after reload.

These are actual production deployment, schema, aggregate read and authenticated
dashboard checks. No fresh provider-backed purchase or renewal was performed in
this release; the 1,220 regression tests are synthetic/local contract evidence.

## Remaining boundaries and rollback

The eight unknown checkout outcomes still require individual provider evidence.
They were preserved, not retried or converted into declines. General multi-invoice
provider refunds remain explicitly unsupported; this is distinct from existing
single-invoice Store refunds. Historical discount-adjusted MRR, bank settlement/
fees and explicit internal-purchase classification remain separate capabilities.

If rollback is necessary, the operator/user owns the decision. Restore the
recorded previous Worker versions after checking active operations; retain
additive migration 0127 and all financial evidence. A full database restore would
also discard intervening legitimate writes and is not a routine code rollback.

Deployment logs are retained only in ignored
`cloudflare/.wrangler/financial-truth-release/prod-*.log` on the Mac mini.

Dashboard: https://serp-prod-lago-operator.serpcompany.workers.dev/serp-billing/analytics
