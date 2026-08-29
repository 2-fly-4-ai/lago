# SERP Lago Fork Documentation

This is the root documentation index for the integration fork. Upstream product documentation
remains useful, but SERP-specific decisions must be recorded in this repository.

## Start Here

- [SERP_ARCHITECTURE.md](SERP_ARCHITECTURE.md) — root, submodule, and wider-platform boundaries.
- [SOURCE_OF_TRUTH.md](SOURCE_OF_TRUTH.md) — authority for code, contracts, deployment, and plans.
- [SAFETY.md](SAFETY.md) — financial, data, secret, deployment, and Git gates.
- [QUALITY.md](QUALITY.md) — proportional verification and submodule checks.
- [architecture.md](architecture.md) — existing Lago service and worker architecture.
- [dev_environment.md](dev_environment.md) — Docker development workflow.
- [reference/easy-pay-direct-operations.md](reference/easy-pay-direct-operations.md) — EPD and Lago
  dashboards, ownership, configuration names, staging posture, rollout, and rollback.
- [evidence/global-indirect-tax-and-anrok-cost-estimate-2026-08-29.md](evidence/global-indirect-tax-and-anrok-cost-estimate-2026-08-29.md)
  — production sales distribution, likely tax markets, and Anrok cost scenarios.
- [plans/README.md](plans/README.md) — canonical dated plan lifecycle.

Implementation documentation inside `api/` and `front/` belongs to those submodule histories. A
root document may map their contract, but must not silently override child code or instructions.
