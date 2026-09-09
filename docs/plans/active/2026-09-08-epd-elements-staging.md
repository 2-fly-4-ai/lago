# EPD Elements staging migration

Status: active. Owner: Lago. Approved scope: staging only, 2026-09-08.

## Contract and ownership

- Lago checkout owns hosted Elements capture and immutable payment execution checkpoints.
- EPD Commerce owns card-token attachment, saved payment-method UUIDs and order processing.
- Lago owns billing periods and renewal scheduling; do not create a second Commerce subscription.
- Store retains checkout routing, product pricing and fulfillment contracts unchanged.
- Auth remains the entitlement authority. Existing Stripe and production paths are unchanged.

The documented capture flow is Elements `cct_` token → customer payment method UUID → order.
It does not depend on importing a Gateway billing ID. Existing Gateway profiles must retain their
backend identity. Never infer a backend from the shape of a saved identifier.

## Rollout order

1. Add isolated sandbox-only Commerce adapter with strict response and idempotency validation.
2. Add immutable backend discriminators and populated-upgrade regression coverage.
3. Wire Elements checkout and Lago-scheduled Commerce renewals; preserve legacy dispatch.
4. Run focused scenarios and complete regression gates, including lifecycle reconciliation.
5. Verify required staging publishable/secret keys belong to the same sandbox without exposing them.
6. Apply approved staging migrations and deploy staging only after gates pass.
7. Demonstrate browser capture, initial payment, saved-method renewal, one-time exclusion,
   declines, duplicate/interrupted submissions, fulfillment and notifications.
8. Record separate mocked, real sandbox and production evidence. Production is not authorized
   by this migration approval; request approval after staging readiness is established.

## Safety

Keep live mode disabled for Elements. Never send raw card data through Lago. Preserve unknown
financial outcomes for reconciliation; never replace an uncertain order with a new idempotency key.
Do not migrate existing saved profiles or charge historical periods automatically.

## Primary references

- https://docs.api.epd.com/guides/elements/
- https://docs.api.epd.com/recipes/one-time-payment/
- https://docs.api.epd.com/api-reference/payment-methods/

## Evidence

### Hosted renderer, 2026-09-08 (local only)

The renderer selects `commerce_elements` only with an explicit development/staging/test
`APP_ENV`, network mode `test` or `gateway_test`, and `EASY_PAY_DIRECT_LIVEMODE_ALLOWED=0`.
Unspecified checkout backend retains `gateway_vault`. `EASY_PAY_DIRECT_PUBLISHABLE_KEY`
must be a test publishable key, not a secret key. No configured values were changed.

The canonical `https://js.epd.com/element/v1/epd.js` SDK is loaded directly. Official
Elements documentation and the public SDK source were inspected: async `EPD(...)`,
split hosted fields, `createToken({number, expiration, cvc})`, and opaque `cct_` output.
The default SDK loads Basis Theory's `https://js.basistheory.com` hosted runtime;
CSP permits that exact script/frame host and `https://api.epd.com` API connections.
Telemetry is explicitly disabled. An account-specific custom Elements domain would
need separate verified CSP configuration; none is inferred or allowed by wildcard.
The mutable SDK channel currently has no documented pinned SRI release.

No raw card input is created or read by Lago. First/last names, email, phone and consent
are validated before capture. Tax, regional discount and summary rendering are shared
with the legacy form. Capture has a mutex and timeout, and a changed quote is rejected
before submission. The single-use token uses the existing `payment_token` envelope,
with `first_name`/`last_name` added only for Elements.

Local tests: 11 renderer/gating tests plus 46 existing provider tests passed; six
executed browser-controller tests use a deliberately mocked SDK. They exercise field
completion, consent/names, duplicate clicks, SDK failures/live-mode mismatch, token
shape, capture timeout, quote changes and failed server submission. These do not
prove real iframe loading, account configuration, browser CSP compatibility or a
provider transaction. Real sandbox evidence remains required before any readiness claim.

The initial checkout, hosted renderer, saved-method renewals and backend-aware refund code are
implemented locally. Sandbox verification remains pending. Prior legacy suite results are not
proof of this new path. See `docs/evidence/epd-follow-up-remediation-2026-09-08.md` for the preceding investigation.

### Integrated local gate

The complete `pnpm run check` passed on the Mini SSD on 2026-09-08 after the initial
checkout webhook consistency regression and refund fixture correction. It includes formatting,
lint, Access checks, browser-controller tests, inventory and tax checks, generated binding checks,
TypeScript, the complete Vitest suite and all seven development/production dry-run builds.
These are local checks, not deployments. Checkout/refund focused verification passed 71/71
(62 checkout and 9 immutable refund routing cases). The final independent-review follow-up for
late renewal success after a failure is implemented: only an authenticated exact-order success
can reopen read-only reconciliation, never a new charge. Its automatic collection suite passed
85/85, including 14 Commerce and 71 legacy cases; typecheck, formatting and lint passed.

Final frozen-code rerun: complete `pnpm run check` exited 0, with **905/905 Vitest tests
across 94 files** and all seven dry-run builds passing. Three independent reviewers covered
the provider contract/checkout, saved-method renewal/migration, and UI/refund/ingress paths.
Provider responses and browser SDK behavior in these tests are mocked; local D1 is exercised.

No staging or production deployment, remote migration, actual Elements transaction, entitlement
delivery or Slack delivery was performed for this migration. The provider setup blocker below
prevents an evidence-backed customer-journey readiness claim or production canary recommendation.

### Refund and webhook compatibility follow-up

Elements refund dispatch is chosen by the original immutable initial or automatic payment
execution, joined to its exact successful payment-request ledger row. It is not selected
by the current UI flag or an ID prefix. Missing/ambiguous Elements payment evidence is held.
The existing historical test-only legacy refund path is preserved; an unproven or Gateway
origin in `gateway_test` is never promoted to Commerce. Production refund behavior remains
unchanged. Elements transport uses the documented sandbox key without Gateway credentials,
and the refund transaction checkpoint is persisted before its confirmation read.

Signed sandbox webhook ingestion in `gateway_test` requires an explicit non-production app
environment and live mode disabled. It remains available after the checkout UI flag is
rolled back. Ingestion is not fulfillment proof: reconciliation still validates the exact
persisted execution. Automatic renewal receipt processing and its read-recovery coverage are
owned by the renewal/reconciliation reviewers, not established by these ingress tests.

## Provider setup observation

Read-only Commerce inspection on 2026-09-08, signed in as the authorized owner, showed only
TSMC, LLC in the company switcher and no publishable keys. The displayed API-key list was live
keys, including revoked entries; a historical key name containing “sandbox” is not sandbox proof.
Do not use those live credentials for this migration. EPD's documented Demo Company and matching
test publishable/secret keys must be available before real browser tokenization or sandbox charges.
No key was revealed, created, copied or changed during this inspection.
