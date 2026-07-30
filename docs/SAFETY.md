# Safety and Operator Gates

## Explicit Approval Required

Do not run billing, invoice, payment-provider, webhook replay, customer-data, database, migration,
seed, backfill, deployment, secret, or production smoke-test operations without explicit approval
for the exact environment and command.

Do not update a submodule pointer unless the child commit is committed, pushed to an accessible
remote, reviewed with the root change, and has a documented rollback.

## Sensitive Data

- Never print or commit credentials, signing material, payment data, customer records, invoice
  documents, webhook payloads, database exports, or env values.
- Use synthetic fixtures for contract tests.
- Keep temporary evidence in ignored repository-local paths and remove it after use.
- Treat logs and screenshots as sensitive until reviewed and redacted.

## Before an Approved Remote Operation

1. Identify the exact root revision and both submodule revisions.
2. Identify the environment, provider account, database, and rollback owner.
3. Run non-mutating contract and service checks first.
4. Confirm idempotency and reconciliation for every financial mutation.
5. Capture verification that does not expose customer or payment data.
