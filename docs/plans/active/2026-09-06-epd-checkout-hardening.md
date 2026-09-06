# EPD checkout hardening

Status: active. Requested after production checkout failure and pricing audit.

## Ownership and rollout

- Lago owns Gateway/Commerce card binding, payment execution/reconciliation,
  subscription pricing, invoices, renewals, and tax calculation.
- Store owns product routing, authoritative offer and regional-discount selection,
  checkout-session expectations, fulfillment, and customer account actions.
- Marketing sites remain checkout handoff clients. Existing direct Stripe sales
  must remain unchanged. Production EPD scope must not expand beyond Sprout.
- Implement and test locally on the Mac mini SSD. Deploy Lago staging before Store
  staging; verify fresh-card, returning-card, discounted, one-time and recurring
  flows. Promote only verified changes; do not enable automatic collection or
  submit live payments as part of this work.

## Work and acceptance

- [x] Bind the newly submitted card to each checkout; replay only that execution's checkpoints (local regression verified).
- [x] Implement subscription-scoped regional discounts and invoice accounting (local; staging still required).
- [x] Validate Store subscription/base price/discount/currency against Lago before payment and fulfillment (local).
- [ ] Audit customer identity/provider isolation and subscription payment-method ownership.
- [ ] Close account cancellation/management gaps before enabling automatic renewal.
- [x] Remove public provider-routing bypass; retain deliberate operator rollback.
- [ ] Bound provider calls and sanitize public failures without hiding reconciliation needs.
- [ ] Run focused regression tests and full clean gates; record actual results.
- [ ] Verify staging end to end, including notification and fulfillment evidence.
- [ ] Record deployment versions and remaining external tax/registration decisions.

Never treat an unknown provider outcome as permission to submit a second payment.
No claim of global tax readiness: technical coverage and actual collection
registrations are separate release requirements.

## Local verification — 2026-09-06

- Full Lago `cloudflare check` passed: format, lint, typecheck, security/tax tests,
  all unit tests and dev/production dry-run builds. New profile-migration regression
  seeds an automatic execution referencing a legacy profile and verifies preservation
  plus `foreign_key_check`. The rebuild explicitly asserts zero FK violations before
  ending deferred enforcement; see Cloudflare's D1 foreign-key documentation.
- Store: 656 tests passed, 4 pre-existing integration/manual skips; typecheck passed.
  Shared regional-policy focused tests passed. Staging artifact build is separate
  from actual deployment; do not deploy/reuse an artifact labelled with a parent
  commit while the worktree has uncommitted changes.
- No production writes, live payments, or automatic-collection enablement in this
  implementation pass. Staging gateway configuration remains test-mode; production
  automatic collection remains outside this rollout.

Delayed Commerce approval now binds the checkout-scoped renewal profile through
provider reconciliation; success webhooks leave the execution pending that provider
read rather than losing its renewal reference. Returning-card regression covers
delayed approval and preservation of the old profile.

Remaining technical review: Store account closure/billing management needs Lago
coverage; successful checkout replay must not create a second purchase.
Staging provider/browser verification and deployment are not completed by local gates.

Production migration 0111 removes the old customer-wide unique constraint. Pause
new EPD routing before applying it, deploy the matching API, verify, then restore
only the approved canary. The old Worker must not serve EPD writes against the new
schema. This production sequence has not been executed.
