import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import { browserPdfRenderer, generateInvoicePdf } from "../documents/invoice";

export type DocumentWorkflowParams = {
  invoiceId: string;
  organizationId: string;
  correlationId: string;
};

export class DocumentWorkflow extends WorkflowEntrypoint<Env, DocumentWorkflowParams> {
  override async run(event: WorkflowEvent<DocumentWorkflowParams>, step: WorkflowStep) {
    const { invoiceId, organizationId, correlationId } = event.payload;
    if (!invoiceId || !organizationId || !correlationId)
      throw new Error("invalid_document_payload");
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
