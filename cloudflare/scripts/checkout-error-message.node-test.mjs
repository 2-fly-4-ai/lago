import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { runInNewContext } from "node:vm";

// Execute the actual helper embedded in the hosted checkout, not a test copy.
const source = readFileSync(
  new URL("../src/providers/easy-pay-direct.ts", import.meta.url),
  "utf8",
);
const helper = source
  .match(/function checkoutErrorMessage\(payload,fallback\)\{.*?\}function money/s)?.[0]
  .replace(/function money$/, "");
assert.ok(helper, "The checkout error helper must be present");
const message = runInNewContext(`(${helper})`);

test("shows the API explanation instead of the HTTP status label", () => {
  for (const code of ["checkout_tax_registration_missing", "checkout_tax_rule_missing"]) {
    assert.equal(
      message(
        {
          status: 503,
          error: "Service Unavailable",
          code,
          message: "Tax rules do not cover this billing destination",
        },
        "Fallback",
      ),
      "Tax rules do not cover this billing destination",
    );
  }
});

test("supports nested API errors and rejects non-text messages", () => {
  assert.equal(
    message({ error: { message: "This checkout has expired" } }, "Fallback"),
    "This checkout has expired",
  );
  assert.equal(message({ error: "Conflict" }, "Fallback"), "Conflict");
  for (const payload of [
    null,
    {},
    { message: " ", error: {} },
    { message: 503 },
    { error: { message: [] } },
  ]) {
    assert.equal(message(payload, "Fallback"), "Fallback");
  }
});

test("tax quoting and payment submission both use the same helper and a text-only sink", () => {
  assert.ok(source.includes("checkoutErrorMessage(payload,'Tax could not be calculated')"));
  assert.ok(source.includes("checkoutErrorMessage(body,'Payment could not be processed')"));
  assert.ok(source.includes("error.textContent=cause instanceof Error?cause.message:"));
  assert.ok(!source.includes("error.innerHTML="));
});
