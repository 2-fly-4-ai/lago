import { ApiError, optionalString } from "../http";
import { deterministicUuid } from "../identifiers";

export type UsageThresholdRow = {
  id: string;
  organization_id: string;
  plan_id: string | null;
  subscription_id: string | null;
  amount_minor: number;
  recurring: number;
  threshold_display_name: string | null;
  version: number;
  deleted_at: string | null;
  created_at: string;
  updated_at: string;
};

export type NormalizedUsageThresholdInput = {
  amountMinor: number;
  recurring: 0 | 1;
  displayName: string | null;
};

export type PreparedUsageThreshold = NormalizedUsageThresholdInput & { id: string };

export type UsageThresholdAmounts = {
  historicalUsageMinor: number;
  invoicedUsageMinor: number;
  currentUsageMinor: number;
  progressiveBilledUsageMinor: number;
};

export async function applicableUsageThresholds(
  database: D1Database,
  organizationId: string,
  subscriptionId: string,
  planId: string,
): Promise<UsageThresholdRow[]> {
  const result = await database
    .prepare(
      `SELECT id, organization_id, plan_id, subscription_id, amount_minor, recurring,
              threshold_display_name, version, deleted_at, created_at, updated_at
       FROM usage_thresholds
       WHERE organization_id = ? AND deleted_at IS NULL
         AND (subscription_id = ? OR (plan_id = ? AND NOT EXISTS (
           SELECT 1 FROM usage_thresholds subscription_threshold
           WHERE subscription_threshold.organization_id = ?
             AND subscription_threshold.subscription_id = ?
             AND subscription_threshold.deleted_at IS NULL
         )))
       ORDER BY recurring, amount_minor, id`,
    )
    .bind(organizationId, subscriptionId, planId, organizationId, subscriptionId)
    .all<UsageThresholdRow>();
  return [...result.results];
}

export async function ownedUsageThresholds(
  database: D1Database,
  organizationId: string,
  owner: { planId: string } | { subscriptionId: string },
): Promise<UsageThresholdRow[]> {
  const ownerColumn = "planId" in owner ? "plan_id" : "subscription_id";
  const ownerId = "planId" in owner ? owner.planId : owner.subscriptionId;
  const result = await database
    .prepare(
      `SELECT id, organization_id, plan_id, subscription_id, amount_minor, recurring,
              threshold_display_name, version, deleted_at, created_at, updated_at
       FROM usage_thresholds
       WHERE organization_id = ? AND ${ownerColumn} = ? AND deleted_at IS NULL
       ORDER BY recurring, amount_minor, id`,
    )
    .bind(organizationId, ownerId)
    .all<UsageThresholdRow>();
  return [...result.results];
}

export function normalizeUsageThresholdInputs(value: unknown): NormalizedUsageThresholdInput[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    throw new ApiError(422, "validation_error", "usage_thresholds must be an array");
  }
  const normalized = value.map((entry, index) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new ApiError(422, "validation_error", `usage_thresholds[${index}] must be an object`);
    }
    const input = entry as Record<string, unknown>;
    const amountMinor = positiveInteger(
      input.amount_cents,
      `usage_thresholds[${index}].amount_cents`,
    );
    return {
      amountMinor,
      recurring: booleanInteger(input.recurring),
      displayName: optionalString(input, "threshold_display_name"),
    };
  });
  const identities = new Set<string>();
  let recurringCount = 0;
  for (const threshold of normalized) {
    const identity = `${threshold.recurring}:${threshold.amountMinor}`;
    if (identities.has(identity)) {
      throw new ApiError(422, "duplicated_values", "usage_thresholds has duplicated values");
    }
    identities.add(identity);
    if (threshold.recurring === 1) recurringCount += 1;
  }
  if (recurringCount > 1) {
    throw new ApiError(
      422,
      "multiple_recurring_thresholds",
      "usage_thresholds supports at most one recurring threshold",
    );
  }
  return normalized;
}

export async function prepareUsageThresholds(
  namespace: string,
  organizationId: string,
  ownerId: string,
  ownerVersion: number,
  inputs: NormalizedUsageThresholdInput[],
): Promise<PreparedUsageThreshold[]> {
  return Promise.all(
    inputs.map(async (threshold) => ({
      ...threshold,
      id: await deterministicUuid(
        "usage-threshold",
        `${namespace}:${organizationId}:${ownerId}:${ownerVersion}:${threshold.recurring}:${threshold.amountMinor}`,
      ),
    })),
  );
}

export function usageThresholdInsertStatements(
  database: D1Database,
  organizationId: string,
  owner: { planId: string } | { subscriptionId: string },
  thresholds: PreparedUsageThreshold[],
  now: string,
): D1PreparedStatement[] {
  const planId = "planId" in owner ? owner.planId : null;
  const subscriptionId = "subscriptionId" in owner ? owner.subscriptionId : null;
  return thresholds.map((threshold) =>
    database
      .prepare(
        `INSERT INTO usage_thresholds
         (id, organization_id, plan_id, subscription_id, amount_minor, recurring,
          threshold_display_name, version, deleted_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 1, NULL, ?, ?)`,
      )
      .bind(
        threshold.id,
        organizationId,
        planId,
        subscriptionId,
        threshold.amountMinor,
        threshold.recurring,
        threshold.displayName,
        now,
        now,
      ),
  );
}

export function serializeUsageThreshold(threshold: UsageThresholdRow): Record<string, unknown> {
  return {
    lago_id: threshold.id,
    amount_cents: threshold.amount_minor,
    recurring: threshold.recurring === 1,
    threshold_display_name: threshold.threshold_display_name,
    created_at: threshold.created_at,
    updated_at: threshold.updated_at,
  };
}

export function passedUsageThresholds(
  thresholds: UsageThresholdRow[],
  amounts: UsageThresholdAmounts,
): UsageThresholdRow[] {
  assertAmounts(amounts);
  const fixed = thresholds
    .filter((threshold) => threshold.recurring === 0)
    .sort(
      (left, right) => left.amount_minor - right.amount_minor || left.id.localeCompare(right.id),
    );
  const recurring = thresholds.find((threshold) => threshold.recurring === 1);
  if (thresholds.filter((threshold) => threshold.recurring === 1).length > 1) {
    throw new Error("multiple_recurring_usage_thresholds");
  }
  const actualCurrentUsage = amounts.currentUsageMinor - amounts.progressiveBilledUsageMinor;
  if (actualCurrentUsage < 0) return [];
  const invoicedUsage =
    amounts.historicalUsageMinor + amounts.invoicedUsageMinor + amounts.progressiveBilledUsageMinor;
  const largestFixedAmount = fixed.at(-1)?.amount_minor ?? 0;
  const totalUsage = invoicedUsage + actualCurrentUsage;
  const passed: UsageThresholdRow[] = [];
  if (invoicedUsage < largestFixedAmount) {
    passed.push(
      ...fixed.filter(
        (threshold) =>
          threshold.amount_minor > invoicedUsage && threshold.amount_minor <= totalUsage,
      ),
    );
    if (recurring && totalUsage - largestFixedAmount >= recurring.amount_minor) {
      passed.push(recurring);
    }
  } else if (recurring) {
    const recurringRemainder = invoicedUsage % recurring.amount_minor;
    if (actualCurrentUsage + recurringRemainder >= recurring.amount_minor) {
      passed.push(recurring);
    }
  }
  return passed;
}

function assertAmounts(amounts: UsageThresholdAmounts): void {
  for (const value of Object.values(amounts)) {
    if (!Number.isSafeInteger(value) || value < 0)
      throw new Error("invalid_usage_threshold_amount");
  }
}

function positiveInteger(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw new ApiError(422, "validation_error", `${field} must be greater than zero`);
  }
  return value;
}

function booleanInteger(value: unknown): 0 | 1 {
  if (value === undefined || value === null) return 0;
  if (typeof value !== "boolean") {
    throw new ApiError(422, "validation_error", "usage threshold recurring must be boolean");
  }
  return value ? 1 : 0;
}
