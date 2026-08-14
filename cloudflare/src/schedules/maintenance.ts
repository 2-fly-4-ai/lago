import type { DomainEvent } from "../domain-events";

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
    terminated += results[1]?.meta.changes ?? 0;
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
    terminated += results[1]?.meta.changes ?? 0;
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
