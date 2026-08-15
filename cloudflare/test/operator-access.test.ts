import { env } from "cloudflare:test";
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from "jose";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";

import { sha256Hex } from "../src/auth/api-key";
import {
  assertOperatorMutationRequest,
  authenticateOperatorAccess,
  type OperatorEnv,
} from "../src/operator/access";
import operatorWorker from "../src/operator/index";

const issuer = "https://serp-test.cloudflareaccess.com";
const audience = "synthetic-operator-audience";
const subject = "synthetic-access-subject";
let keySet: ReturnType<typeof createLocalJWKSet>;
let privateKey: CryptoKey;

function operatorEnv(overrides: Partial<OperatorEnv> = {}): OperatorEnv {
  return {
    APP_ENV: "test",
    BILLING_DB: env.BILLING_DB,
    OPERATOR_ACCESS_ENABLED: "1",
    ACCESS_TEAM_DOMAIN: issuer,
    ACCESS_AUD: audience,
    ...overrides,
  };
}

async function accessToken(
  options: {
    audience?: string;
    issuer?: string;
    subject?: string;
    expiration?: string;
  } = {},
): Promise<string> {
  return new SignJWT({})
    .setProtectedHeader({ alg: "RS256", kid: "operator-test-key" })
    .setIssuer(options.issuer ?? issuer)
    .setAudience(options.audience ?? audience)
    .setSubject(options.subject ?? subject)
    .setIssuedAt()
    .setExpirationTime(options.expiration ?? "5m")
    .sign(privateKey);
}

function accessRequest(token: string): Request {
  return new Request("https://operator.test/api/operator/v1/session", {
    headers: { "Cf-Access-Jwt-Assertion": token },
  });
}

beforeAll(async () => {
  const pair = await generateKeyPair("RS256");
  privateKey = pair.privateKey;
  const publicJwk = await exportJWK(pair.publicKey);
  publicJwk.alg = "RS256";
  publicJwk.kid = "operator-test-key";
  keySet = createLocalJWKSet({ keys: [publicJwk] });
});

beforeEach(async () => {
  const subjectHash = await sha256Hex(`${issuer}\n${subject}`);
  await env.BILLING_DB.batch([
    env.BILLING_DB.prepare(
      "DELETE FROM operator_memberships WHERE organization_id = 'org-operator-access'",
    ),
    env.BILLING_DB.prepare("DELETE FROM organizations WHERE id = 'org-operator-access'"),
    env.BILLING_DB.prepare(
      `INSERT INTO organizations (id, external_id, name, created_at, updated_at)
       VALUES ('org-operator-access', 'operator-access', 'Operator Access',
               '2026-08-16T00:00:00.000Z', '2026-08-16T00:00:00.000Z')`,
    ),
    env.BILLING_DB.prepare(
      `INSERT INTO operator_memberships
       (id, organization_id, access_issuer, access_subject_sha256, role, active, version,
        created_at, updated_at, revoked_at)
       VALUES ('membership-operator-access', 'org-operator-access', ?, ?, 'viewer', 1, 1,
               '2026-08-16T00:00:00.000Z', '2026-08-16T00:00:00.000Z', NULL)`,
    ).bind(issuer, subjectHash),
  ]);
});

describe("operator Access authentication", () => {
  it("fails closed before configuration or token processing when disabled", async () => {
    await expect(
      authenticateOperatorAccess(
        new Request("https://operator.test/api/operator/v1/session"),
        operatorEnv({
          OPERATOR_ACCESS_ENABLED: "0",
          ACCESS_TEAM_DOMAIN: undefined,
          ACCESS_AUD: undefined,
        }),
        keySet,
      ),
    ).rejects.toMatchObject({ status: 503, code: "operator_access_disabled" });
  });

  it("rejects missing or invalid issuer and audience configuration", async () => {
    const token = await accessToken();
    await expect(
      authenticateOperatorAccess(
        accessRequest(token),
        operatorEnv({ ACCESS_TEAM_DOMAIN: "https://example.com" }),
        keySet,
      ),
    ).rejects.toMatchObject({ status: 503, code: "operator_access_misconfigured" });
    await expect(
      authenticateOperatorAccess(accessRequest(token), operatorEnv({ ACCESS_AUD: "" }), keySet),
    ).rejects.toMatchObject({ status: 503, code: "operator_access_misconfigured" });
  });

  it("validates issuer, audience, signature, expiry, subject, and tenant membership", async () => {
    const context = await authenticateOperatorAccess(
      accessRequest(await accessToken()),
      operatorEnv(),
      keySet,
    );
    expect(context).toEqual({
      membershipId: "membership-operator-access",
      organizationId: "org-operator-access",
      organizationExternalId: "operator-access",
      role: "viewer",
    });

    await expect(
      authenticateOperatorAccess(
        accessRequest(await accessToken({ audience: "wrong-audience" })),
        operatorEnv(),
        keySet,
      ),
    ).rejects.toMatchObject({ status: 401, code: "operator_unauthorized" });
    await expect(
      authenticateOperatorAccess(
        accessRequest(await accessToken({ expiration: "-1m" })),
        operatorEnv(),
        keySet,
      ),
    ).rejects.toMatchObject({ status: 401, code: "operator_unauthorized" });
    await expect(
      authenticateOperatorAccess(
        accessRequest(await accessToken({ subject: "unknown-subject" })),
        operatorEnv(),
        keySet,
      ),
    ).rejects.toMatchObject({ status: 403, code: "operator_membership_required" });
  });

  it("keeps operator membership tenant identity immutable and unique", async () => {
    const subjectHash = await sha256Hex(`${issuer}\n${subject}`);
    await expect(
      env.BILLING_DB.prepare(
        `INSERT INTO operator_memberships
         (id, organization_id, access_issuer, access_subject_sha256, role, active, version,
          created_at, updated_at, revoked_at)
         VALUES ('membership-operator-duplicate', 'org-operator-access', ?, ?, 'admin', 1, 1,
                 '2026-08-16T00:00:00.000Z', '2026-08-16T00:00:00.000Z', NULL)`,
      )
        .bind(issuer, subjectHash)
        .run(),
    ).rejects.toThrow();
    await expect(
      env.BILLING_DB.prepare(
        `UPDATE operator_memberships SET organization_id = 'missing-organization'
         WHERE id = 'membership-operator-access'`,
      ).run(),
    ).rejects.toThrow(/immutable_operator_membership_identity/);
  });
});

describe("operator mutation request boundary", () => {
  it("requires same-origin, fetch provenance, CSRF header, and JSON", () => {
    expect(() =>
      assertOperatorMutationRequest(
        new Request("https://operator.test/api/operator/v1/example", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Origin: "https://operator.test",
            "Sec-Fetch-Site": "same-origin",
            "X-Operator-Request": "1",
          },
          body: "{}",
        }),
      ),
    ).not.toThrow();

    expect(() =>
      assertOperatorMutationRequest(
        new Request("https://operator.test/api/operator/v1/example", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Origin: "https://attacker.test",
            "X-Operator-Request": "1",
          },
          body: "{}",
        }),
      ),
    ).toThrow(/same-origin/);
    expect(() =>
      assertOperatorMutationRequest(
        new Request("https://operator.test/api/operator/v1/example", {
          method: "POST",
          headers: { "Content-Type": "application/json", Origin: "https://operator.test" },
          body: "{}",
        }),
      ),
    ).toThrow(/CSRF/);
    expect(() =>
      assertOperatorMutationRequest(
        new Request("https://operator.test/api/operator/v1/example", {
          method: "POST",
          headers: {
            "Content-Type": "text/plain",
            Origin: "https://operator.test",
            "X-Operator-Request": "1",
          },
          body: "{}",
        }),
      ),
    ).toThrow(/application\/json/);
  });
});

describe("operator Worker disabled boundary", () => {
  it("reports health but refuses readiness and sessions while disabled", async () => {
    const disabled = operatorEnv({
      OPERATOR_ACCESS_ENABLED: "0",
      ACCESS_TEAM_DOMAIN: undefined,
      ACCESS_AUD: undefined,
    });
    const health = await operatorWorker.fetch(
      new Request("https://operator.test/health"),
      disabled,
    );
    expect(health.status).toBe(200);
    await expect(health.json()).resolves.toMatchObject({
      service: "serp-lago-operator",
      access_enabled: false,
    });

    const ready = await operatorWorker.fetch(new Request("https://operator.test/ready"), disabled);
    expect(ready.status).toBe(503);
    await expect(ready.json()).resolves.toMatchObject({ code: "operator_access_disabled" });

    const session = await operatorWorker.fetch(
      new Request("https://operator.test/api/operator/v1/session"),
      disabled,
    );
    expect(session.status).toBe(503);
    await expect(session.json()).resolves.toMatchObject({ code: "operator_access_disabled" });
  });
});
