import { applyD1Migrations, env } from "cloudflare:test";
import { expect, it } from "vitest";

it("preserves historical uncertainty, backfills Elements, and freezes transport", async () => {
  const db = (env as typeof env & { MIGRATION_REHEARSAL_DB: D1Database }).MIGRATION_REHEARSAL_DB;
  for (const table of [
    "easy_pay_direct_payment_executions",
    "easy_pay_direct_automatic_payment_executions",
  ]) {
    await db
      .prepare(`CREATE TABLE ${table} (id TEXT PRIMARY KEY, payment_backend TEXT NOT NULL) STRICT`)
      .run();
    await db
      .prepare(
        `INSERT INTO ${table} VALUES ('legacy','gateway_vault'),('elements','commerce_elements')`,
      )
      .run();
  }
  await applyD1Migrations(
    db,
    env.TEST_MIGRATIONS!.filter((m) => m.name === "0120_epd_charge_transport.sql"),
  );
  for (const [table, legacy] of [
    ["easy_pay_direct_payment_executions", "legacy_unknown"],
    ["easy_pay_direct_automatic_payment_executions", "gateway"],
  ]) {
    expect(
      (await db.prepare(`SELECT id, charge_transport FROM ${table} ORDER BY id`).all()).results,
    ).toEqual([
      { id: "elements", charge_transport: "commerce" },
      { id: "legacy", charge_transport: legacy },
    ]);
    await expect(
      db.prepare(`UPDATE ${table} SET charge_transport='commerce' WHERE id='legacy'`).run(),
    ).rejects.toThrow(/immutable_epd_charge_transport/);
    await expect(
      db.prepare(`INSERT INTO ${table} VALUES ('invalid','commerce_elements','gateway')`).run(),
    ).rejects.toThrow(/invalid_epd_charge_transport/);
    await db.prepare(`INSERT INTO ${table} VALUES ('gateway','gateway_vault','gateway')`).run();
  }
  expect((await db.prepare("PRAGMA foreign_key_check").all()).results).toEqual([]);
});
