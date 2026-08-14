import type { DomainEvent } from "../domain-events";
import { finalizeInvoice } from "../billing/finalize-invoice";
import { refreshSubscriptionDraft } from "../billing/refresh-draft-invoice";

type ExpiringCoupon = {
  id: string;
  organization_id: string;
  code: string;
};

type ExpiringWallet = {
  id: string;
  organization_id: string;
  customer_id: string;
  balance_minor: number;
  version: number;
};

type DueInvoice = {
  id: string;
  organization_id: string;
  customer_id: string;
  payment_due_date: string;
  version: number;
};

type RetainedWebhookReceipt = {
  id: string;
  archive_key: string | null;
};

type ArtifactCleanupTask = {
  archive_key: string;
};

type RetentionEnv = Pick<Env, "BILLING_ARTIFACTS" | "BILLING_DB">;

const RETENTION_DAYS = 90;

export async function expireCoupons(
  env: Env,
  cutoff: string,
  correlationId: string,
): Promise<number> {
  const rows = await env.BILLING_DB.prepare(
    `SELECT id, organization_id, code FROM coupons
     WHERE status = 'active' AND expiration = 'time_limit' AND expiration_at < ?
     ORDER BY expiration_at, id LIMIT 100`,
  )
    .bind(cutoff)
    .all<ExpiringCoupon>();
  let terminated = 0;
  for (const row of rows.results) {
    const event: DomainEvent = {
      id: `coupon-terminated:${row.id}:v2`,
      type: "coupon.terminated",
      version: 1,
      aggregateType: "coupon",
      aggregateId: row.id,
      aggregateVersion: 2,
      occurredAt: cutoff,
      causationId: correlationId,
      correlationId,
      payload: { organizationId: row.organization_id, couponId: row.id, code: row.code },
    };
    const results = await env.BILLING_DB.batch([
      conditionalOutboxStatement(env.BILLING_DB, row.organization_id, event, "coupons", row.id),
      env.BILLING_DB.prepare(
        `UPDATE coupons SET status = 'terminated', terminated_at = COALESCE(terminated_at, ?),
         updated_at = ? WHERE id = ? AND status = 'active' AND expiration_at < ?`,
      ).bind(cutoff, cutoff, row.id, cutoff),
    ]);
    terminated += (results[1]?.meta.changes ?? 0) > 0 ? 1 : 0;
  }
  return terminated;
}

export async function expireWallets(
  env: Env,
  cutoff: string,
  correlationId: string,
): Promise<number> {
  const rows = await env.BILLING_DB.prepare(
    `SELECT id, organization_id, customer_id, balance_minor, version FROM wallets
     WHERE status = 'active' AND expiration_at < ? ORDER BY expiration_at, id LIMIT 100`,
  )
    .bind(cutoff)
    .all<ExpiringWallet>();
  let terminated = 0;
  for (const row of rows.results) {
    const nextVersion = row.version + 1;
    const event: DomainEvent = {
      id: `wallet-terminated:${row.id}:v${nextVersion}`,
      type: "wallet.terminated",
      version: 1,
      aggregateType: "wallet",
      aggregateId: row.id,
      aggregateVersion: nextVersion,
      occurredAt: cutoff,
      causationId: correlationId,
      correlationId,
      payload: {
        organizationId: row.organization_id,
        customerId: row.customer_id,
        balanceMinor: row.balance_minor,
      },
    };
    const results = await env.BILLING_DB.batch([
      conditionalOutboxStatement(env.BILLING_DB, row.organization_id, event, "wallets", row.id),
      env.BILLING_DB.prepare(
        `UPDATE wallets SET status = 'terminated', terminated_at = COALESCE(terminated_at, ?),
         updated_at = ?, version = version + 1
         WHERE id = ? AND status = 'active' AND expiration_at < ? AND version = ?`,
      ).bind(cutoff, cutoff, row.id, cutoff, row.version),
    ]);
    terminated += (results[1]?.meta.changes ?? 0) > 0 ? 1 : 0;
  }
  return terminated;
}

export async function markInvoicesOverdue(
  env: Env,
  cutoff: string,
  correlationId: string,
): Promise<number> {
  const cutoffDate = cutoff.slice(0, 10);
  const rows = await env.BILLING_DB.prepare(
    `SELECT id, organization_id, customer_id, payment_due_date, version FROM invoices
     WHERE status = 'finalized' AND payment_status <> 'succeeded' AND payment_overdue = 0
       AND payment_due_date IS NOT NULL AND payment_due_date <= ?
     ORDER BY payment_due_date, id LIMIT 100`,
  )
    .bind(cutoffDate)
    .all<DueInvoice>();
  let overdue = 0;
  for (const row of rows.results) {
    const nextVersion = row.version + 1;
    const event: DomainEvent = {
      id: `invoice-payment-overdue:${row.id}:v${nextVersion}`,
      type: "invoice.payment_overdue",
      version: 1,
      aggregateType: "invoice",
      aggregateId: row.id,
      aggregateVersion: nextVersion,
      occurredAt: cutoff,
      causationId: correlationId,
      correlationId,
      payload: {
        organizationId: row.organization_id,
        invoiceId: row.id,
        customerId: row.customer_id,
        paymentDueDate: row.payment_due_date,
      },
    };
    const results = await env.BILLING_DB.batch([
      env.BILLING_DB.prepare(
        `INSERT INTO outbox_events
         (event_id, organization_id, event_type, event_version, aggregate_type,
          aggregate_id, aggregate_version, causation_id, correlation_id, payload_json,
          occurred_at, published_at)
         SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL FROM invoices
         WHERE id = ? AND organization_id = ? AND version = ? AND status = 'finalized'
           AND payment_status <> 'succeeded' AND payment_overdue = 0 AND payment_due_date <= ?`,
      ).bind(
        event.id,
        row.organization_id,
        event.type,
        event.version,
        event.aggregateType,
        event.aggregateId,
        event.aggregateVersion,
        event.causationId,
        event.correlationId,
        JSON.stringify(event.payload),
        event.occurredAt,
        row.id,
        row.organization_id,
        row.version,
        cutoffDate,
      ),
      env.BILLING_DB.prepare(
        `UPDATE invoices SET payment_overdue = 1, version = version + 1, updated_at = ?
         WHERE id = ? AND organization_id = ? AND version = ? AND status = 'finalized'
           AND payment_status <> 'succeeded' AND payment_overdue = 0 AND payment_due_date <= ?`,
      ).bind(cutoff, row.id, row.organization_id, row.version, cutoffDate),
    ]);
    overdue += results[1]?.meta.changes ?? 0;
  }
  return overdue;
}

export async function finalizeDueInvoices(
  env: Pick<Env, "BILLING_DB" | "BILLING_ACCOUNTS" | "DOMAIN_EVENTS">,
  cutoff: string,
  correlationId: string,
): Promise<number> {
  const cutoffDate = cutoff.slice(0, 10);
  const rows = await env.BILLING_DB.prepare(
    `SELECT i.id FROM invoices i WHERE i.status = 'draft'
       AND COALESCE(expected_finalization_date, issuing_date) <= ?
     ORDER BY COALESCE(expected_finalization_date, issuing_date),
              CASE
                WHEN EXISTS (
                  SELECT 1 FROM termination_credit_note_contexts tc
                  JOIN credit_notes cn ON cn.id = tc.credit_note_id
                  WHERE tc.source_invoice_id = i.id AND cn.allocation_state = 'draft'
                ) THEN 0
                WHEN EXISTS (
                  SELECT 1 FROM plan_change_invoice_contexts pc
                  JOIN termination_credit_note_contexts tc
                    ON tc.subscription_id = pc.previous_subscription_id
                  JOIN credit_notes cn ON cn.id = tc.credit_note_id
                  WHERE pc.invoice_id = i.id AND cn.allocation_state = 'draft'
                ) OR EXISTS (
                  SELECT 1 FROM subscription_invoice_contexts sic
                  JOIN termination_credit_note_contexts tc
                    ON tc.subscription_id = sic.subscription_id
                  JOIN credit_notes cn ON cn.id = tc.credit_note_id
                  WHERE sic.invoice_id = i.id AND sic.context_type = 'termination'
                    AND cn.allocation_state = 'draft'
                ) THEN 2
                ELSE 1
              END,
              i.id LIMIT 100`,
  )
    .bind(cutoffDate)
    .all<{ id: string }>();
  let finalized = 0;
  let pending = [...rows.results];
  while (pending.length > 0) {
    const deferred: typeof pending = [];
    let progressed = false;
    for (const row of pending) {
      try {
        if (await finalizeInvoice(env, row.id, null, cutoff, correlationId)) {
          finalized += 1;
          progressed = true;
        }
      } catch (error) {
        if (error instanceof Error && error.message === "termination_credit_note_not_finalized") {
          deferred.push(row);
          continue;
        }
        throw error;
      }
    }
    if (!progressed) break;
    pending = deferred;
  }
  return finalized;
}

export async function refreshFlaggedDraftInvoices(
  env: Pick<Env, "BILLING_DB" | "BILLING_ACCOUNTS" | "DOMAIN_EVENTS">,
  refreshedAt: string,
  correlationId: string,
): Promise<number> {
  const rows = await env.BILLING_DB.prepare(
    `SELECT id FROM invoices WHERE status = 'draft' AND ready_to_be_refreshed = 1
     ORDER BY updated_at, id LIMIT 100`,
  ).all<{ id: string }>();
  let refreshed = 0;
  for (const row of rows.results) {
    const result = await refreshSubscriptionDraft(
      env,
      row.id,
      null,
      refreshedAt,
      correlationId,
      false,
    );
    if (result.changed) refreshed += 1;
  }
  return refreshed;
}

export function webhookRetentionCutoff(triggeredAt: string): string {
  const cutoff = new Date(triggeredAt);
  if (!Number.isFinite(cutoff.getTime())) throw new Error("invalid_retention_timestamp");
  cutoff.setUTCDate(cutoff.getUTCDate() - RETENTION_DAYS);
  return cutoff.toISOString();
}

export async function cleanupOutboundWebhookDeliveries(
  env: Pick<Env, "BILLING_DB">,
  cutoff: string,
): Promise<number> {
  const result = await env.BILLING_DB.prepare(
    `DELETE FROM outbound_webhook_deliveries WHERE id IN (
       SELECT id FROM outbound_webhook_deliveries WHERE updated_at < ?
       ORDER BY updated_at, id LIMIT 1000
     )`,
  )
    .bind(cutoff)
    .run();
  return result.meta.changes;
}

export async function cleanupInboundWebhookReceipts(
  env: RetentionEnv,
  cutoff: string,
): Promise<{ artifactsDeleted: number; receiptsDeleted: number }> {
  let artifactsDeleted = await drainArtifactCleanupTasks(env);
  const rows = await env.BILLING_DB.prepare(
    `SELECT id, archive_key FROM webhook_receipts WHERE received_at < ?
     ORDER BY received_at, id LIMIT 100`,
  )
    .bind(cutoff)
    .all<RetainedWebhookReceipt>();
  let receiptsDeleted = 0;
  for (const row of rows.results) {
    const statements: D1PreparedStatement[] = [];
    if (row.archive_key) {
      statements.push(
        env.BILLING_DB.prepare(
          `INSERT OR IGNORE INTO artifact_cleanup_tasks
           (archive_key, resource_type, resource_id, created_at)
           SELECT ?, 'webhook_receipt', id, ? FROM webhook_receipts
           WHERE id = ? AND received_at < ?`,
        ).bind(row.archive_key, cutoff, row.id, cutoff),
      );
    }
    statements.push(
      env.BILLING_DB.prepare("DELETE FROM webhook_receipts WHERE id = ? AND received_at < ?").bind(
        row.id,
        cutoff,
      ),
    );
    const results = await env.BILLING_DB.batch(statements);
    receiptsDeleted += results.at(-1)?.meta.changes ?? 0;
  }
  artifactsDeleted += await drainArtifactCleanupTasks(env);
  return { artifactsDeleted, receiptsDeleted };
}

async function drainArtifactCleanupTasks(env: RetentionEnv): Promise<number> {
  const result = await env.BILLING_DB.prepare(
    `SELECT archive_key FROM artifact_cleanup_tasks ORDER BY created_at, archive_key LIMIT 100`,
  ).all<ArtifactCleanupTask>();
  const keys = result.results.map((row) => row.archive_key);
  if (keys.length === 0) return 0;
  await env.BILLING_ARTIFACTS.delete(keys);
  await env.BILLING_DB.batch(
    keys.map((key) =>
      env.BILLING_DB.prepare("DELETE FROM artifact_cleanup_tasks WHERE archive_key = ?").bind(key),
    ),
  );
  return keys.length;
}

function conditionalOutboxStatement(
  database: D1Database,
  organizationId: string,
  event: DomainEvent,
  sourceTable: "coupons" | "wallets",
  sourceId: string,
): D1PreparedStatement {
  return database
    .prepare(
      `INSERT INTO outbox_events
       (event_id, organization_id, event_type, event_version, aggregate_type,
        aggregate_id, aggregate_version, causation_id, correlation_id, payload_json,
        occurred_at, published_at)
       SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL
       FROM ${sourceTable} WHERE id = ? AND status = 'active'`,
    )
    .bind(
      event.id,
      organizationId,
      event.type,
      event.version,
      event.aggregateType,
      event.aggregateId,
      event.aggregateVersion,
      event.causationId,
      event.correlationId,
      JSON.stringify(event.payload),
      event.occurredAt,
      sourceId,
    );
}
