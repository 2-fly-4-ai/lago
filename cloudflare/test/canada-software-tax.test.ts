import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { calculateLocalD1Tax } from "../src/tax/local-d1";
// @ts-expect-error Plain-JavaScript offline candidate generator.
import { buildExpandedSoftwareCandidate } from "../scripts/expanded-software-tax-candidate.mjs";
import {
  addCanadianSoftwareRules,
  renderCanadianDraftSql,
  // @ts-expect-error Plain-JavaScript offline candidate generator.
} from "../scripts/canada-software-candidate.mjs";
import tedb from "../fixtures/indirect-tax/eu-tedb-standard-rates-2026-08-31.json";
import expansion from "../fixtures/indirect-tax/software-rate-expansion-2026-09-06.json";
import evidence from "../fixtures/indirect-tax/canada-software-components-2026-09-06.json";

const now = new Date("2026-09-06T12:00:00.000Z");
const artifact = addCanadianSoftwareRules(
  buildExpandedSoftwareCandidate(tedb, expansion, "2026-09-06"),
  evidence,
  "2026-09-06",
);
const organizationId = "org-canada-tax-test";
beforeAll(async () => {
  const statements = renderCanadianDraftSql(artifact, now.toISOString())
    .replace(/^--.*$/gm, "")
    .split(/;\s*\n/)
    .map((s: string) => s.trim())
    .filter(Boolean);
  await env.BILLING_DB.batch(statements.map((s: string) => env.BILLING_DB.prepare(s)));
  await env.BILLING_DB.batch([
    env.BILLING_DB.prepare(
      "UPDATE indirect_tax_rule_sets SET status='retired' WHERE status='active'",
    ),
    env.BILLING_DB.prepare(
      "UPDATE indirect_tax_rule_sets SET status='active', activated_at=? WHERE id=?",
    ).bind(now.toISOString(), artifact.id),
    env.BILLING_DB.prepare(
      "INSERT INTO organizations(id,external_id,name,created_at,updated_at) VALUES(?,?,?, ?, ?)",
    ).bind(organizationId, organizationId, "Canadian test", now.toISOString(), now.toISOString()),
    env.BILLING_DB.prepare(
      `INSERT INTO indirect_tax_registration_scopes(id,organization_id,rule_set_id,country,region,status,effective_from,effective_to,registration_reference,created_at,updated_at) VALUES(?,?,?,'CA',NULL,'enabled','2026-09-06T00:00:00.000Z',NULL,'fictional-local-scope',?,?)`,
    ).bind("scope-canada-test", organizationId, artifact.id, now.toISOString(), now.toISOString()),
  ]);
});
const quote = (state: string | null, subtotal = 900, taxCode = "txcd_10202000") =>
  calculateLocalD1Tax(
    env.BILLING_DB,
    {
      address: { country: "CA", state, postalCode: null },
      currency: "USD",
      organizationId,
      requestHash: "c".repeat(64),
      subtotalMinor: subtotal,
      taxCode,
    },
    now,
  );

describe("Canadian component-aware tax calculation", () => {
  it("rejects a taxable Canadian rule without its levy evidence even when collection is off", async () => {
    await env.BILLING_DB.prepare(`INSERT INTO indirect_tax_rules
      (id,rule_set_id,country,region,postal_prefix,product_tax_code,taxability,rate_ppm,priority,source_url,source_reference,effective_from,effective_to,created_at)
      VALUES('ca-incomplete-test',?,'CA','BC',NULL,'txcd_99999999','taxable',120000,0,'https://example.invalid','synthetic-negative-test','2026-09-06T00:00:00.000Z',NULL,?)`)
      .bind(artifact.id, now.toISOString())
      .run();
    for (const mode of ["collect", "off"]) {
      try {
        await env.BILLING_DB.prepare(
          "UPDATE indirect_tax_registration_scopes SET collection_mode=? WHERE id='scope-canada-test'",
        )
          .bind(mode)
          .run();
        await expect(quote("BC", 900, "txcd_99999999")).rejects.toMatchObject({
          code: "checkout_tax_components_invalid",
        });
      } finally {
        await env.BILLING_DB.prepare(
          "UPDATE indirect_tax_registration_scopes SET collection_mode='collect' WHERE id='scope-canada-test'",
        ).run();
      }
    }
    expect((await env.BILLING_DB.prepare("PRAGMA foreign_key_check").all()).results).toEqual([]);
  });
  it.each([
    ["AB", 45],
    ["BC", 108],
    ["MB", 108],
    ["NB", 135],
    ["NL", 135],
    ["NS", 126],
    ["NT", 45],
    ["NU", 45],
    ["ON", 117],
    ["PE", 135],
    ["QC", 135],
    ["SK", 99],
    ["YT", 45],
  ] as const)("calculates both software classifications for %s", async (region, tax) => {
    for (const taxCode of ["txcd_10103100", "txcd_10202000"])
      await expect(quote(region, 900, taxCode)).resolves.toMatchObject({
        taxMinor: tax,
        totalMinor: 900 + tax,
        collectionMode: "collect",
      });
  });
  it("rounds each independent levy rather than the summed percentage", async () => {
    await expect(quote("BC", 10)).resolves.toMatchObject({ taxMinor: 2, totalMinor: 12 });
    await expect(quote("QC", 10)).resolves.toMatchObject({ taxMinor: 2, totalMinor: 12 });
    await expect(quote("ON", 10)).resolves.toMatchObject({ taxMinor: 1, totalMinor: 11 });
  });
  it("rejects absent and unknown provinces instead of applying a federal-only default", async () => {
    for (const region of [null, "ZZ"])
      await expect(quote(region)).rejects.toMatchObject({ code: "checkout_tax_rule_missing" });
  });
  it("preserves immutable levy evidence after activation", async () => {
    const id = "ca-bc-txcd_10202000-20260906";
    await expect(
      env.BILLING_DB.prepare("UPDATE indirect_tax_rule_components SET rate_ppm=1 WHERE rule_id=?")
        .bind(id)
        .run(),
    ).rejects.toThrow();
    await expect(
      env.BILLING_DB.prepare("DELETE FROM indirect_tax_rule_components WHERE rule_id=?")
        .bind(id)
        .run(),
    ).rejects.toThrow();
    await expect(
      env.BILLING_DB.prepare(
        "INSERT INTO indirect_tax_rule_components(rule_id,code,rate_ppm,source_url) VALUES(?,'QST',1,'https://example.invalid')",
      )
        .bind(id)
        .run(),
    ).rejects.toThrow();
    await expect(quote("BC")).resolves.toMatchObject({ taxMinor: 108 });
  });
  it("charges no tax in off mode while retaining the same reviewed component rule", async () => {
    const original = await quote("BC");
    try {
      await env.BILLING_DB.prepare(
        "UPDATE indirect_tax_registration_scopes SET collection_mode='off' WHERE id='scope-canada-test'",
      ).run();
      const off = await quote("BC");
      expect(off).toMatchObject({
        taxMinor: 0,
        totalMinor: 900,
        collectionMode: "off",
        ruleId: original.ruleId,
      });
      expect(off.id).not.toBe(original.id);
    } finally {
      await env.BILLING_DB.prepare(
        "UPDATE indirect_tax_registration_scopes SET collection_mode='collect' WHERE id='scope-canada-test'",
      ).run();
    }
  });
});
