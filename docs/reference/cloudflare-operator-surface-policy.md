# Cloudflare Operator Surface Policy

Verified: 2026-08-16

This policy controls which parts of the pinned Lago React/Apollo console may become visible from
the container-free Cloudflare Worker. It is evidence for M8, not authorization to expose a screen,
create an identity policy, modify `serp-auth`, or enable a provider or payment action.

## Current state

The pinned frontend contains 503 GraphQL operations. After excluding two Material UI class-name
constants that matched the old lexical route heuristic, it contains 159 literal route constants.
The complete item-level inventory remains generated in
`cloudflare-rewrite-feature-inventory.json`.

The isolated Worker currently serves only a script-free migration shell. It deliberately has no
credential input, GraphQL client, or billing controls. The legacy React application must not be
built or uploaded wholesale: doing so would make hundreds of unmapped operations appear usable.

## Screen admission rule

A screen may replace the migration shell only when all of these conditions hold:

1. Every operation reachable from the screen is mapped to a tested Worker REST contract, an
   explicit disabled boundary, or an approved external owner.
2. Navigation, loading, empty, error, stale-write, unauthorized, and cross-tenant behavior have
   end-to-end tests.
3. Mutating controls are hidden when their provider or outbound-action gate is disabled and cannot
   be re-enabled from browser input.
4. The screen does not receive or persist a raw Lago API key, provider secret, payment token, or
   customer export outside its narrowly required response.
5. Cloudflare Access authentication and the tenant/role authorization bridge described below are
   enabled and verified for the deployed Worker.
6. The migration shell remains the rollback asset until the new screen passes remote smoke in the
   isolated stack.

Static delivery alone is not screen parity. A route remains unavailable even when SPA fallback can
return `index.html` for its URL.

## Authentication decision

The operator browser must not use a full-power Lago API key as its login credential or store one in
`localStorage`, `sessionStorage`, IndexedDB, a cookie, or rendered application state. API keys
remain service-to-service credentials.

The selected browser architecture is:

1. A dedicated `serp-dev-lago-operator` Worker serves browser assets and its operator BFF. A
   Cloudflare Access self-hosted application protects that Worker directly by name. No custom
   domain or DNS change is required. `serp-dev-lago-native` remains separate so service API clients
   and provider webhooks are not intercepted by the human login policy.
2. The Worker independently validates `Cf-Access-Jwt-Assertion` against the configured Access team
   issuer, application audience, signature, and expiry.
3. A D1 operator-membership record maps a stable Access subject to one organization and an explicit
   role. Email is display/audit metadata, not the tenant authorization key.
4. Browser API requests use the validated Access identity. Existing bearer API-key authentication
   remains available for service clients and is never synthesized in the browser.
5. Same-origin mutation requests require JSON plus an operator-only CSRF header and reject an
   unexpected `Origin`. Read-only and mutation roles are enforced before domain handlers run.
6. Missing Access configuration, invalid JWTs, missing membership, or ambiguous membership fails
   closed. There is no development bypass in a deployed environment.

Cloudflare currently documents direct Worker-name protection for self-hosted Access applications
and requires Workers behind Access to validate the injected JWT. Provisioning is intentionally
pending because the allowed identity/group policy, session duration, Access team domain, and
application audience have not been approved or made available to this branch. Until then,
interactive operator access stays disabled.

Current platform references:

- [Choose an Access application type](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/choose-application-type/)
- [Validate Access JWTs](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/validating-json/)

## Route-family disposition

| Route family                                                                                                                                                      | Decision                                     | Current evidence and boundary                                                                                                                                                                          |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Customers, plans, subscriptions, invoices, fees, billable metrics, add-ons, coupons, manual taxes, wallets, credit notes, payments, payment requests, and dunning | Retain screen by screen                      | Tenant-scoped REST contracts exist for the retained subsets. Advanced fields/actions remain hidden until their individual operation mapping is complete.                                               |
| Organization, single billing entity, invoice custom sections, API keys, webhook endpoints, payment receipts, quotes, and data exports                             | Retain as REST replacements                  | These already have documented Worker replacements. Existing-secret reveal, non-default billing entities, XML/email actions, and other explicit boundaries must stay unavailable.                       |
| Usage and revenue analytics                                                                                                                                       | Retain later                                 | D1 owns exact usage and daily projections, but the operator analytics query contract and bounded UI read model are not implemented.                                                                    |
| Activity logs, API logs, webhook logs, forecasts, and advanced developer event views                                                                              | Retain only with a new bounded read contract | Static routes alone are insufficient; log retention, redaction, pagination, and tenant authorization must be specified first.                                                                          |
| Customer portal                                                                                                                                                   | Blocked pending separate contract            | Portal token authentication, public exposure, edit permissions, and downloadable-document rules are not part of the operator Access session.                                                           |
| Login, signup, invitation, password reset, Okta, team, role, and authentication settings                                                                          | Blocked pending identity decision            | The Cloudflare Access bridge replaces the need for a containerized Rails login runtime, but identity lifecycle and operator provisioning need an approved policy before legacy screens can be retired. |
| Feature and entitlement screens                                                                                                                                   | External owner                               | `serp-auth` remains entitlement authority. This Lago branch neither edits it nor invents a duplicate entitlement store. A future UI contract requires a separate cross-repository plan.                |
| Adyen, Cashfree, Flutterwave, GoCardless, MoneyHash, and Lago-managed Stripe screens                                                                              | Not used for verified SERP scope             | Read-only consumer audit found direct provider ownership outside Lago and no Lago API dependency. Reintroduction requires a new verified consumer contract and disabled-by-default provider slice.     |
| Anrok, Avalara, HubSpot, NetSuite, Salesforce, Xero, Lago tax management, AI agent, and Lago-managed email screens                                                | Not used for verified SERP scope             | No verified SERP consumer exists and their external side effects are outside the retained Worker contract.                                                                                             |
| Authorize.Net configuration                                                                                                                                       | Blocked, provider behavior retained          | Checkout/reconciliation behavior is retained behind safety gates, but browser secret entry and provider credential storage are not configured or approved.                                             |
| Usage alerts and entitlement/progressive-billing editor routes                                                                                                    | Not used until separately retained           | Core progressive invoice behavior exists; the premium alert/entitlement UI contracts do not have a verified SERP consumer.                                                                             |
| Development design-system route                                                                                                                                   | Retire from deployed build                   | It is explicitly development-only and is not an operator workflow. Source may remain as legacy visual reference.                                                                                       |
| Error, forbidden, and migration status states                                                                                                                     | Retain                                       | These are local static UI states and must not call a backend operation merely to render.                                                                                                               |

`not used` is a scoped evidence statement, not an irreversible deletion. It means the Cloudflare
operator bundle omits the route and code until a verified SERP consumer changes the disposition.

## Rollout order

1. Implement and test Access JWT validation, operator membership, role checks, origin/CSRF checks,
   and value-free audit evidence with configuration absent by default.
2. Obtain explicit approval for the isolated Access allow policy, then provision the dedicated
   operator Worker and Worker-name application and record its non-secret issuer/audience
   configuration. Do not deploy the operator Worker publicly before Access protects it.
3. Ship a read-only organization/status shell and prove tenant isolation remotely with synthetic
   membership only. The membership-scoped organization BFF and its interactive read-only screen
   are implemented locally; remote Access/membership proof remains pending.
4. Add API-key metadata management, keeping one-time create/rotate values ephemeral and never
   offering existing-key reveal. The complete viewer-read/admin-mutation BFF and interactive screen
   are locally implemented and tested; remote Access proof remains pending. The screen uses no
   browser credential storage and clears one-time create/rotate values when its dialog closes.
5. Add the retained catalog and billing screens in bounded families, each with complete operation
   mapping and rollback to the migration shell. The first catalog family, manual invoice custom-
   section viewer reads plus admin create/edit/terminate, is implemented locally through the
   canonical REST handler and existing internal domain-event Queue; remote Access proof remains
   pending. The first billing family, single-default-entity viewer reads plus admin updates, is also
   implemented locally through the canonical D1 handler. It exposes only supported legal, address,
   payment-term, numbering, locale, and document defaults; multi-entity, e-invoicing, tax-assignment,
   and external-action paths remain unavailable. Payment-receipt list/show metadata is implemented
   as the next read-only family, with document URLs, generation/download, email, and every mutation
   suppressed at the operator boundary. Manual-tax list/show plus admin create/edit/terminate is the
   next bounded catalog family, reusing the canonical D1 transaction, value-free outbox evidence,
   and producer-only Queue publication. Add-on list/show plus admin create/edit/terminate follows the
   same boundary while preserving canonical currency/in-use guards and rejecting tax-code targeting.
6. Add analytics/logging only after their bounded read models and retention/redaction contracts
   exist.
7. Remove a legacy screen from the product map only after its `not used`, `external`, or `retire`
   rationale has explicit product approval.

## Rollback

The rollback is asset-first and does not change billing state: restore the script-free migration
shell while keeping Worker REST APIs available to verified service clients. If the Access bridge
is suspect, remove browser authorization/membership bindings or block the Access application; do
not weaken API-key authentication or expose an unauthenticated operator path. D1 membership and
audit rows remain evidence and are removed only by a separately approved cleanup.
