import { sha256Hex } from "../auth/api-key";
import { ApiError } from "../http";
import { stableJson } from "../json";
import { resolveWashingtonRate } from "./washington-dor";

const DEFAULT_MAX_DATA_AGE_DAYS = 45;
const LOCAL_QUOTE_TTL_MS = 30 * 60 * 1000;
const RATE_SCALE = 1_000_000n;

export type LocalTaxAddress = {
  country: string;
  state: string | null;
  postalCode: string | null;
  addressLine?: string | null;
  city?: string | null;
};

export type LocalRateResolution = {
  locationCode: string;
  jurisdiction: string;
  period: string;
  validThrough: string;
  stateRatePpm: number;
  localRatePpm: number;
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
  collectionMode: "collect" | "off";
  calculationMethod: "static" | "wa_dor_address";
  rateResolution: LocalRateResolution | null;
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
  collection_mode: "collect" | "off";
};

type RuleRow = {
  id: string;
  region: string | null;
  postal_prefix: string | null;
  taxability: "taxable" | "exempt";
  rate_ppm: number;
  priority: number;
  calculation_method: "static" | "wa_dor_address";
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
    fetcher?: typeof fetch;
    confirmedAddress?: boolean;
    beforeAddressLookup?: () => void;
  },
  now = new Date(),
): Promise<LocalTaxCalculation> {
  if (!Number.isSafeInteger(input.subtotalMinor) || input.subtotalMinor <= 0) {
    throw new ApiError(503, "checkout_tax_amount_invalid", "Tax amount is invalid");
  }
  const maxDataAgeDays = parseMaxDataAgeDays(input.maxDataAgeDays);
  const nowIso = now.toISOString();
  const ruleSet = await loadActiveRuleSet(database, nowIso);
  if (!ruleSet) {
    throw new ApiError(503, "checkout_tax_rules_unavailable", "Tax rules are unavailable");
  }
  const refreshedAt = Date.parse(ruleSet.refreshed_at);
  if (
    !Number.isFinite(refreshedAt) ||
    refreshedAt > now.getTime() ||
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
  let rateResolution: LocalRateResolution | null = null;
  let calculatedTax: number;
  if (selectedRule.calculation_method === "wa_dor_address") {
    input.beforeAddressLookup?.();
    const resolved = await resolveWashingtonAddressRate(
      input.address,
      input.fetcher ?? fetch,
      now,
      input.confirmedAddress === true,
    );
    if (resolved.stateRatePpm !== selectedRule.rate_ppm) {
      throw new ApiError(
        503,
        "checkout_tax_address_rate_mismatch",
        "Washington tax authority rate does not match reviewed state rules",
      );
    }
    rateResolution = resolved;
    calculatedTax = roundRate(input.subtotalMinor, resolved.stateRatePpm + resolved.localRatePpm);
  } else if (input.address.country === "CA" && selectedRule.taxability === "taxable") {
    calculatedTax = await calculateCanadianComponents(database, selectedRule, input.subtotalMinor);
  } else {
    calculatedTax = roundRate(input.subtotalMinor, selectedRule.rate_ppm);
  }
  const taxMinor =
    selectedRule.taxability === "exempt" || selectedScope.collection_mode === "off"
      ? 0
      : calculatedTax;
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
      calculation_method: selectedRule.calculation_method,
      rate_resolution: rateResolution,
      collection_scope_id: selectedScope.id,
      collection_mode: selectedScope.collection_mode,
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
    collectionMode: selectedScope.collection_mode,
    calculationMethod: selectedRule.calculation_method,
    rateResolution,
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
      `SELECT id, region, collection_mode
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
      `SELECT id, region, postal_prefix, taxability, rate_ppm, priority, calculation_method
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

async function resolveWashingtonAddressRate(
  address: LocalTaxAddress,
  fetcher: typeof fetch,
  now: Date,
  confirmedAddress: boolean,
): Promise<LocalRateResolution> {
  if (
    address.country !== "US" ||
    address.state !== "WA" ||
    !address.addressLine ||
    !address.city ||
    !address.postalCode
  ) {
    throw new ApiError(
      422,
      "invalid_billing_address",
      "Washington billing addresses require street, city, state and ZIP code",
    );
  }
  const postal = /^(\d{5})(?:-(\d{4}))?$/.exec(address.postalCode);
  if (!postal) {
    throw new ApiError(422, "invalid_billing_address", "Enter a valid Washington ZIP code");
  }
  const resolved = await resolveWashingtonRate(
    {
      addressLine: address.addressLine,
      city: address.city,
      zip: postal[1]!,
      plus4: postal[2] ?? null,
    },
    fetcher,
  );
  if (
    resolved.status !== "resolved" &&
    (resolved.resultCode !== 2 ||
      !confirmedAddress ||
      !sameWashingtonAddress(address, resolved.normalizedAddress))
  ) {
    const normalized = resolved.normalizedAddress;
    throw new ApiError(
      422,
      "checkout_tax_address_correction_required",
      resolved.resultCode === 2
        ? "We standardized your Washington billing address. Review it, then update the total again."
        : "Washington State could not uniquely confirm this billing address",
      resolved.resultCode === 2
        ? {
            normalized_address: {
              address_line: normalized.addressLine,
              city: normalized.city,
              state: "WA",
              postal_code: normalized.plus4
                ? `${normalized.zip}-${normalized.plus4}`
                : normalized.zip,
            },
          }
        : undefined,
    );
  }
  if (Date.parse(resolved.validThrough) <= now.getTime()) {
    throw new ApiError(503, "checkout_tax_address_rate_stale", "Washington tax rate is stale");
  }
  return {
    locationCode: resolved.locationCode,
    jurisdiction: `${resolved.jurisdiction}, ${resolved.county}`,
    period: resolved.period,
    validThrough: resolved.validThrough,
    stateRatePpm: resolved.stateRatePpm,
    localRatePpm: resolved.localRatePpm,
  };
}

function sameWashingtonAddress(
  submitted: LocalTaxAddress,
  normalized: {
    addressLine: string;
    city: string;
    zip: string;
    plus4?: string | null;
  },
): boolean {
  const submittedPostal = submitted.postalCode?.trim() ?? "";
  const normalizedPostal = normalized.plus4
    ? `${normalized.zip}-${normalized.plus4}`
    : normalized.zip;
  return (
    comparableAddressPart(submitted.addressLine) ===
      comparableAddressPart(normalized.addressLine) &&
    comparableAddressPart(submitted.city) === comparableAddressPart(normalized.city) &&
    submittedPostal === normalizedPostal
  );
}

function comparableAddressPart(value: string | null | undefined): string {
  return value?.trim().replace(/\s+/g, " ").toUpperCase() ?? "";
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

async function calculateCanadianComponents(
  database: D1Database,
  rule: RuleRow,
  subtotal: number,
): Promise<number> {
  const rows = await database
    .prepare(
      "SELECT code,rate_ppm FROM indirect_tax_rule_components WHERE rule_id=? ORDER BY code LIMIT 6",
    )
    .bind(rule.id)
    .all<{ code: string; rate_ppm: number }>();
  const components = rows.results;
  const codes = new Set(components.map((c) => c.code));
  const validShape =
    (components.length === 1 && (codes.has("GST") || codes.has("HST"))) ||
    (components.length === 2 &&
      codes.has("GST") &&
      ["PST", "RST", "QST"].some((code) => codes.has(code)));
  if (!validShape || components.reduce((sum, c) => sum + c.rate_ppm, 0) !== rule.rate_ppm) {
    throw new ApiError(503, "checkout_tax_components_invalid", "Tax components require review");
  }
  // Each independent levy uses the same pre-tax base; no tax-on-tax or combined rounding.
  const total = components.reduce((sum, c) => sum + roundRate(subtotal, c.rate_ppm), 0);
  if (!Number.isSafeInteger(total))
    throw new ApiError(503, "checkout_tax_amount_invalid", "Tax amount is invalid");
  return total;
}

function parseMaxDataAgeDays(value: string | undefined): number {
  if (!value) return DEFAULT_MAX_DATA_AGE_DAYS;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 365) {
    throw new ApiError(503, "checkout_tax_config_invalid", "Tax configuration is invalid");
  }
  return parsed;
}
