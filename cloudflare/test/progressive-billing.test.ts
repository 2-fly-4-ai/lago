import { env, SELF } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { sha256Hex } from "../src/auth/api-key";
import { closeBillingPeriod } from "../src/billing/close-period";
import {
  createProgressiveBillingInvoice,
  type ProgressiveBillingCandidate,
} from "../src/billing/progressive-billing";
import { refreshLifetimeUsage } from "../src/usage/lifetime-usage";

const apiKey = "progressive-billing-test-key";
const headers = { Authorization: `Bearer ${apiKey}` };
const candidate: ProgressiveBillingCandidate = {
  subscriptionId: "subscription-progressive",
  organizationId: "org-progressive",
  externalSubscriptionId: "subscription-progressive-external",
};

beforeAll(async () => {
  const now = "2026-08-01T00:00:00.000Z";
  await env.BILLING_DB.batch([
    env.BILLING_DB.prepare(
      `INSERT INTO organizations (id, external_id, name, created_at, updated_at)
       VALUES ('org-progressive', 'progressive-test', 'Progressive Test', ?, ?)`,
    ).bind(now, now),
    env.BILLING_DB.prepare(
      `INSERT INTO api_keys
       (id, organization_id, key_prefix, key_hash, created_at, revoked_at)
       VALUES ('key-progressive', 'org-progressive', 'progress', ?, ?, NULL)`,
    ).bind(await sha256Hex(apiKey), now),
    env.BILLING_DB.prepare(
      `INSERT INTO customers
       (id, organization_id, external_id, currency, metadata_json, created_at, updated_at)
       VALUES ('customer-progressive', 'org-progressive', 'customer-progressive-external',
               'USD', '{}', ?, ?)`,
    ).bind(now, now),
    env.BILLING_DB.prepare(
      `INSERT INTO plans
       (id, organization_id, code, name, interval, amount_minor, currency, version, active,
        created_at, updated_at)
       VALUES ('plan-progressive', 'org-progressive', 'progressive-plan', 'Progressive Plan',
               'monthly', 0, 'USD', 1, 1, ?, ?)`,
    ).bind(now, now),
    env.BILLING_DB.prepare(
      `INSERT INTO subscriptions
       (id, organization_id, customer_id, plan_id, external_id, status, subscription_at,
        started_at, current_period_start, current_period_end, generation, version,
        created_at, updated_at)
       VALUES ('subscription-progressive', 'org-progressive', 'customer-progressive',
               'plan-progressive', 'subscription-progressive-external', 'active', ?, ?, ?,
               '2026-09-01T00:00:00.000Z', 1, 1, ?, ?)`,
    ).bind(now, now, now, now, now),
    env.BILLING_DB.prepare(
      `INSERT INTO billable_metrics
       (id, organization_id, code, name, aggregation_type, field_name, recurring,
        properties_json, version, active, created_at, updated_at)
       VALUES ('metric-progressive', 'org-progressive', 'progressive-units',
               'Progressive units', 'sum_agg', 'units', 0, '{}', 1, 1, ?, ?)`,
    ).bind(now, now),
    env.BILLING_DB.prepare(
      `INSERT INTO charges
       (id, organization_id, plan_id, billable_metric_id, code, charge_model,
        properties_json, invoiceable, pay_in_advance, prorated, min_amount_minor,
        version, active, created_at, updated_at)
       VALUES ('charge-progressive', 'org-progressive', 'plan-progressive',
               'metric-progressive', 'progressive-charge', 'standard', '{"amount":"10"}',
               1, 0, 0, 1000, 1, 1, ?, ?)`,
    ).bind(now, now),
    env.BILLING_DB.prepare(
      `INSERT INTO usage_thresholds
       (id, organization_id, plan_id, subscription_id, amount_minor, recurring,
        threshold_display_name, version, deleted_at, created_at, updated_at)
       VALUES ('threshold-progressive-fixed', 'org-progressive', 'plan-progressive', NULL,
               100, 0, 'First hundred', 1, NULL, ?, ?),
              ('threshold-progressive-recurring', 'org-progressive', 'plan-progressive', NULL,
               100, 1, 'Every hundred', 1, NULL, ?, ?)`,
    ).bind(now, now, now, now),
    usageEvent("first", "2026-08-10T00:00:00.000Z", "15"),
  ]);
});

describe("progressive usage billing", () => {
  it("creates cumulative invoices, credits the latest one, and emits threshold evidence", async () => {
    const first = await createProgressiveBillingInvoice(
      env,
      candidate,
      "2026-08-15T00:00:00.000Z",
      "progressive-first",
    );
    expect(first).toMatchObject({
      replayed: false,
      grossUsageMinor: 150,
      progressiveCreditMinor: 0,
      totalDueMinor: 150,
      thresholdIds: ["threshold-progressive-fixed"],
    });
    await expect(
      env.BILLING_DB.prepare(
        `SELECT invoice.subtotal_minor, invoice.total_due_minor,
                invoice.progressive_billing_credit_minor,
                marker.gross_usage_amount_minor,
                (SELECT COUNT(*) FROM invoice_lines line
                 WHERE line.invoice_id = invoice.id AND json_extract(line.metadata_json, '$.trueUp') = 1)
                  AS true_ups
         FROM invoices invoice
         JOIN progressive_billing_invoices marker ON marker.invoice_id = invoice.id
         WHERE invoice.id = ?`,
      )
        .bind(first!.invoiceId)
        .first(),
    ).resolves.toEqual({
      subtotal_minor: 150,
      total_due_minor: 150,
      progressive_billing_credit_minor: 0,
      gross_usage_amount_minor: 150,
      true_ups: 0,
    });

    await env.BILLING_DB.batch([
      usageEvent("second", "2026-08-16T00:00:00.000Z", "10"),
      env.BILLING_DB.prepare(
        `INSERT INTO usage_subscription_activities
         (organization_id, external_subscription_id, subscription_id, latest_event_at,
          latest_event_on, version, attempts, inserted_at, updated_at)
         VALUES ('org-progressive', 'subscription-progressive-external',
                 'subscription-progressive', '2026-08-16T00:00:00.000Z', '2026-08-16',
                 1, 0, '2026-08-16T00:00:00.000Z', '2026-08-16T00:00:00.000Z')`,
      ),
    ]);
    const second = await createProgressiveBillingInvoice(
      env,
      candidate,
      "2026-08-20T00:00:00.000Z",
      "progressive-second",
    );
    expect(second).toMatchObject({
      replayed: false,
      grossUsageMinor: 250,
      progressiveCreditMinor: 150,
      totalDueMinor: 100,
      thresholdIds: ["threshold-progressive-recurring"],
    });
    await expect(
      env.BILLING_DB.prepare(
        `SELECT COUNT(*) AS invoices,
                (SELECT COUNT(*) FROM progressive_billing_credits) AS credits,
                (SELECT SUM(amount_minor) FROM progressive_billing_credits) AS credited,
                (SELECT COUNT(*) FROM applied_usage_thresholds) AS applied,
                (SELECT COUNT(*) FROM outbox_events
                 WHERE event_type = 'subscription.usage_threshold_reached') AS threshold_events
         FROM progressive_billing_invoices`,
      ).first(),
    ).resolves.toEqual({
      invoices: 2,
      credits: 1,
      credited: 150,
      applied: 2,
      threshold_events: 2,
    });

    const lifetime = await refreshLifetimeUsage(
      env.BILLING_DB,
      "org-progressive",
      "subscription-progressive-external",
      "2026-08-20T00:00:00.000Z",
    );
    expect(lifetime).toMatchObject({
      invoiced_usage_amount_minor: 0,
      current_usage_amount_minor: 250,
    });
    const shown = await SELF.fetch(`https://lago.test/api/v1/invoices/${second!.invoiceId}`, {
      headers,
    });
    expect(shown.status, await shown.clone().text()).toBe(200);
    await expect(shown.json()).resolves.toMatchObject({
      invoice: {
        invoice_type: "progressive_billing",
        fees_amount_cents: 250,
        progressive_billing_credit_amount_cents: 150,
        total_amount_cents: 100,
        applied_usage_thresholds: [
          {
            lifetime_usage_amount_cents: 250,
            usage_threshold: {
              lago_id: "threshold-progressive-recurring",
              amount_cents: 100,
              recurring: true,
            },
          },
        ],
      },
    });

    await env.BILLING_DB.batch([
      env.BILLING_DB.prepare("UPDATE charges SET active = 0 WHERE id = 'charge-progressive'"),
      env.BILLING_DB.prepare(
        `INSERT INTO charges
         (id, organization_id, plan_id, billable_metric_id, code, charge_model,
          properties_json, invoiceable, pay_in_advance, prorated, min_amount_minor,
          version, active, created_at, updated_at)
         SELECT 'charge-progressive-v2', organization_id, plan_id, billable_metric_id,
                'progressive-charge-v2', charge_model, properties_json, invoiceable,
                pay_in_advance, prorated, min_amount_minor, 1, 1,
                '2026-08-21T00:00:00.000Z', '2026-08-21T00:00:00.000Z'
         FROM charges WHERE id = 'charge-progressive'`,
      ),
      usageEvent("third", "2026-08-21T00:00:00.000Z", "10"),
      env.BILLING_DB.prepare(
        `UPDATE usage_subscription_activities
         SET latest_event_at = '2026-08-21T00:00:00.000Z', latest_event_on = '2026-08-21',
             version = version + 1, updated_at = '2026-08-21T00:00:00.000Z'
         WHERE organization_id = 'org-progressive'
           AND external_subscription_id = 'subscription-progressive-external'`,
      ),
    ]);
    const corrected = await createProgressiveBillingInvoice(
      env,
      candidate,
      "2026-08-22T00:00:00.000Z",
      "progressive-source-correction",
    );
    expect(corrected).toMatchObject({
      replayed: false,
      grossUsageMinor: 350,
      progressiveCreditMinor: 0,
      totalDueMinor: 350,
      thresholdIds: ["threshold-progressive-recurring"],
    });
    await expect(
      env.BILLING_DB.prepare(
        `SELECT note.total_amount_minor, note.balance_amount_minor, note.reason,
                (SELECT SUM(amount_minor) FROM credit_note_items
                 WHERE credit_note_id = note.id) AS item_amount,
                (SELECT COUNT(*) FROM outbox_events
                 WHERE aggregate_id = note.id AND event_type = 'credit_note.created') AS events
         FROM credit_notes note WHERE note.invoice_id = ?`,
      )
        .bind(second!.invoiceId)
        .first(),
    ).resolves.toEqual({
      total_amount_minor: 250,
      balance_amount_minor: 250,
      reason: "other",
      item_amount: 250,
      events: 1,
    });

    const closed = await closeBillingPeriod(
      env,
      "subscription-progressive",
      "2026-09-01T00:00:00.000Z",
      "progressive-period-close",
    );
    expect(closed).toMatchObject({ totalDueMinor: 400, lineCount: 3 });
    await expect(
      env.BILLING_DB.prepare(
        `SELECT invoice.subtotal_minor, invoice.progressive_billing_credit_minor,
                invoice.total_due_minor,
                credit.progressive_invoice_id, credit.amount_minor
         FROM invoices invoice
         JOIN progressive_billing_credits credit ON credit.invoice_id = invoice.id
         WHERE invoice.id = ?`,
      )
        .bind(closed.invoiceId)
        .first(),
    ).resolves.toEqual({
      subtotal_minor: 1000,
      progressive_billing_credit_minor: 350,
      total_due_minor: 400,
      progressive_invoice_id: corrected!.invoiceId,
      amount_minor: 350,
    });
  });
});

function usageEvent(suffix: string, timestamp: string, units: string): D1PreparedStatement {
  return env.BILLING_DB.prepare(
    `INSERT INTO usage_events
     (id, organization_id, subscription_id, customer_id, billable_metric_id,
      transaction_id, code, timestamp, timestamp_ms, properties_json, request_sha256,
      archive_key, created_at, external_subscription_id)
     VALUES (?, 'org-progressive', 'subscription-progressive', 'customer-progressive',
             'metric-progressive', ?, 'progressive-units', ?, ?, ?, ?, ?, ?,
             'subscription-progressive-external')`,
  ).bind(
    `event-progressive-${suffix}`,
    `transaction-progressive-${suffix}`,
    timestamp,
    Date.parse(timestamp),
    JSON.stringify({ units }),
    `hash-progressive-${suffix}`,
    `progressive/${suffix}.json`,
    timestamp,
  );
}
