# Tax Product Classification and Registration Review

Date: 2026-08-31

## Outcome

The EPD tax path no longer assigns the same product tax code to recurring and one-time purchases.
It resolves the candidate classification from the Lago plan interval:

| Lago plan interval | Candidate Stripe taxonomy reference | Description |
| ------------------ | ----------------------------------- | ----------- |
| weekly/monthly/quarterly/yearly | `txcd_10103100` | SaaS, electronic download, personal use |
| `one_time` | `txcd_10202000` | Downloadable software, personal use |

The recurring mapping matches the current SERP 1-App contract: a customer subscribes to one generic
premium app and retains access while the subscription remains active. The one-time mapping is kept
separate for permanent software purchases. These are concrete taxonomy candidates, not a legal
conclusion that every jurisdiction taxes either category at its standard rate.

If Lago cannot resolve a supported plan interval, the tax quote returns
`checkout_tax_classification_missing`. If the relevant configured code is absent or invalid, it
returns `checkout_tax_code_missing`. It does not fall back to the other purchase type.

## Registration separation

The generated registration review covers six market groups and 32 destination countries:

- EU OSS: 27 EU destination countries;
- Great Britain;
- India;
- South Korea;
- Mexico;
- Switzerland.

Every group is `unconfirmed`, collection is `disabled`, and the artifact has no organization
target, registration reference, reviewed timestamp, or effective date. Its checksum is
`8eac3fbaf1271160aac5926775885a9239981f3cc670466d1bf9ba735046473d`.

The review artifact is not accepted by the draft rule importer and cannot create D1 registration
scopes. Authority registration confirmation and an action-time environment approval are required
before producing any scope SQL.

## Verification

- The EPD destination-tax integration tests pass, including recurring/one-time code selection,
  missing-classification rejection, local D1 calculation, and Stripe-test-only calculation.
- The local calculator tests pass.
- Fourteen source/import/registration tests pass.
- The generated priority candidate contains 64 rules: both product codes for 32 countries.
- The complete application suite is 425/428 after adding the new passing classification test. The
  only failures remain the same two invoice-number uniqueness cases in
  `subscription-lifecycle.test.ts` and the same missing credit application in
  `subscription-plan-change.test.ts` recorded before this phase.

## Safety boundary

The production configuration continues to set `EASY_PAY_DIRECT_TAX_MODE=disabled`. No Worker was
deployed, no remote migration or D1 write ran, no tax registration or collection scope was added,
and no Stripe or EPD request was made.

## Canonical taxonomy references

- Stripe product tax codes: <https://docs.stripe.com/tax/tax-codes?type=digital>
- Stripe product tax code and tax-behavior guidance:
  <https://docs.stripe.com/tax/products-prices-tax-codes-tax-behavior>
