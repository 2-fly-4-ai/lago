import { sha256Hex } from "../auth/api-key";
import {
  calculateSubscriptionInvoice,
  findBillableSubscription,
  walletFeeBuckets,
} from "../billing/subscription-invoice-calculation";
import {
  projectedUsageByWallet,
  type WalletApplicability,
  type WalletFeeBucket,
  type WalletFeeType,
} from "../billing/wallet-limitations";
import type { DomainEvent } from "../domain-events";
import { deterministicUuid } from "../identifiers";
import { stableJson } from "../json";
import { createStripeWalletFunding } from "../providers/stripe";
import { Decimal } from "../rating/decimal";
import { reconcileProviderWalletFunding } from "../wallets/provider-funding";

type ProjectionEnv = Pick<Env, "BILLING_DB"> & {
  WALLET_FUNDING_MODE?: string;
  STRIPE_NETWORK_MODE?: string;
  STRIPE_RESTRICTED_API_KEY?: string;
  STRIPE_ACCOUNT_CODE?: string;
  STRIPE_ORGANIZATION_ID?: string;
  STRIPE_LIVEMODE_ALLOWED?: string;
};

type ProjectionCustomer = { id: string; organization_id: string };

type ProjectionWallet = {
  id: string;
  code: string;
  organization_id: string;
  customer_id: string;
  balance_minor: number;
  ongoing_balance_minor: number;
  depleted_ongoing_balance: number;
  ongoing_balance_version: number;
  version: number;
  rate_amount: string;
  currency: string;
  currency_exponent: number;
  priority: number;
  allowed_fee_types_json: string;
};

type ThresholdRule = {
  id: string;
  wallet_id: string;
  paid_credits: string;
  granted_credits: string;
  threshold_credits: string;
  transaction_metadata_json: string;
  transaction_name: string | null;
  payment_method_id: string | null;
};

type StoredThresholdFunding = {
  id: string;
  organization_id: string;
  wallet_id: string;
  wallet_transaction_id: string;
  idempotency_key: string;
  provider_charge_minor: number;
  currency: string;
  payment_method_id: string;
};

export type WalletProjectionRun = {
  customers: number;
  wallets: number;
  thresholdTopUps: number;
};

export async function refreshWalletOngoingBalances(
  env: ProjectionEnv,
  refreshedAt: string,
  correlationId: string,
  fetcher: typeof fetch = fetch,
): Promise<WalletProjectionRun> {
  if (!Number.isFinite(Date.parse(refreshedAt))) throw new Error("invalid_wallet_projection_time");
  await resumeThresholdWalletFundings(env, refreshedAt, fetcher);
  const result: WalletProjectionRun = { customers: 0, wallets: 0, thresholdTopUps: 0 };
  let cursor = "";
  for (;;) {
    const customers = await env.BILLING_DB.prepare(
      `SELECT customer.id, customer.organization_id
       FROM customers customer
       WHERE customer.id > ? AND EXISTS (
         SELECT 1 FROM wallets wallet
         WHERE wallet.customer_id = customer.id AND wallet.status = 'active'
           AND (wallet.expiration_at IS NULL OR wallet.expiration_at > ?)
       )
       ORDER BY customer.id LIMIT 100`,
    )
      .bind(cursor, refreshedAt)
      .all<ProjectionCustomer>();
    if (customers.results.length === 0) break;
    for (const customer of customers.results) {
      const projected = await projectCustomerWallets(
        env,
        customer,
        refreshedAt,
        correlationId,
        fetcher,
      );
      result.customers += 1;
      result.wallets += projected.wallets;
      result.thresholdTopUps += projected.thresholdTopUps;
    }
    cursor = customers.results.at(-1)!.id;
  }
  return result;
}

export async function projectedCustomerLiabilityMinor(
  database: D1Database,
  customerId: string,
): Promise<number> {
  const subscriptionRows = await database
    .prepare(
      `SELECT id FROM subscriptions
       WHERE customer_id = ? AND status IN ('active', 'past_due')
         AND current_period_start IS NOT NULL AND current_period_end IS NOT NULL
       ORDER BY generation, id`,
    )
    .bind(customerId)
    .all<{ id: string }>();
  let currentLiabilityMinor = 0;
  for (const row of subscriptionRows.results) {
    const subscription = await findBillableSubscription(database, row.id);
    if (!subscription) continue;
    const calculation = await calculateSubscriptionInvoice(
      database,
      subscription,
      `wallet-projection:${subscription.id}:${subscription.current_period_start}:${subscription.current_period_end}`,
      `wallet-projection:${subscription.current_period_start}:${subscription.current_period_end}`,
      subscription.current_period_start,
      subscription.current_period_end,
    );
    currentLiabilityMinor = safeAdd(
      currentLiabilityMinor,
      safeAdd(calculation.totalDueMinor, calculation.prepaidCreditMinor),
    );
  }
  const drafts = await database
    .prepare(
      `SELECT COALESCE(SUM(total_due_minor + prepaid_credit_minor), 0) AS amount_minor
       FROM invoices WHERE customer_id = ? AND status = 'draft'`,
    )
    .bind(customerId)
    .first<{ amount_minor: number }>();
  return safeAdd(currentLiabilityMinor, drafts?.amount_minor ?? 0);
}

async function projectCustomerWallets(
  env: ProjectionEnv,
  customer: ProjectionCustomer,
  refreshedAt: string,
  correlationId: string,
  fetcher: typeof fetch,
): Promise<{ wallets: number; thresholdTopUps: number }> {
  const database = env.BILLING_DB;
  const wallets = await database
    .prepare(
      `SELECT id, organization_id, customer_id, balance_minor, ongoing_balance_minor,
              depleted_ongoing_balance, ongoing_balance_version, version, rate_amount, currency,
              currency_exponent, priority, code, allowed_fee_types_json
       FROM wallets
       WHERE customer_id = ? AND organization_id = ? AND status = 'active'
         AND (expiration_at IS NULL OR expiration_at > ?)
       ORDER BY priority, created_at, id`,
    )
    .bind(customer.id, customer.organization_id, refreshedAt)
    .all<ProjectionWallet>();
  if (wallets.results.length === 0) return { wallets: 0, thresholdTopUps: 0 };

  const metricTargets = await projectionWalletTargets(
    database,
    wallets.results.map((wallet) => wallet.id),
  );
  const applicability: WalletApplicability[] = wallets.results.map((wallet) => ({
    id: wallet.id,
    code: wallet.code,
    allowedFeeTypes: new Set(parseFeeTypes(wallet.allowed_fee_types_json)),
    billableMetricIds: metricTargets.get(wallet.id) ?? new Set<string>(),
  }));
  const usageByWallet = await projectedCustomerUsageByWallet(database, customer.id, applicability);
  const rules = await activeThresholdRules(database, customer, refreshedAt);
  const statements: D1PreparedStatement[] = [];
  const providerFundings: Array<{
    operationId: string;
    transactionId: string;
    wallet: ProjectionWallet;
    rule: ThresholdRule;
    providerChargeMinor: number;
  }> = [];
  let thresholdTopUps = 0;
  for (const wallet of wallets.results) {
    const usageMinor = usageByWallet.get(wallet.id) ?? 0;
    const ongoingMinor = wallet.balance_minor - usageMinor;
    const depleted = ongoingMinor <= 0 ? 1 : 0;
    const projectionVersion = wallet.ongoing_balance_version + 1;
    const runId = `${correlationId}:${wallet.id}:p${projectionVersion}`;
    statements.push(
      database
        .prepare(
          `INSERT INTO wallet_projection_guards
           (run_id, wallet_id, expected_wallet_version, created_at) VALUES (?, ?, ?, ?)`,
        )
        .bind(runId, wallet.id, wallet.version, refreshedAt),
      database
        .prepare(
          `UPDATE wallets
           SET ongoing_balance_minor = ?, ongoing_usage_balance_minor = ?,
               depleted_ongoing_balance = ?, last_ongoing_balance_sync_at = ?,
               ongoing_balance_version = ongoing_balance_version + 1
           WHERE id = ? AND organization_id = ? AND status = 'active' AND version = ?`,
        )
        .bind(
          ongoingMinor,
          usageMinor,
          depleted,
          refreshedAt,
          wallet.id,
          wallet.organization_id,
          wallet.version,
        ),
    );
    if (wallet.depleted_ongoing_balance === 0 && depleted === 1) {
      statements.push(
        outboxStatement(
          database,
          wallet.organization_id,
          depletedEvent(wallet, projectionVersion, refreshedAt, correlationId),
        ),
      );
    }

    const rule = rules.get(wallet.id);
    if (rule && (await thresholdIsDue(database, wallet, rule, ongoingMinor))) {
      const totalCredits = Decimal.parse(rule.paid_credits)
        .add(Decimal.parse(rule.granted_credits))
        .toString();
      const amountMinor = creditsToMinor(
        totalCredits,
        wallet.rate_amount,
        wallet.currency_exponent,
      );
      const providerChargeMinor = creditsToMinor(
        rule.paid_credits,
        wallet.rate_amount,
        wallet.currency_exponent,
      );
      if (amountMinor > 0) {
        const idempotencyKey = `wallet-threshold:${rule.id}:p${projectionVersion}`;
        const transactionId = await deterministicUuid(
          "wallet-threshold-transaction",
          `${wallet.organization_id}:${idempotencyKey}`,
        );
        const requestHash = await sha256Hex(
          stableJson({
            ruleId: rule.id,
            walletId: wallet.id,
            projectionVersion,
            paidCredits: rule.paid_credits,
            grantedCredits: rule.granted_credits,
            amountMinor,
          }),
        );
        if (
          providerChargeMinor > 0 &&
          thresholdFundingEnabled(env, customer.organization_id, rule)
        ) {
          const operationId = await deterministicUuid("wallet-funding", transactionId);
          statements.push(
            database
              .prepare(
                `INSERT INTO wallet_transactions
                 (id, organization_id, wallet_id, transaction_type, transaction_status, status,
                  source, amount_minor, credit_amount, remaining_minor, priority, wallet_version,
                  idempotency_key, request_sha256, name, created_at, updated_at,
                  skip_invoice_custom_sections, metadata_json, wallet_threshold_rule_id)
                 VALUES (?, ?, ?, 'inbound', 'purchased', 'pending', 'threshold', ?, ?, ?, ?, ?, ?, ?,
                         ?, ?, ?, 0, ?, ?)`,
              )
              .bind(
                transactionId,
                wallet.organization_id,
                wallet.id,
                amountMinor,
                totalCredits,
                amountMinor,
                wallet.priority,
                wallet.version,
                idempotencyKey,
                requestHash,
                rule.transaction_name,
                refreshedAt,
                refreshedAt,
                rule.transaction_metadata_json,
                rule.id,
              ),
            database
              .prepare(
                `INSERT INTO provider_wallet_funding_operations
                 (id, organization_id, wallet_id, wallet_transaction_id, provider,
                  provider_account_code, payment_method_id, idempotency_key, request_sha256,
                  amount_minor, credit_amount, currency, status, created_at, updated_at,
                  recurring_rule_id, recurring_trigger, provider_charge_minor)
                 VALUES (?, ?, ?, ?, 'stripe', ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, 'threshold', ?)`,
              )
              .bind(
                operationId,
                wallet.organization_id,
                wallet.id,
                transactionId,
                env.STRIPE_ACCOUNT_CODE!.trim(),
                rule.payment_method_id,
                `stripe-wallet-funding:${operationId}`,
                requestHash,
                amountMinor,
                totalCredits,
                wallet.currency,
                refreshedAt,
                refreshedAt,
                rule.id,
                providerChargeMinor,
              ),
          );
          providerFundings.push({
            operationId,
            transactionId,
            wallet,
            rule,
            providerChargeMinor,
          });
        }
        if (providerChargeMinor === 0) {
          statements.push(
            database
              .prepare(
                `INSERT INTO wallet_transactions
               (id, organization_id, wallet_id, transaction_type, transaction_status, status,
                source, amount_minor, credit_amount, remaining_minor, priority, wallet_version,
                idempotency_key, request_sha256, name, settled_at, created_at, updated_at,
                skip_invoice_custom_sections, metadata_json, wallet_threshold_rule_id)
               VALUES (?, ?, ?, 'inbound', 'granted', 'settled', 'threshold', ?, ?, ?, ?, ?, ?, ?,
                       ?, ?, ?, ?, 0, ?, ?)`,
              )
              .bind(
                transactionId,
                wallet.organization_id,
                wallet.id,
                amountMinor,
                rule.granted_credits,
                amountMinor,
                wallet.priority,
                wallet.version,
                idempotencyKey,
                requestHash,
                rule.transaction_name,
                refreshedAt,
                refreshedAt,
                refreshedAt,
                rule.transaction_metadata_json,
                rule.id,
              ),
            database
              .prepare(
                `UPDATE wallets
               SET balance_minor = balance_minor + ?, ongoing_balance_minor = ongoing_balance_minor + ?,
                   version = version + 1, updated_at = ?
               WHERE id = ? AND organization_id = ? AND status = 'active' AND version = ?`,
              )
              .bind(
                amountMinor,
                amountMinor,
                refreshedAt,
                wallet.id,
                wallet.organization_id,
                wallet.version,
              ),
            outboxStatement(
              database,
              wallet.organization_id,
              thresholdTransactionEvent(
                wallet,
                rule,
                transactionId,
                amountMinor,
                refreshedAt,
                correlationId,
              ),
            ),
          );
          thresholdTopUps += 1;
        }
      }
    }
    statements.push(
      database
        .prepare("DELETE FROM wallet_projection_guards WHERE run_id = ? AND wallet_id = ?")
        .bind(runId, wallet.id),
    );
  }
  statements.push(
    database
      .prepare(
        "UPDATE customers SET awaiting_wallet_refresh = 0 WHERE id = ? AND organization_id = ?",
      )
      .bind(customer.id, customer.organization_id),
  );
  await database.batch(statements);
  for (const funding of providerFundings) {
    await executeThresholdWalletFunding(env, funding, refreshedAt, fetcher);
    thresholdTopUps += 1;
  }
  return { wallets: wallets.results.length, thresholdTopUps };
}

function thresholdFundingEnabled(
  env: ProjectionEnv,
  organizationId: string,
  rule: ThresholdRule,
): boolean {
  return (
    env.WALLET_FUNDING_MODE === "stripe_test" &&
    env.STRIPE_NETWORK_MODE === "enabled" &&
    env.STRIPE_LIVEMODE_ALLOWED !== "1" &&
    env.STRIPE_ORGANIZATION_ID?.trim() === organizationId &&
    Boolean(env.STRIPE_ACCOUNT_CODE?.trim()) &&
    Boolean(rule.payment_method_id)
  );
}

async function resumeThresholdWalletFundings(
  env: ProjectionEnv,
  now: string,
  fetcher: typeof fetch,
): Promise<void> {
  if (env.WALLET_FUNDING_MODE !== "stripe_test" || env.STRIPE_NETWORK_MODE !== "enabled") return;
  const operations = await env.BILLING_DB.prepare(
    `SELECT operation.id, operation.organization_id, operation.wallet_id,
            operation.wallet_transaction_id, operation.idempotency_key,
            COALESCE(operation.provider_charge_minor, operation.amount_minor) AS provider_charge_minor,
            operation.currency, operation.payment_method_id
     FROM provider_wallet_funding_operations operation
     JOIN wallet_transactions transaction_row ON transaction_row.id = operation.wallet_transaction_id
     WHERE operation.recurring_trigger = 'threshold'
       AND operation.status IN ('pending', 'failed') AND transaction_row.status = 'pending'
     ORDER BY operation.created_at, operation.id LIMIT 100`,
  ).all<StoredThresholdFunding>();
  for (const operation of operations.results)
    await executeStoredThresholdFunding(env, operation, now, fetcher);
}

async function executeThresholdWalletFunding(
  env: ProjectionEnv,
  funding: {
    operationId: string;
    transactionId: string;
    wallet: ProjectionWallet;
    rule: ThresholdRule;
    providerChargeMinor: number;
  },
  now: string,
  fetcher: typeof fetch,
): Promise<void> {
  if (!funding.rule.payment_method_id) return;
  await executeStoredThresholdFunding(
    env,
    {
      id: funding.operationId,
      organization_id: funding.wallet.organization_id,
      wallet_id: funding.wallet.id,
      wallet_transaction_id: funding.transactionId,
      idempotency_key: `stripe-wallet-funding:${funding.operationId}`,
      provider_charge_minor: funding.providerChargeMinor,
      currency: funding.wallet.currency,
      payment_method_id: funding.rule.payment_method_id,
    },
    now,
    fetcher,
  );
}

async function executeStoredThresholdFunding(
  env: ProjectionEnv,
  operation: StoredThresholdFunding,
  now: string,
  fetcher: typeof fetch,
): Promise<void> {
  if (
    env.STRIPE_ORGANIZATION_ID?.trim() !== operation.organization_id ||
    !env.STRIPE_ACCOUNT_CODE?.trim()
  )
    return;
  try {
    const result = await createStripeWalletFunding(
      env,
      {
        organizationId: operation.organization_id,
        walletId: operation.wallet_id,
        walletTransactionId: operation.wallet_transaction_id,
        amountMinor: operation.provider_charge_minor,
        currency: operation.currency,
        paymentMethodId: operation.payment_method_id,
        idempotencyKey: operation.idempotency_key,
      },
      fetcher,
    );
    await reconcileProviderWalletFunding(env.BILLING_DB, operation.id, result, now);
  } catch (error) {
    await env.BILLING_DB.prepare(
      `UPDATE provider_wallet_funding_operations
       SET status = 'failed', failure_code = 'stripe_request_failed', failure_message = ?,
           updated_at = ? WHERE id = ? AND status IN ('pending', 'failed')`,
    )
      .bind(
        error instanceof Error ? error.message.slice(0, 500) : "Stripe request failed",
        now,
        operation.id,
      )
      .run();
    throw error;
  }
}

async function projectedCustomerUsageByWallet(
  database: D1Database,
  customerId: string,
  wallets: WalletApplicability[],
): Promise<Map<string, number>> {
  const result = new Map(wallets.map((wallet) => [wallet.id, 0]));
  const subscriptionRows = await database
    .prepare(
      `SELECT id FROM subscriptions
       WHERE customer_id = ? AND status IN ('active', 'past_due')
         AND current_period_start IS NOT NULL AND current_period_end IS NOT NULL
       ORDER BY generation, id`,
    )
    .bind(customerId)
    .all<{ id: string }>();
  for (const row of subscriptionRows.results) {
    const subscription = await findBillableSubscription(database, row.id);
    if (!subscription) continue;
    const calculation = await calculateSubscriptionInvoice(
      database,
      subscription,
      `wallet-projection:${subscription.id}:${subscription.current_period_start}:${subscription.current_period_end}`,
      `wallet-projection:${subscription.current_period_start}:${subscription.current_period_end}`,
      subscription.current_period_start,
      subscription.current_period_end,
    );
    addProjectedUsage(
      result,
      projectedUsageByWallet(
        wallets,
        walletFeeBuckets(calculation.lines, calculation.invoiceTaxes),
        safeAdd(calculation.totalDueMinor, calculation.prepaidCreditMinor),
      ),
    );
  }

  const drafts = await database
    .prepare(
      `SELECT id, total_due_minor + prepaid_credit_minor AS liability_minor
       FROM invoices WHERE customer_id = ? AND status = 'draft' ORDER BY id`,
    )
    .bind(customerId)
    .all<{ id: string; liability_minor: number }>();
  for (const draft of drafts.results) {
    const buckets = await persistedInvoiceFeeBuckets(database, draft.id);
    addProjectedUsage(
      result,
      projectedUsageByWallet(
        wallets,
        buckets.length > 0
          ? buckets
          : [
              {
                amountMinor: draft.liability_minor,
                billableMetricId: null,
                feeType: "subscription",
              },
            ],
        draft.liability_minor,
      ),
    );
  }
  return result;
}

function addProjectedUsage(target: Map<string, number>, additions: Map<string, number>): void {
  for (const [walletId, amountMinor] of additions)
    target.set(walletId, safeAdd(target.get(walletId) ?? 0, amountMinor));
}

async function persistedInvoiceFeeBuckets(
  database: D1Database,
  invoiceId: string,
): Promise<WalletFeeBucket[]> {
  const rows = await database
    .prepare(
      `SELECT line.line_type, line.amount_minor,
              CASE WHEN line.source_type = 'charge'
                   THEN COALESCE(json_extract(line.metadata_json, '$.billableMetricId'),
                                 charge.billable_metric_id)
              END AS billable_metric_id,
              CASE WHEN line.source_type = 'charge'
                   THEN json_extract(line.metadata_json, '$.targetWalletCode')
              END AS target_wallet_code,
              COALESCE((SELECT SUM(tax.amount_minor) FROM invoice_line_taxes tax
                        WHERE tax.invoice_line_id = line.id), 0) AS tax_minor
       FROM invoice_lines line
       LEFT JOIN charges charge ON charge.id = line.source_id
       WHERE line.invoice_id = ? ORDER BY line.id`,
    )
    .bind(invoiceId)
    .all<{
      line_type: string;
      amount_minor: number;
      billable_metric_id: string | null;
      target_wallet_code: string | null;
      tax_minor: number;
    }>();
  return rows.results.map((row) => ({
    amountMinor: safeAdd(row.amount_minor, row.tax_minor),
    billableMetricId: row.billable_metric_id,
    feeType: projectionFeeType(row.line_type),
    targetWalletCode: row.target_wallet_code,
  }));
}

async function projectionWalletTargets(database: D1Database, walletIds: string[]) {
  const result = new Map<string, Set<string>>();
  if (walletIds.length === 0) return result;
  const placeholders = walletIds.map(() => "?").join(", ");
  const rows = await database
    .prepare(
      `SELECT target.wallet_id, target.billable_metric_id FROM wallet_targets target
       JOIN billable_metrics metric ON metric.id = target.billable_metric_id
       WHERE target.wallet_id IN (${placeholders}) AND metric.active = 1
       ORDER BY target.wallet_id, target.billable_metric_id`,
    )
    .bind(...walletIds)
    .all<{ wallet_id: string; billable_metric_id: string }>();
  for (const row of rows.results) {
    const values = result.get(row.wallet_id) ?? new Set<string>();
    values.add(row.billable_metric_id);
    result.set(row.wallet_id, values);
  }
  return result;
}

function parseFeeTypes(value: string): WalletFeeType[] {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item): item is WalletFeeType =>
      ["charge", "add_on", "subscription", "credit", "commitment", "fixed_charge"].includes(
        String(item),
      ),
    );
  } catch {
    return [];
  }
}

function projectionFeeType(lineType: string): WalletFeeType {
  if (lineType === "usage") return "charge";
  if (["subscription", "fixed_charge", "commitment"].includes(lineType))
    return lineType as WalletFeeType;
  throw new Error("unsupported_wallet_projection_line_type");
}

async function activeThresholdRules(
  database: D1Database,
  customer: ProjectionCustomer,
  refreshedAt: string,
): Promise<Map<string, ThresholdRule>> {
  const rows = await database
    .prepare(
      `SELECT rule.id, rule.wallet_id,
              COALESCE(funding.paid_credits, rule.paid_credits) AS paid_credits,
              rule.granted_credits, rule.threshold_credits,
              rule.transaction_metadata_json, rule.transaction_name, funding.payment_method_id
       FROM wallet_threshold_rules rule
       LEFT JOIN provider_recurring_wallet_rule_funding funding
         ON funding.rule_id = rule.id AND funding.storage_kind = 'threshold'
       JOIN wallets wallet ON wallet.id = rule.wallet_id
       WHERE wallet.customer_id = ? AND rule.organization_id = ? AND rule.status = 'active'
         AND rule.method = 'fixed'
         AND (rule.started_at IS NULL OR rule.started_at <= ?)
         AND (rule.expiration_at IS NULL OR rule.expiration_at > ?)`,
    )
    .bind(customer.id, customer.organization_id, refreshedAt, refreshedAt)
    .all<ThresholdRule>();
  return new Map(rows.results.map((row) => [row.wallet_id, row]));
}

async function thresholdIsDue(
  database: D1Database,
  wallet: ProjectionWallet,
  rule: ThresholdRule,
  ongoingMinor: number,
): Promise<boolean> {
  const thresholdMinor = creditsToMinor(
    rule.threshold_credits,
    wallet.rate_amount,
    wallet.currency_exponent,
  );
  if (ongoingMinor > thresholdMinor) return false;
  const pending = await database
    .prepare(
      `SELECT COALESCE(SUM(amount_minor), 0) AS amount_minor
       FROM wallet_transactions WHERE wallet_id = ? AND status = 'pending'`,
    )
    .bind(wallet.id)
    .first<{ amount_minor: number }>();
  return safeAdd(ongoingMinor, pending?.amount_minor ?? 0) <= thresholdMinor;
}

function creditsToMinor(credits: string, rate: string, exponent: number): number {
  const value = Decimal.parse(credits)
    .multiply(Decimal.parse(rate))
    .multiply(Decimal.parse(10 ** exponent));
  const rounded = Number(value.round());
  if (!Number.isSafeInteger(rounded) || rounded < 0) throw new Error("invalid_wallet_amount");
  return rounded;
}

function safeAdd(left: number, right: number): number {
  const value = left + right;
  if (!Number.isSafeInteger(value)) throw new Error("wallet_projection_amount_overflow");
  return value;
}

function depletedEvent(
  wallet: ProjectionWallet,
  projectionVersion: number,
  occurredAt: string,
  correlationId: string,
): DomainEvent {
  return {
    id: `wallet-depleted-ongoing-balance:${wallet.id}:p${projectionVersion}`,
    type: "wallet.depleted_ongoing_balance",
    version: 1,
    aggregateType: "wallet",
    aggregateId: wallet.id,
    aggregateVersion: wallet.version,
    occurredAt,
    causationId: correlationId,
    correlationId,
    payload: { organizationId: wallet.organization_id, walletId: wallet.id },
  };
}

function thresholdTransactionEvent(
  wallet: ProjectionWallet,
  rule: ThresholdRule,
  transactionId: string,
  amountMinor: number,
  occurredAt: string,
  correlationId: string,
): DomainEvent {
  return {
    id: `wallet-transaction-created:${transactionId}:v1`,
    type: "wallet_transaction.created",
    version: 1,
    aggregateType: "wallet_transaction",
    aggregateId: transactionId,
    aggregateVersion: 1,
    occurredAt,
    causationId: correlationId,
    correlationId,
    payload: {
      organizationId: wallet.organization_id,
      walletId: wallet.id,
      recurringTransactionRuleId: rule.id,
      transactionStatus: "granted",
      source: "threshold",
      amountMinor,
      creditAmount: rule.granted_credits,
    },
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
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
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
    );
}
