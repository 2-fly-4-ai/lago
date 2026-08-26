import { ApiError } from "../http";

export function normalizeSubscriptionAt(value: unknown): string | null {
  if (value === undefined || value === null || value === "") return null;
  let timestamp: Date;
  if (typeof value === "number" && Number.isFinite(value)) {
    timestamp = new Date(value * 1_000);
  } else if (typeof value === "string" && value.trim()) {
    timestamp = new Date(value.trim());
  } else {
    throw new ApiError(
      422,
      "validation_error",
      "subscription_at must be an ISO 8601 timestamp or epoch seconds",
    );
  }
  if (!Number.isFinite(timestamp.getTime())) {
    throw new ApiError(
      422,
      "validation_error",
      "subscription_at must be a valid ISO 8601 timestamp or epoch seconds",
    );
  }
  return timestamp.toISOString();
}

export function assertFutureSubscriptionAt(subscriptionAt: string, now: Date): void {
  if (Date.parse(subscriptionAt) <= now.getTime()) {
    throw new ApiError(
      422,
      "unsupported_subscription_feature",
      "subscription_at currently supports future activation only",
    );
  }
}

export function normalizeEndingAt(value: unknown): string | null {
  if (value === undefined || value === null || value === "") return null;
  let timestamp: Date;
  if (typeof value === "number" && Number.isFinite(value)) {
    timestamp = new Date(value * 1_000);
  } else if (typeof value === "string" && value.trim()) {
    timestamp = new Date(value.trim());
  } else {
    throw new ApiError(
      422,
      "validation_error",
      "ending_at must be an ISO 8601 timestamp or epoch seconds",
    );
  }
  if (!Number.isFinite(timestamp.getTime())) {
    throw new ApiError(
      422,
      "validation_error",
      "ending_at must be a valid ISO 8601 timestamp or epoch seconds",
    );
  }
  return timestamp.toISOString();
}

export function assertEndingAtAfterStart(endingAt: string, startAt: string): void {
  const endingDate = endingAt.slice(0, 10);
  const startDate = startAt.slice(0, 10);
  if (endingDate <= startDate) {
    throw new ApiError(
      422,
      "validation_error",
      "ending_at must be on a later UTC date than the subscription start",
    );
  }
}

export function assertFutureEndingAt(endingAt: string, now: Date): void {
  if (endingAt.slice(0, 10) <= now.toISOString().slice(0, 10)) {
    throw new ApiError(422, "validation_error", "ending_at must be on a future UTC date");
  }
}
