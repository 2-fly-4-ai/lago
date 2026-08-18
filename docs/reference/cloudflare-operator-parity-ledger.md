# Cloudflare Operator Authoritative Parity Ledger

Generated from `docs/reference/cloudflare-rewrite-feature-inventory.json`.

## Completion rule

The checked-in original Lago frontend is the product source of truth. A classification,
placeholder, disabled route, or unreachable legacy GraphQL operation is **not** parity. A surface
is complete only when its Cloudflare-native behavior has executable evidence, or the user has
explicitly approved that named omission or replacement.

No earlier `blocked`, `external`, `not-used`, or `retired` classification is treated as product
approval.

## Current baseline

- Original GraphQL operations: **503**
- Original literal route constants: **159**
- Tested Access-scoped REST replacement families: **22**
- Operations currently eligible to count as complete: **56**
- Routes currently eligible to count as complete: **21**

Completion eligibility is evidence-driven. The remediated product surfaces count only because
their original operations and routes now map to executable Cloudflare behavior and focused tests.
Unreconciled surfaces remain ineligible even when related REST families exist.

## Surface ledger

| Surface | State | Operations | Routes | Required Cloudflare contract | Evidence / remaining gap |
| --- | --- | ---: | ---: | --- | --- |
| Right-side AI assistant | complete | 4 | 0 | D1 conversation history plus a tenant-scoped streaming Worker AI contract | cloudflare/src/operator/ai.ts; cloudflare/operator-app; operator-parity-surfaces.test.ts |
| Analytics | complete | 17 | 5 | Tenant-scoped D1 usage, invoice, revenue, MRR, and prepaid-credit read models | cloudflare/src/operator/analytics.ts; cloudflare/operator-app; operator-parity-surfaces.test.ts |
| Forecasts | complete | 1 | 1 | Tenant-scoped forecast projection and bounded read contract | cloudflare/src/operator/analytics.ts; cloudflare/operator-app; operator-parity-surfaces.test.ts |
| Billable metrics | complete | 8 | 5 | Existing canonical billable-metric API exposed through the Access BFF | cloudflare/src/api/metered-usage.ts; cloudflare/src/operator/product-parity.ts; cloudflare/operator-app |
| Features and entitlements | complete | 10 | 4 | Lago-owned D1 feature/privilege catalog with an explicit future serp-auth sync boundary | migration 0073; cloudflare/src/operator/features.ts; cloudflare/src/operator/product-parity.ts; operator-parity-surfaces.test.ts |
| Activity, API, event, and webhook logs | complete | 16 | 6 | Redacted tenant-scoped event and request projections with bounded retention | migration 0074; cloudflare/src/operator/observability.ts; cloudflare/operator-app; operator-parity-surfaces.test.ts |
| Customer portal | missing | 13 | 4 | Separate public-token Worker contract and customer-safe projections | A separate security boundary is required, but the product surface remains unfinished. |
| Identity, invitations, team, roles, and authentication settings | partial | 33 | 17 | Cloudflare Access authentication plus D1 organization memberships and role policy | Access replaces operator login, but invitations, membership lifecycle, role administration, and related settings are not complete. |
| Provider, accounting, CRM, tax, and payment integrations | missing | 131 | 29 | Provider-specific secret-safe Worker adapters behind disabled-by-default gates | No integration may be silently removed. Each requires implementation or explicit user approval to omit. |
| Core billing and configuration operator | partial | 270 | 88 | 22 tested Access-scoped REST replacement families | The current pages cover bounded subsets. Exact original fields, tabs, filters, logs, advanced actions, and failure states still require operation-level verification. |

## Machine-readable operation ledger

Every one of the 503 operations and 159 routes, including its original
source file, previous disposition, current required surface, and evidence state, is recorded in
`docs/reference/cloudflare-operator-parity-ledger.json`. The generator fails if any original
operation or route is absent.
