import { renderCreditNoteHtml } from "../../src/documents/credit-note";
import { renderInvoiceHtml } from "../../src/documents/invoice";
import { renderPaymentReceiptHtml } from "../../src/documents/payment-receipt";

export type DocumentGoldenCase = {
  name: "invoice" | "payment-receipt" | "credit-note";
  html: string;
  expectedText: string[];
  minimumPages: number;
  rowCount: number;
};

const invoiceLines = Array.from({ length: 18 }, (_, index) => ({
  description: `Metered API usage - region ${String(index + 1).padStart(2, "0")}`,
  quantity_decimal: String(index + 1),
  unit_amount_decimal: "100",
  amount_minor: (index + 1) * 100,
}));

export const documentGoldenCases: DocumentGoldenCase[] = [
  {
    name: "invoice",
    html: renderInvoiceHtml(
      {
        id: "invoice-golden",
        organization_id: "organization-golden",
        number: "INV-2026-0042",
        status: "finalized",
        currency: "USD",
        subtotal_minor: 17_100,
        tax_minor: 1_710,
        credits_minor: 2_500,
        total_due_minor: 16_310,
        version: 3,
        finalized_at: "2026-08-15T12:00:00.000Z",
        issuing_date: "2026-08-15",
        customer_external_id: "customer-golden",
        customer_name: "Synthetic Customer & Partners",
        customer_email: "billing@example.test",
      },
      invoiceLines,
      [
        {
          name: "purchase-order",
          display_name: "Purchase order",
          details: "PO-2026-0007\nSynthetic billing contact: Finance Operations",
        },
        {
          name: "service-period",
          display_name: "Service notes",
          details:
            "Usage covers the synthetic August service window. This fixture intentionally includes enough rows and notes to verify page flow, repeated table structure, totals alignment, and footer legibility.",
        },
      ],
    ),
    expectedText: [
      "Invoice",
      "INV-2026-0042",
      "Synthetic Customer & Partners",
      "Metered API usage - region 18",
      "Total due",
      "$163.10",
      "Purchase order",
      "Generated from immutable invoice version 3",
    ],
    minimumPages: 2,
    rowCount: 18,
  },
  {
    name: "payment-receipt",
    html: renderPaymentReceiptHtml(
      {
        id: "receipt-golden",
        organization_id: "organization-golden",
        number: "RCPT-2026-0017",
        version: 2,
        payment_id: "payment-golden-0017",
        payable_type: "PaymentRequest",
        invoice_ids_json: '["invoice-golden-a","invoice-golden-b"]',
        invoice_numbers_json: '["INV-2026-0042","INV-2026-0043"]',
        provider: "authorize_net",
        provider_account_code: "synthetic-sandbox",
        provider_transaction_id: "txn-synthetic-0017",
        payment_type: "provider",
        reference: null,
        amount_minor: 24_680,
        currency: "USD",
        payment_created_at: "2026-08-15T12:30:00.000Z",
        organization_name: "Synthetic SERP Billing",
        organization_legal_name: "Synthetic SERP Billing LLC",
        organization_legal_number: "SYN-000042",
        organization_address_line1: "100 Workers Avenue",
        organization_address_line2: "Suite 2026",
        organization_city: "Edge City",
        organization_state: "CA",
        organization_zipcode: "94107",
        organization_country: "US",
        organization_email: "receipts@example.test",
        organization_tax_id: "TAX-SYNTHETIC-42",
        invoice_footer: "Thank you for your synthetic payment.",
        customer_external_id: "customer-golden",
        customer_name: "Synthetic Customer & Partners",
        customer_email: "billing@example.test",
      },
      [
        {
          id: "invoice-golden-a",
          number: "INV-2026-0042",
          total_due_minor: 16_310,
          currency: "USD",
        },
        {
          id: "invoice-golden-b",
          number: "INV-2026-0043",
          total_due_minor: 8_370,
          currency: "USD",
        },
      ],
    ),
    expectedText: [
      "Payment receipt",
      "RCPT-2026-0017",
      "Synthetic SERP Billing LLC",
      "Authorize Net · txn-synthetic-0017",
      "$246.80",
      "Paid invoices",
      "INV-2026-0043",
      "Generated from immutable payment receipt version 2",
    ],
    minimumPages: 1,
    rowCount: 2,
  },
  {
    name: "credit-note",
    html: renderCreditNoteHtml(
      {
        id: "credit-note-golden",
        organization_id: "organization-golden",
        invoice_id: "invoice-golden",
        invoice_number: "INV-2026-0042",
        number: "CN-2026-0009",
        status: "finalized",
        credit_status: "available",
        reason: "order_change",
        description:
          "Synthetic adjustment for a changed service quantity. The credit remains available on the customer balance.",
        currency: "USD",
        total_amount_minor: 5_250,
        credit_amount_minor: 5_250,
        balance_amount_minor: 5_250,
        refund_amount_minor: 0,
        offset_amount_minor: 0,
        taxes_amount_minor: 250,
        coupons_adjustment_minor: 0,
        version: 1,
        issuing_date: "2026-08-15",
        organization_name: "Synthetic SERP Billing",
        organization_legal_name: "Synthetic SERP Billing LLC",
        organization_legal_number: "SYN-000042",
        organization_address_line1: "100 Workers Avenue",
        organization_address_line2: "Suite 2026",
        organization_city: "Edge City",
        organization_state: "CA",
        organization_zipcode: "94107",
        organization_country: "US",
        organization_email: "credits@example.test",
        organization_tax_id: "TAX-SYNTHETIC-42",
        invoice_footer: "Synthetic credits are applied to future invoices.",
        customer_external_id: "customer-golden",
        customer_name: "Synthetic Customer & Partners",
        customer_email: "billing@example.test",
      },
      [
        { description: "Unused platform capacity", amount_minor: 3_000 },
        { description: "API usage correction", amount_minor: 1_500 },
        { description: "Support adjustment", amount_minor: 500 },
      ],
    ),
    expectedText: [
      "Credit note",
      "CN-2026-0009",
      "Synthetic Customer & Partners",
      "Unused platform capacity",
      "Customer balance credit",
      "$52.50",
      "Generated from immutable credit note version 1",
      "XML e-invoicing is not enabled",
    ],
    minimumPages: 1,
    rowCount: 3,
  },
];
