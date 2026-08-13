import { ApiError } from "../http";

export type AuthContext = {
  organizationId: string;
  organizationExternalId: string;
  apiKeyId: string;
};

export async function authenticateApiKey(
  request: Request,
  database: D1Database,
): Promise<AuthContext> {
  const authorization = request.headers.get("Authorization") ?? "";
  const match = authorization.match(/^Bearer\s+(.+)$/i);
  const token = match?.[1]?.trim();
  if (!token) throw new ApiError(401, "unauthorized", "A bearer API key is required");

  const keyHash = await sha256Hex(token);
  const row = await database
    .prepare(
      `SELECT api_keys.id AS api_key_id,
              organizations.id AS organization_id,
              organizations.external_id AS organization_external_id
       FROM api_keys
       JOIN organizations ON organizations.id = api_keys.organization_id
       WHERE api_keys.key_hash = ? AND api_keys.revoked_at IS NULL
       LIMIT 1`,
    )
    .bind(keyHash)
    .first<{
      api_key_id: string;
      organization_id: string;
      organization_external_id: string;
    }>();

  if (!row) throw new ApiError(401, "unauthorized", "The API key is invalid or revoked");
  return {
    organizationId: row.organization_id,
    organizationExternalId: row.organization_external_id,
    apiKeyId: row.api_key_id,
  };
}

export async function sha256Hex(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
