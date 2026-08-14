import type { AuthContext } from "../auth/api-key";
import { sha256Hex } from "../auth/api-key";
import type { DomainEvent } from "../domain-events";
import { ApiError, json, objectAt, optionalString, parseJsonObject, requiredString } from "../http";
import { deterministicUuid } from "../identifiers";
import { stableJson } from "../json";
import { Decimal } from "../rating/decimal";
import {
  normalizeSubscriptionCustomSections,
  resolveCustomSectionIds,
  resourceCustomSectionLinkStatements,
  serializeAppliedCustomSectionsForResources,
  type SerializedAppliedCustomSection,
} from "../subscriptions/custom-sections";

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
  skip_invoice_custom_sections: number;
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
  skip_invoice_custom_sections: number;
  request_sha256: string;
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
    if (request.method === "PUT") return updateWallet(id, request, env, auth, requestId);
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
  const customSections = normalizeSubscriptionCustomSections(input.invoice_custom_section);
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
  const customSectionIds = await resolveCustomSectionIds(
    env.BILLING_DB,
    auth.organizationId,
    customSections?.codes,
  );
  const normalized = {
    code,
    currency,
    expirationAt,
    externalCustomerId,
    grantedCredits,
    name,
    priority,
    rateAmount,
    invoiceCustomSection: customSections
      ? { skip: customSections.skip === true, sectionIds: customSectionIds ?? null }
      : null,
  };
  const requestHash = await sha256Hex(stableJson(normalized));
  const existing = await findActiveWalletByCode(env.BILLING_DB, customer.id, code);
  if (existing) {
    if (existing.request_sha256 !== requestHash)
      throw new ApiError(422, "value_already_exist", "Active wallet code already exists");
    return json({ wallet: await serializeWallet(env.BILLING_DB, existing) }, { requestId });
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
      created_at, updated_at, terminated_at, skip_invoice_custom_sections)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 'active', ?, 1, ?, ?, ?, NULL, ?)`,
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
      customSections?.skip === true ? 1 : 0,
    ),
  ];
  statements.push(
    ...resourceCustomSectionLinkStatements(
      env.BILLING_DB,
      { table: "wallets_invoice_custom_sections", ownerColumn: "wallet_id" },
      auth.organizationId,
      id,
      customSectionIds,
      now,
      false,
    ),
  );
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
        skipInvoiceCustomSections: false,
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
        return json({ wallet: await serializeWallet(env.BILLING_DB, concurrent) }, { requestId });
      }
      throw new ApiError(422, "value_already_exist", "Active wallet code already exists");
    }
    throw error;
  }
  await env.DOMAIN_EVENTS.send(event);
  if (initialTransactionEvent) await env.DOMAIN_EVENTS.send(initialTransactionEvent);
  const wallet = await findWallet(env.BILLING_DB, auth.organizationId, id);
  if (!wallet) throw new ApiError(500, "persistence_error", "Wallet was not persisted");
  return json({ wallet: await serializeWallet(env.BILLING_DB, wallet) }, { requestId });
}

async function createTransaction(
  request: Request,
  env: Env,
  auth: AuthContext,
  requestId: string,
): Promise<Response> {
  const input = objectAt(await parseJsonObject(request), "wallet_transaction");
  const customSections = normalizeSubscriptionCustomSections(input.invoice_custom_section);
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
  const customSectionIds = await resolveCustomSectionIds(
    env.BILLING_DB,
    auth.organizationId,
    customSections?.codes,
  );
  const requestHash = await sha256Hex(
    stableJson({
      amountMinor,
      credits,
      priority,
      walletId,
      invoiceCustomSection: customSections
        ? { skip: customSections.skip === true, sectionIds: customSectionIds ?? null }
        : null,
    }),
  );
  const replay = await findTransactionByKey(env.BILLING_DB, auth.organizationId, idempotencyKey);
  if (replay) {
    if (replay.request_sha256 !== requestHash)
      throw new ApiError(
        409,
        "idempotency_conflict",
        "Idempotency key was reused with different input",
      );
    return json(
      { wallet_transactions: [await serializeTransaction(env.BILLING_DB, replay)] },
      { requestId },
    );
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
    const statements: D1PreparedStatement[] = [
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
        skipInvoiceCustomSections: customSections?.skip === true,
      }),
      ...resourceCustomSectionLinkStatements(
        env.BILLING_DB,
        {
          table: "wallet_transactions_invoice_custom_sections",
          ownerColumn: "wallet_transaction_id",
        },
        auth.organizationId,
        id,
        customSectionIds,
        now,
        false,
      ),
      env.BILLING_DB.prepare(
        "UPDATE wallets SET balance_minor = balance_minor + ?, version = version + 1, updated_at = ? WHERE id = ? AND organization_id = ? AND version = ? AND status = 'active'",
      ).bind(amountMinor, now, wallet.id, auth.organizationId, wallet.version),
      outboxStatement(env.BILLING_DB, auth.organizationId, event),
    ];
    const walletUpdateIndex = statements.length - 2;
    const results = await env.BILLING_DB.batch(statements);
    if ((results[walletUpdateIndex]?.meta.changes ?? 0) < 1)
      throw new Error("wallet_version_conflict");
  } catch (error) {
    const concurrent = await findTransactionByKey(
      env.BILLING_DB,
      auth.organizationId,
      idempotencyKey,
    );
    if (concurrent) {
      if (concurrent.request_sha256 !== requestHash)
        throw new ApiError(
          409,
          "idempotency_conflict",
          "Idempotency key was reused with different input",
        );
      return json(
        { wallet_transactions: [await serializeTransaction(env.BILLING_DB, concurrent)] },
        { requestId },
      );
    }
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
  return json(
    { wallet_transactions: [await serializeTransaction(env.BILLING_DB, transaction)] },
    { requestId },
  );
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
  const serializedWallets = await serializeWallets(database, rows.results);
  return json({ wallets: serializedWallets, meta: pagination(rows.results.length) }, { requestId });
}

async function showWallet(
  id: string,
  database: D1Database,
  auth: AuthContext,
  requestId: string,
): Promise<Response> {
  const wallet = await findWallet(database, auth.organizationId, id);
  if (!wallet) throw new ApiError(404, "wallet_not_found", "Wallet was not found");
  return json({ wallet: await serializeWallet(database, wallet) }, { requestId });
}

async function updateWallet(
  id: string,
  request: Request,
  env: Env,
  auth: AuthContext,
  requestId: string,
): Promise<Response> {
  const wallet = await findWallet(env.BILLING_DB, auth.organizationId, id);
  if (!wallet || wallet.status !== "active")
    throw new ApiError(404, "wallet_not_found", "Active wallet was not found");
  const input = objectAt(await parseJsonObject(request), "wallet");
  const unsupported = Object.keys(input).find((field) => field !== "invoice_custom_section");
  if (unsupported)
    throw new ApiError(
      422,
      "unsupported_wallet_update_feature",
      `${unsupported} is not implemented for Cloudflare wallet updates`,
    );
  const customSections = normalizeSubscriptionCustomSections(input.invoice_custom_section);
  if (!customSections)
    throw new ApiError(422, "validation_error", "invoice_custom_section is required");
  const resolvedIds = await resolveCustomSectionIds(
    env.BILLING_DB,
    auth.organizationId,
    customSections.codes,
  );
  const currentlySkipped = wallet.skip_invoice_custom_sections === 1;
  const nextSkipped =
    customSections.skip === true ? true : customSections.skip === false ? false : currentlySkipped;
  const replaceSections =
    customSections.skip === true ||
    (customSections.codes !== undefined && (!currentlySkipped || customSections.skip === false));
  const nextSectionIds = customSections.skip === true ? [] : (resolvedIds ?? []);
  const currentSectionIds = replaceSections
    ? await selectedWalletCustomSectionIds(env.BILLING_DB, wallet.id)
    : [];
  if (
    currentlySkipped === nextSkipped &&
    (!replaceSections || sameStringSets(currentSectionIds, nextSectionIds))
  )
    return json({ wallet: await serializeWallet(env.BILLING_DB, wallet) }, { requestId });

  const now = new Date().toISOString();
  const nextVersion = wallet.version + 1;
  const event = walletEvent(
    "wallet.updated",
    wallet.id,
    nextVersion,
    auth.organizationId,
    requestId,
    now,
    {
      customerId: wallet.customer_id,
      skipInvoiceCustomSections: nextSkipped,
      invoiceCustomSectionIds: replaceSections ? nextSectionIds : undefined,
    },
  );
  const statements: D1PreparedStatement[] = [
    env.BILLING_DB.prepare(
      `UPDATE wallets
       SET skip_invoice_custom_sections = ?, version = version + 1, updated_at = ?
       WHERE id = ? AND organization_id = ? AND status = 'active' AND version = ?`,
    ).bind(nextSkipped ? 1 : 0, now, wallet.id, auth.organizationId, wallet.version),
  ];
  if (replaceSections) {
    statements.push(
      env.BILLING_DB.prepare(
        `DELETE FROM wallets_invoice_custom_sections
         WHERE wallet_id = ? AND organization_id = ?
           AND EXISTS (SELECT 1 FROM wallets WHERE id = ? AND organization_id = ?
                       AND version = ? AND updated_at = ?)`,
      ).bind(wallet.id, auth.organizationId, wallet.id, auth.organizationId, nextVersion, now),
    );
    for (const sectionId of nextSectionIds) {
      statements.push(
        env.BILLING_DB.prepare(
          `INSERT OR IGNORE INTO wallets_invoice_custom_sections
           (wallet_id, invoice_custom_section_id, organization_id, created_at)
           SELECT ?, ?, ?, ? FROM wallets
           WHERE id = ? AND organization_id = ? AND version = ? AND updated_at = ?`,
        ).bind(
          wallet.id,
          sectionId,
          auth.organizationId,
          now,
          wallet.id,
          auth.organizationId,
          nextVersion,
          now,
        ),
      );
    }
  }
  const outboxIndex = statements.length;
  statements.push(
    conditionalWalletOutboxStatement(env.BILLING_DB, auth.organizationId, event, nextVersion, now),
  );
  const results = await env.BILLING_DB.batch(statements);
  if ((results[0]?.meta.changes ?? 0) < 1 || results[outboxIndex]?.meta.changes !== 1)
    throw new ApiError(409, "wallet_version_conflict", "Wallet changed concurrently");
  await env.DOMAIN_EVENTS.send(event);
  const updated = await findWallet(env.BILLING_DB, auth.organizationId, wallet.id);
  if (!updated) throw new ApiError(500, "persistence_error", "Wallet disappeared");
  return json({ wallet: await serializeWallet(env.BILLING_DB, updated) }, { requestId });
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
  return json({ wallet: await serializeWallet(env.BILLING_DB, wallet) }, { requestId });
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
  const serializedTransactions = await serializeTransactions(database, rows.results);
  return json(
    {
      wallet_transactions: serializedTransactions,
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
  return json(
    { wallet_transaction: await serializeTransaction(database, transaction) },
    { requestId },
  );
}

function walletSelect() {
  return `SELECT w.id, w.customer_id, c.external_id AS external_customer_id, w.code, w.name,
    w.currency, w.currency_exponent, w.rate_amount, w.priority, w.balance_minor, w.consumed_minor,
    w.status, w.expiration_at, w.skip_invoice_custom_sections, w.version, w.request_sha256,
    w.created_at, w.updated_at, w.terminated_at
    FROM wallets w JOIN customers c ON c.id = w.customer_id`;
}
function transactionSelect() {
  return `SELECT wt.id, wt.wallet_id, wt.invoice_id, wt.voided_invoice_id,
    wt.transaction_type, wt.transaction_status, wt.status, wt.source, wt.amount_minor,
    wt.credit_amount, wt.remaining_minor, wt.priority, wt.name, wt.settled_at,
    wt.failed_at, wt.created_at, wt.skip_invoice_custom_sections, wt.request_sha256,
    w.rate_amount, w.currency_exponent
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

async function selectedWalletCustomSectionIds(database: D1Database, walletId: string) {
  const rows = await database
    .prepare(
      `SELECT invoice_custom_section_id FROM wallets_invoice_custom_sections
       WHERE wallet_id = ? ORDER BY invoice_custom_section_id`,
    )
    .bind(walletId)
    .all<{ invoice_custom_section_id: string }>();
  return rows.results.map((row) => row.invoice_custom_section_id);
}

function sameStringSets(left: string[], right: string[]) {
  const leftSorted = [...left].sort();
  const rightSorted = [...right].sort();
  return (
    leftSorted.length === rightSorted.length &&
    leftSorted.every((value, index) => value === rightSorted[index])
  );
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
    skipInvoiceCustomSections: boolean;
  },
) {
  return db
    .prepare(
      `INSERT INTO wallet_transactions
       (id, organization_id, wallet_id, transaction_type, transaction_status, status, source,
        amount_minor, credit_amount, remaining_minor, priority, wallet_version, idempotency_key,
        request_sha256, name, settled_at, created_at, updated_at, skip_invoice_custom_sections)
       VALUES (?, ?, ?, 'inbound', 'granted', 'settled', 'manual', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
      value.skipInvoiceCustomSections ? 1 : 0,
    );
}

async function serializeWallet(database: D1Database, row: WalletRow) {
  const serialized = await serializeWallets(database, [row]);
  return serialized[0]!;
}

async function serializeWallets(database: D1Database, rows: WalletRow[]) {
  const sections = await serializeAppliedCustomSectionsForResources(
    database,
    { table: "wallets_invoice_custom_sections", ownerColumn: "wallet_id" },
    rows.map((row) => row.id),
  );
  return rows.map((row) => serializeWalletRow(row, sections.get(row.id) ?? []));
}

function serializeWalletRow(row: WalletRow, sections: SerializedAppliedCustomSection[]) {
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
    applied_invoice_custom_sections: sections,
    applies_to: { fee_types: [], billable_metric_codes: [] },
    payment_method: { payment_method_id: null, payment_method_type: null },
  };
}

async function serializeTransaction(database: D1Database, row: WalletTransactionRow) {
  const serialized = await serializeTransactions(database, [row]);
  return serialized[0]!;
}

async function serializeTransactions(database: D1Database, rows: WalletTransactionRow[]) {
  const sections = await serializeAppliedCustomSectionsForResources(
    database,
    {
      table: "wallet_transactions_invoice_custom_sections",
      ownerColumn: "wallet_transaction_id",
    },
    rows.map((row) => row.id),
  );
  return rows.map((row) => serializeTransactionRow(row, sections.get(row.id) ?? []));
}

function serializeTransactionRow(
  row: WalletTransactionRow,
  sections: SerializedAppliedCustomSection[],
) {
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
    applied_invoice_custom_sections: sections,
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

function conditionalWalletOutboxStatement(
  database: D1Database,
  organizationId: string,
  event: DomainEvent,
  expectedVersion: number,
  expectedUpdatedAt: string,
): D1PreparedStatement {
  return database
    .prepare(
      `INSERT INTO outbox_events
       (event_id, organization_id, event_type, event_version, aggregate_type, aggregate_id,
        aggregate_version, causation_id, correlation_id, payload_json, occurred_at, published_at)
       SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL FROM wallets
       WHERE id = ? AND organization_id = ? AND version = ? AND updated_at = ?
       ON CONFLICT(event_id) DO NOTHING`,
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
      event.aggregateId,
      organizationId,
      expectedVersion,
      expectedUpdatedAt,
    );
}
