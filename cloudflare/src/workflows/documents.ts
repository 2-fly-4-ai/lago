import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import { browserPdfRenderer, generateInvoicePdf } from "../documents/invoice";
import { generatePaymentReceiptPdf } from "../documents/payment-receipt";
import { generateCreditNotePdf } from "../documents/credit-note";

export type DocumentWorkflowParams =
  | {
      kind?: "invoice";
      invoiceId: string;
      organizationId: string;
      correlationId: string;
    }
  | {
      kind: "payment_receipt";
      paymentReceiptId: string;
      organizationId: string;
      correlationId: string;
    }
  | {
      kind: "credit_note";
      creditNoteId: string;
      organizationId: string;
      correlationId: string;
    };

export class DocumentWorkflow extends WorkflowEntrypoint<Env, DocumentWorkflowParams> {
  override async run(event: WorkflowEvent<DocumentWorkflowParams>, step: WorkflowStep) {
    const { organizationId, correlationId } = event.payload;
    if (!organizationId || !correlationId) throw new Error("invalid_document_payload");
    if (event.payload.kind === "credit_note") {
      const { creditNoteId } = event.payload;
      if (!creditNoteId) throw new Error("invalid_document_payload");
      const owned = await step.do("verify credit note ownership", async () => {
        const note = await this.env.BILLING_DB.prepare(
          `SELECT id FROM credit_notes
           WHERE id = ? AND organization_id = ? AND allocation_state = 'finalized' LIMIT 1`,
        )
          .bind(creditNoteId, organizationId)
          .first();
        return !!note;
      });
      if (!owned) throw new Error("credit_note_not_found");
      return step.do(
        "render and archive credit note pdf",
        {
          retries: { limit: 5, delay: "10 seconds", backoff: "exponential" },
          timeout: "2 minutes",
        },
        async () =>
          generateCreditNotePdf(this.env, creditNoteId, browserPdfRenderer(this.env.BROWSER)),
      );
    }
    if (event.payload.kind === "payment_receipt") {
      const { paymentReceiptId } = event.payload;
      if (!paymentReceiptId) throw new Error("invalid_document_payload");
      const owned = await step.do("verify payment receipt ownership", async () => {
        const receipt = await this.env.BILLING_DB.prepare(
          "SELECT id FROM payment_receipts WHERE id = ? AND organization_id = ? LIMIT 1",
        )
          .bind(paymentReceiptId, organizationId)
          .first();
        return !!receipt;
      });
      if (!owned) throw new Error("payment_receipt_not_found");
      return step.do(
        "render and archive payment receipt pdf",
        {
          retries: { limit: 5, delay: "10 seconds", backoff: "exponential" },
          timeout: "2 minutes",
        },
        async () =>
          generatePaymentReceiptPdf(
            this.env,
            paymentReceiptId,
            browserPdfRenderer(this.env.BROWSER),
          ),
      );
    }

    const { invoiceId } = event.payload;
    if (!invoiceId) throw new Error("invalid_document_payload");
    const owned = await step.do("verify invoice ownership", async () => {
      const invoice = await this.env.BILLING_DB.prepare(
        "SELECT id FROM invoices WHERE id = ? AND organization_id = ? LIMIT 1",
      )
        .bind(invoiceId, organizationId)
        .first();
      return !!invoice;
    });
    if (!owned) throw new Error("invoice_not_found");
    return step.do(
      "render and archive invoice pdf",
      { retries: { limit: 5, delay: "10 seconds", backoff: "exponential" }, timeout: "2 minutes" },
      async () => generateInvoicePdf(this.env, invoiceId, browserPdfRenderer(this.env.BROWSER)),
    );
  }
}
