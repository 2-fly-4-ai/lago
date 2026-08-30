# EU TEDB Standard-rate Snapshot Evidence

Date: 2026-08-31

## Outcome

The Cloudflare-native Lago worktree can now retrieve the national standard VAT rates for all 27 EU
member states directly from the European Commission Taxes in Europe Database (TEDB) public SOAP
service. This avoids a Stripe Tax calculation request merely to learn the published standard-rate
table.

The checked-in snapshot records:

- situation date: `2026-08-31`;
- retrieval timestamp: `2026-08-30T12:50:51.354Z`;
- raw SOAP response SHA-256:
  `53bd338b4b5e975bcbe35ce2a2ccd7ff17b6df6764fd85c889d08b088cd7bc84`;
- source contract: `eu-tedb-standard-rates/v1`;
- exact coverage: 27 national standard rates.

| Country | Rate | Country | Rate | Country | Rate |
| ------- | ---: | ------- | ---: | ------- | ---: |
| AT | 20% | BE | 21% | BG | 20% |
| CY | 19% | CZ | 21% | DE | 19% |
| DK | 25% | EE | 24% | ES | 21% |
| FI | 25.5% | FR | 20% | GR | 24% |
| HR | 25% | HU | 27% | IE | 23% |
| IT | 22% | LT | 21% | LU | 17% |
| LV | 21% | MT | 18% | NL | 21% |
| PL | 23% | PT | 23% | RO | 21% |
| SE | 25% | SI | 22% | SK | 23% |

TEDB identifies Greece as `EL`; the normalized snapshot uses `GR` and preserves
`source_member_state: EL`. The parser also ignores category/product-code records and selects the one
unqualified national default when TEDB returns additional import or special-territory entries.

## Priority markets outside the EU

The aggregate exposure report's likely first wave also has published standard rates from the
relevant authorities:

| Market | Published standard rate | Authority reference |
| ------ | ----------------------: | ------------------- |
| United Kingdom | 20% | HM Revenue & Customs VAT rates |
| India | 18% | Central Board of Indirect Taxes and Customs IT-services FAQ |
| South Korea | 10% | National Tax Service VAT law/rate guidance |
| Mexico | 16% | Tax Administration Service VAT Law article 1 |
| Switzerland | 8.1% | Federal Tax Administration VAT rates |

These are rate-source facts only. The standard rate is not yet an approved product-taxability
classification, registration scope, effective collection date, or production rule.

The deterministic priority-market generator combines the checked EU snapshot with these five
non-EU authority references into a valid 64-rule `draft` artifact: two provisional software
classifications for each of 32 countries. The generated artifact checksum is
`1786f62cffe7f301d8f994dc9d4a5cc353a84229cba6d3986fdde41a98522605`. It is generated for review
and is neither loaded nor activated.

## Verification

- The live public-authority response produced exactly one selected national standard rate for every
  member state.
- Fourteen importer/source Node tests passed, including exact snapshot fields and country order, Greece
  normalization, incomplete-coverage rejection, duplicate-default rejection, SOAP-fault rejection,
  rate validation, fixed-endpoint enforcement, 32-country/two-classification candidate coverage,
  disabled registration-review controls, and draft-only rule import controls.
- `tax-rules:check` validates the checked-in snapshot without network access.
- `oxlint` returned zero warnings and zero errors for the adapter and tests.

## Safety boundary

No remote D1 data, Worker deployment, Cloudflare resource, Stripe object or calculation, EPD
transaction, tax registration, registration scope, collection switch, `store-new`, or `serp-auth`
state was changed. The snapshot is not consumed by checkout.

## Sources

- European Commission TEDB VAT Retrieval Service WSDL:
  <https://ec.europa.eu/taxation_customs/tedb/ws/VatRetrievalService.wsdl>
- European Commission TEDB public service specification:
  <https://taxation-customs.ec.europa.eu/document/download/d4a05b85-fd95-45a5-95b4-3ef320fa9728_en>
- HM Revenue & Customs VAT rates: <https://www.gov.uk/vat-rates>
- India CBIC sectoral FAQ: <https://cbic-gst.gov.in/hindi/sectoral-faq.html>
- South Korea National Tax Service VAT law:
  <https://taxlaw.nts.go.kr/st/USESTA002M.do?ntstBscId=100000000000001571&ntstSysClCd=01&ntstTlawClCd=111>
- Mexico SAT VAT Law article 1: <https://wwwmat.sat.gob.mx/articulo/19848/articulo-1>
- Swiss Federal Tax Administration VAT rates: <https://www.estv.admin.ch/en/vat-rates-switzerland>
