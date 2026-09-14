# Historical payment review display

## Scope

Separate historically reviewed EPD unknown outcomes from actionable operator diagnostics. Keep all rows visible and retain original financial statuses. No retry authorization, payment mutation, or collected-revenue adjustment.

Structured invoice metadata must match tenant, execution, checkpoint, attempt count and failure code; a provider transaction or payment-ledger record invalidates the reviewed presentation. Invalid metadata is ignored.

## Validation

- Full local regression suite: 1,249 tests across 107 files passed.
- Focused operator observability/assets/analytics: 19 passed.
- Typecheck, lint, formatting and diff whitespace checks passed.
- Production operator dry-run succeeded with existing configuration.
- Production read-only predicate verification recognized eight reviewed unknown outcomes, retaining their unknown status.

## Approved operator-only release

User approved production dashboard deployment on 2026-09-14. Target: `serp-prod-lago-operator`; existing production D1 binding unchanged. Do not deploy native billing or Store. No migration required.

Pre-release operator version / rollback target: `6996e85b-f995-4509-a83e-6f80aef992ab`. Live version bindings checked against configuration; preserve variables with `--keep-vars`. Existing refund mode is unchanged by this release.

Deployment command: `npx wrangler deploy --config wrangler.operator-production.jsonc --env-file /dev/null --keep-vars --message "Historical payment review display; no financial behavior changes"` from `cloudflare/`.

After deployment, verify the active version, unchanged bindings, authenticated review summary and continued row visibility. Record deployed version and verification in the operational closeout evidence. Rollback is operator-only to the version above if the release fails verification; do not revert financial data.
