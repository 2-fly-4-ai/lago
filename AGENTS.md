# Lago Fork Agent Map

This repository is SERP's integration fork of Lago: the billing and usage-metering component in the
wider app-store platform. The default branch remains an upstream-shaped composition repository;
SERP changes are not operational truth until their feature branch is reviewed and merged.

Read these first:

1. `README.md`
2. `docs/README.md`
3. `docs/SERP_ARCHITECTURE.md`
4. `docs/SOURCE_OF_TRUTH.md`
5. `docs/SAFETY.md`
6. `docs/QUALITY.md`
7. `docs/plans/README.md`

Repository shape:

- `api/` and `front/`: independently versioned Git submodules.
- `events-processor/`: event ingestion and processing service.
- `connectors/`: external integration services.
- `docker/`, `deploy/`, and `docker-compose*.yml`: runtime composition and deployment assets.
- `docs/`: root architecture, operations, and canonical execution plans.

Golden rules:

1. Treat the root, `api/`, and `front/` as separate Git histories. Never update a gitlink unless
   the referenced child commit is committed and accessible.
2. Preserve upstream compatibility unless a SERP fork decision documents the divergence.
3. Do not run billing, payment-provider, database, migration, deploy, secret, or customer-data
   operations without explicit approval.
4. Never commit or print credentials, payment data, customer records, webhook payloads, or env
   values.
5. Do not infer production deployment or enabled premium features from source, compose files, or a
   feature branch.
6. New plans use `docs/plans/active/YYYY-MM-DD-<slug>.md`.
7. Update the owning docs and plan when a service boundary or operator workflow changes.
