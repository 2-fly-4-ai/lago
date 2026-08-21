# Cloudflare Operator Surface Policy

Verified: 2026-08-22

This policy controls which parts of the pinned Lago React/Apollo console may become visible from
the container-free Cloudflare Worker. It is evidence for M8, not authorization to expose a screen,
create an identity policy, modify `serp-auth`, or enable a provider or payment action.

## Current state

The pinned frontend contains 503 GraphQL operations. After excluding two Material UI class-name
constants that matched the old lexical route heuristic, it contains 159 literal route constants.
The complete item-level inventory remains generated in
`cloudflare-rewrite-feature-inventory.json`.

The deployed API Worker still serves the script-free migration shell. The separate operator Worker
is deployed behind its approved Cloudflare Access application. Its native module app uses 22 tested
membership-scoped REST route families and has no GraphQL client or browser credential input/storage.
The generated inventory preserves each legacy operation's historical migration classification and
records the REST replacements separately. The authoritative parity ledger now maps all 503 original
operations and all 159 original route constants to executable Cloudflare behavior and evidence. The
legacy React application must not be built or uploaded wholesale.

## Approved product decision: no screen retirement

On 2026-08-22, the product owner selected the retain-by-default policy: no original Lago product
screen or workflow is approved for retirement. Historical `blocked`, `external`, `not-used`,
`retired`, or `deferred` inventory labels are implementation-history evidence only and cannot be
used to omit a product surface.

This decision means:

- every original product route stays represented by an executable Cloudflare-native surface or a
  named Cloudflare-native replacement;
- a disabled external action remains visibly safety-disabled on its retained surface rather than
  making the screen disappear;
- Cloudflare Access may replace Lago password/social/Okta credential handling, but the identity,
  invitation, team, role, authentication-settings, and security-log workflows remain product
  surfaces;
- the development-only design-system route remains available as source/reference tooling and is
  not classified as a retired customer/operator product screen;
- future removal of any named product screen requires a new explicit product decision and a
  rollback entry. Silence, lack of a current consumer, or an unavailable provider is not approval.

The generated authoritative ledger in `cloudflare-operator-parity-ledger.md` is the enforcement
record: all 503 operations and 159 routes are completion-eligible only through executable evidence,
not through an omission classification.

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
3. D1 operator-membership records map a stable Access subject to one or more organizations, with an
   explicit role per organization. Email is display/audit metadata, not the tenant authorization
   key. Multi-membership requests select an admitted organization explicitly and fail closed when
   the selection is missing or invalid.
4. Browser API requests use the validated Access identity. Existing bearer API-key authentication
   remains available for service clients and is never synthesized in the browser.
5. Same-origin mutation requests require JSON plus an operator-only CSRF header and reject an
   unexpected `Origin`. Read-only and mutation roles are enforced before domain handlers run.
6. Missing Access configuration, invalid JWTs, missing membership, or ambiguous membership fails
   closed. There is no development bypass in a deployed environment.

Cloudflare currently documents direct Worker-name protection for self-hosted Access applications
and requires Workers behind Access to validate the injected JWT. The isolated
`serp-dev-lago-operator` application and narrowly scoped allow policy are provisioned, and the
Worker also validates the issuer, audience, signature, expiry, and D1 membership before admitting
an operator request.

Current platform references:

- [Choose an Access application type](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/choose-application-type/)
- [Validate Access JWTs](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/validating-json/)

## Route-family disposition

| Route family                                                                                                                                                      | Decision                            | Current evidence and boundary                                                                                                                                                                      |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Customers, plans, subscriptions, invoices, fees, billable metrics, add-ons, coupons, manual taxes, wallets, credit notes, payments, payment requests, and dunning | Retain screen by screen             | Tenant-scoped REST contracts exist for the retained subsets. Advanced fields/actions remain hidden until their individual operation mapping is complete.                                           |
| Organization, single billing entity, invoice custom sections, API keys, webhook endpoints, payment receipts, quotes, and data exports                             | Retain as REST replacements         | These already have documented Worker replacements. Existing-secret reveal, non-default billing entities, XML/email actions, and other explicit boundaries must stay unavailable.                   |
| Usage and revenue analytics                                                                                                                                       | Retained                            | Tenant-scoped D1 revenue, MRR, usage, prepaid-credit, invoice, customer, and plan projections are exposed through bounded date/customer filters.                                                   |
| Activity logs, API logs, webhook logs, forecasts, and advanced developer event views                                                                              | Retained                            | Redacted tenant projections, bounded retention/pagination, forecast scenarios, and entity activity reads have focused tests and operator routes.                                                   |
| Customer portal                                                                                                                                                   | Retained as a separate Worker       | Operator-created, hashed, expiring portal tokens reach a customer-safe projection Worker; tokenless requests fail closed and no operator Access credential is reused.                              |
| Login, signup, invitation, password reset, Okta, team, role, and authentication settings                                                                          | Replaced by Access-native identity  | Cloudflare Access handles authentication; D1 owns membership/invitation/role policy, while password and Okta credential screens are intentionally not duplicated.                                  |
| Feature and entitlement screens                                                                                                                                   | Retained Lago catalog               | Lago-owned feature, privilege, and plan-entitlement configuration is tenant-scoped in D1. `serp-auth` remains only a future projection consumer and is not modified here.                          |
| Adyen, Cashfree, Flutterwave, GoCardless, MoneyHash, and Lago-managed Stripe screens                                                                              | Retained, safety-disabled           | Their configuration families remain represented in the secret-safe integration registry and settings UI. Provider calls remain disabled until separately approved.                                |
| Anrok, Avalara, HubSpot, NetSuite, Salesforce, Xero, Lago tax management, and Lago-managed email screens                                                          | Retained, safety-disabled           | The secret-safe integration registry preserves their visible configuration structure, while unverified external side effects remain disabled.                                                      |
| Lago Assistant                                                                                                                                                    | Retained read-only                  | Workers AI streaming chat and D1 history are Access- and tenant-scoped; aggregate context is read-only and no billing mutation tools are exposed.                                                  |
| Authorize.Net configuration                                                                                                                                       | Retained, safety-disabled           | Configuration structure and checkout/reconciliation behavior are retained behind safety gates; browser secret entry and provider credential storage are not configured or approved.                |
| Usage alerts and entitlement/progressive-billing editor routes                                                                                                    | Retained                            | Alert, feature, privilege, plan-entitlement, and progressive-billing surfaces remain represented by tested Cloudflare-native contracts; external actions remain gated.                             |
| Development design-system route                                                                                                                                   | Retained as development reference   | It is not a customer/operator production workflow and is not deployed in the protected operator bundle, but its source/reference role is preserved rather than classified as product retirement.    |
| Error, forbidden, and migration status states                                                                                                                     | Retain                              | These are local static UI states and must not call a backend operation merely to render.                                                                                                           |

Historical `not used` labels remain useful discovery evidence, but the approved product policy does
not permit them to remove a product route. Disabled provider operations stay fail-closed while their
screen-level structure remains represented.

## Rollout order

1. Implement and test Access JWT validation, operator membership, role checks, origin/CSRF checks,
   and value-free audit evidence with configuration absent by default.
2. Obtain explicit approval for the isolated Access allow policy. Deploy only the binding-free
   bootstrap that returns `503` for every route to obtain the immutable Worker ID, then provision the
   Worker-name application and record its non-secret issuer/audience configuration. Do not deploy
   the functional operator Worker, Static Assets, or data bindings before Access protects that ID.
3. Ship a read-only organization/status shell and prove tenant isolation remotely with synthetic
   membership only. The membership-scoped organization BFF, multi-organization selection, viewer
   restriction, and tenant isolation have passed remote Access verification.
4. Add API-key metadata management, keeping one-time create/rotate values ephemeral and never
   offering existing-key reveal. The complete viewer-read/admin-mutation BFF and interactive screen
   are implemented, tested, and protected by the verified Access boundary. The screen uses no
   browser credential storage and clears one-time create/rotate values when its dialog closes.
5. Add the retained catalog and billing screens in bounded families, each with complete operation
   mapping and rollback to the migration shell. The first catalog family, manual invoice custom-
   section viewer reads plus admin create/edit/terminate, is implemented through the canonical REST
   handler and existing internal domain-event Queue. The first billing family,
   single-default-entity viewer reads plus admin updates, is also implemented through the canonical
   D1 handler. It exposes only supported legal, address,
   payment-term, numbering, locale, and document defaults; multi-entity, e-invoicing, tax-assignment,
   and external-action paths remain unavailable. Payment-receipt list/show metadata is implemented
   as the next read-only family, with document URLs, generation/download, email, and every mutation
   suppressed at the operator boundary. Manual-tax list/show plus admin create/edit/terminate is the
   next bounded catalog family, reusing the canonical D1 transaction, value-free outbox evidence,
   and producer-only Queue publication. Add-on list/show plus admin create/edit/terminate follows the
   same boundary while preserving canonical currency/in-use guards and rejecting tax-code targeting.
   Core customer list/show plus admin create/edit is implemented through the canonical D1 and Queue
   handler. Its BFF allowlist admits only identity, email, currency, timezone, and payment-term
   fields; provider, dunning, metadata, custom-section, tax-target, and deletion operations are
   rejected until their separate mappings are complete.
   Coupon catalog list/show plus admin create and customer-application list/apply/terminate are
   implemented as one bounded family. The operator Worker reuses the canonical coupon handler,
   publishes through the existing Queue, and reaches the API Worker’s `BILLING_ACCOUNTS` Durable
   Object through a cross-script binding for the same per-customer command reservation boundary.
   Coupon definitions are immutable after creation; plan- or billable-metric-targeted creation is
   admitted through the canonical contract, while edit/delete and customer targeting are not exposed.
   Core plan list/show/create/edit/delete and nested add-on-backed fixed-charge lifecycle are also
   implemented. The BFF rejects embedded usage-charge graphs, thresholds, commitments, taxes, and
   metadata pending their own mapped editors. In-use plan deletion preserves the canonical durable
   deletion task and calls the API Worker’s `PLAN_DELETION_WORKFLOW` through a cross-script binding;
   fixed-charge mutations retain their canonical cascade, pricing-model, and immediate-billing
   guards.
   Core subscription list/show/create/plan-change/update/cancel/terminate is implemented through the
   canonical D1, Queue, and per-customer Durable Object command boundary. Admin termination requires
   explicit final-invoice and prepaid-credit behavior. Provider payment methods, subscription custom
   sections, and usage-threshold overrides remain rejected at the BFF until separately admitted.
   Core invoice list/show plus admin one-off create, draft refresh/finalize, and finalized void is
   implemented through the canonical D1, Queue, and Durable Object boundaries. A successful
   payment remains independent settlement evidence after void. One-off
   creation is manual-only (`skip_psp: true`) and tenant-validated fee tax targeting is admitted. Document generation
   and download, payment URLs, provider payment retry, and email delivery remain separate actions
   and are not exposed by this family.
   Core wallet list/show/transaction reads plus admin manual granted-credit create/top-up/terminate
   is implemented through the canonical D1 and Queue ledger. Top-ups keep the canonical idempotency
   key requirement. Recurring grants, fee/metric targeting, invoice custom sections, paid credits,
   and provider funding are rejected until their separate operation mappings and safety gates exist.
   Core credit-note list/show plus admin itemized credit/offset allocation and fully-unconsumed
   credit-only void is implemented through the canonical D1 and Queue ledger, including creation
   idempotency, invoice-line remaining-amount guards, coupon/tax-adjusted estimates, and PDF
   generation/download. The provider-refund control remains visibly disabled because the deployed
   `CREDIT_NOTE_REFUND_MODE` is `disabled`; only the network-free sandbox adapter may admit it.
   Provider actions and email remain outside this operator family.
   Payment list/show is exposed as a read-only settlement ledger. Payment recording, payment-link
   creation, provider retry, and every other mutation remain unavailable in the operator Worker and
   retain their existing disabled external-action gates.
   Quote list/show plus admin idempotent draft create, owner/version edit, approve/void, and
   superseding clone is implemented through the canonical D1 and Queue REST replacement. No PDF,
   template, generation, download, email, or public-delivery behavior is invented for the operator
   surface.
   Data-export list/show plus admin idempotent CSV snapshot creation is implemented for the four
   retained export resources. Migration 0071 records mutually exclusive API-key or active operator-
   membership provenance, and the operator Worker dispatches the API Worker’s shared Document
   Workflow through a cross-script binding. Artifact download and completion email remain separate
   delivery actions and are not exposed.
   Webhook endpoint list/show is exposed read-only while outbound delivery is disabled. Endpoint
   mutation, signing-secret configuration, and delivery remain outside the operator Worker; no HMAC
   secret is accepted by or stored in the browser.
   Dunning campaign list/show plus admin create/edit/delete is implemented through the canonical D1
   policy handler. Payment requests are exposed read-only as scheduler evidence, and manual browser
   creation is rejected. Provider checkout remains behind the disabled payment-mutation gate;
   email/link delivery remains absent, and customer-specific assignment is still outside this
   bounded screen.
6. Add analytics/logging only after their bounded read models and retention/redaction contracts
   exist.
7. Do not remove a legacy product screen. Any future exception requires a new explicit product
   decision naming the screen, rationale, replacement or user impact, evidence, and rollback path.

## Rollback

The rollback is asset-first and does not change billing state: restore the script-free migration
shell while keeping Worker REST APIs available to verified service clients. If the Access bridge
is suspect, remove browser authorization/membership bindings or block the Access application; do
not weaken API-key authentication or expose an unauthenticated operator path. D1 membership and
audit rows remain evidence and are removed only by a separately approved cleanup.
