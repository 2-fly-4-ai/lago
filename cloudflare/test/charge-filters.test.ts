import { describe, expect, it } from "vitest";
import {
  ALL_FILTER_VALUES,
  normalizeBillableMetricFilters,
  normalizeChargeFilters,
  partitionUsageEvents,
} from "../src/usage/charge-filters";

describe("charge filters", () => {
  it("assigns each event to the first most-specific matching filter", async () => {
    const metricFilters = normalizeBillableMetricFilters([
      { key: "region", values: ["eu", "us"] },
      { key: "cloud", values: ["aws", "gcp"] },
    ]);
    const filters = await normalizeChargeFilters(
      [
        { properties: { amount: "10" }, values: { region: ["eu"] } },
        {
          properties: { amount: "20" },
          values: { cloud: [ALL_FILTER_VALUES], region: ["eu"] },
        },
        { properties: { amount: "30" }, values: { cloud: ["aws"] } },
      ],
      metricFilters,
      "standard",
      "charge-one",
    );
    const event = (id: string, properties: Record<string, unknown>) => ({
      id,
      properties,
      timestampMs: 1,
    });
    const result = partitionUsageEvents(
      [
        event("specific", { cloud: "gcp", region: "eu" }),
        event("broad", { region: "eu" }),
        event("aws", { cloud: "aws", region: "us" }),
        event("base", { cloud: "gcp", region: "us" }),
      ],
      filters,
    );

    expect(result.filters.map((partition) => partition.events.map(({ id }) => id))).toEqual([
      ["broad"],
      ["specific"],
      ["aws"],
    ]);
    expect(result.base.map(({ id }) => id)).toEqual(["base"]);
  });

  it("requires wildcard properties to exist and rejects invalid filter catalogs", async () => {
    const metricFilters = normalizeBillableMetricFilters([{ key: "cloud", values: ["aws"] }]);
    const filters = await normalizeChargeFilters(
      [{ properties: { amount: "1" }, values: { cloud: [ALL_FILTER_VALUES] } }],
      metricFilters,
      "standard",
      "charge-wildcard",
    );
    expect(
      partitionUsageEvents(
        [
          { id: "missing", properties: {}, timestampMs: 1 },
          { id: "present", properties: { cloud: null }, timestampMs: 2 },
        ],
        filters,
      ),
    ).toMatchObject({
      base: [{ id: "missing" }],
      filters: [{ events: [{ id: "present" }] }],
    });

    await expect(
      normalizeChargeFilters(
        [{ properties: { amount: "1" }, values: { cloud: ["gcp"] } }],
        metricFilters,
        "standard",
        "charge-invalid",
      ),
    ).rejects.toMatchObject({ code: "validation_error" });
  });
});
