import { Decimal } from "../rating/decimal";

export type SupportedAggregationType =
  | "count_agg"
  | "sum_agg"
  | "max_agg"
  | "unique_count_agg"
  | "weighted_sum_agg"
  | "latest_agg"
  | "custom_agg";

export type UsageAggregationEvent = {
  id: string;
  timestampMs: number;
  properties: Record<string, unknown>;
};

export type AggregationRoundingFunction = "round" | "ceil" | "floor";

export type UsageAggregationOptions = {
  periodStartMs?: number;
  periodEndMs?: number;
  periodDurationDays?: number;
  initialValue?: Decimal;
};

export type UsageAggregationResult = {
  units: Decimal;
  totalAggregatedUnits: Decimal;
};

export function applyAggregationRounding(
  units: Decimal,
  roundingFunction: AggregationRoundingFunction | null,
  roundingPrecision: number | null,
): Decimal {
  if (!roundingFunction) return units;
  return units.roundToScale(
    roundingPrecision ?? 0,
    roundingFunction === "round" ? "half_up" : roundingFunction === "ceil" ? "ceiling" : "floor",
  );
}

export function aggregateUsage(
  type: SupportedAggregationType,
  fieldName: string | null,
  events: UsageAggregationEvent[],
  options: UsageAggregationOptions = {},
): Decimal {
  return aggregateUsageResult(type, fieldName, events, options).units;
}

export function aggregateUsageResult(
  type: SupportedAggregationType,
  fieldName: string | null,
  events: UsageAggregationEvent[],
  options: UsageAggregationOptions = {},
): UsageAggregationResult {
  if (type === "count_agg") {
    const units = Decimal.parse(events.length);
    return { units, totalAggregatedUnits: units };
  }
  if (!fieldName) throw new Error("aggregation_field_name_required");

  if (type === "sum_agg" || type === "custom_agg") {
    const units = events.reduce(
      (total, event) => total.add(decimalProperty(event, fieldName)),
      Decimal.zero(),
    );
    return { units, totalAggregatedUnits: units };
  }

  if (type === "max_agg") {
    if (events.length === 0) return { units: Decimal.zero(), totalAggregatedUnits: Decimal.zero() };
    const units = events
      .map((event) => decimalProperty(event, fieldName))
      .reduce((maximum, value) => (value.compare(maximum) > 0 ? value : maximum));
    return { units, totalAggregatedUnits: units };
  }

  if (type === "latest_agg") {
    const latest = [...events].sort(
      (left, right) => right.timestampMs - left.timestampMs || right.id.localeCompare(left.id),
    )[0];
    const units = latest ? decimalProperty(latest, fieldName) : Decimal.zero();
    return { units, totalAggregatedUnits: units };
  }

  if (type === "weighted_sum_agg") {
    return aggregateWeightedSum(fieldName, events, options);
  }

  const state = new Map<string, "add" | "remove">();
  for (const event of [...events].sort(
    (left, right) => left.timestampMs - right.timestampMs || left.id.localeCompare(right.id),
  )) {
    const value = scalarProperty(event, fieldName);
    const operation = event.properties.operation_type ?? "add";
    if (operation !== "add" && operation !== "remove") {
      throw new Error("invalid_unique_count_operation");
    }
    state.set(value, operation);
  }
  const units = Decimal.parse(
    [...state.values()].filter((operation) => operation === "add").length,
  );
  return { units, totalAggregatedUnits: units };
}

function aggregateWeightedSum(
  fieldName: string,
  events: UsageAggregationEvent[],
  options: UsageAggregationOptions,
): UsageAggregationResult {
  const { periodStartMs, periodEndMs, periodDurationDays } = options;
  if (
    typeof periodStartMs !== "number" ||
    typeof periodEndMs !== "number" ||
    typeof periodDurationDays !== "number" ||
    !Number.isSafeInteger(periodStartMs) ||
    !Number.isSafeInteger(periodEndMs) ||
    !Number.isSafeInteger(periodDurationDays) ||
    periodDurationDays <= 0 ||
    periodEndMs <= periodStartMs
  ) {
    throw new Error("weighted_sum_period_required");
  }

  const initialValue = options.initialValue ?? Decimal.zero();
  const ordered = [...events].sort(
    (left, right) => left.timestampMs - right.timestampMs || left.id.localeCompare(right.id),
  );
  let cumulative = initialValue;
  let weightedMilliseconds = Decimal.zero();
  let cursor = periodStartMs;
  let index = 0;

  while (index < ordered.length) {
    const timestampMs = ordered[index]!.timestampMs;
    if (
      !Number.isSafeInteger(timestampMs) ||
      timestampMs < periodStartMs ||
      timestampMs >= periodEndMs
    ) {
      throw new Error("weighted_sum_event_outside_period");
    }
    weightedMilliseconds = weightedMilliseconds.add(
      cumulative.multiply(Decimal.parse(timestampMs - cursor)),
    );
    let difference = Decimal.zero();
    while (index < ordered.length && ordered[index]!.timestampMs === timestampMs) {
      difference = difference.add(decimalProperty(ordered[index]!, fieldName));
      index += 1;
    }
    cumulative = cumulative.add(difference);
    cursor = timestampMs;
  }

  weightedMilliseconds = weightedMilliseconds.add(
    cumulative.multiply(Decimal.parse(periodEndMs - cursor)),
  );
  const denominator = BigInt(periodDurationDays) * 86_400_000n;
  const units = weightedMilliseconds.divideByIntegerCeilToScale(denominator, 20);
  return { units, totalAggregatedUnits: cumulative };
}

function decimalProperty(event: UsageAggregationEvent, fieldName: string): Decimal {
  const value = event.properties[fieldName];
  if (typeof value !== "string" && typeof value !== "number") {
    throw new Error("aggregation_property_must_be_numeric");
  }
  return Decimal.parse(value);
}

function scalarProperty(event: UsageAggregationEvent, fieldName: string): string {
  const value = event.properties[fieldName];
  if (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean") {
    throw new Error("aggregation_property_required");
  }
  return String(value);
}
