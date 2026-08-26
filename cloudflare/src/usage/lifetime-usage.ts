import { calculateCurrentUsageProjection, type SubscriptionUsageRow } from "../api/metered-usage";
import { deterministicUuid } from "../identifiers";

type LifetimeSubscription = SubscriptionUsageRow & {
  status: string;
  subscription_at: string | null;
  started_at: string | null;
  created_at: string;
};

export type LifetimeUsageRow = {
  id: string;
  organization_id: string;
  subscription_id: string;
  external_subscription_id: string;
  historical_usage_amount_minor: number;
  invoiced_usage_amount_minor: number;
  current_usage_amount_minor: number;
  current_usage_amount_refreshed_at: string | null;
  invoiced_usage_amount_refreshed_at: string | null;
  recalculate_current_usage: number;
  recalculate_invoiced_usage: number;
  created_at: string;
  updated_at: string;
};

type SubscriptionActivity = {
  organization_id: string;
  external_subscription_id: string;
  subscription_id: string;
  version: number;
};

export async function processUsageEventSubscriptionActivity(
  database: D1Database,
  usageEventId: string,
  refreshedAt = new Date().toISOString(),
): Promise<"processed" | "pending" | "missing"> {
  const event = await database
    .prepare(
      `SELECT organization_id, subscription_id, external_subscription_id
       FROM usage_events WHERE id = ? AND deleted_at IS NULL LIMIT 1`,
    )
    .bind(usageEventId)
    .first<{
      organization_id: string;
      subscription_id: string;
      external_subscription_id: string;
    }>();
  if (!event) return "missing";
  return processSubscriptionActivity(
    database,
    event.organization_id,
    event.external_subscription_id,
    refreshedAt,
  );
}

export async function processSubscriptionActivity(
  database: D1Database,
  organizationId: string,
  externalSubscriptionId: string,
  refreshedAt = new Date().toISOString(),
): Promise<"processed" | "pending" | "missing"> {
  const activity = await findActivity(database, organizationId, externalSubscriptionId);
  if (!activity) return "missing";
  try {
    await refreshLifetimeUsage(
      database,
      organizationId,
      externalSubscriptionId,
      refreshedAt,
      activity.version,
    );
  } catch (error) {
    await recordActivityFailure(database, activity, refreshedAt);
    throw error;
  }
  const remaining = await findActivity(database, organizationId, externalSubscriptionId);
  return remaining ? "pending" : "processed";
}

export async function refreshLifetimeUsage(
  database: D1Database,
  organizationId: string,
  externalSubscriptionId: string,
  refreshedAt = new Date().toISOString(),
  activityVersion?: number,
): Promise<LifetimeUsageRow | null> {
  const subscription = await findLifetimeSubscription(
    database,
    organizationId,
    externalSubscriptionId,
  );
  if (!subscription) {
    if (activityVersion !== undefined) {
      await database
        .prepare(
          `DELETE FROM usage_subscription_activities
           WHERE organization_id = ? AND external_subscription_id = ? AND version = ?`,
        )
        .bind(organizationId, externalSubscriptionId, activityVersion)
        .run();
    }
    return null;
  }

  const existing = await findLifetimeUsage(database, organizationId, externalSubscriptionId);
  const currentUsageMinor = await currentUsageAmountMinor(database, subscription, refreshedAt);
  const invoicedUsageMinor = await invoicedUsageAmountMinor(
    database,
    organizationId,
    externalSubscriptionId,
  );
  const id =
    existing?.id ??
    (await deterministicUuid("lifetime-usage", `${organizationId}:${externalSubscriptionId}`));
  const statements: D1PreparedStatement[] = [
    database
      .prepare(
        `INSERT INTO lifetime_usages
         (id, organization_id, subscription_id, external_subscription_id,
          historical_usage_amount_minor, invoiced_usage_amount_minor,
          current_usage_amount_minor, current_usage_amount_refreshed_at,
          invoiced_usage_amount_refreshed_at, recalculate_current_usage,
          recalculate_invoiced_usage, created_at, updated_at)
         VALUES (?, ?, ?, ?, 0, ?, ?, ?, ?, 0, 0, ?, ?)
         ON CONFLICT(organization_id, external_subscription_id) DO UPDATE SET
           subscription_id = excluded.subscription_id,
           invoiced_usage_amount_minor = excluded.invoiced_usage_amount_minor,
           current_usage_amount_minor = excluded.current_usage_amount_minor,
           current_usage_amount_refreshed_at = excluded.current_usage_amount_refreshed_at,
           invoiced_usage_amount_refreshed_at = excluded.invoiced_usage_amount_refreshed_at,
           recalculate_current_usage = 0,
           recalculate_invoiced_usage = 0,
           updated_at = excluded.updated_at`,
      )
      .bind(
        id,
        organizationId,
        subscription.id,
        externalSubscriptionId,
        invoicedUsageMinor,
        currentUsageMinor,
        refreshedAt,
        refreshedAt,
        refreshedAt,
        refreshedAt,
      ),
  ];
  if (activityVersion !== undefined) {
    statements.push(
      database
        .prepare(
          `DELETE FROM usage_subscription_activities
           WHERE organization_id = ? AND external_subscription_id = ? AND version = ?`,
        )
        .bind(organizationId, externalSubscriptionId, activityVersion),
    );
  }
  await database.batch(statements);
  return findLifetimeUsage(database, organizationId, externalSubscriptionId);
}

export async function pendingSubscriptionActivities(
  database: D1Database,
  limit = 100,
): Promise<Array<{ organizationId: string; externalSubscriptionId: string }>> {
  const result = await database
    .prepare(
      `SELECT organization_id, external_subscription_id
       FROM usage_subscription_activities
       ORDER BY updated_at, organization_id, external_subscription_id LIMIT ?`,
    )
    .bind(limit)
    .all<{ organization_id: string; external_subscription_id: string }>();
  return result.results.map((row) => ({
    organizationId: row.organization_id,
    externalSubscriptionId: row.external_subscription_id,
  }));
}

export async function lifetimeUsageRefreshCandidates(
  database: D1Database,
  limit = 100,
): Promise<Array<{ organizationId: string; externalSubscriptionId: string }>> {
  const result = await database
    .prepare(
      `SELECT organization_id, external_subscription_id FROM lifetime_usages
       ORDER BY recalculate_invoiced_usage DESC,
                COALESCE(current_usage_amount_refreshed_at, ''),
                organization_id, external_subscription_id
       LIMIT ?`,
    )
    .bind(limit)
    .all<{ organization_id: string; external_subscription_id: string }>();
  return result.results.map((row) => ({
    organizationId: row.organization_id,
    externalSubscriptionId: row.external_subscription_id,
  }));
}

export async function findLifetimeUsage(
  database: D1Database,
  organizationId: string,
  externalSubscriptionId: string,
): Promise<LifetimeUsageRow | null> {
  return database
    .prepare(
      `SELECT id, organization_id, subscription_id, external_subscription_id,
              historical_usage_amount_minor, invoiced_usage_amount_minor,
              current_usage_amount_minor, current_usage_amount_refreshed_at,
              invoiced_usage_amount_refreshed_at, recalculate_current_usage,
              recalculate_invoiced_usage, created_at, updated_at
       FROM lifetime_usages
       WHERE organization_id = ? AND external_subscription_id = ? LIMIT 1`,
    )
    .bind(organizationId, externalSubscriptionId)
    .first<LifetimeUsageRow>();
}

export async function lifetimeUsageFromDatetime(
  database: D1Database,
  organizationId: string,
  externalSubscriptionId: string,
): Promise<string | null> {
  const result = await database
    .prepare(
      `SELECT MIN(COALESCE(subscription_at, started_at, created_at)) AS from_datetime
       FROM subscriptions
       WHERE organization_id = ? AND external_id = ? AND status <> 'canceled'`,
    )
    .bind(organizationId, externalSubscriptionId)
    .first<{ from_datetime: string | null }>();
  return result?.from_datetime ?? null;
}

async function findActivity(
  database: D1Database,
  organizationId: string,
  externalSubscriptionId: string,
): Promise<SubscriptionActivity | null> {
  return database
    .prepare(
      `SELECT organization_id, external_subscription_id, subscription_id, version
       FROM usage_subscription_activities
       WHERE organization_id = ? AND external_subscription_id = ? LIMIT 1`,
    )
    .bind(organizationId, externalSubscriptionId)
    .first<SubscriptionActivity>();
}

async function findLifetimeSubscription(
  database: D1Database,
  organizationId: string,
  externalSubscriptionId: string,
): Promise<LifetimeSubscription | null> {
  return database
    .prepare(
      `SELECT s.id, s.organization_id, s.customer_id, s.plan_id, s.external_id,
              s.status, s.subscription_at, s.started_at, s.created_at,
              s.current_period_start, s.current_period_end,
              s.billing_time, s.billing_timezone, p.currency, p.interval
       FROM subscriptions s JOIN plans p ON p.id = s.plan_id
       WHERE s.organization_id = ? AND s.external_id = ? AND s.status <> 'canceled'
       ORDER BY CASE
                  WHEN s.status IN ('active', 'past_due') THEN 0
                  WHEN s.status = 'pending' THEN 1
                  ELSE 2
                END,
                s.generation DESC
       LIMIT 1`,
    )
    .bind(organizationId, externalSubscriptionId)
    .first<LifetimeSubscription>();
}

async function currentUsageAmountMinor(
  database: D1Database,
  subscription: LifetimeSubscription,
  calculatedThrough: string,
): Promise<number> {
  if (
    !["active", "past_due"].includes(subscription.status) ||
    !subscription.current_period_start ||
    !subscription.current_period_end
  ) {
    return 0;
  }
  const projection = await calculateCurrentUsageProjection(database, subscription, {
    calculatedThrough,
  });
  const amount = projection.total.round();
  const numeric = Number(amount);
  if (!Number.isSafeInteger(numeric) || numeric < 0)
    throw new Error("invalid_lifetime_current_usage");
  return numeric;
}

async function invoicedUsageAmountMinor(
  database: D1Database,
  organizationId: string,
  externalSubscriptionId: string,
): Promise<number> {
  const result = await database
    .prepare(
      `SELECT COALESCE(SUM(line.amount_minor), 0) AS amount_minor
       FROM invoice_lines line
       JOIN invoices invoice ON invoice.id = line.invoice_id
       WHERE invoice.organization_id = ?
         AND invoice.status IN ('draft', 'finalized')
         AND line.line_type = 'usage'
         AND NOT EXISTS (
           SELECT 1 FROM progressive_billing_invoices progressive
           WHERE progressive.invoice_id = invoice.id
         )
         AND EXISTS (
           SELECT 1 FROM invoice_subscriptions owned
           JOIN subscriptions lineage ON lineage.id = owned.subscription_id
           WHERE owned.invoice_id = invoice.id
             AND lineage.organization_id = ?
             AND lineage.external_id = ?
             AND lineage.status <> 'canceled'
         )`,
    )
    .bind(organizationId, organizationId, externalSubscriptionId)
    .first<{ amount_minor: number }>();
  const amount = result?.amount_minor ?? 0;
  if (!Number.isSafeInteger(amount) || amount < 0)
    throw new Error("invalid_lifetime_invoiced_usage");
  return amount;
}

async function recordActivityFailure(
  database: D1Database,
  activity: SubscriptionActivity,
  attemptedAt: string,
): Promise<void> {
  await database
    .prepare(
      `UPDATE usage_subscription_activities
       SET attempts = attempts + 1, last_error_code = 'projection_failed', updated_at = ?
       WHERE organization_id = ? AND external_subscription_id = ? AND version = ?`,
    )
    .bind(
      attemptedAt,
      activity.organization_id,
      activity.external_subscription_id,
      activity.version,
    )
    .run();
}
