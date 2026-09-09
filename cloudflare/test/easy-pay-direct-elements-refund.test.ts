import { describe, expect, it, vi } from "vitest";
import {
  refundEasyPayDirectElementsOrder,
  readEasyPayDirectElementsRefundTransaction,
} from "../src/providers/easy-pay-direct-elements";

const env = {
  APP_ENV: "test",
  EASY_PAY_DIRECT_COMMERCE_API_KEY: "epd_test_sk_fixture",
  EASY_PAY_DIRECT_NETWORK_MODE: "gateway_test" as const,
  EASY_PAY_DIRECT_LIVEMODE_ALLOWED: "0" as const,
};
const orderId = "6ba7b811-9dad-11d1-80b4-00c04fd430c8";
const saleId = "6ba7b812-9dad-11d1-80b4-00c04fd430c8";
const transactionId = "6ba7b813-9dad-11d1-80b4-00c04fd430c8";
const otherId = "6ba7b814-9dad-11d1-80b4-00c04fd430c8";
const input = {
  orderId,
  amountMinor: 200,
  currency: "USD",
  idempotencyKey: "550e8400-e29b-41d4-a716-446655440001",
};
const before = {
  id: orderId,
  total: 450,
  currency: "usd",
  status: "succeeded",
  transactions: [{ id: saleId, type: "sale", status: "succeeded" }],
};
const after = {
  ...before,
  status: "partially_refunded",
  transactions: [
    ...before.transactions,
    { id: transactionId, type: "refund", status: "succeeded" },
  ],
};
const transaction = {
  id: transactionId,
  type: "refund",
  order_id: orderId,
  amount: 200,
  currency: "usd",
  status: "succeeded",
};

describe("Elements refund adapter (mocked provider only)", () => {
  it("uses official sandbox credentials without Gateway keys and checkpoints before read", async () => {
    const checkpoint = vi.fn(async (_id: string) => undefined);
    const provider = vi.fn<typeof fetch>(async (url, options) => {
      if (String(url).endsWith(`/transactions/${transactionId}`)) {
        expect(checkpoint).toHaveBeenCalledWith(transactionId);
        return Response.json(transaction);
      }
      if (options?.method === "POST") {
        expect(String(url)).toBe(`https://api.epd.com/v1/orders/${orderId}/refund`);
        expect(JSON.parse(String(options.body))).toEqual({ amount: 200 });
        expect(new Headers(options.headers).get("X-EPD-Idempotency-Key")).toBe(
          input.idempotencyKey,
        );
        return Response.json(after);
      }
      return Response.json(before);
    });
    expect(await refundEasyPayDirectElementsOrder(env, input, provider, checkpoint)).toMatchObject({
      id: transactionId,
      status: "succeeded",
    });
    expect(provider).toHaveBeenCalledTimes(3);
  });
  it.each([
    { total: 100 },
    { currency: "eur" },
    { status: "pending" },
    { transactions: undefined },
    { transactions: [{ id: "invalid" }] },
  ])("holds bad original evidence before POST %j", async (patch) => {
    const provider = vi.fn<typeof fetch>(async () => Response.json({ ...before, ...patch }));
    await expect(refundEasyPayDirectElementsOrder(env, input, provider)).rejects.toMatchObject({
      status: 409,
    });
    expect(provider).toHaveBeenCalledTimes(1);
  });
  it.each([
    { id: otherId },
    { order_id: otherId },
    { type: "sale" },
    { amount: 199 },
    { currency: "eur" },
  ])("holds mismatched exact refund %j", async (patch) => {
    expect(
      await readEasyPayDirectElementsRefundTransaction(env, { ...input, transactionId }, async () =>
        Response.json({ ...transaction, ...patch }),
      ),
    ).toMatchObject({ id: null, status: "unknown" });
  });
  it.each(["pending", "in_progress", "unexpected"])(
    "never treats %s as success",
    async (status) => {
      expect(
        await readEasyPayDirectElementsRefundTransaction(
          env,
          { ...input, transactionId },
          async () =>
            Response.json({
              ...transaction,
              status,
              processor_response: { message: "private diagnostic" },
            }),
        ),
      ).toEqual({
        id: transactionId,
        status: "unknown",
        responseText: "Refund outcome is pending",
      });
    },
  );
  it.each(["failed", "voided"])("recognizes exact %s refund without raw errors", async (status) => {
    expect(
      await readEasyPayDirectElementsRefundTransaction(env, { ...input, transactionId }, async () =>
        Response.json({ ...transaction, status }),
      ),
    ).toEqual({ id: transactionId, status: "failed", responseText: "Refund failed" });
  });
  it.each([
    before,
    { ...after, transactions: [...after.transactions, { id: otherId, type: "refund" }] },
  ])("does not infer a refund from cumulative or ambiguous order evidence", async (result) => {
    let calls = 0;
    const checkpoint = vi.fn(async (_id: string) => undefined);
    expect(
      await refundEasyPayDirectElementsOrder(
        env,
        input,
        async () => Response.json(++calls === 1 ? before : result),
        checkpoint,
      ),
    ).toMatchObject({ id: null, status: "unknown" });
    expect(checkpoint).not.toHaveBeenCalled();
    expect(calls).toBe(2);
  });
  it("does not retry a lost POST response", async () => {
    const provider = vi.fn<typeof fetch>(async (_url, options) => {
      if (options?.method === "POST") throw new TypeError("lost");
      return Response.json(before);
    });
    await expect(refundEasyPayDirectElementsOrder(env, input, provider)).rejects.toMatchObject({
      status: 503,
    });
    expect(provider).toHaveBeenCalledTimes(2);
  });
  it("retains the financial checkpoint when follow-up read is interrupted", async () => {
    const checkpoint = vi.fn(async (_id: string) => undefined);
    let calls = 0;
    await expect(
      refundEasyPayDirectElementsOrder(
        env,
        input,
        async () => {
          if (++calls === 3) throw new TypeError("read lost");
          return Response.json(calls === 1 ? before : after);
        },
        checkpoint,
      ),
    ).rejects.toMatchObject({ status: 503 });
    expect(checkpoint).toHaveBeenCalledWith(transactionId);
  });
  it("rejects production and missing durable key before mutation", async () => {
    const provider = vi.fn<typeof fetch>();
    await expect(
      refundEasyPayDirectElementsOrder({ ...env, APP_ENV: "production" }, input, provider),
    ).rejects.toMatchObject({ status: 503 });
    await expect(
      refundEasyPayDirectElementsOrder(env, { ...input, idempotencyKey: undefined }, provider),
    ).rejects.toMatchObject({ status: 422 });
    expect(provider).not.toHaveBeenCalled();
  });
});
