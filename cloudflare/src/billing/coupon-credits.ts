import { deterministicUuid } from "../identifiers";
import { stableJson } from "../json";
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

export function couponCreditStatements(
  database: D1Database,
  organizationId: string,
  invoiceId: string,
  currency: string,
  credits: CouponCredit[],
  now: string,
  correlationId: string,
): D1PreparedStatement[] {
  return credits.flatMap((credit) => [
    database
      .prepare(
        `INSERT INTO coupon_credits
         (id, organization_id, invoice_id, applied_coupon_id, applied_coupon_version,
          amount_minor, currency, before_taxes, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?)`,
      )
      .bind(
        credit.id,
        organizationId,
        invoiceId,
        credit.appliedCouponId,
        credit.expectedVersion,
        credit.amountMinor,
        currency,
        now,
      ),
    database
      .prepare(
        `UPDATE applied_coupons
         SET frequency_duration_remaining = ?,
             status = CASE WHEN ? = 1 THEN 'terminated' ELSE status END,
             termination_reason = CASE WHEN ? = 1 THEN 'consumed' ELSE termination_reason END,
             terminated_at = CASE WHEN ? = 1 THEN ? ELSE terminated_at END,
             version = version + 1, updated_at = ?
         WHERE id = ? AND organization_id = ? AND status = 'active' AND version = ?`,
      )
      .bind(
        credit.nextRemaining,
        credit.terminates ? 1 : 0,
        credit.terminates ? 1 : 0,
        credit.terminates ? 1 : 0,
        now,
        now,
        credit.appliedCouponId,
        organizationId,
        credit.expectedVersion,
      ),
    database
      .prepare(
        `INSERT INTO outbox_events
         (event_id, organization_id, event_type, event_version, aggregate_type,
          aggregate_id, aggregate_version, causation_id, correlation_id, payload_json,
          occurred_at, published_at)
         VALUES (?, ?, 'coupon.consumed', 1, 'applied_coupon', ?, ?, ?, ?, ?, ?, NULL)`,
      )
      .bind(
        `coupon-consumed:${credit.id}:v1`,
        organizationId,
        credit.appliedCouponId,
        credit.expectedVersion + 1,
        invoiceId,
        correlationId,
        stableJson({
          organizationId,
          invoiceId,
          appliedCouponId: credit.appliedCouponId,
          couponCreditId: credit.id,
          amountMinor: credit.amountMinor,
          currency,
        }),
        now,
      ),
  ]);
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
