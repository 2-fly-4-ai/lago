import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

import { calculateLocalD1Tax } from "../src/tax/local-d1";
import expansion from "../fixtures/indirect-tax/software-rate-expansion-2026-09-06.json";
import noSalesTax from "../fixtures/indirect-tax/no-sales-tax-software-2026-09-06.json";

const now = new Date("2026-08-30T10:00:00.000Z");
let organizationId: string;
let ruleSetId: string;

beforeEach(async () => {
  const fixture = crypto.randomUUID();
  organizationId = `org-local-tax-${fixture}`;
  ruleSetId = `rules-local-tax-${fixture}`;
  await env.BILLING_DB.batch([
    env.BILLING_DB.prepare("DELETE FROM indirect_tax_registration_scopes"),
    env.BILLING_DB.prepare("DELETE FROM indirect_tax_rules"),
    env.BILLING_DB.prepare("DELETE FROM indirect_tax_rule_sets"),
    env.BILLING_DB.prepare(
      `INSERT INTO organizations (id, external_id, name, created_at, updated_at)
       VALUES (?, ?, 'Local tax fixture', ?, ?)`,
    ).bind(organizationId, organizationId, now.toISOString(), now.toISOString()),
    env.BILLING_DB.prepare(
      `INSERT INTO indirect_tax_rule_sets
       (id, version, status, source_name, source_url, source_published_at, effective_from,
        effective_to, content_sha256, refreshed_at, created_at, activated_at)
       VALUES (?, 1, 'active', 'Synthetic tax fixture', 'https://example.invalid/tax-fixture',
               ?, '2020-01-01T00:00:00.000Z', NULL, ?, ?, ?, ?)`,
    ).bind(
      ruleSetId,
      now.toISOString(),
      "b".repeat(64),
      now.toISOString(),
      now.toISOString(),
      now.toISOString(),
    ),
  ]);
});

describe("local D1 indirect tax calculator", () => {
  it("switches collection off without removing rates and gives the quote a new identity", async () => {
    await seedScopeAndRule({ region: "NJ", ratePpm: 66_250 });
    const address = { country: "US", state: "NJ", postalCode: "07030" };
    const collecting = await calculate(address, 900);
    await env.BILLING_DB.prepare(
      "UPDATE indirect_tax_registration_scopes SET collection_mode = 'off' WHERE organization_id = ?",
    )
      .bind(organizationId)
      .run();
    const off = await calculate(address, 900);
    expect(off).toMatchObject({
      taxMinor: 0,
      totalMinor: 900,
      collectionMode: "off",
      ruleId: collecting.ruleId,
    });
    expect(off.id).not.toBe(collecting.id);
    await env.BILLING_DB.prepare(
      "UPDATE indirect_tax_registration_scopes SET status = 'disabled' WHERE organization_id = ?",
    )
      .bind(organizationId)
      .run();
    await expect(calculate(address, 900)).rejects.toMatchObject({
      code: "checkout_tax_registration_missing",
    });
  });

  it("still rejects missing rules when collection is explicitly off", async () => {
    await seedCountryScope("US", `scope-${organizationId}`);
    await env.BILLING_DB.prepare(
      "UPDATE indirect_tax_registration_scopes SET collection_mode = 'off' WHERE organization_id = ?",
    )
      .bind(organizationId)
      .run();
    await expect(
      calculate({ country: "US", state: "NY", postalCode: "10001" }, 900),
    ).rejects.toMatchObject({ code: "checkout_tax_rule_missing" });
  });

  it("rejects future-dated rules and invalid exempt subtotals", async () => {
    await seedScopeAndRule({ region: "CA", ratePpm: 0, taxability: "exempt" });
    const address = { country: "US", state: "CA", postalCode: "94105" };
    await expect(calculate(address, -1)).rejects.toMatchObject({
      code: "checkout_tax_amount_invalid",
    });
    await expect(
      calculate(address, 900, new Date("2026-08-29T00:00:00.000Z")),
    ).rejects.toMatchObject({
      code: "checkout_tax_rules_stale",
    });
  });

  // Local test scopes only: these are not evidence of the merchant's registrations.
  it.each([
    ["AU", 90],
    ["NZ", 135],
    ["NO", 225],
    ["SG", 81],
    ["AE", 45],
    ["MY", 72],
    ["PH", 108],
    ["ZA", 135],
    ["CL", 171],
    ["IS", 216],
    ["KE", 144],
    ["JP", 90],
    ["AR", 189],
  ] as const)(
    "calculates both draft software classifications for %s",
    async (country, expectedTax) => {
      const market = expansion.markets.find((item) => item.country === country);
      expect(market).toBeDefined();
      for (const taxCode of ["txcd_10103100", "txcd_10202000"]) {
        await env.BILLING_DB.prepare(
          `INSERT INTO indirect_tax_rules
         (id, rule_set_id, country, region, postal_prefix, product_tax_code, taxability,
          rate_ppm, priority, source_url, source_reference, effective_from, effective_to, created_at)
         VALUES (?, ?, ?, NULL, NULL, ?, 'taxable', ?, 0, ?, 'test-scope-only',
                 '2020-01-01T00:00:00.000Z', NULL, ?)`,
        )
          .bind(
            `rule-${organizationId}-${taxCode}`,
            ruleSetId,
            country,
            taxCode,
            market!.rate_ppm,
            market!.rate_url,
            now.toISOString(),
          )
          .run();
      }
      const quote = (taxCode: string) =>
        calculateLocalD1Tax(
          env.BILLING_DB,
          {
            address: { country, state: null, postalCode: null },
            currency: "USD",
            organizationId,
            requestHash: "d".repeat(64),
            subtotalMinor: 900,
            taxCode,
          },
          now,
        );
      await expect(quote("txcd_10103100")).rejects.toMatchObject({
        code: "checkout_tax_registration_missing",
      });
      await seedCountryScope(country, `scope-${organizationId}`);
      for (const taxCode of ["txcd_10103100", "txcd_10202000"]) {
        await expect(quote(taxCode)).resolves.toMatchObject({
          subtotalMinor: 900,
          taxMinor: expectedTax,
          totalMinor: 900 + expectedTax,
        });
      }
    },
  );

  it("uses an explicit no-sales-tax rule and still requires an enabled destination scope", async () => {
    const market = noSalesTax.markets.find((item) => item.country === "HK")!;
    for (const taxCode of ["txcd_10103100", "txcd_10202000"])
      await env.BILLING_DB.prepare(
        `INSERT INTO indirect_tax_rules
         (id,rule_set_id,country,region,postal_prefix,product_tax_code,taxability,rate_ppm,
          priority,source_url,source_reference,effective_from,effective_to,created_at)
         VALUES(?,?,?,NULL,NULL,?,'exempt',0,0,?,'explicit-no-sales-tax-test',
                '2020-01-01T00:00:00.000Z',NULL,?)`,
      )
        .bind(
          `hk-${organizationId}-${taxCode}`,
          ruleSetId,
          market.country,
          taxCode,
          market.url,
          now.toISOString(),
        )
        .run();
    const quote = (taxCode: string) =>
      calculateLocalD1Tax(
        env.BILLING_DB,
        {
          address: { country: "HK", state: null, postalCode: null },
          currency: "USD",
          organizationId,
          requestHash: "e".repeat(64),
          subtotalMinor: 900,
          taxCode,
        },
        now,
      );
    await expect(quote("txcd_10103100")).rejects.toMatchObject({
      code: "checkout_tax_registration_missing",
    });
    await seedCountryScope("HK", `scope-${organizationId}`);
    for (const taxCode of ["txcd_10103100", "txcd_10202000"])
      await expect(quote(taxCode)).resolves.toMatchObject({ taxMinor: 0, totalMinor: 900 });
  });

  it("rounds a 6.625% rule to the nearest minor unit", async () => {
    await seedScopeAndRule({ region: "NJ", ratePpm: 66_250 });
    const result = await calculate({ country: "US", state: "NJ", postalCode: "07030" }, 900);
    expect(result).toMatchObject({
      subtotalMinor: 900,
      taxMinor: 60,
      totalMinor: 960,
    });
    expect(result.id).toMatch(/^localtax_[a-f0-9]{64}$/);
  });

  it("prefers a postal rule over a region rule", async () => {
    await seedScopeAndRule({ region: "WA", ratePpm: 65_000 });
    await insertRule({ idSuffix: "981", postalPrefix: "981", region: "WA", ratePpm: 101_000 });
    const result = await calculate({ country: "US", state: "WA", postalCode: "98104" }, 1000);
    expect(result.taxMinor).toBe(101);
    expect(result.ruleId).toContain("981");
  });

  it("resolves a Washington destination from the official address service", async () => {
    await seedWashingtonAddressRule();
    const result = await calculateLocalD1Tax(
      env.BILLING_DB,
      {
        address: {
          country: "US",
          state: "WA",
          postalCode: "98104",
          addressLine: "700 Fifth Avenue",
          city: "Seattle",
        },
        currency: "USD",
        fetcher: async () => washingtonResponse(),
        organizationId,
        requestHash: "f".repeat(64),
        subtotalMinor: 900,
        taxCode: "txcd_10103100",
      },
      now,
    );
    expect(result).toMatchObject({
      calculationMethod: "wa_dor_address",
      subtotalMinor: 900,
      taxMinor: 92,
      totalMinor: 992,
      rateResolution: {
        locationCode: "1726",
        jurisdiction: "SEATTLE, KING",
        period: "Q32026",
        validThrough: "2026-10-01T00:00:00.000Z",
        stateRatePpm: 65_000,
        localRatePpm: 37_500,
      },
    });
  });

  it("fails closed when Washington needs an address correction or required fields are absent", async () => {
    await seedWashingtonAddressRule();
    const base = {
      currency: "USD",
      organizationId,
      requestHash: "f".repeat(64),
      subtotalMinor: 900,
      taxCode: "txcd_10103100",
    };
    await expect(
      calculateLocalD1Tax(
        env.BILLING_DB,
        { ...base, address: { country: "US", state: "WA", postalCode: "98104" } },
        now,
      ),
    ).rejects.toMatchObject({ code: "invalid_billing_address" });
    const correctionInput = {
      ...base,
      address: {
        country: "US",
        state: "WA",
        postalCode: "98104",
        addressLine: "700 Fifth Avenue",
        city: "Seattle",
      },
      fetcher: async () => washingtonResponse({ result: 2 }),
    };
    await expect(calculateLocalD1Tax(env.BILLING_DB, correctionInput, now)).rejects.toMatchObject({
      code: "checkout_tax_address_correction_required",
      details: {
        normalized_address: {
          address_line: "700 FIFTH AVE",
          city: "SEATTLE",
          state: "WA",
          postal_code: "98104",
        },
      },
    });
    await expect(
      calculateLocalD1Tax(
        env.BILLING_DB,
        {
          ...correctionInput,
          address: { ...correctionInput.address, addressLine: "700 FIFTH AVE" },
          confirmedAddress: true,
        },
        now,
      ),
    ).resolves.toMatchObject({ taxMinor: 92, totalMinor: 992 });
    await expect(
      calculateLocalD1Tax(env.BILLING_DB, { ...correctionInput, confirmedAddress: true }, now),
    ).rejects.toMatchObject({ code: "checkout_tax_address_correction_required" });
  });

  it("rejects stale Washington periods and state-rate disagreement", async () => {
    await seedWashingtonAddressRule();
    const calculateWashington = (response: Response) =>
      calculateLocalD1Tax(
        env.BILLING_DB,
        {
          address: {
            country: "US",
            state: "WA",
            postalCode: "98104",
            addressLine: "700 Fifth Avenue",
            city: "Seattle",
          },
          currency: "USD",
          fetcher: async () => response,
          organizationId,
          requestHash: "f".repeat(64),
          subtotalMinor: 900,
          taxCode: "txcd_10103100",
        },
        now,
      );
    await expect(
      calculateWashington(washingtonResponse({ period: "Q22026" })),
    ).rejects.toMatchObject({ code: "checkout_tax_address_rate_stale" });
    await expect(
      calculateWashington(washingtonResponse({ localRate: "0.042500", stateRate: "0.060000" })),
    ).rejects.toMatchObject({ code: "checkout_tax_address_rate_mismatch" });
  });

  it("requires an explicit exempt rule instead of treating missing data as zero", async () => {
    await seedScopeAndRule({ region: "CA", ratePpm: 0, taxability: "exempt" });
    await expect(
      calculate({ country: "US", state: "CA", postalCode: "94105" }, 1000),
    ).resolves.toMatchObject({ taxMinor: 0, totalMinor: 1000 });

    await expect(
      calculate({ country: "US", state: "NY", postalCode: "10001" }, 1000),
    ).rejects.toMatchObject({ code: "checkout_tax_registration_missing" });
  });

  it("fails closed when the active dataset is stale", async () => {
    await seedScopeAndRule({ region: "NJ", ratePpm: 66_250 });
    await expect(
      calculate(
        { country: "US", state: "NJ", postalCode: "07030" },
        900,
        new Date("2026-10-30T10:00:00.000Z"),
      ),
    ).rejects.toMatchObject({ code: "checkout_tax_rules_stale" });
  });

  it("rejects equally specific duplicate rules at the database boundary", async () => {
    await seedScopeAndRule({ region: "WA", ratePpm: 65_000 });
    await expect(
      insertRule({ idSuffix: "conflict", region: "WA", ratePpm: 70_000 }),
    ).rejects.toBeDefined();
  });

  it("rejects duplicate country-wide registration scopes with null regions", async () => {
    await seedCountryScope("GB", "scope-country-one");
    await expect(seedCountryScope("GB", "scope-country-two")).rejects.toBeDefined();
  });
});

function calculate(
  address: { country: string; state: string | null; postalCode: string | null },
  subtotalMinor: number,
  asOf = now,
) {
  return calculateLocalD1Tax(
    env.BILLING_DB,
    {
      address,
      currency: "USD",
      organizationId,
      requestHash: "c".repeat(64),
      subtotalMinor,
      taxCode: "txcd_10103100",
    },
    asOf,
  );
}

async function seedScopeAndRule(input: {
  region: string;
  ratePpm: number;
  taxability?: "taxable" | "exempt";
}) {
  await env.BILLING_DB.prepare(
    `INSERT INTO indirect_tax_registration_scopes
     (id, organization_id, rule_set_id, country, region, status, registration_reference,
      effective_from, effective_to, created_at, updated_at)
     VALUES (?, ?, ?, 'US', ?, 'enabled', 'synthetic-only',
             '2020-01-01T00:00:00.000Z', NULL, ?, ?)`,
  )
    .bind(
      `scope-${organizationId}-${input.region}`,
      organizationId,
      ruleSetId,
      input.region,
      now.toISOString(),
      now.toISOString(),
    )
    .run();
  await insertRule(input);
}

async function insertRule(input: {
  idSuffix?: string;
  postalPrefix?: string;
  region: string;
  ratePpm: number;
  taxability?: "taxable" | "exempt";
}) {
  const taxability = input.taxability ?? "taxable";
  await env.BILLING_DB.prepare(
    `INSERT INTO indirect_tax_rules
     (id, rule_set_id, country, region, postal_prefix, product_tax_code, taxability,
      rate_ppm, priority, source_url, source_reference, effective_from, effective_to, created_at)
     VALUES (?, ?, 'US', ?, ?, 'txcd_10103100', ?, ?, 0,
             'https://example.invalid/tax-fixture', 'synthetic-only',
             '2020-01-01T00:00:00.000Z', NULL, ?)`,
  )
    .bind(
      `rule-${organizationId}-${input.idSuffix ?? input.region}`,
      ruleSetId,
      input.region,
      input.postalPrefix ?? null,
      taxability,
      input.ratePpm,
      now.toISOString(),
    )
    .run();
}

async function seedCountryScope(country: string, id: string) {
  return env.BILLING_DB.prepare(
    `INSERT INTO indirect_tax_registration_scopes
     (id, organization_id, rule_set_id, country, region, status, registration_reference,
      effective_from, effective_to, created_at, updated_at)
     VALUES (?, ?, ?, ?, NULL, 'enabled', 'synthetic-only',
             '2020-01-01T00:00:00.000Z', NULL, ?, ?)`,
  )
    .bind(id, organizationId, ruleSetId, country, now.toISOString(), now.toISOString())
    .run();
}

async function seedWashingtonAddressRule() {
  await env.BILLING_DB.prepare(
    `INSERT INTO indirect_tax_registration_scopes
     (id, organization_id, rule_set_id, country, region, status, registration_reference,
      effective_from, effective_to, created_at, updated_at)
     VALUES (?, ?, ?, 'US', 'WA', 'enabled', 'test-only',
             '2020-01-01T00:00:00.000Z', NULL, ?, ?)`,
  )
    .bind(
      `scope-${organizationId}-WA`,
      organizationId,
      ruleSetId,
      now.toISOString(),
      now.toISOString(),
    )
    .run();
  await env.BILLING_DB.prepare(
    `INSERT INTO indirect_tax_rules
     (id, rule_set_id, country, region, postal_prefix, product_tax_code, taxability,
      rate_ppm, priority, source_url, source_reference, effective_from, effective_to,
      created_at, calculation_method)
     VALUES (?, ?, 'US', 'WA', NULL, 'txcd_10103100', 'taxable', 65000, 0,
             'https://webgis.dor.wa.gov/webapi/', 'test-only',
             '2020-01-01T00:00:00.000Z', NULL, ?, 'wa_dor_address')`,
  )
    .bind(`rule-${organizationId}-WA-address`, ruleSetId, now.toISOString())
    .run();
}

function washingtonResponse(
  input: {
    result?: 0 | 2 | 4;
    period?: string;
    stateRate?: string;
    localRate?: string;
  } = {},
): Response {
  const stateRate = input.stateRate ?? "0.065000";
  const localRate = input.localRate ?? "0.037500";
  const total = (Number(stateRate) + Number(localRate)).toFixed(6);
  return new Response(
    `<response result="${input.result ?? 0}" loccode="1726" rate="${total}">
       <rate staterate="${stateRate}" localrate="${localRate}" period="${input.period ?? "Q32026"}" jurisdiction="SEATTLE" county="KING" />
       <results location="700 FIFTH AVE" city="SEATTLE" zip="98104" plus4="" />
     </response>`,
    { headers: { "content-type": "application/xml" } },
  );
}
