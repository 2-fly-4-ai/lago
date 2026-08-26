import { ApiError } from "../http";
import type { ChargeModel } from "../rating/charge-models";

export function parseChargeModel(model: string, properties: Record<string, unknown>): ChargeModel {
  if (model === "standard") return { model, amount: decimalString(properties, "amount") };
  if (model === "package") {
    return {
      model,
      amount: decimalString(properties, "amount"),
      packageSize: decimalString(properties, "package_size"),
      freeUnits: optionalDecimalString(properties, "free_units") ?? "0",
    };
  }
  if (model === "percentage") {
    rejectPresent(properties, ["per_transaction_min_amount", "per_transaction_max_amount"]);
    const freeEvents = optionalNonNegativeInteger(properties, "free_units_per_events") ?? 0;
    if (freeEvents > 0) {
      throw new ApiError(
        422,
        "unsupported_charge_properties",
        "free_units_per_events requires per-event percentage rating",
      );
    }
    return {
      model,
      rate: decimalString(properties, "rate"),
      fixedAmount: optionalDecimalString(properties, "fixed_amount") ?? "0",
      freeUnits: optionalDecimalString(properties, "free_units_per_total_aggregation") ?? "0",
      freeEvents,
    };
  }
  if (model === "graduated") {
    return { model, ranges: ranges(properties, "graduated_ranges", "per_unit_amount") };
  }
  if (model === "volume") {
    return { model, ranges: ranges(properties, "volume_ranges", "per_unit_amount") };
  }
  if (model === "graduated_percentage") {
    return { model, ranges: ranges(properties, "graduated_percentage_ranges", "rate") };
  }
  throw new ApiError(422, "unsupported_charge_model", `Unsupported charge model: ${model}`);
}

function rejectPresent(value: Record<string, unknown>, keys: string[]): void {
  const unsupported = keys.find((key) => value[key] !== undefined && value[key] !== null);
  if (unsupported) {
    throw new ApiError(
      422,
      "unsupported_charge_properties",
      `${unsupported} is not implemented by the Cloudflare rating engine`,
    );
  }
}

function ranges(
  properties: Record<string, unknown>,
  key: string,
  variableKey: "per_unit_amount" | "rate",
): Array<{
  fromValue: string;
  toValue: string | null;
  flatAmount: string;
  perUnitAmount: string;
  rate: string;
}> {
  const source = properties[key];
  if (!Array.isArray(source) || source.length === 0) {
    throw new ApiError(422, "validation_error", `${key} must be a non-empty array`);
  }
  return source.map((entry, index) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new ApiError(422, "validation_error", `${key}[${index}] must be an object`);
    }
    const object = entry as Record<string, unknown>;
    return {
      fromValue: decimalString(object, "from_value"),
      toValue: nullableDecimalString(object, "to_value"),
      flatAmount: optionalDecimalString(object, "flat_amount") ?? "0",
      perUnitAmount: variableKey === "per_unit_amount" ? decimalString(object, variableKey) : "0",
      rate: variableKey === "rate" ? decimalString(object, variableKey) : "0",
    };
  });
}

function decimalString(value: Record<string, unknown>, key: string): string {
  const candidate = value[key];
  if (typeof candidate !== "string" && typeof candidate !== "number") {
    throw new ApiError(422, "validation_error", `${key} must be a decimal`);
  }
  const normalized = String(candidate);
  if (!/^[+-]?\d+(?:\.\d+)?$/.test(normalized)) {
    throw new ApiError(422, "validation_error", `${key} must be a decimal`);
  }
  return normalized;
}

function optionalDecimalString(value: Record<string, unknown>, key: string): string | null {
  return value[key] === undefined || value[key] === null ? null : decimalString(value, key);
}

function nullableDecimalString(value: Record<string, unknown>, key: string): string | null {
  return optionalDecimalString(value, key);
}

function optionalNonNegativeInteger(value: Record<string, unknown>, key: string): number | null {
  const candidate = value[key];
  if (candidate === undefined || candidate === null) return null;
  const number = typeof candidate === "string" ? Number(candidate) : candidate;
  if (!Number.isSafeInteger(number) || Number(number) < 0) {
    throw new ApiError(422, "validation_error", `${key} must be a non-negative integer`);
  }
  return Number(number);
}
