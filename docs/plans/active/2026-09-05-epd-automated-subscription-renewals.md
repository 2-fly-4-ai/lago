# Easy Pay Direct automated subscription renewals

Opened: 2026-09-05

## Objective

Complete the missing recurring-payment leg for the Cloudflare-native Lago rollout. A finalized,
due subscription invoice for an Easy Pay Direct customer must be collected automatically from the
provider-vaulted payment method, reconcile through the existing Lago payment ledger, and enter the
existing dunning path after a definitive decline. Duplicate cron runs, workflow retries, queue
redelivery, and provider webhooks must converge without a second charge.

## Ownership and rollout order

- This `lago` repository owns invoice eligibility, tax repricing, automatic payment requests,
  provider-vault references, EPD/NMI merchant-initiated transactions, reconciliation, and dunning.
- `store-new` remains the owner of product routing, initial checkout, completion polling, and
  fulfillment. It consumes Lago status but does not schedule renewals.
- `serp-auth` remains the entitlement authority. No authentication or entitlement contract changes
  are required for this implementation.
- EPD/NMI owns the card vault and provider outcome. Lago stores only provider-issued identifiers and
  payment evidence, never card numbers, CVVs, or reusable browser payment tokens.

Rollout order: additive Lago schema, local tests and dry-run builds, staging migration, staging
Worker deploy, synthetic and EPD test-mode renewal QA, then a separate production approval. Store
and production product routes remain unchanged during this plan.

## Design constraints

- Cloudflare Queues are at-least-once. A deterministic D1 execution identity and stable EPD order
  identity are therefore mandatory before the first provider request.
- The first customer-initiated charge stores the EPD/NMI customer-vault ID and original transaction
  ID. Renewals use `initiated_by=merchant`, `stored_credential_indicator=used`,
  `billing_method=recurring`, and that original transaction ID.
- Historical checkout profiles are never promoted by inference. Only a fresh checkout through the
  explicit credential-on-file implementation can make a subscription renewable; fixture vault
  references are quarantined and rejected at runtime.
- A definitive provider decline becomes a failed Lago payment and may be retried only through a new
  dunning payment request. An ambiguous network outcome remains `unknown`; reconciliation queries
  the provider by stable order ID before any further action.
- Automatic collection is separately gated from interactive payment mutations. Disabling the gate
  stops new renewal charges while preserving all ledger and provider evidence.
- When EPD tax enforcement is enabled, renewal tax is recalculated from the last committed billing
  destination against the current reviewed D1 rule set before the payment request is created.
  Missing, stale, or ambiguous tax data fails closed.

## Milestones and acceptance criteria

1. Add additive automatic-collection and tax-evidence tables with tenant, invoice, profile, amount,
   and immutable-identity guards. Migration and foreign-key tests must pass.
2. Persist reusable gateway profile evidence after both Gateway test and Commerce first charges,
   including the original transaction ID needed for subsequent credential-on-file charges.
3. On `invoice.finalized`, create exactly one automatic payment request only for a due recurring
   EPD invoice with no existing payment request and an active reusable profile.
4. On the resulting `payment_request.created`, claim exactly one execution, issue the EPD/NMI
   merchant-initiated transaction, and reconcile success or definitive failure through the existing
   payment-request allocator.
5. Reconcile ambiguous executions by provider read using the stable order ID. Never submit another
   charge while an outcome is unknown.
6. Cover first renewal, monthly/yearly amounts, tax-inclusive totals, decline, dunning retry,
   duplicate event, overlapping worker, queue replay, provider-read recovery, missing profile,
   stale tax data, and disabled-gate behavior.
7. Pass formatting, lint, generated types, TypeScript, full tests, migration checks, and all dry-run
   builds before staging deployment.
8. Apply only the additive staging migration, deploy staging, verify fail-closed controls and D1
   integrity, then run an EPD test-mode renewal without live cards or production data.

## Safety and rollback

- No production deploy, production D1 mutation, live provider charge, Store route change, or secret
  synchronization is part of this plan.
- Set `EASY_PAY_DIRECT_AUTOMATIC_COLLECTION_ENABLED=0` to stop new automated charges immediately.
- Do not delete unknown executions. Reconcile them from provider reads or resolve them manually with
  retained evidence.
- The schema is additive. A code rollback may leave the new tables in place without affecting the
  existing interactive EPD or direct-Stripe paths.

## Completion evidence

- Added migrations `0103` through `0105`, the automatic-collection runner, queue and cron recovery,
  gateway provider-read reconciliation, local-D1 renewal tax repricing, and independent rollout
  gating.
- Tests cover first-charge profile binding, monthly and yearly eligibility, approval, definitive
  decline, dunning, replay, ambiguous outcome/provider-read convergence, tax, disabled-gate
  behavior, and placeholder-vault rejection.
- The full clean gate passes formatting, lint, generated inventories and bindings, typecheck, 76
  test files / 437 tests, and every development and production dry-run build.
- Staging migrations are current and D1 foreign-key checks return no rows. Worker version
  `9610760b-d81d-44af-9410-070df2063083` is healthy and ready with automatic collection disabled
  and local-D1 tax enforcement restored.
- A bounded staging probe created exactly one execution and made one Gateway test request. It
  exposed an old fixture vault (`Invalid Customer Vault ID`) and did not resubmit. Migration `0105`
  then removed renewable status from every obvious placeholder profile; post-migration counts are
  zero reusable placeholder profiles and zero subscriptions bound to them.
- Remaining acceptance item: complete one fresh recurring staging checkout through the current EPD
  hosted form, then enable the renewal gate for its single synthetic next invoice and verify one
  successful provider transaction. The extension-backed browser session was unavailable during
  this run, so this provider-issued-vault proof is not claimed complete.
