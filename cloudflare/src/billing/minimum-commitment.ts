import { deterministicUuid } from "../identifiers";
import { Decimal } from "../rating/decimal";

type CommitmentRow = {
  id: string;
  amount_minor: number;
  invoice_display_name: string | null;
};

export type CommitmentLine = {
  id: string;
  commitmentId: string;
  description: string;
  amountMinor: number;
  preciseAmountMinor: string;
};

export async function calculateMinimumCommitmentLine(
  database: D1Database,
  planId: string,
  invoiceId: string,
  roundedFeesMinor: number,
  preciseFeesMinor: Decimal,
): Promise<CommitmentLine | null> {
  const commitment = await database
    .prepare(
      `SELECT id, amount_minor, invoice_display_name
       FROM minimum_commitments WHERE plan_id = ? LIMIT 1`,
    )
    .bind(planId)
    .first<CommitmentRow>();
  if (!commitment || roundedFeesMinor >= commitment.amount_minor) return null;
  const preciseAmount = Decimal.parse(commitment.amount_minor).subtract(preciseFeesMinor);
  return {
    id: await deterministicUuid("minimum-commitment-line", `${invoiceId}:${commitment.id}`),
    commitmentId: commitment.id,
    description: commitment.invoice_display_name ?? "Minimum commitment",
    amountMinor: commitment.amount_minor - roundedFeesMinor,
    preciseAmountMinor: preciseAmount.compare(Decimal.zero()) > 0 ? preciseAmount.toString() : "0",
  };
}
