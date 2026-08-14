import { isDomainEvent } from "./domain-events";
import { authenticateApiKey } from "./auth/api-key";
import { handleLagoCompatibilityRequest } from "./api/lago-compatibility";
import { ApiError, apiErrorResponse } from "./http";
import { authorizeNetPaymentForm } from "./providers/authorize-net";
import { handleAuthorizeNetWebhook } from "./webhooks/authorize-net";
import { reconcileAuthorizeNetReceipt } from "./reconciliation/authorize-net";
import { deliverOutboundWebhooks } from "./webhooks/outbound";
import { scheduleInstanceId } from "./schedules/registry";
import { processPayInAdvanceUsageEvent } from "./billing/pay-in-advance-usage";

export { BillingAccount } from "./durable-objects/billing-account";
export { CheckoutWorkflow } from "./workflows/checkout";
export { ReconciliationWorkflow } from "./workflows/reconciliation";
export { DocumentWorkflow } from "./workflows/documents";
export { PlanDeletionWorkflow } from "./workflows/plan-deletion";

function jsonError(status: number, code: string, requestId: string): Response {
  return Response.json(
    {
      error: code,
      request_id: requestId,
    },
    {
      status,
      headers: { "Cache-Control": "no-store", "X-Request-Id": requestId },
    },
  );
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const requestId = request.headers.get("X-Request-Id")?.trim() || crypto.randomUUID();
    const url = new URL(request.url);

    try {
      if (request.method === "GET" && url.pathname === "/health") {
        return Response.json(
          { status: "ok", service: "serp-lago-native", environment: env.APP_ENV },
          { headers: { "Cache-Control": "no-store", "X-Request-Id": requestId } },
        );
      }

      if (request.method === "GET" && url.pathname === "/ready") {
        const result = await env.BILLING_DB.prepare("SELECT 1 AS ready").first<{ ready: number }>();
        if (result?.ready !== 1) return jsonError(503, "not_ready", requestId);
        return Response.json(
          { status: "ready" },
          { headers: { "Cache-Control": "no-store", "X-Request-Id": requestId } },
        );
      }

      if (request.method === "GET" && url.pathname === "/authorize_net/payment_form") {
        return authorizeNetPaymentForm(url);
      }

      const authorizeNetWebhookMatch = url.pathname.match(/^\/webhooks\/authorize_net\/([^/]+)$/);
      if (request.method === "POST" && authorizeNetWebhookMatch?.[1]) {
        return await handleAuthorizeNetWebhook(
          request,
          env,
          decodeURIComponent(authorizeNetWebhookMatch[1]),
          requestId,
        );
      }

      if (url.pathname.startsWith("/api/v1/")) {
        const auth = await authenticateApiKey(request, env.BILLING_DB);
        const response = await handleLagoCompatibilityRequest(request, env, auth, requestId);
        if (response) return response;
      }

      return jsonError(404, "not_found", requestId);
    } catch (error) {
      if (error instanceof ApiError) return apiErrorResponse(error, requestId);
      console.error(
        JSON.stringify({ level: "error", event: "unhandled_request_error", requestId }),
      );
      return apiErrorResponse(
        new ApiError(500, "internal_error", "An unexpected error occurred"),
        requestId,
      );
    }
  },

  async scheduled(controller: ScheduledController, env: Env): Promise<void> {
    const instanceId = scheduleInstanceId(controller.scheduledTime);
    try {
      await env.RECONCILIATION_WORKFLOW.create({
        id: instanceId,
        params: { schedule: { cron: controller.cron, triggeredAt: controller.scheduledTime } },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "workflow_dispatch_failed";
      if (!message.toLowerCase().includes("already exists")) throw error;
    }
  },

  async queue(batch: MessageBatch<unknown>, env: Env): Promise<void> {
    for (const message of batch.messages) {
      if (!isDomainEvent(message.body)) {
        message.ack();
        continue;
      }

      const event = message.body;
      const existing = await env.BILLING_DB.prepare(
        "SELECT event_id FROM processed_messages WHERE event_id = ?",
      )
        .bind(event.id)
        .first();

      if (existing) {
        message.ack();
        continue;
      }

      try {
        if (event.type === "usage_event.ingested") {
          await processPayInAdvanceUsageEvent(env, event.aggregateId, event.correlationId);
        }

        if (event.type === "authorize_net.webhook.received") {
          const outcome = await reconcileAuthorizeNetReceipt(env, event.aggregateId);
          if (outcome === "deferred") {
            message.ack();
            continue;
          }
        }

        const outboundOutcome = await deliverOutboundWebhooks(env, event);
        if (outboundOutcome === "retry") {
          message.retry();
          continue;
        }

        const processedAt = new Date().toISOString();
        await env.BILLING_DB.batch([
          env.BILLING_DB.prepare(
            `INSERT INTO processed_messages (event_id, event_type, processed_at)
             VALUES (?, ?, ?) ON CONFLICT(event_id) DO NOTHING`,
          ).bind(event.id, event.type, processedAt),
          env.BILLING_DB.prepare(
            `UPDATE outbox_events SET published_at = COALESCE(published_at, ?)
             WHERE event_id = ?`,
          ).bind(processedAt, event.id),
        ]);
        message.ack();
      } catch {
        message.retry();
      }
    }
  },
} satisfies ExportedHandler<Env>;
