import type { AuthContext } from "../auth/api-key";
import { sha256Hex } from "../auth/api-key";
import type { DomainEvent } from "../domain-events";
import { ApiError, json, objectAt, optionalString, parseJsonObject, requiredString } from "../http";
import { deterministicUuid } from "../identifiers";
import { stableJson } from "../json";
import { Decimal } from "../rating/decimal";

type WalletRow = {
  id: string;
  customer_id: string;
  external_customer_id: string;
  code: string;
  name: string | null;
  currency: string;
  currency_exponent: number;
  rate_amount: string;
  priority: number;
  balance_minor: number;
  consumed_minor: number;
  status: string;
  expiration_at: string | null;
  version: number;
  request_sha256: string;
  created_at: string;
  updated_at: string;
  terminated_at: string | null;
};

type WalletTransactionRow = {
  id: string;
  wallet_id: string;
  invoice_id: string | null;
  voided_invoice_id: string | null;
  transaction_type: string;
  transaction_status: string;
  status: string;
  source: string;
  amount_minor: number;
  credit_amount: string;
  remaining_minor: number | null;
  rate_amount: string;
  currency_exponent: number;
  priority: number;
  name: string | null;
  settled_at: string | null;
  failed_at: string | null;
  created_at: string;
};

export async function handleWalletLedgerRequest(
  request: Request,
  env: Env,
  auth: AuthContext,
  requestId: string,
): Promise<Response | null> {
  const url = new URL(request.url);
  if (request.method === "POST" && url.pathname === "/api/v1/wallets")
    return createWallet(request, env, auth, requestId);
  if (request.method === "GET" && url.pathname === "/api/v1/wallets")
    return listWallets(url, env.BILLING_DB, auth, requestId);
  const walletMatch = url.pathname.match(/^\/api\/v1\/wallets\/([^/]+)$/);
  if (walletMatch?.[1]) {
    const id = decodeURIComponent(walletMatch[1]);
    if (request.method === "GET") return showWallet(id, env.BILLING_DB, auth, requestId);
    if (request.method === "DELETE") return terminateWallet(id, env, auth, requestId);
  }
  if (request.method === "POST" && url.pathname === "/api/v1/wallet_transactions")
    return createTransaction(request, env, auth, requestId);
  const transactionMatch = url.pathname.match(/^\/api\/v1\/wallet_transactions\/([^/]+)$/);
  if (request.method === "GET" && transactionMatch?.[1])
    return showTransaction(
      decodeURIComponent(transactionMatch[1]),
      env.BILLING_DB,
      auth,
      requestId,
    );
  const walletTransactionsMatch = url.pathname.match(
    /^\/api\/v1\/wallets\/([^/]+)\/wallet_transactions$/,
  );
  if (request.method === "GET" && walletTransactionsMatch?.[1])
    return listTransactions(
      decodeURIComponent(walletTransactionsMatch[1]),
      url,
      env.BILLING_DB,
      auth,
      requestId,
    );
  return null;
}

async function createWallet(
  request: Request,
  env: Env,
  auth: AuthContext,
  requestId: string,
): Promise<Response> {
  const input = objectAt(await parseJsonObject(request), "wallet");
  rejectUnsupported(input);
  const externalCustomerId = requiredString(input, "external_customer_id");
  const customer = await env.BILLING_DB.prepare(
    "SELECT id, currency FROM customers WHERE organization_id = ? AND external_id = ? LIMIT 1",
  )
    .bind(auth.organizationId, externalCustomerId)
    .first<{ id: string; currency: string | null }>();
  if (!customer) throw new ApiError(404, "customer_not_found", "Customer was not found");
  const name = optionalString(input, "name");
  const code = optionalString(input, "code") ?? slug(name ?? "default");
  const currency = (optionalString(input, "currency") ?? customer.currency ?? "").toUpperCase();
  if (!/^[A-Z]{3}$/.test(currency))
    throw new ApiError(422, "validation_error", "currency must be an ISO currency code");
  if (customer.currency && customer.currency !== currency)
    throw new ApiError(422, "currency_mismatch", "Wallet and customer currencies must match");
  const rateAmount = positiveDecimal(input.rate_amount, "rate_amount");
  const priority =
    input.priority === undefined ? 50 : boundedInteger(input.priority, "priority", 1, 50);
  const expirationAt =
    input.expiration_at === undefined || input.expiration_at === null
      ? null
      : isoTimestamp(input.expiration_at, "expiration_at");
  const grantedCredits =
    input.granted_credits === undefined
      ? null
      : nonNegativeDecimal(input.granted_credits, "granted_credits");
  const normalized = {
    code,
    currency,
    expirationAt,
    externalCustomerId,
    grantedCredits,
    name,
    priority,
    rateAmount,
  };
  const requestHash = await sha256Hex(stableJson(normalized));
  const existing = await findActiveWalletByCode(env.BILLING_DB, customer.id, code);
  if (existing) {
    if (existing.request_sha256 !== requestHash)
      throw new ApiError(422, "value_already_exist", "Active wallet code already exists");
    return json({ wallet: serializeWallet(existing) }, { requestId });
  }
  const now = new Date().toISOString();
  const id = crypto.randomUUID();
  const exponent = currencyExponent(currency);
  const initialMinor = grantedCredits ? creditsToMinor(grantedCredits, rateAmount, exponent) : 0;
  const statements: D1PreparedStatement[] = [
    env.BILLING_DB.prepare(
      `INSERT INTO wallets
     (id, organization_id, customer_id, code, name, currency, currency_exponent, rate_amount,
      priority, balance_minor, consumed_minor, status, expiration_at, version, request_sha256,
      created_at, updated_at, terminated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 'active', ?, 1, ?, ?, ?, NULL)`,
    ).bind(
      id,
      auth.organizationId,
      customer.id,
      code,
      name,
      currency,
      exponent,
      rateAmount,
      priority,
      initialMinor,
      expirationAt,
      requestHash,
      now,
      now,
    ),
  ];
  let initialTransactionEvent: DomainEvent | null = null;
  if (grantedCredits && initialMinor > 0) {
    const initialTransactionId = await deterministicUuid("wallet-inbound", `${id}:initial`);
    statements.push(
      inboundStatement(env.BILLING_DB, {
        id: initialTransactionId,
        organizationId: auth.organizationId,
        walletId: id,
        walletVersion: 1,
        amountMinor: initialMinor,
        creditAmount: grantedCredits,
        priority,
        requestHash: await sha256Hex(stableJson({ id, initialMinor, grantedCredits })),
        now,
        idempotencyKey: `wallet-initial:${id}`,
        name: optionalString(input, "transaction_name"),
      }),
    );
    initialTransactionEvent = walletEvent(
      "wallet_transaction.created",
      initialTransactionId,
      1,
      auth.organizationId,
      requestId,
      now,
      {
        walletId: id,
        amountMinor: initialMinor,
        creditAmount: grantedCredits,
        transactionStatus: "granted",
      },
      "wallet_transaction",
    );
    statements.push(outboxStatement(env.BILLING_DB, auth.organizationId, initialTransactionEvent));
  }
  statements.push(
    env.BILLING_DB.prepare(
      "UPDATE customers SET currency = COALESCE(currency, ?), updated_at = ? WHERE id = ?",
    ).bind(currency, now, customer.id),
  );
  const event = walletEvent("wallet.created", id, 1, auth.organizationId, requestId, now, {
    customerId: customer.id,
    code,
    initialBalanceMinor: initialMinor,
  });
  statements.push(outboxStatement(env.BILLING_DB, auth.organizationId, event));
  try {
    await env.BILLING_DB.batch(statements);
  } catch (error) {
    const concurrent = await findActiveWalletByCode(env.BILLING_DB, customer.id, code);
    if (concurrent) {
      if (concurrent.request_sha256 === requestHash) {
        return json({ wallet: serializeWallet(concurrent) }, { requestId });
      }
      throw new ApiError(422, "value_already_exist", "Active wallet code already exists");
    }
    throw error;
  }
  await env.DOMAIN_EVENTS.send(event);
  if (initialTransactionEvent) await env.DOMAIN_EVENTS.send(initialTransactionEvent);
  const wallet = await findWallet(env.BILLING_DB, auth.organizationId, id);
  if (!wallet) throw new ApiError(500, "persistence_error", "Wallet was not persisted");
  return json({ wallet: serializeWallet(wallet) }, { requestId });
}

async function createTransaction(
  request: Request,
  env: Env,
  auth: AuthContext,
  requestId: string,
): Promise<Response> {
  const input = objectAt(await parseJsonObject(request), "wallet_transaction");
  if (
    input.paid_credits !== undefined ||
    input.voided_credits !== undefined ||
    input.payment_method !== undefined
  )
    throw new ApiError(
      422,
      "unsupported_wallet_payment",
      "Paid and voided credit mutations require the payment workflow",
    );
  const walletId = requiredString(input, "wallet_id");
  const credits = positiveDecimal(input.granted_credits, "granted_credits");
  const wallet = await findWallet(env.BILLING_DB, auth.organizationId, walletId);
  if (!wallet || wallet.status !== "active")
    throw new ApiError(404, "wallet_not_found", "Active wallet was not found");
  if (wallet.expiration_at && Date.parse(wallet.expiration_at) <= Date.now())
    throw new ApiError(422, "wallet_expired", "Wallet is expired");
  const priority =
    input.priority === undefined ? 50 : boundedInteger(input.priority, "priority", 1, 50);
  const idempotencyKey = request.headers.get("Idempotency-Key")?.trim() || null;
  if (!idempotencyKey)
    throw new ApiError(
      422,
      "idempotency_key_required",
      "Idempotency-Key is required for wallet mutations",
    );
  const amountMinor = creditsToMinor(credits, wallet.rate_amount, wallet.currency_exponent);
  const requestHash = await sha256Hex(stableJson({ amountMinor, credits, priority, walletId }));
  const replay = await findTransactionByKey(env.BILLING_DB, auth.organizationId, idempotencyKey);
  if (replay) {
    const stored = await env.BILLING_DB.prepare(
      "SELECT request_sha256 FROM wallet_transactions WHERE id = ?",
    )
      .bind(replay.id)
      .first<{ request_sha256: string }>();
    if (stored?.request_sha256 !== requestHash)
      throw new ApiError(
        409,
        "idempotency_conflict",
        "Idempotency key was reused with different input",
      );
    return json({ wallet_transactions: [serializeTransaction(replay)] }, { requestId });
  }
  const now = new Date().toISOString();
  const id = await deterministicUuid(
    "wallet-transaction",
    `${auth.organizationId}:${idempotencyKey}`,
  );
  const event = walletEvent(
    "wallet_transaction.created",
    id,
    1,
    auth.organizationId,
    requestId,
    now,
    { walletId, amountMinor, creditAmount: credits, transactionStatus: "granted" },
    "wallet_transaction",
  );
  try {
    const results = await env.BILLING_DB.batch([
      inboundStatement(env.BILLING_DB, {
        id,
        organizationId: auth.organizationId,
        walletId,
        walletVersion: wallet.version,
        amountMinor,
        creditAmount: credits,
        priority,
        requestHash,
        now,
        idempotencyKey,
        name: optionalString(input, "name"),
      }),
      env.BILLING_DB.prepare(
        "UPDATE wallets SET balance_minor = balance_minor + ?, version = version + 1, updated_at = ? WHERE id = ? AND organization_id = ? AND version = ? AND status = 'active'",
      ).bind(amountMinor, now, wallet.id, auth.organizationId, wallet.version),
      outboxStatement(env.BILLING_DB, auth.organizationId, event),
    ]);
    if ((results[1]?.meta.changes ?? 0) < 1) throw new Error("wallet_version_conflict");
  } catch (error) {
    const concurrent = await findTransactionByKey(
      env.BILLING_DB,
      auth.organizationId,
      idempotencyKey,
    );
    if (concurrent)
      return json({ wallet_transactions: [serializeTransaction(concurrent)] }, { requestId });
    const message = error instanceof Error ? error.message : "";
    if (message.includes("wallet_version_conflict")) {
      throw new ApiError(
        409,
        "wallet_version_conflict",
        "Wallet changed during the top-up; retry with the same idempotency key",
      );
    }
    throw error;
  }
  await env.DOMAIN_EVENTS.send(event);
  const transaction = await findTransaction(env.BILLING_DB, auth.organizationId, id);
  if (!transaction)
    throw new ApiError(500, "persistence_error", "Wallet transaction was not persisted");
  return json({ wallet_transactions: [serializeTransaction(transaction)] }, { requestId });
}

async function listWallets(
  url: URL,
  database: D1Database,
  auth: AuthContext,
  requestId: string,
): Promise<Response> {
  const external = url.searchParams.get("external_customer_id")?.trim() || null;
  const currency = url.searchParams.get("currency")?.trim().toUpperCase() || null;
  const conditions = ["w.organization_id = ?"];
  const bindings: unknown[] = [auth.organizationId];
  if (external) {
    conditions.push("c.external_id = ?");
    bindings.push(external);
  }
  if (currency) {
    conditions.push("w.currency = ?");
    bindings.push(currency);
  }
  const rows = await database
    .prepare(
      `${walletSelect()} WHERE ${conditions.join(" AND ")} ORDER BY w.priority, w.created_at, w.id`,
    )
    .bind(...bindings)
    .all<WalletRow>();
  return json(
    { wallets: rows.results.map(serializeWallet), meta: pagination(rows.results.length) },
    { requestId },
  );
}

async function showWallet(
  id: string,
  database: D1Database,
  auth: AuthContext,
  requestId: string,
): Promise<Response> {
  const wallet = await findWallet(database, auth.organizationId, id);
  if (!wallet) throw new ApiError(404, "wallet_not_found", "Wallet was not found");
  return json({ wallet: serializeWallet(wallet) }, { requestId });
}

async function terminateWallet(
  id: string,
  env: Env,
  auth: AuthContext,
  requestId: string,
): Promise<Response> {
  let wallet = await findWallet(env.BILLING_DB, auth.organizationId, id);
  if (!wallet) throw new ApiError(404, "wallet_not_found", "Wallet was not found");
  if (wallet.status === "active") {
    const now = new Date().toISOString();
    const event = walletEvent(
      "wallet.terminated",
      wallet.id,
      wallet.version + 1,
      auth.organizationId,
      requestId,
      now,
      { customerId: wallet.customer_id, balanceMinor: wallet.balance_minor },
    );
    const results = await env.BILLING_DB.batch([
      env.BILLING_DB.prepare(
        "UPDATE wallets SET status = 'terminated', terminated_at = ?, updated_at = ?, version = version + 1 WHERE id = ? AND organization_id = ? AND version = ?",
      ).bind(now, now, id, auth.organizationId, wallet.version),
      outboxStatement(env.BILLING_DB, auth.organizationId, event),
    ]);
    if ((results[0]?.meta.changes ?? 0) < 1)
      throw new ApiError(409, "wallet_version_conflict", "Wallet changed concurrently");
    await env.DOMAIN_EVENTS.send(event);
    wallet = await findWallet(env.BILLING_DB, auth.organizationId, id);
  }
  if (!wallet) throw new ApiError(500, "persistence_error", "Wallet disappeared");
  return json({ wallet: serializeWallet(wallet) }, { requestId });
}

async function listTransactions(
  walletId: string,
  _url: URL,
  database: D1Database,
  auth: AuthContext,
  requestId: string,
): Promise<Response> {
  const rows = await database
    .prepare(
      `${transactionSelect()} WHERE wt.organization_id = ? AND wt.wallet_id = ? ORDER BY wt.created_at DESC, wt.id DESC LIMIT 100`,
    )
    .bind(auth.organizationId, walletId)
    .all<WalletTransactionRow>();
  return json(
    {
      wallet_transactions: rows.results.map(serializeTransaction),
      meta: pagination(rows.results.length),
    },
    { requestId },
  );
}

async function showTransaction(
  id: string,
  database: D1Database,
  auth: AuthContext,
  requestId: string,
): Promise<Response> {
  const transaction = await findTransaction(database, auth.organizationId, id);
  if (!transaction)
    throw new ApiError(404, "wallet_transaction_not_found", "Wallet transaction was not found");
  return json({ wallet_transaction: serializeTransaction(transaction) }, { requestId });
}

function walletSelect() {
  return `SELECT w.id, w.customer_id, c.external_id AS external_customer_id, w.code, w.name, w.currency, w.currency_exponent, w.rate_amount, w.priority, w.balance_minor, w.consumed_minor, w.status, w.expiration_at, w.version, w.request_sha256, w.created_at, w.updated_at, w.terminated_at FROM wallets w JOIN customers c ON c.id = w.customer_id`;
}
function transactionSelect() {
  return `SELECT wt.id, wt.wallet_id, wt.invoice_id, wt.voided_invoice_id,
    wt.transaction_type, wt.transaction_status, wt.status, wt.source, wt.amount_minor,
    wt.credit_amount, wt.remaining_minor, wt.priority, wt.name, wt.settled_at,
    wt.failed_at, wt.created_at, w.rate_amount, w.currency_exponent
    FROM wallet_transactions wt JOIN wallets w ON w.id = wt.wallet_id`;
}
async function findWallet(db: D1Database, org: string, id: string) {
  return db
    .prepare(`${walletSelect()} WHERE w.organization_id = ? AND w.id = ? LIMIT 1`)
    .bind(org, id)
    .first<WalletRow>();
}
async function findActiveWalletByCode(db: D1Database, customerId: string, code: string) {
  return db
    .prepare(
      `${walletSelect()} WHERE w.customer_id = ? AND w.code = ? AND w.status = 'active' LIMIT 1`,
    )
    .bind(customerId, code)
    .first<WalletRow>();
}
async function findTransaction(db: D1Database, org: string, id: string) {
  return db
    .prepare(`${transactionSelect()} WHERE wt.organization_id = ? AND wt.id = ? LIMIT 1`)
    .bind(org, id)
    .first<WalletTransactionRow>();
}
async function findTransactionByKey(db: D1Database, org: string, key: string) {
  return db
    .prepare(
      `${transactionSelect()} WHERE wt.organization_id = ? AND wt.idempotency_key = ? LIMIT 1`,
    )
    .bind(org, key)
    .first<WalletTransactionRow>();
}

function inboundStatement(
  db: D1Database,
  value: {
    id: string;
    organizationId: string;
    walletId: string;
    walletVersion: number;
    amountMinor: number;
    creditAmount: string;
    priority: number;
    requestHash: string;
    now: string;
    idempotencyKey: string;
    name: string | null;
  },
) {
  return db
    .prepare(
      `INSERT INTO wallet_transactions (id, organization_id, wallet_id, transaction_type, transaction_status, status, source, amount_minor, credit_amount, remaining_minor, priority, wallet_version, idempotency_key, request_sha256, name, settled_at, created_at, updated_at) VALUES (?, ?, ?, 'inbound', 'granted', 'settled', 'manual', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      value.id,
      value.organizationId,
      value.walletId,
      value.amountMinor,
      value.creditAmount,
      value.amountMinor,
      value.priority,
      value.walletVersion,
      value.idempotencyKey,
      value.requestHash,
      value.name,
      value.now,
      value.now,
      value.now,
    );
}

function serializeWallet(row: WalletRow) {
  const credits = minorToCredits(row.balance_minor, row.rate_amount, row.currency_exponent);
  return {
    lago_id: row.id,
    lago_customer_id: row.customer_id,
    external_customer_id: row.external_customer_id,
    status: row.status,
    currency: row.currency,
    name: row.name,
    code: row.code,
    rate_amount: row.rate_amount,
    credits_balance: credits,
    credits_ongoing_balance: credits,
    credits_ongoing_usage_balance: credits,
    balance_cents: row.balance_minor,
    ongoing_balance_cents: row.balance_minor,
    ongoing_usage_balance_cents: row.balance_minor,
    consumed_credits: minorToCredits(row.consumed_minor, row.rate_amount, row.currency_exponent),
    created_at: row.created_at,
    expiration_at: row.expiration_at,
    terminated_at: row.terminated_at,
    priority: row.priority,
    invoice_requires_successful_payment: false,
    paid_top_up_min_amount_cents: null,
    paid_top_up_max_amount_cents: null,
    recurring_transaction_rules: [],
    applies_to: { fee_types: [], billable_metric_codes: [] },
    payment_method: { payment_method_id: null, payment_method_type: null },
  };
}
function serializeTransaction(row: WalletTransactionRow) {
  return {
    lago_id: row.id,
    lago_wallet_id: row.wallet_id,
    lago_invoice_id: row.invoice_id,
    lago_credit_note_id: null,
    lago_voided_invoice_id: row.voided_invoice_id,
    status: row.status,
    source: row.source,
    transaction_status: row.transaction_status,
    transaction_type: row.transaction_type,
    amount: Decimal.parse(row.amount_minor)
      .divide(Decimal.parse(10 ** row.currency_exponent))
      .toString(),
    credit_amount: row.credit_amount,
    remaining_amount_cents: row.remaining_minor,
    remaining_credit_amount:
      row.remaining_minor === null
        ? null
        : minorToCredits(row.remaining_minor, row.rate_amount, row.currency_exponent),
    priority: row.priority,
    settled_at: row.settled_at,
    failed_at: row.failed_at,
    created_at: row.created_at,
    invoice_requires_successful_payment: false,
    metadata: [],
    name: row.name,
    payment_method: { payment_method_id: null, payment_method_type: null },
  };
}

function creditsToMinor(credits: string, rate: string, exponent: number): number {
  const value = Decimal.parse(credits)
    .multiply(Decimal.parse(rate))
    .multiply(Decimal.parse(10 ** exponent));
  const rounded = Number(value.round());
  if (!Number.isSafeInteger(rounded) || rounded < 0)
    throw new ApiError(422, "invalid_wallet_amount", "Wallet amount exceeds supported precision");
  return rounded;
}
function minorToCredits(minor: number, rate: string, exponent: number) {
  return Decimal.parse(minor)
    .divide(Decimal.parse(10 ** exponent))
    .divide(Decimal.parse(rate))
    .toString();
}
function positiveDecimal(value: unknown, field: string) {
  const result = nonNegativeDecimal(value, field);
  if (Decimal.parse(result).compare(Decimal.zero()) <= 0)
    throw new ApiError(422, "validation_error", `${field} must be greater than zero`);
  return result;
}
function nonNegativeDecimal(value: unknown, field: string) {
  if ((typeof value !== "string" && typeof value !== "number") || String(value).trim() === "")
    throw new ApiError(422, "validation_error", `${field} must be a decimal`);
  try {
    const result = Decimal.parse(String(value));
    if (result.isNegative()) throw new Error();
    return result.toString();
  } catch {
    throw new ApiError(422, "validation_error", `${field} must be a non-negative decimal`);
  }
}
function boundedInteger(value: unknown, field: string, min: number, max: number) {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min || value > max)
    throw new ApiError(422, "validation_error", `${field} must be between ${min} and ${max}`);
  return value;
}
function isoTimestamp(value: unknown, field: string) {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value)))
    throw new ApiError(422, "validation_error", `${field} must be an ISO timestamp`);
  return new Date(value).toISOString();
}
function slug(value: string) {
  return (
    value
      .toLowerCase()
      .replaceAll(/[^a-z0-9]+/g, "_")
      .replaceAll(/^_+|_+$/g, "")
      .slice(0, 100) || "default"
  );
}
function currencyExponent(currency: string) {
  if (new Set(["BHD", "JOD", "KWD", "OMR", "TND"]).has(currency)) return 3;
  if (
    new Set([
      "BIF",
      "CLP",
      "DJF",
      "GNF",
      "JPY",
      "KMF",
      "KRW",
      "PYG",
      "RWF",
      "UGX",
      "VND",
      "VUV",
      "XAF",
      "XOF",
      "XPF",
    ]).has(currency)
  )
    return 0;
  return 2;
}
function pagination(total: number) {
  return {
    current_page: total === 0 ? 0 : 1,
    next_page: null,
    prev_page: null,
    total_pages: total === 0 ? 0 : 1,
    total_count: total,
  };
}
function rejectUnsupported(input: Record<string, unknown>) {
  for (const field of [
    "paid_credits",
    "recurring_transaction_rules",
    "applies_to",
    "payment_method",
    "invoice_custom_section",
    "metadata",
  ])
    if (input[field] !== undefined && input[field] !== null)
      throw new ApiError(
        422,
        "unsupported_wallet_feature",
        `${field} is not implemented for Cloudflare wallets`,
      );
}

function walletEvent(
  type: string,
  aggregateId: string,
  aggregateVersion: number,
  organizationId: string,
  correlationId: string,
  occurredAt: string,
  payload: Record<string, unknown>,
  aggregateType = "wallet",
): DomainEvent {
  return {
    id: `${type.replaceAll(".", "-")}:${aggregateId}:v${aggregateVersion}`,
    type,
    version: 1,
    aggregateType,
    aggregateId,
    aggregateVersion,
    occurredAt,
    causationId: correlationId,
    correlationId,
    payload: { organizationId, ...payload },
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
