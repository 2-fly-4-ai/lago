# EPD production billing-ID repair

Opened: 2026-09-06
Status: active

## Incident and objective

The first production EPD canary reached the hosted Collect.js form and the Gateway Customer Vault,
then failed while Lago attached that vault record to EPD Commerce. Lago derived a 32-character
hexadecimal `billing_id`; the pinned EPD Commerce payment-method contract accepts a numeric Gateway
billing ID. The objective is to repair that boundary, prove safe recovery for interrupted
executions, and keep production exposure limited to one reviewed product.

## Ownership and rollout

- `store-new` owns product routing. Production Worker version
  `20ed8514-a66b-4257-b2e2-2c7ae6fefd7a` routes only `sprout-video-downloader` to Lago/EPD;
  Skool and OnlyFans returned to direct Stripe. Store commit: `be3b89d9a5a7`.
- Lago owns Gateway vault identifiers, EPD Commerce attachment, execution checkpoints, recovery,
  provider-read reconciliation, and customer-safe errors.
- EPD owns Collect.js tokens, Customer Vault records, Commerce payment methods, and financial
  outcomes.
- `serp-auth` remains the entitlement authority and is unchanged.

Rollout order:

1. Derive a deterministic numeric Gateway billing ID that is valid in both Gateway and Commerce.
2. Reject incompatible live IDs locally before a Commerce request.
3. On a fresh customer submission only, replace a legacy alphanumeric checkpoint by adding a new
   billing record to the already-known vault; background reconciliation must not consume or invent
   a card token.
4. Run the focused EPD matrix and the complete Lago clean gate.
5. Deploy and verify staging only after action-time approval. No real card or production data.
6. Deploy Lago production only after a separate action-time approval and record the Worker version.
7. Complete one fresh Sprout canary purchase and reconcile Store, Lago, EPD, Slack, and entitlement
   evidence without recording payment data.

## Safety and rollback

- Never submit, log, store, or reproduce card numbers, expiry values, security codes, credentials,
  signed checkout links, or customer details.
- A Collect.js token is single-use. A replacement vault billing record is created only from a fresh
  customer-initiated submission.
- Automatic production EPD renewal collection remains disabled.
- Immediate checkout rollback is the Store routing manifest or `LAGO_CHECKOUT_ENABLED=0`; preserve
  all Lago/EPD evidence for reconciliation.
- No production D1 migration or secret change is required for this repair.

## Acceptance criteria

- New production vault requests send a deterministic 32-digit `billing_id`.
- The identical idempotency input derives the identical billing ID.
- Live Commerce attachment cannot receive an alphanumeric billing ID.
- A valid numeric checkpoint resumes without a second Gateway vault call.
- A legacy alphanumeric checkpoint can recover only after a fresh browser token and uses
  `add_billing` against the existing vault.
- Focused tests, formatting, lint, typecheck, Access checks, inventory, tax checks, all Worker tests,
  and development/production dry-run builds pass.
- Production rollout is not complete until a fresh Sprout canary reaches a definitive reconciled
  outcome and no other product routes to EPD.

## Progress

Local repair completed on 2026-09-06. The provider now derives a stable 32-digit value, blocks an
incompatible live value before EPD Commerce, preserves one-call resume for valid checkpoints, and
requires a fresh browser token to replace a legacy alphanumeric checkpoint. The focused matrix is
27/27. The complete Cloudflare gate passed with 517/517 Worker tests before the final additional
determinism regression; that regression and the focused typecheck then passed, bringing the suite
to 518 tests. Formatting, lint, Access fail-closed checks, checkout-message checks, inventory, tax
rules, generated binding checks, typecheck, and all development/production dry-run builds passed.

No Lago Worker, D1 database, secret, provider transaction, or production payment was changed by
the repair. Staging deployment and production promotion remain action-time approval gates.
