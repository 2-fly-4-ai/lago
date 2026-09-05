# Canadian software tax components — 2026-09-06

Status: local draft and migrated-D1 tests only. No remote activation or production change.

## Result and scope

The combined candidate contains 61 countries and 146 software rules: the expanded 60-country,
120-rule draft plus two classifications for each of Canada's 13 provinces and territories.
The offline coverage report retains all 108 recorded destinations; these 61 countrywide candidate
countries account for 1,959 paid events in the retained aggregate. That is not a complete lifetime sample.
This is not worldwide completion. The scope is B2C prewritten electronically delivered software,
not physical goods, custom work, resale or multi-jurisdiction business use.

| Destination | Components |
| --- | --- |
| AB, NT, NU, YT | GST 5% |
| BC | GST 5% + PST 7% |
| MB | GST 5% + RST 7% |
| NB, NL, PE | HST 15% |
| NS | HST 14% |
| ON | HST 13% |
| QC | GST 5% + QST 9.975% |
| SK | GST 5% + PST 6% |

## Authority evidence

Sources were reviewed on 2026-09-06 Fiji time (2026-09-05 UTC). The fixture records the UTC date;
the offline review CLI evaluates freshness using SERP's Fiji operating date. This is not the
statutory date on which each tax first became effective.

- [CRA's province/territory rate table](https://www.canada.ca/en/revenue-agency/services/tax/businesses/topics/gst-hst-businesses/charge-collect-which-rate/calculator.html)
  supplies the current federal and provincial rates, including Nova Scotia's April 2025 change.
- [CRA cross-border digital products and services](https://www.canada.ca/en/revenue-agency/services/tax/businesses/topics/gst-hst-businesses/digital-economy-gsthst/charge-collect/cross-border.html)
  describes recipient location and customer-status distinctions.
- [BC software bulletin](https://www2.gov.bc.ca/gov/content/taxes/sales-taxes/pst/publications/software)
  covers prewritten downloaded and remotely accessed software.
- [Manitoba Bulletin 033](https://www.gov.mb.ca/finance/taxation/pubs/bulletins/033.pdf)
  covers computer software and cloud-computing treatment. Its cloud-computing change is effective
  January 2026; do not apply this current candidate to older purchases.
- [Saskatchewan PST](https://www.saskatchewan.ca/business/taxes-licensing-and-reporting/provincial-taxes-policies-and-bulletins/provincial-sales-tax)
  gives 6%; [PST-7 Computer Services](https://sets.saskatchewan.ca/rptp/wcm/connect/8a78bed5-fec6-4efc-9db1-faa14990f979/PST.007%2BComputer%2BServices%2B%25281%2529.pdf?CACHE=NONE&CONTENTCACHE=NONE&MOD=AJPERES&attachment=true)
  addresses licensed, downloaded and remotely accessed software.
- [Revenu Québec calculation guidance](https://www.revenuquebec.ca/en/businesses/consumption-taxes/gsthst-and-qst/collecting-gst-and-qst/calculating-the-taxes/)
  specifies GST/QST on the same pre-tax base and rounding. The implementation uses separate levy
  calculations, not QST on a GST-inclusive base.

## Engineering changes

- Migration 0108 stores immutable per-rule levy components. Components may only be inserted for
  a Canadian draft rule, and cannot be updated/deleted. New evidence requires a new version.
- Component definitions and their source identifiers are embedded in the rule's checksummed
  `source_reference`. The importer validates them before emitting a draft-only SQL batch.
- Each levy rounds independently in integer minor units. For example, on a 10-cent BC subtotal,
  GST and PST round to one cent each; a combined 12% calculation would incorrectly yield one cent.
- The runtime rejects taxable Canadian rules without valid matching components. It never treats
  a missing province or missing provincial levy as federal-only coverage.
- Collection-off retains the reviewed rule and returns zero tax with a different quote identity.
  Missing component evidence still fails validation in off mode.
- The existing quote stores the immutable rule ID. Component provenance is recoverable through
  that rule. Customer-facing per-levy display/reporting has not been added in this patch.
- The current scope switch is whole-jurisdiction collect/off. A federal-only collection scope
  in a province with a separate levy needs a per-levy configuration contract before activation;
  do not assume every collector must collect both.

## Reproduction and rollout order

From the Mac Mini SSD checkout's `cloudflare` directory:

```sh
pnpm run tax-rules:canada-candidate
node scripts/tax-coverage-review.mjs --canada
node --test scripts/canada-software-candidate.node-test.mjs
pnpm exec vitest run test/canada-software-tax.test.ts test/plan-tax-classifications.test.ts
pnpm run check
```

The CLI prints a draft JSON artifact only. `renderCanadianDraftSql` renders its rules and
components as one transactional import. The generic renderer now rejects Canadian taxable
artifacts unless called by the component-aware path, preventing an import that omits levy rows.
No activation/scope statements are generated.

Validation: 18 Canadian migrated-D1 tests and five Canadian generator tests pass, including the
server's actual UTC date. The full local gate passes 495 Worker tests across 79 files, 32 tax-data
tests, Access/checkout-message tests, inventory, lint, formatting, typecheck, generated types and
seven dry-run builds. These results are not an EPD staging purchase or production verification.

Before an authorized staging rollout: verify exact target plans; apply migrations 0107/0108;
apply the guarded classification metadata; import the combined draft with components; configure
only approved synthetic test scopes; activate the matching ruleset; deploy the matching Worker;
then test real staged checkout, renewals and collect/off behavior. Preserve existing production
plans, product routing and provider credentials. Old active Canadian taxable rules without levy
components are not compatible with this runtime and must not be left active during rollout.

## Still open

US destination tax requires state/local boundaries, not a national rate or guessed ZIP prefix.
[New York's own rate publication](https://www.tax.ny.gov/pdf/publications/sales/pub718.pdf)
explicitly warns ZIP areas need not match taxing jurisdictions. The current checkout collects
country/state/postcode; address-level resolution remains a genuine implementation/data gap.
The rest of the retained 108-country geography is still tracked by the gap report, including
unknown locations. Publisher signing, durable refresh ownership and staged verification remain
open. This document does not mark the broader tax plan complete.
