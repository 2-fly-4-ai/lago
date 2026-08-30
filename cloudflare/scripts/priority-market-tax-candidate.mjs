import { readFile } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";

import { contentChecksum, validateRuleSetArtifact } from "./indirect-tax-rule-set.mjs";
import { validateTedbSnapshot } from "./eu-tedb-standard-rates.mjs";

const PRODUCT_TAX_CODE = "txcd_10103100";
const ARTIFACT_DATE = "2026-08-31T00:00:00.000Z";
const REFERENCE_PATH = "docs/evidence/eu-tedb-standard-rate-snapshot-2026-08-31.md";
const TEDB_URL = "https://ec.europa.eu/taxation_customs/tedb/ws/VatRetrievalService.wsdl";

const PRIORITY_MARKETS = [
  {
    country: "CH",
    component: "fta-ch",
    authority: "Swiss Federal Tax Administration",
    url: "https://www.estv.admin.ch/en/vat-rates-switzerland",
    ratePpm: 81_000,
    effectiveFrom: "2024-01-01T00:00:00.000Z",
  },
  {
    country: "GB",
    component: "hmrc-gb",
    authority: "HM Revenue & Customs",
    url: "https://www.gov.uk/vat-rates",
    ratePpm: 200_000,
    effectiveFrom: "2011-01-04T00:00:00.000Z",
  },
  {
    country: "IN",
    component: "cbic-in",
    authority: "India Central Board of Indirect Taxes and Customs",
    url: "https://cbic-gst.gov.in/hindi/sectoral-faq.html",
    ratePpm: 180_000,
    effectiveFrom: ARTIFACT_DATE,
  },
  {
    country: "KR",
    component: "nts-kr",
    authority: "South Korea National Tax Service",
    url: "https://taxlaw.nts.go.kr/st/USESTA002M.do?ntstBscId=100000000000001571&ntstSysClCd=01&ntstTlawClCd=111",
    ratePpm: 100_000,
    effectiveFrom: ARTIFACT_DATE,
  },
  {
    country: "MX",
    component: "sat-mx",
    authority: "Mexico Tax Administration Service",
    url: "https://wwwmat.sat.gob.mx/articulo/19848/articulo-1",
    ratePpm: 160_000,
    effectiveFrom: ARTIFACT_DATE,
  },
];

export function buildPriorityMarketCandidate(tedbSnapshot) {
  const tedb = validateTedbSnapshot(tedbSnapshot);
  const components = [
    {
      id: "eu-tedb",
      authority: "European Commission Taxes in Europe Database",
      url: TEDB_URL,
      retrieved_at: tedb.retrieved_at,
    },
    ...PRIORITY_MARKETS.map((market) => ({
      id: market.component,
      authority: market.authority,
      url: market.url,
      retrieved_at: ARTIFACT_DATE,
    })),
  ];
  const euRules = tedb.rates.map((rate) =>
    rule({
      country: rate.country,
      component: "eu-tedb",
      url: TEDB_URL,
      ratePpm: rate.rate_ppm,
      effectiveFrom: `${rate.effective_from}T00:00:00.000Z`,
      reference: `TEDB national standard VAT rate of ${rate.rate_percent}% for situation date ${tedb.situation_on}.`,
    }),
  );
  const marketRules = PRIORITY_MARKETS.map((market) =>
    rule({
      ...market,
      reference: `Authority-published national standard rate of ${formatPercent(market.ratePpm)}%.`,
    }),
  );
  const artifact = {
    format: "serp-indirect-tax-rule-set/v1",
    id: "priority-market-candidate-2026-08-31",
    version: 1,
    status: "draft",
    source: {
      name: "SERP priority-market official-authority candidate",
      url: REFERENCE_PATH,
      published_at: ARTIFACT_DATE,
      components,
    },
    effective_from: ARTIFACT_DATE,
    effective_to: null,
    refreshed_at: tedb.retrieved_at,
    content_sha256: "",
    rules: [...euRules, ...marketRules],
  };
  artifact.content_sha256 = contentChecksum(artifact);
  return validateRuleSetArtifact(artifact);
}

function rule({ country, component, url, ratePpm, effectiveFrom, reference }) {
  return {
    id: `${country.toLowerCase()}-standard-software-priority-v1`,
    country,
    region: null,
    postal_prefix: null,
    product_tax_code: PRODUCT_TAX_CODE,
    taxability: "taxable",
    rate_ppm: ratePpm,
    priority: 0,
    source_component_id: component,
    source_url: url,
    source_reference: `${reference} Generic-software classification and collection registration require separate review.`,
    effective_from: effectiveFrom,
    effective_to: null,
  };
}

function formatPercent(ratePpm) {
  return (ratePpm / 10_000).toString();
}

async function main() {
  const snapshotPath = fileURLToPath(
    new URL("../fixtures/indirect-tax/eu-tedb-standard-rates-2026-08-31.json", import.meta.url),
  );
  const snapshot = JSON.parse(await readFile(snapshotPath, "utf8"));
  process.stdout.write(`${JSON.stringify(buildPriorityMarketCandidate(snapshot), null, 2)}\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
