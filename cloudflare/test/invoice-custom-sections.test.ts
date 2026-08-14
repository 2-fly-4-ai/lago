import { env, SELF } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { sha256Hex } from "../src/auth/api-key";

const apiKey = "invoice-sections-key";
const otherApiKey = "invoice-sections-other-key";
const headers = { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" };

beforeEach(async () => {
  const now = "2026-08-13T00:00:00.000Z";
  await env.BILLING_DB.batch([
    env.BILLING_DB.prepare(
      `INSERT OR IGNORE INTO organizations (id, external_id, name, created_at, updated_at)
       VALUES ('org-sections', 'sections', 'Sections', ?, ?),
              ('org-sections-other', 'sections-other', 'Other sections', ?, ?)`,
    ).bind(now, now, now, now),
    env.BILLING_DB.prepare(
      `INSERT OR IGNORE INTO api_keys
       (id, organization_id, key_prefix, key_hash, created_at, revoked_at)
       VALUES ('key-sections', 'org-sections', 'sections', ?, ?, NULL),
              ('key-sections-other', 'org-sections-other', 'sections-o', ?, ?, NULL)`,
    ).bind(await sha256Hex(apiKey), now, await sha256Hex(otherApiKey), now),
    env.BILLING_DB.prepare(
      `INSERT OR IGNORE INTO customers
       (id, organization_id, external_id, currency, metadata_json, invoice_grace_period,
        created_at, updated_at)
       VALUES ('customer-sections', 'org-sections', 'customer-sections', 'USD', '{}', 3, ?, ?),
              ('customer-plan-sections', 'org-sections', 'customer-plan-sections', 'USD', '{}', 0, ?, ?),
              ('customer-sections-other', 'org-sections-other', 'customer-sections-other',
               'USD', '{}', 0, ?, ?)`,
    ).bind(now, now, now, now, now, now),
    env.BILLING_DB.prepare(
      `INSERT OR IGNORE INTO plans
       (id, organization_id, code, name, interval, amount_minor, currency, pay_in_advance,
        version, active, created_at, updated_at)
       VALUES ('plan-sections-prepaid', 'org-sections', 'sections-prepaid', 'Prepaid',
               'monthly', 1000, 'USD', 1, 1, 1, ?, ?),
              ('plan-sections-pending', 'org-sections', 'sections-pending', 'Pending',
               'monthly', 1000, 'USD', 0, 1, 1, ?, ?),
              ('plan-sections-pending-next', 'org-sections', 'sections-pending-next',
               'Pending next', 'monthly', 2000, 'USD', 0, 1, 1, ?, ?),
              ('plan-sections-active', 'org-sections', 'sections-active', 'Active',
               'monthly', 1000, 'USD', 0, 1, 1, ?, ?),
              ('plan-sections-upgrade', 'org-sections', 'sections-upgrade', 'Upgrade',
               'monthly', 2000, 'USD', 0, 1, 1, ?, ?),
              ('plan-sections-high', 'org-sections', 'sections-high', 'High',
               'monthly', 3000, 'USD', 0, 1, 1, ?, ?),
              ('plan-sections-low', 'org-sections', 'sections-low', 'Low',
               'monthly', 500, 'USD', 0, 1, 1, ?, ?),
              ('plan-sections-other', 'org-sections-other', 'sections-other', 'Other',
               'monthly', 1000, 'USD', 0, 1, 1, ?, ?)`,
    ).bind(now, now, now, now, now, now, now, now, now, now, now, now, now, now, now, now),
    env.BILLING_DB.prepare(
      `INSERT OR IGNORE INTO subscriptions
       (id, organization_id, customer_id, plan_id, external_id, status, subscription_at,
        started_at, current_period_start, current_period_end, version, created_at, updated_at)
       VALUES ('subscription-sections-other', 'org-sections-other', 'customer-sections-other',
               'plan-sections-other', 'subscription-sections-other', 'active', ?, ?, ?,
               '2026-09-13T00:00:00.000Z', 1, ?, ?)`,
    ).bind(now, now, now, now, now),
  ]);
});

describe("invoice custom sections", () => {
  it("provides replay-safe tenant-scoped catalog CRUD and permits code reuse after termination", async () => {
    const payload = sectionPayload("terms", "Terms", "Version one", "Payment terms");
    const created = await api("/api/v1/invoice_custom_sections", "POST", payload);
    expect(created.status).toBe(200);
    const first = await created.json<{ invoice_custom_section: { lago_id: string } }>();

    const replay = await api("/api/v1/invoice_custom_sections", "POST", payload);
    expect(replay.status).toBe(200);
    await expect(replay.json()).resolves.toMatchObject({
      invoice_custom_section: { lago_id: first.invoice_custom_section.lago_id },
    });
    const conflict = await api(
      "/api/v1/invoice_custom_sections",
      "POST",
      sectionPayload("terms", "Different", "Version one", "Payment terms"),
    );
    expect(conflict.status).toBe(422);
    await expect(conflict.json()).resolves.toMatchObject({ code: "value_already_exist" });

    const hidden = await api(
      "/api/v1/invoice_custom_sections/terms",
      "GET",
      undefined,
      otherApiKey,
    );
    expect(hidden.status).toBe(404);
    const updated = await api("/api/v1/invoice_custom_sections/terms", "PUT", {
      invoice_custom_section: { name: "Updated terms", details: "Version two" },
    });
    expect(updated.status).toBe(200);
    await expect(updated.json()).resolves.toMatchObject({
      invoice_custom_section: { code: "terms", name: "Updated terms", details: "Version two" },
    });
    await expect(apiJson("/api/v1/invoice_custom_sections")).resolves.toMatchObject({
      meta: { total_count: 1 },
      invoice_custom_sections: [{ code: "terms" }],
    });

    expect((await api("/api/v1/invoice_custom_sections/terms", "DELETE")).status).toBe(200);
    expect((await api("/api/v1/invoice_custom_sections/terms")).status).toBe(404);
    const recreated = await api("/api/v1/invoice_custom_sections", "POST", payload);
    expect(recreated.status).toBe(200);
    const second = await recreated.json<{ invoice_custom_section: { lago_id: string } }>();
    expect(second.invoice_custom_section.lago_id).not.toBe(first.invoice_custom_section.lago_id);
    await expect(
      env.BILLING_DB.prepare(
        `SELECT COUNT(*) AS count FROM outbox_events
         WHERE organization_id = 'org-sections' AND aggregate_type = 'invoice_custom_section'`,
      ).first(),
    ).resolves.toEqual({ count: 4 });
  });

  it("rolls a catalog mutation back when its transactional outbox write fails", async () => {
    await createSection("rollback", "Rollback", "Original", null);
    await env.BILLING_DB.prepare(
      `CREATE TRIGGER fail_invoice_custom_section_outbox
       BEFORE INSERT ON outbox_events
       WHEN NEW.event_type = 'invoice_custom_section.updated'
       BEGIN
         SELECT RAISE(ABORT, 'injected_invoice_custom_section_outbox_failure');
       END`,
    ).run();
    try {
      const response = await api("/api/v1/invoice_custom_sections/rollback", "PUT", {
        invoice_custom_section: { details: "Must roll back" },
      });
      expect(response.status).toBe(500);
    } finally {
      await env.BILLING_DB.prepare("DROP TRIGGER fail_invoice_custom_section_outbox").run();
    }
    await expect(
      env.BILLING_DB.prepare(
        `SELECT details, version,
                (SELECT COUNT(*) FROM outbox_events
                 WHERE aggregate_id = invoice_custom_sections.id) AS events
         FROM invoice_custom_sections
         WHERE organization_id = 'org-sections' AND code = 'rollback' AND status = 'active'`,
      ).first(),
    ).resolves.toEqual({ details: "Original", version: 1, events: 1 });
  });

  it("refreshes draft snapshots, freezes finalized snapshots, and honors explicit skip semantics", async () => {
    await createSection("legal", "Legal", "Version one", "Legal terms");
    const created = await createSubscription(
      "section-snapshot",
      "customer-sections",
      "sections-prepaid",
      {
        skip_invoice_custom_sections: false,
        invoice_custom_section_codes: ["unknown-is-ignored", "legal"],
      },
    );
    expect(created.status).toBe(200);
    await expect(created.json()).resolves.toMatchObject({
      subscription: {
        skip_invoice_custom_sections: false,
        applied_invoice_custom_sections: [
          { invoice_custom_section: { code: "legal", details: "Version one" } },
        ],
      },
    });
    expect(
      (
        await createSubscription("section-snapshot", "customer-sections", "sections-prepaid", {
          skip_invoice_custom_sections: false,
          invoice_custom_section_codes: ["legal", "unknown-is-ignored", "legal"],
        })
      ).status,
    ).toBe(200);
    const divergent = await createSubscription(
      "section-snapshot",
      "customer-sections",
      "sections-prepaid",
      { invoice_custom_section_codes: [] },
    );
    expect(divergent.status).toBe(409);
    await expect(divergent.json()).resolves.toMatchObject({
      code: "subscription_idempotency_conflict",
    });
    await expect(linkCount("section-snapshot")).resolves.toBe(1);
    const invoice = await invoiceFor("section-snapshot");
    expect(invoice).toMatchObject({ status: "draft", ready_to_be_refreshed: 0 });
    await expect(apiJson(`/api/v1/invoices/${invoice!.id}`)).resolves.toMatchObject({
      invoice: {
        applied_invoice_custom_sections: [
          { code: "legal", details: "Version one", display_name: "Legal terms" },
        ],
      },
    });

    expect(
      (
        await api("/api/v1/invoice_custom_sections/legal", "PUT", {
          invoice_custom_section: { code: "legal-v2", details: "Version two" },
        })
      ).status,
    ).toBe(200);
    await expect(snapshotState(invoice!.id)).resolves.toEqual({
      code: "legal",
      details: "Version one",
      ready_to_be_refreshed: 1,
      status: "draft",
    });
    expect((await api(`/api/v1/invoices/${invoice!.id}/refresh`, "PUT")).status).toBe(200);
    await expect(snapshotState(invoice!.id)).resolves.toEqual({
      code: "legal-v2",
      details: "Version two",
      ready_to_be_refreshed: 0,
      status: "draft",
    });
    expect((await api(`/api/v1/invoices/${invoice!.id}/finalize`, "PUT")).status).toBe(200);
    expect(
      (
        await api("/api/v1/invoice_custom_sections/legal-v2", "PUT", {
          invoice_custom_section: { details: "Version three" },
        })
      ).status,
    ).toBe(200);
    await expect(snapshotState(invoice!.id)).resolves.toEqual({
      code: "legal-v2",
      details: "Version two",
      ready_to_be_refreshed: 0,
      status: "finalized",
    });

    expect(
      (
        await createSubscription("section-skip", "customer-sections", "sections-prepaid", {
          invoice_custom_section_codes: ["legal-v2"],
        })
      ).status,
    ).toBe(200);
    const skipped = await updateSubscriptionSections("section-skip", {
      skip_invoice_custom_sections: true,
      invoice_custom_section_codes: ["legal-v2"],
    });
    expect(skipped).toMatchObject({
      subscription: { skip_invoice_custom_sections: true, applied_invoice_custom_sections: [] },
    });
    await expect(linkCount("section-skip")).resolves.toBe(0);

    const implicit = await updateSubscriptionSections("section-skip", {
      invoice_custom_section_codes: ["legal-v2"],
    });
    expect(implicit).toMatchObject({
      subscription: { skip_invoice_custom_sections: true, applied_invoice_custom_sections: [] },
    });
    await expect(linkCount("section-skip")).resolves.toBe(0);

    const restored = await updateSubscriptionSections("section-skip", {
      skip_invoice_custom_sections: false,
      invoice_custom_section_codes: ["legal-v2"],
    });
    expect(restored).toMatchObject({
      subscription: {
        skip_invoice_custom_sections: false,
        applied_invoice_custom_sections: [{ invoice_custom_section: { code: "legal-v2" } }],
      },
    });
    await expect(linkCount("section-skip")).resolves.toBe(1);
  });

  it("preserves pending-row attachments but starts new active generations from explicit input", async () => {
    await createSection("generation", "Generation", "Generation terms", null);
    expect(
      (
        await createSubscription(
          "pending-sections",
          "customer-plan-sections",
          "sections-pending",
          {
            invoice_custom_section_codes: ["generation"],
          },
          "2099-01-01T00:00:00.000Z",
        )
      ).status,
    ).toBe(200);
    const pendingChange = await createSubscription(
      "pending-sections",
      "customer-plan-sections",
      "sections-pending-next",
    );
    expect(pendingChange.status).toBe(200);
    await expect(pendingChange.json()).resolves.toMatchObject({
      subscription: {
        status: "pending",
        plan_code: "sections-pending-next",
        applied_invoice_custom_sections: [{ invoice_custom_section: { code: "generation" } }],
      },
    });

    expect(
      (
        await createSubscription(
          "upgrade-without-sections",
          "customer-plan-sections",
          "sections-active",
          {
            invoice_custom_section_codes: ["generation"],
          },
        )
      ).status,
    ).toBe(200);
    const upgradeWithout = await createSubscription(
      "upgrade-without-sections",
      "customer-plan-sections",
      "sections-upgrade",
    );
    expect(upgradeWithout.status).toBe(200);
    await expect(upgradeWithout.json()).resolves.toMatchObject({
      subscription: { plan_code: "sections-upgrade", applied_invoice_custom_sections: [] },
    });
    await expect(upgradeSnapshotCount("upgrade-without-sections")).resolves.toBe(0);

    expect(
      (
        await createSubscription(
          "upgrade-with-sections",
          "customer-plan-sections",
          "sections-active",
        )
      ).status,
    ).toBe(200);
    const upgradeWith = await createSubscription(
      "upgrade-with-sections",
      "customer-plan-sections",
      "sections-upgrade",
      { invoice_custom_section_codes: ["generation"] },
    );
    expect(upgradeWith.status).toBe(200);
    await expect(upgradeWith.json()).resolves.toMatchObject({
      subscription: {
        plan_code: "sections-upgrade",
        applied_invoice_custom_sections: [{ invoice_custom_section: { code: "generation" } }],
      },
    });
    await expect(upgradeSnapshotCount("upgrade-with-sections")).resolves.toBe(1);

    expect(
      (
        await createSubscription(
          "downgrade-without-sections",
          "customer-plan-sections",
          "sections-high",
          { invoice_custom_section_codes: ["generation"] },
        )
      ).status,
    ).toBe(200);
    expect(
      (
        await createSubscription(
          "downgrade-without-sections",
          "customer-plan-sections",
          "sections-low",
        )
      ).status,
    ).toBe(200);
    await expect(pendingGenerationState("downgrade-without-sections")).resolves.toEqual({
      links: 0,
      skip_invoice_custom_sections: 0,
    });

    expect(
      (
        await createSubscription(
          "downgrade-with-sections",
          "customer-plan-sections",
          "sections-high",
        )
      ).status,
    ).toBe(200);
    expect(
      (
        await createSubscription(
          "downgrade-with-sections",
          "customer-plan-sections",
          "sections-low",
          { invoice_custom_section_codes: ["generation"] },
        )
      ).status,
    ).toBe(200);
    await expect(pendingGenerationState("downgrade-with-sections")).resolves.toEqual({
      links: 1,
      skip_invoice_custom_sections: 0,
    });
  });

  it("rejects cross-tenant relationship injection at the D1 boundary", async () => {
    const section = await createSection("tenant-guard", "Tenant guard", "Guard", null);
    await expect(
      env.BILLING_DB.prepare(
        `INSERT INTO subscriptions_invoice_custom_sections
         (subscription_id, invoice_custom_section_id, organization_id, created_at)
         VALUES ('subscription-sections-other', ?, 'org-sections-other', ?)`,
      )
        .bind(section.lago_id, "2026-08-13T00:00:00.000Z")
        .run(),
    ).rejects.toThrow("invalid_subscription_invoice_custom_section_tenant");
    await expect(
      env.BILLING_DB.prepare(
        "SELECT COUNT(*) AS count FROM subscriptions_invoice_custom_sections WHERE subscription_id = 'subscription-sections-other'",
      ).first(),
    ).resolves.toEqual({ count: 0 });

    expect(
      (
        await createSubscription("tenant-guard-valid", "customer-sections", "sections-prepaid", {
          invoice_custom_section_codes: ["tenant-guard"],
        })
      ).status,
    ).toBe(200);
    const valid = await env.BILLING_DB.prepare(
      `SELECT link.subscription_id, link.invoice_custom_section_id, i.id AS invoice_id,
              snapshot.id AS snapshot_id
       FROM subscriptions_invoice_custom_sections link
       JOIN subscriptions s ON s.id = link.subscription_id
       JOIN invoices i ON i.subscription_id = s.id
       JOIN applied_invoice_custom_sections snapshot ON snapshot.invoice_id = i.id
       WHERE s.external_id = 'tenant-guard-valid' LIMIT 1`,
    ).first<{
      subscription_id: string;
      invoice_custom_section_id: string;
      invoice_id: string;
      snapshot_id: string;
    }>();
    expect(valid).toBeTruthy();
    await expect(
      env.BILLING_DB.prepare(
        `UPDATE subscriptions_invoice_custom_sections SET organization_id = 'org-sections-other'
         WHERE subscription_id = ? AND invoice_custom_section_id = ?`,
      )
        .bind(valid!.subscription_id, valid!.invoice_custom_section_id)
        .run(),
    ).rejects.toThrow("immutable_subscription_invoice_custom_section_identity");
    await expect(
      env.BILLING_DB.prepare(
        `INSERT INTO applied_invoice_custom_sections
         (id, invoice_id, organization_id, invoice_custom_section_id, code, name, details,
          created_at)
         VALUES ('cross-tenant-snapshot', ?, 'org-sections-other', NULL, 'cross', 'Cross',
                 'Cross', ?)`,
      )
        .bind(valid!.invoice_id, "2026-08-13T00:00:00.000Z")
        .run(),
    ).rejects.toThrow("invalid_applied_invoice_custom_section_tenant");
    await expect(
      env.BILLING_DB.prepare(
        "UPDATE applied_invoice_custom_sections SET details = 'mutated' WHERE id = ?",
      )
        .bind(valid!.snapshot_id)
        .run(),
    ).rejects.toThrow("immutable_applied_invoice_custom_section");
  });
});

function sectionPayload(code: string, name: string, details: string, displayName: string | null) {
  return {
    invoice_custom_section: {
      code,
      name,
      details,
      display_name: displayName,
    },
  };
}

async function createSection(
  code: string,
  name: string,
  details: string,
  displayName: string | null,
) {
  const response = await api(
    "/api/v1/invoice_custom_sections",
    "POST",
    sectionPayload(code, name, details, displayName),
  );
  expect(response.status).toBe(200);
  return (await response.json<{ invoice_custom_section: { lago_id: string } }>())
    .invoice_custom_section;
}

function createSubscription(
  externalId: string,
  externalCustomerId: string,
  planCode: string,
  invoiceCustomSection?: {
    skip_invoice_custom_sections?: boolean;
    invoice_custom_section_codes?: string[];
  },
  subscriptionAt?: string,
) {
  return api("/api/v1/subscriptions", "POST", {
    subscription: {
      external_id: externalId,
      external_customer_id: externalCustomerId,
      plan_code: planCode,
      ...(subscriptionAt ? { subscription_at: subscriptionAt } : {}),
      ...(invoiceCustomSection ? { invoice_custom_section: invoiceCustomSection } : {}),
    },
  });
}

async function updateSubscriptionSections(
  externalId: string,
  invoiceCustomSection: {
    skip_invoice_custom_sections?: boolean;
    invoice_custom_section_codes?: string[];
  },
) {
  const response = await api(`/api/v1/subscriptions/${externalId}`, "PUT", {
    subscription: { invoice_custom_section: invoiceCustomSection },
  });
  expect(response.status).toBe(200);
  return response.json();
}

function invoiceFor(externalId: string) {
  return env.BILLING_DB.prepare(
    `SELECT i.id, i.status, i.ready_to_be_refreshed
     FROM invoices i JOIN subscriptions s ON s.id = i.subscription_id
     WHERE s.organization_id = 'org-sections' AND s.external_id = ?
     ORDER BY i.created_at DESC LIMIT 1`,
  )
    .bind(externalId)
    .first<{ id: string; status: string; ready_to_be_refreshed: number }>();
}

function snapshotState(invoiceId: string) {
  return env.BILLING_DB.prepare(
    `SELECT i.status, i.ready_to_be_refreshed, section.code, section.details
     FROM invoices i LEFT JOIN applied_invoice_custom_sections section ON section.invoice_id = i.id
     WHERE i.id = ? LIMIT 1`,
  )
    .bind(invoiceId)
    .first<{
      status: string;
      ready_to_be_refreshed: number;
      code: string | null;
      details: string | null;
    }>();
}

async function linkCount(externalId: string) {
  const row = await env.BILLING_DB.prepare(
    `SELECT COUNT(*) AS count FROM subscriptions_invoice_custom_sections link
     JOIN subscriptions s ON s.id = link.subscription_id
     WHERE s.organization_id = 'org-sections' AND s.external_id = ?
       AND s.status IN ('active', 'past_due', 'pending')`,
  )
    .bind(externalId)
    .first<{ count: number }>();
  return row?.count ?? 0;
}

async function upgradeSnapshotCount(externalId: string) {
  const row = await env.BILLING_DB.prepare(
    `SELECT COUNT(*) AS count
     FROM applied_invoice_custom_sections section
     JOIN invoices i ON i.id = section.invoice_id
     JOIN plan_change_invoice_contexts context ON context.invoice_id = i.id
     JOIN subscriptions next ON next.id = context.next_subscription_id
     WHERE next.organization_id = 'org-sections' AND next.external_id = ?`,
  )
    .bind(externalId)
    .first<{ count: number }>();
  return row?.count ?? 0;
}

function pendingGenerationState(externalId: string) {
  return env.BILLING_DB.prepare(
    `SELECT s.skip_invoice_custom_sections,
            (SELECT COUNT(*) FROM subscriptions_invoice_custom_sections link
             WHERE link.subscription_id = s.id) AS links
     FROM subscriptions s
     WHERE s.organization_id = 'org-sections' AND s.external_id = ?
       AND s.status = 'pending' AND s.previous_subscription_id IS NOT NULL
     ORDER BY s.generation DESC LIMIT 1`,
  )
    .bind(externalId)
    .first<{ skip_invoice_custom_sections: number; links: number }>();
}

function api(
  path: string,
  method = "GET",
  body?: Record<string, unknown>,
  key = apiKey,
): Promise<Response> {
  return SELF.fetch(`https://lago.test${path}`, {
    method,
    headers: { ...headers, Authorization: `Bearer ${key}` },
    body: body ? JSON.stringify(body) : undefined,
  });
}

async function apiJson(path: string): Promise<unknown> {
  const response = await api(path);
  expect(response.status).toBe(200);
  return response.json();
}
