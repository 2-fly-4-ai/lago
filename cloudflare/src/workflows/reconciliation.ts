import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import { reconcileAuthorizeNetReceipt } from "../reconciliation/authorize-net";
import type { DomainEvent } from "../domain-events";

type ReconciliationParams = {
  schedule?: {
    cron: string;
    triggeredAt: number;
  };
};

export class ReconciliationWorkflow extends WorkflowEntrypoint<Env, ReconciliationParams> {
  override async run(event: WorkflowEvent<ReconciliationParams>, step: WorkflowStep) {
    const pendingReceiptIds = await step.do("load pending provider receipts", async () => {
      const result = await this.env.BILLING_DB.prepare(
        `SELECT id FROM webhook_receipts
         WHERE provider = 'authorize_net' AND processed_at IS NULL
         ORDER BY received_at ASC LIMIT 100`,
      ).all<{ id: string }>();
      return result.results.map((row) => row.id);
    });

    let processedReceipts = 0;
    let deferredReceipts = 0;
    for (const receiptId of pendingReceiptIds) {
      const outcome = await step.do(
        `reconcile provider receipt ${receiptId}`,
        { retries: { limit: 5, delay: "10 seconds", backoff: "exponential" }, timeout: "1 minute" },
        async () => reconcileAuthorizeNetReceipt(this.env, receiptId),
      );
      if (outcome === "processed") processedReceipts += 1;
      else deferredReceipts += 1;
    }

    const publishedEvents = await step.do(
      "publish pending outbox events",
      { retries: { limit: 5, delay: "5 seconds", backoff: "exponential" }, timeout: "1 minute" },
      async () => publishOutboxEvents(this.env),
    );

    return {
      accepted: true,
      cron: event.payload.schedule?.cron ?? null,
      triggeredAt: event.payload.schedule?.triggeredAt ?? null,
      pendingReceipts: pendingReceiptIds.length,
      processedReceipts,
      deferredReceipts,
      publishedEvents,
    };
  }
}

async function publishOutboxEvents(env: Env): Promise<number> {
  const result = await env.BILLING_DB.prepare(
    `SELECT event_id, event_type, event_version, aggregate_type, aggregate_id,
            aggregate_version, occurred_at, causation_id, correlation_id, payload_json
     FROM outbox_events WHERE published_at IS NULL ORDER BY occurred_at ASC LIMIT 100`,
  ).all<{
    event_id: string;
    event_type: string;
    event_version: number;
    aggregate_type: string;
    aggregate_id: string;
    aggregate_version: number;
    occurred_at: string;
    causation_id: string | null;
    correlation_id: string;
    payload_json: string;
  }>();

  const messages = result.results.map((row) => ({
    body: {
      id: row.event_id,
      type: row.event_type,
      version: row.event_version,
      aggregateType: row.aggregate_type,
      aggregateId: row.aggregate_id,
      aggregateVersion: row.aggregate_version,
      occurredAt: row.occurred_at,
      causationId: row.causation_id,
      correlationId: row.correlation_id,
      payload: parsePayload(row.payload_json),
    } satisfies DomainEvent,
  }));
  if (messages.length > 0) await env.DOMAIN_EVENTS.sendBatch(messages);
  return messages.length;
}

function parsePayload(value: string): Record<string, unknown> {
  try {
    const payload = JSON.parse(value) as unknown;
    return payload && typeof payload === "object" && !Array.isArray(payload)
      ? (payload as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}
