import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { sha256Hex } from "../src/auth/api-key";
import { holdCustomerForClosure } from "../src/api/customer-closure";
import {
  pendingEasyPayDirectAutomaticCollectionInvoices,
  prepareEasyPayDirectAutomaticCollection,
  processEasyPayDirectAutomaticCollection,
  reconcileEasyPayDirectAutomaticCollection,
} from "../src/billing/easy-pay-direct-automatic-collection";
import { stableJson } from "../src/json";
import { encryptBillingAddress } from "../src/tax/billing-address-vault";

let invoiceId: string;
let organizationId: string;

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

  it("does not include one-time invoices in the automatic renewal candidate scan", async () => {
    await expect(
      pendingEasyPayDirectAutomaticCollectionInvoices(env.BILLING_DB, "all"),
    ).resolves.toContain(invoiceId);
    await env.BILLING_DB.prepare(
      `UPDATE plans SET interval = 'one_time', updated_at = ?
       WHERE id = (SELECT plan_id FROM subscriptions WHERE id =
         (SELECT subscription_id FROM invoices WHERE id = ?))`,
    )
      .bind(new Date().toISOString(), invoiceId)
      .run();

    await expect(
      pendingEasyPayDirectAutomaticCollectionInvoices(env.BILLING_DB, "all"),
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
    expect(providerFetch).toHaveBeenCalledOnce();
    await expect(collectionState(invoiceId)).resolves.toMatchObject({
      execution_status: "succeeded",
      invoice_status: "succeeded",
      request_status: "succeeded",
      attempt_count: 1,
    });
  });

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
        `<nm_response><transaction><transaction_id>renewal-reconciled</transaction_id><order_id>${paymentRequestId}</order_id><condition>complete</condition><requested_amount>9.00</requested_amount><currency>USD</currency><action><success>1</success><response_code>100</response_code><response_text>Approved</response_text></action></transaction></nm_response>`,
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
    },
  );

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

  it.each(["eligible", "one_time", "unscoped", "mixed_scope"])(
    "checks every invoice in a %s dunning request",
    async (scenario) => {
      const runtimeEnv = enabledEnv();
      await prepareEasyPayDirectAutomaticCollection(runtimeEnv, invoiceId, "dunning-initial");
      const initialRequestId = (await automaticPaymentRequestId(invoiceId))!;
      await processEasyPayDirectAutomaticCollection(
        runtimeEnv,
        initialRequestId,
        vi.fn<typeof fetch>(
          async () =>
            new Response(
              `response=2&responsetext=Declined&response_code=200&transactionid=dunning-initial-decline-${initialRequestId}&orderid=${initialRequestId}`,
            ),
        ),
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
      const providerFetch = vi.fn<typeof fetch>(
        async () =>
          new Response(
            `response=1&responsetext=Approved&response_code=100&transactionid=dunning-approved&orderid=${dunningRequestId}`,
          ),
      );
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
            scenario === "one_time" ? runtimeEnv : scopedEnv(),
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
      expect(providerFetch).toHaveBeenCalledOnce();
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

function enabledEnv(): Env {
  return new Proxy(env, {
    get(target, property, receiver) {
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
