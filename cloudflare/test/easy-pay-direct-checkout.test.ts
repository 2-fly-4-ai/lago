import { env } from "cloudflare:test";
import type { WorkflowStep } from "cloudflare:workers";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  handleEasyPayDirectCheckoutSubmission,
  resumeEasyPayDirectExecution,
  EASY_PAY_DIRECT_SETUP_REVIEW_CODES,
} from "../src/api/easy-pay-direct-checkout";
import { sha256Hex } from "../src/auth/api-key";
import { holdCustomerForClosure } from "../src/api/customer-closure";
import {
  easyPayDirectPaymentForm,
  verifyEasyPayDirectCheckoutToken,
} from "../src/providers/easy-pay-direct";
import {
  reconcileEasyPayDirectExecution,
  reconcileEasyPayDirectReceipt,
  pendingEasyPayDirectExecutions,
} from "../src/reconciliation/easy-pay-direct";
import { runCheckoutWorkflow } from "../src/workflows/checkout";
import {
  enrollProductScopedAutomaticCollections,
  prepareEasyPayDirectAutomaticCollection,
  processEasyPayDirectAutomaticCollection,
} from "../src/billing/easy-pay-direct-automatic-collection";

const organizationId = "org-easy-pay-direct-checkout";
let customerId: string;
let invoiceId: string;
let paymentRequestId: string;

beforeEach(seedCheckoutFixture);

async function seedCheckoutFixture() {
  const fixtureId = crypto.randomUUID();
  customerId = `customer-easy-pay-direct-checkout-${fixtureId}`;
  invoiceId = `invoice-easy-pay-direct-checkout-${fixtureId}`;
  paymentRequestId = `payment-request-easy-pay-direct-checkout-${fixtureId}`;
  const now = new Date().toISOString();
  await env.BILLING_DB.batch([
    env.BILLING_DB.prepare(
      `INSERT OR IGNORE INTO organizations (id, external_id, name, created_at, updated_at)
       VALUES (?, 'easy-pay-direct-checkout', 'Easy Pay Direct Checkout', ?, ?)`,
    ).bind(organizationId, now, now),
    env.BILLING_DB.prepare(
      `INSERT OR IGNORE INTO customers
       (id, organization_id, external_id, email, name, currency, metadata_json,
        payment_provider, payment_provider_code, created_at, updated_at)
       VALUES (?, ?, ?, 'synthetic@example.com', 'Synthetic Customer',
               'USD', '{}', 'easy_pay_direct', 'epd-synthetic', ?, ?)`,
    ).bind(customerId, organizationId, `easy-pay-direct-customer-${fixtureId}`, now, now),
    env.BILLING_DB.prepare(
      `INSERT OR IGNORE INTO invoices
       (id, organization_id, customer_id, number, status, payment_status, currency,
        subtotal_minor, tax_minor, credits_minor, total_due_minor, version, finalized_at,
        payment_overdue, ready_for_payment_processing, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'finalized', 'pending',
               'USD', 1999, 0, 0, 1999, 1, ?, 1, 1, ?, ?)`,
    ).bind(invoiceId, organizationId, customerId, `INV-EPD-${fixtureId}`, now, now, now),
    env.BILLING_DB.prepare(
      `INSERT OR IGNORE INTO payment_requests
       (id, organization_id, customer_id, amount_minor, currency, email, payment_attempts,
        payment_status, ready_for_payment_processing, version, created_at, updated_at)
       VALUES (?, ?, ?, 1999, 'USD', 'synthetic@example.com', 0, 'pending', 1, 1, ?, ?)`,
    ).bind(paymentRequestId, organizationId, customerId, now, now),
    env.BILLING_DB.prepare(
      `INSERT OR IGNORE INTO invoices_payment_requests
       (id, organization_id, payment_request_id, invoice_id, invoice_version, created_at, updated_at)
       VALUES (?, ?, ?, ?, 1, ?, ?)`,
    ).bind(
      `link-easy-pay-direct-checkout-${fixtureId}`,
      organizationId,
      paymentRequestId,
      invoiceId,
      now,
      now,
    ),
  ]);
}

describe("Easy Pay Direct Commerce checkout execution", () => {
  it.each(["paid", "disabled"])(
    "rechecks %s state after provider setup and before ordering",
    async (state) => {
      const { runtimeEnv, request } = await productionSubmission();
      const provider = commerceVaultFixture();
      const fetcher = vi.fn<typeof fetch>(async (input, init) => {
        const result = await provider.fetcher(input, init);
        if (String(input).endsWith("/products")) {
          await env.BILLING_DB.prepare(
            "UPDATE payment_requests SET payment_status = ?, ready_for_payment_processing = 0 WHERE id = ?",
          )
            .bind(state === "paid" ? "succeeded" : "pending", paymentRequestId)
            .run();
        }
        return result;
      });
      await expect(
        handleEasyPayDirectCheckoutSubmission(request(), runtimeEnv, "late-state-change", fetcher),
      ).rejects.toMatchObject({ code: "easy_pay_direct_checkout_state_changed" });
      expect(provider.operations).toContain("product");
      expect(provider.operations).not.toContain("order");
      const execution = await executionForTest();
      expect(execution).toMatchObject({
        status: "unknown",
        failure_code: "easy_pay_direct_checkout_state_changed",
        provider_transaction_id: null,
      });
      const calls = fetcher.mock.calls.length;
      await expect(resumeEasyPayDirectExecution(runtimeEnv, execution!.id, fetcher)).resolves.toBe(
        "deferred",
      );
      expect(fetcher).toHaveBeenCalledTimes(calls);
    },
  );

  it("still reads an existing order when charging is disabled and recovery checkpoints are missing", async () => {
    const { runtimeEnv, request } = await productionSubmission();
    const provider = commerceVaultFixture();
    await handleEasyPayDirectCheckoutSubmission(
      request(),
      runtimeEnv,
      "existing-order",
      provider.fetcher,
    );
    const execution = await executionForTest();
    await env.BILLING_DB.batch([
      env.BILLING_DB.prepare(
        "UPDATE payment_requests SET payment_status = 'succeeded', ready_for_payment_processing = 0 WHERE id = ?",
      ).bind(paymentRequestId),
      env.BILLING_DB.prepare(
        "UPDATE easy_pay_direct_payment_executions SET status = 'unknown', failure_code = 'easy_pay_direct_recovery_checkpoint_missing', phone_ciphertext = NULL, phone_iv = NULL, gateway_billing_id = 'legacy-id' WHERE id = ?",
      ).bind(execution!.id),
    ]);
    expect(await pendingEasyPayDirectExecutions(env.BILLING_DB, "production")).toContain(
      execution!.id,
    );
    const fetcher = vi.fn<typeof fetch>(async (input, init) => {
      expect(String(input)).toBe(`https://api.epd.com/v1/orders/fixture-order-${paymentRequestId}`);
      expect(init?.method).toBe("GET");
      return Response.json({ id: `fixture-order-${paymentRequestId}`, status: "pending" });
    });
    await expect(reconcileEasyPayDirectExecution(runtimeEnv, execution!.id, fetcher)).resolves.toBe(
      "deferred",
    );
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it.each(["paid", "disabled"])("recovery must not order when request is %s", async (state) => {
    const { runtimeEnv, request } = await productionSubmission();
    const provider = commerceVaultFixture();
    let attachmentUnavailable = true;
    const fetcher = vi.fn<typeof fetch>(async (input, init) => {
      if (attachmentUnavailable && String(input).endsWith("/payment_methods"))
        return new Response("Unavailable", { status: 503 });
      return provider.fetcher(input, init);
    });
    await expect(
      handleEasyPayDirectCheckoutSubmission(request(), runtimeEnv, "review-seed", fetcher),
    ).rejects.toThrow();
    const execution = await executionForTest();
    await env.BILLING_DB.prepare(
      "UPDATE payment_requests SET payment_status = ?, ready_for_payment_processing = 0 WHERE id = ?",
    )
      .bind(state === "paid" ? "succeeded" : "pending", paymentRequestId)
      .run();
    attachmentUnavailable = false;
    await resumeEasyPayDirectExecution(runtimeEnv, execution!.id, fetcher);
    expect(provider.operations.filter((operation) => operation === "order")).toHaveLength(0);
  });

  it.each(["legacy-billing", "missing-phone"])(
    "%s records must not starve recovery",
    async (kind) => {
      for (let i = 0; i < 101; i += 1) {
        if (i > 0) await seedCheckoutFixture();
        const { runtimeEnv, request } = await productionSubmission();
        const provider = commerceVaultFixture({ exposeBinding: false });
        await expect(
          handleEasyPayDirectCheckoutSubmission(
            request(),
            runtimeEnv,
            "review-held",
            provider.fetcher,
          ),
        ).rejects.toThrow();
        const execution = await executionForTest();
        await env.BILLING_DB.prepare(
          "UPDATE easy_pay_direct_payment_executions SET customer_vault_id = 'fixture-vault', gateway_billing_id = ?, failure_code = ?, phone_ciphertext = CASE WHEN ? = 'missing-phone' THEN NULL ELSE phone_ciphertext END, phone_iv = CASE WHEN ? = 'missing-phone' THEN NULL ELSE phone_iv END WHERE id = ?",
        )
          .bind(
            kind === "legacy-billing" ? "legacy-id" : "123",
            kind === "missing-phone" ? "easy_pay_direct_recovery_checkpoint_missing" : null,
            kind,
            kind,
            execution!.id,
          )
          .run();
      }
      await seedCheckoutFixture();
      const { runtimeEnv, request } = await productionSubmission();
      const provider = commerceVaultFixture({ rejectAttach: true });
      await expect(
        handleEasyPayDirectCheckoutSubmission(
          request(),
          runtimeEnv,
          "review-actionable",
          provider.fetcher,
        ),
      ).rejects.toThrow();
      const actionable = await executionForTest();
      await env.BILLING_DB.prepare(
        "UPDATE easy_pay_direct_payment_executions SET failure_code = NULL WHERE id = ?",
      )
        .bind(actionable!.id)
        .run();
      expect(await pendingEasyPayDirectExecutions(env.BILLING_DB, "production")).toContain(
        actionable!.id,
      );
    },
  );
  it.each(
    ["lookup", "read_customer"].flatMap((operation) =>
      [503, 429, "network"].map((failure) => ({ operation, failure })),
    ),
  )(
    "allows a fresh submission after $operation $failure, without consuming the first token",
    async ({ operation, failure }) => {
      const { runtimeEnv, request } = await productionSubmission();
      const provider = commerceVaultFixture({ expectedToken: "fresh-fictional-hosted-token" });
      let unavailable = true;
      const fetcher = vi.fn<typeof fetch>(async (input, init) => {
        const isRead =
          operation === "lookup"
            ? String(input).includes("/customers?")
            : String(input).endsWith("/customers/fixture-customer");
        if (unavailable && isRead) {
          if (failure === "network") throw new TypeError("Network unavailable");
          return new Response("Temporary outage", { status: Number(failure) });
        }
        return provider.fetcher(input, init);
      });
      await expect(
        handleEasyPayDirectCheckoutSubmission(request(), runtimeEnv, "read-outage", fetcher),
      ).rejects.toMatchObject({ code: "easy_pay_direct_customer_lookup_retryable" });
      expect(provider.savedVaults).toEqual([]);
      const execution = await executionForTest();
      expect(execution).toMatchObject({
        status: "pending",
        customer_vault_id: null,
        gateway_billing_id: null,
      });
      await expect(resumeEasyPayDirectExecution(runtimeEnv, execution!.id, fetcher)).resolves.toBe(
        "deferred",
      );
      unavailable = false;
      const response = await handleEasyPayDirectCheckoutSubmission(
        request("fresh-fictional-hosted-token"),
        runtimeEnv,
        "read-recovered",
        fetcher,
      );
      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toMatchObject({ status: "processing" });
      expect(provider.operations.filter((item) => item === "add_billing")).toHaveLength(1);
      expect(provider.operations.filter((item) => item === "order")).toHaveLength(1);
    },
  );

  it("keeps a gateway timeout unknown and never makes its consumed token retryable", async () => {
    const { runtimeEnv, request } = await productionSubmission();
    const provider = commerceVaultFixture();
    const fetcher = vi.fn<typeof fetch>(async (input, init) => {
      if (String(input).includes("/api/transact.php")) throw new Error("gateway timeout");
      return provider.fetcher(input, init);
    });
    await expect(
      handleEasyPayDirectCheckoutSubmission(request(), runtimeEnv, "vault-timeout", fetcher),
    ).rejects.toThrow();
    expect(await executionForTest()).toMatchObject({ status: "unknown" });
    const count = fetcher.mock.calls.length;
    await expect(
      handleEasyPayDirectCheckoutSubmission(request(), runtimeEnv, "vault-timeout-retry", fetcher),
    ).rejects.toMatchObject({ status: 409 });
    expect(fetcher).toHaveBeenCalledTimes(count);
  });

  it("allows only one concurrent retry to claim a read-only failure", async () => {
    const { runtimeEnv, request } = await productionSubmission();
    await expect(
      handleEasyPayDirectCheckoutSubmission(
        request(),
        runtimeEnv,
        "seed-read-failure",
        async () => new Response("Unavailable", { status: 503 }),
      ),
    ).rejects.toThrow();
    const provider = commerceVaultFixture({ expectedToken: "fresh-fictional-hosted-token" });
    let releaseRead: () => void = () => {};
    let markEntered: () => void = () => {};
    const blockedRead = new Promise<void>((resolve) => {
      releaseRead = resolve;
    });
    const enteredRead = new Promise<void>((resolve) => {
      markEntered = resolve;
    });
    const fetcher = vi.fn<typeof fetch>(async (input, init) => {
      if (String(input).includes("/customers?")) {
        markEntered();
        await blockedRead;
      }
      return provider.fetcher(input, init);
    });
    const first = handleEasyPayDirectCheckoutSubmission(
      request("fresh-fictional-hosted-token"),
      runtimeEnv,
      "retry-first",
      fetcher,
    );
    await enteredRead;
    try {
      await expect(
        handleEasyPayDirectCheckoutSubmission(
          request("fresh-fictional-hosted-token"),
          runtimeEnv,
          "retry-overlap",
          fetcher,
        ),
      ).rejects.toMatchObject({ status: 409 });
    } finally {
      releaseRead();
      await first;
    }
    expect(provider.operations.filter((item) => item === "add_billing")).toHaveLength(1);
    expect(provider.operations.filter((item) => item === "order")).toHaveLength(1);
  });

  it("defers a recovery lookup outage without resetting a vaulted execution or aborting the batch", async () => {
    const { runtimeEnv, request } = await productionSubmission();
    const provider = commerceVaultFixture();
    let stage = "attachment-outage";
    const fetcher = vi.fn<typeof fetch>(async (input, init) => {
      if (
        (stage === "attachment-outage" && String(input).endsWith("/payment_methods")) ||
        (stage === "read-outage" && String(input).endsWith("/customers/fixture-customer"))
      ) {
        return new Response("Temporary outage", { status: 503 });
      }
      return provider.fetcher(input, init);
    });
    await expect(
      handleEasyPayDirectCheckoutSubmission(request(), runtimeEnv, "checkpoint-outage", fetcher),
    ).rejects.toThrow();
    const execution = await executionForTest();
    expect(execution).toMatchObject({
      status: "unknown",
      customer_vault_id: "fixture-existing-vault",
    });
    stage = "read-outage";
    await expect(resumeEasyPayDirectExecution(runtimeEnv, execution!.id, fetcher)).resolves.toBe(
      "deferred",
    );
    expect(await executionForTest()).toMatchObject({
      status: "unknown",
      failure_code: "easy_pay_direct_customer_lookup_retryable",
    });
    stage = "recovered";
    await expect(resumeEasyPayDirectExecution(runtimeEnv, execution!.id, fetcher)).resolves.toBe(
      "advanced",
    );
    expect(provider.operations.filter((item) => item === "add_billing")).toHaveLength(1);
    expect(provider.operations.filter((item) => item === "order")).toHaveLength(1);
  });

  it("selects actionable records beyond 100 held executions and retains existing orders", async () => {
    let orderedHeldId = "";
    const fixtureIds: string[] = [];
    for (let i = 0; i < 101; i += 1) {
      if (i > 0) await seedCheckoutFixture();
      const { runtimeEnv, request } = await productionSubmission();
      const provider = commerceVaultFixture({ exposeBinding: false });
      await expect(
        handleEasyPayDirectCheckoutSubmission(
          request(),
          runtimeEnv,
          "hold-fixture",
          provider.fetcher,
        ),
      ).rejects.toThrow();
      const execution = await executionForTest();
      fixtureIds.push(execution!.id);
      await env.BILLING_DB.prepare(
        `UPDATE easy_pay_direct_payment_executions SET customer_vault_id = 'fixture-vault', gateway_billing_id = '123', failure_code = ? WHERE id = ?`,
      )
        .bind(
          EASY_PAY_DIRECT_SETUP_REVIEW_CODES[i % EASY_PAY_DIRECT_SETUP_REVIEW_CODES.length],
          execution!.id,
        )
        .run();
      orderedHeldId = execution!.id;
    }
    await env.BILLING_DB.prepare(
      "UPDATE easy_pay_direct_payment_executions SET provider_transaction_id = 'fixture-held-order' WHERE id = ?",
    )
      .bind(orderedHeldId)
      .run();
    await seedCheckoutFixture();
    const { runtimeEnv, request } = await productionSubmission();
    const provider = commerceVaultFixture({ rejectAttach: true });
    await expect(
      handleEasyPayDirectCheckoutSubmission(
        request(),
        runtimeEnv,
        "actionable-fixture",
        provider.fetcher,
      ),
    ).rejects.toThrow();
    const actionable = await executionForTest();
    fixtureIds.push(actionable!.id);
    await env.BILLING_DB.prepare(
      "UPDATE easy_pay_direct_payment_executions SET failure_code = NULL WHERE id = ?",
    )
      .bind(actionable!.id)
      .run();
    expect(await pendingEasyPayDirectExecutions(env.BILLING_DB, "production")).toEqual(
      expect.arrayContaining([orderedHeldId, actionable!.id]),
    );
    expect(
      (await pendingEasyPayDirectExecutions(env.BILLING_DB, "production")).filter((id) =>
        fixtureIds.includes(id),
      ),
    ).toHaveLength(2);
  });

  it("looks up the existing Commerce vault before saving a card when no local profile exists", async () => {
    const { runtimeEnv, request } = await productionSubmission();
    const provider = commerceVaultFixture();
    const response = await handleEasyPayDirectCheckoutSubmission(
      request(),
      runtimeEnv,
      "vault-link",
      provider.fetcher,
    );
    await expect(response.json()).resolves.toMatchObject({
      status: "processing",
      provider_order_id: `fixture-order-${paymentRequestId}`,
    });
    expect(provider.operations).toEqual([
      "lookup",
      "read_customer",
      "add_billing",
      "attach",
      "product",
      "order",
    ]);
    expect(provider.savedVaults).toEqual(["fixture-existing-vault"]);
    await expect(
      env.BILLING_DB.prepare(
        "SELECT provider_customer_id, gateway_customer_vault_id, provider_payment_method_id FROM provider_customer_profiles WHERE customer_id = ?",
      )
        .bind(customerId)
        .first(),
    ).resolves.toEqual({
      provider_customer_id: "fixture-customer",
      gateway_customer_vault_id: "fixture-existing-vault",
      provider_payment_method_id: "fixture-new-method",
    });
    const calls = provider.fetcher.mock.calls.length;
    await handleEasyPayDirectCheckoutSubmission(
      request(),
      runtimeEnv,
      "vault-link-replay",
      provider.fetcher,
    );
    expect(provider.fetcher).toHaveBeenCalledTimes(calls);
  });

  it("attaches the submitted card explicitly even when new-customer creation returns a default", async () => {
    const { runtimeEnv, request } = await productionSubmission();
    const provider = commerceVaultFixture({ existing: false });
    await handleEasyPayDirectCheckoutSubmission(
      request(),
      runtimeEnv,
      "new-vault-link",
      provider.fetcher,
    );
    expect(provider.operations).toEqual([
      "lookup",
      "add_customer",
      "create_customer",
      "read_customer",
      "attach",
      "product",
      "order",
    ]);
    expect(provider.savedVaults).toEqual(["fixture-new-vault"]);
  });

  it("does not consume a card token when Commerce omits the legacy vault binding", async () => {
    const { runtimeEnv, request } = await productionSubmission();
    const provider = commerceVaultFixture({ exposeBinding: false });
    await expect(
      handleEasyPayDirectCheckoutSubmission(
        request(),
        runtimeEnv,
        "missing-vault",
        provider.fetcher,
      ),
    ).rejects.toMatchObject({ code: "easy_pay_direct_customer_vault_unverified" });
    expect(provider.operations).toEqual(["lookup", "read_customer"]);
    const execution = await executionForTest();
    expect(execution).toMatchObject({
      status: "unknown",
      failure_code: "easy_pay_direct_customer_vault_unverified",
      provider_transaction_id: null,
    });
    await expect(
      resumeEasyPayDirectExecution(runtimeEnv, execution!.id, provider.fetcher),
    ).resolves.toBe("deferred");
    await expect(
      handleEasyPayDirectCheckoutSubmission(
        request(),
        runtimeEnv,
        "missing-vault-again",
        provider.fetcher,
      ),
    ).rejects.toMatchObject({ status: 409 });
    expect(provider.operations).toEqual(["lookup", "read_customer"]);
  });

  it("quarantines an old wrong-vault checkpoint without another attachment, charge, or retry loop", async () => {
    const { runtimeEnv, request } = await productionSubmission();
    const provider = commerceVaultFixture({ exposeBinding: false });
    await expect(
      handleEasyPayDirectCheckoutSubmission(
        request(),
        runtimeEnv,
        "seed-execution",
        provider.fetcher,
      ),
    ).rejects.toMatchObject({ status: 409 });
    // Reproduce the persisted pre-fix state, using only synthetic local D1 rows.
    await env.BILLING_DB.prepare(
      `UPDATE easy_pay_direct_payment_executions SET customer_vault_id = 'wrong-vault', gateway_billing_id = '123456',
       provider_customer_id = 'fixture-customer', last_checkpoint = 'provider_customer', failure_code = NULL
       WHERE payment_request_id = ?`,
    )
      .bind(paymentRequestId)
      .run();
    const verifiedProvider = commerceVaultFixture();
    const execution = await executionForTest();
    await expect(
      resumeEasyPayDirectExecution(runtimeEnv, execution!.id, verifiedProvider.fetcher),
    ).resolves.toBe("deferred");
    expect(verifiedProvider.operations).toEqual(["read_customer"]);
    await expect(executionForTest()).resolves.toMatchObject({
      status: "unknown",
      failure_code: "easy_pay_direct_customer_vault_mismatch",
      customer_vault_id: "wrong-vault",
      gateway_billing_id: "123456",
      provider_transaction_id: null,
    });
    await expect(
      resumeEasyPayDirectExecution(runtimeEnv, execution!.id, verifiedProvider.fetcher),
    ).resolves.toBe("deferred");
    await expect(
      handleEasyPayDirectCheckoutSubmission(
        request(),
        runtimeEnv,
        "wrong-vault-again",
        verifiedProvider.fetcher,
      ),
    ).rejects.toMatchObject({ status: 409 });
    expect(verifiedProvider.operations).toEqual(["read_customer"]);
  });

  it("stops a definitive attachment rejection and hides the provider's vault identifiers", async () => {
    const { runtimeEnv, request } = await productionSubmission();
    const provider = commerceVaultFixture({ rejectAttach: true });
    await expect(
      handleEasyPayDirectCheckoutSubmission(
        request(),
        runtimeEnv,
        "attach-rejected",
        provider.fetcher,
      ),
    ).rejects.toMatchObject({
      code: "easy_pay_direct_payment_method_rejected",
      message: expect.not.stringContaining("private-vault"),
    });
    expect(provider.operations).toEqual(["lookup", "read_customer", "add_billing", "attach"]);
    const execution = await executionForTest();
    expect(execution).toMatchObject({
      status: "unknown",
      failure_code: "easy_pay_direct_payment_method_rejected",
      provider_transaction_id: null,
    });
    await expect(
      resumeEasyPayDirectExecution(runtimeEnv, execution!.id, provider.fetcher),
    ).resolves.toBe("deferred");
    expect(provider.operations).toEqual(["lookup", "read_customer", "add_billing", "attach"]);
  });

  it("stops before attachment when newly created Commerce customer is not linked to the requested vault", async () => {
    const { runtimeEnv, request } = await productionSubmission();
    const provider = commerceVaultFixture({ existing: false, ignoreRequestedBinding: true });
    await expect(
      handleEasyPayDirectCheckoutSubmission(
        request(),
        runtimeEnv,
        "create-binding-mismatch",
        provider.fetcher,
      ),
    ).rejects.toMatchObject({ code: "easy_pay_direct_customer_vault_mismatch" });
    expect(provider.operations).toEqual([
      "lookup",
      "add_customer",
      "create_customer",
      "read_customer",
    ]);
  });

  it("rejects a product checkout before provider or database work when terms are not accepted", async () => {
    const providerFetch = vi.fn<typeof fetch>();
    await expect(
      handleEasyPayDirectCheckoutSubmission(
        new Request("https://lago.test/easy_pay_direct/payment_form", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            checkout: "signed-checkout-token",
            payment_token: "hosted-payment-token",
            phone: "+15555550123",
            terms_accepted: false,
          }),
        }),
        enabledEnv("gateway_test"),
        "request-epd-terms",
        providerFetch,
      ),
    ).rejects.toMatchObject({ code: "easy_pay_direct_terms_required", status: 422 });
    expect(providerFetch).not.toHaveBeenCalled();
  });

  it("rejects an already-issued checkout after a customer closure hold without calling EPD", async () => {
    const runtimeEnv = enabledEnv("gateway_test");
    await runCheckoutWorkflow(runtimeEnv, checkoutParams(), immediateStep());
    const checkout = await env.BILLING_DB.prepare(
      "SELECT payment_url FROM payment_request_checkout_intents WHERE payment_request_id = ?",
    )
      .bind(paymentRequestId)
      .first<{ payment_url: string }>();
    const customer = await env.BILLING_DB.prepare("SELECT external_id FROM customers WHERE id = ?")
      .bind(customerId)
      .first<{ external_id: string }>();
    const response = await holdCustomerForClosure(
      env.BILLING_DB,
      { organizationId, organizationExternalId: organizationId, apiKeyId: "test" },
      customer!.external_id,
      "hold-test",
    );
    expect(response.status).toBe(200);
    const providerFetch = vi.fn<typeof fetch>();
    await expect(
      handleEasyPayDirectCheckoutSubmission(
        new Request("https://lago.test/easy_pay_direct/payment_form", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            checkout: new URL(checkout!.payment_url).searchParams.get("checkout"),
            payment_token: "hosted-token-closed",
            phone: "+15555550123",
            terms_accepted: true,
          }),
        }),
        runtimeEnv,
        "closed-test",
        providerFetch,
      ),
    ).rejects.toMatchObject({ status: 409 });
    expect(providerFetch).not.toHaveBeenCalled();
  });

  it("does not treat reusable provider payment tokens as global idempotency keys", async () => {
    const indexes = await env.BILLING_DB.prepare(
      "PRAGMA index_list('easy_pay_direct_payment_executions')",
    ).all<{ name: string; unique: number }>();
    const uniqueIndexColumns = await Promise.all(
      indexes.results
        .filter((index) => index.unique === 1)
        .map(async (index) => {
          const columns = await env.BILLING_DB.prepare(
            `PRAGMA index_info('${index.name.replaceAll("'", "''")}')`,
          ).all<{ name: string }>();
          return columns.results.map((column) => column.name);
        }),
    );

    expect(uniqueIndexColumns).not.toContainEqual(["payment_token_sha256"]);
  });

  it("charges the product canary through forced Gateway test mode and reconciles once", async () => {
    const runtimeEnv = enabledEnv("gateway_test");
    const recurringPlanId = `plan-${paymentRequestId}`;
    const recurringSubscriptionId = `subscription-${paymentRequestId}`;
    const now = new Date().toISOString();
    await env.BILLING_DB.batch([
      env.BILLING_DB.prepare(
        `INSERT INTO provider_customer_profiles
         (id, organization_id, customer_id, provider, provider_account_code,
          provider_customer_id, gateway_customer_vault_id, status, created_at, updated_at)
         VALUES (?, ?, ?, 'easy_pay_direct', 'epd-synthetic',
                 'gateway:legacy-placeholder', 'vault-test-legacy', 'active', ?, ?)`,
      ).bind(`legacy-profile-${paymentRequestId}`, organizationId, customerId, now, now),
      env.BILLING_DB.prepare(
        `INSERT INTO plans
         (id, organization_id, code, name, interval, amount_minor, currency,
          version, active, created_at, updated_at)
         VALUES (?, ?, ?, 'EPD checkout subscription', 'monthly', 1999, 'USD', 1, 1, ?, ?)`,
      ).bind(recurringPlanId, organizationId, recurringPlanId, now, now),
      env.BILLING_DB.prepare(
        `INSERT INTO subscriptions
         (id, organization_id, customer_id, plan_id, external_id, status, started_at,
          current_period_start, current_period_end, version, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 'active', ?, ?, '2026-10-01T00:00:00.000Z', 1, ?, ?)`,
      ).bind(
        recurringSubscriptionId,
        organizationId,
        customerId,
        recurringPlanId,
        recurringSubscriptionId,
        now,
        now,
        now,
        now,
      ),
      env.BILLING_DB.prepare(
        `UPDATE invoices
         SET subscription_id = ?, updated_at = ?
         WHERE id = ? AND organization_id = ?`,
      ).bind(recurringSubscriptionId, now, invoiceId, organizationId),
    ]);
    await runCheckoutWorkflow(runtimeEnv, checkoutParams(), immediateStep());
    const checkout = await env.BILLING_DB.prepare(
      `SELECT payment_url, status, provider_account_code FROM payment_request_checkout_intents
       WHERE payment_request_id = ? AND provider = 'easy_pay_direct'`,
    )
      .bind(paymentRequestId)
      .first<{ payment_url: string; status: string; provider_account_code: string }>();
    expect(checkout).toMatchObject({ status: "succeeded", provider_account_code: "epd-synthetic" });
    await expect(
      env.BILLING_DB.prepare(
        `SELECT intent.organization_id, intent.payment_request_id, intent.request_sha256,
                request.organization_id AS request_organization_id, request.payment_status
         FROM payment_request_checkout_intents intent
         JOIN payment_requests request ON request.id = intent.payment_request_id
         WHERE intent.payment_request_id = ?`,
      )
        .bind(paymentRequestId)
        .first(),
    ).resolves.toMatchObject({
      organization_id: organizationId,
      payment_request_id: paymentRequestId,
      request_organization_id: organizationId,
      payment_status: "pending",
    });
    const checkoutToken = new URL(checkout!.payment_url).searchParams.get("checkout")!;
    const checkoutForm = await easyPayDirectPaymentForm(new URL(checkout!.payment_url), runtimeEnv);
    const checkoutHtml = await checkoutForm.text();
    expect(checkoutHtml).toContain("SERP subscription");
    expect(checkoutHtml).toContain("$19.99");
    expect(checkoutHtml).toContain("synthetic@example.com");
    expect(checkoutHtml).toContain("Total due today");
    const providerFetch = vi.fn<typeof fetch>(async (_input, init) => {
      const body = new URLSearchParams(String(init?.body));
      expect(body.get("payment_token")).toBe("hosted-token-canary-1");
      expect(body.get("amount")).toBe("19.99");
      expect(body.get("test_mode")).toBe("enabled");
      expect(body.get("security_key")).toBe("synthetic-security-key");
      expect(body.has("ccnumber")).toBe(false);
      return new Response(
        "response=1&responsetext=Approved&response_code=100&transactionid=epd-gateway-test-1&authcode=TEST&customer_vault_id=87426631",
      );
    });
    const request = () =>
      new Request("https://lago.test/easy_pay_direct/payment_form", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          checkout: checkoutToken,
          payment_token: "hosted-token-canary-1",
          phone: "+15555550123",
          terms_accepted: true,
          return_to:
            "https://store.test/checkout/success?session_id=lago%3Ainvoice-1&provider=easy_pay_direct",
        }),
      });
    const first = await handleEasyPayDirectCheckoutSubmission(
      request(),
      runtimeEnv,
      "request-epd-gateway-test-1",
      providerFetch,
    );
    await expect(first.json()).resolves.toMatchObject({
      status: "succeeded",
      provider: "easy_pay_direct",
      provider_order_id: "epd-gateway-test-1",
      replayed: false,
      redirect_url:
        "https://store.test/checkout/success?session_id=lago%3Ainvoice-1&provider=easy_pay_direct",
    });
    const replay = await handleEasyPayDirectCheckoutSubmission(
      request(),
      runtimeEnv,
      "request-epd-gateway-test-2",
      providerFetch,
    );
    await expect(replay.json()).resolves.toMatchObject({ status: "succeeded", replayed: true });
    expect(providerFetch).toHaveBeenCalledOnce();
    await expect(
      env.BILLING_DB.prepare(
        `SELECT execution.status AS execution_status, execution.provider_transaction_id,
                execution.provider_response_code, request.payment_status,
                execution.terms_accepted_at IS NOT NULL AS terms_accepted,
                execution.terms_version, request.ready_for_payment_processing,
                invoice.payment_status AS invoice_status
         FROM easy_pay_direct_payment_executions execution
         JOIN payment_requests request ON request.id = execution.payment_request_id
         JOIN invoices_payment_requests link ON link.payment_request_id = request.id
         JOIN invoices invoice ON invoice.id = link.invoice_id
         WHERE execution.payment_request_id = ?`,
      )
        .bind(paymentRequestId)
        .first(),
    ).resolves.toEqual({
      execution_status: "succeeded",
      provider_transaction_id: "epd-gateway-test-1",
      provider_response_code: "100",
      terms_accepted: 1,
      terms_version: "apps-serp-terms-and-privacy-2026-08-25",
      payment_status: "succeeded",
      ready_for_payment_processing: 0,
      invoice_status: "succeeded",
    });
    await expect(
      env.BILLING_DB.prepare(
        `SELECT profile.gateway_customer_vault_id, profile.initial_transaction_id,
                profile.status, subscription.payment_method_type,
                subscription.payment_method_id = profile.id AS profile_bound
         FROM subscriptions subscription
         JOIN provider_customer_profiles profile
           ON profile.organization_id = subscription.organization_id
          AND profile.id = subscription.payment_method_id
         WHERE subscription.id = ? AND subscription.organization_id = ?`,
      )
        .bind(recurringSubscriptionId, organizationId)
        .first(),
    ).resolves.toEqual({
      gateway_customer_vault_id: "87426631",
      initial_transaction_id: "epd-gateway-test-1",
      status: "active",
      payment_method_type: "provider",
      profile_bound: 1,
    });
    // A paid checkout alone cannot authorize renewal of every generic-plan product.
    expect(await enrollProductScopedAutomaticCollections(env.BILLING_DB)).toBe(0);
    await env.BILLING_DB.batch([
      env.BILLING_DB.prepare(`INSERT INTO subscription_checkout_products
        (subscription_id, organization_id, product_slug, created_at) VALUES (?, ?, 'sprout-video-downloader', ?)`).bind(
        recurringSubscriptionId,
        organizationId,
        now,
      ),
      env.BILLING_DB.prepare(`INSERT INTO subscription_invoice_contexts
        (invoice_id, organization_id, subscription_id, context_type, period_start, period_end, created_at)
        VALUES (?, ?, ?, 'initial', ?, '2026-10-01T00:00:00.000Z', ?)`).bind(
        invoiceId,
        organizationId,
        recurringSubscriptionId,
        now,
        now,
      ),
    ]);
    expect(await enrollProductScopedAutomaticCollections(env.BILLING_DB)).toBe(0);
    await env.BILLING_DB.prepare(`INSERT INTO easy_pay_direct_product_collection_policies
      (organization_id, product_slug, status, created_at) VALUES (?, 'sprout-video-downloader', 'enabled', ?)`)
      .bind(organizationId, now)
      .run();
    expect(await enrollProductScopedAutomaticCollections(env.BILLING_DB)).toBe(1);
    expect(await enrollProductScopedAutomaticCollections(env.BILLING_DB)).toBe(0);

    const renewalInvoice = `renewal-${invoiceId}`;
    await env.BILLING_DB.prepare(`INSERT INTO invoices
      (id, organization_id, customer_id, subscription_id, number, status, payment_status, currency,
       subtotal_minor, tax_minor, credits_minor, total_due_minor, version, finalized_at,
       payment_overdue, ready_for_payment_processing, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, 'finalized', 'pending', 'USD', 1999, 0, 1000, 999, 1, ?, 1, 1, ?, ?)`)
      .bind(
        renewalInvoice,
        organizationId,
        customerId,
        recurringSubscriptionId,
        renewalInvoice,
        now,
        now,
        now,
      )
      .run();
    const renewalEnv = new Proxy(runtimeEnv, {
      get(target, property, receiver) {
        if (property === "EASY_PAY_DIRECT_AUTOMATIC_COLLECTION_ENABLED") return "1";
        if (property === "EASY_PAY_DIRECT_AUTOMATIC_COLLECTION_SCOPE_MODE") return "product_scoped";
        return Reflect.get(target, property, receiver) as unknown;
      },
    }) as Env;
    await expect(
      prepareEasyPayDirectAutomaticCollection(renewalEnv, renewalInvoice, "canary-renewal"),
    ).resolves.toBe("processed");
    const automatic = await env.BILLING_DB.prepare(`SELECT execution.payment_request_id
      FROM easy_pay_direct_automatic_payment_executions execution JOIN invoices_payment_requests link
      ON link.payment_request_id = execution.payment_request_id WHERE link.invoice_id = ?`)
      .bind(renewalInvoice)
      .first<{ payment_request_id: string }>();
    expect(automatic).not.toBeNull();
    const renewalFetch = vi.fn<typeof fetch>(async (_input, init) => {
      const body = new URLSearchParams(String(init?.body));
      expect(body.get("customer_vault_id")).toBe("87426631");
      expect(body.get("initial_transaction_id")).toBe("epd-gateway-test-1");
      expect(body.get("amount")).toBe("9.99");
      expect(body.get("initiated_by")).toBe("merchant");
      expect(body.get("test_mode")).toBe("enabled");
      expect(body.has("payment_token")).toBe(false);
      return new Response(
        `response=1&responsetext=Approved&response_code=100&transactionid=canary-renewal&orderid=${automatic!.payment_request_id}`,
      );
    });
    // Both product pause and subscription pause are checked immediately before charge.
    await env.BILLING_DB.prepare(
      "UPDATE easy_pay_direct_product_collection_policies SET status = 'disabled' WHERE organization_id = ?",
    )
      .bind(organizationId)
      .run();
    await expect(
      processEasyPayDirectAutomaticCollection(
        renewalEnv,
        automatic!.payment_request_id,
        renewalFetch,
      ),
    ).resolves.toBe("deferred");
    expect(renewalFetch).not.toHaveBeenCalled();
    await env.BILLING_DB.prepare(
      "UPDATE easy_pay_direct_product_collection_policies SET status = 'enabled' WHERE organization_id = ?",
    )
      .bind(organizationId)
      .run();
    await env.BILLING_DB.prepare(
      "UPDATE easy_pay_direct_automatic_collection_scopes SET status = 'disabled' WHERE subscription_id = ?",
    )
      .bind(recurringSubscriptionId)
      .run();
    expect(await enrollProductScopedAutomaticCollections(env.BILLING_DB)).toBe(0);
    await expect(
      processEasyPayDirectAutomaticCollection(
        renewalEnv,
        automatic!.payment_request_id,
        renewalFetch,
      ),
    ).resolves.toBe("deferred");
    expect(renewalFetch).not.toHaveBeenCalled();
    await env.BILLING_DB.prepare(
      "UPDATE easy_pay_direct_automatic_collection_scopes SET status = 'enabled' WHERE subscription_id = ?",
    )
      .bind(recurringSubscriptionId)
      .run();
    await expect(
      processEasyPayDirectAutomaticCollection(
        renewalEnv,
        automatic!.payment_request_id,
        renewalFetch,
      ),
    ).resolves.toBe("processed");
    await expect(
      processEasyPayDirectAutomaticCollection(
        renewalEnv,
        automatic!.payment_request_id,
        renewalFetch,
      ),
    ).resolves.toBe("processed");
    expect(renewalFetch).toHaveBeenCalledOnce();
    await expect(
      env.BILLING_DB.prepare(
        `SELECT provider, signature_valid, processed_at IS NOT NULL AS processed
         FROM webhook_receipts
         WHERE provider = 'easy_pay_direct_gateway_test' AND provider_event_id LIKE 'gateway-test:%'`,
      ).first(),
    ).resolves.toEqual({
      provider: "easy_pay_direct_gateway_test",
      signature_valid: 0,
      processed: 1,
    });
  });

  it("binds an anonymous Store checkout to the submitted email before charging", async () => {
    const runtimeEnv = enabledEnv("gateway_test");
    await env.BILLING_DB.prepare(
      "UPDATE customers SET email = NULL WHERE id = ? AND organization_id = ?",
    )
      .bind(customerId, organizationId)
      .run();
    await env.BILLING_DB.prepare("UPDATE payment_requests SET email = NULL WHERE id = ?")
      .bind(paymentRequestId)
      .run();
    await runCheckoutWorkflow(runtimeEnv, checkoutParams(), immediateStep());
    const checkout = await env.BILLING_DB.prepare(
      `SELECT payment_url FROM payment_request_checkout_intents
       WHERE payment_request_id = ? AND provider = 'easy_pay_direct'`,
    )
      .bind(paymentRequestId)
      .first<{ payment_url: string }>();
    const checkoutForm = await easyPayDirectPaymentForm(new URL(checkout!.payment_url), runtimeEnv);
    expect(await checkoutForm.text()).toContain('placeholder="you@example.com"');
    const checkoutToken = new URL(checkout!.payment_url).searchParams.get("checkout")!;
    const providerFetch = vi.fn<typeof fetch>(async (_input, init) => {
      const body = new URLSearchParams(String(init?.body));
      expect(body.get("email")).toBe("guest@example.test");
      return new Response(
        "response=1&responsetext=Approved&response_code=100&transactionid=epd-guest-test-1&authcode=TEST&customer_vault_id=vault-guest-test-1",
      );
    });
    const response = await handleEasyPayDirectCheckoutSubmission(
      new Request("https://lago.test/easy_pay_direct/payment_form", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          checkout: checkoutToken,
          payment_token: "hosted-token-guest-1",
          phone: "+15555550125",
          email: "Guest@Example.Test",
          terms_accepted: true,
        }),
      }),
      runtimeEnv,
      "request-epd-guest-test",
      providerFetch,
    );
    await expect(response.json()).resolves.toMatchObject({ status: "succeeded" });
    await expect(
      env.BILLING_DB.prepare(
        `SELECT customer.email, execution.email_sha256 IS NOT NULL AS email_bound
         FROM easy_pay_direct_payment_executions execution
         JOIN payment_request_checkout_intents intent
           ON intent.id = execution.checkout_intent_id
         JOIN customers customer
           ON customer.id = intent.customer_id AND customer.organization_id = intent.organization_id
         WHERE execution.payment_request_id = ?`,
      )
        .bind(paymentRequestId)
        .first(),
    ).resolves.toEqual({ email: "guest@example.test", email_bound: 1 });
  });

  it("records a definitive live gateway vault rejection as failed with no transaction", async () => {
    const runtimeEnv = enabledEnv("production");
    await runCheckoutWorkflow(runtimeEnv, checkoutParams(), immediateStep());
    const checkout = await env.BILLING_DB.prepare(
      `SELECT payment_url FROM payment_request_checkout_intents
       WHERE payment_request_id = ? AND provider = 'easy_pay_direct'`,
    )
      .bind(paymentRequestId)
      .first<{ payment_url: string }>();
    const checkoutToken = new URL(checkout!.payment_url).searchParams.get("checkout")!;
    const providerFetch = vi.fn<typeof fetch>(async (input) =>
      String(input).includes("/customers?")
        ? Response.json({ data: [] })
        : new Response(
            "response=3&responsetext=Service+Unavailable&response_code=300&transactionid=0&refid=ref-123",
          ),
    );

    await expect(
      handleEasyPayDirectCheckoutSubmission(
        new Request("https://lago.test/easy_pay_direct/payment_form", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            checkout: checkoutToken,
            payment_token: "hosted-token-live-rejected",
            phone: "+15555550123",
            terms_accepted: true,
          }),
        }),
        runtimeEnv,
        "request-epd-live-rejected",
        providerFetch,
      ),
    ).rejects.toMatchObject({ status: 422, code: "300" });
    expect(providerFetch).toHaveBeenCalledTimes(2);
    await expect(
      env.BILLING_DB.prepare(
        `SELECT status, provider_transaction_id, provider_response_code, failure_code,
                failure_message
         FROM easy_pay_direct_payment_executions WHERE payment_request_id = ?`,
      )
        .bind(paymentRequestId)
        .first(),
    ).resolves.toEqual({
      status: "failed",
      provider_transaction_id: null,
      provider_response_code: "300",
      failure_code: "300",
      failure_message: "Service Unavailable",
    });
  });

  it("uses the newly submitted card instead of a returning customer's saved method", async () => {
    const runtimeEnv = enabledEnv("production");
    const now = new Date().toISOString();
    await env.BILLING_DB.prepare(
      `INSERT INTO provider_customer_profiles
       (id, organization_id, customer_id, provider, provider_account_code,
        provider_customer_id, provider_payment_method_id, gateway_customer_vault_id,
        gateway_billing_id, status, created_at, updated_at)
       VALUES (?, ?, ?, 'easy_pay_direct', 'epd-synthetic', 'returning-customer',
               'old-card-method', 'returning-vault', '111111', 'active', ?, ?)`,
    )
      .bind(`profile-${paymentRequestId}`, organizationId, customerId, now, now)
      .run();
    await runCheckoutWorkflow(runtimeEnv, checkoutParams(), immediateStep());
    const checkout = await env.BILLING_DB.prepare(
      `SELECT payment_url FROM payment_request_checkout_intents WHERE payment_request_id = ?`,
    )
      .bind(paymentRequestId)
      .first<{ payment_url: string }>();
    const providerFetch = vi.fn<typeof fetch>(async (input, init) => {
      const url = String(input);
      if (url.endsWith("/customers/returning-customer"))
        return Response.json({
          id: "returning-customer",
          email: "synthetic@example.com",
          epd_gateway_customer_vault_id: "returning-vault",
        });
      if (url.includes("/api/transact.php")) {
        const body = new URLSearchParams(String(init?.body));
        expect(body.get("payment_token")).toBe("new-card-token");
        expect(body.get("customer_vault_id")).toBe("returning-vault");
        expect(body.get("customer_vault")).toBe("add_billing");
        return new Response(
          `response=1&customer_vault_id=returning-vault&billing_id=${body.get("billing_id")}`,
        );
      }
      if (url.endsWith("/payment_methods")) {
        const body = JSON.parse(String(init?.body));
        expect(body.billing_id).not.toBe("111111");
        return Response.json({ id: "new-card-method" }, { status: 201 });
      }
      if (url.endsWith("/products"))
        return Response.json({
          id: "new-card-product",
          pricing: { amount: 1999, currency: "usd" },
        });
      if (url.endsWith("/orders")) {
        expect(JSON.parse(String(init?.body)).payment_method_id).toBe("new-card-method");
        return Response.json({
          id: "new-card-order",
          status: "pending",
          total: 1999,
          currency: "usd",
        });
      }
      throw new Error(`Unexpected EPD request: ${url}`);
    });
    const response = await handleEasyPayDirectCheckoutSubmission(
      new Request("https://lago.test/easy_pay_direct/payment_form", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          checkout: new URL(checkout!.payment_url).searchParams.get("checkout"),
          payment_token: "new-card-token",
          phone: "+15555550126",
          terms_accepted: true,
        }),
      }),
      runtimeEnv,
      "returning-card-regression",
      providerFetch,
    );
    expect(response.status).toBeLessThan(300);
    const profiles = await env.BILLING_DB.prepare(
      "SELECT provider_payment_method_id, checkout_intent_id FROM provider_customer_profiles WHERE customer_id = ?",
    )
      .bind(customerId)
      .all<{ provider_payment_method_id: string; checkout_intent_id: string | null }>();
    expect(profiles.results).toHaveLength(2);
    expect(
      profiles.results.find((profile) => profile.checkout_intent_id === null)
        ?.provider_payment_method_id,
    ).toBe("old-card-method");
    expect(
      profiles.results.find((profile) => profile.checkout_intent_id !== null)
        ?.provider_payment_method_id,
    ).toBe("new-card-method");
    const execution = await env.BILLING_DB.prepare(
      "SELECT id FROM easy_pay_direct_payment_executions WHERE payment_request_id = ?",
    )
      .bind(paymentRequestId)
      .first<{ id: string }>();
    await reconcileEasyPayDirectExecution(
      runtimeEnv,
      execution!.id,
      vi.fn<typeof fetch>(async () =>
        Response.json({
          id: "new-card-order",
          status: "succeeded",
          total: 1999,
          currency: "usd",
          transactions: [
            {
              id: "new-card-transaction",
              processor_transaction_id: "new-card-processor",
              status: "succeeded",
              type: "sale",
            },
          ],
        }),
      ),
    );
    const approvedProfiles = await env.BILLING_DB.prepare(
      "SELECT checkout_intent_id, initial_transaction_id FROM provider_customer_profiles WHERE customer_id = ?",
    )
      .bind(customerId)
      .all<{ checkout_intent_id: string | null; initial_transaction_id: string | null }>();
    expect(
      approvedProfiles.results.find((profile) => profile.checkout_intent_id !== null)
        ?.initial_transaction_id,
    ).toBe("new-card-processor");
    expect(
      approvedProfiles.results.find((profile) => profile.checkout_intent_id === null)
        ?.initial_transaction_id,
    ).toBeNull();
    expect(
      providerFetch.mock.calls.filter(([input]) => String(input).includes("/api/transact.php")),
    ).toHaveLength(1);
  });

  it("persists a live vault checkpoint and resumes Commerce without vaulting twice", async () => {
    const runtimeEnv = enabledEnv("production");
    await runCheckoutWorkflow(runtimeEnv, checkoutParams(), immediateStep());
    const checkout = await env.BILLING_DB.prepare(
      `SELECT payment_url FROM payment_request_checkout_intents
       WHERE payment_request_id = ? AND provider = 'easy_pay_direct'`,
    )
      .bind(paymentRequestId)
      .first<{ payment_url: string }>();
    const checkoutToken = new URL(checkout!.payment_url).searchParams.get("checkout")!;
    let commerceAvailable = false;
    const providerFetch = vi.fn<typeof fetch>(async (input) => {
      const url = String(input);
      if (url.includes("/api/transact.php")) {
        return new Response(
          "response=1&responsetext=Approved&response_code=100&customer_vault_id=vault-live-recovery&billing_id=12345678901234567890123456789012",
        );
      }
      if (url.includes("/customers?")) return Response.json({ data: [] });
      if (!commerceAvailable) {
        return Response.json(
          { error: { code: "commerce_unavailable", message: "Try again" } },
          { status: 503 },
        );
      }
      if (url.endsWith("/customers")) {
        return Response.json(
          { id: "epd-customer-recovered", default_payment_method: "epd-pm-recovered" },
          { status: 201 },
        );
      }
      if (url.endsWith("/customers/epd-customer-recovered"))
        return Response.json({
          id: "epd-customer-recovered",
          email: "synthetic@example.com",
          epd_gateway_customer_vault_id: "vault-live-recovery",
        });
      if (url.endsWith("/payment_methods")) return Response.json({ id: "epd-pm-recovered" });
      if (url.endsWith("/products")) {
        return Response.json(
          { id: "epd-product-recovered", pricing: { amount: 1999, currency: "usd" } },
          { status: 201 },
        );
      }
      if (url.endsWith("/orders")) {
        return Response.json(
          { id: "epd-order-recovered", status: "pending", total: 1999, currency: "usd" },
          { status: 201 },
        );
      }
      throw new Error(`Unexpected EPD request: ${url}`);
    });
    const submission = (paymentToken: string) =>
      new Request("https://lago.test/easy_pay_direct/payment_form", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          checkout: checkoutToken,
          payment_token: paymentToken,
          phone: "+15555550126",
          terms_accepted: true,
        }),
      });

    await expect(
      handleEasyPayDirectCheckoutSubmission(
        submission("one-time-token-before-outage"),
        runtimeEnv,
        "request-epd-recovery-1",
        providerFetch,
      ),
    ).rejects.toMatchObject({ status: 503, code: "commerce_unavailable" });
    await expect(
      env.BILLING_DB.prepare(
        `SELECT status, last_checkpoint, customer_vault_id, gateway_billing_id,
                provider_transaction_id, phone_ciphertext IS NOT NULL AS has_recovery_phone
         FROM easy_pay_direct_payment_executions WHERE payment_request_id = ?`,
      )
        .bind(paymentRequestId)
        .first(),
    ).resolves.toEqual({
      status: "unknown",
      last_checkpoint: "gateway_vaulted",
      customer_vault_id: "vault-live-recovery",
      gateway_billing_id: "12345678901234567890123456789012",
      provider_transaction_id: null,
      has_recovery_phone: 1,
    });

    commerceAvailable = true;
    const resumed = await handleEasyPayDirectCheckoutSubmission(
      submission("fresh-one-time-token-after-outage"),
      runtimeEnv,
      "request-epd-recovery-2",
      providerFetch,
    );
    await expect(resumed.json()).resolves.toMatchObject({
      status: "processing",
      provider_order_id: "epd-order-recovered",
    });
    expect(
      providerFetch.mock.calls.filter(([input]) => String(input).includes("/api/transact.php")),
    ).toHaveLength(1);
    await expect(
      env.BILLING_DB.prepare(
        `SELECT status, last_checkpoint, provider_customer_id, provider_payment_method_id,
                provider_product_id, provider_transaction_id, resume_count
         FROM easy_pay_direct_payment_executions WHERE payment_request_id = ?`,
      )
        .bind(paymentRequestId)
        .first(),
    ).resolves.toEqual({
      status: "processing",
      last_checkpoint: "provider_order",
      provider_customer_id: "epd-customer-recovered",
      provider_payment_method_id: "epd-pm-recovered",
      provider_product_id: "epd-product-recovered",
      provider_transaction_id: "epd-order-recovered",
      resume_count: 1,
    });
  });

  it("replaces a legacy alphanumeric billing checkpoint only after a fresh customer submission", async () => {
    const runtimeEnv = enabledEnv("production");
    await runCheckoutWorkflow(runtimeEnv, checkoutParams(), immediateStep());
    const checkout = await env.BILLING_DB.prepare(
      `SELECT payment_url FROM payment_request_checkout_intents
       WHERE payment_request_id = ? AND provider = 'easy_pay_direct'`,
    )
      .bind(paymentRequestId)
      .first<{ payment_url: string }>();
    const checkoutToken = new URL(checkout!.payment_url).searchParams.get("checkout")!;
    let gatewayCalls = 0;
    let paymentMethodCalls = 0;
    const providerFetch = vi.fn<typeof fetch>(async (input, init) => {
      const url = String(input);
      if (url.includes("/api/transact.php")) {
        gatewayCalls += 1;
        const body = new URLSearchParams(String(init?.body));
        if (gatewayCalls === 1) {
          expect(body.get("customer_vault")).toBe("add_customer");
          expect(body.get("payment_token")).toBe("token-before-commerce-rejection");
          return new Response(
            `response=1&responsetext=Approved&response_code=100&customer_vault_id=vault-legacy&billing_id=${body.get("billing_id")}`,
          );
        }
        expect(body.get("customer_vault")).toBe("add_billing");
        expect(body.get("customer_vault_id")).toBe("vault-legacy");
        expect(body.get("payment_token")).toBe("fresh-token-for-recovery");
        expect(body.get("billing_id")).toMatch(/^\d{32}$/u);
        return new Response(
          `response=1&responsetext=Approved&response_code=100&customer_vault_id=vault-legacy&billing_id=${body.get("billing_id")}`,
        );
      }
      if (url.includes("/customers?")) {
        return Response.json({ data: [] });
      }
      if (url.endsWith("/customers")) {
        if (gatewayCalls === 1) {
          return Response.json(
            { error: { code: "commerce_unavailable", message: "Try again" } },
            { status: 503 },
          );
        }
        return Response.json({ id: "epd-customer-legacy-recovery" }, { status: 201 });
      }
      if (url.endsWith("/customers/epd-customer-legacy-recovery"))
        return Response.json({
          id: "epd-customer-legacy-recovery",
          email: "synthetic@example.com",
          epd_gateway_customer_vault_id: "vault-legacy",
        });
      if (url.includes("/payment_methods")) {
        paymentMethodCalls += 1;
        const body = JSON.parse(String(init?.body)) as { billing_id?: string };
        expect(body.billing_id).toMatch(/^\d{32}$/u);
        return Response.json({ id: "epd-pm-legacy-recovery" }, { status: 201 });
      }
      if (url.endsWith("/products")) {
        return Response.json(
          { id: "epd-product-legacy-recovery", pricing: { amount: 1999, currency: "usd" } },
          { status: 201 },
        );
      }
      if (url.endsWith("/orders")) {
        return Response.json(
          { id: "epd-order-legacy-recovery", status: "pending", total: 1999, currency: "usd" },
          { status: 201 },
        );
      }
      throw new Error(`Unexpected EPD request: ${url}`);
    });
    const submission = (paymentToken: string) =>
      new Request("https://lago.test/easy_pay_direct/payment_form", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          checkout: checkoutToken,
          payment_token: paymentToken,
          phone: "+15555550127",
          terms_accepted: true,
        }),
      });

    await expect(
      handleEasyPayDirectCheckoutSubmission(
        submission("token-before-commerce-rejection"),
        runtimeEnv,
        "request-epd-legacy-billing-1",
        providerFetch,
      ),
    ).rejects.toMatchObject({ status: 503, code: "commerce_unavailable" });
    await env.BILLING_DB.prepare(
      `UPDATE easy_pay_direct_payment_executions
       SET gateway_billing_id = 'legacy-alphanumeric-id'
       WHERE payment_request_id = ?`,
    )
      .bind(paymentRequestId)
      .run();
    await expect(
      env.BILLING_DB.prepare(
        `SELECT status, last_checkpoint, customer_vault_id, gateway_billing_id,
                provider_customer_id, provider_payment_method_id
         FROM easy_pay_direct_payment_executions WHERE payment_request_id = ?`,
      )
        .bind(paymentRequestId)
        .first(),
    ).resolves.toEqual({
      status: "unknown",
      last_checkpoint: "gateway_vaulted",
      customer_vault_id: "vault-legacy",
      gateway_billing_id: "legacy-alphanumeric-id",
      provider_customer_id: null,
      provider_payment_method_id: null,
    });

    const execution = await env.BILLING_DB.prepare(
      `SELECT id, status, last_checkpoint, resume_count, failure_code, updated_at
       FROM easy_pay_direct_payment_executions WHERE payment_request_id = ?`,
    )
      .bind(paymentRequestId)
      .first<{ id: string }>();
    const callsBeforeRecovery = providerFetch.mock.calls.length;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      await expect(
        reconcileEasyPayDirectExecution(runtimeEnv, execution!.id, providerFetch),
      ).resolves.toBe("deferred");
    }
    expect(providerFetch).toHaveBeenCalledTimes(callsBeforeRecovery);
    await expect(
      env.BILLING_DB.prepare(
        `SELECT id, status, last_checkpoint, resume_count, failure_code, updated_at
         FROM easy_pay_direct_payment_executions WHERE payment_request_id = ?`,
      )
        .bind(paymentRequestId)
        .first(),
    ).resolves.toEqual(execution);

    const recovered = await handleEasyPayDirectCheckoutSubmission(
      submission("fresh-token-for-recovery"),
      runtimeEnv,
      "request-epd-legacy-billing-2",
      providerFetch,
    );
    await expect(recovered.json()).resolves.toMatchObject({
      status: "processing",
      provider_order_id: "epd-order-legacy-recovery",
    });
    expect(gatewayCalls).toBe(2);
    expect(paymentMethodCalls).toBe(1);
    await expect(
      env.BILLING_DB.prepare(
        `SELECT status, last_checkpoint, gateway_billing_id, provider_payment_method_id,
                provider_transaction_id, resume_count
         FROM easy_pay_direct_payment_executions WHERE payment_request_id = ?`,
      )
        .bind(paymentRequestId)
        .first(),
    ).resolves.toEqual({
      status: "processing",
      last_checkpoint: "provider_order",
      gateway_billing_id: expect.stringMatching(/^\d{32}$/u),
      provider_payment_method_id: "epd-pm-legacy-recovery",
      provider_transaction_id: "epd-order-legacy-recovery",
      resume_count: 1,
    });
  });

  it("reconciles a successful Commerce order before returning from checkout", async () => {
    const runtimeEnv = enabledEnv();
    await runCheckoutWorkflow(runtimeEnv, checkoutParams(), immediateStep());
    const checkout = await env.BILLING_DB.prepare(
      `SELECT payment_url, provider_token_sha256, status FROM payment_request_checkout_intents
       WHERE payment_request_id = ? AND provider = 'easy_pay_direct'`,
    )
      .bind(paymentRequestId)
      .first<{ payment_url: string; provider_token_sha256: string; status: string }>();
    const checkoutToken = new URL(checkout!.payment_url).searchParams.get("checkout")!;
    expect(checkout!.provider_token_sha256).toBe(await sha256Hex(checkoutToken));
    await expect(
      verifyEasyPayDirectCheckoutToken(checkoutToken, "synthetic-checkout-signing-secret"),
    ).resolves.toMatchObject({ intent: expect.any(String) });

    const providerFetch = vi.fn<typeof fetch>(async (input, init) => {
      const url = String(input);
      if (url.includes("/customers?")) return Response.json({ data: [] });
      if (url.endsWith("/customers")) {
        expect(JSON.parse(String(init?.body))).toMatchObject({
          email: "synthetic@example.com",
          phone: "+15555550123",
          epd_gateway_customer_vault_id: "card_visa",
        });
        return Response.json(
          { id: "epd-customer-1", default_payment_method: "epd-pm-1" },
          { status: 201 },
        );
      }
      if (url.endsWith("/products")) {
        expect(JSON.parse(String(init?.body))).toMatchObject({
          pricing: { amount: 1999, currency: "usd" },
        });
        return Response.json(
          { id: "epd-product-1", pricing: { amount: 1999, currency: "usd" } },
          { status: 201 },
        );
      }
      expect(url.endsWith("/orders")).toBe(true);
      const orderBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      expect(orderBody).not.toHaveProperty("amount");
      return Response.json(
        { id: "epd-order-1", status: "succeeded", total: 1999, currency: "usd" },
        { status: 201 },
      );
    });
    const request = () =>
      new Request("https://lago.test/easy_pay_direct/payment_form", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          checkout: checkoutToken,
          payment_token: "card_visa",
          phone: "+15555550123",
        }),
      });
    const first = await handleEasyPayDirectCheckoutSubmission(
      request(),
      runtimeEnv,
      "request-epd-1",
      providerFetch,
      "synthetic_qa",
    );
    await expect(first.json()).resolves.toMatchObject({
      status: "succeeded",
      provider: "easy_pay_direct",
      provider_order_id: "epd-order-1",
      replayed: false,
    });
    const replay = await handleEasyPayDirectCheckoutSubmission(
      request(),
      runtimeEnv,
      "request-epd-2",
      providerFetch,
      "synthetic_qa",
    );
    await expect(replay.json()).resolves.toMatchObject({ status: "succeeded", replayed: true });
    expect(providerFetch).toHaveBeenCalledTimes(4);
    await expect(
      env.BILLING_DB.prepare("SELECT payment_status FROM payment_requests WHERE id = ?")
        .bind(paymentRequestId)
        .first(),
    ).resolves.toEqual({ payment_status: "succeeded" });
    await expect(
      env.BILLING_DB.prepare(
        `SELECT provider_customer_id, provider_payment_method_id, gateway_customer_vault_id
       FROM provider_customer_profiles WHERE customer_id = ? AND provider = 'easy_pay_direct'`,
      )
        .bind(customerId)
        .first(),
    ).resolves.toEqual({
      provider_customer_id: "epd-customer-1",
      provider_payment_method_id: "epd-pm-1",
      gateway_customer_vault_id: "card_visa",
    });

    const execution = await env.BILLING_DB.prepare(
      `SELECT id FROM easy_pay_direct_payment_executions WHERE payment_request_id = ?`,
    )
      .bind(paymentRequestId)
      .first<{ id: string }>();
    const orderRead = vi.fn<typeof fetch>(async (input, init) => {
      expect(String(input).endsWith("/orders/epd-order-1")).toBe(true);
      expect(init?.method).toBe("GET");
      return Response.json({
        id: "epd-order-1",
        status: "succeeded",
        total: 1999,
        currency: "usd",
      });
    });
    await expect(
      reconcileEasyPayDirectExecution(runtimeEnv, execution!.id, orderRead),
    ).resolves.toBe("processed");
    expect(orderRead).not.toHaveBeenCalled();
    await expect(
      env.BILLING_DB.prepare(
        `SELECT provider, signature_valid, processed_at IS NOT NULL AS processed
         FROM webhook_receipts WHERE provider = 'easy_pay_direct_inline_confirmation'`,
      ).first(),
    ).resolves.toEqual({
      provider: "easy_pay_direct_inline_confirmation",
      signature_valid: 0,
      processed: 1,
    });

    const successPayload = JSON.stringify({
      id: "evt-order-succeeded-1",
      object: "event",
      type: "order.succeeded",
      livemode: false,
      data: {
        object: {
          id: "epd-order-1",
          object: "order",
          status: "succeeded",
          total: 1999,
          currency: "usd",
          metadata: { lago_payment_request_id: paymentRequestId },
        },
      },
    });
    await insertArchivedEvent(
      "epd_evt_order_success_1",
      "evt-order-succeeded-1",
      "order.succeeded",
      "epd-order-1",
      successPayload,
    );
    await expect(
      reconcileEasyPayDirectReceipt(runtimeEnv, "epd_evt_order_success_1"),
    ).resolves.toBe("processed");
    await expect(
      env.BILLING_DB.prepare(
        "SELECT payment_status, ready_for_payment_processing FROM payment_requests WHERE id = ?",
      )
        .bind(paymentRequestId)
        .first(),
    ).resolves.toEqual({ payment_status: "succeeded", ready_for_payment_processing: 0 });
    await expect(
      env.BILLING_DB.prepare(
        "SELECT status FROM easy_pay_direct_payment_executions WHERE payment_request_id = ?",
      )
        .bind(paymentRequestId)
        .first(),
    ).resolves.toEqual({ status: "succeeded" });

    const chargebackPayload = JSON.stringify({
      id: "evt-chargeback-1",
      object: "event",
      type: "order.chargeback.lost",
      livemode: false,
      data: {
        object: {
          id: "epd-order-1",
          object: "order",
          status: "lost",
          total: 1999,
          currency: "usd",
          metadata: { lago_payment_request_id: paymentRequestId },
        },
      },
    });
    await insertArchivedEvent(
      "epd_evt_chargeback_1",
      "evt-chargeback-1",
      "order.chargeback.lost",
      "epd-order-1",
      chargebackPayload,
    );
    await expect(reconcileEasyPayDirectReceipt(runtimeEnv, "epd_evt_chargeback_1")).resolves.toBe(
      "processed",
    );
    await expect(
      env.BILLING_DB.prepare(
        "SELECT provider, amount_minor, currency, status, livemode FROM payment_disputes WHERE provider_dispute_id = 'epd-order-1'",
      ).first(),
    ).resolves.toEqual({
      provider: "easy_pay_direct",
      amount_minor: 1999,
      currency: "USD",
      status: "lost",
      livemode: 0,
    });
  });

  it("converges a provider-voided order to one failed payment outcome", async () => {
    const runtimeEnv = enabledEnv();
    await runCheckoutWorkflow(runtimeEnv, checkoutParams(), immediateStep());
    const checkout = await env.BILLING_DB.prepare(
      `SELECT payment_url FROM payment_request_checkout_intents
       WHERE payment_request_id = ? AND provider = 'easy_pay_direct'`,
    )
      .bind(paymentRequestId)
      .first<{ payment_url: string }>();
    const checkoutToken = new URL(checkout!.payment_url).searchParams.get("checkout")!;
    const providerFetch = vi.fn<typeof fetch>(async (input) => {
      const url = String(input);
      if (url.includes("/customers?")) return Response.json({ data: [] });
      if (url.endsWith("/customers")) {
        return Response.json(
          { id: "epd-customer-void", default_payment_method: "epd-pm-void" },
          { status: 201 },
        );
      }
      if (url.endsWith("/products")) {
        return Response.json(
          { id: "epd-product-void", pricing: { amount: 1999, currency: "usd" } },
          { status: 201 },
        );
      }
      return Response.json(
        { id: "epd-order-void", status: "pending", total: 1999, currency: "usd" },
        { status: 201 },
      );
    });
    const submitted = await handleEasyPayDirectCheckoutSubmission(
      new Request("https://lago.test/easy_pay_direct/payment_form", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          checkout: checkoutToken,
          payment_token: "card_visa",
          phone: "+15555550124",
        }),
      }),
      runtimeEnv,
      "request-epd-void",
      providerFetch,
      "synthetic_qa",
    );
    expect(submitted.status).toBe(200);
    const execution = await env.BILLING_DB.prepare(
      `SELECT id FROM easy_pay_direct_payment_executions WHERE payment_request_id = ?`,
    )
      .bind(paymentRequestId)
      .first<{ id: string }>();

    await expect(
      reconcileEasyPayDirectExecution(
        runtimeEnv,
        execution!.id,
        vi.fn<typeof fetch>(async () =>
          Response.json({
            id: "epd-order-void",
            status: "voided",
            total: 1999,
            currency: "usd",
          }),
        ),
      ),
    ).resolves.toBe("processed");
    await expect(
      env.BILLING_DB.prepare(
        `SELECT execution.status AS execution_status, request.payment_status,
                request.ready_for_payment_processing
         FROM easy_pay_direct_payment_executions execution
         JOIN payment_requests request ON request.id = execution.payment_request_id
         WHERE execution.id = ?`,
      )
        .bind(execution!.id)
        .first(),
    ).resolves.toEqual({
      execution_status: "failed",
      payment_status: "failed",
      ready_for_payment_processing: 1,
    });
  });
});

async function insertArchivedEvent(
  receiptId: string,
  eventId: string,
  eventType: string,
  orderId: string,
  payload: string,
) {
  const archiveKey = `webhooks/easy-pay-direct/${eventId}.json`;
  await env.BILLING_ARTIFACTS.put(archiveKey, payload);
  await env.BILLING_DB.batch([
    env.BILLING_DB.prepare(
      `INSERT INTO webhook_receipts
       (id, provider, provider_account_code, provider_event_id, signature_valid,
        payload_sha256, received_at, processed_at, processing_error_code, archive_key)
       VALUES (?, 'easy_pay_direct', 'epd-synthetic', ?, 1, ?, ?, NULL, NULL, ?)`,
    ).bind(receiptId, eventId, await sha256Hex(payload), new Date().toISOString(), archiveKey),
    env.BILLING_DB.prepare(
      `INSERT INTO provider_webhook_events
       (receipt_id, organization_id, event_type, provider_transaction_id,
        invoice_id, normalized_status, normalized_at)
       VALUES (?, ?, ?, ?, NULL, NULL, NULL)`,
    ).bind(receiptId, organizationId, eventType, orderId),
  ]);
}

function checkoutParams() {
  const id = `payment-request-checkout-${paymentRequestId}-v1`;
  return {
    organizationId,
    paymentRequestId,
    paymentRequestVersion: 1,
    idempotencyKey: id,
    correlationId: id,
  };
}

async function productionSubmission() {
  const runtimeEnv = enabledEnv("production");
  await runCheckoutWorkflow(runtimeEnv, checkoutParams(), immediateStep());
  const checkout = await env.BILLING_DB.prepare(
    "SELECT payment_url FROM payment_request_checkout_intents WHERE payment_request_id = ?",
  )
    .bind(paymentRequestId)
    .first<{ payment_url: string }>();
  return {
    runtimeEnv,
    request: (paymentToken = "fictional-hosted-token") =>
      new Request("https://lago.test/easy_pay_direct/payment_form", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          checkout: new URL(checkout!.payment_url).searchParams.get("checkout"),
          payment_token: paymentToken,
          phone: "+15555550123",
          terms_accepted: true,
        }),
      }),
  };
}

function executionForTest() {
  return env.BILLING_DB.prepare(`SELECT id, status, failure_code, customer_vault_id, gateway_billing_id, provider_transaction_id
    FROM easy_pay_direct_payment_executions WHERE payment_request_id = ?`)
    .bind(paymentRequestId)
    .first<{ id: string; status: string; failure_code: string | null }>();
}

// Stateful contract fixture, NOT provider-backed acceptance. Billing IDs belong
// to one specific Gateway vault; a Commerce customer cannot see another vault.
function commerceVaultFixture(
  options: {
    existing?: boolean;
    exposeBinding?: boolean;
    rejectAttach?: boolean;
    ignoreRequestedBinding?: boolean;
    expectedToken?: string;
  } = {},
) {
  let exists = options.existing ?? true;
  let linkedVault = "fixture-existing-vault";
  const billings = new Map<string, Set<string>>();
  const operations: string[] = [];
  const savedVaults: string[] = [];
  const fetcher = vi.fn<typeof fetch>(async (input, init) => {
    const url = String(input);
    if (url.includes("/customers?")) {
      operations.push("lookup");
      return Response.json({
        data: exists ? [{ id: "fixture-customer", email: "synthetic@example.com" }] : [],
      });
    }
    if (url.endsWith("/customers/fixture-customer")) {
      operations.push("read_customer");
      expect(init?.method).toBe("GET");
      return Response.json({
        id: "fixture-customer",
        email: "synthetic@example.com",
        ...(options.exposeBinding === false ? {} : { epd_gateway_customer_vault_id: linkedVault }),
      });
    }
    if (url.includes("/api/transact.php")) {
      const body = new URLSearchParams(String(init?.body));
      operations.push(body.get("customer_vault")!);
      const vault = body.get("customer_vault_id") ?? "fixture-new-vault";
      const billing = body.get("billing_id")!;
      expect(body.get("payment_token")).toBe(options.expectedToken ?? "fictional-hosted-token");
      expect(body.has("type")).toBe(false); // Vault only, never charge.
      billings.set(vault, new Set([billing]));
      savedVaults.push(vault);
      return new Response(`response=1&customer_vault_id=${vault}&billing_id=${billing}`);
    }
    if (url.endsWith("/customers")) {
      operations.push("create_customer");
      expect(exists).toBe(false);
      exists = true;
      if (!options.ignoreRequestedBinding)
        linkedVault = JSON.parse(String(init?.body)).epd_gateway_customer_vault_id;
      return Response.json({
        id: "fixture-customer",
        default_payment_method: "not-the-submitted-card",
      });
    }
    if (url.endsWith("/payment_methods")) {
      operations.push("attach");
      expect(url.endsWith("/customers/fixture-customer/payment_methods")).toBe(true);
      const billing = JSON.parse(String(init?.body)).billing_id;
      if (!billings.get(linkedVault)?.has(billing) || options.rejectAttach)
        return Response.json(
          {
            error: {
              code: "validation_error",
              message: "Billing ID private-vault-reference not found",
            },
          },
          { status: 400 },
        );
      return Response.json({ id: "fixture-new-method", customer: "fixture-customer" });
    }
    if (url.endsWith("/products")) {
      operations.push("product");
      return Response.json({ id: "fixture-product", pricing: { amount: 1999, currency: "usd" } });
    }
    if (url.endsWith("/orders")) {
      operations.push("order");
      expect(JSON.parse(String(init?.body)).payment_method_id).toBe("fixture-new-method");
      return Response.json({
        id: `fixture-order-${paymentRequestId}`,
        status: "pending",
        total: 1999,
        currency: "usd",
      });
    }
    throw new Error(`Unexpected fixture endpoint: ${url}`);
  });
  return { fetcher, operations, savedVaults };
}

function enabledEnv(mode: "test" | "gateway_test" | "production" = "test"): Env {
  return new Proxy(env, {
    get(target, property, receiver) {
      if (property === "PAYMENT_MUTATIONS_ENABLED") return "1";
      if (property === "PUBLIC_BASE_URL") return "https://lago.test";
      if (property === "EASY_PAY_DIRECT_COMMERCE_API_KEY") {
        return mode === "production"
          ? "epd_synthetic_sk_live_secret"
          : "epd_synthetic_sk_test_secret";
      }
      if (property === "EASY_PAY_DIRECT_SECURITY_KEY") return "synthetic-security-key";
      if (property === "EASY_PAY_DIRECT_TOKENIZATION_KEY") return "synthetic-tokenization-key";
      if (property === "EASY_PAY_DIRECT_CHECKOUT_SIGNING_SECRET")
        return "synthetic-checkout-signing-secret";
      if (property === "EASY_PAY_DIRECT_NETWORK_MODE") return mode;
      if (property === "EASY_PAY_DIRECT_LIVEMODE_ALLOWED") return mode === "production" ? "1" : "0";
      if (property === "EASY_PAY_DIRECT_ACCOUNT_CODE") return "epd-synthetic";
      if (property === "EASY_PAY_DIRECT_ORGANIZATION_ID") return organizationId;
      if (property === "EASY_PAY_DIRECT_SUCCESS_REDIRECT_URL")
        return "https://store.test/checkout/success";
      if (property === "PROVIDER_READS_ENABLED") return "1";
      return Reflect.get(target, property, receiver) as unknown;
    },
  }) as Env;
}

function immediateStep(): WorkflowStep {
  return {
    async do(_name: string, ...args: unknown[]) {
      const callback = args.find((argument) => typeof argument === "function") as
        | (() => Promise<unknown>)
        | undefined;
      if (!callback) throw new Error("missing_workflow_callback");
      return callback();
    },
  } as unknown as WorkflowStep;
}
