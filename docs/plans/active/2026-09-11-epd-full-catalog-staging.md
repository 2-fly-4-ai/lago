# EPD Full-Catalog Staging Rollout

Status: active

The Store-owned companion plan is
`store-new/docs/plans/active/2026-09-11-epd-full-catalog-staging.md`.

## Lago scope

- Keep automatic collection in `product_scoped` mode.
- Add reviewed product policies for all 48 recurring products that can reach EPD in the Store
  staging catalog, including the 16 `Live Cams` products, JustForFans, OnlyFans, Bundle, and VPN.
- Do not authorize one-time products for renewal; the recurring query must continue requiring a
  weekly, monthly, quarterly, or yearly plan even if malformed historical rows exist.
- Preserve EPD idempotency, duplicate-submission, decline, retry, cancellation, refund,
  out-of-order webhook, reconciliation, and Slack behavior.
- Do not modify production D1 or deploy a production Worker under this plan.

## Verification and rollback

Run the full Cloudflare Lago gate and provider-backed full-test Gateway scenarios before staging is
declared ready. Apply new migrations to staging only. Rollback restores the previous staging Worker
version and disables the newly added product policies while preserving payment evidence.
