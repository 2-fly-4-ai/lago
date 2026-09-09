import { env } from "cloudflare:test";
import { expect, it } from "vitest";
import { pendingEasyPayDirectExecutions } from "../src/reconciliation/easy-pay-direct";

it("quarantines 101 unknown historical transports without starving new work or historical tax commits", async () => {
  const prefix = `fair-${crypto.randomUUID()}`;
  const old = "2026-01-01T00:00:00.000Z";
  const now = new Date().toISOString();
  await env.BILLING_DB.batch([
    env.BILLING_DB.prepare(
      "INSERT INTO organizations (id,external_id,name,created_at,updated_at) VALUES (?,?,'Fairness fixture',?,?)",
    ).bind(prefix, prefix, now, now),
    env.BILLING_DB.prepare(
      "INSERT INTO customers (id,organization_id,external_id,email,name,currency,metadata_json,payment_provider,payment_provider_code,created_at,updated_at) VALUES (?,?,?,'fixture@example.test','Fixture','USD','{}','easy_pay_direct','fair-fixture',?,?)",
    ).bind(prefix, prefix, prefix, now, now),
  ]);
  const statements: D1PreparedStatement[] = [];
  for (let index = 0; index < 103; index++) {
    const id = `${prefix}-${index}`;
    // The first 101 rows deliberately retain the migration's unknown origin.
    // Only the newly created row has explicit Gateway provenance.
    const transport = index === 101 ? "gateway" : "legacy_unknown";
    const status = index === 102 ? "succeeded" : "unknown";
    const time = index < 101 ? old : now;
    statements.push(
      env.BILLING_DB.prepare(
        "INSERT INTO payment_requests (id,organization_id,customer_id,amount_minor,currency,email,payment_attempts,payment_status,ready_for_payment_processing,version,collection_mode,created_at,updated_at) VALUES (?,?,?,900,'USD','fixture@example.test',0,'pending',1,1,'checkout',?,?)",
      ).bind(id, prefix, prefix, now, now),
      env.BILLING_DB.prepare(
        "INSERT INTO payment_request_checkout_intents (id,organization_id,payment_request_id,customer_id,provider,provider_account_code,idempotency_key,request_sha256,amount_minor,currency,payment_request_version,status,payment_url,provider_token_sha256,expires_at,created_at,updated_at) VALUES (?,?,?,?,'easy_pay_direct','fair-fixture',?,'fixture',900,'USD',1,'succeeded','https://fixture.test','fixture',?,?,?)",
      ).bind(id, prefix, id, prefix, id, now, now, now),
      env.BILLING_DB.prepare(
        "INSERT INTO easy_pay_direct_payment_executions (id,charge_transport,organization_id,checkout_intent_id,payment_request_id,provider_account_code,request_sha256,payment_token_sha256,phone_sha256,customer_idempotency_key,payment_method_idempotency_key,product_idempotency_key,order_idempotency_key,status,provider_transaction_id,created_at,updated_at) VALUES (?,?,?,?,?,'fair-fixture','fixture','fixture','fixture',?,?,?,?,?,?,?,?)",
      ).bind(id, transport, prefix, id, id, id, id, id, id, status, `txn-${id}`, time, time),
    );
    if (index === 102) statements.pop(); // Insert tax-bound execution after its quote exists.
  }
  for (let offset = 0; offset < statements.length; offset += 75)
    await env.BILLING_DB.batch(statements.slice(offset, offset + 75));
  const tax = `${prefix}-102`;
  await env.BILLING_DB.batch([
    env.BILLING_DB.prepare(
      "INSERT INTO invoices (id,organization_id,customer_id,number,status,payment_status,currency,subtotal_minor,tax_minor,credits_minor,total_due_minor,version,finalized_at,payment_overdue,ready_for_payment_processing,created_at,updated_at) VALUES (?,?,?,?,'finalized','pending','USD',900,0,0,900,1,?,0,1,?,?)",
    ).bind(tax, prefix, prefix, tax, now, now, now),
    env.BILLING_DB.prepare(
      "INSERT INTO invoices_payment_requests (id,organization_id,payment_request_id,invoice_id,invoice_version,created_at,updated_at) VALUES (?,?,?,?,1,?,?)",
    ).bind(tax, prefix, tax, tax, now, now),
    env.BILLING_DB.prepare(
      "INSERT INTO easy_pay_direct_checkout_tax_quotes (id,organization_id,payment_request_id,invoice_id,source_checkout_intent_id,provider_code,provider_calculation_id,request_sha256,billing_address_sha256,billing_country,currency,subtotal_minor,tax_minor,total_minor,tax_code,status,expires_at,created_at,updated_at) VALUES (?,?,?,?,?,'fixture',?,'fixture','fixture','US','USD',900,0,900,'fixture','applied',?,?,?)",
    ).bind(tax, prefix, tax, tax, tax, tax, now, now, now),
    env.BILLING_DB.prepare(
      "INSERT INTO easy_pay_direct_payment_executions (id,charge_transport,organization_id,checkout_intent_id,payment_request_id,provider_account_code,request_sha256,payment_token_sha256,phone_sha256,customer_idempotency_key,payment_method_idempotency_key,product_idempotency_key,order_idempotency_key,status,provider_transaction_id,created_at,updated_at,tax_quote_id,billing_address_sha256) VALUES (?,'legacy_unknown',?,?,?,'fair-fixture','fixture','fixture','fixture',?,?,?,?,'succeeded',?,?,?,?, 'fixture')",
    ).bind(tax, prefix, tax, tax, tax, tax, tax, tax, `txn-${tax}`, now, now, tax),
    env.BILLING_DB.prepare(
      "INSERT INTO payment_request_payments (id,organization_id,payment_request_id,provider,provider_account_code,provider_transaction_id,idempotency_key,amount_minor,currency,status,created_at,updated_at) VALUES (?,?,?,'easy_pay_direct','fair-fixture',?,?,900,'USD','succeeded',?,?)",
    ).bind(tax, prefix, tax, `txn-${tax}`, tax, now, now),
  ]);
  const pending = await pendingEasyPayDirectExecutions(env.BILLING_DB, "gateway_test");
  expect(pending).toContain(`${prefix}-101`);
  expect(pending).toContain(tax);
  expect(pending.filter((id) => id.startsWith(prefix))).toHaveLength(2);
  expect(
    await env.BILLING_DB.prepare(
      "SELECT COUNT(*) AS count FROM easy_pay_direct_payment_executions WHERE organization_id=? AND charge_transport='legacy_unknown'",
    )
      .bind(prefix)
      .first(),
  ).toEqual({ count: 102 });
});
