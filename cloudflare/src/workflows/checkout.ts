import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";

export type CheckoutWorkflowParams = {
  organizationId: string;
  externalCustomerId: string;
  idempotencyKey: string;
  correlationId: string;
};

export class CheckoutWorkflow extends WorkflowEntrypoint<Env, CheckoutWorkflowParams> {
  override async run(event: WorkflowEvent<CheckoutWorkflowParams>, step: WorkflowStep) {
    return step.do("validate checkout command", async () => {
      const payload = event.payload;
      if (
        !payload.organizationId ||
        !payload.externalCustomerId ||
        !payload.idempotencyKey ||
        !payload.correlationId
      ) {
        throw new Error("Invalid checkout workflow payload");
      }

      return {
        accepted: true,
        organizationId: payload.organizationId,
        externalCustomerId: payload.externalCustomerId,
        idempotencyKey: payload.idempotencyKey,
        correlationId: payload.correlationId,
      };
    });
  }
}
