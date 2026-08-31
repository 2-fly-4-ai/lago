# EPD inline reconciliation production recovery — 2026-08-31

## Incident

A live Easy Pay Direct order returned `succeeded`, but the checkout handler returned `processing` and waited for the scheduled provider-read reconciliation. The observed provider-read fallback took about seven minutes, while the Store success page stopped polling after about 50 seconds. The payment settled, but the customer remained on “Finalizing your order” until the normal fulfillment action was replayed.

Affected Lago invoice: `58c3af8f-7b63-5d0e-b6b9-567ebc3aaac3`.

## Repair

- A Commerce order that returns `succeeded` is now reconciled before the checkout response is returned.
- The inline confirmation uses a deterministic receipt and the existing idempotent payment-request reconciler.
- A concurrent webhook/provider-read race converges on the already-succeeded payment request.
- If inline reconciliation fails, the receipt is closed with `inline_reconciliation_failed` and the existing scheduled provider-read path remains available.
- The Store polls Lago verification for up to roughly ten minutes instead of stopping before the fallback can converge.

No database migration, payment credential, tax configuration, route, product-routing, or provider-mode change was made.

## Verification

- Focused Lago EPD checkout suite: 8/8 passed.
- Store typecheck: passed.
- Store unit suite: 563 passed, 1 manual test skipped.
- Store production Worker build: passed.
- Lago lint, access tests, inventory checks, tax-rule checks, generated binding checks, typecheck, and production dry-run builds: passed.
- The broader Lago suite has seven pre-existing prepaid-credit failures across four unrelated test files; they reproduce in isolation and no prepaid-credit code changed in this repair.
- Staging health: Lago `ready`; Store health `ok`.
- Production health: Lago `ready`; Store health `ok`.
- Replaying the affected Store fulfillment action completed the checkout and created exactly one paid EPD live order for the intended Pornhub Downloader purchase.
- A second replay returned `Order already processed`; the production order count remained exactly one.

## Deployed versions

- Staging Lago: `7f225287-84aa-4be0-be8e-0925a37ec3cf`
- Staging Store: `bbefaf83-7b4f-4078-8b45-36ba9ec2f3da`
- Production Lago: `d3e10488-68ff-449b-a93e-82d1a84ef4ab`
- Production Store: `6f73cb85-67df-4b22-afd3-e2dc69453deb`

The generic adult plan retains `adult_strict_bind`; fulfillment records the intended product and the customer completes the existing product-binding step after checkout.
