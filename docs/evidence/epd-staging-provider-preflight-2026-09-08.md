# Staging provider preflight — 2026-09-08

## Scope

User approved staging deployment and sandbox verification. Production remains unchanged. No remote migration or deployment was performed during this preflight.

## Remote staging checks

- Staging Worker version: `4338ecff-2613-43e5-b353-ba27df356527`.
- Pending Lago migrations: 0114 through 0121.
- D1 foreign-key check: no violations.
- Automatic-collection scopes: one enabled, one disabled.
- Automatic executions: two succeeded, one failed; none pending.
- Time Travel checkpoint obtained before any proposed migration.

## Actual public-demo provider test

Run `dd2f2cc2-f7f7-4093-b5fc-d5e11cfda687` used the documented public demo account, public test card and explicit test mode. No live merchant credentials or real money were used.

Initial $4.50 recurring sale returned approval and demo transaction `12529904772`. Follow-up Query did not verify the sale. A read-only diagnostic returned:

> Query API cannot be used with the public "demo" account.

The sequence stopped. No renewal, one-time sale, decline or refund followed. An approval response alone is not end-to-end proof. This is a restriction of the public demo account, not evidence that a user's Commerce or Gateway dashboard permissions are insufficient.

The harness now identifies this specific restriction and its mocked regression verifies that no further payment is submitted. Ten harness unit tests pass; these are mocked tests, distinct from the actual demo response above.

## Remaining verification

Provider verification needs a dedicated Gateway test account with Payment API and Query API access, plus matching hosted-tokenization credentials for the browser journey. Do not substitute a live merchant key or assume that the public demo provides these capabilities.

Independent documentation review also found that the transaction-query example does not include customer_vault_id. Resolve missing vault evidence using the documented vault-report contract; do not silently accept mismatched identity or invent a currency default.

Full staging customer-journey verification and production readiness remain unproven. Do not claim a successful renewal, refund, entitlement delivery or Slack notification from this run.
