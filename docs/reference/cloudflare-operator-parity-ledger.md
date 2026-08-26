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
- Operations currently eligible to count as complete: **503**
- Routes currently eligible to count as complete: **159**

Completion eligibility is evidence-driven. The remediated product surfaces count only because
their original operations and routes now map to executable Cloudflare behavior and focused tests.
Unreconciled surfaces remain ineligible even when related REST families exist.

## Surface ledger

| Surface | State | Operations | Routes | Required Cloudflare contract | Evidence / remaining gap |
| --- | --- | ---: | ---: | --- | --- |
| Right-side AI assistant | complete | 4 | 0 | D1 conversation history plus a tenant-scoped streaming Worker AI contract | cloudflare/src/operator/ai.ts; cloudflare/operator-app; operator-parity-surfaces.test.ts |
| Analytics | complete | 24 | 5 | Tenant-scoped D1 usage, invoice, revenue, MRR, and prepaid-credit read models | cloudflare/src/operator/analytics.ts; cloudflare/operator-app; operator-parity-surfaces.test.ts |
| Forecasts | complete | 1 | 1 | Tenant-scoped forecast projection and bounded read contract | cloudflare/src/operator/analytics.ts; cloudflare/operator-app; operator-parity-surfaces.test.ts |
| Billable metrics | complete | 17 | 5 | Existing canonical billable-metric API exposed through the Access BFF | cloudflare/src/api/metered-usage.ts; cloudflare/src/operator/product-parity.ts; cloudflare/operator-app |
| Features and entitlements | complete | 15 | 4 | Lago-owned D1 feature/privilege catalog with an explicit future serp-auth sync boundary | migration 0073; cloudflare/src/operator/features.ts; cloudflare/src/operator/product-parity.ts; operator-parity-surfaces.test.ts |
| Activity, API, event, and webhook logs | complete | 18 | 7 | Redacted tenant-scoped event and request projections with bounded retention | migration 0074; cloudflare/src/operator/observability.ts; cloudflare/operator-app; operator-parity-surfaces.test.ts |
| Customer portal | complete | 13 | 4 | Separate public-token Worker contract and customer-safe projections | migration 0077; cloudflare/src/portal/index.ts; cloudflare/src/operator/portal-admin.ts; cloudflare/portal-app; portal.test.ts; portal-app-assets.test.ts |
| Identity, invitations, team, roles, and authentication settings | complete | 37 | 19 | Cloudflare Access authentication plus D1 organization memberships and role policy | migration 0075; cloudflare/src/operator/access.ts; cloudflare/src/operator/team.ts; cloudflare/operator-app; operator-access.test.ts; operator-parity-surfaces.test.ts |
| Provider, accounting, CRM, tax, and payment integrations | complete | 141 | 29 | Provider-specific secret-safe Worker adapters behind disabled-by-default gates | migration 0076; cloudflare/src/operator/integrations.ts; cloudflare/operator-app; operator-parity-surfaces.test.ts |
| Core billing and configuration operator | complete | 233 | 85 | 22 tested Access-scoped REST replacement families | cloudflare/src/operator/index.ts; cloudflare/src/api; cloudflare/operator-app; operator-access.test.ts |

## Machine-readable operation ledger

Every one of the 503 operations and 159 routes, including its original
source file, previous disposition, current required surface, and evidence state, is recorded in
`docs/reference/cloudflare-operator-parity-ledger.json`. The generator fails if any original
operation or route is absent.
