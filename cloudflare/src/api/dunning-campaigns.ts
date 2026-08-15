import type { AuthContext } from "../auth/api-key";
import { sha256Hex } from "../auth/api-key";
import type { DomainEvent } from "../domain-events";
import { ApiError, json, objectAt, optionalString, parseJsonObject, requiredString } from "../http";
import { deterministicUuid } from "../identifiers";
import { stableJson } from "../json";

type DunningCampaignRow = {
  id: string;
  organization_id: string;
  code: string;
  name: string;
  description: string | null;
  bcc_emails_json: string;
  days_between_attempts: number;
  max_attempts: number;
  applied_to_organization: number;
  version: number;
  request_sha256: string;
  created_at: string;
  updated_at: string;
};

type DunningThreshold = {
  id: string;
  amountMinor: number;
  currency: string;
};

type NormalizedCampaign = {
  appliedToOrganization: boolean;
  bccEmails: string[];
  code: string;
  daysBetweenAttempts: number;
  description: string | null;
  maxAttempts: number;
  name: string;
  thresholds: Array<{ amountMinor: number; currency: string }>;
};

export async function handleDunningCampaignApi(
  request: Request,
  env: Env,
  auth: AuthContext,
  requestId: string,
): Promise<Response | null> {
  const url = new URL(request.url);
  if (url.pathname === "/api/v1/dunning_campaigns") {
    if (request.method === "POST") return createCampaign(request, env, auth, requestId);
    if (request.method === "GET") return listCampaigns(url, env.BILLING_DB, auth, requestId);
  }
  const match = url.pathname.match(/^\/api\/v1\/dunning_campaigns\/([^/]+)$/);
  if (!match?.[1]) return null;
  const code = decodeURIComponent(match[1]);
  if (request.method === "GET") return showCampaign(code, env.BILLING_DB, auth, requestId);
  if (request.method === "PUT") return updateCampaign(code, request, env, auth, requestId);
  if (request.method === "DELETE") return deleteCampaign(code, env, auth, requestId);
  return null;
}

async function createCampaign(
  request: Request,
  env: Env,
  auth: AuthContext,
  requestId: string,
): Promise<Response> {
  const input = objectAt(await parseJsonObject(request), "dunning_campaign");
  const normalized = normalizeCampaign(input, null);
  const requestHash = await sha256Hex(stableJson(normalized));
  const existing = await findCampaign(env.BILLING_DB, auth.organizationId, normalized.code);
  if (existing) {
    if (existing.request_sha256 !== requestHash) {
      throw new ApiError(
        409,
        "dunning_campaign_code_conflict",
        "Dunning campaign code already exists with different attributes",
      );
    }
    return campaignResponse(env.BILLING_DB, existing, requestId);
  }
  const campaignId = await deterministicUuid(
    "dunning-campaign",
    `${auth.organizationId}:${normalized.code}`,
  );
  const now = new Date().toISOString();
  const event = campaignEvent(
    "dunning_campaign.created",
    campaignId,
    1,
    auth.organizationId,
    requestId,
    now,
    normalized,
  );
  const statements: D1PreparedStatement[] = [
    env.BILLING_DB.prepare(
      `INSERT INTO dunning_campaigns
       (id, organization_id, code, name, description, bcc_emails_json,
        days_between_attempts, max_attempts, active, version, request_sha256,
        created_at, updated_at, deleted_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, 1, ?, ?, ?, NULL)`,
    ).bind(
      campaignId,
      auth.organizationId,
      normalized.code,
      normalized.name,
      normalized.description,
      stableJson(normalized.bccEmails),
      normalized.daysBetweenAttempts,
      normalized.maxAttempts,
      requestHash,
      now,
      now,
    ),
    ...(await thresholdUpsertStatements(
      env.BILLING_DB,
      auth.organizationId,
      campaignId,
      normalized.thresholds,
      now,
    )),
  ];
  if (normalized.appliedToOrganization) {
    statements.push(
      env.BILLING_DB.prepare(
        `UPDATE organizations SET applied_dunning_campaign_id = ?, updated_at = ? WHERE id = ?`,
      ).bind(campaignId, now, auth.organizationId),
      resetFallbackCustomersStatement(env.BILLING_DB, auth.organizationId, now),
    );
  }
  statements.push(outboxStatement(env.BILLING_DB, auth.organizationId, event));
  try {
    await env.BILLING_DB.batch(statements);
  } catch (error) {
    const concurrent = await findCampaign(env.BILLING_DB, auth.organizationId, normalized.code);
    if (concurrent?.request_sha256 === requestHash) {
      return campaignResponse(env.BILLING_DB, concurrent, requestId);
    }
    if (concurrent) {
      throw new ApiError(
        409,
        "dunning_campaign_code_conflict",
        "Dunning campaign code already exists with different attributes",
      );
    }
    throw error;
  }
  const created = await findCampaign(env.BILLING_DB, auth.organizationId, normalized.code);
  if (!created) throw new Error("dunning_campaign_persistence_failed");
  return campaignResponse(env.BILLING_DB, created, requestId);
}

async function updateCampaign(
  pathCode: string,
  request: Request,
  env: Env,
  auth: AuthContext,
  requestId: string,
): Promise<Response> {
  const current = await findCampaign(env.BILLING_DB, auth.organizationId, pathCode);
  if (!current) throw new ApiError(404, "dunning_campaign_not_found", "Campaign was not found");
  const input = objectAt(await parseJsonObject(request), "dunning_campaign");
  const currentThresholds = await campaignThresholds(env.BILLING_DB, current.id);
  const normalized = normalizeCampaign(input, {
    appliedToOrganization: current.applied_to_organization === 1,
    bccEmails: parseEmails(current.bcc_emails_json),
    code: current.code,
    daysBetweenAttempts: current.days_between_attempts,
    description: current.description,
    maxAttempts: current.max_attempts,
    name: current.name,
    thresholds: currentThresholds.map((threshold) => ({
      amountMinor: threshold.amountMinor,
      currency: threshold.currency,
    })),
  });
  const requestHash = await sha256Hex(stableJson(normalized));
  if (current.request_sha256 === requestHash)
    return campaignResponse(env.BILLING_DB, current, requestId);
  const conflicting = await findCampaign(env.BILLING_DB, auth.organizationId, normalized.code);
  if (conflicting && conflicting.id !== current.id) {
    throw new ApiError(409, "dunning_campaign_code_conflict", "Campaign code already exists");
  }
  const now = new Date().toISOString();
  const nextVersion = current.version + 1;
  const event = campaignEvent(
    "dunning_campaign.updated",
    current.id,
    nextVersion,
    auth.organizationId,
    requestId,
    now,
    normalized,
  );
  const thresholdsChanged =
    stableJson(normalized.thresholds) !==
    stableJson(
      currentThresholds.map((threshold) => ({
        amountMinor: threshold.amountMinor,
        currency: threshold.currency,
      })),
    );
  const attemptPolicyChanged =
    thresholdsChanged ||
    normalized.daysBetweenAttempts !== current.days_between_attempts ||
    normalized.maxAttempts !== current.max_attempts;
  const defaultChanged =
    normalized.appliedToOrganization !== (current.applied_to_organization === 1);
  const statements: D1PreparedStatement[] = [
    env.BILLING_DB.prepare(
      `UPDATE dunning_campaigns
       SET code = ?, name = ?, description = ?, bcc_emails_json = ?,
           days_between_attempts = ?, max_attempts = ?, request_sha256 = ?,
           version = version + 1, updated_at = ?
       WHERE id = ? AND organization_id = ? AND active = 1 AND version = ?`,
    ).bind(
      normalized.code,
      normalized.name,
      normalized.description,
      stableJson(normalized.bccEmails),
      normalized.daysBetweenAttempts,
      normalized.maxAttempts,
      requestHash,
      now,
      current.id,
      auth.organizationId,
      current.version,
    ),
  ];
  if (input.thresholds !== undefined) {
    statements.push(
      env.BILLING_DB.prepare(
        `UPDATE dunning_campaign_thresholds SET deleted_at = ?, updated_at = ?
         WHERE dunning_campaign_id = ? AND organization_id = ? AND deleted_at IS NULL`,
      ).bind(now, now, current.id, auth.organizationId),
      ...(await thresholdUpsertStatements(
        env.BILLING_DB,
        auth.organizationId,
        current.id,
        normalized.thresholds,
        now,
      )),
    );
  }
  if (defaultChanged) {
    const assignment = normalized.appliedToOrganization
      ? env.BILLING_DB.prepare(
          `UPDATE organizations SET applied_dunning_campaign_id = ?, updated_at = ? WHERE id = ?`,
        ).bind(current.id, now, auth.organizationId)
      : env.BILLING_DB.prepare(
          `UPDATE organizations SET applied_dunning_campaign_id = NULL, updated_at = ?
           WHERE id = ? AND applied_dunning_campaign_id = ?`,
        ).bind(now, auth.organizationId, current.id);
    statements.push(
      assignment,
      resetFallbackCustomersStatement(env.BILLING_DB, auth.organizationId, now),
    );
  }
  if (attemptPolicyChanged) {
    const assignmentPredicate = defaultChanged
      ? "customer.applied_dunning_campaign_id = ?"
      : `COALESCE(customer.applied_dunning_campaign_id,
                  (SELECT applied_dunning_campaign_id FROM organizations
                   WHERE id = customer.organization_id)) = ?`;
    statements.push(
      env.BILLING_DB.prepare(
        `UPDATE customers AS customer
         SET last_dunning_campaign_attempt = 0, last_dunning_campaign_attempt_at = NULL,
             version = version + 1, updated_at = ?
         WHERE customer.organization_id = ?
           AND customer.exclude_from_dunning_campaign = 0
           AND ${assignmentPredicate}`,
      ).bind(now, auth.organizationId, current.id),
    );
  }
  statements.push(
    guardedOutboxStatement(
      env.BILLING_DB,
      auth.organizationId,
      event,
      current.id,
      nextVersion,
      now,
    ),
  );
  const results = await env.BILLING_DB.batch(statements);
  if ((results[0]?.meta.changes ?? 0) !== 1) {
    throw new ApiError(409, "dunning_campaign_version_conflict", "Campaign changed concurrently");
  }
  const updated = await findCampaign(env.BILLING_DB, auth.organizationId, normalized.code);
  if (!updated) throw new Error("dunning_campaign_persistence_failed");
  return campaignResponse(env.BILLING_DB, updated, requestId);
}

async function deleteCampaign(
  code: string,
  env: Env,
  auth: AuthContext,
  requestId: string,
): Promise<Response> {
  const current = await findCampaign(env.BILLING_DB, auth.organizationId, code);
  if (!current) throw new ApiError(404, "dunning_campaign_not_found", "Campaign was not found");
  const now = new Date().toISOString();
  const nextVersion = current.version + 1;
  const event = campaignEvent(
    "dunning_campaign.deleted",
    current.id,
    nextVersion,
    auth.organizationId,
    requestId,
    now,
    { code: current.code },
  );
  const results = await env.BILLING_DB.batch([
    env.BILLING_DB.prepare(
      `UPDATE dunning_campaigns SET active = 0, deleted_at = ?, updated_at = ?,
                                    version = version + 1
       WHERE id = ? AND organization_id = ? AND active = 1 AND version = ?`,
    ).bind(now, now, current.id, auth.organizationId, current.version),
    env.BILLING_DB.prepare(
      `UPDATE dunning_campaign_thresholds SET deleted_at = COALESCE(deleted_at, ?), updated_at = ?
       WHERE dunning_campaign_id = ? AND organization_id = ?`,
    ).bind(now, now, current.id, auth.organizationId),
    env.BILLING_DB.prepare(
      `UPDATE customers
       SET applied_dunning_campaign_id = CASE
             WHEN applied_dunning_campaign_id = ? THEN NULL ELSE applied_dunning_campaign_id END,
           last_dunning_campaign_attempt = 0, last_dunning_campaign_attempt_at = NULL,
           version = version + 1, updated_at = ?
       WHERE organization_id = ? AND exclude_from_dunning_campaign = 0
         AND (applied_dunning_campaign_id = ? OR (
           applied_dunning_campaign_id IS NULL AND EXISTS (
             SELECT 1 FROM organizations organization
             WHERE organization.id = ? AND organization.applied_dunning_campaign_id = ?
           )
         ))`,
    ).bind(current.id, now, auth.organizationId, current.id, auth.organizationId, current.id),
    env.BILLING_DB.prepare(
      `UPDATE organizations SET applied_dunning_campaign_id = NULL, updated_at = ?
       WHERE id = ? AND applied_dunning_campaign_id = ?`,
    ).bind(now, auth.organizationId, current.id),
    guardedOutboxStatement(
      env.BILLING_DB,
      auth.organizationId,
      event,
      current.id,
      nextVersion,
      now,
      false,
    ),
  ]);
  if ((results[0]?.meta.changes ?? 0) !== 1) {
    throw new ApiError(409, "dunning_campaign_version_conflict", "Campaign changed concurrently");
  }
  return json(
    {
      dunning_campaign: { ...(await serializeCampaign(env.BILLING_DB, current)), deleted_at: now },
    },
    { requestId },
  );
}

async function listCampaigns(
  url: URL,
  database: D1Database,
  auth: AuthContext,
  requestId: string,
): Promise<Response> {
  const page = pageValue(url.searchParams.get("page"));
  const perPage = Math.min(pageValue(url.searchParams.get("per_page"), 20), 100);
  const offset = (page - 1) * perPage;
  const search = url.searchParams.get("search_term")?.trim().toLowerCase() ?? null;
  const where = search
    ? `campaign.organization_id = ? AND campaign.active = 1
       AND (lower(campaign.code) LIKE ? ESCAPE '\\' OR
            lower(campaign.name) LIKE ? ESCAPE '\\')`
    : "campaign.organization_id = ? AND campaign.active = 1";
  const bindings = search
    ? [auth.organizationId, `%${escapeLike(search)}%`, `%${escapeLike(search)}%`]
    : [auth.organizationId];
  const count = await database
    .prepare(`SELECT COUNT(*) AS total FROM dunning_campaigns campaign WHERE ${where}`)
    .bind(...bindings)
    .first<{ total: number }>();
  const rows = await database
    .prepare(
      `${campaignSelect()} WHERE ${where}
       ORDER BY campaign.created_at DESC, campaign.id DESC LIMIT ? OFFSET ?`,
    )
    .bind(...bindings, perPage, offset)
    .all<DunningCampaignRow>();
  return json(
    {
      dunning_campaigns: await Promise.all(
        rows.results.map((campaign) => serializeCampaign(database, campaign)),
      ),
      meta: pagination(count?.total ?? 0, page, perPage),
    },
    { requestId },
  );
}

async function showCampaign(
  code: string,
  database: D1Database,
  auth: AuthContext,
  requestId: string,
): Promise<Response> {
  const campaign = await findCampaign(database, auth.organizationId, code);
  if (!campaign) throw new ApiError(404, "dunning_campaign_not_found", "Campaign was not found");
  return campaignResponse(database, campaign, requestId);
}

async function campaignResponse(
  database: D1Database,
  campaign: DunningCampaignRow,
  requestId: string,
): Promise<Response> {
  return json({ dunning_campaign: await serializeCampaign(database, campaign) }, { requestId });
}

async function findCampaign(
  database: D1Database,
  organizationId: string,
  code: string,
): Promise<DunningCampaignRow | null> {
  return database
    .prepare(
      `${campaignSelect()} WHERE campaign.organization_id = ? AND campaign.code = ? AND campaign.active = 1 LIMIT 1`,
    )
    .bind(organizationId, code)
    .first<DunningCampaignRow>();
}

function campaignSelect(): string {
  return `SELECT campaign.id, campaign.organization_id, campaign.code, campaign.name,
                 campaign.description, campaign.bcc_emails_json,
                 campaign.days_between_attempts, campaign.max_attempts, campaign.version,
                 campaign.request_sha256, campaign.created_at, campaign.updated_at,
                 CASE WHEN organization.applied_dunning_campaign_id = campaign.id
                      THEN 1 ELSE 0 END AS applied_to_organization
          FROM dunning_campaigns campaign
          JOIN organizations organization ON organization.id = campaign.organization_id`;
}

async function serializeCampaign(database: D1Database, campaign: DunningCampaignRow) {
  const [thresholds, customers] = await Promise.all([
    campaignThresholds(database, campaign.id),
    database
      .prepare(
        `SELECT COUNT(*) AS total FROM customers customer
         JOIN organizations organization ON organization.id = customer.organization_id
         WHERE customer.organization_id = ? AND customer.exclude_from_dunning_campaign = 0
           AND COALESCE(customer.applied_dunning_campaign_id,
                        organization.applied_dunning_campaign_id) = ?`,
      )
      .bind(campaign.organization_id, campaign.id)
      .first<{ total: number }>(),
  ]);
  return {
    lago_id: campaign.id,
    applied_to_organization: campaign.applied_to_organization === 1,
    bcc_emails: parseEmails(campaign.bcc_emails_json),
    code: campaign.code,
    customers_count: customers?.total ?? 0,
    days_between_attempts: campaign.days_between_attempts,
    description: campaign.description,
    max_attempts: campaign.max_attempts,
    name: campaign.name,
    thresholds: thresholds.map((threshold) => ({
      lago_id: threshold.id,
      amount_cents: threshold.amountMinor,
      currency: threshold.currency,
    })),
    version_number: campaign.version,
    created_at: campaign.created_at,
    updated_at: campaign.updated_at,
  };
}

async function campaignThresholds(
  database: D1Database,
  campaignId: string,
): Promise<DunningThreshold[]> {
  const rows = await database
    .prepare(
      `SELECT id, amount_minor, currency FROM dunning_campaign_thresholds
       WHERE dunning_campaign_id = ? AND deleted_at IS NULL ORDER BY currency, id`,
    )
    .bind(campaignId)
    .all<{ id: string; amount_minor: number; currency: string }>();
  return rows.results.map((row) => ({
    id: row.id,
    amountMinor: row.amount_minor,
    currency: row.currency,
  }));
}

async function thresholdUpsertStatements(
  database: D1Database,
  organizationId: string,
  campaignId: string,
  thresholds: NormalizedCampaign["thresholds"],
  now: string,
): Promise<D1PreparedStatement[]> {
  return Promise.all(
    thresholds.map(async (threshold) =>
      database
        .prepare(
          `INSERT INTO dunning_campaign_thresholds
           (id, organization_id, dunning_campaign_id, amount_minor, currency,
            created_at, updated_at, deleted_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, NULL)
           ON CONFLICT(id) DO UPDATE SET amount_minor = excluded.amount_minor,
             currency = excluded.currency, updated_at = excluded.updated_at, deleted_at = NULL
           WHERE organization_id = excluded.organization_id
             AND dunning_campaign_id = excluded.dunning_campaign_id`,
        )
        .bind(
          await deterministicUuid("dunning-threshold", `${campaignId}:${threshold.currency}`),
          organizationId,
          campaignId,
          threshold.amountMinor,
          threshold.currency,
          now,
          now,
        ),
    ),
  );
}

function normalizeCampaign(
  input: Record<string, unknown>,
  current: NormalizedCampaign | null,
): NormalizedCampaign {
  const supported = new Set([
    "applied_to_organization",
    "bcc_emails",
    "code",
    "days_between_attempts",
    "description",
    "max_attempts",
    "name",
    "thresholds",
  ]);
  const unsupported = Object.keys(input).find((key) => !supported.has(key));
  if (unsupported) {
    throw new ApiError(
      422,
      "unsupported_dunning_campaign_feature",
      `${unsupported} is not implemented for dunning campaigns`,
    );
  }
  const code = input.code === undefined && current ? current.code : requiredString(input, "code");
  const name = input.name === undefined && current ? current.name : requiredString(input, "name");
  if (code.length > 255 || name.length > 255) {
    throw new ApiError(
      422,
      "validation_error",
      "Campaign code and name are limited to 255 characters",
    );
  }
  const appliedToOrganization = booleanValue(
    input.applied_to_organization,
    "applied_to_organization",
    current?.appliedToOrganization,
  );
  const daysBetweenAttempts = positiveInteger(
    input.days_between_attempts,
    "days_between_attempts",
    current?.daysBetweenAttempts,
  );
  const maxAttempts = positiveInteger(input.max_attempts, "max_attempts", current?.maxAttempts);
  const thresholds =
    input.thresholds === undefined && current
      ? current.thresholds
      : normalizeThresholds(input.thresholds);
  return {
    appliedToOrganization,
    bccEmails:
      input.bcc_emails === undefined && current
        ? current.bccEmails
        : normalizeEmails(input.bcc_emails),
    code,
    daysBetweenAttempts,
    description:
      input.description === undefined && current
        ? current.description
        : optionalString(input, "description"),
    maxAttempts,
    name,
    thresholds,
  };
}

function normalizeThresholds(value: unknown): NormalizedCampaign["thresholds"] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 50) {
    throw new ApiError(422, "validation_error", "thresholds must contain between 1 and 50 entries");
  }
  const thresholds = value.map((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new ApiError(422, "validation_error", "thresholds must contain objects");
    }
    const threshold = entry as Record<string, unknown>;
    const unsupported = Object.keys(threshold).find(
      (key) => !["id", "lago_id", "amount_cents", "currency"].includes(key),
    );
    if (unsupported)
      throw new ApiError(422, "validation_error", `thresholds.${unsupported} is invalid`);
    const amountMinor = nonNegativeInteger(threshold.amount_cents, "thresholds.amount_cents");
    const currency = requiredString(threshold, "currency").toUpperCase();
    if (!/^[A-Z]{3}$/.test(currency)) {
      throw new ApiError(422, "validation_error", "threshold currency must be an ISO-4217 code");
    }
    return { amountMinor, currency };
  });
  if (new Set(thresholds.map((threshold) => threshold.currency)).size !== thresholds.length) {
    throw new ApiError(422, "validation_error", "threshold currencies must be unique");
  }
  return thresholds.sort((left, right) => left.currency.localeCompare(right.currency));
}

function normalizeEmails(value: unknown): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > 20) {
    throw new ApiError(422, "validation_error", "bcc_emails must be an array of up to 20 emails");
  }
  const emails = value.map((entry) => {
    if (typeof entry !== "string")
      throw new ApiError(422, "validation_error", "bcc_emails is invalid");
    const email = entry.trim().toLowerCase();
    if (email.length > 255 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      throw new ApiError(422, "validation_error", "bcc_emails is invalid");
    }
    return email;
  });
  return [...new Set(emails)].sort();
}

function parseEmails(value: string): string[] {
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed)
      ? parsed.filter((email): email is string => typeof email === "string")
      : [];
  } catch {
    return [];
  }
}

function booleanValue(value: unknown, field: string, fallback?: boolean): boolean {
  if (value === undefined && fallback !== undefined) return fallback;
  if (typeof value !== "boolean")
    throw new ApiError(422, "validation_error", `${field} must be boolean`);
  return value;
}

function positiveInteger(value: unknown, field: string, fallback?: number): number {
  if (value === undefined && fallback !== undefined) return fallback;
  if (!Number.isSafeInteger(value) || (value as number) <= 0) {
    throw new ApiError(422, "validation_error", `${field} must be a positive integer`);
  }
  return value as number;
}

function nonNegativeInteger(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new ApiError(422, "validation_error", `${field} must be a non-negative integer`);
  }
  return value as number;
}

function resetFallbackCustomersStatement(
  database: D1Database,
  organizationId: string,
  now: string,
): D1PreparedStatement {
  return database
    .prepare(
      `UPDATE customers
       SET last_dunning_campaign_attempt = 0, last_dunning_campaign_attempt_at = NULL,
           version = version + 1, updated_at = ?
       WHERE organization_id = ? AND applied_dunning_campaign_id IS NULL
         AND exclude_from_dunning_campaign = 0`,
    )
    .bind(now, organizationId);
}

function campaignEvent(
  type: "dunning_campaign.created" | "dunning_campaign.updated" | "dunning_campaign.deleted",
  campaignId: string,
  aggregateVersion: number,
  organizationId: string,
  requestId: string,
  occurredAt: string,
  payload: Record<string, unknown>,
): DomainEvent {
  return {
    id: `${type.replaceAll(".", "-")}:${campaignId}:v${aggregateVersion}`,
    type,
    version: 1,
    aggregateType: "dunning_campaign",
    aggregateId: campaignId,
    aggregateVersion,
    occurredAt,
    causationId: requestId,
    correlationId: requestId,
    payload: { organizationId, campaignId, ...payload },
  };
}

function outboxStatement(
  database: D1Database,
  organizationId: string,
  event: DomainEvent,
): D1PreparedStatement {
  return database
    .prepare(
      `INSERT INTO outbox_events
       (event_id, organization_id, event_type, event_version, aggregate_type, aggregate_id,
        aggregate_version, causation_id, correlation_id, payload_json, occurred_at, published_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
    )
    .bind(
      event.id,
      organizationId,
      event.type,
      event.version,
      event.aggregateType,
      event.aggregateId,
      event.aggregateVersion,
      event.causationId,
      event.correlationId,
      stableJson(event.payload),
      event.occurredAt,
    );
}

function guardedOutboxStatement(
  database: D1Database,
  organizationId: string,
  event: DomainEvent,
  campaignId: string,
  expectedVersion: number,
  updatedAt: string,
  active = true,
): D1PreparedStatement {
  return database
    .prepare(
      `INSERT INTO outbox_events
       (event_id, organization_id, event_type, event_version, aggregate_type, aggregate_id,
        aggregate_version, causation_id, correlation_id, payload_json, occurred_at, published_at)
       SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL
       FROM dunning_campaigns
       WHERE id = ? AND organization_id = ? AND version = ? AND updated_at = ? AND active = ?`,
    )
    .bind(
      event.id,
      organizationId,
      event.type,
      event.version,
      event.aggregateType,
      event.aggregateId,
      event.aggregateVersion,
      event.causationId,
      event.correlationId,
      stableJson(event.payload),
      event.occurredAt,
      campaignId,
      organizationId,
      expectedVersion,
      updatedAt,
      active ? 1 : 0,
    );
}

function pageValue(value: string | null, fallback = 1): number {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function pagination(total: number, page: number, perPage: number) {
  const totalPages = total === 0 ? 0 : Math.ceil(total / perPage);
  return {
    current_page: total === 0 ? 0 : page,
    next_page: page < totalPages ? page + 1 : null,
    prev_page: page > 1 && page <= totalPages ? page - 1 : null,
    total_pages: totalPages,
    total_count: total,
  };
}

function escapeLike(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_");
}
