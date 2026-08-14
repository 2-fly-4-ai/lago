import { describe, expect, it } from "vitest";
import { Decimal } from "../src/rating/decimal";
import {
  aggregateUsage,
  applyAggregationRounding,
  type UsageAggregationEvent,
} from "../src/usage/aggregation";

const event = (
  id: string,
  timestampMs: number,
  properties: Record<string, unknown>,
): UsageAggregationEvent => ({ id, timestampMs, properties });

describe("usage aggregation", () => {
  it("aggregates count, sum, maximum, and latest values without floating-point drift", () => {
    const events = [event("a", 1, { units: "0.1" }), event("b", 2, { units: "0.2" })];
    expect(aggregateUsage("count_agg", null, events).toString()).toBe("2");
    expect(aggregateUsage("sum_agg", "units", events).toString()).toBe("0.3");
    expect(aggregateUsage("max_agg", "units", events).toString()).toBe("0.2");
    expect(aggregateUsage("latest_agg", "units", events).toString()).toBe("0.2");
  });

  it("uses the last add/remove operation for each unique value", () => {
    const events = [
      event("a", 1, { seat: "one", operation_type: "add" }),
      event("b", 2, { seat: "two" }),
      event("c", 3, { seat: "one", operation_type: "remove" }),
      event("d", 4, { seat: "one", operation_type: "add" }),
    ];
    expect(aggregateUsage("unique_count_agg", "seat", events).toString()).toBe("2");
  });

  it("applies Lago rounding functions after aggregation at positive and negative precision", () => {
    const units = Decimal.parse("123.456");
    expect(applyAggregationRounding(units, "round", 2).toString()).toBe("123.46");
    expect(applyAggregationRounding(units, "ceil", null).toString()).toBe("124");
    expect(applyAggregationRounding(units, "ceil", -2).toString()).toBe("200");
    expect(applyAggregationRounding(units, "floor", 2).toString()).toBe("123.45");
    expect(applyAggregationRounding(units, "floor", -2).toString()).toBe("100");
    expect(applyAggregationRounding(units, null, -2)).toBe(units);
  });

  it("fails closed on malformed aggregation values", () => {
    expect(() => aggregateUsage("sum_agg", "units", [event("a", 1, { units: "nan" })])).toThrow(
      "invalid_decimal",
    );
    expect(() =>
      aggregateUsage("unique_count_agg", "seat", [
        event("a", 1, { seat: "one", operation_type: "replace" }),
      ]),
    ).toThrow("invalid_unique_count_operation");
  });
});
