import { describe, expect, it } from "vitest";
import { passedUsageThresholds, type UsageThresholdRow } from "../src/usage/thresholds";

describe("progressive usage threshold crossing", () => {
  it("passes every newly reached fixed threshold in ascending order", () => {
    expect(cross([10, 20, 31, 40], null, 9, 31)).toEqual([10, 20, 31, 40]);
    expect(cross([10, 20, 31, 40], null, 21, 20)).toEqual([31, 40]);
    expect(cross([10, 20, 31, 40], null, 40, 2)).toEqual([]);
  });

  it("starts recurring crossings after the largest fixed threshold", () => {
    expect(cross([10, 20, 31, 40], 5, 0, 44)).toEqual([10, 20, 31, 40]);
    expect(cross([10, 20, 31, 40], 5, 0, 45)).toEqual([10, 20, 31, 40, 5]);
    expect(cross([10, 20, 31, 40], 5, 40, 5)).toEqual([5]);
    expect(cross([], 10, 202, 8)).toEqual([10]);
  });

  it("subtracts the current period cumulative amount already progressively billed", () => {
    expect(cross([10, 20, 31, 40], null, 0, 31, 10)).toEqual([20, 31]);
    expect(cross([10, 20, 31, 40], 5, 21, 24, 10)).toEqual([40, 5]);
    expect(cross([], 10, 202, 17, 10)).toEqual([]);
    expect(cross([], 10, 202, 18, 10)).toEqual([10]);
  });

  it("does not emit a crossing while progressive credit exceeds recalculated current usage", () => {
    expect(cross([10], null, 0, 9, 10)).toEqual([]);
  });
});

function cross(
  fixed: number[],
  recurring: number | null,
  invoiced: number,
  current: number,
  progressiveBilled = 0,
): number[] {
  const thresholds = [
    ...fixed.map((amount, index) => threshold(`fixed-${index}`, amount, false)),
    ...(recurring === null ? [] : [threshold("recurring", recurring, true)]),
  ];
  return passedUsageThresholds(thresholds, {
    historicalUsageMinor: 0,
    invoicedUsageMinor: invoiced,
    currentUsageMinor: current,
    progressiveBilledUsageMinor: progressiveBilled,
  }).map((entry) => entry.amount_minor);
}

function threshold(id: string, amount: number, recurring: boolean): UsageThresholdRow {
  return {
    id,
    organization_id: "org-threshold",
    plan_id: "plan-threshold",
    subscription_id: null,
    amount_minor: amount,
    recurring: recurring ? 1 : 0,
    threshold_display_name: null,
    version: 1,
    deleted_at: null,
    created_at: "2026-08-15T00:00:00.000Z",
    updated_at: "2026-08-15T00:00:00.000Z",
  };
}
