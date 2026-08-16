import type { AuthContext } from "../auth/api-key";
import { sha256Hex } from "../auth/api-key";
import type { DomainEvent } from "../domain-events";
import { ApiError, json, objectAt, parseJsonObject, requiredString } from "../http";
import { deterministicUuid } from "../identifiers";
import { stableJson } from "../json";

type QuoteRow = {
  id: string;
  organization_id: string;
  customer_id: string;
  customer_external_id: string;
  subscription_id: string | null;
  subscription_external_id: string | null;
  number: string;
  sequential_id: number;
  order_type: string;
  version: number;
  idempotency_key: string;
  request_sha256: string;
  created_at: string;
  updated_at: string;
};

type QuoteVersionRow = {
  id: string;
  organization_id: string;
  quote_id: string;
  sequential_id: number;
  status: string;
  approved_at: string | null;
  voided_at: string | null;
  void_reason: string | null;
  billing_items_json: string | null;
  content: string | null;
  share_token: string | null;
  lock_version: number;
  created_at: string;
  updated_at: string;
};

type SerializedQuote = Record<string, unknown>;
type QuotesEnv = Pick<Env, "BILLING_DB" | "DOMAIN_EVENTS">;

const ORDER_TYPES = new Set(["subscription_creation", "subscription_amendment", "one_off"]);
const VERSION_STATUSES = new Set(["draft", "approved", "voided"]);
const MAX_OWNERS = 100;
const MAX_CONTENT_LENGTH = 100_000;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export async function handleQuotesApi(
  request: Request,
  env: QuotesEnv,
  auth: AuthContext,
  requestId: string,
): Promise<Response | null> {
  const url = new URL(request.url);
  if (url.pathname === "/api/v1/quotes") {
    if (request.method === "POST") return createQuote(request, env, auth, requestId);
    if (request.method === "GET") return listQuotes(url, env.BILLING_DB, auth, requestId);
    return null;
  }

  const quoteMatch = url.pathname.match(/^\/api\/v1\/quotes\/([^/]+)$/);
  if (quoteMatch?.[1]) {
    const quoteId = decodeURIComponent(quoteMatch[1]);
    if (request.method === "GET") return showQuote(quoteId, env.BILLING_DB, auth, requestId);
    if (request.method === "PUT") return updateQuote(quoteId, request, env, auth, requestId);
    return null;
  }

  const versionMatch = url.pathname.match(
    /^\/api\/v1\/quote_versions\/([^/]+)(?:\/(approve|void|clone))?$/,
  );
  if (!versionMatch?.[1]) return null;
  const versionId = decodeURIComponent(versionMatch[1]);
  const action = versionMatch[2];
  if (!action && request.method === "PUT") {
    return updateQuoteVersion(versionId, request, env, auth, requestId);
  }
  if (request.method !== "POST") return null;
  if (action === "approve") return approveQuoteVersion(versionId, env, auth, requestId);
  if (action === "void") return voidQuoteVersion(versionId, env, auth, requestId);
  if (action === "clone") return cloneQuoteVersion(versionId, request, env, auth, requestId);
  return null;
}

async function createQuote(
  request: Request,
  env: QuotesEnv,
  auth: AuthContext,
  requestId: string,
): Promise<Response> {
  const idempotencyKey = requiredIdempotencyKey(request);
  const input = objectAt(await parseJsonObject(request), "quote");
  const customerId = requiredString(input, "customer_id");
  const orderType = enumField(input, "order_type", ORDER_TYPES);
  const subscriptionId = optionalIdentifier(input.subscription_id, "subscription_id");
  if (orderType === "subscription_amendment" && !subscriptionId) {
    throw new ApiError(
      422,
      "subscription_required",
      "subscription_id is required for subscription amendments",
    );
  }
  const ownerIds = ownerIdentifiers(input.owner_ids);
  const billingItems = billingItemsValue(input.billing_items);
  const content = contentValue(input.content);
  const normalized = {
    billingItems,
    content,
    customerId,
    orderType,
    ownerIds,
    subscriptionId,
  };
  const requestHash = await sha256Hex(stableJson(normalized));
  const replay = await findQuoteByIdempotency(env.BILLING_DB, auth.organizationId, idempotencyKey);
  if (replay) return quoteReplayResponse(replay, requestHash, env.BILLING_DB, requestId);

  await requireQuoteScope(env.BILLING_DB, auth.organizationId, customerId, subscriptionId);
  await requireActiveOwners(env.BILLING_DB, auth.organizationId, ownerIds);
  const organization = await env.BILLING_DB.prepare(
    "SELECT quote_counter FROM organizations WHERE id = ? LIMIT 1",
  )
    .bind(auth.organizationId)
    .first<{ quote_counter: number }>();
  if (!organization)
    throw new ApiError(404, "organization_not_found", "Organization was not found");

  const nextSequence = organization.quote_counter + 1;
  const now = new Date().toISOString();
  const quoteId = await deterministicUuid("quote", `${auth.organizationId}:${idempotencyKey}`);
  const versionId = await deterministicUuid("quote-version", `${quoteId}:1`);
  const number = `QT-${new Date(now).getUTCFullYear()}-${String(nextSequence).padStart(4, "0")}`;
  const shareToken = crypto.randomUUID();
  const quoteEvent = eventFor("quote.created", "quote", quoteId, 1, now, requestId, {
    organizationId: auth.organizationId,
    quoteId,
  });
  const versionEvent = eventFor(
    "quote_version.created",
    "quote_version",
    versionId,
    1,
    now,
    requestId,
    { organizationId: auth.organizationId, quoteId, quoteVersionId: versionId, status: "draft" },
  );
  const statements: D1PreparedStatement[] = [
    env.BILLING_DB.prepare(
      "UPDATE organizations SET quote_counter = ?, updated_at = ? WHERE id = ? AND quote_counter = ?",
    ).bind(nextSequence, now, auth.organizationId, organization.quote_counter),
    env.BILLING_DB.prepare(
      `INSERT INTO quotes
       (id, organization_id, customer_id, subscription_id, number, sequential_id, order_type,
        version, idempotency_key, request_sha256, created_at, updated_at)
       SELECT ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?
       FROM organizations WHERE id = ? AND quote_counter = ?`,
    ).bind(
      quoteId,
      auth.organizationId,
      customerId,
      subscriptionId,
      number,
      nextSequence,
      orderType,
      idempotencyKey,
      requestHash,
      now,
      now,
      auth.organizationId,
      nextSequence,
    ),
    env.BILLING_DB.prepare(
      `INSERT INTO quote_versions
       (id, organization_id, quote_id, sequential_id, status, approved_at, voided_at,
        void_reason, billing_items_json, content, share_token, lock_version, created_at, updated_at)
       VALUES (?, ?, ?, 1, 'draft', NULL, NULL, NULL, ?, ?, ?, 1, ?, ?)`,
    ).bind(
      versionId,
      auth.organizationId,
      quoteId,
      billingItems === null ? null : stableJson(billingItems),
      content,
      shareToken,
      now,
      now,
    ),
    ...ownerIds.map((ownerId) =>
      env.BILLING_DB.prepare(
        `INSERT INTO quote_owners
         (organization_id, quote_id, user_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`,
      ).bind(auth.organizationId, quoteId, ownerId, now, now),
    ),
    outboxStatement(env.BILLING_DB, auth.organizationId, quoteEvent),
    outboxStatement(env.BILLING_DB, auth.organizationId, versionEvent),
  ];
  try {
    const results = await env.BILLING_DB.batch(statements);
    if ((results[1]?.meta.changes ?? 0) !== 1) throw new Error("quote_counter_conflict");
  } catch (error) {
    const concurrent = await findQuoteByIdempotency(
      env.BILLING_DB,
      auth.organizationId,
      idempotencyKey,
    );
    if (concurrent) return quoteReplayResponse(concurrent, requestHash, env.BILLING_DB, requestId);
    if (error instanceof ApiError) throw error;
    throw new ApiError(
      409,
      "quote_version_conflict",
      "Quote numbering changed concurrently; retry",
    );
  }
  await Promise.all([env.DOMAIN_EVENTS.send(quoteEvent), env.DOMAIN_EVENTS.send(versionEvent)]);
  return showQuote(quoteId, env.BILLING_DB, auth, requestId);
}

async function listQuotes(
  url: URL,
  database: D1Database,
  auth: AuthContext,
  requestId: string,
): Promise<Response> {
  const page = positiveQueryInteger(url.searchParams.get("page"), 1, "page");
  const perPage = Math.min(
    positiveQueryInteger(url.searchParams.get("per_page"), 20, "per_page"),
    100,
  );
  const customerIds = queryList(url.searchParams, [
    "customer_ids[]",
    "customer_ids",
    "customer_id",
  ]);
  const statuses = queryList(url.searchParams, ["statuses[]", "statuses", "status"]);
  const orderTypes = queryList(url.searchParams, ["order_types[]", "order_types", "order_type"]);
  const ownerIds = queryList(url.searchParams, ["owner_ids[]", "owner_ids", "owner_id"]);
  validateQueryEnums(statuses, VERSION_STATUSES, "status");
  validateQueryEnums(orderTypes, ORDER_TYPES, "order_type");
  const quoteNumber = url.searchParams.get("quote_number")?.trim() || null;
  if (quoteNumber && quoteNumber.length > 100) {
    throw new ApiError(422, "validation_error", "quote_number is too long");
  }
  const from = dateBoundary(url.searchParams.get("from_date"), "from_date", false);
  const to = dateBoundary(url.searchParams.get("to_date"), "to_date", true);
  if (from && to && from >= to) {
    throw new ApiError(422, "validation_error", "from_date must not be after to_date");
  }

  const conditions = ["q.organization_id = ?"];
  const bindings: (string | number)[] = [auth.organizationId];
  addInCondition(conditions, bindings, "q.customer_id", customerIds);
  addInCondition(conditions, bindings, "q.order_type", orderTypes);
  addInCondition(conditions, bindings, "qv.status", statuses);
  if (ownerIds.length > 0) {
    conditions.push(
      `EXISTS (SELECT 1 FROM quote_owners qo WHERE qo.quote_id = q.id AND qo.user_id IN (${placeholders(ownerIds.length)}))`,
    );
    bindings.push(...ownerIds);
  }
  if (quoteNumber) {
    conditions.push("LOWER(q.number) LIKE ? ESCAPE '\\'");
    bindings.push(`%${escapeLike(quoteNumber.toLowerCase())}%`);
  }
  if (from) {
    conditions.push("q.created_at >= ?");
    bindings.push(from);
  }
  if (to) {
    conditions.push("q.created_at < ?");
    bindings.push(to);
  }
  const where = conditions.join(" AND ");
  const joins = `${quoteSelect()} JOIN quote_versions qv ON qv.quote_id = q.id
    AND qv.sequential_id = (SELECT MAX(latest.sequential_id) FROM quote_versions latest WHERE latest.quote_id = q.id)`;
  const count = await database
    .prepare(`SELECT COUNT(*) AS total FROM quotes q JOIN quote_versions qv ON qv.quote_id = q.id
      AND qv.sequential_id = (SELECT MAX(latest.sequential_id) FROM quote_versions latest WHERE latest.quote_id = q.id)
      WHERE ${where}`)
    .bind(...bindings)
    .first<{ total: number }>();
  const rows = await database
    .prepare(`${joins} WHERE ${where} ORDER BY q.created_at DESC, q.id DESC LIMIT ? OFFSET ?`)
    .bind(...bindings, perPage, (page - 1) * perPage)
    .all<QuoteRow & QuoteVersionRow>();
  const quotes = await hydrateQuotes(database, rows.results.map(quoteFromJoinedRow));
  return json({ quotes, meta: pagination(count?.total ?? 0, page, perPage) }, { requestId });
}

async function showQuote(
  quoteId: string,
  database: D1Database,
  auth: AuthContext,
  requestId: string,
): Promise<Response> {
  const quote = await findQuote(database, auth.organizationId, quoteId);
  if (!quote) throw new ApiError(404, "quote_not_found", "Quote was not found");
  const [serialized] = await hydrateQuotes(database, [quote]);
  return json({ quote: serialized }, { requestId });
}

async function updateQuote(
  quoteId: string,
  request: Request,
  env: QuotesEnv,
  auth: AuthContext,
  requestId: string,
): Promise<Response> {
  const current = await requiredQuote(env.BILLING_DB, auth.organizationId, quoteId);
  const input = objectAt(await parseJsonObject(request), "quote");
  const expectedVersion = positiveInteger(input.version, "version");
  if (expectedVersion !== current.version) {
    throw new ApiError(409, "quote_version_conflict", "Quote changed concurrently");
  }
  if (input.owner_ids === undefined) {
    throw new ApiError(422, "validation_error", "owner_ids is required");
  }
  const ownerIds = ownerIdentifiers(input.owner_ids);
  await requireActiveOwners(env.BILLING_DB, auth.organizationId, ownerIds);
  const existing = await ownerIdsForQuotes(env.BILLING_DB, [quoteId]);
  if (sameStrings(existing.get(quoteId) ?? [], ownerIds)) {
    return showQuote(quoteId, env.BILLING_DB, auth, requestId);
  }
  const now = new Date().toISOString();
  const nextVersion = current.version + 1;
  const event = eventFor("quote.updated", "quote", quoteId, nextVersion, now, requestId, {
    organizationId: auth.organizationId,
    quoteId,
    changedFields: ["owners"],
  });
  const statements: D1PreparedStatement[] = [
    env.BILLING_DB.prepare(
      `UPDATE quotes SET version = version + 1, updated_at = ?
       WHERE id = ? AND organization_id = ? AND version = ?`,
    ).bind(now, quoteId, auth.organizationId, expectedVersion),
    env.BILLING_DB.prepare(
      `DELETE FROM quote_owners WHERE quote_id = ? AND organization_id = ?
       AND EXISTS (SELECT 1 FROM quotes WHERE id = ? AND version = ?)`,
    ).bind(quoteId, auth.organizationId, quoteId, nextVersion),
    ...ownerIds.map((ownerId) =>
      env.BILLING_DB.prepare(
        `INSERT INTO quote_owners (organization_id, quote_id, user_id, created_at, updated_at)
         SELECT ?, ?, ?, ?, ? FROM quotes WHERE id = ? AND version = ?`,
      ).bind(auth.organizationId, quoteId, ownerId, now, now, quoteId, nextVersion),
    ),
    outboxStatement(env.BILLING_DB, auth.organizationId, event),
  ];
  try {
    const results = await env.BILLING_DB.batch(statements);
    if ((results[0]?.meta.changes ?? 0) !== 1) throw new Error("quote_version_conflict");
  } catch {
    throw new ApiError(409, "quote_version_conflict", "Quote changed concurrently");
  }
  await env.DOMAIN_EVENTS.send(event);
  return showQuote(quoteId, env.BILLING_DB, auth, requestId);
}

async function updateQuoteVersion(
  versionId: string,
  request: Request,
  env: QuotesEnv,
  auth: AuthContext,
  requestId: string,
): Promise<Response> {
  const current = await requiredQuoteVersion(env.BILLING_DB, auth.organizationId, versionId);
  if (current.status !== "draft") {
    throw new ApiError(
      422,
      "quote_version_not_editable",
      "Only draft quote versions can be edited",
    );
  }
  const input = objectAt(await parseJsonObject(request), "quote_version");
  const expectedVersion = positiveInteger(input.lock_version, "lock_version");
  if (expectedVersion !== current.lock_version) {
    throw new ApiError(409, "quote_version_conflict", "Quote version changed concurrently");
  }
  const billingItems =
    input.billing_items === undefined
      ? parseBillingItems(current.billing_items_json)
      : billingItemsValue(input.billing_items);
  const content = input.content === undefined ? current.content : contentValue(input.content);
  const nextBillingJson = billingItems === null ? null : stableJson(billingItems);
  if (nextBillingJson === current.billing_items_json && content === current.content) {
    return json({ quote_version: serializeQuoteVersion(current) }, { requestId });
  }
  const changedFields: string[] = [];
  if (nextBillingJson !== current.billing_items_json) changedFields.push("billing_items");
  if (content !== current.content) changedFields.push("content");
  const now = new Date().toISOString();
  const nextVersion = current.lock_version + 1;
  const event = eventFor(
    "quote_version.updated",
    "quote_version",
    versionId,
    nextVersion,
    now,
    requestId,
    {
      organizationId: auth.organizationId,
      quoteId: current.quote_id,
      quoteVersionId: versionId,
      changedFields,
    },
  );
  await guardedVersionMutation(
    env,
    current,
    env.BILLING_DB.prepare(
      `UPDATE quote_versions SET billing_items_json = ?, content = ?, lock_version = lock_version + 1,
       updated_at = ? WHERE id = ? AND organization_id = ? AND status = 'draft' AND lock_version = ?`,
    ).bind(nextBillingJson, content, now, versionId, auth.organizationId, expectedVersion),
    event,
  );
  return versionResponse(env.BILLING_DB, auth.organizationId, versionId, requestId);
}

async function approveQuoteVersion(
  versionId: string,
  env: QuotesEnv,
  auth: AuthContext,
  requestId: string,
): Promise<Response> {
  const current = await requiredQuoteVersion(env.BILLING_DB, auth.organizationId, versionId);
  if (current.status === "approved") {
    return json({ quote_version: serializeQuoteVersion(current) }, { requestId });
  }
  if (current.status !== "draft") {
    throw new ApiError(
      422,
      "quote_version_not_approvable",
      "Only draft quote versions can be approved",
    );
  }
  const now = new Date().toISOString();
  const event = eventFor(
    "quote_version.approved",
    "quote_version",
    versionId,
    current.lock_version + 1,
    now,
    requestId,
    {
      organizationId: auth.organizationId,
      quoteId: current.quote_id,
      quoteVersionId: versionId,
      status: "approved",
    },
  );
  await guardedVersionMutation(
    env,
    current,
    env.BILLING_DB.prepare(
      `UPDATE quote_versions SET status = 'approved', approved_at = ?, lock_version = lock_version + 1,
       updated_at = ? WHERE id = ? AND organization_id = ? AND status = 'draft' AND lock_version = ?`,
    ).bind(now, now, versionId, auth.organizationId, current.lock_version),
    event,
  );
  return versionResponse(env.BILLING_DB, auth.organizationId, versionId, requestId);
}

async function voidQuoteVersion(
  versionId: string,
  env: QuotesEnv,
  auth: AuthContext,
  requestId: string,
): Promise<Response> {
  const current = await requiredQuoteVersion(env.BILLING_DB, auth.organizationId, versionId);
  if (current.status === "voided" && current.void_reason === "manual") {
    return json({ quote_version: serializeQuoteVersion(current) }, { requestId });
  }
  if (current.status !== "draft") {
    throw new ApiError(
      422,
      "quote_version_not_voidable",
      "Only draft quote versions can be voided",
    );
  }
  const now = new Date().toISOString();
  const event = eventFor(
    "quote_version.voided",
    "quote_version",
    versionId,
    current.lock_version + 1,
    now,
    requestId,
    {
      organizationId: auth.organizationId,
      quoteId: current.quote_id,
      quoteVersionId: versionId,
      status: "voided",
      voidReason: "manual",
    },
  );
  await guardedVersionMutation(
    env,
    current,
    env.BILLING_DB.prepare(
      `UPDATE quote_versions SET status = 'voided', void_reason = 'manual', voided_at = ?,
       share_token = NULL, lock_version = lock_version + 1, updated_at = ?
       WHERE id = ? AND organization_id = ? AND status = 'draft' AND lock_version = ?`,
    ).bind(now, now, versionId, auth.organizationId, current.lock_version),
    event,
  );
  return versionResponse(env.BILLING_DB, auth.organizationId, versionId, requestId);
}

async function cloneQuoteVersion(
  versionId: string,
  request: Request,
  env: QuotesEnv,
  auth: AuthContext,
  requestId: string,
): Promise<Response> {
  const idempotencyKey = requiredIdempotencyKey(request);
  const commandKey = `quote-version-clone:${idempotencyKey}`;
  const requestHash = await sha256Hex(stableJson({ sourceVersionId: versionId }));
  const replay = await findCloneReplay(env.BILLING_DB, auth.organizationId, commandKey);
  if (replay) return cloneReplayResponse(replay, requestHash, env.BILLING_DB, auth, requestId);

  const source = await requiredQuoteVersion(env.BILLING_DB, auth.organizationId, versionId);
  const approved = await env.BILLING_DB.prepare(
    "SELECT id FROM quote_versions WHERE quote_id = ? AND status = 'approved' LIMIT 1",
  )
    .bind(source.quote_id)
    .first();
  if (approved) {
    throw new ApiError(
      422,
      "approved_quote_not_cloneable",
      "A quote with an approved version cannot be cloned",
    );
  }
  const active = await env.BILLING_DB.prepare(
    "SELECT id FROM quote_versions WHERE quote_id = ? AND status = 'draft' LIMIT 1",
  )
    .bind(source.quote_id)
    .first<{ id: string }>();
  if (active && active.id !== source.id) {
    throw new ApiError(
      422,
      "active_quote_version_exists",
      "The quote already has an active draft version",
    );
  }
  const maximum = await env.BILLING_DB.prepare(
    "SELECT MAX(sequential_id) AS maximum FROM quote_versions WHERE quote_id = ?",
  )
    .bind(source.quote_id)
    .first<{ maximum: number }>();
  const nextSequence = (maximum?.maximum ?? 0) + 1;
  const now = new Date().toISOString();
  const cloneId = await deterministicUuid(
    "quote-version-clone",
    `${auth.organizationId}:${commandKey}`,
  );
  const shareToken = crypto.randomUUID();
  const expiresAt = new Date(Date.parse(now) + 30 * 24 * 60 * 60 * 1000).toISOString();
  const cloneEvent = eventFor(
    "quote_version.created",
    "quote_version",
    cloneId,
    1,
    now,
    requestId,
    {
      organizationId: auth.organizationId,
      quoteId: source.quote_id,
      quoteVersionId: cloneId,
      sourceQuoteVersionId: source.id,
      status: "draft",
    },
  );
  const statements: D1PreparedStatement[] = [];
  let sourceEvent: DomainEvent | null = null;
  if (source.status === "draft") {
    sourceEvent = eventFor(
      "quote_version.voided",
      "quote_version",
      source.id,
      source.lock_version + 1,
      now,
      requestId,
      {
        organizationId: auth.organizationId,
        quoteId: source.quote_id,
        quoteVersionId: source.id,
        status: "voided",
        voidReason: "superseded",
      },
    );
    statements.push(
      env.BILLING_DB.prepare(
        `UPDATE quote_versions SET status = 'voided', void_reason = 'superseded', voided_at = ?,
         share_token = NULL, lock_version = lock_version + 1, updated_at = ?
         WHERE id = ? AND organization_id = ? AND status = 'draft' AND lock_version = ?`,
      ).bind(now, now, source.id, auth.organizationId, source.lock_version),
      outboxStatement(env.BILLING_DB, auth.organizationId, sourceEvent),
    );
  }
  statements.push(
    env.BILLING_DB.prepare(
      `INSERT INTO quote_versions
       (id, organization_id, quote_id, sequential_id, status, approved_at, voided_at, void_reason,
        billing_items_json, content, share_token, lock_version, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'draft', NULL, NULL, NULL, ?, ?, ?, 1, ?, ?)`,
    ).bind(
      cloneId,
      auth.organizationId,
      source.quote_id,
      nextSequence,
      source.billing_items_json,
      source.content,
      shareToken,
      now,
      now,
    ),
    env.BILLING_DB.prepare(
      `INSERT INTO idempotency_records
       (organization_id, idempotency_key, operation, request_sha256, state, response_status,
        response_json, created_at, completed_at, expires_at)
       VALUES (?, ?, 'quote_version.clone', ?, 'completed', 200, ?, ?, ?, ?)`,
    ).bind(
      auth.organizationId,
      commandKey,
      requestHash,
      stableJson({ quoteVersionId: cloneId }),
      now,
      now,
      expiresAt,
    ),
    outboxStatement(env.BILLING_DB, auth.organizationId, cloneEvent),
  );
  try {
    const results = await env.BILLING_DB.batch(statements);
    if (source.status === "draft" && (results[0]?.meta.changes ?? 0) !== 1) {
      throw new Error("quote_version_conflict");
    }
  } catch {
    const concurrent = await findCloneReplay(env.BILLING_DB, auth.organizationId, commandKey);
    if (concurrent)
      return cloneReplayResponse(concurrent, requestHash, env.BILLING_DB, auth, requestId);
    throw new ApiError(409, "quote_version_conflict", "Quote version changed concurrently");
  }
  await Promise.all(
    [sourceEvent, cloneEvent]
      .filter((event): event is DomainEvent => event !== null)
      .map((event) => env.DOMAIN_EVENTS.send(event)),
  );
  return versionResponse(env.BILLING_DB, auth.organizationId, cloneId, requestId);
}

async function guardedVersionMutation(
  env: QuotesEnv,
  current: QuoteVersionRow,
  mutation: D1PreparedStatement,
  event: DomainEvent,
): Promise<void> {
  try {
    const results = await env.BILLING_DB.batch([
      mutation,
      outboxStatement(env.BILLING_DB, current.organization_id, event),
    ]);
    if ((results[0]?.meta.changes ?? 0) !== 1) throw new Error("quote_version_conflict");
  } catch {
    throw new ApiError(409, "quote_version_conflict", "Quote version changed concurrently");
  }
  await env.DOMAIN_EVENTS.send(event);
}

async function quoteReplayResponse(
  quote: QuoteRow,
  requestHash: string,
  database: D1Database,
  requestId: string,
): Promise<Response> {
  if (quote.request_sha256 !== requestHash) {
    throw new ApiError(
      409,
      "idempotency_conflict",
      "Idempotency-Key was already used with different quote values",
    );
  }
  const [serialized] = await hydrateQuotes(database, [quote]);
  return json({ quote: serialized }, { requestId });
}

type CloneReplayRow = {
  operation: string;
  request_sha256: string;
  state: string;
  response_json: string | null;
};

async function findCloneReplay(
  database: D1Database,
  organizationId: string,
  commandKey: string,
): Promise<CloneReplayRow | null> {
  return database
    .prepare(
      `SELECT operation, request_sha256, state, response_json FROM idempotency_records
       WHERE organization_id = ? AND idempotency_key = ? LIMIT 1`,
    )
    .bind(organizationId, commandKey)
    .first<CloneReplayRow>();
}

async function cloneReplayResponse(
  replay: CloneReplayRow,
  requestHash: string,
  database: D1Database,
  auth: AuthContext,
  requestId: string,
): Promise<Response> {
  if (
    replay.operation !== "quote_version.clone" ||
    replay.request_sha256 !== requestHash ||
    replay.state !== "completed"
  ) {
    throw new ApiError(
      409,
      "idempotency_conflict",
      "Idempotency-Key was already used with a different clone request",
    );
  }
  let value: unknown;
  try {
    value = JSON.parse(replay.response_json ?? "null") as unknown;
  } catch {
    throw new ApiError(500, "persistence_error", "Clone replay record is invalid");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ApiError(500, "persistence_error", "Clone replay record is invalid");
  }
  const versionId = (value as Record<string, unknown>).quoteVersionId;
  if (typeof versionId !== "string") {
    throw new ApiError(500, "persistence_error", "Clone replay record is invalid");
  }
  return versionResponse(database, auth.organizationId, versionId, requestId);
}

async function versionResponse(
  database: D1Database,
  organizationId: string,
  versionId: string,
  requestId: string,
): Promise<Response> {
  const version = await requiredQuoteVersion(database, organizationId, versionId);
  return json({ quote_version: serializeQuoteVersion(version) }, { requestId });
}

async function requireQuoteScope(
  database: D1Database,
  organizationId: string,
  customerId: string,
  subscriptionId: string | null,
): Promise<void> {
  const customer = await database
    .prepare("SELECT id FROM customers WHERE id = ? AND organization_id = ? LIMIT 1")
    .bind(customerId, organizationId)
    .first();
  if (!customer) throw new ApiError(404, "customer_not_found", "Customer was not found");
  if (!subscriptionId) return;
  const subscription = await database
    .prepare(
      `SELECT id FROM subscriptions
       WHERE id = ? AND organization_id = ? AND customer_id = ? LIMIT 1`,
    )
    .bind(subscriptionId, organizationId, customerId)
    .first();
  if (!subscription) {
    throw new ApiError(
      422,
      "invalid_subscription_scope",
      "Subscription must belong to the quote customer and organization",
    );
  }
}

async function requireActiveOwners(
  database: D1Database,
  organizationId: string,
  ownerIds: string[],
): Promise<void> {
  if (ownerIds.length === 0) return;
  const row = await database
    .prepare(
      `SELECT COUNT(*) AS total FROM organization_memberships
       WHERE organization_id = ? AND status = 'active' AND user_id IN (${placeholders(ownerIds.length)})`,
    )
    .bind(organizationId, ...ownerIds)
    .first<{ total: number }>();
  if ((row?.total ?? 0) !== ownerIds.length) {
    throw new ApiError(
      422,
      "invalid_quote_owner",
      "Every owner must have an active organization membership",
    );
  }
}

async function requiredQuote(
  database: D1Database,
  organizationId: string,
  quoteId: string,
): Promise<QuoteRow> {
  const quote = await findQuote(database, organizationId, quoteId);
  if (!quote) throw new ApiError(404, "quote_not_found", "Quote was not found");
  return quote;
}

async function findQuote(
  database: D1Database,
  organizationId: string,
  quoteId: string,
): Promise<QuoteRow | null> {
  return database
    .prepare(`${quoteBaseSelect()} WHERE q.organization_id = ? AND q.id = ? LIMIT 1`)
    .bind(organizationId, quoteId)
    .first<QuoteRow>();
}

async function findQuoteByIdempotency(
  database: D1Database,
  organizationId: string,
  idempotencyKey: string,
): Promise<QuoteRow | null> {
  return database
    .prepare(`${quoteBaseSelect()} WHERE q.organization_id = ? AND q.idempotency_key = ? LIMIT 1`)
    .bind(organizationId, idempotencyKey)
    .first<QuoteRow>();
}

async function requiredQuoteVersion(
  database: D1Database,
  organizationId: string,
  versionId: string,
): Promise<QuoteVersionRow> {
  const version = await database
    .prepare(`${quoteVersionSelect()} WHERE organization_id = ? AND id = ? LIMIT 1`)
    .bind(organizationId, versionId)
    .first<QuoteVersionRow>();
  if (!version) {
    throw new ApiError(404, "quote_version_not_found", "Quote version was not found");
  }
  return version;
}

function quoteBaseSelect(): string {
  return `SELECT q.id, q.organization_id, q.customer_id,
    customer.external_id AS customer_external_id, q.subscription_id,
    subscription.external_id AS subscription_external_id, q.number, q.sequential_id,
    q.order_type, q.version, q.idempotency_key, q.request_sha256, q.created_at, q.updated_at
    FROM quotes q JOIN customers customer ON customer.id = q.customer_id
    LEFT JOIN subscriptions subscription ON subscription.id = q.subscription_id`;
}

function quoteSelect(): string {
  return `SELECT q.id, q.organization_id, q.customer_id,
    customer.external_id AS customer_external_id, q.subscription_id,
    subscription.external_id AS subscription_external_id, q.number, q.sequential_id,
    q.order_type, q.version, q.idempotency_key, q.request_sha256, q.created_at, q.updated_at,
    qv.id AS qv_id, qv.organization_id AS qv_organization_id, qv.quote_id AS qv_quote_id,
    qv.sequential_id AS qv_sequential_id, qv.status AS qv_status,
    qv.approved_at AS qv_approved_at, qv.voided_at AS qv_voided_at,
    qv.void_reason AS qv_void_reason, qv.billing_items_json AS qv_billing_items_json,
    qv.content AS qv_content, qv.share_token AS qv_share_token,
    qv.lock_version AS qv_lock_version, qv.created_at AS qv_created_at,
    qv.updated_at AS qv_updated_at
    FROM quotes q JOIN customers customer ON customer.id = q.customer_id
    LEFT JOIN subscriptions subscription ON subscription.id = q.subscription_id`;
}

function quoteVersionSelect(): string {
  return `SELECT id, organization_id, quote_id, sequential_id, status, approved_at, voided_at,
    void_reason, billing_items_json, content, share_token, lock_version, created_at, updated_at
    FROM quote_versions`;
}

function quoteFromJoinedRow(row: QuoteRow & Record<string, unknown>): QuoteRow {
  return {
    id: row.id,
    organization_id: row.organization_id,
    customer_id: row.customer_id,
    customer_external_id: row.customer_external_id,
    subscription_id: row.subscription_id,
    subscription_external_id: row.subscription_external_id,
    number: row.number,
    sequential_id: row.sequential_id,
    order_type: row.order_type,
    version: row.version,
    idempotency_key: row.idempotency_key,
    request_sha256: row.request_sha256,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

async function hydrateQuotes(database: D1Database, rows: QuoteRow[]): Promise<SerializedQuote[]> {
  if (rows.length === 0) return [];
  const quoteIds = rows.map((row) => row.id);
  const [owners, versionsResult] = await Promise.all([
    ownerIdsForQuotes(database, quoteIds),
    database
      .prepare(
        `${quoteVersionSelect()} WHERE quote_id IN (${placeholders(quoteIds.length)})
         ORDER BY quote_id, sequential_id ASC`,
      )
      .bind(...quoteIds)
      .all<QuoteVersionRow>(),
  ]);
  const versions = new Map<string, QuoteVersionRow[]>();
  for (const version of versionsResult.results) {
    const current = versions.get(version.quote_id) ?? [];
    current.push(version);
    versions.set(version.quote_id, current);
  }
  return rows.map((row) => {
    const quoteVersions = versions.get(row.id) ?? [];
    const currentVersion = quoteVersions.at(-1) ?? null;
    return {
      lago_id: row.id,
      lago_customer_id: row.customer_id,
      external_customer_id: row.customer_external_id,
      lago_subscription_id: row.subscription_id,
      external_subscription_id: row.subscription_external_id,
      number: row.number,
      sequential_id: row.sequential_id,
      order_type: row.order_type,
      owner_ids: owners.get(row.id) ?? [],
      current_version: currentVersion ? serializeQuoteVersion(currentVersion) : null,
      versions: quoteVersions.map(serializeQuoteVersion),
      version: row.version,
      created_at: row.created_at,
      updated_at: row.updated_at,
    };
  });
}

async function ownerIdsForQuotes(
  database: D1Database,
  quoteIds: string[],
): Promise<Map<string, string[]>> {
  const result = new Map<string, string[]>();
  if (quoteIds.length === 0) return result;
  const rows = await database
    .prepare(
      `SELECT quote_id, user_id FROM quote_owners WHERE quote_id IN (${placeholders(quoteIds.length)})
       ORDER BY quote_id, user_id`,
    )
    .bind(...quoteIds)
    .all<{ quote_id: string; user_id: string }>();
  for (const row of rows.results) {
    const owners = result.get(row.quote_id) ?? [];
    owners.push(row.user_id);
    result.set(row.quote_id, owners);
  }
  return result;
}

function serializeQuoteVersion(row: QuoteVersionRow): Record<string, unknown> {
  return {
    lago_id: row.id,
    lago_quote_id: row.quote_id,
    version: row.sequential_id,
    status: row.status,
    billing_items: parseBillingItems(row.billing_items_json),
    content: row.content,
    share_token: row.share_token,
    approved_at: row.approved_at,
    voided_at: row.voided_at,
    void_reason: row.void_reason,
    lock_version: row.lock_version,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function parseBillingItems(value: string | null): unknown[] | null {
  if (value === null) return null;
  const parsed = JSON.parse(value) as unknown;
  return Array.isArray(parsed) ? parsed : null;
}

function billingItemsValue(value: unknown): unknown[] | null {
  if (value === undefined || value === null) return null;
  if (!Array.isArray(value)) {
    throw new ApiError(422, "validation_error", "billing_items must be an array or null");
  }
  if (value.some((item) => !item || typeof item !== "object" || Array.isArray(item))) {
    throw new ApiError(422, "validation_error", "billing_items entries must be objects");
  }
  return value;
}

function contentValue(value: unknown): string | null {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string") {
    throw new ApiError(422, "validation_error", "content must be a string or null");
  }
  if (value.length > MAX_CONTENT_LENGTH) {
    throw new ApiError(422, "validation_error", "content is too long");
  }
  return value;
}

function ownerIdentifiers(value: unknown): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    throw new ApiError(422, "validation_error", "owner_ids must be an array");
  }
  if (value.length > MAX_OWNERS) {
    throw new ApiError(422, "validation_error", `owner_ids cannot exceed ${MAX_OWNERS} entries`);
  }
  const owners = value.map((owner, index) => {
    if (typeof owner !== "string" || !UUID_PATTERN.test(owner.trim())) {
      throw new ApiError(422, "validation_error", `owner_ids[${index}] is invalid`);
    }
    return owner.trim();
  });
  return [...new Set(owners)].sort();
}

function optionalIdentifier(value: unknown, field: string): string | null {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string" || !value.trim()) {
    throw new ApiError(422, "validation_error", `${field} must be a string or null`);
  }
  return value.trim();
}

function enumField(input: Record<string, unknown>, field: string, allowed: Set<string>): string {
  const value = input[field];
  if (typeof value !== "string" || !allowed.has(value)) {
    throw new ApiError(422, "validation_error", `${field} is invalid`);
  }
  return value;
}

function positiveInteger(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw new ApiError(422, "validation_error", `${field} must be a positive integer`);
  }
  return value;
}

function positiveQueryInteger(value: string | null, fallback: number, field: string): number {
  if (value === null || value === "") return fallback;
  if (!/^\d+$/.test(value)) {
    throw new ApiError(422, "validation_error", `${field} must be a positive integer`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new ApiError(422, "validation_error", `${field} must be a positive integer`);
  }
  return parsed;
}

function requiredIdempotencyKey(request: Request): string {
  const value = request.headers.get("Idempotency-Key")?.trim();
  if (!value) {
    throw new ApiError(422, "idempotency_key_required", "Idempotency-Key is required");
  }
  if (value.length > 200) {
    throw new ApiError(422, "validation_error", "Idempotency-Key is too long");
  }
  return value;
}

function queryList(params: URLSearchParams, keys: string[]): string[] {
  const values = keys.flatMap((key) => params.getAll(key));
  return [
    ...new Set(
      values
        .flatMap((value) => value.split(","))
        .map((value) => value.trim())
        .filter(Boolean),
    ),
  ];
}

function validateQueryEnums(values: string[], allowed: Set<string>, field: string): void {
  if (values.some((value) => !allowed.has(value))) {
    throw new ApiError(422, "validation_error", `${field} filter is invalid`);
  }
}

function dateBoundary(value: string | null, field: string, exclusiveEnd: boolean): string | null {
  if (value === null || value === "") return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new ApiError(422, "validation_error", `${field} must use YYYY-MM-DD`);
  }
  const instant = new Date(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(instant.getTime()) || instant.toISOString().slice(0, 10) !== value) {
    throw new ApiError(422, "validation_error", `${field} is not a valid date`);
  }
  if (exclusiveEnd) instant.setUTCDate(instant.getUTCDate() + 1);
  return instant.toISOString();
}

function addInCondition(
  conditions: string[],
  bindings: (string | number)[],
  column: string,
  values: string[],
): void {
  if (values.length === 0) return;
  conditions.push(`${column} IN (${placeholders(values.length)})`);
  bindings.push(...values);
}

function placeholders(count: number): string {
  return Array.from({ length: count }, () => "?").join(", ");
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (match) => `\\${match}`);
}

function sameStrings(left: string[], right: string[]): boolean {
  const a = [...left].sort();
  const b = [...right].sort();
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

function pagination(total: number, page: number, perPage: number) {
  const pages = total === 0 ? 0 : Math.ceil(total / perPage);
  return {
    current_page: total === 0 ? 0 : page,
    next_page: page < pages ? page + 1 : null,
    prev_page: page > 1 && page <= pages ? page - 1 : null,
    total_pages: pages,
    total_count: total,
  };
}

function eventFor(
  type: string,
  aggregateType: string,
  aggregateId: string,
  aggregateVersion: number,
  occurredAt: string,
  requestId: string,
  payload: Record<string, unknown>,
): DomainEvent {
  return {
    id: `${type}:${aggregateId}:v${aggregateVersion}`,
    type,
    version: 1,
    aggregateType,
    aggregateId,
    aggregateVersion,
    occurredAt,
    causationId: requestId,
    correlationId: requestId,
    payload,
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
       (event_id, organization_id, event_type, event_version, aggregate_type,
        aggregate_id, aggregate_version, causation_id, correlation_id, payload_json,
        occurred_at, published_at)
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
