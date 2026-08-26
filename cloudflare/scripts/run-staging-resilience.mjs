import { createHash } from "node:crypto";
import assert from "node:assert/strict";

const phase = process.argv.slice(2).find((argument) => argument !== "--");
const runId = process.env.LAGO_SYNTHETIC_RUN_ID;
const apiKey = process.env.LAGO_SYNTHETIC_API_KEY;
const baseUrl =
  process.env.LAGO_SYNTHETIC_BASE_URL ?? "https://serp-dev-lago-native.serpcompany.workers.dev";

assert.match(runId ?? "", /^synthetic-resilience-\d{8}-\d{3}$/);
assert.ok(apiKey, "LAGO_SYNTHETIC_API_KEY is required");
assert.equal(new URL(baseUrl).origin, "https://serp-dev-lago-native.serpcompany.workers.dev");
assert.ok(["setup", "events", "verify"].includes(phase), "phase must be setup, events, or verify");

const codes = {
  customer: `${runId}-customer`,
  earlyEvent: `${runId}-event-early`,
  lateEvent: `${runId}-event-late`,
  metric: `${runId}-units`,
  plan: `${runId}-plan`,
  subscription: `${runId}-subscription`,
  wallet: `${runId}-wallet`,
};

const summary =
  phase === "setup"
    ? await setup()
    : phase === "events"
      ? await exerciseEvents()
      : await verifyCycleAndDocument();

console.log(JSON.stringify({ phase, runId, ...summary }));

async function setup() {
  const health = await fetch(`${baseUrl}/health`);
  const ready = await fetch(`${baseUrl}/ready`);
  assert.equal(health.status, 200);
  assert.equal(ready.status, 200);

  const metricPayload = {
    billable_metric: {
      name: "Synthetic resilience units",
      code: codes.metric,
      aggregation_type: "sum_agg",
      field_name: "units",
    },
  };
  const metric = await expectJson("/api/v1/billable_metrics", 200, metricPayload);
  const metricReplay = await expectJson("/api/v1/billable_metrics", 200, metricPayload);
  assert.equal(metricReplay.billable_metric.lago_id, metric.billable_metric.lago_id);

  const planPayload = {
    plan: {
      name: "Synthetic resilience plan",
      code: codes.plan,
      interval: "monthly",
      amount_cents: 900,
      amount_currency: "USD",
      pay_in_advance: false,
      charges: [
        {
          billable_metric_id: metric.billable_metric.lago_id,
          code: `${runId}-usage-charge`,
          charge_model: "standard",
          properties: { amount: "10" },
        },
      ],
    },
  };
  const plan = await expectJson("/api/v1/plans", 200, planPayload);
  const planReplay = await expectJson("/api/v1/plans", 200, planPayload);
  assert.equal(planReplay.plan.lago_id, plan.plan.lago_id);
  const planConflict = await expectJson("/api/v1/plans", 422, {
    plan: { ...planPayload.plan, amount_cents: 901 },
  });
  assert.equal(planConflict.code, "value_already_exist");

  const customerPayload = {
    customer: {
      external_id: codes.customer,
      name: "Synthetic resilience customer",
      currency: "USD",
      timezone: "UTC",
      metadata: [{ key: "synthetic_run_id", value: runId, display_in_invoice: false }],
    },
  };
  const customer = await expectJson("/api/v1/customers", 200, customerPayload);
  const customerReplay = await expectJson("/api/v1/customers", 200, customerPayload);
  assert.equal(customerReplay.customer.lago_id, customer.customer.lago_id);

  const subscriptionPayload = {
    subscription: {
      external_customer_id: codes.customer,
      external_id: codes.subscription,
      plan_code: codes.plan,
      billing_time: "anniversary",
    },
  };
  const subscription = await expectJson("/api/v1/subscriptions", 200, subscriptionPayload);
  const subscriptionReplay = await expectJson("/api/v1/subscriptions", 200, subscriptionPayload);
  assert.equal(subscriptionReplay.subscription.lago_id, subscription.subscription.lago_id);
  const subscriptionConflict = await expectJson("/api/v1/subscriptions", 409, {
    subscription: { ...subscriptionPayload.subscription, plan_code: `${runId}-different-plan` },
  });
  assert.equal(subscriptionConflict.code, "subscription_idempotency_conflict");

  const walletPayload = {
    wallet: {
      external_customer_id: codes.customer,
      name: "Synthetic resilience wallet",
      code: codes.wallet,
      currency: "USD",
      rate_amount: "1",
      granted_credits: "5",
      priority: 20,
    },
  };
  const wallet = await expectJson("/api/v1/wallets", 200, walletPayload);
  const walletReplay = await expectJson("/api/v1/wallets", 200, walletPayload);
  assert.equal(walletReplay.wallet.lago_id, wallet.wallet.lago_id);
  assert.equal(walletReplay.wallet.balance_cents, 500);

  return {
    health: health.status,
    ready: ready.status,
    metricId: metric.billable_metric.lago_id,
    planId: plan.plan.lago_id,
    customerId: customer.customer.lago_id,
    subscriptionId: subscription.subscription.lago_id,
    walletId: wallet.wallet.lago_id,
  };
}

async function exerciseEvents() {
  const later = eventPayload(codes.lateEvent, "2", "2026-08-10T00:00:00.000Z");
  const earlier = eventPayload(codes.earlyEvent, "1", "2026-08-05T00:00:00.000Z");
  const lateEvent = await expectJson("/api/v1/events", 200, later);
  const earlyEvent = await expectJson("/api/v1/events", 200, earlier);
  const replay = await expectJson("/api/v1/events", 200, later);
  assert.equal(replay.event.lago_id, lateEvent.event.lago_id);
  const conflict = await expectJson("/api/v1/events", 409, {
    event: { ...later.event, properties: { units: "9" } },
  });
  assert.equal(conflict.code, "event_idempotency_conflict");

  const usage = await expectJson(
    `/api/v1/customers/${encodeURIComponent(codes.customer)}/current_usage?external_subscription_id=${encodeURIComponent(codes.subscription)}`,
    200,
  );
  assert.ok(usage.customer_usage.total_amount_cents > 0);

  const invalidWebhook = await fetch(`${baseUrl}/webhooks/stripe/org-synthetic-e2e-20260815-001`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Stripe-Signature": "t=1,v1=invalid" },
    body: JSON.stringify({ id: `${runId}-invalid-webhook`, livemode: false }),
  });
  assert.equal(invalidWebhook.status, 401);

  return {
    earlyEventId: earlyEvent.event.lago_id,
    lateEventId: lateEvent.event.lago_id,
    usageAmountCents: usage.customer_usage.total_amount_cents,
    invalidWebhookStatus: invalidWebhook.status,
  };
}

async function verifyCycleAndDocument() {
  const listed = await expectJson(
    `/api/v1/invoices?external_customer_id=${encodeURIComponent(codes.customer)}`,
    200,
  );
  assert.equal(listed.meta.total_count, 1);
  const invoice = listed.invoices[0];
  assert.equal(invoice.status, "finalized");
  assert.ok(invoice.total_due_amount_cents > 0);

  const shown = await expectJson(`/api/v1/invoices/${encodeURIComponent(invoice.lago_id)}`, 200);
  assert.equal(shown.invoice.lago_id, invoice.lago_id);

  let document = await authenticatedFetch(
    `/api/v1/invoices/${encodeURIComponent(invoice.lago_id)}/download`,
    { method: "POST" },
  );
  assert.ok([200, 202].includes(document.status));
  for (let attempt = 0; document.status === 202 && attempt < 12; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5_000));
    document = await authenticatedFetch(
      `/api/v1/invoices/${encodeURIComponent(invoice.lago_id)}/download`,
      { method: "POST" },
    );
  }
  assert.equal(document.status, 200);
  assert.match(document.headers.get("content-type") ?? "", /^application\/pdf/);
  const pdf = new Uint8Array(await document.arrayBuffer());
  assert.equal(new TextDecoder().decode(pdf.subarray(0, 5)), "%PDF-");

  return {
    invoiceId: invoice.lago_id,
    invoiceTotalCents: invoice.total_due_amount_cents,
    invoiceVersion: shown.invoice.version_number,
    pdfBytes: pdf.byteLength,
    pdfSha256: createHash("sha256").update(pdf).digest("hex"),
  };
}

function eventPayload(transactionId, units, timestamp) {
  return {
    event: {
      transaction_id: transactionId,
      code: codes.metric,
      external_subscription_id: codes.subscription,
      timestamp: Date.parse(timestamp) / 1000,
      properties: { units },
    },
  };
}

async function expectJson(path, status, body) {
  const response = await authenticatedFetch(path, {
    method: body === undefined ? "GET" : "POST",
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const payload = await response.json();
  assert.equal(
    response.status,
    status,
    `${path} returned ${response.status}: ${JSON.stringify(payload)}`,
  );
  return payload;
}

function authenticatedFetch(path, init = {}) {
  return fetch(`${baseUrl}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      ...(init.body === undefined ? {} : { "Content-Type": "application/json" }),
      ...init.headers,
    },
  });
}
