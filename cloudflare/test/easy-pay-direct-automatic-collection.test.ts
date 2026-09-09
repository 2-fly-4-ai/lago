import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { sha256Hex } from "../src/auth/api-key";
import { holdCustomerForClosure } from "../src/api/customer-closure";
import {
  dispatchPendingEasyPayDirectAutomaticCollections,
  pendingEasyPayDirectAutomaticCollectionInvoices,
  pendingEasyPayDirectAutomaticExecutions,
  prepareEasyPayDirectAutomaticCollection,
  processEasyPayDirectAutomaticCollection,
  redispatchPendingEasyPayDirectAutomaticCollections,
  reconcileEasyPayDirectAutomaticCollection,
} from "../src/billing/easy-pay-direct-automatic-collection";
import { stableJson } from "../src/json";
import { encryptBillingAddress } from "../src/tax/billing-address-vault";
import { processDunningCampaigns } from "../src/schedules/dunning";
import { reconcileElementsAutomaticWebhook } from "../src/billing/easy-pay-direct-commerce-renewal";
import { createCreditNote } from "../src/api/credit-note-ledger";

let invoiceId: string;
let organizationId: string;

function approvedGatewayResponse(url: RequestInfo | URL, transactionId: string, orderId: string) {
  return new Response(
    String(url).endsWith("query.php")
      ? `<nm_response><transaction><transaction_id>${transactionId}</transaction_id><order_id>${orderId}</order_id><condition>complete</condition><currency>USD</currency><action><action_type>sale</action_type><amount>9.00</amount><success>1</success></action></transaction></nm_response>`
      : `response=1&response_code=100&transactionid=${transactionId}&orderid=${orderId}`,
  );
}

beforeEach(async () => {
  const fixture = crypto.randomUUID();
  organizationId = `org-epd-renewal-${fixture}`;
  const customerId = `customer-epd-renewal-${fixture}`;
  const profileId = `profile-epd-renewal-${fixture}`;
  const planId = `plan-epd-renewal-${fixture}`;
  const subscriptionId = `subscription-epd-renewal-${fixture}`;
  invoiceId = `invoice-epd-renewal-${fixture}`;
  const now = new Date().toISOString();
  await env.BILLING_DB.batch([
    env.BILLING_DB.prepare(
      `INSERT INTO organizations (id, external_id, name, created_at, updated_at)
       VALUES (?, ?, 'EPD renewal test', ?, ?)`,
    ).bind(organizationId, organizationId, now, now),
    env.BILLING_DB.prepare(
      `INSERT INTO customers
       (id, organization_id, external_id, email, name, currency, metadata_json,
        payment_provider, payment_provider_code, created_at, updated_at)
       VALUES (?, ?, ?, 'renewal@example.test', 'Renewal test', 'USD', '{}',
               'easy_pay_direct', 'epd-renewal-test', ?, ?)`,
    ).bind(customerId, organizationId, customerId, now, now),
    env.BILLING_DB.prepare(
      `INSERT INTO provider_customer_profiles
       (id, organization_id, customer_id, provider, provider_account_code,
        provider_customer_id, gateway_customer_vault_id, initial_transaction_id,
        status, created_at, updated_at)
       VALUES (?, ?, ?, 'easy_pay_direct', 'epd-renewal-test', ?, ?, ?, 'active', ?, ?)`,
    ).bind(
      profileId,
      organizationId,
      customerId,
      `gateway:vault-${fixture}`,
      `vault-${fixture}`,
      `initial-${fixture}`,
      now,
      now,
    ),
    env.BILLING_DB.prepare(
      `INSERT INTO plans
       (id, organization_id, code, name, interval, amount_minor, currency,
        version, active, created_at, updated_at)
       VALUES (?, ?, ?, 'Monthly renewal', 'monthly', 900, 'USD', 1, 1, ?, ?)`,
    ).bind(planId, organizationId, planId, now, now),
    env.BILLING_DB.prepare(
      `INSERT INTO subscriptions
       (id, organization_id, customer_id, plan_id, external_id, status, started_at,
        current_period_start, current_period_end, payment_method_type, payment_method_id,
        version, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'active', ?, ?, '2026-10-01T00:00:00.000Z',
               'provider', ?, 1, ?, ?)`,
    ).bind(
      subscriptionId,
      organizationId,
      customerId,
      planId,
      subscriptionId,
      now,
      now,
      profileId,
      now,
      now,
    ),
    env.BILLING_DB.prepare(
      `INSERT INTO invoices
       (id, organization_id, customer_id, subscription_id, number, status,
        payment_status, currency, subtotal_minor, tax_minor, credits_minor,
        total_due_minor, version, finalized_at, payment_overdue,
        ready_for_payment_processing, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'finalized', 'pending', 'USD', 900, 0, 0, 900,
               1, ?, 0, 1, ?, ?)`,
    ).bind(invoiceId, organizationId, customerId, subscriptionId, `INV-${fixture}`, now, now, now),
  ]);
});

describe("Easy Pay Direct automatic subscription collection", () => {
  // Rebuild the legacy-only fixture before adding checkout-scoped profile fixtures.
  it("preserves referenced legacy profiles through the checkout-profile migration", async () => {
    await prepareEasyPayDirectAutomaticCollection(enabledEnv(), invoiceId, "migration-test");
    const before = await env.BILLING_DB.prepare(
      "SELECT * FROM provider_customer_profiles WHERE organization_id = ?",
    )
      .bind(organizationId)
      .all();
    const migration = env.TEST_MIGRATIONS?.find((item) =>
      item.name.includes("0111_checkout_payment_profiles"),
    );
    expect(migration).toBeDefined();
    await env.BILLING_DB.batch(migration!.queries.map((query) => env.BILLING_DB.prepare(query)));
    // 0111 predates backend identity. Restore only the later profile additions
    // and execution scope trigger after rehearsing its table rebuild.
    const backendMigration = env.TEST_MIGRATIONS!.find((item) => item.name.startsWith("0119_"))!;
    const restore = backendMigration.queries.filter((query) =>
      /ALTER TABLE provider_customer_profiles ADD COLUMN|CREATE TRIGGER provider_customer_profiles_backend_immutable|CREATE TRIGGER provider_customer_profiles_commerce_identity_guard|CREATE TRIGGER easy_pay_direct_automatic_execution_scope_guard/u.test(
        query,
      ),
    );
    await env.BILLING_DB.batch([
      env.BILLING_DB.prepare("DROP TRIGGER easy_pay_direct_automatic_execution_scope_guard"),
      ...restore.map((query) => env.BILLING_DB.prepare(query)),
    ]);
    expect(
      (
        await env.BILLING_DB.prepare(
          "SELECT * FROM provider_customer_profiles WHERE organization_id = ?",
        )
          .bind(organizationId)
          .all()
      ).results,
    ).toEqual(before.results);
    expect((await env.BILLING_DB.prepare("PRAGMA foreign_key_check").all()).results).toEqual([]);
  });

  it.each(["one-time", "unscoped", "invalid-profile"])(
    "dunning collects eligible monthly debt without mixing %s debt",
    async (variant) => {
      const campaign = await seedDunningCreatorFixture();
      const other = await addDunningDebt(variant);
      await processDunningCampaigns(
        scopedEnv(),
        new Date().toISOString(),
        "actual-dunning-creator",
      );
      const request = await env.BILLING_DB.prepare(
        "SELECT id, amount_minor FROM payment_requests WHERE organization_id = ? AND source = 'dunning'",
      )
        .bind(organizationId)
        .first<{ id: string; amount_minor: number }>();
      expect(request?.amount_minor).toBe(900);
      expect(
        await env.BILLING_DB.prepare(
          "SELECT last_dunning_campaign_attempt FROM customers WHERE id = ?",
        )
          .bind(campaign.customerId)
          .first(),
      ).toEqual({ last_dunning_campaign_attempt: 1 });
      expect(
        await env.BILLING_DB.prepare(
          "SELECT invoice_id FROM invoices_payment_requests WHERE payment_request_id = ?",
        )
          .bind(request!.id)
          .all(),
      ).toMatchObject({ results: [{ invoice_id: invoiceId }] });
      const charge = vi.fn<typeof fetch>(async (url) =>
        approvedGatewayResponse(url, `dunning-${request!.id}`, request!.id),
      );
      expect(await processEasyPayDirectAutomaticCollection(scopedEnv(), request!.id, charge)).toBe(
        "processed",
      );
      expect(charge).toHaveBeenCalledTimes(2);
      expect(
        await env.BILLING_DB.prepare(
          "SELECT payment_status, total_due_minor FROM invoices WHERE id = ?",
        )
          .bind(other.invoiceId)
          .first(),
      ).toEqual({ payment_status: "failed", total_due_minor: 900 });
      expect(
        await env.BILLING_DB.prepare(
          "SELECT last_dunning_campaign_attempt FROM customers WHERE id = ?",
        )
          .bind(campaign.customerId)
          .first(),
      ).toEqual({ last_dunning_campaign_attempt: 0 });
    },
  );

  it("does not consume a dunning attempt without eligible EPD debt or below the eligible threshold", async () => {
    const campaign = await seedDunningCreatorFixture();
    await addDunningDebt("one-time");
    await env.BILLING_DB.prepare(
      "UPDATE dunning_campaign_thresholds SET amount_minor = 1000 WHERE dunning_campaign_id = ?",
    )
      .bind(campaign.id)
      .run();
    await processDunningCampaigns(
      scopedEnv(),
      new Date().toISOString(),
      "eligible-below-threshold",
    );
    await env.BILLING_DB.prepare(
      "UPDATE easy_pay_direct_automatic_collection_scopes SET status = 'disabled' WHERE organization_id = ?",
    )
      .bind(organizationId)
      .run();
    await processDunningCampaigns(scopedEnv(), new Date().toISOString(), "no-eligible-debt");
    expect(
      await env.BILLING_DB.prepare(
        "SELECT COUNT(*) AS count FROM payment_requests WHERE organization_id = ? AND source = 'dunning'",
      )
        .bind(organizationId)
        .first(),
    ).toEqual({ count: 0 });
    expect(
      await env.BILLING_DB.prepare(
        "SELECT last_dunning_campaign_attempt FROM customers WHERE id = ?",
      )
        .bind(campaign.customerId)
        .first(),
    ).toEqual({ last_dunning_campaign_attempt: 0 });
  });

  it("durably holds mixed valid profiles without consuming attempts and resolves only proven single-profile debt", async () => {
    const campaign = await seedDunningCreatorFixture();
    const other = await addDunningDebt("mixed-profile");
    const now = new Date().toISOString();
    await processDunningCampaigns(scopedEnv(), now, "mixed-profile-hold");
    const hold = () =>
      env.BILLING_DB.prepare(
        "SELECT status, reason, resolved_at FROM epd_dunning_review_holds WHERE organization_id = ? AND customer_id = ?",
      )
        .bind(organizationId, campaign.customerId)
        .first();
    expect(await hold()).toEqual({
      status: "held",
      reason: "multiple_eligible_provider_profiles",
      resolved_at: null,
    });
    expect(
      await env.BILLING_DB.prepare(
        "SELECT last_dunning_campaign_attempt FROM customers WHERE id = ?",
      )
        .bind(campaign.customerId)
        .first(),
    ).toEqual({ last_dunning_campaign_attempt: 0 });
    expect(
      await env.BILLING_DB.prepare(
        "SELECT COUNT(*) AS count FROM payment_requests WHERE organization_id = ? AND source = 'dunning'",
      )
        .bind(organizationId)
        .first(),
    ).toEqual({ count: 0 });
    await env.BILLING_DB.prepare(
      "UPDATE provider_customer_profiles SET status = 'disabled' WHERE organization_id = ?",
    )
      .bind(organizationId)
      .run();
    await processDunningCampaigns(scopedEnv(), now, "empty-is-not-resolved");
    expect(await hold()).toMatchObject({ status: "held", resolved_at: null });
    await env.BILLING_DB.prepare(
      "UPDATE provider_customer_profiles SET status = 'active' WHERE id = (SELECT payment_method_id FROM subscriptions WHERE id = (SELECT subscription_id FROM invoices WHERE id = ?))",
    )
      .bind(invoiceId)
      .run();
    await processDunningCampaigns(scopedEnv(), now, "single-profile-resolved");
    expect(await hold()).toMatchObject({ status: "resolved", resolved_at: now });
    expect(
      await env.BILLING_DB.prepare(
        "SELECT amount_minor FROM payment_requests WHERE organization_id = ? AND source = 'dunning'",
      )
        .bind(organizationId)
        .first(),
    ).toEqual({ amount_minor: 900 });
    expect(
      await env.BILLING_DB.prepare(
        "SELECT COUNT(*) AS count FROM invoices_payment_requests WHERE invoice_id = ?",
      )
        .bind(other.invoiceId)
        .first(),
    ).toEqual({ count: 0 });
  });

  it.each(["scope", "profile", "one-time", "balance", "version", "closure"])(
    "atomically refuses dunning when %s changes after selection",
    async (fault) => {
      const campaign = await seedDunningCreatorFixture();
      let mutated = false;
      const database = new Proxy(env.BILLING_DB, {
        get(target, property) {
          if (property === "prepare")
            return (sql: string) =>
              target.prepare(
                sql.replace(
                  "WHERE customer.id > ?",
                  `WHERE customer.organization_id = '${organizationId}' AND customer.id > ?`,
                ),
              );
          if (property === "batch")
            return async (statements: D1PreparedStatement[]) => {
              if (!mutated) {
                mutated = true;
                const sql =
                  fault === "scope"
                    ? "UPDATE easy_pay_direct_automatic_collection_scopes SET status = 'disabled' WHERE organization_id = ?"
                    : fault === "profile"
                      ? "UPDATE provider_customer_profiles SET status = 'disabled' WHERE organization_id = ?"
                      : fault === "one-time"
                        ? "UPDATE plans SET interval = 'one_time' WHERE organization_id = ?"
                        : fault === "balance"
                          ? "UPDATE invoices SET total_due_minor = 800, credits_minor = 100 WHERE organization_id = ?"
                          : fault === "version"
                            ? "UPDATE invoices SET version = version + 1 WHERE organization_id = ?"
                            : "INSERT INTO customer_closure_holds (customer_id, organization_id) SELECT id, organization_id FROM customers WHERE organization_id = ?";
                await target.prepare(sql).bind(organizationId).run();
              }
              return target.batch(statements);
            };
          const value = Reflect.get(target, property);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
      const runtime = new Proxy(scopedEnv(), {
        get(target, property, receiver) {
          return property === "BILLING_DB" ? database : Reflect.get(target, property, receiver);
        },
      });
      await expect(
        processDunningCampaigns(runtime, new Date().toISOString(), "selection-race"),
      ).resolves.toMatchObject({ requestsCreated: 0 });
      expect(mutated).toBe(true);
      expect(
        await env.BILLING_DB.prepare(
          "SELECT COUNT(*) AS count FROM payment_requests WHERE organization_id = ? AND source = 'dunning'",
        )
          .bind(organizationId)
          .first(),
      ).toEqual({ count: 0 });
      expect(
        await env.BILLING_DB.prepare(
          "SELECT last_dunning_campaign_attempt FROM customers WHERE id = ?",
        )
          .bind(campaign.customerId)
          .first(),
      ).toEqual({ last_dunning_campaign_attempt: 0 });
      expect(
        await env.BILLING_DB.prepare(
          "SELECT COUNT(*) AS count FROM epd_dunning_attempt_fences",
        ).first(),
      ).toEqual({ count: 0 });
    },
  );

  it.each(["organization", "account", "missing"])(
    "fences %s credential scope before preparation, charge, recovery and dunning",
    async (fault) => {
      await prepareEasyPayDirectAutomaticCollection(enabledEnv(), invoiceId, "configured-scope");
      const requestId = (await automaticPaymentRequestId(invoiceId))!;
      const execution = await env.BILLING_DB.prepare(
        "SELECT id FROM easy_pay_direct_automatic_payment_executions WHERE payment_request_id = ?",
      )
        .bind(requestId)
        .first<{ id: string }>();
      const send = vi.fn(async (_event: unknown) => {});
      const foreign = new Proxy(recoveryFixtureEnv(send), {
        get(target, property, receiver) {
          if (property === "EASY_PAY_DIRECT_ORGANIZATION_ID" && fault !== "account")
            return fault === "missing" ? "" : "foreign-organization";
          if (property === "EASY_PAY_DIRECT_ACCOUNT_CODE" && fault === "account")
            return "foreign-account";
          return Reflect.get(target, property, receiver);
        },
      });
      const provider = vi.fn<typeof fetch>();
      expect(
        await prepareEasyPayDirectAutomaticCollection(
          foreign,
          invoiceId,
          "foreign-prepare",
          provider,
        ),
      ).toBe("not_applicable");
      expect(await processEasyPayDirectAutomaticCollection(foreign, requestId, provider)).toBe(
        "not_applicable",
      );
      await agePendingRenewal(requestId);
      expect(
        await redispatchPendingEasyPayDirectAutomaticCollections(foreign, "foreign-recovery"),
      ).toBe(0);
      await env.BILLING_DB.prepare(
        "UPDATE easy_pay_direct_automatic_payment_executions SET status = 'unknown' WHERE id = ?",
      )
        .bind(execution!.id)
        .run();
      expect(await pendingEasyPayDirectAutomaticExecutions(foreign)).toEqual([]);
      expect(
        await reconcileEasyPayDirectAutomaticCollection(foreign, execution!.id, provider),
      ).toBe("not_applicable");
      expect(await pendingEasyPayDirectAutomaticExecutions(enabledEnv())).toContain(execution!.id);
      await env.BILLING_DB.prepare(
        "UPDATE easy_pay_direct_automatic_payment_executions SET status = 'failed' WHERE id = ?",
      )
        .bind(execution!.id)
        .run();
      const campaign = await seedDunningCreatorFixture();
      await processDunningCampaigns(foreign, new Date().toISOString(), "foreign-dunning");
      expect(
        await env.BILLING_DB.prepare(
          "SELECT last_dunning_campaign_attempt FROM customers WHERE id = ?",
        )
          .bind(campaign.customerId)
          .first(),
      ).toEqual({ last_dunning_campaign_attempt: 0 });
      expect(provider).not.toHaveBeenCalled();
      expect(send).not.toHaveBeenCalled();
    },
  );

  it("recovers an acknowledged pending renewal after automatic collection is re-enabled", async () => {
    await prepareEasyPayDirectAutomaticCollection(enabledEnv(), invoiceId, "before-disable");
    const requestId = (await automaticPaymentRequestId(invoiceId))!;
    expect(await processEasyPayDirectAutomaticCollection(disabledEnv(), requestId)).toBe(
      "not_applicable",
    );
    // The queue consumer acknowledges not_applicable and records this original identity.
    await env.BILLING_DB.batch([
      env.BILLING_DB.prepare(
        "INSERT INTO processed_messages (event_id,event_type,processed_at) VALUES (?, 'payment_request.created', ?)",
      ).bind(`payment-request-created:${requestId}:v1`, new Date().toISOString()),
      env.BILLING_DB.prepare(
        "UPDATE outbox_events SET published_at = ? WHERE aggregate_id = ?",
      ).bind(new Date().toISOString(), requestId),
    ]);
    await agePendingRenewal(requestId);
    const send = vi.fn(async (_event: unknown) => {});
    const runtime = recoveryFixtureEnv(send);
    expect(await redispatchPendingEasyPayDirectAutomaticCollections(runtime, "reenabled")).toBe(1);
    const event = send.mock.calls[0]![0] as { id: string; aggregateId: string };
    expect(event.aggregateId).toBe(requestId);
    expect(event.id).not.toBe(`payment-request-created:${requestId}:v1`);
    const charge = vi.fn<typeof fetch>(async (url) =>
      approvedGatewayResponse(url, `recovered-${requestId}`, requestId),
    );
    expect(await processEasyPayDirectAutomaticCollection(runtime, event.aggregateId, charge)).toBe(
      "processed",
    );
    expect(await processEasyPayDirectAutomaticCollection(runtime, event.aggregateId, charge)).toBe(
      "processed",
    );
    expect(charge).toHaveBeenCalledTimes(2);
    expect(await redispatchPendingEasyPayDirectAutomaticCollections(runtime, "repeat")).toBe(0);
  });

  it("atomically rotates concurrent pending redispatch and preserves an unsent durable outbox", async () => {
    await prepareEasyPayDirectAutomaticCollection(enabledEnv(), invoiceId, "recovery-race");
    const requestId = (await automaticPaymentRequestId(invoiceId))!;
    await agePendingRenewal(requestId);
    const send = vi.fn(async (_event: unknown) => {});
    const runtime = recoveryFixtureEnv(send);
    const counts = await Promise.all([
      redispatchPendingEasyPayDirectAutomaticCollections(runtime, "one"),
      redispatchPendingEasyPayDirectAutomaticCollections(runtime, "two"),
    ]);
    expect(counts.reduce((sum, value) => sum + value, 0)).toBe(1);
    expect(send).toHaveBeenCalledOnce();
    await agePendingRenewal(requestId);
    send.mockRejectedValueOnce(new Error("queue unavailable"));
    await expect(
      redispatchPendingEasyPayDirectAutomaticCollections(runtime, "send-failure"),
    ).rejects.toThrow("queue unavailable");
    expect(
      await env.BILLING_DB.prepare(
        "SELECT status FROM easy_pay_direct_automatic_payment_executions WHERE payment_request_id = ?",
      )
        .bind(requestId)
        .first(),
    ).toEqual({ status: "pending" });
    expect(
      await env.BILLING_DB.prepare(
        "SELECT COUNT(*) AS count FROM outbox_events WHERE aggregate_id = ? AND correlation_id = 'send-failure' AND published_at IS NULL",
      )
        .bind(requestId)
        .first(),
    ).toEqual({ count: 1 });
    expect(await redispatchPendingEasyPayDirectAutomaticCollections(runtime, "too-soon")).toBe(0);
  });

  it.each(["processing", "unknown", "failed", "succeeded"])(
    "never redispatches a %s execution",
    async (status) => {
      await prepareEasyPayDirectAutomaticCollection(enabledEnv(), invoiceId, "terminal-recovery");
      const requestId = (await automaticPaymentRequestId(invoiceId))!;
      await agePendingRenewal(requestId);
      await env.BILLING_DB.prepare(
        "UPDATE easy_pay_direct_automatic_payment_executions SET status = ? WHERE payment_request_id = ?",
      )
        .bind(status, requestId)
        .run();
      const send = vi.fn(async (_event: unknown) => {});
      expect(
        await redispatchPendingEasyPayDirectAutomaticCollections(
          recoveryFixtureEnv(send),
          "no-replay",
        ),
      ).toBe(0);
      expect(send).not.toHaveBeenCalled();
    },
  );

  it.each(["disabled", "mutations-off", "one-time", "invalid-profile", "scope-off"])(
    "keeps recovered %s work from charging",
    async (fault) => {
      await prepareEasyPayDirectAutomaticCollection(enabledEnv(), invoiceId, "recovery-guard");
      const requestId = (await automaticPaymentRequestId(invoiceId))!;
      await agePendingRenewal(requestId);
      const send = vi.fn(async (_event: unknown) => {});
      let runtime = recoveryFixtureEnv(send);
      if (fault === "disabled" || fault === "mutations-off" || fault === "scope-off") {
        runtime = new Proxy(runtime, {
          get(target, property, receiver) {
            if (fault === "disabled" && property === "EASY_PAY_DIRECT_AUTOMATIC_COLLECTION_ENABLED")
              return "0";
            if (fault === "mutations-off" && property === "PAYMENT_MUTATIONS_ENABLED") return "0";
            if (
              fault === "scope-off" &&
              property === "EASY_PAY_DIRECT_AUTOMATIC_COLLECTION_SCOPE_MODE"
            )
              return "scoped";
            return Reflect.get(target, property, receiver);
          },
        });
      } else
        await env.BILLING_DB.prepare(
          fault === "one-time"
            ? "UPDATE plans SET interval = 'one_time' WHERE organization_id = ?"
            : "UPDATE provider_customer_profiles SET status = 'disabled' WHERE organization_id = ?",
        )
          .bind(organizationId)
          .run();
      const queued = await redispatchPendingEasyPayDirectAutomaticCollections(runtime, "guard");
      const charge = vi.fn<typeof fetch>();
      if (fault === "disabled" || fault === "mutations-off") {
        expect(queued).toBe(0);
        expect(send).not.toHaveBeenCalled();
      } else {
        expect(queued).toBe(1);
        expect(await processEasyPayDirectAutomaticCollection(runtime, requestId, charge)).toBe(
          "deferred",
        );
      }
      expect(charge).not.toHaveBeenCalled();
    },
  );

  it.each(["provider", "customer-account"])(
    "does not charge a prepared renewal after the %s changes",
    async (fault) => {
      const runtimeEnv = enabledEnv();
      await prepareEasyPayDirectAutomaticCollection(
        runtimeEnv,
        invoiceId,
        "prepared-provider-drift",
      );
      const requestId = (await automaticPaymentRequestId(invoiceId))!;
      const sql =
        fault === "provider"
          ? "UPDATE customers SET payment_provider = 'stripe' WHERE organization_id = ?"
          : "UPDATE customers SET payment_provider_code = 'different-account' WHERE organization_id = ?";
      await env.BILLING_DB.prepare(sql).bind(organizationId).run();
      const charge = vi.fn<typeof fetch>();
      expect(await processEasyPayDirectAutomaticCollection(runtimeEnv, requestId, charge)).toBe(
        "deferred",
      );
      expect(charge).not.toHaveBeenCalled();
    },
  );

  it("rotates a tax-blocked renewal and still prepares the later valid renewal", async () => {
    await seedCommittedBillingDestinationAndTaxRule();
    const blockedId = `blocked-${invoiceId}`;
    const blockedSubscription = `blocked-sub-${invoiceId}`;
    await env.BILLING_DB.batch([
      env.BILLING_DB.prepare(`INSERT INTO subscriptions
        (id, organization_id, customer_id, plan_id, external_id, status, started_at,
         current_period_start, current_period_end, payment_method_type, payment_method_id,
         version, created_at, updated_at)
        SELECT ?, organization_id, customer_id, plan_id, ?, status, started_at,
         current_period_start, current_period_end, payment_method_type, payment_method_id,
         version, created_at, updated_at FROM subscriptions
        WHERE id = (SELECT subscription_id FROM invoices WHERE id = ?)`).bind(
        blockedSubscription,
        blockedSubscription,
        invoiceId,
      ),
      env.BILLING_DB.prepare(`INSERT INTO invoices
        (id, organization_id, customer_id, subscription_id, number, status,
         payment_status, currency, subtotal_minor, tax_minor, credits_minor,
         total_due_minor, version, finalized_at, payment_overdue,
         ready_for_payment_processing, created_at, updated_at)
        SELECT ?, organization_id, customer_id, ?, ?, status, payment_status,
         currency, subtotal_minor, tax_minor, credits_minor, total_due_minor, version,
         finalized_at, payment_overdue, ready_for_payment_processing, created_at,
         '2000-01-01T00:00:00.000Z' FROM invoices WHERE id = ?`).bind(
        blockedId,
        blockedSubscription,
        blockedId,
        invoiceId,
      ),
    ]);
    const runtimeEnv = candidateFixtureEnv(localTaxEnv());
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      expect(
        await dispatchPendingEasyPayDirectAutomaticCollections(runtimeEnv, "tax-isolation"),
      ).toBe(1);
      expect(await automaticPaymentRequestId(blockedId)).toBeNull();
      expect(await automaticPaymentRequestId(invoiceId)).not.toBeNull();
      const blocked = await env.BILLING_DB.prepare(
        "SELECT updated_at, total_due_minor, version FROM invoices WHERE id = ?",
      )
        .bind(blockedId)
        .first<{ updated_at: string; total_due_minor: number; version: number }>();
      expect(blocked!.updated_at > "2000-01-01T00:00:00.000Z").toBe(true);
      expect(blocked).toMatchObject({ total_due_minor: 900, version: 1 });
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining("easy_pay_direct_automatic_tax_address_missing"),
      );
    } finally {
      warn.mockRestore();
    }
  });

  it("does not swallow unexpected database failures while preparing a renewal", async () => {
    const runtimeEnv = candidateFixtureEnv(localTaxEnv(), true);
    await expect(
      dispatchPendingEasyPayDirectAutomaticCollections(runtimeEnv, "database-error"),
    ).rejects.toThrow("injected database failure");
  });

  it("does not consume a dunning attempt while the preceding renewal outcome is unknown", async () => {
    const runtimeEnv = enabledEnv();
    await prepareEasyPayDirectAutomaticCollection(runtimeEnv, invoiceId, "unknown-before-dunning");
    const initialRequest = (await automaticPaymentRequestId(invoiceId))!;
    await processEasyPayDirectAutomaticCollection(
      runtimeEnv,
      initialRequest,
      vi.fn<typeof fetch>(async () => {
        throw new TypeError("ambiguous renewal transport");
      }),
    );
    const now = new Date().toISOString();
    const campaign = `campaign-${organizationId}`;
    await env.BILLING_DB.batch([
      env.BILLING_DB.prepare("UPDATE invoices SET payment_overdue = 1 WHERE id = ?").bind(
        invoiceId,
      ),
      env.BILLING_DB.prepare(`INSERT INTO dunning_campaigns
        (id, organization_id, code, name, bcc_emails_json, days_between_attempts,
         max_attempts, active, version, request_sha256, created_at, updated_at)
        VALUES (?, ?, ?, 'Unknown outcome guard', '[]', 1, 3, 1, 1, ?, ?, ?)`).bind(
        campaign,
        organizationId,
        campaign,
        "f".repeat(64),
        now,
        now,
      ),
      env.BILLING_DB.prepare(`INSERT INTO dunning_campaign_thresholds
        (id, organization_id, dunning_campaign_id, amount_minor, currency, created_at, updated_at)
        VALUES (?, ?, ?, 1, 'USD', ?, ?)`).bind(
        `threshold-${organizationId}`,
        organizationId,
        campaign,
        now,
        now,
      ),
      env.BILLING_DB.prepare(
        "UPDATE customers SET applied_dunning_campaign_id = ? WHERE organization_id = ?",
      ).bind(campaign, organizationId),
    ]);
    await processDunningCampaigns(env, now, "unknown-dunning-review");
    expect(
      await env.BILLING_DB.prepare(
        "SELECT COUNT(*) AS count FROM payment_requests WHERE organization_id = ? AND source = 'dunning'",
      )
        .bind(organizationId)
        .first(),
    ).toEqual({ count: 0 });
    expect(
      await env.BILLING_DB.prepare(
        "SELECT last_dunning_campaign_attempt FROM customers WHERE organization_id = ?",
      )
        .bind(organizationId)
        .first(),
    ).toEqual({ last_dunning_campaign_attempt: 0 });
  });

  it.each(["account", "empty-vault", "empty-initial"])(
    "excludes an unusable %s profile before the renewal candidate limit",
    async (fault) => {
      const sql =
        fault === "account"
          ? "UPDATE customers SET payment_provider_code = 'different-account' WHERE organization_id = ?"
          : fault === "empty-vault"
            ? "UPDATE provider_customer_profiles SET gateway_customer_vault_id = '' WHERE organization_id = ?"
            : "UPDATE provider_customer_profiles SET initial_transaction_id = '' WHERE organization_id = ?";
      await env.BILLING_DB.prepare(sql).bind(organizationId).run();
      expect(
        await pendingEasyPayDirectAutomaticCollectionInvoices(env.BILLING_DB, "all", {
          organizationId,
          accountCode: "epd-renewal-test",
        }),
      ).not.toContain(invoiceId);
      expect(
        await prepareEasyPayDirectAutomaticCollection(
          enabledEnv(),
          invoiceId,
          "invalid-profile-review",
        ),
      ).toBe("not_applicable");
      expect(await automaticPaymentRequestId(invoiceId)).toBeNull();
    },
  );

  it("preserves a paid renewal and its profile when a stale failure follows interrupted finalization", async () => {
    const runtimeEnv = enabledEnv();
    await prepareEasyPayDirectAutomaticCollection(runtimeEnv, invoiceId, "stale-renewal-failure");
    const requestId = (await automaticPaymentRequestId(invoiceId))!;
    const transactionId = `paid-${requestId}`;
    const charge = vi.fn<typeof fetch>(async (url) =>
      approvedGatewayResponse(url, transactionId, requestId),
    );
    await processEasyPayDirectAutomaticCollection(runtimeEnv, requestId, charge);
    await env.BILLING_DB.prepare(
      "UPDATE easy_pay_direct_automatic_payment_executions SET status = 'unknown', completed_at = NULL WHERE payment_request_id = ?",
    )
      .bind(requestId)
      .run();
    const execution = await env.BILLING_DB.prepare(
      "SELECT id FROM easy_pay_direct_automatic_payment_executions WHERE payment_request_id = ?",
    )
      .bind(requestId)
      .first<{ id: string }>();
    const reader = (failed: boolean) =>
      vi.fn<typeof fetch>(
        async () =>
          new Response(
            `<nm_response><transaction><transaction_id>${transactionId}</transaction_id><order_id>${requestId}</order_id><condition>${failed ? "failed" : "complete"}</condition><currency>USD</currency><action><action_type>sale</action_type><amount>9.00</amount><success>${failed ? "0" : "1"}</success>${failed ? "<response_code>300</response_code><response_text>Invalid Customer Vault ID</response_text>" : ""}</action></transaction></nm_response>`,
          ),
      );
    await reconcileEasyPayDirectAutomaticCollection(runtimeEnv, execution!.id, reader(true));
    expect(await providerProfileState()).toEqual({ status: "active" });
    expect(await collectionState(invoiceId)).toMatchObject({
      execution_status: "unknown",
      request_status: "succeeded",
    });
    await reconcileEasyPayDirectAutomaticCollection(runtimeEnv, execution!.id, reader(false));
    expect(await collectionState(invoiceId)).toMatchObject({
      execution_status: "succeeded",
      request_status: "succeeded",
    });
    expect(charge).toHaveBeenCalledTimes(2);
  });

  it.each(["missing-amount", "missing-currency", "wrong-amount", "wrong-currency"])(
    "keeps an uncertain renewal unpaid when the provider read has %s",
    async (fault) => {
      const runtimeEnv = enabledEnv();
      await prepareEasyPayDirectAutomaticCollection(runtimeEnv, invoiceId, "read-evidence-review");
      const requestId = (await automaticPaymentRequestId(invoiceId))!;
      const charge = vi.fn<typeof fetch>(async () => {
        throw new TypeError("fixture timeout");
      });
      await processEasyPayDirectAutomaticCollection(runtimeEnv, requestId, charge);
      const execution = await env.BILLING_DB.prepare(
        "SELECT id FROM easy_pay_direct_automatic_payment_executions WHERE payment_request_id = ?",
      )
        .bind(requestId)
        .first<{ id: string }>();
      const amount =
        fault === "missing-amount"
          ? ""
          : `<amount>${fault === "wrong-amount" ? "10.00" : "9.00"}</amount>`;
      const currency =
        fault === "missing-currency"
          ? ""
          : `<currency>${fault === "wrong-currency" ? "EUR" : "USD"}</currency>`;
      const read = vi.fn<typeof fetch>(
        async () =>
          new Response(
            `<nm_response><transaction><transaction_id>fixture-${requestId}</transaction_id><order_id>${requestId}</order_id><condition>complete</condition>${currency}<action><action_type>sale</action_type>${amount}<success>1</success></action></transaction></nm_response>`,
          ),
      );
      await expect(
        reconcileEasyPayDirectAutomaticCollection(runtimeEnv, execution!.id, read),
      ).resolves.toBe("deferred");
      expect(
        await env.BILLING_DB.prepare("SELECT payment_status FROM payment_requests WHERE id = ?")
          .bind(requestId)
          .first(),
      ).toEqual({ payment_status: "pending" });
      expect(charge).toHaveBeenCalledOnce();
    },
  );

  it("records and defers a failed renewal provider read so it cannot monopolize the oldest slot", async () => {
    const runtimeEnv = enabledEnv();
    await prepareEasyPayDirectAutomaticCollection(runtimeEnv, invoiceId, "read-outage-review");
    const requestId = (await automaticPaymentRequestId(invoiceId))!;
    await processEasyPayDirectAutomaticCollection(
      runtimeEnv,
      requestId,
      vi.fn<typeof fetch>(async () => {
        throw new TypeError("fixture timeout");
      }),
    );
    await env.BILLING_DB.prepare(
      "UPDATE easy_pay_direct_automatic_payment_executions SET updated_at = '2000-01-01T00:00:00.000Z' WHERE payment_request_id = ?",
    )
      .bind(requestId)
      .run();
    const execution = await env.BILLING_DB.prepare(
      "SELECT id FROM easy_pay_direct_automatic_payment_executions WHERE payment_request_id = ?",
    )
      .bind(requestId)
      .first<{ id: string }>();
    await expect(
      reconcileEasyPayDirectAutomaticCollection(
        runtimeEnv,
        execution!.id,
        vi.fn<typeof fetch>(async () => new Response("unavailable", { status: 503 })),
      ),
    ).resolves.toBe("deferred");
    const state = await env.BILLING_DB.prepare(
      "SELECT updated_at, last_provider_read_at, status FROM easy_pay_direct_automatic_payment_executions WHERE id = ?",
    )
      .bind(execution!.id)
      .first<{ updated_at: string; last_provider_read_at: string; status: string }>();
    expect(state?.updated_at).not.toBe("2000-01-01T00:00:00.000Z");
    expect(state?.last_provider_read_at).toBeTruthy();
    expect(state?.status).toBe("unknown");
  });

  it("does not let a historical manual scope authorize a product-scoped renewal", async () => {
    await enableAutomaticCollectionScope();
    expect(
      await pendingEasyPayDirectAutomaticCollectionInvoices(env.BILLING_DB, "scoped", {
        organizationId,
        accountCode: "epd-renewal-test",
      }),
    ).toContain(invoiceId);
    expect(
      await pendingEasyPayDirectAutomaticCollectionInvoices(env.BILLING_DB, "product_scoped", {
        organizationId,
        accountCode: "epd-renewal-test",
      }),
    ).not.toContain(invoiceId);
    const runtimeEnv = new Proxy(enabledEnv(), {
      get(target, property, receiver) {
        if (property === "EASY_PAY_DIRECT_AUTOMATIC_COLLECTION_SCOPE_MODE") return "product_scoped";
        return Reflect.get(target, property, receiver) as unknown;
      },
    }) as Env;
    await expect(
      prepareEasyPayDirectAutomaticCollection(runtimeEnv, invoiceId, "unattributed"),
    ).resolves.toBe("not_applicable");
  });
  it("does not include one-time invoices in the automatic renewal candidate scan", async () => {
    await expect(
      pendingEasyPayDirectAutomaticCollectionInvoices(env.BILLING_DB, "all", {
        organizationId,
        accountCode: "epd-renewal-test",
      }),
    ).resolves.toContain(invoiceId);
    await env.BILLING_DB.prepare(
      `UPDATE plans SET interval = 'one_time', updated_at = ?
       WHERE id = (SELECT plan_id FROM subscriptions WHERE id =
         (SELECT subscription_id FROM invoices WHERE id = ?))`,
    )
      .bind(new Date().toISOString(), invoiceId)
      .run();

    await expect(
      pendingEasyPayDirectAutomaticCollectionInvoices(env.BILLING_DB, "all", {
        organizationId,
        accountCode: "epd-renewal-test",
      }),
    ).resolves.not.toContain(invoiceId);
    await expect(
      prepareEasyPayDirectAutomaticCollection(enabledEnv(), invoiceId, "one-time-test"),
    ).resolves.toBe("not_applicable");
  });

  it("refuses placeholder vault references before creating a payment request", async () => {
    await env.BILLING_DB.prepare(
      `UPDATE provider_customer_profiles
       SET gateway_customer_vault_id = 'vault-test-placeholder'
       WHERE organization_id = ?`,
    )
      .bind(organizationId)
      .run();

    await expect(
      prepareEasyPayDirectAutomaticCollection(enabledEnv(), invoiceId, "placeholder-vault-test"),
    ).resolves.toBe("not_applicable");
    await expect(automaticPaymentRequestId(invoiceId)).resolves.toBeNull();
  });

  it("holds closure pending until an already claimed renewal is reconciled", async () => {
    await prepareEasyPayDirectAutomaticCollection(enabledEnv(), invoiceId, "closure-flight-test");
    await env.BILLING_DB.prepare(
      "UPDATE easy_pay_direct_automatic_payment_executions SET status = 'unknown' WHERE organization_id = ?",
    )
      .bind(organizationId)
      .run();
    const customer = await env.BILLING_DB.prepare(
      "SELECT external_id FROM customers WHERE organization_id = ?",
    )
      .bind(organizationId)
      .first<{ external_id: string }>();
    const response = await holdCustomerForClosure(
      env.BILLING_DB,
      { organizationId, organizationExternalId: organizationId, apiKeyId: "test" },
      customer!.external_id,
      "flight-test",
    );
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({ closure: { held: true, ready: false } });
  });

  it("does not dispatch a prepared renewal after the closure hold commits", async () => {
    const runtimeEnv = enabledEnv();
    await prepareEasyPayDirectAutomaticCollection(runtimeEnv, invoiceId, "closure-test");
    await env.BILLING_DB.prepare(
      "INSERT INTO customer_closure_holds (customer_id, organization_id) SELECT id, organization_id FROM customers WHERE organization_id = ?",
    )
      .bind(organizationId)
      .run();
    const providerFetch = vi.fn<typeof fetch>();
    await expect(
      processEasyPayDirectAutomaticCollection(
        runtimeEnv,
        (await automaticPaymentRequestId(invoiceId))!,
        providerFetch,
      ),
    ).resolves.toBe("deferred");
    expect(providerFetch).not.toHaveBeenCalled();
  });

  it("charges a vaulted method as a merchant-initiated recurring payment exactly once", async () => {
    const runtimeEnv = enabledEnv();
    await env.BILLING_DB.prepare(
      "UPDATE provider_customer_profiles SET gateway_billing_id = '123456' WHERE organization_id = ?",
    )
      .bind(organizationId)
      .run();
    await expect(
      prepareEasyPayDirectAutomaticCollection(runtimeEnv, invoiceId, "renewal-test"),
    ).resolves.toBe("processed");
    const paymentRequestId = (await automaticPaymentRequestId(invoiceId))!;
    const providerFetch = vi.fn<typeof fetch>(async (input, init) => {
      if (String(input).endsWith("query.php"))
        return approvedGatewayResponse(input, "renewal-approved", paymentRequestId);
      expect(String(input)).toContain("/api/transact.php");
      const body = new URLSearchParams(String(init?.body));
      expect(body.get("customer_vault_id")).toMatch(/^vault-/);
      expect(body.get("billing_id")).toBe("123456");
      expect(body.get("initial_transaction_id")).toMatch(/^initial-/);
      expect(body.get("billing_method")).toBe("recurring");
      expect(body.get("initiated_by")).toBe("merchant");
      expect(body.get("stored_credential_indicator")).toBe("used");
      expect(body.get("test_mode")).toBe("enabled");
      expect(body.get("amount")).toBe("9.00");
      expect(body.has("payment_token")).toBe(false);
      expect(body.has("ccnumber")).toBe(false);
      expect(body.has("cvv")).toBe(false);
      return new Response(
        `response=1&responsetext=Approved&response_code=100&transactionid=renewal-approved&orderid=${paymentRequestId}`,
      );
    });
    await expect(
      processEasyPayDirectAutomaticCollection(runtimeEnv, paymentRequestId, providerFetch),
    ).resolves.toBe("processed");
    await expect(
      processEasyPayDirectAutomaticCollection(runtimeEnv, paymentRequestId, providerFetch),
    ).resolves.toBe("processed");
    expect(providerFetch).toHaveBeenCalledTimes(2);
    await expect(collectionState(invoiceId)).resolves.toMatchObject({
      execution_status: "succeeded",
      invoice_status: "succeeded",
      request_status: "succeeded",
      attempt_count: 1,
    });
  });

  it.each(["wrong-amount", "wrong-currency", "wrong-id", "outage"])(
    "holds an approved renewal with %s evidence without repeating sale",
    async (fault) => {
      const runtime = enabledEnv();
      await prepareEasyPayDirectAutomaticCollection(runtime, invoiceId, "approval-evidence");
      const requestId = (await automaticPaymentRequestId(invoiceId))!;
      let saleCount = 0;
      const fetcher = vi.fn<typeof fetch>(async (url) => {
        if (!String(url).endsWith("query.php")) {
          saleCount++;
          return approvedGatewayResponse(url, `approved-${fault}`, requestId);
        }
        expect(
          await env.BILLING_DB.prepare(
            "SELECT provider_transaction_id, status FROM easy_pay_direct_automatic_payment_executions WHERE payment_request_id = ?",
          )
            .bind(requestId)
            .first(),
        ).toEqual({ provider_transaction_id: `approved-${fault}`, status: "unknown" });
        if (fault === "outage") throw new Error("unavailable");
        let body = await approvedGatewayResponse(url, `approved-${fault}`, requestId).text();
        body =
          fault === "wrong-amount"
            ? body.replace("9.00", "1.00")
            : fault === "wrong-currency"
              ? body.replace("USD", "EUR")
              : body.replace(`approved-${fault}`, "other-id");
        return new Response(body);
      });
      expect(await processEasyPayDirectAutomaticCollection(runtime, requestId, fetcher)).toBe(
        "deferred",
      );
      expect(await processEasyPayDirectAutomaticCollection(runtime, requestId, fetcher)).toBe(
        "deferred",
      );
      expect(saleCount).toBe(1);
      expect(await collectionState(invoiceId)).toMatchObject({
        execution_status: "unknown",
        request_status: "pending",
      });
    },
  );

  it("treats yearly plans as recurring and preserves the invoice amount", async () => {
    await env.BILLING_DB.prepare(
      `UPDATE plans SET interval = 'yearly', updated_at = ?
       WHERE organization_id = ?
         AND id = (
           SELECT subscription.plan_id
           FROM subscriptions subscription
           JOIN invoices invoice ON invoice.subscription_id = subscription.id
           WHERE invoice.id = ? AND invoice.organization_id = ?
         )`,
    )
      .bind(new Date().toISOString(), organizationId, invoiceId, organizationId)
      .run();

    await expect(
      prepareEasyPayDirectAutomaticCollection(enabledEnv(), invoiceId, "yearly-renewal-test"),
    ).resolves.toBe("processed");
    const paymentRequestId = await automaticPaymentRequestId(invoiceId);
    await expect(
      env.BILLING_DB.prepare("SELECT amount_minor, currency FROM payment_requests WHERE id = ?")
        .bind(paymentRequestId)
        .first(),
    ).resolves.toEqual({ amount_minor: 900, currency: "USD" });
  });

  it("records a definitive decline once and leaves the invoice eligible for dunning", async () => {
    const runtimeEnv = enabledEnv();
    await prepareEasyPayDirectAutomaticCollection(runtimeEnv, invoiceId, "decline-test");
    const paymentRequestId = (await automaticPaymentRequestId(invoiceId))!;
    const providerFetch = vi.fn<typeof fetch>(async () =>
      Promise.resolve(
        new Response(
          `response=2&responsetext=Declined&response_code=200&transactionid=renewal-declined&orderid=${paymentRequestId}`,
        ),
      ),
    );
    await expect(
      processEasyPayDirectAutomaticCollection(runtimeEnv, paymentRequestId, providerFetch),
    ).resolves.toBe("processed");
    await expect(collectionState(invoiceId)).resolves.toMatchObject({
      execution_status: "failed",
      invoice_status: "failed",
      request_status: "failed",
      ready_for_payment_processing: 1,
      attempt_count: 1,
    });
  });

  it.each([
    { http: 503, body: "response=3&response_code=300&responsetext=Invalid+Customer+Vault+ID" },
    { http: 503, body: "response=2&response_code=200&transactionid=decline" },
    { http: 503, body: "response=1&response_code=100&transactionid=approved" },
    ...["420", "421", "430", "999"].map((code) => ({
      http: 200,
      body: `response=3&response_code=${code}`,
    })),
    { http: 200, body: "response=2" },
    { http: 200, body: "response=99&response_code=300&responsetext=Invalid+Customer+Vault+ID" },
    {
      http: 200,
      body: "response=1&response_code=300&transactionid=0&responsetext=Invalid+Customer+Vault+ID",
    },
    { http: 200, body: "response=3&response_code=300&authcode=approved" },
    { http: 200, body: "response=3&response_code=300&transactionid=existing" },
    { http: 200, body: "response=1&response_code=100&transactionid=0" },
    { http: 200, body: "response=3&response_code=300&response_code=420" },
  ])(
    "holds ambiguous Gateway renewal without disabling profile or reopening charging %j",
    async ({ http, body }) => {
      const runtime = enabledEnv();
      await prepareEasyPayDirectAutomaticCollection(runtime, invoiceId, "ambiguous-gateway-status");
      const requestId = (await automaticPaymentRequestId(invoiceId))!;
      const provider = vi.fn<typeof fetch>(async () => new Response(body, { status: http }));
      expect(await processEasyPayDirectAutomaticCollection(runtime, requestId, provider)).toBe(
        "deferred",
      );
      expect(await processEasyPayDirectAutomaticCollection(runtime, requestId, provider)).toBe(
        "deferred",
      );
      expect(provider).toHaveBeenCalledOnce();
      expect(await collectionState(invoiceId)).toMatchObject({
        execution_status: "unknown",
        request_status: "pending",
        attempt_count: 1,
      });
      expect(await providerProfileState()).toEqual({ status: "active" });
      expect(
        await env.BILLING_DB.prepare(
          "SELECT COUNT(*) AS count FROM payment_request_payments WHERE payment_request_id = ?",
        )
          .bind(requestId)
          .first(),
      ).toEqual({ count: 0 });
      const execution = await env.BILLING_DB.prepare(
        "SELECT id FROM easy_pay_direct_automatic_payment_executions WHERE payment_request_id = ?",
      )
        .bind(requestId)
        .first<{ id: string }>();
      const reader = vi.fn<typeof fetch>(async (url) => {
        expect(String(url)).toContain("/api/query.php");
        return new Response("<nm_response></nm_response>");
      });
      expect(await reconcileEasyPayDirectAutomaticCollection(runtime, execution!.id, reader)).toBe(
        "deferred",
      );
      expect(reader).toHaveBeenCalledOnce();
      expect(await collectionState(invoiceId)).toMatchObject({ execution_status: "unknown" });
      expect(await providerProfileState()).toEqual({ status: "active" });
    },
  );

  it("never resubmits an unknown charge and converges through the provider query API", async () => {
    const runtimeEnv = enabledEnv();
    await prepareEasyPayDirectAutomaticCollection(runtimeEnv, invoiceId, "unknown-test");
    const paymentRequestId = (await automaticPaymentRequestId(invoiceId))!;
    const failedSubmit = vi.fn<typeof fetch>(async () => {
      throw new Error("connection reset after request");
    });
    await expect(
      processEasyPayDirectAutomaticCollection(runtimeEnv, paymentRequestId, failedSubmit),
    ).resolves.toBe("deferred");
    await expect(
      processEasyPayDirectAutomaticCollection(runtimeEnv, paymentRequestId, failedSubmit),
    ).resolves.toBe("deferred");
    expect(failedSubmit).toHaveBeenCalledOnce();

    const execution = await env.BILLING_DB.prepare(
      `SELECT id FROM easy_pay_direct_automatic_payment_executions
       WHERE payment_request_id = ?`,
    )
      .bind(paymentRequestId)
      .first<{ id: string }>();
    const providerRead = vi.fn<typeof fetch>(async (input, init) => {
      expect(String(input)).toContain("/api/query.php");
      expect(new URLSearchParams(String(init?.body)).get("order_id")).toBe(paymentRequestId);
      return new Response(
        `<nm_response><transaction><transaction_id>renewal-reconciled</transaction_id><order_id>${paymentRequestId}</order_id><condition>complete</condition><currency>USD</currency><action><action_type>sale</action_type><amount>9.00</amount><success>1</success><response_code>100</response_code><response_text>Approved</response_text></action></transaction></nm_response>`,
      );
    });
    await expect(
      reconcileEasyPayDirectAutomaticCollection(runtimeEnv, execution!.id, providerRead),
    ).resolves.toBe("processed");
    await expect(collectionState(invoiceId)).resolves.toMatchObject({
      execution_status: "succeeded",
      invoice_status: "succeeded",
      request_status: "succeeded",
      attempt_count: 1,
    });
  });

  it("records a definitive invalid-vault response once and disables the unusable profile", async () => {
    const runtimeEnv = enabledEnv();
    await prepareEasyPayDirectAutomaticCollection(runtimeEnv, invoiceId, "invalid-vault-test");
    const paymentRequestId = (await automaticPaymentRequestId(invoiceId))!;
    const providerFetch = vi.fn<typeof fetch>(
      async () =>
        new Response(
          `response=3&responsetext=Invalid Customer Vault ID specified&response_code=300&orderid=${paymentRequestId}`,
        ),
    );

    await expect(
      processEasyPayDirectAutomaticCollection(runtimeEnv, paymentRequestId, providerFetch),
    ).resolves.toBe("processed");
    await expect(
      processEasyPayDirectAutomaticCollection(runtimeEnv, paymentRequestId, providerFetch),
    ).resolves.toBe("processed");
    expect(providerFetch).toHaveBeenCalledOnce();
    await expect(collectionState(invoiceId)).resolves.toMatchObject({
      execution_status: "failed",
      invoice_status: "failed",
      request_status: "failed",
      attempt_count: 1,
    });
    await expect(automaticExecutionProviderTransactionId()).resolves.toBeNull();
    await expect(providerProfileState()).resolves.toEqual({ status: "disabled" });
    // Simulate the ledger committing followed by a crash before execution finalization.
    const execution = await env.BILLING_DB.prepare(
      `UPDATE easy_pay_direct_automatic_payment_executions SET status = 'unknown'
       WHERE payment_request_id = ? RETURNING id`,
    )
      .bind(paymentRequestId)
      .first<{ id: string }>();
    const providerRead = vi.fn<typeof fetch>();
    await expect(
      reconcileEasyPayDirectAutomaticCollection(runtimeEnv, execution!.id, providerRead),
    ).resolves.toBe("processed");
    expect(providerRead).not.toHaveBeenCalled();
    await expect(collectionState(invoiceId)).resolves.toMatchObject({
      execution_status: "failed",
      attempt_count: 1,
    });
  });

  it.each([null, "2020-01-01T00:00:00.000Z"])(
    "does not resubmit a processing execution with lease %s",
    async (lease) => {
      await prepareEasyPayDirectAutomaticCollection(enabledEnv(), invoiceId, "crash-test");
      const requestId = (await automaticPaymentRequestId(invoiceId))!;
      await env.BILLING_DB.prepare(
        `UPDATE easy_pay_direct_automatic_payment_executions
         SET status = 'processing', attempt_count = 1, lease_expires_at = ?
         WHERE payment_request_id = ?`,
      )
        .bind(lease, requestId)
        .run();
      const providerFetch = vi.fn<typeof fetch>();
      await expect(
        processEasyPayDirectAutomaticCollection(enabledEnv(), requestId, providerFetch),
      ).resolves.toBe("deferred");
      expect(providerFetch).not.toHaveBeenCalled();
      await expect(collectionState(invoiceId)).resolves.toMatchObject({ attempt_count: 1 });
    },
  );

  it.each(["one_time", "canceled", "unscoped", "disabled_profile"])(
    "rechecks %s eligibility after preparation and before submitting",
    async (change) => {
      await enableAutomaticCollectionScope();
      await prepareEasyPayDirectAutomaticCollection(scopedEnv(), invoiceId, "recheck-test");
      const requestId = (await automaticPaymentRequestId(invoiceId))!;
      const sql =
        change === "one_time"
          ? "UPDATE plans SET interval = 'one_time' WHERE organization_id = ?"
          : change === "canceled"
            ? "UPDATE subscriptions SET status = 'canceled' WHERE organization_id = ?"
            : change === "unscoped"
              ? "UPDATE easy_pay_direct_automatic_collection_scopes SET status = 'disabled' WHERE organization_id = ?"
              : "UPDATE provider_customer_profiles SET status = 'disabled' WHERE organization_id = ?";
      await env.BILLING_DB.prepare(sql).bind(organizationId).run();
      const providerFetch = vi.fn<typeof fetch>();
      await expect(
        processEasyPayDirectAutomaticCollection(scopedEnv(), requestId, providerFetch),
      ).resolves.toBe("deferred");
      expect(providerFetch).not.toHaveBeenCalled();
      await expect(collectionState(invoiceId)).resolves.toMatchObject({ attempt_count: 0 });
    },
  );

  it("does not disable a profile refreshed after the failed execution was prepared", async () => {
    await prepareEasyPayDirectAutomaticCollection(enabledEnv(), invoiceId, "refreshed-profile");
    const requestId = (await automaticPaymentRequestId(invoiceId))!;
    const execution = await env.BILLING_DB.prepare(
      `UPDATE easy_pay_direct_automatic_payment_executions SET status = 'unknown',
       failure_code = '300', failure_message = 'Invalid Customer Vault ID specified'
       WHERE payment_request_id = ? RETURNING id`,
    )
      .bind(requestId)
      .first<{ id: string }>();
    await env.BILLING_DB.prepare(
      "UPDATE provider_customer_profiles SET gateway_customer_vault_id = 'refreshed-vault' WHERE organization_id = ?",
    )
      .bind(organizationId)
      .run();
    await expect(
      reconcileEasyPayDirectAutomaticCollection(enabledEnv(), execution!.id, vi.fn<typeof fetch>()),
    ).resolves.toBe("processed");
    await expect(providerProfileState()).resolves.toEqual({ status: "active" });
  });

  it("converges a legacy invalid-vault unknown without another provider read", async () => {
    const runtimeEnv = enabledEnv();
    await prepareEasyPayDirectAutomaticCollection(runtimeEnv, invoiceId, "legacy-invalid-vault");
    const paymentRequestId = (await automaticPaymentRequestId(invoiceId))!;
    const execution = await env.BILLING_DB.prepare(
      `UPDATE easy_pay_direct_automatic_payment_executions
       SET status = 'unknown', attempt_count = 1, failure_code = '300',
           failure_message = 'Invalid Customer Vault ID specified', updated_at = ?
       WHERE payment_request_id = ? RETURNING id`,
    )
      .bind(new Date().toISOString(), paymentRequestId)
      .first<{ id: string }>();
    const providerRead = vi.fn<typeof fetch>();

    await expect(
      reconcileEasyPayDirectAutomaticCollection(runtimeEnv, execution!.id, providerRead),
    ).resolves.toBe("processed");
    expect(providerRead).not.toHaveBeenCalled();
    await expect(collectionState(invoiceId)).resolves.toMatchObject({
      execution_status: "failed",
      invoice_status: "failed",
      request_status: "failed",
      attempt_count: 1,
    });
    await expect(providerProfileState()).resolves.toEqual({ status: "disabled" });
  });

  it("is fail-closed when the automatic collection gate is disabled", async () => {
    await expect(
      prepareEasyPayDirectAutomaticCollection(disabledEnv(), invoiceId, "disabled-test"),
    ).resolves.toBe("not_applicable");
    await expect(automaticPaymentRequestId(invoiceId)).resolves.toBeNull();
  });

  it("requires an explicit subscription scope in scoped rollout mode", async () => {
    const runtimeEnv = scopedEnv();
    await expect(
      prepareEasyPayDirectAutomaticCollection(runtimeEnv, invoiceId, "scoped-before-enable"),
    ).resolves.toBe("not_applicable");
    await expect(automaticPaymentRequestId(invoiceId)).resolves.toBeNull();

    await enableAutomaticCollectionScope();

    await expect(
      prepareEasyPayDirectAutomaticCollection(runtimeEnv, invoiceId, "scoped-after-enable"),
    ).resolves.toBe("processed");
    await expect(automaticPaymentRequestId(invoiceId)).resolves.not.toBeNull();
  });

  it.each(["collect", "off"])(
    "recalculates its subscription tax with collection %s",
    async (collectionMode) => {
      await seedCommittedBillingDestinationAndTaxRule();
      await env.BILLING_DB.prepare(
        "UPDATE indirect_tax_registration_scopes SET collection_mode = ? WHERE organization_id = ?",
      )
        .bind(collectionMode, organizationId)
        .run();
      const runtimeEnv = localTaxEnv();
      await expect(
        prepareEasyPayDirectAutomaticCollection(runtimeEnv, invoiceId, "tax-renewal-test"),
      ).resolves.toBe("processed");
      await expect(
        env.BILLING_DB.prepare(
          `SELECT invoice.tax_minor, invoice.total_due_minor, invoice.version,
                request.amount_minor, quote.billing_country, quote.billing_state,
                quote.billing_postal_code, quote.tax_minor AS quote_tax_minor
         FROM invoices invoice
         JOIN invoices_payment_requests link ON link.invoice_id = invoice.id
         JOIN payment_requests request ON request.id = link.payment_request_id
         JOIN easy_pay_direct_automatic_tax_quotes quote ON quote.invoice_id = invoice.id
         WHERE invoice.id = ?`,
        )
          .bind(invoiceId)
          .first(),
      ).resolves.toEqual({
        tax_minor: collectionMode === "off" ? 0 : 90,
        total_due_minor: collectionMode === "off" ? 900 : 990,
        version: 2,
        amount_minor: collectionMode === "off" ? 900 : 990,
        billing_country: "US",
        billing_state: "WA",
        billing_postal_code: "98104",
        quote_tax_minor: collectionMode === "off" ? 0 : 90,
      });
      expect(
        await env.BILLING_DB.prepare(
          "SELECT SUM(amount_minor) AS tax,SUM(taxable_base_minor) AS base FROM invoice_line_taxes WHERE invoice_id=?",
        )
          .bind(invoiceId)
          .first(),
      ).toEqual({ tax: collectionMode === "off" ? 0 : 90, base: 900 });
    },
  );

  it("refunds a taxed successful renewal using its saved quote and fee tax snapshots", async () => {
    await seedCommittedBillingDestinationAndTaxRule();
    const runtimeEnv = localTaxEnv();
    await prepareEasyPayDirectAutomaticCollection(runtimeEnv, invoiceId, "taxed-refund");
    const requestId = (await automaticPaymentRequestId(invoiceId))!;
    const gateway = vi.fn<typeof fetch>(
      async (url) =>
        new Response(
          String(url).endsWith("query.php")
            ? `<nm_response><transaction><transaction_id>taxed-renewal-transaction</transaction_id><order_id>${requestId}</order_id><condition>complete</condition><currency>USD</currency><action><action_type>sale</action_type><amount>9.90</amount><success>1</success></action></transaction></nm_response>`
            : `response=1&response_code=100&transactionid=taxed-renewal-transaction&orderid=${requestId}`,
        ),
    );
    expect(await processEasyPayDirectAutomaticCollection(runtimeEnv, requestId, gateway)).toBe(
      "processed",
    );
    const fee = await env.BILLING_DB.prepare("SELECT id FROM invoice_lines WHERE invoice_id=?")
      .bind(invoiceId)
      .first<{ id: string }>();
    // Only local synthetic refund execution; not provider-refund proof.
    const refundEnv = new Proxy(runtimeEnv, {
      get(target, key, receiver) {
        return key === "CREDIT_NOTE_REFUND_MODE" ? "sandbox" : Reflect.get(target, key, receiver);
      },
    });
    for (let index = 0; index < 2; index++) {
      const response = await createCreditNote(
        new Request("https://lago.test/api/v1/credit_notes", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Idempotency-Key": `taxed-refund-${invoiceId}-${index}`,
          },
          body: JSON.stringify({
            credit_note: {
              invoice_id: invoiceId,
              refund_amount_cents: 495,
              items: [{ fee_id: fee!.id, amount_cents: 450 }],
            },
          }),
        }),
        refundEnv,
        { organizationId, organizationExternalId: organizationId, apiKeyId: "fictional" },
        `taxed-refund-${index}`,
      );
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        credit_note: {
          refund_status: "succeeded",
          refund_amount_cents: 495,
          taxes_amount_cents: 45,
        },
      });
    }
    expect(
      await env.BILLING_DB.prepare(
        "SELECT SUM(financial.refund_amount_minor) AS total FROM credit_notes note JOIN credit_note_financials financial ON financial.credit_note_id=note.id WHERE note.invoice_id=?",
      )
        .bind(invoiceId)
        .first(),
    ).toEqual({ total: 990 });
  });

  it("decrypts and re-resolves a Washington address for a recurring invoice", async () => {
    await seedCommittedBillingDestinationAndTaxRule(true, "wa_dor_address");
    const authority = vi.fn<typeof fetch>(
      async () =>
        new Response(
          `<response result="2" loccode="1726" rate="0.102500">
           <rate staterate="0.065000" localrate="0.037500" period="Q32026"
                 jurisdiction="SEATTLE" county="KING" />
           <results location="700 FIFTH AVE" city="SEATTLE" zip="98104" plus4="" />
         </response>`,
          { headers: { "content-type": "application/xml" } },
        ),
    );
    await expect(
      prepareEasyPayDirectAutomaticCollection(
        localTaxEnv(),
        invoiceId,
        "washington-renewal",
        authority,
      ),
    ).resolves.toBe("processed");
    expect(authority).toHaveBeenCalledTimes(1);
    await expect(
      env.BILLING_DB.prepare(
        `SELECT invoice.tax_minor, invoice.total_due_minor,
                quote.local_calculation_method, quote.rate_location_code,
                quote.rate_period, quote.state_rate_ppm, quote.local_rate_ppm
         FROM invoices invoice
         JOIN easy_pay_direct_automatic_tax_quotes quote ON quote.invoice_id = invoice.id
         WHERE invoice.id = ?`,
      )
        .bind(invoiceId)
        .first(),
    ).resolves.toEqual({
      tax_minor: 92,
      total_due_minor: 992,
      local_calculation_method: "wa_dor_address",
      rate_location_code: "1726",
      rate_period: "Q32026",
      state_rate_ppm: 65_000,
      local_rate_ppm: 37_500,
    });
  });

  it("refuses a Washington renewal when the stored address key ID is not active", async () => {
    await seedCommittedBillingDestinationAndTaxRule(true, "wa_dor_address");
    const wrongKey = new Proxy(localTaxEnv(), {
      get(target, property, receiver) {
        if (property === "INDIRECT_TAX_ADDRESS_ENCRYPTION_KEY_ID") return "test-v2";
        return Reflect.get(target, property, receiver) as unknown;
      },
    }) as Env;
    const authority = vi.fn<typeof fetch>();
    await expect(
      prepareEasyPayDirectAutomaticCollection(
        wrongKey,
        invoiceId,
        "washington-wrong-address-key",
        authority,
      ),
    ).rejects.toThrow("easy_pay_direct_automatic_tax_address_unavailable");
    expect(authority).not.toHaveBeenCalled();
    await expect(automaticPaymentRequestId(invoiceId)).resolves.toBeNull();
  });

  it("does not borrow a committed tax quote from another purchase by the same customer", async () => {
    await seedCommittedBillingDestinationAndTaxRule(false);
    await expect(
      prepareEasyPayDirectAutomaticCollection(localTaxEnv(), invoiceId, "wrong-source"),
    ).rejects.toThrow("easy_pay_direct_automatic_tax_address_missing");
    await expect(automaticPaymentRequestId(invoiceId)).resolves.toBeNull();
  });

  it.each(["eligible", "one_time", "unscoped", "mixed_scope", "unknown", "in_flight"])(
    "checks every invoice in a %s dunning request",
    async (scenario) => {
      const runtimeEnv = enabledEnv();
      await prepareEasyPayDirectAutomaticCollection(runtimeEnv, invoiceId, "dunning-initial");
      const initialRequestId = (await automaticPaymentRequestId(invoiceId))!;
      if (scenario !== "in_flight")
        await processEasyPayDirectAutomaticCollection(
          runtimeEnv,
          initialRequestId,
          vi.fn<typeof fetch>(async () => {
            if (scenario === "unknown") throw new TypeError("ambiguous renewal transport");
            return new Response(
              `response=2&responsetext=Declined&response_code=200&transactionid=dunning-initial-decline-${initialRequestId}&orderid=${initialRequestId}`,
            );
          }),
        );
      const invoice = await env.BILLING_DB.prepare(
        "SELECT customer_id, version FROM invoices WHERE id = ?",
      )
        .bind(invoiceId)
        .first<{ customer_id: string; version: number }>();
      const fixture = crypto.randomUUID();
      const campaignId = `campaign-${fixture}`;
      const thresholdId = `threshold-${fixture}`;
      const dunningRequestId = `dunning-request-${fixture}`;
      const now = new Date().toISOString();
      await env.BILLING_DB.batch([
        env.BILLING_DB.prepare(
          "UPDATE invoices SET payment_overdue = 1 WHERE id = ? AND organization_id = ?",
        ).bind(invoiceId, organizationId),
        env.BILLING_DB.prepare(
          `INSERT INTO dunning_campaigns
         (id, organization_id, code, name, bcc_emails_json, days_between_attempts,
          max_attempts, active, version, request_sha256, created_at, updated_at)
         VALUES (?, ?, ?, 'Renewal retry', '[]', 1, 3, 1, 1, ?, ?, ?)`,
        ).bind(campaignId, organizationId, campaignId, "f".repeat(64), now, now),
        env.BILLING_DB.prepare(
          `INSERT INTO dunning_campaign_thresholds
         (id, organization_id, dunning_campaign_id, amount_minor, currency,
          created_at, updated_at)
         VALUES (?, ?, ?, 1, 'USD', ?, ?)`,
        ).bind(thresholdId, organizationId, campaignId, now, now),
        env.BILLING_DB.prepare(
          `INSERT INTO payment_requests
         (id, organization_id, customer_id, amount_minor, currency, email, payment_attempts,
          payment_status, ready_for_payment_processing, version, source,
          dunning_campaign_id, dunning_campaign_threshold_id, dunning_attempt,
          collection_mode, created_at, updated_at)
         VALUES (?, ?, ?, 900, 'USD', 'renewal@example.test', 0, 'pending', 1, 1,
                 'dunning', ?, ?, 1, 'overdue', ?, ?)`,
        ).bind(
          dunningRequestId,
          organizationId,
          invoice!.customer_id,
          campaignId,
          thresholdId,
          now,
          now,
        ),
        env.BILLING_DB.prepare(
          `INSERT INTO invoices_payment_requests
         (id, organization_id, payment_request_id, invoice_id, invoice_version,
          created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        ).bind(
          `dunning-link-${fixture}`,
          organizationId,
          dunningRequestId,
          invoiceId,
          invoice!.version,
          now,
          now,
        ),
      ]);
      const providerFetch = vi.fn<typeof fetch>(async (url) =>
        approvedGatewayResponse(url, `dunning-approved-${fixture}`, dunningRequestId),
      );
      if (scenario === "in_flight") {
        const pausedEnv = new Proxy(runtimeEnv, {
          get(target, property, receiver) {
            return property === "PAYMENT_MUTATIONS_ENABLED"
              ? "0"
              : Reflect.get(target, property, receiver);
          },
        });
        expect(
          await processEasyPayDirectAutomaticCollection(pausedEnv, dunningRequestId, providerFetch),
        ).toBe("deferred");
        let entered!: () => void;
        let release!: () => void;
        const started = new Promise<void>((resolve) => {
          entered = resolve;
        });
        const blocked = new Promise<void>((resolve) => {
          release = resolve;
        });
        const initialCharge = processEasyPayDirectAutomaticCollection(
          runtimeEnv,
          initialRequestId,
          vi.fn<typeof fetch>(async () => {
            entered();
            await blocked;
            throw new TypeError("uncertain first charge");
          }),
        );
        await started;
        try {
          expect(
            await processEasyPayDirectAutomaticCollection(
              runtimeEnv,
              dunningRequestId,
              providerFetch,
            ),
          ).toBe("deferred");
          expect(providerFetch).not.toHaveBeenCalled();
        } finally {
          release();
        }
        await initialCharge;
        return;
      }
      if (scenario === "one_time") {
        await env.BILLING_DB.prepare(
          "UPDATE plans SET interval = 'one_time' WHERE organization_id = ?",
        )
          .bind(organizationId)
          .run();
      }
      if (scenario === "mixed_scope") {
        await enableAutomaticCollectionScope();
        await env.BILLING_DB.batch([
          env.BILLING_DB.prepare(
            `INSERT INTO subscriptions
           (id, organization_id, customer_id, plan_id, external_id, status, started_at,
            current_period_start, current_period_end, payment_method_type, payment_method_id,
            version, created_at, updated_at)
           SELECT ?, organization_id, customer_id, plan_id, ?, status, started_at,
             current_period_start, current_period_end, payment_method_type, payment_method_id,
             version, created_at, updated_at FROM subscriptions WHERE organization_id = ?`,
          ).bind(`unscoped-${fixture}`, `unscoped-${fixture}`, organizationId),
          env.BILLING_DB.prepare(
            `INSERT INTO invoices
           (id, organization_id, customer_id, subscription_id, number, status, payment_status,
            currency, subtotal_minor, tax_minor, credits_minor, total_due_minor, version,
            ready_for_payment_processing, payment_overdue, created_at, updated_at)
           SELECT ?, organization_id, customer_id, ?, ?, status, payment_status,
             currency, subtotal_minor, tax_minor, credits_minor, total_due_minor, version,
               ready_for_payment_processing, payment_overdue, created_at, updated_at FROM invoices WHERE id = ?`,
          ).bind(
            `unscoped-invoice-${fixture}`,
            `unscoped-${fixture}`,
            `UNSCOPED-${fixture}`,
            invoiceId,
          ),
          env.BILLING_DB.prepare(
            `INSERT INTO invoices_payment_requests
           (id, organization_id, payment_request_id, invoice_id, invoice_version, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
          ).bind(
            `unscoped-link-${fixture}`,
            organizationId,
            dunningRequestId,
            `unscoped-invoice-${fixture}`,
            invoice!.version,
            now,
            now,
          ),
        ]);
      }
      if (scenario !== "eligible") {
        await expect(
          processEasyPayDirectAutomaticCollection(
            scenario === "one_time" || scenario === "unknown" ? runtimeEnv : scopedEnv(),
            dunningRequestId,
            providerFetch,
          ),
        ).resolves.toBe("not_applicable");
        expect(providerFetch).not.toHaveBeenCalled();
        await expect(
          env.BILLING_DB.prepare(
            "SELECT COUNT(*) AS count FROM easy_pay_direct_automatic_payment_executions WHERE payment_request_id = ?",
          )
            .bind(dunningRequestId)
            .first(),
        ).resolves.toEqual({ count: 0 });
        return;
      }
      await expect(
        processEasyPayDirectAutomaticCollection(runtimeEnv, dunningRequestId, providerFetch),
      ).resolves.toBe("processed");
      expect(providerFetch).toHaveBeenCalledTimes(2);
      await expect(
        env.BILLING_DB.prepare(
          `SELECT request.payment_status AS request_status,
                execution.status AS execution_status, invoice.payment_status AS invoice_status
         FROM payment_requests request
         JOIN easy_pay_direct_automatic_payment_executions execution
           ON execution.payment_request_id = request.id
         JOIN invoices_payment_requests link ON link.payment_request_id = request.id
         JOIN invoices invoice ON invoice.id = link.invoice_id
         WHERE request.id = ?`,
        )
          .bind(dunningRequestId)
          .first(),
      ).resolves.toEqual({
        request_status: "succeeded",
        execution_status: "succeeded",
        invoice_status: "succeeded",
      });
    },
  );
});

describe("Commerce Elements Lago-controlled renewals", () => {
  it("reopens only GET recovery for later exact same-order success after a failed renewal", async () => {
    const fixture = await commerceFixture();
    await prepareEasyPayDirectAutomaticCollection(fixture.runtime, invoiceId, "commerce-renewal");
    const execution = (await commerceExecution())!;
    await processEasyPayDirectAutomaticCollection(
      fixture.runtime,
      execution.payment_request_id,
      commerceFetcher(fixture, "declined"),
    );
    expect(await commerceExecution()).toMatchObject({
      status: "failed",
      commerce_order_id: fixture.order,
    });
    const order = {
      id: fixture.order,
      customer_id: fixture.customer,
      payment_method: { id: fixture.method },
      status: "succeeded",
      total: 900,
      currency: "usd",
      transactions: [],
      metadata: {
        lago_automatic_execution_id: execution.id,
        lago_payment_request_id: execution.payment_request_id,
      },
    };
    const input = {
      organizationId,
      accountCode: "epd-renewal-test",
      paymentRequestId: execution.payment_request_id,
      executionId: execution.id,
      order,
    };
    expect(
      await reconcileElementsAutomaticWebhook(env.BILLING_DB, {
        ...input,
        order: { ...order, id: crypto.randomUUID() },
      }),
    ).toBe(false);
    expect(
      await reconcileElementsAutomaticWebhook(env.BILLING_DB, {
        ...input,
        order: { ...order, status: "failed" },
      }),
    ).toBe(true);
    expect(await commerceExecution()).toMatchObject({ status: "failed" });
    expect(await reconcileElementsAutomaticWebhook(env.BILLING_DB, input)).toBe(true);
    expect(await commerceExecution()).toMatchObject({ status: "unknown" });
    const reader = commerceFetcher(fixture);
    await processEasyPayDirectAutomaticCollection(
      fixture.runtime,
      execution.payment_request_id,
      reader,
    );
    expect(reader).not.toHaveBeenCalled();
    await reconcileEasyPayDirectAutomaticCollection(fixture.runtime, execution.id, reader);
    expect(reader.mock.calls).toHaveLength(1);
    expect(reader.mock.calls[0]![1]?.method).toBe("GET");
    expect(await commerceExecution()).toMatchObject({ status: "succeeded" });
    expect(
      await reconcileElementsAutomaticWebhook(env.BILLING_DB, {
        ...input,
        order: { ...order, status: "failed" },
      }),
    ).toBe(true);
    expect(await commerceExecution()).toMatchObject({ status: "succeeded" });
  });
  it("recovers only an exact authenticated webhook handle after a lost order response, then settles via GET", async () => {
    const fixture = await commerceFixture();
    await prepareEasyPayDirectAutomaticCollection(fixture.runtime, invoiceId, "commerce-renewal");
    const execution = (await commerceExecution())!;
    const order = {
      id: fixture.order,
      customer_id: fixture.customer,
      payment_method: { id: fixture.method },
      status: "succeeded",
      total: 900,
      currency: "usd",
      transactions: [],
      metadata: {
        lago_automatic_execution_id: execution.id,
        lago_payment_request_id: execution.payment_request_id,
      },
    };
    const input = {
      organizationId,
      accountCode: "epd-renewal-test",
      paymentRequestId: execution.payment_request_id,
      executionId: execution.id,
      order,
    };
    expect(await reconcileElementsAutomaticWebhook(env.BILLING_DB, input)).toBe(false);
    await processEasyPayDirectAutomaticCollection(
      fixture.runtime,
      execution.payment_request_id,
      commerceFetcher(fixture, "lost-order"),
    );
    expect(
      await reconcileElementsAutomaticWebhook(env.BILLING_DB, {
        ...input,
        organizationId: "foreign",
      }),
    ).toBe(false);
    expect(
      await reconcileElementsAutomaticWebhook(env.BILLING_DB, { ...input, accountCode: "foreign" }),
    ).toBe(false);
    expect(
      await reconcileElementsAutomaticWebhook(env.BILLING_DB, {
        ...input,
        order: { ...order, metadata: { ...order.metadata, lago_payment_request_id: "foreign" } },
      }),
    ).toBe(false);
    await expect(
      reconcileElementsAutomaticWebhook(env.BILLING_DB, {
        ...input,
        order: { ...order, customer_id: crypto.randomUUID() },
      }),
    ).rejects.toThrow();
    await expect(
      reconcileElementsAutomaticWebhook(env.BILLING_DB, {
        ...input,
        order: { ...order, total: 901 },
      }),
    ).rejects.toThrow();
    expect(await commerceExecution()).toMatchObject({ status: "unknown", commerce_order_id: null });
    expect(await reconcileElementsAutomaticWebhook(env.BILLING_DB, input)).toBe(true);
    expect(await reconcileElementsAutomaticWebhook(env.BILLING_DB, input)).toBe(true);
    expect(await commerceExecution()).toMatchObject({
      status: "unknown",
      commerce_order_id: fixture.order,
    });
    const reader = commerceFetcher(fixture);
    await reconcileEasyPayDirectAutomaticCollection(fixture.runtime, execution.id, reader);
    expect(reader.mock.calls).toHaveLength(1);
    expect(reader.mock.calls[0]![1]?.method).toBe("GET");
    expect(await commerceExecution()).toMatchObject({ status: "succeeded" });
    expect(await reconcileElementsAutomaticWebhook(env.BILLING_DB, input)).toBe(true);
    expect(
      await reconcileElementsAutomaticWebhook(env.BILLING_DB, {
        ...input,
        order: { ...order, id: crypto.randomUUID() },
      }),
    ).toBe(false);
  });
  it("blocks a saved Commerce profile disabled after preparation", async () => {
    const fixture = await commerceFixture();
    await prepareEasyPayDirectAutomaticCollection(fixture.runtime, invoiceId, "commerce-renewal");
    const execution = (await commerceExecution())!;
    await env.BILLING_DB.prepare(
      "UPDATE provider_customer_profiles SET status = 'disabled' WHERE organization_id = ? AND payment_backend = 'commerce_elements'",
    )
      .bind(organizationId)
      .run();
    const noCalls = vi.fn<typeof fetch>();
    await processEasyPayDirectAutomaticCollection(
      fixture.runtime,
      execution.payment_request_id,
      noCalls,
    );
    expect(noCalls).not.toHaveBeenCalled();
    expect(await commerceExecution()).toMatchObject({ status: "pending" });
  });
  it("records a definitive Commerce decline once without marking the saved method as an invalid Gateway vault", async () => {
    const fixture = await commerceFixture();
    await prepareEasyPayDirectAutomaticCollection(fixture.runtime, invoiceId, "commerce-renewal");
    const execution = (await commerceExecution())!;
    const fetcher = commerceFetcher(fixture, "declined");
    await processEasyPayDirectAutomaticCollection(
      fixture.runtime,
      execution.payment_request_id,
      fetcher,
    );
    await processEasyPayDirectAutomaticCollection(
      fixture.runtime,
      execution.payment_request_id,
      fetcher,
    );
    expect(await commerceExecution()).toMatchObject({
      status: "failed",
      commerce_order_id: fixture.order,
    });
    expect(fetcher.mock.calls.filter(([url]) => String(url).endsWith("/orders"))).toHaveLength(1);
    expect(
      await env.BILLING_DB.prepare(
        "SELECT status FROM provider_customer_profiles WHERE organization_id = ? AND payment_backend = 'commerce_elements'",
      )
        .bind(organizationId)
        .first(),
    ).toEqual({ status: "active" });
  });
  it("does not submit an order when the product read no longer matches the renewal amount", async () => {
    const fixture = await commerceFixture();
    await prepareEasyPayDirectAutomaticCollection(fixture.runtime, invoiceId, "commerce-renewal");
    const execution = (await commerceExecution())!;
    const fetcher = commerceFetcher(fixture, "changed-product");
    await processEasyPayDirectAutomaticCollection(
      fixture.runtime,
      execution.payment_request_id,
      fetcher,
    );
    expect(fetcher.mock.calls.some(([url]) => String(url).includes("/orders"))).toBe(false);
    expect(await commerceExecution()).toMatchObject({ status: "unknown", commerce_order_id: null });
  });
  it("does not repeat a charge when the post-response order checkpoint write fails", async () => {
    const fixture = await commerceFixture();
    await prepareEasyPayDirectAutomaticCollection(fixture.runtime, invoiceId, "commerce-renewal");
    const execution = (await commerceExecution())!;
    const failingDb = new Proxy(env.BILLING_DB, {
      get(target, key, receiver) {
        if (key === "prepare")
          return (sql: string) => {
            if (sql.includes("SET commerce_order_id ="))
              throw new Error("fictional checkpoint unavailable");
            return target.prepare(sql);
          };
        return Reflect.get(target, key, receiver);
      },
    });
    const runtime = new Proxy(fixture.runtime, {
      get(target, key, receiver) {
        return key === "BILLING_DB" ? failingDb : Reflect.get(target, key, receiver);
      },
    });
    const fetcher = commerceFetcher(fixture);
    await processEasyPayDirectAutomaticCollection(runtime, execution.payment_request_id, fetcher);
    expect(await commerceExecution()).toMatchObject({ status: "unknown", commerce_order_id: null });
    await processEasyPayDirectAutomaticCollection(
      fixture.runtime,
      execution.payment_request_id,
      fetcher,
    );
    await reconcileEasyPayDirectAutomaticCollection(fixture.runtime, execution.id, fetcher);
    expect(fetcher.mock.calls.filter(([url]) => String(url).endsWith("/orders"))).toHaveLength(1);
  });
  it("charges a saved Commerce method once without Gateway calls or a second subscription scheduler", async () => {
    const fixture = await commerceFixture();
    await prepareEasyPayDirectAutomaticCollection(fixture.runtime, invoiceId, "commerce-renewal");
    const execution = (await commerceExecution())!;
    const fetcher = commerceFetcher(fixture);
    await Promise.all([
      processEasyPayDirectAutomaticCollection(
        fixture.runtime,
        execution.payment_request_id,
        fetcher,
      ),
      processEasyPayDirectAutomaticCollection(
        fixture.runtime,
        execution.payment_request_id,
        fetcher,
      ),
    ]);
    expect(
      fetcher.mock.calls.filter(
        ([url, init]) => String(url).endsWith("/orders") && init?.method === "POST",
      ),
    ).toHaveLength(1);
    expect(
      fetcher.mock.calls.every(([url]) => String(url).startsWith("https://api.epd.com/v1/")),
    ).toBe(true);
    expect(fetcher.mock.calls.some(([url]) => String(url).includes("/subscriptions"))).toBe(false);
    const orderCall = fetcher.mock.calls.find(([url]) => String(url).endsWith("/orders"))!;
    expect(JSON.parse(String(orderCall[1]?.body))).toMatchObject({
      customer_id: fixture.customer,
      payment_method_id: fixture.method,
      items: [{ product_id: fixture.product, quantity: 1 }],
      currency: "usd",
    });
    expect(new Headers(orderCall[1]?.headers).get("X-EPD-Idempotency-Key")).toBe(
      execution.order_idempotency_key,
    );
    expect(execution.order_idempotency_key).toMatch(/^[a-f0-9-]{14}4/u);
    expect(await commerceExecution()).toMatchObject({
      status: "succeeded",
      provider_transaction_id: fixture.order,
      commerce_order_id: fixture.order,
    });
  });
  it("checkpoints a mismatched POST outcome and resolves with GET without a second charge", async () => {
    const fixture = await commerceFixture();
    await prepareEasyPayDirectAutomaticCollection(fixture.runtime, invoiceId, "commerce-renewal");
    const execution = (await commerceExecution())!;
    await processEasyPayDirectAutomaticCollection(
      fixture.runtime,
      execution.payment_request_id,
      commerceFetcher(fixture, "wrong-amount"),
    );
    expect(await commerceExecution()).toMatchObject({
      status: "unknown",
      commerce_order_id: fixture.order,
    });
    const reader = commerceFetcher(fixture);
    await reconcileEasyPayDirectAutomaticCollection(fixture.runtime, execution.id, reader);
    expect(reader.mock.calls).toHaveLength(1);
    expect(reader.mock.calls[0]![1]?.method).toBe("GET");
    expect(await commerceExecution()).toMatchObject({ status: "succeeded" });
  });
  it("never re-POSTs after a lost order response, even when its lease or 24-hour key window expires", async () => {
    const fixture = await commerceFixture();
    await prepareEasyPayDirectAutomaticCollection(fixture.runtime, invoiceId, "commerce-renewal");
    const execution = (await commerceExecution())!;
    await processEasyPayDirectAutomaticCollection(
      fixture.runtime,
      execution.payment_request_id,
      commerceFetcher(fixture, "lost-order"),
    );
    expect(await commerceExecution()).toMatchObject({ status: "unknown", commerce_order_id: null });
    const noCalls = vi.fn<typeof fetch>();
    await env.BILLING_DB.prepare(
      "UPDATE easy_pay_direct_automatic_payment_executions SET lease_expires_at = '2020-01-01', updated_at = '2020-01-01' WHERE id = ?",
    )
      .bind(execution.id)
      .run();
    await processEasyPayDirectAutomaticCollection(
      fixture.runtime,
      execution.payment_request_id,
      noCalls,
    );
    await reconcileEasyPayDirectAutomaticCollection(fixture.runtime, execution.id, noCalls);
    expect(noCalls).not.toHaveBeenCalled();
  });
  it.each(["one-time", "unpaid-initial", "disabled-profile", "production"])(
    "does not charge Commerce %s work",
    async (kind) => {
      const fixture = await commerceFixture();
      if (kind === "one-time")
        await env.BILLING_DB.prepare(
          "UPDATE plans SET interval = 'one_time' WHERE organization_id = ?",
        )
          .bind(organizationId)
          .run();
      if (kind === "unpaid-initial")
        await env.BILLING_DB.prepare(
          "UPDATE easy_pay_direct_payment_executions SET status = 'unknown' WHERE organization_id = ?",
        )
          .bind(organizationId)
          .run();
      if (kind === "disabled-profile")
        await env.BILLING_DB.prepare(
          "UPDATE provider_customer_profiles SET status = 'disabled' WHERE organization_id = ? AND payment_backend = 'commerce_elements'",
        )
          .bind(organizationId)
          .run();
      const runtime =
        kind === "production"
          ? new Proxy(fixture.runtime, {
              get(target, key, receiver) {
                return key === "APP_ENV" ? "production" : Reflect.get(target, key, receiver);
              },
            })
          : fixture.runtime;
      await prepareEasyPayDirectAutomaticCollection(runtime, invoiceId, "commerce-renewal");
      const execution = (await commerceExecution())!;
      const noCalls = vi.fn<typeof fetch>();
      if (execution)
        await processEasyPayDirectAutomaticCollection(
          runtime,
          execution.payment_request_id,
          noCalls,
        );
      expect(noCalls).not.toHaveBeenCalled();
      if (kind !== "production") expect(execution).toBeNull();
    },
  );
  it("never converts a legacy profile backend or mutates a prepared Commerce identity", async () => {
    const fixture = await commerceFixture();
    await expect(
      env.BILLING_DB.prepare(
        "UPDATE provider_customer_profiles SET payment_backend = 'commerce_elements' WHERE organization_id = ? AND payment_backend = 'gateway_vault'",
      )
        .bind(organizationId)
        .run(),
    ).rejects.toThrow(/immutable_provider_payment_backend/u);
    await prepareEasyPayDirectAutomaticCollection(fixture.runtime, invoiceId, "commerce-renewal");
    const execution = (await commerceExecution())!;
    await expect(
      env.BILLING_DB.prepare(
        "UPDATE easy_pay_direct_automatic_payment_executions SET commerce_payment_method_id = ? WHERE id = ?",
      )
        .bind(crypto.randomUUID(), execution.id)
        .run(),
    ).rejects.toThrow(/immutable_easy_pay_direct_automatic_execution_identity/u);
  });
});

async function commerceFixture() {
  const source = await env.BILLING_DB.prepare(
    "SELECT customer_id, subscription_id FROM invoices WHERE id = ?",
  )
    .bind(invoiceId)
    .first<{ customer_id: string; subscription_id: string }>();
  const initialRequest = crypto.randomUUID(),
    intent = crypto.randomUUID(),
    initial = crypto.randomUUID(),
    profile = crypto.randomUUID();
  const customer = crypto.randomUUID(),
    method = crypto.randomUUID(),
    product = crypto.randomUUID(),
    order = crypto.randomUUID();
  const now = new Date().toISOString();
  await env.BILLING_DB.batch([
    env.BILLING_DB.prepare(`INSERT INTO payment_requests (id,organization_id,customer_id,amount_minor,currency,email,payment_status,ready_for_payment_processing,version,source,collection_mode,created_at,updated_at)
      VALUES (?,?,?,900,'USD','renewal@example.test','pending',1,1,'manual','checkout',?,?)`).bind(
      initialRequest,
      organizationId,
      source!.customer_id,
      now,
      now,
    ),
    env.BILLING_DB.prepare(`INSERT INTO payment_request_checkout_intents (id,organization_id,payment_request_id,customer_id,provider,provider_account_code,idempotency_key,request_sha256,amount_minor,currency,payment_request_version,status,payment_url,provider_token_sha256,created_at,updated_at)
      VALUES (?,?,?,?,'easy_pay_direct','epd-renewal-test',?,?,900,'USD',1,'succeeded','https://fixture.invalid','fixture-token',?,?)`).bind(
      intent,
      organizationId,
      initialRequest,
      source!.customer_id,
      intent,
      intent,
      now,
      now,
    ),
    env.BILLING_DB.prepare(`INSERT INTO easy_pay_direct_payment_executions (id,organization_id,checkout_intent_id,payment_request_id,provider_account_code,request_sha256,payment_token_sha256,phone_sha256,customer_idempotency_key,payment_method_idempotency_key,product_idempotency_key,order_idempotency_key,status,provider_customer_id,provider_payment_method_id,provider_transaction_id,terms_accepted_at,created_at,updated_at,payment_backend,charge_transport)
      VALUES (?,?,?,?,'epd-renewal-test',?,?,'phone',?,?,?,?,'succeeded',?,?,?,?,?,?,'commerce_elements','commerce')`).bind(
      initial,
      organizationId,
      intent,
      initialRequest,
      intent,
      initial,
      initial,
      initial,
      initial,
      initial,
      customer,
      method,
      crypto.randomUUID(),
      now,
      now,
      now,
    ),
    env.BILLING_DB.prepare(
      "UPDATE payment_requests SET payment_status = 'succeeded' WHERE id = ?",
    ).bind(initialRequest),
    env.BILLING_DB.prepare(`INSERT INTO provider_customer_profiles (id,organization_id,customer_id,provider,provider_account_code,provider_customer_id,provider_payment_method_id,status,created_at,updated_at,checkout_intent_id,payment_backend)
      VALUES (?,?,?,'easy_pay_direct','epd-renewal-test',?,?,'active',?,?,?,'commerce_elements')`).bind(
      profile,
      organizationId,
      source!.customer_id,
      customer,
      method,
      now,
      now,
      intent,
    ),
    env.BILLING_DB.prepare("UPDATE subscriptions SET payment_method_id = ? WHERE id = ?").bind(
      profile,
      source!.subscription_id,
    ),
  ]);
  return {
    customer,
    method,
    product,
    order,
    runtime: new Proxy(enabledEnv(), {
      get(target, key, receiver) {
        return key === "EASY_PAY_DIRECT_COMMERCE_API_KEY"
          ? "epd_test_sk_fixture123"
          : Reflect.get(target, key, receiver);
      },
    }),
  };
}
async function commerceExecution() {
  return env.BILLING_DB.prepare(
    "SELECT * FROM easy_pay_direct_automatic_payment_executions WHERE organization_id = ?",
  )
    .bind(organizationId)
    .first<{
      id: string;
      payment_request_id: string;
      order_idempotency_key: string;
      status: string;
      commerce_order_id: string | null;
    }>();
}
function commerceFetcher(fixture: Awaited<ReturnType<typeof commerceFixture>>, fault?: string) {
  return vi.fn<typeof fetch>().mockImplementation(async (input, init) => {
    const url = String(input);
    if (url.includes("/products"))
      return Response.json({
        id: fixture.product,
        pricing: {
          amount: fault === "changed-product" && init?.method === "GET" ? 901 : 900,
          currency: "usd",
        },
        requires_shipping: false,
      });
    if (url.includes("/orders")) {
      if (fault === "lost-order" && init?.method === "POST")
        throw new Error("fictional interrupted response");
      return Response.json({
        id: fixture.order,
        customer_id: fixture.customer,
        payment_method: { id: fixture.method },
        status: fault === "declined" ? "failed" : "succeeded",
        total: fault === "wrong-amount" ? 901 : 900,
        currency: "usd",
        transactions: [],
      });
    }
    throw new Error("Unexpected provider endpoint");
  });
}
function enabledEnv(): Env {
  return new Proxy(env, {
    get(target, property, receiver) {
      if (property === "EASY_PAY_DIRECT_ORGANIZATION_ID") return organizationId;
      if (property === "EASY_PAY_DIRECT_ACCOUNT_CODE") return "epd-renewal-test";
      if (property === "EASY_PAY_DIRECT_AUTOMATIC_COLLECTION_ENABLED") return "1";
      if (property === "EASY_PAY_DIRECT_AUTOMATIC_COLLECTION_SCOPE_MODE") return "all";
      if (property === "PAYMENT_MUTATIONS_ENABLED") return "1";
      if (property === "PROVIDER_READS_ENABLED") return "1";
      if (property === "EASY_PAY_DIRECT_NETWORK_MODE") return "gateway_test";
      if (property === "EASY_PAY_DIRECT_LIVEMODE_ALLOWED") return "0";
      if (property === "EASY_PAY_DIRECT_SECURITY_KEY") return "synthetic-security-key";
      if (property === "EASY_PAY_DIRECT_CHECKOUT_SIGNING_SECRET") {
        return "synthetic-checkout-signing-secret";
      }
      if (property === "INDIRECT_TAX_ADDRESS_ENCRYPTION_KEY_ID") return "test-v1";
      if (property === "INDIRECT_TAX_ADDRESS_ENCRYPTION_SECRET") {
        return "synthetic-address-encryption-secret-32-bytes";
      }
      if (property === "EASY_PAY_DIRECT_COMMERCE_API_KEY") return "epd_synthetic_sk_test_secret";
      if (property === "EASY_PAY_DIRECT_TAX_MODE") return "disabled";
      return Reflect.get(target, property, receiver) as unknown;
    },
  }) as Env;
}

function candidateFixtureEnv(base: Env, failPreparation = false): Env {
  const database = new Proxy(env.BILLING_DB, {
    get(target, property) {
      if (property === "prepare")
        return (sql: string) => {
          if (sql.includes("SELECT invoice.id\n       FROM invoices invoice")) {
            sql = sql.replace(
              "WHERE invoice.status",
              `WHERE invoice.organization_id = '${organizationId}' AND invoice.status`,
            );
          } else if (sql.includes("WHERE execution.status = 'pending' AND julianday")) {
            sql = sql.replace(
              "WHERE execution.status",
              `WHERE execution.organization_id = '${organizationId}' AND execution.status`,
            );
          } else if (
            failPreparation &&
            sql.includes("FROM invoices") &&
            sql.includes("WHERE invoice.id = ?")
          ) {
            throw new Error("injected database failure");
          }
          return target.prepare(sql);
        };
      const value = Reflect.get(target, property);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return new Proxy(base, {
    get(target, property, receiver) {
      if (property === "BILLING_DB") return database;
      return Reflect.get(target, property, receiver);
    },
  });
}

async function seedDunningCreatorFixture(): Promise<{ id: string; customerId: string }> {
  await enableAutomaticCollectionScope();
  const id = `campaign-${crypto.randomUUID()}`;
  const now = new Date().toISOString();
  const customer = await env.BILLING_DB.prepare("SELECT customer_id FROM invoices WHERE id = ?")
    .bind(invoiceId)
    .first<{ customer_id: string }>();
  await env.BILLING_DB.batch([
    env.BILLING_DB.prepare(
      "INSERT INTO dunning_campaigns (id,organization_id,code,name,bcc_emails_json,days_between_attempts,max_attempts,active,version,request_sha256,created_at,updated_at) VALUES (?,?,?,'Renewal test','[]',1,3,1,1,?,?,?)",
    ).bind(id, organizationId, id, "f".repeat(64), now, now),
    env.BILLING_DB.prepare(
      "INSERT INTO dunning_campaign_thresholds (id,organization_id,dunning_campaign_id,amount_minor,currency,created_at,updated_at) VALUES (?,?,?,1,'USD',?,?)",
    ).bind(`threshold-${id}`, organizationId, id, now, now),
    env.BILLING_DB.prepare(
      "UPDATE customers SET applied_dunning_campaign_id = ? WHERE id = ?",
    ).bind(id, customer!.customer_id),
    env.BILLING_DB.prepare(
      "UPDATE invoices SET payment_overdue = 1, payment_status = 'failed' WHERE id = ?",
    ).bind(invoiceId),
  ]);
  return { id, customerId: customer!.customer_id };
}

async function addDunningDebt(variant: string): Promise<{ invoiceId: string }> {
  const id = crypto.randomUUID();
  const secondInvoice = `dunning-invoice-${id}`;
  const secondSub = `dunning-sub-${id}`;
  const secondPlan = `dunning-plan-${id}`;
  const secondProfile = `dunning-profile-${id}`;
  await env.BILLING_DB.batch([
    env.BILLING_DB.prepare(`INSERT INTO payment_requests
      (id,organization_id,customer_id,amount_minor,currency,email,payment_attempts,payment_status,ready_for_payment_processing,version,source,collection_mode,created_at,updated_at)
      SELECT ?,organization_id,customer_id,900,'USD','renewal@example.test',0,'pending',1,1,'manual','checkout',created_at,updated_at FROM invoices WHERE id = ?`).bind(
      `profile-request-${id}`,
      invoiceId,
    ),
    env.BILLING_DB.prepare(`INSERT INTO payment_request_checkout_intents
      (id,organization_id,payment_request_id,customer_id,provider,provider_account_code,idempotency_key,request_sha256,amount_minor,currency,payment_request_version,status,version,created_at,updated_at)
      SELECT ?,organization_id,?,customer_id,'easy_pay_direct','epd-renewal-test',?, ?,900,'USD',1,'pending',1,created_at,updated_at FROM invoices WHERE id = ?`).bind(
      `profile-intent-${id}`,
      `profile-request-${id}`,
      `profile-key-${id}`,
      "f".repeat(64),
      invoiceId,
    ),
    env.BILLING_DB.prepare(`INSERT INTO plans (id,organization_id,code,name,interval,amount_minor,currency,version,active,created_at,updated_at)
      SELECT ?,organization_id,?,'Other plan',?,amount_minor,currency,version,active,created_at,updated_at FROM plans WHERE id = (SELECT plan_id FROM subscriptions WHERE id = (SELECT subscription_id FROM invoices WHERE id = ?))`).bind(
      secondPlan,
      secondPlan,
      variant === "one-time" ? "one_time" : "monthly",
      invoiceId,
    ),
    env.BILLING_DB.prepare(`INSERT INTO provider_customer_profiles (id,organization_id,customer_id,provider,provider_account_code,provider_customer_id,gateway_customer_vault_id,initial_transaction_id,status,created_at,updated_at,checkout_intent_id)
      SELECT ?,organization_id,customer_id,provider,provider_account_code,?,?,?, ?,created_at,updated_at,? FROM provider_customer_profiles WHERE id = (SELECT payment_method_id FROM subscriptions WHERE id = (SELECT subscription_id FROM invoices WHERE id = ?))`).bind(
      secondProfile,
      `gateway:second-${id}`,
      `second-${id}`,
      `initial-second-${id}`,
      variant === "invalid-profile" ? "disabled" : "active",
      `profile-intent-${id}`,
      invoiceId,
    ),
    env.BILLING_DB.prepare(`INSERT INTO subscriptions (id,organization_id,customer_id,plan_id,external_id,status,started_at,current_period_start,current_period_end,payment_method_type,payment_method_id,version,created_at,updated_at)
      SELECT ?,organization_id,customer_id,?,?,status,started_at,current_period_start,current_period_end,payment_method_type,CASE WHEN ? = 1 THEN ? ELSE payment_method_id END,version,created_at,updated_at FROM subscriptions WHERE id = (SELECT subscription_id FROM invoices WHERE id = ?)`).bind(
      secondSub,
      secondPlan,
      secondSub,
      ["mixed-profile", "invalid-profile"].includes(variant) ? 1 : 0,
      secondProfile,
      invoiceId,
    ),
    env.BILLING_DB.prepare(`INSERT INTO invoices (id,organization_id,customer_id,subscription_id,number,status,payment_status,currency,subtotal_minor,tax_minor,credits_minor,total_due_minor,version,ready_for_payment_processing,payment_overdue,created_at,updated_at)
      SELECT ?,organization_id,customer_id,?,?,status,'failed',currency,subtotal_minor,tax_minor,credits_minor,total_due_minor,version,1,1,created_at,updated_at FROM invoices WHERE id = ?`).bind(
      secondInvoice,
      secondSub,
      secondInvoice,
      invoiceId,
    ),
  ]);
  if (variant !== "unscoped")
    await env.BILLING_DB.prepare(
      `INSERT INTO easy_pay_direct_automatic_collection_scopes (subscription_id,organization_id,status,reason,created_at,updated_at) VALUES (?,?,'enabled','test',?,?)`,
    )
      .bind(secondSub, organizationId, new Date().toISOString(), new Date().toISOString())
      .run();
  return { invoiceId: secondInvoice };
}

async function agePendingRenewal(requestId: string): Promise<void> {
  await env.BILLING_DB.prepare(
    "UPDATE easy_pay_direct_automatic_payment_executions SET updated_at = '2000-01-01T00:00:00.000Z' WHERE payment_request_id = ?",
  )
    .bind(requestId)
    .run();
}

function recoveryFixtureEnv(send: (event: unknown) => Promise<void>): Env {
  return new Proxy(candidateFixtureEnv(enabledEnv()), {
    get(target, property, receiver) {
      if (property === "DOMAIN_EVENTS") return { send };
      return Reflect.get(target, property, receiver);
    },
  });
}

function scopedEnv(): Env {
  return new Proxy(enabledEnv(), {
    get(target, property, receiver) {
      if (property === "EASY_PAY_DIRECT_AUTOMATIC_COLLECTION_SCOPE_MODE") return "scoped";
      return Reflect.get(target, property, receiver) as unknown;
    },
  }) as Env;
}

async function enableAutomaticCollectionScope(): Promise<void> {
  const subscription = await env.BILLING_DB.prepare(
    "SELECT subscription_id, organization_id FROM invoices WHERE id = ?",
  )
    .bind(invoiceId)
    .first<{ subscription_id: string; organization_id: string }>();
  const now = new Date().toISOString();
  await env.BILLING_DB.prepare(
    `INSERT INTO easy_pay_direct_automatic_collection_scopes
     (subscription_id, organization_id, status, reason, created_at, updated_at)
     VALUES (?, ?, 'enabled', 'scoped rollout test', ?, ?)`,
  )
    .bind(subscription!.subscription_id, subscription!.organization_id, now, now)
    .run();
}

function disabledEnv(): Env {
  return new Proxy(enabledEnv(), {
    get(target, property, receiver) {
      if (property === "EASY_PAY_DIRECT_AUTOMATIC_COLLECTION_ENABLED") return "0";
      return Reflect.get(target, property, receiver) as unknown;
    },
  }) as Env;
}

function localTaxEnv(): Env {
  return new Proxy(enabledEnv(), {
    get(target, property, receiver) {
      if (property === "EASY_PAY_DIRECT_TAX_MODE") return "enforced";
      if (property === "EASY_PAY_DIRECT_TAX_PROVIDER") return "local_d1";
      if (property === "EASY_PAY_DIRECT_TAX_CODE") return "txcd_10103100";
      if (property === "EASY_PAY_DIRECT_ONE_TIME_TAX_CODE") return "txcd_10202000";
      if (property === "EASY_PAY_DIRECT_TAX_MAX_DATA_AGE_DAYS") return "45";
      return Reflect.get(target, property, receiver) as unknown;
    },
  }) as Env;
}

async function seedCommittedBillingDestinationAndTaxRule(
  sameSubscription = true,
  calculationMethod: "static" | "wa_dor_address" = "static",
): Promise<void> {
  const current = await env.BILLING_DB.prepare(
    "SELECT customer_id, subscription_id FROM invoices WHERE id = ?",
  )
    .bind(invoiceId)
    .first<{ customer_id: string; subscription_id: string }>();
  const fixture = crypto.randomUUID();
  const priorInvoiceId = `prior-invoice-${fixture}`;
  const priorRequestId = `prior-request-${fixture}`;
  const priorIntentId = `prior-intent-${fixture}`;
  const ruleSetId = `tax-rules-${fixture}`;
  const ruleId = `tax-rule-${fixture}`;
  const quoteId = `prior-quote-${fixture}`;
  const billingAddress = {
    country: "US",
    state: "WA",
    postalCode: "98104",
    ...(calculationMethod === "wa_dor_address"
      ? { addressLine: "700 FIFTH AVE", city: "SEATTLE" }
      : {}),
  };
  const billingAddressHash = await sha256Hex(stableJson(billingAddress));
  const encryptedAddress =
    calculationMethod === "wa_dor_address"
      ? await encryptBillingAddress(
          {
            country: "US",
            state: "WA",
            postalCode: "98104",
            addressLine: "700 FIFTH AVE",
            city: "SEATTLE",
          },
          "synthetic-address-encryption-secret-32-bytes",
          quoteId,
        )
      : null;
  const now = new Date().toISOString();
  await env.BILLING_DB.prepare(`INSERT INTO invoice_lines
    (id,invoice_id,line_type,description,quantity_decimal,unit_amount_decimal,amount_minor,source_type,source_id,metadata_json,created_at)
    VALUES(?,?,'subscription','Fictional renewal','1','900',900,'plan',?,'{}',?)`)
    .bind(`tax-fee-${fixture}`, invoiceId, fixture, now)
    .run();
  await env.BILLING_DB.batch([
    env.BILLING_DB.prepare(
      "UPDATE indirect_tax_rule_sets SET status = 'retired' WHERE status = 'active'",
    ),
    env.BILLING_DB.prepare(
      `INSERT INTO indirect_tax_rule_sets
       (id, version, status, source_name, source_url, source_published_at, effective_from,
        effective_to, content_sha256, refreshed_at, created_at, activated_at)
       VALUES (?, (SELECT COALESCE(MAX(version), 0) + 1 FROM indirect_tax_rule_sets), 'active', 'Renewal test rules', 'https://example.invalid/rules', ?,
               '2020-01-01T00:00:00.000Z', NULL, ?, ?, ?, ?)`,
    ).bind(ruleSetId, now, "a".repeat(64), now, now, now),
    env.BILLING_DB.prepare(
      `INSERT INTO indirect_tax_rules
       (id, rule_set_id, country, region, postal_prefix, product_tax_code, taxability,
        rate_ppm, priority, source_url, source_reference, effective_from, effective_to, created_at,
        calculation_method)
       VALUES (?, ?, 'US', 'WA', NULL, 'txcd_10103100', 'taxable', ?, 0,
               ?, 'renewal-test', '2020-01-01T00:00:00.000Z', NULL, ?, ?)`,
    ).bind(
      ruleId,
      ruleSetId,
      calculationMethod === "wa_dor_address" ? 65_000 : 100_000,
      calculationMethod === "wa_dor_address"
        ? "https://webgis.dor.wa.gov/webapi/"
        : "https://example.invalid/rules",
      now,
      calculationMethod,
    ),
    env.BILLING_DB.prepare(
      `INSERT INTO indirect_tax_registration_scopes
       (id, organization_id, rule_set_id, country, region, status,
        registration_reference, effective_from, effective_to, created_at, updated_at)
       VALUES (?, ?, ?, 'US', 'WA', 'enabled', 'test-registration',
               '2020-01-01T00:00:00.000Z', NULL, ?, ?)`,
    ).bind(`scope-${fixture}`, organizationId, ruleSetId, now, now),
    env.BILLING_DB.prepare(
      `INSERT INTO invoices
       (id, organization_id, customer_id, subscription_id, number, status, payment_status,
        currency, subtotal_minor, tax_minor, credits_minor, total_due_minor, version,
        finalized_at, payment_overdue, ready_for_payment_processing, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'finalized', 'pending', 'USD', 900, 90, 0, 990, 1,
               ?, 0, 1, ?, ?)`,
    ).bind(
      priorInvoiceId,
      organizationId,
      current!.customer_id,
      sameSubscription ? current!.subscription_id : null,
      `PRIOR-${fixture}`,
      now,
      now,
      now,
    ),
    env.BILLING_DB.prepare(
      `INSERT INTO payment_requests
       (id, organization_id, customer_id, amount_minor, currency, email, payment_attempts,
        payment_status, ready_for_payment_processing, version, source, collection_mode,
        created_at, updated_at)
       VALUES (?, ?, ?, 990, 'USD', 'renewal@example.test', 0, 'pending', 1, 1,
               'manual', 'checkout', ?, ?)`,
    ).bind(priorRequestId, organizationId, current!.customer_id, now, now),
    env.BILLING_DB.prepare(
      `INSERT INTO invoices_payment_requests
       (id, organization_id, payment_request_id, invoice_id, invoice_version, created_at, updated_at)
       VALUES (?, ?, ?, ?, 1, ?, ?)`,
    ).bind(`prior-link-${fixture}`, organizationId, priorRequestId, priorInvoiceId, now, now),
    env.BILLING_DB.prepare(
      `INSERT INTO payment_request_checkout_intents
       (id, organization_id, payment_request_id, customer_id, provider,
        provider_account_code, idempotency_key, request_sha256, amount_minor, currency,
        payment_request_version, status, payment_url, provider_token_sha256,
        expires_at, version, created_at, updated_at, completed_at)
       VALUES (?, ?, ?, ?, 'easy_pay_direct', 'epd-renewal-test', ?, ?, 990, 'USD',
               1, 'succeeded', 'https://lago.test/checkout', ?, ?, 1, ?, ?, ?)`,
    ).bind(
      priorIntentId,
      organizationId,
      priorRequestId,
      current!.customer_id,
      `prior-${fixture}`,
      "b".repeat(64),
      "c".repeat(64),
      new Date(Date.now() + 60_000).toISOString(),
      now,
      now,
      now,
    ),
    env.BILLING_DB.prepare(
      `INSERT INTO easy_pay_direct_checkout_tax_quotes
       (id, organization_id, payment_request_id, invoice_id, source_checkout_intent_id,
        provider_code, provider_calculation_id, local_rule_set_id, local_rule_id,
        request_sha256, billing_address_sha256, billing_country, billing_state,
        billing_postal_code, local_calculation_method, billing_address_ciphertext,
        billing_address_iv, billing_address_key_id, rate_location_code, rate_jurisdiction, rate_period,
        rate_valid_through, state_rate_ppm, local_rate_ppm, currency, subtotal_minor,
        tax_minor, total_minor, tax_code, status, expires_at, created_at, updated_at, committed_at)
       VALUES (?, ?, ?, ?, ?, 'local_d1', ?, ?, ?, ?, ?, 'US', 'WA', '98104', ?, ?, ?, ?,
               ?, ?, ?, ?, ?, ?, 'USD', 900, ?, ?, 'txcd_10103100', 'committed', ?, ?, ?, ?)`,
    ).bind(
      quoteId,
      organizationId,
      priorRequestId,
      priorInvoiceId,
      priorIntentId,
      `local-calculation-${fixture}`,
      ruleSetId,
      ruleId,
      "d".repeat(64),
      billingAddressHash,
      calculationMethod,
      encryptedAddress?.ciphertext ?? null,
      encryptedAddress?.iv ?? null,
      calculationMethod === "wa_dor_address" ? "test-v1" : null,
      calculationMethod === "wa_dor_address" ? "1726" : null,
      calculationMethod === "wa_dor_address" ? "SEATTLE, KING" : null,
      calculationMethod === "wa_dor_address" ? "Q32026" : null,
      calculationMethod === "wa_dor_address" ? "2026-10-01T00:00:00.000Z" : null,
      calculationMethod === "wa_dor_address" ? 65_000 : null,
      calculationMethod === "wa_dor_address" ? 37_500 : null,
      calculationMethod === "wa_dor_address" ? 92 : 90,
      calculationMethod === "wa_dor_address" ? 992 : 990,
      new Date(Date.now() + 60_000).toISOString(),
      now,
      now,
      now,
    ),
  ]);
}

async function automaticPaymentRequestId(value: string): Promise<string | null> {
  const row = await env.BILLING_DB.prepare(
    `SELECT execution.payment_request_id
     FROM easy_pay_direct_automatic_payment_executions execution
     JOIN invoices_payment_requests link
       ON link.payment_request_id = execution.payment_request_id
     WHERE link.invoice_id = ? LIMIT 1`,
  )
    .bind(value)
    .first<{ payment_request_id: string }>();
  return row?.payment_request_id ?? null;
}

async function collectionState(value: string): Promise<Record<string, unknown> | null> {
  return env.BILLING_DB.prepare(
    `SELECT execution.status AS execution_status, execution.attempt_count,
            request.payment_status AS request_status,
            invoice.payment_status AS invoice_status,
            invoice.ready_for_payment_processing
     FROM easy_pay_direct_automatic_payment_executions execution
     JOIN payment_requests request ON request.id = execution.payment_request_id
     JOIN invoices_payment_requests link ON link.payment_request_id = request.id
     JOIN invoices invoice ON invoice.id = link.invoice_id
     WHERE invoice.id = ? LIMIT 1`,
  )
    .bind(value)
    .first<Record<string, unknown>>();
}

async function providerProfileState(): Promise<{ status: string } | null> {
  return env.BILLING_DB.prepare(
    `SELECT profile.status
     FROM provider_customer_profiles profile
     JOIN invoices invoice ON invoice.customer_id = profile.customer_id
     WHERE invoice.id = ? AND profile.organization_id = invoice.organization_id
       AND profile.provider = 'easy_pay_direct' LIMIT 1`,
  )
    .bind(invoiceId)
    .first<{ status: string }>();
}

async function automaticExecutionProviderTransactionId(): Promise<string | null> {
  const execution = await env.BILLING_DB.prepare(
    `SELECT execution.provider_transaction_id
     FROM easy_pay_direct_automatic_payment_executions execution
     JOIN invoices_payment_requests link
       ON link.payment_request_id = execution.payment_request_id
     WHERE link.invoice_id = ? LIMIT 1`,
  )
    .bind(invoiceId)
    .first<{ provider_transaction_id: string | null }>();
  return execution?.provider_transaction_id ?? null;
}
