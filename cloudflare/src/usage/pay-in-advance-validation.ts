import { ApiError } from "../http";

type PayInAdvanceUsageConfiguration = {
  payInAdvance: number;
  prorated: number;
  invoiceable: number;
  minAmountMinor: number;
  aggregationType: string;
  chargeModel: string;
  properties: Record<string, unknown>;
};

const PAYABLE_AGGREGATIONS = new Set(["count_agg", "sum_agg", "unique_count_agg"]);

export function validatePayInAdvanceUsageConfiguration(
  configuration: PayInAdvanceUsageConfiguration,
): void {
  if (configuration.payInAdvance !== 1) {
    if (configuration.prorated === 1) {
      throw new ApiError(
        422,
        "unsupported_charge_feature",
        "Prorated usage charges are not implemented",
      );
    }
    return;
  }

  if (configuration.invoiceable !== 1) {
    throw new ApiError(
      422,
      "unsupported_charge_feature",
      "Non-invoiceable pay-in-advance usage charges require standalone fee regrouping",
    );
  }
  if (configuration.prorated === 1) {
    throw new ApiError(
      422,
      "unsupported_charge_feature",
      "Prorated pay-in-advance usage charges are not implemented",
    );
  }
  if (!PAYABLE_AGGREGATIONS.has(configuration.aggregationType)) {
    throw new ApiError(
      422,
      "invalid_billable_metric",
      "Pay-in-advance usage supports count, sum, and unique-count metrics",
    );
  }
  if (configuration.chargeModel === "volume") {
    throw new ApiError(
      422,
      "invalid_charge_model",
      "Volume usage charges cannot be billed in advance",
    );
  }
  if (configuration.minAmountMinor !== 0) {
    throw new ApiError(
      422,
      "invalid_min_amount",
      "Pay-in-advance usage charges cannot define a minimum amount",
    );
  }
  for (const field of ["grouped_by", "pricing_group_keys"]) {
    const value = configuration.properties[field];
    if (value !== undefined && value !== null && (!Array.isArray(value) || value.length > 0)) {
      throw new ApiError(
        422,
        "unsupported_charge_properties",
        `${field} is not implemented for pay-in-advance usage charges`,
      );
    }
  }
}
