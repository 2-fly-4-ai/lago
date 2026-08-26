import type { AuthContext } from "../auth/api-key";
import { ApiError, json } from "../http";

type FeeRow = {
  id: string;
  invoice_id: string;
  subscription_id: string | null;
  external_subscription_id: string | null;
  customer_id: string;
  external_customer_id: string;
  line_type: string;
  description: string;
  quantity_decimal: string;
  unit_amount_decimal: string;
  amount_minor: number;
  precise_amount_minor: string | null;
  source_type: string;
  source_id: string;
  metadata_json: string;
  currency: string;
  payment_status: string;
  created_at: string;
};

type AppliedTaxRow = {
  id: string;
  invoice_line_id: string;
  tax_id: string;
  tax_name: string;
  tax_code: string;
  tax_description: string | null;
  tax_rate: string;
  amount_minor: number;
  precise_amount_minor: string;
  taxable_base_minor: number;
  currency: string;
  created_at: string;
};

export async function handleFeesApi(
  request: Request,
  env: Env,
  auth: AuthContext,
  requestId: string,
): Promise<Response | null> {
  const url = new URL(request.url);
  if (url.pathname === "/api/v1/fees") {
    if (request.method === "GET") return listFees(env.BILLING_DB, auth, url, requestId);
    return null;
  }
  const match = url.pathname.match(/^\/api\/v1\/fees\/([^/]+)$/);
  if (!match?.[1]) return null;
  if (request.method === "GET") {
    return showFee(env.BILLING_DB, auth, decodeURIComponent(match[1]), requestId);
  }
  if (request.method === "PUT" || request.method === "DELETE") {
    throw new ApiError(
      422,
      "unsupported_fee_mutation",
      "Fee mutation is not implemented; invoice lines remain immutable billing evidence",
    );
  }
  return null;
}

async function showFee(
  database: D1Database,
  auth: AuthContext,
  feeId: string,
  requestId: string,
): Promise<Response> {
  const fee = await database
    .prepare(`${feeSelect()} WHERE i.organization_id = ? AND line.id = ? LIMIT 1`)
    .bind(auth.organizationId, feeId)
    .first<FeeRow>();
  if (!fee) throw new ApiError(404, "fee_not_found", "Fee was not found");
  const taxes = await taxesByFee(database, [fee.id]);
  return json({ fee: serializeFee(fee, taxes.get(fee.id) ?? []) }, { requestId });
}

async function listFees(
  database: D1Database,
  auth: AuthContext,
  url: URL,
  requestId: string,
): Promise<Response> {
  const page = positiveInteger(url.searchParams.get("page"), 1);
  const perPage = Math.min(positiveInteger(url.searchParams.get("per_page"), 20), 100);
  const where = ["i.organization_id = ?"];
  const values: Array<string | number> = [auth.organizationId];
  addExactFilter(where, values, "line.line_type", url.searchParams.get("fee_type"));
  addExactFilter(where, values, "i.payment_status", url.searchParams.get("payment_status"));
  addExactFilter(
    where,
    values,
    "subscription.external_id",
    url.searchParams.get("external_subscription_id"),
  );
  addExactFilter(
    where,
    values,
    "customer.external_id",
    url.searchParams.get("external_customer_id"),
  );
  const currency = url.searchParams.get("currency")?.trim();
  if (currency) addExactFilter(where, values, "i.currency", currency.toUpperCase());
  addJsonFilter(
    where,
    values,
    "$.billableMetricCode",
    url.searchParams.get("billable_metric_code"),
  );
  addJsonFilter(
    where,
    values,
    "$.eventTransactionId",
    url.searchParams.get("event_transaction_id"),
  );
  addDateFilter(where, values, "line.created_at", ">=", url.searchParams.get("created_at_from"));
  addDateFilter(where, values, "line.created_at", "<=", url.searchParams.get("created_at_to"));
  const predicate = where.join(" AND ");
  const totalRow = await database
    .prepare(
      `SELECT COUNT(*) AS total FROM invoice_lines line
       JOIN invoices i ON i.id = line.invoice_id
       JOIN customers customer ON customer.id = i.customer_id
       LEFT JOIN subscriptions subscription ON subscription.id = i.subscription_id
       WHERE ${predicate}`,
    )
    .bind(...values)
    .first<{ total: number }>();
  const total = Number(totalRow?.total ?? 0);
  const fees = await database
    .prepare(
      `${feeSelect()} WHERE ${predicate}
       ORDER BY line.created_at DESC, line.id DESC LIMIT ? OFFSET ?`,
    )
    .bind(...values, perPage, (page - 1) * perPage)
    .all<FeeRow>();
  const taxes = await taxesByFee(
    database,
    fees.results.map((fee) => fee.id),
  );
  return json(
    {
      fees: fees.results.map((fee) => serializeFee(fee, taxes.get(fee.id) ?? [])),
      meta: paginationMeta(total, page, perPage),
    },
    { requestId },
  );
}

function feeSelect(): string {
  return `SELECT line.id, line.invoice_id, i.subscription_id,
                 subscription.external_id AS external_subscription_id,
                 i.customer_id, customer.external_id AS external_customer_id,
                 line.line_type, line.description, line.quantity_decimal,
                 line.unit_amount_decimal, line.amount_minor, line.precise_amount_minor,
                 line.source_type, line.source_id, line.metadata_json,
                 i.currency, i.payment_status, line.created_at
          FROM invoice_lines line
          JOIN invoices i ON i.id = line.invoice_id
          JOIN customers customer ON customer.id = i.customer_id
          LEFT JOIN subscriptions subscription ON subscription.id = i.subscription_id`;
}

async function taxesByFee(
  database: D1Database,
  feeIds: string[],
): Promise<Map<string, AppliedTaxRow[]>> {
  const grouped = new Map<string, AppliedTaxRow[]>();
  if (feeIds.length === 0) return grouped;
  const placeholders = feeIds.map(() => "?").join(", ");
  const result = await database
    .prepare(
      `SELECT id, invoice_line_id, tax_id, tax_name, tax_code, tax_description, tax_rate,
              amount_minor, precise_amount_minor, taxable_base_minor, currency, created_at
       FROM invoice_line_taxes WHERE invoice_line_id IN (${placeholders})
       ORDER BY created_at, id`,
    )
    .bind(...feeIds)
    .all<AppliedTaxRow>();
  for (const tax of result.results) {
    const current = grouped.get(tax.invoice_line_id) ?? [];
    current.push(tax);
    grouped.set(tax.invoice_line_id, current);
  }
  return grouped;
}

function serializeFee(fee: FeeRow, taxes: AppliedTaxRow[]) {
  const metadata = parseObject(fee.metadata_json);
  const preciseAmountMinor = fee.precise_amount_minor ?? String(fee.amount_minor);
  const taxesMinor = taxes.reduce((sum, tax) => sum + tax.amount_minor, 0);
  const sourceId = typeof metadata.chargeId === "string" ? metadata.chargeId : fee.source_id;
  return {
    lago_id: fee.id,
    lago_charge_id: fee.source_type === "charge" ? sourceId : null,
    lago_charge_filter_id: null,
    lago_fixed_charge_id: fee.source_type === "fixed_charge" ? sourceId : null,
    lago_invoice_id: fee.invoice_id,
    lago_true_up_fee_id: null,
    lago_true_up_parent_fee_id: null,
    lago_original_fee_id: null,
    lago_subscription_id: fee.subscription_id,
    external_subscription_id: fee.external_subscription_id,
    lago_customer_id: fee.customer_id,
    external_customer_id: fee.external_customer_id,
    item: {
      type: fee.line_type,
      code: typeof metadata.code === "string" ? metadata.code : fee.source_id,
      name: typeof metadata.name === "string" ? metadata.name : fee.description,
      description: fee.description,
      invoice_display_name:
        typeof metadata.invoiceDisplayName === "string"
          ? metadata.invoiceDisplayName
          : fee.description,
      filters: null,
      filter_invoice_display_name: null,
      lago_item_id: sourceId,
      item_type: fee.source_type,
      grouped_by: metadata.groupedBy ?? null,
    },
    pay_in_advance: false,
    invoiceable: true,
    amount_cents: fee.amount_minor,
    amount_currency: fee.currency,
    precise_amount: decimalMinorToMajor(preciseAmountMinor),
    precise_total_amount: decimalMinorToMajor(String(Number(preciseAmountMinor) + taxesMinor)),
    taxes_amount_cents: taxesMinor,
    taxes_precise_amount: decimalMinorToMajor(String(taxesMinor)),
    taxes_rate: taxes.reduce((sum, tax) => sum + Number(tax.tax_rate), 0),
    total_aggregated_units: fee.quantity_decimal,
    total_amount_cents: fee.amount_minor + taxesMinor,
    total_amount_currency: fee.currency,
    units: fee.quantity_decimal,
    description: fee.description,
    precise_unit_amount: fee.unit_amount_decimal,
    precise_coupons_amount_cents: "0",
    sub_total_excluding_taxes_amount_cents: fee.amount_minor,
    sub_total_excluding_taxes_precise_amount_cents: preciseAmountMinor,
    events_count: typeof metadata.eventsCount === "number" ? metadata.eventsCount : 0,
    payment_status: fee.payment_status,
    created_at: fee.created_at,
    succeeded_at: null,
    failed_at: null,
    refunded_at: null,
    amount_details: metadata.amountDetails ?? null,
    self_billed: false,
    pricing_unit_details: null,
    presentation_breakdowns: [],
    applied_taxes: taxes.map((tax) => ({
      lago_id: tax.id,
      lago_tax_id: tax.tax_id,
      tax_name: tax.tax_name,
      tax_code: tax.tax_code,
      tax_description: tax.tax_description,
      tax_rate: Number(tax.tax_rate),
      amount_cents: tax.amount_minor,
      precise_amount_cents: tax.precise_amount_minor,
      taxable_base_amount_cents: tax.taxable_base_minor,
      amount_currency: tax.currency,
      created_at: tax.created_at,
    })),
  };
}

function addExactFilter(
  where: string[],
  values: Array<string | number>,
  column: string,
  value: string | null,
): void {
  const normalized = value?.trim();
  if (!normalized) return;
  where.push(`${column} = ?`);
  values.push(normalized);
}

function addJsonFilter(
  where: string[],
  values: Array<string | number>,
  path: string,
  value: string | null,
): void {
  const normalized = value?.trim();
  if (!normalized) return;
  where.push("json_extract(line.metadata_json, ?) = ?");
  values.push(path, normalized);
}

function addDateFilter(
  where: string[],
  values: Array<string | number>,
  column: string,
  operator: ">=" | "<=",
  value: string | null,
): void {
  if (!value) return;
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) {
    throw new ApiError(422, "validation_error", `${column} filter must be an ISO timestamp`);
  }
  where.push(`${column} ${operator} ?`);
  values.push(parsed.toISOString());
}

function positiveInteger(value: string | null, fallback: number): number {
  if (value === null || value === "") return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new ApiError(422, "validation_error", "Pagination values must be positive integers");
  }
  return parsed;
}

function paginationMeta(total: number, page: number, perPage: number) {
  const totalPages = total === 0 ? 0 : Math.ceil(total / perPage);
  return {
    current_page: total === 0 ? 0 : page,
    next_page: page < totalPages ? page + 1 : null,
    prev_page: page > 1 && page <= totalPages ? page - 1 : null,
    total_pages: totalPages,
    total_count: total,
  };
}

function parseObject(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function decimalMinorToMajor(value: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new Error("invalid_fee_decimal");
  return parsed / 100;
}
