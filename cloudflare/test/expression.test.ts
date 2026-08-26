import { describe, expect, it } from "vitest";
import {
  evaluateUsageExpression,
  UsageExpressionError,
  validateUsageExpression,
} from "../src/usage/expression";

const event = {
  code: "tokens",
  timestamp: 1234,
  properties: {
    left: "1.23",
    right: 2.3,
    label: "test",
    rounded: "12.34",
  },
};

describe("Lago usage expressions", () => {
  it("evaluates exact decimal precedence, variables, strings, and supported functions", () => {
    expect(evaluateUsageExpression("0.1 + 0.2 * 3", event)).toBe("0.7");
    expect(evaluateUsageExpression("(123 - event.properties.left) / 10", event)).toBe("12.177");
    expect(evaluateUsageExpression("event.code", event)).toBe("tokens");
    expect(evaluateUsageExpression("event.timestamp / 2", event)).toBe("617.0");
    expect(
      evaluateUsageExpression("CONCAT(event.properties.label, '-', event.properties.left)", event),
    ).toBe("test-1.23");
    expect(evaluateUsageExpression("least(event.properties.rounded, 5.0)", event)).toBe("5.0");
    expect(evaluateUsageExpression("Greatest(event.properties.rounded, 15.0)", event)).toBe("15.0");
    expect(
      evaluateUsageExpression("concat(event.properties.code, '-', event.code)", {
        ...event,
        properties: { ...event.properties, code: "property-code" },
      }),
    ).toBe("property-code-tokens");
  });

  it("matches half-up, ceiling, and floor behavior at positive and negative scales", () => {
    expect(evaluateUsageExpression("round(12.345, 2)", event)).toBe("12.35");
    expect(evaluateUsageExpression("round(15, -1)", event)).toBe("20.0");
    expect(evaluateUsageExpression("round(-15, -1)", event)).toBe("-20.0");
    expect(evaluateUsageExpression("ceil(-12.351, 1)", event)).toBe("-12.3");
    expect(evaluateUsageExpression("floor(-12.351, 1)", event)).toBe("-12.4");
  });

  it("rejects syntax outside the pinned grammar without dynamic evaluation", () => {
    for (const expression of [
      "1+",
      "round()",
      "round(1, 2, 3)",
      "rOuNd(1)",
      "event.properties.bad-name",
      "1\t+ 2",
      "Math.max(1, 2)",
      "'unterminated",
    ]) {
      expect(() => validateUsageExpression(expression), expression).toThrowError(
        UsageExpressionError,
      );
    }
  });

  it("returns stable evaluation failures for missing or non-decimal values", () => {
    expect(() => evaluateUsageExpression("event.properties.missing", event)).toThrowError(
      /Variable: missing not found/,
    );
    expect(() => evaluateUsageExpression("event.properties.label + 1", event)).toThrowError(
      /Expected a decimal/,
    );
    expect(() => evaluateUsageExpression("event.properties.constructor", event)).toThrowError(
      /Variable: constructor not found/,
    );
    expect(() => evaluateUsageExpression("1 / 0", event)).toThrowError(/division_by_zero/);
  });

  it("bounds expression length and nesting", () => {
    expect(() => validateUsageExpression("1".repeat(1025))).toThrowError(/Expression is invalid/);
    expect(() => validateUsageExpression(`${"(".repeat(40)}1${")".repeat(40)}`)).toThrowError(
      /Expression is invalid/,
    );
  });
});
