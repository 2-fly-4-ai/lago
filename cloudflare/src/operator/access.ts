import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from "jose";

import { sha256Hex } from "../auth/api-key";
import { ApiError } from "../http";

export type OperatorRole = "viewer" | "admin";

export type OperatorEnv = {
  APP_ENV: string;
  BILLING_ACCOUNTS: DurableObjectNamespace<import("../index").BillingAccount>;
  BILLING_DB: D1Database;
  DOMAIN_EVENTS: Queue;
  OPERATOR_ACCESS_ENABLED: string;
  ACCESS_TEAM_DOMAIN?: string;
  ACCESS_AUD?: string;
};

export type OperatorContext = {
  membershipId: string;
  organizationId: string;
  organizationExternalId: string;
  role: OperatorRole;
};

const remoteKeySets = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

export async function authenticateOperatorAccess(
  request: Request,
  env: OperatorEnv,
  keySet?: JWTVerifyGetKey,
): Promise<OperatorContext> {
  if (env.OPERATOR_ACCESS_ENABLED !== "1") {
    throw new ApiError(503, "operator_access_disabled", "Operator access is disabled");
  }

  const issuer = accessIssuer(env.ACCESS_TEAM_DOMAIN);
  const audience = env.ACCESS_AUD?.trim();
  if (!audience) {
    throw new ApiError(
      503,
      "operator_access_misconfigured",
      "Operator access configuration is incomplete",
    );
  }

  const token = request.headers.get("Cf-Access-Jwt-Assertion")?.trim();
  if (!token || token.length > 16_384) {
    throw new ApiError(401, "operator_unauthorized", "A valid Access session is required");
  }

  let subject: string;
  try {
    const verified = await jwtVerify(token, keySet ?? remoteKeySet(issuer), {
      algorithms: ["RS256"],
      audience,
      issuer,
      clockTolerance: 5,
    });
    if (typeof verified.payload.sub !== "string" || !verified.payload.sub.trim()) {
      throw new Error("missing_subject");
    }
    subject = verified.payload.sub;
  } catch {
    throw new ApiError(401, "operator_unauthorized", "A valid Access session is required");
  }

  const subjectHash = await sha256Hex(`${issuer}\n${subject}`);
  const membership = await env.BILLING_DB.prepare(
    `SELECT membership.id AS membership_id,
            membership.organization_id,
            membership.role,
            organization.external_id AS organization_external_id
     FROM operator_memberships membership
     JOIN organizations organization ON organization.id = membership.organization_id
     WHERE membership.access_issuer = ?
       AND membership.access_subject_sha256 = ?
       AND membership.active = 1
       AND membership.revoked_at IS NULL
     LIMIT 1`,
  )
    .bind(issuer, subjectHash)
    .first<{
      membership_id: string;
      organization_id: string;
      organization_external_id: string;
      role: OperatorRole;
    }>();

  if (!membership) {
    throw new ApiError(
      403,
      "operator_membership_required",
      "This Access identity has no active operator membership",
    );
  }

  return {
    membershipId: membership.membership_id,
    organizationId: membership.organization_id,
    organizationExternalId: membership.organization_external_id,
    role: membership.role,
  };
}

export function assertOperatorMutationRequest(request: Request): void {
  if (request.method === "GET" || request.method === "HEAD") return;

  const requestUrl = new URL(request.url);
  if (request.headers.get("Origin") !== requestUrl.origin) {
    throw new ApiError(403, "invalid_operator_origin", "Operator mutations require same-origin");
  }
  const fetchSite = request.headers.get("Sec-Fetch-Site");
  if (fetchSite && fetchSite !== "same-origin") {
    throw new ApiError(403, "invalid_operator_origin", "Operator mutations require same-origin");
  }
  if (request.headers.get("X-Operator-Request") !== "1") {
    throw new ApiError(
      403,
      "operator_csrf_required",
      "Operator mutations require the CSRF request header",
    );
  }
  if (["POST", "PUT", "PATCH"].includes(request.method)) {
    const contentType = request.headers.get("Content-Type")?.toLowerCase() ?? "";
    if (!contentType.includes("application/json")) {
      throw new ApiError(415, "unsupported_media_type", "Content-Type must be application/json");
    }
  }
}

export function assertOperatorAdmin(operator: OperatorContext): void {
  if (operator.role !== "admin") {
    throw new ApiError(403, "operator_admin_required", "This operator action requires admin role");
  }
}

function accessIssuer(value: string | undefined): string {
  const candidate = value?.trim().replace(/\/$/, "");
  if (!candidate) {
    throw new ApiError(
      503,
      "operator_access_misconfigured",
      "Operator access configuration is incomplete",
    );
  }

  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    throw new ApiError(
      503,
      "operator_access_misconfigured",
      "Operator access configuration is incomplete",
    );
  }
  if (
    url.protocol !== "https:" ||
    !url.hostname.endsWith(".cloudflareaccess.com") ||
    url.hostname === "cloudflareaccess.com" ||
    url.port ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  ) {
    throw new ApiError(
      503,
      "operator_access_misconfigured",
      "Operator access configuration is incomplete",
    );
  }
  return url.origin;
}

function remoteKeySet(issuer: string): ReturnType<typeof createRemoteJWKSet> {
  let keySet = remoteKeySets.get(issuer);
  if (!keySet) {
    keySet = createRemoteJWKSet(new URL("/cdn-cgi/access/certs", issuer), {
      cacheMaxAge: 5 * 60 * 1_000,
      cooldownDuration: 30_000,
      timeoutDuration: 5_000,
    });
    remoteKeySets.set(issuer, keySet);
  }
  return keySet;
}
