import { Decimal } from "../rating/decimal";

export type SupportedAggregationType =
  | "count_agg"
  | "sum_agg"
  | "max_agg"
  | "unique_count_agg"
  | "latest_agg";

export type UsageAggregationEvent = {
  id: string;
  timestampMs: number;
  properties: Record<string, unknown>;
};

export type AggregationRoundingFunction = "round" | "ceil" | "floor";

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
): Decimal {
  if (type === "count_agg") return Decimal.parse(events.length);
  if (!fieldName) throw new Error("aggregation_field_name_required");

  if (type === "sum_agg") {
    return events.reduce(
      (total, event) => total.add(decimalProperty(event, fieldName)),
      Decimal.zero(),
    );
  }

  if (type === "max_agg") {
    if (events.length === 0) return Decimal.zero();
    return events
      .map((event) => decimalProperty(event, fieldName))
      .reduce((maximum, value) => (value.compare(maximum) > 0 ? value : maximum));
  }

  if (type === "latest_agg") {
    const latest = [...events].sort(
      (left, right) => right.timestampMs - left.timestampMs || right.id.localeCompare(left.id),
    )[0];
    return latest ? decimalProperty(latest, fieldName) : Decimal.zero();
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
  return Decimal.parse([...state.values()].filter((operation) => operation === "add").length);
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
