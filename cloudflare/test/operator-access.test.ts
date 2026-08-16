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
    BILLING_DB: env.BILLING_DB,
    DOMAIN_EVENTS: env.DOMAIN_EVENTS,
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
    env.BILLING_DB.prepare(
      "DELETE FROM outbox_events WHERE organization_id = 'org-operator-access'",
    ),
    env.BILLING_DB.prepare(
      "DELETE FROM invoice_custom_sections WHERE organization_id = 'org-operator-access'",
    ),
    env.BILLING_DB.prepare("DELETE FROM taxes WHERE organization_id = 'org-operator-access'"),
    env.BILLING_DB.prepare("DELETE FROM add_ons WHERE organization_id = 'org-operator-access'"),
    env.BILLING_DB.prepare(
      "DELETE FROM payment_receipts WHERE organization_id = 'org-operator-access'",
    ),
    env.BILLING_DB.prepare(
      "DELETE FROM payment_attempts WHERE organization_id = 'org-operator-access'",
    ),
    env.BILLING_DB.prepare("DELETE FROM invoices WHERE organization_id = 'org-operator-access'"),
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
        role: "viewer",
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

    const unsupported = await operatorMutation("PUT", "/add-ons/priority", {
      add_on: { tax_codes: ["vat"] },
    });
    expect(unsupported.status).toBe(422);
    await expect(unsupported.json()).resolves.toMatchObject({ code: "unsupported_tax_target" });

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

  it("maps customer reads for viewers and upserts for admins while keeping deletion unavailable", async () => {
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
    expect(deleted.status).toBe(422);
    await expect(deleted.json()).resolves.toMatchObject({ code: "unsupported_customer_deletion" });
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

async function operatorMutation(method: string, path: string, body?: unknown): Promise<Response> {
  return handleOperatorRequest(
    new Request(`https://operator.test/api/operator/v1${path}`, {
      method,
      headers: {
        "Cf-Access-Jwt-Assertion": await accessToken(),
        "Content-Type": "application/json",
        Origin: "https://operator.test",
        "Sec-Fetch-Site": "same-origin",
        "X-Operator-Request": "1",
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
    operatorEnv(),
    keySet,
  );
}
