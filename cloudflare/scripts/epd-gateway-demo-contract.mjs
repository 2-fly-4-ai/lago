import { randomInt, randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";

// Public provider fixtures, NOT a merchant key or customer card. No environment,
// credential file, host override, real account or live card inputs are accepted.
// https://secure.easypaydirectgateway.com/merchants/resources/integration/integration_portal.php#testing_information
const demoKey = "6457Thfj624V5r7WUwc5v6a68Zsd6YEm";
const testVisa = "4111111111111111";
// Current NMI testing table specifies 10/29 (its inline example still says 1025).
// https://docs.nmi.com/reference/testing-methods
const documentedExpiry = "1029";
const host = "https://secure.easypaydirectgateway.com/api/";

function fail(code) {
  throw new Error(code);
}
function id(value) {
  if (!/^[0-9]{1,64}$/u.test(value ?? "")) fail("invalid_provider_identity");
  return value;
}
function field(xml, name, optional = false) {
  const rows = [...xml.matchAll(new RegExp(`<${name}>([^<]*)</${name}>`, "gu"))];
  if (optional && rows.length === 0) return "";
  if (rows.length !== 1) fail("ambiguous_provider_evidence");
  return rows[0][1].trim();
}
function cents(value) {
  if (!/^\d+\.\d{2}$/u.test(value)) fail("invalid_provider_money");
  const result = Math.round(Number(value) * 100);
  if (!Number.isSafeInteger(result)) fail("invalid_provider_money");
  return result;
}
async function request(path, fields, fetcher) {
  if (!["transact.php", "query.php"].includes(path)) fail("invalid_demo_path");
  const controller = new AbortController();
  let reader;
  let timer;
  try {
    return await Promise.race([
      (async () => {
        const response = await fetcher(host + path, {
          method: "POST",
          redirect: "error",
          signal: controller.signal,
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({ ...fields, security_key: demoKey }),
        });
        if (
          !response.ok ||
          !response.body ||
          Number(response.headers.get("content-length")) > 262144
        )
          fail("provider_response_unavailable");
        reader = response.body.getReader();
        const decoder = new TextDecoder("utf-8", { fatal: true });
        let size = 0;
        let raw = "";
        for (;;) {
          const chunk = await reader.read();
          if (chunk.done) break;
          size += chunk.value.byteLength;
          if (size > 262144) fail("provider_response_too_large");
          raw += decoder.decode(chunk.value, { stream: true });
        }
        return raw + decoder.decode();
      })(),
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new Error("provider_timeout"));
        }, 15000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
    controller.abort();
    if (reader) void reader.cancel().catch(() => undefined);
  }
}
function result(raw) {
  const form = new URLSearchParams(raw);
  if (
    form.getAll("response").length !== 1 ||
    form.getAll("transactionid").length > 1 ||
    form.getAll("customer_vault_id").length > 1
  )
    fail("ambiguous_provider_response");
  return {
    approved: form.get("response") === "1",
    declined: form.get("response") === "2",
    transactionId: form.get("transactionid"),
    vaultId: form.get("customer_vault_id"),
  };
}
function saleEvidence(raw, expected) {
  if (raw.includes('Query API cannot be used with the public "demo" account.'))
    fail("public_demo_query_unavailable");
  if (/<!DOCTYPE|<!ENTITY/iu.test(raw)) fail("invalid_provider_evidence");
  const rows = [...raw.matchAll(/<transaction>([\s\S]*?)<\/transaction>/gu)];
  if (rows.length !== 1) fail("ambiguous_provider_evidence");
  const xml = rows[0][1];
  const actions = [...xml.matchAll(/<action>([\s\S]*?)<\/action>/gu)].map((row) => row[1]);
  const header = xml.replace(/<action>[\s\S]*?<\/action>/gu, "");
  if (
    field(header, "transaction_id") !== expected.transactionId ||
    field(header, "order_id") !== expected.orderId ||
    field(header, "currency") !== "USD"
  )
    fail("provider_identity_mismatch");
  if (!["complete", "pendingsettlement"].includes(field(header, "condition")))
    fail("sale_not_confirmed");
  const sales = actions.filter((action) => field(action, "action_type") === "sale");
  if (
    sales.length !== 1 ||
    field(sales[0], "success") !== "1" ||
    cents(field(sales[0], "amount")) !== expected.amountMinor
  )
    fail("provider_sale_mismatch");
  const queryVault = field(header, "customer_vault_id", true);
  // Transaction Query may omit vault identity. A same-sale approval checkpoint
  // can supply it; a requested ID alone is not provider evidence. Conflicts fail.
  if (queryVault && queryVault !== (expected.vaultId ?? "")) fail("provider_vault_mismatch");
  let refunds = 0;
  for (const action of actions) {
    if (field(action, "success") !== "1") continue;
    const type = field(action, "action_type");
    if (!["sale", "refund"].includes(type)) fail("unexpected_provider_action");
    if (type === "refund") refunds += cents(field(action, "amount"));
  }
  if (refunds !== (expected.refundedMinor ?? 0)) fail("provider_refund_mismatch");
}

// Read-only diagnosis of this test run's own transaction. Only structural and
// financial fixture fields are returned; never raw response/card/customer data.
export async function inspectDemoTransaction(transactionId, orderId, fetcher = fetch) {
  id(transactionId);
  if (!/^epd-demo-[0-9a-f-]{36}-initial$/u.test(orderId)) fail("invalid_demo_order");
  const raw = await request("query.php", { transaction_id: transactionId }, fetcher);
  const names = [...new Set([...raw.matchAll(/<([a-z_]+)(?:\s|>)/gu)].map((m) => m[1]))];
  const safe = (name) =>
    [...raw.matchAll(new RegExp(`<${name}>([^<]*)</${name}>`, "gu"))].map((m) => m[1]);
  return {
    names,
    transactionMatches: safe("transaction_id").includes(transactionId),
    orderMatches: safe("order_id").includes(orderId),
    currencies: safe("currency"),
    conditions: safe("condition"),
    actions: safe("action_type"),
    success: safe("success"),
    amounts: safe("amount"),
    vaultPresent: safe("customer_vault_id").length === 1,
  };
}

// Does not prove Collect.js tokenization, Lago scheduling, tax, entitlements,
// Slack, customer checkout or production processor behavior. It isolates the
// shared public-demo Payment API contract, NOT the dedicated SerpTEST account.
// Never automatically retry a POST.
export async function runDemoContract(options = {}, fetcher = fetch) {
  if (
    Object.keys(options).some((key) => key !== "approvedDemoTest") ||
    options.approvedDemoTest !== true
  )
    fail("explicit_demo_test_approval_required");
  const runId = randomUUID();
  const vaultId = `${Date.now()}${randomInt(100000, 999999)}`;
  const report = {
    runId,
    publicDemoOnly: true,
    realMoney: false,
    documentedExpiryIsPast: Date.now() >= Date.UTC(2029, 10, 1),
    documentedExpiryAccepted: false,
    recurringPurchase: false,
    storedRenewal: false,
    oneTimePurchase: false,
    oneTimeVaultAbsent: false,
    decline: false,
    partialRefund: false,
    complete: false,
    checks: [],
    limitations: [
      "not_collectjs",
      "not_lago_end_to_end",
      "not_scheduler_proof",
      "not_production_processor_proof",
    ],
  };
  let stage = "initial_recurring";
  const card = {
    ccnumber: testVisa,
    ccexp: documentedExpiry,
    cvv: "999",
    address1: "888",
    zip: "77777",
    first_name: "Gateway",
    last_name: "Demo",
    email: "gateway-demo@example.test",
  };
  const sale = async (name, amountMinor, extra) => {
    const orderId = `epd-demo-${runId}-${name}`;
    const reply = result(
      await request(
        "transact.php",
        {
          type: "sale",
          payment: "creditcard",
          currency: "USD",
          amount: (amountMinor / 100).toFixed(2),
          test_mode: "enabled",
          orderid: orderId,
          ...extra,
        },
        fetcher,
      ),
    );
    if (!reply.approved) fail("sale_not_approved");
    const transactionId = id(reply.transactionId);
    const check = { scenario: name, passed: false, amountMinor, transactionId };
    report.checks.push(check);
    if (extra.customer_vault === "add_customer" && reply.vaultId !== extra.customer_vault_id)
      fail("provider_vault_checkpoint_missing_or_mismatched");
    // Only this run's returned transaction ID is queried. No account-wide reads.
    const evidence = {
      transactionId,
      orderId,
      amountMinor,
      ...(extra.customer_vault_id ? { vaultId: extra.customer_vault_id } : {}),
    };
    saleEvidence(await request("query.php", { transaction_id: transactionId }, fetcher), evidence);
    check.passed = true;
    return evidence;
  };
  try {
    const initial = await sale("initial", 450, {
      ...card,
      customer_vault: "add_customer",
      customer_vault_id: vaultId,
      billing_method: "recurring",
      initiated_by: "customer",
      stored_credential_indicator: "stored",
    });
    report.documentedExpiryAccepted = true;
    report.recurringPurchase = true;
    stage = "stored_renewal";
    await sale("renewal", 450, {
      customer_vault_id: vaultId,
      initial_transaction_id: initial.transactionId,
      billing_method: "recurring",
      initiated_by: "merchant",
      stored_credential_indicator: "used",
    });
    report.storedRenewal = true;
    stage = "one_time";
    await sale("one-time", 900, { ...card });
    report.oneTimePurchase = true;
    report.oneTimeVaultAbsent = true;
    stage = "decline";
    const decline = result(
      await request(
        "transact.php",
        {
          ...card,
          type: "sale",
          payment: "creditcard",
          currency: "USD",
          amount: "0.50",
          test_mode: "enabled",
          orderid: `epd-demo-${runId}-decline`,
        },
        fetcher,
      ),
    );
    if (!decline.declined) fail("decline_not_confirmed");
    report.decline = true;
    stage = "partial_refund";
    const refund = result(
      await request(
        "transact.php",
        {
          type: "refund",
          transactionid: initial.transactionId,
          amount: "1.00",
          payment: "creditcard",
          test_mode: "enabled",
        },
        fetcher,
      ),
    );
    if (!refund.approved) fail("refund_not_approved");
    stage = "partial_refund_readback";
    saleEvidence(await request("query.php", { transaction_id: initial.transactionId }, fetcher), {
      ...initial,
      refundedMinor: 100,
    });
    report.partialRefund = true;
    report.checks.push({
      scenario: "partial-refund",
      passed: true,
      amountMinor: 100,
      transactionId: initial.transactionId,
    });
    report.complete = true;
  } catch (error) {
    // Never leak response text, errors containing card/key data, or request body.
    report.blockedStage = stage;
    report.reason =
      error instanceof Error && error.message === "public_demo_query_unavailable"
        ? "public_demo_query_unavailable_dedicated_test_account_required"
        : "provider_contract_not_proven_do_not_retry_unknown_payment";
  }
  return report;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv.length !== 3 || process.argv[2] !== "--approved-demo-test") {
    console.error(
      "Requires --approved-demo-test after explicit approval. Dedicated public Gateway demo only; no real account inputs accepted.",
    );
    process.exitCode = 2;
  } else {
    const report = await runDemoContract({ approvedDemoTest: true });
    console.log(JSON.stringify(report, null, 2));
    if (!report.complete) process.exitCode = 1;
  }
}
