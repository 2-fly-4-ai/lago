import { env, SELF } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { sha256Hex } from "../src/auth/api-key";
import { failDataExport, generateDataExport } from "../src/documents/data-export";

const apiKey = "data-export-api-key";
const organizationId = "org-data-export";
const customerId = "customer-data-export";
const invoiceId = "invoice-data-export";
const lineId = "line-data-export";
const creditNoteId = "credit-note-data-export";
const creditNoteItemId = "credit-note-item-data-export";

beforeEach(async () => {
  const objects = await env.BILLING_ARTIFACTS.list({ prefix: `data-exports/${organizationId}/` });
  if (objects.objects.length > 0) {
    await env.BILLING_ARTIFACTS.delete(objects.objects.map((object) => object.key));
  }
  const now = "2026-08-15T00:00:00.000Z";
  await env.BILLING_DB.batch([
    env.BILLING_DB.prepare("DELETE FROM outbox_events WHERE organization_id = ?").bind(
      organizationId,
    ),
    env.BILLING_DB.prepare("DELETE FROM data_exports WHERE organization_id = ?").bind(
      organizationId,
    ),
    env.BILLING_DB.prepare("DELETE FROM credit_note_taxes WHERE organization_id = ?").bind(
      organizationId,
    ),
    env.BILLING_DB.prepare(
      "DELETE FROM credit_note_item_adjustments WHERE organization_id = ?",
    ).bind(organizationId),
    env.BILLING_DB.prepare("DELETE FROM credit_note_offsets WHERE organization_id = ?").bind(
      organizationId,
    ),
    env.BILLING_DB.prepare("DELETE FROM credit_note_refunds WHERE organization_id = ?").bind(
      organizationId,
    ),
    env.BILLING_DB.prepare("DELETE FROM credit_note_financials WHERE organization_id = ?").bind(
      organizationId,
    ),
    env.BILLING_DB.prepare("DELETE FROM credit_note_items WHERE organization_id = ?").bind(
      organizationId,
    ),
    env.BILLING_DB.prepare("DELETE FROM credit_notes WHERE organization_id = ?").bind(
      organizationId,
    ),
    env.BILLING_DB.prepare("DELETE FROM invoice_lines WHERE invoice_id = ?").bind(invoiceId),
    env.BILLING_DB.prepare("DELETE FROM invoices WHERE organization_id = ?").bind(organizationId),
    env.BILLING_DB.prepare("DELETE FROM subscriptions WHERE organization_id = ?").bind(
      organizationId,
    ),
    env.BILLING_DB.prepare("DELETE FROM plans WHERE organization_id = ?").bind(organizationId),
    env.BILLING_DB.prepare("DELETE FROM customers WHERE organization_id = ?").bind(organizationId),
    env.BILLING_DB.prepare("DELETE FROM api_keys WHERE organization_id = ?").bind(organizationId),
    env.BILLING_DB.prepare("DELETE FROM organizations WHERE id = ?").bind(organizationId),
    env.BILLING_DB.prepare(
      `INSERT INTO organizations (id, external_id, name, created_at, updated_at)
       VALUES (?, 'data-export', 'Data Export', ?, ?)`,
    ).bind(organizationId, now, now),
    env.BILLING_DB.prepare(
      `INSERT INTO api_keys
       (id, organization_id, key_prefix, key_hash, created_at, revoked_at, name, value_ending,
        updated_at)
       VALUES ('key-data-export', ?, 'data-exp', ?, ?, NULL, 'Data export', 'key', ?)`,
    ).bind(organizationId, await sha256Hex(apiKey), now, now),
    env.BILLING_DB.prepare(
      `INSERT INTO customers
       (id, organization_id, external_id, email, name, currency, metadata_json, created_at,
        updated_at)
       VALUES (?, ?, 'customer-data-export-external', 'export@example.invalid', '=Formula Corp',
               'USD', '{}', ?, ?)`,
    ).bind(customerId, organizationId, now, now),
    env.BILLING_DB.prepare(
      `INSERT INTO plans
       (id, organization_id, code, name, interval, amount_minor, currency, version, active,
        created_at, updated_at)
       VALUES ('plan-data-export', ?, 'export-plan', 'Export Plan', 'monthly', 1000, 'USD',
               1, 1, ?, ?)`,
    ).bind(organizationId, now, now),
    env.BILLING_DB.prepare(
      `INSERT INTO subscriptions
       (id, organization_id, customer_id, plan_id, external_id, status, version, created_at,
        updated_at)
       VALUES ('subscription-data-export', ?, ?, 'plan-data-export',
               'subscription-data-export-external', 'active', 1, ?, ?)`,
    ).bind(organizationId, customerId, now, now),
    env.BILLING_DB.prepare(
      `INSERT INTO invoices
       (id, organization_id, customer_id, subscription_id, number, status, payment_status,
        currency, subtotal_minor, tax_minor, credits_minor, total_due_minor, version,
        finalized_at, created_at, updated_at, invoice_type, issuing_date, payment_due_date)
       VALUES (?, ?, ?, 'subscription-data-export', 'INV-EXPORT-001', 'finalized', 'pending',
               'USD', 1000, 100, 0, 1100, 1, ?, ?, ?, 'subscription', '2026-08-15',
               '2026-09-14')`,
    ).bind(invoiceId, organizationId, customerId, now, now, now),
    env.BILLING_DB.prepare(
      `INSERT INTO invoice_lines
       (id, invoice_id, line_type, description, quantity_decimal, unit_amount_decimal,
        amount_minor, source_type, source_id, metadata_json, created_at, precise_amount_minor)
       VALUES (?, ?, 'charge', 'Synthetic, metered fee', '2', '5', 1000, 'charge',
               'metric-export', ?, ?, '1000')`,
    ).bind(
      lineId,
      invoiceId,
      JSON.stringify({ code: "metric", name: "Metered", groupedBy: { region: "test" } }),
      now,
    ),
    env.BILLING_DB.prepare(
      `INSERT INTO credit_notes
       (id, organization_id, customer_id, invoice_id, sequential_id, number, status,
        credit_status, reason, description, currency, total_amount_minor, credit_amount_minor,
        balance_amount_minor, version, idempotency_key, request_sha256, issuing_date, created_at,
        updated_at)
       VALUES (?, ?, ?, ?, 1, 'CN-EXPORT-001', 'finalized', 'available', 'order_change',
               'Synthetic credit', 'USD', 250, 250, 250, 1, 'credit-export', ?, '2026-08-15',
               ?, ?)`,
    ).bind(creditNoteId, organizationId, customerId, invoiceId, "a".repeat(64), now, now),
    env.BILLING_DB.prepare(
      `INSERT INTO credit_note_items
       (id, organization_id, credit_note_id, invoice_line_id, amount_minor,
        precise_amount_minor, currency, created_at)
       VALUES (?, ?, ?, ?, 250, '250', 'USD', ?)`,
    ).bind(creditNoteItemId, organizationId, creditNoteId, lineId, now),
  ]);
});

describe("container-free data exports", () => {
  it("creates and replays tenant-scoped export commands with value-free evidence", async () => {
    const missingKey = await api("/api/v1/data_exports", "POST", exportBody("invoices"));
    expect(missingKey.status).toBe(422);
    await expect(missingKey.json()).resolves.toMatchObject({ code: "idempotency_key_required" });

    const created = await createExport("invoices-create", "invoices", {
      currency: "usd",
      status: ["finalized"],
      amount_from: 100,
    });
    expect(created.status).toBe(200);
    const body = await created.json<{ data_export: { lago_id: string } }>();
    await expect(
      createExport("invoices-create", "invoices", {
        amount_from: 100,
        status: ["finalized"],
        currency: "USD",
      }).then((response) => response.json()),
    ).resolves.toMatchObject({
      data_export: { lago_id: body.data_export.lago_id, status: "pending", version: 1 },
    });
    const conflict = await createExport("invoices-create", "invoices", { currency: "EUR" });
    expect(conflict.status).toBe(409);

    const event = await env.BILLING_DB.prepare(
      "SELECT payload_json FROM outbox_events WHERE aggregate_type = 'data_export' LIMIT 1",
    ).first<{ payload_json: string }>();
    expect(event?.payload_json).not.toContain("currency");
    expect(event?.payload_json).not.toContain("finalized");
  });

  it("streams invoice and fee CSVs to R2 with filtering and formula neutralization", async () => {
    const invoiceExport = await exportIdFrom(
      await createExport("invoice-csv", "invoices", {
        currency: "USD",
        customer_external_id: "customer-data-export-external",
        issuing_date_from: "2026-08-15",
        issuing_date_to: "2026-08-15",
      }),
    );
    const generated = await generateDataExport(env, invoiceExport);
    expect(generated.rowCount).toBe(1);
    const invoiceCsv = await downloadText(invoiceExport);
    expect(invoiceCsv).toContain("lago_id,sequential_id,partner_billing");
    expect(invoiceCsv).toContain("invoice-data-export,,false,2026-08-15");
    expect(invoiceCsv).toContain("'=Formula Corp");
    expect(invoiceCsv).toContain("INV-EXPORT-001,subscription,pending,finalized");

    const feeExport = await exportIdFrom(
      await createExport("fee-csv", "invoice_fees", { status: ["finalized"] }),
    );
    await generateDataExport(env, feeExport);
    const feeCsv = await downloadText(feeExport);
    expect(feeCsv).toContain("invoice_lago_id,invoice_number,invoice_issuing_date");
    expect(feeCsv).toContain("invoice-data-export,INV-EXPORT-001,2026-08-15,line-data-export");
    expect(feeCsv).toContain('"Synthetic, metered fee"');
    expect(feeCsv).toContain('"{""region"":""test""}"');
  });

  it("streams credit-note and item CSV contracts and supports private downloads", async () => {
    const noteExport = await exportIdFrom(
      await createExport("credit-note-csv", "credit_notes", {
        credit_status: ["available"],
        reason: ["order_change"],
        types: ["credit"],
      }),
    );
    await generateDataExport(env, noteExport);
    const noteResponse = await api(`/api/v1/data_exports/${noteExport}/download`);
    expect(noteResponse.status).toBe(200);
    expect(noteResponse.headers.get("Cache-Control")).toBe("private, no-store");
    expect(await noteResponse.text()).toContain(
      "credit-note-data-export,1,false,2026-08-15,customer-data-export",
    );

    const itemExport = await exportIdFrom(
      await createExport("credit-note-item-csv", "credit_note_items", {
        invoice_number: "INV-EXPORT-001",
      }),
    );
    await generateDataExport(env, itemExport);
    const itemCsv = await downloadText(itemExport);
    expect(itemCsv).toContain("credit_note_lago_id,credit_note_number");
    expect(itemCsv).toContain(
      "credit-note-data-export,CN-EXPORT-001,INV-EXPORT-001,2026-08-15,credit-note-item-data-export,line-data-export,USD,250",
    );
  });

  it("validates filters, isolates tenants, paginates status, and disables completion email", async () => {
    const invalidCases = [
      exportBody("invoices", { unknown: true }),
      exportBody("invoices", { amount_from: 20, amount_to: 10 }),
      exportBody("invoices", { status: ["unknown"] }),
      exportBody("credit_notes", { issuing_date_from: "2026-02-30" }),
    ];
    for (const [index, body] of invalidCases.entries()) {
      const response = await api("/api/v1/data_exports", "POST", body, {
        "Idempotency-Key": `invalid-${index}`,
      });
      expect(response.status).toBe(422);
    }
    const exportId = await exportIdFrom(await createExport("status-list", "invoices"));
    await expect(
      api("/api/v1/data_exports?per_page=1").then((response) => response.json()),
    ).resolves.toMatchObject({
      data_exports: [{ lago_id: exportId }],
      meta: { total_count: 1, current_page: 1 },
    });
    expect((await api(`/api/v1/data_exports/${exportId}/download`)).status).toBe(422);
    const resend = await api(`/api/v1/data_exports/${exportId}/resend`, "POST");
    expect(resend.status).toBe(422);
    await expect(resend.json()).resolves.toMatchObject({ code: "data_export_email_disabled" });
    expect((await api("/api/v1/data_exports/unknown")).status).toBe(404);
  });

  it("replays generation without changing completed artifacts and guards stale outbox versions", async () => {
    const exportId = await exportIdFrom(await createExport("generation-replay", "invoices"));
    const first = await generateDataExport(env, exportId);
    const second = await generateDataExport(env, exportId);
    expect(second).toEqual(first);
    await expect(
      env.BILLING_DB.prepare(
        `INSERT INTO outbox_events
         (event_id, organization_id, event_type, event_version, aggregate_type, aggregate_id,
          aggregate_version, correlation_id, payload_json, occurred_at, published_at)
         VALUES ('stale-data-export', ?, 'data_export.completed', 1, 'data_export', ?, 99,
                 'stale', '{}', '2026-08-15T01:00:00.000Z', NULL)`,
      )
        .bind(organizationId, exportId)
        .run(),
    ).rejects.toThrow();
    const row = await env.BILLING_DB.prepare(
      "SELECT status, version, row_count FROM data_exports WHERE id = ?",
    )
      .bind(exportId)
      .first();
    expect(row).toEqual({ status: "completed", version: 3, row_count: 1 });
  });

  it("records bounded failures without persisting exception or filter values", async () => {
    const exportId = await exportIdFrom(
      await createExport("failed-export", "invoices", { search_term: "private-filter-value" }),
    );
    await failDataExport(env, exportId, "failure-correlation");
    const row = await env.BILLING_DB.prepare(
      "SELECT status, error_code, version FROM data_exports WHERE id = ?",
    )
      .bind(exportId)
      .first();
    expect(row).toEqual({
      status: "failed",
      error_code: "data_export_generation_failed",
      version: 2,
    });
    const event = await env.BILLING_DB.prepare(
      "SELECT payload_json FROM outbox_events WHERE event_type = 'data_export.failed' AND aggregate_id = ?",
    )
      .bind(exportId)
      .first<{ payload_json: string }>();
    expect(event?.payload_json).not.toContain("private-filter-value");

    const processingId = await exportIdFrom(
      await createExport("failed-after-processing", "credit_notes"),
    );
    await env.BILLING_DB.prepare(
      `UPDATE data_exports SET status = 'processing', started_at = ?, version = 2, updated_at = ?
       WHERE id = ?`,
    )
      .bind("2026-08-15T01:00:00.000Z", "2026-08-15T01:00:00.000Z", processingId)
      .run();
    await failDataExport(env, processingId, "processing-failure");
    await expect(
      env.BILLING_DB.prepare(
        "SELECT status, started_at, error_code, version FROM data_exports WHERE id = ?",
      )
        .bind(processingId)
        .first(),
    ).resolves.toEqual({
      status: "failed",
      started_at: "2026-08-15T01:00:00.000Z",
      error_code: "data_export_generation_failed",
      version: 3,
    });
  });
});

function exportBody(resourceType: string, filters: Record<string, unknown> = {}) {
  return { data_export: { format: "csv", resource_type: resourceType, filters } };
}

function createExport(
  key: string,
  resourceType: string,
  filters: Record<string, unknown> = {},
): Promise<Response> {
  return api("/api/v1/data_exports", "POST", exportBody(resourceType, filters), {
    "Idempotency-Key": key,
  });
}

async function exportIdFrom(response: Response): Promise<string> {
  expect(response.status).toBe(200);
  const body = await response.json<{ data_export: { lago_id: string } }>();
  return body.data_export.lago_id;
}

async function downloadText(exportId: string): Promise<string> {
  const response = await api(`/api/v1/data_exports/${exportId}/download`);
  expect(response.status).toBe(200);
  return response.text();
}

function api(
  path: string,
  method = "GET",
  body?: unknown,
  extraHeaders?: Record<string, string>,
): Promise<Response> {
  return SELF.fetch(`https://lago.test${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      ...(body ? { "Content-Type": "application/json" } : {}),
      ...extraHeaders,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
}
