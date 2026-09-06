# EPD customer/vault binding repair

Opened: 2026-09-07
Status: active; not deployed

## Incident

A production Sprout checkout reused an EPD Commerce customer with a different Gateway vault.
The card was vaulted before Commerce customer resolution. The local reusable profile is saved
only after payment-method attachment, so a prior interrupted checkout can leave an existing
Commerce customer without a local profile. Email lookup then joins incompatible references.
Aggregate-only production inspection confirmed one recent incomplete execution with a reused
Commerce customer and a different vault; no provider order is recorded for that execution.

Staging's `gateway_test` initial purchase bypasses Commerce attachment. Its success did not prove
the production bridge. The previous readiness claim was unsupported for this boundary.

## Owner, scope, and rollout

Lago owns customer resolution, vault attachment, checkpoints, error handling, and tests. EPD is
the authority for the customer's linked vault and payment outcome. Store routing, prices,
discounts, tax configuration, renewal scope, and existing subscription profiles stay unchanged.

1. Resolve and validate Commerce customer identity before consuming a card token.
2. Require positive evidence of the matching vault; never replace an existing customer's vault,
   use another customer's payment method, or infer a binding from email alone.
3. Quarantine mismatched interrupted checkpoints without replaying their attachment or order.
4. Keep provider diagnostics out of customer-visible errors; distinguish a definitive pre-order
   rejection from an uncertain payment outcome.
5. Test the production Commerce branch with stateful synthetic provider fixtures, including
   returning customers without a local profile, mismatches, interrupted operations, and replay.
6. Validate the actual provider contract separately. Current public EPD docs describe `card_token`
   through EPD Elements, not the legacy `billing_id`/Gateway-vault customer binding. Do not invent
   support for a response field or call mocked coverage provider-backed acceptance.
7. Full Lago gate, review, then separately approved staging and production deployments. No live
   payment, provider replay, D1 repair, routing change, or secret action is authorized by this plan.

## Acceptance and safety

No card data or customer records in evidence. Retain interrupted records and idempotency keys.
Never automatically resume a mismatched vault into a charge. No production readiness claim until
the actual Commerce attachment contract is verified and the matching sandbox path succeeds.

## Local verification

The repair includes 12 additional regressions (538 Worker tests total): stateful returning-customer
and new-customer attachment, missing/incorrect binding, existing interrupted mismatch, repeat
reconciliation and browser replay, provider error redaction, ambiguous/malformed customer lookup,
incorrect customer/payment-method identities, and inconsistent Gateway vault responses.
The focused suite is 41/41; the full Lago gate (538/538) passed, including formatting, lint,
typecheck, Access checks, tax checks, generated binding checks, inventory, and all seven
development/production dry-run builds. Root harness and diff whitespace checks also passed.

These are local contract tests with fictional data, not a successful live provider test. Public
customer documentation and public Commerce client assets did not establish the legacy vault
response contract. A narrowly scoped read-only EPD binding inspection was requested; no card
details, customer edits, provider payments, replays, secrets, D1 writes, or deployments were made.
Production remains at the pre-repair version. Do not widen the canary or ask for another real
purchase based on these local results.

## Follow-up recovery repair

The second review identified safe preflight outages being stranded as unknown and permanent
setup-review holds occupying the reconciliation batch. Both code paths are repaired:

- A transient read-only lookup failure resets only a fresh execution with no provider checkpoints.
  It allows a new hosted token while retaining all non-card identity/terms/tax checks and the
  immutable initial fingerprint. Concurrent retry claims remain exclusive.
- A lookup failure during recovery preserves the vault and defers without aborting the batch.
- Setup-review holds without an order are filtered before the oldest-100 limit. A held execution
  with an existing provider order stays eligible for outcome reconciliation.
- Malformed customer lookup entries cannot be mistaken for a missing customer.

Thirteen more regressions cover lookup/read 503, 429 and network failures; fresh-token and
concurrent retry; gateway timeout safety; recovery read outage; 101 held records plus actionable
records; and malformed provider entries. Focused tests pass 54/54. The final full gate passes
551/551 Worker tests, formatting, lint, typecheck, generated bindings, Access/UI/tax checks, and
all seven dev/production dry-run builds. Root harness and diff whitespace checks pass.
No migration, deployment, provider/customer mutation,
payment retry, or production configuration change is part of this follow-up. The actual EPD
vault-link contract remains unverified; read-only account verification has been requested.
