import { calculateCurrentUsageProjection, type SubscriptionUsageRow } from "../api/metered-usage";
import { localDate, localDateString, localMidnightUtc } from "../billing/periods";
import { deterministicUuid } from "../identifiers";
import { stableJson } from "../json";
import { Decimal } from "../rating/decimal";

type DailyUsageCandidate = SubscriptionUsageRow & {
  timezone: string;
  usageDate: string;
  calculatedThrough: string;
};

type InvoiceDailyUsageCandidate = {
  invoiceId: string;
  invoiceVersion: number;
  invoiceUpdatedAt: string;
  organizationId: string;
  customerId: string;
  subscriptionId: string;
  externalSubscriptionId: string;
  periodStart: string;
  periodEnd: string;
  currency: string;
  timezone: string;
  usageDate: string;
};

type UsagePayload = {
  from_datetime: string;
  to_datetime: string;
  issuing_date: string;
  currency: string;
  amount_cents: number | string;
  total_amount_cents: number | string;
  taxes_amount_cents: number | string;
  charges_usage: Array<Record<string, unknown>>;
};

type StoredSnapshot = {
  source_type: string;
  source_invoice_id: string | null;
  source_invoice_version: number | null;
};

type InvoiceLineRow = {
  source_id: string;
  quantity_decimal: string;
  amount_minor: number;
  metadata_json: string;
};

type ChargeCatalogRow = {
  id: string;
  code: string;
  invoice_display_name: string | null;
  charge_model: string;
  metric_id: string;
  metric_code: string;
  metric_name: string;
  aggregation_type: string;
};

export type DailyUsageRollup = {
  usageDate: string;
  billableMetricCode: string;
  currency: string;
  amountMinor: number;
  units: string;
};

export async function scheduledDailyUsageCandidates(
  database: D1Database,
  triggeredAt: number,
  limit = 100,
): Promise<DailyUsageCandidate[]> {
  const triggered = new Date(triggeredAt);
  if (!Number.isFinite(triggered.getTime())) throw new Error("invalid_daily_usage_timestamp");
  const recentEventOn = shiftDate(triggered.toISOString().slice(0, 10), -1);
  const rows = await database
    .prepare(
      `SELECT s.id, s.organization_id, s.customer_id, s.plan_id, s.external_id,
              s.current_period_start, s.current_period_end, s.billing_time,
              s.billing_timezone, p.currency, p.interval,
              COALESCE(c.timezone, s.billing_timezone) AS timezone
       FROM subscriptions s JOIN customers c ON c.id = s.customer_id
       JOIN plans p ON p.id = s.plan_id
       WHERE s.status IN ('active', 'past_due')
         AND s.current_period_start IS NOT NULL AND s.current_period_end IS NOT NULL
         AND s.last_received_event_on >= ?
       ORDER BY s.last_received_event_on DESC, s.organization_id, s.id
       LIMIT ?`,
    )
    .bind(recentEventOn, Math.max(limit * 5, limit))
    .all<SubscriptionUsageRow & { timezone: string }>();

  const candidates: DailyUsageCandidate[] = [];
  for (const row of rows.results) {
    if (candidates.length >= limit) break;
    let localHour: number;
    let today: string;
    let calculatedThrough: string;
    try {
      localHour = Number(
        new Intl.DateTimeFormat("en-US-u-ca-iso8601-nu-latn", {
          timeZone: row.timezone,
          hour: "2-digit",
          hourCycle: "h23",
        }).format(triggered),
      );
      today = localDateString(triggered, row.timezone);
      calculatedThrough = localMidnightUtc(
        localDate(triggered, row.timezone),
        row.timezone,
      ).toISOString();
    } catch {
      continue;
    }
    if (![0, 1, 2].includes(localHour)) continue;
    if (localDateString(new Date(row.current_period_start), row.timezone) === today) continue;
    const usageDate = shiftDate(today, -1);
    const existing = await database
      .prepare(
        `SELECT 1 FROM daily_usage_snapshots
         WHERE subscription_id = ? AND usage_date = ? LIMIT 1`,
      )
      .bind(row.id, usageDate)
      .first<{ 1: number }>();
    if (existing) continue;
    candidates.push({ ...row, usageDate, calculatedThrough });
  }
  return candidates;
}

export async function projectScheduledDailyUsage(
  database: D1Database,
  candidate: DailyUsageCandidate,
  refreshedAt: string,
): Promise<boolean> {
  const projection = await calculateCurrentUsageProjection(database, candidate, {
    calculatedThrough: candidate.calculatedThrough,
  });
  const charges = projection.chargeUsage.filter(nonZeroChargeUsage);
  if (charges.length === 0) return false;
  const total = charges.reduce(
    (sum, charge) => sum.add(decimalField(charge, "amount_cents")),
    Decimal.zero(),
  );
  const usage: UsagePayload = {
    from_datetime: candidate.current_period_start,
    to_datetime: candidate.current_period_end,
    issuing_date: candidate.current_period_end.slice(0, 10),
    currency: candidate.currency,
    amount_cents: jsonDecimal(total),
    total_amount_cents: jsonDecimal(total),
    taxes_amount_cents: 0,
    charges_usage: charges,
  };
  return writeDailyUsageSnapshot(database, {
    organizationId: candidate.organization_id,
    customerId: candidate.customer_id,
    subscriptionId: candidate.id,
    externalSubscriptionId: candidate.external_id,
    usageDate: candidate.usageDate,
    calculatedThrough: candidate.calculatedThrough,
    refreshedAt,
    usage,
    source: { type: "scheduled" },
  });
}

export async function invoiceDailyUsageCandidates(
  database: D1Database,
  limit = 100,
): Promise<InvoiceDailyUsageCandidate[]> {
  const rows = await database
    .prepare(
      `WITH owners AS (
         SELECT bc.invoice_id, bc.subscription_id, bc.period_start, bc.period_end
         FROM billing_cycles bc
         WHERE bc.status = 'closed' AND bc.invoice_id IS NOT NULL
         UNION ALL
         SELECT owned.invoice_id, owned.subscription_id, owned.period_start, owned.period_end
         FROM invoice_subscriptions owned
         WHERE owned.period_start IS NOT NULL AND owned.period_end IS NOT NULL
           AND NOT EXISTS (SELECT 1 FROM billing_cycles bc WHERE bc.invoice_id = owned.invoice_id)
           AND 1 = (SELECT COUNT(*) FROM invoice_subscriptions peers
                    WHERE peers.invoice_id = owned.invoice_id)
       )
       SELECT i.id AS invoice_id, i.version AS invoice_version, i.updated_at AS invoice_updated_at,
              i.organization_id, i.customer_id, owner.subscription_id, s.external_id,
              owner.period_start, owner.period_end, i.currency,
              COALESCE(c.timezone, s.billing_timezone) AS timezone
       FROM owners owner JOIN invoices i ON i.id = owner.invoice_id
       JOIN subscriptions s ON s.id = owner.subscription_id
       JOIN customers c ON c.id = i.customer_id
       LEFT JOIN daily_usage_snapshots snapshot
         ON snapshot.source_invoice_id = i.id AND snapshot.subscription_id = owner.subscription_id
       WHERE i.status IN ('draft', 'finalized')
         AND NOT EXISTS (SELECT 1 FROM pay_in_advance_usage_billings advance_billing
                         WHERE advance_billing.invoice_id = i.id)
         AND EXISTS (SELECT 1 FROM invoice_lines line
                     WHERE line.invoice_id = i.id AND line.line_type = 'usage')
         AND (snapshot.id IS NULL OR snapshot.source_invoice_version < i.version)
       ORDER BY i.updated_at, i.id, owner.subscription_id LIMIT ?`,
    )
    .bind(limit)
    .all<{
      invoice_id: string;
      invoice_version: number;
      invoice_updated_at: string;
      organization_id: string;
      customer_id: string;
      subscription_id: string;
      external_id: string;
      period_start: string;
      period_end: string;
      currency: string;
      timezone: string;
    }>();
  return rows.results.map((row) => ({
    invoiceId: row.invoice_id,
    invoiceVersion: row.invoice_version,
    invoiceUpdatedAt: row.invoice_updated_at,
    organizationId: row.organization_id,
    customerId: row.customer_id,
    subscriptionId: row.subscription_id,
    externalSubscriptionId: row.external_id,
    periodStart: row.period_start,
    periodEnd: row.period_end,
    currency: row.currency,
    timezone: row.timezone,
    usageDate: localDateString(new Date(Date.parse(row.period_end) - 1), row.timezone),
  }));
}

export async function projectInvoiceDailyUsage(
  database: D1Database,
  candidate: InvoiceDailyUsageCandidate,
): Promise<boolean> {
  const [lineResult, catalogResult] = await Promise.all([
    database
      .prepare(
        `SELECT source_id, quantity_decimal, amount_minor, metadata_json
         FROM invoice_lines WHERE invoice_id = ? AND line_type = 'usage'
         ORDER BY created_at, id`,
      )
      .bind(candidate.invoiceId)
      .all<InvoiceLineRow>(),
    database
      .prepare(
        `SELECT ch.id, ch.code, ch.invoice_display_name, ch.charge_model,
                bm.id AS metric_id, bm.code AS metric_code, bm.name AS metric_name,
                bm.aggregation_type
         FROM charges ch JOIN billable_metrics bm ON bm.id = ch.billable_metric_id
         WHERE ch.organization_id = ?`,
      )
      .bind(candidate.organizationId)
      .all<ChargeCatalogRow>(),
  ]);
  const catalog = new Map(catalogResult.results.map((charge) => [charge.id, charge]));
  const byCode = new Map(catalogResult.results.map((charge) => [charge.code, charge]));
  const groups = new Map<
    string,
    {
      catalog: ChargeCatalogRow;
      units: Decimal;
      events: number;
      amount: number;
      filters: Map<string, { values: unknown; units: Decimal; events: number; amount: number }>;
    }
  >();
  for (const line of lineResult.results) {
    const metadata = parseObject(line.metadata_json);
    const metadataChargeId = optionalText(metadata.chargeId);
    const metadataChargeCode = optionalText(metadata.chargeCode);
    const charge =
      (metadataChargeId ? catalog.get(metadataChargeId) : undefined) ??
      (metadataChargeCode ? byCode.get(metadataChargeCode) : undefined) ??
      catalog.get(line.source_id);
    if (!charge) throw new Error("daily_usage_invoice_charge_not_found");
    const current = groups.get(charge.id) ?? {
      catalog: charge,
      units: Decimal.zero(),
      events: 0,
      amount: 0,
      filters: new Map(),
    };
    const trueUp = metadata.trueUp === true;
    const units = trueUp ? Decimal.zero() : Decimal.parse(line.quantity_decimal);
    const eventCount = nonNegativeInteger(metadata.eventCount);
    current.units = current.units.add(units);
    current.events += eventCount;
    current.amount = safeAdd(current.amount, line.amount_minor);
    if (metadata.chargeFilterValues !== undefined) {
      const filterKey = stableJson(metadata.chargeFilterValues);
      const filter = current.filters.get(filterKey) ?? {
        values: metadata.chargeFilterValues,
        units: Decimal.zero(),
        events: 0,
        amount: 0,
      };
      filter.units = filter.units.add(units);
      filter.events += eventCount;
      filter.amount = safeAdd(filter.amount, line.amount_minor);
      current.filters.set(filterKey, filter);
    }
    groups.set(charge.id, current);
  }
  const charges = [...groups.values()]
    .filter((group) => group.amount !== 0 || !group.units.isZero())
    .sort((left, right) => left.catalog.id.localeCompare(right.catalog.id))
    .map((group) => ({
      units: group.units.toString(),
      total_aggregated_units: group.units.toString(),
      events_count: group.events,
      amount_cents: group.amount,
      amount_currency: candidate.currency,
      charge: {
        lago_id: group.catalog.id,
        code: group.catalog.code,
        charge_model: group.catalog.charge_model,
        invoice_display_name: group.catalog.invoice_display_name,
      },
      billable_metric: {
        lago_id: group.catalog.metric_id,
        name: group.catalog.metric_name,
        code: group.catalog.metric_code,
        aggregation_type: group.catalog.aggregation_type,
      },
      filters: [...group.filters.values()].map((filter) => ({
        units: filter.units.toString(),
        total_aggregated_units: filter.units.toString(),
        events_count: filter.events,
        amount_cents: filter.amount,
        values: filter.values,
      })),
      grouped_usage: [],
      pricing_unit_details: null,
      presentation_breakdowns: [],
    }));
  if (charges.length === 0) return false;
  const amount = charges.reduce((sum, charge) => safeAdd(sum, charge.amount_cents), 0);
  const usage: UsagePayload = {
    from_datetime: candidate.periodStart,
    to_datetime: candidate.periodEnd,
    issuing_date: candidate.usageDate,
    currency: candidate.currency,
    amount_cents: amount,
    total_amount_cents: amount,
    taxes_amount_cents: 0,
    charges_usage: charges,
  };
  return writeDailyUsageSnapshot(database, {
    organizationId: candidate.organizationId,
    customerId: candidate.customerId,
    subscriptionId: candidate.subscriptionId,
    externalSubscriptionId: candidate.externalSubscriptionId,
    usageDate: candidate.usageDate,
    calculatedThrough: candidate.periodEnd,
    refreshedAt: candidate.invoiceUpdatedAt,
    usage,
    source: {
      type: "invoice",
      invoiceId: candidate.invoiceId,
      invoiceVersion: candidate.invoiceVersion,
    },
  });
}

export async function dailyUsageRollups(
  database: D1Database,
  organizationId: string,
  fromDate: string,
  toDate: string,
  billableMetricCode?: string,
): Promise<DailyUsageRollup[]> {
  const metricPredicate = billableMetricCode ? " AND line.billable_metric_code = ?" : "";
  const bindings = billableMetricCode
    ? [organizationId, fromDate, toDate, billableMetricCode]
    : [organizationId, fromDate, toDate];
  const result = await database
    .prepare(
      `SELECT snapshot.usage_date, line.billable_metric_code, line.currency,
              line.delta_units_decimal, line.delta_amount_minor
       FROM daily_usage_charge_snapshots line
       JOIN daily_usage_snapshots snapshot ON snapshot.id = line.daily_usage_snapshot_id
       WHERE snapshot.organization_id = ? AND snapshot.usage_date BETWEEN ? AND ?${metricPredicate}
       ORDER BY snapshot.usage_date, line.billable_metric_code, line.id`,
    )
    .bind(...bindings)
    .all<{
      usage_date: string;
      billable_metric_code: string;
      currency: string;
      delta_units_decimal: string;
      delta_amount_minor: number;
    }>();
  const buckets = new Map<string, DailyUsageRollup>();
  for (const row of result.results) {
    const key = `${row.usage_date}\0${row.billable_metric_code}\0${row.currency}`;
    const current = buckets.get(key) ?? {
      usageDate: row.usage_date,
      billableMetricCode: row.billable_metric_code,
      currency: row.currency,
      amountMinor: 0,
      units: "0",
    };
    current.amountMinor = safeAdd(current.amountMinor, row.delta_amount_minor);
    current.units = Decimal.parse(current.units)
      .add(Decimal.parse(row.delta_units_decimal))
      .toString();
    buckets.set(key, current);
  }
  return [...buckets.values()];
}

async function writeDailyUsageSnapshot(
  database: D1Database,
  input: {
    organizationId: string;
    customerId: string;
    subscriptionId: string;
    externalSubscriptionId: string;
    usageDate: string;
    calculatedThrough: string;
    refreshedAt: string;
    usage: UsagePayload;
    source: { type: "scheduled" } | { type: "invoice"; invoiceId: string; invoiceVersion: number };
  },
): Promise<boolean> {
  const existing = await database
    .prepare(
      `SELECT source_type, source_invoice_id, source_invoice_version
       FROM daily_usage_snapshots WHERE subscription_id = ? AND usage_date = ? LIMIT 1`,
    )
    .bind(input.subscriptionId, input.usageDate)
    .first<StoredSnapshot>();
  if (existing?.source_type === "invoice") {
    if (input.source.type === "scheduled") return false;
    if (
      existing.source_invoice_id !== input.source.invoiceId ||
      (existing.source_invoice_version ?? 0) >= input.source.invoiceVersion
    ) {
      return false;
    }
  } else if (existing && input.source.type === "scheduled") {
    return false;
  }

  const previousDate = shiftDate(input.usageDate, -1);
  const previous = await database
    .prepare(
      `SELECT usage_json FROM daily_usage_snapshots
       WHERE subscription_id = ? AND usage_date = ?
         AND from_datetime = ? AND to_datetime = ? LIMIT 1`,
    )
    .bind(input.subscriptionId, previousDate, input.usage.from_datetime, input.usage.to_datetime)
    .first<{ usage_json: string }>();
  const usageDiff = previous
    ? diffUsagePayload(input.usage, parseUsagePayload(previous.usage_json))
    : structuredClone(input.usage);
  const snapshotId = await deterministicUuid(
    "daily-usage",
    `${input.subscriptionId}:${input.usageDate}`,
  );
  const amountMinor = minorInteger(input.usage.amount_cents);
  const totalAmountMinor = minorInteger(input.usage.total_amount_cents);
  const taxAmountMinor = minorInteger(input.usage.taxes_amount_cents);
  const statements: D1PreparedStatement[] = [
    database
      .prepare("DELETE FROM daily_usage_charge_snapshots WHERE daily_usage_snapshot_id = ?")
      .bind(snapshotId),
    database
      .prepare(
        `INSERT INTO daily_usage_snapshots
         (id, organization_id, customer_id, subscription_id, external_subscription_id,
          usage_date, from_datetime, to_datetime, calculated_through, refreshed_at, currency,
          amount_minor, total_amount_minor, tax_amount_minor, usage_json, usage_diff_json,
          source_type, source_invoice_id, source_invoice_version, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(subscription_id, usage_date) DO UPDATE SET
           external_subscription_id = excluded.external_subscription_id,
           from_datetime = excluded.from_datetime, to_datetime = excluded.to_datetime,
           calculated_through = excluded.calculated_through, refreshed_at = excluded.refreshed_at,
           currency = excluded.currency, amount_minor = excluded.amount_minor,
           total_amount_minor = excluded.total_amount_minor,
           tax_amount_minor = excluded.tax_amount_minor, usage_json = excluded.usage_json,
           usage_diff_json = excluded.usage_diff_json, source_type = excluded.source_type,
           source_invoice_id = excluded.source_invoice_id,
           source_invoice_version = excluded.source_invoice_version, updated_at = excluded.updated_at`,
      )
      .bind(
        snapshotId,
        input.organizationId,
        input.customerId,
        input.subscriptionId,
        input.externalSubscriptionId,
        input.usageDate,
        input.usage.from_datetime,
        input.usage.to_datetime,
        input.calculatedThrough,
        input.refreshedAt,
        input.usage.currency,
        amountMinor,
        totalAmountMinor,
        taxAmountMinor,
        stableJson(input.usage),
        stableJson(usageDiff),
        input.source.type,
        input.source.type === "invoice" ? input.source.invoiceId : null,
        input.source.type === "invoice" ? input.source.invoiceVersion : null,
        input.refreshedAt,
        input.refreshedAt,
      ),
  ];
  const diffByCharge = new Map(usageDiff.charges_usage.map((charge) => [chargeId(charge), charge]));
  for (const charge of input.usage.charges_usage) {
    const id = chargeId(charge);
    const metric = requiredObject(charge.billable_metric, "billable_metric");
    const chargeDetail = requiredObject(charge.charge, "charge");
    const delta = diffByCharge.get(id) ?? charge;
    const lineId = await deterministicUuid("daily-usage-charge", `${snapshotId}:${id}`);
    statements.push(
      database
        .prepare(
          `INSERT INTO daily_usage_charge_snapshots
           (id, daily_usage_snapshot_id, organization_id, customer_id, subscription_id,
            charge_id, charge_code, billable_metric_id, billable_metric_code, currency,
            cumulative_units_decimal, delta_units_decimal, cumulative_events_count,
            delta_events_count, cumulative_amount_minor, delta_amount_minor,
            cumulative_usage_json, delta_usage_json, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          lineId,
          snapshotId,
          input.organizationId,
          input.customerId,
          input.subscriptionId,
          id,
          optionalText(chargeDetail.code),
          requiredText(metric.lago_id, "billable_metric.lago_id"),
          requiredText(metric.code, "billable_metric.code"),
          input.usage.currency,
          decimalField(charge, "units").toString(),
          decimalField(delta, "units").toString(),
          nonNegativeInteger(charge.events_count),
          integerField(delta.events_count),
          minorInteger(charge.amount_cents),
          minorInteger(delta.amount_cents),
          stableJson(charge),
          stableJson(delta),
          input.refreshedAt,
          input.refreshedAt,
        ),
    );
  }
  await database.batch(statements);
  return true;
}

function diffUsagePayload(current: UsagePayload, previous: UsagePayload): UsagePayload {
  const diff = structuredClone(current);
  const previousCharges = new Map(
    previous.charges_usage.map((charge) => [chargeId(charge), charge]),
  );
  for (const charge of diff.charges_usage) {
    const prior = previousCharges.get(chargeId(charge));
    if (prior) diffUsageNode(charge, prior);
  }
  const amount = diff.charges_usage.reduce(
    (sum, charge) => sum.add(decimalField(charge, "amount_cents")),
    Decimal.zero(),
  );
  const taxes = Decimal.parse(String(current.taxes_amount_cents)).subtract(
    Decimal.parse(String(previous.taxes_amount_cents)),
  );
  diff.amount_cents = jsonDecimal(amount);
  diff.taxes_amount_cents = jsonDecimal(taxes);
  diff.total_amount_cents = jsonDecimal(amount.add(taxes));
  return diff;
}

function diffUsageNode(current: Record<string, unknown>, previous: Record<string, unknown>): void {
  current.units = decimalField(current, "units")
    .subtract(decimalField(previous, "units"))
    .toString();
  if (
    current.total_aggregated_units !== undefined &&
    previous.total_aggregated_units !== undefined
  ) {
    current.total_aggregated_units = decimalField(current, "total_aggregated_units")
      .subtract(decimalField(previous, "total_aggregated_units"))
      .toString();
  }
  current.events_count = integerField(current.events_count) - integerField(previous.events_count);
  current.amount_cents = jsonDecimal(
    decimalField(current, "amount_cents").subtract(decimalField(previous, "amount_cents")),
  );
  diffNestedNodes(current, previous, "filters", (node) => stableJson(node.values));
  diffNestedNodes(current, previous, "grouped_usage", (node) => stableJson(node.grouped_by));
}

function diffNestedNodes(
  current: Record<string, unknown>,
  previous: Record<string, unknown>,
  field: string,
  key: (node: Record<string, unknown>) => string,
): void {
  const currentNodes = recordArray(current[field]);
  const previousNodes = new Map(recordArray(previous[field]).map((node) => [key(node), node]));
  for (const node of currentNodes) {
    const prior = previousNodes.get(key(node));
    if (prior) diffUsageNode(node, prior);
  }
}

function nonZeroChargeUsage(charge: Record<string, unknown>): boolean {
  return !decimalField(charge, "units").isZero() || !decimalField(charge, "amount_cents").isZero();
}

function chargeId(charge: Record<string, unknown>): string {
  return requiredText(requiredObject(charge.charge, "charge").lago_id, "charge.lago_id");
}

function parseUsagePayload(value: string): UsagePayload {
  const parsed = JSON.parse(value) as unknown;
  const object = requiredObject(parsed, "usage");
  return {
    from_datetime: requiredText(object.from_datetime, "from_datetime"),
    to_datetime: requiredText(object.to_datetime, "to_datetime"),
    issuing_date: requiredText(object.issuing_date, "issuing_date"),
    currency: requiredText(object.currency, "currency"),
    amount_cents: numericJson(object.amount_cents),
    total_amount_cents: numericJson(object.total_amount_cents),
    taxes_amount_cents: numericJson(object.taxes_amount_cents),
    charges_usage: recordArray(object.charges_usage),
  };
}

function parseObject(value: string): Record<string, unknown> {
  const parsed = JSON.parse(value) as unknown;
  return requiredObject(parsed, "json_object");
}

function requiredObject(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`invalid_${field.replaceAll(".", "_")}`);
  }
  return value as Record<string, unknown>;
}

function recordArray(value: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(value)) return [];
  return value.map((entry) => requiredObject(entry, "usage_node"));
}

function requiredText(value: unknown, field: string): string {
  if (typeof value !== "string" || !value) throw new Error(`invalid_${field.replaceAll(".", "_")}`);
  return value;
}

function optionalText(value: unknown): string | null {
  return typeof value === "string" && value ? value : null;
}

function decimalField(object: Record<string, unknown>, field: string): Decimal {
  const value = object[field];
  if (typeof value !== "string" && typeof value !== "number") throw new Error(`invalid_${field}`);
  return Decimal.parse(value);
}

function numericJson(value: unknown): number | string {
  if (typeof value !== "string" && typeof value !== "number")
    throw new Error("invalid_numeric_json");
  Decimal.parse(value);
  return value;
}

function integerField(value: unknown): number {
  if (!Number.isSafeInteger(value)) throw new Error("invalid_integer");
  return Number(value);
}

function nonNegativeInteger(value: unknown): number {
  const integer = integerField(value);
  if (integer < 0) throw new Error("invalid_non_negative_integer");
  return integer;
}

function minorInteger(value: unknown): number {
  if (typeof value !== "string" && typeof value !== "number")
    throw new Error("invalid_minor_amount");
  const rounded = Decimal.parse(value).round();
  const result = Number(rounded);
  if (!Number.isSafeInteger(result)) throw new Error("minor_amount_out_of_range");
  return result;
}

function safeAdd(left: number, right: number): number {
  const result = left + right;
  if (!Number.isSafeInteger(result)) throw new Error("integer_overflow");
  return result;
}

function jsonDecimal(value: Decimal): number | string {
  const source = value.toString();
  const numeric = Number(source);
  return Number.isFinite(numeric) && Math.abs(numeric) <= Number.MAX_SAFE_INTEGER
    ? numeric
    : source;
}

function shiftDate(value: string, days: number): string {
  const date = new Date(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(date.getTime())) throw new Error("invalid_usage_date");
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}
