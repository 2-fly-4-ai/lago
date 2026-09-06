# Sprout recurring canary launch

Status: active. User authorized deep verification and the Sprout production canary.

## Owners and rollout

- Store owns signed product selection, pricing, discounts, fulfillment, and the
  Sprout-only live checkout route. It will send immutable per-subscription product
  attribution to Lago, not mutable customer metadata.
- Lago owns saved payment profiles, recurring eligibility, collection, retries,
  cancellation holds, and product-scoped renewal authorization.
- Deploy additive Lago schema/code to staging before Store; test successful first
  payment, renewal, replay, cancellation, one-time exclusion and regional prices.
  Promote only verified source, Lago before Store, with Sprout-only policy.
- Preserve existing direct Stripe routes and production tax-disabled configuration.
  No real card submission or synthetic live charge is authorized for QA.

## Findings / required evidence

- Current scoped collection has no automatic enrollment from checkout. Turning on
  its global switch alone does not complete recurring checkout.
- Manual historical scopes must not authorize unrelated subscriptions on activation.
- Product attribution must be immutable, tenant-bound and authenticated; shared
  plans and customer metadata are not authorization sources.
- Enrollment requires a paid initial invoice, checkout-bound active profile and
  original transaction reference. Disabled scopes must not silently re-enable.
- Check existing production eligibility in aggregates before activation; preserve
  unresolved payment evidence without resubmission.
- Correct Sprout's misleading one-time/lifetime marketing copy.
- Record full gates, staging evidence, production versions and rollback procedure.
