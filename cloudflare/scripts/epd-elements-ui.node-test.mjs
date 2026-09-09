import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";

// Execute the actual emitted browser controller with an explicitly mocked SDK.
// This is not evidence of a provider transaction or a real hosted iframe.
const source = readFileSync(
  new URL("../src/providers/easy-pay-direct-elements-ui.ts", import.meta.url),
  "utf8",
);
const module = { exports: {} };
runInNewContext(
  ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText,
  { exports: module.exports },
);
const tick = () => new Promise((resolve) => setImmediate(resolve));
async function setup(options = {}) {
  const nodes = new Map();
  const handlers = new Map();
  const states = new Map();
  const timers = new Map();
  let nextTimer = 0;
  let captureCount = 0;
  const submissions = [];
  for (const id of [
    "payment-status",
    "pay",
    "error",
    "email",
    "phone",
    "terms",
    "first-name",
    "last-name",
    "ccnumber",
    "ccexp",
    "cvv",
  ])
    nodes.set(id, {
      value:
        {
          email: "fixture@example.test",
          phone: "+14155551234",
          "first-name": "Test",
          "last-name": "Customer",
        }[id] ?? "",
      checked: true,
      textContent: "",
      disabled: true,
      focus() {},
      classList: { toggle() {} },
      setAttribute() {},
      addEventListener(type, fn) {
        handlers.set(`${id}:${type}`, fn);
      },
    });
  const context = {
    document: { getElementById: (id) => nodes.get(id) },
    error: nodes.get("error"),
    button: nodes.get("pay"),
    checkout: "signed-checkout",
    taxQuoteId: "quote-1",
    taxReady: true,
    cardReady: false,
    setTimeout(fn) {
      const id = ++nextTimer;
      timers.set(id, fn);
      return id;
    },
    clearTimeout(id) {
      timers.delete(id);
    },
    refreshPayState() {
      nodes.get("pay").disabled = !(context.cardReady && context.taxReady);
    },
    submit: async (token) => {
      submissions.push(token);
      return options.submitted ?? true;
    },
    EPD: async (key, config) => {
      assert.equal(key, "epd_test_pk_fixture");
      assert.equal(config.disableTelemetry, true);
      if (options.initError) throw new Error("private provider detail");
      return {
        sandbox: options.sandbox ?? true,
        create(type, config) {
          assert.ok(config.ariaLabel);
          const state = { complete: options.complete ?? true, valid: true, empty: false };
          states.set(type, state);
          return {
            mount: async () => {},
            getState: () => state,
            on: (event, fn) => handlers.set(`${type}:${event}`, fn),
          };
        },
        createToken: async () => {
          captureCount++;
          return options.capture ? options.capture() : { token: "cct_fixtureOpaqueToken" };
        },
      };
    },
  };
  await runInNewContext(module.exports.easyPayDirectElementsScript("epd_test_pk_fixture"), context);
  return {
    context,
    nodes,
    handlers,
    states,
    timers,
    submissions,
    count: () => captureCount,
    click: () => handlers.get("pay:click")?.(),
  };
}
test("all hosted fields must be complete and valid; consent and real names precede capture", async () => {
  const ui = await setup({ complete: false });
  assert.equal(ui.nodes.get("pay").disabled, true);
  for (const [type, state] of ui.states) {
    state.complete = true;
    ui.handlers.get(`${type}:change`)(state);
  }
  assert.equal(ui.nodes.get("pay").disabled, false);
  ui.nodes.get("terms").checked = false;
  await ui.click();
  assert.equal(ui.count(), 0);
  ui.nodes.get("terms").checked = true;
  ui.nodes.get("first-name").value = " ";
  await ui.click();
  assert.equal(ui.count(), 0);
  ui.nodes.get("first-name").value = "Test";
  await ui.click();
  assert.deepEqual(ui.submissions, ["cct_fixtureOpaqueToken"]);
  assert.equal(ui.nodes.get("pay").disabled, true);
});
test("concurrent clicks create one token and one payment; success remains locked", async () => {
  let resolve;
  const capture = new Promise((done) => {
    resolve = done;
  });
  const ui = await setup({ capture: () => capture });
  const first = ui.click();
  await ui.click();
  assert.equal(ui.count(), 1);
  resolve({ token: "cct_fixtureOpaqueToken" });
  await first;
  await ui.click();
  assert.equal(ui.count(), 1);
  assert.equal(ui.submissions.length, 1);
});
test("SDK failure or live SDK config never submits and never echoes provider detail", async () => {
  for (const options of [{ initError: true }, { sandbox: false }]) {
    const ui = await setup(options);
    await ui.click();
    assert.equal(ui.count(), 0);
    assert.equal(ui.nodes.get("pay").disabled, true);
    assert.doesNotMatch(ui.nodes.get("error").textContent, /private/);
  }
});
test("a quote changed during capture cannot charge the obsolete total", async () => {
  let resolve;
  const capture = new Promise((done) => {
    resolve = done;
  });
  const ui = await setup({ capture: () => capture });
  const click = ui.click();
  ui.context.taxQuoteId = "quote-2";
  resolve({ token: "cct_fixtureOpaqueToken" });
  await click;
  assert.equal(ui.submissions.length, 0);
  assert.equal(ui.nodes.get("pay").disabled, false);
});
test("malformed Gateway token and tokenization timeout never reach payment endpoint", async () => {
  const wrong = await setup({ capture: async () => ({ token: "123456789" }) });
  await wrong.click();
  assert.equal(wrong.submissions.length, 0);
  const ui = await setup({ capture: () => new Promise(() => {}) });
  const click = ui.click();
  await tick();
  for (const timer of ui.timers.values()) timer();
  await click;
  assert.equal(ui.submissions.length, 0);
  assert.equal(ui.nodes.get("pay").disabled, false);
});
test("failed server submission is retryable and incomplete fields remain disabled", async () => {
  const ui = await setup({ submitted: false });
  await ui.click();
  assert.equal(ui.nodes.get("pay").disabled, false);
  const state = ui.states.get("cardCvc");
  state.valid = false;
  ui.handlers.get("cardCvc:change")(state);
  assert.equal(ui.nodes.get("pay").disabled, true);
  await ui.click();
  assert.equal(ui.count(), 1);
});
