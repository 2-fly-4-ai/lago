# EPD Gateway follow-up readiness

Date: 2026-09-08. Status: local implementation and verification; **not production-ready**.
No deployment, remote migration, secret synchronization, provider transaction or customer message
was performed during this follow-up. Existing dirty work is preserved in the audit worktree;
HEAD alone does not identify this uncommitted release unit.

## What changed

- Gateway URL/form/charge/read credential checks are separate from Commerce.
- Initial purchases determine recurring versus one-time from linked invoice plans. One-time
  requests do not send recurring or vault-creation flags; unknown/mixed types stop before charging.
- Initial and renewal approvals require matching provider Query evidence before settlement.
  Transaction and original vault checkpoints survive read failure; conflicting vault evidence
  cannot be overwritten on a later recovery pass. Uncertain attempts never create a second sale.
- Malformed, truncated, duplicate and saturated Query results are not accepted as unique proof.
- Immutable execution transport separates new Gateway/Commerce payments. Historical ambiguous
  initial payments remain review-held and cannot silently route refunds to another system.
  Held historical rows do not consume the automatic reconciliation batch indefinitely.
- Gateway partial refunds have a claim-once local operation journal. Local operation identity is
  distinct from the provider's original sale ID. A recorded explicit response can finalize;
  lost/ambiguous responses stay held without retrying or guessing from aggregate refund totals.

Independent reviewers examined provider contracts, renewal evidence, transport/refund provenance,
and follow-up recovery. The second pass found and led to fixes for vault mismatch recovery and
reconciliation starvation. These reviews reduce risk; they are not a guarantee of no remaining bugs.

## Evidence classification

Final local release command: `pnpm run check` exited 0 on the Mini local SSD. This includes
formatting, lint, Access tests, checkout UI tests, nine demo-harness unit tests, inventory and tax
checks, generated binding checks, TypeScript, the full Vitest suite, and all development/production
**dry-run** builds. The preceding full Vitest run had 994/996 passing with two obsolete
Commerce replay fixtures lacking explicit transport; those fixtures were corrected and the
complete release command rerun successfully. No tests were skipped or safety checks weakened to
resolve those failures.

| Area | Evidence obtained | Not established by this evidence |
| --- | --- | --- |
| Gateway field/response contract | Primary Gateway portal and separate Commerce docs compared; provider parser tests | Merchant processor acceptance or live credential validity |
| Initial purchase, discount/tax totals | Local D1 checkout and tax tests with mocked provider responses | Actual hosted-card purchase and returned customer access |
| Renewal and one-time exclusion | Local automatic collection and plan-interval tests | Real stored-card renewal on the chosen merchant processor |
| Failure, duplicate, interruption and reconciliation | Local fault injection, checkpoint/replay and batch-fairness tests | Real provider timeout/webhook timing |
| Refunds | Local operation journal, concurrency/lost-response/partial-refund tests | Actual Gateway refund acceptance and settlement |
| Migrations | Populated local rehearsal through 0121; historical preservation and foreign-key checks | Remote baseline, restore timing or permission to migrate |
| Demo harness | Nine mocked harness tests; strict public demo target and approval guard | Any actual provider transaction; harness has not been run against EPD |
| Entitlements and Slack | Existing local lifecycle tests remain part of the regression suite | Actual staged Store/Auth acknowledgement and delivered Slack message |
| Production | No change in this follow-up | A successful new production canary |

## Remaining acceptance actions

1. Obtain the pending approval to execute the dedicated Gateway demo API harness. This is unrelated
   to Commerce workspace roles. Its documented expiry example is stale; actual acceptance is unknown.
2. Run and inspect the real demo outcomes, stopping on ambiguity without retrying a mutation.
   A successful direct API run does not replace Collect.js testing.
3. Inspect exact staging deployed versions/migration journals and approve the scoped staging release
   commands. Include the earlier Store/Auth source-delivery changes described in the release checklist;
   do not deploy a partial customer journey or blindly activate historical renewal scopes.
4. Demonstrate staged hosted-card checkout, renewal, one-time exclusion, cancellation/refund,
   entitlement convergence and labeled Slack delivery; keep an excluded Stripe control.
5. Review the actual production Gateway route and processor configuration against that evidence.
   New direct Gateway initial/refund code is still test-only. Do not enable production by changing
   a test-mode flag or claim that the old Commerce bridge is validated by a Gateway demo.
6. Freeze reviewed source and rerun release checks before requesting a separate Sprout-only canary
   approval. The user makes the eventual real purchase.

No new production canary is justified by the local results alone.
