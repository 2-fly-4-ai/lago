import { authenticateOperatorAccess, type OperatorEnv } from "./access";
import { ApiError, apiErrorResponse, json } from "../http";

export default {
  async fetch(request: Request, env: OperatorEnv): Promise<Response> {
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
        if (ready?.ready !== 1)
          throw new ApiError(503, "not_ready", "Operator service is not ready");
        return json({ status: "ready" }, { requestId });
      }

      if (request.method === "GET" && url.pathname === "/api/operator/v1/session") {
        const operator = await authenticateOperatorAccess(request, env);
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
  },
} satisfies ExportedHandler<OperatorEnv>;
