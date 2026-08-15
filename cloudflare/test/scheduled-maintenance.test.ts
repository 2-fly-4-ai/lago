import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanupInboundWebhookReceipts,
  cleanupOutboundWebhookDeliveries,
  expireCoupons,
  expireWallets,
  finalizeDueInvoices,
  markInvoicesOverdue,
  webhookRetentionCutoff,
} from "../src/schedules/maintenance";
import {
  dueLegacySchedules,
  LEGACY_SCHEDULES,
  scheduleInstanceId,
} from "../src/schedules/registry";
import {
  expireRecurringWalletRules,
  isRecurringDateDue,
  topUpDueRecurringWallets,
} from "../src/schedules/recurring-wallets";

beforeEach(async () => {
  const now = "2026-08-14T00:00:00.000Z";
  await env.BILLING_DB.batch([
    env.BILLING_DB.prepare(
      `DELETE FROM outbox_events WHERE aggregate_id IN
       ('invoice-overdue', 'invoice-future', 'invoice-draft-due', 'invoice-draft-future',
        'coupon-expired', 'coupon-future', 'wallet-expired', 'wallet-future',
        'rule-recurring-expired', 'rule-recurring-future')
        OR aggregate_type = 'wallet_transaction'`,
    ),
    env.BILLING_DB.prepare(
      `DELETE FROM wallet_transactions
       WHERE wallet_id IN
       ('wallet-recurring-due', 'wallet-recurring-created-today', 'wallet-recurring-imported')`,
    ),
    env.BILLING_DB.prepare(
      "DELETE FROM outbound_webhook_deliveries WHERE webhook_endpoint_id = 'endpoint-schedule'",
    ),
    env.BILLING_DB.prepare(
      `DELETE FROM webhook_receipts WHERE id IN
       ('receipt-old', 'receipt-recent', 'receipt-retry')`,
    ),
    env.BILLING_DB.prepare(
      "DELETE FROM artifact_cleanup_tasks WHERE resource_type = 'webhook_receipt'",
    ),
    env.BILLING_DB.prepare("DELETE FROM webhook_endpoints WHERE id = 'endpoint-schedule'"),
    env.BILLING_DB.prepare(
      `DELETE FROM invoices WHERE id IN
       ('invoice-overdue', 'invoice-future', 'invoice-draft-due', 'invoice-draft-future')`,
    ),
    env.BILLING_DB.prepare("DELETE FROM coupons WHERE id IN ('coupon-expired', 'coupon-future')"),
    env.BILLING_DB.prepare(
      `DELETE FROM wallets WHERE id IN
       ('wallet-expired', 'wallet-future', 'wallet-recurring-due',
        'wallet-recurring-created-today', 'wallet-recurring-expired',
        'wallet-recurring-imported')`,
    ),
    env.BILLING_DB.prepare(
      `INSERT OR IGNORE INTO organizations (id, external_id, name, created_at, updated_at)
       VALUES ('org-schedule', 'schedule-test', 'Schedule Test', ?, ?)`,
    ).bind(now, now),
    env.BILLING_DB.prepare(
      `INSERT OR IGNORE INTO customers
       (id, organization_id, external_id, currency, metadata_json, created_at, updated_at)
       VALUES ('customer-schedule', 'org-schedule', 'schedule-customer', 'USD', '{}', ?, ?)`,
    ).bind(now, now),
    couponStatement("coupon-expired", "expired", "2026-08-14T00:29:59.000Z", now),
    couponStatement("coupon-future", "future", "2026-08-14T00:30:01.000Z", now),
    walletStatement("wallet-expired", "expired", "2026-08-14T00:44:59.000Z", now),
    walletStatement("wallet-future", "future", "2026-08-14T00:45:01.000Z", now),
    invoiceStatement("invoice-overdue", "INV-OVERDUE", "2026-08-13", now),
    invoiceStatement("invoice-future", "INV-FUTURE", "2026-08-15", now),
    draftInvoiceStatement("invoice-draft-due", "INV-DRAFT-DUE", "2026-08-14", now),
    draftInvoiceStatement("invoice-draft-future", "INV-DRAFT-FUTURE", "2026-08-15", now),
  ]);
});

describe("legacy schedule ownership", () => {
  it("maps all 27 Clockwork schedules exactly once", () => {
    expect(LEGACY_SCHEDULES).toHaveLength(27);
    expect(new Set(LEGACY_SCHEDULES.map((schedule) => schedule.key)).size).toBe(27);
    expect(
      LEGACY_SCHEDULES.filter((schedule) => schedule.executor).map((schedule) => schedule.key),
    ).toEqual([
      "schedule:activate_subscriptions",
      "schedule:refresh_draft_invoices",
      "schedule:process_subscription_activity",
      "schedule:process_dedicated_orgs_subscription_activities",
      "schedule:refresh_lifetime_usages",
      "schedule:refresh_wallets_ongoing_balance",
      "schedule:terminate_ended_subscriptions",
      "schedule:bill_customers",
      "schedule:api_keys_track_usage",
      "schedule:finalize_invoices",
      "schedule:mark_invoices_as_payment_overdue",
      "schedule:terminate_coupons",
      "schedule:bill_ended_trial_subscriptions",
      "schedule:terminate_wallets",
      "schedule:termination_alert",
      "schedule:terminate_expired_wallet_transaction_rules",
      "schedule:top_up_wallet_interval_credits",
      "schedule:clean_webhooks",
      "schedule:clean_inbound_webhooks",
      "schedule:post_validate_events",
      "schedule:compute_daily_usage",
      "schedule:retry_inbound_webhooks",
      "schedule:refresh_flagged_subscriptions",
    ]);
  });

  it("selects deterministic UTC slots and workflow instance IDs", () => {
    const triggeredAt = Date.parse("2026-08-14T01:30:00.000Z");
    const due = dueLegacySchedules(triggeredAt).map((schedule) => schedule.key);
    expect(due).toEqual([
      "schedule:activate_subscriptions",
      "schedule:refresh_draft_invoices",
      "schedule:process_subscription_activity",
      "schedule:process_dedicated_orgs_subscription_activities",
      "schedule:refresh_lifetime_usages",
      "schedule:refresh_wallets_ongoing_balance",
      "schedule:retry_generating_subscription_invoices",
      "schedule:terminate_coupons",
      "schedule:retry_failed_invoices",
      "schedule:retry_inbound_webhooks",
      "schedule:refresh_flagged_subscriptions",
    ]);
    expect(scheduleInstanceId(triggeredAt)).toBe("maintenance-202608140130");
    expect(scheduleInstanceId(triggeredAt + 30_000)).toBe("maintenance-202608140130");
  });

  it("records post-validation as a synchronous precommit boundary", () => {
    const due = dueLegacySchedules(Date.parse("2026-08-14T01:05:00.000Z"));
    expect(due.find((schedule) => schedule.key === "schedule:post_validate_events")).toMatchObject({
      parity: "implemented",
      executor: "audit_synchronous_event_validation",
      owner: "synchronous usage ingestion validation",
    });
  });

  it("records API-key usage as a synchronous authentication boundary", () => {
    const due = dueLegacySchedules(Date.parse("2026-08-14T01:15:00.000Z"));
    expect(due.find((schedule) => schedule.key === "schedule:api_keys_track_usage")).toMatchObject({
      parity: "implemented",
      executor: "audit_synchronous_api_key_usage",
      owner: "synchronous D1 authentication tracking",
    });
  });

  it("owns the retained daily revenue projection in the hourly :15 workflow slot", () => {
    const due = dueLegacySchedules(Date.parse("2026-08-14T01:15:00.000Z"));
    expect(due.find((schedule) => schedule.key === "schedule:compute_daily_usage")).toMatchObject({
      parity: "implemented",
      executor: "project_daily_usage",
      owner: "D1 daily revenue analytics projection",
    });
  });
});

describe("scheduled ledger maintenance", () => {
  it("finalizes due drafts exactly once without changing their issuing date", async () => {
    const cutoff = "2026-08-14T00:20:00.000Z";
    await expect(finalizeDueInvoices(env, cutoff, "schedule-test")).resolves.toBe(1);
    await expect(finalizeDueInvoices(env, cutoff, "schedule-test-replay")).resolves.toBe(0);
    await expect(
      env.BILLING_DB.prepare(
        `SELECT
           (SELECT status FROM invoices WHERE id = 'invoice-draft-due') AS due_status,
           (SELECT issuing_date FROM invoices WHERE id = 'invoice-draft-due') AS issuing_date,
           (SELECT payment_due_date FROM invoices WHERE id = 'invoice-draft-due') AS payment_due_date,
           (SELECT version FROM invoices WHERE id = 'invoice-draft-due') AS due_version,
           (SELECT status FROM invoices WHERE id = 'invoice-draft-future') AS future_status,
           (SELECT COUNT(*) FROM outbox_events
              WHERE event_type = 'invoice.finalized'
                AND aggregate_id = 'invoice-draft-due') AS events`,
      ).first(),
    ).resolves.toEqual({
      due_status: "finalized",
      due_version: 2,
      events: 1,
      future_status: "draft",
      issuing_date: "2026-08-10",
      payment_due_date: "2026-08-10",
    });
  });

  it("deletes webhook records after 90 days and drains archived payloads exactly once", async () => {
    const oldAt = "2026-05-15T00:00:00.000Z";
    const recentAt = "2026-08-13T00:00:00.000Z";
    const oldArchiveKey = "webhooks/test/old.json";
    await env.BILLING_ARTIFACTS.put(oldArchiveKey, "old payload");
    await env.BILLING_DB.batch([
      webhookEndpointStatement(recentAt),
      outboundDeliveryStatement("delivery-old", oldAt),
      outboundDeliveryStatement("delivery-recent", recentAt),
      inboundReceiptStatement("receipt-old", oldAt, oldArchiveKey),
      inboundReceiptStatement("receipt-recent", recentAt, null),
    ]);
    const cutoff = webhookRetentionCutoff("2026-08-14T01:10:00.000Z");
    expect(cutoff).toBe("2026-05-16T01:10:00.000Z");

    await expect(cleanupOutboundWebhookDeliveries(env, cutoff)).resolves.toBe(1);
    await expect(cleanupOutboundWebhookDeliveries(env, cutoff)).resolves.toBe(0);
    await expect(cleanupInboundWebhookReceipts(env, cutoff)).resolves.toEqual({
      artifactsDeleted: 1,
      receiptsDeleted: 1,
    });
    await expect(cleanupInboundWebhookReceipts(env, cutoff)).resolves.toEqual({
      artifactsDeleted: 0,
      receiptsDeleted: 0,
    });

    await expect(env.BILLING_ARTIFACTS.get(oldArchiveKey)).resolves.toBeNull();
    await expect(
      env.BILLING_DB.prepare(
        `SELECT
           (SELECT COUNT(*) FROM outbound_webhook_deliveries) AS deliveries,
           (SELECT COUNT(*) FROM webhook_receipts) AS receipts,
           (SELECT COUNT(*) FROM artifact_cleanup_tasks) AS cleanup_tasks`,
      ).first(),
    ).resolves.toEqual({ cleanup_tasks: 0, deliveries: 1, receipts: 1 });
  });

  it("retains an R2 deletion task after object storage failure and drains it on retry", async () => {
    const cutoff = webhookRetentionCutoff("2026-08-14T01:10:00.000Z");
    const archiveKey = "webhooks/test/retry.json";
    await env.BILLING_ARTIFACTS.put(archiveKey, "retry payload");
    await env.BILLING_DB.prepare(
      `INSERT INTO webhook_receipts
       (id, provider, provider_account_code, provider_event_id, signature_valid,
        payload_sha256, received_at, processed_at, processing_error_code, archive_key)
       VALUES ('receipt-retry', 'authorize_net', 'org-schedule', 'retry', 1,
               'hash-retry', '2026-05-15T00:00:00.000Z', NULL, NULL, ?)`,
    )
      .bind(archiveKey)
      .run();
    const failingEnv = {
      ...env,
      BILLING_ARTIFACTS: { delete: vi.fn().mockRejectedValue(new Error("synthetic_r2_failure")) },
    } as unknown as Env;
    await expect(cleanupInboundWebhookReceipts(failingEnv, cutoff)).rejects.toThrow(
      "synthetic_r2_failure",
    );
    await expect(
      env.BILLING_DB.prepare(
        `SELECT
           (SELECT COUNT(*) FROM webhook_receipts WHERE id = 'receipt-retry') AS receipts,
           (SELECT COUNT(*) FROM artifact_cleanup_tasks WHERE archive_key = ?) AS cleanup_tasks`,
      )
        .bind(archiveKey)
        .first(),
    ).resolves.toEqual({ cleanup_tasks: 1, receipts: 0 });

    await expect(cleanupInboundWebhookReceipts(env, cutoff)).resolves.toEqual({
      artifactsDeleted: 1,
      receiptsDeleted: 0,
    });
    await expect(env.BILLING_ARTIFACTS.get(archiveKey)).resolves.toBeNull();
  });

  it("marks due invoices overdue exactly once with outbox evidence", async () => {
    const cutoff = "2026-08-14T00:25:00.000Z";
    await expect(markInvoicesOverdue(env, cutoff, "schedule-test")).resolves.toBe(1);
    await expect(markInvoicesOverdue(env, cutoff, "schedule-test-replay")).resolves.toBe(0);

    await expect(
      env.BILLING_DB.prepare(
        `SELECT
           (SELECT payment_overdue FROM invoices WHERE id = 'invoice-overdue') AS overdue_invoice,
           (SELECT version FROM invoices WHERE id = 'invoice-overdue') AS overdue_version,
           (SELECT payment_overdue FROM invoices WHERE id = 'invoice-future') AS future_invoice,
           (SELECT COUNT(*) FROM outbox_events
              WHERE event_type = 'invoice.payment_overdue'
                AND aggregate_id = 'invoice-overdue') AS events`,
      ).first(),
    ).resolves.toEqual({
      overdue_invoice: 1,
      overdue_version: 2,
      future_invoice: 0,
      events: 1,
    });
  });

  it("terminates expired coupons and wallets exactly once with outbox evidence", async () => {
    const couponCutoff = "2026-08-14T00:30:00.000Z";
    const walletCutoff = "2026-08-14T00:45:00.000Z";
    await expect(expireCoupons(env, couponCutoff, "schedule-test")).resolves.toBe(1);
    await expect(expireCoupons(env, couponCutoff, "schedule-test-replay")).resolves.toBe(0);
    await expect(expireWallets(env, walletCutoff, "schedule-test")).resolves.toBe(1);
    await expect(expireWallets(env, walletCutoff, "schedule-test-replay")).resolves.toBe(0);

    await expect(
      env.BILLING_DB.prepare(
        `SELECT
           (SELECT status FROM coupons WHERE id = 'coupon-expired') AS expired_coupon,
           (SELECT status FROM coupons WHERE id = 'coupon-future') AS future_coupon,
           (SELECT status FROM wallets WHERE id = 'wallet-expired') AS expired_wallet,
           (SELECT version FROM wallets WHERE id = 'wallet-expired') AS wallet_version,
           (SELECT status FROM wallets WHERE id = 'wallet-future') AS future_wallet,
           (SELECT COUNT(*) FROM outbox_events
              WHERE event_type IN ('coupon.terminated', 'wallet.terminated')
                AND aggregate_id IN ('coupon-expired', 'wallet-expired')) AS events`,
      ).first(),
    ).resolves.toEqual({
      expired_coupon: "terminated",
      future_coupon: "active",
      expired_wallet: "terminated",
      wallet_version: 2,
      future_wallet: "active",
      events: 2,
    });
  });

  it("creates one local-anniversary granted top-up and replays by wallet/local date", async () => {
    await env.BILLING_DB.batch([
      env.BILLING_DB.prepare(
        "UPDATE customers SET timezone = 'Pacific/Noumea' WHERE id = 'customer-schedule'",
      ),
      walletStatement(
        "wallet-recurring-due",
        "recurring-due",
        "2027-12-31T00:00:00.000Z",
        "2026-07-13T14:00:00.000Z",
      ),
      walletStatement(
        "wallet-recurring-created-today",
        "recurring-created-today",
        "2027-12-31T00:00:00.000Z",
        "2026-09-13T14:00:00.000Z",
      ),
      walletStatement(
        "wallet-recurring-imported",
        "recurring-imported",
        "2027-12-31T00:00:00.000Z",
        "2026-07-13T14:00:00.000Z",
      ),
      recurringRuleStatement(
        "rule-recurring-due",
        "wallet-recurring-due",
        "monthly",
        "2026-07-13T14:00:00.000Z",
        null,
      ),
      recurringRuleStatement(
        "rule-recurring-created-today",
        "wallet-recurring-created-today",
        "monthly",
        "2026-09-13T14:00:00.000Z",
        null,
      ),
      recurringRuleStatement(
        "rule-recurring-imported",
        "wallet-recurring-imported",
        "monthly",
        "2026-07-13T14:00:00.000Z",
        null,
      ),
      legacyIntervalTransactionStatement(
        "legacy-interval-imported",
        "wallet-recurring-imported",
        "rule-recurring-imported",
        "2026-09-13T23:55:00.000Z",
      ),
    ]);
    const triggeredAt = "2026-09-14T00:55:00.000Z";
    await expect(topUpDueRecurringWallets(env, triggeredAt, "schedule-recurring")).resolves.toBe(1);
    await expect(
      topUpDueRecurringWallets(env, triggeredAt, "schedule-recurring-replay"),
    ).resolves.toBe(0);

    await expect(
      env.BILLING_DB.prepare(
        `SELECT
           (SELECT balance_minor FROM wallets WHERE id = 'wallet-recurring-due') AS balance,
           (SELECT balance_minor FROM wallets
              WHERE id = 'wallet-recurring-created-today') AS creation_day_balance,
           (SELECT balance_minor FROM wallets
              WHERE id = 'wallet-recurring-imported') AS imported_balance,
           (SELECT source FROM wallet_transactions
              WHERE wallet_id = 'wallet-recurring-due') AS source,
           (SELECT name FROM wallet_transactions
              WHERE wallet_id = 'wallet-recurring-due') AS transaction_name,
           (SELECT metadata_json FROM wallet_transactions
              WHERE wallet_id = 'wallet-recurring-due') AS metadata_json,
           (SELECT COUNT(*) FROM wallet_transactions
              WHERE wallet_id = 'wallet-recurring-due') AS transactions,
           (SELECT COUNT(*) FROM outbox_events
              WHERE event_type = 'wallet_transaction.created'
                AND aggregate_type = 'wallet_transaction') AS events`,
      ).first(),
    ).resolves.toEqual({
      balance: 300,
      creation_day_balance: 100,
      events: 1,
      imported_balance: 100,
      metadata_json: '[{"key":"origin","value":"recurring"}]',
      source: "interval",
      transaction_name: "Monthly grant",
      transactions: 1,
    });
  });

  it("terminates expired recurring rules once and preserves future rules", async () => {
    await env.BILLING_DB.batch([
      walletStatement(
        "wallet-recurring-expired",
        "recurring-expired",
        "2027-12-31T00:00:00.000Z",
        "2026-07-01T00:00:00.000Z",
      ),
      recurringRuleStatement(
        "rule-recurring-expired",
        "wallet-recurring-expired",
        "weekly",
        null,
        "2026-08-14T00:49:59.000Z",
      ),
    ]);
    await expect(
      expireRecurringWalletRules(env, "2026-08-14T00:50:00.000Z", "schedule-expire-rule"),
    ).resolves.toBe(1);
    await expect(
      expireRecurringWalletRules(env, "2026-08-14T00:50:00.000Z", "schedule-expire-replay"),
    ).resolves.toBe(0);
    await expect(
      env.BILLING_DB.prepare(
        `SELECT status, version,
                (SELECT COUNT(*) FROM outbox_events
                 WHERE aggregate_id = recurring_transaction_rules.id) AS events
         FROM recurring_transaction_rules WHERE id = 'rule-recurring-expired'`,
      ).first(),
    ).resolves.toEqual({ events: 1, status: "terminated", version: 2 });
  });

  it("matches Lago's clipped interval anniversaries", () => {
    expect(
      isRecurringDateDue(
        "monthly",
        { year: 2026, month: 1, day: 31 },
        {
          year: 2026,
          month: 2,
          day: 28,
        },
      ),
    ).toBe(true);
    expect(
      isRecurringDateDue(
        "yearly",
        { year: 2024, month: 2, day: 29 },
        {
          year: 2026,
          month: 2,
          day: 28,
        },
      ),
    ).toBe(true);
    expect(
      isRecurringDateDue(
        "quarterly",
        { year: 2026, month: 1, day: 15 },
        {
          year: 2026,
          month: 3,
          day: 15,
        },
      ),
    ).toBe(false);
    expect(
      isRecurringDateDue(
        "weekly",
        { year: 2026, month: 8, day: 7 },
        {
          year: 2026,
          month: 8,
          day: 14,
        },
      ),
    ).toBe(true);
  });
});

function couponStatement(
  id: string,
  code: string,
  expirationAt: string,
  now: string,
): D1PreparedStatement {
  return env.BILLING_DB.prepare(
    `INSERT OR IGNORE INTO coupons
     (id, organization_id, code, name, coupon_type, amount_minor, currency, percentage_rate,
      frequency, frequency_duration, expiration, expiration_at, reusable, status,
      request_sha256, created_at, updated_at)
     VALUES (?, 'org-schedule', ?, ?, 'fixed_amount', 100, 'USD', NULL, 'once', NULL,
             'time_limit', ?, 1, 'active', ?, ?, ?)`,
  ).bind(id, code, code, expirationAt, `hash-${id}`, now, now);
}

function invoiceStatement(
  id: string,
  number: string,
  paymentDueDate: string,
  now: string,
): D1PreparedStatement {
  return env.BILLING_DB.prepare(
    `INSERT OR IGNORE INTO invoices
     (id, organization_id, customer_id, number, status, payment_status, currency,
      subtotal_minor, tax_minor, credits_minor, total_due_minor, version, finalized_at,
      net_payment_term, payment_due_date, payment_overdue, created_at, updated_at)
     VALUES (?, 'org-schedule', 'customer-schedule', ?, 'finalized', 'pending', 'USD',
             100, 0, 0, 100, 1, ?, 0, ?, 0, ?, ?)`,
  ).bind(id, number, now, paymentDueDate, now, now);
}

function draftInvoiceStatement(
  id: string,
  number: string,
  expectedFinalizationDate: string,
  now: string,
): D1PreparedStatement {
  return env.BILLING_DB.prepare(
    `INSERT OR IGNORE INTO invoices
     (id, organization_id, customer_id, number, status, payment_status, currency,
      subtotal_minor, tax_minor, credits_minor, total_due_minor, version, finalized_at,
      net_payment_term, payment_due_date, payment_overdue, issuing_date,
      expected_finalization_date, created_at, updated_at)
     VALUES (?, 'org-schedule', 'customer-schedule', ?, 'draft', 'pending', 'USD',
             100, 0, 0, 100, 1, NULL, 0, NULL, 0, '2026-08-10', ?, ?, ?)`,
  ).bind(id, number, expectedFinalizationDate, now, now);
}

function walletStatement(
  id: string,
  code: string,
  expirationAt: string,
  now: string,
): D1PreparedStatement {
  return env.BILLING_DB.prepare(
    `INSERT OR IGNORE INTO wallets
     (id, organization_id, customer_id, code, name, currency, currency_exponent, rate_amount,
      priority, balance_minor, consumed_minor, status, expiration_at, version, request_sha256,
      created_at, updated_at, terminated_at)
     VALUES (?, 'org-schedule', 'customer-schedule', ?, ?, 'USD', 2, '1', 50, 100, 0,
             'active', ?, 1, ?, ?, ?, NULL)`,
  ).bind(id, code, code, expirationAt, `hash-${id}`, now, now);
}

function recurringRuleStatement(
  id: string,
  walletId: string,
  interval: string,
  startedAt: string | null,
  expirationAt: string | null,
): D1PreparedStatement {
  const now = "2026-07-01T00:00:00.000Z";
  return env.BILLING_DB.prepare(
    `INSERT INTO recurring_transaction_rules
     (id, organization_id, wallet_id, interval, method, trigger, paid_credits, granted_credits,
      started_at, expiration_at, status, transaction_metadata_json, transaction_name,
      invoice_requires_successful_payment, ignore_paid_top_up_limits,
      skip_invoice_custom_sections, version, created_at, updated_at, terminated_at)
     VALUES (?, 'org-schedule', ?, ?, 'fixed', 'interval', '0', '2', ?, ?, 'active',
             '[{"key":"origin","value":"recurring"}]', 'Monthly grant', 0, 0, 0, 1, ?, ?, NULL)`,
  ).bind(id, walletId, interval, startedAt, expirationAt, now, now);
}

function legacyIntervalTransactionStatement(
  id: string,
  walletId: string,
  ruleId: string,
  createdAt: string,
): D1PreparedStatement {
  return env.BILLING_DB.prepare(
    `INSERT INTO wallet_transactions
     (id, organization_id, wallet_id, transaction_type, transaction_status, status, source,
      amount_minor, credit_amount, remaining_minor, priority, wallet_version, request_sha256,
      settled_at, created_at, updated_at, recurring_transaction_rule_id)
     VALUES (?, 'org-schedule', ?, 'inbound', 'granted', 'settled', 'interval', 25, '0.25',
             25, 50, 1, 'legacy-import-hash', ?, ?, ?, ?)`,
  ).bind(id, walletId, createdAt, createdAt, createdAt, ruleId);
}

function webhookEndpointStatement(now: string): D1PreparedStatement {
  return env.BILLING_DB.prepare(
    `INSERT OR IGNORE INTO webhook_endpoints
     (id, organization_id, webhook_url, signature_algo, name, event_types_json, status,
      version, created_at, updated_at, deleted_at)
     VALUES ('endpoint-schedule', 'org-schedule', 'https://example.test/webhooks', 'hmac',
             'Schedule endpoint', NULL, 'active', 1, ?, ?, NULL)`,
  ).bind(now, now);
}

function outboundDeliveryStatement(id: string, updatedAt: string): D1PreparedStatement {
  return env.BILLING_DB.prepare(
    `INSERT OR IGNORE INTO outbound_webhook_deliveries
     (id, organization_id, webhook_endpoint_id, event_id, event_type, payload_json, status,
      attempts, created_at, updated_at)
     VALUES (?, 'org-schedule', 'endpoint-schedule', ?, 'invoice.finalized', '{}', 'succeeded',
             1, ?, ?)`,
  ).bind(id, `event-${id}`, updatedAt, updatedAt);
}

function inboundReceiptStatement(
  id: string,
  receivedAt: string,
  archiveKey: string | null,
): D1PreparedStatement {
  return env.BILLING_DB.prepare(
    `INSERT OR IGNORE INTO webhook_receipts
     (id, provider, provider_account_code, provider_event_id, signature_valid,
      payload_sha256, received_at, processed_at, processing_error_code, archive_key)
     VALUES (?, 'authorize_net', 'org-schedule', ?, 1, ?, ?, ?, NULL, ?)`,
  ).bind(id, id, `hash-${id}`, receivedAt, receivedAt, archiveKey);
}
