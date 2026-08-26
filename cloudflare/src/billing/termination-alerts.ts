import { stableJson } from "../json";

export async function enqueueTerminationAlerts(
  database: D1Database,
  triggeredAt: string,
  correlationId: string,
): Promise<{ candidates: number; enqueued: number }> {
  const triggeredDate = triggeredAt.slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(triggeredDate) || !Number.isFinite(Date.parse(triggeredAt))) {
    throw new Error("invalid_termination_alert_timestamp");
  }
  const candidates = await database
    .prepare(
      `SELECT id, organization_id, external_id, ending_at, version
       FROM subscriptions
       WHERE status = 'active' AND ending_at IS NOT NULL
         AND substr(ending_at, 1, 10) IN (date(?, '+15 days'), date(?, '+45 days'))
       ORDER BY ending_at, id LIMIT 100`,
    )
    .bind(triggeredDate, triggeredDate)
    .all<{
      id: string;
      organization_id: string;
      external_id: string;
      ending_at: string;
      version: number;
    }>();
  if (candidates.results.length === 0) return { candidates: 0, enqueued: 0 };
  const results = await database.batch(
    candidates.results.map((subscription) =>
      database
        .prepare(
          `INSERT INTO outbox_events
           (event_id, organization_id, event_type, event_version, aggregate_type,
            aggregate_id, aggregate_version, causation_id, correlation_id, payload_json,
            occurred_at, published_at)
           VALUES (?, ?, 'subscription.termination_alert', 1, 'subscription', ?, ?, ?, ?, ?, ?, NULL)
           ON CONFLICT(event_id) DO NOTHING`,
        )
        .bind(
          `subscription-termination-alert:${subscription.id}:${triggeredDate}`,
          subscription.organization_id,
          subscription.id,
          subscription.version,
          correlationId,
          correlationId,
          stableJson({
            organizationId: subscription.organization_id,
            subscriptionId: subscription.id,
            externalSubscriptionId: subscription.external_id,
            endingAt: subscription.ending_at,
          }),
          triggeredAt,
        ),
    ),
  );
  return {
    candidates: candidates.results.length,
    enqueued: results.filter((result) => result.meta.changes === 1).length,
  };
}
