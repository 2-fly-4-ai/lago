# Staging Tax Shadow Deployment

Date: 2026-08-31

## Deployment

- Worker: `serp-dev-lago-native`
- Version: `0b31a222-1ed1-4724-82a9-078ec67430d7`
- Source commit: `e108d02`
- Tax mode: `shadow`
- Benchmark provider: `stripe_test`
- EPD network mode: `gateway_test`
- EPD live mode allowed: `0`
- Health: HTTP 200, `status=ok`
- Readiness: HTTP 200, `status=ready`

No production Worker, route, database, secret, registration, or payment was changed.

## Staging D1

- Applied migration: `0101_local_indirect_tax_rules.sql`
- Pending migrations after apply: none
- Draft rule set: `priority-market-candidate-2026-08-31`, version 1
- Checksum: `1786f62cffe7f301d8f994dc9d4a5cc353a84229cba6d3986fdde41a98522605`
- Rules: 64
- Countries: 32
- Product tax codes: 2
- Active rule sets: 0
- Registration scopes: 0

The first remote import attempt failed and rolled back because the renderer included explicit SQL
transaction statements. Current Cloudflare D1 file imports are already transactional and reject
explicit `BEGIN TRANSACTION` and `COMMIT`. The renderer and its test were corrected, and the
subsequent 65-query import completed successfully.

Reference: <https://developers.cloudflare.com/d1/best-practices/import-export-data/>

## Checkout verification

The real staged product path was opened for Pornhub Downloader without entering customer or card
data and without submitting payment. The staging Store routed the product to Stripe Sandbox rather
than creating an EPD/Lago checkout. Consequently, the Worker was not given a fresh signed EPD
checkout token and no Lago shadow tax quote was created.

This is a Store routing/configuration blocker, not a Lago health, migration, or Worker deployment
failure. Resolving it requires a separately approved staging `store-new` change or configuration
update. The temporary Stripe Sandbox checkout was closed without submission.

## Follow-up

The staging Store router was subsequently corrected and now sends the selected product to
Lago/EPD. Shadow benchmarking and local D1 enforcement were completed afterward; see
`local-d1-tax-staging-enforcement-2026-08-31.md`. This section remains as the historical state at
the time of the shadow deployment, not the current staging result.
