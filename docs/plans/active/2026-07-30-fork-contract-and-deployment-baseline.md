# Fork Contract and Deployment Baseline

Opened: 2026-07-30
Status: active

## Objective

Turn the current upstream-shaped default branch and SERP feature work into a documented,
testable fork without guessing which customizations are deployed.

## Scope

- Inventory root, API, and frontend revisions and their writable remotes.
- Review SERP feature branches and classify changes as merge, revise, or archive.
- Add synthetic storefront request, webhook, and reconciliation fixtures.
- Document the enabled service topology and an approval-gated deployment/rollback runbook.
- Preserve upstream mergeability and record deliberate divergence.

## Safety

No payment-provider mutation, customer-data access, database operation, secret change, deployment,
or submodule pointer update is authorized by this plan.

## Acceptance Criteria

- Default-branch docs describe the actual composed revisions and contract owners.
- Each retained SERP customization has tests and a reviewed default-branch path.
- Storefront/Lago contract fixtures cover idempotency, failure, and reconciliation.
- Deployment and rollback ownership is explicit before any live change.

## Progress

- [x] Root harness and canonical plan structure prepared.
- [ ] Review customization branches against the default branch.
- [ ] Pin synthetic cross-repository contract fixtures.
- [ ] Document enabled non-secret topology and release procedure.
