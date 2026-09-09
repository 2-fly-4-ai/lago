import assert from "node:assert/strict";
import { test } from "node:test";
import { runDemoContract } from "./epd-gateway-demo-contract.mjs";

function fakeGateway(fault = "") {
  const calls = [];
  const sales = new Map();
  let nextId = 1000;
  const fetcher = async (url, init) => {
    const fields = Object.fromEntries(init.body);
    calls.push({ url, fields });
    assert.ok(url.startsWith("https://secure.easypaydirectgateway.com/api/"));
    assert.equal(init.redirect, "error");
    assert.equal(fields.security_key, "6457Thfj624V5r7WUwc5v6a68Zsd6YEm");
    if (fault === "transport") throw new Error("private raw response must not escape");
    if (fault === "expired_example") return new Response("response=3&responsetext=expired");
    if (fault === "oversize") return new Response("x", { headers: { "content-length": "262145" } });
    if (url.endsWith("query.php")) {
      if (fault === "public_demo_query")
        return new Response(
          '<nm_response><error_response>Query API cannot be used with the public "demo" account. REFID:123</error_response></nm_response>',
        );
      const sale = sales.get(fields.transaction_id);
      assert.ok(sale, "Query must refer only to a transaction created in this run");
      const vault =
        sale.customer_vault_id && fault !== "query_vault_omitted"
          ? `<customer_vault_id>${fault === "vault" ? "other" : sale.customer_vault_id}</customer_vault_id>`
          : "";
      return new Response(
        `<nm_response><transaction><transaction_id>${fields.transaction_id}</transaction_id><order_id>${sale.orderid}</order_id><currency>${fault === "currency" ? "EUR" : "USD"}</currency><condition>pendingsettlement</condition>${vault}<action><action_type>sale</action_type><success>1</success><amount>${sale.amount}</amount></action>${sale.refunded ? "<action><action_type>refund</action_type><success>1</success><amount>1.00</amount></action>" : ""}</transaction></nm_response>`,
      );
    }
    assert.equal(fields.test_mode, "enabled");
    if (fields.type === "refund") {
      const sale = sales.get(fields.transactionid);
      assert.ok(sale);
      sale.refunded = true;
      if (fault === "refund_readback") sale.refunded = false;
      return new Response(`response=1&transactionid=${fields.transactionid}`);
    }
    if (fields.ccnumber) {
      assert.equal(fields.ccnumber, "4111111111111111");
      assert.equal(fields.ccexp, "1029");
      assert.equal(fields.email, "gateway-demo@example.test");
    }
    if (fields.amount === "0.50") return new Response("response=2&transactionid=0");
    const transactionId = String(++nextId);
    sales.set(transactionId, { ...fields });
    if (fault === "duplicate_response")
      return new Response(`response=1&response=2&transactionid=${transactionId}`);
    const vaultReply =
      fields.customer_vault_id && fault !== "sale_vault_missing"
        ? `&customer_vault_id=${fault === "sale_vault_mismatch" ? "999" : fields.customer_vault_id}`
        : "";
    return new Response(
      `response=1&transactionid=${transactionId}${vaultReply}${fault === "duplicate_vault" ? vaultReply : ""}`,
    );
  };
  return { fetcher, calls };
}

test("public demo approval without Query evidence stops before any further payment", async () => {
  const { fetcher, calls } = fakeGateway("public_demo_query");
  const report = await runDemoContract({ approvedDemoTest: true }, fetcher);
  assert.equal(report.complete, false);
  assert.equal(report.recurringPurchase, false);
  assert.equal(report.reason, "public_demo_query_unavailable_dedicated_test_account_required");
  assert.equal(calls.length, 2);
  assert.equal(calls.filter((call) => call.fields.type === "sale").length, 1);
});

test("requires explicit approval and rejects all account/host/key overrides before fetch", async () => {
  for (const options of [
    {},
    { approvedDemoTest: false },
    { approvedDemoTest: true, securityKey: "anything" },
    { approvedDemoTest: true, host: "https://other.test" },
  ]) {
    let called = false;
    await assert.rejects(
      runDemoContract(options, async () => {
        called = true;
      }),
      /explicit_demo_test_approval_required/,
    );
    assert.equal(called, false);
  }
});
test("proves the scripted demo sequence with mocks and no one-time vault fields", async () => {
  const { fetcher, calls } = fakeGateway();
  const report = await runDemoContract({ approvedDemoTest: true }, fetcher);
  assert.equal(report.complete, true, JSON.stringify(report));
  assert.equal(report.documentedExpiryAccepted, true);
  assert.equal(report.documentedExpiryIsPast, Date.now() >= Date.UTC(2029, 10, 1));
  assert.equal(report.publicDemoOnly, true);
  assert.equal(report.dedicatedDemoOnly, undefined);
  assert.equal(report.partialRefund, true);
  assert.equal(calls.length, 9);
  const sales = calls.filter((call) => call.fields.type === "sale");
  assert.equal(sales.length, 4);
  assert.equal(sales[0].fields.customer_vault, "add_customer");
  assert.equal(sales[0].fields.initiated_by, "customer");
  assert.equal(sales[1].fields.initiated_by, "merchant");
  assert.equal(sales[1].fields.initial_transaction_id, report.checks[0].transactionId);
  assert.equal(sales[1].fields.customer_vault_id, sales[0].fields.customer_vault_id);
  assert.equal(sales[1].fields.ccnumber, undefined);
  for (const key of [
    "customer_vault",
    "customer_vault_id",
    "billing_method",
    "stored_credential_indicator",
    "initial_transaction_id",
  ])
    assert.equal(sales[2].fields[key], undefined);
  const encoded = JSON.stringify(report);
  for (const sensitive of [
    sales[0].fields.ccnumber,
    sales[0].fields.security_key,
    sales[0].fields.email,
    "private raw response",
  ])
    assert.equal(encoded.includes(sensitive), false);
});
for (const fault of [
  "transport",
  "duplicate_response",
  "currency",
  "expired_example",
  "vault",
  "oversize",
  "sale_vault_missing",
  "sale_vault_mismatch",
  "duplicate_vault",
]) {
  test(`holds ${fault} without a second mutation or raw output`, async () => {
    const { fetcher, calls } = fakeGateway(fault);
    const report = await runDemoContract({ approvedDemoTest: true }, fetcher);
    assert.equal(report.complete, false);
    assert.equal(report.blockedStage, "initial_recurring");
    assert.equal(calls.filter((call) => call.fields.type === "sale").length, 1);
    assert.equal(JSON.stringify(report).includes("private raw response"), false);
    if (fault === "currency") {
      assert.equal(report.checks[0].transactionId, "1001");
      assert.equal(report.checks[0].passed, false);
    }
  });
}

test("allows omitted Query vault only after matching initial sale vault checkpoint", async () => {
  const { fetcher } = fakeGateway("query_vault_omitted");
  const report = await runDemoContract({ approvedDemoTest: true }, fetcher);
  assert.equal(report.complete, true);
  assert.equal(report.storedRenewal, true);
});

test("does not claim refund proof from approval alone or retry missing readback", async () => {
  const { fetcher, calls } = fakeGateway("refund_readback");
  const report = await runDemoContract({ approvedDemoTest: true }, fetcher);
  assert.equal(report.complete, false);
  assert.equal(report.partialRefund, false);
  assert.equal(report.blockedStage, "partial_refund_readback");
  assert.equal(calls.filter((call) => call.fields.type === "refund").length, 1);
});
