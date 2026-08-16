import assert from "node:assert/strict";
import { test } from "node:test";

import { reconcileOperatorAccess } from "./provision-operator-access.mjs";

const workerId = "617f1d0431a98306ff61e336d79fce86";
const appId = "f174e90a-fafe-4643-bbbc-4a0ed4fc8415";
const policyId = "0b63249c-95bf-4cc0-a7cc-d7faaaf1dac0";
const audience = "737646a56ab1df6ec9bddc7e5ca84eaf3b0768850f3ffb5d74f1534911fe3893";
const email = "farleythecoder@gmail.com";
const token = "test-token-that-is-long-enough-for-validation";

test("check mode reports the exact fail-closed plan without writing", async () => {
  const calls = [];
  const result = await reconcileOperatorAccess({
    apiToken: token,
    email,
    fetchImpl: mockCloudflare(calls, [organization(), workers(), envelope([])]),
  });

  assert.equal(result.status, "application-not-provisioned");
  assert.equal(result.would_create_application, true);
  assert.equal(result.worker_id, workerId);
  assert.equal(result.access_team_domain, "https://serp.cloudflareaccess.com");
  assert.deepEqual(
    calls.map((call) => call.method),
    ["GET", "GET", "GET"],
  );
});

test("apply mode creates and verifies the one Worker application and email policy", async () => {
  const calls = [];
  const result = await reconcileOperatorAccess({
    apiToken: token,
    email,
    apply: true,
    fetchImpl: mockCloudflare(calls, [
      organization(),
      workers(),
      envelope([]),
      envelope(application()),
      envelope([]),
      envelope(policy()),
      envelope([policy()]),
    ]),
  });

  assert.equal(result.status, "configured");
  assert.equal(result.application_created, true);
  assert.equal(result.policy_created, true);
  assert.equal(result.access_aud, audience);
  assert.deepEqual(
    calls.map((call) => call.method),
    ["GET", "GET", "GET", "POST", "GET", "POST", "GET"],
  );
  assert.deepEqual(calls[3].body, {
    name: "serp-dev-lago-operator",
    type: "self_hosted",
    session_duration: "24h",
    app_launcher_visible: false,
    destinations: [{ type: "worker", worker_id: workerId }],
  });
  assert.deepEqual(calls[5].body.include, [{ email: { email } }]);
});

test("existing exact resources are verified without writes", async () => {
  const calls = [];
  const result = await reconcileOperatorAccess({
    apiToken: token,
    email,
    apply: true,
    fetchImpl: mockCloudflare(calls, [
      organization(),
      workers(),
      envelope([application()]),
      envelope([policy()]),
    ]),
  });

  assert.equal(result.status, "configured");
  assert.equal(result.application_created, false);
  assert.equal(result.policy_created, false);
  assert.deepEqual(
    calls.map((call) => call.method),
    ["GET", "GET", "GET", "GET"],
  );
});

test("unapproved additional policies fail closed", async () => {
  await assert.rejects(
    reconcileOperatorAccess({
      apiToken: token,
      email,
      apply: true,
      fetchImpl: mockCloudflare(
        [],
        [
          organization(),
          workers(),
          envelope([application()]),
          envelope([policy(), { ...policy(), id: "other", name: "Everyone" }]),
        ],
      ),
    }),
    /unapproved additional policies/,
  );
});

test("API errors do not expose the token", async () => {
  const failingFetch = async () =>
    new Response(
      JSON.stringify({
        success: false,
        errors: [{ code: 9109, message: `Unauthorized token ${token}` }],
      }),
      { status: 403, headers: { "Content-Type": "application/json" } },
    );
  await assert.rejects(
    reconcileOperatorAccess({ apiToken: token, email, fetchImpl: failingFetch }),
    (error) => {
      assert.doesNotMatch(error.message, new RegExp(token));
      assert.match(error.message, /Unauthorized/);
      return true;
    },
  );
});

function organization() {
  return envelope({ auth_domain: "serp.cloudflareaccess.com" });
}

function workers() {
  return envelope([{ id: "serp-dev-lago-operator", tag: workerId }]);
}

function application() {
  return {
    id: appId,
    aud: audience,
    name: "serp-dev-lago-operator",
    type: "self_hosted",
    session_duration: "24h",
    app_launcher_visible: false,
    destinations: [{ type: "worker", worker_id: workerId }],
  };
}

function policy() {
  return {
    id: policyId,
    name: "Allow Lago operator development",
    decision: "allow",
    precedence: 1,
    session_duration: "24h",
    include: [{ email: { email } }],
    exclude: [],
    require: [],
  };
}

function envelope(result) {
  return { success: true, errors: [], messages: [], result };
}

function mockCloudflare(calls, responses) {
  return async (url, init) => {
    const response = responses.shift();
    if (!response) throw new Error(`Unexpected request to ${url}`);
    calls.push({
      url,
      method: init.method,
      body: init.body ? JSON.parse(init.body) : undefined,
    });
    return new Response(JSON.stringify(response), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };
}
