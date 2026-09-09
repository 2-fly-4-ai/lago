# Gateway vault Query compatibility repair

Scope: local Lago code and synthetic regression tests only. No deployment, remote database mutation, credential change or provider transaction.

## Contract and fix

The Gateway Payment API response documents `customer_vault_id` as the requested or created vault ID. The transaction Query example does not include it. An omitted Query field is therefore not a contradictory vault identity.

Primary reference: https://secure.easypaydirectgateway.com/merchants/resources/integration/integration_portal.php (Payment API response variables and Query response example).

`finalizeGatewayTestOutcome` now preserves the direct-Gateway sale's transaction/vault checkpoint when Query omits the vault. The update requires immutable Gateway transport and the same transaction ID. A supplied conflicting vault is rejected. A profile from another checkout/customer is never used to fill this gap. Exact successful-sale status, order, amount and currency verification remain required.

When both sale and Query omit the vault, recurring saved-card setup stays pending. Recovery does not resubmit the payment. The change does not make unknown vault identity acceptable for renewals.

The Gateway response parser also rejects duplicated response, transaction, vault or order fields rather than selecting the first value as binding evidence.

## Independent review

Gateway reviewer confirmed the narrow design: immutable direct-Gateway transport and exact transaction fencing provide checkpoint provenance for the current reachable paths. Commerce setup/resume cannot populate these direct-Gateway executions. A separate vault report can verify existence/billing selection but cannot establish a missing sale-to-vault link.

## Verification

- Checkout suite: 76/76 local Workers/D1 tests, with mocked provider responses.
- Added inline Query omission, interrupted Query recovery, and both-responses-missing cases.
- Existing conflicting-vault and no-second-sale cases remain passing.
- Four additional provider-parser ambiguity cases passed.
- Full `pnpm run check`: exit 0, including 1003/1003 Vitest tests across 98 files, formatting, lint, Access/UI/demo-harness tests, inventory, tax checks, generated types, TypeScript and all development/production dry-run builds.
- Repository harness and `git diff --check`: passed.

Dedicated Gateway test-account lifecycle verification remains blocked as recorded in `epd-staging-provider-preflight-2026-09-08.md`. This repair is not proof of live purchases, vault billing selection, renewals, refunds, entitlements or Slack delivery. Production remains unchanged.

The existing dirty worktree `tmp/lago-production-canary` on `codex/epd-vault-binding-repair` is retained to preserve this and the earlier uncommitted audit work. No branch merge or push was performed.
