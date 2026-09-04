# Easy Pay Direct automated subscription renewals

Opened: 2026-09-05
Completed: 2026-09-05

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
- Automatic collection defaults to subscription-scoped rollout. The global gate cannot create a
  new execution unless the subscription has an enabled D1 scope row; broad `all` mode requires a
  separate rollout decision.
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

- Added migrations `0103` through `0106`, the automatic-collection runner, queue and cron recovery,
  gateway provider-read reconciliation, local-D1 renewal tax repricing, and independent rollout
  gating.
- Migration `0106` adds a subscription-scoped rollout table after staging inventory showed that a
  global gate could include unrelated historical staging subscriptions. New automatic and dunning
  executions now fail closed unless scoped, while already-created executions remain reconcilable.
- Tests cover first-charge profile binding, monthly and yearly eligibility, approval, definitive
  decline, dunning, replay, ambiguous outcome/provider-read convergence, tax, disabled-gate
  behavior, and placeholder-vault rejection.
- The final full clean gate passes formatting, lint, generated inventories and bindings, access
  tests, tax-rule validation, TypeScript, the complete test suite, and every development and
  production dry-run build.
- Staging migrations are current through `0106`, D1 foreign-key checks return no rows, and final
  Worker version `4fc0fbc2-2b09-44ef-82b1-1be2bcc9d0b3` is healthy with automatic collection
  disabled, subscription-scoped rollout, Gateway test mode, live mode disabled, and local-D1 tax
  enforcement restored.
- A bounded staging probe created exactly one execution and made one Gateway test request. It
  exposed an old fixture vault (`Invalid Customer Vault ID`) and did not resubmit. Migration `0105`
  then removed renewable status from every obvious placeholder profile; post-migration counts are
  zero reusable placeholder profiles and zero subscriptions bound to them.
- A fresh 123Movies `$9/month` hosted-form checkout completed against the EPD test gateway and
  stored one provider-issued customer vault plus the original customer-initiated transaction.
- The single fresh subscription was added to the D1 rollout scope. Candidate inspection returned
  exactly one scoped invoice before the temporary gate was enabled.
- Its controlled renewal recalculated the stored German billing destination from `$9.00` to
  `$10.71` (`$1.71` local-D1 tax), created one payment request, made one merchant-initiated EPD
  test attempt, received a provider transaction reference, and marked the invoice paid.
- Two explicit scheduler replays left the result at one payment request, one execution, and one
  provider attempt. Provider-read convergence remains covered by the automated ambiguous-outcome
  tests; this definitive-success provider response required no read recovery.
- The temporary enabled version was `6eddb33e-9c15-4b36-88fb-29e68a65d5b2`. The final deployment
  restored `EASY_PAY_DIRECT_AUTOMATIC_COLLECTION_ENABLED=0`.
- Follow-up on 2026-09-05: the user approved keeping staging automatic collection enabled. The
  staging master gate is therefore on in `scoped` mode, with only the reviewed test subscription
  enabled in D1. Worker version `fa29dd40-603c-48a9-92bb-aa8107e28d37` is healthy in this state;
  production remains off.
