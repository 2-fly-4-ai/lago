# Cloudflare-Native Lago Isolated Acceptance

Date: 2026-08-23

Status: isolated development stack accepted; production authority cutover remains deferred

## Accepted revisions and deployments

- Lago branch: `codex/cloudflare-native-rewrite`
- Store consumer branch: `codex/lago-cloudflare-cutover`
- Development API Worker: `6684a2ee-fa56-49ac-9088-129bc1e17593`
- Development operator Worker: `92f04ee8-e33f-42dd-9060-17ca78711c74`
- Development customer-portal Worker: `6bfeedea-636d-4af4-bcf0-3e20573ab3a0`
- Staging Store Worker: `a796ae31-5007-44b2-99f5-5c973f544549`

The Store canary sends explicit checkout collection mode and immediate invoice terms. A synthetic
checkout completed the Store-to-Lago customer, subscription, invoice, payment-request, and hosted
Easy Pay Direct handoff and returned a signed sandbox payment URL. Stripe remains the Store
rollback path.

## Provider sandbox evidence

Easy Pay Direct Demo Company testing covered a successful order, exact replay, processor decline,
decline replay, invalid-signature fail-closed webhook handling, scheduled provider-read recovery,
and repeated no-op reconciliation after convergence. Migration `0093` removed the incorrect global
payment-token uniqueness constraint while preserving execution idempotency. The public sandbox does
not expose a safe void command; a provider-read contract test proves that a provider `voided` status
converges exactly once to a failed local payment outcome.

Stripe TEST testing covered a declined funding operation and exact replay with one failed provider
operation and no settled wallet transaction. A synthetic 100-minor-unit funding and refund then
completed once; exact refund replay returned the same credit note and provider refund. Temporary QA
API keys were revoked. No live card, live provider mode, customer record, or production billing data
was used.

The retained development connections are deliberately non-live. Final API safety bindings are:

- `PAYMENT_MUTATIONS_ENABLED=0`
- `CREDIT_NOTE_REFUND_MODE=disabled`
- `EASY_PAY_DIRECT_NETWORK_MODE=test`
- `EASY_PAY_DIRECT_LIVEMODE_ALLOWED=0`
- `PROVIDER_READS_ENABLED=1`
- `STRIPE_NETWORK_MODE=enabled`
- `STRIPE_WEBHOOKS_ENABLED=1`
- `STRIPE_LIVEMODE_ALLOWED=0`
- `OUTBOUND_WEBHOOKS_ENABLED=0`

## UI truth audit

All 29 top-level operator routes were loaded through the Access-authenticated development Worker and
checked after membership resolution. Analytics, forecasts, configuration, billing operations,
settings, integrations, developer tools, and the right-side assistant all rendered real tenant data
or an honest empty state. Unused vendors correctly report `Not configured`; configured Stripe and
Easy Pay Direct connections report `Connected` with writes paused by the safety gate.

The audit found one stale Payments-page sentence claiming Stripe network access was disabled. It was
replaced with provider-neutral safety-gate language, covered by the operator asset suite, deployed in
operator version `92f04ee8-e33f-42dd-9060-17ca78711c74`, and verified live. The app's screenshot
capture endpoint was unavailable during this pass, so the acceptance uses loaded DOM state together
with the existing checked-in visual-parity captures from 2026-08-18.

## Clean gate and remote invariants

- Formatting: pass
- Lint: pass with zero warnings
- Access provisioning tests: 5/5 pass
- Feature inventory: current
- Operator parity ledger: current, 503/503 operations and 159/159 routes eligible
- Wrangler-generated binding types: current
- TypeScript: pass
- Full serial Workers suite: 72 files, 400 tests pass
- Development and production API/operator/portal dry bundles: pass
- D1 migrations: none pending after `0092` and `0093`
- D1 `PRAGMA foreign_key_check`: empty
- API `/health`: 200
- API `/ready`: 200
- Unauthenticated API data: 401
- Unauthenticated operator: 302 to the configured Cloudflare Access application

## Deferred production rollout

This acceptance finishes the isolated Cloudflare-native build; it does not declare production Lago
authority. Read-only production shadow comparison, production migration and reconciliation,
production provider/DNS/secret activation, the `store-new` canary switch, two production billing
cycles, and legacy container retirement remain governed by
`docs/reference/cloudflare-native-cutover-plan.md`. `serp-auth` remains unchanged because it is the
entitlement authority and is not part of the endpoint switch.
