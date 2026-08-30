import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

import { calculateLocalD1Tax } from "../src/tax/local-d1";

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
