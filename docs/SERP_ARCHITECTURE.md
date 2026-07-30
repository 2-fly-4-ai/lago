# SERP Lago Fork Architecture

Last reviewed from the default branch: 2026-07-30

## Purpose

Lago supplies billing, usage metering, invoicing, payment-provider integration, and operator
surfaces for the wider SERP platform. This root repository composes services and pins independent
API and frontend histories; it is not a monorepo containing those implementations.

```text
storefront / platform services
             |
             v
       Lago API contract
       /       |       \
      v        v        v
 billing   usage jobs   payment/webhook integrations
      \        |        /
       v       v       v
      database, queues, documents, observability

operator browser --> front submodule --> Lago API
```

## Ownership Boundaries

- The root owns service composition, root deployment assets, connector services, event-processor
  integration, documentation, and the exact `api`/`front` gitlink revisions.
- `api/` owns billing-domain behavior, schemas, jobs, and API contracts.
- `front/` owns the operator interface and its client contract.
- Payment providers own external mutation outcomes; local code and fixtures describe intended
  integrations only.
- Storefront, entitlement, and analytics repositories own their side of cross-repository
  contracts. A Lago change does not implicitly transfer that authority.

## Current-State Warning

The default branch is an upstream-shaped baseline. SERP customization branches may contain
self-hosting, provider, analytics, AI, or Cloudflare experiments that have not been merged. A
branch, compose service, environment key name, or disabled code path is evidence of intent—not
proof of production use.

## Known Gaps

- Record the exact storefront-to-Lago request, webhook, and reconciliation fixtures.
- Decide and document which SERP feature branch changes belong on the default branch.
- Inventory enabled production-like services without accessing customer or payment data.
- Define an approved deployment and rollback runbook before any platform migration.
- Keep root and submodule revisions independently testable and reproducible.
