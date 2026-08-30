# Local D1 Tax Staging Enforcement

Date: 2026-08-31 (Fiji)

## Deployment

- Worker: `serp-dev-lago-native`
- Version: `2ca86009-37b8-480f-bcbf-f27b07d0f6ca`
- Tax mode: `enforced`
- Tax provider: `local_d1`
- EPD network mode: `gateway_test`
- EPD live mode allowed: `0`
- API readiness: HTTP 200
- Unauthenticated operator request: HTTP 302 to Cloudflare Access

Production remained on `EASY_PAY_DIRECT_TAX_MODE=disabled`. No live card, payment submission,
production database, production route, production secret, `store-new`, or `serp-auth` mutation was
part of this activation.

## Staging data

- Applied migrations: `0101_local_indirect_tax_rules.sql` and
  `0102_indirect_tax_null_identity_guards.sql`
- Pending migrations after apply: none
- Active rule set: `priority-market-candidate-2026-08-31-v2`, version 2
- Checksum: `3ed5b218afe287548c7b44f88c76064805bf132da92338d3ecbd04784ab25d93`
- Rules: 64 across 32 countries and 2 product tax codes
- Enabled scopes: 32, all limited to `org-synthetic-e2e-20260815-001`
- Scope reference:
  `staging-synthetic-qa-only:not-a-legal-registration:priority-market-review-2026-08-31`
- Foreign-key violations: 0
- Duplicate normalized rule or scope identities: 0

Version 1 was retired and its 32 synthetic scopes were disabled. Its midnight UTC effective time
was still in the future at the Cloudflare edge even though it was already August 31 in Fiji. Version
2 uses the source snapshot's actual UTC retrieval instant. The runtime's future-effective guard was
not bypassed.

The synthetic scopes are QA fixtures. They are not legal registrations and must never be copied to
production as registration evidence.

## Benchmark and checkout matrix

Stripe Tax sandbox returned zero for Great Britain, Germany, France, India, South Korea, Mexico,
and Switzerland because the test account had only a California sandbox registration. Those values
were recorded as a registration-awareness check, not accepted as rate evidence.

The real Pornhub Downloader staging Store route created a fresh Lago/EPD one-time checkout. No
contact or card data was entered and Pay was not submitted. The enforced local results were:

| Destination | Subtotal | Tax | Total | Reviewed rate |
| --- | ---: | ---: | ---: | ---: |
| Great Britain | $9.00 | $1.80 | $10.80 | 20% |
| Germany | $9.00 | $1.71 | $10.71 | 19% |
| France | $9.00 | $1.80 | $10.80 | 20% |
| India | $9.00 | $1.62 | $10.62 | 18% |
| South Korea | $9.00 | $0.90 | $9.90 | 10% |
| Mexico | $9.00 | $1.44 | $10.44 | 16% |
| Switzerland | $9.00 | $0.73 | $9.73 | 8.1% |

Every persisted quote identified `local_d1`, the immutable rule set, and the exact rule. Requoting
superseded the prior checkout atomically, leaving one active Great Britain quote for $10.80.

An unsupported United States address returned HTTP 503 and left Pay disabled. The previous valid
amount remained visible but could not be submitted after the address changed. A final Great Britain
quote restored a valid $10.80 total and ready EPD test fields for visual review.

## Quality gate and rollback

Formatting, lint, access tests, inventory checks, tax rule tests, generated binding checks,
typecheck, the full test suite, and all staging and production dry-run builds passed before the
staging deployment.

Rollback for new staging checkouts is to set `EASY_PAY_DIRECT_TAX_MODE=disabled` or `shadow` and
redeploy. Historical quotes and rule sets must remain immutable. If needed, restore Worker version
`0b31a222-1ed1-4724-82a9-078ec67430d7`; do not reuse an already repriced checkout.
