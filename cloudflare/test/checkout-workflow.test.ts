import { env } from "cloudflare:test";
import type { WorkflowStep } from "cloudflare:workers";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  dispatchPendingPaymentRequestCheckouts,
  runCheckoutWorkflow,
  type CheckoutWorkflowParams,
} from "../src/workflows/checkout";

const organizationId = "org-checkout-workflow";
const customerId = "customer-checkout-workflow";
const paymentRequestId = "payment-request-checkout-workflow";

beforeEach(async () => {
  const now = "2026-08-15T06:00:00.000Z";
  await env.BILLING_DB.batch([
    env.BILLING_DB.prepare(
      `INSERT OR IGNORE INTO organizations (id, external_id, name, created_at, updated_at)
       VALUES (?, 'checkout-workflow', 'Checkout Workflow', ?, ?)`,
    ).bind(organizationId, now, now),
    env.BILLING_DB.prepare(
      `INSERT OR IGNORE INTO customers
       (id, organization_id, external_id, email, name, currency, metadata_json,
        payment_provider, payment_provider_code, created_at, updated_at)
       VALUES (?, ?, 'checkout-customer', 'billing@example.com', 'Checkout Customer', 'USD',
               '{}', 'authorize_net', 'checkout-provider', ?, ?)`,
    ).bind(customerId, organizationId, now, now),
    env.BILLING_DB.prepare(
      `INSERT OR IGNORE INTO invoices
       (id, organization_id, customer_id, number, status, payment_status, currency,
        subtotal_minor, tax_minor, credits_minor, total_due_minor, version, finalized_at,
        payment_overdue, ready_for_payment_processing, created_at, updated_at)
       VALUES ('invoice-checkout-workflow', ?, ?, 'INV-CHECKOUT', 'finalized', 'pending',
               'USD', 1700, 0, 0, 1700, 1, ?, 1, 1, ?, ?)`,
    ).bind(organizationId, customerId, now, now, now),
    env.BILLING_DB.prepare(
      `INSERT OR IGNORE INTO payment_requests
       (id, organization_id, customer_id, amount_minor, currency, email, payment_attempts,
        payment_status, ready_for_payment_processing, version, created_at, updated_at)
       VALUES (?, ?, ?, 1700, 'USD', 'billing@example.com', 0, 'pending', 1, 1, ?, ?)`,
    ).bind(paymentRequestId, organizationId, customerId, now, now),
    env.BILLING_DB.prepare(
      `INSERT OR IGNORE INTO invoices_payment_requests
       (id, organization_id, payment_request_id, invoice_id, invoice_version,
        created_at, updated_at)
       VALUES ('link-checkout-workflow', ?, ?, 'invoice-checkout-workflow', 1, ?, ?)`,
    ).bind(organizationId, paymentRequestId, now, now),
  ]);
  await env.BILLING_DB.batch([
    env.BILLING_DB.prepare(
      `DELETE FROM outbox_events WHERE organization_id = ?
       AND aggregate_type = 'payment_request_checkout'`,
    ).bind(organizationId),
    env.BILLING_DB.prepare(
      `DELETE FROM payment_request_checkout_intents WHERE organization_id = ?`,
    ).bind(organizationId),
    env.BILLING_DB.prepare(
      `UPDATE payment_requests
       SET payment_status = 'pending', ready_for_payment_processing = 1, version = 1,
           updated_at = ? WHERE id = ? AND organization_id = ?`,
    ).bind(now, paymentRequestId, organizationId),
    env.BILLING_DB.prepare(
      `UPDATE invoices
       SET payment_status = 'pending', payment_overdue = 1,
           ready_for_payment_processing = 1, version = 1, updated_at = ?
       WHERE id = 'invoice-checkout-workflow' AND organization_id = ?`,
    ).bind(now, organizationId),
  ]);
});

describe("payment request checkout workflow", () => {
  it("dispatches only when payment mutations are enabled", async () => {
    const create = vi.fn(async () => ({ id: "synthetic-workflow" }));
    await expect(
      dispatchPendingPaymentRequestCheckouts({
        BILLING_DB: env.BILLING_DB,
        CHECKOUT_WORKFLOW: { create } as unknown as Env["CHECKOUT_WORKFLOW"],
        PAYMENT_MUTATIONS_ENABLED: "0",
      }),
    ).resolves.toEqual({ candidates: 0, dispatched: 0 });
    expect(create).not.toHaveBeenCalled();

    await expect(
      dispatchPendingPaymentRequestCheckouts({
        BILLING_DB: env.BILLING_DB,
        CHECKOUT_WORKFLOW: { create } as unknown as Env["CHECKOUT_WORKFLOW"],
        PAYMENT_MUTATIONS_ENABLED: "1",
      }),
    ).resolves.toEqual({ candidates: 1, dispatched: 1 });
    expect(create).toHaveBeenCalledWith({
      id: `payment-request-checkout-${paymentRequestId}-v1`,
      params: checkoutParams(),
    });
  });

  it("persists a sensitive hosted-link outcome and replays without another provider call", async () => {
    const providerFetch = vi.fn<typeof fetch>(async () =>
      Response.json({ token: "synthetic-payment-request-secret-token" }),
    );
    const workflowEnv = enabledEnv();
    await expect(
      runCheckoutWorkflow(workflowEnv, checkoutParams(), immediateStep(), providerFetch),
    ).resolves.toMatchObject({ accepted: true, replayed: false, paymentRequestId });
    await expect(
      runCheckoutWorkflow(workflowEnv, checkoutParams(), immediateStep(), providerFetch),
    ).resolves.toMatchObject({ accepted: true, replayed: true, paymentRequestId });
    expect(providerFetch).toHaveBeenCalledOnce();

    const intent = await env.BILLING_DB.prepare(
      `SELECT status, payment_url, provider_token_sha256, failure_code, version
       FROM payment_request_checkout_intents WHERE payment_request_id = ?`,
    )
      .bind(paymentRequestId)
      .first<{
        status: string;
        payment_url: string;
        provider_token_sha256: string;
        failure_code: string | null;
        version: number;
      }>();
    expect(intent).toMatchObject({ status: "succeeded", failure_code: null, version: 3 });
    expect(intent?.payment_url).toContain("token=synthetic-payment-request-secret-token");
    expect(intent?.provider_token_sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(intent?.provider_token_sha256).not.toContain("synthetic-payment-request-secret-token");

    const event = await env.BILLING_DB.prepare(
      `SELECT event_type, payload_json FROM outbox_events
       WHERE event_type = 'payment_request.checkout_url_created' AND aggregate_id =
         (SELECT id FROM payment_request_checkout_intents WHERE payment_request_id = ?)`,
    )
      .bind(paymentRequestId)
      .first<{ event_type: string; payload_json: string }>();
    expect(event?.event_type).toBe("payment_request.checkout_url_created");
    expect(event?.payload_json).not.toContain("synthetic-payment-request-secret-token");
    expect(event?.payload_json).not.toContain("payment_url");
  });

  it("records a bounded provider failure without retaining a URL or token", async () => {
    const providerFetch = vi.fn<typeof fetch>(async () =>
      Response.json(
        { messages: { message: [{ code: "E00027", text: "Synthetic provider rejection" }] } },
        { status: 400 },
      ),
    );
    await expect(
      runCheckoutWorkflow(enabledEnv(), checkoutParams(), immediateStep(), providerFetch),
    ).rejects.toMatchObject({ code: "authorize_net_error" });
    await expect(
      env.BILLING_DB.prepare(
        `SELECT status, payment_url, provider_token_sha256, failure_code
         FROM payment_request_checkout_intents WHERE payment_request_id = ?`,
      )
        .bind(paymentRequestId)
        .first(),
    ).resolves.toEqual({
      status: "failed",
      payment_url: null,
      provider_token_sha256: null,
      failure_code: "authorize_net_error",
    });
    await expect(
      env.BILLING_DB.prepare(
        `SELECT event_type FROM outbox_events
         WHERE event_type = 'payment_request.payment_failure' AND aggregate_id =
           (SELECT id FROM payment_request_checkout_intents WHERE payment_request_id = ?)`,
      )
        .bind(paymentRequestId)
        .first(),
    ).resolves.toEqual({ event_type: "payment_request.payment_failure" });
  });
});

function checkoutParams(): CheckoutWorkflowParams {
  const instanceId = `payment-request-checkout-${paymentRequestId}-v1`;
  return {
    organizationId,
    paymentRequestId,
    paymentRequestVersion: 1,
    idempotencyKey: instanceId,
    correlationId: instanceId,
  };
}

function enabledEnv(): Env {
  return new Proxy(env, {
    get(target, property, receiver) {
      if (property === "PAYMENT_MUTATIONS_ENABLED") return "1";
      if (property === "PUBLIC_BASE_URL") return "https://lago.test";
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
