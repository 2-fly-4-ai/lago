import { env } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import { checkpointEasyPayDirectRefund } from "../src/billing/easy-pay-direct-refund-reconciliation";
import {
  submitGatewayRefundOperation,
  readGatewayRefundOperation,
} from "../src/billing/easy-pay-direct-gateway-refund-operation";
async function fixture() {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  await env.BILLING_DB.batch([
    env.BILLING_DB.prepare(
      "INSERT INTO organizations(id,external_id,name,created_at,updated_at) VALUES(?,?,'Fixture',?,?)",
    ).bind(id, id, now, now),
    env.BILLING_DB.prepare(
      "INSERT INTO customers(id,organization_id,external_id,currency,created_at,updated_at) VALUES(?,?,?,'USD',?,?)",
    ).bind(id, id, id, now, now),
    env.BILLING_DB.prepare(
      "INSERT INTO invoices(id,organization_id,customer_id,status,payment_status,currency,created_at,updated_at) VALUES(?,?,?,'finalized','succeeded','USD',?,?)",
    ).bind(id, id, id, now, now),
    env.BILLING_DB.prepare(
      "INSERT INTO payment_attempts(id,organization_id,invoice_id,provider,provider_account_code,idempotency_key,amount_minor,currency,status,created_at,updated_at) VALUES(?,?,?,'easy_pay_direct',?,?,900,'USD','succeeded',?,?)",
    ).bind(id, id, id, id, id, now, now),
    env.BILLING_DB.prepare(
      "INSERT INTO provider_refund_operations(id,organization_id,invoice_id,payment_attempt_id,provider,provider_account_code,provider_payment_id,idempotency_key,request_sha256,provider_idempotency_key,amount_minor,currency,status,created_at,updated_at) VALUES(?,?,?,?,'easy_pay_direct',?,'12345',?,?,?,100,'USD','submitted',?,?)",
    ).bind(id, id, id, id, id, id, id, id, now, now),
  ]);
  const runtime = new Proxy(env, {
    get(target, key, receiver) {
      return (
        (
          {
            APP_ENV: "test",
            EASY_PAY_DIRECT_NETWORK_MODE: "gateway_test",
            EASY_PAY_DIRECT_LIVEMODE_ALLOWED: "0",
            EASY_PAY_DIRECT_SECURITY_KEY: "fixture",
          } as Record<string, string>
        )[String(key)] ?? Reflect.get(target, key, receiver)
      );
    },
  });
  return {
    id,
    runtime,
    input: {
      organizationId: id,
      providerAccountCode: id,
      orderId: "12345",
      amountMinor: 100,
      currency: "USD",
      idempotencyKey: id,
    },
  };
}
const sale =
  "<nm_response><transaction><transaction_id>12345</transaction_id><currency>USD</currency><condition>complete</condition><action><action_type>sale</action_type><success>1</success><amount>9.00</amount></action></transaction></nm_response>";
describe("Gateway durable refund operation, local D1 / mocked network", () => {
  it("persists safe preflight diagnostics without refund submission or replay", async () => {
    const f = await fixture();
    const provider = vi.fn<typeof fetch>(async () => new Response("private body"));
    const result = await submitGatewayRefundOperation(
      f.runtime,
      f.input,
      provider,
      async () => undefined,
    );
    expect(result.status).toBe("unknown");
    expect(result.responseText).toContain(
      "gateway_refund_diagnostic:preflight_query:transaction_count",
    );
    expect(result.responseText).not.toContain("private");
    // The outer ledger stores this complete public-safe message on reconciliation.
    await env.BILLING_DB.prepare(
      "UPDATE provider_refund_operations SET failure_message = ? WHERE id = ?",
    )
      .bind(result.responseText, f.id)
      .run();
    expect(
      await submitGatewayRefundOperation(f.runtime, f.input, provider, async () => undefined),
    ).toEqual(result);
    expect(provider).toHaveBeenCalledTimes(1);
  });
  it("separate partial refunds may share the original sale without checkpoint collisions", async () => {
    const f = await fixture();
    const second = crypto.randomUUID();
    await env.BILLING_DB.prepare(`INSERT INTO provider_refund_operations(id,organization_id,invoice_id,payment_attempt_id,provider,provider_account_code,provider_payment_id,idempotency_key,request_sha256,provider_idempotency_key,amount_minor,currency,status,created_at,updated_at)
      SELECT ?,organization_id,invoice_id,payment_attempt_id,provider,provider_account_code,provider_payment_id,?,?,?,amount_minor,currency,status,created_at,updated_at FROM provider_refund_operations WHERE id = ?`)
      .bind(second, second, second, second, f.id)
      .run();
    const provider = vi.fn<typeof fetch>(
      async (url) =>
        new Response(String(url).endsWith("query.php") ? sale : "response=1&transactionid=12345"),
    );
    for (const operationId of [f.id, second]) {
      const input = { ...f.input, idempotencyKey: operationId };
      expect(
        await submitGatewayRefundOperation(f.runtime, input, provider, (transactionId) =>
          checkpointEasyPayDirectRefund(env.BILLING_DB, { ...input, operationId }, transactionId),
        ),
      ).toMatchObject({ id: `gateway-operation:${operationId}`, status: "succeeded" });
    }
    expect(provider).toHaveBeenCalledTimes(4);
    const rows = await env.BILLING_DB.prepare(
      "SELECT provider_refund_transaction_id FROM provider_refund_operations WHERE organization_id = ?",
    )
      .bind(f.id)
      .all();
    expect(new Set(rows.results.map((row) => row.provider_refund_transaction_id)).size).toBe(2);
  });
  it("concurrent calls claim exactly one submission", async () => {
    const f = await fixture();
    const provider = vi.fn<typeof fetch>(
      async (url) =>
        new Response(String(url).endsWith("query.php") ? sale : "response=1&transactionid=12345"),
    );
    await Promise.all([
      submitGatewayRefundOperation(f.runtime, f.input, provider, async () => undefined),
      submitGatewayRefundOperation(f.runtime, f.input, provider, async () => undefined),
    ]);
    expect(provider).toHaveBeenCalledTimes(2);
    expect(await readGatewayRefundOperation(f.runtime, f.input)).toMatchObject({
      status: "succeeded",
    });
  });
  it("records approval by local operation and never reposts on replay", async () => {
    const f = await fixture();
    const checkpoint = vi.fn(async () => undefined);
    const provider = vi.fn<typeof fetch>(
      async (url) =>
        new Response(String(url).endsWith("query.php") ? sale : "response=1&transactionid=12345"),
    );
    expect(
      await submitGatewayRefundOperation(f.runtime, f.input, provider, checkpoint),
    ).toMatchObject({ status: "succeeded", id: `gateway-operation:${f.id}` });
    expect(checkpoint).toHaveBeenCalledWith(`gateway-operation:${f.id}`);
    expect(await readGatewayRefundOperation(f.runtime, f.input)).toMatchObject({
      status: "succeeded",
    });
    await submitGatewayRefundOperation(f.runtime, f.input, provider, checkpoint);
    expect(provider).toHaveBeenCalledTimes(2);
  });
  it("holds lost response and read/replay never manufacture success or repost", async () => {
    const f = await fixture();
    const provider = vi.fn<typeof fetch>(async (url) => {
      if (String(url).endsWith("query.php")) return new Response(sale);
      throw new Error("lost");
    });
    expect(
      await submitGatewayRefundOperation(f.runtime, f.input, provider, async () => undefined),
    ).toMatchObject({ status: "unknown" });
    expect(
      await submitGatewayRefundOperation(f.runtime, f.input, provider, async () => undefined),
    ).toMatchObject({ status: "unknown" });
    expect(await readGatewayRefundOperation(f.runtime, f.input)).toMatchObject({
      status: "unknown",
    });
    expect(provider).toHaveBeenCalledTimes(2);
  });
  it("checkpoint failure cannot submit a refund", async () => {
    const f = await fixture();
    const provider = vi.fn<typeof fetch>();
    expect(
      await submitGatewayRefundOperation(f.runtime, f.input, provider, async () => {
        throw new Error("db");
      }),
    ).toMatchObject({ status: "unknown" });
    expect(provider).not.toHaveBeenCalled();
  });
  it("rejects operation identity mismatch before provider traffic", async () => {
    const f = await fixture();
    const provider = vi.fn<typeof fetch>();
    await expect(
      submitGatewayRefundOperation(
        f.runtime,
        { ...f.input, amountMinor: 101 },
        provider,
        async () => undefined,
      ),
    ).rejects.toMatchObject({ code: "gateway_refund_operation_unclaimed" });
    expect(provider).not.toHaveBeenCalled();
  });
});
