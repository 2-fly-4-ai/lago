import type { DomainEvent } from "../domain-events";
import { stableJson } from "../json";

type PendingSubscription = {
  id: string;
  organization_id: string;
  external_id: string;
  status: string;
  version: number;
};

export type CancelPendingSubscriptionResult = {
  changed: boolean;
  event: DomainEvent | null;
};

export async function cancelPendingSubscriptionGeneration(
  env: Pick<Env, "BILLING_DB" | "DOMAIN_EVENTS">,
  subscriptionId: string,
  expectedVersion: number,
  canceledAt: string,
  correlationId: string,
  publishImmediately = true,
): Promise<CancelPendingSubscriptionResult> {
  const subscription = await env.BILLING_DB.prepare(
    `SELECT id, organization_id, external_id, status, version
     FROM subscriptions WHERE id = ? LIMIT 1`,
  )
    .bind(subscriptionId)
    .first<PendingSubscription>();
  if (!subscription) throw new Error("subscription_not_found");
  if (subscription.status === "canceled" || subscription.status === "terminated") {
    return { changed: false, event: null };
  }
  if (subscription.status !== "pending" || subscription.version !== expectedVersion) {
    throw new Error("subscription_version_conflict");
  }

  const event: DomainEvent = {
    id: `subscription-terminated:${subscription.id}:v${expectedVersion + 1}`,
    type: "subscription.terminated",
    version: 1,
    aggregateType: "subscription",
    aggregateId: subscription.id,
    aggregateVersion: expectedVersion + 1,
    occurredAt: canceledAt,
    causationId: correlationId,
    correlationId,
    payload: {
      organizationId: subscription.organization_id,
      subscriptionId: subscription.id,
      externalSubscriptionId: subscription.external_id,
      canceledAt,
      terminatedAt: null,
      finalInvoiceGenerated: false,
      creditNoteGenerated: false,
    },
  };
  const results = await env.BILLING_DB.batch([
    env.BILLING_DB.prepare(
      `UPDATE subscriptions
       SET status = 'canceled', canceled_at = ?, version = version + 1, updated_at = ?
       WHERE id = ? AND organization_id = ? AND version = ? AND status = 'pending'`,
    ).bind(canceledAt, canceledAt, subscription.id, subscription.organization_id, expectedVersion),
    env.BILLING_DB.prepare(
      `INSERT INTO outbox_events
       (event_id, organization_id, event_type, event_version, aggregate_type,
        aggregate_id, aggregate_version, causation_id, correlation_id, payload_json,
        occurred_at, published_at)
       SELECT ?, ?, ?, 1, 'subscription', ?, ?, ?, ?, ?, ?, NULL
       FROM subscriptions
       WHERE id = ? AND organization_id = ? AND version = ?
         AND status = 'canceled' AND canceled_at = ?
       ON CONFLICT(event_id) DO NOTHING`,
    ).bind(
      event.id,
      subscription.organization_id,
      event.type,
      subscription.id,
      event.aggregateVersion,
      correlationId,
      correlationId,
      stableJson(event.payload),
      canceledAt,
      subscription.id,
      subscription.organization_id,
      expectedVersion + 1,
      canceledAt,
    ),
  ]);
  if ((results[0]?.meta.changes ?? 0) < 1 || results[1]?.meta.changes !== 1) {
    const current = await env.BILLING_DB.prepare(
      "SELECT status FROM subscriptions WHERE id = ? LIMIT 1",
    )
      .bind(subscription.id)
      .first<{ status: string }>();
    if (current?.status === "canceled" || current?.status === "terminated") {
      return { changed: false, event: null };
    }
    throw new Error("subscription_version_conflict");
  }
  if (publishImmediately) await env.DOMAIN_EVENTS.send(event);
  return { changed: true, event };
}
