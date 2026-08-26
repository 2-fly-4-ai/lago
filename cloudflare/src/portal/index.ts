import { sha256Hex } from "../auth/api-key";
import { ApiError, apiErrorResponse, json, parseJsonObject } from "../http";

type PortalContext = {
  tokenId: string;
  organizationId: string;
  customerId: string;
};

export default {
  async fetch(request: Request, env: PortalBindings, ctx: ExecutionContext): Promise<Response> {
    const requestId = crypto.randomUUID();
    const url = new URL(request.url);
    try {
      if (request.method === "GET" && url.pathname === "/health") {
        return json({ status: "ok", service: "serp-lago-customer-portal" }, { requestId });
      }
      if (!url.pathname.startsWith("/api/portal/v1/")) {
        throw new ApiError(404, "not_found", "The requested portal route was not found");
      }
      const portal = await authenticatePortal(request, env.BILLING_DB);
      ctx.waitUntil(markUsed(env.BILLING_DB, portal.tokenId));
      const response = await handlePortalRequest(request, env, portal, requestId);
      if (response) return withPortalHeaders(response);
      throw new ApiError(404, "not_found", "The requested portal route was not found");
    } catch (error) {
      const response =
        error instanceof ApiError
          ? apiErrorResponse(error, requestId)
          : apiErrorResponse(
              new ApiError(500, "internal_error", "An unexpected error occurred"),
              requestId,
            );
      return withPortalHeaders(response);
    }
  },
} satisfies ExportedHandler<PortalBindings>;

async function handlePortalRequest(
  request: Request,
  env: PortalBindings,
  portal: PortalContext,
  requestId: string,
): Promise<Response | null> {
  const url = new URL(request.url);
  if (url.pathname === "/api/portal/v1/session") {
    if (request.method === "GET") return portalSession(env.BILLING_DB, portal, requestId);
    if (request.method === "PATCH") {
      assertPortalMutation(request);
      return updateCustomer(request, env.BILLING_DB, portal, requestId);
    }
  }
  if (url.pathname === "/api/portal/v1/invoices" && request.method === "GET") {
    return portalInvoices(env.BILLING_DB, portal, requestId);
  }
  const invoiceMatch = url.pathname.match(
    /^\/api\/portal\/v1\/invoices\/([^/]+)(?:\/(download))?$/,
  );
  if (invoiceMatch?.[1] && request.method === "GET") {
    return portalInvoice(
      env,
      portal,
      decodeURIComponent(invoiceMatch[1]),
      Boolean(invoiceMatch[2]),
      requestId,
    );
  }
  if (url.pathname === "/api/portal/v1/wallets" && request.method === "GET") {
    return portalWallets(env.BILLING_DB, portal, requestId);
  }
  const walletTopUp = url.pathname.match(/^\/api\/portal\/v1\/wallets\/([^/]+)\/top-up$/);
  if (walletTopUp && request.method === "POST") {
    assertPortalMutation(request);
    throw new ApiError(
      422,
      "external_action_disabled",
      "Wallet top-up remains disabled in this development portal",
    );
  }
  if (url.pathname === "/api/portal/v1/usage" && request.method === "GET") {
    return portalUsage(env.BILLING_DB, portal, requestId);
  }
  if (url.pathname === "/api/portal/v1/subscriptions" && request.method === "GET") {
    return portalSubscriptions(env.BILLING_DB, portal, requestId);
  }
  if (url.pathname === "/api/portal/v1/overdue-balances" && request.method === "GET") {
    return portalOverdue(env.BILLING_DB, portal, requestId);
  }
  return null;
}

async function authenticatePortal(request: Request, database: D1Database): Promise<PortalContext> {
  const token = request.headers.get("X-Customer-Portal-Token")?.trim();
  if (!token || !/^[a-f0-9]{64}$/.test(token)) {
    throw new ApiError(401, "portal_unauthorized", "A valid customer portal token is required");
  }
  const row = await database
    .prepare(
      `SELECT id AS token_id, organization_id, customer_id FROM customer_portal_tokens
       WHERE token_sha256 = ? AND active = 1 AND revoked_at IS NULL
         AND (expires_at IS NULL OR expires_at > ?) LIMIT 1`,
    )
    .bind(await sha256Hex(token), new Date().toISOString())
    .first<{ token_id: string; organization_id: string; customer_id: string }>();
  if (!row)
    throw new ApiError(401, "portal_unauthorized", "A valid customer portal token is required");
  return {
    tokenId: row.token_id,
    organizationId: row.organization_id,
    customerId: row.customer_id,
  };
}

async function portalSession(database: D1Database, portal: PortalContext, requestId: string) {
  const customer = await database
    .prepare(`SELECT c.external_id, c.name, c.email, c.currency, c.timezone,
    c.net_payment_term, o.name AS organization_name FROM customers c JOIN organizations o ON o.id = c.organization_id
    WHERE c.id = ? AND c.organization_id = ?`)
    .bind(portal.customerId, portal.organizationId)
    .first();
  if (!customer) throw new ApiError(404, "customer_not_found", "Customer was not found");
  return json({ customer }, { requestId });
}

async function updateCustomer(
  request: Request,
  database: D1Database,
  portal: PortalContext,
  requestId: string,
) {
  const body = await parseJsonObject(request);
  const customer =
    body.customer && typeof body.customer === "object" && !Array.isArray(body.customer)
      ? (body.customer as Record<string, unknown>)
      : {};
  const unsupported = Object.keys(customer).find(
    (key) => !new Set(["name", "email", "timezone"]).has(key),
  );
  if (unsupported)
    throw new ApiError(
      422,
      "unsupported_customer_field",
      `${unsupported} cannot be changed in the portal`,
    );
  const current = await database
    .prepare("SELECT name, email, timezone FROM customers WHERE id = ? AND organization_id = ?")
    .bind(portal.customerId, portal.organizationId)
    .first<{ name: string | null; email: string | null; timezone: string | null }>();
  if (!current) throw new ApiError(404, "customer_not_found", "Customer was not found");
  const value = (key: "name" | "email" | "timezone") =>
    typeof customer[key] === "string" ? String(customer[key]).trim() || null : current[key];
  await database
    .prepare(
      "UPDATE customers SET name = ?, email = ?, timezone = ?, updated_at = ? WHERE id = ? AND organization_id = ?",
    )
    .bind(
      value("name"),
      value("email"),
      value("timezone"),
      new Date().toISOString(),
      portal.customerId,
      portal.organizationId,
    )
    .run();
  return portalSession(database, portal, requestId);
}

async function portalInvoices(database: D1Database, portal: PortalContext, requestId: string) {
  const result = await database
    .prepare(`SELECT i.id AS lago_id, i.number, i.status, i.payment_status, i.currency,
    i.total_due_minor AS total_amount_cents, i.issuing_date, i.created_at, artifact.status AS pdf_status
    FROM invoices i LEFT JOIN document_artifacts artifact ON artifact.resource_type = 'invoice'
      AND artifact.resource_id = i.id AND artifact.resource_version = i.version AND artifact.artifact_type = 'pdf'
    WHERE i.organization_id = ? AND i.customer_id = ? ORDER BY i.created_at DESC LIMIT 100`)
    .bind(portal.organizationId, portal.customerId)
    .all();
  return json({ invoices: result.results }, { requestId });
}

async function portalInvoice(
  env: PortalBindings,
  portal: PortalContext,
  invoiceId: string,
  download: boolean,
  requestId: string,
) {
  const invoice =
    await env.BILLING_DB.prepare(`SELECT i.id AS lago_id, i.number, i.status, i.payment_status, i.currency,
    i.total_due_minor AS total_amount_cents, i.issuing_date, i.created_at, artifact.status AS pdf_status, artifact.object_key
    FROM invoices i LEFT JOIN document_artifacts artifact ON artifact.resource_type = 'invoice'
      AND artifact.resource_id = i.id AND artifact.resource_version = i.version AND artifact.artifact_type = 'pdf'
    WHERE i.id = ? AND i.organization_id = ? AND i.customer_id = ?`)
      .bind(invoiceId, portal.organizationId, portal.customerId)
      .first<Record<string, unknown>>();
  if (!invoice) throw new ApiError(404, "invoice_not_found", "Invoice was not found");
  if (!download) {
    delete invoice.object_key;
    return json({ invoice }, { requestId });
  }
  if (invoice.pdf_status !== "ready" || typeof invoice.object_key !== "string")
    throw new ApiError(409, "invoice_pdf_not_ready", "Invoice PDF is not ready");
  const object = await env.BILLING_ARTIFACTS.get(invoice.object_key);
  if (!object) throw new ApiError(404, "invoice_pdf_not_found", "Invoice PDF was not found");
  const filename = `${
    String(invoice.number ?? "invoice")
      .replace(/[^a-zA-Z0-9._-]+/g, "-")
      .replace(/^-+|-+$/g, "") || "invoice"
  }.pdf`;
  return new Response(object.body, {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `attachment; filename="${filename}"`,
    },
  });
}

async function portalWallets(database: D1Database, portal: PortalContext, requestId: string) {
  const result = await database
    .prepare(`SELECT id AS lago_id, name, code, status, currency,
    balance_minor AS balance_cents, expiration_at FROM wallets WHERE organization_id = ? AND customer_id = ?
    ORDER BY created_at DESC`)
    .bind(portal.organizationId, portal.customerId)
    .all();
  return json({ wallets: result.results }, { requestId });
}

async function portalUsage(database: D1Database, portal: PortalContext, requestId: string) {
  const result = await database
    .prepare(`SELECT code, COUNT(*) AS events_count, MIN(timestamp) AS first_event_at,
    MAX(timestamp) AS last_event_at FROM usage_events WHERE organization_id = ? AND customer_id = ? AND deleted_at IS NULL
    GROUP BY code ORDER BY code`)
    .bind(portal.organizationId, portal.customerId)
    .all();
  return json({ usage: result.results }, { requestId });
}

async function portalSubscriptions(database: D1Database, portal: PortalContext, requestId: string) {
  const result = await database
    .prepare(`SELECT s.id AS lago_id, s.external_id, s.status, s.started_at,
    s.current_period_start, s.current_period_end, p.code AS plan_code, p.name AS plan_name
    FROM subscriptions s JOIN plans p ON p.id = s.plan_id WHERE s.organization_id = ? AND s.customer_id = ?
    ORDER BY s.created_at DESC`)
    .bind(portal.organizationId, portal.customerId)
    .all();
  return json({ subscriptions: result.results }, { requestId });
}

async function portalOverdue(database: D1Database, portal: PortalContext, requestId: string) {
  const row = await database
    .prepare(`SELECT currency, COALESCE(SUM(total_due_minor), 0) AS amount_cents,
    COUNT(*) AS invoices_count FROM invoices WHERE organization_id = ? AND customer_id = ?
    AND payment_status = 'pending' AND status = 'finalized' GROUP BY currency LIMIT 1`)
    .bind(portal.organizationId, portal.customerId)
    .first();
  return json({ overdue_balance: row ?? { amount_cents: 0, invoices_count: 0 } }, { requestId });
}

function assertPortalMutation(request: Request) {
  const url = new URL(request.url);
  if (
    request.headers.get("Origin") !== url.origin ||
    request.headers.get("X-Portal-Request") !== "1"
  ) {
    throw new ApiError(
      403,
      "invalid_portal_origin",
      "Portal changes require a same-origin request",
    );
  }
}

async function markUsed(database: D1Database, tokenId: string) {
  await database
    .prepare(
      "UPDATE customer_portal_tokens SET last_used_at = ?, updated_at = ? WHERE id = ? AND active = 1",
    )
    .bind(new Date().toISOString(), new Date().toISOString(), tokenId)
    .run();
}

function withPortalHeaders(response: Response) {
  const headers = new Headers(response.headers);
  headers.set("Cache-Control", "no-store");
  headers.set("Referrer-Policy", "no-referrer");
  headers.set("X-Content-Type-Options", "nosniff");
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
