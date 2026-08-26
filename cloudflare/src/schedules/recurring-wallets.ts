import { sha256Hex } from "../auth/api-key";
import type { DomainEvent } from "../domain-events";
import { deterministicUuid } from "../identifiers";
import { stableJson } from "../json";
import { createStripeWalletFunding } from "../providers/stripe";
import { Decimal } from "../rating/decimal";
import { reconcileProviderWalletFunding } from "../wallets/provider-funding";
import type { RecurringRuleInterval } from "../wallets/recurring-rules";

type DueRecurringRule = {
  id: string;
  organization_id: string;
  wallet_id: string;
  interval: RecurringRuleInterval;
  paid_credits: string;
  granted_credits: string;
  started_at: string | null;
  expiration_at: string | null;
  transaction_metadata_json: string;
  transaction_name: string | null;
  wallet_created_at: string;
  wallet_version: number;
  rate_amount: string;
  currency: string;
  currency_exponent: number;
  priority: number;
  timezone: string;
  payment_method_id: string | null;
};

type RecurringWalletFundingEnv = Pick<Env, "BILLING_DB"> & {
  WALLET_FUNDING_MODE?: string;
  STRIPE_NETWORK_MODE?: string;
  STRIPE_RESTRICTED_API_KEY?: string;
  STRIPE_ACCOUNT_CODE?: string;
  STRIPE_ORGANIZATION_ID?: string;
  STRIPE_LIVEMODE_ALLOWED?: string;
};

type ExpiringRecurringRule = {
  id: string;
  organization_id: string;
  wallet_id: string;
  version: number;
  storage_kind: "interval" | "threshold";
};

export async function expireRecurringWalletRules(
  env: Pick<Env, "BILLING_DB">,
  cutoff: string,
  correlationId: string,
): Promise<number> {
  const rows = await env.BILLING_DB.prepare(
    `SELECT id, organization_id, wallet_id, version, storage_kind FROM (
       SELECT id, organization_id, wallet_id, version, expiration_at,
              'interval' AS storage_kind
       FROM recurring_transaction_rules
       WHERE status = 'active' AND expiration_at IS NOT NULL AND expiration_at <= ?
       UNION ALL
       SELECT id, organization_id, wallet_id, version, expiration_at,
              'threshold' AS storage_kind
       FROM wallet_threshold_rules
       WHERE status = 'active' AND expiration_at IS NOT NULL AND expiration_at <= ?
     ) ORDER BY expiration_at, id LIMIT 100`,
  )
    .bind(cutoff, cutoff)
    .all<ExpiringRecurringRule>();
  let terminated = 0;
  for (const row of rows.results) {
    const table =
      row.storage_kind === "threshold" ? "wallet_threshold_rules" : "recurring_transaction_rules";
    const event = recurringRuleEvent(row, cutoff, correlationId);
    const results = await env.BILLING_DB.batch([
      env.BILLING_DB.prepare(
        `INSERT INTO outbox_events
         (event_id, organization_id, event_type, event_version, aggregate_type, aggregate_id,
          aggregate_version, causation_id, correlation_id, payload_json, occurred_at, published_at)
         SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL FROM ${table}
         WHERE id = ? AND organization_id = ? AND status = 'active' AND version = ?
           AND expiration_at IS NOT NULL AND expiration_at <= ?
         ON CONFLICT(event_id) DO NOTHING`,
      ).bind(
        event.id,
        row.organization_id,
        event.type,
        event.version,
        event.aggregateType,
        event.aggregateId,
        event.aggregateVersion,
        event.causationId,
        event.correlationId,
        stableJson(event.payload),
        event.occurredAt,
        row.id,
        row.organization_id,
        row.version,
        cutoff,
      ),
      env.BILLING_DB.prepare(
        `UPDATE ${table}
         SET status = 'terminated', terminated_at = COALESCE(terminated_at, ?),
             updated_at = ?, version = version + 1
         WHERE id = ? AND organization_id = ? AND status = 'active' AND version = ?
           AND expiration_at IS NOT NULL AND expiration_at <= ?`,
      ).bind(cutoff, cutoff, row.id, row.organization_id, row.version, cutoff),
    ]);
    terminated += results[1]?.meta.changes ?? 0;
  }
  return terminated;
}

export async function topUpDueRecurringWallets(
  env: RecurringWalletFundingEnv,
  triggeredAt: string,
  correlationId: string,
  fetcher: typeof fetch = fetch,
): Promise<number> {
  const triggeredDate = new Date(triggeredAt);
  if (!Number.isFinite(triggeredDate.getTime()))
    throw new Error("invalid_recurring_wallet_timestamp");
  const rows = await env.BILLING_DB.prepare(
    `SELECT rule.id, rule.organization_id, rule.wallet_id, rule.interval,
            COALESCE(funding.paid_credits, rule.paid_credits) AS paid_credits,
            rule.granted_credits,
            rule.started_at, rule.expiration_at, rule.transaction_metadata_json,
            rule.transaction_name, wallet.created_at AS wallet_created_at,
            wallet.version AS wallet_version, wallet.rate_amount, wallet.currency,
            wallet.currency_exponent, wallet.priority,
            COALESCE(customer.timezone, organization.timezone, 'UTC') AS timezone,
            funding.payment_method_id
     FROM recurring_transaction_rules rule
     LEFT JOIN provider_recurring_wallet_rule_funding funding
       ON funding.rule_id = rule.id AND funding.storage_kind = 'interval'
     JOIN wallets wallet ON wallet.id = rule.wallet_id
     JOIN customers customer ON customer.id = wallet.customer_id
     JOIN organizations organization ON organization.id = rule.organization_id
     WHERE rule.status = 'active' AND rule.trigger = 'interval' AND rule.method = 'fixed'
       AND wallet.status = 'active'
       AND (wallet.expiration_at IS NULL OR wallet.expiration_at > ?)
       AND (rule.expiration_at IS NULL OR rule.expiration_at > ?)
     ORDER BY rule.created_at, rule.id LIMIT 500`,
  )
    .bind(triggeredAt, triggeredAt)
    .all<DueRecurringRule>();
  let created = 0;
  for (const row of rows.results) {
    const localToday = localDate(triggeredDate, row.timezone);
    const walletCreatedDate = localDate(new Date(row.wallet_created_at), row.timezone);
    if (sameLocalDate(localToday, walletCreatedDate)) continue;
    const anchorInstant = new Date(row.started_at ?? row.wallet_created_at);
    if (anchorInstant.getTime() > triggeredDate.getTime()) continue;
    const anchor = localDate(anchorInstant, row.timezone);
    if (!isRecurringDateDue(row.interval, anchor, localToday)) continue;

    const paid = Decimal.parse(row.paid_credits);
    const granted = Decimal.parse(row.granted_credits);
    const totalCredits = paid.add(granted).toString();
    const amountMinor = creditsToMinor(totalCredits, row.rate_amount, row.currency_exponent);
    const providerChargeMinor = creditsToMinor(
      row.paid_credits,
      row.rate_amount,
      row.currency_exponent,
    );
    if (amountMinor === 0) continue;
    const localDateKey = formatLocalDate(localToday);
    const idempotencyKey = `wallet-interval:${row.wallet_id}:${localDateKey}`;
    const replay = await env.BILLING_DB.prepare(
      `SELECT id, status FROM wallet_transactions
       WHERE organization_id = ? AND idempotency_key = ? LIMIT 1`,
    )
      .bind(row.organization_id, idempotencyKey)
      .first<{ id: string; status: string }>();
    if (replay) {
      if (providerChargeMinor > 0 && replay.status === "pending")
        await executeRecurringWalletFunding(
          env,
          row,
          replay.id,
          providerChargeMinor,
          triggeredAt,
          fetcher,
        );
      continue;
    }
    const recentIntervalTransactions = await env.BILLING_DB.prepare(
      `SELECT id, created_at FROM wallet_transactions
       WHERE organization_id = ? AND wallet_id = ? AND source = 'interval'
         AND transaction_type = 'inbound'
       ORDER BY created_at DESC, id DESC LIMIT 32`,
    )
      .bind(row.organization_id, row.wallet_id)
      .all<{ id: string; created_at: string }>();
    if (
      recentIntervalTransactions.results.some((transaction) =>
        sameLocalDate(localDate(new Date(transaction.created_at), row.timezone), localToday),
      )
    )
      continue;

    const transactionId = await deterministicUuid(
      "wallet-interval-transaction",
      `${row.organization_id}:${idempotencyKey}`,
    );
    const requestHash = await sha256Hex(
      stableJson({
        ruleId: row.id,
        walletId: row.wallet_id,
        localDate: localDateKey,
        paidCredits: row.paid_credits,
        grantedCredits: row.granted_credits,
        amountMinor,
      }),
    );
    const event = walletTransactionEvent(
      row,
      transactionId,
      amountMinor,
      triggeredAt,
      correlationId,
    );
    if (providerChargeMinor > 0) {
      if (!recurringFundingEnabled(env, row)) continue;
      const operationId = await deterministicUuid("wallet-funding", transactionId);
      const providerAccountCode = env.STRIPE_ACCOUNT_CODE!.trim();
      await env.BILLING_DB.batch([
        env.BILLING_DB.prepare(
          `INSERT INTO wallet_transactions
           (id, organization_id, wallet_id, transaction_type, transaction_status, status, source,
            amount_minor, credit_amount, remaining_minor, priority, wallet_version,
            idempotency_key, request_sha256, name, created_at, updated_at,
            skip_invoice_custom_sections, metadata_json, recurring_transaction_rule_id)
           VALUES (?, ?, ?, 'inbound', 'purchased', 'pending', 'interval', ?, ?, ?, ?, ?, ?, ?, ?,
                   ?, ?, 0, ?, ?)`,
        ).bind(
          transactionId,
          row.organization_id,
          row.wallet_id,
          amountMinor,
          totalCredits,
          amountMinor,
          row.priority,
          row.wallet_version,
          idempotencyKey,
          requestHash,
          row.transaction_name,
          triggeredAt,
          triggeredAt,
          row.transaction_metadata_json,
          row.id,
        ),
        env.BILLING_DB.prepare(
          `INSERT INTO provider_wallet_funding_operations
           (id, organization_id, wallet_id, wallet_transaction_id, provider,
            provider_account_code, payment_method_id, idempotency_key, request_sha256,
            amount_minor, credit_amount, currency, status, created_at, updated_at,
            recurring_rule_id, recurring_trigger, provider_charge_minor)
           VALUES (?, ?, ?, ?, 'stripe', ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, 'interval', ?)`,
        ).bind(
          operationId,
          row.organization_id,
          row.wallet_id,
          transactionId,
          providerAccountCode,
          row.payment_method_id,
          `stripe-wallet-funding:${operationId}`,
          requestHash,
          amountMinor,
          totalCredits,
          row.currency,
          triggeredAt,
          triggeredAt,
          row.id,
          providerChargeMinor,
        ),
      ]);
      await executeRecurringWalletFunding(
        env,
        row,
        transactionId,
        providerChargeMinor,
        triggeredAt,
        fetcher,
      );
      created += 1;
      continue;
    }
    try {
      const results = await env.BILLING_DB.batch([
        env.BILLING_DB.prepare(
          `INSERT INTO wallet_transactions
           (id, organization_id, wallet_id, transaction_type, transaction_status, status, source,
            amount_minor, credit_amount, remaining_minor, priority, wallet_version,
            idempotency_key, request_sha256, name, settled_at, created_at, updated_at,
            skip_invoice_custom_sections, metadata_json, recurring_transaction_rule_id)
           VALUES (?, ?, ?, 'inbound', 'granted', 'settled', 'interval', ?, ?, ?, ?, ?, ?, ?, ?,
                   ?, ?, ?, 0, ?, ?)`,
        ).bind(
          transactionId,
          row.organization_id,
          row.wallet_id,
          amountMinor,
          row.granted_credits,
          amountMinor,
          row.priority,
          row.wallet_version,
          idempotencyKey,
          requestHash,
          row.transaction_name,
          triggeredAt,
          triggeredAt,
          triggeredAt,
          row.transaction_metadata_json,
          row.id,
        ),
        env.BILLING_DB.prepare(
          `UPDATE wallets SET balance_minor = balance_minor + ?,
               ongoing_balance_minor = ongoing_balance_minor + ?, version = version + 1,
               updated_at = ?
           WHERE id = ? AND organization_id = ? AND status = 'active' AND version = ?`,
        ).bind(
          amountMinor,
          amountMinor,
          triggeredAt,
          row.wallet_id,
          row.organization_id,
          row.wallet_version,
        ),
        outboxStatement(env.BILLING_DB, row.organization_id, event),
      ]);
      if ((results[1]?.meta.changes ?? 0) > 0) created += 1;
    } catch (error) {
      const concurrent = await env.BILLING_DB.prepare(
        `SELECT id FROM wallet_transactions
         WHERE organization_id = ? AND idempotency_key = ? LIMIT 1`,
      )
        .bind(row.organization_id, idempotencyKey)
        .first<{ id: string }>();
      if (!concurrent) throw error;
    }
  }
  return created;
}

function recurringFundingEnabled(env: RecurringWalletFundingEnv, row: DueRecurringRule): boolean {
  return (
    env.WALLET_FUNDING_MODE === "stripe_test" &&
    env.STRIPE_NETWORK_MODE === "enabled" &&
    env.STRIPE_LIVEMODE_ALLOWED !== "1" &&
    env.STRIPE_ORGANIZATION_ID?.trim() === row.organization_id &&
    Boolean(env.STRIPE_ACCOUNT_CODE?.trim()) &&
    Boolean(row.payment_method_id)
  );
}

async function executeRecurringWalletFunding(
  env: RecurringWalletFundingEnv,
  row: DueRecurringRule,
  transactionId: string,
  providerChargeMinor: number,
  now: string,
  fetcher: typeof fetch,
): Promise<void> {
  if (!recurringFundingEnabled(env, row)) return;
  const operation = await env.BILLING_DB.prepare(
    `SELECT id, status, idempotency_key FROM provider_wallet_funding_operations
     WHERE organization_id = ? AND wallet_transaction_id = ? LIMIT 1`,
  )
    .bind(row.organization_id, transactionId)
    .first<{ id: string; status: string; idempotency_key: string }>();
  if (!operation || operation.status === "succeeded") return;
  try {
    const result = await createStripeWalletFunding(
      env,
      {
        organizationId: row.organization_id,
        walletId: row.wallet_id,
        walletTransactionId: transactionId,
        amountMinor: providerChargeMinor,
        currency: row.currency,
        paymentMethodId: row.payment_method_id!,
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

export function isRecurringDateDue(
  interval: RecurringRuleInterval,
  anchor: LocalDate,
  current: LocalDate,
): boolean {
  if (compareLocalDate(current, anchor) < 0) return false;
  if (interval === "weekly") return weekdayNumber(current) === weekdayNumber(anchor);
  const monthDifference = (current.year - anchor.year) * 12 + current.month - anchor.month;
  const cadenceMonths =
    interval === "monthly" ? 1 : interval === "quarterly" ? 3 : interval === "semiannual" ? 6 : 12;
  return (
    monthDifference >= 0 &&
    monthDifference % cadenceMonths === 0 &&
    current.day === Math.min(anchor.day, daysInMonth(current.year, current.month))
  );
}

type LocalDate = { year: number; month: number; day: number };

function localDate(date: Date, timezone: string): LocalDate {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const value = (type: Intl.DateTimeFormatPartTypes) =>
    Number(parts.find((part) => part.type === type)?.value);
  const result = { year: value("year"), month: value("month"), day: value("day") };
  if (!result.year || !result.month || !result.day) throw new Error("invalid_recurring_local_date");
  return result;
}

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function weekdayNumber(date: LocalDate): number {
  return new Date(Date.UTC(date.year, date.month - 1, date.day)).getUTCDay();
}

function compareLocalDate(left: LocalDate, right: LocalDate): number {
  return formatLocalDate(left).localeCompare(formatLocalDate(right));
}

function sameLocalDate(left: LocalDate, right: LocalDate): boolean {
  return compareLocalDate(left, right) === 0;
}

function formatLocalDate(date: LocalDate): string {
  return `${date.year.toString().padStart(4, "0")}-${date.month
    .toString()
    .padStart(2, "0")}-${date.day.toString().padStart(2, "0")}`;
}

function creditsToMinor(credits: string, rate: string, exponent: number): number {
  const value = Decimal.parse(credits)
    .multiply(Decimal.parse(rate))
    .multiply(Decimal.parse(10 ** exponent));
  const rounded = Number(value.round());
  if (!Number.isSafeInteger(rounded) || rounded < 0) throw new Error("invalid_wallet_amount");
  return rounded;
}

function recurringRuleEvent(
  row: ExpiringRecurringRule,
  occurredAt: string,
  correlationId: string,
): DomainEvent {
  return {
    id: `wallet-recurring-rule-terminated:${row.id}:v${row.version + 1}`,
    type: "wallet.recurring_transaction_rule.terminated",
    version: 1,
    aggregateType: "recurring_transaction_rule",
    aggregateId: row.id,
    aggregateVersion: row.version + 1,
    occurredAt,
    causationId: correlationId,
    correlationId,
    payload: {
      organizationId: row.organization_id,
      walletId: row.wallet_id,
      recurringTransactionRuleId: row.id,
    },
  };
}

function walletTransactionEvent(
  row: DueRecurringRule,
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
      organizationId: row.organization_id,
      walletId: row.wallet_id,
      recurringTransactionRuleId: row.id,
      amountMinor,
      creditAmount: row.granted_credits,
      transactionStatus: "granted",
      source: "interval",
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
