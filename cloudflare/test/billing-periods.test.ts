import { describe, expect, it } from "vitest";
import {
  activeBillingPeriod,
  addTrialDays,
  assertBillingTimezone,
  billingPeriodDurationDays,
  firstPeriodEnd,
  followingPeriodEnd,
  initialPlanProration,
  localDateString,
} from "../src/billing/periods";

describe("timezone-aware billing periods", () => {
  it("uses local calendar boundaries across DST transitions", () => {
    const start = new Date("2026-03-05T12:00:00.000Z");
    const marchEnd = firstPeriodEnd(start, "monthly", "calendar", "Europe/Paris");
    expect(marchEnd.toISOString()).toBe("2026-03-31T22:00:00.000Z");
    expect(followingPeriodEnd(marchEnd, "monthly", "calendar", "Europe/Paris").toISOString()).toBe(
      "2026-04-30T22:00:00.000Z",
    );
    expect(localDateString(marchEnd, "Europe/Paris")).toBe("2026-04-01");
  });

  it("prorates calendar base fees by local civil days", () => {
    const periodEnd = new Date("2026-03-31T22:00:00.000Z");
    expect(
      initialPlanProration(
        new Date("2026-03-15T00:00:00.000Z"),
        periodEnd,
        "calendar",
        "monthly",
        "Europe/Paris",
      ),
    ).toEqual({ billableDays: 17, fullPeriodDays: 31 });
  });

  it("keeps the full calendar duration for a mid-period weighted usage window", () => {
    expect(
      billingPeriodDurationDays(
        new Date("2026-03-15T00:00:00.000Z"),
        new Date("2026-03-31T22:00:00.000Z"),
        "calendar",
        "monthly",
        "Europe/Paris",
      ),
    ).toBe(31);
  });

  it("preserves anniversary behavior and rejects unknown zones", () => {
    expect(
      firstPeriodEnd(
        new Date("2026-01-31T10:00:00.000Z"),
        "monthly",
        "anniversary",
        "Asia/Tokyo",
      ).toISOString(),
    ).toBe("2026-02-28T10:00:00.000Z");
    expect(() => assertBillingTimezone("Mars/Olympus_Mons")).toThrow("invalid_billing_timezone");
  });

  it("keeps trial end wall-clock time stable across daylight-saving changes", () => {
    const trialEnd = addTrialDays(new Date("2026-03-25T11:12:00.500Z"), 10, "Europe/Paris");
    expect(trialEnd.toISOString()).toBe("2026-04-04T10:12:00.500Z");
  });

  it("finds the active period for an anniversary subscription started in the past", () => {
    const period = activeBillingPeriod(
      new Date("2026-01-31T10:00:00.000Z"),
      new Date("2026-03-15T00:00:00.000Z"),
      "monthly",
      "anniversary",
      "UTC",
    );
    expect(period.periodStart.toISOString()).toBe("2026-02-28T10:00:00.000Z");
    expect(period.periodEnd.toISOString()).toBe("2026-03-28T10:00:00.000Z");
  });

  it("advances a backdated calendar subscription through timezone boundaries", () => {
    const period = activeBillingPeriod(
      new Date("2026-02-15T11:00:00.000Z"),
      new Date("2026-04-15T00:00:00.000Z"),
      "monthly",
      "calendar",
      "Europe/Paris",
    );
    expect(period.periodStart.toISOString()).toBe("2026-03-31T22:00:00.000Z");
    expect(period.periodEnd.toISOString()).toBe("2026-04-30T22:00:00.000Z");
  });
});
