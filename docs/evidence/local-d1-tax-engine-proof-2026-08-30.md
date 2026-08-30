# Local D1 tax engine proof

Date: 2026-08-30

## Result

The Lago/EPD checkout can calculate destination tax from D1, atomically replace the signed checkout
with the tax-inclusive total, charge that exact amount through the EPD gateway-test adapter, and
commit the local quote without calling Stripe.

This is a code-and-test proof only. It is not a deployed rate service and contains no production tax
dataset.

## Data model

- `indirect_tax_rule_sets` versions every dataset and records source, publication, effective,
  checksum, refresh, and activation metadata.
- `indirect_tax_rules` records country, optional region/postal prefix, product tax code, taxability,
  rate in parts per million, priority, effective window, and public source reference.
- `indirect_tax_registration_scopes` separately authorizes collection for an organization and
  jurisdiction. Rate availability alone never enables collection.
- EPD tax quotes retain the exact local rule-set and rule IDs used.

## Behavioral proof

- The local calculator uses integer arithmetic and nearest-minor-unit rounding.
- A synthetic 6.625% rule calculates USD 0.60 on USD 9.00.
- Postal-prefix rules override region rules.
- Zero tax requires an explicit exempt rule.
- Missing registration, missing rule, stale dataset, and equally specific conflicting rules fail
  closed.
- The end-to-end synthetic checkout reprices USD 19.99 plus 10% tax to USD 21.99, submits exactly
  USD 21.99 to the EPD gateway-test adapter, and performs one provider request total. Stripe is not
  called for calculation or commit.

## Safety boundary

- Staging remains configured for the existing `stripe_test` provider until a reviewed rate dataset
  and importer exist.
- Production remains `EASY_PAY_DIRECT_TAX_MODE=disabled`.
- No remote D1 migration, data load, Worker deployment, provider call, card submission, secret
  change, `store-new` change, or `serp-auth` change was performed for this proof.

## Remaining work

The hard part is not arithmetic. Before this can replace Stripe Tax in staging, SERP needs an
approved, maintainable source for all intended jurisdictions, a versioned importer, ownership of the
refresh/review process, and a bounded comparison report. Stripe sandbox can validate selected
examples but must not become the production source dataset.

The initial source hierarchy under review is:

- US member-state rates and boundaries from the
  [Streamlined Sales Tax Governing Board's published files](https://www.streamlinedsalestax.org/Shared-Pages/rate-and-boundary-files/rate-and-boundary-file-updates),
  with non-member states supplied from their own revenue authorities.
- EU VAT rates from the
  [European Commission Taxes in Europe Database](https://taxation-customs.ec.europa.eu/taxation/vat/vat-directive/vat-rates_en),
  whose data is supplied by member states.
- Country tax-authority sources for the UK, Australia, and other non-EU markets.

Rates and address boundaries do not by themselves answer product taxability or registration
obligations; those remain separate reviewed inputs.

## Verification

- Focused local/Stripe test files: 8 tests passed.
- TypeScript, lint, generated binding types, formatting, and all staging/production dry-run Worker
  builds passed.
- Migrations `0001` through `0101` applied cleanly to a fresh temporary local D1 database, and
  `PRAGMA foreign_key_check` returned no rows.
- Full suite: 424 of 427 tests passed. The same three pre-existing failures remain outside this tax
  work: two invoice-number collisions in subscription termination and one missing credit
  application in a second plan upgrade.
