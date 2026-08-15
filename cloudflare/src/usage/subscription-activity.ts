export function subscriptionActivityStatements(
  database: D1Database,
  organizationId: string,
  subscriptionId: string,
  externalSubscriptionId: string,
  eventAt: string,
  insertedAt: string,
): D1PreparedStatement[] {
  const eventOn = eventAt.slice(0, 10);
  return [
    database
      .prepare(
        `INSERT INTO usage_subscription_activities
         (organization_id, external_subscription_id, subscription_id, latest_event_at,
          latest_event_on, version, attempts, last_error_code, inserted_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 1, 0, NULL, ?, ?)
         ON CONFLICT(organization_id, external_subscription_id) DO UPDATE SET
           subscription_id = excluded.subscription_id,
           latest_event_at = MAX(latest_event_at, excluded.latest_event_at),
           latest_event_on = MAX(latest_event_on, excluded.latest_event_on),
           version = version + 1,
           attempts = 0,
           last_error_code = NULL,
           updated_at = excluded.updated_at`,
      )
      .bind(
        organizationId,
        externalSubscriptionId,
        subscriptionId,
        eventAt,
        eventOn,
        insertedAt,
        insertedAt,
      ),
    database
      .prepare(
        `UPDATE subscriptions
         SET updated_at = CASE
               WHEN last_received_event_on IS NULL OR last_received_event_on < ? THEN ?
               ELSE updated_at
             END,
             last_received_event_on = CASE
               WHEN last_received_event_on IS NULL OR last_received_event_on < ? THEN ?
               ELSE last_received_event_on
             END
         WHERE id = ? AND organization_id = ?`,
      )
      .bind(eventOn, insertedAt, eventOn, eventOn, subscriptionId, organizationId),
  ];
}
