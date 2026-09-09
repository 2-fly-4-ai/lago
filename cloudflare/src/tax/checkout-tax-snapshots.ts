import { ApiError } from "../http";
import { deterministicUuid } from "../identifiers";

// Snapshot the collected local quote, not a tax rate looked up during a refund.
// These records are replaced only while repricing an unpaid invoice, in the same
// guarded transaction as its aggregate amount and checkout version.
export async function checkoutTaxSnapshotStatements(
  db: D1Database,
  input: {
    organizationId: string;
    invoiceId: string;
    quoteId: string;
    ruleId: string;
    country: string;
    collectionMode: "collect" | "off";
    rateResolution: { stateRatePpm: number; localRatePpm: number } | null;
    subtotalMinor: number;
    taxMinor: number;
    currency: string;
    now: string;
  },
): Promise<D1PreparedStatement[]> {
  const invalid = () =>
    new ApiError(
      409,
      "checkout_tax_fee_allocation_unavailable",
      "Invoice tax allocation requires review",
    );
  if (
    !Number.isSafeInteger(input.subtotalMinor) ||
    input.subtotalMinor < 0 ||
    !Number.isSafeInteger(input.taxMinor) ||
    input.taxMinor < 0 ||
    (input.subtotalMinor === 0 && input.taxMinor !== 0)
  )
    throw invalid();
  const lines = await db
    .prepare(`SELECT line.id,line.amount_minor,
    COALESCE((SELECT SUM(credit.amount_minor) FROM coupon_credit_lines credit WHERE credit.invoice_line_id=line.id),0) AS coupons
    FROM invoice_lines line JOIN invoices invoice ON invoice.id=line.invoice_id
    WHERE invoice.id=? AND invoice.organization_id=? ORDER BY line.id`)
    .bind(input.invoiceId, input.organizationId)
    .all<{ id: string; amount_minor: number; coupons: number }>();
  const bases = lines.results.map((line) => ({ ...line, base: line.amount_minor - line.coupons }));
  if (
    !bases.length ||
    bases.some((line) => !Number.isSafeInteger(line.base) || line.base < 0) ||
    bases.reduce((total, line) => total + line.base, 0) !== input.subtotalMinor
  )
    throw invalid();
  const notes = await db
    .prepare("SELECT id FROM credit_notes WHERE invoice_id=? LIMIT 1")
    .bind(input.invoiceId)
    .first();
  if (notes) throw invalid();
  const rule = await db
    .prepare("SELECT rate_ppm,taxability FROM indirect_tax_rules WHERE id=?")
    .bind(input.ruleId)
    .first<{ rate_ppm: number; taxability: string }>();
  if (!rule) throw invalid();
  let components = [
    {
      code: "TAX",
      rate_ppm: input.rateResolution
        ? input.rateResolution.stateRatePpm + input.rateResolution.localRatePpm
        : rule.rate_ppm,
    },
  ];
  if (input.country === "CA" && rule.taxability === "taxable") {
    components = (
      await db
        .prepare(
          "SELECT code,rate_ppm FROM indirect_tax_rule_components WHERE rule_id=? ORDER BY code",
        )
        .bind(input.ruleId)
        .all<{ code: string; rate_ppm: number }>()
    ).results;
    if (!components.length || components.reduce((sum, c) => sum + c.rate_ppm, 0) !== rule.rate_ppm)
      throw invalid();
  }
  const rounded = (value: number, numerator: number, denominator: number) =>
    denominator === 0 && value === 0 && numerator === 0
      ? 0
      : Number(
          (BigInt(value) * BigInt(numerator) + BigInt(denominator) / 2n) / BigInt(denominator),
        );
  const snapshots = components.map((component) => ({
    ...component,
    amount:
      input.collectionMode === "off" || rule.taxability === "exempt"
        ? 0
        : rounded(input.subtotalMinor, component.rate_ppm, 1_000_000),
  }));
  if (snapshots.reduce((sum, c) => sum + c.amount, 0) !== input.taxMinor) throw invalid();
  const statements = [
    db
      .prepare("DELETE FROM invoice_line_taxes WHERE invoice_id=? AND organization_id=?")
      .bind(input.invoiceId, input.organizationId),
    db
      .prepare("DELETE FROM invoice_taxes WHERE invoice_id=? AND organization_id=?")
      .bind(input.invoiceId, input.organizationId),
  ];
  for (const component of snapshots) {
    const code = `epd-local:${input.quoteId}:${component.code}`;
    const taxId = await deterministicUuid("checkout-local-tax", code);
    const name = component.code === "TAX" ? "Sales tax" : component.code;
    const rate = String(component.rate_ppm / 10_000);
    const description = `Local checkout tax quote ${input.quoteId}`;
    statements.push(
      db
        .prepare(`INSERT INTO taxes(id,organization_id,code,name,description,rate,applied_to_organization,status,request_sha256,created_at,updated_at)
      VALUES(?,CASE WHEN NOT EXISTS (SELECT 1 FROM credit_notes WHERE invoice_id=?)
        AND (SELECT COUNT(*) FROM invoice_lines WHERE invoice_id=?)=? THEN ? ELSE NULL END,
        ?,?,?,?,0,'terminated',?,?,?) ON CONFLICT(id) DO NOTHING`)
        .bind(
          taxId,
          input.invoiceId,
          input.invoiceId,
          bases.length,
          input.organizationId,
          code,
          name,
          description,
          rate,
          input.quoteId,
          input.now,
          input.now,
        ),
    );
    let cumulativeBase = 0;
    for (const line of bases) {
      const previous = rounded(component.amount, cumulativeBase, input.subtotalMinor);
      cumulativeBase += line.base;
      const amount = rounded(component.amount, cumulativeBase, input.subtotalMinor) - previous;
      statements.push(
        db
          .prepare(`INSERT INTO invoice_line_taxes(id,organization_id,invoice_id,invoice_line_id,tax_id,tax_code,tax_name,tax_description,tax_rate,taxable_base_minor,amount_minor,precise_amount_minor,currency,created_at)
        VALUES(?,?,?,?,?,?,?,?,?,CASE WHEN
          (SELECT amount_minor-COALESCE((SELECT SUM(amount_minor) FROM coupon_credit_lines WHERE invoice_line_id=?),0)
           FROM invoice_lines WHERE id=? AND invoice_id=?)=? THEN ? ELSE NULL END,?,?,?,?)`)
          .bind(
            await deterministicUuid("checkout-local-line-tax", `${taxId}:${line.id}`),
            input.organizationId,
            input.invoiceId,
            line.id,
            taxId,
            code,
            name,
            description,
            rate,
            line.id,
            line.id,
            input.invoiceId,
            line.base,
            line.base,
            amount,
            String(amount),
            input.currency,
            input.now,
          ),
      );
    }
    statements.push(
      db
        .prepare(`INSERT INTO invoice_taxes(id,organization_id,invoice_id,tax_id,tax_code,tax_name,tax_description,tax_rate,taxable_base_minor,amount_minor,precise_amount_minor,currency,created_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`)
        .bind(
          await deterministicUuid("checkout-local-invoice-tax", `${taxId}:${input.invoiceId}`),
          input.organizationId,
          input.invoiceId,
          taxId,
          code,
          name,
          description,
          rate,
          input.subtotalMinor,
          component.amount,
          String(component.amount),
          input.currency,
          input.now,
        ),
    );
  }
  return statements;
}
