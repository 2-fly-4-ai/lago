# Generic-plan delivery classification — 2026-09-06

Status: local reviewed metadata patch; not applied to a remote database.

## Contract

The 13 generic catalog variants are price buckets for eligible installed browser applications,
not delivery classifications. Monthly, yearly and one-time prices must not automatically become
different tax categories. The reviewed default for this catalog is prewritten downloaded software
for personal use (`txcd_10202000`). This is an engineering mapping for the described products, not
a claim that every jurisdiction taxes software identically.

Source catalog: `cloudflare/fixtures/store-generic-catalog-2026-09-05.json`, Store commit
`d01233ffdc9718ee7e89fe6250c6e163d4e41172`.
The public generated Store product content describes Skool Video Downloader and OnlyFans
Downloader as browser-local extensions. The generic 1-App product grants an eligible application
slot. SERP VPN describes a browser proxy-manager extension using the customer's proxy routes;
its name alone is not evidence of a separately supplied hosted VPN service.

The identifier's public definition is available in [Stripe's tax-code documentation](https://docs.stripe.com/tax/tax-codes?type=physical).
This lookup used public documentation, not a Stripe Tax calculation or account API.

## Exact coverage

| Generic base | Monthly | Yearly | One-time |
| --- | ---: | ---: | ---: |
| 1-App | $9 | $79 | $9 |
| App Plus | $17 | $149 | $17 |
| 1-App Plus | $27 | $239 | $27 |
| 1-App Premium | $37 | $329 | $37 |
| 1-App Lifetime | — | — | $99 |

No prices, supported purchase choices, billing intervals or product routing are changed.
The separate bundle variants are not included in this 13-plan review. A future hosted service,
mixed bundle, business-use product or physical delivery needs its own reviewed mapping; do not
infer a tax code from its price or cadence.

## Backfill and verification

`cloudflare/scripts/plan-tax-classifications.mjs` creates metadata-only SQL from the exact
catalog and classification manifest. It validates tenant identity, every expected active plan,
price, currency, cadence, pending-deletion status and compatible existing tax metadata before
updating anything. Existing conflicting classifications abort the whole batch. Replaying the
patch preserves all rows exactly. Unrelated metadata is retained.

Five migrated-D1 tests cover all 13 variants, exact replay, price/classification/inactive-plan
conflicts, incomplete reviews and absent tenants. Existing initial-checkout and renewal tests
verify explicit metadata and subscription-specific quote classification instead of interval-based
guessing. No remote metadata has been backfilled by these tests.

Apply the reviewed metadata to every plan actually used by the target environment before the
new strict-classification Worker is deployed. Bootstrap of future catalogs must explicitly run
the matching reviewed metadata step; the insert-only catalog generator alone is insufficient.
Do not weaken the missing/mixed-classification rejection to make a deployment pass.
