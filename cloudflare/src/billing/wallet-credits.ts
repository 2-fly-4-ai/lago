import { deterministicUuid } from "../identifiers";
import { stableJson } from "../json";
import { Decimal } from "../rating/decimal";

type WalletRow = {
  id: string;
  rate_amount: string;
  currency_exponent: number;
  priority: number;
  balance_minor: number;
  version: number;
};
type LotRow = { id: string; remaining_minor: number; priority: number; created_at: string };

export type WalletAllocation = {
  walletId: string;
  walletVersion: number;
  amountMinor: number;
  creditAmount: string;
  transactionId: string;
  lots: Array<{ id: string; remainingBefore: number; amountMinor: number; consumptionId: string }>;
};

export async function calculateWalletAllocations(
  database: D1Database,
  organizationId: string,
  customerId: string,
  invoiceId: string,
  currency: string,
  amountDueMinor: number,
): Promise<WalletAllocation[]> {
  const wallets = await database
    .prepare(
      `SELECT id, rate_amount, currency_exponent, priority, balance_minor, version
     FROM wallets WHERE organization_id = ? AND customer_id = ? AND status = 'active'
       AND currency = ? AND balance_minor > 0
       AND (expiration_at IS NULL OR expiration_at > ?)
     ORDER BY priority, created_at, id`,
    )
    .bind(organizationId, customerId, currency, new Date().toISOString())
    .all<WalletRow>();
  const allocations: WalletAllocation[] = [];
  let remainingInvoice = amountDueMinor;
  for (const wallet of wallets.results) {
    if (remainingInvoice <= 0) break;
    const amountMinor = Math.min(remainingInvoice, wallet.balance_minor);
    if (amountMinor <= 0) continue;
    const transactionId = await deterministicUuid(
      "wallet-invoice-consumption",
      `${invoiceId}:${wallet.id}`,
    );
    const lots = await loadLots(database, wallet.id);
    let remainingWallet = amountMinor;
    const consumedLots: WalletAllocation["lots"] = [];
    for (const lot of lots) {
      if (remainingWallet <= 0) break;
      const amount = Math.min(remainingWallet, lot.remaining_minor);
      if (amount <= 0) continue;
      consumedLots.push({
        id: lot.id,
        remainingBefore: lot.remaining_minor,
        amountMinor: amount,
        consumptionId: await deterministicUuid(
          "wallet-lot-consumption",
          `${transactionId}:${lot.id}`,
        ),
      });
      remainingWallet -= amount;
    }
    if (remainingWallet !== 0) throw new Error("wallet_lot_balance_corrupt");
    allocations.push({
      walletId: wallet.id,
      walletVersion: wallet.version,
      amountMinor,
      creditAmount: minorToCredits(amountMinor, wallet.rate_amount, wallet.currency_exponent),
      transactionId,
      lots: consumedLots,
    });
    remainingInvoice -= amountMinor;
  }
  return allocations;
}

export function walletAllocationStatements(
  database: D1Database,
  organizationId: string,
  invoiceId: string,
  allocation: WalletAllocation,
  now: string,
  correlationId = invoiceId,
): D1PreparedStatement[] {
  const statements = [
    database
      .prepare(
        `INSERT INTO wallet_transactions
       (id, organization_id, wallet_id, invoice_id, transaction_type, transaction_status,
        status, source, amount_minor, credit_amount, remaining_minor, priority, wallet_version,
        request_sha256, settled_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'outbound', 'invoiced', 'settled', 'manual', ?, ?, NULL, 50, ?,
               ?, ?, ?, ?)`,
      )
      .bind(
        allocation.transactionId,
        organizationId,
        allocation.walletId,
        invoiceId,
        allocation.amountMinor,
        allocation.creditAmount,
        allocation.walletVersion,
        `invoice:${invoiceId}:${allocation.walletId}`,
        now,
        now,
        now,
      ),
    database
      .prepare(
        `UPDATE wallets SET balance_minor = balance_minor - ?, consumed_minor = consumed_minor + ?,
       version = version + 1, updated_at = ?
       WHERE id = ? AND organization_id = ? AND version = ? AND status = 'active'
         AND balance_minor >= ?`,
      )
      .bind(
        allocation.amountMinor,
        allocation.amountMinor,
        now,
        allocation.walletId,
        organizationId,
        allocation.walletVersion,
        allocation.amountMinor,
      ),
  ];
  for (const lot of allocation.lots) {
    statements.push(
      database
        .prepare(
          `INSERT INTO wallet_transaction_consumptions
         (id, organization_id, inbound_transaction_id, outbound_transaction_id,
          amount_minor, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          lot.consumptionId,
          organizationId,
          lot.id,
          allocation.transactionId,
          lot.amountMinor,
          now,
        ),
      database
        .prepare(
          `UPDATE wallet_transactions SET remaining_minor = remaining_minor - ?, updated_at = ?
         WHERE id = ? AND wallet_id = ? AND transaction_type = 'inbound'
           AND status = 'settled' AND remaining_minor = ?`,
        )
        .bind(lot.amountMinor, now, lot.id, allocation.walletId, lot.remainingBefore),
    );
  }
  const eventId = `wallet-credits-consumed:${allocation.transactionId}:v1`;
  statements.push(
    database
      .prepare(
        `INSERT INTO outbox_events
       (event_id, organization_id, event_type, event_version, aggregate_type,
        aggregate_id, aggregate_version, causation_id, correlation_id, payload_json,
        occurred_at, published_at)
       VALUES (?, ?, 'wallet.credits_consumed', 1, 'wallet', ?, ?, ?, ?, ?, ?, NULL)`,
      )
      .bind(
        eventId,
        organizationId,
        allocation.walletId,
        allocation.walletVersion + 1,
        invoiceId,
        correlationId,
        stableJson({
          organizationId,
          walletId: allocation.walletId,
          invoiceId,
          transactionId: allocation.transactionId,
          amountMinor: allocation.amountMinor,
        }),
        now,
      ),
  );
  return statements;
}

export async function walletRecreditStatements(
  database: D1Database,
  organizationId: string,
  invoiceId: string,
  now: string,
  correlationId = invoiceId,
): Promise<D1PreparedStatement[]> {
  const outbound = await database
    .prepare(
      `SELECT wt.id, wt.wallet_id, wt.amount_minor, w.version, w.rate_amount,
            w.currency_exponent, w.priority
     FROM wallet_transactions wt JOIN wallets w ON w.id = wt.wallet_id
     WHERE wt.organization_id = ? AND wt.invoice_id = ?
       AND wt.transaction_type = 'outbound' AND wt.transaction_status = 'invoiced'
     ORDER BY wt.created_at, wt.id`,
    )
    .bind(organizationId, invoiceId)
    .all<{
      id: string;
      wallet_id: string;
      amount_minor: number;
      version: number;
      rate_amount: string;
      currency_exponent: number;
      priority: number;
    }>();
  const statements: D1PreparedStatement[] = [];
  for (const transaction of outbound.results) {
    const recreditId = await deterministicUuid(
      "wallet-invoice-recredit",
      `${invoiceId}:${transaction.wallet_id}`,
    );
    statements.push(
      database
        .prepare(
          `INSERT INTO wallet_transactions
         (id, organization_id, wallet_id, voided_invoice_id, transaction_type,
          transaction_status, status, source, amount_minor, credit_amount, remaining_minor,
          priority, wallet_version, request_sha256, settled_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'inbound', 'voided', 'settled', 'manual', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          recreditId,
          organizationId,
          transaction.wallet_id,
          invoiceId,
          transaction.amount_minor,
          minorToCredits(
            transaction.amount_minor,
            transaction.rate_amount,
            transaction.currency_exponent,
          ),
          transaction.amount_minor,
          transaction.priority,
          transaction.version,
          `void:${invoiceId}:${transaction.wallet_id}`,
          now,
          now,
          now,
        ),
      database
        .prepare(
          `UPDATE wallets SET balance_minor = balance_minor + ?,
         ongoing_balance_minor = ongoing_balance_minor + ?,
         consumed_minor = MAX(0, consumed_minor - ?), version = version + 1, updated_at = ?
         WHERE id = ? AND organization_id = ? AND version = ?`,
        )
        .bind(
          transaction.amount_minor,
          transaction.amount_minor,
          transaction.amount_minor,
          now,
          transaction.wallet_id,
          organizationId,
          transaction.version,
        ),
      database
        .prepare(
          `INSERT INTO outbox_events
         (event_id, organization_id, event_type, event_version, aggregate_type,
          aggregate_id, aggregate_version, causation_id, correlation_id, payload_json,
          occurred_at, published_at)
         VALUES (?, ?, 'wallet.credits_recredited', 1, 'wallet', ?, ?, ?, ?, ?, ?, NULL)`,
        )
        .bind(
          `wallet-credits-recredited:${recreditId}:v1`,
          organizationId,
          transaction.wallet_id,
          transaction.version + 1,
          invoiceId,
          correlationId,
          stableJson({
            organizationId,
            walletId: transaction.wallet_id,
            voidedInvoiceId: invoiceId,
            transactionId: recreditId,
            amountMinor: transaction.amount_minor,
          }),
          now,
        ),
    );
  }
  return statements;
}

async function loadLots(database: D1Database, walletId: string) {
  const result = await database
    .prepare(
      `SELECT id, remaining_minor, priority, created_at FROM wallet_transactions
     WHERE wallet_id = ? AND transaction_type = 'inbound' AND status = 'settled'
       AND remaining_minor > 0
     ORDER BY priority,
       CASE WHEN transaction_status = 'granted' THEN 0 ELSE 1 END,
       created_at, id`,
    )
    .bind(walletId)
    .all<LotRow>();
  return [...result.results];
}

function minorToCredits(minor: number, rate: string, exponent: number) {
  return Decimal.parse(minor)
    .divide(Decimal.parse(10 ** exponent))
    .divide(Decimal.parse(rate))
    .toString();
}
