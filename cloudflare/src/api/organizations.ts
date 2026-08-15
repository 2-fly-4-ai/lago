import type { AuthContext } from "../auth/api-key";
import { ApiError, json, objectAt, parseJsonObject } from "../http";

type OrganizationRow = {
  id: string;
  external_id: string;
  name: string;
  slug: string | null;
  default_currency: string;
  country: string | null;
  address_line1: string | null;
  address_line2: string | null;
  state: string | null;
  zipcode: string | null;
  email: string | null;
  city: string | null;
  legal_name: string | null;
  legal_number: string | null;
  tax_identification_number: string | null;
  timezone: string;
  net_payment_term: number;
  invoice_grace_period: number;
  document_numbering: string;
  document_number_prefix: string | null;
  finalize_zero_amount_invoice: number;
  email_settings_json: string;
  invoice_footer: string | null;
  document_locale: string;
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

const EMAIL_SETTINGS = new Set([
  "invoice.finalized",
  "credit_note.created",
  "payment_receipt.created",
]);
const DOCUMENT_NUMBERINGS = new Set(["per_customer", "per_organization"]);
const LAGO_CURRENCIES = new Set(
  `AED AFN ALL AMD ANG AOA ARS AUD AWG AZN BAM BBD BDT BGN BHD BIF BMD BND BOB BRL BSD BWP BYN
   BZD CAD CDF CHF CLF CLP CNY COP CRC CVE CZK DJF DKK DOP DZD EGP ETB EUR FJD FKP GBP GEL GHS
   GIP GMD GNF GTQ GYD HKD HNL HRK HTG HUF IDR ILS INR IRR ISK JMD JOD JPY KES KGS KHR KMF KRW
   KWD KYD KZT LAK LBP LKR LRD LSL MAD MDL MGA MKD MMK MNT MOP MRO MUR MVR MWK MXN MYR MZN NAD
   NGN NIO NOK NPR NZD PAB PEN PGK PHP PKR PLN PYG QAR RON RSD RUB RWF SAR SBD SCR SEK SGD SHP SLL
   SOS SRD STD SZL THB TJS TOP TRY TTD TWD TZS UAH UGX USD UYU UZS VND VUV WST XAF XCD XOF XPF
   YER ZAR ZMW`
    .trim()
    .split(/\s+/),
);
const ISO_COUNTRIES = new Set(
  `AD AE AF AG AI AL AM AO AQ AR AS AT AU AW AX AZ BA BB BD BE BF BG BH BI BJ BL BM BN BO BQ BR
   BS BT BV BW BY BZ CA CC CD CF CG CH CI CK CL CM CN CO CR CU CV CW CX CY CZ DE DJ DK DM DO DZ
   EC EE EG EH ER ES ET FI FJ FK FM FO FR GA GB GD GE GF GG GH GI GL GM GN GP GQ GR GS GT GU GW
   GY HK HM HN HR HT HU ID IE IL IM IN IO IQ IR IS IT JE JM JO JP KE KG KH KI KM KN KP KR KW KY
   KZ LA LB LC LI LK LR LS LT LU LV LY MA MC MD ME MF MG MH MK ML MM MN MO MP MQ MR MS MT MU MV
   MW MX MY MZ NA NC NE NF NG NI NL NO NP NR NU NZ OM PA PE PF PG PH PK PL PM PN PR PS PT PW PY
   QA RE RO RS RU RW SA SB SC SD SE SG SH SI SJ SK SL SM SN SO SR SS ST SV SX SY SZ TC TD TF TG
   TH TJ TK TL TM TN TO TR TT TV TW TZ UA UG UM US UY UZ VA VC VE VG VI VN VU WF WS YE YT ZA ZM
   ZW`
    .trim()
    .split(/\s+/),
);
const DOCUMENT_LOCALES = new Map([
  ["en", "en"],
  ["fr", "fr"],
  ["nb", "nb"],
  ["de", "de"],
  ["it", "it"],
  ["es", "es"],
  ["sv", "sv"],
  ["pt-br", "pt-BR"],
  ["zh-tw", "zh-TW"],
]);
const RESERVED_SLUGS = new Set([
  "auth",
  "login",
  "sign-up",
  "forgot-password",
  "reset-password",
  "invitation",
  "customer-portal",
  "404",
  "forbidden",
  "api",
  "admin",
  "graphql",
  "webhooks",
  "google",
  "okta",
  "settings",
  "new",
  "design-system",
  "devtool",
  "customers",
  "customer",
  "plans",
  "plan",
  "invoices",
  "invoice",
  "subscriptions",
  "coupons",
  "coupon",
  "add-ons",
  "add-on",
  "billable-metrics",
  "billable-metric",
  "credit-notes",
  "analytics",
  "analytics-v2",
  "forecasts",
  "payments",
  "payment",
  "features",
  "feature",
  "tax",
  "webhook",
  "api-keys",
  "create",
  "update",
  "duplicate",
]);

export async function handleOrganizationsApi(
  request: Request,
  env: Env,
  auth: AuthContext,
  requestId: string,
): Promise<Response | null> {
  const url = new URL(request.url);
  if (url.pathname !== "/api/v1/organizations") return null;
  if (request.method === "GET") {
    const organization = await requiredOrganization(env.BILLING_DB, auth.organizationId);
    return json(
      { organization: await serializeOrganization(env.BILLING_DB, organization) },
      { requestId },
    );
  }
  if (request.method === "PUT") {
    return updateOrganization(request, env.BILLING_DB, auth, requestId);
  }
  return null;
}

async function updateOrganization(
  request: Request,
  database: D1Database,
  auth: AuthContext,
  requestId: string,
): Promise<Response> {
  const current = await requiredOrganization(database, auth.organizationId);
  const input = objectAt(await parseJsonObject(request), "organization");
  if (input.webhook_url !== undefined) {
    throw new ApiError(
      422,
      "unsupported_organization_webhook_mutation",
      "Use the gated webhook_endpoints API to change webhook delivery configuration",
    );
  }
  const billing = optionalObject(input.billing_configuration, "billing_configuration");
  const next: OrganizationRow = {
    ...current,
    slug: field(input, "slug", current.slug, slug),
    default_currency: field(input, "default_currency", current.default_currency, currencyCode),
    country: field(input, "country", current.country, countryCode),
    address_line1: field(input, "address_line1", current.address_line1, nullableString),
    address_line2: field(input, "address_line2", current.address_line2, nullableString),
    state: field(input, "state", current.state, nullableString),
    zipcode: field(input, "zipcode", current.zipcode, nullableString),
    email: field(input, "email", current.email, emailAddress),
    city: field(input, "city", current.city, nullableString),
    legal_name: field(input, "legal_name", current.legal_name, nullableString),
    legal_number: field(input, "legal_number", current.legal_number, nullableString),
    tax_identification_number: field(
      input,
      "tax_identification_number",
      current.tax_identification_number,
      nullableString,
    ),
    timezone: field(input, "timezone", current.timezone, timezone),
    net_payment_term: field(
      input,
      "net_payment_term",
      current.net_payment_term,
      nonNegativeInteger,
    ),
    document_numbering: field(
      input,
      "document_numbering",
      current.document_numbering,
      documentNumbering,
    ),
    document_number_prefix: field(
      input,
      "document_number_prefix",
      current.document_number_prefix,
      documentPrefix,
    ),
    finalize_zero_amount_invoice: field(
      input,
      "finalize_zero_amount_invoice",
      current.finalize_zero_amount_invoice,
      booleanInteger,
    ),
    email_settings_json: field(input, "email_settings", current.email_settings_json, emailSettings),
    invoice_footer: field(billing, "invoice_footer", current.invoice_footer, invoiceFooter),
    invoice_grace_period: field(
      billing,
      "invoice_grace_period",
      current.invoice_grace_period,
      nonNegativeInteger,
    ),
    document_locale: field(billing, "document_locale", current.document_locale, documentLocale),
  };
  const changedFields = organizationChangedFields(current, next);
  if (changedFields.length === 0) {
    return json({ organization: await serializeOrganization(database, current) }, { requestId });
  }
  const nextVersion = current.version + 1;
  const now = new Date().toISOString();
  try {
    const result = await database.batch([
      database
        .prepare(
          `UPDATE organizations SET slug = ?, default_currency = ?, country = ?, address_line1 = ?,
                  address_line2 = ?, state = ?, zipcode = ?, email = ?, city = ?, legal_name = ?,
                  legal_number = ?, tax_identification_number = ?, timezone = ?,
                  net_payment_term = ?, invoice_grace_period = ?, document_numbering = ?,
                  document_number_prefix = ?, finalize_zero_amount_invoice = ?,
                  email_settings_json = ?, invoice_footer = ?, document_locale = ?,
                  version = ?, updated_at = ?
           WHERE id = ? AND version = ?`,
        )
        .bind(
          next.slug,
          next.default_currency,
          next.country,
          next.address_line1,
          next.address_line2,
          next.state,
          next.zipcode,
          next.email,
          next.city,
          next.legal_name,
          next.legal_number,
          next.tax_identification_number,
          next.timezone,
          next.net_payment_term,
          next.invoice_grace_period,
          next.document_numbering,
          next.document_number_prefix,
          next.finalize_zero_amount_invoice,
          next.email_settings_json,
          next.invoice_footer,
          next.document_locale,
          nextVersion,
          now,
          current.id,
          current.version,
        ),
      organizationEvent(database, current.id, nextVersion, requestId, now, changedFields),
    ]);
    if (result[0]?.meta.changes !== 1) {
      throw new ApiError(409, "stale_organization", "Organization changed concurrently");
    }
  } catch (error) {
    if (error instanceof ApiError) throw error;
    const message = error instanceof Error ? error.message : "";
    if (message.includes("organization_outbox_version_conflict")) {
      throw new ApiError(409, "stale_organization", "Organization changed concurrently");
    }
    if (message.toLowerCase().includes("unique") && message.includes("organizations.slug")) {
      throw new ApiError(422, "value_already_exist", "Organization slug already exists");
    }
    throw error;
  }
  const updated = await requiredOrganization(database, auth.organizationId);
  return json({ organization: await serializeOrganization(database, updated) }, { requestId });
}

function requiredOrganization(
  database: D1Database,
  organizationId: string,
): Promise<OrganizationRow> {
  return database
    .prepare(`${organizationSelect()} WHERE id = ? LIMIT 1`)
    .bind(organizationId)
    .first<OrganizationRow>()
    .then((organization) => {
      if (!organization)
        throw new ApiError(404, "organization_not_found", "Organization was not found");
      return organization;
    });
}

function organizationSelect(): string {
  return `SELECT id, external_id, name, slug, default_currency, country, address_line1,
                 address_line2, state, zipcode, email, city, legal_name, legal_number,
                 tax_identification_number, timezone, net_payment_term, invoice_grace_period,
                 document_numbering, document_number_prefix, finalize_zero_amount_invoice,
                 email_settings_json, invoice_footer, document_locale, version, created_at, updated_at
          FROM organizations`;
}

async function serializeOrganization(database: D1Database, organization: OrganizationRow) {
  const [endpoints, taxes] = await Promise.all([
    database
      .prepare(
        `SELECT webhook_url FROM webhook_endpoints
         WHERE organization_id = ? AND status = 'active' ORDER BY created_at, id`,
      )
      .bind(organization.id)
      .all<{ webhook_url: string }>(),
    database
      .prepare(
        `SELECT id, name, code, rate, description, applied_to_organization, created_at
         FROM taxes WHERE organization_id = ? AND status = 'active'
           AND applied_to_organization = 1 ORDER BY created_at, id`,
      )
      .bind(organization.id)
      .all<TaxRow>(),
  ]);
  const webhookUrls = endpoints.results.map((endpoint) => endpoint.webhook_url);
  return {
    lago_id: organization.id,
    name: organization.name,
    slug: organization.slug ?? organization.external_id,
    default_currency: organization.default_currency,
    created_at: organization.created_at,
    webhook_url: webhookUrls[0] ?? "",
    webhook_urls: webhookUrls,
    country: organization.country,
    address_line1: organization.address_line1,
    address_line2: organization.address_line2,
    state: organization.state,
    zipcode: organization.zipcode,
    email: organization.email,
    city: organization.city,
    legal_name: organization.legal_name,
    legal_number: organization.legal_number,
    timezone: organization.timezone,
    net_payment_term: organization.net_payment_term,
    email_settings: parseStringArray(organization.email_settings_json),
    document_numbering: organization.document_numbering,
    document_number_prefix: organization.document_number_prefix,
    tax_identification_number: organization.tax_identification_number,
    finalize_zero_amount_invoice: organization.finalize_zero_amount_invoice === 1,
    billing_configuration: {
      invoice_footer: organization.invoice_footer,
      invoice_grace_period: organization.invoice_grace_period,
      document_locale: organization.document_locale,
    },
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
    version: organization.version,
    updated_at: organization.updated_at,
  };
}

function organizationEvent(
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
       VALUES (?, ?, 'organization.updated', 1, 'organization', ?, ?, NULL, ?, ?, ?, NULL)`,
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

function organizationChangedFields(current: OrganizationRow, next: OrganizationRow): string[] {
  const fields: Array<keyof OrganizationRow> = [
    "slug",
    "default_currency",
    "country",
    "address_line1",
    "address_line2",
    "state",
    "zipcode",
    "email",
    "city",
    "legal_name",
    "legal_number",
    "tax_identification_number",
    "timezone",
    "net_payment_term",
    "invoice_grace_period",
    "document_numbering",
    "document_number_prefix",
    "finalize_zero_amount_invoice",
    "email_settings_json",
    "invoice_footer",
    "document_locale",
  ];
  return fields.filter((fieldName) => current[fieldName] !== next[fieldName]);
}

export function field<T>(
  input: Record<string, unknown>,
  name: string,
  current: T,
  normalize: (value: unknown) => T,
): T {
  return input[name] === undefined ? current : normalize(input[name]);
}

export function optionalObject(value: unknown, name: string): Record<string, unknown> {
  if (value === undefined || value === null) return {};
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new ApiError(422, "validation_error", `${name} must be an object`);
  }
  return value as Record<string, unknown>;
}

export function nullableString(value: unknown): string | null {
  if (value === null || value === "") return null;
  if (typeof value !== "string")
    throw new ApiError(422, "validation_error", "Value must be a string");
  return value.trim() || null;
}

function slug(value: unknown): string {
  const normalized = nullableString(value)?.toLowerCase();
  if (
    !normalized ||
    normalized.length < 3 ||
    normalized.length > 40 ||
    !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(normalized) ||
    RESERVED_SLUGS.has(normalized)
  ) {
    throw new ApiError(422, "validation_error", "slug is invalid or reserved");
  }
  return normalized;
}

export function currencyCode(value: unknown): string {
  const normalized = nullableString(value)?.toUpperCase();
  if (!normalized || !LAGO_CURRENCIES.has(normalized)) {
    throw new ApiError(
      422,
      "validation_error",
      "default_currency must be a Lago-supported currency code",
    );
  }
  return normalized;
}

export function countryCode(value: unknown): string | null {
  const normalized = nullableString(value)?.toUpperCase() ?? null;
  if (normalized !== null && !ISO_COUNTRIES.has(normalized)) {
    throw new ApiError(422, "validation_error", "country must be an ISO country code");
  }
  return normalized;
}

export function emailAddress(value: unknown): string | null {
  const normalized = nullableString(value)?.toLowerCase() ?? null;
  if (normalized !== null && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized)) {
    throw new ApiError(422, "validation_error", "email must be valid");
  }
  return normalized;
}

export function timezone(value: unknown): string {
  const normalized = nullableString(value);
  if (!normalized) throw new ApiError(422, "validation_error", "timezone is required");
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: normalized }).format(new Date(0));
  } catch {
    throw new ApiError(422, "validation_error", "timezone must be an IANA time zone");
  }
  return normalized;
}

export function nonNegativeInteger(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    throw new ApiError(422, "validation_error", "Value must be a non-negative integer");
  }
  return Number(value);
}

function documentNumbering(value: unknown): string {
  const normalized = nullableString(value);
  if (!normalized || !DOCUMENT_NUMBERINGS.has(normalized)) {
    throw new ApiError(422, "validation_error", "document_numbering is invalid");
  }
  return normalized;
}

export function documentPrefix(value: unknown): string | null {
  const normalized = nullableString(value)?.toUpperCase() ?? null;
  if (normalized !== null && (normalized.length < 1 || normalized.length > 10)) {
    throw new ApiError(
      422,
      "validation_error",
      "document_number_prefix must be 1 to 10 characters",
    );
  }
  return normalized;
}

export function booleanInteger(value: unknown): number {
  if (typeof value !== "boolean") {
    throw new ApiError(422, "validation_error", "Value must be a boolean");
  }
  return value ? 1 : 0;
}

export function emailSettings(value: unknown): string {
  if (
    !Array.isArray(value) ||
    value.some((entry) => typeof entry !== "string" || !EMAIL_SETTINGS.has(entry))
  ) {
    throw new ApiError(422, "validation_error", "email_settings contains an unsupported value");
  }
  return JSON.stringify([...new Set(value)].sort());
}

export function invoiceFooter(value: unknown): string | null {
  const normalized = nullableString(value);
  if (normalized && normalized.length > 600) {
    throw new ApiError(422, "validation_error", "invoice_footer must not exceed 600 characters");
  }
  return normalized;
}

export function documentLocale(value: unknown): string {
  const normalized = nullableString(value)?.toLowerCase();
  const locale = normalized ? DOCUMENT_LOCALES.get(normalized) : undefined;
  if (!locale) {
    throw new ApiError(422, "validation_error", "document_locale is not supported by Lago");
  }
  return locale;
}

export function parseStringArray(value: string): string[] {
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) && parsed.every((entry) => typeof entry === "string")
      ? parsed
      : [];
  } catch {
    return [];
  }
}
