import { describe, expect, it, vi } from "vitest";
import {
  refundEasyPayDirectGatewayTransaction,
  readEasyPayDirectGatewaySaleRefundEvidence,
  gatewayRefundErrorDiagnostic,
  diagnoseEasyPayDirectGatewayRefundEvidence,
} from "../src/providers/easy-pay-direct-gateway-refunds";
const env = {
  APP_ENV: "test",
  EASY_PAY_DIRECT_NETWORK_MODE: "gateway_test",
  EASY_PAY_DIRECT_LIVEMODE_ALLOWED: "0",
  EASY_PAY_DIRECT_SECURITY_KEY: "fixture-not-secret",
};
const input = { transactionId: "12345", amountMinor: 200, currency: "USD" };
const xml = (extra = "") =>
  `<nm_response><transaction><transaction_id>12345</transaction_id><currency>USD</currency><condition>complete</condition><action><action_type>sale</action_type><success>1</success><amount>9.00</amount></action>${extra}</transaction></nm_response>`;
const action = (type: string, amount = "1.00") =>
  `<action><action_type>${type}</action_type><success>1</success><amount>${amount}</amount></action>`;
describe("direct Gateway refunds — mocked provider contract only", () => {
  it("accepts separate negative refund only with exact original linkage", async () => {
    const child = `<transaction><transaction_id>12346</transaction_id><original_transaction_id>12345</original_transaction_id><currency>USD</currency><condition>pendingsettlement</condition>${action("refund", "-4.78")}</transaction>`;
    const document = xml()
      .replace("9.00", "9.56")
      .replace("</nm_response>", `${child}</nm_response>`);
    expect(
      await readEasyPayDirectGatewaySaleRefundEvidence(
        env,
        input,
        async () => new Response(document),
      ),
    ).toEqual({
      transactionId: "12345",
      currency: "USD",
      saleAmountMinor: 956,
      refundedAmountMinor: 478,
    });
  });
  it.each([
    "unrelated",
    "duplicate",
    "positive",
    "wrong_currency",
    "void",
    "failed",
    "double_count",
    "over_refund",
    "truncated",
  ])("holds invalid linked refund %s", async (scenario) => {
    let child = `<transaction><transaction_id>12346</transaction_id><original_transaction_id>12345</original_transaction_id><currency>USD</currency><condition>pendingsettlement</condition>${action("refund", "-4.78")}</transaction>`;
    if (scenario === "unrelated")
      child = child.replace("<original_transaction_id>12345", "<original_transaction_id>99999");
    if (scenario === "duplicate") child += child;
    if (scenario === "positive") child = child.replace("-4.78", "4.78");
    if (scenario === "wrong_currency") child = child.replace("USD", "EUR");
    if (scenario === "void") child = child.replace("refund", "void");
    if (scenario === "failed") child = child.replace("<success>1", "<success>0");
    if (scenario === "over_refund") child = child.replace("-4.78", "-99.00");
    if (scenario === "truncated") child += "<transaction><transaction_id>77777</transaction_id>";
    const document = xml(scenario === "double_count" ? action("refund") : "").replace(
      "</nm_response>",
      `${child}</nm_response>`,
    );
    const provider = vi.fn<typeof fetch>(async () => new Response(document));
    await expect(
      refundEasyPayDirectGatewayTransaction(env, input, provider, async () => undefined),
    ).rejects.toMatchObject({ status: 409 });
    expect(provider).toHaveBeenCalledTimes(1);
  });
  it("summarizes multiple Query blocks without PII or changing evidence acceptance", async () => {
    const first = xml().replace(
      "</transaction>",
      "<email>private@example.test</email></transaction>",
    );
    const second = xml(action("refund", "-4.78"))
      .replace("12345", "12346")
      .replace(
        "</transaction>",
        "<original_transaction_id>12345</original_transaction_id><cc_number>private</cc_number></transaction>",
      );
    const provider = vi.fn<typeof fetch>(async () => new Response(first + second));
    const result = await diagnoseEasyPayDirectGatewayRefundEvidence(env, input, provider);
    expect(result).toMatchObject({
      status: "unverified",
      structure: {
        transactionCount: 2,
        matchingOriginalCount: 1,
        truncated: false,
        transactions: [
          { transactionId: "12345" },
          {
            transactionId: "12346",
            originalTransactionId: "12345",
            currency: "USD",
            condition: "complete",
            relationshipFields: ["original_transaction_id"],
            actions: [
              { type: "sale", success: "1", amount: "9.00" },
              { type: "refund", success: "1", amount: "-4.78" },
            ],
          },
        ],
      },
    });
    expect(JSON.stringify(result)).not.toContain("private");
    expect(provider).toHaveBeenCalledTimes(1);
  });
  it.each(["", "2", "true", "-1"])("rejects malformed action success %s", async (success) => {
    const fetcher = vi.fn<typeof fetch>(
      async () =>
        new Response(
          xml(action("refund").replace("<success>1</success>", `<success>${success}</success>`)),
        ),
    );
    await expect(
      refundEasyPayDirectGatewayTransaction(env, input, fetcher, async () => undefined),
    ).rejects.toMatchObject({ status: 409 });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it.each([
    "response=1&transactionid=0&response_code=100",
    "response=1&transactionid=000&response_code=100",
    "response=1&transactionid=12345&response_code=200",
    "response=1&transactionid=12345&response_code=100&response_code=100",
    "response=2&response_code=100",
    "response=2&response_code=200&response_code=300",
    "response=2&response_code=private",
  ])("holds contradictory response without checkpoint or retry", async (body) => {
    let calls = 0;
    const checkpoint = vi.fn(async () => undefined);
    const result = await refundEasyPayDirectGatewayTransaction(
      env,
      input,
      async () => new Response(++calls === 1 ? xml() : body),
      checkpoint,
    );
    expect(result.status).toBe("unknown");
    expect(checkpoint).not.toHaveBeenCalled();
    expect(calls).toBe(2);
    expect(JSON.stringify(result)).not.toContain("private");
  });
  it.each([300, 301, 302, 303, 304, 305, 307, 308])(
    "never follows Gateway redirect %s",
    async (status) => {
      const provider = vi.fn<typeof fetch>(async (url, options) => {
        const request = new Request(url, options);
        expect(request.redirect).toBe("manual");
        return new Response(status === 304 ? null : "private", {
          status,
          headers: { Location: "https://unexpected.invalid" },
        });
      });
      expect(await diagnoseEasyPayDirectGatewayRefundEvidence(env, input, provider)).toMatchObject({
        status: "unverified",
      });
      expect(provider).toHaveBeenCalledTimes(1);
    },
  );
  it.each(["fetch", "read", "decode"])(
    "identifies transport stage %s without exception text",
    async (phase) => {
      const result = await diagnoseEasyPayDirectGatewayRefundEvidence(env, input, async () => {
        if (phase === "fetch") throw new TypeError("private URL key");
        if (phase === "decode") return new Response(new Uint8Array([255]));
        return new Response(
          new ReadableStream({
            start(controller) {
              controller.error(new TypeError("private stream"));
            },
          }),
        );
      });
      expect(result).toEqual({
        status: "unverified",
        diagnostic: `gateway_refund_diagnostic:transport:${phase}:type_error`,
      });
      expect(JSON.stringify(result)).not.toContain("private");
    },
  );
  it.each([
    [xml().replace("<currency>USD</currency>", ""), "tag_currency_missing"],
    [xml().replace("USD", "EUR"), "currency_mismatch"],
    [xml().replace("9.00", "9"), "amount_format"],
    [xml().replace("<success>1</success>", ""), "tag_success_missing"],
    [xml().replace("complete", "failed"), "condition"],
  ])(
    "readback identifies structural issue without exposing provider values",
    async (body, reason) => {
      const result = await diagnoseEasyPayDirectGatewayRefundEvidence(
        env,
        input,
        async () => new Response(body),
      );
      expect(result).toEqual({
        status: "unverified",
        diagnostic: `gateway_refund_diagnostic:preflight_query:${reason}`,
      });
    },
  );
  it("diagnostic wrapper performs only Query and rejects production", async () => {
    const fetcher = vi.fn<typeof fetch>(async (url) => {
      expect(String(url)).toContain("/api/query.php");
      return new Response(xml());
    });
    expect(await diagnoseEasyPayDirectGatewayRefundEvidence(env, input, fetcher)).toMatchObject({
      status: "verified",
      evidence: { saleAmountMinor: 900, refundedAmountMinor: 0 },
    });
    await expect(
      diagnoseEasyPayDirectGatewayRefundEvidence({ ...env, APP_ENV: "production" }, input, fetcher),
    ).rejects.toMatchObject({ status: 503 });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(
      await diagnoseEasyPayDirectGatewayRefundEvidence(
        env,
        input,
        async () => new Response("private"),
      ),
    ).toEqual({
      status: "unverified",
      diagnostic: "gateway_refund_diagnostic:preflight_query:transaction_count",
      structure: {
        transactionCount: 0,
        matchingOriginalCount: 0,
        truncated: false,
        transactions: [],
      },
    });
  });
  it("distinguishes preflight rejection without sending a refund and excludes raw data", async () => {
    const fetcher = vi.fn<typeof fetch>(async () => new Response("private customer text"));
    try {
      await refundEasyPayDirectGatewayTransaction(env, input, fetcher, async () => undefined);
      expect.fail("must reject");
    } catch (error) {
      expect(gatewayRefundErrorDiagnostic(error)).toBe(
        "gateway_refund_diagnostic:preflight_query:transaction_count",
      );
    }
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it.each([
    [
      "response=3&response_code=300&responsetext=private",
      "refund_response:unconfirmed:response_3:code_300",
    ],
    ["response=1&response=2&responsetext=private", "refund_response:invalid_fields"],
    ["response=private&response_code=private", "refund_response:contradictory_code"],
  ])("records only numeric response diagnostics", async (body, diagnostic) => {
    let calls = 0;
    const result = await refundEasyPayDirectGatewayTransaction(
      env,
      input,
      async () => new Response(++calls === 1 ? xml() : body),
      async () => undefined,
    );
    expect(result.diagnostic).toBe(`gateway_refund_diagnostic:${diagnostic}`);
    expect(JSON.stringify(result)).not.toContain("private");
    expect(calls).toBe(2);
  });
  it("records refund HTTP status without response body", async () => {
    let calls = 0;
    const result = await refundEasyPayDirectGatewayTransaction(
      env,
      input,
      async () => (++calls === 1 ? new Response(xml()) : new Response("private", { status: 503 })),
      async () => undefined,
    );
    expect(result.diagnostic).toBe("gateway_refund_diagnostic:refund_transport:transport:http_503");
    expect(calls).toBe(2);
  });
  it("queries exact original ID and submits positive refund without Commerce credentials", async () => {
    const checkpoint = vi.fn(async () => undefined);
    const fetcher = vi.fn<typeof fetch>(async (url, init) => {
      const body = new URLSearchParams(String(init?.body));
      expect(init?.redirect).toBe("manual");
      if (String(url).endsWith("query.php")) {
        expect(body.get("transaction_id")).toBe("12345");
        return new Response(xml());
      }
      expect(body.get("transactionid")).toBe("12345");
      expect(body.get("type")).toBe("refund");
      expect(body.get("amount")).toBe("2.00");
      expect(body.get("test_mode")).toBe("enabled");
      expect(body.has("billing_id")).toBe(false);
      return new Response("response=1&transactionid=12345&responsetext=secret-text");
    });
    expect(await refundEasyPayDirectGatewayTransaction(env, input, fetcher, checkpoint)).toEqual({
      id: "12345",
      status: "succeeded",
      responseText: "Refund approved by Gateway.",
    });
    expect(checkpoint).toHaveBeenCalledWith("12345");
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it.each([0, -1, 0.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1])(
    "rejects invalid money %s before any request",
    async (amountMinor) => {
      const fetcher = vi.fn<typeof fetch>();
      await expect(
        refundEasyPayDirectGatewayTransaction(
          env,
          { ...input, amountMinor },
          fetcher,
          async () => undefined,
        ),
      ).rejects.toMatchObject({ status: 409 });
      expect(fetcher).not.toHaveBeenCalled();
    },
  );
  it.each(["production", "test", "disabled"])("test app rejects network %s", async (mode) => {
    await expect(
      readEasyPayDirectGatewaySaleRefundEvidence(
        { ...env, EASY_PAY_DIRECT_NETWORK_MODE: mode },
        input,
      ),
    ).rejects.toMatchObject({ status: 503 });
  });
  it.each([
    xml().replace("USD", "EUR"),
    xml().replace("12345", "987"),
    xml(action("void")),
    xml(action("refund", "8.00")),
    xml().replace("9.00", "bad"),
    xml().replace("complete", "failed"),
  ])("holds invalid or insufficient original evidence", async (body) => {
    const fetcher = vi.fn<typeof fetch>(async () => new Response(body));
    await expect(
      refundEasyPayDirectGatewayTransaction(env, input, fetcher, async () => undefined),
    ).rejects.toMatchObject({ status: 409 });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it.each([
    "response=1",
    "response=3&responsetext=private",
    "response=1&response=2&transactionid=12345",
  ])("holds ambiguous response without leakage", async (body) => {
    let calls = 0;
    const result = await refundEasyPayDirectGatewayTransaction(
      env,
      input,
      async () => new Response(++calls === 1 ? xml() : body),
      async () => undefined,
    );
    expect(result.status).toBe("unknown");
    expect(JSON.stringify(result)).not.toContain("private");
    expect(calls).toBe(2);
  });
  it("holds lost response without resubmitting", async () => {
    let calls = 0;
    const result = await refundEasyPayDirectGatewayTransaction(
      env,
      input,
      async () => {
        if (++calls === 1) return new Response(xml());
        throw new Error("private");
      },
      async () => undefined,
    );
    expect(result.status).toBe("unknown");
    expect(calls).toBe(2);
    expect(result.diagnostic).toBe(
      "gateway_refund_diagnostic:refund_transport:transport:fetch:error",
    );
  });
  it("holds success when durable checkpoint fails", async () => {
    let calls = 0;
    const result = await refundEasyPayDirectGatewayTransaction(
      env,
      input,
      async () => new Response(++calls === 1 ? xml() : "response=1&transactionid=12345"),
      async () => {
        throw new Error("db failure");
      },
    );
    expect(result.status).toBe("unknown");
    expect(calls).toBe(2);
  });
  it("exposes aggregate evidence without attributing a refund to an operation", async () => {
    expect(
      await readEasyPayDirectGatewaySaleRefundEvidence(
        env,
        input,
        async () => new Response(xml(action("refund"))),
      ),
    ).toEqual({
      transactionId: "12345",
      currency: "USD",
      saleAmountMinor: 900,
      refundedAmountMinor: 100,
    });
  });
  it("allows explicit production configuration without adding test_mode", async () => {
    let calls = 0;
    const result = await refundEasyPayDirectGatewayTransaction(
      {
        ...env,
        APP_ENV: "production",
        EASY_PAY_DIRECT_NETWORK_MODE: "production",
        EASY_PAY_DIRECT_LIVEMODE_ALLOWED: "1",
      },
      input,
      async (_url, init) => {
        if (++calls === 1) return new Response(xml());
        expect(new URLSearchParams(String(init?.body)).has("test_mode")).toBe(false);
        return new Response("response=2");
      },
      async () => undefined,
    );
    expect(result.status).toBe("failed");
  });
});
