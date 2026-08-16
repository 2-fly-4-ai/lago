import { pathToFileURL } from "node:url";

const API_BASE = "https://api.cloudflare.com/client/v4";
const MAX_RESPONSE_BYTES = 1024 * 1024;
const DEFAULT_ACCOUNT_ID = "cec5f04e1d18bcc65f2be0aefb04f059";
const DEFAULT_WORKER_NAME = "serp-dev-lago-operator";
const DEFAULT_APPLICATION_NAME = "serp-dev-lago-operator";
const DEFAULT_POLICY_NAME = "Allow Lago operator development";
const SESSION_DURATION = "24h";

export async function reconcileOperatorAccess({
  apiToken,
  email,
  apply = false,
  accountId = DEFAULT_ACCOUNT_ID,
  workerName = DEFAULT_WORKER_NAME,
  applicationName = DEFAULT_APPLICATION_NAME,
  policyName = DEFAULT_POLICY_NAME,
  fetchImpl = fetch,
}) {
  assertToken(apiToken);
  const normalizedEmail = normalizeEmail(email);
  assertIdentifier(accountId, "account ID", /^[a-f0-9]{32}$/);
  assertIdentifier(workerName, "Worker name", /^[a-z0-9][a-z0-9-]{0,62}$/);
  assertIdentifier(applicationName, "application name", /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,127}$/);
  assertIdentifier(policyName, "policy name", /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,127}$/);

  const api = createCloudflareApi({ apiToken, fetchImpl });
  const accountPath = `/accounts/${accountId}`;

  // Perform every read permission check before the first write. A failed preflight leaves the
  // fail-closed bootstrap untouched and cannot create a partially configured Access application.
  const [organization, workers, applications] = await Promise.all([
    api.get(`${accountPath}/access/organizations`),
    api.get(`${accountPath}/workers/scripts`),
    listAll(api, `${accountPath}/access/apps`),
  ]);

  const authDomain = requiredString(organization.auth_domain, "Zero Trust auth domain");
  if (!/^[a-z0-9-]+\.cloudflareaccess\.com$/i.test(authDomain)) {
    throw new Error("The Zero Trust organization returned an invalid auth domain");
  }

  const worker = findExactlyOne(
    workers,
    (candidate) => candidate?.id === workerName,
    `Worker named ${workerName}`,
  );
  const workerId = requiredString(worker.tag, "immutable Worker ID");
  if (!/^[a-f0-9]{32}$/i.test(workerId)) {
    throw new Error("The Worker API returned an invalid immutable Worker ID");
  }

  let application = findAtMostOne(
    applications,
    (candidate) => candidate?.name === applicationName,
    `Access application named ${applicationName}`,
  );
  let applicationCreated = false;

  if (!application) {
    if (!apply) {
      return plannedResult({
        accountId,
        workerName,
        workerId,
        applicationName,
        policyName,
        normalizedEmail,
        authDomain,
      });
    }
    application = await api.post(`${accountPath}/access/apps`, {
      name: applicationName,
      type: "self_hosted",
      session_duration: SESSION_DURATION,
      app_launcher_visible: false,
      destinations: [{ type: "worker", worker_id: workerId }],
    });
    applicationCreated = true;
  }

  validateApplication(application, { applicationName, workerId });
  const applicationId = requiredString(application.id, "Access application ID");
  const audience = requiredString(application.aud, "Access application audience");

  let policies = await listAll(api, `${accountPath}/access/apps/${applicationId}/policies`);
  let policy = findAtMostOne(
    policies,
    (candidate) => candidate?.name === policyName,
    `Access policy named ${policyName}`,
  );
  const foreignPolicies = policies.filter((candidate) => candidate?.name !== policyName);
  if (foreignPolicies.length > 0) {
    throw new Error(
      `Access application ${applicationName} has unapproved additional policies; refusing to continue`,
    );
  }

  let policyCreated = false;
  if (!policy) {
    if (!apply) {
      return {
        ...resultBase({
          accountId,
          workerName,
          workerId,
          applicationName,
          applicationId,
          audience,
          authDomain,
          policyName,
          normalizedEmail,
        }),
        status: "policy-not-provisioned",
        would_create_policy: true,
      };
    }
    policy = await api.post(`${accountPath}/access/apps/${applicationId}/policies`, {
      name: policyName,
      decision: "allow",
      precedence: 1,
      session_duration: SESSION_DURATION,
      include: [{ email: { email: normalizedEmail } }],
      exclude: [],
      require: [],
    });
    policyCreated = true;
    policies = await listAll(api, `${accountPath}/access/apps/${applicationId}/policies`);
    if (policies.length !== 1) {
      throw new Error("Access policy verification found an unexpected policy count");
    }
    policy = policies[0];
  }

  validatePolicy(policy, { policyName, normalizedEmail });
  return {
    ...resultBase({
      accountId,
      workerName,
      workerId,
      applicationName,
      applicationId,
      audience,
      authDomain,
      policyName,
      normalizedEmail,
    }),
    status: "configured",
    application_created: applicationCreated,
    policy_created: policyCreated,
    policy_id: requiredString(policy.id, "Access policy ID"),
  };
}

function createCloudflareApi({ apiToken, fetchImpl }) {
  async function request(method, path, body) {
    const response = await fetchImpl(`${API_BASE}${path}`, {
      method,
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${apiToken}`,
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const envelope = await readBoundedJson(response);
    if (!response.ok || envelope?.success !== true) {
      const error = Array.isArray(envelope?.errors) ? envelope.errors[0] : undefined;
      const code = typeof error?.code === "number" ? ` ${error.code}` : "";
      const message =
        typeof error?.message === "string" ? `: ${sanitizeError(error.message, apiToken)}` : "";
      throw new Error(
        `Cloudflare API ${method} ${path} failed (${response.status})${code}${message}`,
      );
    }
    return envelope.result;
  }
  return {
    get: (path) => request("GET", path),
    post: (path, body) => request("POST", path, body),
  };
}

async function listAll(api, path) {
  const results = [];
  for (let page = 1; page <= 100; page += 1) {
    const separator = path.includes("?") ? "&" : "?";
    const envelopeResult = await api.get(`${path}${separator}page=${page}&per_page=50`);
    if (!Array.isArray(envelopeResult))
      throw new Error(`Cloudflare API ${path} did not return a list`);
    results.push(...envelopeResult);
    if (envelopeResult.length < 50) return results;
  }
  throw new Error(`Cloudflare API ${path} exceeded the bounded pagination limit`);
}

async function readBoundedJson(response) {
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_RESPONSE_BYTES) {
    await response.body?.cancel();
    throw new Error("Cloudflare API response exceeded the maximum allowed size");
  }
  if (!response.body) throw new Error("Cloudflare API returned an empty response");

  const reader = response.body.getReader();
  const chunks = [];
  let length = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    length += value.byteLength;
    if (length > MAX_RESPONSE_BYTES) {
      await reader.cancel();
      throw new Error("Cloudflare API response exceeded the maximum allowed size");
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new Error("Cloudflare API returned invalid JSON");
  }
}

function validateApplication(application, { applicationName, workerId }) {
  if (application?.name !== applicationName || application?.type !== "self_hosted") {
    throw new Error(
      "The existing Access application does not match the approved application identity",
    );
  }
  if (application.session_duration !== SESSION_DURATION) {
    throw new Error("The existing Access application does not use the approved 24-hour session");
  }
  if (application.app_launcher_visible !== false) {
    throw new Error("The existing Access application must be hidden from the App Launcher");
  }
  const destinations = Array.isArray(application.destinations) ? application.destinations : [];
  if (
    destinations.length !== 1 ||
    destinations[0]?.type !== "worker" ||
    destinations[0]?.worker_id !== workerId
  ) {
    throw new Error("The existing Access application does not protect only the approved Worker");
  }
}

function validatePolicy(policy, { policyName, normalizedEmail }) {
  if (
    policy?.name !== policyName ||
    policy?.decision !== "allow" ||
    policy?.precedence !== 1 ||
    policy?.session_duration !== SESSION_DURATION ||
    policy?.approval_required === true ||
    policy?.isolation_required === true
  ) {
    throw new Error("The existing Access policy does not match the approved policy settings");
  }
  const include = Array.isArray(policy.include) ? policy.include : [];
  const exclude = Array.isArray(policy.exclude) ? policy.exclude : [];
  const requireRules = Array.isArray(policy.require) ? policy.require : [];
  const includedEmail = include[0]?.email?.email;
  if (
    include.length !== 1 ||
    typeof includedEmail !== "string" ||
    includedEmail.toLowerCase() !== normalizedEmail ||
    exclude.length !== 0 ||
    requireRules.length !== 0
  ) {
    throw new Error("The existing Access policy does not allow only the approved email identity");
  }
}

function plannedResult({
  accountId,
  workerName,
  workerId,
  applicationName,
  policyName,
  normalizedEmail,
  authDomain,
}) {
  return {
    ...resultBase({
      accountId,
      workerName,
      workerId,
      applicationName,
      applicationId: null,
      audience: null,
      authDomain,
      policyName,
      normalizedEmail,
    }),
    status: "application-not-provisioned",
    would_create_application: true,
    would_create_policy: true,
  };
}

function resultBase({
  accountId,
  workerName,
  workerId,
  applicationName,
  applicationId,
  audience,
  authDomain,
  policyName,
  normalizedEmail,
}) {
  return {
    account_id: accountId,
    worker_name: workerName,
    worker_id: workerId,
    application_name: applicationName,
    application_id: applicationId,
    access_aud: audience,
    access_team_domain: `https://${authDomain}`,
    session_duration: SESSION_DURATION,
    policy_name: policyName,
    policy_email: normalizedEmail,
  };
}

function findExactlyOne(values, predicate, description) {
  const value = findAtMostOne(values, predicate, description);
  if (!value) throw new Error(`${description} was not found`);
  return value;
}

function findAtMostOne(values, predicate, description) {
  if (!Array.isArray(values)) throw new Error(`${description} lookup did not return a list`);
  const matches = values.filter(predicate);
  if (matches.length > 1) throw new Error(`${description} is ambiguous`);
  return matches[0];
}

function requiredString(value, description) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${description} is missing`);
  return value.trim();
}

function assertToken(value) {
  if (typeof value !== "string" || value.length < 20 || value.length > 4096) {
    throw new Error("CLOUDFLARE_API_TOKEN is missing or invalid");
  }
}

function sanitizeError(value, apiToken) {
  return value
    .replaceAll(apiToken, "[REDACTED]")
    .replace(/[\r\n\t]/g, " ")
    .slice(0, 500);
}

function normalizeEmail(value) {
  if (typeof value !== "string" || value.length > 254) {
    throw new Error("OPERATOR_ACCESS_EMAIL is missing or invalid");
  }
  const normalized = value.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized)) {
    throw new Error("OPERATOR_ACCESS_EMAIL is missing or invalid");
  }
  return normalized;
}

function assertIdentifier(value, description, pattern) {
  if (typeof value !== "string" || !pattern.test(value)) throw new Error(`Invalid ${description}`);
}

async function main() {
  const apply = process.argv.includes("--apply");
  const check = process.argv.includes("--check");
  if (apply === check) throw new Error("Pass exactly one of --check or --apply");
  const result = await reconcileOperatorAccess({
    apiToken: process.env.CLOUDFLARE_API_TOKEN,
    email: process.env.OPERATOR_ACCESS_EMAIL,
    apply,
  });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((error) => {
    const message = error instanceof Error ? error.message : "Unknown provisioning error";
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  });
}
