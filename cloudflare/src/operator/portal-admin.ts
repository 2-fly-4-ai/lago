import { sha256Hex } from "../auth/api-key";
import { ApiError, json } from "../http";
import type { OperatorContext } from "./access";

export async function handlePortalAdminRequest(
  request: Request,
  database: D1Database,
  operator: OperatorContext,
  requestId: string,
): Promise<Response | null> {
  const match = new URL(request.url).pathname.match(
    /^\/api\/operator\/v1\/customers\/([^/]+)\/portal-token$/,
  );
  if (!match?.[1]) return null;
  const customer = await database
    .prepare("SELECT id FROM customers WHERE organization_id = ? AND external_id = ?")
    .bind(operator.organizationId, decodeURIComponent(match[1]))
    .first<{ id: string }>();
  if (!customer) throw new ApiError(404, "customer_not_found", "Customer was not found");
  if (request.method === "POST") {
    const tokenBytes = crypto.getRandomValues(new Uint8Array(32));
    const token = Array.from(tokenBytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
    const now = new Date().toISOString();
    await database.batch([
      database
        .prepare(
          `UPDATE customer_portal_tokens SET active = 0, revoked_at = ?, updated_at = ?, version = version + 1
           WHERE organization_id = ? AND customer_id = ? AND active = 1`,
        )
        .bind(now, now, operator.organizationId, customer.id),
      database
        .prepare(
          `INSERT INTO customer_portal_tokens
           (id, organization_id, customer_id, token_sha256, active, created_by_membership_id,
            created_at, updated_at)
           VALUES (?, ?, ?, ?, 1, ?, ?, ?)`,
        )
        .bind(
          crypto.randomUUID(),
          operator.organizationId,
          customer.id,
          await sha256Hex(token),
          operator.membershipId,
          now,
          now,
        ),
    ]);
    return json({ portal_token: token, shown_once: true }, { status: 201, requestId });
  }
  if (request.method === "DELETE") {
    const now = new Date().toISOString();
    await database
      .prepare(
        `UPDATE customer_portal_tokens SET active = 0, revoked_at = ?, updated_at = ?, version = version + 1
         WHERE organization_id = ? AND customer_id = ? AND active = 1`,
      )
      .bind(now, now, operator.organizationId, customer.id)
      .run();
    return new Response(null, { status: 204 });
  }
  return null;
}
