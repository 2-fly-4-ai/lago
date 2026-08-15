import type { AuthContext } from "../auth/api-key";
import { ApiError, json, objectAt, parseJsonObject } from "../http";
import {
  booleanInteger,
  countryCode,
  currencyCode,
  documentLocale,
  documentPrefix,
  emailAddress,
  emailSettings,
  field,
  invoiceFooter,
  nonNegativeInteger,
  nullableString,
  optionalObject,
  parseStringArray,
  timezone,
} from "./organizations";

type BillingEntityRow = {
  id: string;
  organization_id: string;
  code: string;
  name: string;
  default_currency: string;
  country: string | null;
  address_line1: string | null;
  address_line2: string | null;
  city: string | null;
  state: string | null;
  zipcode: string | null;
  einvoicing: number;
  email: string | null;
  legal_name: string | null;
  legal_number: string | null;
  timezone: string;
  net_payment_term: number;
  email_settings_json: string;
  document_numbering: "per_customer" | "per_billing_entity";
  document_number_prefix: string | null;
  tax_identification_number: string | null;
  finalize_zero_amount_invoice: number;
  invoice_footer: string | null;
  invoice_grace_period: number;
  subscription_invoice_issuing_date_adjustment: string;
  subscription_invoice_issuing_date_anchor: string;
  document_locale: string;
  is_default: number;
  eu_tax_management: number;
  logo_url: string | null;
  version: number;
  created_at: string;
  updated_at: string;
};

type TaxRow = {
  id: string;
  name: string;
  code: string;
  rate: string;
  description: string | null;
  applied_to_organization: number;
  created_at: string;
};

type SectionRow = {
  id: string;
  organization_id: string;
  code: string;
  name: string;
  description: string | null;
  details: string | null;
  display_name: string | null;
};

export async function handleBillingEntitiesApi(
  request: Request,
  env: Pick<Env, "BILLING_DB">,
  auth: AuthContext,
  requestId: string,
): Promise<Response | null> {
  const url = new URL(request.url);
  if (url.pathname === "/api/v1/billing_entities") {
    if (request.method === "GET") {
      const entity = await requiredBillingEntity(env.BILLING_DB, auth.organizationId);
      return json({ billing_entities: [serializeBillingEntity(entity)] }, { requestId });
    }
    if (request.method === "POST") {
      throw new ApiError(
        422,
        "multiple_billing_entities_unsupported",
        "The Cloudflare billing subset retains exactly one default billing entity per organization",
      );
    }
    return null;
  }
  const match = url.pathname.match(/^\/api\/v1\/billing_entities\/([^/]+)$/);
  if (!match?.[1]) return null;
  const code = decodeURIComponent(match[1]);
  if (code !== "default") {
    throw new ApiError(
      422,
      "unsupported_billing_entity",
      "Multiple billing entities are not implemented by the Cloudflare billing subset",
    );
  }
  if (request.method === "GET") {
    const entity = await requiredBillingEntity(env.BILLING_DB, auth.organizationId);
    return json(
      { billing_entity: await serializeDetailedBillingEntity(env.BILLING_DB, entity) },
      { requestId },
    );
  }
  if (request.method === "PUT")
    return updateBillingEntity(request, env.BILLING_DB, auth, requestId);
  return null;
}

async function updateBillingEntity(
  request: Request,
  database: D1Database,
  auth: AuthContext,
  requestId: string,
): Promise<Response> {
  const current = await requiredBillingEntity(database, auth.organizationId);
  const input = objectAt(await parseJsonObject(request), "billing_entity");
  rejectSideEffectingConfiguration(input);
  const billing = optionalObject(input.billing_configuration, "billing_configuration");
  rejectUnsupportedIssuingDateSettings(billing);
  const next: BillingEntityRow = {
    ...current,
    name: field(input, "name", current.name, requiredName),
    default_currency: field(input, "default_currency", current.default_currency, currencyCode),
    country: field(input, "country", current.country, countryCode),
    address_line1: field(input, "address_line1", current.address_line1, nullableString),
    address_line2: field(input, "address_line2", current.address_line2, nullableString),
    city: field(input, "city", current.city, nullableString),
    state: field(input, "state", current.state, nullableString),
    zipcode: field(input, "zipcode", current.zipcode, nullableString),
    email: field(input, "email", current.email, emailAddress),
    legal_name: field(input, "legal_name", current.legal_name, nullableString),
    legal_number: field(input, "legal_number", current.legal_number, nullableString),
    timezone: field(input, "timezone", current.timezone, timezone),
    net_payment_term: field(
      input,
      "net_payment_term",
      current.net_payment_term,
      nonNegativeInteger,
    ),
    email_settings_json: field(input, "email_settings", current.email_settings_json, emailSettings),
    document_numbering: field(
      input,
      "document_numbering",
      current.document_numbering,
      billingEntityDocumentNumbering,
    ),
    document_number_prefix: field(
      input,
      "document_number_prefix",
      current.document_number_prefix,
      documentPrefix,
    ),
    tax_identification_number: field(
      input,
      "tax_identification_number",
      current.tax_identification_number,
      nullableString,
    ),
    finalize_zero_amount_invoice: field(
      input,
      "finalize_zero_amount_invoice",
      current.finalize_zero_amount_invoice,
      booleanInteger,
    ),
    invoice_footer: field(billing, "invoice_footer", current.invoice_footer, invoiceFooter),
    invoice_grace_period: field(
      billing,
      "invoice_grace_period",
      current.invoice_grace_period,
      nonNegativeInteger,
    ),
    document_locale: field(billing, "document_locale", current.document_locale, documentLocale),
  };
  const changedFields = billingEntityChangedFields(current, next);
  if (changedFields.length === 0) {
    return json(
      { billing_entity: await serializeDetailedBillingEntity(database, current) },
      { requestId },
    );
  }
  const nextVersion = current.version + 1;
  const now = new Date().toISOString();
  try {
    const results = await database.batch([
      database
        .prepare(
          `UPDATE organizations SET name = ?, default_currency = ?, country = ?, address_line1 = ?,
                  address_line2 = ?, city = ?, state = ?, zipcode = ?, email = ?, legal_name = ?,
                  legal_number = ?, timezone = ?, net_payment_term = ?, email_settings_json = ?,
                  document_numbering = ?, document_number_prefix = ?, tax_identification_number = ?,
                  finalize_zero_amount_invoice = ?, invoice_footer = ?, invoice_grace_period = ?,
                  document_locale = ?, version = ?, updated_at = ?
           WHERE id = ? AND version = ?`,
        )
        .bind(
          next.name,
          next.default_currency,
          next.country,
          next.address_line1,
          next.address_line2,
          next.city,
          next.state,
          next.zipcode,
          next.email,
          next.legal_name,
          next.legal_number,
          next.timezone,
          next.net_payment_term,
          next.email_settings_json,
          next.document_numbering === "per_billing_entity" ? "per_organization" : "per_customer",
          next.document_number_prefix,
          next.tax_identification_number,
          next.finalize_zero_amount_invoice,
          next.invoice_footer,
          next.invoice_grace_period,
          next.document_locale,
          nextVersion,
          now,
          auth.organizationId,
          current.version,
        ),
      billingEntityEvent(database, auth.organizationId, nextVersion, requestId, now, changedFields),
    ]);
    if (results[0]?.meta.changes !== 1) {
      throw new ApiError(
        409,
        "billing_entity_version_conflict",
        "Billing entity changed concurrently",
      );
    }
  } catch (error) {
    if (error instanceof ApiError) throw error;
    const message = error instanceof Error ? error.message : "";
    if (message.includes("billing_entity_outbox_version_conflict")) {
      throw new ApiError(
        409,
        "billing_entity_version_conflict",
        "Billing entity changed concurrently",
      );
    }
    throw error;
  }
  const updated = await requiredBillingEntity(database, auth.organizationId);
  return json(
    { billing_entity: await serializeDetailedBillingEntity(database, updated) },
    { requestId },
  );
}

async function requiredBillingEntity(
  database: D1Database,
  organizationId: string,
): Promise<BillingEntityRow> {
  const entity = await database
    .prepare(`${billingEntitySelect()} WHERE organization_id = ? LIMIT 1`)
    .bind(organizationId)
    .first<BillingEntityRow>();
  if (!entity) throw new ApiError(404, "billing_entity_not_found", "Billing entity was not found");
  return entity;
}

function billingEntitySelect(): string {
  return `SELECT id, organization_id, code, name, default_currency, country, address_line1,
                 address_line2, city, state, zipcode, einvoicing, email, legal_name, legal_number,
                 timezone, net_payment_term, email_settings_json, document_numbering,
                 document_number_prefix, tax_identification_number, finalize_zero_amount_invoice,
                 invoice_footer, invoice_grace_period, subscription_invoice_issuing_date_adjustment,
                 subscription_invoice_issuing_date_anchor, document_locale, is_default,
                 eu_tax_management, logo_url, version, created_at, updated_at
          FROM billing_entities`;
}

function serializeBillingEntity(entity: BillingEntityRow) {
  return {
    lago_id: entity.id,
    code: entity.code,
    name: entity.name,
    default_currency: entity.default_currency,
    created_at: entity.created_at,
    updated_at: entity.updated_at,
    country: entity.country,
    address_line1: entity.address_line1,
    address_line2: entity.address_line2,
    city: entity.city,
    state: entity.state,
    zipcode: entity.zipcode,
    einvoicing: entity.einvoicing === 1,
    email: entity.email,
    legal_name: entity.legal_name,
    legal_number: entity.legal_number,
    timezone: entity.timezone,
    net_payment_term: entity.net_payment_term,
    email_settings: parseStringArray(entity.email_settings_json),
    document_numbering: entity.document_numbering,
    document_number_prefix: entity.document_number_prefix,
    tax_identification_number: entity.tax_identification_number,
    finalize_zero_amount_invoice: entity.finalize_zero_amount_invoice === 1,
    invoice_footer: entity.invoice_footer,
    invoice_grace_period: entity.invoice_grace_period,
    subscription_invoice_issuing_date_adjustment:
      entity.subscription_invoice_issuing_date_adjustment,
    subscription_invoice_issuing_date_anchor: entity.subscription_invoice_issuing_date_anchor,
    document_locale: entity.document_locale,
    is_default: entity.is_default === 1,
    eu_tax_management: entity.eu_tax_management === 1,
    logo_url: entity.logo_url,
    version: entity.version,
  };
}

async function serializeDetailedBillingEntity(database: D1Database, entity: BillingEntityRow) {
  const [taxes, sections] = await Promise.all([
    database
      .prepare(
        `SELECT id, name, code, rate, description, applied_to_organization, created_at
         FROM taxes WHERE organization_id = ? AND status = 'active'
           AND applied_to_organization = 1 ORDER BY created_at, id`,
      )
      .bind(entity.organization_id)
      .all<TaxRow>(),
    database
      .prepare(
        `SELECT section.id, section.organization_id, section.code, section.name,
                section.description, section.details, section.display_name
         FROM invoice_custom_sections section
         JOIN organization_invoice_custom_sections link
           ON link.invoice_custom_section_id = section.id
         WHERE link.organization_id = ? AND section.status = 'active'
         ORDER BY section.name, section.code`,
      )
      .bind(entity.organization_id)
      .all<SectionRow>(),
  ]);
  return {
    ...serializeBillingEntity(entity),
    taxes: taxes.results.map((tax) => ({
      lago_id: tax.id,
      name: tax.name,
      code: tax.code,
      rate: Number(tax.rate),
      description: tax.description,
      applied_to_organization: tax.applied_to_organization === 1,
      add_ons_count: 0,
      customers_count: 0,
      plans_count: 0,
      charges_count: 0,
      commitments_count: 0,
      created_at: tax.created_at,
    })),
    selected_invoice_custom_sections: sections.results.map((section) => ({
      lago_id: section.id,
      organization_id: section.organization_id,
      code: section.code,
      name: section.name,
      description: section.description,
      details: section.details,
      display_name: section.display_name,
    })),
  };
}

function billingEntityEvent(
  database: D1Database,
  organizationId: string,
  version: number,
  requestId: string,
  occurredAt: string,
  changedFields: string[],
): D1PreparedStatement {
  return database
    .prepare(
      `INSERT INTO outbox_events
       (event_id, organization_id, event_type, event_version, aggregate_type, aggregate_id,
        aggregate_version, causation_id, correlation_id, payload_json, occurred_at, published_at)
       VALUES (?, ?, 'billing_entity.updated', 1, 'billing_entity', ?, ?, NULL, ?, ?, ?, NULL)`,
    )
    .bind(
      crypto.randomUUID(),
      organizationId,
      organizationId,
      version,
      requestId,
      JSON.stringify({ changed_fields: changedFields }),
      occurredAt,
    );
}

function billingEntityChangedFields(current: BillingEntityRow, next: BillingEntityRow): string[] {
  const fields: Array<keyof BillingEntityRow> = [
    "name",
    "default_currency",
    "country",
    "address_line1",
    "address_line2",
    "city",
    "state",
    "zipcode",
    "email",
    "legal_name",
    "legal_number",
    "timezone",
    "net_payment_term",
    "email_settings_json",
    "document_numbering",
    "document_number_prefix",
    "tax_identification_number",
    "finalize_zero_amount_invoice",
    "invoice_footer",
    "invoice_grace_period",
    "document_locale",
  ];
  return fields.filter((fieldName) => current[fieldName] !== next[fieldName]);
}

function rejectSideEffectingConfiguration(input: Record<string, unknown>): void {
  for (const name of ["tax_codes", "invoice_custom_section_codes", "logo"] as const) {
    if (input[name] !== undefined) {
      throw new ApiError(
        422,
        "unsupported_billing_entity_feature",
        `${name} must be changed through its dedicated Cloudflare API`,
      );
    }
  }
  if (input.einvoicing !== undefined && input.einvoicing !== false) {
    throw new ApiError(
      422,
      "unsupported_billing_entity_feature",
      "Electronic invoicing is not implemented by the Cloudflare billing subset",
    );
  }
  if (input.eu_tax_management !== undefined && input.eu_tax_management !== false) {
    throw new ApiError(
      422,
      "unsupported_billing_entity_feature",
      "EU tax management is not implemented by the Cloudflare billing subset",
    );
  }
}

function rejectUnsupportedIssuingDateSettings(billing: Record<string, unknown>): void {
  const anchor = billing.subscription_invoice_issuing_date_anchor;
  if (anchor !== undefined && anchor !== "next_period_start") {
    throw new ApiError(
      422,
      "unsupported_billing_entity_feature",
      "Only next_period_start invoice issuing is implemented",
    );
  }
  const adjustment = billing.subscription_invoice_issuing_date_adjustment;
  if (adjustment !== undefined && adjustment !== "align_with_finalization_date") {
    throw new ApiError(
      422,
      "unsupported_billing_entity_feature",
      "Only align_with_finalization_date invoice issuing is implemented",
    );
  }
}

function requiredName(value: unknown): string {
  const normalized = nullableString(value);
  if (!normalized) throw new ApiError(422, "validation_error", "name is required");
  return normalized;
}

function billingEntityDocumentNumbering(value: unknown): "per_customer" | "per_billing_entity" {
  if (value !== "per_customer" && value !== "per_billing_entity") {
    throw new ApiError(422, "validation_error", "document_numbering is invalid");
  }
  return value;
}
