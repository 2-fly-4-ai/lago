import type { AuthContext } from "../auth/api-key";
import { sha256Hex } from "../auth/api-key";
import { ApiError, json, objectAt, parseJsonObject, requiredString } from "../http";
import { deterministicUuid } from "../identifiers";
import { stableJson } from "../json";

type ExternalTaxEnv = Pick<Env, "BILLING_DB"> & {
  EXTERNAL_TAX_MODE?: string;
  EXTERNAL_TAX_ADAPTER?: Fetcher;
};

export async function handleExternalTaxApi(
  request: Request,
  env: ExternalTaxEnv,
  auth: AuthContext,
  requestId: string,
): Promise<Response | null> {
  if (new URL(request.url).pathname !== "/api/v1/external_tax/estimate") return null;
  if (request.method !== "POST")
    throw new ApiError(405, "method_not_allowed", "External tax estimates require POST");
  if (env.EXTERNAL_TAX_MODE !== "service_binding" || !env.EXTERNAL_TAX_ADAPTER)
    throw new ApiError(503, "external_tax_disabled", "External tax adapter is disabled");
  const input = objectAt(await parseJsonObject(request), "external_tax");
  const providerCode = requiredString(input, "provider_code");
  const currency = requiredString(input, "currency").toUpperCase();
  if (!/^[A-Z]{3}$/.test(currency))
    throw new ApiError(422, "validation_error", "currency must be an ISO code");
  const lines = taxLines(input.lines);
  const subtotalMinor = lines.reduce((total, line) => safeAdd(total, line.amount_minor), 0);
  const idempotencyKey = request.headers.get("Idempotency-Key")?.trim();
  if (!idempotencyKey)
    throw new ApiError(422, "idempotency_key_required", "Idempotency-Key is required");
  const canonical = {
    currency,
    lines,
    organization_id: auth.organizationId,
    provider_code: providerCode,
  };
  const requestHash = await sha256Hex(stableJson(canonical));
  const replay = await env.BILLING_DB.prepare(
    `SELECT id, request_sha256, status, tax_minor FROM external_tax_estimates
     WHERE organization_id = ? AND idempotency_key = ? LIMIT 1`,
  )
    .bind(auth.organizationId, idempotencyKey)
    .first<{ id: string; request_sha256: string; status: string; tax_minor: number | null }>();
  if (replay) {
    if (replay.request_sha256 !== requestHash)
      throw new ApiError(409, "idempotency_conflict", "External tax estimate input changed");
    if (replay.status === "succeeded")
      return json(
        {
          external_tax: {
            lago_id: replay.id,
            currency,
            subtotal_cents: subtotalMinor,
            tax_cents: replay.tax_minor,
            status: replay.status,
          },
        },
        { requestId },
      );
  }
  const id =
    replay?.id ??
    (await deterministicUuid("external-tax-estimate", `${auth.organizationId}:${idempotencyKey}`));
  const now = new Date().toISOString();
  if (!replay)
    await env.BILLING_DB.prepare(
      `INSERT INTO external_tax_estimates
       (id, organization_id, provider_code, idempotency_key, request_sha256, currency,
        subtotal_minor, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
    )
      .bind(
        id,
        auth.organizationId,
        providerCode,
        idempotencyKey,
        requestHash,
        currency,
        subtotalMinor,
        now,
        now,
      )
      .run();
  let response: Response;
  try {
    response = await env.EXTERNAL_TAX_ADAPTER.fetch("https://tax-adapter.internal/v1/estimate", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Adapter-Contract": "lago-tax-v1",
        "Idempotency-Key": `lago-tax:${id}`,
      },
      body: JSON.stringify(canonical),
    });
  } catch {
    await failEstimate(env.BILLING_DB, id, "adapter_unavailable", now);
    throw new ApiError(503, "external_tax_unavailable", "External tax adapter is unavailable");
  }
  const raw = await response.text();
  if (raw.length > 256 * 1024) {
    await failEstimate(env.BILLING_DB, id, "response_too_large", now);
    throw new ApiError(503, "external_tax_invalid_response", "Tax response is too large");
  }
  let payload: unknown;
  try {
    payload = JSON.parse(raw) as unknown;
  } catch {
    payload = null;
  }
  const taxMinor = response.ok ? responseTaxMinor(payload, currency) : null;
  if (taxMinor === null) {
    await failEstimate(env.BILLING_DB, id, "adapter_rejected", now);
    throw new ApiError(503, "external_tax_failed", "External tax adapter rejected the estimate");
  }
  await env.BILLING_DB.prepare(
    `UPDATE external_tax_estimates SET status = 'succeeded', tax_minor = ?, response_sha256 = ?,
     failure_code = NULL, updated_at = ? WHERE id = ?`,
  )
    .bind(taxMinor, await sha256Hex(raw), now, id)
    .run();
  return json(
    {
      external_tax: {
        lago_id: id,
        currency,
        subtotal_cents: subtotalMinor,
        tax_cents: taxMinor,
        status: "succeeded",
      },
    },
    { requestId },
  );
}

function taxLines(
  value: unknown,
): Array<{ id: string; amount_minor: number; tax_code: string | null }> {
  if (!Array.isArray(value) || value.length === 0 || value.length > 500)
    throw new ApiError(422, "validation_error", "lines must contain 1 to 500 entries");
  return value.map((entry, index) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry))
      throw new ApiError(422, "validation_error", `lines[${index}] is invalid`);
    const row = entry as Record<string, unknown>;
    const amount = row.amount_cents;
    if (!Number.isSafeInteger(amount) || Number(amount) < 0)
      throw new ApiError(422, "validation_error", `lines[${index}].amount_cents is invalid`);
    return {
      id: requiredString(row, "id"),
      amount_minor: Number(amount),
      tax_code: typeof row.tax_code === "string" ? row.tax_code : null,
    };
  });
}

function responseTaxMinor(value: unknown, currency: string): number | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  return row.currency === currency &&
    Number.isSafeInteger(row.tax_cents) &&
    Number(row.tax_cents) >= 0
    ? Number(row.tax_cents)
    : null;
}

async function failEstimate(database: D1Database, id: string, code: string, now: string) {
  await database
    .prepare(
      "UPDATE external_tax_estimates SET status = 'failed', failure_code = ?, updated_at = ? WHERE id = ?",
    )
    .bind(code, now, id)
    .run();
}

function safeAdd(left: number, right: number): number {
  const value = left + right;
  if (!Number.isSafeInteger(value))
    throw new ApiError(422, "invalid_minor_amount", "Tax subtotal is too large");
  return value;
}
