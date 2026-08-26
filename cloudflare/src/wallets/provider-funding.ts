import type { StripeWalletFundingResult } from "../providers/stripe";

export async function reconcileProviderWalletFunding(
  database: D1Database,
  operationId: string,
  result: StripeWalletFundingResult,
  now: string,
): Promise<void> {
  const settled = result.status === "succeeded";
  const failed = result.status === "failed" || result.status === "canceled";
  await database.batch([
    database
      .prepare(
        `UPDATE provider_wallet_funding_operations
         SET provider_payment_intent_id = ?, status = ?, client_secret = ?, failure_code = ?,
             failure_message = ?, updated_at = ? WHERE id = ?`,
      )
      .bind(
        result.id,
        result.status,
        result.clientSecret,
        result.failureCode,
        result.failureMessage,
        now,
        operationId,
      ),
    database
      .prepare(
        `UPDATE wallets SET balance_minor = balance_minor + (
           SELECT amount_minor FROM provider_wallet_funding_operations WHERE id = ?
         ), ongoing_balance_minor = ongoing_balance_minor + (
           SELECT amount_minor FROM provider_wallet_funding_operations WHERE id = ?
         ), version = version + 1, updated_at = ?
         WHERE id = (SELECT wallet_id FROM provider_wallet_funding_operations WHERE id = ?)
           AND ? = 1 AND EXISTS (
             SELECT 1 FROM provider_wallet_funding_operations operation
             JOIN wallet_transactions transaction_row
               ON transaction_row.id = operation.wallet_transaction_id
             WHERE operation.id = ? AND transaction_row.status = 'pending'
           )`,
      )
      .bind(operationId, operationId, now, operationId, settled ? 1 : 0, operationId),
    database
      .prepare(
        `UPDATE wallet_transactions
         SET status = CASE WHEN ? = 1 THEN 'settled'
                           WHEN ? = 1 THEN 'failed' ELSE status END,
             settled_at = CASE WHEN ? = 1 THEN ? ELSE settled_at END,
             failed_at = CASE WHEN ? = 1 THEN ? ELSE failed_at END,
             updated_at = ?
         WHERE id = (SELECT wallet_transaction_id FROM provider_wallet_funding_operations WHERE id = ?)
           AND status = 'pending'`,
      )
      .bind(
        settled ? 1 : 0,
        failed ? 1 : 0,
        settled ? 1 : 0,
        now,
        failed ? 1 : 0,
        now,
        now,
        operationId,
      ),
  ]);
}
