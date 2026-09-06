# Expanded indirect-tax staging rollout

Date: 2026-09-06

## Scope and safety boundary

- Branch: `codex/production-epd-canary`
- Deployed code commit: `6e04771` (`fix(checkout): clear stale totals after address changes`)
- Staging Worker only: `serp-dev-lago-native`
- No production Worker, D1 database, Store route, secret, payment-provider mode, or DNS setting was
  changed.
- Easy Pay Direct remained in `gateway_test` mode and
  `EASY_PAY_DIRECT_LIVEMODE_ALLOWED=0` remained enforced.
- No card details were submitted and no payment transaction was attempted.
- The staging billing-address encryption secret was installed without displaying or recording its
  value.

## Deployed state

- Worker version: `b69c51da-1630-402d-b778-66f3c7e4b4ce`
- Tax mode: `enforced`
- Tax provider: `local_d1`
- Automatic collection scope: `scoped`
- Active signed rule set: `software-us-partial-candidate-2026-09-06-v22`
- Active rule-set version: 22
- Rules: 157
- Enabled registration scopes: 67
  - `collect`: 63
  - `off`: 4
- Generic Lago plans carrying a tax code: 13
- Staging D1 migrations: none pending
- Staging D1 foreign-key violations: none
- `/health`: healthy
- `/ready`: ready

## Browser acceptance matrix

All checks used a fresh one-time $9 staging checkout routed through the customer-facing EPD test
form. The payment button state was checked, but the payment button was never pressed.

| Destination | Expected result | Observed result |
| --- | --- | --- |
| United Kingdom | 20% tax | $1.80 tax, $10.80 total, payment enabled |
| Germany | 19% tax | $1.71 tax, $10.71 total, payment enabled |
| Hong Kong | zero tax | $0.00 tax, $9.00 total, payment enabled |
| Canada, British Columbia | combined software tax | $1.08 tax, $10.08 total, payment enabled |
| United States, California | exempt under the active software rule | $0.00 tax, $9.00 total, payment enabled |
| United States, Connecticut | 6.35% tax | $0.57 tax, $9.57 total, payment enabled |
| United States, Washington | address-resolved official rate | address correction required once, then $0.95 tax and $9.95 total, payment enabled |
| United States, New York | no enabled collection scope | honest coverage error, all totals shown as `—`, payment disabled |

The same fresh checkout was also changed from Germany back to Washington. The form required the
Washington address correction again, then converged to the same $0.95 tax and $9.95 total. This
confirms that switching countries does not reuse a stale quote.

## Washington authority proof

The deployed Worker resolved the Seattle address through the Washington Department of Revenue
address-rate service and persisted only auditable rate metadata plus an encrypted billing address:

- Calculation method: `wa_dor_address`
- Location code: `1726`
- Jurisdiction: `Seattle, King`
- Rate period: `Q32026`
- State rate: 6.50%
- Local rate: 4.05%
- Combined rate: 10.55%
- $9.00 subtotal: $0.95 tax, $9.95 total
- Stored quote status: `applied`
- Encrypted address fields present: yes
- Plaintext address was not queried or printed during the audit.

## Fail-closed and UI-truth checks

- An unsupported New York destination cannot proceed to payment.
- As soon as any billing-address field changes, tax, total due, and the headline total are cleared
  to `—`; a failed quote can no longer leave another jurisdiction's amounts visible.
- Washington authority fetch, response parsing, address encryption, and D1 quote storage failures
  are converted to controlled checkout errors instead of unhandled responses.
- Operational error logs carry bounded categories and identifiers, not billing-address or secret
  contents.
- The original synthetic provider simulator remains separate from the customer-facing EPD test
  checkout.

## Automated verification

- Formatting: 262 files checked, all correct.
- Lint: zero warnings or errors.
- Type generation and TypeScript checks: passed.
- Vitest: 81 files, 515 tests, all passed.
- Access fail-closed tests: 5 passed.
- Checkout UI tests: 4 passed.
- Feature inventory and parity checks: current.
- Tax rule validation and artifact-signing checks: passed.
- Development API, operator, and portal dry builds: passed.
- Production API, operator bootstrap, operator, and portal dry-run builds: passed. These were build
  checks only; nothing was deployed to production.

## Acceptance conclusion

The expanded local-D1 tax path is accepted for staging. The exact deployed Worker version passed
the final browser checks, health/readiness checks, migration audit, and foreign-key audit.

Production activation remains a separate operation. Before enabling collection in production,
the production collection scopes must reflect registrations the business actually holds, the
production rule artifact and address-encryption secret must be installed, and the production
canary must be explicitly authorized and observed. This staging evidence does not itself authorize
production collection.
