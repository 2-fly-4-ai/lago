import { ApiError } from "../http";

export type TaxTargetType =
  | "billing_entity"
  | "customer"
  | "plan"
  | "charge"
  | "fixed_charge"
  | "commitment"
  | "add_on";

export type ResolvedTax = {
  id: string;
  code: string;
  name: string;
  description: string | null;
  rate: string;
};

export function normalizeTaxCodes(value: unknown, field = "tax_codes"): string[] | undefined {
  if (value === undefined) return undefined;
  if (value === null) return [];
  if (!Array.isArray(value)) {
    throw new ApiError(422, "validation_error", `${field} must be an array`);
  }
  const result: string[] = [];
  const seen = new Set<string>();
  for (const [index, candidate] of value.entries()) {
    if (typeof candidate !== "string" || candidate.trim() === "") {
      throw new ApiError(422, "validation_error", `${field}[${index}] must be a non-empty string`);
    }
    const code = candidate.trim();
    if (seen.has(code)) continue;
    seen.add(code);
    result.push(code);
  }
  return result;
}

export async function resolveActiveTaxes(
  database: D1Database,
  organizationId: string,
  codes: string[],
): Promise<ResolvedTax[]> {
  if (codes.length === 0) return [];
  const placeholders = codes.map(() => "?").join(", ");
  const result = await database
    .prepare(
      `SELECT id, code, name, description, rate FROM taxes
       WHERE organization_id = ? AND status = 'active' AND code IN (${placeholders})`,
    )
    .bind(organizationId, ...codes)
    .all<ResolvedTax>();
  const byCode = new Map(result.results.map((tax) => [tax.code, tax]));
  const missing = codes.find((code) => !byCode.has(code));
  if (missing) throw new ApiError(404, "tax_not_found", `Tax ${missing} was not found`);
  return codes.map((code) => byCode.get(code)!);
}

export function replaceTaxTargetStatements(
  database: D1Database,
  organizationId: string,
  targetType: TaxTargetType,
  targetId: string,
  taxes: ResolvedTax[],
  now: string,
): D1PreparedStatement[] {
  return [
    database
      .prepare(
        `DELETE FROM tax_targets
         WHERE organization_id = ? AND target_type = ? AND target_id = ?`,
      )
      .bind(organizationId, targetType, targetId),
    ...taxes.map((tax) =>
      database
        .prepare(
          `INSERT INTO tax_targets
           (organization_id, tax_id, target_type, target_id, created_at)
           VALUES (?, ?, ?, ?, ?)`,
        )
        .bind(organizationId, tax.id, targetType, targetId, now),
    ),
  ];
}

export function guardedReplaceTaxTargetStatements(
  database: D1Database,
  organizationId: string,
  targetType: Exclude<TaxTargetType, "billing_entity" | "commitment">,
  targetId: string,
  taxes: ResolvedTax[],
  now: string,
  expectedVersion: number,
): D1PreparedStatement[] {
  const table = {
    customer: "customers",
    plan: "plans",
    charge: "charges",
    fixed_charge: "fixed_charges",
    add_on: "add_ons",
  }[targetType];
  const current = `EXISTS (
    SELECT 1 FROM ${table}
    WHERE id = ? AND organization_id = ? AND version = ? AND updated_at = ?
  )`;
  return [
    database
      .prepare(
        `DELETE FROM tax_targets
         WHERE organization_id = ? AND target_type = ? AND target_id = ? AND ${current}`,
      )
      .bind(organizationId, targetType, targetId, targetId, organizationId, expectedVersion, now),
    ...taxes.map((tax) =>
      database
        .prepare(
          `INSERT INTO tax_targets
           (organization_id, tax_id, target_type, target_id, created_at)
           SELECT ?, ?, ?, ?, ? WHERE ${current}`,
        )
        .bind(
          organizationId,
          tax.id,
          targetType,
          targetId,
          now,
          targetId,
          organizationId,
          expectedVersion,
          now,
        ),
    ),
  ];
}

export async function taxesForTarget(
  database: D1Database,
  organizationId: string,
  targetType: TaxTargetType,
  targetId: string,
): Promise<ResolvedTax[]> {
  const result = await database
    .prepare(
      `SELECT tax.id, tax.code, tax.name, tax.description, tax.rate
       FROM tax_targets target JOIN taxes tax ON tax.id = target.tax_id
       WHERE target.organization_id = ? AND target.target_type = ? AND target.target_id = ?
         AND tax.organization_id = ? AND tax.status = 'active'
       ORDER BY target.created_at, tax.id`,
    )
    .bind(organizationId, targetType, targetId, organizationId)
    .all<ResolvedTax>();
  return result.results;
}
