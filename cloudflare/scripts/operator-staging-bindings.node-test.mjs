import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";

function config(name) {
  const parsed = ts.parseConfigFileTextToJson(
    name,
    readFileSync(new URL("../" + name, import.meta.url), "utf8"),
  );
  assert.equal(parsed.error, undefined);
  return parsed.config;
}

test("staging operator uses the isolated SerpTEST resources consistently", () => {
  const operator = config("wrangler.operator.jsonc");
  const native = config("wrangler.serptest.jsonc");
  assert.equal(operator.name, "serp-dev-lago-operator");
  assert.equal(native.name, "serp-dev-lago-epd-serptest");
  assert.equal(operator.account_id, native.account_id);
  assert.deepEqual(operator.d1_databases, native.d1_databases);
  assert.deepEqual(operator.r2_buckets, native.r2_buckets);
  assert.deepEqual(operator.queues.producers, native.queues.producers);
  for (const binding of operator.durable_objects.bindings) {
    assert.equal(binding.script_name, native.name);
    assert.ok(
      native.durable_objects.bindings.some(
        (candidate) =>
          candidate.name === binding.name && candidate.class_name === binding.class_name,
      ),
    );
  }
  for (const workflow of operator.workflows) {
    const { script_name, ...definition } = workflow;
    assert.equal(script_name, native.name);
    assert.deepEqual(
      definition,
      native.workflows.find((candidate) => candidate.binding === workflow.binding),
    );
  }
  assert.equal(operator.services[0].service, native.name);
  assert.equal(operator.services[0].entrypoint, "ProviderFinancialService");
  assert.equal(operator.vars.APP_ENV, "development");
  assert.equal(operator.vars.OPERATOR_ACCESS_ENABLED, "1");
  assert.equal(operator.vars.CREDIT_NOTE_REFUND_MODE, "disabled");
  assert.equal(operator.vars.ACCESS_TEAM_DOMAIN, "https://serpcompany.cloudflareaccess.com");
  assert.equal(
    operator.vars.ACCESS_AUD,
    "4e2aeb75eccbd0abda500c9318a371acbeab7a244f8727904358021daea5a951",
  );
  assert.equal(JSON.stringify(operator).includes("serp-prod-"), false);
});
