import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import { handleOperatorObservabilityRequest } from "../src/operator/observability";

type ExecutionStatus = "pending" | "processing" | "succeeded" | "failed" | "unknown";

async function organization(prefix: string): Promise<string> {
  const id = `${prefix}-${crypto.randomUUID()}`;
  const now = new Date().toISOString();
  await env.BILLING_DB.prepare(
    `INSERT INTO organizations (id, external_id, name, created_at, updated_at)
     VALUES (?, ?, 'EPD review fixture', ?, ?)`,
  )
    .bind(id, id, now, now)
    .run();
  return id;
}

async function checkoutExecution(
  organizationId: string,
  input: {
    status: ExecutionStatus;
    updatedAt: string;
    failureCode?: string | null;
    checkpoint?: string;
  },
): Promise<string> {
  const id = crypto.randomUUID();
  const customerId = `customer-${id}`;
  const requestId = `request-${id}`;
  const intentId = `intent-${id}`;
  await env.BILLING_DB.batch([
    env.BILLING_DB.prepare(
      `INSERT INTO customers
       (id, organization_id, external_id, email, name, currency, metadata_json,
        payment_provider, payment_provider_code, created_at, updated_at)
       VALUES (?, ?, ?, 'private-customer@example.invalid', 'Private customer', 'USD', '{}',
               'easy_pay_direct', 'epd-review', ?, ?)`,
    ).bind(customerId, organizationId, customerId, input.updatedAt, input.updatedAt),
    env.BILLING_DB.prepare(
      `INSERT INTO payment_requests
       (id, organization_id, customer_id, amount_minor, currency, email, payment_status,
        ready_for_payment_processing, version, created_at, updated_at)
       VALUES (?, ?, ?, 900, 'USD', 'private-customer@example.invalid', 'pending', 1, 1, ?, ?)`,
    ).bind(requestId, organizationId, customerId, input.updatedAt, input.updatedAt),
    env.BILLING_DB.prepare(
      `INSERT INTO payment_request_checkout_intents
       (id, organization_id, payment_request_id, customer_id, provider, provider_account_code,
        idempotency_key, request_sha256, amount_minor, currency, payment_request_version,
        status, payment_url, provider_token_sha256, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'easy_pay_direct', 'epd-review', ?, 'private-request-hash',
               900, 'USD', 1, 'succeeded', 'https://private.invalid/checkout',
               'private-provider-token-hash', ?, ?)`,
    ).bind(
      intentId,
      organizationId,
      requestId,
      customerId,
      crypto.randomUUID(),
      input.updatedAt,
      input.updatedAt,
    ),
    env.BILLING_DB.prepare(
      `INSERT INTO easy_pay_direct_payment_executions
       (id, organization_id, checkout_intent_id, payment_request_id, provider_account_code,
        request_sha256, payment_token_sha256, phone_sha256, customer_idempotency_key,
        payment_method_idempotency_key, product_idempotency_key, order_idempotency_key,
        status, failure_code, last_checkpoint, payment_backend, charge_transport,
        created_at, updated_at)
       VALUES (?, ?, ?, ?, 'epd-review', 'private-request-hash', 'private-payment-token-hash',
               'private-phone-hash', ?, ?, ?, ?, ?, ?, ?, 'gateway_vault', 'gateway', ?, ?)`,
    ).bind(
      id,
      organizationId,
      intentId,
      requestId,
      crypto.randomUUID(),
      crypto.randomUUID(),
      crypto.randomUUID(),
      crypto.randomUUID(),
      input.status,
      input.failureCode ?? null,
      input.checkpoint ?? "created",
      input.updatedAt,
      input.updatedAt,
    ),
  ]);
  return id;
}

async function automaticExecution(
  organizationId: string,
  input: { status: ExecutionStatus; updatedAt: string; failureCode?: string | null },
): Promise<string> {
  const id = crypto.randomUUID();
  const customerId = `customer-${id}`;
  const requestId = `request-${id}`;
  const profileId = `profile-${id}`;
  await env.BILLING_DB.batch([
    env.BILLING_DB.prepare(
      `INSERT INTO customers
       (id, organization_id, external_id, email, name, currency, metadata_json,
        payment_provider, payment_provider_code, created_at, updated_at)
       VALUES (?, ?, ?, 'private-renewal@example.invalid', 'Private renewal', 'USD', '{}',
               'easy_pay_direct', 'epd-review', ?, ?)`,
    ).bind(customerId, organizationId, customerId, input.updatedAt, input.updatedAt),
    env.BILLING_DB.prepare(
      `INSERT INTO payment_requests
       (id, organization_id, customer_id, amount_minor, currency, email, payment_status,
        ready_for_payment_processing, version, created_at, updated_at)
       VALUES (?, ?, ?, 900, 'USD', 'private-renewal@example.invalid', 'pending', 1, 1, ?, ?)`,
    ).bind(requestId, organizationId, customerId, input.updatedAt, input.updatedAt),
    env.BILLING_DB.prepare(
      `INSERT INTO provider_customer_profiles
       (id, organization_id, customer_id, provider, provider_account_code, provider_customer_id,
        gateway_customer_vault_id, initial_transaction_id, status, payment_backend,
        created_at, updated_at)
       VALUES (?, ?, ?, 'easy_pay_direct', 'epd-review', 'private-provider-customer',
               'private-vault', 'private-initial-transaction', 'active', 'gateway_vault', ?, ?)`,
    ).bind(profileId, organizationId, customerId, input.updatedAt, input.updatedAt),
    env.BILLING_DB.prepare(
      `INSERT INTO easy_pay_direct_automatic_payment_executions
       (id, organization_id, payment_request_id, customer_id, provider_profile_id,
        provider_account_code, request_sha256, gateway_customer_vault_id,
        initial_transaction_id, order_reference, status, failure_code,
        payment_backend, charge_transport, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'epd-review', 'private-renewal-hash', 'private-vault',
               'private-initial-transaction', ?, ?, ?, 'gateway_vault', 'gateway', ?, ?)`,
    ).bind(
      id,
      organizationId,
      requestId,
      customerId,
      profileId,
      `private-order-${id}`,
      input.status,
      input.failureCode ?? null,
      input.updatedAt,
      input.updatedAt,
    ),
  ]);
  return id;
}

describe("operator EPD payment execution review", () => {
  it("reports only tenant-scoped held executions using a redacted diagnostic contract", async () => {
    const primary = await organization("epd-observability-primary");
    const secondary = await organization("epd-observability-secondary");
    const old = new Date(Date.now() - 24 * 60 * 60 * 1_000).toISOString();
    const recent = new Date().toISOString();
    const unknownCheckout = await checkoutExecution(primary, {
      status: "unknown",
      updatedAt: old,
      failureCode: "sk_live_privatecredentialvalue",
      checkpoint: "provider_customer",
    });
    const staleCheckout = await checkoutExecution(primary, {
      status: "processing",
      updatedAt: old,
      failureCode: "easy_pay_direct_order_read_pending",
      checkpoint: "provider_order",
    });
    const pendingCheckout = await checkoutExecution(primary, {
      status: "pending",
      updatedAt: old,
      failureCode: "easy_pay_direct_recovery_pending",
      checkpoint: "provider_customer",
    });
    const unknownAutomatic = await automaticExecution(primary, {
      status: "unknown",
      updatedAt: old,
      failureCode: "easy_pay_direct_gateway_outcome_unknown",
    });
    await checkoutExecution(primary, { status: "processing", updatedAt: recent });
    await checkoutExecution(primary, { status: "failed", updatedAt: old });
    await checkoutExecution(secondary, {
      status: "unknown",
      updatedAt: old,
      failureCode: "cross_tenant_private_code",
    });

    const response = await handleOperatorObservabilityRequest(
      new Request("https://operator.test/api/operator/v1/observability/payment-executions"),
      env.BILLING_DB,
      primary,
      "request-epd-review",
    );
    expect(response?.status).toBe(200);
    const body = (await response?.json()) as {
      payment_executions: Array<Record<string, unknown>>;
      summary: Record<string, number | null>;
    };
    expect(body.summary).toMatchObject({
      total_count: 4,
      checkout_count: 3,
      automatic_count: 1,
      pending_count: 1,
      processing_count: 1,
      unknown_count: 2,
    });
    expect(body.summary.oldest_age_seconds).toBeGreaterThanOrEqual(23 * 60 * 60);
    expect(body.payment_executions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          lago_id: unknownCheckout,
          execution_kind: "checkout",
          status: "unknown",
          review_reason: "unknown_outcome",
          checkpoint: "provider_customer",
          failure_code: "[redacted]",
          provider_transaction_recorded: false,
        }),
        expect.objectContaining({
          lago_id: staleCheckout,
          execution_kind: "checkout",
          status: "processing",
          review_reason: "stale_processing",
          checkpoint: "provider_order",
          failure_code: "easy_pay_direct_order_read_pending",
        }),
        expect.objectContaining({
          lago_id: pendingCheckout,
          execution_kind: "checkout",
          status: "pending",
          review_reason: "pending_with_failure",
          checkpoint: "provider_customer",
          failure_code: "easy_pay_direct_recovery_pending",
        }),
        expect.objectContaining({
          lago_id: unknownAutomatic,
          execution_kind: "automatic",
          status: "unknown",
          checkpoint: "created",
          failure_code: "easy_pay_direct_gateway_outcome_unknown",
        }),
      ]),
    );
    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain("cross_tenant_private_code");
    expect(serialized).not.toContain("private-customer@example.invalid");
    expect(serialized).not.toContain("private-payment-token-hash");
    expect(serialized).not.toContain("private-provider-customer");
    expect(serialized).not.toContain("private-vault");
    expect(serialized).not.toContain("private-order-");
  });

  it("separates reviewed history without resolving or hiding executions and reopens changed evidence", async () => {
    const tenant = await organization("review-annotation");
    const now = new Date().toISOString();
    const id = await checkoutExecution(tenant, { status: "unknown", updatedAt: now });
    const other = await checkoutExecution(tenant, { status: "unknown", updatedAt: now });
    const invoiceId = crypto.randomUUID();
    await env.BILLING_DB.batch([
      env.BILLING_DB.prepare(`INSERT INTO invoices
        (id,organization_id,customer_id,status,payment_status,currency,payment_overdue,created_at,updated_at)
        VALUES (?, ?, ?, 'finalized','pending','USD',1,?,?)`).bind(
        invoiceId,
        tenant,
        `customer-${id}`,
        now,
        now,
      ),
      env.BILLING_DB.prepare(`INSERT INTO invoices_payment_requests
        (id,organization_id,payment_request_id,invoice_id,invoice_version,created_at,updated_at)
        VALUES (?, ?, ?, ?, 1, ?, ?)`).bind(
        crypto.randomUUID(),
        tenant,
        `request-${id}`,
        invoiceId,
        now,
        now,
      ),
    ]);
    const note = {
      execution_id: id,
      outcome: "no_matching_gateway_charge_found",
      checkpoint: "created",
      resume_count: 0,
      failure_code: null,
    };
    const metadataId = crypto.randomUUID();
    await env.BILLING_DB.prepare(`INSERT INTO invoice_metadata
      (id,organization_id,invoice_id,key,value,created_at,updated_at)
      VALUES (?, ?, ?, 'epd_execution_review', ?, ?, ?)`)
      .bind(metadataId, tenant, invoiceId, JSON.stringify(note), now, now)
      .run();
    async function readReview() {
      const response = await handleOperatorObservabilityRequest(
        new Request("https://operator.test/api/operator/v1/observability/payment-executions"),
        env.BILLING_DB,
        tenant,
        "review-annotation-test",
      );
      return response!.json<{
        summary: { total_count: number; reviewed_count: number; action_required_count: number };
        payment_executions: Array<{ lago_id: string; status: string; review_status: string }>;
      }>();
    }
    const reviewed = await readReview();
    expect(reviewed.summary).toMatchObject({
      total_count: 2,
      reviewed_count: 1,
      action_required_count: 1,
    });
    expect(reviewed.payment_executions[0]?.lago_id).toBe(other);
    expect(reviewed.payment_executions).toContainEqual(
      expect.objectContaining({
        lago_id: id,
        status: "unknown",
        review_status: "reviewed_no_gateway_match",
      }),
    );
    for (const invalid of [
      "not json",
      JSON.stringify({ ...note, execution_id: other }),
      JSON.stringify({ ...note, checkpoint: "provider_customer" }),
    ]) {
      await env.BILLING_DB.prepare("UPDATE invoice_metadata SET value=? WHERE id=?")
        .bind(invalid, metadataId)
        .run();
      expect((await readReview()).summary.reviewed_count).toBe(0);
    }
    await env.BILLING_DB.prepare("UPDATE invoice_metadata SET value=? WHERE id=?")
      .bind(JSON.stringify(note), metadataId)
      .run();
    await env.BILLING_DB.prepare(
      "UPDATE easy_pay_direct_payment_executions SET resume_count=1 WHERE id=?",
    )
      .bind(id)
      .run();
    expect((await readReview()).summary.reviewed_count).toBe(0);
    await env.BILLING_DB.prepare(
      "UPDATE easy_pay_direct_payment_executions SET resume_count=0, provider_transaction_id='test-new-evidence' WHERE id=?",
    )
      .bind(id)
      .run();
    expect((await readReview()).summary.reviewed_count).toBe(0);
    expect(
      await env.BILLING_DB.prepare(
        "SELECT status FROM easy_pay_direct_payment_executions WHERE id=?",
      )
        .bind(id)
        .first("status"),
    ).toBe("unknown");
  });

  it("does not handle mutations", async () => {
    const primary = await organization("epd-observability-read-only");
    const response = await handleOperatorObservabilityRequest(
      new Request("https://operator.test/api/operator/v1/observability/payment-executions", {
        method: "POST",
      }),
      env.BILLING_DB,
      primary,
      "request-epd-review-mutation",
    );
    expect(response).toBeNull();
  });
});
