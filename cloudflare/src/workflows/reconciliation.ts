import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import { reconcileAuthorizeNetReceipt } from "../reconciliation/authorize-net";
import type { DomainEvent } from "../domain-events";
import { closeBillingPeriod } from "../billing/close-period";
import { activatePendingSubscriptions } from "../billing/activate-pending-subscriptions";
import { terminateEndedSubscriptions } from "../billing/terminate-subscription";
import { enqueueTerminationAlerts } from "../billing/termination-alerts";
import { billEndedTrialSubscriptions } from "../billing/bill-ended-trials";
import {
  cleanupDeletedMetricEvents,
  cleanupInboundWebhookReceipts,
  cleanupOutboundWebhookDeliveries,
  expireCoupons,
  expireWallets,
  finalizeDueInvoices,
  markInvoicesOverdue,
  refreshFlaggedDraftInvoices,
  webhookRetentionCutoff,
} from "../schedules/maintenance";
import { dueLegacySchedules, scheduleInstanceId } from "../schedules/registry";
import {
  expireRecurringWalletRules,
  topUpDueRecurringWallets,
} from "../schedules/recurring-wallets";
import { refreshWalletOngoingBalances } from "../schedules/wallet-balances";
import { dispatchPendingPlanDeletions } from "../billing/plan-deletion";
import { repairPendingPayInAdvanceFixedChargeInvoices } from "../billing/pay-in-advance-fixed-charges";
import { repairPendingPayInAdvanceUsageInvoices } from "../billing/pay-in-advance-usage";
import {
  lifetimeUsageRefreshCandidates,
  pendingSubscriptionActivities,
  processSubscriptionActivity,
  refreshLifetimeUsage,
} from "../usage/lifetime-usage";
import {
  invoiceDailyUsageCandidates,
  projectInvoiceDailyUsage,
  projectScheduledDailyUsage,
  scheduledDailyUsageCandidates,
} from "../usage/daily-usage";
import {
  createProgressiveBillingInvoice,
  progressiveBillingCandidates,
} from "../billing/progressive-billing";
import { processDunningCampaigns } from "../schedules/dunning";

type ReconciliationParams = {
  schedule?: {
    cron: string;
    triggeredAt: number;
  };
};

export class ReconciliationWorkflow extends WorkflowEntrypoint<Env, ReconciliationParams> {
  override async run(event: WorkflowEvent<ReconciliationParams>, step: WorkflowStep) {
    const triggeredAt = event.payload.schedule?.triggeredAt ?? event.timestamp.getTime();
    const triggeredAtIso = new Date(triggeredAt).toISOString();
    const cron = event.payload.schedule?.cron ?? "manual";
    const runId = scheduleInstanceId(triggeredAt);
    const dueSchedules = dueLegacySchedules(triggeredAt);
    const dueScheduleKeys = dueSchedules.map((schedule) => schedule.key);
    const unimplementedScheduleKeys = dueSchedules
      .filter((schedule) => !schedule.executor)
      .map((schedule) => schedule.key);
    await step.do("record schedule run", async () => {
      await this.env.BILLING_DB.prepare(
        `INSERT INTO schedule_runs
         (id, cron, triggered_at_ms, triggered_at, status, due_schedules_json,
          unimplemented_schedules_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'running', ?, ?, ?, ?)
         ON CONFLICT(id) DO NOTHING`,
      )
        .bind(
          runId,
          cron,
          triggeredAt,
          triggeredAtIso,
          JSON.stringify(dueScheduleKeys),
          JSON.stringify(unimplementedScheduleKeys),
          triggeredAtIso,
          triggeredAtIso,
        )
        .run();
      return { runId, dueScheduleKeys, unimplementedScheduleKeys };
    });

    const executors = new Set(dueSchedules.map((schedule) => schedule.executor));
    try {
      const activatedSubscriptions = executors.has("activate_subscriptions")
        ? await step.do(
            "activate pending subscriptions",
            { retries: { limit: 5, delay: "5 seconds", backoff: "exponential" } },
            async () => activatePendingSubscriptions(this.env, triggeredAtIso, runId),
          )
        : 0;

      const repairedAdvanceFixedChargeInvoices = await step.do(
        "repair advance fixed charge invoices",
        { retries: { limit: 5, delay: "5 seconds", backoff: "exponential" } },
        async () => repairPendingPayInAdvanceFixedChargeInvoices(this.env, triggeredAtIso, runId),
      );

      const repairedAdvanceUsageInvoices = await step.do(
        "repair advance usage invoices",
        { retries: { limit: 5, delay: "5 seconds", backoff: "exponential" } },
        async () => repairPendingPayInAdvanceUsageInvoices(this.env, triggeredAtIso, runId),
      );

      const subscriptionActivities = await step.do("load subscription activities", async () =>
        executors.has("process_subscription_activity")
          ? pendingSubscriptionActivities(this.env.BILLING_DB)
          : [],
      );
      let processedSubscriptionActivities = 0;
      let failedSubscriptionActivities = 0;
      for (const [index, activity] of subscriptionActivities.entries()) {
        try {
          const outcome = await step.do(
            `process subscription activity ${index + 1}`,
            { retries: { limit: 5, delay: "5 seconds", backoff: "exponential" } },
            async () =>
              processSubscriptionActivity(
                this.env.BILLING_DB,
                activity.organizationId,
                activity.externalSubscriptionId,
                triggeredAtIso,
              ),
          );
          if (outcome === "processed") processedSubscriptionActivities += 1;
        } catch {
          failedSubscriptionActivities += 1;
        }
      }

      const lifetimeUsageCandidates = await step.do(
        "load lifetime usage refresh candidates",
        async () =>
          executors.has("refresh_lifetime_usages")
            ? lifetimeUsageRefreshCandidates(this.env.BILLING_DB)
            : [],
      );
      let refreshedLifetimeUsages = 0;
      let failedLifetimeUsageRefreshes = 0;
      for (const [index, candidate] of lifetimeUsageCandidates.entries()) {
        try {
          const refreshed = await step.do(
            `refresh lifetime usage ${index + 1}`,
            { retries: { limit: 5, delay: "5 seconds", backoff: "exponential" } },
            async () =>
              refreshLifetimeUsage(
                this.env.BILLING_DB,
                candidate.organizationId,
                candidate.externalSubscriptionId,
                triggeredAtIso,
              ),
          );
          if (refreshed) refreshedLifetimeUsages += 1;
        } catch {
          failedLifetimeUsageRefreshes += 1;
        }
      }

      const progressiveCandidates = await step.do(
        "load progressive billing candidates",
        async () =>
          executors.has("process_subscription_activity") || executors.has("refresh_lifetime_usages")
            ? progressiveBillingCandidates(this.env.BILLING_DB)
            : [],
      );
      let progressiveInvoices = 0;
      let failedProgressiveBillings = 0;
      for (const candidate of progressiveCandidates) {
        try {
          const invoice = await step.do(
            `bill progressive usage ${candidate.subscriptionId}`,
            { retries: { limit: 5, delay: "5 seconds", backoff: "exponential" } },
            async () =>
              createProgressiveBillingInvoice(
                this.env,
                candidate,
                triggeredAtIso,
                `schedule:${triggeredAt}`,
              ),
          );
          if (invoice && !invoice.replayed) progressiveInvoices += 1;
        } catch {
          failedProgressiveBillings += 1;
        }
      }

      const scheduledUsageCandidates = await step.do(
        "load scheduled daily usage candidates",
        async () =>
          executors.has("project_daily_usage")
            ? scheduledDailyUsageCandidates(this.env.BILLING_DB, triggeredAt)
            : [],
      );
      let projectedScheduledDailyUsages = 0;
      let failedScheduledDailyUsages = 0;
      for (const candidate of scheduledUsageCandidates) {
        try {
          const projected = await step.do(
            `project scheduled daily usage ${candidate.id} ${candidate.usageDate}`,
            { retries: { limit: 5, delay: "5 seconds", backoff: "exponential" } },
            async () => projectScheduledDailyUsage(this.env.BILLING_DB, candidate, triggeredAtIso),
          );
          if (projected) projectedScheduledDailyUsages += 1;
        } catch {
          failedScheduledDailyUsages += 1;
        }
      }

      const invoiceUsageCandidates = await step.do(
        "load invoice daily usage candidates",
        async () =>
          executors.has("project_daily_usage")
            ? invoiceDailyUsageCandidates(this.env.BILLING_DB)
            : [],
      );
      let projectedInvoiceDailyUsages = 0;
      let failedInvoiceDailyUsages = 0;
      for (const candidate of invoiceUsageCandidates) {
        try {
          const projected = await step.do(
            `project invoice daily usage ${candidate.invoiceId} ${candidate.subscriptionId} v${candidate.invoiceVersion}`,
            { retries: { limit: 5, delay: "5 seconds", backoff: "exponential" } },
            async () => projectInvoiceDailyUsage(this.env.BILLING_DB, candidate),
          );
          if (projected) projectedInvoiceDailyUsages += 1;
        } catch {
          failedInvoiceDailyUsages += 1;
        }
      }

      const terminatedSubscriptions = executors.has("terminate_ended_subscriptions")
        ? await step.do(
            "terminate ended subscriptions",
            { retries: { limit: 5, delay: "5 seconds", backoff: "exponential" } },
            async () => terminateEndedSubscriptions(this.env, triggeredAtIso, runId),
          )
        : 0;

      const terminationAlerts = executors.has("enqueue_termination_alerts")
        ? await step.do(
            "enqueue subscription termination alerts",
            { retries: { limit: 5, delay: "5 seconds", backoff: "exponential" } },
            async () => enqueueTerminationAlerts(this.env.BILLING_DB, triggeredAtIso, runId),
          )
        : { candidates: 0, enqueued: 0 };

      const endedTrialSubscriptions = executors.has("bill_ended_trials")
        ? await step.do(
            "bill ended trial subscriptions",
            { retries: { limit: 5, delay: "5 seconds", backoff: "exponential" } },
            async () => billEndedTrialSubscriptions(this.env, triggeredAtIso, runId),
          )
        : 0;

      const pendingReceiptIds = await step.do("load pending provider receipts", async () => {
        if (!executors.has("reconcile_provider_receipts")) return [];
        const result = await this.env.BILLING_DB.prepare(
          `SELECT id FROM webhook_receipts
         WHERE provider = 'authorize_net' AND processed_at IS NULL
         ORDER BY received_at ASC LIMIT 100`,
        ).all<{ id: string }>();
        return result.results.map((row) => row.id);
      });

      let processedReceipts = 0;
      let deferredReceipts = 0;
      for (const receiptId of pendingReceiptIds) {
        const outcome = await step.do(
          `reconcile provider receipt ${receiptId}`,
          {
            retries: { limit: 5, delay: "10 seconds", backoff: "exponential" },
            timeout: "1 minute",
          },
          async () => reconcileAuthorizeNetReceipt(this.env, receiptId),
        );
        if (outcome === "processed") processedReceipts += 1;
        else deferredReceipts += 1;
      }

      const dueBillingPeriods = await step.do("load due billing periods", async () => {
        if (!executors.has("close_billing_periods")) return [];
        const result = await this.env.BILLING_DB.prepare(
          `SELECT id, current_period_end FROM subscriptions
         WHERE status IN ('active', 'past_due') AND current_period_end IS NOT NULL
           AND current_period_end <= ?
           AND (ending_at IS NULL OR ending_at > ?)
         ORDER BY current_period_end, id LIMIT 100`,
        )
          .bind(triggeredAtIso, triggeredAtIso)
          .all<{ id: string; current_period_end: string }>();
        return [...result.results];
      });

      let closedBillingPeriods = 0;
      for (const period of dueBillingPeriods) {
        await step.do(
          `close billing period ${period.id} ${period.current_period_end}`,
          {
            retries: { limit: 5, delay: "10 seconds", backoff: "exponential" },
            timeout: "2 minutes",
          },
          async () =>
            closeBillingPeriod(
              this.env,
              period.id,
              period.current_period_end,
              `schedule:${triggeredAt}`,
            ),
        );
        closedBillingPeriods += 1;
      }

      const expiredCoupons = executors.has("expire_coupons")
        ? await step.do(
            "terminate expired coupons",
            { retries: { limit: 5, delay: "5 seconds", backoff: "exponential" } },
            async () => expireCoupons(this.env, triggeredAtIso, runId),
          )
        : 0;

      const expiredWallets = executors.has("expire_wallets")
        ? await step.do(
            "terminate expired wallets",
            { retries: { limit: 5, delay: "5 seconds", backoff: "exponential" } },
            async () => expireWallets(this.env, triggeredAtIso, runId),
          )
        : 0;

      const expiredRecurringWalletRules = executors.has("terminate_recurring_wallet_rules")
        ? await step.do(
            "terminate expired recurring wallet rules",
            { retries: { limit: 5, delay: "5 seconds", backoff: "exponential" } },
            async () => expireRecurringWalletRules(this.env, triggeredAtIso, runId),
          )
        : 0;

      const recurringWalletTopUps = executors.has("top_up_recurring_wallets")
        ? await step.do(
            "top up recurring granted-credit wallets",
            { retries: { limit: 5, delay: "5 seconds", backoff: "exponential" } },
            async () => topUpDueRecurringWallets(this.env, triggeredAtIso, runId),
          )
        : 0;

      const overdueInvoices = executors.has("mark_invoices_overdue")
        ? await step.do(
            "mark invoices overdue",
            { retries: { limit: 5, delay: "5 seconds", backoff: "exponential" } },
            async () => markInvoicesOverdue(this.env, triggeredAtIso, runId),
          )
        : 0;

      const finalizedInvoices = executors.has("finalize_invoices")
        ? await step.do(
            "finalize due invoices",
            { retries: { limit: 5, delay: "5 seconds", backoff: "exponential" } },
            async () => finalizeDueInvoices(this.env, triggeredAtIso, runId),
          )
        : 0;

      const refreshedDraftInvoices = executors.has("refresh_draft_invoices")
        ? await step.do(
            "refresh flagged draft invoices",
            { retries: { limit: 5, delay: "5 seconds", backoff: "exponential" } },
            async () => refreshFlaggedDraftInvoices(this.env, triggeredAtIso, runId),
          )
        : 0;

      const walletBalanceProjection = executors.has("refresh_wallet_balances")
        ? await step.do(
            "refresh ongoing wallet balances and threshold grants",
            {
              retries: { limit: 5, delay: "5 seconds", backoff: "exponential" },
              timeout: "5 minutes",
            },
            async () => refreshWalletOngoingBalances(this.env, triggeredAtIso, runId),
          )
        : { customers: 0, wallets: 0, thresholdTopUps: 0 };

      const deletedMetricUsage = await step.do(
        "clean retired billable metric usage",
        { retries: { limit: 5, delay: "5 seconds", backoff: "exponential" } },
        async () => cleanupDeletedMetricEvents(this.env),
      );

      const dispatchedPlanDeletions = await step.do(
        "dispatch pending plan deletions",
        { retries: { limit: 5, delay: "5 seconds", backoff: "exponential" } },
        async () => dispatchPendingPlanDeletions(this.env),
      );

      const retentionCutoff = webhookRetentionCutoff(triggeredAtIso);
      const deletedOutboundWebhooks = executors.has("cleanup_outbound_webhooks")
        ? await step.do(
            "delete retained outbound webhooks",
            { retries: { limit: 5, delay: "5 seconds", backoff: "exponential" } },
            async () => cleanupOutboundWebhookDeliveries(this.env, retentionCutoff),
          )
        : 0;
      const deletedInboundWebhooks = executors.has("cleanup_inbound_webhooks")
        ? await step.do(
            "delete retained inbound webhooks",
            { retries: { limit: 5, delay: "5 seconds", backoff: "exponential" } },
            async () => cleanupInboundWebhookReceipts(this.env, retentionCutoff),
          )
        : { artifactsDeleted: 0, receiptsDeleted: 0 };

      const dunning = executors.has("process_dunning_campaigns")
        ? await step.do(
            "process dunning campaigns",
            { retries: { limit: 5, delay: "5 seconds", backoff: "exponential" } },
            async () => processDunningCampaigns(this.env, triggeredAtIso, runId),
          )
        : { candidates: 0, requestsCreated: 0, campaignsFinished: 0 };

      const publishedEvents = await step.do(
        "publish pending outbox events",
        { retries: { limit: 5, delay: "5 seconds", backoff: "exponential" }, timeout: "1 minute" },
        async () => publishOutboxEvents(this.env),
      );

      const result = {
        accepted: true,
        runId,
        cron,
        triggeredAt,
        dueSchedules: dueScheduleKeys,
        unimplementedSchedules: unimplementedScheduleKeys,
        activatedSubscriptions,
        repairedAdvanceFixedChargeInvoices,
        repairedAdvanceUsageInvoices,
        pendingSubscriptionActivities: subscriptionActivities.length,
        processedSubscriptionActivities,
        failedSubscriptionActivities,
        lifetimeUsageRefreshCandidates: lifetimeUsageCandidates.length,
        refreshedLifetimeUsages,
        failedLifetimeUsageRefreshes,
        progressiveBillingCandidates: progressiveCandidates.length,
        progressiveInvoices,
        failedProgressiveBillings,
        scheduledDailyUsageCandidates: scheduledUsageCandidates.length,
        projectedScheduledDailyUsages,
        failedScheduledDailyUsages,
        invoiceDailyUsageCandidates: invoiceUsageCandidates.length,
        projectedInvoiceDailyUsages,
        failedInvoiceDailyUsages,
        eventValidationMode: executors.has("audit_synchronous_event_validation")
          ? "synchronous_precommit"
          : null,
        apiKeyUsageTrackingMode: executors.has("audit_synchronous_api_key_usage")
          ? "synchronous_authentication_write"
          : null,
        terminatedSubscriptions,
        terminationAlerts,
        endedTrialSubscriptions,
        pendingReceipts: pendingReceiptIds.length,
        processedReceipts,
        deferredReceipts,
        dueBillingPeriods: dueBillingPeriods.length,
        closedBillingPeriods,
        expiredCoupons,
        expiredWallets,
        expiredRecurringWalletRules,
        recurringWalletTopUps,
        overdueInvoices,
        finalizedInvoices,
        refreshedDraftInvoices,
        walletBalanceProjection,
        deletedMetricUsage,
        dispatchedPlanDeletions,
        deletedOutboundWebhooks,
        deletedInboundWebhooks,
        dunning,
        publishedEvents,
      };
      await step.do("complete schedule run", async () => {
        await this.env.BILLING_DB.prepare(
          `UPDATE schedule_runs SET status = ?, result_json = ?, updated_at = ?, completed_at = ?
         WHERE id = ?`,
        )
          .bind(
            unimplementedScheduleKeys.length === 0 ? "completed" : "partial",
            JSON.stringify(result),
            new Date().toISOString(),
            new Date().toISOString(),
            runId,
          )
          .run();
        return { completed: true };
      });
      return result;
    } catch (error) {
      await step.do("fail schedule run", async () => {
        const failedAt = new Date().toISOString();
        await this.env.BILLING_DB.prepare(
          `UPDATE schedule_runs SET status = 'failed', error_code = 'schedule_execution_failed',
           updated_at = ?, completed_at = ? WHERE id = ?`,
        )
          .bind(failedAt, failedAt, runId)
          .run();
        return { failed: true };
      });
      throw error;
    }
  }
}

async function publishOutboxEvents(env: Env): Promise<number> {
  const result = await env.BILLING_DB.prepare(
    `SELECT event_id, event_type, event_version, aggregate_type, aggregate_id,
            aggregate_version, occurred_at, causation_id, correlation_id, payload_json
     FROM outbox_events WHERE published_at IS NULL ORDER BY occurred_at ASC LIMIT 100`,
  ).all<{
    event_id: string;
    event_type: string;
    event_version: number;
    aggregate_type: string;
    aggregate_id: string;
    aggregate_version: number;
    occurred_at: string;
    causation_id: string | null;
    correlation_id: string;
    payload_json: string;
  }>();

  const messages = result.results.map((row) => ({
    body: {
      id: row.event_id,
      type: row.event_type,
      version: row.event_version,
      aggregateType: row.aggregate_type,
      aggregateId: row.aggregate_id,
      aggregateVersion: row.aggregate_version,
      occurredAt: row.occurred_at,
      causationId: row.causation_id,
      correlationId: row.correlation_id,
      payload: parsePayload(row.payload_json),
    } satisfies DomainEvent,
  }));
  if (messages.length > 0) await env.DOMAIN_EVENTS.sendBatch(messages);
  return messages.length;
}

function parsePayload(value: string): Record<string, unknown> {
  try {
    const payload = JSON.parse(value) as unknown;
    return payload && typeof payload === "object" && !Array.isArray(payload)
      ? (payload as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}
