# Software-tax expansion evidence — 2026-09-06

Status: **local review candidate, not activated, not production-ready**.

## Result

Added official-source standard-rate evidence for 28 B2C software markets. The generator now
produces 60 country candidates and 120 classification rules, compared with 32/64 previously.
These are candidate standard rates, not approval to collect tax on every customer in those
countries. Territorial exclusions, customer type, delivery classification and the merchant's
collection obligations remain separate checks.

The retained aggregate contains 4,176 paid events: 4,077 across 108 identified countries/territories
and 99 with unknown location. The 60 candidate countries account for 1,781 events.
Neither this event sample nor the candidate dataset represents complete lifetime/worldwide
coverage. US (1,861 events) and Canada (178) remain priority gaps.

## New authority evidence

All source URLs, observation dates and scope caveats are in
[the versioned evidence file](../../cloudflare/fixtures/indirect-tax/software-rate-expansion-2026-09-06.json).
Observation date is not a historical statutory effective date. Candidate review does not
establish the merchant's registrations.

| Country | Standard-rate candidate | Authority |
| --- | ---: | --- |
| Australia | 10% | Australian Taxation Office |
| New Zealand | 15% | Inland Revenue |
| Norway | 25% | Norwegian Tax Administration |
| Singapore | 9% | IRAS |
| UAE | 5% | Federal Tax Authority |
| Malaysia | 8% | Royal Malaysian Customs |
| Philippines | 12% | Bureau of Internal Revenue |
| South Africa | 15% | SARS |
| Chile | 19% | SII |
| Iceland | 24% | Revenue and Customs |
| Kenya | 16% | KRA |
| Japan | 10% | National Tax Agency |
| Argentina | 21% | ARCA |
| Colombia | 19% | DIAN |
| Thailand | 7% | Revenue Department |
| Taiwan | 5% | Ministry of Finance Taxation Administration |
| Türkiye | 20% | Revenue Administration |
| Saudi Arabia | 15% | ZATCA |
| Ukraine | 20% | State Tax Service |
| Costa Rica | 13% | Ministry of Finance |
| Indonesia | 11% effective checkout rate (12% on a deemed 11/12 base) | Directorate General of Taxes |
| Serbia | 20% | Serbian Tax Administration |
| Kazakhstan | 16% | State Revenue Committee |
| Peru | 18% | SUNAT |
| Nigeria | 7.5% | National Assembly |
| Morocco | 20% | Directorate General of Taxes |
| Egypt | 14% | Egyptian Tax Authority |
| Ecuador | 15% | Internal Revenue Service |

For Indonesia, the [DGT digital-tax page](https://pajak.go.id/en/digitaltax) explicitly includes
computer software, applications and subscriptions in the covered digital products and explains
the appointed foreign PMSE collector boundary. The current calculation is 12% applied to a deemed
11/12 taxable base, yielding an 11% checkout amount; the accompanying
[DGT questions and answers](https://www.pajak.go.id/en/digital-tax-questions-and-answers) supplies
the consumer-transaction scope. This candidate does not claim that SERP has been appointed.

Serbia's [VAT law](https://purs.gov.rs/upload/media/2025/11/28/760480/Law_on_value_added_tax_-_Zakon_o_porezu_na_dodatu_vrednost.pdf)
sets a 20% general rate and locates electronically supplied services at the recipient. Kazakhstan's
[2026 VAT guidance](https://www.gov.kz/situations/817/intro?lang=en) sets the base rate at 16%, and
its [State Revenue Committee](https://www.gov.kz/memleket/entities/kgd/press/news/details/1078838?lang=ru)
confirms the foreign-internet-platform regime. Peru's
[2026 IGV page](https://www.gob.pe/institucion/sunat/pages/7910-impuesto-general-a-las-ventas-igv)
sets the combined rate at 18%, while [SUNAT's current nonresident register guidance](https://orientacion.sunat.gob.pe/listado-de-sujetos-no-domiciliados-inscritos-en-el-ruc)
expressly covers digital services and internet-supplied intangible goods to consumers. All three
remain draft candidates until registration and customer-evidence controls are approved.

Nigeria's [Tax Act 2025](https://nass.gov.ng/documents/download/11249) sets VAT at 7.5% and
expressly addresses nonresident taxable suppliers. Morocco's
[Finance Circular 735](https://www.finances.gov.ma/Publication/dgi/2024/Note-Circulaire735LF2024.pdf)
uses a downloaded mobile application as an in-scope remote service and defines the nonresident
registration, declaration and payment obligations. Both remain inactive candidates: supplier
appointment/registration, customer status, classification and invoicing must still be approved.

Egypt's [nonresident digital-services guide](https://portal.eta.gov.eg/sites/default/files/2023-03/digital-service-guide-english_0.pdf)
expressly includes online apps and software and applies the 14% general VAT rate to taxable B2C
supplies. Ecuador's [current SRI guidance](https://www.sri.gob.ec/o/sri-portlet-biblioteca-alfresco-internet/descargar?id=0f4f83f2-be64-45a5-8957-8200d5c3adcd&nombre=NAC-DGECCGC26-00000004.pdf)
states a 15% IVA rate for digital services, while its
[nonresident registration page](https://www.sri.gob.ec/web/intersri/registro-declaracion-y-pago-del-iva-prestadores-de-servicios-digitales-no-residentes)
documents the collection-agent route. Both remain inactive until the applicable registration,
customer-status and intermediary-withholding boundaries are confirmed.

The candidate classifications retain the engine's existing software code identifiers.
New rule labels refer to delivery (remote versus downloaded software), not billing frequency.
**The local runtime patch now requires explicit `plans.metadata_json.tax_code` rather than
selecting a code by plan interval. This patch is not deployed and existing plans have not been
backfilled. Missing or mixed classifications fail closed.**
A monthly downloadable application is not necessarily SaaS. Initial checkout and renewals
must use the same reviewed classification.

## Deliberately unresolved evidence, not fabricated fallback rates

- US: New York's [4% state rate](https://www.tax.ny.gov/bus/st/rates.htm) is only a component;
  local destination taxes may also apply. A postcode prefix must not be assumed to identify a
  legal tax boundary. The expansion builder rejects US national-rate insertion.
- California: [CDTFA Publication 109](https://cdtfa.ca.gov/formspubs/pub109/nontaxable-sales.htm),
  revised July 2026 and opened during this review, describes electronic-only software downloads
  as generally nontaxable. Physical-copy bundles differ. This is useful exemption evidence, not
  permission to make all US software zero-rated. No California production exemption was added.
  Future-effective software legislation also needs checking before a durable exemption rule.
- Canada: retained [CRA GST/HST components](https://www.canada.ca/en/revenue-agency/services/tax/businesses/topics/gst-hst-businesses/charge-collect-place-supply.html)
  cover all 13 provinces/territories, including Nova Scotia's 14% HST. Separate provincial taxes
  are not included. The builder cannot treat a federal 5% component as a Canadian total.
- Hong Kong: no-sales-tax evidence requires explicit non-collection semantics; it must not be
  represented by inventing a registration or treating missing rules as zero. A separate guarded
  candidate now supplies explicit zero-rate exemption rules for both software codes; the runtime
  still requires a matching enabled destination scope before it will return zero.
- Qatar: the [General Tax Authority](https://www.gta.gov.qa/en/investors-guide) states that VAT has
  not been applied. A separate guarded candidate now records explicit zero-tax software rules;
  it is not a missing-rate fallback and must be refreshed before activation because implementation
  of the GCC VAT framework would change the result.
- Vietnam: [Law 48/2024/QH15](https://vanban.chinhphu.vn/?docid=212476&pageid=27160), effective
  1 July 2025, places software products and software services outside VAT. A separate guarded
  candidate records explicit zero-tax rules for both software codes; this says nothing about
  corporate-income tax or foreign-supplier filing obligations.
- Fiji: FRCS's 12.5% standard rate is recorded separately; imported software supplier/recipient
  liability is not resolved, so it is not an activation rule.
- Remaining countries: the reproducible table below retains every gap instead of dropping
  destinations with little volume.

## Engineering and verification

### Runtime hardening (local only)

- Checkout reads an explicit, tenant-scoped plan classification. A one-time purchase can use
  the remote-software classification when explicitly configured; cadence is not its classifier.
- Renewal tax previously used the customer's latest committed checkout quote, even when it
  belonged to another subscription. It now requires its own subscription's committed quote and
  preserves that quote's product tax code and billing destination.
- Migration `0107_indirect_tax_collection_mode.sql` adds an explicit `collect`/`off` setting
  to collection scopes and snapshots it on checkout/renewal quotes. Defaults preserve existing
  behavior; no scope is activated or switched off by this migration.
- `off` retains the reviewed rate data but charges zero tax. It still requires an enabled scope
  and matching fresh rule. Inactive/unconfirmed scopes and missing rules are not zero-tax fallbacks.
- Quote identity includes collection mode. Existing committed or prepared payment amounts are
  not retrospectively rewritten by a switch; a fresh quote reflects the new mode.
- Negative subtotals, including exempt cases, and future-dated datasets are rejected.
- Full local gate passed: 472 Worker tests across 77 files, 27 tax-script tests, Access tests,
  checkout-message tests, inventory, formatting, lint, generated types, typecheck and all seven
  dry-run builds. A subsequent strengthened checkout regression also passed: the mocked EPD
  request charged exactly the new off-mode total, made no tax-provider request, and retained
  immutable collection-mode evidence. These are local synthetic tests, not live EPD transactions.

### Deployment prerequisites and owner

Lago owns classification metadata, rate data, collection settings and quote snapshots. No Store
or marketing-site change is included. Before deploying this runtime patch to any environment:

1. Review the generic plans' actual delivery model and populate explicit `metadata.tax_code`
   through the authorized plan workflow. Do not backfill from monthly/one-time intervals.
   A shared generic plan cannot mix different tax classifications without an additional
   server-owned product classification contract.
2. Apply migration 0107 with environment-specific approval, then deploy the matching Worker.
3. Exercise staging with fictional addresses, including collect/off, failed coverage,
   changed destinations, renewal isolation and refund evidence.
4. Complete US/Canadian destination rules and the remaining coverage/signing/refresh work.
   Only then propose the bounded production rollout. No production switch is included here.

There is no new dashboard collection-toggle UI in this patch. The database setting is the
runtime contract; an audited operator control remains follow-up work.

- Offline generator: `pnpm run tax-rules:expanded-candidate`.
- Reproducible expanded gap report: `pnpm run tax-rules:coverage -- --expanded`
  (or `node scripts/tax-coverage-review.mjs --expanded`).
- Code-owned authority host allowlist rejects insecure URLs, credentials, spoofed hosts and
  Stripe sources in the new dataset. Partial-rate/non-collection evidence is never imported by
  this expansion generator.
- Evidence older than 30 days or future-dated is rejected; retained source age is checked too.
  Re-running does not change the immutable candidate's effective date/checksum or claim that old
  components were freshly retrieved.
- The candidate remains draft-only. No collection registrations or activation statements are
  generated. This is a checksum, **not** cryptographic publisher signing.
- 27 tax-script tests passed in the preceding batch. The local D1 matrix tested the initial 11 additions with both software
  codes, exact tax/total arithmetic, and missing-registration rejection.
- Full Lago gate passed: 466 Worker tests across 77 files, format, lint, Access tests,
  checkout-error tests, inventory, tax checks, generated-type checks, typecheck and all seven
  dev/production dry-run builds.
- A further bounded public EU TEDB refresh failed with `fetch failed`. The retained EU snapshot
  was preserved with its actual timestamp, not relabeled fresh.

No deployment, remote database change, tax registration, Stripe API request, purchase or customer
message was performed for this expansion. Changes are local in `codex/production-epd-canary`.
The previously committed checkout error-message fix also still requires staged deployment.

## Completion boundary

This work improves evidence and local validation; it does **not** close the tax rollout plan.
Remaining implementation: broader US/local boundary handling, explicit product delivery
classification rollout, source refresh ownership/automation, real publisher-key ownership, and
the remaining country research. Canadian levy composition, no-collection semantics, Washington
address resolution and local signature verification are now implemented locally. Actual collection scopes
must then be confirmed from the merchant's registrations/obligations, followed by the exact
approved staging import/verification and separately approved production rollout.

## Retained-geography audit

Known countries/territories: 108; retained successful payment events: 4176.
Countries with both existing candidate classifications: 60. Candidate presence does not mean production ready.

This is an offline gap report, not an importable rate set, registration, or collection instruction. No Stripe API calls. Lifetime history is incomplete. Unknown locations remain explicit.

| Country | Paid events | Invoice events | One-time checkouts | Remote-software candidate | Downloaded-software candidate |
| --- | ---: | ---: | ---: | --- | --- |
| US | 1861 | 1756 | 105 | authority_review_incomplete | authority_review_incomplete |
| GB | 268 | 250 | 18 | existing_candidate_unapproved | existing_candidate_unapproved |
| AU | 203 | 185 | 18 | existing_candidate_unapproved | existing_candidate_unapproved |
| CA | 178 | 168 | 10 | authority_review_incomplete | authority_review_incomplete |
| DE | 140 | 129 | 11 | existing_candidate_unapproved | existing_candidate_unapproved |
| UNKNOWN | 99 | 80 | 19 | location_missing | location_missing |
| FR | 96 | 89 | 7 | existing_candidate_unapproved | existing_candidate_unapproved |
| ES | 65 | 62 | 3 | existing_candidate_unapproved | existing_candidate_unapproved |
| IN | 63 | 55 | 8 | existing_candidate_unapproved | existing_candidate_unapproved |
| KR | 52 | 50 | 2 | existing_candidate_unapproved | existing_candidate_unapproved |
| CH | 49 | 46 | 3 | existing_candidate_unapproved | existing_candidate_unapproved |
| MX | 49 | 47 | 2 | existing_candidate_unapproved | existing_candidate_unapproved |
| NL | 49 | 47 | 2 | existing_candidate_unapproved | existing_candidate_unapproved |
| BR | 45 | 34 | 11 | authority_review_incomplete | authority_review_incomplete |
| AE | 37 | 35 | 2 | existing_candidate_unapproved | existing_candidate_unapproved |
| BE | 37 | 37 | 0 | existing_candidate_unapproved | existing_candidate_unapproved |
| SG | 37 | 36 | 1 | existing_candidate_unapproved | existing_candidate_unapproved |
| PH | 35 | 30 | 5 | existing_candidate_unapproved | existing_candidate_unapproved |
| JP | 33 | 28 | 5 | existing_candidate_unapproved | existing_candidate_unapproved |
| PL | 33 | 29 | 4 | existing_candidate_unapproved | existing_candidate_unapproved |
| AR | 32 | 31 | 1 | existing_candidate_unapproved | existing_candidate_unapproved |
| CN | 32 | 29 | 3 | authority_review_incomplete | authority_review_incomplete |
| HK | 31 | 27 | 4 | authority_review_incomplete | authority_review_incomplete |
| IT | 29 | 27 | 2 | existing_candidate_unapproved | existing_candidate_unapproved |
| TH | 24 | 22 | 2 | existing_candidate_unapproved | existing_candidate_unapproved |
| ZA | 24 | 23 | 1 | existing_candidate_unapproved | existing_candidate_unapproved |
| IE | 23 | 22 | 1 | existing_candidate_unapproved | existing_candidate_unapproved |
| MY | 22 | 19 | 3 | existing_candidate_unapproved | existing_candidate_unapproved |
| VN | 21 | 18 | 3 | authority_review_incomplete | authority_review_incomplete |
| CZ | 20 | 19 | 1 | existing_candidate_unapproved | existing_candidate_unapproved |
| NO | 20 | 20 | 0 | existing_candidate_unapproved | existing_candidate_unapproved |
| RO | 20 | 19 | 1 | existing_candidate_unapproved | existing_candidate_unapproved |
| CO | 18 | 17 | 1 | existing_candidate_unapproved | existing_candidate_unapproved |
| TR | 18 | 15 | 3 | existing_candidate_unapproved | existing_candidate_unapproved |
| FI | 17 | 17 | 0 | existing_candidate_unapproved | existing_candidate_unapproved |
| NZ | 17 | 15 | 2 | existing_candidate_unapproved | existing_candidate_unapproved |
| TW | 17 | 15 | 2 | existing_candidate_unapproved | existing_candidate_unapproved |
| ID | 16 | 15 | 1 | existing_candidate_unapproved | existing_candidate_unapproved |
| IL | 16 | 16 | 0 | source_research_required | source_research_required |
| CL | 14 | 14 | 0 | existing_candidate_unapproved | existing_candidate_unapproved |
| GR | 14 | 10 | 4 | existing_candidate_unapproved | existing_candidate_unapproved |
| PT | 14 | 14 | 0 | existing_candidate_unapproved | existing_candidate_unapproved |
| RS | 14 | 13 | 1 | existing_candidate_unapproved | existing_candidate_unapproved |
| KZ | 13 | 12 | 1 | existing_candidate_unapproved | existing_candidate_unapproved |
| PE | 13 | 13 | 0 | existing_candidate_unapproved | existing_candidate_unapproved |
| SE | 13 | 13 | 0 | existing_candidate_unapproved | existing_candidate_unapproved |
| BG | 12 | 12 | 0 | existing_candidate_unapproved | existing_candidate_unapproved |
| SA | 12 | 11 | 1 | existing_candidate_unapproved | existing_candidate_unapproved |
| UA | 12 | 11 | 1 | existing_candidate_unapproved | existing_candidate_unapproved |
| FJ | 10 | 10 | 0 | authority_review_incomplete | authority_review_incomplete |
| PK | 10 | 10 | 0 | source_research_required | source_research_required |
| CR | 8 | 8 | 0 | existing_candidate_unapproved | existing_candidate_unapproved |
| MA | 8 | 8 | 0 | existing_candidate_unapproved | existing_candidate_unapproved |
| MO | 8 | 8 | 0 | source_research_required | source_research_required |
| DK | 7 | 5 | 2 | existing_candidate_unapproved | existing_candidate_unapproved |
| KW | 7 | 7 | 0 | source_research_required | source_research_required |
| SI | 7 | 7 | 0 | existing_candidate_unapproved | existing_candidate_unapproved |
| SK | 7 | 6 | 1 | existing_candidate_unapproved | existing_candidate_unapproved |
| GT | 6 | 5 | 1 | source_research_required | source_research_required |
| HR | 6 | 6 | 0 | existing_candidate_unapproved | existing_candidate_unapproved |
| HU | 6 | 5 | 1 | existing_candidate_unapproved | existing_candidate_unapproved |
| LB | 6 | 6 | 0 | source_research_required | source_research_required |
| NG | 6 | 5 | 1 | existing_candidate_unapproved | existing_candidate_unapproved |
| AT | 5 | 5 | 0 | existing_candidate_unapproved | existing_candidate_unapproved |
| CY | 5 | 5 | 0 | existing_candidate_unapproved | existing_candidate_unapproved |
| BA | 4 | 4 | 0 | source_research_required | source_research_required |
| EC | 4 | 4 | 0 | existing_candidate_unapproved | existing_candidate_unapproved |
| EG | 4 | 3 | 1 | existing_candidate_unapproved | existing_candidate_unapproved |
| PR | 4 | 4 | 0 | source_research_required | source_research_required |
| PY | 4 | 3 | 1 | source_research_required | source_research_required |
| QA | 4 | 4 | 0 | source_research_required | source_research_required |
| EE | 3 | 3 | 0 | existing_candidate_unapproved | existing_candidate_unapproved |
| IS | 3 | 3 | 0 | existing_candidate_unapproved | existing_candidate_unapproved |
| JM | 3 | 3 | 0 | source_research_required | source_research_required |
| MT | 3 | 3 | 0 | existing_candidate_unapproved | existing_candidate_unapproved |
| PA | 3 | 3 | 0 | source_research_required | source_research_required |
| SV | 3 | 3 | 0 | source_research_required | source_research_required |
| VE | 3 | 3 | 0 | source_research_required | source_research_required |
| AW | 2 | 2 | 0 | source_research_required | source_research_required |
| BD | 2 | 2 | 0 | source_research_required | source_research_required |
| BJ | 2 | 2 | 0 | source_research_required | source_research_required |
| CD | 2 | 2 | 0 | source_research_required | source_research_required |
| DO | 2 | 2 | 0 | source_research_required | source_research_required |
| DZ | 2 | 2 | 0 | source_research_required | source_research_required |
| GE | 2 | 2 | 0 | source_research_required | source_research_required |
| KY | 2 | 2 | 0 | source_research_required | source_research_required |
| LT | 2 | 2 | 0 | existing_candidate_unapproved | existing_candidate_unapproved |
| MN | 2 | 2 | 0 | source_research_required | source_research_required |
| UY | 2 | 1 | 1 | source_research_required | source_research_required |
| AD | 1 | 1 | 0 | source_research_required | source_research_required |
| BF | 1 | 1 | 0 | source_research_required | source_research_required |
| BN | 1 | 1 | 0 | source_research_required | source_research_required |
| ET | 1 | 1 | 0 | source_research_required | source_research_required |
| GA | 1 | 1 | 0 | source_research_required | source_research_required |
| GP | 1 | 1 | 0 | source_research_required | source_research_required |
| KE | 1 | 0 | 1 | existing_candidate_unapproved | existing_candidate_unapproved |
| KG | 1 | 1 | 0 | source_research_required | source_research_required |
| LU | 1 | 1 | 0 | existing_candidate_unapproved | existing_candidate_unapproved |
| LV | 1 | 1 | 0 | existing_candidate_unapproved | existing_candidate_unapproved |
| ME | 1 | 1 | 0 | source_research_required | source_research_required |
| MK | 1 | 1 | 0 | source_research_required | source_research_required |
| MM | 1 | 1 | 0 | source_research_required | source_research_required |
| MU | 1 | 1 | 0 | source_research_required | source_research_required |
| RE | 1 | 1 | 0 | source_research_required | source_research_required |
| SL | 1 | 1 | 0 | source_research_required | source_research_required |
| TT | 1 | 1 | 0 | source_research_required | source_research_required |
| TZ | 1 | 1 | 0 | source_research_required | source_research_required |
| UZ | 1 | 1 | 0 | source_research_required | source_research_required |
| VU | 1 | 1 | 0 | source_research_required | source_research_required |
