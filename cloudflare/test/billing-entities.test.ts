import { env, SELF } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { sha256Hex } from "../src/auth/api-key";

const apiKey = "billing-entity-api-key";
const headers = { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" };

beforeEach(async () => {
  const now = "2026-08-15T00:00:00.000Z";
  await env.BILLING_DB.batch([
    env.BILLING_DB.prepare(
      `DELETE FROM outbox_events WHERE organization_id = 'org-billing-entity-api'`,
    ),
    env.BILLING_DB.prepare(
      `DELETE FROM organization_invoice_custom_sections
       WHERE organization_id = 'org-billing-entity-api'`,
    ),
    env.BILLING_DB.prepare(
      `DELETE FROM invoice_custom_sections WHERE organization_id = 'org-billing-entity-api'`,
    ),
    env.BILLING_DB.prepare(`DELETE FROM taxes WHERE organization_id = 'org-billing-entity-api'`),
    env.BILLING_DB.prepare(`DELETE FROM api_keys WHERE organization_id = 'org-billing-entity-api'`),
    env.BILLING_DB.prepare(`DELETE FROM organizations WHERE id = 'org-billing-entity-api'`),
    env.BILLING_DB.prepare(
      `INSERT INTO organizations
       (id, external_id, name, slug, created_at, updated_at)
       VALUES ('org-billing-entity-api', 'billing-entity-api', 'Billing Entity API',
               'billing-entity-api', ?, ?)`,
    ).bind(now, now),
    env.BILLING_DB.prepare(
      `INSERT INTO api_keys
       (id, organization_id, key_prefix, key_hash, created_at, revoked_at, name,
        value_ending, updated_at)
       VALUES ('key-billing-entity-api', 'org-billing-entity-api', 'billingentity', ?, ?, NULL,
               'Billing Entity API', 'key', ?)`,
    ).bind(await sha256Hex(apiKey), now, now),
  ]);
});

describe("single billing entity compatibility API", () => {
  it("lists and shows the default entity with tax and custom-section projections", async () => {
    const now = "2026-08-15T00:01:00.000Z";
    await env.BILLING_DB.batch([
      env.BILLING_DB.prepare(
        `INSERT INTO taxes
         (id, organization_id, code, name, description, rate, applied_to_organization, status,
          version, request_sha256, created_at, updated_at, terminated_at)
         VALUES ('tax-billing-entity-api', 'org-billing-entity-api', 'vat', 'VAT', 'Default VAT',
                 '20', 1, 'active', 1, 'tax-billing-entity-api', ?, ?, NULL)`,
      ).bind(now, now),
      env.BILLING_DB.prepare(
        `INSERT INTO invoice_custom_sections
         (id, organization_id, code, name, description, details, display_name, section_type,
          status, version, request_sha256, created_at, updated_at, terminated_at)
         VALUES ('section-billing-entity-api', 'org-billing-entity-api', 'legal', 'Legal',
                 'Legal description', 'Legal details', 'Legal display', 'manual', 'active', 1,
                 'section-billing-entity-api', ?, ?, NULL)`,
      ).bind(now, now),
      env.BILLING_DB.prepare(
        `INSERT INTO organization_invoice_custom_sections
         (organization_id, invoice_custom_section_id, created_at)
         VALUES ('org-billing-entity-api', 'section-billing-entity-api', ?)`,
      ).bind(now),
    ]);

    const list = await api("/api/v1/billing_entities");
    expect(list.status).toBe(200);
    await expect(list.json()).resolves.toMatchObject({
      billing_entities: [
        {
          lago_id: "org-billing-entity-api",
          code: "default",
          name: "Billing Entity API",
          default_currency: "USD",
          document_numbering: "per_billing_entity",
          is_default: true,
          einvoicing: false,
          eu_tax_management: false,
          version: 1,
        },
      ],
    });

    const show = await api("/api/v1/billing_entities/default");
    expect(show.status).toBe(200);
    await expect(show.json()).resolves.toMatchObject({
      billing_entity: {
        taxes: [{ lago_id: "tax-billing-entity-api", code: "vat", rate: 20 }],
        selected_invoice_custom_sections: [
          { lago_id: "section-billing-entity-api", code: "legal", name: "Legal" },
        ],
      },
    });
  });

  it("normalizes and atomically updates the shared default billing configuration", async () => {
    const body = {
      billing_entity: {
        name: "Renamed Billing Entity",
        default_currency: "eur",
        country: "fr",
        address_line1: "1 Entity Way",
        email: "ENTITY@EXAMPLE.INVALID",
        legal_name: "Synthetic Entity",
        timezone: "Europe/Paris",
        net_payment_term: 14,
        email_settings: ["payment_receipt.created", "invoice.finalized"],
        document_numbering: "per_customer",
        document_number_prefix: "ent",
        finalize_zero_amount_invoice: true,
        billing_configuration: {
          invoice_footer: "Entity footer",
          invoice_grace_period: 2,
          document_locale: "fr",
          subscription_invoice_issuing_date_anchor: "current_period_end",
          subscription_invoice_issuing_date_adjustment: "keep_anchor",
        },
        einvoicing: false,
        eu_tax_management: false,
      },
    };
    const response = await api("/api/v1/billing_entities/default", "PUT", body);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      billing_entity: {
        name: "Renamed Billing Entity",
        default_currency: "EUR",
        country: "FR",
        email: "entity@example.invalid",
        timezone: "Europe/Paris",
        net_payment_term: 14,
        email_settings: ["invoice.finalized", "payment_receipt.created"],
        document_numbering: "per_customer",
        document_number_prefix: "ENT",
        finalize_zero_amount_invoice: true,
        invoice_footer: "Entity footer",
        invoice_grace_period: 2,
        document_locale: "fr",
        subscription_invoice_issuing_date_anchor: "current_period_end",
        subscription_invoice_issuing_date_adjustment: "keep_anchor",
        version: 2,
      },
    });
    const organization = await env.BILLING_DB.prepare(
      `SELECT name, default_currency, document_numbering,
              subscription_invoice_issuing_date_anchor,
              subscription_invoice_issuing_date_adjustment, version FROM organizations
       WHERE id = 'org-billing-entity-api'`,
    ).first();
    expect(organization).toEqual({
      name: "Renamed Billing Entity",
      default_currency: "EUR",
      document_numbering: "per_customer",
      subscription_invoice_issuing_date_anchor: "current_period_end",
      subscription_invoice_issuing_date_adjustment: "keep_anchor",
      version: 2,
    });
    const event = await env.BILLING_DB.prepare(
      `SELECT aggregate_version, payload_json FROM outbox_events
       WHERE aggregate_type = 'billing_entity' AND aggregate_id = 'org-billing-entity-api'`,
    ).first<{ aggregate_version: number; payload_json: string }>();
    expect(event?.aggregate_version).toBe(2);
    expect(event?.payload_json).toContain("default_currency");
    expect(event?.payload_json).not.toContain("entity@example.invalid");
    expect(event?.payload_json).not.toContain("Entity footer");

    const replay = await api("/api/v1/billing_entities/default", "PUT", body);
    await expect(replay.json()).resolves.toMatchObject({ billing_entity: { version: 2 } });
    await expect(
      env.BILLING_DB.prepare(
        `SELECT COUNT(*) AS total FROM outbox_events
         WHERE aggregate_type = 'billing_entity' AND aggregate_id = 'org-billing-entity-api'`,
      ).first(),
    ).resolves.toEqual({ total: 1 });
  });

  it("creates independent entities while rejecting side-effecting provider configuration", async () => {
    const created = await api("/api/v1/billing_entities", "POST", {
      billing_entity: { code: "second", name: "Second Entity", default_currency: "EUR" },
    });
    expect(created.status).toBe(200);
    await expect(created.json()).resolves.toMatchObject({
      billing_entity: { code: "second", name: "Second Entity", is_default: false },
    });
    expect((await api("/api/v1/billing_entities/second")).status).toBe(200);
    const duplicate = await api("/api/v1/billing_entities", "POST", {
      billing_entity: { code: "second", name: "Duplicate" },
    });
    expect(duplicate.status).toBe(422);
    await expect(duplicate.json()).resolves.toMatchObject({ code: "value_already_exist" });

    const cases: Array<[string, string, unknown, string]> = [
      [
        "/api/v1/billing_entities/default",
        "PUT",
        { billing_entity: { einvoicing: true } },
        "unsupported_billing_entity_feature",
      ],
      [
        "/api/v1/billing_entities/default",
        "PUT",
        { billing_entity: { eu_tax_management: true } },
        "unsupported_billing_entity_feature",
      ],
      [
        "/api/v1/billing_entities/default",
        "PUT",
        { billing_entity: { tax_codes: ["vat"] } },
        "unsupported_billing_entity_feature",
      ],
      [
        "/api/v1/billing_entities/default",
        "PUT",
        { billing_entity: { invoice_custom_section_codes: ["legal"] } },
        "unsupported_billing_entity_feature",
      ],
    ];
    for (const [path, method, body, code] of cases) {
      const response = await api(path, method, body);
      expect(response.status).toBe(422);
      await expect(response.json()).resolves.toMatchObject({ code });
    }
  });

  it("enforces billing-entity outbox versions and rolls back without audit evidence", async () => {
    await env.BILLING_DB.prepare(
      `UPDATE organizations SET invoice_custom_section_version = 4
       WHERE id = 'org-billing-entity-api'`,
    ).run();
    await expect(
      env.BILLING_DB.prepare(
        `INSERT INTO outbox_events
         (event_id, organization_id, event_type, event_version, aggregate_type, aggregate_id,
          aggregate_version, causation_id, correlation_id, payload_json, occurred_at, published_at)
         VALUES ('event-billing-entity-sections', 'org-billing-entity-api',
                 'billing_entity.invoice_custom_sections_updated', 1, 'billing_entity',
                 'org-billing-entity-api', 4, NULL, 'billing-entity-sections', '{}',
                 '2026-08-15T00:01:00.000Z', NULL)`,
      ).run(),
    ).resolves.toMatchObject({ success: true });

    await expect(
      env.BILLING_DB.prepare(
        `INSERT INTO outbox_events
         (event_id, organization_id, event_type, event_version, aggregate_type, aggregate_id,
          aggregate_version, causation_id, correlation_id, payload_json, occurred_at, published_at)
         VALUES ('event-stale-billing-entity', 'org-billing-entity-api', 'billing_entity.updated', 1,
                 'billing_entity', 'org-billing-entity-api', 2, NULL, 'stale-billing-entity', '{}',
                 '2026-08-15T00:02:00.000Z', NULL)`,
      ).run(),
    ).rejects.toThrow(/billing_entity_outbox_version_conflict/);

    await env.BILLING_DB.prepare(
      `CREATE TRIGGER reject_billing_entity_audit BEFORE INSERT ON outbox_events
       WHEN NEW.event_type = 'billing_entity.updated'
       BEGIN SELECT RAISE(ABORT, 'synthetic_billing_entity_audit_failure'); END`,
    ).run();
    const response = await api("/api/v1/billing_entities/default", "PUT", {
      billing_entity: { default_currency: "EUR" },
    });
    expect(response.status).toBe(500);
    await expect(
      api("/api/v1/billing_entities/default").then((shown) => shown.json()),
    ).resolves.toMatchObject({
      billing_entity: { default_currency: "USD", version: 1 },
    });
  });
});

function api(path: string, method = "GET", body?: unknown): Promise<Response> {
  return SELF.fetch(`https://lago.test${path}`, {
    method,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}
