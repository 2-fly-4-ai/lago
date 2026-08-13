import { describe, expect, it } from "vitest";
import fixtures from "../fixtures/rating/lago-calculate-price.json";
import { rateCharge, type ChargeModel } from "../src/rating/charge-models";
import { Decimal } from "../src/rating/decimal";

describe("Lago charge-model parity", () => {
  for (const fixture of fixtures) {
    it(`matches the Rails CalculatePriceService fixture: ${fixture.name}`, () => {
      const result = rateCharge(fixture.units, fixture.charge as ChargeModel);
      expect(result.amountCents).toBe(fixture.expectedAmountCents);
    });
  }

  it("keeps decimal money exact", () => {
    expect(Decimal.parse("0.1").add(Decimal.parse("0.2")).toString()).toBe("0.3");
    expect(rateCharge("0.3", { model: "standard", amount: "0.1" }).amountCents).toBe("0.03");
  });

  it("applies percentage fixed amounts once per paid event", () => {
    expect(
      rateCharge(
        "10",
        { model: "percentage", rate: "5", fixedAmount: "2", freeEvents: 1 },
        { eventsCount: 3 },
      ).amountCents,
    ).toBe("4.5");
  });

  it("rejects malformed models instead of silently substituting pricing", () => {
    expect(() => rateCharge("5", { model: "package", amount: "10", packageSize: 0 })).toThrow(
      "package_size_must_be_positive",
    );
    expect(() =>
      rateCharge("5", {
        model: "volume",
        ranges: [{ fromValue: 10, toValue: null, perUnitAmount: "1", flatAmount: "0" }],
      }),
    ).toThrow("volume_range_not_found");
  });
});
