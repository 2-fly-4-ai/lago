import { ApiError, json } from "../http";

type MoneyPointRow = {
  period: string;
  amount_minor: number;
};

type RevenueStreamRow = {
  stream: string;
  amount_minor: number;
  invoice_count: number;
};

type UsagePointRow = {
  period: string;
  amount_minor: number;
  units: string;
  events_count: number;
};

type MetricUsageRow = {
  code: string;
  amount_minor: number;
  units: string;
  events_count: number;
};

type InvoiceStatusRow = {
  status: string;
  payment_status: string;
  amount_minor: number;
  invoice_count: number;
};

type WalletPointRow = {
  period: string;
  granted_minor: number;
  purchased_minor: number;
  consumed_minor: number;
};

type NamedAmountRow = {
  code: string;
  name: string | null;
  amount_minor: number;
  invoice_count: number;
};

type CollectionRow = {
  collection_status: string;
  amount_minor: number;
  invoice_count: number;
};

export async function handleOperatorAnalyticsRequest(
  request: Request,
  database: D1Database,
  organizationId: string,
  requestId: string,
): Promise<Response | null> {
  const url = new URL(request.url);
  if (request.method !== "GET") return null;
  if (url.pathname === "/api/operator/v1/analytics") {
    return analytics(url, database, organizationId, requestId);
  }
  if (url.pathname === "/api/operator/v1/forecasts") {
    return forecasts(url, database, organizationId, requestId);
  }
  return null;
}

async function analytics(
  url: URL,
  database: D1Database,
  organizationId: string,
  requestId: string,
): Promise<Response> {
  const range = dateRange(url);
  const customerId = await customerScope(url, database, organizationId);
  const organization = await database
    .prepare("SELECT default_currency FROM organizations WHERE id = ? LIMIT 1")
    .bind(organizationId)
    .first<{ default_currency: string }>();
  if (!organization)
    throw new ApiError(404, "organization_not_found", "Organization was not found");
  const currency = organization.default_currency;
  const invoiceCustomer = customerId ? " AND invoice.customer_id = ?" : "";
  const usageCustomer = customerId ? " AND snapshot.customer_id = ?" : "";
  const billableMetricCode = url.searchParams.get("billable_metric_code")?.trim() || null;
  if (billableMetricCode && billableMetricCode.length > 255) {
    throw new ApiError(422, "validation_error", "Billable metric code is too long");
  }
  const usageMetric = billableMetricCode ? " AND charge.billable_metric_code = ?" : "";
  const walletCustomer = customerId ? " AND wallet.customer_id = ?" : "";
  const customerBindings = customerId ? [customerId] : [];
  const usageBindings = [...customerBindings, ...(billableMetricCode ? [billableMetricCode] : [])];

  const statements = [
    database
      .prepare(
        `SELECT substr(COALESCE(invoice.finalized_at, invoice.created_at), 1, 7) AS period,
                SUM(invoice.total_due_minor) AS amount_minor
         FROM invoices invoice
         WHERE invoice.organization_id = ? AND invoice.currency = ? AND invoice.status = 'finalized'
           AND date(COALESCE(invoice.finalized_at, invoice.created_at)) BETWEEN date(?) AND date(?)
           ${invoiceCustomer}
         GROUP BY period ORDER BY period`,
      )
      .bind(organizationId, currency, range.from, range.to, ...customerBindings),
    database
      .prepare(
        `SELECT CASE WHEN invoice.subscription_id IS NULL THEN 'one_off' ELSE 'subscription' END AS stream,
                SUM(invoice.total_due_minor) AS amount_minor, COUNT(*) AS invoice_count
         FROM invoices invoice
         WHERE invoice.organization_id = ? AND invoice.currency = ? AND invoice.status = 'finalized'
           AND date(COALESCE(invoice.finalized_at, invoice.created_at)) BETWEEN date(?) AND date(?)
           ${invoiceCustomer}
         GROUP BY stream ORDER BY stream`,
      )
      .bind(organizationId, currency, range.from, range.to, ...customerBindings),
    database
      .prepare(
        `SELECT COALESCE(ROUND(SUM(CASE plan.interval
                  WHEN 'weekly' THEN plan.amount_minor * 52.0 / 12.0
                  WHEN 'monthly' THEN plan.amount_minor
                  WHEN 'quarterly' THEN plan.amount_minor / 3.0
                  WHEN 'yearly' THEN plan.amount_minor / 12.0
                  ELSE 0 END)), 0) AS amount_minor,
                COUNT(DISTINCT subscription.id) AS subscriptions_count
         FROM subscriptions subscription
         JOIN plans plan ON plan.id = subscription.plan_id
         WHERE subscription.organization_id = ? AND plan.currency = ?
           AND subscription.status IN ('active', 'past_due')
           ${customerId ? "AND subscription.customer_id = ?" : ""}`,
      )
      .bind(organizationId, currency, ...customerBindings),
    database
      .prepare(
        `SELECT snapshot.usage_date AS period, SUM(snapshot.amount_minor) AS amount_minor,
                CAST(COALESCE(SUM(CAST(charge.delta_units_decimal AS REAL)), 0) AS TEXT) AS units,
                COALESCE(SUM(charge.delta_events_count), 0) AS events_count
         FROM daily_usage_snapshots snapshot
         LEFT JOIN daily_usage_charge_snapshots charge
           ON charge.daily_usage_snapshot_id = snapshot.id
         WHERE snapshot.organization_id = ? AND snapshot.currency = ?
           AND date(snapshot.usage_date) BETWEEN date(?) AND date(?) ${usageCustomer} ${usageMetric}
         GROUP BY snapshot.usage_date ORDER BY snapshot.usage_date`,
      )
      .bind(organizationId, currency, range.from, range.to, ...usageBindings),
    database
      .prepare(
        `SELECT charge.billable_metric_code AS code,
                SUM(charge.delta_amount_minor) AS amount_minor,
                CAST(SUM(CAST(charge.delta_units_decimal AS REAL)) AS TEXT) AS units,
                SUM(charge.delta_events_count) AS events_count
         FROM daily_usage_charge_snapshots charge
         JOIN daily_usage_snapshots snapshot ON snapshot.id = charge.daily_usage_snapshot_id
         WHERE charge.organization_id = ? AND charge.currency = ?
           AND date(snapshot.usage_date) BETWEEN date(?) AND date(?) ${usageCustomer} ${usageMetric}
         GROUP BY charge.billable_metric_code ORDER BY amount_minor DESC, code LIMIT 100`,
      )
      .bind(organizationId, currency, range.from, range.to, ...usageBindings),
    database
      .prepare(
        `SELECT invoice.status, invoice.payment_status, SUM(invoice.total_due_minor) AS amount_minor,
                COUNT(*) AS invoice_count
         FROM invoices invoice
         WHERE invoice.organization_id = ? AND invoice.currency = ?
           AND date(invoice.created_at) BETWEEN date(?) AND date(?) ${invoiceCustomer}
         GROUP BY invoice.status, invoice.payment_status
         ORDER BY invoice.status, invoice.payment_status`,
      )
      .bind(organizationId, currency, range.from, range.to, ...customerBindings),
    database
      .prepare(
        `SELECT COALESCE(SUM(wallet.balance_minor), 0) AS balance_minor,
                COALESCE(SUM(wallet.consumed_minor), 0) AS consumed_minor,
                COUNT(*) AS wallets_count
         FROM wallets wallet
         WHERE wallet.organization_id = ? AND wallet.currency = ? AND wallet.status = 'active'
           ${walletCustomer}`,
      )
      .bind(organizationId, currency, ...customerBindings),
    database
      .prepare(
        `SELECT substr(tx.created_at, 1, 7) AS period,
                SUM(CASE WHEN tx.transaction_type = 'inbound'
                              AND tx.transaction_status = 'granted'
                         THEN tx.amount_minor ELSE 0 END) AS granted_minor,
                SUM(CASE WHEN tx.transaction_type = 'inbound'
                              AND tx.transaction_status = 'purchased'
                         THEN tx.amount_minor ELSE 0 END) AS purchased_minor,
                SUM(CASE WHEN tx.transaction_type = 'outbound'
                         THEN tx.amount_minor ELSE 0 END) AS consumed_minor
         FROM wallet_transactions tx
         JOIN wallets wallet ON wallet.id = tx.wallet_id
         WHERE tx.organization_id = ? AND wallet.currency = ?
           AND tx.status = 'settled'
           AND date(tx.created_at) BETWEEN date(?) AND date(?) ${walletCustomer}
         GROUP BY period ORDER BY period`,
      )
      .bind(organizationId, currency, range.from, range.to, ...customerBindings),
    database
      .prepare(
        `SELECT customer.external_id AS code, customer.name,
                SUM(invoice.total_due_minor) AS amount_minor, COUNT(*) AS invoice_count
         FROM invoices invoice
         JOIN customers customer ON customer.id = invoice.customer_id
         WHERE invoice.organization_id = ? AND invoice.currency = ? AND invoice.status = 'finalized'
           AND date(COALESCE(invoice.finalized_at, invoice.created_at)) BETWEEN date(?) AND date(?)
           ${invoiceCustomer}
         GROUP BY customer.id, customer.external_id, customer.name
         ORDER BY amount_minor DESC, customer.external_id LIMIT 100`,
      )
      .bind(organizationId, currency, range.from, range.to, ...customerBindings),
    database
      .prepare(
        `SELECT COALESCE(plan.code, 'one_off') AS code,
                COALESCE(plan.name, 'One-off invoices') AS name,
                SUM(invoice.total_due_minor) AS amount_minor, COUNT(*) AS invoice_count
         FROM invoices invoice
         LEFT JOIN subscriptions subscription ON subscription.id = invoice.subscription_id
         LEFT JOIN plans plan ON plan.id = subscription.plan_id
         WHERE invoice.organization_id = ? AND invoice.currency = ? AND invoice.status = 'finalized'
           AND date(COALESCE(invoice.finalized_at, invoice.created_at)) BETWEEN date(?) AND date(?)
           ${invoiceCustomer}
         GROUP BY COALESCE(plan.code, 'one_off'), COALESCE(plan.name, 'One-off invoices')
         ORDER BY amount_minor DESC, code LIMIT 100`,
      )
      .bind(organizationId, currency, range.from, range.to, ...customerBindings),
    database
      .prepare(
        `SELECT plan.code, plan.name,
                COALESCE(ROUND(SUM(CASE plan.interval
                  WHEN 'weekly' THEN plan.amount_minor * 52.0 / 12.0
                  WHEN 'monthly' THEN plan.amount_minor
                  WHEN 'quarterly' THEN plan.amount_minor / 3.0
                  WHEN 'yearly' THEN plan.amount_minor / 12.0
                  ELSE 0 END)), 0) AS amount_minor,
                COUNT(DISTINCT subscription.id) AS invoice_count
         FROM subscriptions subscription
         JOIN plans plan ON plan.id = subscription.plan_id
         WHERE subscription.organization_id = ? AND plan.currency = ?
           AND subscription.status IN ('active', 'past_due')
           ${customerId ? "AND subscription.customer_id = ?" : ""}
         GROUP BY plan.id, plan.code, plan.name ORDER BY amount_minor DESC, plan.code`,
      )
      .bind(organizationId, currency, ...customerBindings),
    database
      .prepare(
        `SELECT CASE
                  WHEN invoice.payment_status = 'succeeded' THEN 'collected'
                  WHEN invoice.payment_due_date IS NOT NULL
                    AND date(invoice.payment_due_date) < date('now') THEN 'overdue'
                  ELSE 'outstanding'
                END AS collection_status,
                SUM(invoice.total_due_minor) AS amount_minor, COUNT(*) AS invoice_count
         FROM invoices invoice
         WHERE invoice.organization_id = ? AND invoice.currency = ? AND invoice.status = 'finalized'
           AND date(COALESCE(invoice.finalized_at, invoice.created_at)) BETWEEN date(?) AND date(?)
           ${invoiceCustomer}
         GROUP BY collection_status ORDER BY collection_status`,
      )
      .bind(organizationId, currency, range.from, range.to, ...customerBindings),
  ];
  const results = await database.batch(statements);
  const revenue = results[0]?.results as unknown as MoneyPointRow[];
  const streams = results[1]?.results as unknown as RevenueStreamRow[];
  const mrr = results[2]?.results[0] as unknown as {
    amount_minor: number;
    subscriptions_count: number;
  };
  const usage = results[3]?.results as unknown as UsagePointRow[];
  const metrics = results[4]?.results as unknown as MetricUsageRow[];
  const invoices = results[5]?.results as unknown as InvoiceStatusRow[];
  const wallets = results[6]?.results[0] as unknown as {
    balance_minor: number;
    consumed_minor: number;
    wallets_count: number;
  };
  const walletPoints = results[7]?.results as unknown as WalletPointRow[];
  const revenueCustomers = results[8]?.results as unknown as NamedAmountRow[];
  const revenuePlans = results[9]?.results as unknown as NamedAmountRow[];
  const mrrPlans = results[10]?.results as unknown as NamedAmountRow[];
  const collections = results[11]?.results as unknown as CollectionRow[];
  return json(
    {
      analytics: {
        currency,
        from: range.from,
        to: range.to,
        customer_external_id: url.searchParams.get("customer_external_id") || null,
        revenue_streams: {
          total_amount_minor: sum(revenue, "amount_minor"),
          monthly: revenue.map(numberRow),
          breakdown: streams.map((row) => ({
            stream: row.stream,
            amount_minor: Number(row.amount_minor) || 0,
            invoice_count: Number(row.invoice_count) || 0,
          })),
          customer_breakdown: revenueCustomers.map(namedAmount),
          plan_breakdown: revenuePlans.map(namedAmount),
        },
        mrr: {
          amount_minor: Number(mrr?.amount_minor) || 0,
          subscriptions_count: Number(mrr?.subscriptions_count) || 0,
          plan_breakdown: mrrPlans.map((row) => ({
            code: row.code,
            name: row.name,
            amount_minor: Number(row.amount_minor) || 0,
            subscriptions_count: Number(row.invoice_count) || 0,
          })),
        },
        usage: {
          billable_metric_code: billableMetricCode,
          total_amount_minor: sum(usage, "amount_minor"),
          total_units: sumDecimal(usage.map((row) => row.units)),
          total_events_count: sum(usage, "events_count"),
          daily: usage.map((row) => ({
            period: row.period,
            amount_minor: Number(row.amount_minor) || 0,
            units: row.units,
            events_count: Number(row.events_count) || 0,
          })),
          billable_metrics: metrics.map((row) => ({
            code: row.code,
            amount_minor: Number(row.amount_minor) || 0,
            units: row.units,
            events_count: Number(row.events_count) || 0,
          })),
        },
        prepaid_credits: {
          balance_minor: Number(wallets?.balance_minor) || 0,
          consumed_minor: Number(wallets?.consumed_minor) || 0,
          wallets_count: Number(wallets?.wallets_count) || 0,
          monthly: walletPoints.map((row) => ({
            period: row.period,
            granted_minor: Number(row.granted_minor) || 0,
            purchased_minor: Number(row.purchased_minor) || 0,
            consumed_minor: Number(row.consumed_minor) || 0,
          })),
        },
        invoices: {
          total_amount_minor: sum(invoices, "amount_minor"),
          total_count: sum(invoices, "invoice_count"),
          breakdown: invoices.map((row) => ({
            status: row.status,
            payment_status: row.payment_status,
            amount_minor: Number(row.amount_minor) || 0,
            invoice_count: Number(row.invoice_count) || 0,
          })),
          collection_breakdown: collections.map((row) => ({
            status: row.collection_status,
            amount_minor: Number(row.amount_minor) || 0,
            invoice_count: Number(row.invoice_count) || 0,
          })),
        },
      },
    },
    { requestId },
  );
}

function namedAmount(row: NamedAmountRow) {
  return {
    code: row.code,
    name: row.name,
    amount_minor: Number(row.amount_minor) || 0,
    invoice_count: Number(row.invoice_count) || 0,
  };
}

async function forecasts(
  url: URL,
  database: D1Database,
  organizationId: string,
  requestId: string,
): Promise<Response> {
  const months = boundedInteger(url.searchParams.get("months"), 6, 3, 12);
  const organization = await database
    .prepare("SELECT default_currency FROM organizations WHERE id = ? LIMIT 1")
    .bind(organizationId)
    .first<{ default_currency: string }>();
  if (!organization)
    throw new ApiError(404, "organization_not_found", "Organization was not found");
  const historyResult = await database
    .prepare(
      `SELECT substr(COALESCE(finalized_at, created_at), 1, 7) AS period,
              SUM(total_due_minor) AS amount_minor
       FROM invoices
       WHERE organization_id = ? AND currency = ? AND status = 'finalized'
         AND date(COALESCE(finalized_at, created_at)) >= date('now', '-12 months', 'start of month')
       GROUP BY period ORDER BY period`,
    )
    .bind(organizationId, organization.default_currency)
    .all<MoneyPointRow>();
  const history = historyResult.results.map(numberRow);
  const recent = history.slice(-6);
  const baseline = recent.length ? sum(recent, "amount_minor") / recent.length : 0;
  const first = recent[0]?.amount_minor ?? baseline;
  const last = recent.at(-1)?.amount_minor ?? baseline;
  const trend =
    recent.length > 1 && first > 0
      ? clamp((last - first) / first / (recent.length - 1), -0.25, 0.25)
      : 0;
  const points = futureMonths(months).map((period, index) => {
    const realistic = Math.max(0, Math.round(baseline * (1 + trend) ** (index + 1)));
    return {
      period,
      optimistic_amount_minor: Math.round(realistic * (1.1 + index * 0.015)),
      realistic_amount_minor: realistic,
      conservative_amount_minor: Math.round(realistic * Math.max(0.65, 0.9 - index * 0.015)),
    };
  });
  return json(
    {
      forecast: {
        currency: organization.default_currency,
        generated_at: new Date().toISOString(),
        historical_months: history,
        projected_months: points,
        methodology: "Trailing six-month invoiced revenue with bounded month-over-month trend",
      },
    },
    { requestId },
  );
}

async function customerScope(
  url: URL,
  database: D1Database,
  organizationId: string,
): Promise<string | null> {
  const externalId = url.searchParams.get("customer_external_id")?.trim();
  if (!externalId) return null;
  if (externalId.length > 255)
    throw new ApiError(422, "validation_error", "Customer identifier is too long");
  const customer = await database
    .prepare("SELECT id FROM customers WHERE organization_id = ? AND external_id = ? LIMIT 1")
    .bind(organizationId, externalId)
    .first<{ id: string }>();
  if (!customer) throw new ApiError(404, "customer_not_found", "Customer was not found");
  return customer.id;
}

function dateRange(url: URL): { from: string; to: string } {
  const now = new Date();
  const fallbackTo = now.toISOString().slice(0, 10);
  const fromDate = new Date(Date.UTC(now.getUTCFullYear() - 1, now.getUTCMonth(), 1));
  const fallbackFrom = fromDate.toISOString().slice(0, 10);
  const from = dateParameter(url.searchParams.get("from"), fallbackFrom, "from");
  const to = dateParameter(url.searchParams.get("to"), fallbackTo, "to");
  if (from > to) throw new ApiError(422, "validation_error", "from must not be after to");
  const span = Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`);
  if (span > 3 * 366 * 86_400_000) {
    throw new ApiError(422, "validation_error", "Analytics range cannot exceed three years");
  }
  return { from, to };
}

function dateParameter(value: string | null, fallback: string, name: string): string {
  if (!value) return fallback;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(Date.parse(`${value}T00:00:00Z`))) {
    throw new ApiError(422, "validation_error", `${name} must be an ISO date`);
  }
  return value;
}

function numberRow(row: MoneyPointRow): { period: string; amount_minor: number } {
  return { period: row.period, amount_minor: Number(row.amount_minor) || 0 };
}

function sum<T extends object>(rows: T[], key: keyof T): number {
  return rows.reduce((total, row) => total + (Number(row[key]) || 0), 0);
}

function sumDecimal(values: string[]): string {
  return String(values.reduce((total, value) => total + (Number(value) || 0), 0));
}

function futureMonths(count: number): string[] {
  const now = new Date();
  return Array.from({ length: count }, (_, index) => {
    const date = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + index + 1, 1));
    return date.toISOString().slice(0, 7);
  });
}

function boundedInteger(
  value: string | null,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  if (!value) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new ApiError(422, "validation_error", "months is invalid");
  }
  return parsed;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}
