import { Decimal } from "./decimal";

type Range = {
  fromValue: string | number;
  toValue: string | number | null;
  flatAmount: string;
};

export type ChargeModel =
  | { model: "standard"; amount: string }
  | { model: "package"; amount: string; packageSize: string | number; freeUnits?: string | number }
  | { model: "graduated"; ranges: Array<Range & { perUnitAmount: string }> }
  | { model: "volume"; ranges: Array<Range & { perUnitAmount: string }> }
  | {
      model: "percentage";
      rate: string;
      fixedAmount?: string;
      freeUnits?: string | number;
      freeEvents?: number;
    }
  | { model: "graduated_percentage"; ranges: Array<Range & { rate: string }> };

export type RatingResult = {
  model: ChargeModel["model"];
  units: string;
  amountCents: string;
  details: Record<string, unknown>;
};

export type RatingContext = { eventsCount?: number };

const HUNDRED = Decimal.parse(100);
const ONE = Decimal.parse(1);

export function rateCharge(
  unitsInput: string | number,
  charge: ChargeModel,
  context: RatingContext = {},
): RatingResult {
  const units = Decimal.parse(unitsInput);
  if (units.isNegative()) throw new Error("units_must_be_non_negative");

  switch (charge.model) {
    case "standard": {
      const amount = units.multiply(Decimal.parse(charge.amount));
      return result(charge.model, units, amount, { perUnitAmount: charge.amount });
    }
    case "package": {
      const freeUnits = Decimal.parse(charge.freeUnits ?? 0);
      const paidUnits = units.subtract(freeUnits);
      const packageSize = Decimal.parse(charge.packageSize);
      if (packageSize.compare(Decimal.zero()) <= 0)
        throw new Error("package_size_must_be_positive");
      const packageCount =
        paidUnits.isNegative() || paidUnits.isZero()
          ? 0n
          : paidUnits.ceilDividePositive(packageSize);
      const amount = Decimal.parse(charge.amount).multiply(Decimal.parse(packageCount));
      return result(charge.model, units, amount, {
        freeUnits: freeUnits.toString(),
        paidUnits: paidUnits.isNegative() ? "0" : paidUnits.toString(),
        packageSize: packageSize.toString(),
        packageCount: packageCount.toString(),
      });
    }
    case "graduated":
      return rateGraduated(units, charge);
    case "volume":
      return rateVolume(units, charge);
    case "percentage": {
      const freeUnits = Decimal.parse(charge.freeUnits ?? 0);
      const paidUnits = units.subtract(freeUnits);
      const chargeableUnits = paidUnits.isNegative() ? Decimal.zero() : paidUnits;
      const percentage = chargeableUnits.multiply(Decimal.parse(charge.rate)).divide(HUNDRED);
      const eventsCount = context.eventsCount ?? (units.isZero() ? 0 : 1);
      if (!Number.isSafeInteger(eventsCount) || eventsCount < 0) {
        throw new Error("events_count_must_be_non_negative_integer");
      }
      const freeEvents = charge.freeEvents ?? 0;
      if (!Number.isSafeInteger(freeEvents) || freeEvents < 0) {
        throw new Error("free_events_must_be_non_negative_integer");
      }
      const paidEvents = Math.max(0, eventsCount - freeEvents);
      const fixed = Decimal.parse(charge.fixedAmount ?? 0).multiply(Decimal.parse(paidEvents));
      return result(charge.model, units, percentage.add(fixed), {
        freeUnits: freeUnits.toString(),
        paidUnits: chargeableUnits.toString(),
        rate: charge.rate,
        percentageAmount: percentage.toString(),
        fixedAmount: fixed.toString(),
        eventsCount,
        freeEvents,
        paidEvents,
      });
    }
    case "graduated_percentage":
      return rateGraduatedPercentage(units, charge);
  }
}

export function rateProratedFixedCharge(
  fullUnitsInput: string | number,
  proratedUnitsInput: string | number,
  charge: ChargeModel,
): RatingResult {
  const fullUnits = Decimal.parse(fullUnitsInput);
  const proratedUnits = Decimal.parse(proratedUnitsInput);
  if (fullUnits.isNegative() || proratedUnits.isNegative()) {
    throw new Error("units_must_be_non_negative");
  }
  if (charge.model === "standard" || charge.model === "volume") {
    return rateCharge(proratedUnits.toString(), charge);
  }
  if (charge.model !== "graduated") throw new Error("invalid_fixed_charge_model");
  if (proratedUnits.isZero())
    return result(charge.model, proratedUnits, Decimal.zero(), { ranges: [] });

  const ranges = validateRanges(charge.ranges);
  const coefficient = fullUnits.isZero() ? null : proratedUnits.divide(fullUnits, 24);
  let amount = Decimal.zero();
  const details: Array<Record<string, string | null>> = [];
  for (const [index, range] of ranges.entries()) {
    const fullTierUnits = fullUnits.isZero()
      ? Decimal.zero()
      : unitsInRange(fullUnits, range.from, range.to);
    if (!fullUnits.isZero() && fullTierUnits.isZero()) continue;
    if (fullUnits.isZero() && index > 0) break;
    const proratedTierUnits = coefficient ? fullTierUnits.multiply(coefficient) : proratedUnits;
    const perUnitAmount = Decimal.parse(range.source.perUnitAmount);
    const flatAmount = Decimal.parse(range.source.flatAmount);
    const total = proratedTierUnits.multiply(perUnitAmount).add(flatAmount);
    amount = amount.add(total);
    details.push({
      fromValue: range.from.toString(),
      toValue: range.to?.toString() ?? null,
      fullUnits: fullTierUnits.toString(),
      proratedUnits: proratedTierUnits.toString(),
      perUnitAmount: perUnitAmount.toString(),
      flatAmount: flatAmount.toString(),
      total: total.toString(),
    });
    if (fullUnits.isZero() || !range.to || fullUnits.compare(range.to) <= 0) break;
  }
  return result(charge.model, proratedUnits, amount, {
    fullUnits: fullUnits.toString(),
    ranges: details,
  });
}

function rateGraduated(
  units: Decimal,
  charge: Extract<ChargeModel, { model: "graduated" }>,
): RatingResult {
  const ranges = validateRanges(charge.ranges);
  let amount = Decimal.zero();
  const details: Array<Record<string, string | null>> = [];
  for (const range of ranges) {
    const tierUnits = unitsInRange(units, range.from, range.to);
    if (tierUnits.isZero()) continue;
    const unitAmount = Decimal.parse(range.source.perUnitAmount);
    const flatAmount = Decimal.parse(range.source.flatAmount);
    const total = tierUnits.multiply(unitAmount).add(flatAmount);
    amount = amount.add(total);
    details.push({
      fromValue: range.from.toString(),
      toValue: range.to?.toString() ?? null,
      units: tierUnits.toString(),
      perUnitAmount: unitAmount.toString(),
      flatAmount: flatAmount.toString(),
      total: total.toString(),
    });
    if (!range.to || units.compare(range.to) <= 0) break;
  }
  return result(charge.model, units, amount, { ranges: details });
}

function rateGraduatedPercentage(
  units: Decimal,
  charge: Extract<ChargeModel, { model: "graduated_percentage" }>,
): RatingResult {
  const ranges = validateRanges(charge.ranges);
  let amount = Decimal.zero();
  const details: Array<Record<string, string | null>> = [];
  for (const range of ranges) {
    const tierUnits = unitsInRange(units, range.from, range.to);
    if (tierUnits.isZero()) continue;
    const rate = Decimal.parse(range.source.rate);
    const flatAmount = Decimal.parse(range.source.flatAmount);
    const variable = tierUnits.multiply(rate).divide(HUNDRED);
    const total = variable.add(flatAmount);
    amount = amount.add(total);
    details.push({
      fromValue: range.from.toString(),
      toValue: range.to?.toString() ?? null,
      units: tierUnits.toString(),
      rate: rate.toString(),
      flatAmount: flatAmount.toString(),
      total: total.toString(),
    });
    if (!range.to || units.compare(range.to) <= 0) break;
  }
  return result(charge.model, units, amount, { ranges: details });
}

function rateVolume(
  units: Decimal,
  charge: Extract<ChargeModel, { model: "volume" }>,
): RatingResult {
  if (units.isZero()) return result(charge.model, units, Decimal.zero(), { range: null });
  const roundedUnits = Decimal.parse(units.ceil());
  const range = validateRanges(charge.ranges).find(
    (candidate) =>
      roundedUnits.compare(candidate.from) >= 0 &&
      (!candidate.to || units.compare(candidate.to) <= 0),
  );
  if (!range) throw new Error("volume_range_not_found");
  const perUnitAmount = Decimal.parse(range.source.perUnitAmount);
  const flatAmount = Decimal.parse(range.source.flatAmount);
  const amount = units.multiply(perUnitAmount).add(flatAmount);
  return result(charge.model, units, amount, {
    range: {
      fromValue: range.from.toString(),
      toValue: range.to?.toString() ?? null,
      perUnitAmount: perUnitAmount.toString(),
      flatAmount: flatAmount.toString(),
    },
  });
}

function unitsInRange(units: Decimal, from: Decimal, to: Decimal | null): Decimal {
  if (units.compare(from) < 0) return Decimal.zero();
  const effectiveEnd = to && units.compare(to) > 0 ? to : units;
  if (from.isZero()) return effectiveEnd;
  return effectiveEnd.subtract(from).add(ONE);
}

function validateRanges<T extends Range>(ranges: T[]) {
  if (ranges.length === 0) throw new Error("ranges_required");
  const normalized = ranges.map((source) => ({
    source,
    from: Decimal.parse(source.fromValue),
    to: source.toValue === null ? null : Decimal.parse(source.toValue),
  }));
  for (const [index, range] of normalized.entries()) {
    if (range.from.isNegative()) throw new Error("range_from_must_be_non_negative");
    if (range.to && range.to.compare(range.from) < 0) throw new Error("invalid_range_bounds");
    if (index > 0 && range.from.compare(normalized[index - 1]?.from ?? Decimal.zero()) <= 0) {
      throw new Error("ranges_must_be_strictly_ordered");
    }
  }
  return normalized;
}

function result(
  model: ChargeModel["model"],
  units: Decimal,
  amount: Decimal,
  details: Record<string, unknown>,
): RatingResult {
  return { model, units: units.toString(), amountCents: amount.toString(), details };
}
