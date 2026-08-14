import { ApiError } from "../http";
import { deterministicUuid } from "../identifiers";
import { stableJson } from "../json";
import { parseChargeModel } from "./charge-properties";

export const ALL_FILTER_VALUES = "__ALL_FILTER_VALUES__";

export type BillableMetricFilter = {
  key: string;
  values: string[];
};

export type ChargeFilter = {
  lagoId: string;
  invoiceDisplayName: string | null;
  properties: Record<string, unknown>;
  values: Record<string, string[]>;
};

export type FilterableUsageEvent = {
  id: string;
  timestampMs: number;
  properties: Record<string, unknown>;
};

const MAX_METRIC_FILTERS = 20;
const MAX_FILTER_VALUES = 100;
const MAX_CHARGE_FILTERS = 100;

export function normalizeBillableMetricFilters(value: unknown): BillableMetricFilter[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    throw new ApiError(422, "validation_error", "filters must be an array");
  }
  if (value.length > MAX_METRIC_FILTERS) {
    throw new ApiError(
      422,
      "validation_error",
      `filters cannot contain more than ${MAX_METRIC_FILTERS} entries`,
    );
  }
  const seen = new Set<string>();
  const filters = value.map((entry, index) => {
    const input = objectValue(entry, `filters[${index}]`);
    const key = requiredText(input.key, `filters[${index}].key`);
    if (seen.has(key)) {
      throw new ApiError(422, "validation_error", `filters[${index}].key is duplicated`);
    }
    seen.add(key);
    const values = stringArray(input.values, `filters[${index}].values`, MAX_FILTER_VALUES);
    return { key, values: [...new Set(values)].sort() };
  });
  return filters.sort((left, right) => left.key.localeCompare(right.key));
}

export async function normalizeChargeFilters(
  value: unknown,
  metricFilters: BillableMetricFilter[],
  chargeModel: string,
  chargeId: string,
): Promise<ChargeFilter[]> {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    throw new ApiError(422, "validation_error", "filters must be an array");
  }
  if (value.length > MAX_CHARGE_FILTERS) {
    throw new ApiError(
      422,
      "validation_error",
      `filters cannot contain more than ${MAX_CHARGE_FILTERS} entries`,
    );
  }
  if (value.length > 0 && metricFilters.length === 0) {
    throw new ApiError(422, "validation_error", "Charge filters require billable metric filters");
  }
  const allowed = new Map(metricFilters.map((filter) => [filter.key, new Set(filter.values)]));
  const seen = new Set<string>();
  const filters: ChargeFilter[] = [];
  for (const [index, entry] of value.entries()) {
    const input = objectValue(entry, `filters[${index}]`);
    const rawValues = objectValue(input.values, `filters[${index}].values`);
    const keys = Object.keys(rawValues).sort();
    if (keys.length === 0) {
      throw new ApiError(422, "validation_error", `filters[${index}].values cannot be empty`);
    }
    const values: Record<string, string[]> = {};
    for (const key of keys) {
      const allowedValues = allowed.get(key);
      if (!allowedValues) {
        throw new ApiError(
          422,
          "validation_error",
          `filters[${index}].values.${key} is not defined by the billable metric`,
        );
      }
      const selected = [
        ...new Set(
          stringArray(rawValues[key], `filters[${index}].values.${key}`, MAX_FILTER_VALUES),
        ),
      ].sort();
      const wildcard = selected.length === 1 && selected[0] === ALL_FILTER_VALUES;
      if (!wildcard && selected.some((candidate) => !allowedValues.has(candidate))) {
        throw new ApiError(
          422,
          "validation_error",
          `filters[${index}].values.${key} contains an unsupported value`,
        );
      }
      values[key] = selected;
    }
    const identity = stableJson(values);
    if (seen.has(identity)) {
      throw new ApiError(
        422,
        "validation_error",
        `filters[${index}].values duplicates another filter`,
      );
    }
    seen.add(identity);
    const properties =
      input.properties === undefined
        ? {}
        : { ...objectValue(input.properties, `filters[${index}].properties`) };
    delete properties.grouped_by;
    delete properties.pricing_group_keys;
    delete properties.presentation_group_keys;
    parseChargeModel(chargeModel, properties);
    filters.push({
      lagoId: await deterministicUuid("charge-filter", `${chargeId}:${identity}`),
      invoiceDisplayName: optionalText(
        input.invoice_display_name,
        `filters[${index}].invoice_display_name`,
      ),
      properties,
      values,
    });
  }
  return filters;
}

export function parseStoredBillableMetricFilters(value: string): BillableMetricFilter[] {
  return normalizeBillableMetricFilters(parseStoredArray(value));
}

export function parseStoredChargeFilters(
  value: string,
  metricFilters: BillableMetricFilter[],
  chargeModel: string,
  _chargeId: string,
): ChargeFilter[] {
  const entries = parseStoredArray(value);
  const allowed = new Map(metricFilters.map((filter) => [filter.key, new Set(filter.values)]));
  return entries.map((entry, index) => {
    const input = objectValue(entry, `stored_filters[${index}]`);
    const lagoId = requiredText(input.lagoId, `stored_filters[${index}].lagoId`);
    const properties = objectValue(input.properties, `stored_filters[${index}].properties`);
    parseChargeModel(chargeModel, properties);
    const rawValues = objectValue(input.values, `stored_filters[${index}].values`);
    const values: Record<string, string[]> = {};
    for (const key of Object.keys(rawValues).sort()) {
      const selected = stringArray(
        rawValues[key],
        `stored_filters[${index}].values.${key}`,
        MAX_FILTER_VALUES,
      );
      const allowedValues = allowed.get(key);
      const wildcard = selected.length === 1 && selected[0] === ALL_FILTER_VALUES;
      if (
        !allowedValues ||
        (!wildcard && selected.some((candidate) => !allowedValues.has(candidate)))
      ) {
        throw new Error("invalid_stored_filters");
      }
      values[key] = selected;
    }
    return {
      lagoId,
      invoiceDisplayName:
        input.invoiceDisplayName === null
          ? null
          : requiredText(input.invoiceDisplayName, `stored_filters[${index}].invoiceDisplayName`),
      properties,
      values,
    };
  });
}

export function serializeChargeFilter(
  filter: ChargeFilter,
  chargeCode: string,
): Record<string, unknown> {
  return {
    lago_id: filter.lagoId,
    charge_code: chargeCode,
    invoice_display_name: filter.invoiceDisplayName,
    properties: filter.properties,
    values: filter.values,
  };
}

export function partitionUsageEvents<T extends FilterableUsageEvent>(
  events: T[],
  filters: ChargeFilter[],
): { base: T[]; filters: Array<{ filter: ChargeFilter; events: T[] }> } {
  const partitions = filters.map((filter) => ({ filter, events: [] as T[] }));
  const base: T[] = [];
  for (const event of events) {
    let bestIndex = -1;
    let bestSpecificity = -1;
    for (const [index, filter] of filters.entries()) {
      const specificity = Object.keys(filter.values).length;
      if (specificity > bestSpecificity && eventMatchesFilter(event, filter)) {
        bestIndex = index;
        bestSpecificity = specificity;
      }
    }
    if (bestIndex < 0) base.push(event);
    else partitions[bestIndex]!.events.push(event);
  }
  return { base, filters: partitions };
}

function eventMatchesFilter(event: FilterableUsageEvent, filter: ChargeFilter): boolean {
  return Object.entries(filter.values).every(([key, selected]) => {
    if (!Object.prototype.hasOwnProperty.call(event.properties, key)) return false;
    if (selected.length === 1 && selected[0] === ALL_FILTER_VALUES) return true;
    const value = event.properties[key];
    return selected.includes(value === null || value === undefined ? "" : String(value));
  });
}

function parseStoredArray(value: string): unknown[] {
  const parsed = JSON.parse(value) as unknown;
  if (!Array.isArray(parsed)) throw new Error("invalid_stored_filters");
  return parsed;
}

function objectValue(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ApiError(422, "validation_error", `${field} must be an object`);
  }
  return value as Record<string, unknown>;
}

function requiredText(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new ApiError(422, "validation_error", `${field} must be a non-empty string`);
  }
  return value.trim();
}

function optionalText(value: unknown, field: string): string | null {
  if (value === undefined || value === null) return null;
  return requiredText(value, field);
}

function stringArray(value: unknown, field: string, maximum: number): string[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new ApiError(422, "validation_error", `${field} must be a non-empty array`);
  }
  if (value.length > maximum) {
    throw new ApiError(
      422,
      "validation_error",
      `${field} cannot contain more than ${maximum} values`,
    );
  }
  return value.map((candidate, index) => requiredText(candidate, `${field}[${index}]`));
}
