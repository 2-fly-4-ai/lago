import type { JWTVerifyGetKey } from "jose";

import { handleAddOnLedgerRequest } from "../api/add-on-ledger";
import { handleApiKeysApi } from "../api/api-keys";
import { handleBillingEntitiesApi } from "../api/billing-entities";
import { handleCouponLedgerRequest } from "../api/coupon-ledger";
import { handleInvoiceCustomSectionRequest } from "../api/invoice-custom-sections";
import { createSubscription, handleCustomerCompatibilityRequest } from "../api/lago-compatibility";
import { showOrganization } from "../api/organizations";
import { handlePaymentReceiptReadsApi } from "../api/payment-receipts";
import { handlePlanCatalogRequest } from "../api/plan-catalog";
import { handleTaxLedgerRequest } from "../api/tax-ledger";
import { handleSubscriptionLifecycleRequest } from "../api/subscription-lifecycle";
import type { AuthContext } from "../auth/api-key";
import { ApiError, apiErrorResponse, json, objectAt, parseJsonObject } from "../http";
import {
  assertOperatorAdmin,
  assertOperatorMutationRequest,
  authenticateOperatorAccess,
  type OperatorEnv,
} from "./access";

export function createOperatorHandler(keySet?: JWTVerifyGetKey): ExportedHandler<OperatorEnv> {
  return {
    async fetch(request: Request, env: OperatorEnv): Promise<Response> {
      return handleOperatorRequest(request, env, keySet);
    },
  };
}

export async function handleOperatorRequest(
  request: Request,
  env: OperatorEnv,
  keySet?: JWTVerifyGetKey,
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
            role: operator.role,
          },
        },
        { requestId },
      );
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
