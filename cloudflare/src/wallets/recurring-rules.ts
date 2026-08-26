import { ApiError } from "../http";
import { Decimal } from "../rating/decimal";
import {
  normalizeSubscriptionCustomSections,
  serializeAppliedCustomSectionsForResources,
  type SerializedAppliedCustomSection,
  type SubscriptionCustomSections,
} from "../subscriptions/custom-sections";

export const RECURRING_RULE_INTERVALS = [
  "weekly",
  "monthly",
  "quarterly",
  "semiannual",
  "yearly",
] as const;

export type RecurringRuleInterval = (typeof RECURRING_RULE_INTERVALS)[number];

export type RecurringRuleRow = {
  id: string;
  organization_id: string;
  wallet_id: string;
  interval: RecurringRuleInterval;
  method: "fixed";
  trigger: "interval" | "threshold";
  storage_kind: "interval" | "threshold";
  paid_credits: string;
  granted_credits: string;
  threshold_credits: string;
  started_at: string | null;
  expiration_at: string | null;
  status: "active" | "terminated";
  transaction_metadata_json: string;
  transaction_name: string | null;
  payment_method_id: string | null;
  invoice_requires_successful_payment: number;
  ignore_paid_top_up_limits: number;
  skip_invoice_custom_sections: number;
  version: number;
  created_at: string;
  updated_at: string;
  terminated_at: string | null;
};

export type NormalizedRecurringRule = {
  lagoId: string | null;
  interval: RecurringRuleInterval;
  trigger: "interval" | "threshold";
  paidCredits: string;
  grantedCredits: string;
  thresholdCredits: string;
  startedAt: string | null;
  expirationAt: string | null;
  transactionMetadata: Array<{ key?: string; value?: string }>;
  transactionName: string | null;
  paymentMethodId: string | null;
  invoiceRequiresSuccessfulPayment: boolean;
  ignorePaidTopUpLimits: boolean;
  customSections: SubscriptionCustomSections | undefined;
};

export type SerializedRecurringRule = ReturnType<typeof serializeRecurringRule>;

export function normalizeRecurringRuleList(value: unknown): Record<string, unknown>[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value))
    throw new ApiError(422, "validation_error", "recurring_transaction_rules must be an array");
  if (value.length > 1)
    throw new ApiError(
      422,
      "invalid_number_of_recurring_rules",
      "Only one active recurring transaction rule is supported per wallet",
    );
  return value.map((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry))
      throw new ApiError(422, "invalid_recurring_rule", "Recurring transaction rule is invalid");
    return entry as Record<string, unknown>;
  });
}

export function normalizeRecurringRule(
  input: Record<string, unknown>,
  options: {
    fallbackGrantedCredits: string | null;
    now: string;
    current?: RecurringRuleRow;
  },
): NormalizedRecurringRule {
  const supported = new Set([
    "lago_id",
    "interval",
    "method",
    "paid_credits",
    "granted_credits",
    "started_at",
    "expiration_at",
    "target_ongoing_balance",
    "threshold_credits",
    "trigger",
    "invoice_requires_successful_payment",
    "ignore_paid_top_up_limits",
    "transaction_name",
    "invoice_custom_section",
    "transaction_metadata",
    "payment_method",
  ]);
  const unknown = Object.keys(input).find((key) => !supported.has(key));
  if (unknown)
    throw new ApiError(
      422,
      "unsupported_recurring_wallet_feature",
      `${unknown} is not implemented for recurring wallet rules`,
    );

  const trigger = stringValue(input.trigger, "trigger") ?? options.current?.trigger ?? "interval";
  if (trigger !== "interval" && trigger !== "threshold")
    throw new ApiError(422, "invalid_recurring_rule", "Recurring trigger is invalid");
  const method = stringValue(input.method, "method") ?? options.current?.method ?? "fixed";
  if (method !== "fixed") unsupported("target method requires paid-credit processing");

  const paidCredits = decimalOrDefault(input.paid_credits, options.current?.paid_credits ?? "0");
  if (input.target_ongoing_balance !== undefined && input.target_ongoing_balance !== null)
    unsupported("target ongoing balance requires paid-credit processing");
  const paymentMethodId =
    input.payment_method === undefined
      ? (options.current?.payment_method_id ?? null)
      : paymentMethod(input.payment_method);
  if (Decimal.parse(paidCredits).compare(Decimal.zero()) > 0 && !paymentMethodId)
    throw new ApiError(
      422,
      "payment_method_required",
      "Paid recurring credits require a payment method",
    );
  if (Decimal.parse(paidCredits).compare(Decimal.zero()) === 0 && paymentMethodId)
    throw new ApiError(422, "invalid_recurring_rule", "A payment method requires paid credits");
  const invoiceRequiresSuccessfulPayment = booleanOrCurrent(
    input.invoice_requires_successful_payment,
    "invoice_requires_successful_payment",
    options.current?.invoice_requires_successful_payment === 1,
  );
  const ignorePaidTopUpLimits = booleanOrCurrent(
    input.ignore_paid_top_up_limits,
    "ignore_paid_top_up_limits",
    options.current?.ignore_paid_top_up_limits === 1,
  );

  const intervalValue =
    stringValue(input.interval, "interval") ?? options.current?.interval ?? "weekly";
  if (!intervalValue || !RECURRING_RULE_INTERVALS.includes(intervalValue as RecurringRuleInterval))
    throw new ApiError(422, "invalid_recurring_rule", "Recurring interval is invalid");

  const grantedCredits = decimalOrDefault(
    input.granted_credits,
    options.current?.granted_credits ?? options.fallbackGrantedCredits ?? "0",
  );
  const thresholdCredits = decimalOrDefault(
    input.threshold_credits,
    options.current?.threshold_credits ?? "0",
  );
  const startedAt = timestampOrCurrent(input, "started_at", options.current?.started_at ?? null);
  const expirationAt = timestampOrCurrent(
    input,
    "expiration_at",
    options.current?.expiration_at ?? null,
  );
  if (expirationAt && expirationAt <= options.now)
    throw new ApiError(422, "invalid_recurring_rule", "expiration_at must be in the future");

  return {
    lagoId: nullableId(input.lago_id),
    interval: intervalValue as RecurringRuleInterval,
    trigger,
    paidCredits,
    grantedCredits,
    thresholdCredits,
    startedAt,
    expirationAt,
    transactionMetadata:
      input.transaction_metadata === undefined
        ? parseMetadata(options.current?.transaction_metadata_json ?? "[]")
        : normalizeMetadata(input.transaction_metadata),
    transactionName:
      input.transaction_name === undefined
        ? (options.current?.transaction_name ?? null)
        : normalizeName(input.transaction_name),
    paymentMethodId,
    invoiceRequiresSuccessfulPayment,
    ignorePaidTopUpLimits,
    customSections:
      input.invoice_custom_section === undefined
        ? undefined
        : normalizeSubscriptionCustomSections(input.invoice_custom_section),
  };
}

export async function activeRecurringRuleRows(
  database: D1Database,
  organizationId: string,
  walletId: string,
): Promise<RecurringRuleRow[]> {
  const result = await database
    .prepare(`${recurringRuleUnion()} ORDER BY created_at, id`)
    .bind(organizationId, walletId, organizationId, walletId)
    .all<RecurringRuleRow>();
  return result.results;
}

export async function serializeRecurringRulesForWallets(
  database: D1Database,
  walletIds: string[],
  now = new Date().toISOString(),
): Promise<Map<string, ReturnType<typeof serializeRecurringRule>[]>> {
  const grouped = new Map<string, ReturnType<typeof serializeRecurringRule>[]>();
  if (walletIds.length === 0) return grouped;
  const placeholders = walletIds.map(() => "?").join(", ");
  const rows = await database
    .prepare(
      `SELECT id, organization_id, wallet_id, interval, method, trigger, storage_kind,
              paid_credits, granted_credits, threshold_credits, started_at, expiration_at,
              status, transaction_metadata_json, transaction_name,
              payment_method_id,
              invoice_requires_successful_payment, ignore_paid_top_up_limits,
              skip_invoice_custom_sections, version, created_at, updated_at, terminated_at
       FROM (
         SELECT rule.id, rule.organization_id, rule.wallet_id, rule.interval, rule.method, rule.trigger,
                'interval' AS storage_kind, COALESCE(funding.paid_credits, rule.paid_credits) AS paid_credits,
                rule.granted_credits,
                threshold_credits, started_at, expiration_at, status,
                transaction_metadata_json, transaction_name, funding.payment_method_id,
                COALESCE(funding.invoice_requires_successful_payment, rule.invoice_requires_successful_payment)
                  AS invoice_requires_successful_payment,
                COALESCE(funding.ignore_paid_top_up_limits, rule.ignore_paid_top_up_limits)
                  AS ignore_paid_top_up_limits,
                skip_invoice_custom_sections, version, rule.created_at AS created_at,
                rule.updated_at AS updated_at, terminated_at
         FROM recurring_transaction_rules rule
         LEFT JOIN provider_recurring_wallet_rule_funding funding
           ON funding.rule_id = rule.id AND funding.storage_kind = 'interval'
         WHERE rule.wallet_id IN (${placeholders}) AND status = 'active'
           AND (expiration_at IS NULL OR expiration_at > ?)
         UNION ALL
         SELECT rule.id, rule.organization_id, rule.wallet_id, rule.interval, rule.method, rule.trigger,
                'threshold' AS storage_kind, COALESCE(funding.paid_credits, rule.paid_credits) AS paid_credits,
                rule.granted_credits, threshold_credits,
                started_at, expiration_at, status, transaction_metadata_json, transaction_name,
                funding.payment_method_id,
                COALESCE(funding.invoice_requires_successful_payment, rule.invoice_requires_successful_payment)
                  AS invoice_requires_successful_payment,
                COALESCE(funding.ignore_paid_top_up_limits, rule.ignore_paid_top_up_limits)
                  AS ignore_paid_top_up_limits,
                skip_invoice_custom_sections, version, rule.created_at AS created_at,
                rule.updated_at AS updated_at, terminated_at
         FROM wallet_threshold_rules rule
         LEFT JOIN provider_recurring_wallet_rule_funding funding
           ON funding.rule_id = rule.id AND funding.storage_kind = 'threshold'
         WHERE rule.wallet_id IN (${placeholders}) AND status = 'active'
           AND (expiration_at IS NULL OR expiration_at > ?)
       ) ORDER BY wallet_id, created_at, id`,
    )
    .bind(...walletIds, now, ...walletIds, now)
    .all<RecurringRuleRow>();
  const intervalIds = rows.results
    .filter((row) => row.storage_kind === "interval")
    .map((row) => row.id);
  const thresholdIds = rows.results
    .filter((row) => row.storage_kind === "threshold")
    .map((row) => row.id);
  const [intervalSections, thresholdSections] = await Promise.all([
    serializeAppliedCustomSectionsForResources(
      database,
      {
        table: "recurring_transaction_rules_invoice_custom_sections",
        ownerColumn: "recurring_transaction_rule_id",
      },
      intervalIds,
    ),
    serializeAppliedCustomSectionsForResources(
      database,
      {
        table: "wallet_threshold_rules_invoice_custom_sections",
        ownerColumn: "wallet_threshold_rule_id",
      },
      thresholdIds,
    ),
  ]);
  for (const row of rows.results) {
    const sections = row.storage_kind === "interval" ? intervalSections : thresholdSections;
    const serialized = serializeRecurringRule(row, sections.get(row.id) ?? []);
    const walletRules = grouped.get(row.wallet_id) ?? [];
    walletRules.push(serialized);
    grouped.set(row.wallet_id, walletRules);
  }
  return grouped;
}

function serializeRecurringRule(row: RecurringRuleRow, sections: SerializedAppliedCustomSection[]) {
  return {
    lago_id: row.id,
    paid_credits: row.paid_credits,
    granted_credits: row.granted_credits,
    interval: row.interval,
    method: row.method,
    started_at: row.started_at,
    expiration_at: row.expiration_at,
    status: row.status,
    target_ongoing_balance: null,
    threshold_credits: row.threshold_credits,
    trigger: row.trigger,
    created_at: row.created_at,
    invoice_requires_successful_payment: row.invoice_requires_successful_payment === 1,
    transaction_metadata: parseMetadata(row.transaction_metadata_json),
    transaction_name: row.transaction_name,
    ignore_paid_top_up_limits: row.ignore_paid_top_up_limits === 1,
    applied_invoice_custom_sections: sections,
    payment_method: {
      payment_method_id: row.payment_method_id,
      payment_method_type: "provider",
    },
  };
}

function recurringRuleUnion() {
  return `SELECT rule.id, rule.organization_id, rule.wallet_id, rule.interval, rule.method, rule.trigger,
                 'interval' AS storage_kind,
                 COALESCE(funding.paid_credits, rule.paid_credits) AS paid_credits,
                 rule.granted_credits,
                 threshold_credits, started_at, expiration_at, status,
                 transaction_metadata_json, transaction_name, funding.payment_method_id,
                 COALESCE(funding.invoice_requires_successful_payment, rule.invoice_requires_successful_payment)
                   AS invoice_requires_successful_payment,
                 COALESCE(funding.ignore_paid_top_up_limits, rule.ignore_paid_top_up_limits)
                   AS ignore_paid_top_up_limits,
                 skip_invoice_custom_sections, version, rule.created_at AS created_at,
                 rule.updated_at AS updated_at, terminated_at
          FROM recurring_transaction_rules rule
          LEFT JOIN provider_recurring_wallet_rule_funding funding
            ON funding.rule_id = rule.id AND funding.storage_kind = 'interval'
          WHERE rule.organization_id = ? AND rule.wallet_id = ? AND status = 'active'
          UNION ALL
          SELECT rule.id, rule.organization_id, rule.wallet_id, rule.interval, rule.method, rule.trigger,
                 'threshold' AS storage_kind,
                 COALESCE(funding.paid_credits, rule.paid_credits) AS paid_credits,
                 rule.granted_credits, threshold_credits,
                 started_at, expiration_at, status, transaction_metadata_json, transaction_name,
                 funding.payment_method_id,
                 COALESCE(funding.invoice_requires_successful_payment, rule.invoice_requires_successful_payment)
                   AS invoice_requires_successful_payment,
                 COALESCE(funding.ignore_paid_top_up_limits, rule.ignore_paid_top_up_limits)
                   AS ignore_paid_top_up_limits,
                 skip_invoice_custom_sections, version, rule.created_at AS created_at,
                 rule.updated_at AS updated_at, terminated_at
          FROM wallet_threshold_rules rule
          LEFT JOIN provider_recurring_wallet_rule_funding funding
            ON funding.rule_id = rule.id AND funding.storage_kind = 'threshold'
          WHERE rule.organization_id = ? AND rule.wallet_id = ? AND status = 'active'`;
}

function decimalOrDefault(value: unknown, fallback: string): string {
  if (value === undefined) return fallback;
  if (value === null) return "0";
  if ((typeof value !== "string" && typeof value !== "number") || String(value).trim() === "")
    throw new ApiError(422, "invalid_recurring_rule", "Recurring credits must be decimals");
  try {
    const decimal = Decimal.parse(String(value));
    if (decimal.isNegative()) throw new Error();
    return decimal.toString();
  } catch {
    throw new ApiError(422, "invalid_recurring_rule", "Recurring credits must be non-negative");
  }
}

function timestampOrCurrent(
  input: Record<string, unknown>,
  field: "started_at" | "expiration_at",
  current: string | null,
): string | null {
  if (input[field] === undefined) return current;
  if (input[field] === null) return null;
  if (typeof input[field] !== "string" || !Number.isFinite(Date.parse(input[field])))
    throw new ApiError(422, "invalid_recurring_rule", `${field} must be an ISO timestamp`);
  return new Date(input[field]).toISOString();
}

function normalizeMetadata(value: unknown): Array<{ key?: string; value?: string }> {
  if (value === null) return [];
  if (!Array.isArray(value))
    throw new ApiError(422, "invalid_recurring_rule", "transaction_metadata must be an array");
  return value.map((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry))
      throw new ApiError(422, "invalid_recurring_rule", "transaction_metadata is invalid");
    const object = entry as Record<string, unknown>;
    const unknown = Object.keys(object).find((key) => key !== "key" && key !== "value");
    if (unknown || Object.values(object).some((item) => typeof item !== "string"))
      throw new ApiError(422, "invalid_recurring_rule", "transaction_metadata is invalid");
    return object as { key?: string; value?: string };
  });
}

function parseMetadata(value: string): Array<{ key?: string; value?: string }> {
  try {
    return normalizeMetadata(JSON.parse(value) as unknown);
  } catch {
    return [];
  }
}

function normalizeName(value: unknown): string | null {
  if (value === null) return null;
  if (typeof value !== "string")
    throw new ApiError(422, "invalid_recurring_rule", "transaction_name must be a string");
  const normalized = value.trim();
  if (!normalized) return null;
  if (normalized.length > 255)
    throw new ApiError(422, "invalid_recurring_rule", "transaction_name is too long");
  return normalized;
}

function nullableId(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || !value.trim())
    throw new ApiError(422, "invalid_recurring_rule", "lago_id must be a non-empty string");
  return value.trim();
}

function stringValue(value: unknown, field: string): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || !value.trim())
    throw new ApiError(422, "invalid_recurring_rule", `${field} must be a non-empty string`);
  return value.trim();
}

function booleanValue(value: unknown, field: string): boolean {
  if (value === undefined || value === null) return false;
  if (typeof value !== "boolean")
    throw new ApiError(422, "invalid_recurring_rule", `${field} must be a boolean`);
  return value;
}

function booleanOrCurrent(value: unknown, field: string, current: boolean): boolean {
  return value === undefined ? current : booleanValue(value, field);
}

function paymentMethod(value: unknown): string | null {
  if (value === null) return null;
  const candidate =
    typeof value === "string"
      ? value
      : value && typeof value === "object" && !Array.isArray(value)
        ? (value as Record<string, unknown>).payment_method_id
        : null;
  if (typeof candidate !== "string" || !candidate.trim() || candidate.trim().length > 255)
    throw new ApiError(422, "invalid_recurring_rule", "payment_method_id is invalid");
  return candidate.trim();
}

function unsupported(message: string): never {
  throw new ApiError(422, "unsupported_recurring_wallet_feature", message);
}
