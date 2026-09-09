import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";
const module = { exports: {} };
runInNewContext(
  ts.transpileModule(
    readFileSync(
      new URL("../src/providers/easy-pay-direct-collect-ui.ts", import.meta.url),
      "utf8",
    ),
    { compilerOptions: { module: ts.ModuleKind.CommonJS } },
  ).outputText,
  { exports: module.exports },
);
function setup(submitResult) {
  const handlers = new Map(),
    submissions = [],
    navigations = [];
  const node = (id) => ({
    hidden: true,
    textContent: "",
    disabled: true,
    classList: { toggle() {} },
    setAttribute() {},
    insertAdjacentElement() {},
    addEventListener(type, fn) {
      handlers.set(id + type, fn);
    },
  });
  const nodes = new Map(
    ["pay", "error", "payment-status", "ccnumber", "ccexp", "cvv"].map((id) => [id, node(id)]),
  );
  const recovery = node("reload");
  const context = {
    button: nodes.get("pay"),
    error: nodes.get("error"),
    cardReady: false,
    taxReady: true,
    checkout: "fresh-quoted-token",
    taxQuoteId: "quote-1",
    quoteButton: { disabled: false },
    billingAddress: () => ({ country: "US", state: "CA" }),
    returnTo: "https://staging.example.test/success",
    document: { getElementById: (id) => nodes.get(id), createElement: () => recovery },
    location: { origin: "https://fixture.test", assign: (url) => navigations.push(url) },
    URL,
    submit: async (token) => {
      submissions.push(token);
      if (submitResult instanceof Error) throw submitResult;
      return submitResult;
    },
  };
  context.refreshPayState = () =>
    (context.button.disabled = !(context.cardReady && context.taxReady));
  const callbacks = runInNewContext(
    module.exports.easyPayDirectCollectRecoveryScript() + ";collectRecovery",
    context,
  );
  const click = () => {
    let blocked = false;
    handlers.get("payclick")({
      preventDefault() {
        blocked = true;
      },
      stopImmediatePropagation() {},
    });
    return blocked;
  };
  return {
    context,
    callbacks,
    submissions,
    navigations,
    recovery,
    click,
    reload: () => handlers.get("reloadclick")(),
  };
}
test("timeout correction requires fresh page and retains current quoted token", () => {
  const s = setup();
  s.callbacks.fieldsAvailableCallback();
  assert.equal(s.click(), false);
  s.callbacks.validationCallback("ccnumber", false, "invalid");
  s.callbacks.timeoutCallback();
  s.callbacks.validationCallback("ccnumber", true, "");
  s.callbacks.fieldsAvailableCallback();
  assert.equal(s.context.button.disabled, true);
  assert.match(s.context.error.textContent, /Reload/);
  assert.equal(s.click(), true);
  s.callbacks.callback({ token: "late-token" });
  assert.equal(s.submissions.length, 0);
  s.reload();
  const target = new URL(s.navigations[0]);
  assert.equal(target.searchParams.get("checkout"), "fresh-quoted-token");
  assert.equal(target.searchParams.get("return_to"), s.context.returnTo);
  const fresh = setup();
  fresh.callbacks.fieldsAvailableCallback();
  assert.equal(fresh.click(), false);
  fresh.callbacks.callback({ token: "fresh-token" });
  fresh.callbacks.callback({ token: "duplicate" });
  assert.deepEqual(fresh.submissions, ["fresh-token"]);
});

for (const result of [undefined, new Error("Uncertain payment")]) {
  test(`late timeout preserves uncertain submission recovery (${result ? "rejected" : "nontrue"})`, async () => {
    const s = setup(result);
    s.callbacks.fieldsAvailableCallback();
    s.click();
    s.callbacks.callback({ token: "submitted-once" });
    s.context.error.textContent = "Payment outcome needs review";
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(s.recovery.textContent, "Reload checkout status");
    s.callbacks.timeoutCallback();
    assert.equal(s.context.error.textContent, "Payment outcome needs review");
    assert.equal(s.recovery.textContent, "Reload checkout status");
    assert.equal(s.context.button.disabled, true);
    s.callbacks.callback({ token: "late-token" });
    assert.deepEqual(s.submissions, ["submitted-once"]);
  });
}

for (const changed of ["quote", "address", "pending"]) {
  test(`changed ${changed} during tokenization cannot charge`, () => {
    const s = setup(true);
    s.callbacks.fieldsAvailableCallback();
    assert.equal(s.click(), false);
    if (changed === "quote") {
      s.context.checkout = "replacement-token";
      s.context.taxQuoteId = "quote-2";
    }
    if (changed === "address") s.context.billingAddress = () => ({ country: "US", state: "NJ" });
    if (changed === "pending") s.context.quoteButton.disabled = true;
    s.callbacks.callback({ token: "late-token" });
    assert.equal(s.submissions.length, 0);
    assert.equal(s.context.button.disabled, true);
    assert.equal(s.recovery.hidden, false);
    s.context.quoteButton.disabled = false;
    s.callbacks.fieldsAvailableCallback();
    s.callbacks.callback({ token: "another-token" });
    assert.equal(s.submissions.length, 0);
  });
}
test("a quote already in flight blocks the initiating click", () => {
  const s = setup(true);
  s.callbacks.fieldsAvailableCallback();
  s.context.quoteButton.disabled = true;
  assert.equal(s.click(), true);
  s.callbacks.callback({ token: "unsolicited" });
  assert.equal(s.submissions.length, 0);
});
test("uninitialized, unsolicited and duplicate clicks cannot submit", () => {
  const s = setup();
  assert.equal(s.click(), true);
  s.callbacks.callback({ token: "unsolicited" });
  assert.equal(s.submissions.length, 0);
  s.callbacks.fieldsAvailableCallback();
  assert.equal(s.click(), false);
  assert.equal(s.click(), true);
  s.callbacks.callback({ token: "once" });
  s.callbacks.timeoutCallback();
  assert.equal(s.recovery.hidden, true);
  assert.deepEqual(s.submissions, ["once"]);
});
