import { Decimal } from "../rating/decimal";
import { localDate } from "./periods";

export type FixedChargeUnitEvent = {
  fixedChargeVersion: number;
  units: string;
  effectiveAt: string;
};

export type FixedChargePeriodUnits = {
  fullUnits: string;
  proratedUnits: string;
};

export function fixedChargePeriodUnits(
  storedUnits: string,
  hasUnitEvents: boolean,
  unitEvents: FixedChargeUnitEvent[],
  periodStart: string,
  calculationPeriodEnd: string,
  fullPeriodDays: number,
  timezone: string,
): FixedChargePeriodUnits {
  const periodStartMs = Date.parse(periodStart);
  const calculationPeriodEndMs = Date.parse(calculationPeriodEnd);
  if (
    !Number.isFinite(periodStartMs) ||
    !Number.isFinite(calculationPeriodEndMs) ||
    calculationPeriodEndMs <= periodStartMs ||
    !Number.isSafeInteger(fullPeriodDays) ||
    fullPeriodDays <= 0
  ) {
    throw new Error("invalid_fixed_charge_period");
  }

  const parsed = unitEvents.map((event) => ({
    ...event,
    effectiveAtMs: Date.parse(event.effectiveAt),
  }));
  if (parsed.some((event) => !Number.isFinite(event.effectiveAtMs))) {
    throw new Error("invalid_fixed_charge_unit_event");
  }
  const prepared = parsed
    .filter((event) => event.effectiveAtMs < calculationPeriodEndMs)
    .sort((left, right) => left.fixedChargeVersion - right.fixedChargeVersion);

  const effective: typeof prepared = [];
  let minimumLaterTimestamp = Number.POSITIVE_INFINITY;
  for (let index = prepared.length - 1; index >= 0; index -= 1) {
    const event = prepared[index]!;
    if (minimumLaterTimestamp >= event.effectiveAtMs) effective.push(event);
    minimumLaterTimestamp = Math.min(minimumLaterTimestamp, event.effectiveAtMs);
  }
  effective.reverse();

  const prior = effective.filter((event) => event.effectiveAtMs < periodStartMs).at(-1);
  let currentUnits = Decimal.parse(
    prior?.units ?? (hasUnitEvents ? "0" : Decimal.parse(storedUnits).toString()),
  );
  let cursor = periodStartMs;
  let proratedUnits = Decimal.zero();
  for (const event of effective) {
    if (event.effectiveAtMs < periodStartMs) continue;
    const segmentDays = localDaySpan(cursor, event.effectiveAtMs, timezone);
    if (segmentDays < 0) throw new Error("invalid_fixed_charge_unit_event_order");
    proratedUnits = proratedUnits.add(
      currentUnits
        .multiply(Decimal.parse(segmentDays))
        .divideByInteger(BigInt(fullPeriodDays))
        .roundToScale(6, "half_up"),
    );
    currentUnits = Decimal.parse(event.units);
    cursor = event.effectiveAtMs;
  }
  const remainingDays = localDaySpan(cursor, calculationPeriodEndMs, timezone);
  if (remainingDays < 0) throw new Error("invalid_fixed_charge_unit_event_order");
  proratedUnits = proratedUnits.add(
    currentUnits
      .multiply(Decimal.parse(remainingDays))
      .divideByInteger(BigInt(fullPeriodDays))
      .roundToScale(6, "half_up"),
  );

  return { fullUnits: currentUnits.toString(), proratedUnits: proratedUnits.toString() };
}

function localDaySpan(startMs: number, endMs: number, timezone: string): number {
  const start = localDate(new Date(startMs), timezone);
  const end = localDate(new Date(endMs), timezone);
  return (
    Math.floor(Date.UTC(end.year, end.month - 1, end.day) / 86_400_000) -
    Math.floor(Date.UTC(start.year, start.month - 1, start.day) / 86_400_000)
  );
}
