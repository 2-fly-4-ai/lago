import { env, SELF } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { sha256Hex } from "../src/auth/api-key";
import { finalizeDueInvoices } from "../src/schedules/maintenance";

const apiKey = "draft-termination-credit-key";
const headers = { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" };

beforeEach(async () => {
  const now = "2026-08-14T00:00:00.000Z";
  await env.BILLING_DB.batch([
    env.BILLING_DB.prepare(
      `INSERT OR IGNORE INTO organizations (id, external_id, name, created_at, updated_at)
       VALUES ('org-draft-termination-credit', 'draft-termination-credit',
               'Draft termination credit', ?, ?)`,
    ).bind(now, now),
    env.BILLING_DB.prepare(
      `INSERT OR IGNORE INTO api_keys
       (id, organization_id, key_prefix, key_hash, created_at, revoked_at)
       VALUES ('key-draft-termination-credit', 'org-draft-termination-credit',
               'draft-credit', ?, ?, NULL)`,
    ).bind(await sha256Hex(apiKey), now),
  ]);
});

describe("pay-in-advance grace-period termination credits", () => {
  it("keeps the credit draft-coupled, reprices it, and commits it before the termination invoice", async () => {
    const scenario = await createScenario("manual");
    const terminated = await api(
      `/api/v1/subscriptions/${scenario.externalSubscriptionId}`,
      "DELETE",
    );
    expect(terminated.status).toBe(200);

    const drafts = await draftPair(scenario.subscriptionId);
    expect(drafts).toHaveLength(2);
    const source = requireContext(drafts, "initial");
    const termination = requireContext(drafts, "termination");
    const initialCredit = await terminationCredit(scenario.subscriptionId);
    expect(initialCredit).toMatchObject({
      allocation_state: "draft",
      credit_events: 0,
      applications: 0,
    });
    expect(initialCredit?.total_amount_minor).toBeGreaterThan(25);
    expect(termination).toMatchObject({
      status: "draft",
      subtotal_minor: 25,
      credit_notes_minor: 0,
      total_due_minor: 25,
    });

    const shownDraft = await api(`/api/v1/credit_notes/${initialCredit?.id}`);
    expect(shownDraft.status).toBe(200);
    const voidDraft = await api(`/api/v1/credit_notes/${initialCredit?.id}/void`, "PUT");
    expect(voidDraft.status).toBe(422);
    await expect(voidDraft.json()).resolves.toMatchObject({ code: "credit_note_not_finalized" });

    const premature = await api(`/api/v1/invoices/${termination.id}/finalize`, "PUT");
    expect(premature.status).toBe(422);
    await expect(premature.json()).resolves.toMatchObject({
      code: "termination_credit_note_not_finalized",
    });

    const unsupportedWallet = await api("/api/v1/wallets", "POST", {
      wallet: {
        external_customer_id: scenario.externalCustomerId,
        code: "manual-source-adjustment",
        currency: "USD",
        rate_amount: "1",
        granted_credits: "20",
      },
    });
    expect(unsupportedWallet.status).toBe(200);
    const guardedRefresh = await api(`/api/v1/invoices/${source.id}/refresh`, "PUT");
    expect(guardedRefresh.status).toBe(422);
    await expect(guardedRefresh.json()).resolves.toMatchObject({
      code: "unsupported_draft_termination_credit_adjustment",
    });
    await env.BILLING_DB.batch([
      env.BILLING_DB.prepare(
        `DELETE FROM wallet_transactions WHERE wallet_id =
         (SELECT id FROM wallets WHERE customer_id = ? AND code = 'manual-source-adjustment')`,
      ).bind(scenario.customerId),
      env.BILLING_DB.prepare(
        "DELETE FROM wallets WHERE customer_id = ? AND code = 'manual-source-adjustment'",
      ).bind(scenario.customerId),
    ]);

    const repriced = await api(`/api/v1/plans/${scenario.planCode}`, "PUT", {
      plan: { amount_cents: 1200 },
    });
    expect(repriced.status).toBe(200);
    const refreshed = await api(`/api/v1/invoices/${source.id}/refresh`, "PUT");
    expect(refreshed.status).toBe(200);
    await expect(refreshed.json()).resolves.toMatchObject({
      invoice: { status: "draft", total_amount_cents: 1200, version_number: 2 },
    });
    const repricedCredit = await terminationCredit(scenario.subscriptionId);
    expect(repricedCredit).toMatchObject({ allocation_state: "draft", credit_events: 0 });
    expect(repricedCredit?.item_created_at).toBe(initialCredit?.item_created_at);
    expect(repricedCredit?.total_amount_minor).toBeGreaterThan(
      initialCredit?.total_amount_minor ?? Number.MAX_SAFE_INTEGER,
    );

    await env.BILLING_DB.prepare(
      `CREATE TRIGGER abort_draft_termination_credit_finalize
       BEFORE INSERT ON outbox_events
       WHEN NEW.aggregate_id = '${repricedCredit?.id}' AND NEW.event_type = 'credit_note.created'
       BEGIN SELECT RAISE(ABORT, 'synthetic_draft_credit_finalize_failure'); END`,
    ).run();
    const rolledBack = await api(`/api/v1/invoices/${source.id}/finalize`, "PUT");
    expect(rolledBack.status).toBe(500);
    await expect(
      env.BILLING_DB.prepare(
        `SELECT i.status, i.version, cn.allocation_state,
                (SELECT COUNT(*) FROM outbox_events o
                 WHERE o.aggregate_id = cn.id AND o.event_type = 'credit_note.created') AS events,
                cni.amount_minor
         FROM invoices i
         JOIN termination_credit_note_contexts tc ON tc.source_invoice_id = i.id
         JOIN credit_notes cn ON cn.id = tc.credit_note_id
         JOIN credit_note_items cni ON cni.credit_note_id = cn.id
         WHERE i.id = ?`,
      )
        .bind(source.id)
        .first(),
    ).resolves.toEqual({
      allocation_state: "draft",
      amount_minor: repricedCredit?.total_amount_minor,
      events: 0,
      status: "draft",
      version: 2,
    });
    await env.BILLING_DB.prepare("DROP TRIGGER abort_draft_termination_credit_finalize").run();

    const finalizedSource = await api(`/api/v1/invoices/${source.id}/finalize`, "PUT");
    expect(finalizedSource.status).toBe(200);
    await expect(finalizedSource.json()).resolves.toMatchObject({
      invoice: { status: "finalized", total_amount_cents: 1200, version_number: 3 },
    });
    const finalizedCredit = await terminationCredit(scenario.subscriptionId);
    expect(finalizedCredit).toMatchObject({ allocation_state: "finalized", credit_events: 1 });
    expect(finalizedCredit?.invoice_event_rowid).toBeLessThan(
      finalizedCredit?.credit_event_rowid ?? 0,
    );

    const wallet = await api("/api/v1/wallets", "POST", {
      wallet: {
        external_customer_id: scenario.externalCustomerId,
        code: "manual-credit-fallback",
        currency: "USD",
        rate_amount: "1",
        granted_credits: "10",
      },
    });
    expect(wallet.status).toBe(200);
    const finalizedTermination = await api(`/api/v1/invoices/${termination.id}/finalize`, "PUT");
    expect(finalizedTermination.status).toBe(200);
    await expect(finalizedTermination.json()).resolves.toMatchObject({
      invoice: {
        status: "finalized",
        sub_total_excluding_taxes_amount_cents: 25,
        credit_notes_amount_cents: 25,
        prepaid_credit_amount_cents: 0,
        total_amount_cents: 0,
      },
    });
    await expect(committedState(scenario.subscriptionId)).resolves.toMatchObject({
      applications: 1,
      applied_minor: 25,
      credit_events: 1,
      application_events: 1,
      wallet_outbound: 0,
      wallet_consumed: 0,
    });

    const replay = await api(`/api/v1/invoices/${termination.id}/finalize`, "PUT");
    expect(replay.status).toBe(200);
    await expect(committedState(scenario.subscriptionId)).resolves.toMatchObject({
      applications: 1,
      credit_events: 1,
      application_events: 1,
    });
    expect(
      (await api(`/api/v1/subscriptions/${scenario.externalSubscriptionId}`, "DELETE")).status,
    ).toBe(200);
    await expect(
      env.BILLING_DB.prepare(
        `SELECT (SELECT COUNT(*) FROM invoices WHERE subscription_id = ?) AS invoices,
                (SELECT COUNT(*) FROM termination_credit_note_contexts
                 WHERE subscription_id = ?) AS credit_contexts`,
      )
        .bind(scenario.subscriptionId, scenario.subscriptionId)
        .first(),
    ).resolves.toEqual({ credit_contexts: 1, invoices: 2 });
  });

  it("finalizes the due source before its coupled termination draft", async () => {
    const scenario = await createScenario("scheduled");
    expect(
      (await api(`/api/v1/subscriptions/${scenario.externalSubscriptionId}`, "DELETE")).status,
    ).toBe(200);
    const drafts = await draftPair(scenario.subscriptionId);
    const source = requireContext(drafts, "initial");
    const termination = requireContext(drafts, "termination");
    const cutoff = new Date().toISOString();
    await env.BILLING_DB.prepare(
      `UPDATE invoices SET expected_finalization_date = date(?)
       WHERE id IN (?, ?)`,
    )
      .bind(cutoff, source.id, termination.id)
      .run();

    await expect(finalizeDueInvoices(env, cutoff, "draft-credit-schedule")).resolves.toBe(2);
    await expect(finalizeDueInvoices(env, cutoff, "draft-credit-schedule-replay")).resolves.toBe(0);
    await expect(
      env.BILLING_DB.prepare(
        `SELECT
           (SELECT status FROM invoices WHERE id = ?) AS source_status,
           (SELECT status FROM invoices WHERE id = ?) AS termination_status,
           (SELECT allocation_state FROM credit_notes cn
            JOIN termination_credit_note_contexts tc ON tc.credit_note_id = cn.id
            WHERE tc.subscription_id = ?) AS allocation_state,
           (SELECT COUNT(*) FROM credit_note_applications cna
            WHERE cna.invoice_id = ?) AS applications`,
      )
        .bind(source.id, termination.id, scenario.subscriptionId, termination.id)
        .first(),
    ).resolves.toEqual({
      allocation_state: "finalized",
      applications: 1,
      source_status: "finalized",
      termination_status: "finalized",
    });
  });
});

type Scenario = {
  subscriptionId: string;
  customerId: string;
  externalSubscriptionId: string;
  externalCustomerId: string;
  planCode: string;
};

async function createScenario(suffix: string): Promise<Scenario> {
  const now = new Date().toISOString();
  const planId = `plan-draft-credit-${suffix}`;
  const planCode = `draft-credit-${suffix}`;
  const metricId = `metric-draft-credit-${suffix}`;
  await env.BILLING_DB.batch([
    env.BILLING_DB.prepare(
      `INSERT INTO plans
       (id, organization_id, code, name, interval, amount_minor, currency, pay_in_advance,
        version, active, created_at, updated_at)
       VALUES (?, 'org-draft-termination-credit', ?, 'Draft credit plan', 'monthly',
               1000, 'USD', 1, 1, 1, ?, ?)`,
    ).bind(planId, planCode, now, now),
    env.BILLING_DB.prepare(
      `INSERT INTO billable_metrics
       (id, organization_id, code, name, aggregation_type, field_name, recurring,
        properties_json, version, active, created_at, updated_at)
       VALUES (?, 'org-draft-termination-credit', ?, 'Draft credit units', 'sum_agg',
               'quantity', 0, '{}', 1, 1, ?, ?)`,
    ).bind(metricId, `draft-credit-units-${suffix}`, now, now),
    env.BILLING_DB.prepare(
      `INSERT INTO charges
       (id, organization_id, plan_id, billable_metric_id, code, charge_model,
        properties_json, invoiceable, pay_in_advance, prorated, min_amount_minor,
        version, active, created_at, updated_at)
       VALUES (?, 'org-draft-termination-credit', ?, ?, ?, 'standard',
               '{"amount":"2.5"}', 1, 0, 0, 0, 1, 1, ?, ?)`,
    ).bind(
      `charge-draft-credit-${suffix}`,
      planId,
      metricId,
      `draft-credit-charge-${suffix}`,
      now,
      now,
    ),
  ]);
  const externalCustomerId = `draft-credit-customer-${suffix}`;
  const customer = await api("/api/v1/customers", "POST", {
    customer: {
      external_id: externalCustomerId,
      currency: "USD",
      billing_configuration: { invoice_grace_period: 2 },
    },
  });
  expect(customer.status).toBe(200);
  const externalSubscriptionId = `draft-credit-subscription-${suffix}`;
  const subscription = await api("/api/v1/subscriptions", "POST", {
    subscription: {
      external_customer_id: externalCustomerId,
      external_id: externalSubscriptionId,
      plan_code: planCode,
    },
  });
  expect(subscription.status).toBe(200);
  const body = await subscription.json<{ subscription: { lago_id: string } }>();
  const period = await env.BILLING_DB.prepare(
    `SELECT s.current_period_start, s.customer_id, bm.code
     FROM subscriptions s JOIN plans p ON p.id = s.plan_id
     JOIN charges ch ON ch.plan_id = p.id
     JOIN billable_metrics bm ON bm.id = ch.billable_metric_id
     WHERE s.id = ?`,
  )
    .bind(body.subscription.lago_id)
    .first<{ current_period_start: string; customer_id: string; code: string }>();
  if (!period) throw new Error("scenario_subscription_not_found");
  const usageAt = new Date(
    Math.max(Date.now(), Date.parse(period.current_period_start) + 1),
  ).toISOString();
  await env.BILLING_DB.prepare(
    `INSERT INTO usage_events
     (id, organization_id, subscription_id, customer_id, billable_metric_id,
      transaction_id, code, timestamp, timestamp_ms, properties_json, request_sha256,
      archive_key, created_at)
     VALUES (?, 'org-draft-termination-credit', ?, ?, ?, ?, ?, ?, ?,
             '{"quantity":"10"}', ?, ?, ?)`,
  )
    .bind(
      `event-draft-credit-${suffix}`,
      body.subscription.lago_id,
      period.customer_id,
      metricId,
      `transaction-draft-credit-${suffix}`,
      period.code,
      usageAt,
      Date.parse(usageAt),
      `hash-draft-credit-${suffix}`,
      `archive-draft-credit-${suffix}`,
      usageAt,
    )
    .run();
  return {
    subscriptionId: body.subscription.lago_id,
    customerId: period.customer_id,
    externalSubscriptionId,
    externalCustomerId,
    planCode,
  };
}

type DraftRow = {
  id: string;
  context_type: "initial" | "termination";
  status: string;
  subtotal_minor: number;
  credit_notes_minor: number;
  total_due_minor: number;
};

async function draftPair(subscriptionId: string): Promise<DraftRow[]> {
  const rows = await env.BILLING_DB.prepare(
    `SELECT i.id, sic.context_type, i.status, i.subtotal_minor, i.credit_notes_minor,
            i.total_due_minor
     FROM invoices i JOIN subscription_invoice_contexts sic ON sic.invoice_id = i.id
     WHERE i.subscription_id = ? ORDER BY sic.context_type`,
  )
    .bind(subscriptionId)
    .all<DraftRow>();
  return rows.results;
}

function requireContext(rows: DraftRow[], context: DraftRow["context_type"]): DraftRow {
  const row = rows.find((candidate) => candidate.context_type === context);
  if (!row) throw new Error(`missing_${context}_draft`);
  return row;
}

async function terminationCredit(subscriptionId: string) {
  return env.BILLING_DB.prepare(
    `SELECT cn.id, cn.total_amount_minor, cn.balance_amount_minor, cn.allocation_state,
            cni.created_at AS item_created_at,
            (SELECT COUNT(*) FROM credit_note_applications cna
             WHERE cna.credit_note_id = cn.id) AS applications,
            (SELECT COUNT(*) FROM outbox_events o
             WHERE o.aggregate_id = cn.id AND o.event_type = 'credit_note.created') AS credit_events,
            (SELECT rowid FROM outbox_events o
             WHERE o.aggregate_id = tc.source_invoice_id AND o.event_type = 'invoice.finalized')
              AS invoice_event_rowid,
            (SELECT rowid FROM outbox_events o
             WHERE o.aggregate_id = cn.id AND o.event_type = 'credit_note.created')
              AS credit_event_rowid
     FROM termination_credit_note_contexts tc
     JOIN credit_notes cn ON cn.id = tc.credit_note_id
     JOIN credit_note_items cni ON cni.credit_note_id = cn.id
     WHERE tc.subscription_id = ?`,
  )
    .bind(subscriptionId)
    .first<{
      id: string;
      total_amount_minor: number;
      balance_amount_minor: number;
      allocation_state: string;
      item_created_at: string;
      applications: number;
      credit_events: number;
      invoice_event_rowid: number | null;
      credit_event_rowid: number | null;
    }>();
}

async function committedState(subscriptionId: string) {
  return env.BILLING_DB.prepare(
    `SELECT
       (SELECT COUNT(*) FROM credit_note_applications cna
        JOIN invoices i ON i.id = cna.invoice_id
        WHERE i.subscription_id = ?) AS applications,
       (SELECT amount_minor FROM credit_note_applications cna
        JOIN invoices i ON i.id = cna.invoice_id
        WHERE i.subscription_id = ?) AS applied_minor,
       (SELECT COUNT(*) FROM outbox_events o
        JOIN termination_credit_note_contexts tc ON tc.credit_note_id = o.aggregate_id
        WHERE tc.subscription_id = ? AND o.event_type = 'credit_note.created') AS credit_events,
       (SELECT COUNT(*) FROM outbox_events o
        JOIN termination_credit_note_contexts tc ON tc.credit_note_id = o.aggregate_id
        WHERE tc.subscription_id = ? AND o.event_type = 'credit_note.applied') AS application_events,
       (SELECT COUNT(*) FROM wallet_transactions wt JOIN wallets w ON w.id = wt.wallet_id
        JOIN subscriptions s ON s.customer_id = w.customer_id
        WHERE s.id = ? AND wt.transaction_type = 'outbound') AS wallet_outbound,
       (SELECT COALESCE(SUM(w.consumed_minor), 0) FROM wallets w
        JOIN subscriptions s ON s.customer_id = w.customer_id WHERE s.id = ?) AS wallet_consumed`,
  )
    .bind(
      subscriptionId,
      subscriptionId,
      subscriptionId,
      subscriptionId,
      subscriptionId,
      subscriptionId,
    )
    .first();
}

function api(path: string, method = "GET", body?: Record<string, unknown>): Promise<Response> {
  return SELF.fetch(`https://lago.test${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
}
