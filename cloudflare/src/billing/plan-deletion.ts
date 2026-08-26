import type { DomainEvent } from "../domain-events";
import { deterministicUuid } from "../identifiers";
import { stableJson } from "../json";
import { cancelPendingSubscriptionGeneration } from "./cancel-pending-subscription";
import { finalizeInvoice } from "./finalize-invoice";
import { terminatePayInAdvanceWithCredit } from "./pay-in-advance-termination-credit";
import {
  terminateSubscriptionWithInvoice,
  terminateSubscriptionWithoutInvoice,
  type TerminationActions,
} from "./terminate-subscription";

export type DeletablePlan = {
  id: string;
  organizationId: string;
  code: string;
  version: number;
  pendingDeletion: boolean;
};

export type PlanDeletionTask = {
  id: string;
  organization_id: string;
  plan_id: string;
  source_plan_version: number;
  correlation_id: string;
  effective_at: string;
  status: "pending" | "running" | "retiring" | "completed" | "failed";
  workflow_sequence: number;
  workflow_instance_id: string;
  error_code: string | null;
};

type SubscriptionTask = {
  subscription_id: string;
  action: "cancel" | "terminate";
};

type SubscriptionWork = {
  task_status: string;
  effective_at: string;
  correlation_id: string;
  plan_id: string;
  subscription_id: string;
  subscription_task_status: string;
  organization_id: string;
  subscription_plan_id: string;
  subscription_status: string;
  version: number;
  plan_pay_in_advance: number;
  on_termination_credit_note: "credit" | "skip" | "refund" | "offset" | null;
  on_termination_invoice: "generate" | "skip" | null;
};

const SUBSCRIPTION_BATCH_SIZE = 20;
const DRAFT_BATCH_SIZE = 10;

export function planDeletionWorkflowInstanceId(taskId: string, sequence: number): string {
  return `${taskId}-${sequence}`;
}

export async function preparePlanDeletion(
  env: Pick<Env, "BILLING_DB">,
  plan: DeletablePlan,
  correlationId: string,
  effectiveAt: string,
): Promise<PlanDeletionTask> {
  const existing = await findPlanDeletionTask(env.BILLING_DB, plan.id);
  if (existing) return existing;
  if (plan.pendingDeletion) throw new Error("plan_deletion_task_missing");

  const taskId = await deterministicUuid(
    "plan-deletion",
    `${plan.organizationId}:${plan.id}:v${plan.version + 1}`,
  );
  const workflowInstanceId = planDeletionWorkflowInstanceId(taskId, 1);
  const results = await env.BILLING_DB.batch([
    env.BILLING_DB.prepare(
      `UPDATE plans SET pending_deletion = 1, updated_at = ?
       WHERE id = ? AND organization_id = ? AND active = 1
         AND pending_deletion = 0 AND version = ?`,
    ).bind(effectiveAt, plan.id, plan.organizationId, plan.version),
    env.BILLING_DB.prepare(
      `INSERT INTO plan_deletion_tasks
       (id, organization_id, plan_id, source_plan_version, correlation_id, effective_at,
        status, workflow_sequence, workflow_instance_id, error_code, last_dispatched_at,
        created_at, updated_at, completed_at)
       SELECT ?, ?, ?, ?, ?, ?, 'pending', 1, ?, NULL, NULL, ?, ?, NULL
       FROM plans
       WHERE id = ? AND organization_id = ? AND active = 1
         AND pending_deletion = 1 AND version = ?
         AND NOT EXISTS (SELECT 1 FROM plan_deletion_tasks WHERE plan_id = ?)`,
    ).bind(
      taskId,
      plan.organizationId,
      plan.id,
      plan.version,
      correlationId,
      effectiveAt,
      workflowInstanceId,
      effectiveAt,
      effectiveAt,
      plan.id,
      plan.organizationId,
      plan.version,
      plan.id,
    ),
    env.BILLING_DB.prepare(
      `INSERT INTO plan_deletion_subscription_tasks
       (plan_deletion_task_id, subscription_id, action, source_status, status,
        attempt_count, last_error_code, created_at, updated_at, completed_at)
       SELECT ?, s.id, CASE WHEN s.status = 'pending' THEN 'cancel' ELSE 'terminate' END,
              s.status, 'pending', 0, NULL, ?, ?, NULL
       FROM subscriptions s JOIN plan_deletion_tasks task ON task.id = ?
       WHERE s.organization_id = task.organization_id AND s.plan_id = task.plan_id
         AND s.status IN ('pending', 'active', 'past_due')`,
    ).bind(taskId, effectiveAt, effectiveAt, taskId),
  ]);
  if (results[0]?.meta.changes === 1 && results[1]?.meta.changes === 1) {
    const created = await findPlanDeletionTaskById(env.BILLING_DB, taskId);
    if (created) return created;
  }
  const concurrent = await findPlanDeletionTask(env.BILLING_DB, plan.id);
  if (concurrent) return concurrent;
  throw new Error("plan_version_conflict");
}

export async function ensurePlanDeletionWorkflow(
  env: Pick<Env, "BILLING_DB" | "PLAN_DELETION_WORKFLOW">,
  task: PlanDeletionTask,
  retryFailed = false,
): Promise<PlanDeletionTask> {
  let current = task;
  if (retryFailed && current.status === "failed") {
    const sequence = current.workflow_sequence + 1;
    const instanceId = planDeletionWorkflowInstanceId(current.id, sequence);
    await env.BILLING_DB.prepare(
      `UPDATE plan_deletion_tasks
       SET status = 'pending', workflow_sequence = ?, workflow_instance_id = ?,
           error_code = NULL, updated_at = ?
       WHERE id = ? AND status = 'failed' AND workflow_sequence = ?`,
    )
      .bind(sequence, instanceId, new Date().toISOString(), current.id, current.workflow_sequence)
      .run();
    const reloaded = await findPlanDeletionTaskById(env.BILLING_DB, current.id);
    if (!reloaded) throw new Error("plan_deletion_task_not_found");
    current = reloaded;
  }
  if (current.status === "completed" || current.status === "retiring") return current;
  const dispatchedAt = new Date().toISOString();
  await env.BILLING_DB.prepare(
    `UPDATE plan_deletion_tasks SET last_dispatched_at = ?, updated_at = ?
     WHERE id = ? AND workflow_instance_id = ? AND status IN ('pending', 'running')`,
  )
    .bind(dispatchedAt, dispatchedAt, current.id, current.workflow_instance_id)
    .run();
  await createWorkflowInstance(env.PLAN_DELETION_WORKFLOW, current);
  return current;
}

export async function dispatchPendingPlanDeletions(env: Env): Promise<number> {
  const tasks = await env.BILLING_DB.prepare(
    `SELECT id, organization_id, plan_id, source_plan_version, correlation_id, effective_at,
            status, workflow_sequence, workflow_instance_id, error_code
     FROM plan_deletion_tasks
     WHERE status IN ('pending', 'running')
     ORDER BY COALESCE(last_dispatched_at, created_at), id LIMIT 25`,
  ).all<PlanDeletionTask>();
  let dispatched = 0;
  for (const task of tasks.results) {
    try {
      await ensurePlanDeletionWorkflow(env, task);
      dispatched += 1;
    } catch {
      // The next five-minute reconciliation run retries this durable dispatch intent.
    }
  }
  return dispatched;
}

export async function claimPlanDeletionTask(
  database: D1Database,
  taskId: string,
  workflowInstanceId: string,
  sequence: number,
): Promise<PlanDeletionTask | null> {
  const now = new Date().toISOString();
  await database
    .prepare(
      `UPDATE plan_deletion_tasks SET status = 'running', error_code = NULL, updated_at = ?
       WHERE id = ? AND workflow_instance_id = ? AND workflow_sequence = ?
         AND status = 'pending'`,
    )
    .bind(now, taskId, workflowInstanceId, sequence)
    .run();
  return findPlanDeletionTaskById(database, taskId);
}

export async function listPendingPlanDeletionSubscriptions(
  database: D1Database,
  taskId: string,
): Promise<SubscriptionTask[]> {
  const result = await database
    .prepare(
      `SELECT subscription_id, action FROM plan_deletion_subscription_tasks
       WHERE plan_deletion_task_id = ? AND status = 'pending'
       ORDER BY created_at, subscription_id LIMIT ?`,
    )
    .bind(taskId, SUBSCRIPTION_BATCH_SIZE)
    .all<SubscriptionTask>();
  return [...result.results];
}

export async function processPlanDeletionSubscription(
  env: Env,
  taskId: string,
  subscriptionId: string,
): Promise<boolean> {
  const work = await env.BILLING_DB.prepare(
    `SELECT task.status AS task_status, task.effective_at, task.correlation_id, task.plan_id,
            item.subscription_id, item.status AS subscription_task_status,
            s.organization_id, s.plan_id AS subscription_plan_id,
            s.status AS subscription_status, s.version,
            p.pay_in_advance AS plan_pay_in_advance,
            s.on_termination_credit_note, s.on_termination_invoice
     FROM plan_deletion_tasks task
     JOIN plan_deletion_subscription_tasks item ON item.plan_deletion_task_id = task.id
     JOIN subscriptions s ON s.id = item.subscription_id
     JOIN plans p ON p.id = task.plan_id
     WHERE task.id = ? AND item.subscription_id = ? LIMIT 1`,
  )
    .bind(taskId, subscriptionId)
    .first<SubscriptionWork>();
  if (!work) throw new Error("plan_deletion_subscription_not_found");
  if (work.subscription_task_status === "completed") return false;
  if (work.task_status !== "running") throw new Error("plan_deletion_not_running");
  if (work.subscription_plan_id !== work.plan_id) throw new Error("subscription_plan_changed");

  try {
    if (work.subscription_status === "pending") {
      await cancelPendingSubscriptionGeneration(
        env,
        work.subscription_id,
        work.version,
        work.effective_at,
        work.correlation_id,
        false,
      );
    } else if (work.subscription_status === "active" || work.subscription_status === "past_due") {
      const actions = terminationActions(work);
      if (actions.invoice === "generate") {
        await terminateSubscriptionWithInvoice(
          env,
          work.subscription_id,
          work.version,
          work.effective_at,
          work.correlation_id,
          false,
          work.plan_pay_in_advance === 1 && actions.creditNote === "credit",
          actions,
        );
      } else if (work.plan_pay_in_advance === 1 && actions.creditNote === "credit") {
        await terminatePayInAdvanceWithCredit(
          env,
          work.subscription_id,
          work.version,
          work.effective_at,
          work.correlation_id,
          actions,
          false,
        );
      } else {
        await terminateSubscriptionWithoutInvoice(
          env,
          work.subscription_id,
          work.version,
          work.effective_at,
          work.correlation_id,
          false,
          actions,
        );
      }
    } else if (
      work.subscription_status !== "canceled" &&
      work.subscription_status !== "terminated"
    ) {
      throw new Error("subscription_not_terminable");
    }
  } catch (error) {
    const code = errorCode(error);
    await env.BILLING_DB.prepare(
      `UPDATE plan_deletion_subscription_tasks
       SET attempt_count = attempt_count + 1, last_error_code = ?, updated_at = ?
       WHERE plan_deletion_task_id = ? AND subscription_id = ? AND status = 'pending'`,
    )
      .bind(code, new Date().toISOString(), taskId, subscriptionId)
      .run();
    if (code === "subscription_version_conflict") {
      const current = await env.BILLING_DB.prepare(
        "SELECT status FROM subscriptions WHERE id = ? LIMIT 1",
      )
        .bind(subscriptionId)
        .first<{ status: string }>();
      if (current?.status === "canceled" || current?.status === "terminated") {
        return completeSubscriptionTask(env.BILLING_DB, taskId, subscriptionId);
      }
    }
    throw error;
  }
  return completeSubscriptionTask(env.BILLING_DB, taskId, subscriptionId);
}

export async function listPlanDeletionDraftInvoices(
  database: D1Database,
  taskId: string,
): Promise<string[]> {
  const result = await database
    .prepare(
      `SELECT DISTINCT i.id
       FROM plan_deletion_tasks task
       JOIN invoices i ON i.organization_id = task.organization_id
       WHERE task.id = ? AND i.status = 'draft'
         AND (
           EXISTS (
             SELECT 1 FROM invoice_subscriptions owned
             JOIN subscriptions s ON s.id = owned.subscription_id
             WHERE owned.invoice_id = i.id AND s.plan_id = task.plan_id
           ) OR EXISTS (
             SELECT 1 FROM subscriptions s
             WHERE s.id = i.subscription_id AND s.plan_id = task.plan_id
           )
         )
       ORDER BY i.id LIMIT ?`,
    )
    .bind(taskId, DRAFT_BATCH_SIZE)
    .all<{ id: string }>();
  return result.results.map((row) => row.id);
}

export async function finalizePlanDeletionDraft(
  env: Env,
  taskId: string,
  invoiceId: string,
): Promise<boolean> {
  const task = await findPlanDeletionTaskById(env.BILLING_DB, taskId);
  if (!task) throw new Error("plan_deletion_task_not_found");
  if (task.status !== "running") throw new Error("plan_deletion_not_running");
  return finalizeInvoice(
    env,
    invoiceId,
    task.organization_id,
    task.effective_at,
    task.correlation_id,
  );
}

export async function preparePlanDeletionContinuation(
  database: D1Database,
  taskId: string,
  currentWorkflowInstanceId: string,
  currentSequence: number,
): Promise<PlanDeletionTask> {
  const nextSequence = currentSequence + 1;
  const nextInstanceId = planDeletionWorkflowInstanceId(taskId, nextSequence);
  const now = new Date().toISOString();
  await database
    .prepare(
      `UPDATE plan_deletion_tasks
       SET workflow_sequence = ?, workflow_instance_id = ?, updated_at = ?
       WHERE id = ? AND workflow_instance_id = ? AND workflow_sequence = ?
         AND status = 'running'`,
    )
    .bind(nextSequence, nextInstanceId, now, taskId, currentWorkflowInstanceId, currentSequence)
    .run();
  const task = await findPlanDeletionTaskById(database, taskId);
  if (!task) throw new Error("plan_deletion_task_not_found");
  if (task.workflow_sequence !== nextSequence || task.workflow_instance_id !== nextInstanceId) {
    throw new Error("plan_deletion_workflow_superseded");
  }
  return task;
}

export async function retirePlanDeletion(env: Env, taskId: string): Promise<boolean> {
  const task = await findPlanDeletionTaskById(env.BILLING_DB, taskId);
  if (!task) throw new Error("plan_deletion_task_not_found");
  if (task.status === "completed") return false;
  if (task.status !== "running") throw new Error("plan_deletion_not_running");
  const plan = await env.BILLING_DB.prepare(
    "SELECT code, version, active, pending_deletion FROM plans WHERE id = ? LIMIT 1",
  )
    .bind(task.plan_id)
    .first<{ code: string; version: number; active: number; pending_deletion: number }>();
  if (!plan) throw new Error("plan_not_found");
  if (
    plan.active !== 1 ||
    plan.pending_deletion !== 1 ||
    plan.version !== task.source_plan_version
  ) {
    throw new Error("plan_deletion_state_conflict");
  }
  const completedAt = new Date().toISOString();
  const event = planDeletedEvent(task, plan.code, completedAt);
  const noSubscriptionWork = `NOT EXISTS (
    SELECT 1 FROM plan_deletion_subscription_tasks item
    WHERE item.plan_deletion_task_id = ? AND item.status = 'pending'
  )`;
  const noLiveSubscriptions = `NOT EXISTS (
    SELECT 1 FROM subscriptions s
    WHERE s.plan_id = ? AND s.status IN ('pending', 'active', 'past_due')
  )`;
  const noDraftInvoices = `NOT EXISTS (
    SELECT 1 FROM invoices i
    WHERE i.organization_id = ? AND i.status = 'draft'
      AND (
        EXISTS (
          SELECT 1 FROM invoice_subscriptions owned
          JOIN subscriptions s ON s.id = owned.subscription_id
          WHERE owned.invoice_id = i.id AND s.plan_id = ?
        ) OR EXISTS (
          SELECT 1 FROM subscriptions s
          WHERE s.id = i.subscription_id AND s.plan_id = ?
        )
      )
  )`;
  const results = await env.BILLING_DB.batch([
    env.BILLING_DB.prepare(
      `UPDATE plan_deletion_tasks SET status = 'retiring', updated_at = ?
       WHERE id = ? AND status = 'running'
         AND EXISTS (SELECT 1 FROM plans
                     WHERE id = ? AND organization_id = ? AND active = 1
                       AND pending_deletion = 1 AND version = ?)
         AND ${noSubscriptionWork} AND ${noLiveSubscriptions} AND ${noDraftInvoices}`,
    ).bind(
      completedAt,
      task.id,
      task.plan_id,
      task.organization_id,
      task.source_plan_version,
      task.id,
      task.plan_id,
      task.organization_id,
      task.plan_id,
      task.plan_id,
    ),
    env.BILLING_DB.prepare(
      `UPDATE charges SET active = 0, version = version + 1, updated_at = ?
       WHERE organization_id = ? AND plan_id = ? AND active = 1
         AND EXISTS (SELECT 1 FROM plan_deletion_tasks
                     WHERE id = ? AND plan_id = ? AND status = 'retiring')`,
    ).bind(completedAt, task.organization_id, task.plan_id, task.id, task.plan_id),
    env.BILLING_DB.prepare(
      `UPDATE fixed_charges SET active = 0, version = version + 1, updated_at = ?
       WHERE organization_id = ? AND plan_id = ? AND active = 1
         AND EXISTS (SELECT 1 FROM plan_deletion_tasks
                     WHERE id = ? AND plan_id = ? AND status = 'retiring')`,
    ).bind(completedAt, task.organization_id, task.plan_id, task.id, task.plan_id),
    env.BILLING_DB.prepare(
      `UPDATE plans SET active = 0, pending_deletion = 0,
                        version = version + 1, updated_at = ?
       WHERE id = ? AND organization_id = ? AND active = 1 AND pending_deletion = 1
         AND version = ?
         AND EXISTS (SELECT 1 FROM plan_deletion_tasks
                     WHERE id = ? AND plan_id = ? AND status = 'retiring')`,
    ).bind(
      completedAt,
      task.plan_id,
      task.organization_id,
      task.source_plan_version,
      task.id,
      task.plan_id,
    ),
    env.BILLING_DB.prepare(
      `INSERT INTO outbox_events
       (event_id, organization_id, event_type, event_version, aggregate_type,
        aggregate_id, aggregate_version, causation_id, correlation_id, payload_json,
        occurred_at, published_at)
       SELECT ?, ?, ?, 1, 'plan', ?, ?, ?, ?, ?, ?, NULL FROM plans
       WHERE id = ? AND organization_id = ? AND active = 0 AND pending_deletion = 0
         AND version = ?
       ON CONFLICT(event_id) DO NOTHING`,
    ).bind(
      event.id,
      task.organization_id,
      event.type,
      task.plan_id,
      event.aggregateVersion,
      event.causationId,
      event.correlationId,
      stableJson(event.payload),
      completedAt,
      task.plan_id,
      task.organization_id,
      task.source_plan_version + 1,
    ),
    env.BILLING_DB.prepare(
      `UPDATE plan_deletion_tasks
       SET status = 'completed', error_code = NULL, updated_at = ?, completed_at = ?
       WHERE id = ? AND status = 'retiring'
         AND EXISTS (SELECT 1 FROM plans WHERE id = ? AND active = 0
                     AND pending_deletion = 0 AND version = ?)`,
    ).bind(completedAt, completedAt, task.id, task.plan_id, task.source_plan_version + 1),
  ]);
  if (
    results[0]?.meta.changes !== 1 ||
    results[3]?.meta.changes !== 1 ||
    results[4]?.meta.changes !== 1 ||
    results[5]?.meta.changes !== 1
  ) {
    throw new Error("plan_deletion_state_conflict");
  }
  return true;
}

export async function failPlanDeletionTask(
  database: D1Database,
  taskId: string,
  workflowInstanceId: string,
  error: unknown,
): Promise<void> {
  const failedAt = new Date().toISOString();
  await database
    .prepare(
      `UPDATE plan_deletion_tasks
       SET status = 'failed', error_code = ?, updated_at = ?
       WHERE id = ? AND workflow_instance_id = ? AND status IN ('pending', 'running')`,
    )
    .bind(errorCode(error), failedAt, taskId, workflowInstanceId)
    .run();
}

export async function findPlanDeletionTask(
  database: D1Database,
  planId: string,
): Promise<PlanDeletionTask | null> {
  return database
    .prepare(
      `SELECT id, organization_id, plan_id, source_plan_version, correlation_id, effective_at,
              status, workflow_sequence, workflow_instance_id, error_code
       FROM plan_deletion_tasks WHERE plan_id = ? LIMIT 1`,
    )
    .bind(planId)
    .first<PlanDeletionTask>();
}

async function findPlanDeletionTaskById(
  database: D1Database,
  taskId: string,
): Promise<PlanDeletionTask | null> {
  return database
    .prepare(
      `SELECT id, organization_id, plan_id, source_plan_version, correlation_id, effective_at,
              status, workflow_sequence, workflow_instance_id, error_code
       FROM plan_deletion_tasks WHERE id = ? LIMIT 1`,
    )
    .bind(taskId)
    .first<PlanDeletionTask>();
}

async function completeSubscriptionTask(
  database: D1Database,
  taskId: string,
  subscriptionId: string,
): Promise<boolean> {
  const completedAt = new Date().toISOString();
  const result = await database
    .prepare(
      `UPDATE plan_deletion_subscription_tasks
       SET status = 'completed', attempt_count = attempt_count + 1,
           last_error_code = NULL, updated_at = ?, completed_at = ?
       WHERE plan_deletion_task_id = ? AND subscription_id = ? AND status = 'pending'`,
    )
    .bind(completedAt, completedAt, taskId, subscriptionId)
    .run();
  return (result.meta.changes ?? 0) === 1;
}

function terminationActions(work: SubscriptionWork): TerminationActions {
  const creditNote = work.on_termination_credit_note;
  if (
    work.plan_pay_in_advance === 1 &&
    creditNote !== null &&
    creditNote !== "credit" &&
    creditNote !== "skip"
  ) {
    throw new Error("unsupported_plan_deletion_termination_credit_note");
  }
  return {
    creditNote: work.plan_pay_in_advance === 1 ? (creditNote === "skip" ? "skip" : "credit") : null,
    invoice: work.on_termination_invoice ?? "generate",
  };
}

function planDeletedEvent(task: PlanDeletionTask, code: string, occurredAt: string): DomainEvent {
  return {
    id: `plan-deleted:${task.plan_id}:v${task.source_plan_version + 1}`,
    type: "plan.deleted",
    version: 1,
    aggregateType: "plan",
    aggregateId: task.plan_id,
    aggregateVersion: task.source_plan_version + 1,
    occurredAt,
    causationId: task.correlation_id,
    correlationId: task.correlation_id,
    payload: { organizationId: task.organization_id, code },
  };
}

async function createWorkflowInstance(
  binding: Env["PLAN_DELETION_WORKFLOW"],
  task: PlanDeletionTask,
): Promise<void> {
  try {
    await binding.create({
      id: task.workflow_instance_id,
      params: { taskId: task.id, sequence: task.workflow_sequence },
    });
  } catch (error) {
    if (!errorCode(error).toLowerCase().includes("already exists")) throw error;
  }
}

function errorCode(error: unknown): string {
  return error instanceof Error && error.message ? error.message.slice(0, 120) : "unknown_error";
}
