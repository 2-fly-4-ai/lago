# Experimental fulfillment revision triggers — not deployable

This proposal is quarantined outside Cloudflare migrations and executable tests.
Do not enable it, apply its SQL remotely, or describe it as an operational Auth pipeline.

## Reproduced integration failure

The cursor triggers passed 24 isolated local-D1 mutation tests. However, running the
actual `closeBillingPeriod` plus payment-reconciliation regression in
`cloudflare/test/invoice-fulfillment.test.ts` failed with `billing_period_changed`.
The update had committed; the new trigger writes increased D1 `meta.changes`,
breaking `cloudflare/src/billing/close-period.ts:588`'s exact-one-row guard.

A read-only inventory found 102 `meta.changes` comparisons in `cloudflare/src`.
Examples of exact-count consumers include `billing/finalize-invoice.ts:115`,
`billing/pay-in-advance-termination-credit.ts:468`,
`api/payment-ledger.ts:291`, `api/easy-pay-direct-tax.ts:376`,
and `api/subscription-charge-filters.ts:870`. Not every comparison is affected,
but adopting this design requires a systematic compatibility review; do not weaken
checks from exactly one to merely positive.

## Preserved candidate

- The SQL contains monotonic per-subscription cursors and tenant-scoped mutation
  triggers, with indexed invoice/request/customer/plan lookups.
- Subscription deletion or identity retarget and organization deletion retire
  journal entries permanently. Opaque IDs deliberately have no parent foreign
  keys, avoiding new deletion restrictions while retaining historical revisions.
- External publication still requires a trusted deployment namespace: isolated
  production/staging databases may contain identical internal IDs.
- The `.test.ts.txt` preserves the candidate test suite without test discovery.
  The final additional request-allocation/link-removal case was added after the
  24-pass run and remains unverified.

No publisher, immutable source snapshot, refund-access policy, Store/Auth hook,
or deployment enablement was implemented. Reconsider the producer transaction
architecture before promoting any portion of this experiment into migrations.
