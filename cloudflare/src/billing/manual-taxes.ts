import { deterministicUuid } from "../identifiers";
import { Decimal } from "../rating/decimal";
import {
  resolveActiveTaxes,
  taxesForTarget,
  type ResolvedTax,
  type TaxTargetType,
} from "./tax-targets";

type TaxRow = {
  id: string;
  code: string;
  name: string;
  description: string | null;
  rate: string;
};

export type TaxableLine = {
  id: string;
  amountMinor: number;
  sourceType?: "plan" | "charge" | "fixed_charge" | "commitment" | "add_on";
  sourceId?: string;
  taxCodes?: string[];
  couponDiscountMinor?: number;
};

export type LineTax = TaxRow & {
  id: string;
  taxId: string;
  lineId: string;
  taxableBaseMinor: number;
  amountMinor: number;
  preciseAmountMinor: string;
};

export type InvoiceTax = TaxRow & {
  id: string;
  taxId: string;
  taxableBaseMinor: number;
  amountMinor: number;
  preciseAmountMinor: string;
  lineTaxes: LineTax[];
};

export async function calculateManualTaxes(
  database: D1Database,
  organizationId: string,
  customerId: string,
  invoiceId: string,
  lines: TaxableLine[],
  couponsMinor: number,
): Promise<InvoiceTax[]> {
  const taxableBases = allocateTaxableBases(lines, couponsMinor);
  const grouped = new Map<string, { tax: ResolvedTax; lineTaxes: LineTax[] }>();
  for (const line of taxableBases) {
    const taxes = await applicableTaxes(database, organizationId, customerId, line);
    for (const tax of taxes) {
      const precise = Decimal.parse(line.taxableBaseMinor)
        .multiply(Decimal.parse(tax.rate))
        .divideByInteger(100n);
      const lineTax: LineTax = {
        ...tax,
        id: await deterministicUuid("invoice-line-tax", `${invoiceId}:${line.id}:${tax.id}`),
        taxId: tax.id,
        lineId: line.id,
        taxableBaseMinor: line.taxableBaseMinor,
        amountMinor: safeMinor(precise),
        preciseAmountMinor: precise.toString(),
      };
      const current = grouped.get(tax.id);
      if (current) current.lineTaxes.push(lineTax);
      else grouped.set(tax.id, { tax, lineTaxes: [lineTax] });
    }
  }
  return Promise.all(
    [...grouped.values()].map(async ({ tax, lineTaxes }) => {
      const precise = lineTaxes.reduce(
        (sum, line) => sum.add(Decimal.parse(line.preciseAmountMinor)),
        Decimal.zero(),
      );
      return {
        ...tax,
        id: await deterministicUuid("invoice-tax", `${invoiceId}:${tax.id}`),
        taxId: tax.id,
        taxableBaseMinor: lineTaxes.reduce((sum, line) => safeAdd(sum, line.taxableBaseMinor), 0),
        amountMinor: lineTaxes.reduce((sum, line) => safeAdd(sum, line.amountMinor), 0),
        preciseAmountMinor: precise.toString(),
        lineTaxes,
      };
    }),
  );
}

async function applicableTaxes(
  database: D1Database,
  organizationId: string,
  customerId: string,
  line: TaxableLine & { taxableBaseMinor: number },
): Promise<ResolvedTax[]> {
  if (line.taxCodes !== undefined) {
    return resolveActiveTaxes(database, organizationId, line.taxCodes);
  }
  if (line.sourceType && line.sourceId) {
    const direct = await taxesForTarget(
      database,
      organizationId,
      line.sourceType as TaxTargetType,
      line.sourceId,
    );
    if (direct.length > 0) return direct;
    const planId = await sourcePlanId(database, organizationId, line.sourceType, line.sourceId);
    if (planId && line.sourceType !== "plan") {
      const planTaxes = await taxesForTarget(database, organizationId, "plan", planId);
      if (planTaxes.length > 0) return planTaxes;
    }
  }
  const customerTaxes = await taxesForTarget(database, organizationId, "customer", customerId);
  if (customerTaxes.length > 0) return customerTaxes;
  const billingEntityTaxes = await taxesForTarget(
    database,
    organizationId,
    "billing_entity",
    organizationId,
  );
  if (billingEntityTaxes.length > 0) return billingEntityTaxes;
  const defaults = await database
    .prepare(
      `SELECT id, code, name, description, rate FROM taxes
       WHERE organization_id = ? AND status = 'active' AND applied_to_organization = 1
       ORDER BY created_at, id`,
    )
    .bind(organizationId)
    .all<TaxRow>();
  return defaults.results;
}

async function sourcePlanId(
  database: D1Database,
  organizationId: string,
  sourceType: NonNullable<TaxableLine["sourceType"]>,
  sourceId: string,
): Promise<string | null> {
  if (sourceType === "plan") return sourceId;
  const table =
    sourceType === "charge"
      ? "charges"
      : sourceType === "fixed_charge"
        ? "fixed_charges"
        : sourceType === "commitment"
          ? "minimum_commitments"
          : null;
  if (!table) return null;
  const row = await database
    .prepare(`SELECT plan_id FROM ${table} WHERE id = ? AND organization_id = ? LIMIT 1`)
    .bind(sourceId, organizationId)
    .first<{ plan_id: string }>();
  return row?.plan_id ?? null;
}

export function manualTaxStatements(
  database: D1Database,
  organizationId: string,
  invoiceId: string,
  currency: string,
  taxes: InvoiceTax[],
  now: string,
): D1PreparedStatement[] {
  return taxes.flatMap((tax) => [
    ...tax.lineTaxes.map((line) =>
      database
        .prepare(
          `INSERT INTO invoice_line_taxes
           (id, organization_id, invoice_id, invoice_line_id, tax_id, tax_code, tax_name,
            tax_description, tax_rate, taxable_base_minor, amount_minor, precise_amount_minor,
            currency, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          line.id,
          organizationId,
          invoiceId,
          line.lineId,
          tax.taxId,
          tax.code,
          tax.name,
          tax.description,
          tax.rate,
          line.taxableBaseMinor,
          line.amountMinor,
          line.preciseAmountMinor,
          currency,
          now,
        ),
    ),
    database
      .prepare(
        `INSERT INTO invoice_taxes
         (id, organization_id, invoice_id, tax_id, tax_code, tax_name, tax_description,
          tax_rate, taxable_base_minor, amount_minor, precise_amount_minor, currency, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        tax.id,
        organizationId,
        invoiceId,
        tax.taxId,
        tax.code,
        tax.name,
        tax.description,
        tax.rate,
        tax.taxableBaseMinor,
        tax.amountMinor,
        tax.preciseAmountMinor,
        currency,
        now,
      ),
  ]);
}

export function totalManualTaxMinor(taxes: InvoiceTax[]): number {
  const preciseByLine = new Map<string, Decimal>();
  for (const tax of taxes) {
    for (const line of tax.lineTaxes) {
      preciseByLine.set(
        line.lineId,
        (preciseByLine.get(line.lineId) ?? Decimal.zero()).add(
          Decimal.parse(line.preciseAmountMinor),
        ),
      );
    }
  }
  return [...preciseByLine.values()].reduce((sum, precise) => safeAdd(sum, safeMinor(precise)), 0);
}

function allocateTaxableBases(lines: TaxableLine[], couponsMinor: number) {
  const discountedLines = lines.map((line) => {
    const couponDiscountMinor = line.couponDiscountMinor ?? 0;
    if (
      !Number.isSafeInteger(couponDiscountMinor) ||
      couponDiscountMinor < 0 ||
      couponDiscountMinor > line.amountMinor
    ) {
      throw new Error("invalid_line_coupon_discount");
    }
    return { ...line, amountMinor: line.amountMinor - couponDiscountMinor };
  });
  const subtotal = discountedLines.reduce((sum, line) => safeAdd(sum, line.amountMinor), 0);
  if (couponsMinor < 0 || couponsMinor > subtotal) throw new Error("invalid_tax_coupon_base");
  if (subtotal === 0) return discountedLines.map((line) => ({ ...line, taxableBaseMinor: 0 }));
  const allocations = discountedLines.map((line) => {
    const numerator = BigInt(couponsMinor) * BigInt(line.amountMinor);
    return {
      ...line,
      discountMinor: Number(numerator / BigInt(subtotal)),
      remainder: numerator % BigInt(subtotal),
    };
  });
  let remainder = couponsMinor - allocations.reduce((sum, line) => sum + line.discountMinor, 0);
  for (const line of [...allocations].sort((left, right) => {
    if (left.remainder !== right.remainder) return left.remainder > right.remainder ? -1 : 1;
    return left.id.localeCompare(right.id);
  })) {
    if (remainder === 0) break;
    line.discountMinor += 1;
    remainder -= 1;
  }
  return allocations.map((line) => ({
    ...line,
    taxableBaseMinor: line.amountMinor - line.discountMinor,
  }));
}

function safeMinor(value: Decimal) {
  const amount = Number(value.round());
  if (!Number.isSafeInteger(amount) || amount < 0) throw new Error("invalid_tax_amount");
  return amount;
}

function safeAdd(left: number, right: number) {
  const total = left + right;
  if (!Number.isSafeInteger(total) || total < 0) throw new Error("invalid_tax_amount");
  return total;
}
