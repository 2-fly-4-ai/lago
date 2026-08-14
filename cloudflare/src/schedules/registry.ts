export type ScheduleExecutor =
  | "activate_subscriptions"
  | "cleanup_inbound_webhooks"
  | "cleanup_outbound_webhooks"
  | "close_billing_periods"
  | "expire_coupons"
  | "expire_wallets"
  | "finalize_invoices"
  | "mark_invoices_overdue"
  | "refresh_draft_invoices"
  | "reconcile_provider_receipts"
  | "terminate_ended_subscriptions";

export type ScheduleParity = "implemented" | "partial" | "not_started";

type Cadence =
  | { kind: "every_minutes"; minutes: number }
  | { kind: "hourly"; minute: number }
  | { kind: "daily"; hour: number; minute: number }
  | { kind: "dynamic"; source: string };

export type LegacySchedule = {
  key: `schedule:${string}`;
  legacyJob: string;
  cadence: Cadence;
  owner: string;
  parity: ScheduleParity;
  executor?: ScheduleExecutor;
};

const everyMinutes = (minutes: number): Cadence => ({ kind: "every_minutes", minutes });
const hourly = (minute: number): Cadence => ({ kind: "hourly", minute });
const daily = (hour: number, minute: number): Cadence => ({ kind: "daily", hour, minute });
const dynamic = (source: string): Cadence => ({ kind: "dynamic", source });

// This is an exhaustive ownership map of api/clock.rb. Consolidating jobs is intentional, but
// every legacy schedule stays visible until its retained behavior has executable parity evidence.
export const LEGACY_SCHEDULES: readonly LegacySchedule[] = [
  {
    key: "schedule:activate_subscriptions",
    legacyJob: "Clock::ActivateSubscriptionsJob",
    cadence: everyMinutes(5),
    owner: "subscription lifecycle workflow",
    parity: "implemented",
    executor: "activate_subscriptions",
  },
  {
    key: "schedule:refresh_draft_invoices",
    legacyJob: "Clock::RefreshDraftInvoicesJob",
    cadence: everyMinutes(5),
    owner: "reconciliation workflow",
    parity: "implemented",
    executor: "refresh_draft_invoices",
  },
  {
    key: "schedule:process_subscription_activity",
    legacyJob: "Clock::ProcessAllSubscriptionActivitiesJob",
    cadence: dynamic("LAGO_SUBSCRIPTION_ACTIVITY_PROCESSING_INTERVAL_SECONDS, default 60 seconds"),
    owner: "usage projection queue",
    parity: "not_started",
  },
  {
    key: "schedule:process_dedicated_orgs_subscription_activities",
    legacyJob: "Clock::ProcessDedicatedOrgsSubscriptionActivitiesJob",
    cadence: dynamic("Utils::DedicatedWorkerConfig.refresh_interval"),
    owner: "usage projection queue",
    parity: "not_started",
  },
  {
    key: "schedule:refresh_lifetime_usages",
    legacyJob: "Clock::RefreshLifetimeUsagesJob",
    cadence: dynamic("LAGO_LIFETIME_USAGE_REFRESH_INTERVAL_SECONDS, default 5 minutes"),
    owner: "usage projection workflow",
    parity: "not_started",
  },
  {
    key: "schedule:refresh_wallets_ongoing_balance",
    legacyJob: "Clock::RefreshWalletsOngoingBalanceJob",
    cadence: everyMinutes(5),
    owner: "wallet projection workflow",
    parity: "not_started",
  },
  {
    key: "schedule:refresh_dedicated_org_wallets",
    legacyJob: "Clock::RefreshDedicatedOrgWalletsOngoingBalanceJob",
    cadence: dynamic("Utils::DedicatedWorkerConfig.refresh_interval"),
    owner: "wallet projection workflow",
    parity: "not_started",
  },
  {
    key: "schedule:terminate_ended_subscriptions",
    legacyJob: "Clock::TerminateEndedSubscriptionsJob",
    cadence: hourly(5),
    owner: "subscription lifecycle workflow",
    parity: "partial",
    executor: "terminate_ended_subscriptions",
  },
  {
    key: "schedule:bill_customers",
    legacyJob: "Clock::SubscriptionsBillerJob",
    cadence: hourly(10),
    owner: "reconciliation workflow",
    parity: "partial",
    executor: "close_billing_periods",
  },
  {
    key: "schedule:api_keys_track_usage",
    legacyJob: "Clock::ApiKeys::TrackUsageJob",
    cadence: hourly(15),
    owner: "analytics engine projection",
    parity: "not_started",
  },
  {
    key: "schedule:retry_generating_subscription_invoices",
    legacyJob: "Clock::RetryGeneratingSubscriptionInvoicesJob",
    cadence: hourly(30),
    owner: "invoice retry workflow",
    parity: "not_started",
  },
  {
    key: "schedule:finalize_invoices",
    legacyJob: "Clock::FinalizeInvoicesJob",
    cadence: hourly(20),
    owner: "reconciliation workflow",
    parity: "implemented",
    executor: "finalize_invoices",
  },
  {
    key: "schedule:mark_invoices_as_payment_overdue",
    legacyJob: "Clock::MarkInvoicesAsPaymentOverdueJob",
    cadence: hourly(25),
    owner: "reconciliation workflow",
    parity: "implemented",
    executor: "mark_invoices_overdue",
  },
  {
    key: "schedule:terminate_coupons",
    legacyJob: "Clock::TerminateCouponsJob",
    cadence: hourly(30),
    owner: "reconciliation workflow",
    parity: "implemented",
    executor: "expire_coupons",
  },
  {
    key: "schedule:bill_ended_trial_subscriptions",
    legacyJob: "Clock::FreeTrialSubscriptionsBillerJob",
    cadence: hourly(35),
    owner: "subscription lifecycle workflow",
    parity: "not_started",
  },
  {
    key: "schedule:terminate_wallets",
    legacyJob: "Clock::TerminateWalletsJob",
    cadence: hourly(45),
    owner: "reconciliation workflow",
    parity: "implemented",
    executor: "expire_wallets",
  },
  {
    key: "schedule:termination_alert",
    legacyJob: "Clock::SubscriptionsToBeTerminatedJob",
    cadence: hourly(50),
    owner: "subscription lifecycle workflow",
    parity: "not_started",
  },
  {
    key: "schedule:terminate_expired_wallet_transaction_rules",
    legacyJob: "Clock::TerminateRecurringTransactionRulesJob",
    cadence: hourly(50),
    owner: "wallet recurring transaction workflow",
    parity: "not_started",
  },
  {
    key: "schedule:top_up_wallet_interval_credits",
    legacyJob: "Clock::CreateIntervalWalletTransactionsJob",
    cadence: hourly(55),
    owner: "wallet top-up workflow",
    parity: "not_started",
  },
  {
    key: "schedule:clean_webhooks",
    legacyJob: "Clock::WebhooksCleanupJob",
    cadence: daily(1, 0),
    owner: "reconciliation workflow",
    parity: "implemented",
    executor: "cleanup_outbound_webhooks",
  },
  {
    key: "schedule:clean_inbound_webhooks",
    legacyJob: "Clock::InboundWebhooksCleanupJob",
    cadence: daily(1, 10),
    owner: "reconciliation workflow",
    parity: "implemented",
    executor: "cleanup_inbound_webhooks",
  },
  {
    key: "schedule:post_validate_events",
    legacyJob: "Clock::EventsValidationJob",
    cadence: hourly(5),
    owner: "usage validation queue",
    parity: "not_started",
  },
  {
    key: "schedule:compute_daily_usage",
    legacyJob: "Clock::ComputeAllDailyUsagesJob",
    cadence: hourly(15),
    owner: "usage projection workflow",
    parity: "not_started",
  },
  {
    key: "schedule:process_dunning_campaigns",
    legacyJob: "Clock::ProcessDunningCampaignsJob",
    cadence: hourly(45),
    owner: "dunning workflow",
    parity: "not_started",
  },
  {
    key: "schedule:retry_failed_invoices",
    legacyJob: "Clock::RetryFailedInvoicesJob",
    cadence: everyMinutes(15),
    owner: "invoice retry workflow",
    parity: "not_started",
  },
  {
    key: "schedule:retry_inbound_webhooks",
    legacyJob: "Clock::InboundWebhooksRetryJob",
    cadence: everyMinutes(15),
    owner: "reconciliation workflow",
    parity: "partial",
    executor: "reconcile_provider_receipts",
  },
  {
    key: "schedule:refresh_flagged_subscriptions",
    legacyJob: "Clock::ConsumeSubscriptionRefreshedQueueJob",
    cadence: dynamic("conditional Redis and ClickHouse loop, every 10 seconds"),
    owner: "usage projection queue",
    parity: "not_started",
  },
];

export function dueLegacySchedules(triggeredAt: number): LegacySchedule[] {
  const date = new Date(triggeredAt);
  if (!Number.isFinite(date.getTime())) throw new Error("invalid_schedule_timestamp");
  return LEGACY_SCHEDULES.filter((schedule) => isDue(schedule.cadence, date));
}

export function scheduleInstanceId(triggeredAt: number): string {
  const date = new Date(triggeredAt);
  if (!Number.isFinite(date.getTime())) throw new Error("invalid_schedule_timestamp");
  return `maintenance-${date.toISOString().slice(0, 16).replaceAll(/[-T:]/g, "")}`;
}

function isDue(cadence: Cadence, date: Date): boolean {
  if (cadence.kind === "dynamic") return false;
  const minute = date.getUTCMinutes();
  if (cadence.kind === "every_minutes") return minute % cadence.minutes === 0;
  if (cadence.kind === "hourly") return minute === cadence.minute;
  return date.getUTCHours() === cadence.hour && minute === cadence.minute;
}
