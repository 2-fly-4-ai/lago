import { ApiError } from "../http";

export type SubscriptionPaymentMethod = {
  paymentMethodId: string | null;
  paymentMethodType: "manual" | "provider" | null;
};

export function normalizeSubscriptionPaymentMethod(
  value: unknown,
): SubscriptionPaymentMethod | undefined {
  if (value === undefined) return undefined;
  if (value === null) return { paymentMethodId: null, paymentMethodType: null };
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ApiError(422, "validation_error", "payment_method must be an object");
  }
  const input = value as Record<string, unknown>;
  const unsupported = Object.keys(input).find(
    (key) => key !== "payment_method_id" && key !== "payment_method_type",
  );
  if (unsupported) {
    throw new ApiError(
      422,
      "unsupported_subscription_feature",
      `${unsupported} is not implemented for subscription payment methods`,
    );
  }
  const rawType = input.payment_method_type;
  const rawId = input.payment_method_id;
  const paymentMethodType =
    rawType === undefined || rawType === null || rawType === "" ? null : rawType;
  const paymentMethodId = rawId === undefined || rawId === null || rawId === "" ? null : rawId;
  if (paymentMethodType === null && paymentMethodId === null) {
    return { paymentMethodId: null, paymentMethodType: null };
  }
  if (paymentMethodType !== "manual" && paymentMethodType !== "provider") {
    throw new ApiError(422, "validation_error", "payment_method is invalid");
  }
  if (paymentMethodId !== null) {
    if (typeof paymentMethodId !== "string") {
      throw new ApiError(422, "validation_error", "payment_method_id must be a string");
    }
    throw new ApiError(
      422,
      "unsupported_subscription_payment_method",
      "Provider-specific payment method IDs require the Cloudflare payment-method registry",
    );
  }
  return { paymentMethodId: null, paymentMethodType };
}
