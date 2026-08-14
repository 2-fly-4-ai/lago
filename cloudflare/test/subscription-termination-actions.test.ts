import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { sha256Hex } from "../src/auth/api-key";
import {
  terminateEndedSubscriptions,
  terminateSubscriptionWithoutInvoice,
} from "../src/billing/terminate-subscription";

describe("persisted subscription termination actions", () => {
  it("replays creation exactly and honors a stored invoice skip on manual termination", async () => {
    const tenant = await seedTenant("manual-skip");
    const input = {
      external_customer_id: tenant.externalCustomerId,
      external_id: "subscription-manual-skip",
      plan_code: tenant.arrearsPlanCode,
      on_termination_invoice: "skip",
    };
    const created = await api(tenant.apiKey, "/api/v1/subscriptions", "POST", {
      subscription: input,
    });
    expect(created.status).toBe(200);
    const createdBody = await created.json<{
      subscription: {
        lago_id: string;
        on_termination_credit_note: string | null;
        on_termination_invoice: string | null;
      };
    }>();
    expect(createdBody.subscription).toMatchObject({
      on_termination_credit_note: null,
      on_termination_invoice: "skip",
    });

    const replay = await api(tenant.apiKey, "/api/v1/subscriptions", "POST", {
      subscription: input,
    });
    expect(replay.status).toBe(200);
    await expect(replay.json()).resolves.toMatchObject({
      subscription: { lago_id: createdBody.subscription.lago_id },
    });
    const divergent = await api(tenant.apiKey, "/api/v1/subscriptions", "POST", {
      subscription: { ...input, on_termination_invoice: "generate" },
    });
    expect(divergent.status).toBe(409);
    await expect(divergent.json()).resolves.toMatchObject({
      code: "subscription_idempotency_conflict",
    });

    const path = "/api/v1/subscriptions/subscription-manual-skip";
    const terminated = await api(tenant.apiKey, path, "DELETE");
    expect(terminated.status).toBe(200);
    await expect(terminated.json()).resolves.toMatchObject({
      subscription: {
        status: "terminated",
        on_termination_credit_note: null,
        on_termination_invoice: "skip",
      },
    });
    expect((await api(tenant.apiKey, path, "DELETE")).status).toBe(200);
    await expect(subscriptionState(createdBody.subscription.lago_id)).resolves.toEqual({
      status: "terminated",
      version: 2,
      invoices: 0,
      credit_notes: 0,
      termination_events: 1,
    });

    const overridden = await createSubscription(
      tenant,
      "subscription-manual-override",
      tenant.arrearsPlanCode,
      { on_termination_invoice: "skip" },
    );
    const overrideResponse = await api(
      tenant.apiKey,
      "/api/v1/subscriptions/subscription-manual-override?on_termination_invoice=generate",
      "DELETE",
    );
    expect(overrideResponse.status).toBe(200);
    await expect(overrideResponse.json()).resolves.toMatchObject({
      subscription: { on_termination_invoice: "generate", status: "terminated" },
    });
    await expect(subscriptionState(overridden)).resolves.toMatchObject({
      invoices: 1,
      termination_events: 1,
    });
  });

  it("updates and clears ending_at safely, isolates tenants, and schedules stored skips once", async () => {
    const tenant = await seedTenant("scheduled-skip");
    const otherTenant = await seedTenant("scheduled-other");
    const subscriptionId = await createSubscription(
      tenant,
      "subscription-scheduled-skip",
      tenant.arrearsPlanCode,
    );
    const endingAt = new Date(Date.now() + 3 * 86_400_000).toISOString();
    const path = "/api/v1/subscriptions/subscription-scheduled-skip";

    const updated = await api(tenant.apiKey, path, "PUT", {
      subscription: { ending_at: endingAt, on_termination_invoice: "skip" },
    });
    expect(updated.status).toBe(200);
    await expect(updated.json()).resolves.toMatchObject({
      subscription: { ending_at: endingAt, on_termination_invoice: "skip" },
    });
    expect((await api(otherTenant.apiKey, path)).status).toBe(404);
    expect(
      (
        await api(otherTenant.apiKey, path, "PUT", {
          subscription: { ending_at: endingAt },
        })
      ).status,
    ).toBe(404);

    const cleared = await api(tenant.apiKey, path, "PUT", {
      subscription: { ending_at: null },
    });
    expect(cleared.status).toBe(200);
    await expect(cleared.json()).resolves.toMatchObject({
      subscription: { ending_at: null, on_termination_invoice: "skip" },
    });
    const past = await api(tenant.apiKey, path, "PUT", {
      subscription: { ending_at: "2020-01-01T00:00:00.000Z" },
    });
    expect(past.status).toBe(422);
    await expect(past.json()).resolves.toMatchObject({ code: "validation_error" });
    expect(
      (
        await api(tenant.apiKey, path, "PUT", {
          subscription: { ending_at: endingAt },
        })
      ).status,
    ).toBe(200);

    await expect(
      terminateEndedSubscriptions(
        env,
        new Date(Date.parse(endingAt) - 1).toISOString(),
        "stored-skip-before",
      ),
    ).resolves.toBe(0);
    await expect(terminateEndedSubscriptions(env, endingAt, "stored-skip-due")).resolves.toBe(1);
    await expect(terminateEndedSubscriptions(env, endingAt, "stored-skip-replay")).resolves.toBe(0);
    await expect(subscriptionState(subscriptionId)).resolves.toEqual({
      status: "terminated",
      version: 5,
      invoices: 0,
      credit_notes: 0,
      termination_events: 1,
    });
  });

  it("honors supported pay-in-advance credit actions and guards unsupported combinations", async () => {
    const tenant = await seedTenant("advance-actions");
    const credited = await createSubscription(
      tenant,
      "subscription-advance-credit",
      tenant.advancePlanCode,
      { on_termination_credit_note: "credit", on_termination_invoice: "skip" },
    );
    const creditTermination = await api(
      tenant.apiKey,
      "/api/v1/subscriptions/subscription-advance-credit",
      "DELETE",
    );
    expect(creditTermination.status).toBe(200);
    await expect(creditTermination.json()).resolves.toMatchObject({
      subscription: {
        status: "terminated",
        on_termination_credit_note: "credit",
        on_termination_invoice: "skip",
      },
    });
    await expect(subscriptionState(credited)).resolves.toEqual({
      status: "terminated",
      version: 2,
      invoices: 1,
      credit_notes: 1,
      termination_events: 1,
    });

    const generated = await createSubscription(
      tenant,
      "subscription-advance-generate",
      tenant.advancePlanCode,
      { on_termination_credit_note: "skip", on_termination_invoice: "generate" },
    );
    expect(
      (await api(tenant.apiKey, "/api/v1/subscriptions/subscription-advance-generate", "DELETE"))
        .status,
    ).toBe(200);
    await expect(subscriptionState(generated)).resolves.toEqual({
      status: "terminated",
      version: 2,
      invoices: 2,
      credit_notes: 0,
      termination_events: 1,
    });

    const refund = await api(tenant.apiKey, "/api/v1/subscriptions", "POST", {
      subscription: {
        external_customer_id: tenant.externalCustomerId,
        external_id: "subscription-advance-refund",
        plan_code: tenant.advancePlanCode,
        on_termination_credit_note: "refund",
      },
    });
    expect(refund.status).toBe(422);
    await expect(refund.json()).resolves.toMatchObject({
      code: "unsupported_termination_credit_note",
    });
    const arrearsCredit = await api(tenant.apiKey, "/api/v1/subscriptions", "POST", {
      subscription: {
        external_customer_id: tenant.externalCustomerId,
        external_id: "subscription-arrears-credit",
        plan_code: tenant.arrearsPlanCode,
        on_termination_credit_note: "credit",
      },
    });
    expect(arrearsCredit.status).toBe(422);
    await expect(arrearsCredit.json()).resolves.toMatchObject({ code: "validation_error" });
  });

  it("schedules pay-in-advance termination only with a persisted skip-credit action", async () => {
    const tenant = await seedTenant("advance-scheduled");
    const skipEndingAt = new Date(Date.now() + 3 * 86_400_000).toISOString();
    const skipped = await api(tenant.apiKey, "/api/v1/subscriptions", "POST", {
      subscription: {
        external_customer_id: tenant.externalCustomerId,
        external_id: "subscription-advance-scheduled-skip",
        plan_code: tenant.advancePlanCode,
        ending_at: skipEndingAt,
        on_termination_credit_note: "skip",
        on_termination_invoice: "skip",
      },
    });
    expect(skipped.status).toBe(200);
    const skippedBody = await skipped.json<{ subscription: { lago_id: string } }>();
    const skippedReplay = await api(tenant.apiKey, "/api/v1/subscriptions", "POST", {
      subscription: {
        external_customer_id: tenant.externalCustomerId,
        external_id: "subscription-advance-scheduled-skip",
        plan_code: tenant.advancePlanCode,
        ending_at: skipEndingAt,
        on_termination_credit_note: "skip",
        on_termination_invoice: "skip",
      },
    });
    expect(skippedReplay.status).toBe(200);

    const generatedEndingAt = new Date(Date.parse(skipEndingAt) + 86_400_000).toISOString();
    const generated = await api(tenant.apiKey, "/api/v1/subscriptions", "POST", {
      subscription: {
        external_customer_id: tenant.externalCustomerId,
        external_id: "subscription-advance-scheduled-generate",
        plan_code: tenant.advancePlanCode,
        ending_at: generatedEndingAt,
        on_termination_credit_note: "skip",
        on_termination_invoice: "generate",
      },
    });
    expect(generated.status).toBe(200);
    const generatedBody = await generated.json<{ subscription: { lago_id: string } }>();

    const guarded = await api(tenant.apiKey, "/api/v1/subscriptions", "POST", {
      subscription: {
        external_customer_id: tenant.externalCustomerId,
        external_id: "subscription-advance-scheduled-credit",
        plan_code: tenant.advancePlanCode,
        ending_at: generatedEndingAt,
        on_termination_credit_note: "credit",
      },
    });
    expect(guarded.status).toBe(422);
    await expect(guarded.json()).resolves.toMatchObject({
      code: "unsupported_scheduled_termination",
    });

    await expect(
      terminateEndedSubscriptions(env, skipEndingAt, "advance-scheduled-skip"),
    ).resolves.toBe(1);
    await expect(
      terminateEndedSubscriptions(env, skipEndingAt, "advance-scheduled-skip-replay"),
    ).resolves.toBe(0);
    await expect(subscriptionState(skippedBody.subscription.lago_id)).resolves.toEqual({
      status: "terminated",
      version: 2,
      invoices: 1,
      credit_notes: 0,
      termination_events: 1,
    });
    await expect(
      terminateEndedSubscriptions(env, generatedEndingAt, "advance-scheduled-generate"),
    ).resolves.toBe(1);
    await expect(subscriptionState(generatedBody.subscription.lago_id)).resolves.toEqual({
      status: "terminated",
      version: 2,
      invoices: 2,
      credit_notes: 0,
      termination_events: 1,
    });

    const updatedId = await createSubscription(
      tenant,
      "subscription-advance-scheduled-update",
      tenant.advancePlanCode,
    );
    const updatePath = "/api/v1/subscriptions/subscription-advance-scheduled-update";
    const missingSkip = await api(tenant.apiKey, updatePath, "PUT", {
      subscription: { ending_at: generatedEndingAt },
    });
    expect(missingSkip.status).toBe(422);
    const supported = await api(tenant.apiKey, updatePath, "PUT", {
      subscription: {
        ending_at: generatedEndingAt,
        on_termination_credit_note: "skip",
        on_termination_invoice: "skip",
      },
    });
    expect(supported.status).toBe(200);
    const incompatibleUpdate = await api(tenant.apiKey, updatePath, "PUT", {
      subscription: { on_termination_credit_note: "credit" },
    });
    expect(incompatibleUpdate.status).toBe(422);
    await expect(incompatibleUpdate.json()).resolves.toMatchObject({
      code: "unsupported_scheduled_termination",
    });
    const cleared = await api(tenant.apiKey, updatePath, "PUT", {
      subscription: { ending_at: null, on_termination_credit_note: "credit" },
    });
    expect(cleared.status).toBe(200);
    await expect(cleared.json()).resolves.toMatchObject({
      subscription: {
        lago_id: updatedId,
        ending_at: null,
        on_termination_credit_note: "credit",
      },
    });
  });

  it("rolls back a failed no-invoice batch and never leaves an orphan conflict event", async () => {
    const tenant = await seedTenant("atomic-skip");
    const subscriptionId = await createSubscription(
      tenant,
      "subscription-atomic-skip",
      tenant.arrearsPlanCode,
      { on_termination_invoice: "skip" },
    );
    await env.BILLING_DB.prepare(
      `CREATE TRIGGER abort_no_invoice_termination
       BEFORE INSERT ON outbox_events
       WHEN NEW.aggregate_id = '${subscriptionId}' AND NEW.event_type = 'subscription.terminated'
       BEGIN SELECT RAISE(ABORT, 'synthetic_no_invoice_termination_failure'); END`,
    ).run();
    await expect(
      terminateSubscriptionWithoutInvoice(
        env,
        subscriptionId,
        1,
        "2026-08-20T00:00:00.000Z",
        "atomic-skip-failure",
        false,
      ),
    ).rejects.toThrow();
    await env.BILLING_DB.prepare("DROP TRIGGER abort_no_invoice_termination").run();
    await expect(subscriptionState(subscriptionId)).resolves.toEqual({
      status: "active",
      version: 1,
      invoices: 0,
      credit_notes: 0,
      termination_events: 0,
    });

    await expect(
      terminateSubscriptionWithoutInvoice(
        env,
        subscriptionId,
        99,
        "2026-08-20T00:00:00.000Z",
        "atomic-skip-conflict",
        false,
      ),
    ).rejects.toThrow("subscription_version_conflict");
    await expect(subscriptionState(subscriptionId)).resolves.toEqual({
      status: "active",
      version: 1,
      invoices: 0,
      credit_notes: 0,
      termination_events: 0,
    });
  });
});

type Tenant = {
  organizationId: string;
  apiKey: string;
  externalCustomerId: string;
  arrearsPlanCode: string;
  advancePlanCode: string;
};

async function seedTenant(suffix: string): Promise<Tenant> {
  const now = new Date().toISOString();
  const organizationId = `org-termination-actions-${suffix}`;
  const apiKey = `termination-actions-key-${suffix}`;
  const customerId = `customer-termination-actions-${suffix}`;
  const externalCustomerId = `customer-${suffix}`;
  const arrearsPlanCode = `arrears-${suffix}`;
  const advancePlanCode = `advance-${suffix}`;
  await env.BILLING_DB.batch([
    env.BILLING_DB.prepare(
      `INSERT INTO organizations (id, external_id, name, created_at, updated_at)
       VALUES (?, ?, 'Termination actions', ?, ?)`,
    ).bind(organizationId, `termination-actions-${suffix}`, now, now),
    env.BILLING_DB.prepare(
      `INSERT INTO api_keys
       (id, organization_id, key_prefix, key_hash, created_at, revoked_at)
       VALUES (?, ?, ?, ?, ?, NULL)`,
    ).bind(
      `key-termination-actions-${suffix}`,
      organizationId,
      `term-${suffix}`,
      await sha256Hex(apiKey),
      now,
    ),
    env.BILLING_DB.prepare(
      `INSERT INTO customers
       (id, organization_id, external_id, currency, metadata_json, created_at, updated_at)
       VALUES (?, ?, ?, 'USD', '{}', ?, ?)`,
    ).bind(customerId, organizationId, externalCustomerId, now, now),
    env.BILLING_DB.prepare(
      `INSERT INTO plans
       (id, organization_id, code, name, interval, amount_minor, currency, pay_in_advance,
        version, active, created_at, updated_at)
       VALUES (?, ?, ?, 'Arrears plan', 'monthly', 1000, 'USD', 0, 1, 1, ?, ?)`,
    ).bind(`plan-arrears-${suffix}`, organizationId, arrearsPlanCode, now, now),
    env.BILLING_DB.prepare(
      `INSERT INTO plans
       (id, organization_id, code, name, interval, amount_minor, currency, pay_in_advance,
        version, active, created_at, updated_at)
       VALUES (?, ?, ?, 'Advance plan', 'monthly', 1000, 'USD', 1, 1, 1, ?, ?)`,
    ).bind(`plan-advance-${suffix}`, organizationId, advancePlanCode, now, now),
  ]);
  return { organizationId, apiKey, externalCustomerId, arrearsPlanCode, advancePlanCode };
}

async function createSubscription(
  tenant: Tenant,
  externalId: string,
  planCode: string,
  actions: Record<string, unknown> = {},
): Promise<string> {
  const response = await api(tenant.apiKey, "/api/v1/subscriptions", "POST", {
    subscription: {
      external_customer_id: tenant.externalCustomerId,
      external_id: externalId,
      plan_code: planCode,
      ...actions,
    },
  });
  expect(response.status).toBe(200);
  const body = await response.json<{ subscription: { lago_id: string } }>();
  return body.subscription.lago_id;
}

async function subscriptionState(subscriptionId: string): Promise<Record<string, unknown> | null> {
  return env.BILLING_DB.prepare(
    `SELECT s.status, s.version,
            (SELECT COUNT(*) FROM invoices i WHERE i.subscription_id = s.id) AS invoices,
            (SELECT COUNT(*) FROM credit_notes cn JOIN invoices i ON i.id = cn.invoice_id
              WHERE i.subscription_id = s.id) AS credit_notes,
            (SELECT COUNT(*) FROM outbox_events o WHERE o.aggregate_id = s.id
              AND o.event_type = 'subscription.terminated') AS termination_events
     FROM subscriptions s WHERE s.id = ?`,
  )
    .bind(subscriptionId)
    .first<Record<string, unknown>>();
}

function api(
  apiKey: string,
  path: string,
  method = "GET",
  body?: Record<string, unknown>,
): Promise<Response> {
  return SELF.fetch(`https://lago.test${path}`, {
    method,
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
}
