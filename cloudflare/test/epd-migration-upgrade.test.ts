import { applyD1Migrations, env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

// A populated 0113 baseline, not a production dump or the normal test BILLING_DB.
const db = (env as typeof env & { MIGRATION_REHEARSAL_DB: D1Database }).MIGRATION_REHEARSAL_DB;
const now = "2026-09-08T00:00:00.000Z";

describe("EPD additive migration upgrade rehearsal (local only)", () => {
  it("preserves legacy financial evidence and enforces the new protections across 0114–0124", async () => {
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
      "0122_easy_pay_direct_live_refunds.sql",
      "0123_backfill_customer_invoice_currency.sql",
      "0124_enable_reviewed_epd_recurring_products.sql",
    ]);
    await applyD1Migrations(
      db,
      migrations.filter((migration) => !pending.includes(migration)),
    );
    await seedLegacyEvidence();
    const tables = ["organizations", "invoices", "payment_attempts", "webhook_receipts"];
    const before = await Promise.all(tables.map((table) => rows(table)));
    const customersBefore = await rows("customers");
    const refundsBefore = await rows("provider_refund_operations");
    const disputesBefore = await rows("payment_disputes");
    const profilesBefore = await rows("provider_customer_profiles");
    const automaticBefore = await rows("easy_pay_direct_automatic_payment_executions");
    const triggersBefore = await db
      .prepare("SELECT name, tbl_name, sql FROM sqlite_master WHERE type = 'trigger' ORDER BY name")
      .all();

    await applyD1Migrations(db, pending);
    expect(await Promise.all(tables.map((table) => rows(table)))).toEqual(before);
    expect(await rows("customers")).toEqual(
      customersBefore.map((row) =>
        row.id === "customer" ? { ...row, currency: "USD", version: Number(row.version) + 1 } : row,
      ),
    );
    for (const id of [
      "customer-request-conflict",
      "customer-plan-conflict",
      "customer-wallet-conflict",
    ]) {
      await expect(
        db.prepare("SELECT currency, version FROM customers WHERE id = ?").bind(id).first(),
      ).resolves.toEqual({ currency: null, version: 1 });
    }
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
    for (const organizationId of ["org-synthetic-e2e-20260815-001", "org-epd-serptest-20260909"]) {
      const recurringPolicies = await db
        .prepare(
          `SELECT product_slug, status
           FROM easy_pay_direct_product_collection_policies
           WHERE organization_id = ?
           ORDER BY product_slug`,
        )
        .bind(organizationId)
        .all();
      expect(recurringPolicies.results).toHaveLength(48);
      expect(recurringPolicies.results).toContainEqual({
        product_slug: "cam4-video-downloader",
        status: "enabled",
      });
      expect(recurringPolicies.results).toContainEqual({
        product_slug: "sprout-video-downloader",
        status: "enabled",
      });
      expect(recurringPolicies.results).not.toContainEqual(
        expect.objectContaining({ product_slug: "eporner-video-downloader" }),
      );
    }
    expect(
      (
        await db
          .prepare(
            "SELECT COUNT(*) AS count FROM easy_pay_direct_product_collection_policies WHERE organization_id = 'org-serp-billing'",
          )
          .first<{ count: number }>()
      )?.count,
    ).toBe(0);
    const triggersAfter = await db
      .prepare("SELECT name, tbl_name, sql FROM sqlite_master WHERE type = 'trigger' ORDER BY name")
      .all();
    const replacedTriggers = new Set([
      "easy_pay_direct_automatic_execution_scope_guard",
      "easy_pay_direct_automatic_execution_identity_immutable",
      "credit_note_refund_scope_guard",
      "credit_note_refund_identity_immutable",
    ]);
    expect(
      triggersAfter.results.filter(
        (row) =>
          !replacedTriggers.has(String(row.name)) &&
          triggersBefore.results.some((old) => old.name === row.name),
      ),
    ).toEqual(triggersBefore.results.filter((row) => !replacedTriggers.has(String(row.name))));
    for (const name of [
      "easy_pay_direct_automatic_execution_scope_guard",
      "easy_pay_direct_automatic_execution_identity_immutable",
    ])
      expect(triggersAfter.results.find((row) => row.name === name)?.sql).toContain(
        "payment_backend",
      );
    expect(
      triggersAfter.results.find((row) => row.name === "credit_note_refund_scope_guard")?.sql,
    ).toContain("credit_note_refund_scope_conflict");
    expect(
      triggersAfter.results.find((row) => row.name === "credit_note_refund_identity_immutable")
        ?.sql,
    ).toContain("immutable_credit_note_refund_identity");
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
        "INSERT INTO organizations (id, external_id, name, created_at, updated_at) VALUES ('org-serp-billing', 'org-serp-billing', 'SERP Billing', ?, ?)",
      )
      .bind(now, now),
    db
      .prepare(
        "INSERT INTO organizations (id, external_id, name, created_at, updated_at) VALUES ('org-synthetic-e2e-20260815-001', 'org-synthetic-e2e-20260815-001', 'Synthetic staging', ?, ?)",
      )
      .bind(now, now),
    db
      .prepare(
        "INSERT INTO organizations (id, external_id, name, created_at, updated_at) VALUES ('org-epd-serptest-20260909', 'org-epd-serptest-20260909', 'EPD SerpTEST staging', ?, ?)",
      )
      .bind(now, now),
    db
      .prepare(
        "INSERT INTO customers (id, organization_id, external_id, email, payment_provider, payment_provider_code, created_at, updated_at) VALUES ('customer', 'org', 'customer', 'migration@example.test', 'easy_pay_direct', 'fictional-account', ?, ?)",
      )
      .bind(now, now),
    db
      .prepare(
        "INSERT INTO customers (id, organization_id, external_id, email, payment_provider, payment_provider_code, created_at, updated_at) VALUES ('customer-no-invoice', 'org', 'customer-no-invoice', 'no-invoice@example.test', 'easy_pay_direct', 'fictional-account', ?, ?)",
      )
      .bind(now, now),
    db
      .prepare(
        "INSERT INTO customers (id, organization_id, external_id, email, payment_provider, payment_provider_code, created_at, updated_at) VALUES ('customer-mixed', 'org', 'customer-mixed', 'mixed@example.test', 'easy_pay_direct', 'fictional-account', ?, ?)",
      )
      .bind(now, now),
    db
      .prepare(
        "INSERT INTO customers (id, organization_id, external_id, email, currency, payment_provider, payment_provider_code, created_at, updated_at) VALUES ('customer-existing', 'org', 'customer-existing', 'existing@example.test', 'GBP', 'easy_pay_direct', 'fictional-account', ?, ?)",
      )
      .bind(now, now),
    db
      .prepare(
        "INSERT INTO customers (id, organization_id, external_id, email, payment_provider, payment_provider_code, created_at, updated_at) VALUES ('customer-other-provider', 'org', 'customer-other-provider', 'other@example.test', 'stripe', 'stripe', ?, ?)",
      )
      .bind(now, now),
    ...["request", "plan", "wallet"].map((kind) =>
      db
        .prepare(
          "INSERT INTO customers (id, organization_id, external_id, email, payment_provider, payment_provider_code, created_at, updated_at) VALUES (?, 'org', ?, ?, 'easy_pay_direct', 'fictional-account', ?, ?)",
        )
        .bind(
          `customer-${kind}-conflict`,
          `customer-${kind}-conflict`,
          `${kind}-conflict@example.test`,
          now,
          now,
        ),
    ),
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
        "INSERT INTO invoices (id, organization_id, customer_id, status, payment_status, currency, subtotal_minor, total_due_minor, created_at, updated_at) VALUES ('invoice-mixed-usd', 'org', 'customer-mixed', 'finalized', 'succeeded', 'USD', 100, 100, ?, ?)",
      )
      .bind(now, now),
    db
      .prepare(
        "INSERT INTO invoices (id, organization_id, customer_id, status, payment_status, currency, subtotal_minor, total_due_minor, created_at, updated_at) VALUES ('invoice-mixed-eur', 'org', 'customer-mixed', 'finalized', 'succeeded', 'EUR', 100, 100, ?, ?)",
      )
      .bind(now, now),
    db
      .prepare(
        "INSERT INTO invoices (id, organization_id, customer_id, status, payment_status, currency, subtotal_minor, total_due_minor, created_at, updated_at) VALUES ('invoice-other-provider', 'org', 'customer-other-provider', 'finalized', 'succeeded', 'USD', 100, 100, ?, ?)",
      )
      .bind(now, now),
    ...["request", "plan", "wallet"].map((kind) =>
      db
        .prepare(
          "INSERT INTO invoices (id, organization_id, customer_id, status, payment_status, currency, subtotal_minor, total_due_minor, created_at, updated_at) VALUES (?, 'org', ?, 'finalized', 'succeeded', 'USD', 100, 100, ?, ?)",
        )
        .bind(`invoice-${kind}-conflict`, `customer-${kind}-conflict`, now, now),
    ),
    db
      .prepare(
        "INSERT INTO payment_requests (id, organization_id, customer_id, amount_minor, currency, payment_status, ready_for_payment_processing, created_at, updated_at) VALUES ('currency-conflict-request', 'org', 'customer-request-conflict', 100, 'EUR', 'pending', 1, ?, ?)",
      )
      .bind(now, now),
    db
      .prepare(
        "INSERT INTO plans (id, organization_id, code, name, interval, amount_minor, currency, created_at, updated_at) VALUES ('currency-conflict-plan', 'org', 'currency-conflict-plan', 'Currency conflict', 'monthly', 100, 'EUR', ?, ?)",
      )
      .bind(now, now),
    db
      .prepare(
        "INSERT INTO subscriptions (id, organization_id, customer_id, plan_id, external_id, status, created_at, updated_at) VALUES ('currency-conflict-subscription', 'org', 'customer-plan-conflict', 'currency-conflict-plan', 'currency-conflict-subscription', 'active', ?, ?)",
      )
      .bind(now, now),
    db
      .prepare(
        `INSERT INTO wallets
         (id, organization_id, customer_id, code, currency, currency_exponent, rate_amount,
          priority, balance_minor, consumed_minor, status, request_sha256, created_at, updated_at)
         VALUES ('currency-conflict-wallet', 'org', 'customer-wallet-conflict',
                 'currency-conflict-wallet', 'EUR', 2, '1', 1, 0, 0, 'active',
                 'currency-conflict-wallet-hash', ?, ?)`,
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
