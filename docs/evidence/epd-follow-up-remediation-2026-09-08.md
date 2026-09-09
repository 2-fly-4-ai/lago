# EPD follow-up remediation — 2026-09-08

This is local engineering evidence, not a production readiness certificate.
All remote deployments, payment actions, secrets and team permissions remain unchanged.
The active owner/rollout plan is
[the vault repair plan](../plans/active/2026-09-07-epd-vault-binding-repair.md).

## Verified in this batch

- Tax quotes now expire at known rule-set, matching rule, collection-scope, data-freshness,
  Washington rate validity and future matching-rule boundaries. A local checkout test proves
  an expired quote is rejected before any mocked Gateway call.
- Refund selection subtracts already reserved per-provider-payment refunds, including uncertain
  outcomes. A second reservation check runs inside the credit-note transaction. Race fixtures
  prove failure rolls back the credit note and does not call a provider.
- Initial source-owned recovery now has a separate authenticated Store POST. It selects only
  recorded failed/expired fulfillment leases with exact source-v1 activation evidence, explicit
  account/mode and configured organization. It reuses fulfillment, not payment submission.
  A purchase never seen by either webhook or browser still depends on initial webhook delivery.
- Pending/unknown source refreshes now return HTTP 503 rather than reporting HTTP success.
  Generated-Worker tests verify scheduler failure logging for both source routes without
  exposing credentials. This is not proof of an external alert reaching an operator.
- Store test runtime is pinned to installed Node 22.23.1. A new frozen-source release gate
  requires exact Store/Auth revisions and clean trees, rebuilds Auth and runs its Store contract.
  Dirty audit trees intentionally cannot receive a frozen-release pass.
- Auth staging's owning configuration template explicitly chooses test source mode.
  No staging configuration was applied remotely.
- Populated Store 0015–0018 and Auth 0009 migration rehearsals each pass 3/3 using actual
  SQL and fictional records. They exercise constraints, foreign keys, replay preservation and
  interruption rollback with a modeled local journal, not deployed migration history.
- Renewal payment notifications now use the complete authoritative payment/invoice set,
  including successful partial payments. Each provider transaction retains its own deduplication
  claim; initial partial purchases remain ineligible for fulfillment. Slack display headers are
  capped at 150 Unicode characters. No actual Slack message was sent by these tests.
- Expired recurring cancellation now has an explicit versioned capability and exact identity/
  period preconditions. Migration 0118 supplies an assertion executed in the same transaction
  before cancellation effects. It rejects future/malformed invoice coverage, billed successors
  and uncertain manual/automatic payment executions. Independent review caught and verified
  closure of the automatic-execution omission. Twenty-six local D1 tests cover the guard.

## Work requiring distinct evidence or decisions

| Item | Remaining boundary |
| --- | --- |
| Commerce/Gateway bridge | Verify actual merchant customer-to-vault association and recurring processor reference; Gateway login alone cannot prove this. |
| Live refund support | Existing provider-financial mode is test-only. Do not enable a test adapter in production or infer the live contract from mocks. |
| Cancellation | Guarded expired subset is locally tested. Future/malformed coverage or customer-wide uncertain executions remain held, including unrelated abandoned intents; broader safe cancellation remains a distinct limitation. Existing immediate/future-scheduled paths are unchanged. |
| Payment notifications | Local aggregate/split-payment and header regressions pass; actual Slack delivery is unverified and mixed initial/renewal aggregate fulfillment remains held. |
| Three-service lifecycle | Existing Store→Auth contract uses billing fixtures; it is not the entire actual Lago→Store→Auth journey. |
| Provider acceptance | Actual initial purchase, renewal, decline, void/refund and interrupted-response evidence remains separate from local fixtures. |
| Disputes | Access policy and manual/provider override precedence require an explicit decision; do not silently choose revocation policy. |
| Card replacement | Requires verified provider contract and customer-owned authorization; do not fabricate a saved card association. |
| Historical sources/transfers | Real provenance review and migration approval remain required; no automatic backfill/global grant. |
| Recovery holds | Backend holds preserve ambiguous refund/payment/notification evidence; operator resolution must not blindly clear or replay them. |
| Capacity/alerts | Refresh currently admits ten sources per five-minute cron (nominal 120/hour). Measure backlog at expected load and verify alert delivery before broad rollout. |
| Tax operations | Actual collection authorization, maintained jurisdiction coverage and refresh ownership are not established by a calculated rate. |
| Client expiry | Actual extension action behavior and previously minted token lifetime need separate end-to-end proof. |
| Release | Freeze reviewed commits, perform staged migration/build validation and provider-backed staging journey, then obtain production approval. |

Do not collapse these limits into "everything works." No production canary is justified solely
by this batch's local test totals. Keep source-aware Store/Auth rollback constraints in the
[staging checklist](../reference/epd-staging-release-checklist.md).

## Local verification totals

- Store full app suite: 1,011 passed, four credential-dependent tests skipped; type generation
  and TypeScript passed. Skips are not provider acceptance evidence.
- Auth: 105/105, build, TypeScript and source lint passed.
- Actual locally rebuilt Store-to-Auth Worker contract: 8/8. Lago billing input is still a fixture.
- Store and Auth populated migration rehearsals: 3/3 each (included in owning suites).
- Scheduler generated-Worker tests: 2/2; monitoring route tests: 12/12 (route included in app suite).
- Lago final combined gate: 806/806 across 90 test files, including the 26 cancellation guard
  regressions and populated migration rehearsal. Formatting, lint, typecheck, Access checks,
  tax checks and all seven development/production dry-run builds passed. Dry runs are not deployments.
- Store repository doctor and shell-conformance checks passed. Only an empty test-created
  temporary directory was removed; unrelated changes and dirty worktrees were preserved.

## Commerce access navigation

The verified page is <https://commerce.epd.com/user-management>. It shows Brian as Workspace
Admin (9/51), Devin as Owner (51/51), and a More actions menu per row. A permission count is
not evidence of an editable control. The Owner session's available role choices must be
inspected before promising full-access assignment. No ownership transfer or role change was made.

## Subsequent read-only provider investigation

The authorized Owner Commerce session and separately authenticated Gateway session were both
inspected. Permissions are no longer the investigation blocker. Owner's Edit Member and Add
Member selectors exposed six preset roles, no Owner choice or custom-role editor; no role was changed.

The exact billing ID in the user-reported failed checkout returned one Gateway vault record, and
that record listed the billing method. This establishes that the record exists in Gateway; it
does not establish which vault Commerce associates with its customer. Do not copy actual vault,
billing, card or customer identifiers into this report.

Commerce showed an active default merchant route and the user's historical successful sale with
a saved payment method. No vault association identifier was exposed by the inspected customer
or transaction details. Gateway Sync is an explicit migration/approval workflow, not a harmless
refresh; it was not executed.

Independent review rechecked the current official
[customer API](https://docs.api.epd.com/api-reference/customers/) and
[payment-method API](https://docs.api.epd.com/api-reference/payment-methods/).
The documented customer schema does not specify `epd_gateway_customer_vault_id`, and the documented
payment-method input is `card_token`, not our legacy `billing_id` attachment. The supported public
[Elements flow](https://docs.api.epd.com/guides/elements/) is distinct from the current adapter.
Absence from current documentation is not proof the historical API never worked, but is insufficient
to certify the pinned legacy contract. Do not bypass the guard or create a replacement customer
to conceal an unverified association.

Exact unresolved contract questions for EPD: under version `2026-02-11`, is existing Gateway
vault/billing attachment supported, how is the association established and read back, and how
are the Gateway and Commerce merchant accounts matched? If unsupported, adopting Elements also
requires changing the direct-Gateway renewal design; it is not a drop-in token rename.

The focused provider, checkout, Gateway-timeout and replay-window suites were rerun: 123/123
passed locally. These use fictional provider responses. No fresh sandbox/live payment, deployment,
provider migration, vault edit, secret operation or customer-message send was performed.
