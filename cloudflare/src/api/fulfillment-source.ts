import type { AuthContext } from "../auth/api-key";
import { materializeFulfillmentSourceSnapshot } from "../billing/fulfillment-source-snapshot";
import { ApiError, json, parseJsonObject } from "../http";

// Authenticated, tenant-scoped local ledger materialization only. No provider
// request, entitlement delivery, or scheduled polling is performed by this route.
export async function handleFulfillmentSourceRequest(
  request: Request,
  env: Env,
  auth: AuthContext,
  requestId: string,
): Promise<Response | null> {
  const match = new URL(request.url).pathname.match(
    /^\/api\/v1\/subscriptions\/([^/]+)\/fulfillment-source$/,
  );
  if (!match || request.method !== "POST") return null;
  const externalSubscriptionId = decodeURIComponent(match[1]!);
  const body = await parseJsonObject(request);
  const { externalCustomerId, invoiceId } = body;
  if (
    typeof externalCustomerId !== "string" ||
    !externalCustomerId.trim() ||
    typeof invoiceId !== "string" ||
    !invoiceId.trim() ||
    Object.keys(body).some((key) => !["externalCustomerId", "invoiceId"].includes(key))
  ) {
    throw new ApiError(
      400,
      "invalid_request",
      "Invoice and external customer identifiers are required",
    );
  }
  const config = env as unknown as {
    EASY_PAY_DIRECT_NETWORK_MODE?: string;
    EASY_PAY_DIRECT_ACCOUNT_CODE?: string;
    EASY_PAY_DIRECT_ORGANIZATION_ID?: string;
  };
  const providerCode = config.EASY_PAY_DIRECT_ACCOUNT_CODE?.trim();
  const network = config.EASY_PAY_DIRECT_NETWORK_MODE;
  const mode =
    network === "production"
      ? "live"
      : ["test", "gateway_test"].includes(network ?? "")
        ? "test"
        : null;
  if (!providerCode || !mode || config.EASY_PAY_DIRECT_ORGANIZATION_ID !== auth.organizationId) {
    throw new ApiError(503, "fulfillment_scope_unavailable", "Fulfillment scope is unavailable");
  }
  const rows = await env.BILLING_DB.prepare(`SELECT s.id FROM invoices i
    JOIN subscriptions s ON s.id = i.subscription_id AND s.organization_id = i.organization_id AND s.customer_id = i.customer_id
    JOIN customers c ON c.id = s.customer_id AND c.organization_id = s.organization_id
    WHERE i.organization_id = ? AND i.id = ? AND s.external_id = ? AND c.external_id = ?
    UNION SELECT h.subscription_id AS id FROM fulfillment_source_snapshot_heads h
    WHERE h.organization_id = ? AND json_extract(h.payload_json, '$.originInvoiceId') = ?
      AND json_extract(h.payload_json, '$.externalSubscriptionId') = ?
      AND json_extract(h.payload_json, '$.externalCustomerId') = ?`)
    .bind(
      auth.organizationId,
      invoiceId,
      externalSubscriptionId,
      externalCustomerId,
      auth.organizationId,
      invoiceId,
      externalSubscriptionId,
      externalCustomerId,
    )
    .all<{ id: string }>();
  if (rows.results.length !== 1)
    throw new ApiError(404, "subscription_not_found", "Subscription was not found");
  const fulfillmentSource = await materializeFulfillmentSourceSnapshot(
    env.BILLING_DB,
    auth.organizationId,
    rows.results[0]!.id,
    { providerCode, mode, pin: { invoiceId, externalCustomerId, externalSubscriptionId } },
  );
  return json({ fulfillmentSource }, { requestId });
}
