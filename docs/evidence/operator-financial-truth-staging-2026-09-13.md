# Financial-truth correction: isolated staging deployment

## Current status

Billing deployed to isolated SerpTEST. The user subsequently approved aligning
the existing staging admin with SerpTEST and providing both approved users admin
access. Operator deployment and paired browser verification are in progress.
Production, the older shared staging database/native Worker, Store routing and
all provider credentials are unchanged.

The user's “great continue” approved proceeding with the proposed staging step.
The older shared staging database was discovered to be missing migrations 0124–0126,
which include collection-policy changes and historical receipt cleanup. Those were
not run as part of this correction release. The isolated SerpTEST database already
had them and was missing only the additive 0127 guard table.

## Frozen source and deployment

- Source commit: `39e95d9cf0445012ea7c5eaed8c388a9b3f8cf16`.
- Branch: `codex/dub-refund-summary`; committed locally, not pushed in this step.
- API gitlink unchanged: `e36ab5fec575bbba545a5d8078868d60a3010aaf`.
- Front gitlink unchanged: `343281d103a0d103e34a7608bd03096d1d55acca`.
- Reviewed source fingerprint matched the preceding 1,220-test full-gate receipt.
- Worker: `serp-dev-lago-epd-serptest`.
- Database: `serp-dev-lago-epd-serptest-d1`, ID `a88dfe97-3ea1-4b35-baf8-3690e1c4633f`.
- Previous Worker version: `d469f3b6-833a-4951-acb1-0a1327343555`.
- New Worker version: `1aca0b81-8fc5-4b8f-82b2-b1b285323c1e`.
- Version tag: `financial-truth-39e95d9`.
- Cloudflare deployment timestamp: `2026-09-12T13:44:46.527Z`.

The installed Wrangler 4.123.0 command help was checked. The SerpTEST-specific
dry-run build passed before mutation. The only migration applied was
`0127_billing_period_close_fences.sql`; then the native Worker was deployed with
the checked-in SerpTEST config and `--keep-vars`.

The currently deployed non-secret safety flags matched the checked-in config:
development environment, gateway test mode, live mode forbidden, test refund mode,
and the pre-existing payment/automatic-collection switches. No switch or scope was
newly enabled. No manual reconciliation, charge, refund or webhook replay was run.

## Deployed verification

- `/health` returned HTTP 200, status `ok`, environment `development`.
- Cloudflare deployment listing confirmed the new version at 100%.
- Migration journal contains 0127 exactly once; no migrations remain pending.
- Foreign-key checks returned zero violations before and after migration.
- The transaction-local guard table contains zero residual rows.
- The existing checkout processing/unknown aggregate remained one before and after;
  this is count preservation, not proof that its provider outcome is resolved.
- A read-only query using the exact reviewed checkout eligibility expression on
  the remote SerpTEST database found 61 active/past-due recurring candidates:
  15 eligible by the initial-payment gate and 46 blocked. Eligibility is not
  authorization to charge, and no close or collection command was invoked.

These are real remote deployment/schema/read-only checks, not a new provider-backed
payment journey. The 1,220-test suite remains local migrated-D1/contract evidence.

## Approved paired operator step

The existing `serp-dev-lago-operator` hostname is retained. Its checked-in config
now points its D1, R2, Durable Object, workflow, provider service and event queue
bindings to the corresponding resources in `wrangler.serptest.jsonc`. Access
audience/enforcement and the operator refund flag are unchanged. A regression
test compares all these resource mappings and runs in the normal Access gate.

Exactly two admin invitations were inserted in the isolated organization
`org-epd-serptest-20260909`, for the user-approved Farley and Devin email
addresses. Only normalized email hashes are stored, with seven-day expiry.
The normal verified Access login claims an invitation and creates the subject-bound
membership; no subject identity was guessed or copied from another organization.
No existing memberships or Access policies were changed.

Deployment version and post-deployment evidence will be recorded below.

## Rollback boundary

If this isolated release needs rollback, use the recorded previous SerpTEST Worker
version only after checking current operations. Retain additive migration 0127 and
all financial/provider evidence; do not reset or restore the database as a routine
code rollback. Production is outside this release. The root operator/user owns the
rollback decision.

Local deployment logs are in the ignored
`cloudflare/.wrangler/financial-truth-release/` directory on the Mac mini. They are
not customer-facing artifacts and must not be committed as raw runtime output.
