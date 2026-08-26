import type { JWTVerifyGetKey } from "jose";

import { handleAddOnLedgerRequest } from "../api/add-on-ledger";
import { handleApiKeysApi } from "../api/api-keys";
import { handleBillingEntitiesApi } from "../api/billing-entities";
import { handleCouponLedgerRequest } from "../api/coupon-ledger";
import { createDataExport, listDataExports, showDataExport } from "../api/data-exports";
import { handleDunningCampaignApi } from "../api/dunning-campaigns";
import {
  createCreditNote,
  handleCreditNoteLedgerRequest,
  listCreditNotes,
  showCreditNote,
  voidCreditNote,
} from "../api/credit-note-ledger";
import { handleInvoiceCustomSectionRequest } from "../api/invoice-custom-sections";
import { handleMeteredUsageRequest } from "../api/metered-usage";
import {
  createOneOffInvoice,
  createSubscription,
  finalizeDraftInvoice,
  handleLagoCompatibilityRequest,
  handleCustomerCompatibilityRequest,
  listInvoices,
  refreshDraftInvoice,
  showInvoice,
  voidInvoice,
} from "../api/lago-compatibility";
import { showOrganization } from "../api/organizations";
import { handlePaymentReceiptReadsApi, handlePaymentReceiptsApi } from "../api/payment-receipts";
import { listPayments, showPayment } from "../api/payment-ledger";
import { handlePaymentRequestApi } from "../api/payment-requests";
import { handlePlanCatalogRequest } from "../api/plan-catalog";
import { handleQuotesApi } from "../api/quotes";
import { handleTaxLedgerRequest } from "../api/tax-ledger";
import { handleSubscriptionLifecycleRequest } from "../api/subscription-lifecycle";
import { handleWalletLedgerRequest } from "../api/wallet-ledger";
import { listEndpoints, showEndpoint } from "../api/webhook-endpoints";
import type { AuthContext } from "../auth/api-key";
import { ApiError, apiErrorResponse, json, objectAt, parseJsonObject } from "../http";
import {
  assertOperatorAdmin,
  assertOperatorMutationRequest,
  authenticateOperatorAccess,
  type OperatorEnv,
} from "./access";
import { handleOperatorAiRequest } from "./ai";
import { handleOperatorAdvancedBillingRequest } from "./advanced-billing";
import { handleOperatorAnalyticsRequest } from "./analytics";
import { handleOperatorConfigurationRequest } from "./configuration";
import { handleOperatorFeaturesRequest } from "./features";
import { handleOperatorIntegrationsRequest } from "./integrations";
import { handleOperatorObservabilityRequest, recordOperatorApiLog } from "./observability";
import { handleOperatorProductParityRequest } from "./product-parity";
import { handleOperatorProviderFinancialsRequest } from "./provider-financials";
import { handlePortalAdminRequest } from "./portal-admin";
import { handleOperatorTeamRequest } from "./team";

export function createOperatorHandler(keySet?: JWTVerifyGetKey): ExportedHandler<OperatorEnv> {
  return {
    async fetch(request: Request, env: OperatorEnv, ctx: ExecutionContext): Promise<Response> {
      const startedAt = Date.now();
      const requestId = safeRequestId(request.headers.get("X-Request-Id"));
      const headers = new Headers(request.headers);
      headers.set("X-Request-Id", requestId);
      const tracedRequest = new Request(request, { headers });
      const response = await handleOperatorRequest(tracedRequest, env, keySet, ctx);
      ctx.waitUntil(
        recordOperatorApiLog(
          tracedRequest,
          env,
          keySet,
          requestId,
          response.status,
          Date.now() - startedAt,
        ),
      );
      return response;
    },
  };
}

export async function handleOperatorRequest(
  request: Request,
  env: OperatorEnv,
  keySet?: JWTVerifyGetKey,
  executionContext?: ExecutionContext,
): Promise<Response> {
  const requestId = request.headers.get("X-Request-Id")?.trim() || crypto.randomUUID();
  const url = new URL(request.url);

  try {
    if (request.method === "GET" && url.pathname === "/health") {
      return json(
        {
          status: "ok",
          service: "serp-lago-operator",
          environment: env.APP_ENV,
          access_enabled: env.OPERATOR_ACCESS_ENABLED === "1",
        },
        { requestId },
      );
    }

    if (request.method === "GET" && url.pathname === "/ready") {
      if (env.OPERATOR_ACCESS_ENABLED !== "1") {
        throw new ApiError(503, "operator_access_disabled", "Operator access is disabled");
      }
      const ready = await env.BILLING_DB.prepare("SELECT 1 AS ready").first<{ ready: number }>();
      if (ready?.ready !== 1) throw new ApiError(503, "not_ready", "Operator service is not ready");
      return json({ status: "ready" }, { requestId });
    }

    if (
      request.method === "GET" &&
      (url.pathname === "/api/operator/v1/session" ||
        url.pathname === "/api/operator/v1/organization")
    ) {
      const operator = await authenticateOperatorAccess(request, env, keySet);
      if (url.pathname === "/api/operator/v1/organization") {
        return showOrganization(env.BILLING_DB, operator.organizationId, requestId);
      }
      return json(
        {
          operator: {
            membership_id: operator.membershipId,
            organization_id: operator.organizationId,
            organization_external_id: operator.organizationExternalId,
            organization_name: operator.organizationName,
            organization_slug: operator.organizationSlug,
            role: operator.role,
            memberships: operator.memberships.map((membership) => ({
              membership_id: membership.membershipId,
              role: membership.role,
              organization: {
                lago_id: membership.organizationId,
                external_id: membership.organizationExternalId,
                name: membership.organizationName,
                slug: membership.organizationSlug,
              },
            })),
          },
        },
        { requestId },
      );
    }

    if (
      url.pathname === "/api/operator/v1/analytics" ||
      url.pathname === "/api/operator/v1/forecasts"
    ) {
      const operator = await authenticateOperatorAccess(request, env, keySet);
      const response = await handleOperatorAnalyticsRequest(
        request,
        env.BILLING_DB,
        operator.organizationId,
        requestId,
      );
      if (response) return response;
    }

    if (
      url.pathname.startsWith("/api/operator/v1/observability/") ||
      /^\/api\/operator\/v1\/webhook-endpoints\/[^/]+\/logs(?:\/|$)/.test(url.pathname)
    ) {
      const operator = await authenticateOperatorAccess(request, env, keySet);
      const response = await handleOperatorObservabilityRequest(
        request,
        env.BILLING_DB,
        operator.organizationId,
        requestId,
      );
      if (response) return response;
    }

    if (url.pathname.startsWith("/api/operator/v1/team/")) {
      const operator = await authenticateOperatorAccess(request, env, keySet);
      const response = await handleOperatorTeamRequest(request, env, operator, requestId);
      if (response) return response;
    }

    if (/^\/api\/operator\/v1\/integrations(?:\/|$)/.test(url.pathname)) {
      const operator = await authenticateOperatorAccess(request, env, keySet);
      if (request.method !== "GET") {
        assertOperatorAdmin(operator);
        assertOperatorMutationRequest(request);
      }
      let runtimeStatuses: Awaited<
        ReturnType<NonNullable<OperatorEnv["PROVIDER_FINANCIALS"]>["getIntegrationRuntimeStatuses"]>
      > = [];
      if (request.method === "GET" && env.PROVIDER_FINANCIALS) {
        try {
          runtimeStatuses = await env.PROVIDER_FINANCIALS.getIntegrationRuntimeStatuses(
            operator.organizationId,
          );
        } catch {
          console.warn(
            JSON.stringify({
              level: "warn",
              event: "provider_runtime_status_unavailable",
              requestId,
              organizationId: operator.organizationId,
            }),
          );
        }
      }
      const response = await handleOperatorIntegrationsRequest(
        request,
        env.BILLING_DB,
        operator.organizationId,
        requestId,
        runtimeStatuses,
      );
      if (response) return response;
    }

    if (/^\/api\/operator\/v1\/(?:pricing-units|alerts)(?:\/|$)/.test(url.pathname)) {
      const operator = await authenticateOperatorAccess(request, env, keySet);
      if (request.method !== "GET") {
        assertOperatorAdmin(operator);
        assertOperatorMutationRequest(request);
      }
      const response = await handleOperatorConfigurationRequest(
        request,
        env.BILLING_DB,
        operator.organizationId,
        requestId,
      );
      if (response) return response;
    }

    if (
      /^\/api\/operator\/v1\/(?:billing-entities|customers|subscriptions|invoices|credit-notes)(?:\/|$)/.test(
        url.pathname,
      )
    ) {
      const operator = await authenticateOperatorAccess(request, env, keySet);
      if (request.method !== "GET") {
        assertOperatorAdmin(operator);
        assertOperatorMutationRequest(request);
      }
      const response = await handleOperatorAdvancedBillingRequest(
        request,
        env,
        operator.organizationId,
        requestId,
      );
      if (response) return response;
    }

    if (/^\/api\/operator\/v1\/customers\/[^/]+\/portal-token$/.test(url.pathname)) {
      const operator = await authenticateOperatorAccess(request, env, keySet);
      assertOperatorAdmin(operator);
      assertOperatorMutationRequest(request);
      const response = await handlePortalAdminRequest(request, env.BILLING_DB, operator, requestId);
      if (response) return response;
    }

    if (/^\/api\/operator\/v1\/billable-metrics(?:\/|$)/.test(url.pathname)) {
      const operator = await authenticateOperatorAccess(request, env, keySet);
      const parityResponse = await handleOperatorProductParityRequest(
        request,
        env.BILLING_DB,
        operator.organizationId,
        requestId,
      );
      if (parityResponse) return parityResponse;
      if (request.method !== "GET") {
        assertOperatorAdmin(operator);
        assertOperatorMutationRequest(request);
      }
      const auth: AuthContext = {
        organizationId: operator.organizationId,
        organizationExternalId: operator.organizationExternalId,
        apiKeyId: `operator:${operator.membershipId}`,
      };
      const forwardedUrl = new URL(request.url);
      forwardedUrl.pathname = forwardedUrl.pathname.replace(
        "/api/operator/v1/billable-metrics",
        "/api/v1/billable_metrics",
      );
      const response = await handleMeteredUsageRequest(
        new Request(forwardedUrl, request),
        env as unknown as Env,
        auth,
        requestId,
      );
      if (response) return response;
    }

    if (/^\/api\/operator\/v1\/features(?:\/|$)/.test(url.pathname)) {
      const operator = await authenticateOperatorAccess(request, env, keySet);
      const parityResponse = await handleOperatorProductParityRequest(
        request,
        env.BILLING_DB,
        operator.organizationId,
        requestId,
      );
      if (parityResponse) return parityResponse;
      if (request.method !== "GET") {
        assertOperatorAdmin(operator);
        assertOperatorMutationRequest(request);
      }
      const response = await handleOperatorFeaturesRequest(
        request,
        env.BILLING_DB,
        operator.organizationId,
        requestId,
      );
      if (response) return response;
    }

    if (/^\/api\/operator\/v1\/ai\/conversations(?:\/|$)/.test(url.pathname)) {
      const operator = await authenticateOperatorAccess(request, env, keySet);
      if (request.method !== "GET") assertOperatorMutationRequest(request);
      const response = await handleOperatorAiRequest(
        request,
        env,
        operator,
        requestId,
        executionContext,
      );
      if (response) return response;
    }

    if (/^\/api\/operator\/v1\/api-keys(?:\/|$)/.test(url.pathname)) {
      const operator = await authenticateOperatorAccess(request, env, keySet);
      if (request.method !== "GET") {
        assertOperatorAdmin(operator);
        assertOperatorMutationRequest(request);
      }
      const auth: AuthContext = {
        organizationId: operator.organizationId,
        organizationExternalId: operator.organizationExternalId,
        apiKeyId: `operator:${operator.membershipId}`,
      };
      const forwardedUrl = new URL(request.url);
      forwardedUrl.pathname = forwardedUrl.pathname.replace(
        "/api/operator/v1/api-keys",
        "/api/v1/api_keys",
      );
      const response = await handleApiKeysApi(
        new Request(forwardedUrl, request),
        env,
        auth,
        requestId,
      );
      if (response) return response;
    }

    if (/^\/api\/operator\/v1\/billing-entities(?:\/|$)/.test(url.pathname)) {
      const operator = await authenticateOperatorAccess(request, env, keySet);
      if (request.method !== "GET") {
        assertOperatorAdmin(operator);
        assertOperatorMutationRequest(request);
      }
      const auth: AuthContext = {
        organizationId: operator.organizationId,
        organizationExternalId: operator.organizationExternalId,
        apiKeyId: `operator:${operator.membershipId}`,
      };
      const forwardedUrl = new URL(request.url);
      forwardedUrl.pathname = forwardedUrl.pathname.replace(
        "/api/operator/v1/billing-entities",
        "/api/v1/billing_entities",
      );
      const response = await handleBillingEntitiesApi(
        new Request(forwardedUrl, request),
        env,
        auth,
        requestId,
      );
      if (response) return response;
    }

    if (/^\/api\/operator\/v1\/invoice-custom-sections(?:\/|$)/.test(url.pathname)) {
      const operator = await authenticateOperatorAccess(request, env, keySet);
      if (request.method !== "GET") {
        assertOperatorAdmin(operator);
        assertOperatorMutationRequest(request);
      }
      const auth: AuthContext = {
        organizationId: operator.organizationId,
        organizationExternalId: operator.organizationExternalId,
        apiKeyId: `operator:${operator.membershipId}`,
      };
      const forwardedUrl = new URL(request.url);
      forwardedUrl.pathname = forwardedUrl.pathname.replace(
        "/api/operator/v1/invoice-custom-sections",
        "/api/v1/invoice_custom_sections",
      );
      const response = await handleInvoiceCustomSectionRequest(
        new Request(forwardedUrl, request),
        env,
        auth,
        requestId,
      );
      if (response) return response;
    }

    if (/^\/api\/operator\/v1\/payment-receipts(?:\/|$)/.test(url.pathname)) {
      const operator = await authenticateOperatorAccess(request, env, keySet);
      if (request.method !== "GET") {
        throw new ApiError(
          405,
          "operator_payment_receipts_read_only",
          "Payment receipts are read-only in the operator workspace",
        );
      }
      const auth: AuthContext = {
        organizationId: operator.organizationId,
        organizationExternalId: operator.organizationExternalId,
        apiKeyId: `operator:${operator.membershipId}`,
      };
      const forwardedUrl = new URL(request.url);
      forwardedUrl.pathname = forwardedUrl.pathname.replace(
        "/api/operator/v1/payment-receipts",
        "/api/v1/payment_receipts",
      );
      const response = await handlePaymentReceiptReadsApi(
        new Request(forwardedUrl, request),
        env,
        auth,
        requestId,
        { includeFileUrls: false },
      );
      if (response) return response;
      if (forwardedUrl.pathname.endsWith("/download")) {
        if (!env.BILLING_ARTIFACTS)
          throw new ApiError(
            503,
            "artifact_storage_unavailable",
            "Billing artifact storage is unavailable",
          );
        const downloadResponse = await handlePaymentReceiptsApi(
          new Request(forwardedUrl, request),
          env as unknown as Env,
          auth,
          requestId,
        );
        if (downloadResponse) return downloadResponse;
      }
    }

    if (/^\/api\/operator\/v1\/payments(?:\/|$)/.test(url.pathname)) {
      const operator = await authenticateOperatorAccess(request, env, keySet);
      if (request.method !== "GET") {
        throw new ApiError(
          405,
          "operator_payments_read_only",
          "Payments are read-only in the operator workspace",
        );
      }
      const auth: AuthContext = {
        organizationId: operator.organizationId,
        organizationExternalId: operator.organizationExternalId,
        apiKeyId: `operator:${operator.membershipId}`,
      };
      const forwardedUrl = new URL(request.url);
      forwardedUrl.pathname = forwardedUrl.pathname.replace(
        "/api/operator/v1/payments",
        "/api/v1/payments",
      );
      if (forwardedUrl.pathname === "/api/v1/payments") {
        return listPayments(forwardedUrl, env.BILLING_DB, auth, requestId);
      }
      const match = forwardedUrl.pathname.match(/^\/api\/v1\/payments\/([^/]+)$/);
      if (match?.[1]) {
        return showPayment(decodeURIComponent(match[1]), env.BILLING_DB, auth, requestId);
      }
    }

    if (/^\/api\/operator\/v1\/(?:payment-disputes|provider-refunds)(?:\/|$)/.test(url.pathname)) {
      const operator = await authenticateOperatorAccess(request, env, keySet);
      if (request.method !== "GET") {
        assertOperatorAdmin(operator);
        assertOperatorMutationRequest(request);
      }
      const response = await handleOperatorProviderFinancialsRequest(
        request,
        env.BILLING_DB,
        operator.organizationId,
        requestId,
      );
      if (response) return response;
    }

    if (
      /^\/api\/operator\/v1\/quotes(?:\/|$)/.test(url.pathname) ||
      /^\/api\/operator\/v1\/quote-versions(?:\/|$)/.test(url.pathname)
    ) {
      const operator = await authenticateOperatorAccess(request, env, keySet);
      if (request.method !== "GET") {
        assertOperatorAdmin(operator);
        assertOperatorMutationRequest(request);
        await assertOperatorQuoteMutationPayload(request, url.pathname);
      }
      const auth: AuthContext = {
        organizationId: operator.organizationId,
        organizationExternalId: operator.organizationExternalId,
        apiKeyId: `operator:${operator.membershipId}`,
      };
      const forwardedUrl = new URL(request.url);
      forwardedUrl.pathname = forwardedUrl.pathname
        .replace("/api/operator/v1/quotes", "/api/v1/quotes")
        .replace("/api/operator/v1/quote-versions", "/api/v1/quote_versions");
      const response = await handleQuotesApi(
        new Request(forwardedUrl, request),
        env,
        auth,
        requestId,
      );
      if (response) return response;
    }

    if (/^\/api\/operator\/v1\/data-exports(?:\/|$)/.test(url.pathname)) {
      const operator = await authenticateOperatorAccess(request, env, keySet);
      if (request.method !== "GET") {
        assertOperatorAdmin(operator);
        assertOperatorMutationRequest(request);
        await assertOperatorDataExportMutationPayload(request, url.pathname);
      }
      const auth: AuthContext = {
        organizationId: operator.organizationId,
        organizationExternalId: operator.organizationExternalId,
        apiKeyId: `operator:${operator.membershipId}`,
      };
      const forwardedUrl = new URL(request.url);
      forwardedUrl.pathname = forwardedUrl.pathname.replace(
        "/api/operator/v1/data-exports",
        "/api/v1/data_exports",
      );
      if (request.method === "GET" && forwardedUrl.pathname === "/api/v1/data_exports") {
        return listDataExports(forwardedUrl, env.BILLING_DB, auth, requestId);
      }
      const match = forwardedUrl.pathname.match(/^\/api\/v1\/data_exports\/([^/]+)$/);
      if (request.method === "GET" && match?.[1]) {
        return showDataExport(decodeURIComponent(match[1]), env.BILLING_DB, auth, requestId);
      }
      if (request.method === "POST" && forwardedUrl.pathname === "/api/v1/data_exports") {
        return createDataExport(new Request(forwardedUrl, request), env, auth, requestId, {
          operatorMembershipId: operator.membershipId,
        });
      }
      throw new ApiError(
        422,
        "unsupported_operator_data_export_action",
        "Data-export download and email actions are not admitted to the operator workflow",
      );
    }

    if (/^\/api\/operator\/v1\/webhook-endpoints(?:\/|$)/.test(url.pathname)) {
      const operator = await authenticateOperatorAccess(request, env, keySet);
      if (request.method !== "GET") {
        throw new ApiError(
          405,
          "operator_webhook_endpoints_read_only",
          "Webhook endpoints are read-only while outbound delivery is disabled",
        );
      }
      const auth: AuthContext = {
        organizationId: operator.organizationId,
        organizationExternalId: operator.organizationExternalId,
        apiKeyId: `operator:${operator.membershipId}`,
      };
      const forwardedUrl = new URL(request.url);
      forwardedUrl.pathname = forwardedUrl.pathname.replace(
        "/api/operator/v1/webhook-endpoints",
        "/api/v1/webhook_endpoints",
      );
      if (forwardedUrl.pathname === "/api/v1/webhook_endpoints") {
        return listEndpoints(forwardedUrl, env.BILLING_DB, auth, requestId);
      }
      const match = forwardedUrl.pathname.match(/^\/api\/v1\/webhook_endpoints\/([^/]+)$/);
      if (match?.[1]) {
        return showEndpoint(decodeURIComponent(match[1]), env.BILLING_DB, auth, requestId);
      }
    }

    if (/^\/api\/operator\/v1\/dunning-campaigns(?:\/|$)/.test(url.pathname)) {
      const operator = await authenticateOperatorAccess(request, env, keySet);
      if (request.method !== "GET") {
        assertOperatorAdmin(operator);
        assertOperatorMutationRequest(request);
      }
      const auth: AuthContext = {
        organizationId: operator.organizationId,
        organizationExternalId: operator.organizationExternalId,
        apiKeyId: `operator:${operator.membershipId}`,
      };
      const forwardedUrl = new URL(request.url);
      forwardedUrl.pathname = forwardedUrl.pathname.replace(
        "/api/operator/v1/dunning-campaigns",
        "/api/v1/dunning_campaigns",
      );
      const response = await handleDunningCampaignApi(
        new Request(forwardedUrl, request),
        env,
        auth,
        requestId,
      );
      if (response) return response;
    }

    if (/^\/api\/operator\/v1\/payment-requests(?:\/|$)/.test(url.pathname)) {
      const operator = await authenticateOperatorAccess(request, env, keySet);
      if (request.method !== "GET") {
        throw new ApiError(
          405,
          "operator_payment_requests_read_only",
          "Payment requests are read-only in the operator workspace",
        );
      }
      const auth: AuthContext = {
        organizationId: operator.organizationId,
        organizationExternalId: operator.organizationExternalId,
        apiKeyId: `operator:${operator.membershipId}`,
      };
      const forwardedUrl = new URL(request.url);
      forwardedUrl.pathname = forwardedUrl.pathname.replace(
        "/api/operator/v1/payment-requests",
        "/api/v1/payment_requests",
      );
      const response = await handlePaymentRequestApi(
        new Request(forwardedUrl, request),
        env,
        auth,
        requestId,
      );
      if (response) return response;
    }

    if (/^\/api\/operator\/v1\/taxes(?:\/|$)/.test(url.pathname)) {
      const operator = await authenticateOperatorAccess(request, env, keySet);
      if (request.method !== "GET") {
        assertOperatorAdmin(operator);
        assertOperatorMutationRequest(request);
      }
      const auth: AuthContext = {
        organizationId: operator.organizationId,
        organizationExternalId: operator.organizationExternalId,
        apiKeyId: `operator:${operator.membershipId}`,
      };
      const forwardedUrl = new URL(request.url);
      forwardedUrl.pathname = forwardedUrl.pathname.replace(
        "/api/operator/v1/taxes",
        "/api/v1/taxes",
      );
      const response = await handleTaxLedgerRequest(
        new Request(forwardedUrl, request),
        env,
        auth,
        requestId,
      );
      if (response) return response;
    }

    if (/^\/api\/operator\/v1\/add-ons(?:\/|$)/.test(url.pathname)) {
      const operator = await authenticateOperatorAccess(request, env, keySet);
      if (request.method !== "GET") {
        assertOperatorAdmin(operator);
        assertOperatorMutationRequest(request);
      }
      const auth: AuthContext = {
        organizationId: operator.organizationId,
        organizationExternalId: operator.organizationExternalId,
        apiKeyId: `operator:${operator.membershipId}`,
      };
      const forwardedUrl = new URL(request.url);
      forwardedUrl.pathname = forwardedUrl.pathname.replace(
        "/api/operator/v1/add-ons",
        "/api/v1/add_ons",
      );
      const response = await handleAddOnLedgerRequest(
        new Request(forwardedUrl, request),
        env,
        auth,
        requestId,
      );
      if (response) return response;
    }

    if (
      /^\/api\/operator\/v1\/(?:coupons|applied-coupons)(?:\/|$)/.test(url.pathname) ||
      /^\/api\/operator\/v1\/customers\/[^/]+\/applied-coupons(?:\/|$)/.test(url.pathname)
    ) {
      const operator = await authenticateOperatorAccess(request, env, keySet);
      if (request.method !== "GET") {
        assertOperatorAdmin(operator);
        assertOperatorMutationRequest(request);
      }
      const auth: AuthContext = {
        organizationId: operator.organizationId,
        organizationExternalId: operator.organizationExternalId,
        apiKeyId: `operator:${operator.membershipId}`,
      };
      const forwardedUrl = new URL(request.url);
      forwardedUrl.pathname = forwardedUrl.pathname
        .replace("/api/operator/v1/applied-coupons", "/api/v1/applied_coupons")
        .replace("/api/operator/v1/coupons", "/api/v1/coupons")
        .replace("/applied-coupons", "/applied_coupons")
        .replace("/api/operator/v1/customers", "/api/v1/customers");
      const response = await handleCouponLedgerRequest(
        new Request(forwardedUrl, request),
        env,
        auth,
        requestId,
      );
      if (response) return response;
    }

    if (/^\/api\/operator\/v1\/plans(?:\/|$)/.test(url.pathname)) {
      const operator = await authenticateOperatorAccess(request, env, keySet);
      if (request.method !== "GET") {
        assertOperatorAdmin(operator);
        assertOperatorMutationRequest(request);
      }
      const parityResponse = await handleOperatorProductParityRequest(
        request,
        env.BILLING_DB,
        operator.organizationId,
        requestId,
      );
      if (parityResponse) return parityResponse;
      if (request.method !== "GET") {
        await assertOperatorPlanMutationPayload(request, url.pathname);
      }
      const auth: AuthContext = {
        organizationId: operator.organizationId,
        organizationExternalId: operator.organizationExternalId,
        apiKeyId: `operator:${operator.membershipId}`,
      };
      const forwardedUrl = new URL(request.url);
      forwardedUrl.pathname = forwardedUrl.pathname
        .replace("/api/operator/v1/plans", "/api/v1/plans")
        .replace("/fixed-charges", "/fixed_charges");
      const response = await handlePlanCatalogRequest(
        new Request(forwardedUrl, request),
        env,
        auth,
        requestId,
      );
      if (response) return response;
    }

    if (/^\/api\/operator\/v1\/subscriptions(?:\/|$)/.test(url.pathname)) {
      const operator = await authenticateOperatorAccess(request, env, keySet);
      if (request.method !== "GET") {
        assertOperatorAdmin(operator);
        assertOperatorMutationRequest(request);
        await assertOperatorSubscriptionMutationPayload(request);
      }
      const auth: AuthContext = {
        organizationId: operator.organizationId,
        organizationExternalId: operator.organizationExternalId,
        apiKeyId: `operator:${operator.membershipId}`,
      };
      const forwardedUrl = new URL(request.url);
      forwardedUrl.pathname = forwardedUrl.pathname.replace(
        "/api/operator/v1/subscriptions",
        "/api/v1/subscriptions",
      );
      const forwardedRequest = new Request(forwardedUrl, request);
      if (request.method === "POST" && forwardedUrl.pathname === "/api/v1/subscriptions") {
        return createSubscription(forwardedRequest, env, auth, requestId);
      }
      const response = await handleSubscriptionLifecycleRequest(
        forwardedRequest,
        env,
        auth,
        requestId,
      );
      if (response) return response;
    }

    if (/^\/api\/operator\/v1\/invoices(?:\/|$)/.test(url.pathname)) {
      const operator = await authenticateOperatorAccess(request, env, keySet);
      if (request.method !== "GET") {
        assertOperatorAdmin(operator);
        assertOperatorMutationRequest(request);
        await assertOperatorInvoiceMutationPayload(request, url.pathname);
      }
      const auth: AuthContext = {
        organizationId: operator.organizationId,
        organizationExternalId: operator.organizationExternalId,
        apiKeyId: `operator:${operator.membershipId}`,
      };
      const forwardedUrl = new URL(request.url);
      forwardedUrl.pathname = forwardedUrl.pathname.replace(
        "/api/operator/v1/invoices",
        "/api/v1/invoices",
      );
      if (request.method === "GET" && forwardedUrl.pathname === "/api/v1/invoices") {
        return listInvoices(forwardedUrl, env.BILLING_DB, auth, requestId);
      }
      const match = forwardedUrl.pathname.match(/^\/api\/v1\/invoices\/([^/]+)(?:\/([^/]+))?$/);
      if (request.method === "GET" && match?.[1] && !match[2]) {
        return showInvoice(decodeURIComponent(match[1]), env.BILLING_DB, auth, requestId);
      }
      if (request.method === "POST" && forwardedUrl.pathname === "/api/v1/invoices") {
        return createOneOffInvoice(new Request(forwardedUrl, request), env, auth, requestId);
      }
      if (match?.[1] && match[2] === "void" && request.method === "POST") {
        return voidInvoice(
          new Request(forwardedUrl, request),
          decodeURIComponent(match[1]),
          env,
          auth,
          requestId,
        );
      }
      if (match?.[1] && match[2] === "finalize" && request.method === "PUT") {
        return finalizeDraftInvoice(decodeURIComponent(match[1]), env, auth, requestId);
      }
      if (match?.[1] && match[2] === "refresh" && request.method === "PUT") {
        return refreshDraftInvoice(decodeURIComponent(match[1]), env, auth, requestId);
      }
      if (
        match?.[1] &&
        (match[2] === "download" || match[2] === "download_pdf") &&
        request.method === "GET"
      ) {
        if (!env.BILLING_ARTIFACTS)
          throw new ApiError(
            503,
            "artifact_storage_unavailable",
            "Billing artifact storage is unavailable",
          );
        const response = await handleLagoCompatibilityRequest(
          new Request(forwardedUrl, request),
          env as unknown as Env,
          auth,
          requestId,
        );
        if (response) return response;
      }
    }

    if (
      /^\/api\/operator\/v1\/wallets(?:\/|$)/.test(url.pathname) ||
      /^\/api\/operator\/v1\/wallet-transactions(?:\/|$)/.test(url.pathname)
    ) {
      const operator = await authenticateOperatorAccess(request, env, keySet);
      if (request.method !== "GET") {
        assertOperatorAdmin(operator);
        assertOperatorMutationRequest(request);
        await assertOperatorWalletMutationPayload(request, url.pathname);
      }
      const auth: AuthContext = {
        organizationId: operator.organizationId,
        organizationExternalId: operator.organizationExternalId,
        apiKeyId: `operator:${operator.membershipId}`,
      };
      const forwardedUrl = new URL(request.url);
      forwardedUrl.pathname = forwardedUrl.pathname
        .replace("/api/operator/v1/wallets", "/api/v1/wallets")
        .replace("/api/operator/v1/wallet-transactions", "/api/v1/wallet_transactions");
      const response = await handleWalletLedgerRequest(
        new Request(forwardedUrl, request),
        env,
        auth,
        requestId,
      );
      if (response) return response;
    }

    if (/^\/api\/operator\/v1\/credit-notes(?:\/|$)/.test(url.pathname)) {
      const operator = await authenticateOperatorAccess(request, env, keySet);
      if (request.method !== "GET") {
        assertOperatorAdmin(operator);
        assertOperatorMutationRequest(request);
        await assertOperatorCreditNoteMutationPayload(request, url.pathname);
      }
      const auth: AuthContext = {
        organizationId: operator.organizationId,
        organizationExternalId: operator.organizationExternalId,
        apiKeyId: `operator:${operator.membershipId}`,
      };
      const forwardedUrl = new URL(request.url);
      forwardedUrl.pathname = forwardedUrl.pathname.replace(
        "/api/operator/v1/credit-notes",
        "/api/v1/credit_notes",
      );
      if (request.method === "GET" && forwardedUrl.pathname === "/api/v1/credit_notes") {
        return listCreditNotes(forwardedUrl, env.BILLING_DB, auth, requestId);
      }
      const match = forwardedUrl.pathname.match(
        /^\/api\/v1\/credit_notes\/([^/]+)(?:\/(void|download|download_pdf))?$/,
      );
      if (request.method === "GET" && match?.[1] && !match[2]) {
        return showCreditNote(
          decodeURIComponent(match[1]),
          env.BILLING_DB,
          auth,
          requestId,
          forwardedUrl.origin,
        );
      }
      if (request.method === "POST" && forwardedUrl.pathname === "/api/v1/credit_notes") {
        return createCreditNote(new Request(forwardedUrl, request), env, auth, requestId);
      }
      if (request.method === "PUT" && match?.[1] && match[2] === "void") {
        return voidCreditNote(
          decodeURIComponent(match[1]),
          env,
          auth,
          requestId,
          forwardedUrl.origin,
        );
      }
      if (
        request.method === "GET" &&
        match?.[1] &&
        (match[2] === "download" || match[2] === "download_pdf")
      ) {
        if (!env.BILLING_ARTIFACTS)
          throw new ApiError(
            503,
            "artifact_storage_unavailable",
            "Billing artifact storage is unavailable",
          );
        const response = await handleCreditNoteLedgerRequest(
          new Request(forwardedUrl, request),
          env as unknown as Env,
          auth,
          requestId,
        );
        if (response) return response;
      }
      throw new ApiError(
        422,
        "unsupported_operator_credit_note_action",
        "Credit note documents, email, and provider refunds are not admitted to the operator workflow",
      );
    }

    if (/^\/api\/operator\/v1\/customers(?:\/|$)/.test(url.pathname)) {
      const operator = await authenticateOperatorAccess(request, env, keySet);
      if (request.method !== "GET") {
        assertOperatorAdmin(operator);
        assertOperatorMutationRequest(request);
        await assertOperatorCustomerMutationPayload(request);
      }
      const auth: AuthContext = {
        organizationId: operator.organizationId,
        organizationExternalId: operator.organizationExternalId,
        apiKeyId: `operator:${operator.membershipId}`,
      };
      const forwardedUrl = new URL(request.url);
      forwardedUrl.pathname = forwardedUrl.pathname.replace(
        "/api/operator/v1/customers",
        "/api/v1/customers",
      );
      const response = await handleCustomerCompatibilityRequest(
        new Request(forwardedUrl, request),
        env,
        auth,
        requestId,
      );
      if (response) return response;
    }

    throw new ApiError(404, "not_found", "The requested operator route was not found");
  } catch (error) {
    if (error instanceof ApiError) return apiErrorResponse(error, requestId);
    console.error(
      JSON.stringify({ level: "error", event: "unhandled_operator_request_error", requestId }),
    );
    return apiErrorResponse(
      new ApiError(500, "internal_error", "An unexpected error occurred"),
      requestId,
    );
  }
}

export default createOperatorHandler();

function safeRequestId(value: string | null): string {
  const candidate = value?.trim();
  return candidate && candidate.length <= 128 ? candidate : crypto.randomUUID();
}

async function assertOperatorCustomerMutationPayload(request: Request): Promise<void> {
  if (request.method !== "POST" && request.method !== "PUT") return;
  const input = objectAt(await parseJsonObject(request.clone()), "customer");
  const supported = new Set([
    "external_id",
    "name",
    "email",
    "currency",
    "net_payment_term",
    "invoice_grace_period",
    "timezone",
    "metadata",
    "skip_invoice_custom_sections",
    "invoice_custom_section_codes",
    "applied_dunning_campaign_id",
    "exclude_from_dunning_campaign",
  ]);
  const unsupported = Object.keys(input).find((key) => !supported.has(key));
  if (unsupported) {
    throw new ApiError(
      422,
      "unsupported_operator_customer_field",
      `${unsupported} is not admitted to the operator customer workflow`,
    );
  }
}

async function assertOperatorPlanMutationPayload(
  request: Request,
  pathname: string,
): Promise<void> {
  if (request.method !== "POST" && request.method !== "PUT") return;
  const fixedCharge = pathname.includes("/fixed-charges");
  const input = objectAt(
    await parseJsonObject(request.clone()),
    fixedCharge ? "fixed_charge" : "plan",
  );
  const supported = fixedCharge
    ? new Set([
        "add_on_id",
        "code",
        "invoice_display_name",
        "charge_model",
        "properties",
        "units",
        "pay_in_advance",
        "prorated",
        "apply_units_immediately",
        "cascade_updates",
      ])
    : new Set([
        "code",
        "name",
        "invoice_display_name",
        "description",
        "interval",
        "amount_cents",
        "amount_currency",
        "trial_period",
        "pay_in_advance",
      ]);
  const unsupported = Object.keys(input).find((key) => !supported.has(key));
  if (unsupported) {
    throw new ApiError(
      422,
      fixedCharge ? "unsupported_operator_fixed_charge_field" : "unsupported_operator_plan_field",
      `${unsupported} is not admitted to this operator workflow`,
    );
  }
}

async function assertOperatorSubscriptionMutationPayload(request: Request): Promise<void> {
  if (request.method !== "POST" && request.method !== "PUT") return;
  const input = objectAt(await parseJsonObject(request.clone()), "subscription");
  const supported =
    request.method === "POST"
      ? new Set([
          "external_customer_id",
          "external_id",
          "plan_code",
          "name",
          "subscription_at",
          "billing_time",
          "ending_at",
          "on_termination_credit_note",
          "on_termination_invoice",
        ])
      : new Set([
          "name",
          "subscription_at",
          "ending_at",
          "on_termination_credit_note",
          "on_termination_invoice",
        ]);
  const unsupported = Object.keys(input).find((key) => !supported.has(key));
  if (unsupported) {
    throw new ApiError(
      422,
      "unsupported_operator_subscription_field",
      `${unsupported} is not admitted to the operator subscription workflow`,
    );
  }
}

async function assertOperatorInvoiceMutationPayload(
  request: Request,
  pathname: string,
): Promise<void> {
  if (request.method !== "POST" || pathname !== "/api/operator/v1/invoices") return;
  const input = objectAt(await parseJsonObject(request.clone()), "invoice");
  const supported = new Set(["external_customer_id", "currency", "skip_psp", "fees"]);
  const unsupported = Object.keys(input).find((key) => !supported.has(key));
  if (unsupported) {
    throw new ApiError(
      422,
      "unsupported_operator_invoice_field",
      `${unsupported} is not admitted to the operator one-off invoice workflow`,
    );
  }
  if (!Array.isArray(input.fees)) return;
  const feeFields = new Set([
    "add_on_code",
    "invoice_display_name",
    "unit_amount_cents",
    "units",
    "description",
  ]);
  for (const fee of input.fees) {
    if (!fee || typeof fee !== "object" || Array.isArray(fee)) continue;
    const unsupportedFee = Object.keys(fee).find((key) => !feeFields.has(key));
    if (unsupportedFee) {
      throw new ApiError(
        422,
        "unsupported_operator_invoice_fee_field",
        `${unsupportedFee} is not admitted to the operator one-off invoice workflow`,
      );
    }
  }
}

async function assertOperatorWalletMutationPayload(
  request: Request,
  pathname: string,
): Promise<void> {
  if (request.method === "DELETE") return;
  if (request.method !== "POST") {
    throw new ApiError(
      422,
      "unsupported_operator_wallet_mutation",
      "Wallet updates are not admitted to the operator wallet workflow",
    );
  }
  const transaction = pathname.startsWith("/api/operator/v1/wallet-transactions");
  const input = objectAt(
    await parseJsonObject(request.clone()),
    transaction ? "wallet_transaction" : "wallet",
  );
  const supported = transaction
    ? new Set(["wallet_id", "granted_credits", "name", "priority"])
    : new Set([
        "external_customer_id",
        "name",
        "code",
        "currency",
        "rate_amount",
        "granted_credits",
        "priority",
        "expiration_at",
        "transaction_name",
        "recurring_transaction_rules",
      ]);
  const unsupported = Object.keys(input).find((key) => !supported.has(key));
  if (unsupported) {
    throw new ApiError(
      422,
      "unsupported_operator_wallet_field",
      `${unsupported} is not admitted to the operator wallet workflow`,
    );
  }
}

async function assertOperatorCreditNoteMutationPayload(
  request: Request,
  pathname: string,
): Promise<void> {
  if (request.method === "PUT" && pathname.endsWith("/void")) return;
  if (request.method !== "POST" || pathname !== "/api/operator/v1/credit-notes") {
    throw new ApiError(
      422,
      "unsupported_operator_credit_note_action",
      "Only credit note creation and voiding are admitted to the operator workflow",
    );
  }
  const input = objectAt(await parseJsonObject(request.clone()), "credit_note");
  const supported = new Set([
    "invoice_id",
    "reason",
    "description",
    "credit_amount_cents",
    "refund_amount_cents",
    "offset_amount_cents",
    "items",
  ]);
  const unsupported = Object.keys(input).find((key) => !supported.has(key));
  if (unsupported) {
    throw new ApiError(
      422,
      "unsupported_operator_credit_note_field",
      `${unsupported} is not admitted to the operator credit note workflow`,
    );
  }
  if (!Array.isArray(input.items)) return;
  for (const item of input.items) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const unsupportedItem = Object.keys(item).find(
      (key) => key !== "fee_id" && key !== "amount_cents",
    );
    if (unsupportedItem) {
      throw new ApiError(
        422,
        "unsupported_operator_credit_note_item_field",
        `${unsupportedItem} is not admitted to the operator credit note workflow`,
      );
    }
  }
}

async function assertOperatorQuoteMutationPayload(
  request: Request,
  pathname: string,
): Promise<void> {
  const action = pathname.match(/\/(approve|void|clone)$/)?.[1];
  if (request.method === "POST" && action) return;
  const creating = request.method === "POST" && pathname === "/api/operator/v1/quotes";
  const updatingQuote = request.method === "PUT" && pathname.startsWith("/api/operator/v1/quotes/");
  const updatingVersion =
    request.method === "PUT" && pathname.startsWith("/api/operator/v1/quote-versions/");
  if (!creating && !updatingQuote && !updatingVersion) {
    throw new ApiError(
      422,
      "unsupported_operator_quote_action",
      "This quote action is not admitted to the operator workflow",
    );
  }
  const wrapper = updatingVersion ? "quote_version" : "quote";
  const input = objectAt(await parseJsonObject(request.clone()), wrapper);
  const supported = creating
    ? new Set([
        "customer_id",
        "order_type",
        "subscription_id",
        "owner_ids",
        "billing_items",
        "content",
      ])
    : updatingQuote
      ? new Set(["version", "owner_ids"])
      : new Set(["lock_version", "billing_items", "content"]);
  const unsupported = Object.keys(input).find((key) => !supported.has(key));
  if (unsupported) {
    throw new ApiError(
      422,
      "unsupported_operator_quote_field",
      `${unsupported} is not admitted to the operator quote workflow`,
    );
  }
}

async function assertOperatorDataExportMutationPayload(
  request: Request,
  pathname: string,
): Promise<void> {
  if (request.method !== "POST" || pathname !== "/api/operator/v1/data-exports") {
    throw new ApiError(
      422,
      "unsupported_operator_data_export_action",
      "Only data-export creation is admitted to the operator workflow",
    );
  }
  const input = objectAt(await parseJsonObject(request.clone()), "data_export");
  const supported = new Set(["format", "resource_type", "filters"]);
  const unsupported = Object.keys(input).find((key) => !supported.has(key));
  if (unsupported) {
    throw new ApiError(
      422,
      "unsupported_operator_data_export_field",
      `${unsupported} is not admitted to the operator data-export workflow`,
    );
  }
}
