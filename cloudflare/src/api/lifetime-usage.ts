import type { AuthContext } from "../auth/api-key";
import { ApiError, json, objectAt, parseJsonObject } from "../http";
import {
  findLifetimeUsage,
  lifetimeUsageFromDatetime,
  refreshLifetimeUsage,
  type LifetimeUsageRow,
} from "../usage/lifetime-usage";

export async function handleLifetimeUsageRequest(
  request: Request,
  env: Env,
  auth: AuthContext,
  requestId: string,
): Promise<Response | null> {
  const url = new URL(request.url);
  const match = url.pathname.match(/^\/api\/v1\/subscriptions\/([^/]+)\/lifetime_usage$/);
  if (!match?.[1] || !["GET", "PUT"].includes(request.method)) return null;
  const externalSubscriptionId = decodeURIComponent(match[1]);
  let lifetimeUsage = await refreshLifetimeUsage(
    env.BILLING_DB,
    auth.organizationId,
    externalSubscriptionId,
  );
  if (!lifetimeUsage) {
    throw new ApiError(404, "lifetime_usage_not_found", "Lifetime usage was not found");
  }

  if (request.method === "PUT") {
    const body = await parseJsonObject(request);
    const input = objectAt(body, "lifetime_usage");
    const amount = nonNegativeMinorAmount(input.external_historical_usage_amount_cents);
    const updatedAt = new Date().toISOString();
    await env.BILLING_DB.prepare(
      `UPDATE lifetime_usages
       SET historical_usage_amount_minor = ?, updated_at = ?
       WHERE id = ? AND organization_id = ?`,
    )
      .bind(amount, updatedAt, lifetimeUsage.id, auth.organizationId)
      .run();
    lifetimeUsage = await findLifetimeUsage(
      env.BILLING_DB,
      auth.organizationId,
      externalSubscriptionId,
    );
    if (!lifetimeUsage)
      throw new ApiError(500, "persistence_error", "Lifetime usage was not persisted");
  }

  return json(
    {
      lifetime_usage: await serializeLifetimeUsage(
        env.BILLING_DB,
        lifetimeUsage,
        new Date().toISOString(),
      ),
    },
    { requestId },
  );
}

async function serializeLifetimeUsage(
  database: D1Database,
  lifetimeUsage: LifetimeUsageRow,
  toDatetime: string,
): Promise<Record<string, unknown>> {
  return {
    lago_id: lifetimeUsage.id,
    lago_subscription_id: lifetimeUsage.subscription_id,
    external_subscription_id: lifetimeUsage.external_subscription_id,
    external_historical_usage_amount_cents: lifetimeUsage.historical_usage_amount_minor,
    invoiced_usage_amount_cents: lifetimeUsage.invoiced_usage_amount_minor,
    current_usage_amount_cents: lifetimeUsage.current_usage_amount_minor,
    from_datetime: await lifetimeUsageFromDatetime(
      database,
      lifetimeUsage.organization_id,
      lifetimeUsage.external_subscription_id,
    ),
    to_datetime: toDatetime,
  };
}

function nonNegativeMinorAmount(value: unknown): number {
  const amount = typeof value === "string" && /^\d+$/.test(value) ? Number(value) : value;
  if (!Number.isSafeInteger(amount) || Number(amount) < 0) {
    throw new ApiError(
      422,
      "validation_error",
      "external_historical_usage_amount_cents must be a non-negative integer",
    );
  }
  return Number(amount);
}
