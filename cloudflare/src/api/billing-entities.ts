import type { AuthContext } from "../auth/api-key";
import type { DomainEvent } from "../domain-events";
import { ApiError, json, objectAt, parseJsonObject, requiredString } from "../http";
import { deterministicUuid } from "../identifiers";
import { stableJson } from "../json";
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
  invoice_custom_section_version: number;
  version: number;
  archived_at: string | null;
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
      const entities = await env.BILLING_DB.prepare(
        `${billingEntitySelect()} WHERE organization_id = ? AND archived_at IS NULL
         ORDER BY is_default DESC, created_at, id`,
      )
        .bind(auth.organizationId)
        .all<BillingEntityRow>();
      return json(
        { billing_entities: entities.results.map(serializeBillingEntity) },
        { requestId },
      );
    }
    if (request.method === "POST")
      return createBillingEntity(request, env.BILLING_DB, auth, requestId);
    return null;
  }
  const match = url.pathname.match(/^\/api\/v1\/billing_entities\/([^/]+)$/);
  if (!match?.[1]) return null;
  const code = decodeURIComponent(match[1]);
  if (request.method === "GET") {
    const entity = await requiredBillingEntity(env.BILLING_DB, auth.organizationId, code);
    return json(
      { billing_entity: await serializeDetailedBillingEntity(env.BILLING_DB, entity) },
      { requestId },
    );
  }
  if (request.method === "PUT")
    return updateBillingEntity(code, request, env.BILLING_DB, auth, requestId);
  return null;
}

async function createBillingEntity(
  request: Request,
  database: D1Database,
  auth: AuthContext,
  requestId: string,
): Promise<Response> {
  const input = objectAt(await parseJsonObject(request), "billing_entity");
  rejectSideEffectingConfiguration(input);
  const code = billingEntityCode(requiredString(input, "code"));
  const name = requiredName(input.name);
  const existing = await database
    .prepare(
      `${billingEntitySelect()} WHERE organization_id = ? AND code = ? AND archived_at IS NULL
       LIMIT 1`,
    )
    .bind(auth.organizationId, code)
    .first<BillingEntityRow>();
  if (existing)
    throw new ApiError(422, "value_already_exist", "Billing entity code already exists");
  const defaults = await requiredBillingEntity(database, auth.organizationId, "default");
  const billing = optionalObject(input.billing_configuration, "billing_configuration");
  rejectUnsupportedIssuingDateSettings(billing);
  const id = await deterministicUuid("billing-entity", `${auth.organizationId}:${code}`);
  const now = new Date().toISOString();
  const entity: BillingEntityRow = {
    ...defaults,
    id,
    organization_id: auth.organizationId,
    code,
    name,
    default_currency: field(input, "default_currency", defaults.default_currency, currencyCode),
    country: field(input, "country", defaults.country, countryCode),
    address_line1: field(input, "address_line1", null, nullableString),
    address_line2: field(input, "address_line2", null, nullableString),
    city: field(input, "city", null, nullableString),
    state: field(input, "state", null, nullableString),
    zipcode: field(input, "zipcode", null, nullableString),
    email: field(input, "email", null, emailAddress),
    legal_name: field(input, "legal_name", null, nullableString),
    legal_number: field(input, "legal_number", null, nullableString),
    timezone: field(input, "timezone", defaults.timezone, timezone),
    net_payment_term: field(input, "net_payment_term", 0, nonNegativeInteger),
    email_settings_json: field(input, "email_settings", "[]", emailSettings),
    document_numbering: field(
      input,
      "document_numbering",
      "per_customer",
      billingEntityDocumentNumbering,
    ),
    document_number_prefix: field(
      input,
      "document_number_prefix",
      `${name.slice(0, 3).toUpperCase()}-${id.slice(-4).toUpperCase()}`,
      documentPrefix,
    ),
    tax_identification_number: field(input, "tax_identification_number", null, nullableString),
    finalize_zero_amount_invoice: field(input, "finalize_zero_amount_invoice", 1, booleanInteger),
    invoice_footer: field(billing, "invoice_footer", null, invoiceFooter),
    invoice_grace_period: field(billing, "invoice_grace_period", 0, nonNegativeInteger),
    subscription_invoice_issuing_date_adjustment: field(
      billing,
      "subscription_invoice_issuing_date_adjustment",
      "align_with_finalization_date",
      issuingDateAdjustment,
    ),
    subscription_invoice_issuing_date_anchor: field(
      billing,
      "subscription_invoice_issuing_date_anchor",
      "next_period_start",
      issuingDateAnchor,
    ),
    document_locale: field(billing, "document_locale", defaults.document_locale, documentLocale),
    is_default: 0,
    einvoicing: 0,
    eu_tax_management: 0,
    logo_url: null,
    invoice_custom_section_version: 0,
    version: 1,
    archived_at: null,
    created_at: now,
    updated_at: now,
  };
  const event = billingEntityDomainEvent("billing_entity.created", entity, 1, requestId, now, [
    "code",
    "name",
  ]);
  try {
    await database.batch([
      database
        .prepare(
          `INSERT INTO billing_entities
           (id, organization_id, code, name, default_currency, country, address_line1,
            address_line2, city, state, zipcode, einvoicing, email, legal_name, legal_number,
            timezone, net_payment_term, email_settings_json, document_numbering,
            document_number_prefix, tax_identification_number, finalize_zero_amount_invoice,
            invoice_footer, invoice_grace_period,
            subscription_invoice_issuing_date_adjustment,
            subscription_invoice_issuing_date_anchor, document_locale, is_default,
            eu_tax_management, logo_url, invoice_custom_section_version, version,
            created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
                   ?, ?, ?, 0, 0, NULL, 0, 1, ?, ?)`,
        )
        .bind(
          entity.id,
          entity.organization_id,
          entity.code,
          entity.name,
          entity.default_currency,
          entity.country,
          entity.address_line1,
          entity.address_line2,
          entity.city,
          entity.state,
          entity.zipcode,
          entity.email,
          entity.legal_name,
          entity.legal_number,
          entity.timezone,
          entity.net_payment_term,
          entity.email_settings_json,
          entity.document_numbering,
          entity.document_number_prefix,
          entity.tax_identification_number,
          entity.finalize_zero_amount_invoice,
          entity.invoice_footer,
          entity.invoice_grace_period,
          entity.subscription_invoice_issuing_date_adjustment,
          entity.subscription_invoice_issuing_date_anchor,
          entity.document_locale,
          now,
          now,
        ),
      billingEntityOutboxStatement(database, event),
    ]);
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    if (message.includes("UNIQUE"))
      throw new ApiError(422, "value_already_exist", "Billing entity code already exists");
    throw error;
  }
  const created = await requiredBillingEntity(database, auth.organizationId, code);
  return json(
    { billing_entity: await serializeDetailedBillingEntity(database, created) },
    { requestId },
  );
}

async function updateBillingEntity(
  code: string,
  request: Request,
  database: D1Database,
  auth: AuthContext,
  requestId: string,
): Promise<Response> {
  const current = await requiredBillingEntity(database, auth.organizationId, code);
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
    subscription_invoice_issuing_date_adjustment: field(
      billing,
      "subscription_invoice_issuing_date_adjustment",
      current.subscription_invoice_issuing_date_adjustment,
      issuingDateAdjustment,
    ),
    subscription_invoice_issuing_date_anchor: field(
      billing,
      "subscription_invoice_issuing_date_anchor",
      current.subscription_invoice_issuing_date_anchor,
      issuingDateAnchor,
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
      billingEntityUpdateStatement(database, current, next, nextVersion, now),
      billingEntityOutboxStatement(
        database,
        billingEntityDomainEvent(
          "billing_entity.updated",
          current,
          nextVersion,
          requestId,
          now,
          changedFields,
        ),
      ),
    ]);
    if ((results[0]?.meta.changes ?? 0) < 1) {
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
  const updated = await requiredBillingEntity(database, auth.organizationId, code);
  return json(
    { billing_entity: await serializeDetailedBillingEntity(database, updated) },
    { requestId },
  );
}

async function requiredBillingEntity(
  database: D1Database,
  organizationId: string,
  code = "default",
): Promise<BillingEntityRow> {
  const entity = await database
    .prepare(
      `${billingEntitySelect()}
       WHERE organization_id = ? AND code = ? AND archived_at IS NULL LIMIT 1`,
    )
    .bind(organizationId, code)
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
                 eu_tax_management, logo_url, invoice_custom_section_version, version,
                 archived_at, created_at, updated_at
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
        `SELECT DISTINCT tax.id, tax.name, tax.code, tax.rate, tax.description,
                tax.applied_to_organization, tax.created_at
         FROM taxes tax LEFT JOIN tax_targets target
           ON target.tax_id = tax.id AND target.organization_id = tax.organization_id
          AND target.target_type = 'billing_entity' AND target.target_id = ?
         WHERE tax.organization_id = ? AND tax.status = 'active'
           AND (target.tax_id IS NOT NULL OR (? = 1 AND tax.applied_to_organization = 1))
         ORDER BY tax.created_at, tax.id`,
      )
      .bind(entity.id, entity.organization_id, entity.is_default)
      .all<TaxRow>(),
    database
      .prepare(
        `SELECT section.id, section.organization_id, section.code, section.name,
                section.description, section.details, section.display_name
         FROM invoice_custom_sections section
         JOIN billing_entity_invoice_custom_sections link
           ON link.invoice_custom_section_id = section.id
         WHERE link.billing_entity_id = ? AND link.organization_id = ?
           AND section.status = 'active'
         ORDER BY section.name, section.code`,
      )
      .bind(entity.id, entity.organization_id)
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

function billingEntityUpdateStatement(
  database: D1Database,
  current: BillingEntityRow,
  next: BillingEntityRow,
  nextVersion: number,
  now: string,
): D1PreparedStatement {
  const table = current.is_default === 1 ? "organizations" : "billing_entities";
  const idColumn = current.is_default === 1 ? "id" : "id";
  return database
    .prepare(
      `UPDATE ${table}
       SET name = ?, default_currency = ?, country = ?, address_line1 = ?, address_line2 = ?,
           city = ?, state = ?, zipcode = ?, email = ?, legal_name = ?, legal_number = ?,
           timezone = ?, net_payment_term = ?, email_settings_json = ?, document_numbering = ?,
           document_number_prefix = ?, tax_identification_number = ?,
           finalize_zero_amount_invoice = ?, invoice_footer = ?, invoice_grace_period = ?,
           subscription_invoice_issuing_date_adjustment = ?,
           subscription_invoice_issuing_date_anchor = ?, document_locale = ?,
           version = ?, updated_at = ?
       WHERE ${idColumn} = ? AND version = ?`,
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
      current.is_default === 1 && next.document_numbering === "per_billing_entity"
        ? "per_organization"
        : next.document_numbering,
      next.document_number_prefix,
      next.tax_identification_number,
      next.finalize_zero_amount_invoice,
      next.invoice_footer,
      next.invoice_grace_period,
      next.subscription_invoice_issuing_date_adjustment,
      next.subscription_invoice_issuing_date_anchor,
      next.document_locale,
      nextVersion,
      now,
      current.id,
      current.version,
    );
}

function billingEntityDomainEvent(
  type: "billing_entity.created" | "billing_entity.updated",
  entity: BillingEntityRow,
  version: number,
  requestId: string,
  occurredAt: string,
  changedFields: string[],
): DomainEvent {
  return {
    id: `${type.replaceAll(".", "-")}:${entity.id}:v${version}`,
    type,
    version: 1,
    aggregateType: "billing_entity",
    aggregateId: entity.id,
    aggregateVersion: version,
    occurredAt,
    causationId: requestId,
    correlationId: requestId,
    payload: {
      organizationId: entity.organization_id,
      code: entity.code,
      changedFields,
    },
  };
}

function billingEntityOutboxStatement(
  database: D1Database,
  event: DomainEvent,
): D1PreparedStatement {
  const organizationId = event.payload.organizationId;
  if (typeof organizationId !== "string") throw new Error("billing_entity_event_scope_missing");
  return database
    .prepare(
      `INSERT INTO outbox_events
       (event_id, organization_id, event_type, event_version, aggregate_type, aggregate_id,
        aggregate_version, causation_id, correlation_id, payload_json, occurred_at, published_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
    )
    .bind(
      event.id,
      organizationId,
      event.type,
      event.version,
      event.aggregateType,
      event.aggregateId,
      event.aggregateVersion,
      event.causationId,
      event.correlationId,
      stableJson(event.payload),
      event.occurredAt,
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
    "subscription_invoice_issuing_date_adjustment",
    "subscription_invoice_issuing_date_anchor",
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
  if (anchor !== undefined) issuingDateAnchor(anchor);
  const adjustment = billing.subscription_invoice_issuing_date_adjustment;
  if (adjustment !== undefined) issuingDateAdjustment(adjustment);
}

function issuingDateAdjustment(value: unknown): string {
  if (value !== "keep_anchor" && value !== "align_with_finalization_date")
    throw new ApiError(422, "validation_error", "subscription invoice adjustment is invalid");
  return value;
}

function issuingDateAnchor(value: unknown): string {
  if (value !== "current_period_end" && value !== "next_period_start")
    throw new ApiError(422, "validation_error", "subscription invoice anchor is invalid");
  return value;
}

function requiredName(value: unknown): string {
  const normalized = nullableString(value);
  if (!normalized) throw new ApiError(422, "validation_error", "name is required");
  return normalized;
}

function billingEntityCode(value: string): string {
  const normalized = value.trim();
  if (
    normalized.length > 100 ||
    normalized === "default" ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(normalized)
  ) {
    throw new ApiError(
      422,
      "validation_error",
      "code must be a non-default identifier using letters, numbers, dots, dashes, or underscores",
    );
  }
  return normalized;
}

function billingEntityDocumentNumbering(value: unknown): "per_customer" | "per_billing_entity" {
  if (value !== "per_customer" && value !== "per_billing_entity") {
    throw new ApiError(422, "validation_error", "document_numbering is invalid");
  }
  return value;
}
