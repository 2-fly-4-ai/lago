import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import {
  claimPlanDeletionTask,
  ensurePlanDeletionWorkflow,
  failPlanDeletionTask,
  finalizePlanDeletionDraft,
  listPendingPlanDeletionSubscriptions,
  listPlanDeletionDraftInvoices,
  preparePlanDeletionContinuation,
  processPlanDeletionSubscription,
  retirePlanDeletion,
} from "../billing/plan-deletion";

export type PlanDeletionWorkflowParams = {
  taskId: string;
  sequence: number;
};

const MAX_BATCH_ROUNDS_PER_INSTANCE = 100;

export class PlanDeletionWorkflow extends WorkflowEntrypoint<Env, PlanDeletionWorkflowParams> {
  override async run(event: WorkflowEvent<PlanDeletionWorkflowParams>, step: WorkflowStep) {
    const { taskId, sequence } = event.payload;
    const workflowInstanceId = event.instanceId;
    try {
      const task = await step.do("claim plan deletion task", async () =>
        claimPlanDeletionTask(this.env.BILLING_DB, taskId, workflowInstanceId, sequence),
      );
      if (!task) throw new Error("plan_deletion_task_not_found");
      if (task.status === "completed") return { status: "completed", taskId };
      if (task.workflow_instance_id !== workflowInstanceId || task.workflow_sequence !== sequence) {
        return { status: "superseded", taskId };
      }
      if (task.status !== "running") throw new Error("plan_deletion_not_running");

      for (let round = 1; round <= MAX_BATCH_ROUNDS_PER_INSTANCE; round += 1) {
        const subscriptions = await step.do(`load subscription batch ${round}`, async () =>
          listPendingPlanDeletionSubscriptions(this.env.BILLING_DB, taskId),
        );
        if (subscriptions.length === 0) break;
        await step.do(
          `process subscription batch ${round}`,
          {
            retries: { limit: 8, delay: "5 seconds", backoff: "exponential" },
            timeout: "5 minutes",
          },
          async () => {
            let completed = 0;
            for (const subscription of subscriptions) {
              if (
                await processPlanDeletionSubscription(
                  this.env,
                  taskId,
                  subscription.subscription_id,
                )
              ) {
                completed += 1;
              }
            }
            return { completed, attempted: subscriptions.length };
          },
        );
      }

      const subscriptionsRemain = await step.do(
        "check subscription continuation",
        async () =>
          (await listPendingPlanDeletionSubscriptions(this.env.BILLING_DB, taskId)).length > 0,
      );
      if (subscriptionsRemain) {
        return this.handoff(step, taskId, workflowInstanceId, sequence, "subscriptions");
      }

      for (let round = 1; round <= MAX_BATCH_ROUNDS_PER_INSTANCE; round += 1) {
        const invoiceIds = await step.do(`load draft invoice batch ${round}`, async () =>
          listPlanDeletionDraftInvoices(this.env.BILLING_DB, taskId),
        );
        if (invoiceIds.length === 0) break;
        await step.do(
          `finalize draft invoice batch ${round}`,
          {
            retries: { limit: 8, delay: "5 seconds", backoff: "exponential" },
            timeout: "5 minutes",
          },
          async () => {
            let finalized = 0;
            for (const invoiceId of invoiceIds) {
              if (await finalizePlanDeletionDraft(this.env, taskId, invoiceId)) finalized += 1;
            }
            return { finalized, attempted: invoiceIds.length };
          },
        );
      }

      const draftsRemain = await step.do(
        "check draft invoice continuation",
        async () => (await listPlanDeletionDraftInvoices(this.env.BILLING_DB, taskId)).length > 0,
      );
      if (draftsRemain) {
        return this.handoff(step, taskId, workflowInstanceId, sequence, "drafts");
      }

      const retired = await step.do(
        "retire plan graph",
        { retries: { limit: 8, delay: "5 seconds", backoff: "exponential" } },
        async () => retirePlanDeletion(this.env, taskId),
      );
      return { status: "completed", taskId, retired };
    } catch (error) {
      await step.do("record plan deletion failure", async () => {
        await failPlanDeletionTask(this.env.BILLING_DB, taskId, workflowInstanceId, error);
        return { failed: true };
      });
      throw error;
    }
  }

  private async handoff(
    step: WorkflowStep,
    taskId: string,
    workflowInstanceId: string,
    sequence: number,
    phase: "subscriptions" | "drafts",
  ) {
    const continuation = await step.do("prepare plan deletion continuation", async () =>
      preparePlanDeletionContinuation(this.env.BILLING_DB, taskId, workflowInstanceId, sequence),
    );
    const dispatched = await step.do("dispatch plan deletion continuation", async () => {
      try {
        await ensurePlanDeletionWorkflow(this.env, continuation);
        return true;
      } catch {
        // Reconciliation owns the durable dispatch retry after this instance hands off.
        return false;
      }
    });
    return {
      status: "continued",
      taskId,
      phase,
      sequence: continuation.workflow_sequence,
      dispatched,
    };
  }
}
