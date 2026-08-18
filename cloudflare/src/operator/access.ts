import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from "jose";

import { sha256Hex } from "../auth/api-key";
import { ApiError } from "../http";

export type OperatorRole = "viewer" | "admin";

export type OperatorEnv = {
  AI?: import("./ai").OperatorAiEnv["AI"];
  AI_MODEL?: string;
  APP_ENV: string;
  BILLING_ACCOUNTS: DurableObjectNamespace<import("../index").BillingAccount>;
  BILLING_DB: D1Database;
  DOMAIN_EVENTS: Queue;
  DOCUMENT_WORKFLOW: Env["DOCUMENT_WORKFLOW"];
  PLAN_DELETION_WORKFLOW: Env["PLAN_DELETION_WORKFLOW"];
  OPERATOR_ACCESS_ENABLED: string;
  TEST_MIGRATIONS?: Env["TEST_MIGRATIONS"];
  ACCESS_TEAM_DOMAIN?: string;
  ACCESS_AUD?: string;
};

export type OperatorContext = {
  accessIssuer: string;
  membershipId: string;
  organizationId: string;
  organizationExternalId: string;
  organizationName: string;
  organizationSlug: string;
  role: OperatorRole;
  memberships: OperatorMembership[];
};

export type OperatorMembership = {
  membershipId: string;
  organizationId: string;
  organizationExternalId: string;
  organizationName: string;
  organizationSlug: string;
  role: OperatorRole;
};

type OperatorMembershipRow = {
  membership_id: string;
  organization_id: string;
  organization_external_id: string;
  organization_name: string;
  organization_slug: string | null;
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
  let email: string | null = null;
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
    email = typeof verified.payload.email === "string" ? verified.payload.email : null;
  } catch {
    throw new ApiError(401, "operator_unauthorized", "A valid Access session is required");
  }

  const subjectHash = await sha256Hex(`${issuer}\n${subject}`);
  const membershipsResult = await env.BILLING_DB.prepare(
    `SELECT membership.id AS membership_id,
            membership.organization_id,
            membership.role,
            organization.external_id AS organization_external_id,
            organization.name AS organization_name,
            organization.slug AS organization_slug
     FROM operator_memberships membership
     JOIN organizations organization ON organization.id = membership.organization_id
     WHERE membership.access_issuer = ?
       AND membership.access_subject_sha256 = ?
       AND membership.active = 1
       AND membership.revoked_at IS NULL
     ORDER BY membership.created_at, membership.id`,
  )
    .bind(issuer, subjectHash)
    .all<OperatorMembershipRow>();

  if (membershipsResult.results.length === 0 && email) {
    const claimed = await claimPendingInvitations(env.BILLING_DB, issuer, subjectHash, email);
    if (claimed) return authenticateOperatorAccess(request, env, keySet);
  }

  if (membershipsResult.results.length === 0) {
    throw new ApiError(
      403,
      "operator_membership_required",
      "This Access identity has no active operator membership",
    );
  }

  const memberships = membershipsResult.results.map(toOperatorMembership);
  const requestedOrganization = request.headers.get("X-Operator-Organization")?.trim();
  let membership: OperatorMembership | undefined;
  if (requestedOrganization) {
    membership = memberships.find(
      (candidate) =>
        candidate.organizationSlug === requestedOrganization ||
        candidate.organizationExternalId === requestedOrganization,
    );
    if (!membership) {
      throw new ApiError(
        403,
        "operator_organization_forbidden",
        "This Access identity has no active membership for the requested organization",
      );
    }
  } else if (memberships.length === 1 || new URL(request.url).pathname.endsWith("/session")) {
    membership = memberships[0];
  } else {
    throw new ApiError(
      409,
      "operator_organization_required",
      "Select an organization before accessing operator data",
    );
  }

  if (!membership) {
    throw new ApiError(403, "operator_membership_required", "No active membership is available");
  }

  return {
    accessIssuer: issuer,
    ...membership,
    memberships,
  };
}

async function claimPendingInvitations(
  database: D1Database,
  issuer: string,
  subjectHash: string,
  email: string,
): Promise<boolean> {
  const normalizedEmail = email.trim().toLowerCase();
  if (!normalizedEmail || normalizedEmail.length > 320) return false;
  const emailHash = await sha256Hex(normalizedEmail);
  const invitations = await database
    .prepare(
      `SELECT id, organization_id, role FROM operator_invitations
       WHERE access_issuer = ? AND email_sha256 = ? AND status = 'pending'
         AND expires_at > ? ORDER BY created_at, id LIMIT 20`,
    )
    .bind(issuer, emailHash, new Date().toISOString())
    .all<{ id: string; organization_id: string; role: OperatorRole }>();
  let claimed = false;
  for (const invitation of invitations.results) {
    const now = new Date().toISOString();
    const membershipId = crypto.randomUUID();
    try {
      await database.batch([
        database
          .prepare(
            `INSERT INTO operator_memberships
             (id, organization_id, access_issuer, access_subject_sha256, role, active,
              version, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, 1, 1, ?, ?)`,
          )
          .bind(
            membershipId,
            invitation.organization_id,
            issuer,
            subjectHash,
            invitation.role,
            now,
            now,
          ),
        database
          .prepare(
            `UPDATE operator_invitations
             SET status = 'accepted', accepted_by_membership_id = ?, accepted_at = ?,
                 updated_at = ?, version = version + 1
             WHERE id = ? AND status = 'pending'`,
          )
          .bind(membershipId, now, now, invitation.id),
      ]);
      claimed = true;
    } catch {
      // Another request may have claimed the same invitation concurrently.
    }
  }
  return claimed;
}

function toOperatorMembership(row: OperatorMembershipRow): OperatorMembership {
  return {
    membershipId: row.membership_id,
    organizationId: row.organization_id,
    organizationExternalId: row.organization_external_id,
    organizationName: row.organization_name,
    organizationSlug: row.organization_slug ?? row.organization_external_id,
    role: row.role,
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
