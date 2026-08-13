import { deterministicUuid } from "../identifiers";
import { Decimal } from "../rating/decimal";

type TaxRow = {
  id: string;
  code: string;
  name: string;
  description: string | null;
  rate: string;
};

export type TaxableLine = { id: string; amountMinor: number };

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
  invoiceId: string,
  lines: TaxableLine[],
  couponsMinor: number,
): Promise<InvoiceTax[]> {
  const result = await database
    .prepare(
      `SELECT id, code, name, description, rate FROM taxes
       WHERE organization_id = ? AND status = 'active' AND applied_to_organization = 1
       ORDER BY created_at, id`,
    )
    .bind(organizationId)
    .all<TaxRow>();
  if (result.results.length === 0) return [];
  const taxableBases = allocateTaxableBases(lines, couponsMinor);
  return Promise.all(
    result.results.map(async (tax) => {
      const lineTaxes = await Promise.all(
        taxableBases.map(async (line) => {
          const precise = Decimal.parse(line.taxableBaseMinor)
            .multiply(Decimal.parse(tax.rate))
            .divideByInteger(100n);
          return {
            ...tax,
            id: await deterministicUuid("invoice-line-tax", `${invoiceId}:${line.id}:${tax.id}`),
            taxId: tax.id,
            lineId: line.id,
            taxableBaseMinor: line.taxableBaseMinor,
            amountMinor: safeMinor(precise),
            preciseAmountMinor: precise.toString(),
          };
        }),
      );
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
  const subtotal = lines.reduce((sum, line) => safeAdd(sum, line.amountMinor), 0);
  if (couponsMinor < 0 || couponsMinor > subtotal) throw new Error("invalid_tax_coupon_base");
  if (subtotal === 0) return lines.map((line) => ({ id: line.id, taxableBaseMinor: 0 }));
  const allocations = lines.map((line) => {
    const numerator = BigInt(couponsMinor) * BigInt(line.amountMinor);
    return {
      id: line.id,
      amountMinor: line.amountMinor,
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
    id: line.id,
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
