import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
// @ts-expect-error Operator script is plain JavaScript, exercised against the migrated D1 schema.
import { buildCatalogSql } from "../scripts/store-plan-catalog.mjs";
import catalog from "../fixtures/store-full-base-catalog-2026-09-05.json";

async function apply(sql: string) {
  await env.BILLING_DB.batch(
    sql
      .replace(/^--.*$/gm, "")
      .split(";")
      .map((statement) => statement.trim())
      .filter(Boolean)
      .map((statement) => env.BILLING_DB.prepare(statement)),
  );
}

describe("Store catalog bootstrap", () => {
  it("adds all 15 correct variants atomically and replays without changing existing rows", async () => {
    const organization = "org-catalog-bootstrap";
    await env.BILLING_DB.prepare(
      "INSERT INTO organizations (id,external_id,name,created_at,updated_at) VALUES (?,?,?,'2026-09-05','2026-09-05')",
    )
      .bind(organization, organization, "Catalog bootstrap")
      .run();
    const sql = buildCatalogSql(catalog, organization);
    await apply(sql);
    const before = await env.BILLING_DB.prepare(
      "SELECT * FROM plans WHERE organization_id=? ORDER BY code",
    )
      .bind(organization)
      .all();
    expect(before.results).toHaveLength(15);
    expect(before.results.filter((row) => row.interval === "one_time")).toHaveLength(5);
    await apply(sql);
    const after = await env.BILLING_DB.prepare(
      "SELECT * FROM plans WHERE organization_id=? ORDER BY code",
    )
      .bind(organization)
      .all();
    expect(after.results).toEqual(before.results);
    expect(after.results.every((row) => row.pay_in_advance === 1)).toBe(true);
  });

  it("rejects the entire batch on an existing price conflict and preserves that row", async () => {
    const organization = "org-catalog-conflict";
    await env.BILLING_DB.prepare(
      "INSERT INTO organizations (id,external_id,name,created_at,updated_at) VALUES (?,?,?,'2026-09-05','2026-09-05')",
    )
      .bind(organization, organization, "Conflict")
      .run();
    await apply(buildCatalogSql({ ...catalog, plans: [catalog.plans[0]] }, organization));
    await env.BILLING_DB.prepare("UPDATE plans SET amount_minor=901 WHERE organization_id=?")
      .bind(organization)
      .run();
    await expect(apply(buildCatalogSql(catalog, organization))).rejects.toThrow();
    const rows = await env.BILLING_DB.prepare(
      "SELECT amount_minor FROM plans WHERE organization_id=?",
    )
      .bind(organization)
      .all();
    expect(rows.results).toEqual([{ amount_minor: 901 }]);
  });

  it("rejects unknown tenants and malformed or duplicate catalog input", async () => {
    await expect(apply(buildCatalogSql(catalog, "org-does-not-exist"))).rejects.toThrow();
    expect(() =>
      buildCatalogSql({ ...catalog, plans: [catalog.plans[0], catalog.plans[0]] }, "org-test"),
    ).toThrow();
    expect(() =>
      buildCatalogSql(
        { ...catalog, plans: [{ ...catalog.plans[0], amount_minor: -1 }] },
        "org-test",
      ),
    ).toThrow();
  });
});
