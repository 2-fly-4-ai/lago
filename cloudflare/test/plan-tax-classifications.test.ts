import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
// @ts-expect-error Plain-JavaScript operator generator tested against migrated D1.
import { buildCatalogSql } from "../scripts/store-plan-catalog.mjs";
// @ts-expect-error Plain-JavaScript operator generator tested against migrated D1.
import { buildPlanTaxClassificationSql } from "../scripts/plan-tax-classifications.mjs";
import catalog from "../fixtures/store-generic-catalog-2026-09-05.json";
import review from "../fixtures/indirect-tax/generic-plan-classifications-2026-09-06.json";

async function apply(sql: string) {
  await env.BILLING_DB.batch(
    sql
      .replace(/^--.*$/gm, "")
      .split(";")
      .map((s) => s.trim())
      .filter(Boolean)
      .map((s) => env.BILLING_DB.prepare(s)),
  );
}
async function seed() {
  const id = `org-classification-${crypto.randomUUID()}`;
  await env.BILLING_DB.prepare(
    "INSERT INTO organizations(id,external_id,name,created_at,updated_at) VALUES(?,?,?,'2026-09-06','2026-09-06')",
  )
    .bind(id, id, "Classification test")
    .run();
  await apply(buildCatalogSql(catalog, id));
  return id;
}
describe("Generic plan tax classification", () => {
  it("classifies all 13 variants without changing prices, cadence or unrelated metadata, and replays exactly", async () => {
    const id = await seed();
    const before = await env.BILLING_DB.prepare(
      "SELECT code,amount_minor,interval,currency,version FROM plans WHERE organization_id=? ORDER BY code",
    )
      .bind(id)
      .all();
    const patch = buildPlanTaxClassificationSql(catalog, review, id);
    await apply(patch);
    const rows = await env.BILLING_DB.prepare(
      "SELECT * FROM plans WHERE organization_id=? ORDER BY code",
    )
      .bind(id)
      .all();
    expect(rows.results).toHaveLength(13);
    expect(
      rows.results.every((r) => JSON.parse(String(r.metadata_json)).tax_code === review.tax_code),
    ).toBe(true);
    expect(
      rows.results.every(
        (r) => JSON.parse(String(r.metadata_json)).source_commit === catalog.source_commit,
      ),
    ).toBe(true);
    expect(
      (
        await env.BILLING_DB.prepare(
          "SELECT code,amount_minor,interval,currency,version FROM plans WHERE organization_id=? ORDER BY code",
        )
          .bind(id)
          .all()
      ).results,
    ).toEqual(before.results);
    await apply(patch);
    expect(
      (
        await env.BILLING_DB.prepare("SELECT * FROM plans WHERE organization_id=? ORDER BY code")
          .bind(id)
          .all()
      ).results,
    ).toEqual(rows.results);
  });
  it.each(["price", "classification", "missing"])(
    "rolls the whole backfill back for %s conflicts",
    async (conflict) => {
      const id = await seed();
      const code = catalog.plans.at(-1)!.code;
      const change =
        conflict === "price"
          ? "amount_minor=1"
          : conflict === "missing"
            ? "active=0"
            : `metadata_json='{"tax_code":"txcd_10103100"}'`;
      await env.BILLING_DB.prepare(`UPDATE plans SET ${change} WHERE organization_id=? AND code=?`)
        .bind(id, code)
        .run();
      await expect(apply(buildPlanTaxClassificationSql(catalog, review, id))).rejects.toThrow();
      expect(
        (await env.BILLING_DB.prepare(
          "SELECT COUNT(*) AS n FROM plans WHERE organization_id=? AND json_extract(metadata_json,'$.tax_code')='txcd_10202000'",
        )
          .bind(id)
          .first<{ n: number }>())!.n,
      ).toBe(0);
    },
  );
  it("rejects incomplete reviews and unknown tenants", async () => {
    expect(() =>
      buildPlanTaxClassificationSql(
        catalog,
        { ...review, plan_codes: review.plan_codes.slice(1) },
        "org-test",
      ),
    ).toThrow();
    expect(() =>
      buildPlanTaxClassificationSql(
        catalog,
        { ...review, source_commit: "0".repeat(40) },
        "org-test",
      ),
    ).toThrow();
    await expect(
      apply(buildPlanTaxClassificationSql(catalog, review, "org-absent")),
    ).rejects.toThrow();
  });
});
