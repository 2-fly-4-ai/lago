import { ApiError } from "../http";

export type SubscriptionCustomSections = {
  skip: boolean | undefined;
  codes: string[] | undefined;
};

export type CustomerCustomSections = {
  skip: boolean | undefined;
  codes: string[] | undefined;
};

export function normalizeCustomerCustomSections(
  input: Record<string, unknown>,
): CustomerCustomSections {
  const rawSkip = input.skip_invoice_custom_sections;
  if (rawSkip !== undefined && typeof rawSkip !== "boolean")
    throw new ApiError(422, "validation_error", "skip_invoice_custom_sections must be a boolean");
  const codes = normalizeCustomSectionCodes(input.invoice_custom_section_codes);
  if (rawSkip === true && input.invoice_custom_section_codes !== undefined)
    throw new ApiError(
      422,
      "validation_error",
      "skip_invoice_custom_sections cannot be combined with invoice_custom_section_codes",
    );
  return { skip: rawSkip as boolean | undefined, codes };
}

export function normalizeCustomSectionCodes(value: unknown): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value))
    throw new ApiError(422, "validation_error", "invoice_custom_section_codes must be an array");
  return [...new Set(value.map(normalizeCode))].sort();
}

export function normalizeSubscriptionCustomSections(
  value: unknown,
): SubscriptionCustomSections | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ApiError(422, "validation_error", "invoice_custom_section must be an object");
  }
  const input = value as Record<string, unknown>;
  const unsupported = Object.keys(input).find(
    (key) => key !== "skip_invoice_custom_sections" && key !== "invoice_custom_section_codes",
  );
  if (unsupported)
    throw new ApiError(
      422,
      "unsupported_subscription_feature",
      `${unsupported} is not implemented for subscription invoice custom sections`,
    );
  const rawSkip = input.skip_invoice_custom_sections;
  if (rawSkip !== undefined && typeof rawSkip !== "boolean")
    throw new ApiError(422, "validation_error", "skip_invoice_custom_sections must be a boolean");
  const codes = normalizeCustomSectionCodes(input.invoice_custom_section_codes);
  return { skip: rawSkip as boolean | undefined, codes: rawSkip === true ? [] : codes };
}

export async function resolveCustomSectionIds(
  database: D1Database,
  organizationId: string,
  codes: string[] | undefined,
): Promise<string[] | undefined> {
  if (codes === undefined) return undefined;
  if (codes.length === 0) return [];
  const placeholders = codes.map(() => "?").join(", ");
  const rows = await database
    .prepare(
      `SELECT id, code FROM invoice_custom_sections
       WHERE organization_id = ? AND status = 'active' AND code IN (${placeholders})`,
    )
    .bind(organizationId, ...codes)
    .all<{ id: string; code: string }>();
  const byCode = new Map(rows.results.map((row) => [row.code, row.id]));
  return codes.flatMap((code) => (byCode.has(code) ? [byCode.get(code)!] : []));
}

export function customSectionLinkStatements(
  database: D1Database,
  organizationId: string,
  subscriptionId: string,
  sectionIds: string[] | undefined,
  createdAt: string,
  replace: boolean,
): D1PreparedStatement[] {
  if (sectionIds === undefined) return [];
  const statements: D1PreparedStatement[] = [];
  if (replace)
    statements.push(
      database
        .prepare(
          `DELETE FROM subscriptions_invoice_custom_sections
           WHERE subscription_id = ? AND organization_id = ?`,
        )
        .bind(subscriptionId, organizationId),
    );
  for (const sectionId of sectionIds) {
    statements.push(
      database
        .prepare(
          `INSERT OR IGNORE INTO subscriptions_invoice_custom_sections
           (subscription_id, invoice_custom_section_id, organization_id, created_at)
           VALUES (?, ?, ?, ?)`,
        )
        .bind(subscriptionId, sectionId, organizationId, createdAt),
    );
  }
  return statements;
}

export function guardedCustomSectionLinkStatements(
  database: D1Database,
  organizationId: string,
  subscriptionId: string,
  sectionIds: string[] | undefined,
  createdAt: string,
  expectedVersion: number,
  expectedStatus: string,
): D1PreparedStatement[] {
  if (sectionIds === undefined) return [];
  const statements: D1PreparedStatement[] = [
    database
      .prepare(
        `DELETE FROM subscriptions_invoice_custom_sections
         WHERE subscription_id = ? AND organization_id = ?
           AND EXISTS (
             SELECT 1 FROM subscriptions
             WHERE id = ? AND organization_id = ? AND version = ? AND status = ?
               AND updated_at = ?
           )`,
      )
      .bind(
        subscriptionId,
        organizationId,
        subscriptionId,
        organizationId,
        expectedVersion,
        expectedStatus,
        createdAt,
      ),
  ];
  for (const sectionId of sectionIds) {
    statements.push(
      database
        .prepare(
          `INSERT OR IGNORE INTO subscriptions_invoice_custom_sections
           (subscription_id, invoice_custom_section_id, organization_id, created_at)
           SELECT ?, ?, ?, ?
           FROM subscriptions
           WHERE id = ? AND organization_id = ? AND version = ? AND status = ?
             AND updated_at = ?`,
        )
        .bind(
          subscriptionId,
          sectionId,
          organizationId,
          createdAt,
          subscriptionId,
          organizationId,
          expectedVersion,
          expectedStatus,
          createdAt,
        ),
    );
  }
  return statements;
}

type CustomSectionResourceLink =
  | {
      table: "wallets_invoice_custom_sections";
      ownerColumn: "wallet_id";
    }
  | {
      table: "wallet_transactions_invoice_custom_sections";
      ownerColumn: "wallet_transaction_id";
    };

export function resourceCustomSectionLinkStatements(
  database: D1Database,
  link: CustomSectionResourceLink,
  organizationId: string,
  resourceId: string,
  sectionIds: string[] | undefined,
  createdAt: string,
  replace: boolean,
): D1PreparedStatement[] {
  if (sectionIds === undefined) return [];
  const statements: D1PreparedStatement[] = [];
  if (replace)
    statements.push(
      database
        .prepare(`DELETE FROM ${link.table} WHERE ${link.ownerColumn} = ? AND organization_id = ?`)
        .bind(resourceId, organizationId),
    );
  for (const sectionId of sectionIds) {
    statements.push(
      database
        .prepare(
          `INSERT OR IGNORE INTO ${link.table}
           (${link.ownerColumn}, invoice_custom_section_id, organization_id, created_at)
           VALUES (?, ?, ?, ?)`,
        )
        .bind(resourceId, sectionId, organizationId, createdAt),
    );
  }
  return statements;
}

export type SerializedAppliedCustomSection = {
  lago_id: string;
  invoice_custom_section_id: string;
  created_at: string;
  invoice_custom_section: {
    lago_id: string;
    organization_id: string;
    code: string;
    name: string;
    description: string | null;
    details: string | null;
    display_name: string | null;
  };
};

export async function serializeAppliedCustomSections(database: D1Database, subscriptionId: string) {
  const sections = await serializeAppliedCustomSectionsForSubscriptions(database, [subscriptionId]);
  return sections.get(subscriptionId) ?? [];
}

export async function serializeAppliedCustomSectionsForSubscriptions(
  database: D1Database,
  subscriptionIds: string[],
): Promise<Map<string, SerializedAppliedCustomSection[]>> {
  const grouped = new Map<string, SerializedAppliedCustomSection[]>();
  if (subscriptionIds.length === 0) return grouped;
  const placeholders = subscriptionIds.map(() => "?").join(", ");
  const rows = await database
    .prepare(
      `SELECT link.subscription_id, link.invoice_custom_section_id, link.created_at,
              cs.id, cs.organization_id,
              cs.code, cs.name, cs.description, cs.details, cs.display_name
       FROM subscriptions_invoice_custom_sections link
       JOIN invoice_custom_sections cs ON cs.id = link.invoice_custom_section_id
       WHERE link.subscription_id IN (${placeholders}) AND cs.status = 'active'
       ORDER BY link.subscription_id, cs.name, cs.code`,
    )
    .bind(...subscriptionIds)
    .all<{
      subscription_id: string;
      invoice_custom_section_id: string;
      created_at: string;
      id: string;
      organization_id: string;
      code: string;
      name: string;
      description: string | null;
      details: string | null;
      display_name: string | null;
    }>();
  for (const row of rows.results) {
    const sections = grouped.get(row.subscription_id) ?? [];
    sections.push({
      lago_id: `${row.subscription_id}:${row.invoice_custom_section_id}`,
      invoice_custom_section_id: row.invoice_custom_section_id,
      created_at: row.created_at,
      invoice_custom_section: {
        lago_id: row.id,
        organization_id: row.organization_id,
        code: row.code,
        name: row.name,
        description: row.description,
        details: row.details,
        display_name: row.display_name,
      },
    });
    grouped.set(row.subscription_id, sections);
  }
  return grouped;
}

export async function serializeAppliedCustomSectionsForResources(
  database: D1Database,
  link: CustomSectionResourceLink,
  resourceIds: string[],
): Promise<Map<string, SerializedAppliedCustomSection[]>> {
  const grouped = new Map<string, SerializedAppliedCustomSection[]>();
  if (resourceIds.length === 0) return grouped;
  const placeholders = resourceIds.map(() => "?").join(", ");
  const rows = await database
    .prepare(
      `SELECT link.${link.ownerColumn} AS resource_id, link.invoice_custom_section_id,
              link.created_at, cs.id, cs.organization_id, cs.code, cs.name, cs.description,
              cs.details, cs.display_name
       FROM ${link.table} link
       JOIN invoice_custom_sections cs ON cs.id = link.invoice_custom_section_id
       WHERE link.${link.ownerColumn} IN (${placeholders}) AND cs.status = 'active'
       ORDER BY link.${link.ownerColumn}, cs.name, cs.code`,
    )
    .bind(...resourceIds)
    .all<{
      resource_id: string;
      invoice_custom_section_id: string;
      created_at: string;
      id: string;
      organization_id: string;
      code: string;
      name: string;
      description: string | null;
      details: string | null;
      display_name: string | null;
    }>();
  for (const row of rows.results) {
    const sections = grouped.get(row.resource_id) ?? [];
    sections.push({
      lago_id: `${row.resource_id}:${row.invoice_custom_section_id}`,
      invoice_custom_section_id: row.invoice_custom_section_id,
      created_at: row.created_at,
      invoice_custom_section: {
        lago_id: row.id,
        organization_id: row.organization_id,
        code: row.code,
        name: row.name,
        description: row.description,
        details: row.details,
        display_name: row.display_name,
      },
    });
    grouped.set(row.resource_id, sections);
  }
  return grouped;
}

function normalizeCode(value: unknown): string {
  if (typeof value !== "string" || !value.trim())
    throw new ApiError(
      422,
      "validation_error",
      "invoice_custom_section_codes must contain non-empty strings",
    );
  return value.trim();
}
