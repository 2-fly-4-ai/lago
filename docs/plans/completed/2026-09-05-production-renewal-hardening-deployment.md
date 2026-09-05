# Production Lago renewal hardening deployment

Opened: 2026-09-05
Completed: 2026-09-05

## Scope and approval

User approved production Lago deployment on 2026-09-05, explicitly excluding a production Store
deployment. Promote the completed staging renewal hardening from `f8464c1` (last code commit
`02a259f`), including the later fixes after the quoted `36d3f78` checkpoint.

Lago owns billing candidate selection, reconciliation, execution and rollout-scope schema.
Store owns product routing and prices. No Store files, routes, deployment, or secrets change.
Skool and OnlyFans are proposed next product canaries, not activated by this deployment.

## Deployment sequence

1. Verify clean branch, staging evidence, and full clean gate.
2. Record prior production Worker version and D1 Time Travel bookmark.
3. Apply pending migrations 0103–0106 before deploying the API Worker. These create automatic
   tax/execution and subscription-scope tables; 0104 deliberately does no backfill; 0105 only
   quarantines obvious placeholder references. Production preflight found zero matching profiles.
4. Deploy only `serp-prod-lago-native` with `wrangler.production.jsonc`, preserving secrets and
   dashboard variables. Keep automatic collection disabled and scope mode scoped. No operator,
   portal, Store, or auth deployment is required for this API hardening.
5. Verify deployed version, health, Access fail-closed, migrations, foreign keys, and zero
   enabled automatic collection scopes/executions. Do not manually trigger reconciliation,
   provider reads, charges, refunds, or purchase flows.

## Preflight

- Clean/pushed `codex/production-epd-canary` at `f8464c1`.
- Full `pnpm run check` passed again on the Mac mini's SSD via SSH.
- Staging version `baf75f95-b992-4fd2-a71e-d7e58b9ce7e5` and completed replay evidence are recorded
   in the completed staging hardening plan.
- Prior production API version: `d3e10488-68ff-449b-a93e-82d1a84ef4ab`.
- Production preflight: zero foreign-key violations, zero placeholder EPD profiles.
- Existing production tax and Stripe paths are disabled; retain that posture. New automatic
   collection stays disabled. Existing customer-initiated EPD checkout stays available.

## Rollback

Owner: Lago deployment operator in this task. Roll back only the API Worker to the recorded prior
version if code health fails. Leave additive schema and all financial evidence intact. A D1 restore
is a separate explicit decision because it can erase concurrent production writes; the bookmark
is recovery evidence, not permission to restore automatically.

## Completion evidence

- Deployed production API version: `7ac94d25-e0c8-4731-8b20-e9ef92bd13f0` at 100%,
  tag `renewal-hardening-20260905`, source `f8464c1` (code `02a259f`). Upload took 7.07s;
  trigger deployment took 4.57s. Only the native API Worker and its existing triggers changed.
- Pre-migration D1 bookmark:
  `000001d1-0000078c-000050dd-5263adb095620c5b1924ee2e5a85c9e4`.
- Migrations 0103–0106 applied successfully. Postflight: no pending migrations, zero foreign-key
  violations, zero enabled automatic-collection scopes, and zero automatic payment executions.
- Production health returned HTTP 200. Unauthenticated operator returned HTTP 302 to Access.
- Deployed-version inspection confirmed automatic collection disabled, scoped rollout mode,
  existing customer-initiated EPD production checkout preserved, and tax/Stripe network modes
  unchanged (disabled). No secrets were copied or changed.
- Full `pnpm run check` succeeded immediately before deployment: format, lint, Access tests,
  tax tests, inventories, generated types, TypeScript, Vitest, and all seven dry-run builds.
- Store worktree remained clean on `codex/epd-recurring-staging`. No Store files/deployment,
  product route switches, manual workflow triggers, or provider transaction submissions occurred.

## Next product rollout (deferred)

User requested Skool and OnlyFans as the next limited product rollout. The Store catalog contains
`skool-bulk-downloader`, `skool-video-downloader`, and `onlyfans-downloader`; confirm which Skool
product before activation. The inspected routing file still defaults to direct Stripe and has no
Skool/OnlyFans override. Existing Pornhub live routing remains unchanged.

Before routing new recurring purchases, separately review and approve the subscription collection
scope and tax readiness. This code deployment does not turn on automatic renewals or establish
production tax collection readiness. Preserve existing subscriptions' payment-provider ownership;
do not migrate existing Stripe subscriptions merely by changing new-checkout routing.
