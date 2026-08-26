import { env, SELF } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { sha256Hex } from "../src/auth/api-key";

const currentKey = "api-key-lifecycle-current";
const lastKey = "api-key-lifecycle-last";
const otherKey = "api-key-lifecycle-other";
const headers = { Authorization: `Bearer ${currentKey}`, "Content-Type": "application/json" };

beforeEach(async () => {
  const now = "2026-08-14T00:00:00.000Z";
  await env.BILLING_DB.batch([
    env.BILLING_DB.prepare(
      `INSERT OR IGNORE INTO organizations (id, external_id, name, created_at, updated_at)
       VALUES ('org-api-key-lifecycle', 'api-key-lifecycle', 'API Key Lifecycle', ?, ?)`,
    ).bind(now, now),
    env.BILLING_DB.prepare(
      `INSERT OR IGNORE INTO api_keys
       (id, organization_id, key_prefix, key_hash, created_at, revoked_at, name, value_ending,
        updated_at)
       VALUES ('key-api-key-current', 'org-api-key-lifecycle', 'api-key-curr', ?, ?, NULL,
               'Current', 'ent', ?)`,
    ).bind(await sha256Hex(currentKey), now, now),
    env.BILLING_DB.prepare(
      `INSERT OR IGNORE INTO organizations (id, external_id, name, created_at, updated_at)
       VALUES ('org-api-key-last', 'api-key-last', 'API Key Last', ?, ?)`,
    ).bind(now, now),
    env.BILLING_DB.prepare(
      `INSERT OR IGNORE INTO api_keys
       (id, organization_id, key_prefix, key_hash, created_at, revoked_at, name, value_ending,
        updated_at)
       VALUES ('key-api-key-last', 'org-api-key-last', 'api-key-last', ?, ?, NULL,
               'Last', 'ast', ?)`,
    ).bind(await sha256Hex(lastKey), now, now),
    env.BILLING_DB.prepare(
      `INSERT OR IGNORE INTO organizations (id, external_id, name, created_at, updated_at)
       VALUES ('org-api-key-other', 'api-key-other', 'API Key Other', ?, ?)`,
    ).bind(now, now),
    env.BILLING_DB.prepare(
      `INSERT OR IGNORE INTO api_keys
       (id, organization_id, key_prefix, key_hash, created_at, revoked_at, name, value_ending,
        updated_at)
       VALUES ('key-api-key-other', 'org-api-key-other', 'api-key-othe', ?, ?, NULL,
               'Other', 'her', ?)`,
    ).bind(await sha256Hex(otherKey), now, now),
  ]);
});

describe("API key lifecycle", () => {
  it("creates a hashed key, returns plaintext once, and lists only a sanitized value", async () => {
    const created = await api("/api/v1/api_keys", "POST", { api_key: { name: "Automation" } });
    expect(created.status).toBe(200);
    const body = await created.json<{
      api_key: { id: string; name: string; value: string; version: number };
    }>();
    expect(body.api_key).toMatchObject({ name: "Automation", version: 1 });
    expect(body.api_key.value).toMatch(/^lago_[0-9a-f]{64}$/);

    const stored = await env.BILLING_DB.prepare(
      `SELECT key_hash, value_ending, permissions_json FROM api_keys WHERE id = ?`,
    )
      .bind(body.api_key.id)
      .first<{ key_hash: string; value_ending: string; permissions_json: string }>();
    expect(stored).toEqual({
      key_hash: await sha256Hex(body.api_key.value),
      value_ending: body.api_key.value.slice(-3),
      permissions_json: "{}",
    });
    expect(JSON.stringify(stored)).not.toContain(body.api_key.value);

    const authenticated = await SELF.fetch("https://lago.test/api/v1/api_keys", {
      headers: { Authorization: `Bearer ${body.api_key.value}` },
    });
    expect(authenticated.status).toBe(200);
    const listed = await authenticated.json<{
      api_keys: Array<{ id: string; value: string }>;
      meta: { total_count: number };
    }>();
    expect(listed.meta.total_count).toBe(2);
    expect(listed.api_keys.find((key) => key.id === body.api_key.id)?.value).toBe(
      `••••••••${body.api_key.value.slice(-3)}`,
    );
    expect(JSON.stringify(listed)).not.toContain(body.api_key.value);

    const events = await env.BILLING_DB.prepare(
      `SELECT payload_json FROM outbox_events
       WHERE organization_id = 'org-api-key-lifecycle' AND aggregate_id = ?`,
    )
      .bind(body.api_key.id)
      .all<{ payload_json: string }>();
    expect(events.results).toHaveLength(1);
    expect(JSON.stringify(events.results)).not.toContain(body.api_key.value);
  });

  it("updates, rotates, revokes, and invalidates credentials atomically", async () => {
    const created = await api("/api/v1/api_keys", "POST", { api_key: { name: "Before" } });
    const createdBody = await created.json<{ api_key: { id: string; value: string } }>();

    const updated = await api(`/api/v1/api_keys/${createdBody.api_key.id}`, "PUT", {
      api_key: { name: "After" },
    });
    expect(updated.status).toBe(200);
    await expect(updated.json()).resolves.toMatchObject({
      api_key: { id: createdBody.api_key.id, name: "After", version: 2 },
    });

    const permissions = await api(`/api/v1/api_keys/${createdBody.api_key.id}`, "PUT", {
      api_key: { permissions: { invoices: ["read"] } },
    });
    expect(permissions.status).toBe(422);
    await expect(permissions.json()).resolves.toMatchObject({
      code: "unsupported_api_key_permissions",
    });

    const rotated = await api(`/api/v1/api_keys/${createdBody.api_key.id}/rotate`, "POST", {
      api_key: { name: "Rotated" },
    });
    expect(rotated.status).toBe(200);
    const rotatedBody = await rotated.json<{ api_key: { id: string; value: string } }>();
    expect(rotatedBody.api_key.id).not.toBe(createdBody.api_key.id);
    expect(rotatedBody.api_key.value).toMatch(/^lago_[0-9a-f]{64}$/);

    expect(await authStatus(createdBody.api_key.value)).toBe(401);
    expect(await authStatus(rotatedBody.api_key.value)).toBe(200);

    const revoked = await api(`/api/v1/api_keys/${rotatedBody.api_key.id}`, "DELETE");
    expect(revoked.status).toBe(200);
    await expect(revoked.json()).resolves.toMatchObject({
      api_key: { id: rotatedBody.api_key.id, revoked_at: expect.any(String) },
    });
    expect(await authStatus(rotatedBody.api_key.value)).toBe(401);

    const eventTypes = await env.BILLING_DB.prepare(
      `SELECT event_type FROM outbox_events WHERE organization_id = 'org-api-key-lifecycle'
         AND aggregate_id IN (?, ?)
       ORDER BY occurred_at, event_type`,
    )
      .bind(createdBody.api_key.id, rotatedBody.api_key.id)
      .all<{ event_type: string }>();
    expect(eventTypes.results.map((event) => event.event_type).sort()).toEqual([
      "api_key.created",
      "api_key.revoked",
      "api_key.rotated",
      "api_key.updated",
    ]);
  });

  it("protects the last non-expiring key and enforces tenant isolation", async () => {
    const lastResponse = await SELF.fetch("https://lago.test/api/v1/api_keys/key-api-key-last", {
      method: "DELETE",
      headers: { Authorization: `Bearer ${lastKey}` },
    });
    expect(lastResponse.status).toBe(422);
    await expect(lastResponse.json()).resolves.toMatchObject({
      code: "last_non_expiring_api_key",
    });
    expect(await authStatus(lastKey)).toBe(200);

    const crossTenant = await api("/api/v1/api_keys/key-api-key-other");
    expect(crossTenant.status).toBe(404);
    await expect(crossTenant.json()).resolves.toMatchObject({ code: "api_key_not_found" });
  });

  it("rejects expired keys and excludes them from the active list", async () => {
    const expiredValue = "api-key-expired-value";
    await env.BILLING_DB.prepare(
      `INSERT INTO api_keys
       (id, organization_id, key_prefix, key_hash, created_at, revoked_at, name,
        value_ending, expires_at, updated_at)
       VALUES ('key-api-key-expired', 'org-api-key-lifecycle', 'api-key-expi', ?,
               '2026-08-13T00:00:00.000Z', NULL, 'Expired', 'red',
               '2026-08-14T00:00:00.000Z', '2026-08-14T00:00:00.000Z')`,
    )
      .bind(await sha256Hex(expiredValue))
      .run();
    expect(await authStatus(expiredValue)).toBe(401);

    const active = await api("/api/v1/api_keys?status=active");
    const activeBody = await active.json<{ api_keys: Array<{ id: string }> }>();
    expect(activeBody.api_keys.map((key) => key.id)).not.toContain("key-api-key-expired");
    const revoked = await api("/api/v1/api_keys?status=revoked");
    const revokedBody = await revoked.json<{ api_keys: Array<{ id: string }> }>();
    expect(revokedBody.api_keys.map((key) => key.id)).toContain("key-api-key-expired");
  });

  it("rolls back key creation when audit evidence cannot commit", async () => {
    await env.BILLING_DB.prepare(
      `CREATE TRIGGER reject_api_key_audit BEFORE INSERT ON outbox_events
       WHEN NEW.event_type = 'api_key.created'
       BEGIN SELECT RAISE(ABORT, 'synthetic_api_key_audit_failure'); END`,
    ).run();
    const response = await api("/api/v1/api_keys", "POST", {
      api_key: { name: "Must Roll Back" },
    });
    expect(response.status).toBe(500);
    await expect(
      env.BILLING_DB.prepare(
        `SELECT COUNT(*) AS total FROM api_keys
         WHERE organization_id = 'org-api-key-lifecycle' AND name = 'Must Roll Back'`,
      ).first(),
    ).resolves.toEqual({ total: 0 });
  });

  it("rejects stale key and rotation audit versions at the D1 boundary", async () => {
    const now = "2026-08-15T00:02:00.000Z";
    await expect(
      env.BILLING_DB.prepare(
        `INSERT INTO outbox_events
         (event_id, organization_id, event_type, event_version, aggregate_type, aggregate_id,
          aggregate_version, causation_id, correlation_id, payload_json, occurred_at, published_at)
         VALUES ('event-stale-api-key', 'org-api-key-lifecycle', 'api_key.updated', 1,
                 'api_key', 'key-api-key-current', 2, NULL, 'stale-api-key', '{}', ?, NULL)`,
      )
        .bind(now)
        .run(),
    ).rejects.toThrow(/api_key_outbox_version_conflict/);

    await expect(
      env.BILLING_DB.prepare(
        `INSERT INTO outbox_events
         (event_id, organization_id, event_type, event_version, aggregate_type, aggregate_id,
          aggregate_version, causation_id, correlation_id, payload_json, occurred_at, published_at)
         VALUES ('event-stale-rotation', 'org-api-key-lifecycle', 'api_key.rotated', 1,
                 'api_key', 'key-api-key-current', 1, NULL, 'stale-rotation',
                 '{"replaced_api_key_id":"key-api-key-current","previous_version":2}', ?, NULL)`,
      )
        .bind(now)
        .run(),
    ).rejects.toThrow(/api_key_rotation_version_conflict/);
  });
});

function api(path: string, method = "GET", body?: unknown): Promise<Response> {
  return SELF.fetch(`https://lago.test${path}`, {
    method,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

async function authStatus(value: string): Promise<number> {
  return (
    await SELF.fetch("https://lago.test/api/v1/api_keys", {
      headers: { Authorization: `Bearer ${value}` },
    })
  ).status;
}
