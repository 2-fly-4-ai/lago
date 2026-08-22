import { isDomainEvent } from "./domain-events";
import { authenticateApiKey } from "./auth/api-key";
import { handleLagoCompatibilityRequest } from "./api/lago-compatibility";
import { ApiError, apiErrorResponse } from "./http";
import { authorizeNetPaymentForm } from "./providers/authorize-net";
import { easyPayDirectPaymentForm } from "./providers/easy-pay-direct";
import { handleAuthorizeNetWebhook } from "./webhooks/authorize-net";
import { handleEasyPayDirectWebhook } from "./webhooks/easy-pay-direct";
import { handleStripeWebhook } from "./webhooks/stripe";
import { reconcileAuthorizeNetReceipt } from "./reconciliation/authorize-net";
import { reconcileEasyPayDirectReceipt } from "./reconciliation/easy-pay-direct";
import { deliverOutboundWebhooks } from "./webhooks/outbound";
import { scheduleInstanceId } from "./schedules/registry";
import { processPayInAdvanceUsageEvent } from "./billing/pay-in-advance-usage";
import { processUsageEventSubscriptionActivity } from "./usage/lifetime-usage";
import { handlePaymentRequestApi } from "./api/payment-requests";
import { handleDunningCampaignApi } from "./api/dunning-campaigns";
import { handleFeesApi } from "./api/fees";
import { handleApiKeysApi } from "./api/api-keys";
import { handleOrganizationsApi } from "./api/organizations";
import { handleBillingEntitiesApi } from "./api/billing-entities";
import { dispatchPaymentReceiptDocument, handlePaymentReceiptsApi } from "./api/payment-receipts";
import { dispatchCreditNoteDocument } from "./api/credit-note-ledger";
import { handleQuotesApi } from "./api/quotes";
import { handleDataExportsApi } from "./api/data-exports";
import { handleExternalTaxApi } from "./api/external-tax";
import { handleEasyPayDirectCheckoutSubmission } from "./api/easy-pay-direct-checkout";

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

      if (request.method === "GET" && url.pathname === "/easy_pay_direct/payment_form") {
        return await easyPayDirectPaymentForm(url, env);
      }

      if (request.method === "POST" && url.pathname === "/easy_pay_direct/payment_form") {
        return await handleEasyPayDirectCheckoutSubmission(request, env, requestId);
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

      const easyPayDirectWebhookMatch = url.pathname.match(
        /^\/webhooks\/easy_pay_direct\/([^/]+)$/,
      );
      if (request.method === "POST" && easyPayDirectWebhookMatch?.[1]) {
        return await handleEasyPayDirectWebhook(
          request,
          env,
          decodeURIComponent(easyPayDirectWebhookMatch[1]),
          requestId,
        );
      }

      const stripeWebhookMatch = url.pathname.match(/^\/webhooks\/stripe\/([^/]+)$/);
      if (request.method === "POST" && stripeWebhookMatch?.[1]) {
        return await handleStripeWebhook(
          request,
          env,
          decodeURIComponent(stripeWebhookMatch[1]),
          requestId,
        );
      }

      if (url.pathname.startsWith("/api/v1/")) {
        const auth = await authenticateApiKey(request, env.BILLING_DB);
        const dunningCampaignResponse = await handleDunningCampaignApi(
          request,
          env,
          auth,
          requestId,
        );
        if (dunningCampaignResponse) return dunningCampaignResponse;
        const paymentRequestResponse = await handlePaymentRequestApi(request, env, auth, requestId);
        if (paymentRequestResponse) return paymentRequestResponse;
        const feeResponse = await handleFeesApi(request, env, auth, requestId);
        if (feeResponse) return feeResponse;
        const apiKeyResponse = await handleApiKeysApi(request, env, auth, requestId);
        if (apiKeyResponse) return apiKeyResponse;
        const organizationResponse = await handleOrganizationsApi(request, env, auth, requestId);
        if (organizationResponse) return organizationResponse;
        const billingEntityResponse = await handleBillingEntitiesApi(request, env, auth, requestId);
        if (billingEntityResponse) return billingEntityResponse;
        const paymentReceiptResponse = await handlePaymentReceiptsApi(
          request,
          env,
          auth,
          requestId,
        );
        if (paymentReceiptResponse) return paymentReceiptResponse;
        const quoteResponse = await handleQuotesApi(request, env, auth, requestId);
        if (quoteResponse) return quoteResponse;
        const dataExportResponse = await handleDataExportsApi(request, env, auth, requestId);
        if (dataExportResponse) return dataExportResponse;
        const externalTaxResponse = await handleExternalTaxApi(request, env, auth, requestId);
        if (externalTaxResponse) return externalTaxResponse;
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
          try {
            await processUsageEventSubscriptionActivity(env.BILLING_DB, event.aggregateId);
          } catch {
            console.warn(
              JSON.stringify({
                level: "warn",
                event: "lifetime_usage_projection_deferred",
                usageEventId: event.aggregateId,
              }),
            );
          }
        }

        if (event.type === "authorize_net.webhook.received") {
          const outcome = await reconcileAuthorizeNetReceipt(env, event.aggregateId);
          if (outcome === "deferred") {
            message.ack();
            continue;
          }
        }

        if (event.type === "easy_pay_direct.webhook.received") {
          const outcome = await reconcileEasyPayDirectReceipt(env, event.aggregateId);
          if (outcome === "deferred") {
            message.ack();
            continue;
          }
        }

        if (!env.TEST_MIGRATIONS && event.type === "payment_receipt.created") {
          const organizationId = event.payload.organizationId;
          if (typeof organizationId !== "string" || organizationId.length === 0)
            throw new Error("invalid_payment_receipt_event");
          await dispatchPaymentReceiptDocument(
            env,
            event.aggregateId,
            organizationId,
            event.aggregateVersion,
            event.correlationId,
          );
        }

        if (
          !env.TEST_MIGRATIONS &&
          (event.type === "credit_note.created" || event.type === "credit_note.voided")
        ) {
          const organizationId = event.payload.organizationId;
          if (typeof organizationId !== "string" || organizationId.length === 0)
            throw new Error("invalid_credit_note_event");
          await dispatchCreditNoteDocument(
            env,
            event.aggregateId,
            organizationId,
            event.aggregateVersion,
            event.correlationId,
          );
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
