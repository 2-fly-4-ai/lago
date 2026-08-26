import { env } from "cloudflare:test";
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from "jose";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";

import { sha256Hex } from "../src/auth/api-key";
import {
  assertOperatorMutationRequest,
  authenticateOperatorAccess,
  type OperatorEnv,
} from "../src/operator/access";
import { handleOperatorRequest } from "../src/operator/index";

const issuer = "https://serp-test.cloudflareaccess.com";
const audience = "synthetic-operator-audience";
const subject = "synthetic-access-subject";
let keySet: ReturnType<typeof createLocalJWKSet>;
let privateKey: CryptoKey;

function operatorEnv(overrides: Partial<OperatorEnv> = {}): OperatorEnv {
  return {
    APP_ENV: "test",
    BILLING_ACCOUNTS: env.BILLING_ACCOUNTS,
    BILLING_ARTIFACTS: env.BILLING_ARTIFACTS,
    BILLING_DB: env.BILLING_DB,
    DOMAIN_EVENTS: env.DOMAIN_EVENTS,
    DOCUMENT_WORKFLOW: env.DOCUMENT_WORKFLOW,
    PLAN_DELETION_WORKFLOW: env.PLAN_DELETION_WORKFLOW,
    OPERATOR_ACCESS_ENABLED: "1",
    TEST_MIGRATIONS: env.TEST_MIGRATIONS,
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
    email?: string;
  } = {},
): Promise<string> {
  return new SignJWT(options.email ? { email: options.email } : {})
    .setProtectedHeader({ alg: "RS256", kid: "operator-test-key" })
    .setIssuer(options.issuer ?? issuer)
    .setAudience(options.audience ?? audience)
    .setSubject(options.subject ?? subject)
    .setIssuedAt()
    .setExpirationTime(options.expiration ?? "5m")
    .sign(privateKey);
}

function accessRequest(token: string, organizationSlug?: string): Request {
  return new Request("https://operator.test/api/operator/v1/session", {
    headers: {
      "Cf-Access-Jwt-Assertion": token,
      ...(organizationSlug ? { "X-Operator-Organization": organizationSlug } : {}),
    },
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
      "DELETE FROM operator_api_logs WHERE organization_id = 'org-operator-access'",
    ),
    env.BILLING_DB.prepare(
      "DELETE FROM operator_invitations WHERE organization_id = 'org-operator-access'",
    ),
    env.BILLING_DB.prepare(
      "DELETE FROM customer_portal_tokens WHERE organization_id = 'org-operator-access'",
    ),
    env.BILLING_DB.prepare("DELETE FROM ai_messages WHERE organization_id = 'org-operator-access'"),
    env.BILLING_DB.prepare(
      "DELETE FROM ai_conversations WHERE organization_id = 'org-operator-access'",
    ),
    env.BILLING_DB.prepare(
      "DELETE FROM entitlement_values WHERE organization_id = 'org-operator-access'",
    ),
    env.BILLING_DB.prepare(
      "DELETE FROM plan_entitlements WHERE organization_id = 'org-operator-access'",
    ),
    env.BILLING_DB.prepare(
      "DELETE FROM entitlement_privileges WHERE organization_id = 'org-operator-access'",
    ),
    env.BILLING_DB.prepare(
      "DELETE FROM entitlement_features WHERE organization_id = 'org-operator-access'",
    ),
    env.BILLING_DB.prepare(
      "DELETE FROM customers WHERE organization_id = 'org-operator-access-secondary'",
    ),
    env.BILLING_DB.prepare(
      "DELETE FROM operator_memberships WHERE organization_id = 'org-operator-access-secondary'",
    ),
    env.BILLING_DB.prepare("DELETE FROM organizations WHERE id = 'org-operator-access-secondary'"),
    env.BILLING_DB.prepare(
      "DELETE FROM data_exports WHERE organization_id = 'org-operator-access'",
    ),
    env.BILLING_DB.prepare(
      "DELETE FROM outbound_webhook_deliveries WHERE organization_id = 'org-operator-access'",
    ),
    env.BILLING_DB.prepare(
      "DELETE FROM webhook_endpoints WHERE organization_id = 'org-operator-access'",
    ),
    env.BILLING_DB.prepare(
      "UPDATE organizations SET applied_dunning_campaign_id = NULL WHERE id = 'org-operator-access'",
    ),
    env.BILLING_DB.prepare(
      `UPDATE customers SET applied_dunning_campaign_id = NULL
       WHERE organization_id = 'org-operator-access'`,
    ),
    env.BILLING_DB.prepare(
      "DELETE FROM dunning_campaign_thresholds WHERE organization_id = 'org-operator-access'",
    ),
    env.BILLING_DB.prepare(
      "DELETE FROM dunning_campaigns WHERE organization_id = 'org-operator-access'",
    ),
    env.BILLING_DB.prepare(
      "DELETE FROM operator_memberships WHERE organization_id = 'org-operator-access'",
    ),
    env.BILLING_DB.prepare(
      "DELETE FROM outbox_events WHERE organization_id = 'org-operator-access'",
    ),
    env.BILLING_DB.prepare(
      "DELETE FROM invoice_custom_sections WHERE organization_id = 'org-operator-access'",
    ),
    env.BILLING_DB.prepare(
      "DELETE FROM credit_note_taxes WHERE organization_id = 'org-operator-access'",
    ),
    env.BILLING_DB.prepare(
      "DELETE FROM credit_note_item_adjustments WHERE organization_id = 'org-operator-access'",
    ),
    env.BILLING_DB.prepare(
      "DELETE FROM credit_note_offsets WHERE organization_id = 'org-operator-access'",
    ),
    env.BILLING_DB.prepare(
      "DELETE FROM credit_note_refunds WHERE organization_id = 'org-operator-access'",
    ),
    env.BILLING_DB.prepare(
      "DELETE FROM credit_note_financials WHERE organization_id = 'org-operator-access'",
    ),
    env.BILLING_DB.prepare("DELETE FROM taxes WHERE organization_id = 'org-operator-access'"),
    env.BILLING_DB.prepare(
      "DELETE FROM applied_coupons WHERE organization_id = 'org-operator-access'",
    ),
    env.BILLING_DB.prepare("DELETE FROM coupons WHERE organization_id = 'org-operator-access'"),
    env.BILLING_DB.prepare(
      "DELETE FROM fixed_charges WHERE organization_id = 'org-operator-access'",
    ),
    env.BILLING_DB.prepare("DELETE FROM add_ons WHERE organization_id = 'org-operator-access'"),
    env.BILLING_DB.prepare("DELETE FROM charges WHERE organization_id = 'org-operator-access'"),
    env.BILLING_DB.prepare(
      "DELETE FROM usage_thresholds WHERE organization_id = 'org-operator-access'",
    ),
    env.BILLING_DB.prepare(
      "DELETE FROM minimum_commitments WHERE organization_id = 'org-operator-access'",
    ),
    env.BILLING_DB.prepare(
      "DELETE FROM payment_receipts WHERE organization_id = 'org-operator-access'",
    ),
    env.BILLING_DB.prepare(
      "DELETE FROM payment_attempts WHERE organization_id = 'org-operator-access'",
    ),
    env.BILLING_DB.prepare(
      "DELETE FROM wallet_transactions WHERE organization_id = 'org-operator-access'",
    ),
    env.BILLING_DB.prepare("DELETE FROM wallets WHERE organization_id = 'org-operator-access'"),
    env.BILLING_DB.prepare(
      "DELETE FROM credit_note_recredits WHERE organization_id = 'org-operator-access'",
    ),
    env.BILLING_DB.prepare(
      "DELETE FROM credit_note_applications WHERE organization_id = 'org-operator-access'",
    ),
    env.BILLING_DB.prepare(
      "DELETE FROM termination_credit_note_contexts WHERE organization_id = 'org-operator-access'",
    ),
    env.BILLING_DB.prepare(
      "DELETE FROM credit_note_document_artifacts WHERE organization_id = 'org-operator-access'",
    ),
    env.BILLING_DB.prepare(
      "DELETE FROM credit_note_items WHERE organization_id = 'org-operator-access'",
    ),
    env.BILLING_DB.prepare(
      "DELETE FROM credit_notes WHERE organization_id = 'org-operator-access'",
    ),
    env.BILLING_DB.prepare(
      "DELETE FROM quote_owners WHERE organization_id = 'org-operator-access'",
    ),
    env.BILLING_DB.prepare(
      "DELETE FROM quote_versions WHERE organization_id = 'org-operator-access'",
    ),
    env.BILLING_DB.prepare("DELETE FROM quotes WHERE organization_id = 'org-operator-access'"),
    env.BILLING_DB.prepare(
      "DELETE FROM plan_change_invoice_contexts WHERE organization_id = 'org-operator-access'",
    ),
    env.BILLING_DB.prepare(
      "DELETE FROM subscription_invoice_contexts WHERE organization_id = 'org-operator-access'",
    ),
    env.BILLING_DB.prepare("DELETE FROM invoices WHERE organization_id = 'org-operator-access'"),
    env.BILLING_DB.prepare(
      "DELETE FROM subscriptions WHERE organization_id = 'org-operator-access'",
    ),
    env.BILLING_DB.prepare("DELETE FROM plans WHERE organization_id = 'org-operator-access'"),
    env.BILLING_DB.prepare("DELETE FROM api_keys WHERE organization_id = 'org-operator-access'"),
    env.BILLING_DB.prepare("DELETE FROM customers WHERE organization_id = 'org-operator-access'"),
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
    expect(context).toMatchObject({
      membershipId: "membership-operator-access",
      organizationId: "org-operator-access",
      organizationExternalId: "operator-access",
      organizationName: "Operator Access",
      organizationSlug: "operator-access",
      role: "viewer",
      memberships: [
        {
          membershipId: "membership-operator-access",
          organizationId: "org-operator-access",
          organizationSlug: "operator-access",
          role: "viewer",
        },
      ],
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

  it("claims a hashed pending Access invitation on first authenticated login", async () => {
    const invitedSubject = `invited-${crypto.randomUUID()}`;
    const invitedEmail = `invited-${crypto.randomUUID()}@example.invalid`;
    const now = new Date().toISOString();
    await env.BILLING_DB.prepare(
      `INSERT INTO operator_invitations
       (id, organization_id, access_issuer, email_sha256, role, status,
        invited_by_membership_id, created_at, updated_at, expires_at)
       VALUES (?, 'org-operator-access', ?, ?, 'admin', 'pending',
               'membership-operator-access', ?, ?, '2099-01-01T00:00:00.000Z')`,
    )
      .bind(crypto.randomUUID(), issuer, await sha256Hex(invitedEmail), now, now)
      .run();

    const context = await authenticateOperatorAccess(
      accessRequest(await accessToken({ subject: invitedSubject, email: invitedEmail })),
      operatorEnv(),
      keySet,
    );
    expect(context).toMatchObject({ organizationId: "org-operator-access", role: "admin" });
    const invitation = await env.BILLING_DB.prepare(
      "SELECT status FROM operator_invitations WHERE organization_id = 'org-operator-access'",
    ).first<{ status: string }>();
    expect(invitation?.status).toBe("accepted");
  });

  it("allows one Access identity in multiple organizations while keeping each membership unique and immutable", async () => {
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

    await env.BILLING_DB.prepare(
      `INSERT INTO organizations (id, external_id, name, slug, created_at, updated_at)
       VALUES ('org-operator-access-secondary', 'operator-access-secondary',
               'Operator Access Secondary', 'operator-access-secondary',
               '2026-08-16T00:00:00.000Z', '2026-08-16T00:00:00.000Z')`,
    ).run();
    await expect(
      env.BILLING_DB.prepare(
        `INSERT INTO operator_memberships
         (id, organization_id, access_issuer, access_subject_sha256, role, active, version,
          created_at, updated_at, revoked_at)
         VALUES ('membership-operator-secondary', 'org-operator-access-secondary', ?, ?,
                 'admin', 1, 1, '2026-08-16T00:00:01.000Z',
                 '2026-08-16T00:00:01.000Z', NULL)`,
      )
        .bind(issuer, subjectHash)
        .run(),
    ).resolves.toBeDefined();

    const secondaryContext = await authenticateOperatorAccess(
      accessRequest(await accessToken(), "operator-access-secondary"),
      operatorEnv(),
      keySet,
    );
    expect(secondaryContext).toMatchObject({
      membershipId: "membership-operator-secondary",
      organizationId: "org-operator-access-secondary",
      organizationSlug: "operator-access-secondary",
      role: "admin",
    });
    expect(secondaryContext.memberships).toHaveLength(2);

    await expect(
      authenticateOperatorAccess(
        accessRequest(await accessToken(), "not-a-membership"),
        operatorEnv(),
        keySet,
      ),
    ).rejects.toMatchObject({ status: 403, code: "operator_organization_forbidden" });

    await expect(
      authenticateOperatorAccess(
        new Request("https://operator.test/api/operator/v1/customers", {
          headers: { "Cf-Access-Jwt-Assertion": await accessToken() },
        }),
        operatorEnv(),
        keySet,
      ),
    ).rejects.toMatchObject({ status: 409, code: "operator_organization_required" });

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
    const health = await handleOperatorRequest(
      new Request("https://operator.test/health"),
      disabled,
    );
    expect(health.status).toBe(200);
    await expect(health.json()).resolves.toMatchObject({
      service: "serp-lago-operator",
      access_enabled: false,
    });

    const ready = await handleOperatorRequest(new Request("https://operator.test/ready"), disabled);
    expect(ready.status).toBe(503);
    await expect(ready.json()).resolves.toMatchObject({ code: "operator_access_disabled" });

    const session = await handleOperatorRequest(
      new Request("https://operator.test/api/operator/v1/session"),
      disabled,
    );
    expect(session.status).toBe(503);
    await expect(session.json()).resolves.toMatchObject({ code: "operator_access_disabled" });
  });

  it("projects the membership-scoped organization through the existing REST serializer", async () => {
    const response = await handleOperatorRequest(
      accessRequest(await accessToken()).clone(),
      operatorEnv(),
      keySet,
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      operator: {
        membership_id: "membership-operator-access",
        organization_id: "org-operator-access",
        organization_external_id: "operator-access",
        organization_name: "Operator Access",
        organization_slug: "operator-access",
        role: "viewer",
        memberships: [
          {
            membership_id: "membership-operator-access",
            role: "viewer",
            organization: {
              lago_id: "org-operator-access",
              external_id: "operator-access",
              name: "Operator Access",
              slug: "operator-access",
            },
          },
        ],
      },
    });

    const organizationResponse = await handleOperatorRequest(
      new Request("https://operator.test/api/operator/v1/organization", {
        headers: { "Cf-Access-Jwt-Assertion": await accessToken() },
      }),
      operatorEnv(),
      keySet,
    );
    expect(organizationResponse.status).toBe(200);
    await expect(organizationResponse.json()).resolves.toMatchObject({
      organization: {
        lago_id: "org-operator-access",
        name: "Operator Access",
        slug: "operator-access",
        default_currency: "USD",
        timezone: "UTC",
        version: 1,
      },
    });
  });

  it("returns every membership and isolates organization-slug data requests", async () => {
    const subjectHash = await sha256Hex(`${issuer}\n${subject}`);
    const now = "2026-08-16T00:02:00.000Z";
    await env.BILLING_DB.batch([
      env.BILLING_DB.prepare(
        `INSERT INTO organizations (id, external_id, name, slug, created_at, updated_at)
         VALUES ('org-operator-access-secondary', 'operator-access-secondary',
                 'Operator Access Secondary', 'operator-access-secondary', ?, ?)`,
      ).bind(now, now),
      env.BILLING_DB.prepare(
        `INSERT INTO operator_memberships
         (id, organization_id, access_issuer, access_subject_sha256, role, active, version,
          created_at, updated_at, revoked_at)
         VALUES ('membership-operator-secondary', 'org-operator-access-secondary', ?, ?,
                 'admin', 1, 1, ?, ?, NULL)`,
      ).bind(issuer, subjectHash, now, now),
      env.BILLING_DB.prepare(
        `INSERT INTO customers
         (id, organization_id, external_id, name, currency, metadata_json, version,
          created_at, updated_at)
         VALUES ('customer-operator-primary', 'org-operator-access', 'primary-customer',
                 'Primary Customer', 'USD', '{}', 1, ?, ?)`,
      ).bind(now, now),
      env.BILLING_DB.prepare(
        `INSERT INTO customers
         (id, organization_id, external_id, name, currency, metadata_json, version,
          created_at, updated_at)
         VALUES ('customer-operator-secondary', 'org-operator-access-secondary',
                 'secondary-customer', 'Secondary Customer', 'NZD', '{}', 1, ?, ?)`,
      ).bind(now, now),
    ]);

    const session = await handleOperatorRequest(
      accessRequest(await accessToken(), "operator-access-secondary"),
      operatorEnv(),
      keySet,
    );
    expect(session.status).toBe(200);
    await expect(session.json()).resolves.toMatchObject({
      operator: {
        membership_id: "membership-operator-secondary",
        organization_slug: "operator-access-secondary",
        role: "admin",
        memberships: [
          { organization: { slug: "operator-access" } },
          { organization: { slug: "operator-access-secondary" } },
        ],
      },
    });

    const secondaryCustomers = await handleOperatorRequest(
      new Request("https://operator.test/api/operator/v1/customers", {
        headers: {
          "Cf-Access-Jwt-Assertion": await accessToken(),
          "X-Operator-Organization": "operator-access-secondary",
        },
      }),
      operatorEnv(),
      keySet,
    );
    await expect(secondaryCustomers.json()).resolves.toMatchObject({
      customers: [{ external_id: "secondary-customer", name: "Secondary Customer" }],
      meta: { total_count: 1 },
    });

    const primaryCustomers = await handleOperatorRequest(
      new Request("https://operator.test/api/operator/v1/customers", {
        headers: {
          "Cf-Access-Jwt-Assertion": await accessToken(),
          "X-Operator-Organization": "operator-access",
        },
      }),
      operatorEnv(),
      keySet,
    );
    await expect(primaryCustomers.json()).resolves.toMatchObject({
      customers: [{ external_id: "primary-customer", name: "Primary Customer" }],
      meta: { total_count: 1 },
    });

    const unscopedCustomers = await handleOperatorRequest(
      new Request("https://operator.test/api/operator/v1/customers", {
        headers: { "Cf-Access-Jwt-Assertion": await accessToken() },
      }),
      operatorEnv(),
      keySet,
    );
    expect(unscopedCustomers.status).toBe(409);
    await expect(unscopedCustomers.json()).resolves.toMatchObject({
      code: "operator_organization_required",
    });
  });

  it("allows sanitized key reads for viewers and gates key mutations to same-origin admins", async () => {
    const viewerList = await handleOperatorRequest(
      new Request("https://operator.test/api/operator/v1/api-keys", {
        headers: { "Cf-Access-Jwt-Assertion": await accessToken() },
      }),
      operatorEnv(),
      keySet,
    );
    expect(viewerList.status).toBe(200);
    await expect(viewerList.json()).resolves.toMatchObject({
      api_keys: [],
      meta: { total_count: 0 },
    });

    const viewerCreate = await operatorApiKeyRequest("POST", "/api-keys", {
      api_key: { name: "Operator-created" },
    });
    expect(viewerCreate.status).toBe(403);
    await expect(viewerCreate.json()).resolves.toMatchObject({ code: "operator_admin_required" });

    await env.BILLING_DB.prepare(
      `UPDATE operator_memberships SET role = 'admin', version = version + 1,
         updated_at = '2026-08-16T00:01:00.000Z'
       WHERE id = 'membership-operator-access'`,
    ).run();
    const created = await operatorApiKeyRequest("POST", "/api-keys", {
      api_key: { name: "Operator-created" },
    });
    expect(created.status).toBe(200);
    const createdBody = await created.json<{
      api_key: { id: string; name: string; value: string };
    }>();
    expect(createdBody.api_key).toMatchObject({ name: "Operator-created" });
    expect(createdBody.api_key.value).toMatch(/^lago_[0-9a-f]{64}$/);

    const listed = await handleOperatorRequest(
      new Request("https://operator.test/api/operator/v1/api-keys", {
        headers: { "Cf-Access-Jwt-Assertion": await accessToken() },
      }),
      operatorEnv(),
      keySet,
    );
    const listedBody = await listed.json<{
      api_keys: Array<{ id: string; value: string }>;
    }>();
    expect(listedBody.api_keys.find((key) => key.id === createdBody.api_key.id)).toEqual({
      id: createdBody.api_key.id,
      value: `••••••••${createdBody.api_key.value.slice(-3)}`,
      name: "Operator-created",
      permissions: {},
      created_at: expect.any(String),
      expires_at: null,
      revoked_at: null,
      last_used_at: null,
      version: 1,
    });
    expect(JSON.stringify(listedBody)).not.toContain(createdBody.api_key.value);
  });

  it("maps admin rename, rotate, show, and revoke without revealing an existing secret", async () => {
    await promoteOperatorAdmin();
    const backup = await operatorApiKeyRequest("POST", "/api-keys", {
      api_key: { name: "Backup" },
    });
    expect(backup.status).toBe(200);

    const created = await operatorApiKeyRequest("POST", "/api-keys", {
      api_key: { name: "Before" },
    });
    const createdBody = await created.json<{ api_key: { id: string; value: string } }>();

    const updated = await operatorApiKeyRequest("PUT", `/api-keys/${createdBody.api_key.id}`, {
      api_key: { name: "After" },
    });
    expect(updated.status).toBe(200);
    await expect(updated.json()).resolves.toMatchObject({
      api_key: { id: createdBody.api_key.id, name: "After", version: 2 },
    });

    const rotated = await operatorApiKeyRequest(
      "POST",
      `/api-keys/${createdBody.api_key.id}/rotate`,
      { api_key: { name: "Rotated" } },
    );
    expect(rotated.status).toBe(200);
    const rotatedBody = await rotated.json<{ api_key: { id: string; value: string } }>();
    expect(rotatedBody.api_key.id).not.toBe(createdBody.api_key.id);
    expect(rotatedBody.api_key.value).toMatch(/^lago_[0-9a-f]{64}$/);

    const shown = await handleOperatorRequest(
      new Request(`https://operator.test/api/operator/v1/api-keys/${createdBody.api_key.id}`, {
        headers: { "Cf-Access-Jwt-Assertion": await accessToken() },
      }),
      operatorEnv(),
      keySet,
    );
    expect(shown.status).toBe(200);
    const shownText = await shown.text();
    expect(shownText).toContain(`••••••••${createdBody.api_key.value.slice(-3)}`);
    expect(shownText).not.toContain(createdBody.api_key.value);

    const revoked = await operatorApiKeyRequest("DELETE", `/api-keys/${rotatedBody.api_key.id}`);
    expect(revoked.status).toBe(200);
    await expect(revoked.json()).resolves.toMatchObject({
      api_key: { id: rotatedBody.api_key.id, revoked_at: expect.any(String) },
    });
  });

  it("maps invoice custom-section reads for viewers and lifecycle mutations for admins", async () => {
    const viewerList = await handleOperatorRequest(
      new Request("https://operator.test/api/operator/v1/invoice-custom-sections", {
        headers: { "Cf-Access-Jwt-Assertion": await accessToken() },
      }),
      operatorEnv(),
      keySet,
    );
    expect(viewerList.status).toBe(200);
    await expect(viewerList.json()).resolves.toMatchObject({
      invoice_custom_sections: [],
      meta: { total_count: 0 },
    });

    const viewerCreate = await operatorMutation("POST", "/invoice-custom-sections", {
      invoice_custom_section: { code: "terms", name: "Terms" },
    });
    expect(viewerCreate.status).toBe(403);
    await expect(viewerCreate.json()).resolves.toMatchObject({ code: "operator_admin_required" });

    await promoteOperatorAdmin();
    const created = await operatorMutation("POST", "/invoice-custom-sections", {
      invoice_custom_section: {
        code: "terms",
        name: "Payment terms",
        description: "Shown on invoices",
        details: "Due on receipt",
        display_name: "Terms",
      },
    });
    expect(created.status).toBe(200);
    await expect(created.json()).resolves.toMatchObject({
      invoice_custom_section: {
        code: "terms",
        name: "Payment terms",
        details: "Due on receipt",
      },
    });

    const updated = await operatorMutation("PUT", "/invoice-custom-sections/terms", {
      invoice_custom_section: { name: "Updated terms", details: "Net 15" },
    });
    expect(updated.status).toBe(200);
    await expect(updated.json()).resolves.toMatchObject({
      invoice_custom_section: { code: "terms", name: "Updated terms", details: "Net 15" },
    });

    const terminated = await operatorMutation("DELETE", "/invoice-custom-sections/terms");
    expect(terminated.status).toBe(200);
    const empty = await handleOperatorRequest(
      new Request("https://operator.test/api/operator/v1/invoice-custom-sections", {
        headers: { "Cf-Access-Jwt-Assertion": await accessToken() },
      }),
      operatorEnv(),
      keySet,
    );
    await expect(empty.json()).resolves.toMatchObject({ meta: { total_count: 0 } });
  });

  it("maps the single billing entity for viewers and gates updates to same-origin admins", async () => {
    const viewerShow = await handleOperatorRequest(
      new Request("https://operator.test/api/operator/v1/billing-entities/default", {
        headers: { "Cf-Access-Jwt-Assertion": await accessToken() },
      }),
      operatorEnv(),
      keySet,
    );
    expect(viewerShow.status).toBe(200);
    await expect(viewerShow.json()).resolves.toMatchObject({
      billing_entity: {
        lago_id: "org-operator-access",
        code: "default",
        name: "Operator Access",
        default_currency: "USD",
        is_default: true,
        version: 1,
      },
    });

    const viewerUpdate = await operatorMutation("PUT", "/billing-entities/default", {
      billing_entity: { timezone: "Pacific/Fiji" },
    });
    expect(viewerUpdate.status).toBe(403);
    await expect(viewerUpdate.json()).resolves.toMatchObject({
      code: "operator_admin_required",
    });

    await promoteOperatorAdmin();
    const updated = await operatorMutation("PUT", "/billing-entities/default", {
      billing_entity: {
        name: "Operator Billing",
        default_currency: "nzd",
        country: "nz",
        email: "BILLING@EXAMPLE.INVALID",
        timezone: "Pacific/Auckland",
        net_payment_term: 14,
        document_numbering: "per_customer",
        document_number_prefix: "op",
        finalize_zero_amount_invoice: true,
        billing_configuration: {
          invoice_footer: "Synthetic operator footer",
          invoice_grace_period: 2,
          document_locale: "en",
        },
      },
    });
    expect(updated.status).toBe(200);
    await expect(updated.json()).resolves.toMatchObject({
      billing_entity: {
        name: "Operator Billing",
        default_currency: "NZD",
        country: "NZ",
        email: "billing@example.invalid",
        timezone: "Pacific/Auckland",
        net_payment_term: 14,
        document_numbering: "per_customer",
        document_number_prefix: "OP",
        finalize_zero_amount_invoice: true,
        invoice_footer: "Synthetic operator footer",
        invoice_grace_period: 2,
        document_locale: "en",
        version: 2,
      },
    });

    const event = await env.BILLING_DB.prepare(
      `SELECT payload_json FROM outbox_events
       WHERE organization_id = 'org-operator-access' AND aggregate_type = 'billing_entity'`,
    ).first<{ payload_json: string }>();
    expect(event?.payload_json).toContain("default_currency");
    expect(event?.payload_json).not.toContain("billing@example.invalid");
    expect(event?.payload_json).not.toContain("Synthetic operator footer");

    const unsupported = await operatorMutation("PUT", "/billing-entities/default", {
      billing_entity: { einvoicing: true },
    });
    expect(unsupported.status).toBe(422);
    await expect(unsupported.json()).resolves.toMatchObject({
      code: "unsupported_billing_entity_feature",
    });
  });

  it("maps payment-receipt reads without exposing document or email actions", async () => {
    const now = "2026-08-16T00:02:00.000Z";
    await env.BILLING_DB.batch([
      env.BILLING_DB.prepare(
        `INSERT INTO customers
         (id, organization_id, external_id, name, currency, metadata_json, version,
          created_at, updated_at)
         VALUES ('customer-operator-receipt', 'org-operator-access', 'operator-customer',
                 'Operator Customer', 'USD', '{}', 1, ?, ?)`,
      ).bind(now, now),
      env.BILLING_DB.prepare(
        `INSERT INTO invoices
         (id, organization_id, customer_id, number, status, payment_status, currency,
          subtotal_minor, tax_minor, credits_minor, total_due_minor, version, payment_overdue,
          finalized_at, created_at, updated_at)
         VALUES ('invoice-operator-receipt', 'org-operator-access', 'customer-operator-receipt',
                 'INV-OPERATOR', 'finalized', 'succeeded', 'USD', 1250, 0, 0, 1250, 1, 0,
                 ?, ?, ?)`,
      ).bind(now, now, now),
      env.BILLING_DB.prepare(
        `INSERT INTO payment_attempts
         (id, organization_id, invoice_id, provider, provider_account_code,
          provider_transaction_id, idempotency_key, amount_minor, currency, status,
          payment_type, version, created_at, updated_at)
         VALUES ('payment-operator-receipt', 'org-operator-access', 'invoice-operator-receipt',
                 'manual', 'manual', NULL, 'operator-receipt', 1250, 'USD', 'succeeded',
                 'manual', 1, ?, ?)`,
      ).bind(now, now),
      env.BILLING_DB.prepare(
        `UPDATE payment_receipts SET file_url = 'https://files.invalid/receipt.pdf'
         WHERE payment_id = 'payment-operator-receipt'`,
      ),
    ]);

    const list = await handleOperatorRequest(
      new Request("https://operator.test/api/operator/v1/payment-receipts", {
        headers: { "Cf-Access-Jwt-Assertion": await accessToken() },
      }),
      operatorEnv(),
      keySet,
    );
    expect(list.status).toBe(200);
    await expect(list.json()).resolves.toMatchObject({
      payment_receipts: [
        {
          lago_id: "payment-receipt:payment-operator-receipt",
          number: "operator-customer-RCPT-000001",
          file_url: null,
          xml_url: null,
          payment: {
            external_customer_id: "operator-customer",
            invoice_numbers: ["INV-OPERATOR"],
            amount_cents: 1250,
            amount_currency: "USD",
          },
        },
      ],
      meta: { total_count: 1 },
    });

    const shown = await handleOperatorRequest(
      new Request(
        "https://operator.test/api/operator/v1/payment-receipts/payment-receipt%3Apayment-operator-receipt",
        { headers: { "Cf-Access-Jwt-Assertion": await accessToken() } },
      ),
      operatorEnv(),
      keySet,
    );
    await expect(shown.json()).resolves.toMatchObject({
      payment_receipt: {
        lago_id: "payment-receipt:payment-operator-receipt",
        file_url: null,
      },
    });

    const blocked = await operatorMutation(
      "POST",
      "/payment-receipts/payment-receipt%3Apayment-operator-receipt/resend_email",
      {},
    );
    expect(blocked.status).toBe(405);
    await expect(blocked.json()).resolves.toMatchObject({
      code: "operator_payment_receipts_read_only",
    });
  });

  it("maps manual-tax reads for viewers and lifecycle mutations for admins", async () => {
    const viewerList = await handleOperatorRequest(
      new Request("https://operator.test/api/operator/v1/taxes", {
        headers: { "Cf-Access-Jwt-Assertion": await accessToken() },
      }),
      operatorEnv(),
      keySet,
    );
    await expect(viewerList.json()).resolves.toMatchObject({ taxes: [], meta: { total_count: 0 } });

    const viewerCreate = await operatorMutation("POST", "/taxes", {
      tax: { code: "vat", name: "VAT", rate: 15 },
    });
    expect(viewerCreate.status).toBe(403);

    await promoteOperatorAdmin();
    const created = await operatorMutation("POST", "/taxes", {
      tax: {
        code: "vat",
        name: "VAT",
        description: "Synthetic operator tax",
        rate: 15,
        applied_to_organization: true,
      },
    });
    expect(created.status).toBe(200);
    await expect(created.json()).resolves.toMatchObject({
      tax: { code: "vat", name: "VAT", rate: 15, applied_to_organization: true },
    });

    const updated = await operatorMutation("PUT", "/taxes/vat", {
      tax: { code: "gst", name: "GST", rate: "12.5" },
    });
    expect(updated.status).toBe(200);
    await expect(updated.json()).resolves.toMatchObject({
      tax: { code: "gst", name: "GST", rate: 12.5, applied_to_organization: true },
    });

    const terminated = await operatorMutation("DELETE", "/taxes/gst");
    expect(terminated.status).toBe(200);
    const empty = await handleOperatorRequest(
      new Request("https://operator.test/api/operator/v1/taxes", {
        headers: { "Cf-Access-Jwt-Assertion": await accessToken() },
      }),
      operatorEnv(),
      keySet,
    );
    await expect(empty.json()).resolves.toMatchObject({ taxes: [], meta: { total_count: 0 } });
  });

  it("maps add-on reads for viewers and lifecycle mutations for admins", async () => {
    const viewerList = await handleOperatorRequest(
      new Request("https://operator.test/api/operator/v1/add-ons", {
        headers: { "Cf-Access-Jwt-Assertion": await accessToken() },
      }),
      operatorEnv(),
      keySet,
    );
    await expect(viewerList.json()).resolves.toMatchObject({
      add_ons: [],
      meta: { total_count: 0 },
    });

    const viewerCreate = await operatorMutation("POST", "/add-ons", {
      add_on: { code: "support", name: "Support", amount_cents: 2500, amount_currency: "USD" },
    });
    expect(viewerCreate.status).toBe(403);

    await promoteOperatorAdmin();
    const created = await operatorMutation("POST", "/add-ons", {
      add_on: {
        code: "support",
        name: "Support",
        invoice_display_name: "Priority support",
        description: "Synthetic operator add-on",
        amount_cents: 2500,
        amount_currency: "usd",
      },
    });
    expect(created.status).toBe(200);
    await expect(created.json()).resolves.toMatchObject({
      add_on: {
        code: "support",
        name: "Support",
        amount_cents: 2500,
        amount_currency: "USD",
      },
    });

    const updated = await operatorMutation("PUT", "/add-ons/support", {
      add_on: { code: "priority", name: "Priority support", amount_cents: 3000 },
    });
    expect(updated.status).toBe(200);
    await expect(updated.json()).resolves.toMatchObject({
      add_on: { code: "priority", name: "Priority support", amount_cents: 3000 },
    });

    const tax = await operatorMutation("POST", "/taxes", {
      tax: { code: "vat", name: "VAT", rate: 20, applied_to_organization: false },
    });
    expect(tax.status).toBe(200);
    const taxed = await operatorMutation("PUT", "/add-ons/priority", {
      add_on: { tax_codes: ["vat"] },
    });
    expect(taxed.status).toBe(200);
    await expect(taxed.json()).resolves.toMatchObject({
      add_on: { taxes: [{ code: "vat", rate: 20 }] },
    });

    const terminated = await operatorMutation("DELETE", "/add-ons/priority");
    expect(terminated.status).toBe(200);
    const empty = await handleOperatorRequest(
      new Request("https://operator.test/api/operator/v1/add-ons", {
        headers: { "Cf-Access-Jwt-Assertion": await accessToken() },
      }),
      operatorEnv(),
      keySet,
    );
    await expect(empty.json()).resolves.toMatchObject({ add_ons: [], meta: { total_count: 0 } });
  });

  it("maps the complete coupon catalog and customer-application workflow", async () => {
    const viewerList = await handleOperatorRequest(
      new Request("https://operator.test/api/operator/v1/coupons", {
        headers: { "Cf-Access-Jwt-Assertion": await accessToken() },
      }),
      operatorEnv(),
      keySet,
    );
    await expect(viewerList.json()).resolves.toMatchObject({
      coupons: [],
      meta: { total_count: 0 },
    });

    const viewerCreate = await operatorMutation("POST", "/coupons", {
      coupon: {
        code: "welcome",
        name: "Welcome",
        coupon_type: "percentage",
        percentage_rate: "10",
        frequency: "once",
      },
    });
    expect(viewerCreate.status).toBe(403);

    await promoteOperatorAdmin();
    await operatorMutation("POST", "/customers", {
      customer: {
        external_id: "coupon-customer",
        name: "Coupon Customer",
        currency: "usd",
      },
    });
    const created = await operatorMutation("POST", "/coupons", {
      coupon: {
        code: "welcome",
        name: "Welcome",
        description: "Synthetic operator coupon",
        coupon_type: "percentage",
        percentage_rate: "10",
        frequency: "recurring",
        frequency_duration: 2,
        expiration: "no_expiration",
        reusable: false,
      },
    });
    expect(created.status).toBe(200);
    await expect(created.json()).resolves.toMatchObject({
      coupon: {
        code: "welcome",
        percentage_rate: "10",
        frequency: "recurring",
        frequency_duration: 2,
        reusable: false,
      },
    });

    const targetPlan = await operatorMutation("POST", "/plans", {
      plan: {
        code: "targeted-plan",
        name: "Targeted plan",
        interval: "monthly",
        amount_cents: 1000,
        amount_currency: "USD",
      },
    });
    expect(targetPlan.status).toBe(200);
    const targeted = await operatorMutation("POST", "/coupons", {
      coupon: {
        code: "targeted",
        name: "Targeted",
        coupon_type: "percentage",
        percentage_rate: "10",
        frequency: "once",
        applies_to: { plan_codes: ["targeted-plan"] },
      },
    });
    expect(targeted.status).toBe(200);
    await expect(targeted.json()).resolves.toMatchObject({
      coupon: { limited_plans: true, plan_codes: ["targeted-plan"] },
    });

    const applied = await operatorMutation("POST", "/applied-coupons", {
      applied_coupon: {
        external_customer_id: "coupon-customer",
        coupon_code: "welcome",
      },
    });
    expect(applied.status).toBe(200);
    const appliedBody = await applied.json<{ applied_coupon: { lago_id: string } }>();
    expect(appliedBody.applied_coupon).toMatchObject({
      coupon_code: "welcome",
      external_customer_id: "coupon-customer",
      status: "active",
    });

    const listed = await handleOperatorRequest(
      new Request("https://operator.test/api/operator/v1/applied-coupons?status=active", {
        headers: { "Cf-Access-Jwt-Assertion": await accessToken() },
      }),
      operatorEnv(),
      keySet,
    );
    await expect(listed.json()).resolves.toMatchObject({
      applied_coupons: [{ lago_id: appliedBody.applied_coupon.lago_id }],
      meta: { total_count: 1 },
    });

    const terminated = await operatorMutation(
      "DELETE",
      `/customers/coupon-customer/applied-coupons/${encodeURIComponent(appliedBody.applied_coupon.lago_id)}`,
    );
    expect(terminated.status).toBe(200);
    await expect(terminated.json()).resolves.toMatchObject({
      applied_coupon: { status: "terminated" },
    });
  });

  it("maps core plan lifecycle and nested fixed-charge lifecycle without admitting usage graphs", async () => {
    const viewerList = await handleOperatorRequest(
      new Request("https://operator.test/api/operator/v1/plans", {
        headers: { "Cf-Access-Jwt-Assertion": await accessToken() },
      }),
      operatorEnv(),
      keySet,
    );
    await expect(viewerList.json()).resolves.toMatchObject({
      plans: [],
      meta: { total_count: 0 },
    });
    expect(
      (
        await operatorMutation("POST", "/plans", {
          plan: {
            code: "operator-plan",
            name: "Operator Plan",
            interval: "monthly",
            amount_cents: 1000,
            amount_currency: "USD",
          },
        })
      ).status,
    ).toBe(403);

    await promoteOperatorAdmin();
    const addOn = await operatorMutation("POST", "/add-ons", {
      add_on: {
        code: "operator-seat",
        name: "Operator Seat",
        amount_cents: 250,
        amount_currency: "USD",
      },
    });
    const addOnId = (await addOn.json<{ add_on: { lago_id: string } }>()).add_on.lago_id;
    const created = await operatorMutation("POST", "/plans", {
      plan: {
        code: "operator-plan",
        name: "Operator Plan",
        invoice_display_name: "Operator plan invoice",
        description: "Synthetic operator plan",
        interval: "monthly",
        amount_cents: 1000,
        amount_currency: "usd",
        trial_period: 7,
        pay_in_advance: true,
      },
    });
    expect(created.status).toBe(200);
    await expect(created.json()).resolves.toMatchObject({
      plan: {
        code: "operator-plan",
        amount_cents: 1000,
        amount_currency: "USD",
        trial_period: 7,
        pay_in_advance: true,
      },
    });

    const blockedGraph = await operatorMutation("PUT", "/plans/operator-plan", {
      plan: { charges: [] },
    });
    expect(blockedGraph.status).toBe(422);
    await expect(blockedGraph.json()).resolves.toMatchObject({
      code: "unsupported_operator_plan_field",
    });

    const fixed = await operatorMutation("POST", "/plans/operator-plan/fixed-charges", {
      fixed_charge: {
        add_on_id: addOnId,
        code: "seat-charge",
        invoice_display_name: "Seats",
        charge_model: "standard",
        properties: { amount: "250" },
        units: "2",
      },
    });
    expect(fixed.status).toBe(200);
    await expect(fixed.json()).resolves.toMatchObject({
      fixed_charge: { code: "seat-charge", add_on_code: "operator-seat", units: "2" },
    });
    const fixedList = await handleOperatorRequest(
      new Request("https://operator.test/api/operator/v1/plans/operator-plan/fixed-charges", {
        headers: { "Cf-Access-Jwt-Assertion": await accessToken() },
      }),
      operatorEnv(),
      keySet,
    );
    await expect(fixedList.json()).resolves.toMatchObject({
      fixed_charges: [{ code: "seat-charge" }],
      meta: { total_count: 1 },
    });
    const fixedUpdated = await operatorMutation(
      "PUT",
      "/plans/operator-plan/fixed-charges/seat-charge",
      { fixed_charge: { invoice_display_name: "Updated seats", units: "3" } },
    );
    await expect(fixedUpdated.json()).resolves.toMatchObject({
      fixed_charge: { code: "seat-charge", invoice_display_name: "Updated seats", units: "3" },
    });
    expect(
      (
        await operatorMutation("DELETE", "/plans/operator-plan/fixed-charges/seat-charge", {
          fixed_charge: { cascade_updates: false },
        })
      ).status,
    ).toBe(200);

    const updated = await operatorMutation("PUT", "/plans/operator-plan", {
      plan: { code: "operator-plan-v2", name: "Operator Plan v2", amount_cents: 1250 },
    });
    await expect(updated.json()).resolves.toMatchObject({
      plan: { code: "operator-plan-v2", name: "Operator Plan v2", amount_cents: 1250 },
    });
    const deleted = await operatorMutation("DELETE", "/plans/operator-plan-v2");
    expect(deleted.status).toBe(200);
    const empty = await handleOperatorRequest(
      new Request("https://operator.test/api/operator/v1/plans", {
        headers: { "Cf-Access-Jwt-Assertion": await accessToken() },
      }),
      operatorEnv(),
      keySet,
    );
    await expect(empty.json()).resolves.toMatchObject({ plans: [], meta: { total_count: 0 } });
  });

  it("maps subscription creation, plan changes, safe updates, and termination", async () => {
    const viewerList = await handleOperatorRequest(
      new Request("https://operator.test/api/operator/v1/subscriptions", {
        headers: { "Cf-Access-Jwt-Assertion": await accessToken() },
      }),
      operatorEnv(),
      keySet,
    );
    await expect(viewerList.json()).resolves.toMatchObject({
      subscriptions: [],
      meta: { total_count: 0 },
    });
    expect(
      (
        await operatorMutation("POST", "/subscriptions", {
          subscription: {
            external_customer_id: "subscriber",
            external_id: "operator-subscription",
            plan_code: "starter",
          },
        })
      ).status,
    ).toBe(403);

    await promoteOperatorAdmin();
    await operatorMutation("POST", "/customers", {
      customer: { external_id: "subscriber", name: "Subscriber", currency: "USD" },
    });
    for (const [code, amount] of [
      ["starter", 1000],
      ["growth", 1500],
    ] as const) {
      await operatorMutation("POST", "/plans", {
        plan: {
          code,
          name: code,
          interval: "monthly",
          amount_cents: amount,
          amount_currency: "USD",
        },
      });
    }
    const created = await operatorMutation("POST", "/subscriptions", {
      subscription: {
        external_customer_id: "subscriber",
        external_id: "operator-subscription",
        plan_code: "starter",
        name: "Starter subscription",
        billing_time: "anniversary",
        subscription_at: "2027-08-16T00:00:00.000Z",
        on_termination_invoice: "skip",
      },
    });
    expect(created.status).toBe(200);
    await expect(created.json()).resolves.toMatchObject({
      subscription: {
        external_id: "operator-subscription",
        external_customer_id: "subscriber",
        plan_code: "starter",
        status: "pending",
      },
    });

    const blockedProvider = await operatorMutation("PUT", "/subscriptions/operator-subscription", {
      subscription: { payment_method: { type: "provider", id: "unsafe" } },
    });
    expect(blockedProvider.status).toBe(422);
    await expect(blockedProvider.json()).resolves.toMatchObject({
      code: "unsupported_operator_subscription_field",
    });

    const renamed = await operatorMutation("PUT", "/subscriptions/operator-subscription", {
      subscription: { name: "Renamed subscription", on_termination_invoice: "skip" },
    });
    await expect(renamed.json()).resolves.toMatchObject({
      subscription: { name: "Renamed subscription", plan_code: "starter" },
    });

    const changed = await operatorMutation("POST", "/subscriptions", {
      subscription: {
        external_customer_id: "subscriber",
        external_id: "operator-subscription",
        plan_code: "growth",
        name: "Growth subscription",
        billing_time: "anniversary",
        subscription_at: "2027-08-16T00:00:00.000Z",
        on_termination_invoice: "skip",
      },
    });
    expect(changed.status).toBe(200);
    await expect(changed.json()).resolves.toMatchObject({
      subscription: { external_id: "operator-subscription", plan_code: "growth" },
    });

    const terminated = await operatorMutation(
      "DELETE",
      "/subscriptions/operator-subscription?on_termination_invoice=skip",
    );
    expect(terminated.status).toBe(200);
    await expect(terminated.json()).resolves.toMatchObject({
      subscription: { status: "canceled" },
    });
  });

  it("maps invoice reads and the one-off create and void lifecycle", async () => {
    const viewerList = await handleOperatorRequest(
      new Request("https://operator.test/api/operator/v1/invoices", {
        headers: { "Cf-Access-Jwt-Assertion": await accessToken() },
      }),
      operatorEnv(),
      keySet,
    );
    await expect(viewerList.json()).resolves.toMatchObject({
      invoices: [],
      meta: { total_count: 0 },
    });
    expect(
      (
        await operatorMutation("POST", "/invoices", {
          invoice: {
            external_customer_id: "invoice-customer",
            currency: "USD",
            skip_psp: true,
            fees: [{ add_on_code: "support" }],
          },
        })
      ).status,
    ).toBe(403);

    await promoteOperatorAdmin();
    await operatorMutation("POST", "/customers", {
      customer: { external_id: "invoice-customer", name: "Invoice Customer", currency: "USD" },
    });
    await operatorMutation("POST", "/add-ons", {
      add_on: { code: "support", name: "Support", amount_cents: 500, amount_currency: "USD" },
    });
    const blockedTarget = await operatorMutation("POST", "/invoices", {
      invoice: {
        external_customer_id: "invoice-customer",
        currency: "USD",
        skip_psp: true,
        fees: [{ add_on_code: "support", tax_codes: ["vat"] }],
      },
    });
    expect(blockedTarget.status).toBe(422);
    await expect(blockedTarget.json()).resolves.toMatchObject({
      code: "unsupported_operator_invoice_fee_field",
    });

    const created = await operatorMutation("POST", "/invoices", {
      invoice: {
        external_customer_id: "invoice-customer",
        currency: "usd",
        skip_psp: true,
        fees: [
          {
            add_on_code: "support",
            invoice_display_name: "Priority support",
            unit_amount_cents: 750,
            units: 2,
            description: "Synthetic operator fee",
          },
        ],
      },
    });
    expect(created.status).toBe(200);
    const createdBody = await created.json<{
      invoice: { lago_id: string; total_amount_cents: number };
    }>();
    expect(createdBody.invoice.total_amount_cents).toBe(1500);
    const shown = await handleOperatorRequest(
      new Request(
        `https://operator.test/api/operator/v1/invoices/${encodeURIComponent(createdBody.invoice.lago_id)}`,
        { headers: { "Cf-Access-Jwt-Assertion": await accessToken() } },
      ),
      operatorEnv(),
      keySet,
    );
    await expect(shown.json()).resolves.toMatchObject({
      invoice: {
        lago_id: createdBody.invoice.lago_id,
        invoice_type: "one_off",
        status: "finalized",
        fees: [{ item: { code: "support" } }],
      },
    });
    await env.BILLING_DB.prepare("UPDATE invoices SET payment_status = 'succeeded' WHERE id = ?")
      .bind(createdBody.invoice.lago_id)
      .run();

    const voided = await operatorMutation(
      "POST",
      `/invoices/${encodeURIComponent(createdBody.invoice.lago_id)}/void`,
      {},
    );
    expect(voided.status).toBe(200);
    await expect(voided.json()).resolves.toMatchObject({
      invoice: { status: "voided", payment_status: "succeeded" },
    });
  });

  it("maps core granted-credit wallet reads, creation, top-up, and termination", async () => {
    const viewerList = await handleOperatorRequest(
      new Request("https://operator.test/api/operator/v1/wallets", {
        headers: { "Cf-Access-Jwt-Assertion": await accessToken() },
      }),
      operatorEnv(),
      keySet,
    );
    await expect(viewerList.json()).resolves.toMatchObject({
      wallets: [],
      meta: { total_count: 0 },
    });
    expect(
      (
        await operatorMutation("POST", "/wallets", {
          wallet: {
            external_customer_id: "wallet-customer",
            code: "operator-wallet",
            currency: "USD",
            rate_amount: "1",
            granted_credits: "10",
          },
        })
      ).status,
    ).toBe(403);

    await promoteOperatorAdmin();
    await operatorMutation("POST", "/customers", {
      customer: { external_id: "wallet-customer", name: "Wallet Customer", currency: "USD" },
    });
    const recurring = await operatorMutation("POST", "/wallets", {
      wallet: {
        external_customer_id: "wallet-customer",
        code: "blocked-wallet",
        currency: "USD",
        rate_amount: "1",
        recurring_transaction_rules: [{ interval: "monthly", granted_credits: "10" }],
      },
    });
    expect(recurring.status).toBe(200);
    await expect(recurring.json()).resolves.toMatchObject({
      wallet: {
        recurring_transaction_rules: [
          { interval: "monthly", paid_credits: "0", granted_credits: "10" },
        ],
      },
    });

    const created = await operatorMutation("POST", "/wallets", {
      wallet: {
        external_customer_id: "wallet-customer",
        name: "Operator wallet",
        code: "operator-wallet",
        currency: "USD",
        rate_amount: "1",
        granted_credits: "10",
        priority: 20,
      },
    });
    expect(created.status).toBe(200);
    const createdBody = await created.json<{ wallet: { lago_id: string } }>();
    await expect(
      handleOperatorRequest(
        new Request(
          `https://operator.test/api/operator/v1/wallets/${encodeURIComponent(createdBody.wallet.lago_id)}/wallet_transactions`,
          { headers: { "Cf-Access-Jwt-Assertion": await accessToken() } },
        ),
        operatorEnv(),
        keySet,
      ).then((response) => response.json()),
    ).resolves.toMatchObject({ wallet_transactions: [{ credit_amount: "10" }] });

    const toppedUp = await operatorMutation(
      "POST",
      "/wallet-transactions",
      { wallet_transaction: { wallet_id: createdBody.wallet.lago_id, granted_credits: "5" } },
      { "Idempotency-Key": "operator-wallet-top-up" },
    );
    expect(toppedUp.status).toBe(200);
    await expect(toppedUp.json()).resolves.toMatchObject({
      wallet_transactions: [{ credit_amount: "5", transaction_status: "granted" }],
    });

    const terminated = await operatorMutation(
      "DELETE",
      `/wallets/${encodeURIComponent(createdBody.wallet.lago_id)}`,
    );
    expect(terminated.status).toBe(200);
    await expect(terminated.json()).resolves.toMatchObject({ wallet: { status: "terminated" } });
  });

  it("maps internal credit note reads, creation, and unconsumed voiding", async () => {
    const viewerList = await handleOperatorRequest(
      new Request("https://operator.test/api/operator/v1/credit-notes", {
        headers: { "Cf-Access-Jwt-Assertion": await accessToken() },
      }),
      operatorEnv(),
      keySet,
    );
    await expect(viewerList.json()).resolves.toMatchObject({
      credit_notes: [],
      meta: { total_count: 0 },
    });
    await promoteOperatorAdmin();
    await operatorMutation("POST", "/customers", {
      customer: { external_id: "credit-customer", name: "Credit Customer", currency: "USD" },
    });
    await operatorMutation("POST", "/add-ons", {
      add_on: {
        code: "credit-source",
        name: "Credit source",
        amount_cents: 900,
        amount_currency: "USD",
      },
    });
    const invoice = await operatorMutation("POST", "/invoices", {
      invoice: {
        external_customer_id: "credit-customer",
        currency: "USD",
        skip_psp: true,
        fees: [{ add_on_code: "credit-source" }],
      },
    }).then((response) =>
      response.json<{ invoice: { lago_id: string; fees: Array<{ lago_id: string }> } }>(),
    );
    await expect(
      operatorMutation(
        "POST",
        "/credit-notes",
        {
          credit_note: {
            invoice_id: invoice.invoice.lago_id,
            credit_amount_cents: 300,
            refund_amount_cents: 100,
            offset_amount_cents: 0,
            items: [{ fee_id: invoice.invoice.fees[0]!.lago_id, amount_cents: 400 }],
          },
        },
        { "Idempotency-Key": "blocked-credit-refund" },
      ),
    ).rejects.toMatchObject({ status: 503, code: "credit_note_refunds_disabled" });

    const created = await operatorMutation(
      "POST",
      "/credit-notes",
      {
        credit_note: {
          invoice_id: invoice.invoice.lago_id,
          reason: "order_change",
          description: "Synthetic operator credit",
          credit_amount_cents: 400,
          items: [{ fee_id: invoice.invoice.fees[0]!.lago_id, amount_cents: 400 }],
        },
      },
      { "Idempotency-Key": "operator-credit-note" },
    );
    expect(created.status).toBe(200);
    const createdBody = await created.json<{ credit_note: { lago_id: string } }>();
    await expect(createdBody).toMatchObject({
      credit_note: { credit_status: "available", total_amount_cents: 400 },
    });
    const voided = await operatorMutation(
      "PUT",
      `/credit-notes/${encodeURIComponent(createdBody.credit_note.lago_id)}/void`,
    );
    expect(voided.status).toBe(200);
    await expect(voided.json()).resolves.toMatchObject({
      credit_note: { credit_status: "voided", balance_amount_cents: 0 },
    });

    const offset = await operatorMutation(
      "POST",
      "/credit-notes",
      {
        credit_note: {
          invoice_id: invoice.invoice.lago_id,
          reason: "order_change",
          credit_amount_cents: 0,
          offset_amount_cents: 100,
          refund_amount_cents: 0,
          items: [{ fee_id: invoice.invoice.fees[0]!.lago_id, amount_cents: 100 }],
        },
      },
      { "Idempotency-Key": "operator-credit-note-offset" },
    );
    expect(offset.status).toBe(200);
    await expect(offset.json()).resolves.toMatchObject({
      credit_note: {
        credit_status: "consumed",
        credit_amount_cents: 0,
        offset_amount_cents: 100,
        refund_amount_cents: 0,
      },
    });
  });

  it("maps payment settlement reads without admitting payment mutations", async () => {
    const empty = await handleOperatorRequest(
      new Request("https://operator.test/api/operator/v1/payments", {
        headers: { "Cf-Access-Jwt-Assertion": await accessToken() },
      }),
      operatorEnv(),
      keySet,
    );
    await expect(empty.json()).resolves.toMatchObject({ payments: [], meta: { total_count: 0 } });
    const mutation = await operatorMutation("POST", "/payments", {
      payment: { invoice_id: "unsafe", amount_cents: 1 },
    });
    expect(mutation.status).toBe(405);
    await expect(mutation.json()).resolves.toMatchObject({ code: "operator_payments_read_only" });
  });

  it("maps quote draft editing and approval without inventing document actions", async () => {
    const viewerList = await handleOperatorRequest(
      new Request("https://operator.test/api/operator/v1/quotes", {
        headers: { "Cf-Access-Jwt-Assertion": await accessToken() },
      }),
      operatorEnv(),
      keySet,
    );
    await expect(viewerList.json()).resolves.toMatchObject({
      quotes: [],
      meta: { total_count: 0 },
    });
    await promoteOperatorAdmin();
    const customer = await operatorMutation("POST", "/customers", {
      customer: { external_id: "quote-customer", name: "Quote Customer", currency: "USD" },
    }).then((response) => response.json<{ customer: { lago_id: string } }>());
    const created = await operatorMutation(
      "POST",
      "/quotes",
      {
        quote: {
          customer_id: customer.customer.lago_id,
          order_type: "one_off",
          owner_ids: [],
          content: "Synthetic operator quote",
          billing_items: [{ description: "Consulting", amount_cents: 1200 }],
        },
      },
      { "Idempotency-Key": "operator-quote" },
    );
    expect(created.status).toBe(200);
    const createdBody = await created.json<{
      quote: { lago_id: string; current_version: { lago_id: string; lock_version: number } };
    }>();
    const versionId = createdBody.quote.current_version.lago_id;
    const edited = await operatorMutation("PUT", `/quote-versions/${versionId}`, {
      quote_version: {
        lock_version: createdBody.quote.current_version.lock_version,
        content: "Approved synthetic quote",
      },
    });
    expect(edited.status).toBe(200);
    const approved = await operatorMutation("POST", `/quote-versions/${versionId}/approve`);
    expect(approved.status).toBe(200);
    await expect(approved.json()).resolves.toMatchObject({
      quote_version: { status: "approved", content: "Approved synthetic quote" },
    });
    const blockedDocument = await operatorMutation("POST", `/quote-versions/${versionId}/download`);
    expect(blockedDocument.status).toBe(422);
    await expect(blockedDocument.json()).resolves.toMatchObject({
      code: "unsupported_operator_quote_action",
    });
  });

  it("maps data-export creation and status without exposing artifact delivery", async () => {
    const viewerList = await handleOperatorRequest(
      new Request("https://operator.test/api/operator/v1/data-exports", {
        headers: { "Cf-Access-Jwt-Assertion": await accessToken() },
      }),
      operatorEnv(),
      keySet,
    );
    await expect(viewerList.json()).resolves.toMatchObject({
      data_exports: [],
      meta: { total_count: 0 },
    });
    await promoteOperatorAdmin();
    const created = await operatorMutation(
      "POST",
      "/data-exports",
      { data_export: { format: "csv", resource_type: "invoices", filters: { currency: "USD" } } },
      { "Idempotency-Key": "operator-data-export" },
    );
    expect(created.status).toBe(200);
    const createdBody = await created.json<{ data_export: { lago_id: string } }>();
    const blockedDownload = await operatorMutation(
      "POST",
      `/data-exports/${encodeURIComponent(createdBody.data_export.lago_id)}/download`,
    );
    expect(blockedDownload.status).toBe(422);
    await expect(blockedDownload.json()).resolves.toMatchObject({
      code: "unsupported_operator_data_export_action",
    });
  });

  it("keeps webhook endpoint inspection read-only while outbound delivery is disabled", async () => {
    const list = await handleOperatorRequest(
      new Request("https://operator.test/api/operator/v1/webhook-endpoints", {
        headers: { "Cf-Access-Jwt-Assertion": await accessToken() },
      }),
      operatorEnv(),
      keySet,
    );
    await expect(list.json()).resolves.toMatchObject({
      webhook_endpoints: [],
      meta: { total_count: 0 },
    });
    await promoteOperatorAdmin();
    const mutation = await operatorMutation("POST", "/webhook-endpoints", {
      webhook_endpoint: { webhook_url: "https://hooks.example.test/operator" },
    });
    expect(mutation.status).toBe(405);
    await expect(mutation.json()).resolves.toMatchObject({
      code: "operator_webhook_endpoints_read_only",
    });
  });

  it("maps dunning campaign configuration while keeping payment requests read-only", async () => {
    const viewerCampaigns = await handleOperatorRequest(
      new Request("https://operator.test/api/operator/v1/dunning-campaigns", {
        headers: { "Cf-Access-Jwt-Assertion": await accessToken() },
      }),
      operatorEnv(),
      keySet,
    );
    await expect(viewerCampaigns.json()).resolves.toMatchObject({
      dunning_campaigns: [],
      meta: { total_count: 0 },
    });
    const viewerCreate = await operatorMutation("POST", "/dunning-campaigns", {
      dunning_campaign: {
        code: "operator-dunning",
        name: "Operator dunning",
        days_between_attempts: 3,
        max_attempts: 2,
        thresholds: [{ amount_cents: 1000, currency: "USD" }],
      },
    });
    expect(viewerCreate.status).toBe(403);

    await promoteOperatorAdmin();
    const created = await operatorMutation("POST", "/dunning-campaigns", {
      dunning_campaign: {
        code: "operator-dunning",
        name: "Operator dunning",
        days_between_attempts: 3,
        max_attempts: 2,
        applied_to_organization: true,
        thresholds: [{ amount_cents: 1000, currency: "USD" }],
      },
    });
    expect(created.status).toBe(200);
    await expect(created.json()).resolves.toMatchObject({
      dunning_campaign: {
        code: "operator-dunning",
        applied_to_organization: true,
        thresholds: [{ amount_cents: 1000, currency: "USD" }],
      },
    });

    const paymentRequests = await handleOperatorRequest(
      new Request("https://operator.test/api/operator/v1/payment-requests", {
        headers: { "Cf-Access-Jwt-Assertion": await accessToken() },
      }),
      operatorEnv(),
      keySet,
    );
    await expect(paymentRequests.json()).resolves.toMatchObject({
      payment_requests: [],
      meta: { total_count: 0 },
    });
    const blockedCollection = await operatorMutation("POST", "/payment-requests", {
      payment_request: { external_customer_id: "operator-customer", lago_invoice_ids: [] },
    });
    expect(blockedCollection.status).toBe(405);
    await expect(blockedCollection.json()).resolves.toMatchObject({
      code: "operator_payment_requests_read_only",
    });
  });

  it("maps customer reads for viewers and admits dependency-safe admin deletion", async () => {
    const viewerList = await handleOperatorRequest(
      new Request("https://operator.test/api/operator/v1/customers", {
        headers: { "Cf-Access-Jwt-Assertion": await accessToken() },
      }),
      operatorEnv(),
      keySet,
    );
    await expect(viewerList.json()).resolves.toMatchObject({
      customers: [],
      meta: { total_count: 0 },
    });

    const viewerCreate = await operatorMutation("POST", "/customers", {
      customer: { external_id: "operator-customer", name: "Operator Customer" },
    });
    expect(viewerCreate.status).toBe(403);

    await promoteOperatorAdmin();
    const created = await operatorMutation("POST", "/customers", {
      customer: {
        external_id: "operator-customer",
        name: "Operator Customer",
        email: "CUSTOMER@EXAMPLE.INVALID",
        currency: "nzd",
        timezone: "Pacific/Auckland",
      },
    });
    expect(created.status).toBe(200);
    await expect(created.json()).resolves.toMatchObject({
      customer: {
        external_id: "operator-customer",
        name: "Operator Customer",
        email: "customer@example.invalid",
        currency: "NZD",
        timezone: "Pacific/Auckland",
      },
    });

    const updated = await operatorMutation("PUT", "/customers/operator-customer", {
      customer: { name: "Updated Customer", net_payment_term: 14 },
    });
    expect(updated.status).toBe(200);
    await expect(updated.json()).resolves.toMatchObject({
      customer: {
        external_id: "operator-customer",
        name: "Updated Customer",
        net_payment_term: 14,
      },
    });

    const blockedProvider = await operatorMutation("PUT", "/customers/operator-customer", {
      customer: {
        billing_configuration: {
          payment_provider: "authorize_net",
          payment_provider_code: "authorize-net-default",
        },
      },
    });
    expect(blockedProvider.status).toBe(422);
    await expect(blockedProvider.json()).resolves.toMatchObject({
      code: "unsupported_operator_customer_field",
    });

    const deleted = await operatorMutation("DELETE", "/customers/operator-customer");
    expect(deleted.status).toBe(204);
  });
});

describe("operator parity surface routing", () => {
  it("gates feature and plan-entitlement mutations behind Access admin and CSRF checks", async () => {
    const viewerList = await handleOperatorRequest(
      new Request("https://operator.test/api/operator/v1/features", {
        headers: { "Cf-Access-Jwt-Assertion": await accessToken() },
      }),
      operatorEnv(),
      keySet,
    );
    expect(viewerList.status).toBe(200);

    const viewerCreate = await operatorMutation("POST", "/features", {
      feature: { name: "Exports", code: "exports", privileges: [] },
    });
    expect(viewerCreate.status).toBe(403);
    await expect(viewerCreate.json()).resolves.toMatchObject({ code: "operator_admin_required" });

    await promoteOperatorAdmin();
    const createdFeature = await operatorMutation("POST", "/features", {
      feature: {
        name: "Exports",
        code: "exports",
        privileges: [{ name: "Enabled", code: "enabled", value_type: "boolean" }],
      },
    });
    expect(createdFeature.status).toBe(201);
    const feature = await createdFeature.json<{
      feature: { lago_id: string; code: string };
    }>();

    const createdPlan = await operatorMutation("POST", "/plans", {
      plan: {
        code: "pro",
        name: "Pro",
        interval: "monthly",
        amount_cents: 5000,
        amount_currency: "USD",
        pay_in_advance: false,
      },
    });
    expect(createdPlan.status).toBe(200);

    const entitlements = await operatorMutation("PUT", "/plans/pro/entitlements", {
      entitlements: [
        {
          feature_code: "exports",
          privileges: [{ privilege_code: "enabled", value: true }],
        },
      ],
    });
    expect(entitlements.status).toBe(200);
    await expect(entitlements.json()).resolves.toMatchObject({
      plan_code: "pro",
      entitlements: [
        {
          feature_code: "exports",
          privileges: [{ privilege_code: "enabled", value: true }],
        },
      ],
    });

    const activity = await handleOperatorRequest(
      new Request(
        `https://operator.test/api/operator/v1/features/${feature.feature.lago_id}/activity`,
        { headers: { "Cf-Access-Jwt-Assertion": await accessToken() } },
      ),
      operatorEnv(),
      keySet,
    );
    expect(activity.status).toBe(200);
    await expect(activity.json()).resolves.toMatchObject({
      activity_logs: [{ event_type: "feature.created" }],
    });
  });
});

async function promoteOperatorAdmin(): Promise<void> {
  await env.BILLING_DB.prepare(
    `UPDATE operator_memberships SET role = 'admin', version = version + 1,
       updated_at = '2026-08-16T00:01:00.000Z'
     WHERE id = 'membership-operator-access'`,
  ).run();
}

async function operatorApiKeyRequest(
  method: string,
  path: string,
  body?: unknown,
): Promise<Response> {
  return operatorMutation(method, path, body);
}

async function operatorMutation(
  method: string,
  path: string,
  body?: unknown,
  extraHeaders: Record<string, string> = {},
): Promise<Response> {
  return handleOperatorRequest(
    new Request(`https://operator.test/api/operator/v1${path}`, {
      method,
      headers: {
        "Cf-Access-Jwt-Assertion": await accessToken(),
        "Content-Type": "application/json",
        Origin: "https://operator.test",
        "Sec-Fetch-Site": "same-origin",
        "X-Operator-Request": "1",
        ...extraHeaders,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
    operatorEnv(),
    keySet,
  );
}
