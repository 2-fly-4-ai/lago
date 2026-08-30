import { sha256Hex } from "../auth/api-key";
import { ApiError } from "../http";
import { stableJson } from "../json";

const DEFAULT_MAX_DATA_AGE_DAYS = 45;
const LOCAL_QUOTE_TTL_MS = 30 * 60 * 1000;
const RATE_SCALE = 1_000_000n;

export type LocalTaxAddress = {
  country: string;
  state: string | null;
  postalCode: string | null;
};

export type LocalTaxCalculation = {
  id: string;
  currency: string;
  subtotalMinor: number;
  taxMinor: number;
  totalMinor: number;
  expiresAt: string;
  ruleSetId: string;
  ruleId: string;
};

type RuleSetRow = {
  id: string;
  refreshed_at: string;
  effective_from: string;
  effective_to: string | null;
};

type RegistrationScopeRow = {
  id: string;
  region: string | null;
};

type RuleRow = {
  id: string;
  region: string | null;
  postal_prefix: string | null;
  taxability: "taxable" | "exempt";
  rate_ppm: number;
  priority: number;
};

export async function calculateLocalD1Tax(
  database: D1Database,
  input: {
    address: LocalTaxAddress;
    currency: string;
    maxDataAgeDays?: string;
    organizationId: string;
    requestHash: string;
    subtotalMinor: number;
    taxCode: string;
  },
  now = new Date(),
): Promise<LocalTaxCalculation> {
  const maxDataAgeDays = parseMaxDataAgeDays(input.maxDataAgeDays);
  const nowIso = now.toISOString();
  const ruleSet = await loadActiveRuleSet(database, nowIso);
  if (!ruleSet) {
    throw new ApiError(503, "checkout_tax_rules_unavailable", "Tax rules are unavailable");
  }
  const refreshedAt = Date.parse(ruleSet.refreshed_at);
  if (
    !Number.isFinite(refreshedAt) ||
    now.getTime() - refreshedAt > maxDataAgeDays * 24 * 60 * 60 * 1000
  ) {
    throw new ApiError(503, "checkout_tax_rules_stale", "Tax rules require review");
  }
  const scopes = await loadRegistrationScopes(
    database,
    input.organizationId,
    ruleSet.id,
    input.address,
    nowIso,
  );
  const selectedScope = selectMostSpecificScope(scopes, input.address);
  if (!selectedScope) {
    throw new ApiError(
      503,
      "checkout_tax_registration_missing",
      "Tax collection is not configured for this billing destination",
    );
  }
  const rules = await loadMatchingRules(database, ruleSet.id, input.address, input.taxCode, nowIso);
  const selectedRule = selectMostSpecificRule(rules, input.address);
  if (!selectedRule) {
    throw new ApiError(
      503,
      "checkout_tax_rule_missing",
      "Tax rules do not cover this billing destination",
    );
  }
  const taxMinor =
    selectedRule.taxability === "exempt"
      ? 0
      : roundRate(input.subtotalMinor, selectedRule.rate_ppm);
  const totalMinor = input.subtotalMinor + taxMinor;
  if (!Number.isSafeInteger(totalMinor)) {
    throw new ApiError(503, "checkout_tax_amount_invalid", "Tax amount is invalid");
  }
  const fingerprint = await sha256Hex(
    stableJson({
      address: input.address,
      currency: input.currency,
      organization_id: input.organizationId,
      request_sha256: input.requestHash,
      rule_id: selectedRule.id,
      rule_set_id: ruleSet.id,
      subtotal_minor: input.subtotalMinor,
      tax_code: input.taxCode,
    }),
  );
  return {
    id: `localtax_${fingerprint}`,
    currency: input.currency,
    subtotalMinor: input.subtotalMinor,
    taxMinor,
    totalMinor,
    expiresAt: new Date(now.getTime() + LOCAL_QUOTE_TTL_MS).toISOString(),
    ruleSetId: ruleSet.id,
    ruleId: selectedRule.id,
  };
}

async function loadActiveRuleSet(database: D1Database, nowIso: string): Promise<RuleSetRow | null> {
  const rows = await database
    .prepare(
      `SELECT id, refreshed_at, effective_from, effective_to
       FROM indirect_tax_rule_sets
       WHERE status = 'active'
         AND datetime(effective_from) <= datetime(?)
         AND (effective_to IS NULL OR datetime(effective_to) > datetime(?))
       LIMIT 2`,
    )
    .bind(nowIso, nowIso)
    .all<RuleSetRow>();
  if (rows.results.length > 1) {
    throw new ApiError(503, "checkout_tax_rules_ambiguous", "Tax rules require review");
  }
  return rows.results[0] ?? null;
}

async function loadRegistrationScopes(
  database: D1Database,
  organizationId: string,
  ruleSetId: string,
  address: LocalTaxAddress,
  nowIso: string,
): Promise<RegistrationScopeRow[]> {
  const rows = await database
    .prepare(
      `SELECT id, region
       FROM indirect_tax_registration_scopes
       WHERE organization_id = ? AND rule_set_id = ? AND country = ? AND status = 'enabled'
         AND (region IS NULL OR region = ?)
         AND datetime(effective_from) <= datetime(?)
         AND (effective_to IS NULL OR datetime(effective_to) > datetime(?))`,
    )
    .bind(organizationId, ruleSetId, address.country, address.state, nowIso, nowIso)
    .all<RegistrationScopeRow>();
  return rows.results;
}

function selectMostSpecificScope(
  scopes: RegistrationScopeRow[],
  address: LocalTaxAddress,
): RegistrationScopeRow | null {
  const ranked = scopes
    .filter((scope) => scope.region === null || scope.region === address.state)
    .map((scope) => ({ scope, specificity: scope.region === null ? 0 : 1 }))
    .sort((left, right) => right.specificity - left.specificity);
  if (ranked.length > 1 && ranked[0]!.specificity === ranked[1]!.specificity) {
    throw new ApiError(
      503,
      "checkout_tax_registration_ambiguous",
      "Tax registration requires review",
    );
  }
  return ranked[0]?.scope ?? null;
}

async function loadMatchingRules(
  database: D1Database,
  ruleSetId: string,
  address: LocalTaxAddress,
  taxCode: string,
  nowIso: string,
): Promise<RuleRow[]> {
  const rows = await database
    .prepare(
      `SELECT id, region, postal_prefix, taxability, rate_ppm, priority
       FROM indirect_tax_rules
       WHERE rule_set_id = ? AND country = ? AND product_tax_code = ?
         AND (region IS NULL OR region = ?)
         AND (postal_prefix IS NULL OR substr(?, 1, length(postal_prefix)) = postal_prefix)
         AND datetime(effective_from) <= datetime(?)
         AND (effective_to IS NULL OR datetime(effective_to) > datetime(?))`,
    )
    .bind(ruleSetId, address.country, taxCode, address.state, address.postalCode, nowIso, nowIso)
    .all<RuleRow>();
  return rows.results;
}

function selectMostSpecificRule(rules: RuleRow[], address: LocalTaxAddress): RuleRow | null {
  const ranked = rules
    .filter(
      (rule) =>
        (rule.region === null || rule.region === address.state) &&
        (rule.postal_prefix === null || address.postalCode?.startsWith(rule.postal_prefix)),
    )
    .map((rule) => ({
      priority: rule.priority,
      rule,
      specificity: (rule.region === null ? 0 : 1) + (rule.postal_prefix?.length ?? 0) * 2,
    }))
    .sort((left, right) => right.specificity - left.specificity || right.priority - left.priority);
  if (
    ranked.length > 1 &&
    ranked[0]!.specificity === ranked[1]!.specificity &&
    ranked[0]!.priority === ranked[1]!.priority
  ) {
    throw new ApiError(503, "checkout_tax_rule_ambiguous", "Tax rules require review");
  }
  return ranked[0]?.rule ?? null;
}

function roundRate(subtotalMinor: number, ratePpm: number): number {
  if (
    !Number.isSafeInteger(subtotalMinor) ||
    subtotalMinor <= 0 ||
    !Number.isSafeInteger(ratePpm) ||
    ratePpm < 0 ||
    ratePpm > Number(RATE_SCALE)
  ) {
    throw new ApiError(503, "checkout_tax_amount_invalid", "Tax amount is invalid");
  }
  const rounded = (BigInt(subtotalMinor) * BigInt(ratePpm) + RATE_SCALE / 2n) / RATE_SCALE;
  const result = Number(rounded);
  if (!Number.isSafeInteger(result)) {
    throw new ApiError(503, "checkout_tax_amount_invalid", "Tax amount is invalid");
  }
  return result;
}

function parseMaxDataAgeDays(value: string | undefined): number {
  if (!value) return DEFAULT_MAX_DATA_AGE_DAYS;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 365) {
    throw new ApiError(503, "checkout_tax_config_invalid", "Tax configuration is invalid");
  }
  return parsed;
}
