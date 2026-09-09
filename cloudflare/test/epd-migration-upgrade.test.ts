import { applyD1Migrations, env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

// A populated 0113 baseline, not a production dump or the normal test BILLING_DB.
const db = (env as typeof env & { MIGRATION_REHEARSAL_DB: D1Database }).MIGRATION_REHEARSAL_DB;
const now = "2026-09-08T00:00:00.000Z";

describe("EPD additive migration upgrade rehearsal (local only)", () => {
  it("preserves legacy financial evidence and enforces the new protections across 0114–0121", async () => {
    const migrations = env.TEST_MIGRATIONS!;
    const pending = migrations.filter((migration) => Number(migration.name.slice(0, 4)) >= 114);
    expect(pending.map((migration) => migration.name)).toEqual([
      "0114_epd_refund_read_checkpoint.sql",
      "0115_fulfillment_source_snapshots.sql",
      "0116_epd_dispute_event_provenance.sql",
      "0117_epd_dunning_review_holds.sql",
      "0118_expired_epd_cancellation_fences.sql",
      "0119_epd_commerce_renewal_backends.sql",
      "0120_epd_charge_transport.sql",
      "0121_gateway_refund_attempts.sql",
    ]);
    await applyD1Migrations(
      db,
      migrations.filter((migration) => !pending.includes(migration)),
    );
    await seedLegacyEvidence();
    const tables = [
      "organizations",
      "customers",
      "invoices",
      "payment_attempts",
      "webhook_receipts",
    ];
    const before = await Promise.all(tables.map((table) => rows(table)));
    const refundsBefore = await rows("provider_refund_operations");
    const disputesBefore = await rows("payment_disputes");
    const profilesBefore = await rows("provider_customer_profiles");
    const automaticBefore = await rows("easy_pay_direct_automatic_payment_executions");
    const triggersBefore = await db
      .prepare("SELECT name, tbl_name, sql FROM sqlite_master WHERE type = 'trigger' ORDER BY name")
      .all();

    await applyD1Migrations(db, pending);
    expect(await Promise.all(tables.map((table) => rows(table)))).toEqual(before);
    expect(await rows("provider_refund_operations")).toEqual(
      refundsBefore.map((row) => ({ ...row, provider_refund_transaction_id: null })),
    );
    expect(await rows("payment_disputes")).toEqual(
      disputesBefore.map((row) => ({ ...row, last_provider_event_receipt_id: null })),
    );
    expect(await rows("provider_customer_profiles")).toEqual(
      profilesBefore.map((row) => ({ ...row, payment_backend: "gateway_vault" })),
    );
    expect(await rows("easy_pay_direct_automatic_payment_executions")).toEqual(
      automaticBefore.map((row) => ({
        ...row,
        payment_backend: "gateway_vault",
        charge_transport: "gateway",
        commerce_customer_id: null,
        commerce_payment_method_id: null,
        product_idempotency_key: null,
        order_idempotency_key: null,
        commerce_product_id: null,
        commerce_order_id: null,
        order_submit_started_at: null,
      })),
    );
    // Existing locally-timestamped dispute heads must not acquire invented provenance.
    expect((await db.prepare("PRAGMA foreign_key_check").all()).results).toEqual([]);
    const triggersAfter = await db
      .prepare("SELECT name, tbl_name, sql FROM sqlite_master WHERE type = 'trigger' ORDER BY name")
      .all();
    const replacedTriggers = new Set([
      "easy_pay_direct_automatic_execution_scope_guard",
      "easy_pay_direct_automatic_execution_identity_immutable",
    ]);
    expect(
      triggersAfter.results.filter(
        (row) =>
          !replacedTriggers.has(String(row.name)) &&
          triggersBefore.results.some((old) => old.name === row.name),
      ),
    ).toEqual(triggersBefore.results.filter((row) => !replacedTriggers.has(String(row.name))));
    for (const name of replacedTriggers) {
      expect(triggersAfter.results.find((row) => row.name === name)?.sql).toContain(
        "payment_backend",
      );
    }
    expect(
      triggersAfter.results
        .filter((row) => !triggersBefore.results.some((old) => old.name === row.name))
        .map((row) => row.tbl_name)
        .sort(),
    ).toEqual([
      "easy_pay_direct_automatic_payment_executions",
      "easy_pay_direct_automatic_payment_executions",
      "easy_pay_direct_automatic_payment_executions",
      "easy_pay_direct_payment_executions",
      "easy_pay_direct_payment_executions",
      "easy_pay_direct_payment_executions",
      "fulfillment_source_snapshot_history",
      "fulfillment_source_snapshot_history",
      "gateway_refund_attempts",
      "gateway_refund_attempts",
      "provider_customer_profiles",
      "provider_customer_profiles",
      "provider_refund_operations",
    ]);

    expect(await rows("gateway_refund_attempts")).toEqual([]);
    await db
      .prepare(
        "INSERT INTO gateway_refund_attempts(operation_id,status,response_transaction_id,created_at,updated_at) VALUES ('refund-a','submitted','original-sale',?,?)",
      )
      .bind(now, now)
      .run();
    await db
      .prepare(
        "UPDATE gateway_refund_attempts SET status = 'succeeded' WHERE operation_id = 'refund-a'",
      )
      .run();
    await expect(
      db
        .prepare(
          "UPDATE gateway_refund_attempts SET status = 'unknown' WHERE operation_id = 'refund-a'",
        )
        .run(),
    ).rejects.toThrow(/immutable_gateway_refund_terminal_outcome/);
    await expect(
      db
        .prepare(
          "UPDATE gateway_refund_attempts SET operation_id = 'refund-b' WHERE operation_id = 'refund-a'",
        )
        .run(),
    ).rejects.toThrow(/immutable_gateway_refund/);
    expect(await rows("provider_refund_operations")).toEqual(
      refundsBefore.map((row) => ({ ...row, provider_refund_transaction_id: null })),
    );
    expect((await db.prepare("PRAGMA foreign_key_check").all()).results).toEqual([]);

    await db
      .prepare(
        "UPDATE provider_refund_operations SET provider_refund_transaction_id = 'fictional-refund-transaction' WHERE id = 'refund-a'",
      )
      .run();
    await expect(
      db
        .prepare(
          "UPDATE provider_refund_operations SET provider_refund_transaction_id = 'fictional-refund-transaction' WHERE id = 'refund-b'",
        )
        .run(),
    ).rejects.toThrow(/UNIQUE/);
    await expect(
      db
        .prepare(
          "UPDATE provider_refund_operations SET provider_refund_transaction_id = NULL WHERE id = 'refund-a'",
        )
        .run(),
    ).rejects.toThrow(/immutable_provider_refund_transaction/);
    await expect(
      db
        .prepare(
          "UPDATE provider_refund_operations SET provider_refund_transaction_id = 'replacement' WHERE id = 'refund-a'",
        )
        .run(),
    ).rejects.toThrow(/immutable_provider_refund_transaction/);

    await expect(
      db
        .prepare(
          "UPDATE payment_disputes SET last_provider_event_receipt_id = 'missing' WHERE id = 'dispute'",
        )
        .run(),
    ).rejects.toThrow(/FOREIGN KEY/);
    await db
      .prepare(
        "UPDATE payment_disputes SET last_provider_event_receipt_id = 'receipt' WHERE id = 'dispute'",
      )
      .run();
    await expect(
      db.prepare("DELETE FROM webhook_receipts WHERE id = 'receipt'").run(),
    ).rejects.toThrow(/FOREIGN KEY/);

    await db
      .prepare(
        "INSERT INTO fulfillment_source_snapshot_history VALUES ('org', 'subscription', 1, '{}', ?)",
      )
      .bind(now)
      .run();
    await expect(
      db
        .prepare(
          "UPDATE fulfillment_source_snapshot_history SET payload_json = '{\"changed\":true}'",
        )
        .run(),
    ).rejects.toThrow(/immutable_fulfillment_source_snapshot/);
    await expect(
      db.prepare("DELETE FROM fulfillment_source_snapshot_history").run(),
    ).rejects.toThrow(/immutable_fulfillment_source_snapshot/);
    await expect(
      db
        .prepare(
          "INSERT INTO fulfillment_source_snapshot_history VALUES ('org', 'invalid', 1, 'not-json', ?)",
        )
        .bind(now)
        .run(),
    ).rejects.toThrow(/CHECK/);
    await expect(
      db
        .prepare(
          "INSERT INTO fulfillment_source_snapshot_history VALUES ('org', 'invalid', 0, '{}', ?)",
        )
        .bind(now)
        .run(),
    ).rejects.toThrow(/CHECK/);

    // Exercise actual D1 batch rollback, not just a mocked failed assertion.
    const hold = db
      .prepare(
        "INSERT INTO epd_dunning_review_holds VALUES ('org', 'customer', 'campaign', 'multiple_eligible_provider_profiles', 'held', ?, ?, NULL)",
      )
      .bind(now, now);
    await expect(
      db.batch([hold, db.prepare("INSERT INTO epd_dunning_attempt_fences VALUES ('guard', 0)")]),
    ).rejects.toThrow(/epd_dunning_eligibility_current/);
    expect(await rows("epd_dunning_review_holds")).toEqual([]);
    expect(await rows("epd_dunning_attempt_fences")).toEqual([]);
    await db.batch([
      db.prepare("INSERT INTO epd_dunning_attempt_fences VALUES ('guard', 1)"),
      hold,
      db.prepare("DELETE FROM epd_dunning_attempt_fences WHERE guard_id = 'guard'"),
    ]);
    expect(await rows("epd_dunning_attempt_fences")).toEqual([]);
    expect(await rows("epd_dunning_review_holds")).toHaveLength(1);
    await expect(
      db.batch([
        db.prepare("UPDATE epd_dunning_review_holds SET status = 'resolved'"),
        db.prepare("INSERT INTO expired_epd_cancellation_fences VALUES ('expired', 0)"),
      ]),
    ).rejects.toThrow(/expired_epd_cancellation_current/);
    expect((await rows("epd_dunning_review_holds"))[0]?.status).toBe("held");
    expect(await rows("expired_epd_cancellation_fences")).toEqual([]);

    // The migration journal, not rerunning raw ALTER statements, makes retries safe.
    const journal = await db.prepare("SELECT * FROM d1_migrations ORDER BY id").all();
    const refundsAfter = await rows("provider_refund_operations");
    await applyD1Migrations(db, migrations);
    expect(
      await db
        .prepare("SELECT * FROM d1_migrations ORDER BY id")
        .all()
        .then((result) => result.results),
    ).toEqual(journal.results);
    expect(await rows("provider_refund_operations")).toEqual(refundsAfter);
    expect((await db.prepare("PRAGMA foreign_key_check").all()).results).toEqual([]);
  }, 30_000);
});

async function rows(table: string) {
  // All table names are source-defined test constants, never user input.
  return (await db.prepare(`SELECT * FROM ${table} ORDER BY 1`).all()).results;
}

async function seedLegacyEvidence() {
  await db.batch([
    db
      .prepare(
        "INSERT INTO organizations (id, external_id, name, created_at, updated_at) VALUES ('org', 'org', 'Migration rehearsal', ?, ?)",
      )
      .bind(now, now),
    db
      .prepare(
        "INSERT INTO customers (id, organization_id, external_id, email, payment_provider, payment_provider_code, created_at, updated_at) VALUES ('customer', 'org', 'customer', 'migration@example.test', 'easy_pay_direct', 'fictional-account', ?, ?)",
      )
      .bind(now, now),
    db
      .prepare(
        "INSERT INTO provider_customer_profiles (id, organization_id, customer_id, provider, provider_account_code, provider_customer_id, gateway_customer_vault_id, initial_transaction_id, status, created_at, updated_at) VALUES ('profile', 'org', 'customer', 'easy_pay_direct', 'fictional-account', 'legacy-customer', '1234', '5678', 'active', ?, ?)",
      )
      .bind(now, now),
    db
      .prepare(
        "INSERT INTO payment_requests (id, organization_id, customer_id, amount_minor, currency, payment_status, ready_for_payment_processing, created_at, updated_at) VALUES ('renewal-request', 'org', 'customer', 900, 'USD', 'pending', 1, ?, ?)",
      )
      .bind(now, now),
    db
      .prepare(
        "INSERT INTO easy_pay_direct_automatic_payment_executions (id, organization_id, payment_request_id, customer_id, provider_profile_id, provider_account_code, request_sha256, gateway_customer_vault_id, initial_transaction_id, order_reference, status, attempt_count, created_at, updated_at) VALUES ('renewal-execution', 'org', 'renewal-request', 'customer', 'profile', 'fictional-account', 'legacy-hash', '1234', '5678', 'legacy-reference', 'unknown', 1, ?, ?)",
      )
      .bind(now, now),
    db
      .prepare(
        "INSERT INTO invoices (id, organization_id, customer_id, status, payment_status, currency, subtotal_minor, total_due_minor, created_at, updated_at) VALUES ('invoice', 'org', 'customer', 'finalized', 'succeeded', 'USD', 900, 900, ?, ?)",
      )
      .bind(now, now),
    db
      .prepare(
        "INSERT INTO payment_attempts (id, organization_id, invoice_id, provider, provider_account_code, provider_transaction_id, idempotency_key, amount_minor, currency, status, created_at, updated_at) VALUES ('payment', 'org', 'invoice', 'easy_pay_direct', 'fictional-account', 'fictional-sale', 'payment', 900, 'USD', 'succeeded', ?, ?)",
      )
      .bind(now, now),
    ...["a", "b"].map((suffix) =>
      db
        .prepare(
          "INSERT INTO provider_refund_operations (id, organization_id, invoice_id, payment_attempt_id, provider, provider_account_code, provider_payment_id, idempotency_key, request_sha256, amount_minor, currency, status, created_at, updated_at) VALUES (?, 'org', 'invoice', 'payment', 'easy_pay_direct', 'fictional-account', 'fictional-sale', ?, 'fictional-hash', 100, 'USD', 'pending', ?, ?)",
        )
        .bind(`refund-${suffix}`, `refund-${suffix}`, now, now),
    ),
    db
      .prepare(
        "INSERT INTO payment_disputes (id, organization_id, provider, provider_account_code, provider_dispute_id, payment_attempt_id, invoice_id, amount_minor, currency, status, livemode, provider_created_at, last_provider_event_created_at, created_at, updated_at) VALUES ('dispute', 'org', 'easy_pay_direct', 'fictional-account', 'fictional-dispute', 'payment', 'invoice', 900, 'USD', 'under_review', 0, ?, ?, ?, ?)",
      )
      .bind(now, now, now, now),
    db
      .prepare(
        "INSERT INTO webhook_receipts (id, provider, provider_account_code, provider_event_id, signature_valid, payload_sha256, received_at) VALUES ('receipt', 'easy_pay_direct', 'fictional-account', 'fictional-event', 1, 'fictional-hash', ?)",
      )
      .bind(now),
  ]);
}
