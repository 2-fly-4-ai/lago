import { env, SELF } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { sha256Hex } from "../src/auth/api-key";

const apiKey = "organization-api-key";
const headers = { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" };

beforeEach(async () => {
  const now = "2026-08-15T00:00:00.000Z";
  await env.BILLING_DB.batch([
    env.BILLING_DB.prepare(
      `DELETE FROM outbox_events
       WHERE organization_id IN ('org-organization-api', 'org-organization-other')`,
    ),
    env.BILLING_DB.prepare(
      `DELETE FROM webhook_endpoints
       WHERE organization_id IN ('org-organization-api', 'org-organization-other')`,
    ),
    env.BILLING_DB.prepare(
      `DELETE FROM taxes
       WHERE organization_id IN ('org-organization-api', 'org-organization-other')`,
    ),
    env.BILLING_DB.prepare(
      `DELETE FROM api_keys
       WHERE organization_id IN ('org-organization-api', 'org-organization-other')`,
    ),
    env.BILLING_DB.prepare(
      `DELETE FROM organizations
       WHERE id IN ('org-organization-api', 'org-organization-other')`,
    ),
    env.BILLING_DB.prepare(
      `INSERT INTO organizations
       (id, external_id, name, slug, created_at, updated_at)
       VALUES ('org-organization-api', 'organization-api', 'Organization API',
               'organization-api', ?, ?)`,
    ).bind(now, now),
    env.BILLING_DB.prepare(
      `INSERT INTO api_keys
       (id, organization_id, key_prefix, key_hash, created_at, revoked_at, name,
        value_ending, updated_at)
       VALUES ('key-organization-api', 'org-organization-api', 'organization', ?, ?, NULL,
               'Organization API', 'key', ?)`,
    ).bind(await sha256Hex(apiKey), now, now),
    env.BILLING_DB.prepare(
      `INSERT INTO organizations
       (id, external_id, name, slug, created_at, updated_at)
       VALUES ('org-organization-other', 'organization-other', 'Organization Other',
               'existing-slug', ?, ?)`,
    ).bind(now, now),
  ]);
});

describe("organization compatibility API", () => {
  it("shows Lago defaults plus default-tax and active-webhook projections", async () => {
    const now = "2026-08-15T00:01:00.000Z";
    await env.BILLING_DB.batch([
      env.BILLING_DB.prepare(
        `INSERT INTO taxes
         (id, organization_id, code, name, description, rate, applied_to_organization, status,
          version, request_sha256, created_at, updated_at, terminated_at)
         VALUES ('tax-organization-api', 'org-organization-api', 'vat', 'VAT', 'Default VAT',
                 '10', 1, 'active', 1, 'tax-organization-api', ?, ?, NULL)`,
      ).bind(now, now),
      env.BILLING_DB.prepare(
        `INSERT INTO webhook_endpoints
         (id, organization_id, webhook_url, signature_algo, name, event_types_json, status,
          version, created_at, updated_at, deleted_at)
         VALUES ('endpoint-organization-api', 'org-organization-api',
                 'https://hooks.example.invalid/lago', 'hmac', 'Synthetic', NULL, 'active',
                 1, ?, ?, NULL)`,
      ).bind(now, now),
    ]);

    const response = await api();
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      organization: {
        lago_id: "org-organization-api",
        name: "Organization API",
        slug: "organization-api",
        default_currency: "USD",
        timezone: "UTC",
        net_payment_term: 0,
        webhook_url: "https://hooks.example.invalid/lago",
        webhook_urls: ["https://hooks.example.invalid/lago"],
        email_settings: [],
        document_numbering: "per_organization",
        finalize_zero_amount_invoice: false,
        billing_configuration: {
          invoice_footer: null,
          invoice_grace_period: 0,
          document_locale: "en",
        },
        taxes: [
          {
            lago_id: "tax-organization-api",
            code: "vat",
            rate: 10,
            applied_to_organization: true,
          },
        ],
        version: 1,
      },
    });
  });

  it("normalizes and atomically updates billing-critical organization configuration", async () => {
    const response = await api("PUT", {
      organization: {
        slug: "updated-organization",
        default_currency: "eur",
        country: "fr",
        address_line1: "1 Synthetic Way",
        address_line2: "Suite 2",
        state: "IDF",
        zipcode: "75001",
        email: "BILLING@EXAMPLE.INVALID",
        city: "Paris",
        legal_name: "Synthetic Legal Name",
        legal_number: "SYN-1",
        tax_identification_number: "FR-SYNTHETIC",
        timezone: "Europe/Paris",
        net_payment_term: 30,
        email_settings: ["payment_receipt.created", "invoice.finalized"],
        document_numbering: "per_customer",
        document_number_prefix: "syn",
        finalize_zero_amount_invoice: true,
        billing_configuration: {
          invoice_footer: "Synthetic footer",
          invoice_grace_period: 3,
          document_locale: "pt-br",
        },
      },
    });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      organization: {
        slug: "updated-organization",
        default_currency: "EUR",
        country: "FR",
        email: "billing@example.invalid",
        timezone: "Europe/Paris",
        net_payment_term: 30,
        email_settings: ["invoice.finalized", "payment_receipt.created"],
        document_numbering: "per_customer",
        document_number_prefix: "SYN",
        finalize_zero_amount_invoice: true,
        billing_configuration: {
          invoice_footer: "Synthetic footer",
          invoice_grace_period: 3,
          document_locale: "pt-BR",
        },
        version: 2,
      },
    });

    const event = await env.BILLING_DB.prepare(
      `SELECT aggregate_version, payload_json FROM outbox_events
       WHERE aggregate_type = 'organization' AND aggregate_id = 'org-organization-api'`,
    ).first<{ aggregate_version: number; payload_json: string }>();
    expect(event?.aggregate_version).toBe(2);
    const payload = JSON.parse(event!.payload_json) as { changed_fields: string[] };
    expect(payload.changed_fields).toContain("default_currency");
    expect(payload.changed_fields).toContain("invoice_grace_period");
    expect(event?.payload_json).not.toContain("billing@example.invalid");
    expect(event?.payload_json).not.toContain("Synthetic footer");

    const replay = await api("PUT", {
      organization: {
        slug: "updated-organization",
        default_currency: "EUR",
        country: "FR",
        email: "billing@example.invalid",
        timezone: "Europe/Paris",
        net_payment_term: 30,
        email_settings: ["invoice.finalized", "payment_receipt.created"],
        document_numbering: "per_customer",
        document_number_prefix: "SYN",
        finalize_zero_amount_invoice: true,
        address_line1: "1 Synthetic Way",
        address_line2: "Suite 2",
        state: "IDF",
        zipcode: "75001",
        city: "Paris",
        legal_name: "Synthetic Legal Name",
        legal_number: "SYN-1",
        tax_identification_number: "FR-SYNTHETIC",
        billing_configuration: {
          invoice_footer: "Synthetic footer",
          invoice_grace_period: 3,
          document_locale: "pt-BR",
        },
      },
    });
    await expect(replay.json()).resolves.toMatchObject({ organization: { version: 2 } });
    await expect(
      env.BILLING_DB.prepare(
        `SELECT COUNT(*) AS total FROM outbox_events
         WHERE aggregate_type = 'organization' AND aggregate_id = 'org-organization-api'`,
      ).first(),
    ).resolves.toEqual({ total: 1 });
  });

  it("rejects invalid or side-effecting organization configuration", async () => {
    const cases: Array<[Record<string, unknown>, string]> = [
      [{ slug: "api" }, "validation_error"],
      [{ default_currency: "US" }, "validation_error"],
      [{ default_currency: "ZZZ" }, "validation_error"],
      [{ country: "France" }, "validation_error"],
      [{ country: "ZZ" }, "validation_error"],
      [{ email: "not-an-email" }, "validation_error"],
      [{ timezone: "Mars/Olympus" }, "validation_error"],
      [{ net_payment_term: -1 }, "validation_error"],
      [{ document_numbering: "global" }, "validation_error"],
      [{ document_number_prefix: "TOO-LONG-PREFIX" }, "validation_error"],
      [{ email_settings: ["customer.message"] }, "validation_error"],
      [{ billing_configuration: { invoice_footer: "x".repeat(601) } }, "validation_error"],
      [{ billing_configuration: { document_locale: "invalid_locale" } }, "validation_error"],
      [{ billing_configuration: { document_locale: "fr-FR" } }, "validation_error"],
      [
        { webhook_url: "https://hooks.example.invalid/implicit" },
        "unsupported_organization_webhook_mutation",
      ],
    ];
    for (const [organization, code] of cases) {
      const response = await api("PUT", { organization });
      expect(response.status).toBe(422);
      await expect(response.json()).resolves.toMatchObject({ code });
    }
    await expect(api().then((response) => response.json())).resolves.toMatchObject({
      organization: { version: 1, webhook_urls: [] },
    });
  });

  it("enforces global slug uniqueness and outbox versions", async () => {
    const duplicate = await api("PUT", { organization: { slug: "existing-slug" } });
    expect(duplicate.status).toBe(422);
    await expect(duplicate.json()).resolves.toMatchObject({ code: "value_already_exist" });

    await expect(
      env.BILLING_DB.prepare(
        `INSERT INTO outbox_events
         (event_id, organization_id, event_type, event_version, aggregate_type, aggregate_id,
          aggregate_version, causation_id, correlation_id, payload_json, occurred_at, published_at)
         VALUES ('event-stale-organization', 'org-organization-api', 'organization.updated', 1,
                 'organization', 'org-organization-api', 2, NULL, 'stale-organization', '{}',
                 '2026-08-15T00:02:00.000Z', NULL)`,
      ).run(),
    ).rejects.toThrow(/organization_outbox_version_conflict/);
  });

  it("rolls back configuration when audit evidence cannot commit", async () => {
    await env.BILLING_DB.prepare(
      `CREATE TRIGGER reject_organization_audit BEFORE INSERT ON outbox_events
       WHEN NEW.event_type = 'organization.updated'
       BEGIN SELECT RAISE(ABORT, 'synthetic_organization_audit_failure'); END`,
    ).run();
    const response = await api("PUT", { organization: { default_currency: "EUR" } });
    expect(response.status).toBe(500);
    await expect(api().then((shown) => shown.json())).resolves.toMatchObject({
      organization: { default_currency: "USD", version: 1 },
    });
  });
});

function api(method = "GET", body?: unknown): Promise<Response> {
  return SELF.fetch("https://lago.test/api/v1/organizations", {
    method,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}
