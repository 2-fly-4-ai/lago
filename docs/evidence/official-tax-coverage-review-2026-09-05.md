## Review notes — 2026-09-05

User decision: use official tax authorities; no additional Stripe Tax requests, including sandbox benchmarking. Existing direct Stripe checkout is not being removed.

This audit uses aggregate country counts from already retained Store webhook records. It contains no customer records, secrets or raw webhook payloads. It is not a complete lifetime export: 4,176 retained paid events cover 108 known countries/territories, plus 99 events with no country. Subscription checkout events are excluded to avoid double-counting their invoices. Counts are events, not customers or net sales.

Existing candidate: EU27 plus GB, CH, IN, KR and MX (32 countries, two software-code slots). Additional authority research is recorded for US, AU, CA, NZ, NO, SG, AE, JP, PH, BR, HK, ZA, TH, MY, VN and CN. These 16 entries are research evidence, not activated rules. The other 60 observed countries still require source research. Worldwide coverage is not complete.

Sources and caveats: [authority review fixture](../../cloudflare/fixtures/indirect-tax/authority-review-2026-09-05.json). Reproduce the table with `cd cloudflare && pnpm tax-rules:coverage`; use `node scripts/tax-coverage-review.mjs --json` for source URLs and per-classification details.

Important unresolved requirements:

- US state/local rates, boundaries and software taxability; SST does not cover every state. California electronic-only software and New York prewritten software cannot share one blanket rule.
- Canada province-dependent GST/HST plus separate provincial taxes.
- Monthly versus one-time billing does not establish SaaS versus downloaded-software classification. The table labels describe current code slots, not a legal determination.
- A no-VAT regime (for example Hong Kong) needs an explicit reviewed non-collection policy, not an invented registration or a missing-data fallback to zero.
- Effective dates, regional exceptions, B2B treatment, actual collection registrations, artifact signing and a named refresh owner remain gates before production activation.
- EU TEDB live refresh was attempted twice on 2026-09-05 and failed with a network fetch error. The existing checked snapshot was preserved, not relabeled as fresh.
- No new country rules, registrations, tax activations or production changes were made in this audit.

Validation: 21/21 tax script tests passed, including four new coverage-audit tests; formatting and lint passed. The audit generator is offline-only and emits no activation SQL.

# Official-source tax coverage review

Known countries/territories: 108; retained successful payment events: 4176.
Countries with both existing candidate classifications: 32. Candidate presence does not mean production ready.

This is an offline gap report, not an importable rate set, registration, or collection instruction. No Stripe API calls. Lifetime history is incomplete. Unknown locations remain explicit.

| Country | Paid events | Invoice events | One-time checkouts | Recurring candidate | One-time candidate |
| --- | ---: | ---: | ---: | --- | --- |
| US | 1861 | 1756 | 105 | authority_review_incomplete | authority_review_incomplete |
| GB | 268 | 250 | 18 | existing_candidate_unapproved | existing_candidate_unapproved |
| AU | 203 | 185 | 18 | authority_review_incomplete | authority_review_incomplete |
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
| AE | 37 | 35 | 2 | authority_review_incomplete | authority_review_incomplete |
| BE | 37 | 37 | 0 | existing_candidate_unapproved | existing_candidate_unapproved |
| SG | 37 | 36 | 1 | authority_review_incomplete | authority_review_incomplete |
| PH | 35 | 30 | 5 | authority_review_incomplete | authority_review_incomplete |
| JP | 33 | 28 | 5 | authority_review_incomplete | authority_review_incomplete |
| PL | 33 | 29 | 4 | existing_candidate_unapproved | existing_candidate_unapproved |
| AR | 32 | 31 | 1 | source_research_required | source_research_required |
| CN | 32 | 29 | 3 | authority_review_incomplete | authority_review_incomplete |
| HK | 31 | 27 | 4 | authority_review_incomplete | authority_review_incomplete |
| IT | 29 | 27 | 2 | existing_candidate_unapproved | existing_candidate_unapproved |
| TH | 24 | 22 | 2 | authority_review_incomplete | authority_review_incomplete |
| ZA | 24 | 23 | 1 | authority_review_incomplete | authority_review_incomplete |
| IE | 23 | 22 | 1 | existing_candidate_unapproved | existing_candidate_unapproved |
| MY | 22 | 19 | 3 | authority_review_incomplete | authority_review_incomplete |
| VN | 21 | 18 | 3 | authority_review_incomplete | authority_review_incomplete |
| CZ | 20 | 19 | 1 | existing_candidate_unapproved | existing_candidate_unapproved |
| NO | 20 | 20 | 0 | authority_review_incomplete | authority_review_incomplete |
| RO | 20 | 19 | 1 | existing_candidate_unapproved | existing_candidate_unapproved |
| CO | 18 | 17 | 1 | source_research_required | source_research_required |
| TR | 18 | 15 | 3 | source_research_required | source_research_required |
| FI | 17 | 17 | 0 | existing_candidate_unapproved | existing_candidate_unapproved |
| NZ | 17 | 15 | 2 | authority_review_incomplete | authority_review_incomplete |
| TW | 17 | 15 | 2 | source_research_required | source_research_required |
| ID | 16 | 15 | 1 | source_research_required | source_research_required |
| IL | 16 | 16 | 0 | source_research_required | source_research_required |
| CL | 14 | 14 | 0 | source_research_required | source_research_required |
| GR | 14 | 10 | 4 | existing_candidate_unapproved | existing_candidate_unapproved |
| PT | 14 | 14 | 0 | existing_candidate_unapproved | existing_candidate_unapproved |
| RS | 14 | 13 | 1 | source_research_required | source_research_required |
| KZ | 13 | 12 | 1 | source_research_required | source_research_required |
| PE | 13 | 13 | 0 | source_research_required | source_research_required |
| SE | 13 | 13 | 0 | existing_candidate_unapproved | existing_candidate_unapproved |
| BG | 12 | 12 | 0 | existing_candidate_unapproved | existing_candidate_unapproved |
| SA | 12 | 11 | 1 | source_research_required | source_research_required |
| UA | 12 | 11 | 1 | source_research_required | source_research_required |
| FJ | 10 | 10 | 0 | source_research_required | source_research_required |
| PK | 10 | 10 | 0 | source_research_required | source_research_required |
| CR | 8 | 8 | 0 | source_research_required | source_research_required |
| MA | 8 | 8 | 0 | source_research_required | source_research_required |
| MO | 8 | 8 | 0 | source_research_required | source_research_required |
| DK | 7 | 5 | 2 | existing_candidate_unapproved | existing_candidate_unapproved |
| KW | 7 | 7 | 0 | source_research_required | source_research_required |
| SI | 7 | 7 | 0 | existing_candidate_unapproved | existing_candidate_unapproved |
| SK | 7 | 6 | 1 | existing_candidate_unapproved | existing_candidate_unapproved |
| GT | 6 | 5 | 1 | source_research_required | source_research_required |
| HR | 6 | 6 | 0 | existing_candidate_unapproved | existing_candidate_unapproved |
| HU | 6 | 5 | 1 | existing_candidate_unapproved | existing_candidate_unapproved |
| LB | 6 | 6 | 0 | source_research_required | source_research_required |
| NG | 6 | 5 | 1 | source_research_required | source_research_required |
| AT | 5 | 5 | 0 | existing_candidate_unapproved | existing_candidate_unapproved |
| CY | 5 | 5 | 0 | existing_candidate_unapproved | existing_candidate_unapproved |
| BA | 4 | 4 | 0 | source_research_required | source_research_required |
| EC | 4 | 4 | 0 | source_research_required | source_research_required |
| EG | 4 | 3 | 1 | source_research_required | source_research_required |
| PR | 4 | 4 | 0 | source_research_required | source_research_required |
| PY | 4 | 3 | 1 | source_research_required | source_research_required |
| QA | 4 | 4 | 0 | source_research_required | source_research_required |
| EE | 3 | 3 | 0 | existing_candidate_unapproved | existing_candidate_unapproved |
| IS | 3 | 3 | 0 | source_research_required | source_research_required |
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
| KE | 1 | 0 | 1 | source_research_required | source_research_required |
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
