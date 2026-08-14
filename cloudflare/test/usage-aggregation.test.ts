import { describe, expect, it } from "vitest";
import { Decimal } from "../src/rating/decimal";
import {
  aggregateUsage,
  aggregateUsageResult,
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

  it("integrates weighted deltas over the full charge period with Lago precision", () => {
    const hour = 3_600_000;
    const events = [
      event("a", 0, { value: "2" }),
      event("b", hour, { value: "3" }),
      event("c", hour + hour / 2, { value: "1" }),
      event("d", 2 * hour, { value: "-4" }),
      event("e", 4 * hour, { value: "-2" }),
      event("f", 5 * hour, { value: "10" }),
      event("g", 5.5 * hour, { value: "-10" }),
    ];
    const result = aggregateUsageResult("weighted_sum_agg", "value", events, {
      periodStartMs: 0,
      periodEndMs: 31 * 86_400_000,
      periodDurationDays: 31,
    });
    expect(result.units.toString()).toBe("0.02217741935483870968");
    expect(result.totalAggregatedUnits.toString()).toBe("0");
  });

  it("carries recurring weighted state and combines same-timestamp deltas", () => {
    const result = aggregateUsageResult(
      "weighted_sum_agg",
      "value",
      [event("b", 0, { value: "3" }), event("a", 0, { value: "3" })],
      {
        periodStartMs: 0,
        periodEndMs: 31 * 86_400_000,
        periodDurationDays: 31,
        initialValue: Decimal.parse("1000"),
      },
    );
    expect(result.units.toString()).toBe("1006");
    expect(result.totalAggregatedUnits.toString()).toBe("1006");
  });

  it("ceil-normalizes negative weighted fractions at exactly 20 decimal places", () => {
    const result = aggregateUsageResult(
      "weighted_sum_agg",
      "value",
      [event("negative", 2 * 86_400_000, { value: "-1" })],
      {
        periodStartMs: 0,
        periodEndMs: 3 * 86_400_000,
        periodDurationDays: 3,
      },
    );
    expect(result.units.toString()).toBe("-0.33333333333333333333");
    expect(result.totalAggregatedUnits.toString()).toBe("-1");
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
