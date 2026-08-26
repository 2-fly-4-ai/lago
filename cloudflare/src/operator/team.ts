import { sha256Hex } from "../auth/api-key";
import { ApiError, json, parseJsonObject } from "../http";
import {
  assertOperatorAdmin,
  assertOperatorMutationRequest,
  type OperatorContext,
  type OperatorEnv,
  type OperatorRole,
} from "./access";

type MembershipRow = {
  id: string;
  role: OperatorRole;
  active: number;
  access_subject_sha256: string;
  version: number;
  created_at: string;
  updated_at: string;
  revoked_at: string | null;
};

type InvitationRow = {
  id: string;
  email_sha256: string;
  role: OperatorRole;
  status: string;
  version: number;
  created_at: string;
  updated_at: string;
  expires_at: string;
  accepted_at: string | null;
  revoked_at: string | null;
};

export async function handleOperatorTeamRequest(
  request: Request,
  env: OperatorEnv,
  operator: OperatorContext,
  requestId: string,
): Promise<Response | null> {
  const url = new URL(request.url);
  if (!url.pathname.startsWith("/api/operator/v1/team/")) return null;
  if (request.method !== "GET") {
    assertOperatorAdmin(operator);
    assertOperatorMutationRequest(request);
  }

  if (url.pathname === "/api/operator/v1/team/members" && request.method === "GET") {
    return listMembers(env.BILLING_DB, operator.organizationId, requestId);
  }
  const memberMatch = url.pathname.match(/^\/api\/operator\/v1\/team\/members\/([^/]+)$/);
  if (memberMatch?.[1] && (request.method === "PATCH" || request.method === "DELETE")) {
    return mutateMember(
      request,
      env.BILLING_DB,
      operator,
      decodeURIComponent(memberMatch[1]),
      requestId,
    );
  }

  if (url.pathname === "/api/operator/v1/team/invitations") {
    if (request.method === "GET") {
      return listInvitations(env.BILLING_DB, operator.organizationId, requestId);
    }
    if (request.method === "POST") {
      return createInvitation(request, env.BILLING_DB, operator, requestId);
    }
  }
  const inviteMatch = url.pathname.match(/^\/api\/operator\/v1\/team\/invitations\/([^/]+)$/);
  if (inviteMatch?.[1] && (request.method === "PATCH" || request.method === "DELETE")) {
    return mutateInvitation(
      request,
      env.BILLING_DB,
      operator,
      decodeURIComponent(inviteMatch[1]),
      requestId,
    );
  }

  if (url.pathname === "/api/operator/v1/team/roles" && request.method === "GET") {
    return json(
      {
        roles: [
          {
            code: "admin",
            name: "Admin",
            description: "Manage billing configuration and operator memberships",
          },
          {
            code: "viewer",
            name: "Viewer",
            description: "Read tenant-scoped billing data and reports",
          },
        ],
      },
      { requestId },
    );
  }
  if (url.pathname === "/api/operator/v1/team/authentication" && request.method === "GET") {
    return json(
      {
        authentication: {
          provider: "cloudflare_access",
          enforced: true,
          password_login: false,
          social_login: false,
          sso_configuration: "Managed by the Cloudflare Access application",
        },
      },
      { requestId },
    );
  }
  if (url.pathname === "/api/operator/v1/team/security-logs" && request.method === "GET") {
    const result = await env.BILLING_DB.prepare(
      `SELECT id, request_id, method, route_template, response_status, occurred_at
       FROM operator_api_logs WHERE organization_id = ? AND response_status >= 400
       ORDER BY occurred_at DESC, id DESC LIMIT 100`,
    )
      .bind(operator.organizationId)
      .all();
    return json({ security_logs: result.results }, { requestId });
  }

  return null;
}

async function listMembers(
  database: D1Database,
  organizationId: string,
  requestId: string,
): Promise<Response> {
  const result = await database
    .prepare(
      `SELECT id, role, active, access_subject_sha256, version, created_at, updated_at, revoked_at
       FROM operator_memberships WHERE organization_id = ?
       ORDER BY active DESC, created_at, id`,
    )
    .bind(organizationId)
    .all<MembershipRow>();
  return json(
    {
      members: result.results.map((row) => ({
        lago_id: row.id,
        identity: `Access identity …${row.access_subject_sha256.slice(-12)}`,
        role: row.role,
        status: row.active ? "active" : "revoked",
        version: row.version,
        created_at: row.created_at,
        updated_at: row.updated_at,
        revoked_at: row.revoked_at,
      })),
    },
    { requestId },
  );
}

async function mutateMember(
  request: Request,
  database: D1Database,
  operator: OperatorContext,
  membershipId: string,
  requestId: string,
): Promise<Response> {
  const current = await database
    .prepare(
      "SELECT id, role, active FROM operator_memberships WHERE id = ? AND organization_id = ?",
    )
    .bind(membershipId, operator.organizationId)
    .first<{ id: string; role: OperatorRole; active: number }>();
  if (!current) throw new ApiError(404, "membership_not_found", "Membership was not found");
  if (membershipId === operator.membershipId) {
    throw new ApiError(
      422,
      "self_membership_change",
      "Use another admin to change your membership",
    );
  }
  const now = new Date().toISOString();
  if (request.method === "DELETE") {
    await ensureAnotherAdmin(database, operator.organizationId, current.role);
    await database
      .prepare(
        `UPDATE operator_memberships SET active = 0, revoked_at = ?, updated_at = ?, version = version + 1
         WHERE id = ? AND organization_id = ? AND active = 1`,
      )
      .bind(now, now, membershipId, operator.organizationId)
      .run();
    return new Response(null, { status: 204 });
  }
  const body = await parseJsonObject(request);
  const role = parseRole(body.role);
  if (current.role === "admin" && role !== "admin") {
    await ensureAnotherAdmin(database, operator.organizationId, current.role);
  }
  await database
    .prepare(
      `UPDATE operator_memberships SET role = ?, updated_at = ?, version = version + 1
       WHERE id = ? AND organization_id = ? AND active = 1`,
    )
    .bind(role, now, membershipId, operator.organizationId)
    .run();
  return listMembers(database, operator.organizationId, requestId);
}

async function listInvitations(
  database: D1Database,
  organizationId: string,
  requestId: string,
): Promise<Response> {
  const result = await database
    .prepare(
      `SELECT id, email_sha256, role, status, version, created_at, updated_at, expires_at,
              accepted_at, revoked_at
       FROM operator_invitations WHERE organization_id = ? ORDER BY created_at DESC, id DESC LIMIT 100`,
    )
    .bind(organizationId)
    .all<InvitationRow>();
  return json(
    {
      invitations: result.results.map((row) => ({
        lago_id: row.id,
        identity: `Invited email …${row.email_sha256.slice(-12)}`,
        role: row.role,
        status: row.status,
        version: row.version,
        created_at: row.created_at,
        updated_at: row.updated_at,
        expires_at: row.expires_at,
        accepted_at: row.accepted_at,
        revoked_at: row.revoked_at,
      })),
    },
    { requestId },
  );
}

async function createInvitation(
  request: Request,
  database: D1Database,
  operator: OperatorContext,
  requestId: string,
): Promise<Response> {
  const body = await parseJsonObject(request);
  const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
  if (!email || email.length > 320 || !email.includes("@")) {
    throw new ApiError(422, "validation_error", "A valid Access email is required");
  }
  const role = parseRole(body.role);
  const now = new Date().toISOString();
  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1_000).toISOString();
  try {
    await database
      .prepare(
        `INSERT INTO operator_invitations
         (id, organization_id, access_issuer, email_sha256, role, status,
          invited_by_membership_id, created_at, updated_at, expires_at)
         VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?)`,
      )
      .bind(
        crypto.randomUUID(),
        operator.organizationId,
        operator.accessIssuer,
        await sha256Hex(email),
        role,
        operator.membershipId,
        now,
        now,
        expiresAt,
      )
      .run();
  } catch (error) {
    if (String(error).includes("UNIQUE")) {
      throw new ApiError(409, "invitation_exists", "A pending invitation already exists");
    }
    throw error;
  }
  return listInvitations(database, operator.organizationId, requestId);
}

async function mutateInvitation(
  request: Request,
  database: D1Database,
  operator: OperatorContext,
  invitationId: string,
  requestId: string,
): Promise<Response> {
  const invitation = await database
    .prepare(
      "SELECT id FROM operator_invitations WHERE id = ? AND organization_id = ? AND status = 'pending'",
    )
    .bind(invitationId, operator.organizationId)
    .first<{ id: string }>();
  if (!invitation) throw new ApiError(404, "invitation_not_found", "Invitation was not found");
  const now = new Date().toISOString();
  if (request.method === "DELETE") {
    await database
      .prepare(
        `UPDATE operator_invitations SET status = 'revoked', revoked_at = ?, updated_at = ?,
                version = version + 1 WHERE id = ? AND organization_id = ?`,
      )
      .bind(now, now, invitationId, operator.organizationId)
      .run();
    return new Response(null, { status: 204 });
  }
  const body = await parseJsonObject(request);
  const role = parseRole(body.role);
  await database
    .prepare(
      `UPDATE operator_invitations SET role = ?, updated_at = ?, version = version + 1
       WHERE id = ? AND organization_id = ? AND status = 'pending'`,
    )
    .bind(role, now, invitationId, operator.organizationId)
    .run();
  return listInvitations(database, operator.organizationId, requestId);
}

function parseRole(value: unknown): OperatorRole {
  if (value !== "viewer" && value !== "admin") {
    throw new ApiError(422, "validation_error", "role must be viewer or admin");
  }
  return value;
}

async function ensureAnotherAdmin(
  database: D1Database,
  organizationId: string,
  currentRole: OperatorRole,
): Promise<void> {
  if (currentRole !== "admin") return;
  const row = await database
    .prepare(
      `SELECT COUNT(*) AS count FROM operator_memberships
       WHERE organization_id = ? AND role = 'admin' AND active = 1 AND revoked_at IS NULL`,
    )
    .bind(organizationId)
    .first<{ count: number }>();
  if (Number(row?.count) <= 1) {
    throw new ApiError(422, "last_admin_required", "The organization must retain an active admin");
  }
}
