import { deterministicUuid } from "../identifiers";
import { stableJson } from "../json";
import { Decimal } from "../rating/decimal";

type ApplicableCouponRow = {
  id: string;
  coupon_id: string;
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

type CouponTargetRow = {
  coupon_id: string;
  target_type: "plan" | "billable_metric";
  target_id: string;
};

export type CouponApplicableLine = {
  id: string;
  amountMinor: number;
  billableMetricId?: string | null;
};

export type CouponLineDiscount = {
  lineId: string;
  amountMinor: number;
};

export type CouponCredit = {
  id: string;
  appliedCouponId: string;
  amountMinor: number;
  expectedVersion: number;
  nextRemaining: number | null;
  terminates: boolean;
  lineDiscounts: CouponLineDiscount[];
};

export async function calculateCouponCredits(
  database: D1Database,
  organizationId: string,
  customerId: string,
  invoiceId: string,
  currency: string,
  lines: CouponApplicableLine[],
  planId?: string,
): Promise<CouponCredit[]> {
  const result = await database
    .prepare(
      `SELECT ac.id, ac.coupon_id, ac.amount_minor, ac.currency, ac.percentage_rate, ac.frequency,
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
  const targetRows =
    result.results.length === 0
      ? { results: [] as CouponTargetRow[] }
      : await database
          .prepare(
            `SELECT coupon_id, target_type, target_id FROM coupon_targets
             WHERE organization_id = ? AND coupon_id IN (${result.results.map(() => "?").join(", ")})
             ORDER BY created_at, target_id`,
          )
          .bind(organizationId, ...result.results.map((coupon) => coupon.coupon_id))
          .all<CouponTargetRow>();
  const plan = planId
    ? await database
        .prepare("SELECT id, parent_id FROM plans WHERE id = ? AND organization_id = ? LIMIT 1")
        .bind(planId, organizationId)
        .first<{ id: string; parent_id: string | null }>()
    : null;
  const eligiblePlanIds = new Set([plan?.id, plan?.parent_id].filter(Boolean));
  const targetsByCoupon = new Map<string, CouponTargetRow[]>();
  for (const target of targetRows.results) {
    const targets = targetsByCoupon.get(target.coupon_id) ?? [];
    targets.push(target);
    targetsByCoupon.set(target.coupon_id, targets);
  }
  const credits: CouponCredit[] = [];
  const remainingByLine = new Map(lines.map((line) => [line.id, line.amountMinor]));
  for (const coupon of result.results) {
    if ([...remainingByLine.values()].every((amount) => amount <= 0)) break;
    if (coupon.coupon_type === "fixed_amount" && coupon.currency !== currency) continue;
    const targets = targetsByCoupon.get(coupon.coupon_id) ?? [];
    const planTargets = new Set(
      targets.filter((target) => target.target_type === "plan").map((target) => target.target_id),
    );
    const metricTargets = new Set(
      targets
        .filter((target) => target.target_type === "billable_metric")
        .map((target) => target.target_id),
    );
    const eligibleLines = lines.filter((line) => {
      if (metricTargets.size > 0)
        return Boolean(line.billableMetricId && metricTargets.has(line.billableMetricId));
      if (planTargets.size > 0)
        return [...eligiblePlanIds].some((eligiblePlanId) => planTargets.has(eligiblePlanId!));
      return true;
    });
    const eligibleBase = eligibleLines.reduce(
      (sum, line) => sum + (remainingByLine.get(line.id) ?? 0),
      0,
    );
    if (eligibleBase <= 0) continue;
    const available = availableAmount(coupon, eligibleBase);
    const amount = Math.min(eligibleBase, available);
    if (amount <= 0) continue;
    const lineDiscounts = allocateLineDiscounts(
      eligibleLines,
      remainingByLine,
      amount,
      eligibleBase,
    );
    for (const discount of lineDiscounts) {
      remainingByLine.set(
        discount.lineId,
        (remainingByLine.get(discount.lineId) ?? 0) - discount.amountMinor,
      );
    }
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
      lineDiscounts,
    });
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
          amount_minor, currency, before_taxes, allocations_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
      )
      .bind(
        credit.id,
        organizationId,
        invoiceId,
        credit.appliedCouponId,
        credit.expectedVersion,
        credit.amountMinor,
        currency,
        stableJson(credit.lineDiscounts),
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

function allocateLineDiscounts(
  lines: CouponApplicableLine[],
  remainingByLine: Map<string, number>,
  discountMinor: number,
  baseMinor: number,
): CouponLineDiscount[] {
  const allocations = lines
    .map((line) => {
      const remaining = remainingByLine.get(line.id) ?? 0;
      const numerator = BigInt(discountMinor) * BigInt(remaining);
      return {
        lineId: line.id,
        amountMinor: Number(numerator / BigInt(baseMinor)),
        remainder: numerator % BigInt(baseMinor),
      };
    })
    .filter((allocation) => (remainingByLine.get(allocation.lineId) ?? 0) > 0);
  let undistributed =
    discountMinor - allocations.reduce((sum, allocation) => sum + allocation.amountMinor, 0);
  allocations.sort((left, right) => {
    if (left.remainder === right.remainder) return left.lineId.localeCompare(right.lineId);
    return left.remainder > right.remainder ? -1 : 1;
  });
  for (const allocation of allocations) {
    if (undistributed <= 0) break;
    allocation.amountMinor += 1;
    undistributed -= 1;
  }
  return allocations
    .filter((allocation) => allocation.amountMinor > 0)
    .map(({ lineId, amountMinor }) => ({ lineId, amountMinor }));
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
