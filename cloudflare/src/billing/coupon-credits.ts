import { deterministicUuid } from "../identifiers";
import { Decimal } from "../rating/decimal";

type ApplicableCouponRow = {
  id: string;
  amount_minor: number | null;
  currency: string | null;
  percentage_rate: string | null;
  frequency: string;
  frequency_duration: number | null;
  frequency_duration_remaining: number | null;
  version: number;
  coupon_type: string;
  consumed_minor: number;
};

export type CouponCredit = {
  id: string;
  appliedCouponId: string;
  amountMinor: number;
  expectedVersion: number;
  nextRemaining: number | null;
  terminates: boolean;
};

export async function calculateCouponCredits(
  database: D1Database,
  organizationId: string,
  customerId: string,
  invoiceId: string,
  currency: string,
  subtotalMinor: number,
): Promise<CouponCredit[]> {
  const result = await database
    .prepare(
      `SELECT ac.id, ac.amount_minor, ac.currency, ac.percentage_rate, ac.frequency,
              ac.frequency_duration, ac.frequency_duration_remaining, ac.version,
              cp.coupon_type,
              COALESCE((SELECT SUM(cc.amount_minor) FROM coupon_credits cc
                JOIN invoices i ON i.id = cc.invoice_id
                WHERE cc.applied_coupon_id = ac.id AND i.status <> 'voided'), 0) AS consumed_minor
       FROM applied_coupons ac JOIN coupons cp ON cp.id = ac.coupon_id
       WHERE ac.organization_id = ? AND ac.customer_id = ? AND ac.status = 'active'
         AND cp.status = 'active'
         AND (cp.expiration = 'no_expiration' OR cp.expiration_at > ?)
       ORDER BY ac.created_at, ac.id`,
    )
    .bind(organizationId, customerId, new Date().toISOString())
    .all<ApplicableCouponRow>();
  const credits: CouponCredit[] = [];
  let remainingInvoice = subtotalMinor;
  for (const coupon of result.results) {
    if (remainingInvoice <= 0) break;
    if (coupon.coupon_type === "fixed_amount" && coupon.currency !== currency) continue;
    const available = availableAmount(coupon, remainingInvoice);
    const amount = Math.min(remainingInvoice, available);
    if (amount <= 0) continue;
    const nextRemaining =
      coupon.frequency === "recurring"
        ? Math.max(0, (coupon.frequency_duration_remaining ?? 0) - 1)
        : null;
    const terminates =
      (coupon.frequency === "once" &&
        (coupon.coupon_type === "percentage" || amount >= available)) ||
      (coupon.frequency === "recurring" && nextRemaining === 0);
    credits.push({
      id: await deterministicUuid("coupon-credit", `${invoiceId}:${coupon.id}`),
      appliedCouponId: coupon.id,
      amountMinor: amount,
      expectedVersion: coupon.version,
      nextRemaining,
      terminates,
    });
    remainingInvoice -= amount;
  }
  return credits;
}

function availableAmount(coupon: ApplicableCouponRow, baseMinor: number): number {
  if (coupon.coupon_type === "percentage") {
    const precise = Decimal.parse(baseMinor)
      .multiply(Decimal.parse(coupon.percentage_rate ?? "0"))
      .divideByInteger(100n);
    return safeMinor(precise);
  }
  const available =
    coupon.frequency === "once"
      ? Math.max(0, (coupon.amount_minor ?? 0) - coupon.consumed_minor)
      : (coupon.amount_minor ?? 0);
  return available;
}

function safeMinor(value: Decimal): number {
  const rounded = Number(value.round());
  if (!Number.isSafeInteger(rounded) || rounded < 0) throw new Error("invalid_coupon_amount");
  return rounded;
}
