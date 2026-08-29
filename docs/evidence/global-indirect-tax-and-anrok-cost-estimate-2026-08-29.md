# Global indirect-tax exposure and Anrok cost estimate — 2026-08-29

Status: planning estimate from production aggregate data; not a registration decision or tax
opinion.

## Executive answer

SERP does **not** need to pay Anrok for every country in which a customer has bought something.
Anrok bills per active tax market: EU OSS is one market, each registered US state is one, Canada's
federal GST/HST is one with certain provinces separate, and most other countries are individual
markets.

Using SERP's actual production distribution, the realistic software-tier estimate is:

| Scenario | Markets | Public list price | Annual cost | Share of annualized gross |
| --- | ---: | ---: | ---: | ---: |
| Defensible floor | 6 | $600/month | $7,200/year | 2.38% |
| Working budget | 8 | **$800/month** | **$9,600/year** | **3.17%** |
| Conservative planning envelope | 12 | $1,200/month | $14,400/year | 4.76% |

The working budget is the number to use for planning. Six markets are already likely from the
observed sales and published rules: EU OSS, UK, India, South Korea, Mexico, and Switzerland. Two
additional slots cover a US state or another first-sale/low-threshold jurisdiction that survives a
formal product-taxability review. Twelve markets is a cautious initial budget envelope, not the
expected result or a legal cap on possible registrations.

Anrok currently publishes $100 per market per month for software and other non-ecommerce
companies, versus $50 for its ecommerce product. SERP sells software subscriptions and digital
products, so this report uses the conservative $100 software price rather than assuming SERP will
qualify for the ecommerce tier. Anrok also says high-volume Starter sellers may incur additional
fees. Its older billing FAQ describes a flat fee plus a basis-point component, while the current
pricing page says a flat per-market fee and no standard-feature add-ons. A written quote is
therefore required before treating $800 as a contract price.

The Anrok fee is separate from tax collected from customers and remitted to governments. If tax is
added at checkout, that tax is normally customer-funded. If SERP keeps tax-inclusive prices, the
tax becomes a margin cost.

## Production-data basis

All figures below came from read-only aggregate queries against `serp-prod-safe-store-d1`. No
customer identifiers, addresses, payment details, secrets, or webhook payloads were exported or
recorded in this report.

The geographic sample uses:

- every live `invoice.payment_succeeded` event for subscriptions;
- live, paid `checkout.session.completed` events only when `mode=payment` for one-time purchases;
- no subscription Checkout events, because their first invoices are already represented and
  including both would double count the first payment.

| Measure | Result |
| --- | ---: |
| Observed window | 2026-05-18 17:42:32 to 2026-08-29 11:07:38 UTC |
| Observed duration | 102.7258 days |
| Successful transactions | 3,867 |
| Observed gross | $85,163.85 |
| Transactions with a country | 3,776 (97.65%) |
| Known customer countries | 105 |
| Annualized gross at the observed run rate | **$302,800.93** |
| Annualized monthly average | $25,233.41 |

The complete Store order ledger is a useful cross-check: 11,079 completed orders and $273,224.54
from 2025-09-25 through 2026-08-29. The Store order-country field only became consistently
populated near the end of that period, so the shorter Stripe webhook window is the more reliable
geographic source.

### Revenue concentration

| Annualized country-revenue bracket | Known countries | Transactions observed | Annualized gross |
| --- | ---: | ---: | ---: |
| At least $100,000 | 1 | 1,722 | $138,422.41 |
| $10,000–$99,999 | 4 | 734 | $58,362.99 |
| $5,000–$9,999 | 2 | 154 | $12,951.83 |
| $1,000–$4,999 | 30 | 833 | $61,503.57 |
| Less than $1,000 | 68 | 333 | $23,558.45 |
| Unknown country | — | 91 | $8,001.68 |

The country count is therefore a poor cost proxy: 68 of the 105 known countries jointly produce
only 7.78% of annualized gross.

### Material market groups

| Market group | Transactions observed | Observed gross | Annualized gross | Current planning result |
| --- | ---: | ---: | ---: | --- |
| United States | 1,722 | $38,931.80 | $138,422.41 | State review required |
| EU OSS | 593 | $13,337.05 | $47,420.02 | Include as 1 market |
| United Kingdom | 244 | $5,187.30 | $18,443.50 | Include as 1 market |
| Canada | 172 | $4,104.00 | $14,591.81 | Below federal remote-seller threshold at this run rate |
| Australia | 189 | $4,094.50 | $14,558.04 | Below remote-seller threshold at this run rate |
| Switzerland | 44 | $1,002.00 | $3,562.62 | Likely include; worldwide threshold is exceeded |
| India | 56 | $973.20 | $3,460.22 | Include as 1 market |
| Mexico | 44 | $896.50 | $3,187.51 | Include as 1 market |
| South Korea | 48 | $532.00 | $1,891.53 | Include as 1 market |
| All other known countries | 664 | $13,855.00 | $49,261.59 | Threshold and collection-mechanism review |
| Unknown country | 91 | $2,250.50 | $8,001.68 | Improve evidence collection |

The top individual countries are US ($138,422 annualized), UK ($18,444), Canada ($14,592),
Australia ($14,558), Germany ($10,770), France ($7,857), Spain ($5,095), Netherlands ($3,751),
Switzerland ($3,563), India ($3,460), Singapore ($3,380), and Mexico ($3,188).

## Why the six-market floor is reasonable

This mapping assumes SERP's automated app/subscription access is a B2C electronically supplied
service. A bundled service involving material human delivery could change the classification.

1. **EU OSS — include.** A non-EU supplier can use the Non-Union OSS to register, file, and pay for
   B2C services across the EU through one member state. EU OSS counts as one Anrok market, not 27.
2. **United Kingdom — include.** The UK requires an overseas supplier of digital services to UK
   consumers to account for UK VAT; the normal domestic registration threshold is not the working
   protection for a non-established supplier.
3. **India — include.** India's registration rules specifically cover a person outside India
   supplying OIDAR services to a non-taxable online recipient.
4. **South Korea — include.** The simplified-registration rules require a foreign electronic-service
   supplier to register after commencing covered supplies.
5. **Mexico — include.** SAT's foreign digital-services process says foreign persons or entities
   without a Mexican establishment providing digital services must register, file, and pay VAT.
6. **Switzerland — likely include.** Swiss guidance uses a CHF100,000 worldwide-turnover test for
   foreign companies making covered Swiss supplies. SERP's annualized worldwide gross is about
   $302,801, so it clears the worldwide limb; a specialist should confirm the exact product
   classification and start date.

The legal pages identify the seller as TSMC LLC with a Wyoming address. That creates a home-state
review, but this report does not automatically add Wyoming as an Anrok market. Wyoming's published
rule taxes specified digital products transferred for permanent use; a recurring app/subscription
right may not satisfy that description. Confirm product taxability before registering.

## Markets that appear below published thresholds

These are not included in the six-market floor at the current run rate:

- **Canada:** about $14,592 annualized versus the CAD30,000 federal threshold for the simplified
  nonresident digital-services regime. Currency movement does not make the current figure close.
- **Australia:** about $14,558 annualized versus A$75,000.
- **Singapore:** about $3,380 annualized. The overseas-vendor regime requires both S$1 million
  global turnover and more than S$100,000 of covered Singapore B2C sales; SERP is below both at the
  observed run rate.
- **New Zealand:** about $1,202 annualized versus NZ$60,000.
- **Norway:** about $1,479 annualized versus NOK50,000 over 12 months.
- **Taiwan:** about $2,133 annualized versus NT$600,000 annually.

Thresholds must be monitored in the local statutory currency and over the jurisdiction's required
lookback period. Crossing a threshold can create a registration deadline even if the Anrok market
was not active at the start of the year.

## US uncertainty

The US cannot yet be priced state-by-state from the present evidence. Country coverage is strong,
but the state field is missing for $33,768 of the $38,932 observed US gross. Known-state sales are
small—California $1,294, Florida $908, and Texas $541.80 during the sample—but treating the missing
87% as proportionally distributed would be an unsupported assumption.

Total US annualized revenue is about $138,422. Many states use a $100,000 economic-nexus threshold,
but the precise threshold base and taxation of downloaded software, subscriptions, and SaaS vary.
The next checkout-data change should require billing country plus state/region before payment and
store a normalized jurisdiction on both the Store order and Lago invoice. Until a full 12-month
state distribution exists, reserve two markets in the working budget rather than claiming zero US
markets or inventing several.

## Current tax behavior

The same production event sample shows:

| Stripe automatic-tax setting | Transactions | Gross | Tax recorded |
| --- | ---: | ---: | ---: |
| Disabled | 3,867 | $85,163.85 | $0.00 |

So Stripe has processed the payments, but Stripe Automatic Tax did not calculate or collect tax on
any transaction in this sample. Moving a product from direct Stripe to EPD/Lago does not “inherit”
tax from Stripe because there is no enabled Stripe tax calculation to inherit. Lago needs an
independent tax decision before EPD capture: determine jurisdiction and product taxability,
calculate tax, persist the quote, display it, and charge exactly the invoice total.

For scale only, applying representative standard rates to the current untaxed, annualized gross in
the six likely markets produces this add-on-tax estimate:

| Market | Approximate annual tax |
| --- | ---: |
| EU OSS, using the destination-country mix | $9,903 |
| United Kingdom | $3,689 |
| India | $623 |
| Mexico | $510 |
| Switzerland | $289 |
| South Korea | $189 |
| **Approximate total** | **$15,203/year** |

That is not a liability determination and excludes any US state tax, reduced rates, exemptions,
refunds, and currency movement. It is mostly a customer-funded pass-through if added on top of the
advertised price. If SERP keeps the displayed price tax-inclusive, the actual tax must instead be
backed out of that price and becomes a margin reduction.

## Price caveats and next action

Published Anrok pricing supports the $800/month planning number, but not a final payable invoice:

- current public software pricing is $100 per active market per month;
- ecommerce is advertised at $50 per market per month, but SERP should not assume eligibility;
- Starter may add undisclosed high-transaction-volume fees;
- government registration charges and tax remittances are pass-through amounts;
- Anrok's current pricing page and older billing FAQ describe the variable-fee mechanics
  differently.

Before signing, send Anrok this aggregate profile—approximately 13,750 annual transactions,
$302,801 annualized gross, six likely immediate markets, eight budgeted markets, and API-driven
Lago/EPD calculation—and require a written all-in quote covering platform, basis points if any,
registrations, filings, and supported countries. Do not send customer data.

## Sources

- [Anrok current pricing and market definition](https://www.anrok.com/pricing)
- [Anrok billing FAQ](https://help-center.anrok.com/hc/en-us/articles/4410156178963-Billing-FAQ)
- [EU One Stop Shop](https://europa.eu/youreurope/business/finance-and-tax/vat/one-stop-shop/index_en.htm)
- [UK VAT rules for digital services supplied to consumers](https://www.gov.uk/guidance/the-vat-rules-if-you-supply-digital-services-to-private-consumers)
- [Canada electronic-commerce GST/HST rules](https://www.canada.ca/en/revenue-agency/programs/about-canada-revenue-agency-cra/federal-government-budgets/faq-relation-electronic-commerce-supplies.html)
- [Australia nonresident digital-products and services GST guidance](https://www.ato.gov.au/api/public/content/0-5cfa3e60-d95b-41aa-9be1-cea62009de33)
- [Switzerland VAT liability for foreign companies](https://www.estv.admin.ch/en/vat-liability-foreign-companies)
- [India GST registration rules](https://cbic-gst.gov.in/gst-registration-rules.html)
- [South Korea foreign electronic-services guidance](https://www.nts.go.kr/english/na/ntt/selectNttList.do?bbsId=30699&mi=11210)
- [Mexico SAT foreign digital-services VAT filing](https://wwwmat.sat.gob.mx/declaracion/42009/presenta-tu-declaracion-de-pagos)
- [Singapore overseas-vendor registration](https://www.iras.gov.sg/taxes/goods-services-tax-%28gst%29/gst-and-digital-economy/overseas-businesses)
- [New Zealand GST on remote services](https://www.ird.govt.nz/gst-on-remote-services)
- [Norway registration threshold](https://www.skatteetaten.no/en/rettskilder/type/handboker/merverdiavgiftshandboken/gjeldende/M-2/M-2-1/)
- [Taiwan foreign electronic-services threshold](https://www.ntbca.gov.tw/English/singlehtml/f1dd42510f2e44fd9ff0249b0c210772?cntId=4136f22826bc4adaabd82912b11b61c8)
- [US remote-seller state threshold guidance](https://www.streamlinedsalestax.org/for-businesses/remote-seller-faqs/remote-seller-state-guidance)
- [Wyoming specified-digital-products rule](https://wyoleg.gov/arules/2012/rules/ARR26-007P.pdf)
