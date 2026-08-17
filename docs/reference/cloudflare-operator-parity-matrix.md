# Cloudflare Operator Product-Parity Matrix

Evidence date: 2026-08-18

This matrix records the product structure preserved from the checked-in Lago frontend while the
SERP billing runtime moves to the isolated Cloudflare stack. It is a porting record, not permission
to enable a provider, payment, email, document-delivery, production-data, or production-route
action.

## Product shell and tenancy

| Original Lago behavior             | Cloudflare operator behavior                                                                                                              | Evidence                                                                 |
| ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| Persistent grouped left navigation | Reports, Configuration, Billing & operations, and Settings are retained with original Lago SVG assets and selection treatment             | `front/src/layouts/MainNavLayout/`; `cloudflare/operator-app/index.html` |
| Organization-scoped workspace      | Every route is scoped as `/:organizationSlug/...`; the current membership is sent as `X-Operator-Organization`                            | `cloudflare/operator-app/assets/operator-app.js`                         |
| Organization switcher              | One Access identity can hold multiple active memberships and safely switch organizations                                                  | migration `0072`; `operator-access.test.ts`; local browser QA            |
| Tenant isolation                   | An unknown organization returns `403`; an unselected multi-membership API request returns `409`; object misses never query another tenant | `operator-access.test.ts`; customer and generic detail missing states    |
| List and entity pages              | Lists remain focused pages; admitted show contracts use deep-linkable entity pages with back navigation and browser history               | `customer-detail`, `entity-detail`, local route QA                       |
| Responsive navigation              | The sidebar becomes an off-canvas menu; actions stack; tables expose a horizontal-scroll hint                                             | 390 × 844 browser QA captures                                            |
| Typography and icons               | Inter is self-hosted under the restrictive CSP; visible UI icons are copied from the original Lago asset set                              | `operator-app/assets/fonts/`; `operator-app/assets/icons/`               |

## Navigation and route parity

| Lago area        | Cloudflare route                                                      | Current product state                                                                                                                            |
| ---------------- | --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| Analytics        | `/:org/analytics`                                                     | Original navigation position retained; explicit unavailable panel until the bounded D1 analytics read model exists                               |
| Forecasts        | `/:org/forecasts`                                                     | Original navigation position retained; explicit unavailable panel                                                                                |
| Billable metrics | `/:org/billable-metrics`                                              | Original navigation position retained; rating engine remains active, operator catalog editor unavailable                                         |
| Plans            | `/:org/plans` and `/:org/plans/:code`                                 | List, focused detail, create/edit/delete, and fixed-charge dialogs retained for the admitted core contract                                       |
| Features         | `/:org/features`                                                      | Original navigation position retained; entitlement authority remains in `serp-auth`                                                              |
| Add-ons          | `/:org/add-ons` and `/:org/add-ons/:code`                             | List, focused detail, create/edit/terminate                                                                                                      |
| Coupons          | `/:org/coupons` and `/:org/coupons/:code`                             | Definitions, customer applications, create/apply/terminate; immutable-definition boundary is visible                                             |
| Customers        | `/:org/customers`, `/:org/customers/:externalId`, optional detail tab | Original entity header, Overview/Wallets/Analytics/Invoices/Credit notes/Settings tabs, details rail, create/edit, and tenant-safe missing state |
| Subscriptions    | `/:org/subscriptions` and `/:org/subscriptions/:externalId`           | List, focused detail, create/edit/terminate or cancel with explicit termination options                                                          |
| Invoices         | `/:org/invoices` and `/:org/invoices/:lagoId`                         | List, focused detail, manual one-off create, draft refresh/finalize, unpaid finalized void                                                       |
| Payments         | `/:org/payments` and `/:org/payments/:lagoId`                         | Read-only settlement list/detail; payment links, retry, and manual settlement remain unavailable                                                 |
| Credit notes     | `/:org/credit-notes` and `/:org/credit-notes/:lagoId`                 | List, focused detail, internal-credit create and eligible void; refund/provider/document actions unavailable                                     |
| Wallets          | `/:org/wallets` and `/:org/wallets/:lagoId`                           | List, focused detail, granted-credit create/top-up/terminate; provider-funded and paid-credit paths unavailable                                  |
| Quotes           | `/:org/quotes` and `/:org/quotes/:lagoId`                             | List, focused detail, draft create/edit, approve/void, and version clone; PDF/email/public delivery unavailable                                  |
| Organization     | `/:org/overview`                                                      | Organization identity, currency, timezone, version, and membership-aware header                                                                  |
| Billing profile  | `/:org/billing-profile`                                               | Default billing-entity profile and admitted legal/address/payment/document settings                                                              |
| Invoice sections | `/:org/invoice-sections` and `/:org/invoice-sections/:code`           | List, focused detail, create/edit/terminate                                                                                                      |
| Taxes            | `/:org/taxes` and `/:org/taxes/:code`                                 | List, focused detail, create/edit/terminate                                                                                                      |
| API keys         | `/:org/api-keys` and `/:org/api-keys/:id`                             | Sanitized list/detail; admin create/rename/rotate/revoke; raw secrets remain one-time only                                                       |
| Payment receipts | `/:org/payment-receipts` and `/:org/payment-receipts/:lagoId`         | Read-only metadata list/detail; document URL, generation, download, and email unavailable                                                        |
| Data exports     | `/:org/data-exports` and `/:org/data-exports/:lagoId`                 | List, focused status detail, idempotent snapshot create; artifact delivery unavailable                                                           |
| Webhooks         | `/:org/webhook-endpoints` and `/:org/webhook-endpoints/:lagoId`       | Read-only endpoint list/detail; secret mutation and delivery controls unavailable                                                                |
| Dunning          | `/:org/dunning-campaigns` and `/:org/dunning-campaigns/:code`         | Campaign list/detail/create/edit/delete plus read-only payment-request ledger; provider collection and messaging flags stay disabled             |

## Preserved safety boundaries

- Cloudflare Access authenticates the separate operator Worker before its assets or REST BFF are
  exposed. There is no API-key login form, browser credential store, or operator bypass.
- The BFF reuses canonical tenant-scoped REST handlers. It does not add a parallel GraphQL billing
  authority or a second tenant selector.
- Admin controls remain hidden from viewer memberships and server-side role checks remain
  authoritative.
- Unsupported portions of an otherwise retained Lago screen stay visible as unavailable states.
  They are not removed from the information architecture and are not represented as implemented.
- Provider reads, provider mutations, customer messages, and document delivery remain controlled by
  the existing external-action flags, which must remain `0` for this isolated rollout.

## Visual and interaction evidence

- Original captures:
  `docs/evidence/cloudflare-operator-2026-08-18/04-original-lago-customer-usage.png` and
  `docs/evidence/cloudflare-operator-2026-08-18/05-original-lago-customer-billing.png`.
- Matched customer comparisons:
  `docs/evidence/cloudflare-operator-2026-08-18/14-customer-detail-comparison-final.png` and
  `docs/evidence/cloudflare-operator-2026-08-18/16-customer-analytics-comparison-final.png`.
- Responsive list/detail/navigation captures:
  `docs/evidence/cloudflare-operator-2026-08-18/09-operator-parity-navigation-mobile-fixed.png`,
  `docs/evidence/cloudflare-operator-2026-08-18/12-operator-customer-detail-mobile.png`, and
  `docs/evidence/cloudflare-operator-2026-08-18/17-operator-plans-mobile-overflow.png`.
- Browser checks cover direct deep links, reload, back/forward, customer tabs, organization switch,
  viewer action suppression, cross-tenant object misses, native dialogs, global Escape handling, and
  zero console errors in the exercised states.
