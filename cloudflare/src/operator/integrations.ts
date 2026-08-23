import { ApiError, json, parseJsonObject } from "../http";
import type { ProviderRuntimeStatus } from "../provider-financial-service";

const PROVIDERS = [
  ["stripe", "Stripe", "payments"],
  ["adyen", "Adyen", "payments"],
  ["authorize_net", "Authorize.Net", "payments"],
  ["easy_pay_direct", "Easy Pay Direct", "payments"],
  ["cashfree", "Cashfree", "payments"],
  ["flutterwave", "Flutterwave", "payments"],
  ["gocardless", "GoCardless", "payments"],
  ["moneyhash", "MoneyHash", "payments"],
  ["anrok", "Anrok", "tax"],
  ["avalara", "Avalara", "tax"],
  ["lago_tax_management", "Lago tax management", "tax"],
  ["netsuite", "NetSuite", "accounting"],
  ["xero", "Xero", "accounting"],
  ["hubspot", "HubSpot", "crm"],
  ["salesforce", "Salesforce", "crm"],
] as const;

type Row = {
  id: string;
  provider_code: string;
  integration_group: string;
  display_name: string | null;
  status: string;
  settings_json: string;
  version: number;
  created_at: string;
  updated_at: string;
};

export async function handleOperatorIntegrationsRequest(
  request: Request,
  database: D1Database,
  organizationId: string,
  requestId: string,
  runtimeStatuses: ProviderRuntimeStatus[] = [],
): Promise<Response | null> {
  const match = new URL(request.url).pathname.match(
    /^\/api\/operator\/v1\/integrations(?:\/([^/]+))?$/,
  );
  if (!match) return null;
  const code = match[1] ? decodeURIComponent(match[1]) : null;
  if (request.method === "GET") {
    const integrations = await list(database, organizationId, runtimeStatuses);
    if (!code) return json({ integrations }, { requestId });
    const integration = integrations.find((item) => item.provider_code === code);
    if (!integration) throw new ApiError(404, "integration_not_found", "Integration was not found");
    return json({ integration }, { requestId });
  }
  const provider = PROVIDERS.find(([providerCode]) => providerCode === code);
  if (!provider || !code)
    throw new ApiError(404, "integration_not_found", "Integration was not found");
  const now = new Date().toISOString();
  if (request.method === "DELETE") {
    await database
      .prepare(
        "UPDATE operator_integration_connections SET deleted_at = ?, status = 'disabled', updated_at = ?, version = version + 1 WHERE organization_id = ? AND provider_code = ? AND deleted_at IS NULL",
      )
      .bind(now, now, organizationId, code)
      .run();
    return new Response(null, { status: 204 });
  }
  if (request.method !== "PUT") return null;
  const body = await parseJsonObject(request);
  const settings =
    body.settings && typeof body.settings === "object" && !Array.isArray(body.settings)
      ? (body.settings as Record<string, unknown>)
      : {};
  if (
    JSON.stringify(settings).length > 10_000 ||
    Object.keys(settings).some((key) => /secret|token|password|api.?key|credential/i.test(key))
  ) {
    throw new ApiError(
      422,
      "secret_not_admitted",
      "Credentials must use an approved Cloudflare secret binding",
    );
  }
  const displayName = typeof body.display_name === "string" ? body.display_name.trim() : null;
  await database
    .prepare(`INSERT INTO operator_integration_connections
    (id, organization_id, provider_code, integration_group, display_name, status, settings_json, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, 'configuration_required', ?, ?, ?)
    ON CONFLICT (organization_id, provider_code) DO UPDATE SET display_name = excluded.display_name,
    status = 'configuration_required', settings_json = excluded.settings_json, deleted_at = NULL,
    updated_at = excluded.updated_at, version = operator_integration_connections.version + 1`)
    .bind(
      crypto.randomUUID(),
      organizationId,
      code,
      provider[2],
      displayName,
      JSON.stringify(settings),
      now,
      now,
    )
    .run();
  return json(
    {
      integration: (await list(database, organizationId, runtimeStatuses)).find(
        (item) => item.provider_code === code,
      ),
    },
    { requestId },
  );
}

async function list(
  database: D1Database,
  organizationId: string,
  runtimeStatuses: ProviderRuntimeStatus[],
) {
  const result = await database
    .prepare(`SELECT id, provider_code, integration_group, display_name, status,
    settings_json, version, created_at, updated_at FROM operator_integration_connections
    WHERE organization_id = ? AND deleted_at IS NULL`)
    .bind(organizationId)
    .all<Row>();
  const rows = new Map(result.results.map((row) => [row.provider_code, row]));
  const runtime = new Map(runtimeStatuses.map((status) => [status.providerCode, status]));
  return PROVIDERS.map(([code, name, group]) => {
    const row = rows.get(code);
    const providerRuntime = runtime.get(code as ProviderRuntimeStatus["providerCode"]);
    return {
      lago_id: row?.id ?? null,
      provider_code: code,
      name,
      integration_group: group,
      display_name: row?.display_name ?? null,
      status: providerRuntime?.connectionState ?? row?.status ?? "disabled",
      settings: row ? safeSettings(row.settings_json) : {},
      secret_ready: providerRuntime?.secretReady ?? false,
      external_actions_enabled: providerRuntime?.externalActionsEnabled ?? false,
      environment: providerRuntime?.environment ?? null,
      status_message:
        providerRuntime?.message ??
        (row ? "Configuration saved; credentials are not connected" : "Not configured"),
      version: row?.version ?? 0,
      created_at: row?.created_at ?? null,
      updated_at: row?.updated_at ?? null,
    };
  });
}

function safeSettings(raw: string): Record<string, unknown> {
  try {
    const value = JSON.parse(raw) as unknown;
    return value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}
